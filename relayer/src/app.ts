import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TransactionTimeoutError } from "near-api-js/rpc-errors";
import { DailyBudget } from "./budget.ts";
import type { Chain } from "./chain.ts";
import { ACCOUNT_ID, type FaucetMode, type Network } from "./config.ts";
import { isRecord } from "./guards.ts";
import {
  checkDelegate,
  checkExpiry,
  checkSignature,
  decodeSignedDelegate,
  isGameOnly,
  signerPublicKey,
  type PolicyConfig,
} from "./policy.ts";
import type { VerifyToken } from "./privy.ts";
import { RateLimiter } from "./rateLimit.ts";
import type { StateStore } from "./state.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_BODY_BYTES = 16 * 1024;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
/** The TILT token's refusal of a second welcome for an account (meme/). */
const WELCOME_ALREADY_CLAIMED = "Welcome already claimed";
/** 300 tUSDC (6 decimals), minted on activation: a 200 tUSDC table seed plus a seat's rent. */
export const ACTIVATION_AMOUNT = 300_000_000n;
/** 100 tUSDC, minted per faucet claim. */
export const FAUCET_AMOUNT = 100_000_000n;

export const LIMITS = {
  relayPerSender: 30,
  relayGlobal: 600,
  /** Behind Vercel and the Funnel, many judges (shared cloud IPs) can share one address. */
  activatePerIp: 15,
  activateGlobalPerHour: 100,
  faucetPerIp: 5,
  faucetGlobalPerHour: 100,
  /** Testnet activations without a Privy login (CLI demo), on top of the limits above. */
  anonymousActivateGlobalPerHour: 60,
} as const;

export interface AppDeps {
  config: PolicyConfig & {
    network: Network;
    activationYocto: bigint;
    dailyBudgetYocto: bigint;
    paused: boolean;
    anonymousActivation: boolean;
    faucetMode: FaucetMode;
  };
  chain: Chain;
  verifyToken: VerifyToken;
  store: StateStore;
  now?: () => number;
}

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

function fail(c: Context, status: ContentfulStatusCode, error: string) {
  return c.json({ error }, status);
}

async function jsonField(c: Context, field: string): Promise<string | null> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body)) return null;
  const value = body[field];
  return typeof value === "string" ? value : null;
}

const LOOPBACK: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };

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
  return peer !== undefined && LOOPBACK[peer] === true && forwarded ? forwarded : peer;
}

type Auth = { ok: true; userId: string } | { ok: false; response: Response };

