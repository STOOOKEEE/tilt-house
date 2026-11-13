import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, MINT_AMOUNT } from "../src/app.ts";
import { StateStore } from "../src/state.ts";
import { CONFIG, FakeChain, NEAR, WELCOME_AMOUNT, privyToken, testApp } from "./helpers.ts";

let chain: FakeChain;
let clock: number;
let app: Hono;

beforeEach(() => {
  chain = new FakeChain();
  clock = 0;
  app = testApp({ chain, now: () => clock });
});

async function claim(accountId: unknown, ip = "10.0.0.1") {
  const res = await app.request(
    "/faucet",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId }) },
    { incoming: { socket: { remoteAddress: ip } } },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /faucet", () => {
  it("mints 100 tUSDC to named and implicit accounts", async () => {
    const implicit = "ab".repeat(32);
    expect(await claim("alice.testnet")).toEqual({ status: 200, body: { minted: "100000000" } });
    expect((await claim(implicit)).status).toBe(200);
    expect(chain.mints).toEqual([
      { accountId: "alice.testnet", tokens: MINT_AMOUNT },
      { accountId: implicit, tokens: MINT_AMOUNT },
    ]);
  });

  it("allows one claim per account per hour", async () => {
    expect((await claim("alice.testnet")).status).toBe(200);
    expect(await claim("alice.testnet", "10.0.0.2")).toEqual({ status: 429, body: { error: "already_claimed" } });
    clock += 60 * 60_000;
    expect((await claim("alice.testnet")).status).toBe(200);
    expect(chain.mints).toHaveLength(2);
  });

  it.each(["Alice.testnet", "a", "evil..testnet", "x".repeat(65), ""])("refuses invalid account %j", async (accountId) => {
    expect(await claim(accountId)).toEqual({ status: 403, body: { error: "invalid_account" } });
    expect(chain.mints).toHaveLength(0);
  });

  it("refuses a malformed body", async () => {
    expect(await claim(["alice.testnet"])).toEqual({ status: 400, body: { error: "invalid_body" } });
  });

  it("reports a refused mint (e.g. the token's 24 h cap) and keeps the claim spent", async () => {
    chain.mintError = new Error("daily cap reached");
    expect(await claim("alice.testnet")).toEqual({ status: 502, body: { error: "mint_failed" } });
    chain.mintError = null;
    expect(await claim("alice.testnet")).toEqual({ status: 429, body: { error: "already_claimed" } });
  });

  it(`allows ${LIMITS.faucetPerIp} requests per IP per minute`, async () => {
    for (let i = 0; i < LIMITS.faucetPerIp; i++) expect((await claim(`p${i}.testnet`)).status).toBe(200);
    expect(await claim("late.testnet")).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect((await claim("late.testnet", "10.0.0.2")).status).toBe(200);
  });

  it(`caps claims at ${LIMITS.faucetGlobalPerHour} per hour`, async () => {
    for (let i = 0; i < LIMITS.faucetGlobalPerHour; i++) {
      expect((await claim(`p${i}.testnet`, `10.1.0.${i}`)).status).toBe(200);
    }
    expect(await claim("late.testnet", "10.9.9.9")).toEqual({ status: 429, body: { error: "rate_limited" } });
    clock += 60 * 60_000;
    expect((await claim("late.testnet", "10.9.9.9")).status).toBe(200);
  });

  it("does not share quotas with /activate", async () => {
    for (let i = 0; i < LIMITS.faucetPerIp; i++) await claim(`p${i}.testnet`);
    const res = await app.request(
      "/activate",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await privyToken()}` },
        body: JSON.stringify({ accountId: "cd".repeat(32) }),
      },
      { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /faucet on mainnet", () => {
  const ALICE = "did:privy:alice00000000000000000000";
  const wallet = "ab".repeat(32);
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(null);
    store.bind(ALICE, wallet, 0);
    app = testApp({ chain, now: () => clock, store, config: { ...CONFIG, network: "mainnet" } });
  });

  async function claimAs(accountId: string, authorization?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authorization) headers.authorization = authorization;
    const res = await app.request(
      "/faucet",
      { method: "POST", headers, body: JSON.stringify({ accountId }) },
      { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("needs a Privy login", async () => {
    expect(await claimAs(wallet)).toEqual({ status: 401, body: { error: "missing_token" } });
    expect(chain.mints).toHaveLength(0);
  });

  it("mints only to the account activated for that user, once per hour per user", async () => {
    const token = `Bearer ${await privyToken(ALICE, clock)}`;
    expect(await claimAs("cd".repeat(32), token)).toEqual({ status: 403, body: { error: "not_your_account" } });
    expect(await claimAs(wallet, token)).toEqual({ status: 200, body: { minted: "100000000" } });
    expect(await claimAs(wallet, token)).toEqual({ status: 429, body: { error: "already_claimed" } });
    expect(chain.mints).toEqual([{ accountId: wallet, tokens: MINT_AMOUNT }]);
  });

  it("refuses a user who was never activated", async () => {
    const token = `Bearer ${await privyToken("did:privy:bob0000000000000000000000", clock)}`;
    expect(await claimAs(wallet, token)).toEqual({ status: 403, body: { error: "not_your_account" } });
  });
});

describe("POST /faucet: kill switch and daily budget", () => {
  it("refuses while paused", async () => {
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, paused: true } });
    expect(await claim("alice.testnet")).toEqual({ status: 503, body: { error: "paused" } });
  });

  it("refuses once today's budget is spent, without spending the claim", async () => {
    expect((await claim("alice.testnet")).status).toBe(200);
    chain.balance -= 5n * NEAR;
    clock += 10_000;
    expect(await claim("bob.testnet")).toEqual({ status: 503, body: { error: "daily_budget_exhausted" } });
    clock += 24 * 60 * 60_000;
    expect((await claim("bob.testnet")).status).toBe(200);
  });
});

describe("POST /faucet in welcome mode (TILT floor)", () => {
  const ALICE = "did:privy:alice00000000000000000000";
  const BOB = "did:privy:bob0000000000000000000000";
  const wallet = "ab".repeat(32);
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(null);
    store.bind(ALICE, wallet, 0);
    app = testApp({ chain, now: () => clock, store, config: { ...CONFIG, faucetMode: "welcome" } });
  });

  async function claimAs(accountId: string, user?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (user) headers.authorization = `Bearer ${await privyToken(user, clock)}`;
    const res = await app.request(
      "/faucet",
      { method: "POST", headers, body: JSON.stringify({ accountId }) },
      { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("needs a Privy login, even on testnet", async () => {
    expect(await claimAs(wallet)).toEqual({ status: 401, body: { error: "missing_token" } });
    expect(chain.welcomed).toEqual([]);
  });

  it("claims the welcome once for the user's own account, and never mints", async () => {
    expect(await claimAs("cd".repeat(32), ALICE)).toEqual({ status: 403, body: { error: "not_your_account" } });
    expect(await claimAs(wallet, ALICE)).toEqual({ status: 200, body: { welcomed: WELCOME_AMOUNT.toString() } });
    clock += 24 * 60 * 60_000;
    expect(await claimAs(wallet, ALICE)).toEqual({ status: 409, body: { error: "already_claimed" } });
    expect(chain.welcomed).toEqual([wallet]);
    expect(chain.mints).toEqual([]);
  });

  it("refuses a user this relayer never activated", async () => {
    expect(await claimAs(wallet, BOB)).toEqual({ status: 403, body: { error: "not_your_account" } });
  });

  it("claims once when the same user sends two requests at the same time", async () => {
    const results = await Promise.all([claimAs(wallet, ALICE), claimAs(wallet, ALICE)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(chain.welcomed).toEqual([wallet]);
  });

  it("lets the player retry after the token refused (e.g. today's claim cap)", async () => {
    chain.welcomeError = new Error("daily welcome cap reached");
    expect(await claimAs(wallet, ALICE)).toEqual({ status: 502, body: { error: "welcome_failed" } });
    chain.welcomeError = null;
    expect((await claimAs(wallet, ALICE)).status).toBe(200);
  });

  it("keeps an account the token says already claimed as claimed (state lost, claimed elsewhere)", async () => {
    chain.welcomed.push(wallet);
    expect(await claimAs(wallet, ALICE)).toEqual({ status: 409, body: { error: "already_claimed" } });
    expect(store.hasWelcome(ALICE)).toBe(true);
  });

  it("remembers claims across a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "relayer-")), "state.json");
    store = new StateStore(file);
    store.bind(ALICE, wallet, 0);
    app = testApp({ chain, now: () => clock, store, config: { ...CONFIG, faucetMode: "welcome" } });
    expect((await claimAs(wallet, ALICE)).status).toBe(200);
    app = testApp({ chain, now: () => clock, store: new StateStore(file), config: { ...CONFIG, faucetMode: "welcome" } });
    expect(await claimAs(wallet, ALICE)).toEqual({ status: 409, body: { error: "already_claimed" } });
  });
});
