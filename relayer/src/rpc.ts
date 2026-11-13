import { setTimeout as defaultSleep } from "node:timers/promises";
import { JsonRpcProvider } from "near-api-js";

/**
 * A JSON-RPC provider over several endpoints (`NEAR_RPC_URLS`, preferred first) that backs off
 * instead of hammering: an endpoint answering 429, 408 or 5xx (or unreachable) cools down (1 s,
 * doubling up to 30 s, reset by a success) and the request moves to the next endpoint, or waits
 * for the first one to cool down. Transactions go to the first endpoint only: a failover endpoint
 * may serve reads well and time out on `send_tx`. Resending a signed transaction is safe (same
 * hash, same nonce). Any other error is the request's own answer and is thrown as is.
 *
 * near-api-js's `FailoverRpcProvider` switches on every error, contract errors included, and
 * rethrows them wrapped, which hides `AccessKeyDoesNotExistError` and the like from the caller.
 */

type RpcMethodName = Parameters<JsonRpcProvider["sendJsonRpc"]>[0];

const OVERLOAD_STATUS: Record<number, true> = { 408: true, 429: true, 500: true, 502: true, 503: true, 504: true };
const TX_METHODS: Record<string, true> = { send_tx: true, broadcast_tx_commit: true, broadcast_tx_async: true };
export const MAX_ATTEMPTS = 4;
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** near-api-js puts the HTTP status in `cause` (ProviderError); fetch failures are TypeErrors. */
export function isOverload(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (typeof error.cause === "number") return OVERLOAD_STATUS[error.cause] === true;
  return /fetch failed|Failed to fetch|RetriesExceeded/.test(`${error.name} ${error.message}`);
}

export interface Endpoint {
  url: string;
  /** Unix ms until which it is skipped. */
  coolUntil: number;
  /** The next cool-down; 0 after a success. */
  backoffMs: number;
}

export function cooled(endpoint: Endpoint, now: number): void {
  const backoff = endpoint.backoffMs === 0 ? FIRST_BACKOFF_MS : endpoint.backoffMs;
  endpoint.coolUntil = now + backoff;
  endpoint.backoffMs = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

/** Among the first `usable`: the preferred endpoint not cooling down, else the first to cool down. */
export function pick(endpoints: readonly Endpoint[], usable: number, now: number): { index: number; waitMs: number } {
  let earliest = { index: 0, waitMs: Infinity };
  for (const [index, endpoint] of endpoints.slice(0, usable).entries()) {
    const waitMs = endpoint.coolUntil - now;
    if (waitMs <= 0) return { index, waitMs: 0 };
    if (waitMs < earliest.waitMs) earliest = { index, waitMs };
  }
  return earliest;
}

export interface FailoverOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
}

export class FailoverProvider extends JsonRpcProvider {
  readonly endpoints: Endpoint[];
  private readonly providers: JsonRpcProvider[];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;
  private readonly log: (line: string) => void;

  constructor(urls: readonly string[], { now = Date.now, sleep = defaultSleep, log = console.error }: FailoverOptions = {}) {
    const first = urls[0];
    if (first === undefined) throw new Error("no NEAR RPC URL");
    super({ url: first });
    this.endpoints = urls.map((url) => ({ url, coolUntil: 0, backoffMs: 0 }));
    // One attempt each: retries and backoff happen here, across endpoints.
    this.providers = urls.map((url) => new JsonRpcProvider({ url }, { retries: 1 }));
    this.now = now;
    this.sleep = sleep;
    this.log = log;
  }

  override async sendJsonRpc<M extends RpcMethodName, P, R>(method: M, params: P): Promise<R> {
    const usable = TX_METHODS[method] === true ? 1 : this.endpoints.length;
    for (let attempt = 1; ; attempt++) {
      const { index, waitMs } = pick(this.endpoints, usable, this.now());
      if (waitMs > 0) await this.sleep(waitMs);
      const endpoint = this.endpoints[index];
      const provider = this.providers[index];
      if (!endpoint || !provider) throw new Error(`no RPC endpoint ${index}`);
      try {
        const result = await provider.sendJsonRpc<M, P, R>(method, params);
        endpoint.backoffMs = 0;
        endpoint.coolUntil = 0;
        return result;
      } catch (error) {
        if (!isOverload(error)) throw error;
        cooled(endpoint, this.now());
        if (attempt >= MAX_ATTEMPTS) throw error;
        this.log(`rpc ${endpoint.url} ${method}: ${error instanceof Error ? error.message : String(error)}, backing off (attempt ${attempt})`);
      }
    }
  }
}

/** `NEAR_RPC_URLS` (comma-separated), else `NEAR_RPC_URL`, else the network's defaults. */
export function rpcUrls(env: NodeJS.ProcessEnv, defaults: readonly string[]): string[] {
  const list = env.NEAR_RPC_URLS ?? env.NEAR_RPC_URL;
  const urls = list === undefined ? [...defaults] : list.split(",").map((u) => u.trim()).filter((u) => u !== "");
  if (urls.length === 0) throw new Error("env NEAR_RPC_URLS is empty");
  for (const url of urls) if (!/^https?:\/\//.test(url)) throw new Error(`env NEAR_RPC_URLS: ${url} is not an http(s) URL`);
  return urls;
}
