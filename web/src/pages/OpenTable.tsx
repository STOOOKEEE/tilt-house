import { useCallback, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { LoginPrompt } from '../components/LoginPrompt'
import { formatUsdc, parseUsdc, tokenSymbol } from '../format'
import { EXPLORER_TX } from '../house'
import { getFloorState, MIN_TABLE_SEED, openTableProblem, PREPAY_HOURS } from '../near/floor'
import { fullAccessCall } from '../near/session'
import { useNear } from '../near/useNear'
import { PAGE_POLL_MS, usePlayer, usePoll } from '../near/usePoll'
import type { Game } from '../near/views'
import { dealerLook, LOOK_PRESETS, type LookPreset } from '../scene/looks'

const GAMES: readonly Game[] = ['dice', 'roulette', 'blackjack']

/** The three temperaments of `dealer_rules`; the keeper reprices the table with the one picked. */
const TEMPERAMENTS = [
  { id: 'greedy', text: 'high edge, tight max bets, pays little rent: earns more per round, fewer players' },
  { id: 'promoter', text: 'low edge and boosts to fill the table, pays more rent to stay seen: can bleed on streaks' },
  { id: 'cautious', text: 'protects the bankroll first: cuts max bets when it loses, steady and slow' },
] as const
type Temperament = (typeof TEMPERAMENTS)[number]['id']

const LOOK_LABELS: Record<LookPreset, string> = {
  'gold-visor': 'gold visor',
  'top-hat': 'top hat',
  beanie: 'beanie',
  bare: 'bare head',
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
  const [id, setId] = useState('')
  const [name, setName] = useState('')
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
      const { txHash } = await call('bid for a seat', 'bid_for_seat', { dealer_id: id, rent_per_hour: String(rentUnits) })
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
        Seed a table from your house balance and you own it: you hold its founding LP shares and pick how its dealer
        plays. Then bid rent for a seat on the floor; the rent goes to the jackpot. A table off the floor takes no bets.
      </p>
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
            onChange={(e) => setId(e.target.value.toLowerCase())}
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
            at least {formatUsdc(MIN_TABLE_SEED)}; your balance: {player.data ? formatUsdc(player.data.balance) : '—'}
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
      <OpenStatus step={step} id={id} />
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

function OpenStatus({ step, id }: { step: Step; id: string }) {
  switch (step.state) {
    case 'idle':
      return null
    case 'busy':
      return <p className="muted">{step.label}: confirm in the Privy window…</p>
    case 'done':
      return (
        <p className="win">
          Table open and seat bid sent ·{' '}
          <a href={`${EXPLORER_TX}${step.txHash}`} target="_blank" rel="noreferrer">
            view tx
          </a>{' '}
          · <Link to={`/table/${id}`}>go to your table</Link>
        </p>
      )
    case 'error':
      return (
        <p className="loss">
          Could not {step.label}: {step.message}
        </p>
      )
  }
}
