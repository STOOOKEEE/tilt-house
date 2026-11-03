import { createHash } from "node:crypto";
import { deserialize, serialize } from "borsh";
import { KeyType, PublicKey, SCHEMA } from "near-api-js";

/**
 * What the relayer agrees to pay gas for. Everything here is pure: the caller
 * supplies the chain facts (block height, access key) separately.
 */

export const GAME_METHODS = [
  "bet_dice",
  "bet_roulette",
  "bj_deal",
  "bj_hit",
  "bj_double",
  "bj_stand",
  "refund_stuck_round",
] as const;

// Money moves on the house contract. The contract requires 1 yocto on some of
// them, which only a full-access key can attach; the relayer also checks the
// signing key is full access before paying for any of them.
export const MONEY_METHODS = ["withdraw", "invest", "divest", "mt_transfer"] as const;

export const DEPOSIT_METHOD = "ft_transfer_call";

export const ONE_YOCTO = 1n;
export const MAX_GAS = 300_000_000_000_000n; // 300 Tgas, the protocol cap per transaction
export const MAX_KEY_ALLOWANCE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR
export const MAX_ACTIONS = 4;
// A delegate may live at most this many blocks (~10 min); longer-lived signed
// payloads are easier to hoard and replay at a bad time.
export const MAX_TTL_BLOCKS = 600n;
// Big enough for any allowed shape (the key setup is ~400 bytes).
export const MAX_ENCODED_BYTES = 8 * 1024;

// NEP-461: signed delegate payloads are prefixed with 2^30 + 366 (u32 LE) so they can
// never collide with a signed transaction.
const DELEGATE_PREFIX = (1 << 30) + 366;

export type RefusalReason =
  | "no_actions"
  | "too_many_actions"
  | "wrong_receiver"
  | "action_not_allowed"
  | "method_not_allowed"
  | "deposit_not_allowed"
  | "gas_too_high"
  | "invalid_args"
  | "wrong_ft_receiver"
  | "full_access_key_not_allowed"
  | "wrong_key_receiver"
  | "wrong_key_methods"
  | "allowance_too_high"
  | "unsupported_key_type"
  | "bad_signature"
  | "expired"
  | "ttl_too_long"
  | "unknown_key"
  | "key_not_full_access"
  | "stale_nonce";

export type Verdict = { ok: true; needsFullAccess: boolean } | { ok: false; reason: RefusalReason };

type Bytes = ArrayLike<number>;

export interface FunctionCallAction {
  methodName: string;
  args: Bytes;
  gas: bigint;
  deposit: bigint;
}

export interface KeyPermission {
  functionCall?: { allowance: bigint | null; receiverId: string; methodNames: string[] };
  [other: string]: unknown;
}

export interface DecodedKey {
  ed25519Key?: { data: Bytes };
  [other: string]: unknown;
}

// Borsh enums decode to an object with exactly one key naming the variant.
export interface DecodedAction {
  functionCall?: FunctionCallAction;
  addKey?: { publicKey: DecodedKey; accessKey: { nonce: bigint; permission: KeyPermission } };
  [other: string]: unknown;
}

export interface DecodedDelegate {
  senderId: string;
  receiverId: string;
  actions: DecodedAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  publicKey: DecodedKey;
}

export interface DecodedSignedDelegate {
  delegateAction: DecodedDelegate;
  signature: { ed25519Signature?: { data: Bytes }; [other: string]: unknown };
}

export interface PolicyConfig {
  house: string;
  token: string;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Base64 borsh `SignedDelegate` → decoded value, or null if it is not one. */
export function decodeSignedDelegate(encoded: string): DecodedSignedDelegate | null {
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_ENCODED_BYTES) return null;
  try {
    // The borsh schema fixes the shape, so the decoded value matches the interface.
    const decoded = deserialize(SCHEMA.SignedDelegate, bytes) as DecodedSignedDelegate;
    // borsh ignores trailing bytes; only accept the canonical encoding of what we relay.
    return Buffer.from(serialize(SCHEMA.SignedDelegate, decoded)).equals(bytes) ? decoded : null;
  } catch {
    return null;
  }
}

const refuse = (reason: RefusalReason): Verdict => ({ ok: false, reason });

