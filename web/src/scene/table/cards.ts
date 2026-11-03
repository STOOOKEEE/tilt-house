// Blackjack props: thin box cards with canvas faces (rank + suit) and a patterned back, the
// player's and dealer's card rows, hand totals, and the felt print.
import * as THREE from 'three'
import { cardLabel, handTotal } from '../../house'
import { disposeObject } from '../renderer'
import { pixelTexture } from '../voxel'
import { type Animator, arcTo, feltPoint, PALETTE, textSprite, type TextSprite } from './props'

const CARD_W = 0.34
const CARD_D = 0.48
const CARD_T = 0.012
const CARD_GAP = 0.27
/** Felt coordinates (u, v) of each row's first card. */
const PLAYER_ROW = { u: 0.45, v: 0.64 }
const DEALER_ROW = { u: 0.45, v: 0.24 }
/** Felt point of the betting circle (chips). */
export const BLACKJACK_BET = { u: 0.5, v: 0.84 }
const SUITS = ['♠', '♥', '♦', '♣'] as const
const RED_SUITS: Record<string, true> = { '♥': true, '♦': true }

/** The contract draws ranks only (infinite shoe); the suit is decoration, stable for a given card. */
export function suitFor(roundId: number, side: 'player' | 'dealer', index: number, rank: number): string {
  return SUITS[(roundId * 7 + index * 3 + rank + (side === 'dealer' ? 1 : 0)) % SUITS.length]
}

function faceTexture(rank: number, suit: string): THREE.Texture {
  const label = cardLabel(rank)
  const color = RED_SUITS[suit] ? '#c8283c' : '#16161a'
  return pixelTexture(
    136,
    192,
    (ctx, w, h) => {
      ctx.fillStyle = '#fbf7ec'
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = '#d9cfb8'
      ctx.lineWidth = 6
      ctx.strokeRect(3, 3, w - 6, h - 6)
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = 'bold 40px "JetBrains Mono", ui-monospace, monospace'
      ctx.fillText(label, 30, 32)
      ctx.font = '30px serif'
      ctx.fillText(suit, 30, 66)
      ctx.font = '84px serif'
      ctx.fillText(suit, w / 2, h / 2 + 12)
      ctx.save()
      ctx.translate(w - 30, h - 32)
      ctx.rotate(Math.PI)
      ctx.font = 'bold 40px "JetBrains Mono", ui-monospace, monospace'
      ctx.fillText(label, 0, 0)
      ctx.restore()
    },
    { smooth: true },
  ).texture
}

/** Pink and gold checks: the house back, the same on every card. */
function backTexture(): THREE.Texture {
  return pixelTexture(17, 24, (ctx, w, h) => {
    ctx.fillStyle = PALETTE.cream
    ctx.fillRect(0, 0, w, h)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? PALETTE.pink : '#a8326e'
        ctx.fillRect(x, y, 1, 1)
      }
    }
    ctx.fillStyle = PALETTE.gold
    ctx.fillRect(7, 10, 3, 4)
  }).texture
}

/** A card lying on the felt; face up when rotation.z = 0, face down at π. */
function cardMesh(face: THREE.Texture | null): THREE.Mesh {
  const edge = new THREE.MeshLambertMaterial({ color: '#efe8d6' })
  const top = face ? new THREE.MeshLambertMaterial({ map: face }) : edge.clone()
  const back = new THREE.MeshLambertMaterial({ map: backTexture() })
  // BoxGeometry face order: +X, -X, +Y (face), -Y (back), +Z, -Z.
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, CARD_T, CARD_D), [edge, edge.clone(), top, back, edge.clone(), edge.clone()])
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function setFace(card: THREE.Mesh, face: THREE.Texture): void {
  const materials = card.material as THREE.Material[]
  materials[2].dispose()
  materials[2] = new THREE.MeshLambertMaterial({ map: face })
}

export class Cards {
  readonly group = new THREE.Group()
  private player: THREE.Mesh[] = []
  private dealer: THREE.Mesh[] = []
  private playerRanks: number[] = []
  private dealerRanks: number[] = []
  private roundId = 0
  private readonly playerTotal: TextSprite = textSprite(0.16, 5)
  private readonly dealerTotal: TextSprite = textSprite(0.16, 5)

  private readonly anim: Animator

