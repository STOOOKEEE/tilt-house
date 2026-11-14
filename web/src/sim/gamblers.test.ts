import { describe, expect, it } from 'vitest'
import { diffGamblers, footfall, parseGamblerList, parseGamblerTimeline, toCues, type GamblerSnapshot, type GamblerState } from './gamblers'

function g(id: string, state: GamblerState, dealer_id: string | null = null, seat: number | null = null): GamblerSnapshot {
  return { id, name: null, persona: null, state, dealer_id, seat, reason_code: null, reason: `${id} reason`, balance: '0', session_net: '0' }
}

describe('diffGamblers', () => {
  it('walks a newcomer in, then to the table it sits at', () => {
    expect(diffGamblers([], [g('mia', 'seated', 'ada', 0)]).map((m) => m.kind)).toEqual(['enter', 'consider', 'sit'])
  })

  it('does not repeat a gambler that stays put', () => {
    const seated = [g('mia', 'seated', 'ada', 0)]
    expect(diffGamblers(seated, seated)).toEqual([])
  })

  it('sits a gambler that was deciding at the same table without a second look', () => {
    expect(diffGamblers([g('mia', 'deciding', 'ada')], [g('mia', 'seated', 'ada')]).map((m) => m.kind)).toEqual(['sit'])
  })

  it('makes a vanished or leaving gambler leave once', () => {
    expect(diffGamblers([g('mia', 'seated', 'ada')], [])).toMatchObject([{ kind: 'leave', id: 'mia' }])
    expect(diffGamblers([g('mia', 'seated', 'ada')], [g('mia', 'leaving')])).toMatchObject([{ kind: 'leave' }])
    expect(diffGamblers([g('mia', 'leaving')], [])).toEqual([])
  })
})

describe('toCues', () => {
  const info = new Map([['mia', { id: 'mia', name: 'Mia', persona: 'whale' as const }]])

  it('finds the table by id, else by seat, else drops the move', () => {
    const after = [g('mia', 'seated', 'ada', 4)]
    const moves = diffGamblers([], after)
    expect(toCues(moves, after, info, [null, 'ada'])).toMatchObject([
      { kind: 'enter', name: 'Mia', persona: 'whale' },
      { kind: 'consider', seat: 1 },
      { kind: 'sit', seat: 1 },
    ])
    expect(toCues(moves, after, info, [null, null, null, null, 'bob', null]).map((c) => c.seat)).toEqual([null, 4, 4])
    expect(toCues(moves, after, info, [null, null, null, null, null, null]).map((c) => c.kind)).toEqual(['enter'])
  })
})

describe('footfall', () => {
  it('counts distinct sitters and lookers who went elsewhere, inside the window', () => {
    const frames = [
      { t: 0, gamblers: [g('old', 'seated', 'ada')] },
      { t: 600, gamblers: [g('mia', 'deciding', 'ada'), g('leo', 'deciding', 'ada')] },
      { t: 1200, gamblers: [g('mia', 'seated', 'ada'), g('leo', 'seated', 'bob')] },
      { t: 1800, gamblers: [g('mia', 'seated', 'ada')] },
    ]
    expect(footfall(frames, 'ada', 600, 1800)).toEqual({ passed: 1, sat: 1 })
  })
})

describe('parseGamblerTimeline', () => {
  it('is null for a sim.json without gamblers', () => {
    expect(parseGamblerTimeline({ frames: [] })).toBeNull()
  })

  it('reads the gambler list and per-frame snapshots', () => {
    const timeline = parseGamblerTimeline({
      gamblers: [{ id: 'g-mia', name: 'Mia', persona: 'tourist' }],
      frames: [{ t: 600, gamblers: [{ id: 'g-mia', state: 'seated', dealer_id: 'ada', seat: 0, reason: 'near the door', balance: '5000000', session_net: '-100000' }] }],
    })
    expect(timeline?.frames[0].gamblers[0]).toMatchObject({ state: 'seated', session_net: '-100000', name: null })
  })

  it('refuses an unknown persona', () => {
    expect(() => parseGamblerTimeline({ gamblers: [{ id: 'x', name: 'X', persona: 'robot' }], frames: [] })).toThrow()
  })
})

describe('parseGamblerList: hesitating', () => {
  const entry = (hesitating: unknown, extra: object = {}) => ({
    id: 'g-mia',
    name: 'Mia',
    persona: 'bargain_hunter',
    state: 'deciding',
    dealer_id: 'mine',
    seat: 2,
    reason: "Ada's at 1.0 %: go under 1.1 % and I'm yours",
    balance: '5000000',
    session_net: '0',
    hesitating,
    ...extra,
  })
  const lowerEdge = { dealer_id: 'mine', rival_id: 'ada', want: 'lower_edge', edge_bp: 110, max_bet: null, until: 1_800_000_000 }

  it('is null when absent or null', () => {
    const old: Record<string, unknown> = entry(null)
    delete old.hesitating
    expect(parseGamblerList([old, entry(null)]).map((g) => g.hesitating)).toEqual([null, null])
  })

  it('reads every field of the contract', () => {
    expect(parseGamblerList([entry(lowerEdge)])[0].hesitating).toEqual(lowerEdge)
    const whale = { dealer_id: 'mine', rival_id: null, want: 'higher_max_bet', edge_bp: null, max_bet: '20000000', until: 5 }
    expect(parseGamblerList([entry(whale)])[0].hesitating).toEqual(whale)
    const boost = { dealer_id: 'mine', rival_id: 'bruno', want: 'boost', until: 5 }
    expect(parseGamblerList([entry(boost)])[0].hesitating).toMatchObject({ want: 'boost', edge_bp: null, max_bet: null })
  })

  it('refuses a malformed hesitation', () => {
    for (const bad of [
      { ...lowerEdge, want: 'free_drinks' },
      { ...lowerEdge, edge_bp: null },
      { ...lowerEdge, edge_bp: 1.5 },
      { ...lowerEdge, want: 'higher_max_bet', max_bet: null },
      { ...lowerEdge, want: 'higher_max_bet', max_bet: 20 },
      { ...lowerEdge, until: '5' },
      { ...lowerEdge, rival_id: 7 },
      { ...lowerEdge, dealer_id: 'other' },
      'lower_edge',
    ]) {
      expect(() => parseGamblerList([entry(bad)])).toThrow()
    }
  })

  it('refuses a hesitation outside the deciding state', () => {
    expect(() => parseGamblerList([entry(lowerEdge, { state: 'seated' })])).toThrow()
  })
})
