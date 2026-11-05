// One dealer's table seen from the player's seat: room, felt, the dealer rig, the game props and
// the dealer's display board, playing rounds step by step as planned by the director. The felt is
// the input: clicks on it are reported in felt coordinates, the page decides what they mean. Steps run strictly in order (a draw is never skipped); when rounds
// queue up the clock runs faster instead.
import * as THREE from 'three'
import { formatUsdc } from '../../format'
import type { Game, RoundView, RouletteBet } from '../../near/views'
import { createCharacter } from '../characters'
import { dealerLook } from '../looks'
import { disposeObject, mountRenderer, type MountedRenderer } from '../renderer'
import type { CharacterRig, FeltAction, FeltCell, Mood, SlipStack, TableSceneApi } from '../types'
import { createBoard, type BoardInfo } from './board'
import { BLACKJACK_BET, Cards, paintBlackjackFelt } from './cards'
import { Dice, paintDiceFelt } from './dice'
import { endsDrawing, planRound, type Step } from './director'
import { betCell, chipColor, DICE_BET_SPOT } from './felt'
import {
  Animator,
  arcTo,
  buildLights,
  buildRoom,
  buildTable,
  chipCount,
  chipStack,
  easeInOut,
  CURTAIN_UP_Y,
  curtain,
  type FeltTable,
  feltPoint,
  FELT_Y,
  hourglass,
  TABLE_D,
  TABLE_W,
  textSprite,
  valueStack,
} from './props'
import { paintRouletteFelt, Roulette, WHEEL_AT } from './roulette'

export interface TableSceneOptions {
  dealerId: string
  dealerName: string
  game: Game
  /** Called when a round's first step plays, so the page can label whose round is on the felt. */
  onRound?: (round: RoundView) => void
  /** The pointer on the felt, in felt coordinates. */
  onFelt?: (u: number, v: number, action: FeltAction) => void
}

/** The dealer sits this far behind the felt's back edge, its hands resting over the felt. */
const DEALER_Z = -TABLE_D / 2 - 0.35
/** Each round still waiting in the queue speeds the clock up by this much. */
const BACKLOG_SPEEDUP = 0.75
const MAX_TIME_SCALE = 4
const RESULT_HOLD_S = 1
/** The answer after a drawing loop: the long throw already played while the VRF drew. */
const FAST_RESULT_SPEED = 2.5
const DRAWING_TEXT = 'shuffling…'
/**
 * Close-ups while a round plays: over the wheel, down on the dice, a little closer to the cards.
 * The camera glides there in `SHOT_MOVE_S` when the player plays and back once the result held.
 */
const WHEEL = feltPoint(WHEEL_AT.u, WHEEL_AT.v)
const SHOTS: Record<Game, { eye: THREE.Vector3; look: THREE.Vector3; amount: number }> = {
  roulette: { eye: new THREE.Vector3(WHEEL.x + 0.25, 2.55, WHEEL.z + 0.95), look: WHEEL.clone(), amount: 1 },
  dice: { eye: new THREE.Vector3(0, 2.5, 1.55), look: feltPoint(0.5, 0.38), amount: 0.85 },
  blackjack: { eye: new THREE.Vector3(0, 2.3, 1.7), look: feltPoint(0.5, 0.42), amount: 0.6 },
}
const SHOT_MOVE_S = 0.4
const CLOSE_UP_HOLD_S = 1
/** Skipping plays the rest of the round this many times faster. */
const SKIP_SPEED = 12
/** The player's eyes: seated at the felt's near edge, looking down at it and across at the dealer. */
const EYE = new THREE.Vector3(0, 2.45, TABLE_D / 2 + 2.0)
const LOOK_AT = new THREE.Vector3(0, 1.0, -0.75)
/** The whole felt width must stay in view, a little margin on each side. */
const FRAME_HALF_W = TABLE_W / 2 + 0.15
const SEAT_FOV = 50
/** From the seat the dealer is close: a smaller bubble keeps the board and the felt in view. */
const SEAT_BUBBLE_SCALE = 0.55
/** Where the board stands: behind the felt, to the dealer's left (the player's right). */
const BOARD_AT = new THREE.Vector3(1.75, 1.9, -TABLE_D / 2 - 0.8)
/** A press held this long (ms) takes a chip off, like a right-click. */
const LONG_PRESS_MS = 500
/** A press that moves farther than this (px) is a drag, not a click. */
const CLICK_SLOP = 8

