// Contract between the 3D pieces of the casino (three.js, blocky "voxel" style, original
// characters — nothing copied from Minecraft). Two modules implement it:
//   - characters.ts: the dealers (CharacterRig), built from boxes, animated procedurally;
//   - table/*: the props (cards, roulette wheel, dice) and the director that plays rounds.
import type * as THREE from 'three'
import type { Game, RoundView } from '../near/views'

/** A dealer's mood, from its pool and offer: drives face, posture and idle loop. */
export type Mood = 'happy' | 'neutral' | 'nervous' | 'broke'

/** What a dealer looks like: one per dealer id, chosen to match its temperament. */
export interface DealerLook {
  skin: string
  shirt: string
  vest: string
  hair: string
  /** Optional hat on top of the head. */
  hat: 'none' | 'visor' | 'top_hat' | 'beanie'
  /** Accent color for the nameplate and table trim. */
  accent: string
}

/** Arm gestures the table director asks for; each resolves when the motion ends. */
export type Gesture =
  | { kind: 'deal'; to: THREE.Vector3 } // right hand reaches toward `to` (card destination)
  | { kind: 'flip' } // both hands turn a card in front of the dealer
  | { kind: 'spin' } // flick the roulette ball
  | { kind: 'throw' } // shake and throw dice
  | { kind: 'collect' } // sweep chips back
  | { kind: 'pay' } // push chips to the player
  | { kind: 'celebrate' }
  | { kind: 'facepalm' }

export interface CharacterRig {
  /** Root object; place it behind the table, facing +Z (toward the camera/player). */
  readonly object: THREE.Object3D
  /** World position of the right hand, where a dealt card starts. */
  handPosition(): THREE.Vector3
  setMood(mood: Mood): void
  /** One line in a speech bubble above the head (the dealer's reason); null hides it. */
  say(text: string | null): void
  gesture(g: Gesture): Promise<void>
  /** Advance animations; called every frame with seconds since last frame. */
  update(dt: number): void
  dispose(): void
}

/** Builds a dealer. Implemented in scene/characters.ts. */
export type CreateCharacter = (look: DealerLook, name: string) => CharacterRig

/** One dealer table scene mounted in a DOM element. Implemented in scene/table/TableScene.ts. */
export interface TableSceneApi {
  /** Sets which game the table shows (felt layout and props). */
  setGame(game: Game): void
  /** Plays the transition from `previous` to `next` of the same round (or a new round). The
   *  director queues animations so draws are shown in order, then leaves the final state on the
   *  table. Rounds of other players are played the same way (spectator view). */
  showRound(previous: RoundView | null, next: RoundView): void
  setMood(mood: Mood): void
  say(text: string | null): void
  /** Table closed (bust): curtain down, dealer slumps. */
  setOpen(open: boolean): void
  dispose(): void
}
