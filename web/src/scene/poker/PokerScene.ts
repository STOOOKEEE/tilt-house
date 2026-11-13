// A No-Limit Hold'em table, full screen: up to six blocky players around an oval felt, seen from
// the player's own seat (always the one nearest the camera). The page pushes plain snapshots of
// the table; the scene animates from what it shows to each snapshot in order: deal, bets, sweeps
// into the pot, board cards, showdown, the pot pushed to the winners. When snapshots queue up
// the clock runs faster instead of skipping any.
import * as THREE from 'three'
import { formatUsdc } from '../../format'
import { PERSONAS } from '../../sim/gamblers'
import { createCharacter } from '../characters'
import { gamblerLook } from '../lobby/gamblers'
import { disposeObject, mountRenderer, type MountedRenderer } from '../renderer'
import { cardMesh, faceTexture, setFace } from '../table/cards'
import { Animator, arcTo, buildLights, buildRoom, chipCount, chipStack, PALETTE, textSprite, type TextSprite } from '../table/props'
import type { CharacterRig, Mood } from '../types'
import {
  BOARD_GAP,
  boardSlot,
  CAMERA,
  cameraEye,
  chairAt,
  POKER_FELT_Y,
  POT_LABEL,
  POT_MAX_CHIPS,
  potSlot,
  RADIUS,
  seatSlot,
  slotAngle,
  towardSeat,
  type FlatPoint,
} from './layout'
import { buildOvalTable, dealerButton, deckPile, timerRing } from './table'

export interface PokerSeatScene {
  seat: number
  player: string
  name: string
  npc: boolean
  you: boolean
  stack: string
  bet: string
  folded: boolean
  allIn: boolean
  /** Card codes ("As") face up, null face down; empty when not holding cards. */
  cards: readonly (string | null)[]
  /** The last action, said in a bubble ("raise 4.00"); null hides it. */
  said: string | null
}

export interface PokerWinner {
  seat: number
  amount: string
  label: string
}

export interface PokerSceneState {
  seats: readonly (PokerSeatScene | null)[]
  /** Hand number; a new one sweeps the table and deals. */
  hand: number | null
  button: number | null
  board: readonly string[]
  /** Pot amounts already swept to the middle: main pot first, then side pots. */
  pots: readonly string[]
  toAct: number | null
  /** Unix ms when the player to act is auto-played. */
  deadline: number | null
  actionMs: number
  /** Set once a hand is over: the pot goes to these seats. */
  winners: readonly PokerWinner[]
}

export interface PokerSceneApi {
  show(state: PokerSceneState): void
  dispose(): void
}

const DECK_AT: FlatPoint = { x: 1.0, z: -0.62 }
const CARD_SPREAD = 0.2
const OWN_CARD_SCALE = 1.15
const OWN_CARD_TILT = 0.6
const BUBBLE_SCALE = 0.5
const DEAL_S = 0.32
const SWEEP_S = 0.45
const WIN_HOLD_S = 2.4
const BACKLOG_SPEEDUP = 0.9
const MAX_TIME_SCALE = 5
const EMPTY: PokerSceneState = { seats: [], hand: null, button: null, board: [], pots: [], toAct: null, deadline: null, actionMs: 1, winners: [] }
const SUITS: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }
const RANKS = '23456789TJQKA'

export function createPokerScene(el: HTMLElement, options: { title: string; accent: string }): PokerSceneApi {
  return new PokerScene(el, options)
}

/** "As" → the blackjack face drawer's rank (ace 1, ten 10, faces 11-13) and suit symbol. */
function cardFace(code: string): THREE.Texture {
  const rank = RANKS.indexOf(code[0]) + 2
  return faceTexture(rank === 14 ? 1 : rank, SUITS[code[1]] ?? '♠')
}

interface SeatObjects {
  player: string
  rig: CharacterRig | null
  plate: TextSprite
  tag: TextSprite
  /** One holder per card: yaw and tilt on the holder, the face-up/down flip on its mesh. */
  cards: THREE.Group[]
  codes: (string | null)[]
  bet: THREE.Group | null
  betLabel: TextSprite
}

