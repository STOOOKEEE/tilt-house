import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, MINT_AMOUNT } from "../src/app.ts";
import { fundingNeeded } from "../src/chain.ts";
import { StateStore } from "../src/state.ts";
import { CONFIG, FakeChain, NEAR, privyToken, testApp } from "./helpers.ts";

let chain: FakeChain;
let clock: number;
let app: Hono;

beforeEach(() => {
  chain = new FakeChain();
  clock = 0;
  app = testApp({ chain, now: () => clock });
});

const implicit = (n: number) => n.toString(16).padStart(64, "0");
const user = (n: number) => `did:privy:user${n.toString().padStart(20, "0")}`;

interface Caller {
  ip?: string;
  forwardedFor?: string;
  /** A Privy user id to sign a token for, a raw Authorization header, or null for none. */
  as?: string | { header: string } | null;
}

/** Each account is activated by its own Privy user unless the test says otherwise. */
async function activate(accountId: unknown, { ip = "10.0.0.1", forwardedFor, as }: Caller = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
  const who = as === undefined ? `did:privy:for${String(accountId).replace(/[^A-Za-z0-9]/g, "").slice(-20)}` : as;
  if (typeof who === "string") headers.authorization = `Bearer ${await privyToken(who, clock)}`;
  else if (who !== null) headers.authorization = who.header;
  const res = await app.request(
    "/activate",
    { method: "POST", headers, body: JSON.stringify({ accountId }) },
    { incoming: { socket: { remoteAddress: ip } } },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /activate", () => {
  it("funds and registers a new implicit account once", async () => {
    expect(await activate(implicit(1))).toEqual({ status: 200, body: { funded: true, registered: true, minted: "100000000" } });
    expect(chain.activations).toEqual([implicit(1)]);
    expect(await activate(implicit(1))).toEqual({ status: 409, body: { error: "already_activated" } });
    expect(chain.activations).toHaveLength(1);
  });

  it.each(["alice.testnet", implicit(0xabc).toUpperCase(), `${implicit(1)}0`, "0x" + implicit(1).slice(2)])(
    "refuses %s (not a 64-hex implicit account)",
    async (accountId) => {
      expect(await activate(accountId)).toEqual({ status: 403, body: { error: "not_implicit_account" } });
      expect(chain.activations).toHaveLength(0);
    },
  );

  it("refuses a malformed body", async () => {
    expect(await activate(42)).toEqual({ status: 400, body: { error: "invalid_body" } });
  });

  it("lets the player retry after a chain failure", async () => {
    chain.activateError = new Error("rpc down");
    expect(await activate(implicit(2), { as: user(2) })).toEqual({ status: 502, body: { error: "rpc_error" } });
    chain.activateError = null;
    expect((await activate(implicit(2), { as: user(2) })).status).toBe(200);
  });

  it("is sized for judges sharing an address, under the daily budget", () => {
    expect(LIMITS.activatePerIp).toBe(15);
    expect(LIMITS.anonymousActivateGlobalPerHour).toBe(60);
    expect(LIMITS.anonymousActivateGlobalPerHour).toBeLessThanOrEqual(LIMITS.activateGlobalPerHour);
  });

  it(`allows ${LIMITS.activatePerIp} requests per IP per minute`, async () => {
    for (let i = 0; i < LIMITS.activatePerIp; i++) expect((await activate(implicit(10 + i))).status).toBe(200);
    expect(await activate(implicit(99))).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect((await activate(implicit(99), { ip: "10.0.0.2" })).status).toBe(200);
    clock += 60_000;
    expect((await activate(implicit(100))).status).toBe(200);
  });

  it(`caps activations at ${LIMITS.activateGlobalPerHour} per hour`, async () => {
    for (let i = 0; i < LIMITS.activateGlobalPerHour; i++) {
      expect((await activate(implicit(1000 + i), { ip: `10.1.${Math.floor(i / 100)}.${i % 100}` })).status).toBe(200);
    }
    expect(await activate(implicit(5000), { ip: "10.9.9.9" })).toEqual({ status: 429, body: { error: "rate_limited" } });
    clock += 60 * 60_000;
    expect((await activate(implicit(5000), { ip: "10.9.9.9" })).status).toBe(200);
  });

  it("behind the local proxy, limits the client it names last, not a forged earlier entry", async () => {
    const viaProxy = (n: number, forwardedFor: string) => activate(implicit(n), { ip: "127.0.0.1", forwardedFor });
    for (let i = 0; i < LIMITS.activatePerIp; i++) {
      expect((await viaProxy(200 + i, `6.6.6.${i}, 203.0.113.7`)).status).toBe(200);
    }
    expect((await viaProxy(299, "1.2.3.4, 203.0.113.7")).status).toBe(429);
    expect((await viaProxy(300, "203.0.113.8")).status).toBe(200);
  });

  it("ignores X-Forwarded-For from a non-loopback peer", async () => {
    for (let i = 0; i < LIMITS.activatePerIp; i++) {
      expect((await activate(implicit(400 + i), { ip: "10.0.0.9", forwardedFor: `198.51.100.${i}` })).status).toBe(200);
    }
    expect((await activate(implicit(499), { ip: "10.0.0.9", forwardedFor: "198.51.100.200" })).status).toBe(429);
  });
});

