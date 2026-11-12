import {
  KeyPair,
  KeyPairSigner,
  actions,
  buildDelegateAction,
  encodeSignedDelegate,
  teraToGas,
  type Action,
  type SignedDelegate,
} from "near-api-js";
import { webcrypto } from "node:crypto";
import { createApp, type AppDeps } from "../src/app.ts";
import type { AccessKeyInfo, Activation, Chain, RelayOutcome, RelayWait } from "../src/chain.ts";
import type { DecodedSignedDelegate } from "../src/policy.ts";
import { GAME_METHODS } from "../src/policy.ts";
import { privyVerifier } from "../src/privy.ts";
import { StateStore } from "../src/state.ts";

export const HOUSE = "house.tilthouse.testnet";
export const TOKEN = "usdc.fakes.testnet";
export const PLAYER = "alice.testnet";
export const HEIGHT = 1_000n;
export const NEAR = 1_000_000_000_000_000_000_000_000n;
export const CONFIG: AppDeps["config"] = {
  network: "testnet",
  house: HOUSE,
  token: TOKEN,
  activationYocto: NEAR / 50n,
  dailyBudgetYocto: 5n * NEAR,
  paused: false,
  anonymousActivation: false,
};
export const APP_ID = "cmtestapp0000000000000000";
export const KID = "test-key";

/** A Privy-like ES256 signing key and the JWKS that publishes it. */
export const PRIVY_KEY = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
export async function jwksOf(key: webcrypto.CryptoKeyPair, kid = KID): Promise<unknown> {
  const { x, y } = await webcrypto.subtle.exportKey("jwk", key.publicKey);
  return { keys: [{ kty: "EC", crv: "P-256", x, y, kid, use: "sig", alg: "ES256" }] };
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Signs a token like Privy's: valid for the test app and an hour from `nowMs` unless overridden. */
export async function privyToken(
  user = "did:privy:alice00000000000000000000",
  nowMs = 0,
  { claims = {}, header = {}, key = PRIVY_KEY }: { claims?: Record<string, unknown>; header?: Record<string, unknown>; key?: webcrypto.CryptoKeyPair } = {},
): Promise<string> {
  const nowS = Math.floor(nowMs / 1000);
  const head = b64url({ alg: "ES256", typ: "JWT", kid: KID, ...header });
  const body = b64url({ iss: "privy.io", aud: APP_ID, sub: user, sid: "s1", iat: nowS, exp: nowS + 3600, ...claims });
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

/** The app with the real verifier over the test key, an in-memory (or given) store, a fake chain. */
export function testApp(over: Partial<AppDeps> & { chain: Chain; now: () => number }) {
  const store = over.store ?? new StateStore(null);
  return createApp({
    config: CONFIG,
    verifyToken: privyVerifier(APP_ID, () => jwksOf(PRIVY_KEY)),
    store,
    ...over,
  });
}

export const gameCall = (method: string, gas = teraToGas(100), deposit = 0n): Action =>
  actions.functionCall(method, { dealer_id: "lucky" }, gas, deposit);

export interface DelegateOptions {
  receiverId?: string;
  senderId?: string;
  maxBlockHeight?: bigint;
  nonce?: bigint;
  key?: KeyPair;
}

/** A delegate signed locally with a throwaway key, as the browser would send it. */
export async function signDelegate(
  acts: Action[],
  opts: DelegateOptions = {},
): Promise<{ signed: SignedDelegate; hash: Uint8Array; key: KeyPair }> {
  const key = opts.key ?? KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: opts.senderId ?? PLAYER,
    receiverId: opts.receiverId ?? HOUSE,
    actions: acts,
    nonce: opts.nonce ?? 10n,
    maxBlockHeight: opts.maxBlockHeight ?? HEIGHT + 120n,
    publicKey: key.getPublicKey(),
  });
  const { signedDelegate, delegateHash } = await new KeyPairSigner(key).signDelegateAction(delegateAction);
  return { signed: signedDelegate, hash: delegateHash, key };
}

export const toBase64 = (signed: SignedDelegate): string => Buffer.from(encodeSignedDelegate(signed)).toString("base64");

export const keySetup = (allowance: bigint | undefined = 250_000_000_000_000_000_000_000n, methods: string[] = [...GAME_METHODS], receiver = HOUSE): Action =>
  actions.addFunctionCallAccessKey(KeyPair.fromRandom("ed25519").getPublicKey(), receiver, methods, allowance);

/** In-memory chain: fixed height, one access key answer, records relayed delegates. */
export class FakeChain implements Chain {
  height = HEIGHT;
  key: AccessKeyInfo | null = { nonce: 1n, fullAccess: true };
  relayed: DecodedSignedDelegate[] = [];
  waits: RelayWait[] = [];
  activations: string[] = [];
  relayError: Error | null = null;
  activateError: Error | null = null;
  mints: { accountId: string; tokens: bigint }[] = [];
  mintError: Error | null = null;
  /** The relayer's balance; tests lower it to simulate spending. */
  balance = 100n * NEAR;
  balanceError: Error | null = null;

  async blockHeight(): Promise<bigint> {
    return this.height;
  }

  async accessKey(): Promise<AccessKeyInfo | null> {
    return this.key;
  }

  /** Like the RPC: "included" answers before any receipt ran, so no success or failure yet. */
  async relay(signed: DecodedSignedDelegate, wait: RelayWait): Promise<RelayOutcome> {
    if (this.relayError) throw this.relayError;
    this.relayed.push(signed);
    this.waits.push(wait);
    return { txHash: `tx${this.relayed.length}`, status: wait === "included" ? "pending" : "success" };
  }

  async activate(accountId: string, _near: bigint, tokens: bigint): Promise<Activation> {
    if (this.activateError) throw this.activateError;
    this.activations.push(accountId);
    return { funded: true, registered: true, minted: tokens.toString() };
  }

  async mint(accountId: string, tokens: bigint): Promise<void> {
    if (this.mintError) throw this.mintError;
    this.mints.push({ accountId, tokens });
  }

  async relayerBalance(): Promise<bigint> {
    if (this.balanceError) throw this.balanceError;
    return this.balance;
  }
}
