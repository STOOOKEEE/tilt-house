import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ViewShapeError,
  decodeViewReply,
  getLobby,
  parseConfig,
  parseHistory,
  parseLobby,
  parsePlayer,
  parseRound,
} from './views'

const DEALER = {
  id: 'ada',
  name: 'Ada',
  game: 'dice',
  temperament: 'greedy',
  rake_bp: 345,
  total_edge_bp: 345,
  max_bet: '1520000',
  min_bet: '100000',
  worst_case_multiple: '100',
  boost_until: 0,
  reason: 'fresh_liquidity',
  reason_text: 'raising my max bet and cutting my edge: fresh liquidity came in',
  open: true,
  bankroll: '2000000000',
  reserved: '0',
  open_stakes: '0',
  shares: '2000000000000000',
  share_price_buy: '1000000',
  share_price_sell: '1000000',
}

/** What a v1 lobby entry (no tycoon fields) parses to for the v2 fields. */
const NO_V2 = {
  npc: null,
  controller: null,
  autopilot: null,
  temperament_changed_at: null,
  last_boost_at: null,
  seat: null,
  seat_traffic_bp: null,
  rent_per_hour: null,
  rent_owed: null,
  paid_until: null,
  ask: null,
  cooldown_until: null,
  offer_rake_bp: null,
  base_edge_bp: null,
  open_sessions: null,
  earnings_1h: null,
  rent_1h: null,
  pnl_1h: null,
  gamblers_1h: null,
  game_share_bp: null,
}

/** docs/contract-api.md `get_lobby` v2 extras. */
const V2 = {
  npc: true,
  controller: 'ada.tilthouse.testnet',
  autopilot: true,
  temperament_changed_at: 0,
  last_boost_at: 0,
  offer_rake_bp: 420,
  base_edge_bp: 0,
  seated: true,
  seat: 1,
  seat_traffic_bp: 15000,
  rent_per_hour: '1500000',
  rent_owed: '250',
  paid_until: 1762190000,
  ask: null,
  cooldown_until: 0,
  open_sessions: 1,
  earnings_1h: '1200000',
  rent_1h: '1500000',
  pnl_1h: '-300000',
  stats: { bets_1h: 40, volume_1h: '4000000', player_net_1h: '-1200000', idle_secs: 12, inflow_1h: '0', game_share_bp: 6000, gamblers_1h: 3 },
}

describe('parseLobby', () => {
  it('accepts the v1 dealer shape, v2 fields null, and drops fields the UI does not use', () => {
    expect(parseLobby([{ ...DEALER, traits: { greed: 85 }, stats: {}, repriced_at: 1 }])).toEqual([{ ...DEALER, ...NO_V2 }])
  })

  it('reads the v2 fields: 1-based seat to index, signed P&L, stats', () => {
    const [dealer] = parseLobby([{ ...DEALER, ...V2 }])
    expect(dealer).toMatchObject({
      npc: true,
      controller: 'ada.tilthouse.testnet',
      autopilot: true,
      seat: 0,
      seat_traffic_bp: 15000,
      rent_owed: '250',
      ask: null,
      offer_rake_bp: 420,
      earnings_1h: '1200000',
      pnl_1h: '-300000',
      gamblers_1h: 3,
      game_share_bp: 6000,
    })
  })

  it('fails closed on a present v2 field of the wrong type', () => {
    expect(() => parseLobby([{ ...DEALER, ...V2, seat: 0 }])).toThrow(/seat number/)
    expect(() => parseLobby([{ ...DEALER, ...V2, seat: 7 }])).toThrow(/seat number/)
    expect(() => parseLobby([{ ...DEALER, ...V2, pnl_1h: '-0.3' }])).toThrow(/pnl_1h/)
    expect(() => parseLobby([{ ...DEALER, ...V2, rent_owed: '-1' }])).toThrow(/rent_owed/)
    expect(() => parseLobby([{ ...DEALER, ...V2, npc: 'yes' }])).toThrow(/npc/)
    expect(() => parseLobby([{ ...DEALER, ...V2, stats: { gamblers_1h: -1 } }])).toThrow(/gamblers_1h/)
  })

  it('fails closed on amounts sent as numbers, unknown games or missing fields', () => {
    expect(() => parseLobby([{ ...DEALER, bankroll: 2000000000 }])).toThrow(ViewShapeError)
    expect(() => parseLobby([{ ...DEALER, bankroll: '-1' }])).toThrow(/lobby\[0\]\.bankroll/)
    expect(() => parseLobby([{ ...DEALER, game: 'poker' }])).toThrow(ViewShapeError)
    expect(() => parseLobby([{ ...DEALER, boost_until: '0' }])).toThrow(/boost_until/)
    const { reason_text: _dropped, ...partial } = DEALER
    expect(() => parseLobby([partial])).toThrow(/reason_text/)
    expect(() => parseLobby({})).toThrow(ViewShapeError)
  })
})