type Props =
  | { game: 'blackjack'; cards: Cards }
  | { game: 'roulette'; wheel: Roulette }
  | { game: 'dice'; dice: Dice }

export function createTableScene(el: HTMLElement, options: TableSceneOptions): TableSceneApi {
  return new TableScene(el, options)
}

class TableScene implements TableSceneApi {
  private readonly mounted: MountedRenderer
  private readonly anim = new Animator()
  private readonly rig: CharacterRig
  private readonly table: FeltTable
  private readonly hourglass = hourglass()
  private readonly curtain = curtain()
  private readonly drawingLabel = textSprite(0.14, DRAWING_TEXT.length + 1)
  /** Between the player's click and the first step showing the draw's answer. */
  private drawing = false
  /** The steps right after a drawing loop run fast, up to the settle. */
  private fastResult = false
  private props: Props | null = null
  /** The roulette bet of the round on the felt: where its chips go. */
  private rouletteBet: RouletteBet | null = null
  private stake: THREE.Group[] = []
  /** The player's unplayed chips; hidden while a round plays (its own stake animates instead). */
  private readonly slip = new THREE.Group()
  private readonly glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly board = createBoard()
  private readonly detachPointer: () => void
  /** 0 = seat view, 1 = the game's close-up; eased toward `shotTarget` every frame. */
  private shot = 0
  private shotTarget = 0
  private skipping = false
  /** Seconds (frame clock, unaffected by the animation speed) until the camera goes back; null = no release pending. */
  private releaseIn: number | null = null
  private queue: Step[] = []
  private lastQueued: RoundView | null = null
  private running = false
  private disposed = false
  private reason: string | null = null
  private open = true
  private readonly unsubscribe: () => void

  private readonly options: TableSceneOptions

