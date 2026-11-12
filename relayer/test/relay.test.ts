import { KeyPair, SCHEMA, actions, encodeSignedDelegate, teraToGas, type Action } from "near-api-js";
import { TransactionTimeoutError } from "near-api-js/rpc-errors";
import { serialize } from "borsh";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../src/app.ts";
import { GAME_METHODS, MONEY_METHODS, decodeSignedDelegate, delegateHash } from "../src/policy.ts";
import {
  CONFIG,
  FakeChain,
  HEIGHT,
  HOUSE,
  PLAYER,
  TOKEN,
  gameCall,
  keySetup,
  signDelegate,
  testApp,
  toBase64,
  type DelegateOptions,
} from "./helpers.ts";

let chain: FakeChain;
let clock: number;
let app: Hono;

beforeEach(() => {
  chain = new FakeChain();
  clock = 0;
  app = testApp({ chain, now: () => clock });
});

async function post(body: unknown) {
  const res = await app.request("/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function relay(acts: Action[], opts?: DelegateOptions) {
  const { signed } = await signDelegate(acts, opts);
  return post({ signedDelegate: toBase64(signed) });
}

const ftDeposit = (receiverId: string, deposit = 1n, method = "ft_transfer_call"): Action =>
  actions.functionCall(method, { receiver_id: receiverId, amount: "1000000", msg: "" }, teraToGas(100), deposit);

describe("encoding", () => {
  it("decodes to the same bytes and the same signed hash", async () => {
    const { signed, hash } = await signDelegate([gameCall("close_session"), keySetup()]);
    const decoded = decodeSignedDelegate(toBase64(signed));
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(Buffer.from(serialize(SCHEMA.SignedDelegate, decoded))).toEqual(Buffer.from(encodeSignedDelegate(signed)));
    expect(Buffer.from(delegateHash(decoded.delegateAction))).toEqual(Buffer.from(hash));
  });

  it("rejects bodies that are not a base64 SignedDelegate", async () => {
    expect((await post({})).body).toEqual({ error: "invalid_body" });
    expect((await post({ signedDelegate: 5 })).status).toBe(400);
    expect((await post({ signedDelegate: "not base64!" })).body).toEqual({ error: "invalid_encoding" });
    expect((await post({ signedDelegate: Buffer.from("garbage").toString("base64") })).body).toEqual({
      error: "invalid_encoding",
    });
    const { signed } = await signDelegate([gameCall("close_session")]);
    const trailing = Buffer.concat([Buffer.from(encodeSignedDelegate(signed)), Buffer.from([0])]);
    expect((await post({ signedDelegate: trailing.toString("base64") })).body).toEqual({ error: "invalid_encoding" });
  });
});

describe("allowed shapes", () => {
  it.each(GAME_METHODS)("relays %s from a function-call key", async (method) => {
    chain.key = { nonce: 1n, fullAccess: false };
    const res = await relay([gameCall(method)]);
    // open_session waits for execution (the web plays only an open session); the others answer at inclusion.
    const status = method === "open_session" ? "success" : "pending";
    expect(res).toEqual({ status: 200, body: { txHash: "tx1", status } });
    expect(chain.relayed[0]?.delegateAction.senderId).toBe(PLAYER);
  });

  it("relays several game calls up to 300 Tgas in total", async () => {
    const res = await relay([gameCall("close_session", teraToGas(150)), gameCall("force_close", teraToGas(150))]);
    expect(res.status).toBe(200);
  });

  it.each([250_000_000_000_000_000_000_000n, undefined])("relays the one-time key setup (allowance %s)", async (allowance) => {
    const res = await relay([keySetup(allowance)], { receiverId: PLAYER });
    expect(res.status).toBe(200);
  });

  it("accepts the key setup methods in any order", async () => {
    const res = await relay([keySetup(undefined, [...GAME_METHODS].reverse())], { receiverId: PLAYER });
    expect(res.status).toBe(200);
  });

  it.each(MONEY_METHODS)("relays %s with 1 yocto or none from a full-access key", async (method) => {
    expect((await relay([gameCall(method, teraToGas(100), 1n)])).status).toBe(200);
    expect((await relay([gameCall(method, teraToGas(100), 0n)])).status).toBe(200);
  });

  it("relays a USDC deposit to the house", async () => {
    const res = await relay([ftDeposit(HOUSE)], { receiverId: TOKEN });
    expect(res.status).toBe(200);
  });
});

describe("when the relayer answers", () => {
  it("answers session moves at inclusion", async () => {
    await relay([gameCall("close_session", teraToGas(100)), gameCall("force_close", teraToGas(100))]);
    expect(chain.waits).toEqual(["included"]);
  });

  it("waits for open_session to execute: the web plays only an open session", async () => {
    await relay([gameCall("open_session", teraToGas(100))]);
    expect(chain.waits).toEqual(["executed"]);
  });

  it.each([
    ["a money move", [gameCall("withdraw", teraToGas(100), 1n)], {}],
    ["a game move bundled with a money move", [gameCall("close_session"), gameCall("divest")], {}],
    ["a USDC deposit", [ftDeposit(HOUSE)], { receiverId: TOKEN }],
    ["the key setup", [keySetup()], { receiverId: PLAYER }],
  ] as const)("waits for the full execution of %s", async (_name, acts, opts) => {
    const res = await relay([...acts], opts);
    expect(res.body).toMatchObject({ status: "success" });
    expect(chain.waits).toEqual(["executed"]);
  });
});

describe("refusals (review focus #5)", () => {
  const refused = async (acts: Action[], reason: string, opts?: DelegateOptions) => {
    const res = await relay(acts, opts);
    expect(res).toEqual({ status: 403, body: { error: reason } });
    expect(chain.relayed).toHaveLength(0);
  };

  it("another receiver", () => refused([gameCall("close_session")], "wrong_receiver", { receiverId: "evil.testnet" }));
  it("a method outside the allow-list", () => refused([gameCall("add_dealer")], "method_not_allowed"));
  it("reprice (dealer-only)", () => refused([gameCall("reprice")], "method_not_allowed"));
  it("a deposit on a game move", () => refused([gameCall("close_session", teraToGas(100), 1n)], "deposit_not_allowed"));
  it("more than 1 yocto on a money move", () =>
    refused([gameCall("withdraw", teraToGas(100), 2n)], "deposit_not_allowed"));
  it("a NEAR transfer to the house", () => refused([actions.transfer(1n)], "action_not_allowed"));
  it("a game call hidden next to a transfer", () =>
    refused([gameCall("close_session"), actions.transfer(10n ** 24n)], "action_not_allowed"));
  it("a single call above 300 Tgas", () => refused([gameCall("close_session", teraToGas(301))], "gas_too_high"));
  it("calls above 300 Tgas in total", () =>
    refused([gameCall("close_session", teraToGas(200)), gameCall("force_close", teraToGas(200))], "gas_too_high"));
  it("too many actions", () => refused(Array.from({ length: 5 }, () => gameCall("close_session", teraToGas(10))), "too_many_actions"));
  it("no actions", () => refused([], "no_actions"));

  it("a full-access key setup", () =>
    refused([actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())], "full_access_key_not_allowed", {
      receiverId: PLAYER,
    }));
  it("a key for another contract", () =>
    refused([keySetup(undefined, [...GAME_METHODS], "evil.testnet")], "wrong_key_receiver", { receiverId: PLAYER }));
  it("a key with an extra method", () =>
    refused([keySetup(undefined, [...GAME_METHODS, "withdraw"])], "wrong_key_methods", { receiverId: PLAYER }));
  it("a key missing a method", () =>
    refused([keySetup(undefined, GAME_METHODS.slice(1))], "wrong_key_methods", { receiverId: PLAYER }));
  it("a key with duplicated methods", () =>
    refused([keySetup(undefined, [...GAME_METHODS.slice(1), "bet_dice"])], "wrong_key_methods", {
      receiverId: PLAYER,
    }));
  it("a key with no method restriction", () => refused([keySetup(undefined, [])], "wrong_key_methods", { receiverId: PLAYER }));
  it("a key allowance above 0.25 NEAR", () =>
    refused([keySetup(250_000_000_000_000_000_000_001n)], "allowance_too_high", { receiverId: PLAYER }));
  it("a key setup sent to the house", () => refused([keySetup()], "action_not_allowed"));
  it("a key setup bundled with another action", () =>
    refused([keySetup(), actions.transfer(1n)], "too_many_actions", { receiverId: PLAYER }));

  it("an FT deposit to another receiver", () =>
    refused([ftDeposit("evil.testnet")], "wrong_ft_receiver", { receiverId: TOKEN }));
  it("an FT call without 1 yocto", () => refused([ftDeposit(HOUSE, 0n)], "deposit_not_allowed", { receiverId: TOKEN }));
  it("a plain ft_transfer", () => refused([ftDeposit(HOUSE, 1n, "ft_transfer")], "method_not_allowed", { receiverId: TOKEN }));
  it("an FT call with unreadable args", () =>
    refused([actions.functionCall("ft_transfer_call", new Uint8Array([1, 2]), teraToGas(50), 1n)], "invalid_args", {
      receiverId: TOKEN,
    }));

  it("a money move signed by a function-call key", async () => {
    chain.key = { nonce: 1n, fullAccess: false };
    await refused([gameCall("withdraw", teraToGas(100), 1n)], "key_not_full_access");
  });
  it("a key setup signed by a function-call key", async () => {
    chain.key = { nonce: 1n, fullAccess: false };
    await refused([keySetup()], "key_not_full_access", { receiverId: PLAYER });
  });
  it("a key unknown on chain", async () => {
    chain.key = null;
    await refused([gameCall("close_session")], "unknown_key");
  });
  it("a nonce already used", async () => {
    chain.key = { nonce: 10n, fullAccess: true };
    await refused([gameCall("close_session")], "stale_nonce", { nonce: 10n });
  });
  it("an expired delegate", () => refused([gameCall("close_session")], "expired", { maxBlockHeight: HEIGHT }));
  it("a delegate valid too far ahead", () =>
    refused([gameCall("close_session")], "ttl_too_long", { maxBlockHeight: HEIGHT + 601n }));

  it("a forged signature", async () => {
    const { signed } = await signDelegate([gameCall("close_session")]);
    signed.delegateAction.receiverId = HOUSE;
    signed.delegateAction.nonce += 1n; // changes the signed bytes
    expect(await post({ signedDelegate: toBase64(signed) })).toEqual({ status: 403, body: { error: "bad_signature" } });
  });
  it("a signature by another key", async () => {
    const { signed } = await signDelegate([gameCall("close_session")]);
    const { signed: other } = await signDelegate([gameCall("close_session")]);
    signed.signature = other.signature;
    expect(await post({ signedDelegate: toBase64(signed) })).toEqual({ status: 403, body: { error: "bad_signature" } });
  });
  it("a secp256k1 signer", () =>
    refused([gameCall("close_session")], "unsupported_key_type", { key: KeyPair.fromRandom("secp256k1") }));
});