describe("POST /activate: Privy login", () => {
  it("refuses a request without a token", async () => {
    expect(await activate(implicit(1), { as: null })).toEqual({ status: 401, body: { error: "missing_token" } });
    expect(await activate(implicit(1), { as: { header: "Basic abc" } })).toEqual({ status: 401, body: { error: "missing_token" } });
    expect(chain.activations).toHaveLength(0);
  });

  it("refuses a token that does not verify", async () => {
    const forged = (await privyToken(user(1), clock)).replace(/\.[^.]+$/, ".AAAA");
    expect(await activate(implicit(1), { as: { header: `Bearer ${forged}` } })).toEqual({ status: 401, body: { error: "invalid_token" } });
    const expired = await privyToken(user(1), clock - 2 * 3_600_000);
    expect(await activate(implicit(1), { as: { header: `Bearer ${expired}` } })).toEqual({ status: 401, body: { error: "invalid_token" } });
    expect(chain.activations).toHaveLength(0);
  });

  it("fails closed when Privy's keys cannot be fetched", async () => {
    app = testApp({
      chain,
      now: () => clock,
      verifyToken: () => Promise.reject(new Error("jwks down")),
    });
    expect(await activate(implicit(1))).toEqual({ status: 503, body: { error: "auth_unavailable" } });
    expect(chain.activations).toHaveLength(0);
  });

  it("activates one account per Privy user", async () => {
    expect((await activate(implicit(1), { as: user(1) })).status).toBe(200);
    expect(await activate(implicit(2), { as: user(1) })).toEqual({ status: 409, body: { error: "already_activated" } });
    expect(chain.activations).toEqual([implicit(1)]);
  });

  it("activates an account once, whoever asks", async () => {
    expect((await activate(implicit(1), { as: user(1) })).status).toBe(200);
    expect(await activate(implicit(1), { as: user(2) })).toEqual({ status: 409, body: { error: "already_activated" } });
    expect(chain.activations).toHaveLength(1);
  });

  it("pays once when the same user sends two requests at the same time", async () => {
    const results = await Promise.all([activate(implicit(1), { as: user(1) }), activate(implicit(2), { as: user(1) })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(chain.activations).toHaveLength(1);
  });

  it("remembers activations across a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "relayer-")), "state.json");
    app = testApp({ chain, now: () => clock, store: new StateStore(file) });
    expect((await activate(implicit(1), { as: user(1) })).status).toBe(200);
    app = testApp({ chain, now: () => clock, store: new StateStore(file) });
    expect(await activate(implicit(2), { as: user(1) })).toEqual({ status: 409, body: { error: "already_activated" } });
    expect(await activate(implicit(1), { as: user(2) })).toEqual({ status: 409, body: { error: "already_activated" } });
    expect(chain.activations).toHaveLength(1);
  });
});

describe("POST /activate: plans", () => {
  it("tops up and mints 100 tUSDC in mint mode", async () => {
    expect((await activate(implicit(1))).status).toBe(200);
    expect(chain.plans).toEqual([{ near: CONFIG.activationYocto, topUp: true, tokens: MINT_AMOUNT }]);
  });

  it("welcome mode (TILT floor): funds only a new account and mints nothing", async () => {
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, faucetMode: "welcome" } });
    expect(await activate(implicit(1))).toEqual({ status: 200, body: { funded: true, registered: true, minted: "0" } });
    expect(chain.plans).toEqual([{ near: CONFIG.activationYocto, topUp: false, tokens: 0n }]);
  });

  it("an account the other relayer already funded gets no NEAR in welcome mode", () => {
    const near = CONFIG.activationYocto;
    expect(fundingNeeded(0n, { near, topUp: false, tokens: 0n })).toBe(true);
    expect(fundingNeeded(1n, { near, topUp: false, tokens: 0n })).toBe(false);
    expect(fundingNeeded(near - 1n, { near, topUp: true, tokens: 0n })).toBe(true);
    expect(fundingNeeded(near, { near, topUp: true, tokens: 0n })).toBe(false);
  });
});

