import { actions, encodeSignedDelegate, type Action, type PublicKey, type SignedDelegate } from 'near-api-js'

/** House methods the browser game key may call. Must match the relayer's allow-list. */
export const GAME_METHODS = [
  'bet_dice',
  'bet_roulette',
  'bj_deal',
  'bj_hit',
  'bj_double',
  'bj_stand',
  'refund_stuck_round',
] as const
export type GameMethod = (typeof GAME_METHODS)[number]

/** 0.25 NEAR in yoctoNEAR: caps what a stolen browser key can burn in gas. */
export const GAME_KEY_ALLOWANCE = 250_000_000_000_000_000_000_000n

/** Bets may request VRF through OutLayer (yield/resume), so leave headroom. */
export const MOVE_GAS = 100_000_000_000_000n

/** AddKey for the browser game key: function calls to the house only, no deposits possible. */
export function gameKeyAction(gameKey: PublicKey, houseContract: string): Action {
  return actions.addFunctionCallAccessKey(gameKey, houseContract, [...GAME_METHODS], GAME_KEY_ALLOWANCE)
}

/** One game move: a zero-deposit function call (function-call keys cannot attach deposits). */
export function moveAction(method: GameMethod, args: object): Action {
  return actions.functionCall(method, args, MOVE_GAS, 0n)
}

/** Generic call signed by the full-access (Privy) key; deposit in yoctoNEAR. */
export function callAction(method: string, args: object, deposit: bigint, gas: bigint = MOVE_GAS): Action {
  if (deposit < 0n) throw new Error('deposit must be non-negative')
  return actions.functionCall(method, args, gas, deposit)
}

/** Wire format of POST /relay: borsh-encoded SignedDelegate, base64. */
export function signedDelegateToBase64(signedDelegate: SignedDelegate): string {
  return bytesToBase64(encodeSignedDelegate(signedDelegate))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
