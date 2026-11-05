import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, createApp } from "../src/app.ts";
import { CONFIG, FakeChain } from "./helpers.ts";

let chain: FakeChain;
let clock: number;
let app: Hono;

beforeEach(() => {
  chain = new FakeChain();
  clock = 0;
  app = createApp({ config: CONFIG, chain, now: () => clock });
});

const implicit = (n: number) => n.toString(16).padStart(64, "0");

async function activate(accountId: unknown, ip = "10.0.0.1", forwardedFor?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
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
    expect(await activate(implicit(2))).toEqual({ status: 502, body: { error: "rpc_error" } });
    chain.activateError = null;
    expect((await activate(implicit(2))).status).toBe(200);
  });

  it(`allows ${LIMITS.activatePerIp} requests per IP per minute`, async () => {
    for (let i = 0; i < LIMITS.activatePerIp; i++) expect((await activate(implicit(10 + i))).status).toBe(200);
    expect(await activate(implicit(99))).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect((await activate(implicit(99), "10.0.0.2")).status).toBe(200);
    clock += 60_000;
    expect((await activate(implicit(100))).status).toBe(200);
  });

  it(`caps activations at ${LIMITS.activateGlobalPerHour} per hour`, async () => {
    for (let i = 0; i < LIMITS.activateGlobalPerHour; i++) {
      expect((await activate(implicit(1000 + i), `10.1.${Math.floor(i / 100)}.${i % 100}`)).status).toBe(200);
    }
    expect(await activate(implicit(5000), "10.9.9.9")).toEqual({ status: 429, body: { error: "rate_limited" } });
    clock += 60 * 60_000;
    expect((await activate(implicit(5000), "10.9.9.9")).status).toBe(200);
  });

  it("behind the local proxy, limits the client it names last, not a forged earlier entry", async () => {
    const viaProxy = (n: number, forwarded: string) => activate(implicit(n), "127.0.0.1", forwarded);
    for (let i = 0; i < LIMITS.activatePerIp; i++) {
      expect((await viaProxy(200 + i, `6.6.6.${i}, 203.0.113.7`)).status).toBe(200);
    }
    expect((await viaProxy(299, "1.2.3.4, 203.0.113.7")).status).toBe(429);
    expect((await viaProxy(300, "203.0.113.8")).status).toBe(200);
  });

  it("ignores X-Forwarded-For from a non-loopback peer", async () => {
    for (let i = 0; i < LIMITS.activatePerIp; i++) {
      expect((await activate(implicit(400 + i), "10.0.0.9", `198.51.100.${i}`)).status).toBe(200);
    }
    expect((await activate(implicit(499), "10.0.0.9", "198.51.100.200")).status).toBe(429);
  });
});
