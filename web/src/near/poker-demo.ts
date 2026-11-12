/**
 * `?demo=1` practice table: the browser plays the server's part with the same rules mirror
 * (poker-rules.ts) against two local practice bots, and publishes the same `TableState` the
 * session server sends, finished hands included, so the page and its "deck verified" check run
 * exactly as at a live table. No login, no server, no chain, play chips only.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { HandView, LastHand, SeatView, TableState } from './poker-client'
import {
  cardText,
  evaluate,
  historyHash,
  nextButton,
  PokerHand,
  type HandStart,
  type Legal,
  type PokerAction,
} from './poker-rules'
import { randomClientSeed } from './session-client'

const TABLE = 'poker-demo'
const SEATS = 6
const BIG_BLIND = 100_000n
const CONFIG = { small_blind: BIG_BLIND / 2n, big_blind: BIG_BLIND, rake_cap: BIG_BLIND * 3n }
const RAKE_BP = 300
const ACTION_MS = 20_000
const SEED_MS = 1_200
/** Between hands: the result stays on the felt this long. */
const RESULT_MS = 4_500
const BOT_THINK_MS = 900
const BOT_STACK = 10_000_000n
const BOTS = [
  { seat: 2, player: 'practice-ada.bot', name: 'ada' },
  { seat: 4, player: 'practice-bruno.bot', name: 'bruno' },
]
export const DEMO_PLAYER = 'you.demo'

interface DemoSeat {
  seat: number
  player: string
  name: string
  npc: boolean
  stack: bigint
}

export class PokerDemo {
  private seats: (DemoSeat | null)[] = Array.from({ length: SEATS }, () => null)
  private hand: PokerHand | null = null
  private handNumber = 0
  private button = SEATS - 1
  private phase: 'idle' | 'seeding' | 'playing' = 'idle'
  private handSeed = new Uint8Array(32)
  private commitment = ''
  private seeds = new Map<number, string>()
  /** When the current phase or turn times out, or the next hand starts. */
  private due = 0
  private lastHand: LastHand | null = null
  private lastActions = new Map<number, { street: string; action: PokerAction }>()
  private version = 1
  /** The player asked to leave during a hand: folded at the next turn, unseated at its end. */
  private leaving = false
  /** The player's own seed for the current hand (the deck mixes it in). */
  mySeed: string | null = null
  private readonly random: () => number

  constructor(random: () => number = Math.random) {
    this.random = random
    for (const bot of BOTS) this.seats[bot.seat] = { ...bot, npc: true, stack: BOT_STACK }
  }

  youSeat(): number | null {
    const at = this.seats.findIndex((s) => s?.player === DEMO_PLAYER)
    return at < 0 ? null : at
  }

  join(buyIn: bigint, now: number): void {
    if (this.youSeat() !== null) throw new Error('already seated')
    const seat = this.seats.findIndex((s) => s === null)
    if (seat < 0) throw new Error('the table is full')
    this.seats[seat] = { seat, player: DEMO_PLAYER, name: 'you', npc: false, stack: buyIn }
    this.due = Math.min(this.due, now)
    this.version++
  }

  /** Like the server: out of a hand at once, else folded at the next turn and gone when it ends. */
  leave(now: number): boolean {
    const seat = this.youSeat()
    if (seat === null) return true
    const inHand = this.hand?.publicSeats().some((s) => s.seat === seat && !s.folded) ?? false
    if (inHand) {
      this.leaving = true
      if (this.hand?.toAct() === seat) this.play(seat, 'fold', now)
      return false
    }
    this.seats[seat] = null
    this.version++
    return true
  }


  act(action: PokerAction, now: number): void {
    const seat = this.youSeat()
    if (seat === null || !this.hand || this.hand.toAct() !== seat) throw new Error('not your turn')
    this.play(seat, action, now)
  }

  /** Moves the table on to `now`: deals, plays the bots and the clock. Returns whether it changed. */
  tick(now: number): boolean {
    if (now < this.due) return false
    if (this.phase === 'idle') return this.startSeeding(now)
    if (this.phase === 'seeding') return this.deal(now)
    const hand = this.hand
    const seat = hand?.toAct() ?? null
    if (!hand || seat === null) return false
    const legal = hand.legal()
    if (!legal) return false
    const player = this.seats[seat]
    // A bot plays after a short think; the player's clock runs out to a check, else a fold.
    if (!player?.npc && this.leaving) {
      this.play(seat, 'fold', now)
      return true
    }
    const action: PokerAction = player?.npc ? botAction(legal, this.strength(seat), this.random()) : legal.can_check ? 'check' : 'fold'
    this.play(seat, action, now)
    return true
  }

