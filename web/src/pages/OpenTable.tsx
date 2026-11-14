import { useCallback, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { LoginPrompt } from '../components/LoginPrompt'
import { YourMoney } from '../components/YourMoney'
import { formatUsdc, parseUsdc, tokenSymbol } from '../format'
import { EXPLORER_TX } from '../house'
import { missingSeedHint } from '../money'
import { getFloorState, MIN_TABLE_SEED, openTableProblem, PREPAY_HOURS, SEAT_TRAFFIC_BP, SEATS, type SeatView } from '../near/floor'
import { fullAccessCall } from '../near/session'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePlayer, usePoll } from '../near/usePoll'
import { getTokenBalance, type Game } from '../near/views'
import { dealerLook, LOOK_PRESETS, type LookPreset } from '../scene/looks'

const GAMES: readonly Game[] = ['dice', 'roulette', 'blackjack']

/** The three temperaments of `dealer_rules`; the keeper reprices the table with the one picked. */
const TEMPERAMENTS = [
  { id: 'greedy', text: 'high edge, tight max bets, pays little rent: earns more per round, fewer players' },
  { id: 'promoter', text: 'low edge and boosts to fill the table, pays more rent to stay seen: can bleed on streaks' },
  { id: 'cautious', text: 'protects its money first: cuts max bets when it loses, steady and slow' },
] as const
type Temperament = (typeof TEMPERAMENTS)[number]['id']

const LOOK_LABELS: Record<LookPreset, string> = {
  'gold-visor': 'gold visor',
  'top-hat': 'top hat',
  beanie: 'beanie',
  bare: 'bare head',
}

/** The label of the second call: failing there leaves an open table without a seat. */
const SEAT_STEP = 'bid for a seat'
const BACK_SEAT = SEATS - 1

/** 15_000 bp → "1.5×": a seat's share of the passers-by. */
function trafficText(bp: number): string {
  return `${(bp / 10_000).toFixed(1)}×`
}

type Step =
  | { state: 'idle' }
  | { state: 'busy'; label: string }
  | { state: 'done'; txHash: string }
  | { state: 'error'; label: string; message: string }

