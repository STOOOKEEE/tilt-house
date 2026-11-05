/**
 * A provably fair session at one table (docs/sessions.md), from the browser: start it on the
 * session server, open it on chain with one relayed game-key call (no popup), then instant rounds, each
 * signed state checked before it is shown. The last valid state is kept in localStorage: it is the
 * player's proof for `force_close` if the server ever stops answering.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JsonRpcProvider } from 'near-api-js'
import type { Config } from '../config'
import { gameKeyCall } from './session'
import {
  checkNextState,
  NOT_OPEN_YET,
  randomClientSeed,
  SessionError,
  sessionClient,
  verifySession,
  verifyTicket,
  type BjAction,
  type BjSession,
  type CompactRound,
  type SessionTicket,
  type SignedState,
  type VerifyResult,
} from './session-client'
import type { Bet, DealerView } from './views'

/**
 * Polls in a row that must miss the session on chain before it counts as closed elsewhere (the
 * server closes idle sessions): covers the poll that still predates `open_session`.
 */
const CLOSED_AFTER_MISSES = 3
/** `open_session` lands in a block or two; the server answers 409 until it sees it. */
const OPEN_RETRIES = 20
const OPEN_RETRY_MS = 1_000

export type SessionPhase = 'idle' | 'starting' | 'opening' | 'playing' | 'closing' | 'closed'

export interface StoredSession {
  sessionUrl: string
  session_id: string
  token: string
  server_public_key: string
  ticket: SessionTicket
  ticket_signature: string
  /** The last state whose signature, chain and balance checked out. */
  state: SignedState
  rounds: CompactRound[]
  opened: boolean
  server_seed: string | null
}

export interface SessionApi {
  phase: SessionPhase
  session: StoredSession | null
  /** A blackjack hand in play (not yet a round). */
  hand: BjSession | null
  /** The round just played, for the table animation; `ordinal` changes with every new one. */
  last: { round: CompactRound; ordinal: number } | null
  busy: boolean
  error: string
  /** Set when the server sent a state that failed its checks: stop playing, keep the last good one. */
  broken: string
  verified: VerifyResult | null
  start(lock: bigint): Promise<void>
  bet(bet: Bet, stake: bigint): Promise<void>
  act(action: BjAction): Promise<void>
  close(): Promise<void>
  verify(): void
  forceClose(): Promise<void>
  forget(): void
}

function storageKey(accountId: string, contract: string): string {
  return `tilt-house:session:${accountId}:${contract}`
}

function load(accountId: string, contract: string): StoredSession | null {
  const raw = localStorage.getItem(storageKey(accountId, contract))
  if (!raw) return null
  try {
    // Written by this module only; a corrupt entry is dropped rather than trusted.
    return JSON.parse(raw) as StoredSession
  } catch {
    return null
  }
}

/** Why the server's ticket must not be signed, or null. Protects the player before any money moves. */
export function ticketProblem(
  ticket: SessionTicket,
  expected: { player: string; dealer: DealerView; lock: bigint; clientSeed: string },
): string | null {
  if (ticket.player !== expected.player) return 'ticket for another player'
  if (ticket.dealer_id !== expected.dealer.id || ticket.game !== expected.dealer.game) return 'ticket for another table'
  if (ticket.lock !== expected.lock.toString()) return 'ticket locks another amount'
  if (ticket.client_seed !== expected.clientSeed) return 'ticket ignores your client seed'
  if (ticket.rake_bp > expected.dealer.rake_bp) return `ticket rake ${ticket.rake_bp} bp is above the table's ${expected.dealer.rake_bp} bp`
  return null
}

/**
 * `ready`: the browser game key exists. Opening and force-closing are signed with it (no popup):
 * the money only moves between the player's floor balance and the session escrow.
 */
