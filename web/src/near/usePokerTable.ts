/**
 * One poker table from the browser: the live table (docs/poker-api.md) through the player's
 * ordinary session at that dealer, or the local practice table (`?demo=1`). Both give the page
 * the same `PokerTableApi`; every finished hand is replayed from its revealed seed
 * (`verifyHand`) before the page shows "deck verified".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Config } from '../config'
import { pokerClient, roundMatchesHand, verifyHand, type HandCheck, type TableState } from './poker-client'
import { PokerDemo } from './poker-demo'
import type { PokerAction } from './poker-rules'
import { randomClientSeed, SessionError } from './session-client'
import type { SessionApi } from './useSession'

/** Same as a session round: the server answers 409 until `open_session` is final on chain. */
const JOIN_RETRIES = 20
const JOIN_RETRY_MS = 1_000
/** After a failed poll, wait this long before the next one. */
const POLL_BACKOFF_MS = 2_000
const DEMO_TICK_MS = 150

export interface HandProof {
  hand: number
  check: HandCheck
}

export interface PokerTableApi {
  table: TableState | null
  error: string
  busy: boolean
  /** What the sit-down is waiting for ("opening your session on chain…"), '' when nothing. */
  progress: string
  /** Opens a session for `buyIn` (live) and takes a seat. */
  sit(buyIn: bigint): Promise<void>
  act(action: PokerAction): Promise<void>
  leave(): Promise<void>
  /** The replay of the last finished hand. */
  proof: HandProof | null
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Replays each newly finished hand once, with the player's own seed when it was dealt in. */
function useProof(table: TableState | null, seedFor: (hand: number) => string | undefined): HandProof | null {
  const [proof, setProof] = useState<HandProof | null>(null)
  const last = table?.last_hand ?? null
  const sessionId = table?.you?.session_id
  useEffect(() => {
    if (!last || proof?.hand === last.number) return
    const mineAt = last.players.find((p) => p.session_id === sessionId)
    const clientSeed = seedFor(last.number)
    const mine = mineAt && clientSeed !== undefined ? { seat: mineAt.seat, clientSeed } : null
    setProof({ hand: last.number, check: verifyHand(last, mine) })
    // One replay per finished hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.number])
  return proof
}

export function usePokerDemo(): PokerTableApi {
  const engine = useRef<PokerDemo | null>(null)
  engine.current ??= new PokerDemo()
  const seeds = useRef(new Map<number, string>())
  const [table, setTable] = useState<TableState | null>(() => engine.current?.state() ?? null)
  const [error, setError] = useState('')

  const publish = useCallback(() => {
    const demo = engine.current
    if (!demo) return
    const next = demo.state()
    if (next.hand?.phase === 'seeding' && demo.mySeed) seeds.current.set(next.hand.number, demo.mySeed)
    setTable(next)
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      if (engine.current?.tick(Date.now())) publish()
    }, DEMO_TICK_MS)
    return () => clearInterval(timer)
  }, [publish])

  const run = async (task: (demo: PokerDemo) => void) => {
    setError('')
    try {
      if (engine.current) task(engine.current)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    publish()
  }

  const proof = useProof(table, (hand) => seeds.current.get(hand))
  return {
    table,
    error,
    busy: false,
    progress: '',
    sit: (buyIn) => run((demo) => demo.join(buyIn, Date.now())),
    act: (action) => run((demo) => demo.act(action, Date.now())),
    leave: () => run((demo) => void demo.leave(Date.now())),
    proof,
  }
}

export function usePokerLive(config: Config, tableId: string, session: SessionApi): PokerTableApi {
  const [table, setTable] = useState<TableState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [wantSeat, setWantSeat] = useState(false)
  const seeds = useRef(new Map<number, string>())
  const client = pokerClient(config.sessionUrl)
  const s = session.session
  const mine = s !== null && s.ticket.dealer_id === tableId && s.server_seed === null ? s : null
  const token = mine && session.phase === 'playing' ? mine.token : null

  // Long poll: each answer comes back as soon as the table changes (or after 10 s).
  useEffect(() => {
    if (!config.sessionUrl || !tableId) return
    const abort = new AbortController()
    let since: number | null = null
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          const next = await client.state(tableId, token, since, abort.signal)
          since = next.version
          setTable(next)
        } catch (e) {
          if (abort.signal.aborted) return
          setError(e instanceof Error ? e.message : String(e))
          await later(POLL_BACKOFF_MS)
        }
      }
    })()
    return () => abort.abort()
    // The client is rebuilt each render from the same URL; the poll restarts only for a new token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.sessionUrl, tableId, token])

  const run = async (task: () => Promise<void>) => {
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

  // Once the session is open on chain, take the seat (the server needs a block or two to see it).
  const you = table?.you ?? null
  useEffect(() => {
    if (!wantSeat || !token || !mine || you) return
    setWantSeat(false)
    void run(async () => {
      setProgress('taking your seat…')
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            await client.join(tableId, token, mine.session_id, null)
            return
          } catch (e) {
            if (!(e instanceof SessionError && e.status === 409) || attempt >= JOIN_RETRIES) throw e
            await later(JOIN_RETRY_MS)
          }
        }
      } finally {
        setProgress('')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantSeat, token, you])

  // The player's own seed for each hand: drawn here, so the server cannot choose it.
  const hand = table?.hand ?? null
  useEffect(() => {
    if (!token || you?.seat == null || !hand || hand.phase !== 'seeding') return
    if (!hand.seats.includes(you.seat) || hand.seeds_in.includes(you.seat) || seeds.current.has(hand.number)) return
    const clientSeed = randomClientSeed()
    seeds.current.set(hand.number, clientSeed)
    client.seed(tableId, token, hand.number, clientSeed).catch((e: unknown) => {
      // Too late or refused: the deck then uses the default seed, which the proof will show.
      seeds.current.delete(hand.number)
      setError(e instanceof Error ? e.message : String(e))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, you?.seat, hand?.number, hand?.phase])

  // Each recorded hand advances the session: its round must be this seat's line of the replayed hand.
  const lastHand = table?.last_hand ?? null
  const round = you?.last_round ?? null
  const state = you?.state ?? null
  useEffect(() => {
    if (!round || !state || !lastHand || you?.seat == null || !mine || round.nonce !== mine.state.nonce + 1) return
    const ofHand = round.bet !== 'blackjack' && 'poker' in round.bet ? round.bet.poker.hand : null
    if (ofHand !== lastHand.number) return
    if (!verifyHand(lastHand).ok || !roundMatchesHand(round, lastHand, you.seat)) {
      setError(`hand ${lastHand.number}: your session round does not match the replayed hand`)
      return
    }
    session.adoptRound(round, state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.nonce, state?.nonce, lastHand?.number])

  const proof = useProof(table, (n) => seeds.current.get(n))
  return {
    table,
    error: error || session.error || session.broken,
    busy: busy || session.busy,
    progress: progress || (session.phase === 'starting' ? 'starting your session…' : session.phase === 'opening' ? 'opening your session on chain…' : ''),
    async sit(buyIn) {
      setWantSeat(true)
      if (!mine || session.phase !== 'playing') await session.start(buyIn)
    },
    act: (action) =>
      run(async () => {
        if (!token || !hand) throw new Error('not seated')
        setTable(await client.act(tableId, token, hand.number, action))
      }),
    leave: () =>
      run(async () => {
        if (!token) throw new Error('not seated')
        await client.leave(tableId, token)
      }),
    proof,
  }
}