describe('parsePlayer', () => {
  it('reads a v1 player: balance, LP positions and the open round, no tables or sessions', () => {
    expect(
      parsePlayer({
        account_id: 'alice.testnet',
        balance: '5000000',
        lp: [{ dealer_id: 'ada', shares: '10', value: '9' }],
        open_round: null,
        last_round: 12,
        rounds: [3, 12],
      }),
    ).toEqual({
      balance: '5000000',
      lp: [{ dealer_id: 'ada', shares: '10', value: '9' }],
      open_round: null,
      last_round: 12,
      tables: [],
      seats: [],
      open_session: null,
      sessions: [],
    })
  })

  it('reads a v2 player: tables, 1-based seats to indexes, sessions', () => {
    expect(
      parsePlayer({
        account_id: 'alice.testnet',
        balance: '5000000',
        lp: [],
        tables: ['alice-dice'],
        seats: [3],
        open_session: 's-17',
        sessions: ['s-3', 's-9', 's-17'],
      }),
    ).toMatchObject({ tables: ['alice-dice'], seats: [2], open_session: 's-17', sessions: ['s-3', 's-9', 's-17'], open_round: null })
    expect(() => parsePlayer({ balance: '0', lp: [], seats: [0] })).toThrow(/player\.seats\[0\]/)
    expect(() => parsePlayer({ balance: '0', lp: [], tables: [1] })).toThrow(/player\.tables\[0\]/)
  })

  it('rejects a float balance or a missing player', () => {
    expect(() => parsePlayer({ balance: 1.5, lp: [] })).toThrow(ViewShapeError)
    expect(() => parsePlayer(null)).toThrow(ViewShapeError)
  })
})

describe('parseRound', () => {
  const ROUND = {
    id: 12,
    player: 'alice.testnet',
    dealer_id: 'eve',
    game: 'blackjack',
    bet: 'blackjack',
    stake: '1000000',
    wager: '2000000',
    rake_bp: 120,
    status: 'settled',
    step: 2,
    created_at: 1_762_190_000,
    updated_at: 1_762_190_021,
    roll: null,
    pocket: null,
    bj: { player: [10, 1], dealer: [9, 7, 5], doubled: false, done: true },
    payout: '4950000',
    proofs: [{ step: 0, alpha: 'vrf:6802:alice.testnet:round-12-0', signature_hex: 'ab', output_hex: 'cd' }],
    error: null,
  }

  it('reads a settled blackjack round with its VRF proofs', () => {
    const round = parseRound(ROUND)
    expect(round?.status).toBe('settled')
    expect(round?.bj?.dealer).toEqual([9, 7, 5])
    expect(round?.roll).toBeNull()
    expect(round?.proofs[0].alpha).toBe('vrf:6802:alice.testnet:round-12-0')
  })

  it('reads dice and roulette bets in core serde form', () => {
    expect(parseRound({ ...ROUND, game: 'dice', bet: { dice: { chance_bp: 5000, over: true } } })?.bet).toEqual({
      dice: { chance_bp: 5000, over: true },
    })
    expect(parseRound({ ...ROUND, game: 'roulette', bet: { roulette: { dozen: 2 } } })?.bet).toEqual({
      roulette: { dozen: 2 },
    })
    expect(() => parseRound({ ...ROUND, bet: { roulette: 'green' } })).toThrow(/round\.bet\.roulette/)
  })

  it('returns null for a missing round and rejects unknown statuses', () => {
    expect(parseRound(null)).toBeNull()
    expect(() => parseRound({ ...ROUND, status: 'won' })).toThrow(ViewShapeError)
    expect(() => parseRound({ ...ROUND, bj: { ...ROUND.bj, player: ['A'] } })).toThrow(/bj\.player\[0\]/)
  })
})

