/**
 * NEAR RPC with one fallback. Calls go to the configured endpoint (default fastnear) with retries;
 * when it keeps refusing (429, 5xx, timeouts: a shared cloud IP gets rate-limited), the call and
 * every later one of the run go to dRPC's public testnet endpoint. Testnet only, like every target.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { JsonRpcProvider } from "near-api-js";
import { color, errorMessage, line } from "./ui.ts";

export const FALLBACK_RPC = "https://near-testnet.drpc.org";
export const RATE_LIMITED = "public RPC rate-limited: retry later or pass --rpc <url>";

const RETRIES = 6;
const RETRY_BASE_MS = 400;
/** HTTP statuses near-api-js puts in an error's `cause`: the endpoint's trouble, not the answer. */
const OVERLOAD_STATUS: Record<number, true> = { 408: true, 429: true, 500: true, 502: true, 503: true, 504: true };
/**
 * RPC and NearBlocks rate-limit; a network blip is not a verdict either. Gateways also answer a
 * JSON-RPC error at HTTP 200 (FastNear `{"code":-429,"message":"Rate limits exceeded…"}`), which
 * near-api-js reports as "Unknown RPC error" (nearcore always names its errors).
 */
const TRANSIENT =
  /HTTP (408|429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|Rate limits? exceeded|"code":-429|Unknown RPC error|RetriesExceeded/i;

export function isTransient(error: unknown): boolean {
  if (error instanceof Error && typeof error.cause === "number" && OVERLOAD_STATUS[error.cause] === true) return true;
  const name = error instanceof Error ? error.name : "";
  return TRANSIENT.test(`${name} ${errorMessage(error)}`);
}

export async function withRetry<T>(task: () => Promise<T>, retryBaseMs = RETRY_BASE_MS): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= RETRIES || !isTransient(error)) throw error;
      await sleep(retryBaseMs * 2 ** attempt);
    }
  }
}

export interface RpcOptions {
  fallback?: string;
  retryBaseMs?: number;
  /** Told once, when the run moves to the fallback. */
  notice?: (text: string) => void;
}

/** One configured endpoint and its fallback; once fallen back, the run stays there. */
export class Rpc {
  readonly configured: string;
  readonly #fallback: string;
  readonly #retryBaseMs: number;
  readonly #notice: (text: string) => void;
  #fellBack = false;

  constructor(configured: string, options: RpcOptions = {}) {
    this.configured = configured;
    this.#fallback = options.fallback ?? FALLBACK_RPC;
    this.#retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.#notice = options.notice ?? ((text) => line(color.dim(text)));
  }

  /** Runs `task` against the endpoint in use; a non-transient error (a contract's answer) is never retried. */
  async call<T>(task: (url: string) => Promise<T>): Promise<T> {
    if (!this.#fellBack) {
      try {
        return await withRetry(() => task(this.configured), this.#retryBaseMs);
      } catch (error) {
        if (!isTransient(error)) throw error;
        if (this.configured === this.#fallback) throw this.#rateLimited(error);
        this.#fallBack();
      }
    }
    try {
      return await withRetry(() => task(this.#fallback), this.#retryBaseMs);
    } catch (error) {
      throw isTransient(error) ? this.#rateLimited(error) : error;
    }
  }

  #fallBack(): void {
    // Concurrent calls may fail together: say it once.
    if (this.#fellBack) return;
    this.#fellBack = true;
    this.#notice(`RPC ${this.configured} rate-limited, using ${this.#fallback}`);
  }

  #rateLimited(error: unknown): Error {
    const tried = [...new Set([this.configured, this.#fallback])].join(", ");
    return new Error(`${RATE_LIMITED} (tried ${tried})`, { cause: error });
  }
}

const endpoints = new Map<string, Rpc>();

/** The run's `Rpc` for a configured URL, shared so the fallback sticks across every reader. */
export function rpcFor(url: string): Rpc {
  let rpc = endpoints.get(url);
  if (rpc === undefined) {
    rpc = new Rpc(url);
    endpoints.set(url, rpc);
  }
  return rpc;
}

/** near-api-js does one try per endpoint; `Rpc` retries and falls back. */
const SINGLE_TRY = { retries: 1 };

/** A near-api-js provider (accounts, signing, txs) whose every request goes through an `Rpc`. */
export class FallbackProvider extends JsonRpcProvider {
  readonly #rpc: Rpc;
  readonly #byUrl = new Map<string, JsonRpcProvider>();

  constructor(rpc: Rpc) {
    super({ url: rpc.configured }, SINGLE_TRY);
    this.#rpc = rpc;
  }

  override sendJsonRpc<Method extends Parameters<JsonRpcProvider["sendJsonRpc"]>[0], Params, Result>(
    method: Method,
    params: Params,
  ): Promise<Result> {
    return this.#rpc.call((url) => this.#provider(url).sendJsonRpc<Method, Params, Result>(method, params));
  }

  #provider(url: string): JsonRpcProvider {
    let provider = this.#byUrl.get(url);
    if (provider === undefined) {
      provider = new JsonRpcProvider({ url }, SINGLE_TRY);
      this.#byUrl.set(url, provider);
    }
    return provider;
  }
}