describe("rate limits", () => {
  it(`allows ${LIMITS.relayPerSender} moves per sender per minute`, async () => {
    for (let i = 0; i < LIMITS.relayPerSender; i++) expect((await relay([gameCall("close_session")])).status).toBe(200);
    expect(await relay([gameCall("close_session")])).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect((await relay([gameCall("close_session")], { senderId: "bob.testnet" })).status).toBe(200);
    clock += 60_000;
    expect((await relay([gameCall("close_session")])).status).toBe(200);
  });

  it("does not let forged payloads spend a sender's quota", async () => {
    chain.key = null;
    for (let i = 0; i < LIMITS.relayPerSender + 5; i++) expect((await relay([gameCall("close_session")])).status).toBe(403);
    chain.key = { nonce: 1n, fullAccess: true };
    expect((await relay([gameCall("close_session")])).status).toBe(200);
  });

  it(`caps all requests at ${LIMITS.relayGlobal} per minute`, async () => {
    for (let i = 0; i < LIMITS.relayGlobal; i++) expect((await post({})).status).toBe(400);
    expect(await relay([gameCall("close_session")])).toEqual({ status: 429, body: { error: "rate_limited" } });
    clock += 60_000;
    expect((await relay([gameCall("close_session")])).status).toBe(200);
  });
});

