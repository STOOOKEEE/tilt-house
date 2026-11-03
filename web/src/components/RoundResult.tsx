import { formatUsdc } from '../format'
import { EXPLORER_TX, cardLabel, diceWins, handTotal, pocketColor, rouletteBetLabel } from '../house'
import type { BlackjackHand, RoundView, VrfProof } from '../near/views'
import { useNow } from '../useNow'
import { checkProof } from '../vrf'

interface Props {
  round: RoundView
  /** Relayed transactions of this round (bet and blackjack moves), newest last. */
  txHashes: string[]
  vrfPubkeyHex: string | null
  /** Signs relayed transactions, so it is the signer named in the alpha of relayed rounds. */
  relayerAccount: string
  refundAfterSecs: number
  /** Present when the viewer may ask for a refund (anyone may, but only the player cares). */
  onRefund: (() => void) | null
}

export function RoundResult({ round, txHashes, vrfPubkeyHex, relayerAccount, refundAfterSecs, onRefund }: Props) {
  const now = useNow()
  const stuck = round.status === 'failed' || (round.status === 'waiting_vrf' && now - round.updated_at >= refundAfterSecs)
  return (
    <section className="round">
      <header>
        Round #{round.id} · {round.dealer_id} · <RoundStatusLabel round={round} />
      </header>
      <Outcome round={round} />
      {round.error ? <p className="loss">VRF step failed: {round.error}</p> : null}
      {stuck && onRefund ? (
        <p>
          The draw did not come back.{' '}
          <button type="button" onClick={onRefund}>
            Refund my stake
          </button>
        </p>
      ) : null}
      {txHashes.length > 0 ? (
        <p className="muted">
          tx:{' '}
          {txHashes.map((hash) => (
            <a key={hash} href={`${EXPLORER_TX}${hash}`} target="_blank" rel="noreferrer">
              {hash.slice(0, 8)}…{' '}
            </a>
          ))}
        </p>
      ) : null}
      {round.proofs.length > 0 ? (
        <details>
          <summary>verify the draw</summary>
          <p className="muted">
            Each draw is OutLayer&apos;s VRF: an Ed25519 signature over <code>alpha</code>, which names this round, step
            and the account that signed the request (you, or the relayer for a gasless move). The random output is sha256(signature). Checked below in your browser.
          </p>
          {round.proofs.map((proof) => (
            <ProofDetail
              key={proof.step}
              proof={proof}
              round={round}
              vrfPubkeyHex={vrfPubkeyHex}
              relayerAccount={relayerAccount}
            />
          ))}
        </details>
      ) : null}
    </section>
  )
}

function RoundStatusLabel({ round }: { round: RoundView }) {
  switch (round.status) {
    case 'waiting_vrf':
      return <span className="muted">drawing…</span>
    case 'player_turn':
      return <span className="key">your move</span>
    case 'failed':
      return <span className="loss">draw failed</span>
    case 'refunded':
      return <span className="muted">refunded</span>
    case 'settled': {
      const net = BigInt(round.payout ?? '0') - BigInt(round.wager)
      if (net > 0n) return <span className="win">won +{formatUsdc(net)} tUSDC</span>
      if (net === 0n) return <span className="muted">push</span>
      return <span className="loss">lost {formatUsdc(-net)} tUSDC</span>
    }
  }
}

function Outcome({ round }: { round: RoundView }) {
  const { bet } = round
  if (bet !== 'blackjack' && 'dice' in bet) {
    const { chance_bp, over } = bet.dice
    const target = over ? `≥ ${((10_000 - chance_bp) / 100).toFixed(2)}` : `< ${(chance_bp / 100).toFixed(2)}`
    return (
      <p className="outcome">
        roll {round.roll === null ? '…' : <Big win={diceWins(round.roll, chance_bp, over)}>{(round.roll / 100).toFixed(2)}</Big>}{' '}
        <span className="muted">
          needed {target} · stake {formatUsdc(round.stake)}
        </span>
      </p>
    )
  }
  if (bet !== 'blackjack' && 'roulette' in bet) {
    return (
      <p className="outcome">
        pocket{' '}
        {round.pocket === null ? '…' : <span className={`pocket ${pocketColor(round.pocket)}`}>{round.pocket}</span>}{' '}
        <span className="muted">
          bet {rouletteBetLabel(bet.roulette)} · stake {formatUsdc(round.stake)}
        </span>
      </p>
    )
  }
  return round.bj ? <Hand hand={round.bj} wager={round.wager} /> : <p className="outcome">dealing…</p>
}

function Big({ win, children }: { win: boolean; children: string }) {
  return <strong className={win ? 'win' : 'loss'}>{children}</strong>
}

function Hand({ hand, wager }: { hand: BlackjackHand; wager: string }) {
  const player = handTotal(hand.player)
  const dealer = handTotal(hand.dealer)
  return (
    <div className="outcome">
      <p>
        you <Cards cards={hand.player} /> = {player.soft ? 'soft ' : ''}
        {player.total}
        {hand.doubled ? ' · doubled' : ''}
      </p>
      <p>
        dealer <Cards cards={hand.dealer} /> = {dealer.total}
      </p>
      <p className="muted">wager {formatUsdc(wager)}</p>
    </div>
  )
}

function Cards({ cards }: { cards: number[] }) {
  return (
    <span className="cards-row">
      {cards.map((card, i) => (
        <span key={i} className="playing-card">
          {cardLabel(card)}
        </span>
      ))}
    </span>
  )
}

function ProofDetail({
  proof,
  round,
  vrfPubkeyHex,
  relayerAccount,
}: {
  proof: VrfProof
  round: RoundView
  vrfPubkeyHex: string | null
  relayerAccount: string
}) {
  const check = vrfPubkeyHex ? checkProof(proof, vrfPubkeyHex, round.id, [round.player, relayerAccount]) : null
  return (
    <dl className="proof">
      <dt>step</dt>
      <dd>{proof.step}</dd>
      <dt>alpha</dt>
      <dd>
        <code>{proof.alpha}</code>
      </dd>
      <dt>signature</dt>
      <dd>
        <code>{proof.signature_hex}</code>
      </dd>
      <dt>output</dt>
      <dd>
        <code>{proof.output_hex}</code>
      </dd>
      <dt>VRF key</dt>
      <dd>
        <code>{vrfPubkeyHex ?? 'loading…'}</code>
      </dd>
      {check ? (
        <>
          <dt>checks</dt>
          <dd>
            <Check ok={check.signature}>signature</Check> <Check ok={check.output}>output = sha256(signature)</Check>{' '}
            <Check ok={check.binding}>alpha names this round</Check>
          </dd>
        </>
      ) : null}
    </dl>
  )
}

function Check({ ok, children }: { ok: boolean; children: string }) {
  return <span className={ok ? 'win' : 'loss'}>{(ok ? '✓ ' : '✗ ') + children}</span>
}
