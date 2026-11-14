import { describe, expect, it } from 'vitest'
import { mockFloor, type DealerFloorInfo, type FloorState } from './near/floor'
import { parseDealer } from './near/views'
import { seasonRanking, tableTag } from './season'

function dealer(id: string, price: string, extra: object = {}) {
  return parseDealer({
    id,
    name: id.toUpperCase(),
    game: 'dice',
    temperament: 'greedy',
    rake_bp: 300,
    total_edge_bp: 300,
    min_bet: '100000',
    max_bet: '1000000',
    worst_case_multiple: '100',
    boost_until: 0,
    reason: 'steady',
    reason_text: 'steady',
    open: true,
    bankroll: '2000000000',
    reserved: '100000000',
    open_stakes: '0',
    shares: '2000000000000000',
    share_price_buy: price,
    share_price_sell: price,
    ...extra,
  })
}

const npc: DealerFloorInfo = { npc: true, controller: 'ada.tilthouse.testnet', dealer_account: null, look: null }
const player = (controller: string): DealerFloorInfo => ({ npc: false, controller, dealer_account: null, look: null })

function state(): FloorState {
  const ada = dealer('ada', '1020000')
  const bruno = dealer('bruno', '980000')
  const mine = dealer('mine', '1050000')
  const late = dealer('late', '1000000', { open: false })
  // Seated in this order (seats 1-3); `late` is off the floor.
  const floor = mockFloor([ada, bruno, mine])
  const info = new Map([
    ['ada', npc],
    ['bruno', npc],
    ['mine', player('alice.testnet')],
    ['late', player('bob.testnet')],
  ])
  return { floor, dealers: [ada, bruno, late, mine], info, mock: false }
}

describe('seasonRanking', () => {
  it('ranks every table by LP price change since it opened', () => {
    const rows = seasonRanking(state())
    expect(rows.map((r) => [r.rank, r.dealerId, r.changeBp])).toEqual([
      [1, 'mine', 500],
      [2, 'ada', 200],
      [3, 'late', 0],
      [4, 'bruno', -200],
    ])
  })

  it('marks player tables with their owner and NPC dealers without one', () => {
    const rows = seasonRanking(state())
    expect(rows[0]).toMatchObject({ playerOwned: true, owner: 'alice.testnet', seat: 3, rent: '1100000' })
    expect(rows[1]).toMatchObject({ playerOwned: false, owner: null, seat: 1, rent: '1500000' })
  })

  it('shows a table off the floor without seat or rent', () => {
    const late = seasonRanking(state()).find((r) => r.dealerId === 'late')
    expect(late).toMatchObject({ seat: null, rent: null, open: false, playerOwned: true, owner: 'bob.testnet' })
  })

  it('breaks ties by seat, then id, and rounds the change toward zero', () => {
    const s = state()
    s.dealers = [dealer('zed', '999999'), dealer('ada', '1000000'), dealer('bruno', '1000000')]
    s.floor = mockFloor([s.dealers[2], s.dealers[1]])
    const rows = seasonRanking(s)
    expect(rows.map((r) => r.dealerId)).toEqual(['bruno', 'ada', 'zed'])
    expect(rows[2].changeBp).toBe(0)
  })

  it('tags the house test wallets\' tables "house test", never a player\'s', () => {
    const rows = seasonRanking(state(), ['alice.testnet'])
    const mine = rows.find((r) => r.dealerId === 'mine')
    expect(mine).toMatchObject({ playerOwned: true, owner: 'alice.testnet', houseTest: true })
    expect(rows.find((r) => r.dealerId === 'late')).toMatchObject({ playerOwned: true, houseTest: false })
    expect(rows.find((r) => r.dealerId === 'ada')).toMatchObject({ playerOwned: false, houseTest: false })
    expect(rows.map(tableTag)).toEqual(['house test', 'NPC', 'player-owned', 'NPC'])
  })

  it('tags no table without configured test accounts', () => {
    expect(seasonRanking(state()).some((r) => r.houseTest)).toBe(false)
    // An NPC dealer is never a house test table, even if its account were listed.
    expect(seasonRanking(state(), ['ada.tilthouse.testnet']).some((r) => r.houseTest)).toBe(false)
  })

  it('is empty on an empty lobby', () => {
    expect(seasonRanking({ ...state(), dealers: [] })).toEqual([])
  })
})
