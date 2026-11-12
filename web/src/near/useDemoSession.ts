/**
 * Dev only (`?demo=1` on a table page): a session played entirely in the browser with a local
 * seed and the same rules as the session server (session-client replay), so the table can be
 * tried and its animations checked without a login, a server or the chain. Never signs or
 * moves money; states carry no server signature.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { useRef, useState } from 'react'
import {
  chainStep,
  playHand,
  replayRound,
  roundWager,
  verifySession,
  type BjAction,
  type BjSession,
  type CompactRound,
  type SessionTicket,
} from './session-client'
import type { SessionApi, SessionPhase, StoredSession } from './useSession'
import type { Bet, DealerView } from './views'

/** About what the real server answers in. */
const LATENCY_MS = 120
const DEMO_PLAYER = 'demo.testnet'

const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function useDemoSession(dealer: DealerView | undefined): SessionApi {
  const seed = useRef(crypto.getRandomValues(new Uint8Array(32)))
  const [session, setSession] = useState<StoredSession | null>(null)
  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [hand, setHand] = useState<BjSession | null>(null)
  const [last, setLast] = useState<SessionApi['last']>(null)
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState<SessionApi['verified']>(null)

  const finish = (s: StoredSession, round: CompactRound): void => {
    const balance = BigInt(s.state.balance) - roundWager(round) + BigInt(round.payout)
    const state = { ...s.state, nonce: round.nonce, balance: balance.toString(), chain: chainStep(s.state.chain, round) }
    setSession({ ...s, state, rounds: [...s.rounds, round] })
    setHand(null)
    setLast((prev) => ({ round, ordinal: (prev?.ordinal ?? 0) + 1 }))
  }

  /** Blackjack: the hand after `actions`; finished hands become a round. */
  const step = (s: StoredSession, nonce: number, stake: bigint, actions: BjAction[]): void => {
    const state = playHand(seed.current, s.ticket.client_seed, nonce, actions)
    if (state.done) finish(s, replayRound(seed.current, s.ticket, nonce, 'blackjack', stake, actions))
    else setHand({ nonce, stake: stake.toString(), rake_bp: s.ticket.rake_bp, actions, state })
  }

  const slow = async (task: () => void): Promise<void> => {
    setBusy(true)
    await later(LATENCY_MS)
    task()
    setBusy(false)
  }

  return {
    phase,
    session,
    hand,
    last,
    busy,
    error: '',
    broken: '',
    verified,
    async start(lock) {
      if (!dealer) return
      const ticket: SessionTicket = {
        session_id: 'demo',
        player: DEMO_PLAYER,
        dealer_id: dealer.id,
        game: dealer.game,
        lock: lock.toString(),
        server_seed_hash: bytesToHex(sha256(seed.current)),
        client_seed: 'demo',
        rake_bp: dealer.rake_bp,
        max_bet: dealer.max_bet,
        max_win: (lock * 10n).toString(),
        expires_at: 0,
      }
      const state = { session_id: 'demo', nonce: 0, balance: ticket.lock, chain: ticket.server_seed_hash, signature: '' }
      setPhase('opening')
      await slow(() => {
        setSession({ sessionUrl: '', session_id: 'demo', token: '', server_public_key: '', ticket, ticket_signature: '', state, rounds: [], opened: true, server_seed: null })
        setPhase('playing')
      })
    },
    async bet(bet: Bet, stake: bigint) {
      const s = session
      if (!s) return
      const nonce = s.state.nonce + 1
      await slow(() => (bet === 'blackjack' ? step(s, nonce, stake, []) : finish(s, replayRound(seed.current, s.ticket, nonce, bet, stake, []))))
    },
    async act(action) {
      const s = session
      if (!s || !hand) return
      await slow(() => step(s, hand.nonce, BigInt(hand.stake), [...hand.actions, action]))
    },
    async close() {
      const s = session
      if (!s) return
      const server_seed = bytesToHex(seed.current)
      setSession({ ...s, server_seed })
      setVerified(verifySession(server_seed, s.ticket, s.rounds, s.state))
      setPhase('closed')
    },
    verify() {
      if (session?.server_seed) setVerified(verifySession(session.server_seed, session.ticket, session.rounds, session.state))
    },
    async forceClose() {
      setPhase('closed')
    },
    forget() {
      seed.current = crypto.getRandomValues(new Uint8Array(32))
      setSession(null)
      setHand(null)
      setVerified(null)
      setPhase('idle')
    },
    // The poker practice table runs its own local engine (poker-demo.ts), not this session.
    adoptRound() {},
  }
}