  private startSeeding(now: number): boolean {
    const seated = this.seats.filter((s): s is DemoSeat => s !== null)
    if (seated.length < 2 || this.youSeat() === null) {
      this.due = now + RESULT_MS
      return false
    }
    // Practice bots never go broke for good.
    for (const s of seated) if (s.npc && s.stack < BIG_BLIND * 20n) s.stack = BOT_STACK
    this.handNumber++
    this.handSeed = crypto.getRandomValues(new Uint8Array(32))
    this.commitment = bytesToHex(sha256(this.handSeed))
    this.seeds = new Map(seated.filter((s) => s.npc).map((s) => [s.seat, randomClientSeed()]))
    this.mySeed = randomClientSeed()
    const you = this.youSeat()
    if (you !== null) this.seeds.set(you, this.mySeed)
    this.button = nextButton(
      seated.map((s) => s.seat),
      this.button,
    ) ?? seated[0].seat
    this.phase = 'seeding'
    this.due = now + SEED_MS
    this.version++
    return true
  }

  private deal(now: number): boolean {
    const seated = this.seats.filter((s): s is DemoSeat => s !== null && s.stack > 0n)
    if (seated.length < 2 || !seated.some((s) => s.seat === this.button)) {
      this.phase = 'idle'
      return true
    }
    const start: HandStart = {
      table: TABLE,
      hand: this.handNumber,
      config: CONFIG,
      button: this.button,
      seats: seated.map((s) => ({ seat: s.seat, player: s.player, stack: s.stack, client_seed: this.seeds.get(s.seat) ?? `default-${this.handNumber}`, rake_bp: RAKE_BP })),
      hand_seed_hash: this.commitment,
    }
    this.hand = new PokerHand(start, this.handSeed)
    this.lastActions.clear()
    this.phase = 'playing'
    this.afterMove(now)
    return true
  }

  private play(seat: number, action: PokerAction, now: number): void {
    const hand = this.hand
    if (!hand) return
    const street = hand.street
    hand.act(seat, action)
    this.lastActions.set(seat, { street, action })
    this.afterMove(now)
  }

  private afterMove(now: number): void {
    const hand = this.hand
    this.version++
    if (!hand) return
    if (hand.isDone()) {
      this.finish(hand)
      this.due = now + RESULT_MS
      return
    }
    const next = hand.toAct()
    const quick = next !== null && (this.seats[next]?.npc === true || this.leaving)
    this.due = now + (quick ? BOT_THINK_MS : ACTION_MS)
  }

  private finish(hand: PokerHand): void {
    const result = hand.result
    if (!result) return
    for (const line of result.seats) {
      const seat = this.seats[line.seat]
      if (seat) seat.stack = line.stack_after
    }
    const history = { start: hand.start, hand_seed: bytesToHex(hand.handSeed), actions: [...hand.actions] }
    this.lastHand = {
      number: hand.start.hand,
      commitment: hand.start.hand_seed_hash,
      history,
      history_hash: historyHash(history),
      result: {
        board: result.board.map(cardText),
        showdown: result.showdown,
        pots: result.pots.map((p) => ({ amount: p.amount.toString(), eligible: p.eligible, winners: p.winners })),
        rake: result.rake.toString(),
        seats: result.seats.map((s) => ({
          seat: s.seat,
          player: s.player,
          put_in: s.put_in.toString(),
          won: s.won.toString(),
          stack_after: s.stack_after.toString(),
          shown: s.shown && s.shown.map(cardText),
          value: s.value,
        })),
      },
      deck: hand.deck.map(cardText),
      players: hand.start.seats.map((s) => {
        const line = result.seats.find((r) => r.seat === s.seat)
        return {
          seat: s.seat,
          player: s.player,
          name: this.seats[s.seat]?.name ?? s.player,
          npc: s.player !== DEMO_PLAYER,
          session_id: s.player === DEMO_PLAYER ? 'demo' : 'practice-bot',
          hole: (hand.hole(s.seat) ?? []).map(cardText),
          stake: (line?.put_in ?? 0n).toString(),
          payout: (line?.won ?? 0n).toString(),
          nonce: null,
        }
      }),
      ended_at: Date.now(),
    }
    this.hand = null
    this.phase = 'idle'
    for (const s of this.seats) if (s && !s.npc && (s.stack === 0n || this.leaving)) this.seats[s.seat] = null
    this.leaving = false
  }