export function OpenTable() {
  const { config, walletId, nearAccount } = useNear()
  const loadFloor = useCallback(() => getFloorState(config), [config])
  const floor = usePoll(loadFloor, PAGE_POLL_MS)
  const player = usePlayer()
  const loadWallet = useCallback(() => getTokenBalance(config.rpcUrl, config.tokenContract, walletId), [config, walletId])
  const wallet = usePoll(walletId ? loadWallet : null, PAGE_POLL_MS)
  const [name, setName] = useState('')
  // The id follows the name until the player edits it.
  const [typedId, setTypedId] = useState<string | null>(null)
  const id = typedId ?? tableIdFrom(name)
  const [game, setGame] = useState<Game>('dice')
  const [temperament, setTemperament] = useState<Temperament>('promoter')
  const [look, setLook] = useState<LookPreset>('top-hat')
  const [seed, setSeed] = useState(formatUsdc(MIN_TABLE_SEED))
  const [rent, setRent] = useState('')
  const [step, setStep] = useState<Step>({ state: 'idle' })

  const rentToSit = floor.data ? BigInt(floor.data.floor.outbid_min) : null
  const seedUnits = parseUsdc(seed)
  // Until the player types a rent, offer the price of a seat right now.
  const rentUnits = rent === '' ? rentToSit : parseUsdc(rent)
  const problem =
    rentToSit === null
      ? 'loading the floor…'
      : openTableProblem({
          id,
          name,
          seed: seedUnits,
          rent: rentUnits,
          rentToSit,
          balance: player.data ? BigInt(player.data.balance) : null,
        })
  const busy = step.state === 'busy'
  // Deposit right here while the house cannot cover the seed (the minimum, or more if typed).
  const seedNeeded = seedUnits !== null && seedUnits > MIN_TABLE_SEED ? seedUnits : MIN_TABLE_SEED
  const needsDeposit = player.data !== null && BigInt(player.data.balance) < seedNeeded

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!nearAccount || problem !== null || seedUnits === null || rentUnits === null) return
    const call = (label: string, method: string, args: object) => {
      setStep({ state: 'busy', label })
      return fullAccessCall(nearAccount, config, config.houseContract, method, args, 0n).catch((error: unknown) => {
        throw new StepError(label, error instanceof Error ? error.message : String(error))
      })
    }
    try {
      await call('open the table', 'open_table', { id, name: name.trim(), game, temperament, look, seed_amount: String(seedUnits) })
      const { txHash } = await call(SEAT_STEP, 'bid_for_seat', { dealer_id: id, rent_per_hour: String(rentUnits) })
      setStep({ state: 'done', txHash })
    } catch (error) {
      if (error instanceof StepError) setStep({ state: 'error', label: error.label, message: error.message })
      else throw error
    } finally {
      player.refresh()
      floor.refresh()
    }
  }

  return (
    <>
      <h1>Open your table</h1>
      <p className="muted">
        You are the house. Seed a table from your house balance and you own it, dealer included. Then rent a seat on the
        floor, where the NPC gamblers walk by. Rent goes to the jackpot; a table off the floor takes no bets.
      </p>
      <Checklist
        house={player.data ? BigInt(player.data.balance) : null}
        wallet={wallet.data ? BigInt(wallet.data) : null}
        seats={floor.data?.floor.seats ?? null}
        rentToSit={rentToSit}
        loggedIn={Boolean(walletId)}
      />
      {walletId && nearAccount && needsDeposit ? (
        <YourMoney
          player={player.data}
          onChange={() => {
            player.refresh()
            wallet.refresh()
          }}
        />
      ) : null}
      {floor.data?.mock ? (
        <p className="loss">
          This contract ({config.houseContract}) has no floor yet (no <code>get_floor</code>): opening a table will fail
          until the new contract is deployed.
        </p>
      ) : null}
      {floor.error ? <p className="loss">Could not load the floor: {floor.error}</p> : null}
      {!walletId || !nearAccount ? <LoginPrompt action="open a table" /> : null}
      <form className="panel open-table" onSubmit={(e) => void submit(e)}>
        <label>
          name
          <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Lucky Lou" />
        </label>
        <label>
          table id
          <input
            value={id}
            maxLength={16}
            onChange={(e) => setTypedId(e.target.value.toLowerCase())}
            placeholder="lucky-lou"
            pattern="[a-z0-9-]{2,16}"
          />
          <span className="muted">2–16 characters, a-z 0-9 -; it names your LP token too</span>
        </label>
        <fieldset>
          <legend>game</legend>
          {GAMES.map((g) => (
            <label key={g} className="choice">
              <input type="radio" name="game" checked={game === g} onChange={() => setGame(g)} /> {g}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>temperament</legend>
          {TEMPERAMENTS.map((t) => (
            <label key={t.id} className="choice">
              <input type="radio" name="temperament" checked={temperament === t.id} onChange={() => setTemperament(t.id)} />{' '}
              <strong>{t.id}</strong> <span className="muted">{t.text}</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>look</legend>
          {LOOK_PRESETS.map((preset) => (
            <label key={preset} className="choice">
              <input
                type="radio"
                name="look"
                checked={look === preset}
                onChange={() => setLook(preset)}
              />{' '}
              <span className="swatch" style={{ background: dealerLook('', preset).accent }} /> {LOOK_LABELS[preset]}
            </label>
          ))}
        </fieldset>
        <label>
          seed ({tokenSymbol()})
          <input className="number" inputMode="decimal" value={seed} onChange={(e) => setSeed(e.target.value)} />
          <span className="muted">
            at least {formatUsdc(MIN_TABLE_SEED)}; in your house: {player.data ? formatUsdc(player.data.balance) : '—'}
          </span>
        </label>
        <label>
          rent bid ({tokenSymbol()} per hour)
          <input
            className="number"
            inputMode="decimal"
            value={rent}
            placeholder={rentToSit === null ? '' : formatUsdc(rentToSit)}
            onChange={(e) => setRent(e.target.value)}
          />
          <span className="muted">
            a seat costs {rentToSit === null ? '…' : formatUsdc(rentToSit)}/h now; {String(PREPAY_HOURS)} hours are
            prepaid from the seed
          </span>
        </label>
        {problem ? <p className="muted">{problem}</p> : null}
        <button type="submit" disabled={busy || problem !== null || !nearAccount}>
          Open the table and bid
        </button>
      </form>
      <OpenStatus step={step} id={id} seat={floor.data?.floor.seats.find((s) => s.dealer_id === id) ?? null} />
    </>
  )
}

/** A failed call, tagged with the step it failed at so the player knows whether the table exists. */
class StepError extends Error {
  readonly label: string

  constructor(label: string, message: string) {
    super(message)
    this.label = label
  }
}

/** "Lucky Lou" → "lucky-lou": a valid table id (a-z 0-9 -, at most 16 characters). */
function tableIdFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 16)
    .replace(/^-+|-+$/g, '')
}

/**
 * The seat a bid at `outbid_min` takes, as core `seat_for_bid` picks it: the cheapest empty seat
 * (the back of the room), else the weakest seated table's (lowest rent, most recently seated).
 */
function seatToTake(seats: readonly SeatView[]): SeatView | null {
  const empty = seats.filter((s) => s.dealer_id === null)
  if (empty.length > 0) return empty.reduce((a, b) => (BigInt(b.min_rent) <= BigInt(a.min_rent) ? b : a))
  let weakest: SeatView | null = null
  for (const s of seats) {
    if (weakest === null) {
      weakest = s
      continue
    }
    const [rent, low] = [BigInt(s.rent_per_hour), BigInt(weakest.rent_per_hour)]
    if (rent < low || (rent === low && s.seated_at > weakest.seated_at)) weakest = s
  }
  return weakest
}

interface ChecklistProps {
  house: bigint | null
  wallet: bigint | null
  seats: readonly SeatView[] | null
  rentToSit: bigint | null
  loggedIn: boolean
}

/** What the player has and what a table on the floor takes: the seed, then a seat. */
function Checklist({ house, wallet, seats, rentToSit, loggedIn }: ChecklistProps) {
  const seat = seats ? seatToTake(seats) : null
  const symbol = tokenSymbol()
  const seeded = house !== null && house >= MIN_TABLE_SEED
  const hint = missingSeedHint({ house, wallet, minSeed: MIN_TABLE_SEED, loggedIn, symbol })
  return (
    <section className="panel">
      <h2>What it takes</h2>
      <p>
        You have: in the house <span className="money">{house === null ? '—' : formatUsdc(house)} {symbol}</span> · in your
        wallet <span className="money">{wallet === null ? '—' : formatUsdc(wallet)} {symbol}</span>
      </p>
      <ol>
        <li className={seeded ? 'win' : undefined}>
          {seeded ? '✓ ' : ''}A seed of at least {formatUsdc(MIN_TABLE_SEED, 0)} {symbol} in the house.{' '}
          {hint ? <span className="muted">{hint}</span> : null}
        </li>
        <li>
          A seat: {rentToSit === null || seat === null ? '…' : <SeatPrice seat={seat} rent={rentToSit} />}{' '}
          <span className="muted">
            {String(PREPAY_HOURS)} hours of rent are prepaid from the seed, then the pool pays it by the second.
          </span>
        </li>
      </ol>
      <p className="muted">
        The goal: climb to seat 1, by the entrance, where {trafficText(SEAT_TRAFFIC_BP[0])} the passers-by walk past. Buy a
        better seat when its holder lists it (<Link to="/seats">Seats</Link>), or outbid your way in.
      </p>
    </section>
  )
}

function SeatPrice({ seat, rent }: { seat: SeatView; rent: bigint }) {
  const price = (
    <span className="money">
      {formatUsdc(rent)} {tokenSymbol()}/h
    </span>
  )
  const where = `${trafficText(seat.traffic_bp)} passers-by${seat.seat === BACK_SEAT ? ', the back of the room' : ''}`
  return seat.dealer_id === null ? (
    <>
      the cheapest is seat {seat.seat + 1} ({where}) at its minimum rent, {price}.
    </>
  ) : (
    <>
      the floor is full: outbid the cheapest table by 10 % ({price}) and take its seat {seat.seat + 1} ({where}).
    </>
  )
}

function OpenStatus({ step, id, seat }: { step: Step; id: string; seat: SeatView | null }) {
  switch (step.state) {
    case 'idle':
      return null
    case 'busy':
      return <p className="muted">{step.label}: confirm in the Privy window…</p>
    case 'done':
      return (
        <section className="panel">
          <p className="win">
            Table open and seat bid sent ·{' '}
            <a href={`${EXPLORER_TX}${step.txHash}`} target="_blank" rel="noreferrer">
              view tx
            </a>
          </p>
          <p>
            {seat ? `You hold seat ${seat.seat + 1} (${trafficText(seat.traffic_bp)} passers-by). ` : ''}
            Your customers come in from the entrance: set your edge, max bet and boosts to win them from your rivals, and
            climb to seat 1.
          </p>
          <p>
            <Link className="button" to="/my-table">
              Run it from My table
            </Link>{' '}
            <Link className="button ghost" to={`/table/${id}`}>
              See your table
            </Link>
          </p>
        </section>
      )
    case 'error':
      return (
        <section className="panel">
          <p className="loss">
            Could not {step.label}: {step.message}
          </p>
          {step.label === SEAT_STEP ? (
            <p>
              Your table is open but has no seat yet, so no customer can sit. Take one from <Link to="/my-table">My table</Link>{' '}
              (seat bid): the cheapest is the back seat, {trafficText(SEAT_TRAFFIC_BP[BACK_SEAT])} passers-by.
            </p>
          ) : null}
        </section>
      )
  }
}