describe("chain errors", () => {
  it("maps RPC failures to 502", async () => {
    chain.relayError = new Error("boom");
    expect(await relay([gameCall("close_session")])).toEqual({ status: 502, body: { error: "rpc_error" } });
  });

  it("maps RPC timeouts to 504", async () => {
    chain.relayError = new TransactionTimeoutError();
    expect(await relay([gameCall("close_session")])).toEqual({ status: 504, body: { error: "rpc_timeout" } });
  });
});

describe("kill switch and daily budget", () => {
  it("refuses every relay while paused, and /health says so", async () => {
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, paused: true } });
    expect(await relay([gameCall("close_session")])).toEqual({ status: 503, body: { error: "paused" } });
    expect(chain.relayed).toHaveLength(0);
    expect(await (await app.request("/health")).json()).toEqual({ ok: true, network: "testnet", paused: true });
  });

  it("stops paying gas once today's spending reached the budget, until the next UTC day", async () => {
    expect((await relay([gameCall("close_session")])).status).toBe(200);
    chain.balance -= CONFIG.dailyBudgetYocto;
    clock += 10_000;
    expect(await relay([gameCall("close_session")])).toEqual({ status: 503, body: { error: "daily_budget_exhausted" } });
    expect(chain.relayed).toHaveLength(1);
    clock += 24 * 60 * 60_000;
    expect((await relay([gameCall("close_session")])).status).toBe(200);
  });

  it("fails closed when the relayer balance cannot be read", async () => {
    chain.balanceError = new Error("rpc down");
    expect(await relay([gameCall("close_session")])).toEqual({ status: 502, body: { error: "rpc_error" } });
    expect(chain.relayed).toHaveLength(0);
  });
});

describe("health", () => {
  it("answers with the network and the kill switch", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ ok: true, network: "testnet", paused: false });
  });
});
