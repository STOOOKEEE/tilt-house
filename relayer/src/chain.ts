import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  baseEncode,
  teraToGas,
  type KeyPairString,
  type SignedDelegate,
  type Transaction,
} from "near-api-js";
import { AccountDoesNotExistError, AccessKeyDoesNotExistError } from "near-api-js/rpc-errors";
import type { Config } from "./config.ts";
import type { DecodedSignedDelegate } from "./policy.ts";

export interface AccessKeyInfo {
  nonce: bigint;
  fullAccess: boolean;
}

export interface RelayOutcome {
  txHash: string;
  /** "pending": included in a block, receipts still running (game moves only). */
  status: "success" | "failure" | "pending";
  failure?: string;
}

/** "executed" waits for every receipt; "included" answers once the transaction is in a block. */
export type RelayWait = "executed" | "included";

export interface Activation {
  funded: boolean;
  registered: boolean;
  /** tUSDC base units minted to the account, decimal string. */
  minted: string;
}

export interface ActivationPlan {
  /** NEAR (yocto) the account gets. */
  near: bigint;
  /** true: sent if the account holds less; false: only if the account does not exist yet. */
  topUp: boolean;
  /** Token base units minted after registration (0: none). */
  tokens: bigint;
}

/** Everything the HTTP layer needs from NEAR; faked in tests. */
export interface Chain {
  blockHeight(): Promise<bigint>;
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null>;
  relay(signed: DecodedSignedDelegate, wait: RelayWait): Promise<RelayOutcome>;
  /** Sends NEAR as `plan` says, registers the account on the token, mints `plan.tokens`. */
  activate(accountId: string, plan: ActivationPlan): Promise<Activation>;
  /** Mints `tokens` tUSDC to the account (relayer is the token's minter). */
  mint(accountId: string, tokens: bigint): Promise<void>;
  /** The TILT welcome allowance (`claim_welcome_for`, relayer = welcome operator); the amount received. */
  claimWelcome(accountId: string): Promise<bigint>;
  /** The relayer account's own NEAR balance, yocto (the daily budget watches it). */
  relayerBalance(): Promise<bigint>;
}

const STORAGE_DEPOSIT_GAS = teraToGas(30);
const MINT_GAS = teraToGas(30);
const WELCOME_GAS = teraToGas(30);
const DECIMAL = /^\d+$/;

/** Whether activation sends NEAR to an account holding `balance` (0: the account does not exist). */
export function fundingNeeded(balance: bigint, { near, topUp }: ActivationPlan): boolean {
  // An existing account always holds some NEAR (its storage stake).
  return topUp ? balance < near : balance === 0n;
}

function isKeyPairString(value: string): value is KeyPairString {
  return value.startsWith("ed25519:") || value.startsWith("secp256k1:");
}

function failureOf(status: unknown): string | undefined {
  if (typeof status !== "object" || status === null || !("Failure" in status)) return undefined;
  return JSON.stringify(status.Failure);
}

/**
 * Remembers the hash of the transaction it signed: an INCLUDED answer carries no outcome, so the
 * hash must come from signing. One per relay, so concurrent relays never mix hashes; on a nonce
 * retry near-api-js signs again and the last hash is the one sent.
 */
class HashRecordingSigner extends KeyPairSigner {
  txHash = "";

  override async signTransaction(transaction: Transaction): ReturnType<KeyPairSigner["signTransaction"]> {
    const signed = await super.signTransaction(transaction);
    this.txHash = baseEncode(signed.txHash);
    return signed;
  }
}