/** Decide from the delegate alone whether its actions are sponsored. */
export function checkDelegate(delegate: DecodedDelegate, cfg: PolicyConfig): Verdict {
  const { actions } = delegate;
  if (actions.length === 0) return refuse("no_actions");
  if (actions.length > MAX_ACTIONS) return refuse("too_many_actions");
  if (delegate.receiverId === cfg.house) return checkHouseCalls(actions);
  if (delegate.receiverId === cfg.token) return checkTokenDeposit(actions, cfg.house);
  // AddKey applies to the receiver, so the key setup targets the sender's own account.
  if (delegate.receiverId === delegate.senderId) return checkKeySetup(actions, cfg.house);
  return refuse("wrong_receiver");
}

function isIn<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

function checkHouseCalls(actions: DecodedAction[]): Verdict {
  let gas = 0n;
  let needsFullAccess = false;
  for (const action of actions) {
    const call = action.functionCall;
    if (!call) return refuse("action_not_allowed");
    if (isIn(GAME_METHODS, call.methodName)) {
      if (call.deposit !== 0n) return refuse("deposit_not_allowed");
    } else if (isIn(MONEY_METHODS, call.methodName)) {
      if (call.deposit !== 0n && call.deposit !== ONE_YOCTO) return refuse("deposit_not_allowed");
      needsFullAccess = true;
    } else {
      return refuse("method_not_allowed");
    }
    gas += call.gas;
  }
  if (gas > MAX_GAS) return refuse("gas_too_high");
  return { ok: true, needsFullAccess };
}

function checkTokenDeposit(actions: DecodedAction[], house: string): Verdict {
  if (actions.length !== 1) return refuse("too_many_actions");
  const call = actions[0]?.functionCall;
  if (!call) return refuse("action_not_allowed");
  if (call.methodName !== DEPOSIT_METHOD) return refuse("method_not_allowed");
  if (call.deposit !== ONE_YOCTO) return refuse("deposit_not_allowed");
  if (call.gas > MAX_GAS) return refuse("gas_too_high");
  const receiver = jsonField(call.args, "receiver_id");
  if (receiver === undefined) return refuse("invalid_args");
  if (receiver !== house) return refuse("wrong_ft_receiver");
  return { ok: true, needsFullAccess: true };
}

function jsonField(args: Bytes, field: string): unknown {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(Uint8Array.from(args)).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return (parsed as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function checkKeySetup(actions: DecodedAction[], house: string): Verdict {
  if (actions.length !== 1) return refuse("too_many_actions");
  const addKey = actions[0]?.addKey;
  if (!addKey) return refuse("action_not_allowed");
  const permission = addKey.accessKey.permission.functionCall;
  if (!permission) return refuse("full_access_key_not_allowed");
  if (permission.receiverId !== house) return refuse("wrong_key_receiver");
  if (!sameMethods(permission.methodNames, GAME_METHODS)) return refuse("wrong_key_methods");
  if (permission.allowance !== null && permission.allowance > MAX_KEY_ALLOWANCE) {
    return refuse("allowance_too_high");
  }
  return { ok: true, needsFullAccess: true };
}

function sameMethods(given: string[], expected: readonly string[]): boolean {
  const unique = new Set(given);
  return unique.size === given.length && given.length === expected.length && expected.every((m) => unique.has(m));
}

/** The delegate must still be valid and not signed for the far future. */
export function checkExpiry(maxBlockHeight: bigint, currentHeight: bigint): Verdict {
  if (maxBlockHeight <= currentHeight) return refuse("expired");
  if (maxBlockHeight > currentHeight + MAX_TTL_BLOCKS) return refuse("ttl_too_long");
  return { ok: true, needsFullAccess: false };
}

/** Ed25519 only: Privy wallets and browser game keys are ed25519. */
export function signerPublicKey(delegate: DecodedDelegate): PublicKey | null {
  const key = delegate.publicKey.ed25519Key;
  if (!key) return null;
  return new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(key.data) });
}

/** Checks the sender's signature locally so forged payloads never cost gas. */
export function checkSignature(signed: DecodedSignedDelegate): Verdict {
  const publicKey = signerPublicKey(signed.delegateAction);
  const signature = signed.signature.ed25519Signature;
  if (!publicKey || !signature) return refuse("unsupported_key_type");
  const valid = publicKey.verify(delegateHash(signed.delegateAction), Uint8Array.from(signature.data));
  return valid ? { ok: true, needsFullAccess: false } : refuse("bad_signature");
}

/** sha256 of the NEP-461-prefixed borsh delegate: the bytes the sender signed. */
export function delegateHash(delegate: DecodedDelegate): Uint8Array {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(DELEGATE_PREFIX);
  const body = serialize(SCHEMA.DelegateAction, delegate);
  return createHash("sha256").update(prefix).update(body).digest();
}
