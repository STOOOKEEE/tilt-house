import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatBp,
  formatCountdown,
  formatPrice,
  formatPriceChange,
  formatSimTime,
  formatUsdc,
  parseUsdc,
  setTokenSymbol,
  shortAccount,
  shortHex,
  tokenSymbol,
  toBaseUnits,
} from './format'

describe('formatUsdc', () => {
  it('shows 6-decimal base units as USDC with at least 2 decimals', () => {
    expect(formatUsdc('0')).toBe('0.00')
    expect(formatUsdc('100000')).toBe('0.10')
    expect(formatUsdc('1234567')).toBe('1.234567')
    expect(formatUsdc('2000000000')).toBe('2,000.00')
    expect(formatUsdc(1_500_000n, 0)).toBe('1.5')
    expect(formatUsdc(1_000_000n, 0)).toBe('1')
  })

  it('keeps big amounts exact and signs negatives', () => {
    expect(formatUsdc('340282366920938463463374607431768211455')).toBe(
      '340,282,366,920,938,463,463,374,607,431,768.211455',
    )
    expect(formatUsdc(-2_500_000n)).toBe('-2.50')
  })

  it('refuses strings that are not base units', () => {
    expect(() => formatUsdc('1.5')).toThrow()
    expect(() => formatUsdc('-1')).toThrow()
    expect(() => toBaseUnits('')).toThrow()
  })
})

describe('parseUsdc', () => {
  it('turns user input into base units', () => {
    expect(parseUsdc('1')).toBe(1_000_000n)
    expect(parseUsdc(' 0.1 ')).toBe(100_000n)
    expect(parseUsdc('12.345678')).toBe(12_345_678n)
    expect(parseUsdc('3.')).toBe(3_000_000n)
  })

  it('rejects anything else', () => {
    for (const bad of ['', '-1', '1.2345678', 'abc', '1e3', '.5', '1,5']) expect(parseUsdc(bad)).toBeNull()
  })
})

describe('formatBp', () => {
  it('shows basis points as a percentage', () => {
    expect(formatBp(245)).toBe('2.45%')
    expect(formatBp(100)).toBe('1.00%')
    expect(formatBp(0)).toBe('0.00%')
  })
})

describe('share prices', () => {
  it('shows millionths of launch as a multiple', () => {
    expect(formatPrice('1000000')).toBe('1.0000×')
    expect(formatPrice('1023456')).toBe('1.0234×')
    expect(formatPrice('1')).toBe('0.0000×')
  })

  it('shows the change vs launch', () => {
    expect(formatPriceChange('1023456')).toBe('+2.34%')
    expect(formatPriceChange('995000')).toBe('-0.50%')
    expect(formatPriceChange('1000000')).toBe('+0.00%')
  })
})

describe('formatCountdown', () => {
  it('shows minutes and seconds, hours when needed, nothing once over', () => {
    expect(formatCountdown(245)).toBe('4:05')
    expect(formatCountdown(3723)).toBe('1:02:03')
    expect(formatCountdown(0)).toBe('')
    expect(formatCountdown(-5)).toBe('')
  })
})

describe('formatSimTime', () => {
  it('shows the simulated day and clock', () => {
    expect(formatSimTime(600)).toBe('day 1 · 00:10')
    expect(formatSimTime(2 * 86_400 + 14 * 3600 + 20 * 60)).toBe('day 3 · 14:20')
  })
})

describe('shortHex', () => {
  it('keeps both ends of long hex', () => {
    expect(shortHex('a'.repeat(8) + 'b'.repeat(48) + 'c'.repeat(8))).toBe('aaaaaaaa…cccccccc')
    expect(shortHex('abcd')).toBe('abcd')
  })
})

describe('amounts per currency', () => {
  it('follows the active currency and takes an explicit symbol', () => {
    expect(tokenSymbol()).toBe('tUSDC')
    expect(formatAmount('12340000')).toBe('12.34 tUSDC')
    setTokenSymbol('TILT')
    try {
      expect(formatAmount('1000000000000')).toBe('1,000,000.00 TILT')
      expect(formatAmount(-2_500_000n)).toBe('-2.50 TILT')
      expect(formatAmount('1', 'tUSDC')).toBe('0.000001 tUSDC')
    } finally {
      setTokenSymbol('tUSDC')
    }
  })

  it('shortens implicit account ids only', () => {
    expect(shortAccount('alice.testnet')).toBe('alice.testnet')
    expect(shortAccount('a'.repeat(64))).toBe('aaaaaa…aaaaaa')
  })
})