export function nearChain(config: Config): Chain {
  if (!isKeyPairString(config.relayerPrivateKey)) throw new Error("RELAYER_PRIVATE_KEY must be ed25519:… or secp256k1:…");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const keyPair = KeyPair.fromString(config.relayerPrivateKey);
  const signer = new KeyPairSigner(keyPair);
  const relayer = new Account(config.relayerAccount, provider, signer);

  async function balanceOf(accountId: string): Promise<bigint> {
    try {
      return (await provider.viewAccount({ accountId })).amount;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return 0n;
      throw error;
    }
  }

  async function isRegistered(accountId: string): Promise<boolean> {
    const balance = await provider.callFunction({
      contractId: config.token,
      method: "storage_balance_of",
      args: { account_id: accountId },
    });
    return balance !== null && balance !== undefined;
  }

  async function storageMin(): Promise<bigint> {
    const bounds = await provider.callFunction({ contractId: config.token, method: "storage_balance_bounds", args: {} });
    const min = typeof bounds === "object" && bounds !== null && "min" in bounds ? bounds.min : undefined;
    if (typeof min !== "string" || !/^\d+$/.test(min)) throw new Error("token returned invalid storage_balance_bounds");
    return BigInt(min);
  }

  async function registerOnToken(accountId: string): Promise<boolean> {
    if (await isRegistered(accountId)) return false;
    await relayer.callFunction({
      contractId: config.token,
      methodName: "storage_deposit",
      args: { account_id: accountId, registration_only: true },
      deposit: await storageMin(),
      gas: STORAGE_DEPOSIT_GAS,
    });
    return true;
  }

  async function mint(accountId: string, tokens: bigint): Promise<void> {
    // mint_to is payable: it registers an unknown receiver with the attached storage deposit.
    const deposit = (await isRegistered(accountId)) ? 0n : await storageMin();
    await relayer.callFunction({
      contractId: config.token,
      methodName: "mint_to",
      args: { account_id: accountId, amount: tokens.toString() },
      deposit,
      gas: MINT_GAS,
    });
  }

  return {
    async blockHeight() {
      const block = await provider.viewBlock({ finality: "final" });
      return BigInt(block.header.height);
    },

    async accessKey(accountId, publicKey) {
      try {
        const key = await provider.viewAccessKey({ accountId, publicKey });
        return { nonce: BigInt(key.nonce), fullAccess: key.permission === "FullAccess" };
      } catch (error) {
        if (error instanceof AccessKeyDoesNotExistError || error instanceof AccountDoesNotExistError) return null;
        throw error;
      }
    },

    async relay(signed, wait) {
      const recorder = new HashRecordingSigner(keyPair);
      const outcome = await relayer.signAndSendTransaction({
        receiverId: signed.delegateAction.senderId,
        // The borsh schema decoded this value, so it re-encodes to the same bytes;
        // near-api-js only needs the fields, not the class instances.
        actions: [actions.signedDelegate(signed as unknown as SignedDelegate)],
        waitUntil: wait === "included" ? "INCLUDED" : "EXECUTED_OPTIMISTIC",
        throwOnFailure: false,
        signer: recorder,
      });
      if (wait === "included") return { txHash: recorder.txHash, status: "pending" };
      const failure = [outcome.transaction_outcome, ...outcome.receipts_outcome]
        .map((o) => failureOf(o.outcome.status))
        .find((f) => f !== undefined);
      const txHash = outcome.transaction_outcome.id;
      return failure === undefined ? { txHash, status: "success" } : { txHash, status: "failure", failure };
    },

    async activate(accountId, { near, topUp, tokens }) {
      const funded = fundingNeeded(await balanceOf(accountId), { near, topUp, tokens });
      if (funded) await relayer.transfer({ receiverId: accountId, amount: near });
      const registered = await registerOnToken(accountId);
      if (tokens > 0n) await mint(accountId, tokens);
      return { funded, registered, minted: tokens.toString() };
    },

    mint,

    async claimWelcome(accountId) {
      // Payable like mint_to: registers an unknown receiver with the attached storage deposit.
      const deposit = (await isRegistered(accountId)) ? 0n : await storageMin();
      const amount = await relayer.callFunction({
        contractId: config.token,
        methodName: "claim_welcome_for",
        args: { account_id: accountId },
        deposit,
        gas: WELCOME_GAS,
      });
      if (typeof amount !== "string" || !DECIMAL.test(amount)) throw new Error("claim_welcome_for returned an invalid amount");
      return BigInt(amount);
    },

    relayerBalance: () => balanceOf(config.relayerAccount),
  };
}