export function createApp({ config, chain, verifyToken, store, now = Date.now }: AppDeps): Hono {
  const relaySender = new RateLimiter(LIMITS.relayPerSender, MINUTE_MS);
  const relayGlobal = new RateLimiter(LIMITS.relayGlobal, MINUTE_MS);
  const activateIp = new RateLimiter(LIMITS.activatePerIp, MINUTE_MS);
  const activateGlobal = new RateLimiter(LIMITS.activateGlobalPerHour, HOUR_MS);
  const anonymousActivateGlobal = new RateLimiter(LIMITS.anonymousActivateGlobalPerHour, HOUR_MS);
  const faucetIp = new RateLimiter(LIMITS.faucetPerIp, MINUTE_MS);
  const faucetGlobal = new RateLimiter(LIMITS.faucetGlobalPerHour, HOUR_MS);
  // One claim per account per hour; the token contract also caps mints per 24 h.
  const faucetAccount = new RateLimiter(1, HOUR_MS);
  const budget = new DailyBudget(config.dailyBudgetYocto, store, () => chain.relayerBalance());
  // Testnet keeps an open faucet (judges with their own CLI accounts use it); on mainnet, and for
  // TILT welcome claims, only a Privy user may claim, for the account the relayer activated for them.
  const welcome = config.faucetMode === "welcome";
  const faucetNeedsLogin = config.network === "mainnet" || welcome;

  /** A Privy-authenticated caller, or the refusal to send. Key fetch errors fail closed. */
  async function authenticate(c: Context): Promise<Auth> {
    const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return { ok: false, response: fail(c, 401, "missing_token") };
    try {
      const check = await verifyToken(token, now());
      if (check.ok) return check;
      return { ok: false, response: fail(c, 401, "invalid_token") };
    } catch (error) {
      console.error("privy keys unavailable", error);
      return { ok: false, response: fail(c, 503, "auth_unavailable") };
    }
  }

  const app = new Hono();
  app.use("*", cors());
  app.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, "body_too_large") }));
  // Kill switch: nothing that spends NEAR runs while paused; /health stays up to report it.
  app.use("*", async (c, next) => {
    if (config.paused && c.req.method === "POST") return fail(c, 503, "paused");
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, network: config.network, paused: config.paused }));

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
      if (!(await budget.allows(now(), 0n))) return fail(c, 503, "daily_budget_exhausted");
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
    // Testnet without a token: an anonymous activation, bound to the account alone. A token that is
    // sent but fails verification is refused, never downgraded to anonymous.
    const anonymous = config.anonymousActivation && c.req.header("authorization") === undefined;
    if (anonymous && !anonymousActivateGlobal.take("*", now())) return fail(c, 429, "rate_limited");
    let privyUser: string | null = null;
    if (!anonymous) {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      privyUser = auth.userId;
    }
    const accountId = await jsonField(c, "accountId");
    if (accountId === null) return fail(c, 400, "invalid_body");
    if (!IMPLICIT_ACCOUNT.test(accountId)) return fail(c, 403, "not_implicit_account");
    const userId = privyUser ?? `anonymous:${accountId}`;
    try {
      if (!(await budget.allows(now(), config.activationYocto))) return fail(c, 503, "daily_budget_exhausted");
    } catch (error) {
      console.error("budget check failed", error);
      return fail(c, 502, "rpc_error");
    }
    // No await between these checks and `bind`: two concurrent requests cannot both pay.
    // One activation per Privy user and one per account, remembered across restarts.
    if (store.hasUser(userId) || store.hasAccount(accountId)) return fail(c, 409, "already_activated");
    store.bind(userId, accountId, now());
    try {
      const plan = { near: config.activationYocto, topUp: !welcome, tokens: welcome ? 0n : ACTIVATION_AMOUNT };
      return c.json(await chain.activate(accountId, plan));
    } catch (error) {
      // Let the player retry; a retry skips the transfer and registration already done.
      store.unbind(userId);
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
    let claimant = accountId;
    if (faucetNeedsLogin) {
      const auth = await authenticate(c);
      if (!auth.ok) return auth.response;
      if (store.state.activations[auth.userId]?.accountId !== accountId) return fail(c, 403, "not_your_account");
      claimant = auth.userId;
    }
    try {
      if (!(await budget.allows(now(), 0n))) return fail(c, 503, "daily_budget_exhausted");
    } catch (error) {
      console.error("budget check failed", error);
      return fail(c, 502, "rpc_error");
    }
    if (welcome) return claimWelcome(c, claimant, accountId);
    // The claim is spent even if the mint fails: fail closed, the player retries in an hour.
    if (!faucetAccount.take(claimant, now())) return fail(c, 429, "already_claimed");
    try {
      await chain.mint(accountId, FAUCET_AMOUNT);
      return c.json({ minted: FAUCET_AMOUNT.toString() });
    } catch (error) {
      console.error("faucet mint failed", error);
      return fail(c, 502, "mint_failed");
    }
  });

  /**
   * Once per Privy user (and so per account: activation binds one to the other), remembered
   * across restarts. A failed claim is forgotten so the player can retry (daily cap, RPC): the
   * token itself refuses a second claim for an account, so a retry can never pay twice. That
   * refusal is kept as a claim, so a lost state file does not reopen retries.
   */
  async function claimWelcome(c: Context, userId: string, accountId: string): Promise<Response> {
    // No await between this check and `markWelcome`: two concurrent requests cannot both claim.
    if (store.hasWelcome(userId)) return fail(c, 409, "already_claimed");
    store.markWelcome(userId, accountId, now());
    try {
      return c.json({ welcomed: (await chain.claimWelcome(accountId)).toString() });
    } catch (error) {
      if (error instanceof Error && error.message.includes(WELCOME_ALREADY_CLAIMED)) return fail(c, 409, "already_claimed");
      store.unmarkWelcome(userId);
      console.error("welcome claim failed", error);
      return fail(c, 502, "welcome_failed");
    }
  }

  return app;
}