  /** Rough strength 0..1 of a seat's hand for the practice bots: pairs, high cards, made hands. */
  private strength(seat: number): number {
    const hand = this.hand
    const hole = hand?.hole(seat)
    if (!hand || !hole) return 0
    const board = hand.board()
    if (board.length === 0) {
      const [a, b] = hole.map((c) => c >> 2)
      const pair = a === b ? 0.5 + a / 26 : 0
      return Math.min(1, pair + (Math.max(a, b) + Math.min(a, b) / 2) / 30 + ((hole[0] & 3) === (hole[1] & 3) ? 0.05 : 0))
    }
    const category = evaluate([...hole, ...board]) >> 20
    return Math.min(1, 0.15 + category * 0.2)
  }

  state(): TableState {
    const hand = this.hand
    const live = hand?.publicSeats() ?? []
    const you = this.youSeat()
    const seats: (SeatView | null)[] = this.seats.map((s) => {
      if (!s) return null
      const inHand = live.find((l) => l.seat === s.seat)
      const last = this.lastActions.get(s.seat)
      return {
        seat: s.seat,
        player: s.player,
        name: s.name,
        npc: s.npc,
        stack: (inHand?.stack ?? s.stack).toString(),
        bet: (inHand?.street_in ?? 0n).toString(),
        total_in: (inHand?.total_in ?? 0n).toString(),
        folded: inHand?.folded ?? false,
        all_in: inHand?.all_in ?? false,
        in_hand: inHand !== undefined,
        waiting: hand !== null && inHand === undefined,
        leaving: false,
        last_action: last && hand && last.street === hand.street ? last.action : null,
        cards: null,
      }
    })
    let view: HandView | null = null
    if (this.phase === 'seeding') {
      view = {
        number: this.handNumber,
        phase: 'seeding',
        commitment: this.commitment,
        seats: this.seats.filter((s): s is DemoSeat => s !== null && s.stack > 0n).map((s) => s.seat),
        seeds_in: [...this.seeds.keys()],
        button: this.button,
        small_blind_seat: null,
        big_blind_seat: null,
        board: [],
        pots: [],
        current_bet: '0',
        to_act: null,
        deadline: this.due,
      }
    } else if (hand) {
      const [sb, bb] = hand.blindSeats()
      view = {
        number: hand.start.hand,
        phase: hand.street,
        commitment: hand.start.hand_seed_hash,
        seats: hand.start.seats.map((s) => s.seat),
        seeds_in: hand.start.seats.map((s) => s.seat),
        button: hand.start.button,
        small_blind_seat: sb,
        big_blind_seat: bb,
        board: hand.board().map(cardText),
        pots: hand.livePots().map((p) => ({ amount: p.amount.toString(), eligible: p.eligible, winners: p.winners })),
        current_bet: hand.currentBet.toString(),
        to_act: hand.toAct(),
        deadline: this.due,
      }
    }
    const legal = hand && you !== null && hand.toAct() === you ? hand.legal() : null
    return {
      table_id: TABLE,
      name: 'Practice table',
      version: this.version,
      seats,
      config: {
        small_blind: CONFIG.small_blind.toString(),
        big_blind: CONFIG.big_blind.toString(),
        rake_cap: CONFIG.rake_cap.toString(),
        min_buy_in: (BIG_BLIND * 20n).toString(),
        max_buy_in: (BIG_BLIND * 100n).toString(),
        rake_bp: RAKE_BP,
        action_ms: ACTION_MS,
        seed_ms: SEED_MS,
      },
      hand: view,
      last_hand: this.lastHand,
      you:
        you === null
          ? null
          : {
              seat: you,
              session_id: 'demo',
              hole: hand?.hole(you)?.map(cardText) ?? null,
              legal,
              state: null,
              last_round: null,
            },
    }
  }
}

/** The practice bots: bet strong hands, call fair prices, fold the rest; a little bluff. */
export function botAction(legal: Legal, strength: number, roll: number): PokerAction {
  if (legal.raise && strength + roll * 0.25 > 0.85) {
    const { min_to, max_to } = legal.raise
    const to = min_to + (max_to - min_to) / 8n
    return { raise_to: to > max_to ? max_to : to }
  }
  if (legal.can_check) return 'check'
  // Cheap calls with anything playable; big ones only with a good hand.
  const cheap = legal.call <= BIG_BLIND * 2n
  if (strength > 0.55 || (cheap && strength + roll * 0.3 > 0.35)) return 'call'
  return 'fold'
}
