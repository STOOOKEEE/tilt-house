import { describe, expect, it } from 'vitest'
import { countUpValue } from './Jackpot'

describe('countUpValue', () => {
  it('stays between the start and the target, even for a frame stamped before the start', () => {
    expect(countUpValue(0n, 24_209_583n, -500)).toBe(0n)
    expect(countUpValue(30_000_000n, 24_209_583n, -500)).toBe(30_000_000n)
    expect(countUpValue(0n, 24_209_583n, 750) > 0n).toBe(true)
    expect(countUpValue(0n, 24_209_583n, 5_000)).toBe(24_209_583n)
    expect(countUpValue(30_000_000n, 24_209_583n, 5_000)).toBe(24_209_583n)
  })
})
