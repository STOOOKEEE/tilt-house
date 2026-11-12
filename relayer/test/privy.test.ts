import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JWKS_REFETCH_MS, JWKS_TTL_MS, privyVerifier, type TokenRefusal } from "../src/privy.ts";
import { APP_ID, PRIVY_KEY, jwksOf, privyToken } from "./helpers.ts";

const USER = "did:privy:alice00000000000000000000";
const NOW = 1_800_000_000_000;

function counting(jwks: () => Promise<unknown>) {
  const loads = { count: 0 };
  return { loads, load: () => (loads.count++, jwks()) };
}

const otherKey = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const verifier = () => privyVerifier(APP_ID, () => jwksOf(PRIVY_KEY));

describe("privyVerifier", () => {
  it("accepts a token signed by Privy's key for this app and returns the user's DID", async () => {
    expect(await verifier()(await privyToken(USER, NOW), NOW)).toEqual({ ok: true, userId: USER });
  });

  it("accepts an audience list that includes the app", async () => {
    const token = await privyToken(USER, NOW, { claims: { aud: ["other", APP_ID] } });
    expect(await verifier()(token, NOW)).toEqual({ ok: true, userId: USER });
  });

  const refusals: [string, () => Promise<string>, TokenRefusal][] = [
    ["garbage", async () => "not-a-jwt", "malformed"],
    ["four segments", async () => `${await privyToken(USER, NOW)}.x`, "malformed"],
    ["non-base64url characters", async () => (await privyToken(USER, NOW)).replace(".", ".+"), "malformed"],
    ["a huge token", async () => "a".repeat(5000), "malformed"],
    ["alg none", () => privyToken(USER, NOW, { header: { alg: "none" } }), "unsupported_alg"],
    ["alg HS256", () => privyToken(USER, NOW, { header: { alg: "HS256" } }), "unsupported_alg"],
    ["no kid", () => privyToken(USER, NOW, { header: { kid: undefined } }), "unknown_key"],
    ["an unknown kid", () => privyToken(USER, NOW, { header: { kid: "rotated-away" } }), "unknown_key"],
    ["a signature by another key", () => privyToken(USER, NOW, { key: otherKey }), "bad_signature"],
    ["another issuer", () => privyToken(USER, NOW, { claims: { iss: "evil.io" } }), "wrong_issuer"],
    ["another Privy app", () => privyToken(USER, NOW, { claims: { aud: "cmotherapp000000000000000" } }), "wrong_audience"],
    ["no expiry", () => privyToken(USER, NOW, { claims: { exp: undefined } }), "expired"],
    ["an expired token", () => privyToken(USER, NOW - 3_600_000), "expired"],
    ["a token issued in the future", () => privyToken(USER, NOW + 3_600_000), "not_yet_valid"],
    ["a token not valid before later", () => privyToken(USER, NOW, { claims: { nbf: NOW / 1000 + 600 } }), "not_yet_valid"],
    ["a non-Privy subject", () => privyToken("alice", NOW), "invalid_subject"],
    ["no subject", () => privyToken(USER, NOW, { claims: { sub: undefined } }), "invalid_subject"],
  ];

  it.each(refusals)("refuses %s", async (_name, token, reason) => {
    expect(await verifier()(await token(), NOW)).toEqual({ ok: false, reason });
  });

  it("refuses a valid token whose payload was swapped", async () => {
    const [head, , sig] = (await privyToken(USER, NOW)).split(".");
    const [, body] = (await privyToken("did:privy:mallory0000000000000000", NOW)).split(".");
    expect(await verifier()(`${head}.${body}.${sig}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("caches the keys, refetching after the TTL", async () => {
    const { loads, load } = counting(() => jwksOf(PRIVY_KEY));
    const verify = privyVerifier(APP_ID, load);
    for (let i = 0; i < 5; i++) await verify(await privyToken(USER, NOW), NOW + i);
    expect(loads.count).toBe(1);
    const later = NOW + JWKS_TTL_MS;
    await verify(await privyToken(USER, later), later);
    expect(loads.count).toBe(2);
  });

  it("refetches for an unknown kid at most once per interval (key rotation without a fetch storm)", async () => {
    const { loads, load } = counting(() => jwksOf(PRIVY_KEY));
    const verify = privyVerifier(APP_ID, load);
    await verify(await privyToken(USER, NOW), NOW);
    const unknown = await privyToken(USER, NOW, { header: { kid: "new" } });
    for (let i = 1; i <= 3; i++) expect(await verify(unknown, NOW + i)).toEqual({ ok: false, reason: "unknown_key" });
    expect(loads.count).toBe(1);
    await verify(unknown, NOW + JWKS_REFETCH_MS);
    expect(loads.count).toBe(2);
  });

  it("throws when the keys cannot be fetched and none are cached (the caller fails closed)", async () => {
    const verify = privyVerifier(APP_ID, () => Promise.reject(new Error("down")));
    await expect(verify(await privyToken(USER, NOW), NOW)).rejects.toThrow("down");
  });

  it("keeps using a known key when a refresh fails", async () => {
    let up = true;
    const verify = privyVerifier(APP_ID, () => (up ? jwksOf(PRIVY_KEY) : Promise.reject(new Error("down"))));
    await verify(await privyToken(USER, NOW), NOW);
    up = false;
    const later = NOW + JWKS_TTL_MS;
    expect(await verify(await privyToken(USER, later), later)).toEqual({ ok: true, userId: USER });
  });

  it("refuses a key set without a usable ES256 key", async () => {
    const verify = privyVerifier(APP_ID, async () => ({ keys: [{ kty: "RSA", kid: "k", n: "x", e: "AQAB" }] }));
    await expect(verify(await privyToken(USER, NOW), NOW)).rejects.toThrow(/no usable ES256 key/);
  });
});
