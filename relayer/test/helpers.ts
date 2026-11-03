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
import type { AccessKeyInfo, Activation, Chain, RelayOutcome } from "../src/chain.ts";
import type { DecodedSignedDelegate } from "../src/policy.ts";
import { GAME_METHODS } from "../src/policy.ts";

export const HOUSE = "house.tilthouse.testnet";
export const TOKEN = "usdc.fakes.testnet";
export const PLAYER = "alice.testnet";
export const HEIGHT = 1_000n;
export const CONFIG = { house: HOUSE, token: TOKEN, activationYocto: 20_000_000_000_000_000_000_000n };

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
  activations: string[] = [];
  relayError: Error | null = null;
  activateError: Error | null = null;

  async blockHeight(): Promise<bigint> {
    return this.height;
  }

  async accessKey(): Promise<AccessKeyInfo | null> {
    return this.key;
  }

  async relay(signed: DecodedSignedDelegate): Promise<RelayOutcome> {
    if (this.relayError) throw this.relayError;
    this.relayed.push(signed);
    return { txHash: `tx${this.relayed.length}`, status: "success" };
  }

  async activate(accountId: string): Promise<Activation> {
    if (this.activateError) throw this.activateError;
    this.activations.push(accountId);
    return { funded: true, registered: true };
  }
}
