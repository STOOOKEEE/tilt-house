// The "?" legend of a table: what the felt, the chips, TILT and the verification do, one line each.
import { useEffect, useState } from 'react'
import type { Game } from '../../near/views'

const FELT: Record<Game, string> = {
  dice: 'Click the bar to pick your target, Under / Over to flip the side, the circle to place chips. Lower chance, bigger pay.',
  roulette: 'Click any number, line or corner. A chip between cells splits the bet; one spin settles every stack.',
  blackjack: 'Chips on the circle, TILT to deal, then Hit, Stand or Double (H, S, D). Beat the dealer without passing 21.',
}

export function TableLegend({ game }: { game: Game }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey) return
      if (event.key === '?') setOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="legend">
      {open ? (
        <dl className="hud legend-card" id="table-legend">
          <dt>Felt</dt>
          <dd>{FELT[game]}</dd>
          <dt>Chips</dt>
          <dd>Pick a value at the bottom. Click adds a chip, right-click or long-press takes one off.</dd>
          <dt>TILT</dt>
          <dd>Plays everything on the felt as one round (Space). Your chips stay for the next one.</dd>
          <dt>Verify</dt>
          <dd>
            Sitting down commits the server’s seed hash on chain; every result comes signed. Leave (Esc) and the seed is
            revealed: “Verify every round” replays the whole session in your browser.
          </dd>
        </dl>
      ) : null}
      <button
        type="button"
        className="ghost legend-toggle"
        aria-expanded={open}
        aria-controls="table-legend"
        title="How this table works (?)"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '✕' : '?'}
      </button>
    </div>
  )
}
