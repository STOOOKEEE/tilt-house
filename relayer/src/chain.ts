import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  teraToGas,
  type KeyPairString,
  type SignedDelegate,
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
  status: "success" | "failure";
  failure?: string;
}

export interface Activation {
  funded: boolean;
  registered: boolean;
}

/** Everything the HTTP layer needs from NEAR; faked in tests. */
export interface Chain {
  blockHeight(): Promise<bigint>;
  accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null>;
  relay(signed: DecodedSignedDelegate): Promise<RelayOutcome>;
  activate(accountId: string, amount: bigint): Promise<Activation>;
}

const STORAGE_DEPOSIT_GAS = teraToGas(30);

function isKeyPairString(value: string): value is KeyPairString {
  return value.startsWith("ed25519:") || value.startsWith("secp256k1:");
}

function failureOf(status: unknown): string | undefined {
  if (typeof status !== "object" || status === null || !("Failure" in status)) return undefined;
  return JSON.stringify(status.Failure);
}

export function nearChain(config: Config): Chain {
  if (!isKeyPairString(config.relayerPrivateKey)) throw new Error("RELAYER_PRIVATE_KEY must be ed25519:… or secp256k1:…");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const signer = new KeyPairSigner(KeyPair.fromString(config.relayerPrivateKey));
  const relayer = new Account(config.relayerAccount, provider, signer);

  async function balanceOf(accountId: string): Promise<bigint> {
    try {
      return (await provider.viewAccount({ accountId })).amount;
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return 0n;
      throw error;
    }
  }

  async function registerOnToken(accountId: string): Promise<boolean> {
    const existing = await provider.callFunction({
      contractId: config.token,
      method: "storage_balance_of",
      args: { account_id: accountId },
    });
    if (existing !== null && existing !== undefined) return false;
    const bounds = await provider.callFunction({ contractId: config.token, method: "storage_balance_bounds", args: {} });
    const min = typeof bounds === "object" && bounds !== null && "min" in bounds ? bounds.min : undefined;
    if (typeof min !== "string" || !/^\d+$/.test(min)) throw new Error("token returned invalid storage_balance_bounds");
    await relayer.callFunction({
      contractId: config.token,
      methodName: "storage_deposit",
      args: { account_id: accountId, registration_only: true },
      deposit: BigInt(min),
      gas: STORAGE_DEPOSIT_GAS,
    });
    return true;
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

    async relay(signed) {
      const outcome = await relayer.signAndSendTransaction({
        receiverId: signed.delegateAction.senderId,
        // The borsh schema decoded this value, so it re-encodes to the same bytes;
        // near-api-js only needs the fields, not the class instances.
        actions: [actions.signedDelegate(signed as unknown as SignedDelegate)],
        throwOnFailure: false,
      });
      const failure = [outcome.transaction_outcome, ...outcome.receipts_outcome]
        .map((o) => failureOf(o.outcome.status))
        .find((f) => f !== undefined);
      const txHash = outcome.transaction_outcome.id;
      return failure === undefined ? { txHash, status: "success" } : { txHash, status: "failure", failure };
    },

    async activate(accountId, amount) {
      const funded = (await balanceOf(accountId)) < amount;
      if (funded) await relayer.transfer({ receiverId: accountId, amount });
      const registered = await registerOnToken(accountId);
      return { funded, registered };
    },
  };
}
