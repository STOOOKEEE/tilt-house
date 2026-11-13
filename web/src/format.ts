/**
 * USDC (and tUSDC) have 6 decimals, and so does $TILT (the floor's rules are written in 6-decimal
 * units); amounts travel as integer base units in decimal strings.
 */
export const USDC_DECIMALS = 6
const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS)

/** Share prices are millionths of the launch price (1 000 000 = launch). */
export const PRICE_SCALE = 1_000_000n

const BASE_UNITS = /^\d+$/

/** The active currency's symbol. Set once at startup: switching currency reloads the page. */
let activeSymbol = 'tUSDC'

export function setTokenSymbol(symbol: string): void {
  activeSymbol = symbol
}

export function tokenSymbol(): string {
  return activeSymbol
}

/** Base units → "12.34 TILT" in the active currency (or the one given). */
export function formatAmount(value: string | bigint, symbol = activeSymbol): string {
  return `${formatUsdc(value)} ${symbol}`
}

/** Parses a base-unit decimal string; throws on anything else (negative, float, empty). */
export function toBaseUnits(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value
  if (!BASE_UNITS.test(value)) throw new Error(`not an amount in base units: ${value}`)
  return BigInt(value)
}

/**
 * Base units → "12.34" (trailing zeros trimmed, at least 2 decimals). Signed amounts keep their
 * sign so P&L can be shown with the same helper.
 */
export function formatUsdc(value: string | bigint, minDecimals = 2): string {
  const amount = typeof value === 'bigint' ? value : toBaseUnits(value)
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const whole = abs / USDC_UNIT
  let fraction = (abs % USDC_UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  if (fraction.length < minDecimals) fraction = fraction.padEnd(minDecimals, '0')
  const text = fraction ? `${groupThousands(whole)}.${fraction}` : groupThousands(whole)
  return negative ? `-${text}` : text
}

function groupThousands(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const USDC_INPUT = /^\d+(\.\d{0,6})?$/

/** User input "12.5" → base units. Returns null for anything that is not a plain positive amount. */
export function parseUsdc(input: string): bigint | null {
  const text = input.trim()
  if (!USDC_INPUT.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  return BigInt(whole) * USDC_UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, '0'))
}

/** Basis points → "2.45%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`
}

/** Share price in millionths of launch → "1.0234×". */
export function formatPrice(price: string | bigint): string {
  const scaled = toBaseUnits(price)
  const whole = scaled / PRICE_SCALE
  const fraction = ((scaled % PRICE_SCALE) / 100n).toString().padStart(4, '0')
  return `${whole}.${fraction}×`
}

/** Change of a share price vs launch → "+2.34%" / "-0.50%". Integer math, rounded toward zero. */
export function formatPriceChange(price: string | bigint): string {
  const deltaBp = ((toBaseUnits(price) - PRICE_SCALE) * 10_000n) / PRICE_SCALE
  const sign = deltaBp < 0n ? '-' : '+'
  const abs = deltaBp < 0n ? -deltaBp : deltaBp
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}%`
}

/** Remaining seconds → "4:05" (or "1:02:03"); 0 or less → "". */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return ''
  const s = Math.floor(seconds)
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const secs = String(s % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`
}

/** Simulated time in seconds → "day 3 · 14:20". */
export function formatSimTime(t: number): string {
  const day = Math.floor(t / 86_400) + 1
  const hours = String(Math.floor((t % 86_400) / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((t % 3600) / 60)).padStart(2, '0')
  return `day ${day} · ${hours}:${minutes}`
}

/** Shortens a long (implicit, 64-hex) account id for display: "a42bd9…93ae8b". */
export function shortAccount(accountId: string): string {
  return accountId.length > 20 ? `${accountId.slice(0, 6)}…${accountId.slice(-6)}` : accountId
}

/** Shortens a long hex string for display: "a42bd982…93ae8b". */
export function shortHex(hex: string, keep = 8): string {
  return hex.length > keep * 2 + 1 ? `${hex.slice(0, keep)}…${hex.slice(-keep)}` : hex
}