describe('parseHistory', () => {
  it('reads reprice and invest entries', () => {
    const entries = parseHistory([
      { seq: 41, t: 100, kind: 'reprice', text: 'x', reason: 'idle', reason_text: 'x', rake_bp: 300, max_bet: '9', boost_until: 0, account_id: null, amount: null },
      { seq: 42, t: 101, kind: 'invest', text: 'in', reason: null, reason_text: null, rake_bp: null, max_bet: null, boost_until: null, account_id: 'a.testnet', amount: '5' },
    ])
    expect(entries[0]).toMatchObject({ seq: 41, kind: 'reprice', rake_bp: 300, max_bet: '9' })
    expect(entries[1]).toMatchObject({ kind: 'invest', text: 'in', account_id: 'a.testnet', amount: '5', reason: null })
    expect(() => parseHistory([{ ...entries[0], kind: 'jackpot' }])).toThrow(/kind/)
  })
})

describe('parseConfig', () => {
  it('needs a 32-byte hex VRF key', () => {
    const config = { vrf_pubkey_hex: 'c0'.repeat(32), min_bet: '100000', refund_after_secs: 120, next_round_id: 13, owner: 'x' }
    expect(parseConfig(config).refund_after_secs).toBe(120)
    expect(() => parseConfig({ ...config, vrf_pubkey_hex: 'c0' })).toThrow(/vrf_pubkey_hex/)
  })

  it('reads next_round_id, which the spectator view polls', () => {
    const config = { vrf_pubkey_hex: 'c0'.repeat(32), min_bet: '100000', refund_after_secs: 120, next_round_id: 13 }
    expect(parseConfig(config).next_round_id).toBe(13)
    expect(() => parseConfig({ ...config, next_round_id: undefined })).toThrow(/next_round_id/)
  })
})

function rpcReply(result: unknown) {
  return { jsonrpc: '2.0', id: 'x', result: { result: [...new TextEncoder().encode(JSON.stringify(result))] } }
}

describe('decodeViewReply', () => {
  it('decodes the result bytes as JSON', () => {
    expect(decodeViewReply('get_lobby', rpcReply([1, 2]))).toEqual([1, 2])
  })

  it('throws on RPC errors and contract panics', () => {
    expect(() => decodeViewReply('m', { error: { name: 'HANDLER_ERROR' } })).toThrow(/HANDLER_ERROR/)
    expect(() => decodeViewReply('m', { result: { error: 'wasm execution failed' } })).toThrow(/wasm execution/)
  })
})

describe('getLobby', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts a call_function query to the house and parses the reply', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rpcReply([DEALER]))))
    vi.stubGlobal('fetch', fetchMock)

    const lobby = await getLobby({ rpcUrl: 'https://rpc.test', houseContract: 'house.testnet' })

    expect(lobby[0].id).toBe('ada')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://rpc.test')
    const body = JSON.parse(String(init.body)) as { params: Record<string, string> }
    expect(body.params.request_type).toBe('call_function')
    expect(body.params.account_id).toBe('house.testnet')
    expect(body.params.method_name).toBe('get_lobby')
    expect(atob(body.params.args_base64)).toBe('{}')
  })
})