describe("POST /activate: kill switch and daily budget", () => {
  it("refuses while paused", async () => {
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, paused: true } });
    expect(await activate(implicit(1))).toEqual({ status: 503, body: { error: "paused" } });
    expect(chain.activations).toHaveLength(0);
  });

  it("refuses an activation that would overshoot today's budget", async () => {
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, dailyBudgetYocto: NEAR / 10n } });
    expect((await activate(implicit(1))).status).toBe(200);
    // The relayer spent 0.09 NEAR since the first look: 0.01 left, an activation costs 0.02.
    chain.balance -= (NEAR * 9n) / 100n;
    clock += 10_000;
    expect(await activate(implicit(2))).toEqual({ status: 503, body: { error: "daily_budget_exhausted" } });
    expect(chain.activations).toHaveLength(1);
    // The refused user was not bound: they can activate tomorrow.
    clock += 24 * 60 * 60_000;
    expect((await activate(implicit(2))).status).toBe(200);
  });

  it("keeps counting today's spending across a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "relayer-")), "state.json");
    const config = { ...CONFIG, dailyBudgetYocto: NEAR / 10n };
    app = testApp({ chain, now: () => clock, config, store: new StateStore(file) });
    expect((await activate(implicit(1))).status).toBe(200);
    chain.balance -= NEAR / 10n;
    clock += 10_000;
    expect((await activate(implicit(2))).status).toBe(503);
    app = testApp({ chain, now: () => clock, config, store: new StateStore(file) });
    expect(await activate(implicit(3))).toEqual({ status: 503, body: { error: "daily_budget_exhausted" } });
  });

  it("fails closed when the relayer balance cannot be read", async () => {
    chain.balanceError = new Error("rpc down");
    expect(await activate(implicit(1))).toEqual({ status: 502, body: { error: "rpc_error" } });
    expect(chain.activations).toHaveLength(0);
  });
});

describe("POST /activate: anonymous testnet activations (CLI demo)", () => {
  beforeEach(() => {
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, anonymousActivation: true } });
  });

  it("activates an account without a login, once per account", async () => {
    expect((await activate(implicit(1), { as: null })).status).toBe(200);
    expect(await activate(implicit(1), { as: null, ip: "10.0.0.2" })).toEqual({ status: 409, body: { error: "already_activated" } });
    expect(await activate(implicit(1), { as: user(1) })).toEqual({ status: 409, body: { error: "already_activated" } });
    expect(chain.activations).toEqual([implicit(1)]);
  });

  it("never downgrades a bad token to anonymous", async () => {
    expect(await activate(implicit(1), { as: { header: "Bearer not.a.token" } })).toEqual({ status: 401, body: { error: "invalid_token" } });
    expect(await activate(implicit(1), { as: { header: "Basic x" } })).toEqual({ status: 401, body: { error: "missing_token" } });
    expect(chain.activations).toHaveLength(0);
  });

  it(`caps anonymous activations at ${LIMITS.anonymousActivateGlobalPerHour} per hour, logged-in users unaffected`, async () => {
    for (let i = 0; i < LIMITS.anonymousActivateGlobalPerHour; i++) {
      expect((await activate(implicit(600 + i), { as: null, ip: `10.2.0.${i}` })).status).toBe(200);
    }
    expect(await activate(implicit(699), { as: null, ip: "10.2.1.1" })).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect((await activate(implicit(699), { as: user(699), ip: "10.2.1.2" })).status).toBe(200);
  });

  it("still respects the kill switch and the daily budget", async () => {
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, anonymousActivation: true, paused: true } });
    expect(await activate(implicit(1), { as: null })).toEqual({ status: 503, body: { error: "paused" } });
    app = testApp({ chain, now: () => clock, config: { ...CONFIG, anonymousActivation: true, dailyBudgetYocto: NEAR / 100n } });
    expect(await activate(implicit(1), { as: null })).toEqual({ status: 503, body: { error: "daily_budget_exhausted" } });
  });
});