  constructor(host: HTMLElement, options: TableSceneOptions) {
    this.options = options
    this.mounted = mountRenderer(host)
    const { scene, camera } = this.mounted
    camera.fov = SEAT_FOV
    buildLights(scene)
    const look = dealerLook(options.dealerId)
    scene.add(buildRoom(options.dealerName, look.accent))
    this.table = buildTable(look.accent)
    scene.add(this.table.object)
    this.rig = createCharacter(look, options.dealerName, { bubbleScale: SEAT_BUBBLE_SCALE })
    this.rig.object.position.set(0, 0, DEALER_Z)
    scene.add(this.rig.object)
    this.hourglass.position.copy(feltPoint(0.7, 0.22, 0.75))
    this.drawingLabel.sprite.position.copy(feltPoint(0.5, 0.3, 0.6))
    scene.add(this.hourglass, this.curtain, this.drawingLabel.sprite)
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.4, depthWrite: false }),
    )
    this.glow.rotation.x = -Math.PI / 2
    this.glow.visible = false
    this.board.object.position.copy(BOARD_AT)
    this.board.object.rotation.y = Math.atan2(EYE.x - BOARD_AT.x, EYE.z - BOARD_AT.z)
    scene.add(this.slip, this.glow, this.board.object)
    this.detachPointer = this.attachPointer()
    this.setGame(options.game)
    this.unsubscribe = this.mounted.onFrame((dt, elapsed) => this.frame(dt, elapsed))
  }

  setGame(game: Game): void {
    if (this.props?.game === game) return
    if (this.props) {
      const group = this.propsGroup(this.props)
      group.removeFromParent()
      disposeObject(group)
    }
    this.props = buildProps(game, this.anim)
    this.table.object.add(this.propsGroup(this.props))
    if (this.props.game === 'roulette') this.table.object.add(this.props.wheel.marker)
    this.table.paint(game === 'blackjack' ? paintBlackjackFelt : game === 'roulette' ? paintRouletteFelt : paintDiceFelt)
  }

  showRound(previous: RoundView | null, next: RoundView): void {
    if (this.disposed) return
    if (next.game !== this.props?.game) this.setGame(next.game)
    // Diff against what the felt will actually show: `previous` only counts if it is the last snapshot
    // queued. Otherwise (another round queued in between) the round is replayed whole.
    const shown = previous !== null && previous.id === this.lastQueued?.id ? this.lastQueued : null
    this.queue.push(...planRound(shown, next, this.drawing))
    this.lastQueued = next
    void this.drain()
  }

  startDrawing(game: Game): void {
    if (this.disposed || this.drawing) return
    this.setGame(game)
    this.drawing = true
    this.slip.visible = false
    this.glow.visible = false
    this.shotTarget = 1
    this.releaseIn = null
    // The player is waiting: clearing the last round and placing the bet run fast too.
    this.fastResult = true
    this.drawingLabel.set(DRAWING_TEXT)
    this.hourglass.visible = false
    const props = this.props
    if (props?.game === 'dice') props.dice.startShaking()
    if (props?.game === 'blackjack') props.cards.hold()
    if (props?.game === 'roulette') {
      props.wheel.startRunning()
      void this.rig.gesture({ kind: 'spin' })
    }
    // A new round: the finished one leaves the felt now, not when the bet shows up.
    const last = this.lastQueued
    if (last === null || last.status === 'settled' || last.status === 'refunded' || last.status === 'failed') {
      this.queue.push({ kind: 'clear' })
      void this.drain()
    }
  }

  stopDrawing(): void {
    if (this.drawing) this.endDrawing(false)
    this.shotTarget = 0
  }

  animating(): boolean {
    return this.running || this.drawing
  }

  /** Plays the rest of the queued round fast and cuts the camera back to the seat. */
  skip(): void {
    if (!this.running) return
    this.skipping = true
    this.anim.timeScale = SKIP_SPEED
  }

  setMood(mood: Mood): void {
    this.rig.setMood(mood)
  }

  say(text: string | null): void {
    this.reason = text
    this.rig.say(text)
  }

  setOpen(open: boolean): void {
    if (open === this.open) return
    this.open = open
    this.curtain.visible = true
    const from = this.curtain.position.y
    const to = open ? CURTAIN_UP_Y : 0
    void this.anim.tween(1.2, (t) => (this.curtain.position.y = from + (to - from) * t)).then(() => {
      if (this.open) this.curtain.visible = false
    })
  }

  setSlip(stacks: readonly SlipStack[]): void {
    for (const child of [...this.slip.children]) {
      child.removeFromParent()
      disposeObject(child)
    }
    for (const s of stacks) {
      const stack = valueStack(s.chips, chipColor)
      stack.position.copy(feltPoint(s.u, s.v, 0.002))
      this.slip.add(stack)
    }
  }

  highlight(cell: FeltCell | null): void {
    this.glow.visible = cell !== null
    if (!cell) return
    this.glow.position.copy(feltPoint(cell.u + cell.w / 2, cell.v + cell.h / 2, 0.004))
    this.glow.scale.set(cell.w * TABLE_W, cell.h * TABLE_D, 1)
  }

  previewDiceBet(bet: { chance_bp: number; over: boolean } | null): void {
    if (this.props?.game === 'dice' && bet) this.props.dice.setBet(bet)
  }

  setBoard(info: BoardInfo): void {
    this.board.set(info)
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
    this.detachPointer()
    this.unsubscribe()
    this.anim.finishAll()
    this.rig.dispose()
    this.mounted.dispose()
  }

  // ---- frame loop -----------------------------------------------------------------------------

  private frame(dt: number, elapsed: number): void {
    if (this.releaseIn !== null) {
      this.releaseIn -= dt
      if (this.releaseIn <= 0) {
        this.releaseIn = null
        if (!this.drawing) this.shotTarget = 0
      }
    }
    const step = this.skipping ? 1 : dt / SHOT_MOVE_S
    this.shot = this.shotTarget > this.shot ? Math.min(this.shotTarget, this.shot + step) : Math.max(this.shotTarget, this.shot - step)
    this.frameCamera(elapsed)
    this.anim.update(dt)
    this.rig.update(dt)
    const props = this.props
    if (props?.game === 'roulette') props.wheel.update(dt)
    if (props?.game === 'dice') props.dice.update(elapsed)
    if (props?.game === 'blackjack' && this.drawing) props.cards.update(this.rig.handPosition(), elapsed)
    if (this.hourglass.visible) {
      // Quarter turns, ticking like a clock: reads as "waiting" more than a smooth spin.
      this.hourglass.rotation.y = Math.floor(elapsed * 3) * (Math.PI / 4)
      this.hourglass.rotation.z = Math.floor(elapsed / 1.5) % 2 === 0 ? 0 : Math.PI
      this.hourglass.position.y = FELT_Y + 0.75 + Math.sin(elapsed * 2) * 0.04
    }
  }

  /** Narrow screens move the eyes back (and up) so the whole felt stays in view; a slow breath of sway. */
  private frameCamera(elapsed: number): void {
    const camera = this.mounted.camera
    const tanHalfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect
    const back = Math.max(0, FRAME_HALF_W / tanHalfH - (EYE.z - LOOK_AT.z) * 0.9)
    camera.position.set(EYE.x + Math.sin(elapsed * 0.3) * 0.02, EYE.y + back * 0.35, EYE.z + back)
    const close = this.props ? SHOTS[this.props.game] : null
    if (!close || this.shot === 0) {
      camera.lookAt(LOOK_AT)
      return
    }
    const t = easeInOut(this.shot) * close.amount
    camera.position.lerp(close.eye, t)
    camera.lookAt(LOOK_AT.clone().lerp(close.look, t))
  }

  // ---- pointer --------------------------------------------------------------------------------

  /** Felt coordinates under a pointer event, or null off the felt. */
  private feltAt(event: PointerEvent | MouseEvent): { u: number; v: number } | null {
    const canvas = this.mounted.renderer.domElement
    const rect = canvas.getBoundingClientRect()
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(pointer, this.mounted.camera)
    const hit = ray.intersectObject(this.table.top, false)[0]
    if (!hit) return null
    return { u: hit.point.x / TABLE_W + 0.5, v: hit.point.z / TABLE_D + 0.5 }
  }

  private attachPointer(): () => void {
    const canvas = this.mounted.renderer.domElement
    const report = (event: PointerEvent | MouseEvent, action: FeltAction): void => {
      const at = this.feltAt(event)
      if (at) this.options.onFelt?.(at.u, at.v, action)
      else if (action === 'move') this.options.onFelt?.(-1, -1, 'leave')
    }
    let press: { x: number; y: number; timer: number; long: boolean } | null = null
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      const timer = window.setTimeout(() => {
        if (!press) return
        press.long = true
        report(event, 'remove')
      }, LONG_PRESS_MS)
      press = { x: event.clientX, y: event.clientY, timer, long: false }
    }
    const onUp = (event: PointerEvent): void => {
      const p = press
      press = null
      if (!p) return
      window.clearTimeout(p.timer)
      if (p.long || Math.hypot(event.clientX - p.x, event.clientY - p.y) > CLICK_SLOP) return
      // A click while a round plays skips its animation instead of placing a chip.
      if (this.running) this.skip()
      else report(event, 'add')
    }
    const onMove = (event: PointerEvent): void => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP) {
        window.clearTimeout(press.timer)
        press = null
      }
      report(event, 'move')
    }
    const onLeave = (): void => this.options.onFelt?.(-1, -1, 'leave')
    const onMenu = (event: MouseEvent): void => {
      event.preventDefault()
      // A touch long press also fires contextmenu: it already took its chip off.
      if (event instanceof PointerEvent && event.pointerType === 'touch') return
      report(event, 'remove')
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('contextmenu', onMenu)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('contextmenu', onMenu)
    }
  }

  // ---- step runner ----------------------------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.queue.length > 0 && !this.disposed) {
      const step = this.queue.shift() as Step
      if (this.drawing && endsDrawing(step)) {
        this.endDrawing(step.kind === 'throw' || step.kind === 'spin')
        this.fastResult = true
      }
      if (step.kind === 'settle' || step.kind === 'void') this.fastResult = false
      const backlog = this.queue.filter((s) => s.kind === 'clear').length
      this.anim.timeScale = this.skipping
        ? SKIP_SPEED
        : this.fastResult
          ? FAST_RESULT_SPEED
          : Math.min(MAX_TIME_SCALE, 1 + backlog * BACKLOG_SPEEDUP)
      if (step.kind !== 'think' && this.hourglass.visible) {
        // The draw came back: the thinking loop ends and the dealer's reason returns.
        this.hourglass.visible = false
        this.rig.say(this.reason)
      }
      try {
        await this.play(step)
      } catch (error) {
        // A broken animation must not freeze the table: report it and go on with the next step.
        console.error('table step failed', step.kind, error)
      }
    }
    // Still waiting for the answer: the steps that bring it stay fast.
    this.fastResult = this.drawing
    this.running = false
    this.skipping = false
    this.anim.timeScale = 1
    if (!this.drawing) this.slip.visible = true
  }

  /** `handOver`: the next step (throw, spin) lands the running cup or ball itself. */
  private endDrawing(handOver: boolean): void {
    this.drawing = false
    this.drawingLabel.set('')
    const props = this.props
    if (props?.game === 'blackjack') props.cards.release()
    if (handOver) return
    if (props?.game === 'dice') props.dice.stopShaking()
    if (props?.game === 'roulette') props.wheel.stopRunning()
  }

  private async play(step: Step): Promise<void> {
    switch (step.kind) {
      case 'clear':
        return this.clear()
      case 'bet':
        return this.placeBet(step.round)
      case 'think':
        this.hourglass.visible = true
        this.rig.say('drawing…')
        return
      case 'double':
        return this.addChips(this.stake.length > 0 ? chipCountOf(this.stake[0]) : 1, 0.26)
      case 'deal':
        return this.deal(step.to, step.index, step.rank)
      case 'reveal':
        if (this.props?.game !== 'blackjack') return
        await Promise.all([this.rig.gesture({ kind: 'flip' }), this.props.cards.reveal(step.rank)])
        return
      case 'spin':
        return this.spin(step.pocket)
      case 'throw':
        return this.throwDice(step.roll)
      case 'settle':
        return this.settle(step.outcome, step.payout, step.wager)
      case 'void':
        return this.voidRound(step.refunded)
    }
  }

  private async clear(): Promise<void> {
    const toDealer = feltPoint(0.5, 0.05, 0.02)
    const props = this.props
    const work: Promise<unknown>[] = [this.sweepStake(toDealer)]
    if (props?.game === 'blackjack') work.push(props.cards.clear(toDealer))
    if (props?.game === 'dice') work.push(props.dice.clear())
    if (props?.game === 'roulette') props.wheel.clear()
    await Promise.all(work)
  }

  private async placeBet(round: RoundView): Promise<void> {
    this.options.onRound?.(round)
    this.rig.say(this.reason)
    const props = this.props
    if (props?.game === 'blackjack') props.cards.newRound(round.id)
    if (props?.game === 'dice' && typeof round.bet === 'object' && 'dice' in round.bet) props.dice.setBet(round.bet.dice)
    this.rouletteBet = typeof round.bet === 'object' && 'roulette' in round.bet ? round.bet.roulette : null
    await this.addChips(chipCount(round.stake), 0)
  }

  /** A stack slides in from the player's edge to the betting spot (offset sideways for a double). */
  private async addChips(count: number, offsetX: number): Promise<void> {
    const stack = chipStack(count, this.stake.length * 2)
    stack.userData.count = count
    stack.position.copy(feltPoint(0.5, 1.05, 0.02))
    this.table.object.add(stack)
    this.stake.push(stack)
    const spot = this.betSpot()
    spot.x += offsetX
    await arcTo(this.anim, stack, spot, 0.45, 0.2)
  }

  private betSpot(): THREE.Vector3 {
    const props = this.props
    if (props?.game === 'blackjack') return feltPoint(BLACKJACK_BET.u, BLACKJACK_BET.v, 0.002)
    if (props?.game === 'roulette' && this.rouletteBet !== null) {
      const cell = betCell(this.rouletteBet)
      return feltPoint(cell.u + cell.w / 2, cell.v + cell.h / 2, 0.002)
    }
    return feltPoint(DICE_BET_SPOT.u, DICE_BET_SPOT.v, 0.002)
  }

  private async deal(to: 'player' | 'dealer', index: number, rank: number | null): Promise<void> {
    if (this.props?.game !== 'blackjack') return
    const cards = this.props.cards
    const spot = cards.spot(to, index)
    const reach = this.rig.gesture({ kind: 'deal', to: spot })
    await this.anim.wait(0.25)
    await Promise.all([reach, cards.deal(to, index, rank, this.rig.handPosition())])
  }

  private async spin(pocket: number): Promise<void> {
    if (this.props?.game !== 'roulette') return
    this.rig.say('no more bets!')
    await Promise.all([this.rig.gesture({ kind: 'spin' }), this.props.wheel.spin(pocket)])
    this.backToSeatSoon()
  }

  /** The draw landed: hold the close-up on the result a moment (real time), then back to the seat. */
  private backToSeatSoon(): void {
    this.releaseIn = this.skipping ? 0 : CLOSE_UP_HOLD_S
  }

  private async throwDice(roll: number): Promise<void> {
    if (this.props?.game !== 'dice') return
    await Promise.all([this.rig.gesture({ kind: 'throw' }), this.props.dice.throw(roll)])
    this.backToSeatSoon()
  }

  private async settle(outcome: 'win' | 'lose' | 'push', payout: string, wager: string): Promise<void> {
    if (outcome === 'lose') {
      this.rig.say('the house wins this one')
      await Promise.all([this.rig.gesture({ kind: 'collect' }), this.sweepStake(feltPoint(0.5, 0.05, 0.02))])
      await this.rig.gesture({ kind: 'celebrate' })
    } else {
      const gain = BigInt(payout) - BigInt(wager)
      this.rig.say(outcome === 'push' ? 'push: stake back' : `you win +${formatUsdc(gain)} tUSDC`)
      await this.rig.gesture({ kind: 'pay' })
      if (outcome === 'win') await this.addChips(chipCount(gain.toString()), -0.26)
      await this.sweepStake(feltPoint(0.5, 1.15, 0.02))
      if (outcome === 'win') await this.rig.gesture({ kind: 'facepalm' })
    }
    await this.anim.wait(RESULT_HOLD_S)
    this.rig.say(this.reason)
    this.shotTarget = 0
  }

  private async voidRound(refunded: boolean): Promise<void> {
    this.rig.say(refunded ? 'stake refunded' : 'the draw failed: your stake is safe')
    await this.rig.gesture({ kind: 'facepalm' })
    if (refunded) {
      await this.rig.gesture({ kind: 'pay' })
      await this.sweepStake(feltPoint(0.5, 1.15, 0.02))
    }
    await this.anim.wait(RESULT_HOLD_S)
    this.rig.say(this.reason)
    this.shotTarget = 0
  }

  /** Every chip on the felt slides to `to` and goes away. */
  private async sweepStake(to: THREE.Vector3): Promise<void> {
    const stacks = this.stake
    this.stake = []
    await Promise.all(stacks.map((stack) => arcTo(this.anim, stack, to, 0.4, 0.1)))
    for (const stack of stacks) {
      stack.removeFromParent()
      disposeObject(stack)
    }
  }

  private propsGroup(props: Props): THREE.Group {
    if (props.game === 'blackjack') return props.cards.group
    return props.game === 'roulette' ? props.wheel.group : props.dice.group
  }
}

function buildProps(game: Game, anim: Animator): Props {
  if (game === 'blackjack') return { game, cards: new Cards(anim) }
  if (game === 'roulette') return { game, wheel: new Roulette(anim) }
  return { game, dice: new Dice(anim) }
}

function chipCountOf(stack: THREE.Group): number {
  return typeof stack.userData.count === 'number' ? stack.userData.count : 1
}