class PokerScene implements PokerSceneApi {
  private readonly mounted: MountedRenderer
  private readonly anim = new Animator()
  private readonly seats = new Map<number, SeatObjects>()
  private readonly empties: TextSprite[] = []
  private readonly board: THREE.Group[] = []
  private boardCodes: string[] = []
  private pots: THREE.Group[] = []
  private readonly potLabels: TextSprite[] = []
  private readonly button = dealerButton()
  private readonly timer = timerRing()
  private readonly result = textSprite(0.2, 34)
  private shown: PokerSceneState = EMPTY
  private target: PokerSceneState = EMPTY
  private readonly queue: PokerSceneState[] = []
  private running = false
  private disposed = false
  private pivot = 0
  private seatCount = 6
  private readonly unsubscribe: () => void

  constructor(host: HTMLElement, options: { title: string; accent: string }) {
    this.mounted = mountRenderer(host)
    const { scene, camera } = this.mounted
    camera.fov = CAMERA.fov
    buildLights(scene)
    scene.add(buildRoom(options.title, options.accent))
    scene.add(buildOvalTable(options.accent, options.title))
    const deck = deckPile()
    deck.position.copy(this.felt(DECK_AT))
    this.button.visible = false
    this.result.sprite.position.set(0, POKER_FELT_Y + 0.75, 0.1)
    scene.add(deck, this.button, this.timer.object, this.result.sprite)
    for (let i = 0; i < 6; i++) {
      const label = textSprite(POT_LABEL.height, 9)
      label.sprite.position.copy(this.felt(potSlot(i), POT_LABEL.lift))
      this.potLabels.push(label)
      scene.add(label.sprite)
    }
    this.unsubscribe = this.mounted.onFrame((dt) => this.frame(dt))
  }

  show(state: PokerSceneState): void {
    if (this.disposed) return
    this.queue.push(state)
    this.target = state
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.queue.length = 0
    this.anim.finishAll()
    this.unsubscribe()
    for (const seat of this.seats.values()) seat.rig?.dispose()
    this.mounted.dispose()
  }

