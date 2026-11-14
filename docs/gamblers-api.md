# Live gamblers API (session server)

The NPC gambler runner lives in the session server (docs/tycoon.md, docs/sessions.md); the web reads it
from `VITE_SESSION_URL`. Both endpoints are public, read-only, `GET`, JSON. When they are unreachable the
web falls back to the sim.json demo floor. Amounts are base-unit decimal strings (`session_net` may start
with `-`); seats are **0-based** here, like sim.json frames. Parser: `web/src/sim/gamblers.ts`.

## `GET /gamblers/floor`

The gamblers on the floor now, same shape as a sim.json frame's `gamblers` array. Gamblers off the floor
are omitted.

```ts
type GamblerState = 'walking' | 'deciding' | 'seated' | 'leaving'

interface GamblerSnapshot {
  id: string               // "g-mia" (NEAR sub-account g-mia.tilthouse.testnet)
  name: string             // "Mia" (display name; also in sim.json top-level `gamblers`)
  persona: 'bargain_hunter' | 'regular' | 'whale' | 'thrill_seeker' | 'tourist'
  state: GamblerState
  dealer_id: string | null // the table it is deciding at / seated at; null while walking
  seat: number | null      // 0-based seat of dealer_id
  reason_code: string | null // cheapest | loyal | fits_my_bets | boosting | jackpot | near_entrance | best_overall | nothing_worth_it | broke | hesitating | deal | session_over | poker
  reason: string | null    // one line, e.g. "Ada's 1.0 % beats Bruno's 2.4 %"
  balance: string          // in-contract balance, base units
  session_net: string      // signed, current session's result so far ("0" when not playing)
  hesitating: null | {     // null (or absent, for old servers) unless it stands at a player's table, asking
    dealer_id: string        // the player-owned table it stands at while deciding (also the entry's dealer_id)
    rival_id: string | null  // the table it would pick right now (null = it would leave)
    want: 'lower_edge' | 'higher_max_bet' | 'boost'
    edge_bp: number | null   // lower_edge: total edge (game edge + rake) in bp at or below which it sits
    max_bet: string | null   // higher_max_bet: max bet in base units at or above which it sits
    until: number            // unix seconds: when it decides (end of its deciding pause)
  }
}

type FloorReply = GamblerSnapshot[]
```

`name` and `persona` are optional in sim.json frames (they come from the top-level list there) but
required here.

**Hesitating** (`core/src/gambler_rules.rs`, `hesitation`). A gambler that passes up a player-owned table
(the contract's `npc: false`) stops there instead when one owner action would win it: that table is the
best-scoring player table and comes within `HESITATION_MARGIN_POINTS` (30) of the winner, or of the
persona's threshold when nothing cleared it. It asks for what its persona weighs most among the changes
that close the gap: a lower total edge (within the game's 1–5 % bounds), a higher max bet (at most its
stake) or a boost (only when not boosting). While it asks, `state` is `"deciding"`, `dealer_id`/`seat`
are the player's table, `reason_code` is `"hesitating"` and `reason` the ask in plain words ("Ada's at
1.0 %: go to 0.9 % and I'm yours", "I bet 25.0 a round: raise your max bet to 25.0", "boost your table
and I'll sit"). The owner answers with `set_offer` (rake = target total edge − the game's base edge).
At `until` the gambler reads the floor again and decides with the same noise: at the player's table
`reason_code` is `"deal"` ("deal: Pat's 0.9 % it is"), otherwise its usual reason.

## `GET /gamblers/footfall?dealer_id=<id>`

The last hour at one table, for the owner dashboard and the offer preview.

```ts
interface Arrival {
  persona: GamblerSnapshot['persona']
  score: number      // this table's score for that gambler (gambler_rules), any real number
  chose: boolean     // the gambler sat at this table
  reason: string     // the gambler's one-line reason (for this choice, or where it went instead)
}

interface FootfallReply {
  dealer_id: string
  passed_1h: number  // distinct gamblers who stopped at this table and went elsewhere (or left)
  sat_1h: number     // distinct gamblers who sat here
  arrivals_1h: Arrival[] // every arrival on the floor over the hour, scored for this table, oldest first
}
```

Unknown `dealer_id`: `404 {"error":"unknown dealer"}`.
