import { describe, expect, it } from 'vitest'
import { BUBBLE_MAX_CHARS, clipText, wrapWords } from './bubble'

const byChars = (s: string) => s.length

describe('clipText', () => {
  it('keeps short text and collapses whitespace', () => {
    expect(clipText('  steady:\n nothing  to react to ')).toBe('steady: nothing to react to')
  })

  it('cuts long text to the limit with an ellipsis', () => {
    const clipped = clipText('x'.repeat(100))
    expect(clipped).toHaveLength(BUBBLE_MAX_CHARS)
    expect(clipped.endsWith('…')).toBe(true)
  })
})

describe('wrapWords', () => {
  it('fills lines greedily without exceeding the width', () => {
    expect(wrapWords('cutting my edge for you', 10, byChars)).toEqual(['cutting my', 'edge for', 'you'])
  })

  it('puts a word longer than the width on its own line', () => {
    expect(wrapWords('a supercalifragilistic b', 5, byChars)).toEqual(['a', 'supercalifragilistic', 'b'])
  })

  it('returns no line for empty text', () => {
    expect(wrapWords('', 10, byChars)).toEqual([])
  })
})
