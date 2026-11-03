import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, MINT_AMOUNT, createApp } from "../src/app.ts";
import { CONFIG, FakeChain } from "./helpers.ts";

let chain: FakeChain;
let clock: number;
let app: Hono;

beforeEach(() => {
  chain = new FakeChain();
  clock = 0;
  app = createApp({ config: CONFIG, chain, now: () => clock });
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
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: "cd".repeat(32) }) },
      { incoming: { socket: { remoteAddress: "10.0.0.1" } } },
    );
    expect(res.status).toBe(200);
  });
});
