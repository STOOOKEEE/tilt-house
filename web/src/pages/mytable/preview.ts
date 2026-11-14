/**
 * Dev only (`/my-table?as=<dealer_id>&sample=1`): made-up gamblers at a table, so the cockpit can be
 * looked at before a player table has live customers. Each hesitating one decides after its pause
 * (sits, goes to the rival, leaves) so the outcomes show too. Never used in a production build.
 */
import type { FloorState } from '../../near/floor'
import type { GamblerSnapshot, Hesitation } from '../../sim/gamblers'
import { maxBetCap } from '../../tycoon'

export function sampleFeed(state: FloorState, dealerId: string, anchor: number, now: number): GamblerSnapshot[] {
  const mine = state.dealers.find((d) => d.id === dealerId)
  if (!mine) return []
  const rival = state.dealers.find((d) => d.id !== dealerId && d.game === mine.game) ?? state.dealers.find((d) => d.id !== dealerId)
  const rivalId = rival?.id ?? null
  const seat = state.floor.seats.find((s) => s.dealer_id === dealerId)?.seat ?? null
  const edge = Math.max(mine.total_edge_bp - 25, 100)
  const whaleBet = maxBetCap(mine) * 2n

  const gambler = (id: string, name: string, persona: GamblerSnapshot['persona'], reason: string, session_net = '0'): GamblerSnapshot => ({
    id,
    name,
    persona,
    state: 'seated',
    dealer_id: dealerId,
    seat,
    reason_code: null,
    reason,
    balance: '50000000',
    session_net,
    hesitating: null,
  })
  /** Deciding at our table until `wait` seconds after the anchor, then `after` (null = gone). */
  const asking = (g: GamblerSnapshot, want: Omit<Hesitation, 'dealer_id' | 'until'>, wait: number, after: Partial<GamblerSnapshot> | null) => {
    const until = anchor + wait
    if (now < until) return [{ ...g, state: 'deciding' as const, hesitating: { dealer_id: dealerId, until, ...want } }]
    return after === null ? [] : [{ ...g, ...after }]
  }

  return [
    ...asking(
      gambler('g-sample-mia', 'Mia', 'bargain_hunter', `${rival?.name ?? 'the other table'}'s at ${((rival?.total_edge_bp ?? edge) / 100).toFixed(1)} %: go under ${(edge / 100).toFixed(2)} % and I'm yours`),
      { rival_id: rivalId, want: 'lower_edge', edge_bp: edge, max_bet: null },
      75,
      { reason: `your ${(edge / 100).toFixed(2)} % won me over` },
    ),
    ...asking(
      gambler('g-sample-otto', 'Otto', 'whale', `my stakes need a max bet of ${Number(whaleBet) / 1e6}: take them and I sit`),
      { rival_id: rivalId, want: 'higher_max_bet', edge_bp: null, max_bet: String(whaleBet) },
      110,
      { state: 'seated', dealer_id: rivalId, reason: `${rival?.name ?? 'the other table'} takes my stakes` },
    ),
    ...asking(
      gambler('g-sample-tom', 'Tom', 'thrill_seeker', 'nothing here gets my heart going: boost and I stay'),
      { rival_id: null, want: 'boost', edge_bp: null, max_bet: null },
      150,
      null,
    ),
    gambler('g-sample-vera', 'Vera', 'whale', 'your max bet takes my stakes', String(BigInt(mine.bankroll) / 12n)),
    gambler('g-sample-leo', 'Leo', 'regular', 'you treated me well last time', '-2400000'),
  ]
}