export function useSession(
  config: Config,
  provider: JsonRpcProvider,
  walletId: string,
  ready: boolean,
  dealer: DealerView | undefined,
  /** The latest `get_player` poll (a new object per poll), null while unknown. */
  chain: { open_session: string | null } | null,
): SessionApi {
  const [session, setSession] = useState<StoredSession | null>(null)
  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [hand, setHand] = useState<BjSession | null>(null)
  const [last, setLast] = useState<SessionApi['last']>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [broken, setBroken] = useState('')
  const [verified, setVerified] = useState<VerifyResult | null>(null)

  // Resume a session this browser holds for this account (after a reload).
  useEffect(() => {
    if (!walletId) return
    const stored = load(walletId, config.houseContract)
    setSession(stored)
    setPhase(stored === null ? 'idle' : stored.server_seed !== null ? 'closed' : stored.opened ? 'playing' : 'idle')
  }, [walletId, config.houseContract])

  const save = useCallback(
    (next: StoredSession | null) => {
      setSession(next)
      if (next === null) localStorage.removeItem(storageKey(walletId, config.houseContract))
      else localStorage.setItem(storageKey(walletId, config.houseContract), JSON.stringify(next))
    },
    [walletId, config.houseContract],
  )

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const client = sessionClient(config.sessionUrl)

  const start = (lock: bigint) =>
    run(async () => {
      if (!config.sessionUrl) throw new Error('no session server configured (VITE_SESSION_URL)')
      if (!walletId || !dealer) throw new Error('log in first')
      if (!ready) throw new Error('your game key is still being set up')
      setPhase('starting')
      setVerified(null)
      setBroken('')
      const clientSeed = randomClientSeed()
      try {
        const started = await client.start({ player: walletId, dealer_id: dealer.id, lock, client_seed: clientSeed })
        if (!verifyTicket(started.server_public_key, started.ticket, started.ticket_signature)) {
          throw new Error('the server ticket signature does not verify')
        }
        const problem = ticketProblem(started.ticket, { player: walletId, dealer, lock, clientSeed })
        if (problem) throw new Error(problem)
        if (started.state.nonce !== 0 || started.state.chain !== started.ticket.server_seed_hash || started.state.balance !== started.ticket.lock) {
          throw new Error('the server start state does not match its ticket')
        }
        const stored: StoredSession = {
          sessionUrl: config.sessionUrl,
          session_id: started.session_id,
          token: started.token,
          server_public_key: started.server_public_key,
          ticket: started.ticket,
          ticket_signature: started.ticket_signature,
          state: started.state,
          rounds: [],
          opened: false,
          server_seed: null,
        }
        save(stored)
        setPhase('opening')
        await gameKeyCall(walletId, provider, config, 'open_session', {
          ticket: started.ticket,
          server_sig: started.ticket_signature,
        })
        save({ ...stored, opened: true })
        setPhase('playing')
      } catch (e) {
        setPhase('idle')
        throw e
      }
    })

  /** Sends one move, retrying while the server has not seen the open transaction yet. */
  const send = async (s: StoredSession, move: Parameters<typeof client.play>[3]) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.play(s.session_id, s.token, s.state.nonce + 1, move)
      } catch (e) {
        if (!(e instanceof SessionError && e.status === NOT_OPEN_YET) || attempt >= OPEN_RETRIES) throw e
        // ES2022 lib has no Promise.withResolvers.
        await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS))
      }
    }
  }

  const move = (payload: Parameters<typeof client.play>[3]) =>
    run(async () => {
      if (!session || phase !== 'playing' || broken) throw new Error('no session in play')
      const reply = await send(session, payload)
      if (!reply.done || reply.round === null) {
        // A blackjack hand in progress: no new state yet, the cards come from the server alone.
        if (reply.state.nonce !== session.state.nonce) {
          setBroken('the server moved the state without a finished round')
          return
        }
        setHand(reply.hand)
        return
      }
      const round = reply.round
      const problem = checkNextState(session.server_public_key, session.state, round, reply.state)
      if (problem) {
        setBroken(`round ${round.nonce} refused: ${problem}`)
        return
      }
      setHand(null)
      save({ ...session, state: reply.state, rounds: [...session.rounds, round] })
      setLast((prev) => ({ round, ordinal: (prev?.ordinal ?? 0) + 1 }))
    })

  const close = () =>
    run(async () => {
      if (!session) throw new Error('no session')
      setPhase('closing')
      try {
        const closed = await client.close(session.session_id, session.token)
        // The server's last state must be ours: a later one would be rounds we never saw.
        if (closed.state.nonce !== session.state.nonce || closed.state.chain !== session.state.chain) {
          setBroken('the server closed on a state other than your last one')
        }
        const next = { ...session, server_seed: closed.server_seed }
        save(next)
        setVerified(verifySession(closed.server_seed, session.ticket, session.rounds, session.state))
        setPhase('closed')
      } catch (e) {
        setPhase('playing')
        throw e
      }
    })

  // Closed without us (idle timeout, another tab): show the verify view instead of failing on the
  // next round, with the seed the server revealed when it closed.
  const misses = useRef(0)
  const sessionId = session?.session_id
  const stillPlaying = phase === 'playing' && session?.opened === true && !busy
  useEffect(() => {
    if (!stillPlaying || chain === null || sessionId === undefined) return
    misses.current = chain.open_session === sessionId ? 0 : misses.current + 1
    if (misses.current < CLOSED_AFTER_MISSES || !session) return
    misses.current = 0
    setPhase('closed')
    setHand(null)
    void client.revealedSeed(sessionId).then(
      (seed) => {
        if (seed === null) return
        save({ ...session, server_seed: seed })
        setVerified(verifySession(seed, session.ticket, session.rounds, session.state))
      },
      () => setError('the session was closed on chain; its seed could not be fetched yet'),
    )
    // Runs per chain observation; `session` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, stillPlaying, sessionId])

  const verify = () => {
    if (session?.server_seed) setVerified(verifySession(session.server_seed, session.ticket, session.rounds, session.state))
  }

  const forceClose = () =>
    run(async () => {
      if (!session || !walletId) throw new Error('no session')
      const { signature, ...state } = session.state
      await gameKeyCall(walletId, provider, config, 'force_close', {
        session_id: session.session_id,
        state,
        server_sig: signature,
      })
      setPhase('closed')
    })

  const forget = () => {
    save(null)
    setPhase('idle')
    setHand(null)
    setVerified(null)
    setBroken('')
  }

  return {
    phase,
    session,
    hand,
    last,
    busy,
    error,
    broken,
    verified,
    start,
    bet: (bet, stake) => move({ bet, stake }),
    act: (action) => move({ action }),
    close,
    verify,
    forceClose,
    forget,
  }
}
