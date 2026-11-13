import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyPair, KeyPairSigner, actions, baseDecode, baseEncode, createTransaction, encodeTransaction } from "near-api-js";
import { AccessKeyDoesNotExistError, RpcError, TransactionTimeoutError } from "near-api-js/rpc-errors";
import { afterEach, describe, expect, it } from "vitest";
import { FailoverProvider, MAX_ATTEMPTS, classify, cooled, pick, rpcUrls, statusRequest, type Endpoint } from "../src/rpc.ts";

const BLOCK = { header: { height: 7, hash: "11111111111111111111111111111111" } };
const KEY = KeyPair.fromRandom("ed25519").getPublicKey().toString();
const UNKNOWN_KEY = {
  name: "HANDLER_ERROR",
  cause: { name: "UNKNOWN_ACCESS_KEY", info: { public_key: KEY, block_height: 1, block_hash: "11111111111111111111111111111111" } },
  code: -32000,
  message: "Server error",
  data: `Access key for public key ${KEY} does not exist`,
};

/** FastNear's rate-limit answer: a JSON-RPC error body, no NEAR error name. */
const RATE_LIMITED = { error: { code: -429, message: "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com" } };
/** nearcore's send_tx answer when `wait_until` is not reached in time. */
const NEAR_TIMEOUT = { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: { cause: "PENDING", status: { final_execution_status: "INCLUDED" } } }, code: -32000, message: "Server error", data: "Timeout" } };
const UNKNOWN_TX = {
  error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: "x" } }, code: -32000, message: "Server error" },
};
const OUTCOME = { final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" } };

/** A JSON-RPC endpoint answering `status` first for the given number of requests, then `ok`. */
interface Mock {
  url: string;
  methods: string[];
  /** Params of each request, in order. */
  params: unknown[];
}

/** One scripted answer: an HTTP status with a raw body, or a JSON-RPC body (HTTP 200). */
type Reply = { status: number; body?: string } | { json: object };

/** An endpoint answering from `replies` in order, then `rest` for every later request. */
async function scripted(replies: Reply[], rest: (method: string) => Reply = () => ({ json: { result: OUTCOME } })): Promise<Mock> {
  const methods: string[] = [];
  const params: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body) as { method: string; id: string; params: unknown };
      methods.push(request.method);
      params.push(request.params);
      const reply = replies.shift() ?? rest(request.method);
      if ("json" in reply) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply.json }));
      } else {
        res.writeHead(reply.status).end(reply.body ?? "");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, methods, params };
}

