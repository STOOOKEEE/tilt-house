import { encodeSignedDelegate, type Account, type Action } from "near-api-js";

/** House methods a game key may call; same list as the web client and the relayer's allow-list. */
export const GAME_METHODS = [
  "bet_dice",
  "bet_roulette",
  "bj_deal",
  "bj_hit",
  "bj_double",
  "bj_stand",
  "refund_stuck_round",
] as const;

/** 0.25 NEAR in yoctoNEAR: the most the relayer accepts as a game-key allowance. */
export const GAME_KEY_ALLOWANCE = 250_000_000_000_000_000_000_000n;

// The relayer refuses delegates valid for more than 600 blocks; ~2 minutes is plenty.
const DELEGATE_TTL_BLOCKS = 120;

/**
 * Signs `actions` for `receiverId` as a NEP-366 SignedDelegate with the account's signer and posts it
 * to `{relayer}/relay`. Returns the relayer's transaction hash; refusals and on-chain failures throw.
 */
export async function relayActions(
  relayer: string,
  account: Account,
  receiverId: string,
  delegateActions: Action[],
): Promise<string> {
  const { signedDelegate } = await account.createSignedMetaTransaction({
    receiverId,
    actions: delegateActions,
    blockHeightTtl: DELEGATE_TTL_BLOCKS,
  });
  const response = await fetch(`${relayer}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) throw new Error(`relayer answered HTTP ${response.status}`);
  if ("error" in body) throw new Error(`relayer refused: ${String(body.error)}`);
  if (!("txHash" in body) || typeof body.txHash !== "string") throw new Error("relayer sent no txHash");
  if ("status" in body && body.status === "failure") {
    const failure = "failure" in body ? JSON.stringify(body.failure) : "unknown";
    throw new Error(`relayed tx ${body.txHash} failed: ${failure}`);
  }
  return body.txHash;
}

