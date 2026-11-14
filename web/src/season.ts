// Season 1: every table on the USD floor ranked by what it made for its LPs. Pure, so tested
// without a browser or the chain.
import { PRICE_SCALE } from './format'
import { floorSeats, type FloorState } from './near/floor'
import type { Game } from './near/views'

/** Season 1 starts on this UTC day; LP prices count from each table's opening (the launch price). */
export const SEASON_START = '2026-11-14'

export interface SeasonRow {
  rank: number
  dealerId: string
  name: string
  game: Game
  /** A player's table; false = an NPC dealer (a launch table). */
  playerOwned: boolean
  /** The controlling account of a player's table; null for an NPC dealer or when unknown. */
  owner: string | null
  /** A player's table run by the team's labeled test wallets (config `testAccounts`): tagged "house test", not "player". */
  houseTest: boolean
  /** 1-based seat; null off the floor. */
  seat: number | null
  /** Rent per hour in base units; null off the floor. */
  rent: string | null
  /** LP share price, millionths of the launch price. */
  price: string
  /** LP price change since the table opened, in basis points (rounded toward zero). */
  changeBp: number
  open: boolean
}

/**
 * Every table, best LP result first. A table opens at the launch price, so the change of its
 * share price is its LPs' profit per share. Ties: the seated table first, then the better seat,
 * then the id, so the order never flickers between polls.
 */
export function seasonRanking(state: FloorState, testAccounts: readonly string[] = []): SeasonRow[] {
  const seats = floorSeats(state)
  const rows = state.dealers.map((dealer): Omit<SeasonRow, 'rank'> => {
    const index = seats.findIndex((s) => s?.dealer.id === dealer.id)
    const seated = index >= 0 ? seats[index] : null
    const info = state.info.get(dealer.id)
    const playerOwned = seated ? seated.playerOwned : info?.npc === false
    const price = BigInt(dealer.share_price_buy)
    const owner = playerOwned ? (info?.controller ?? dealer.controller) : null
    return {
      dealerId: dealer.id,
      name: dealer.name,
      game: dealer.game,
      playerOwned,
      owner,
      houseTest: owner !== null && testAccounts.includes(owner),
      seat: seated ? index + 1 : null,
      rent: seated ? seated.rent : null,
      price: dealer.share_price_buy,
      changeBp: Number(((price - PRICE_SCALE) * 10_000n) / PRICE_SCALE),
      open: dealer.open,
    }
  })
  rows.sort((a, b) => {
    const [pa, pb] = [BigInt(a.price), BigInt(b.price)]
    if (pa !== pb) return pa > pb ? -1 : 1
    return (a.seat ?? Infinity) - (b.seat ?? Infinity) || a.dealerId.localeCompare(b.dealerId)
  })
  return rows.map((row, i) => ({ ...row, rank: i + 1 }))
}

/** The board's tag for a table: a house test wallet's table is never shown as a player's. */
export function tableTag(row: Pick<SeasonRow, 'houseTest' | 'playerOwned'>): 'house test' | 'player-owned' | 'NPC' {
  if (row.houseTest) return 'house test'
  return row.playerOwned ? 'player-owned' : 'NPC'
}
