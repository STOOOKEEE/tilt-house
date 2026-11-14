import { formatUsdc } from './format'

/** The one-line model shown under every "Your money" heading. */
export const MONEY_EXPLAINER =
  'In the house is what your tables and bets spend; in your wallet is where your chips arrive. Deposit moves chips into the house.'

interface SeedHintInput {
  /** House balance, null while loading. */
  house: bigint | null
  /** Wallet balance, null while loading. */
  wallet: bigint | null
  minSeed: bigint
  loggedIn: boolean
  symbol: string
}

/** What the player does next when the house balance cannot seed a table, or null once it can. */
export function missingSeedHint({ house, wallet, minSeed, loggedIn, symbol }: SeedHintInput): string | null {
  if (!loggedIn) return 'Log in first: your first visit brings your starting chips to your wallet.'
  if (house !== null && house >= minSeed) return null
  const missing = minSeed - (house ?? 0n)
  const amount = `${formatUsdc(missing)} ${symbol}`
  if (wallet !== null && wallet >= missing) return `Deposit ${amount} below: it moves chips from your wallet into the house.`
  return `Get chips with the button below, then deposit ${amount}.`
}
