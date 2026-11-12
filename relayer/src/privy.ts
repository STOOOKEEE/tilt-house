import { webcrypto } from "node:crypto";
import { isRecord } from "./guards.ts";

/**
 * Verifies Privy access tokens (ES256 JWTs) against the app's JWKS, so the relayer pays only for
 * people who logged in through Privy. Privy's documented checks: issuer `privy.io`, audience =
 * the app id, not expired; `sub` is the user's Privy DID, stable across devices and logins.
 */

export const PRIVY_ISSUER = "privy.io";
export const privyJwksUrl = (appId: string) => `https://auth.privy.io/api/v1/apps/${appId}/jwks.json`;

/** Keys are cached this long, then refetched (Privy rotates keys rarely, with overlap). */
export const JWKS_TTL_MS = 60 * 60_000;
/** A token naming an unknown key triggers at most one refetch per this interval: no fetch storm. */
export const JWKS_REFETCH_MS = 60_000;
/** Tolerated clock difference with Privy for `iat`/`nbf`. */
const CLOCK_SKEW_S = 60;
// Privy tokens are a few hundred bytes; anything far longer is not one.
const MAX_TOKEN_LENGTH = 4096;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const PRIVY_DID = /^did:privy:[A-Za-z0-9]{1,64}$/;

export type TokenRefusal =
  | "malformed"
  | "unsupported_alg"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "invalid_subject";

export type TokenCheck = { ok: true; userId: string } | { ok: false; reason: TokenRefusal };

/** Throws only when the keys cannot be fetched (the caller fails closed); every bad token is a refusal. */
export type VerifyToken = (token: string, nowMs: number) => Promise<TokenCheck>;

type KeyMap = Map<string, webcrypto.CryptoKey>;

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Only P-256 signing keys; anything else in the set is ignored rather than trusted. */
async function importKeys(jwks: unknown): Promise<KeyMap> {
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) throw new Error("Privy JWKS: no keys array");
  const keys: KeyMap = new Map();
  for (const jwk of jwks.keys) {
    if (!isRecord(jwk) || jwk.kty !== "EC" || jwk.crv !== "P-256") continue;
    if (jwk.alg !== undefined && jwk.alg !== "ES256") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    const { kid, x, y } = jwk;
    if (typeof kid !== "string" || typeof x !== "string" || typeof y !== "string") continue;
    const key = await webcrypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y }, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    keys.set(kid, key);
  }
  if (keys.size === 0) throw new Error("Privy JWKS: no usable ES256 key");
  return keys;
}

export async function fetchJwks(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Privy JWKS: HTTP ${response.status}`);
  return response.json();
}

export function privyVerifier(appId: string, loadJwks: () => Promise<unknown>): VerifyToken {
  let keys: KeyMap | null = null;
  let fetchedAt = -Infinity;
  let inFlight: Promise<KeyMap> | null = null;

  function refresh(nowMs: number): Promise<KeyMap> {
    inFlight ??= loadJwks()
      .then(importKeys)
      .then((fresh) => {
        keys = fresh;
        fetchedAt = nowMs;
        return fresh;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function keyFor(kid: string, nowMs: number): Promise<webcrypto.CryptoKey | undefined> {
    const age = nowMs - fetchedAt;
    if (!keys || age >= JWKS_TTL_MS || (!keys.has(kid) && age >= JWKS_REFETCH_MS)) {
      try {
        await refresh(nowMs);
      } catch (error) {
        // A stale but known key still beats refusing every player while Privy's CDN hiccups.
        if (!keys?.has(kid)) throw error;
      }
    }
    return keys?.get(kid);
  }

  return async (token, nowMs) => {
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    const [headerPart, payloadPart, signaturePart] = parts;
    if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart || !parts.every((p) => SEGMENT.test(p))) {
      return { ok: false, reason: "malformed" };
    }
    const header = decodeJson(headerPart);
    const claims = decodeJson(payloadPart);
    if (!header || !claims) return { ok: false, reason: "malformed" };
    // Pinning the algorithm closes the `alg: none` / HMAC-with-the-public-key confusions.
    if (header.alg !== "ES256") return { ok: false, reason: "unsupported_alg" };
    if (typeof header.kid !== "string") return { ok: false, reason: "unknown_key" };

    const key = await keyFor(header.kid, nowMs);
    if (!key) return { ok: false, reason: "unknown_key" };
    const signature = Buffer.from(signaturePart, "base64url");
    const signed = Buffer.from(`${headerPart}.${payloadPart}`, "ascii");
    const valid = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed);
    if (!valid) return { ok: false, reason: "bad_signature" };

    if (claims.iss !== PRIVY_ISSUER) return { ok: false, reason: "wrong_issuer" };
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(appId)) return { ok: false, reason: "wrong_audience" };
    const nowS = Math.floor(nowMs / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowS) return { ok: false, reason: "expired" };
    if (typeof claims.iat === "number" && claims.iat > nowS + CLOCK_SKEW_S) return { ok: false, reason: "not_yet_valid" };
    if (typeof claims.nbf === "number" && claims.nbf > nowS + CLOCK_SKEW_S) return { ok: false, reason: "not_yet_valid" };
    if (typeof claims.sub !== "string" || !PRIVY_DID.test(claims.sub)) return { ok: false, reason: "invalid_subject" };
    return { ok: true, userId: claims.sub };
  };
}