/** A real signed transaction, base64 as send_tx carries it, and its hash. */
async function signedTx(): Promise<{ base64: string; hash: string }> {
  const key = KeyPair.fromRandom("ed25519");
  const tx = createTransaction("relayer.testnet", key.getPublicKey(), "b.testnet", 5n, [actions.transfer(1n)], baseDecode("11111111111111111111111111111111"));
  const { txHash, signedTransaction } = await new KeyPairSigner(key).signTransaction(tx);
  return { base64: Buffer.from(encodeTransaction(signedTransaction)).toString("base64"), hash: baseEncode(txHash) };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function mock(failFirst: number, status = 429, answer: (method: string) => object = () => ({ result: BLOCK })): Promise<Mock> {
  return scripted(Array.from({ length: failFirst }, () => ({ status, body: "slow down" })), (method) => ({ json: answer(method) }));
}

function provider(urls: string[]) {
  const sleeps: number[] = [];
  let clock = 0;
  const p = new FailoverProvider(urls, {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: () => {},
  });
  return { p, sleeps };
}

describe("FailoverProvider", () => {
  it("backs off and retries a throttled endpoint", async () => {
    const one = await mock(2);
    const { p, sleeps } = provider([one.url]);
    expect((await p.viewBlock({ finality: "final" })).header.height).toBe(7);
    expect(one.methods).toEqual(["block", "block", "block"]);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("gives up after MAX_ATTEMPTS with the endpoint's error", async () => {
    const one = await mock(100, 503);
    const { p } = provider([one.url]);
    await expect(p.viewBlock({ finality: "final" })).rejects.toThrow(/unavailable/);
    expect(one.methods).toHaveLength(MAX_ATTEMPTS);
  });

  it("fails reads over to the next endpoint at once, and keeps using it while the first cools down", async () => {
    const first = await mock(100);
    const second = await mock(0);
    const { p, sleeps } = provider([first.url, second.url]);
    await p.viewBlock({ finality: "final" });
    await p.viewBlock({ finality: "final" });
    expect(first.methods).toHaveLength(1);
    expect(second.methods).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it("fails reads over on a rate-limit JSON-RPC body (HTTP 200, code -429)", async () => {
    const first = await scripted([{ json: RATE_LIMITED }]);
    const second = await mock(0);
    const { p } = provider([first.url, second.url]);
    expect((await p.viewBlock({ finality: "final" })).header.height).toBe(7);
    expect(first.methods).toEqual(["block"]);
    expect(second.methods).toEqual(["block"]);
  });

  it.each([
    ["a -429 JSON-RPC body", { json: RATE_LIMITED }],
    ["HTTP 429", { status: 429, body: JSON.stringify(RATE_LIMITED) }],
  ] as const)("sends a transaction refused with %s to the next endpoint, same signed bytes", async (_name, refusal) => {
    const tx = await signedTx();
    const first = await scripted([refusal]);
    const second = await scripted([]);
    const { p } = provider([first.url, second.url]);
    const params = { signed_tx_base64: tx.base64, wait_until: "EXECUTED_OPTIMISTIC" };
    expect(await p.sendJsonRpc("send_tx", params)).toEqual(OUTCOME);
    expect(first.params).toEqual([params]);
    expect(second.params).toEqual([params]);
  });

  it("still prefers the first endpoint for transactions", async () => {
    const tx = await signedTx();
    const first = await scripted([]);
    const second = await scripted([]);
    const { p } = provider([first.url, second.url]);
    await p.sendJsonRpc("send_tx", { signed_tx_base64: tx.base64, wait_until: "INCLUDED" });
    expect(first.methods).toEqual(["send_tx"]);
    expect(second.methods).toEqual([]);
  });

  it.each([
    ["HTTP 408 (dRPC)", { status: 408, body: '{"error":{"message":"Request timeout on the free plan","code":30}}' }],
    ["nearcore's TIMEOUT_ERROR", { json: NEAR_TIMEOUT }],
  ] as const)("retries a transaction after %s with the same signed bytes", async (_name, timeout) => {
    const tx = await signedTx();
    const one = await scripted([timeout]);
    const { p, sleeps } = provider([one.url]);
    const params = { signed_tx_base64: tx.base64, wait_until: "FINAL" };
    expect(await p.sendJsonRpc("send_tx", params)).toEqual(OUTCOME);
    expect(one.params).toEqual([params, params]);
    expect(sleeps).toEqual([1_000]);
  });

  it("reports a transaction that timed out on every attempt but landed, asking its status by hash", async () => {
    const tx = await signedTx();
    const timeouts = Array.from({ length: MAX_ATTEMPTS }, (): Reply => ({ status: 408 }));
    const one = await scripted(timeouts);
    const { p } = provider([one.url]);
    expect(await p.sendJsonRpc("send_tx", { signed_tx_base64: tx.base64, wait_until: "FINAL" })).toEqual(OUTCOME);
    expect(one.methods).toEqual([...Array(MAX_ATTEMPTS).fill("send_tx"), "tx"]);
    expect(one.params.at(-1)).toEqual({ tx_hash: tx.hash, sender_account_id: "relayer.testnet", wait_until: "FINAL" });
  });

  it("checks the status when a resend after a timeout is refused (the first copy used the nonce)", async () => {
    const tx = await signedTx();
    const invalidNonce = { error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error" } };
    const one = await scripted([{ status: 408 }, { json: invalidNonce }]);
    const { p } = provider([one.url]);
    expect(await p.sendJsonRpc("send_tx", { signed_tx_base64: tx.base64, wait_until: "FINAL" })).toEqual(OUTCOME);
    expect(one.methods).toEqual(["send_tx", "send_tx", "tx"]);
  });

  it("gives up with the timeout when the chain does not know the transaction", async () => {
    const tx = await signedTx();
    const one = await scripted([], (method) => (method === "tx" ? { json: UNKNOWN_TX } : { status: 408 }));
    const { p } = provider([one.url]);
    await expect(p.sendJsonRpc("send_tx", { signed_tx_base64: tx.base64, wait_until: "FINAL" })).rejects.toThrow(/Timeout/);
    expect(one.methods).toEqual([...Array(MAX_ATTEMPTS).fill("send_tx"), "tx"]);
  });

  it("gives up after rate limits without asking the status (nothing was delivered)", async () => {
    const tx = await signedTx();
    const one = await scripted([], () => ({ json: RATE_LIMITED }));
    const { p } = provider([one.url]);
    await expect(p.sendJsonRpc("send_tx", { signed_tx_base64: tx.base64, wait_until: "FINAL" })).rejects.toBeInstanceOf(RpcError);
    expect(one.methods).toEqual(Array(MAX_ATTEMPTS).fill("send_tx"));
  });

  it("passes a contract's own answer through, typed, without retrying", async () => {
    const one = await mock(0, 429, () => ({ error: UNKNOWN_KEY }));
    const { p } = provider([one.url]);
    const read = p.viewAccessKey({ accountId: "a.testnet", publicKey: KEY });
    await expect(read).rejects.toBeInstanceOf(AccessKeyDoesNotExistError);
    expect(one.methods).toHaveLength(1);
  });
});

describe("backoff", () => {
  it("doubles up to 30 s and picks the endpoint that cools down first", () => {
    const a: Endpoint = { url: "a", coolUntil: 0, backoffMs: 0 };
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      cooled(a, 0);
      waits.push(a.coolUntil);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    const b: Endpoint = { url: "b", coolUntil: 500, backoffMs: 1_000 };
    expect(pick([a, b], 0)).toEqual({ index: 1, waitMs: 500 });
    expect(pick([a], 0)).toEqual({ index: 0, waitMs: 30_000 });
    expect(pick([a, b], 600)).toEqual({ index: 1, waitMs: 0 });
  });

  it("retries only the endpoint's trouble, telling timeouts apart", () => {
    const status = (code: number) => Object.assign(new Error("x"), { cause: code });
    expect([429, 500, 502, 503, 504].map((code) => classify(status(code)))).toEqual(Array(5).fill("overload"));
    expect(classify(status(408))).toBe("timeout");
    expect(classify(status(400))).toBe(null);
    expect(classify(new RpcError("Unknown RPC error"))).toBe("overload");
    expect(classify(new Error("Rate limits exceeded"))).toBe("overload");
    expect(classify(new TransactionTimeoutError())).toBe("timeout");
    expect(classify(new TypeError("fetch failed"))).toBe("timeout");
    expect(classify(new Error("Smart contract panicked: the day is already closed"))).toBe(null);
  });

  it("derives the tx status request from send_tx params", async () => {
    const tx = await signedTx();
    expect(statusRequest({ signed_tx_base64: tx.base64, wait_until: "INCLUDED" })).toEqual({
      tx_hash: tx.hash,
      sender_account_id: "relayer.testnet",
      wait_until: "INCLUDED",
    });
    expect(statusRequest([tx.base64])).toMatchObject({ tx_hash: tx.hash, wait_until: "EXECUTED_OPTIMISTIC" });
    expect(statusRequest({ signed_tx_base64: "AA==" })).toBe(null);
    expect(statusRequest({ finality: "final" })).toBe(null);
  });
});

describe("rpcUrls", () => {
  const DEFAULTS = ["https://a.example", "https://b.example"];
  it("reads NEAR_RPC_URLS, then NEAR_RPC_URL, then the defaults", () => {
    expect(rpcUrls({ NEAR_RPC_URLS: " https://x.example , https://y.example" }, DEFAULTS)).toEqual(["https://x.example", "https://y.example"]);
    expect(rpcUrls({ NEAR_RPC_URL: "https://x.example" }, DEFAULTS)).toEqual(["https://x.example"]);
    expect(rpcUrls({}, DEFAULTS)).toEqual(DEFAULTS);
    expect(() => rpcUrls({ NEAR_RPC_URLS: "," }, DEFAULTS)).toThrow(/empty/);
    expect(() => rpcUrls({ NEAR_RPC_URLS: "ftp://x" }, DEFAULTS)).toThrow(/http/);
  });
});
