import { useState } from 'react'
import { formatBp, formatUsdc } from '../format'
import { DICE_MAX_CHANCE_BP, DICE_MIN_CHANCE_BP, applyRake, diceWinPayout, rouletteBetLabel, rouletteWinMultiple } from '../house'
import type { Bet, RouletteBet } from '../near/views'

interface FormProps {
  stake: bigint | null
  rakeBp: number
  disabled: boolean
  onBet: (bet: Bet) => void
}

export function DiceForm({ stake, rakeBp, disabled, onBet }: FormProps) {
  const [chanceBp, setChanceBp] = useState(5_000)
  const [over, setOver] = useState(false)
  const target = over ? `roll ≥ ${((10_000 - chanceBp) / 100).toFixed(2)}` : `roll < ${(chanceBp / 100).toFixed(2)}`
  return (
    <div className="game-form">
      <label>
        win chance {formatBp(chanceBp)}
        <input
          type="range"
          min={DICE_MIN_CHANCE_BP}
          max={DICE_MAX_CHANCE_BP}
          step={50}
          value={chanceBp}
          onChange={(event) => setChanceBp(Number(event.target.value))}
        />
      </label>
      <div className="choices">
        <button type="button" className={over ? 'ghost' : ''} onClick={() => setOver(false)}>
          under
        </button>
        <button type="button" className={over ? '' : 'ghost'} onClick={() => setOver(true)}>
          over
        </button>
        <span className="muted">
          {target} of 100.00
          {stake ? ` · a win pays ${formatUsdc(diceWinPayout(stake, chanceBp, rakeBp))}` : ''}
        </span>
      </div>
      <button type="button" disabled={disabled} onClick={() => onBet({ dice: { chance_bp: chanceBp, over } })}>
        Roll
      </button>
    </div>
  )
}

const SIMPLE_BETS: RouletteBet[] = ['red', 'black', 'odd', 'even', 'low', 'high']
const DOZENS: RouletteBet[] = [1, 2, 3].map((dozen) => ({ dozen }))
const COLUMNS: RouletteBet[] = [1, 2, 3].map((column) => ({ column }))

export function RouletteForm({ stake, rakeBp, disabled, onBet }: FormProps) {
  const [bet, setBet] = useState<RouletteBet>('red')
  const [straight, setStraight] = useState('17')
  const number = Number(straight)
  const numberValid = /^\d{1,2}$/.test(straight) && number <= 36
  const label = rouletteBetLabel(bet)
  const payout = stake ? applyRake(stake * rouletteWinMultiple(bet), stake, rakeBp) : null
  const option = (choice: RouletteBet) => (
    <button
      key={rouletteBetLabel(choice)}
      type="button"
      className={rouletteBetLabel(choice) === label ? '' : 'ghost'}
      onClick={() => setBet(choice)}
    >
      {rouletteBetLabel(choice)}
    </button>
  )
  return (
    <div className="game-form">
      <div className="choices">{SIMPLE_BETS.map(option)}</div>
      <div className="choices">{DOZENS.map(option)}</div>
      <div className="choices">{COLUMNS.map(option)}</div>
      <div className="choices">
        <input
          className="number"
          inputMode="numeric"
          value={straight}
          onChange={(event) => {
            setStraight(event.target.value)
            if (/^\d{1,2}$/.test(event.target.value) && Number(event.target.value) <= 36) {
              setBet({ straight: Number(event.target.value) })
            }
          }}
          onFocus={() => numberValid && setBet({ straight: number })}
        />
        <span className="muted">a number 0–36 pays 36×</span>
      </div>
      <p className="muted">
        betting {label}
        {payout ? ` · a win pays ${formatUsdc(payout)}` : ''}
      </p>
      <button type="button" disabled={disabled} onClick={() => onBet({ roulette: bet })}>
        Spin
      </button>
    </div>
  )
}