  // ---- queue --------------------------------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let next = this.queue.shift(); next && !this.disposed; next = this.queue.shift()) {
        this.anim.timeScale = Math.min(MAX_TIME_SCALE, 1 + this.queue.length * BACKLOG_SPEEDUP)
        await this.transition(this.shown, next)
        this.shown = next
      }
    } finally {
      this.running = false
      this.anim.timeScale = 1
    }
  }

  private async transition(from: PokerSceneState, to: PokerSceneState): Promise<void> {
    this.layout(to)
    const newHand = to.hand !== null && to.hand !== from.hand
    if (newHand) {
      this.result.set('')
      await this.sweepTable()
    }
    // Bets that disappeared went into the pot: slide them in before the pot grows.
    const swept = this.bettors(from).some((seat) => !this.bettors(to).includes(seat)) || to.winners.length > 0
    if (swept) await this.sweepBets()
    await this.dealCards(to, newHand)
    await this.dealBoard(to.board)
    this.placeBets(to)
    // Once the hand is over the pots stay unlabeled in the middle until they are pushed to the winners.
    this.placePots(to.pots, to.winners.length === 0)
    this.refreshSeats(to)
    if (to.winners.length > 0 && from.winners.length === 0) await this.payWinners(to)
  }

  // ---- seats ---------------------------------------------------------------------------------

  /** Seats rotate so the player's own seat is the nearest one; spectators look from an empty seat. */
  private layout(state: PokerSceneState): void {
    const you = state.seats.find((s) => s?.you)
    const seatCount = Math.max(2, state.seats.length)
    const pivot = you ? you.seat : Math.max(0, state.seats.indexOf(null))
    const moved = pivot !== this.pivot || seatCount !== this.seatCount
    this.pivot = pivot
    this.seatCount = seatCount
    for (const [seat, objects] of this.seats) {
      const view = state.seats[seat]
      if (!view || view.player !== objects.player || moved || view.you !== (objects.rig === null)) this.removeSeat(seat)
    }
    state.seats.forEach((view, seat) => {
      if (view && !this.seats.has(seat)) this.addSeat(view)
    })
    for (const label of this.empties.splice(0)) {
      label.sprite.removeFromParent()
      disposeObject(label.sprite)
    }
    state.seats.forEach((view, seat) => {
      if (view) return
      const label = textSprite(0.11, 9)
      label.set('open seat', PALETTE.green)
      label.sprite.position.copy(this.felt(towardSeat(this.angle(seat), RADIUS.plate), 0.35))
      this.empties.push(label)
      this.mounted.scene.add(label.sprite)
    })
  }

  private angle(seat: number): number {
    return slotAngle(seatSlot(seat, this.pivot, this.seatCount), this.seatCount)
  }

  private addSeat(view: PokerSeatScene): void {
    const angle = this.angle(view.seat)
    let rig: CharacterRig | null = null
    if (!view.you) {
      const persona = PERSONAS[hash(view.player) % PERSONAS.length]
      rig = createCharacter(gamblerLook(view.player, persona), view.name, { bubbleScale: BUBBLE_SCALE })
      const chair = chairAt(angle)
      rig.object.position.set(chair.x, 0, chair.z)
      rig.object.rotation.y = chair.yaw
      this.mounted.scene.add(rig.object)
    }
    const plate = textSprite(0.13, 16)
    // The player's own plate sits on the near rim, below its cards.
    plate.sprite.position.copy(this.felt(towardSeat(angle, view.you ? 1.08 : RADIUS.plate), view.you ? 0.16 : 0.42))
    const tag = textSprite(0.1, 4)
    tag.sprite.position.copy(plate.sprite.position).add(new THREE.Vector3(0, 0.13, 0))
    const betLabel = textSprite(0.09, 7)
    betLabel.sprite.position.copy(this.felt(towardSeat(angle, RADIUS.bet), 0.28))
    this.mounted.scene.add(plate.sprite, tag.sprite, betLabel.sprite)
    this.seats.set(view.seat, { player: view.player, rig, plate, tag, cards: [], codes: [], bet: null, betLabel })
  }

  private removeSeat(seat: number): void {
    const objects = this.seats.get(seat)
    if (!objects) return
    this.seats.delete(seat)
    objects.rig?.dispose()
    for (const object of [objects.plate.sprite, objects.tag.sprite, objects.betLabel.sprite, ...objects.cards, ...(objects.bet ? [objects.bet] : [])]) {
      object.removeFromParent()
      disposeObject(object)
    }
  }

  private refreshSeats(state: PokerSceneState): void {
    for (const view of state.seats) {
      const objects = view ? this.seats.get(view.seat) : undefined
      if (!view || !objects) continue
      const status = view.folded ? ' · fold' : view.allIn ? ' · ALL IN' : ''
      objects.plate.set(`${view.you ? 'you' : view.name} ${formatUsdc(view.stack)}${status}`, view.seat === state.toAct ? PALETTE.gold : view.you ? PALETTE.pink : PALETTE.cream)
      objects.tag.set(view.npc ? 'BOT' : '', PALETTE.pink)
      const won = state.winners.some((w) => w.seat === view.seat)
      const mood: Mood = won ? 'happy' : view.stack === '0' && !view.allIn ? 'broke' : view.allIn ? 'nervous' : 'neutral'
      objects.rig?.setMood(mood)
      objects.rig?.say(view.said)
    }
    if (state.button !== null && state.seats[state.button]) {
      const at = towardSeat(this.angle(state.button) - 0.32, RADIUS.button)
      this.button.position.copy(this.felt(at, 0.02))
      this.button.visible = true
    } else this.button.visible = false
  }

  // ---- cards -------------------------------------------------------------------------------

  private felt(p: FlatPoint, lift = 0): THREE.Vector3 {
    return new THREE.Vector3(p.x, POKER_FELT_Y + lift, p.z)
  }

  private cardHolder(code: string | null, own: boolean, yaw: number): THREE.Group {
    const holder = new THREE.Group()
    const mesh = cardMesh(code ? cardFace(code) : null)
    mesh.rotation.z = Math.PI
    holder.add(mesh)
    holder.rotation.order = 'YXZ'
    holder.rotation.y = yaw
    if (own) {
      holder.scale.setScalar(OWN_CARD_SCALE)
      holder.rotation.x = OWN_CARD_TILT
    }
    holder.position.copy(this.felt(DECK_AT, 0.05))
    this.mounted.scene.add(holder)
    return holder
  }

  private cardSpot(seat: number, index: number, own: boolean): THREE.Vector3 {
    const angle = this.angle(seat)
    const base = towardSeat(angle, own ? RADIUS.ownCards : RADIUS.cards)
    // Fan the two cards side by side, across the line to the seat.
    const spread = (index - 0.5) * CARD_SPREAD * (own ? 2.1 : 1.4)
    return this.felt({ x: base.x + Math.cos(angle) * spread, z: base.z + Math.sin(angle) * spread }, own ? 0.12 : 0.008 + index * 0.004)
  }

  private async flip(holder: THREE.Group, code: string): Promise<void> {
    const mesh = holder.children[0]
    if (!(mesh instanceof THREE.Mesh)) return
    setFace(mesh, cardFace(code))
    await this.anim.tween(0.3, (t) => (mesh.rotation.z = Math.PI * (1 - t)))
  }

  /** Deals new hole cards (in turn from the button), turns shown ones, mucks folded hands. */
  private async dealCards(state: PokerSceneState, newHand: boolean): Promise<void> {
    const order = [...state.seats.keys()].sort((a, b) => this.dealOrder(a, state) - this.dealOrder(b, state))
    for (const seat of order) {
      const view = state.seats[seat]
      const objects = this.seats.get(seat)
      if (!view || !objects) continue
      if (view.cards.length === 0 && objects.cards.length > 0) await this.muck(objects)
    }
    for (let round = 0; round < 2; round++) {
      for (const seat of order) {
        const view = state.seats[seat]
        const objects = this.seats.get(seat)
        if (!view || !objects || view.cards.length <= round || objects.cards.length > round) continue
        const code = view.cards[round]
        const holder = this.cardHolder(code, view.you, this.angle(seat))
        objects.cards.push(holder)
        objects.codes.push(code)
        const landing = arcTo(this.anim, holder, this.cardSpot(seat, round, view.you), newHand ? DEAL_S : DEAL_S * 1.4, 0.2)
        await (code ? Promise.all([landing, this.flip(holder, code)]) : landing)
      }
    }
    const flips: Promise<void>[] = []
    for (const view of state.seats) {
      const objects = view ? this.seats.get(view.seat) : undefined
      if (!view || !objects) continue
      view.cards.forEach((code, i) => {
        if (code && objects.codes[i] !== code && objects.cards[i]) {
          objects.codes[i] = code
          flips.push(this.flip(objects.cards[i], code))
        }
      })
    }
    await Promise.all(flips)
  }

  private dealOrder(seat: number, state: PokerSceneState): number {
    const n = this.seatCount
    return state.button === null ? seat : (seat - state.button - 1 + n * 2) % n
  }

  private async muck(objects: SeatObjects): Promise<void> {
    const cards = objects.cards.splice(0)
    objects.codes = []
    await Promise.all(cards.map((card) => arcTo(this.anim, card, this.felt(DECK_AT, 0.05), SWEEP_S, 0.15)))
    for (const card of cards) {
      card.removeFromParent()
      disposeObject(card)
    }
  }

  private async dealBoard(board: readonly string[]): Promise<void> {
    if (board.length < this.boardCodes.length) await this.clearBoard()
    for (let i = this.boardCodes.length; i < board.length; i++) {
      const holder = this.cardHolder(board[i], false, 0)
      this.board.push(holder)
      this.boardCodes.push(board[i])
      await Promise.all([arcTo(this.anim, holder, this.felt(boardSlot(i, BOARD_GAP), 0.008), DEAL_S, 0.2), this.flip(holder, board[i])])
    }
  }

  private async clearBoard(): Promise<void> {
    const cards = this.board.splice(0)
    this.boardCodes = []
    await Promise.all(cards.map((card) => arcTo(this.anim, card, this.felt(DECK_AT, 0.05), SWEEP_S, 0.15)))
    for (const card of cards) {
      card.removeFromParent()
      disposeObject(card)
    }
  }

  /** A new hand: every card back to the deck, the bets and pots gone. */
  private async sweepTable(): Promise<void> {
    await Promise.all([...[...this.seats.values()].map((objects) => this.muck(objects)), this.clearBoard()])
    this.placePots([], false)
    for (const objects of this.seats.values()) this.setBet(objects, null, '0')
  }

  // ---- chips -------------------------------------------------------------------------------

  private bettors(state: PokerSceneState): number[] {
    return state.seats.filter((s): s is PokerSeatScene => s !== null && s.bet !== '0').map((s) => s.seat)
  }

  private setBet(objects: SeatObjects, seat: number | null, amount: string): void {
    if (objects.bet) {
      objects.bet.removeFromParent()
      disposeObject(objects.bet)
      objects.bet = null
    }
    objects.betLabel.set(amount === '0' ? '' : formatUsdc(amount), PALETTE.gold)
    if (amount === '0' || seat === null) return
    const stack = chipStack(chipCount(amount), seat)
    stack.position.copy(this.felt(towardSeat(this.angle(seat), RADIUS.bet)))
    this.mounted.scene.add(stack)
    objects.bet = stack
  }

  private placeBets(state: PokerSceneState): void {
    for (const [seat, objects] of this.seats) this.setBet(objects, seat, state.seats[seat]?.bet ?? '0')
  }

  /** Every bet in front slides to the middle. */
  private async sweepBets(): Promise<void> {
    const moving = [...this.seats.values()].filter((o) => o.bet !== null)
    if (moving.length === 0) return
    for (const o of moving) o.betLabel.set('')
    await Promise.all(moving.map((o) => (o.bet ? arcTo(this.anim, o.bet, this.felt(potSlot(0)), SWEEP_S, 0.1) : Promise.resolve())))
    for (const o of moving) this.setBet(o, null, '0')
  }

  private placePots(amounts: readonly string[], labeled: boolean): void {
    for (const pot of this.pots.splice(0)) {
      pot.removeFromParent()
      disposeObject(pot)
    }
    amounts.forEach((amount, i) => {
      const stack = chipStack(Math.min(chipCount(amount), POT_MAX_CHIPS), i + 2)
      stack.position.copy(this.felt(potSlot(i)))
      this.pots.push(stack)
      this.mounted.scene.add(stack)
    })
    this.potLabels.forEach((label, i) => {
      const amount = labeled ? amounts[i] : undefined
      label.set(amount === undefined ? '' : `${i === 0 ? 'pot' : 'side'} ${formatUsdc(amount)}`, i === 0 ? PALETTE.gold : PALETTE.pink)
    })
  }

  private async payWinners(to: PokerSceneState): Promise<void> {
    const total = to.winners.reduce((sum, w) => sum + BigInt(w.amount), 0n)
    const names = to.winners.map((w) => {
      const seat = to.seats[w.seat]
      return `${seat?.you ? 'you' : (seat?.name ?? `seat ${w.seat + 1}`)} +${formatUsdc(w.amount)}${w.label ? ` · ${w.label}` : ''}`
    })
    this.result.set(names.join('   '), PALETTE.gold)
    const piles = this.pots.splice(0)
    if (piles.length === 0 && total > 0n) {
      const pile = chipStack(chipCount(total.toString()), 1)
      pile.position.copy(this.felt(potSlot(0)))
      this.mounted.scene.add(pile)
      piles.push(pile)
    }
    const moves = to.winners.flatMap((w, i) => {
      const pile = piles[i % Math.max(1, piles.length)]
      if (!pile) return []
      const spot = this.felt(towardSeat(this.angle(w.seat), RADIUS.bet))
      return [arcTo(this.anim, i < piles.length ? pile : pile.clone(), spot, 0.7, 0.35)]
    })
    for (const w of to.winners) void this.seats.get(w.seat)?.rig?.gesture({ kind: 'celebrate' })
    await Promise.all(moves)
    await this.anim.wait(WIN_HOLD_S)
    for (const pile of piles) {
      pile.removeFromParent()
      disposeObject(pile)
    }
  }

  // ---- frame -------------------------------------------------------------------------------

  private frame(dt: number): void {
    this.anim.update(dt)
    for (const objects of this.seats.values()) objects.rig?.update(dt)
    this.frameCamera()
    const { toAct, deadline, actionMs } = this.target
    const acting = toAct !== null && deadline !== null && this.target.winners.length === 0
    this.timer.object.visible = acting
    if (acting && toAct !== null && deadline !== null) {
      const spot = towardSeat(this.angle(toAct), RADIUS.cards)
      this.timer.object.position.copy(this.felt(spot))
      this.timer.set((deadline - Date.now()) / Math.max(1, actionMs))
    }
  }

  private frameCamera(): void {
    const camera = this.mounted.camera
    const eye = cameraEye(camera.aspect)
    camera.position.set(eye.x, eye.y, eye.z)
    camera.lookAt(CAMERA.lookAt.x, CAMERA.lookAt.y, CAMERA.lookAt.z)
  }
}

/** A stable small number from an account id: the same player always looks the same. */
function hash(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}
