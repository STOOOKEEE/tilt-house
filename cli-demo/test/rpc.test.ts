import { afterEach, describe, expect, it, vi } from "vitest";
import { viewCall } from "../../web/src/near/views";
import { FallbackProvider, RATE_LIMITED, Rpc } from "../src/rpc.ts";

const PRIMARY = "https://primary.test";
const FALLBACK = "https://fallback.test";
const VIEW_OK = { jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from('"ok"')], logs: [], block_height: 1, block_hash: "h" } };
const FASTNEAR_LIMIT = { jsonrpc: "2.0", id: "x", error: { code: -429, message: "Rate limits exceeded" } };

type Reply = { status: number; body: unknown };

/** A fake `fetch`: each endpoint answers with its function; every request is recorded. */
function fakeFetch(answers: Record<string, () => Reply>): string[] {
  const hits: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      hits.push(url);
      const answer = answers[url];
      if (answer === undefined) throw new TypeError("fetch failed");
      const { status, body } = answer();
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return hits;
}

const tooMany = (): Reply => ({ status: 429, body: { error: "Too Many Requests" } });
const ok = (): Reply => ({ status: 200, body: VIEW_OK });

function rpc(configured = PRIMARY): { rpc: Rpc; notices: string[] } {
  const notices: string[] = [];
  return { rpc: new Rpc(configured, { fallback: FALLBACK, retryBaseMs: 0, notice: (text) => notices.push(text) }), notices };
}

const read = (r: Rpc) => r.call((url) => viewCall(url, "floor.testnet", "get_config"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Rpc", () => {
  it("falls back after the configured endpoint's retries, says so once and stays there", async () => {
    const hits = fakeFetch({ [PRIMARY]: tooMany, [FALLBACK]: ok });
    const { rpc: r, notices } = rpc();
    expect(await read(r)).toBe("ok");
    expect(await read(r)).toBe("ok");
    expect(hits.filter((u) => u === PRIMARY)).toHaveLength(6);
    expect(hits.filter((u) => u === FALLBACK)).toHaveLength(2);
    expect(notices).toEqual([`RPC ${PRIMARY} rate-limited, using ${FALLBACK}`]);
  });

  it("treats a JSON-RPC -429 at HTTP 200 (FastNear) and network failures as rate limits", async () => {
    fakeFetch({ [PRIMARY]: () => ({ status: 200, body: FASTNEAR_LIMIT }), [FALLBACK]: ok });
    expect(await read(rpc().rpc)).toBe("ok");
    fakeFetch({ [FALLBACK]: ok });
    expect(await read(rpc().rpc)).toBe("ok");
  });

  it("stays on the configured endpoint while it answers", async () => {
    let calls = 0;
    const hits = fakeFetch({ [PRIMARY]: () => (++calls < 3 ? tooMany() : ok()), [FALLBACK]: ok });
    const { rpc: r, notices } = rpc();
    expect(await read(r)).toBe("ok");
    expect(hits).toEqual([PRIMARY, PRIMARY, PRIMARY]);
    expect(notices).toEqual([]);
  });

  it("says what to do when the fallback is rate-limited too", async () => {
    fakeFetch({ [PRIMARY]: tooMany, [FALLBACK]: () => ({ status: 503, body: null }) });
    await expect(read(rpc().rpc)).rejects.toThrow(RATE_LIMITED);
    fakeFetch({ [FALLBACK]: tooMany });
    await expect(read(rpc(FALLBACK).rpc)).rejects.toThrow(RATE_LIMITED);
  });

  it("never retries nor falls back on a real answer (a contract error)", async () => {
    const panic = { jsonrpc: "2.0", id: "x", result: { error: "wasm execution failed", logs: [], block_height: 1, block_hash: "h" } };
    const hits = fakeFetch({ [PRIMARY]: () => ({ status: 200, body: panic }), [FALLBACK]: ok });
    await expect(read(rpc().rpc)).rejects.toThrow(/wasm execution failed/);
    expect(hits).toEqual([PRIMARY]);
  });
});

describe("FallbackProvider", () => {
  it("sends near-api-js requests through the fallback", async () => {
    const status = { jsonrpc: "2.0", id: "x", result: { chain_id: "testnet" } };
    const hits = fakeFetch({ [PRIMARY]: tooMany, [FALLBACK]: () => ({ status: 200, body: status }) });
    const { rpc: r, notices } = rpc();
    expect(await new FallbackProvider(r).viewNodeStatus()).toEqual({ chain_id: "testnet" });
    expect(hits.filter((u) => u === PRIMARY)).toHaveLength(6);
    expect(notices).toHaveLength(1);
  });

  it("fails with the hint when every endpoint is rate-limited", async () => {
    fakeFetch({ [PRIMARY]: tooMany, [FALLBACK]: tooMany });
    await expect(new FallbackProvider(rpc().rpc).viewNodeStatus()).rejects.toThrow(RATE_LIMITED);
  });
});
