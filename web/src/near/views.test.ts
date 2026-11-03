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

describe('parseLobby', () => {
  it('accepts the documented dealer shape and drops fields the UI does not use', () => {
    expect(parseLobby([{ ...DEALER, traits: { greed: 85 }, stats: {}, repriced_at: 1 }])).toEqual([DEALER])
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
  it('reads balance, LP positions and the open round', () => {
    expect(
      parsePlayer({
        account_id: 'alice.testnet',
        balance: '5000000',
        lp: [{ dealer_id: 'ada', shares: '10', value: '9' }],
        open_round: null,
        last_round: 12,
        rounds: [3, 12],
      }),
    ).toEqual({ balance: '5000000', lp: [{ dealer_id: 'ada', shares: '10', value: '9' }], open_round: null, last_round: 12 })
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
    const config = { vrf_pubkey_hex: 'c0'.repeat(32), min_bet: '100000', refund_after_secs: 120, owner: 'x' }
    expect(parseConfig(config).refund_after_secs).toBe(120)
    expect(() => parseConfig({ ...config, vrf_pubkey_hex: 'c0' })).toThrow(/vrf_pubkey_hex/)
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
