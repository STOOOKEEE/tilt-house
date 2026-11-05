import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TransactionTimeoutError } from "near-api-js/rpc-errors";
import type { Chain } from "./chain.ts";
import { ACCOUNT_ID } from "./config.ts";
import {
  checkDelegate,
  checkExpiry,
  checkSignature,
  decodeSignedDelegate,
  isGameOnly,
  signerPublicKey,
  type PolicyConfig,
} from "./policy.ts";
import { RateLimiter } from "./rateLimit.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_BODY_BYTES = 16 * 1024;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
/** 100 tUSDC (6 decimals), minted on activation and per faucet claim. */
export const MINT_AMOUNT = 100_000_000n;

export const LIMITS = {
  relayPerSender: 30,
  relayGlobal: 600,
  activatePerIp: 5,
  activateGlobalPerHour: 100,
  faucetPerIp: 5,
  faucetGlobalPerHour: 100,
} as const;

export interface AppDeps {
  config: PolicyConfig & { activationYocto: bigint };
  chain: Chain;
  now?: () => number;
}

function fail(c: Context, status: ContentfulStatusCode, error: string) {
  return c.json({ error }, status);
}

async function jsonField(c: Context, field: string): Promise<string | null> {
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The relayer listens on loopback only; public traffic reaches it through the local HTTPS proxy
 * (Tailscale Funnel), which appends the real client to X-Forwarded-For. Only that last entry is
 * trusted: earlier ones come from the client and can be forged.
 */
function clientIp(c: Context): string | undefined {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  return peer !== undefined && LOOPBACK.has(peer) && forwarded ? forwarded : peer;
}

export function createApp({ config, chain, now = Date.now }: AppDeps): Hono {
  const relaySender = new RateLimiter(LIMITS.relayPerSender, MINUTE_MS);
  const relayGlobal = new RateLimiter(LIMITS.relayGlobal, MINUTE_MS);
  const activateIp = new RateLimiter(LIMITS.activatePerIp, MINUTE_MS);
  const activateGlobal = new RateLimiter(LIMITS.activateGlobalPerHour, HOUR_MS);
  const faucetIp = new RateLimiter(LIMITS.faucetPerIp, MINUTE_MS);
  const faucetGlobal = new RateLimiter(LIMITS.faucetGlobalPerHour, HOUR_MS);
  // One claim per account per hour; the token contract also caps mints per 24 h.
  const faucetAccount = new RateLimiter(1, HOUR_MS);
  // Accounts this process already funded; an in-flight activation counts too, so
  // two concurrent requests cannot both pay.
  const activated = new Set<string>();

  const app = new Hono();
  app.use("*", cors());
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, "body_too_large") }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/relay", async (c) => {
    if (!relayGlobal.take("*", now())) return fail(c, 429, "rate_limited");
    const encoded = await jsonField(c, "signedDelegate");
    if (encoded === null) return fail(c, 400, "invalid_body");
    const signed = decodeSignedDelegate(encoded);
    if (!signed) return fail(c, 400, "invalid_encoding");
    const delegate = signed.delegateAction;

    const policy = checkDelegate(delegate, config);
    if (!policy.ok) return fail(c, 403, policy.reason);
    const signature = checkSignature(signed);
    if (!signature.ok) return fail(c, 403, signature.reason);
    // checkSignature already refused anything but ed25519, so the key exists.
    const publicKey = signerPublicKey(delegate);
    if (!publicKey) return fail(c, 403, "unsupported_key_type");

    try {
      const expiry = checkExpiry(delegate.maxBlockHeight, await chain.blockHeight());
      if (!expiry.ok) return fail(c, 403, expiry.reason);
      const key = await chain.accessKey(delegate.senderId, publicKey.toString());
      if (!key) return fail(c, 403, "unknown_key");
      if (policy.needsFullAccess && !key.fullAccess) return fail(c, 403, "key_not_full_access");
      if (delegate.nonce <= key.nonce) return fail(c, 403, "stale_nonce");
      // Counted only once the key is proven to belong to the sender, so nobody can
      // burn another account's quota with forged payloads.
      if (!relaySender.take(delegate.senderId, now())) return fail(c, 429, "rate_limited");
      // A game move's result shows up in the round the page polls: answering at inclusion saves
      // the whole execution (VRF included). Money and key moves wait for their outcome.
      return c.json(await chain.relay(signed, isGameOnly(delegate, config) ? "included" : "executed"));
    } catch (error) {
      if (error instanceof TransactionTimeoutError) return fail(c, 504, "rpc_timeout");
      console.error("relay failed", error);
      return fail(c, 502, "rpc_error");
    }
  });

  app.post("/activate", async (c) => {
    const ip = clientIp(c) ?? "unknown";
    if (!activateIp.take(ip, now()) || !activateGlobal.take("*", now())) return fail(c, 429, "rate_limited");
    const accountId = await jsonField(c, "accountId");
    if (accountId === null) return fail(c, 400, "invalid_body");
    if (!IMPLICIT_ACCOUNT.test(accountId)) return fail(c, 403, "not_implicit_account");
    if (activated.has(accountId)) return fail(c, 409, "already_activated");
    activated.add(accountId);
    try {
      return c.json(await chain.activate(accountId, config.activationYocto, MINT_AMOUNT));
    } catch (error) {
      // Let the player retry; a retry skips the transfer and registration already done.
      activated.delete(accountId);
      console.error("activation failed", error);
      return fail(c, 502, "rpc_error");
    }
  });

  app.post("/faucet", async (c) => {
    const ip = clientIp(c) ?? "unknown";
    if (!faucetIp.take(ip, now()) || !faucetGlobal.take("*", now())) return fail(c, 429, "rate_limited");
    const accountId = await jsonField(c, "accountId");
    if (accountId === null) return fail(c, 400, "invalid_body");
    if (!ACCOUNT_ID.test(accountId)) return fail(c, 403, "invalid_account");
    // The claim is spent even if the mint fails: fail closed, the player retries in an hour.
    if (!faucetAccount.take(accountId, now())) return fail(c, 429, "already_claimed");
    try {
      await chain.mint(accountId, MINT_AMOUNT);
      return c.json({ minted: MINT_AMOUNT.toString() });
    } catch (error) {
      console.error("faucet mint failed", error);
      return fail(c, 502, "mint_failed");
    }
  });

  return app;
}
