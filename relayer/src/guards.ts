/** The relayer's one object guard for untrusted JSON (request bodies, JWTs, the state file, JWKS). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