  constructor(anim: Animator) {
    this.anim = anim
    this.playerTotal.sprite.position.copy(feltPoint(PLAYER_ROW.u - 0.12, PLAYER_ROW.v, 0.12))
    this.dealerTotal.sprite.position.copy(feltPoint(DEALER_ROW.u - 0.12, DEALER_ROW.v, 0.12))
    this.group.add(this.playerTotal.sprite, this.dealerTotal.sprite)
  }

  /** Where card `index` of `side` lands: rows fan to the right, each card a hair above the last. */
  spot(side: 'player' | 'dealer', index: number): THREE.Vector3 {
    const row = side === 'player' ? PLAYER_ROW : DEALER_ROW
    const at = feltPoint(row.u, row.v, CARD_T / 2 + index * 0.004)
    at.x += index * CARD_GAP
    return at
  }

  newRound(roundId: number): void {
    this.roundId = roundId
  }

  /** Flies a card from `from` (the dealer's hand) to its spot; `rank` null lands face down. */
  async deal(side: 'player' | 'dealer', index: number, rank: number | null, from: THREE.Vector3): Promise<void> {
    const card = cardMesh(rank === null ? null : faceTexture(rank, suitFor(this.roundId, side, index, rank)))
    card.position.copy(from)
    card.rotation.z = Math.PI
    this.group.add(card)
    ;(side === 'player' ? this.player : this.dealer)[index] = card
    const flip = rank !== null
    await Promise.all([
      arcTo(this.anim, card, this.spot(side, index), 0.45, 0.25),
      this.anim.tween(0.45, (t) => {
        card.rotation.z = flip ? Math.PI * (1 - t) : Math.PI
        card.rotation.y = (1 - t) * 0.6
      }),
    ])
    if (rank !== null) this.addRank(side, rank)
  }

  /** Turns the face-down dealer card, now drawn as `rank`. */
  async reveal(rank: number): Promise<void> {
    const card = this.dealer[1]
    if (!card) return
    setFace(card, faceTexture(rank, suitFor(this.roundId, 'dealer', 1, rank)))
    const base = card.position.y
    await this.anim.tween(0.4, (t) => {
      card.rotation.z = Math.PI * (1 - t)
      card.position.y = base + Math.sin(Math.PI * t) * 0.18
    })
    this.addRank('dealer', rank)
  }

  /** Sweeps every card back toward the dealer and drops them. */
  async clear(to: THREE.Vector3): Promise<void> {
    const cards = [...this.player, ...this.dealer]
    this.player = []
    this.dealer = []
    this.playerRanks = []
    this.dealerRanks = []
    this.playerTotal.set('')
    this.dealerTotal.set('')
    if (cards.length > 0) await Promise.all(cards.map((card) => arcTo(this.anim, card, to, 0.35, 0.1)))
    for (const card of cards) {
      card.removeFromParent()
      disposeObject(card)
    }
  }

  private addRank(side: 'player' | 'dealer', rank: number): void {
    const ranks = side === 'player' ? this.playerRanks : this.dealerRanks
    ranks.push(rank)
    const { total, soft } = handTotal(ranks)
    const color = total > 21 ? PALETTE.red : total === 21 ? PALETTE.gold : PALETTE.cream
    ;(side === 'player' ? this.playerTotal : this.dealerTotal).set(soft ? `soft ${total}` : String(total), color)
  }
}

/** Felt print: the house rules arc and outlined card spots. */
export function paintBlackjackFelt(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.strokeStyle = 'rgba(243,234,210,0.55)'
  ctx.fillStyle = 'rgba(243,234,210,0.75)'
  ctx.lineWidth = 3
  const cardW = (CARD_W / 4.2) * w
  const cardH = (CARD_D / 2.4) * h
  for (const row of [PLAYER_ROW, DEALER_ROW]) {
    ctx.strokeRect(row.u * w - cardW / 2 - 6, row.v * h - cardH / 2 - 6, cardW + 12, cardH + 12)
  }
  ctx.textAlign = 'center'
  ctx.font = 'bold 30px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillStyle = PALETTE.gold
  ctx.fillText('BLACKJACK PAYS 3 TO 2', w / 2, h * 0.42)
  ctx.font = '22px "JetBrains Mono", ui-monospace, monospace'
  ctx.fillStyle = 'rgba(243,234,210,0.7)'
  ctx.fillText('DEALER STANDS ON ALL 17s · INFINITE SHOE · VRF DRAWN', w / 2, h * 0.47)
  ctx.beginPath()
  ctx.arc(BLACKJACK_BET.u * w, BLACKJACK_BET.v * h, 46, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillText('BET', BLACKJACK_BET.u * w, BLACKJACK_BET.v * h + 8)
}
