import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyPair } from "near-api-js";
import { AccessKeyDoesNotExistError } from "near-api-js/rpc-errors";
import { afterEach, describe, expect, it } from "vitest";
import { FailoverProvider, MAX_ATTEMPTS, cooled, isOverload, pick, rpcUrls, type Endpoint } from "../src/rpc.ts";

const BLOCK = { header: { height: 7, hash: "11111111111111111111111111111111" } };
const KEY = KeyPair.fromRandom("ed25519").getPublicKey().toString();
const UNKNOWN_KEY = {
  name: "HANDLER_ERROR",
  cause: { name: "UNKNOWN_ACCESS_KEY", info: { public_key: KEY, block_height: 1, block_hash: "11111111111111111111111111111111" } },
  code: -32000,
  message: "Server error",
  data: `Access key for public key ${KEY} does not exist`,
};

/** A JSON-RPC endpoint answering `status` first for the given number of requests, then `ok`. */
interface Mock {
  url: string;
  methods: string[];
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function mock(failFirst: number, status = 429, answer: (method: string) => object = () => ({ result: BLOCK })): Promise<Mock> {
  const methods: string[] = [];
  let left = failFirst;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { method, id } = JSON.parse(body) as { method: string; id: string };
      methods.push(method);
      if (left > 0) {
        left--;
        res.writeHead(status).end("slow down");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...answer(method) }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, methods };
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

  it("sends transactions to the first endpoint only", async () => {
    const first = await mock(100);
    const second = await mock(0);
    const { p } = provider([first.url, second.url]);
    await expect(p.sendJsonRpc("send_tx", { signed_tx_base64: "AA==", wait_until: "INCLUDED" })).rejects.toThrow();
    expect(first.methods).toEqual(Array(MAX_ATTEMPTS).fill("send_tx"));
    expect(second.methods).toEqual([]);
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
    expect(pick([a, b], 2, 0)).toEqual({ index: 1, waitMs: 500 });
    expect(pick([a, b], 1, 0)).toEqual({ index: 0, waitMs: 30_000 });
    expect(pick([a, b], 2, 600)).toEqual({ index: 1, waitMs: 0 });
  });

  it("retries only overload answers", () => {
    const status = (code: number) => Object.assign(new Error("x"), { cause: code });
    expect([408, 429, 500, 502, 503, 504].every((code) => isOverload(status(code)))).toBe(true);
    expect(isOverload(status(400))).toBe(false);
    expect(isOverload(new TypeError("fetch failed"))).toBe(true);
    expect(isOverload(new Error("Smart contract panicked: the day is already closed"))).toBe(false);
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
