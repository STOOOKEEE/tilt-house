import { useEffect, useState } from 'react'
import { formatBp, formatUsdc, tokenSymbol } from '../../format'
import type { DealerView } from '../../near/views'
import type { GamblerSnapshot } from '../../sim/gamblers'
import { maxBetCap } from '../../tycoon'
import {
  PERSONA_WORDS,
  answerWant,
  decidesIn,
  doorOutcome,
  personaLabel,
  trackDoor,
  type DoorCard,
  type DoorOutcome,
  type Send,
} from './cockpit'

interface DoorProps {
  dealer: DealerView
  dealers: readonly DealerView[]
  /** Null while the live gambler feed is unreachable. */
  feed: readonly GamblerSnapshot[] | null
  feedError: string
  now: number
  busy: boolean
  send: Send
}

/** The heart of the cockpit: gamblers standing at the table, what would win them over, and a one-click answer. */
export function Door({ dealer, dealers, feed, feedError, now, busy, send }: DoorProps) {
  const [cards, setCards] = useState<DoorCard[]>([])
  useEffect(() => {
    if (feed) setCards((previous) => trackDoor(previous, feed, dealer.id, Math.floor(Date.now() / 1000)))
  }, [feed, dealer.id])

  return (
    <div className="cockpit-block cockpit-door">
      <h3>Customers at your door</h3>
      {feed === null ? (
        <p className="muted">
          The live gambler feed is off{feedError ? ` (${feedError})` : ''}: gamblers hesitating at your table show here.
        </p>
      ) : cards.length === 0 ? (
        <p className="muted">
          Nobody is hesitating at your table right now. When a gambler stops here but would rather pick another table,
          it says what would win it over and waits a moment for your answer.
        </p>
      ) : (
        <>
          {cards.map((card) => (
            <CustomerCard key={card.gambler_id} card={card} dealer={dealer} dealers={dealers} feed={feed} now={now} busy={busy} send={send} />
          ))}
          <p className="muted">
            Each answer sends <code>set_offer</code> with the rest of your offer unchanged; it turns autopilot off
            {dealer.autopilot ? ` (now on, ${dealer.temperament})` : ''}.
          </p>
        </>
      )}
    </div>
  )
}

function rivalOffer(rival: DealerView, now: number): string {
  const boosting = rival.boost_until > now ? ', boosting' : ''
  return `${formatBp(rival.total_edge_bp)} edge, max bet ${formatUsdc(rival.max_bet)}${boosting}`
}

interface CardProps {
  card: DoorCard
  dealer: DealerView
  dealers: readonly DealerView[]
  feed: readonly GamblerSnapshot[]
  now: number
  busy: boolean
  send: Send
}

function CustomerCard({ card, dealer, dealers, feed, now, busy, send }: CardProps) {
  const { hesitating } = card
  const rival = dealers.find((d) => d.id === hesitating.rival_id) ?? null
  const outcome = doorOutcome(card, feed, now)
  const cares = card.persona ? `: cares about ${PERSONA_WORDS[card.persona].cares}` : ''

  return (
    <div className={`customer-card outcome-${outcome.kind}`}>
      <p>
        <strong>{card.name}</strong> <span className="muted">· {personaLabel(card.persona)}{cares}</span>
      </p>
      {card.ask ? <p className="customer-ask">“{card.ask}”</p> : null}
      <p className="muted">
        {hesitating.rival_id === null
          ? 'would leave the floor right now'
          : `would pick ${rival?.name ?? hesitating.rival_id} right now${rival ? `: ${rivalOffer(rival, now)}` : ''}`}
      </p>
      {outcome.kind === 'deciding' ? (
        <>
          <p className="countdown">{decidesIn(hesitating.until, now)}</p>
          <Answer card={card} dealer={dealer} now={now} busy={busy} send={send} />
        </>
      ) : (
        <Outcome outcome={outcome} name={card.name} dealers={dealers} />
      )}
    </div>
  )
}

function Answer({ card, dealer, now, busy, send }: Omit<CardProps, 'dealers' | 'feed'>) {
  const answer = answerWant(dealer, card.hesitating, now)
  switch (answer.kind) {
    case 'offer':
      return (
        <button type="button" disabled={busy} onClick={() => send(`${answer.label} for ${card.name}`, 'set_offer', answer.args)}>
          {answer.label}
        </button>
      )
    case 'invest':
      return (
        <p>
          <button type="button" disabled>
            {answer.label}
          </button>{' '}
          <span className="muted">
            the pool covers up to {formatUsdc(maxBetCap(dealer))}: invest {formatUsdc(answer.need)} {tokenSymbol()} first in
          </span>{' '}
          <a href={`#pool-${dealer.id}`}>Pool</a>
        </p>
      )
    case 'blocked':
      return (
        <p>
          <button type="button" disabled>
            {answer.label}
          </button>{' '}
          <span className="muted">{answer.reason}</span>
        </p>
      )
  }
}

function Outcome({ outcome, name, dealers }: { outcome: Exclude<DoorOutcome, { kind: 'deciding' }>; name: string; dealers: readonly DealerView[] }) {
  const why = outcome.reason ? `: “${outcome.reason}”` : ''
  switch (outcome.kind) {
    case 'sat':
      return <p className="win">{name} sat at your table{why}</p>
    case 'rival':
      return (
        <p className="loss">
          {name} went to {dealers.find((d) => d.id === outcome.dealer_id)?.name ?? outcome.dealer_id}
          {why}
        </p>
      )
    case 'left':
      return <p className="loss">{name} left the floor{why}</p>
  }
}
