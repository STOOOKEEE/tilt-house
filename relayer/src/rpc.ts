import { createHash } from "node:crypto";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { JsonRpcProvider, baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { RpcError, TransactionTimeoutError } from "near-api-js/rpc-errors";

/**
 * A JSON-RPC provider over several endpoints (`NEAR_RPC_URLS`, preferred first) that backs off
 * instead of hammering. An endpoint that is rate-limiting, overloaded, timing out or unreachable
 * cools down (1 s, doubling up to 30 s, reset by a success) and the request moves to the next
 * endpoint, or waits for the first one to cool down. Any other error is the request's own answer
 * and is thrown as is.
 *
 * Transactions fail over too, still preferring the first endpoint: the same signed bytes are sent
 * again (same hash, same nonce), which is idempotent: a node that already has the transaction
 * answers with its outcome. When an attempt may have reached a node (a timeout) and the last one
 * fails, the transaction's status is asked by hash on any endpoint, so a landed transaction is
 * reported as such rather than as an error.
 *
 * near-api-js's `FailoverRpcProvider` switches on every error, contract errors included, and
 * rethrows them wrapped, which hides `AccessKeyDoesNotExistError` and the like from the caller.
 */

type RpcMethodName = Parameters<JsonRpcProvider["sendJsonRpc"]>[0];

/** `overload`: the endpoint refused, try elsewhere. `timeout`: same, but the request may have reached the node. */
export type Failure = "overload" | "timeout";

const OVERLOAD_STATUS: Record<number, true> = { 429: true, 500: true, 502: true, 503: true, 504: true };
const TIMEOUT_STATUS = 408;
const TX_METHODS: Record<string, true> = { send_tx: true, broadcast_tx_commit: true, broadcast_tx_async: true };
// near-api-js's message for a JSON-RPC error without a NEAR error name: gateways answer that way
// (FastNear `{"code":-429,"message":"Rate limits exceeded…"}`, dRPC plan limits); nearcore never does.
const NON_NEAR_ERROR = "Unknown RPC error";
const DEFAULT_WAIT_UNTIL = "EXECUTED_OPTIMISTIC";
export const MAX_ATTEMPTS = 4;
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Whether an error is the endpoint's trouble rather than the request's answer. near-api-js puts
 * the HTTP status in `cause` (ProviderError, the 429 body in the message); nearcore's own send_tx
 * timeout is a TransactionTimeoutError; network failures are TypeErrors.
 */
export function classify(error: unknown): Failure | null {
  if (error instanceof TransactionTimeoutError) return "timeout";
  if (!(error instanceof Error)) return null;
  if (typeof error.cause === "number") {
    if (error.cause === TIMEOUT_STATUS) return "timeout";
    return OVERLOAD_STATUS[error.cause] === true ? "overload" : null;
  }
  if (error instanceof RpcError && error.message === NON_NEAR_ERROR) return "overload";
  if (/Rate limits? exceeded/i.test(error.message)) return "overload";
  // The connection broke: a transaction may have been delivered before it did.
  if (/fetch failed|Failed to fetch/.test(`${error.name} ${error.message}`)) return "timeout";
  if (error.name === "RetriesExceeded") return "overload";
  return null;
}

/** The `tx` status request for a `send_tx` / `broadcast_tx_*` request, or null if its params are not a signed transaction. */
export function statusRequest(params: unknown): { tx_hash: string; sender_account_id: string; wait_until: string } | null {
  let encoded: unknown;
  let waitUntil: unknown = DEFAULT_WAIT_UNTIL;
  if (Array.isArray(params)) encoded = params[0];
  else if (typeof params === "object" && params !== null && "signed_tx_base64" in params) {
    encoded = params.signed_tx_base64;
    if ("wait_until" in params && typeof params.wait_until === "string") waitUntil = params.wait_until;
  }
  if (typeof encoded !== "string" || typeof waitUntil !== "string") return null;
  try {
    const { transaction } = decodeSignedTransaction(Buffer.from(encoded, "base64"));
    const hash = createHash("sha256").update(encodeTransaction(transaction)).digest();
    return { tx_hash: baseEncode(hash), sender_account_id: transaction.signerId, wait_until: waitUntil };
  } catch {
    return null;
  }
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

/** The preferred endpoint not cooling down, else the first to cool down. */
export function pick(endpoints: readonly Endpoint[], now: number): { index: number; waitMs: number } {
  let earliest = { index: 0, waitMs: Infinity };
  for (const [index, endpoint] of endpoints.entries()) {
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
    const isTx = TX_METHODS[method] === true;
    let maybeDelivered = false;
    for (let attempt = 1; ; attempt++) {
      const { index, waitMs } = pick(this.endpoints, this.now());
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
        const failure = classify(error);
        if (failure === "timeout") maybeDelivered = true;
        // A refusal after a possible delivery (e.g. the nonce is now used) may be the first copy landing.
        if (failure === null || attempt >= MAX_ATTEMPTS) {
          if (failure !== null) cooled(endpoint, this.now());
          if (isTx && maybeDelivered) return this.landedOr<R>(params, error);
          throw error;
        }
        cooled(endpoint, this.now());
        this.log(`rpc ${endpoint.url} ${method}: ${failure}: ${error instanceof Error ? error.message : String(error)}, retrying (attempt ${attempt})`);
      }
    }
  }

  /** The outcome of a transaction that may have landed, or `error` if the chain does not know it. */
  private async landedOr<R>(params: unknown, error: unknown): Promise<R> {
    const request = statusRequest(params);
    if (!request) throw error;
    try {
      const outcome = await this.sendJsonRpc<"tx", typeof request, R>("tx", request);
      this.log(`rpc: transaction ${request.tx_hash} landed despite the errors`);
      return outcome;
    } catch {
      throw error;
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
