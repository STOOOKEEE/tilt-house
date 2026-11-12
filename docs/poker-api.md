# Poker API (session server)

No-Limit Hold'em, 2–6 seats, play money. Served by the session server next to the sessions API
(docs/sessions.md); the web reaches it under the same base URL (`VITE_SESSION_URL`, `/session` on the
site). JSON in and out, amounts are base-unit decimal strings (6 decimals, like every Tilt House amount),
seats are **0-based** integers, times are **Unix milliseconds**. Errors are `{"error": "..."}` with the
statuses listed at the end. Game rules, deck, hand evaluation and NPC strategy are core's
(`core/src/poker.rs`, `core/src/poker_npc.rs`, docs/poker-rules.md); core types below are given by name
and serialize exactly as serde writes them.

A poker table is a floor dealer whose game is `poker`; its table id **is** its `dealer_id` (`poker-demo`
in `--no-chain` mode). Each seated player plays through an ordinary session at that dealer: the buy-in is
the session's `lock`, the stack is the session balance, and every hand the player puts chips into becomes
one `CompactRound` of that session (see "Hands on chain"). The session token is the player's credential
at the table.

Stakes (every table): small blind 0.1, big blind 0.2, buy-in 4 to 20 chips (core's 20–100 big blinds; the
maximum is lowered to the ticket's max bet, 80 % of the dealer's max bet, which is all the contract takes),
rake = the dealer's `rake_bp` of the pot (the lowest `rake_bp` among the players' tickets), capped at 3
big blinds, none without a flop.

## Flow for a human player

1. `GET /poker/tables`: pick a table.
2. `POST /sessions` `{player, dealer_id: <table id>, lock: <buy-in>, client_seed}` (docs/sessions.md):
   `lock` must be within 4..=20 chips (`400` otherwise) and at most the table's current `max_buy_in`
   (`409 buy-in above this table's max buy-in now` otherwise). Keep `session_id` and `token`.
3. Sign `open_session` on chain, exactly as at the other tables.
4. `POST /poker/tables/{id}/join` with `Authorization: Bearer <token>` and `{"session_id": "..."}`.
   `409 session not open on chain yet` until the open tx has executed: retry every second.
   The player is seated with `waiting: true` and dealt in from the next hand.
5. Poll `GET /poker/tables/{id}?since=<version>` with the same bearer token (see "Polling").
6. When `hand.phase == "seeding"`, your seat is in `hand.seats` and not in `hand.seeds_in`, post a fresh
   random client seed: `POST /poker/tables/{id}/seed`. The web does this automatically.
7. When `you.legal` is not null it is your turn: `POST /poker/tables/{id}/action` before
   `hand.deadline`. Otherwise the server checks for you when checking is free, else folds.
8. `POST /poker/tables/{id}/leave`. In a hand you fold at your next turn and are unseated when it ends;
   then the server closes your session (final settle + seed reveal on chain) and the stack goes back to
   your contract balance. `POST /sessions/{id}/close` answers `409` while you are seated.

A player whose clock runs out twice in a row (two turns, in one hand or across hands) is stood up the
same way. A player whose stack falls under the big blind is stood up after the hand.

## Endpoints

### `GET /poker/tables`

```ts
interface TableSummary {
  table_id: string         // = dealer_id
  name: string             // dealer name
  seats: number            // 6
  humans: number           // seated humans (waiting and queued included, leavers not)
  npcs: number             // seated NPC players (leavers not)
  small_blind: string
  big_blind: string
  min_buy_in: string
  max_buy_in: string       // capped at the ticket's max bet (refreshed on this call); below min_buy_in: no buy-in now
  rake_bp: number          // the dealer's rake when the table was first used
  hand_number: number      // hands dealt since the server started (0: none yet)
}
type TablesReply = TableSummary[]
```

### `GET /poker/tables/{id}?since=<version>`

Public table state, plus the caller's private view when the session token of a seated (or queued)
player is sent as `Authorization: Bearer <token>`. Any other token, or none, is a watcher: `you` is
null, no error.

```ts
type Card = string          // "As", "Td", "7c", "2h": ranks 23456789TJQKA, suits cdhs (core `Card`)
type PokerAction =          // core `PokerAction`
  'fold' | 'check' | 'call' | 'all_in' | { raise_to: string }   // raise_to: total in front this street

interface SeatView {
  seat: number
  player: string           // NEAR account
  name: string             // NPCs: lineup name ("Mia"); humans: the account
  npc: boolean             // true: a house bot (strategy: core/src/poker_npc.rs), playing its own wallet
  stack: string            // all the player's chips at the table not in front of it (behind included)
  bet: string              // chips in front this street
  total_in: string         // chips put in this hand (all streets)
  folded: boolean
  all_in: boolean
  in_hand: boolean         // dealt into the current hand
  waiting: boolean         // seated, dealt in from the next hand
  leaving: boolean         // unseated when the current hand ends
  last_action: PokerAction | null   // this street
  cards: [Card, Card] | null        // shown at the showdown only; never someone's live hole cards
}

interface Pot {            // core `Pot`
  amount: string
  eligible: number[]       // seats that can win it; pots[0] is the main pot, the rest side pots
  winners: number[]        // filled once the hand is over
}

interface HandView {
  number: number           // per table, increasing
  phase: 'seeding' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'
  commitment: string       // hex sha256(hand_seed), published before any client seed is taken
  seats: number[]          // seats dealt into this hand
  seeds_in: number[]       // seats whose client seed for this hand is in (NPC seeds are in from the start)
  button: number
  small_blind_seat: number | null   // null while seeding
  big_blind_seat: number | null
  board: Card[]
  pots: Pot[]              // everything committed so far (uncalled chips not yet returned, no rake)
  current_bet: string      // highest bet this street
  to_act: number | null    // seat whose turn it is
  deadline: number | null  // Unix ms: seeding ends / to_act is played by the clock
}

interface Legal {          // core `Legal`
  seat: number
  can_check: boolean
  call: string             // chips a call adds (capped at your stack); "0" when you can check
  raise: { min_to: string; max_to: string } | null   // raise_to range; max_to = all in
  stack: string            // chips behind, in play this hand
}

interface YouView {
  seat: number | null      // null while queued for a seat an NPC is giving up
  session_id: string
  hole: [Card, Card] | null   // your two hole cards, once dealt
  legal: Legal | null      // non-null exactly when it is your turn
  state: SignedState | null   // your session's latest signed state (same JSON as POST /sessions/{id}/rounds)
  last_round: CompactRound | null   // the round your latest recorded hand became
}

interface TableState {
  table_id: string
  name: string
  version: number          // bumps on every change; pass it back as `since`
  seats: (SeatView | null)[]   // length 6, null = empty seat
  queued: number           // humans waiting for an NPC's seat
  config: {
    small_blind: string; big_blind: string; rake_cap: string
    min_buy_in: string; max_buy_in: string
    rake_bp: number; action_ms: number; seed_ms: number
  }
  hand: HandView | null    // null between hands
  last_hand: HandRecord | null   // the previous finished hand, fully revealed
  you: YouView | null
}
```

A player is dealt in with at most the ticket's max bet in play (the contract's limit on one round's
stake); chips above it stay behind and count in `stack` but not in `you.legal.stack`.

### Polling

`since` is optional. When `since` equals the current `version`, the server holds the request until the
table changes or 10 s pass, then answers with the current state, so a client can loop on it without a
delay. Otherwise it answers at once. Every request counts against the per-IP limit (60/s, burst 120).

### `POST /poker/tables/{id}/join`

Bearer: the session token. Body `{"session_id": "<hex>", "seat"?: number}` (`seat` optional: first free
seat otherwise). The session must be this table's dealer's, open on chain, not closing, not seated
anywhere, its account not already at the table, and its balance at least one big blind. A session that
already played hands (rejoin after a server restart) sits with its current balance.

If every seat is taken and an NPC sits, the human is queued (`seat: null`) and the NPC gives up its seat
when the current hand ends (anti-bumhunting: NPCs only fill empty seats, by core's
`npc_seats_change`: they come only while a human is seated, aim at 4 players, and leave as humans come).
No NPC to replace: `409 table full`.

Reply: `{"seat": number | null, "waiting": true}`.

### `POST /poker/tables/{id}/seed`

Bearer token. Body `{"hand": <number>, "client_seed": "<1-64 printable chars, no ':'>"}`. Only during
`seeding` of that hand, once per seat. A human seat that sends none uses its default
`<session client_seed>-<hand number>` (hashed down to 32 hex chars if longer than 64); NPC seats use
`<npc id>-<hand number>` (e.g. `g-mia-12`), fixed before the commitment. Reply: `{"ok": true}`.

### `POST /poker/tables/{id}/action`

Bearer token. Body `{"hand": <number>, "action": PokerAction}`, e.g. `{"hand": 7, "action": "call"}` or
`{"hand": 7, "action": {"raise_to": "600000"}}` (a bet when nobody bet this street). `400` for an action
`you.legal` does not allow, `409` when it is not your turn. Reply: your `TableState`.

### `POST /poker/tables/{id}/leave`

Bearer token, no body. Reply `{"left": boolean}`: `true` when unseated at once (not in a hand, or
queued), `false` when unseated at the end of the current hand (you fold at your turn). The server then
closes the session; read `GET /sessions/{session_id}` for its rounds and, once closing, its seed.

## Provably fair hands

Per hand, in this order:

1. The server draws `hand_seed` (32 random bytes) and publishes `commitment = sha256(hand_seed)` with
   `phase: "seeding"` (NPC seeds already fixed).
2. Each human seat posts a client seed, or gets its default, within `seed_ms` (or until all are in).
3. The deck is `deck_for(hand_seed, client seeds in seat order)` (core: HMAC-SHA256 of the hand seed over
   `"tilt-house/poker-deck/v1:" + seeds joined by ":"`, then Fisher–Yates), and the hand is dealt
   (`Hand::new`). The client seeds arrive after the commitment, so the server cannot pick a seed for a
   deck it likes.
4. At the end `last_hand` reveals everything:

```ts
interface HandRecord {
  number: number
  commitment: string       // hex
  hand_seed: string        // hex; sha256(hand_seed) == commitment
  history: HandHistory     // core: {start: HandStart, hand_seed, actions: [{seat, action}]}; replay_hand(history)
  history_hash: string     // hex sha256(borsh(history)): what each player's round commits to
  deck: Card[]             // deck_for(hand_seed, seeds), 52 cards
  players: {
    seat: number; player: string; name: string; npc: boolean; session_id: string
    hole: [Card, Card]     // every dealt hand is revealed with the seed (derivable from it anyway)
    stake: string          // chips put in the pot
    payout: string         // chips won, after rake
    nonce: number | null   // the session round this hand became; null when the player put nothing in
  }[]
  result: HandResult       // core: {board, showdown, pots, rake, seats: [{seat, player, put_in, won, stack_after, shown, value}]}
  ended_at: number         // Unix ms
}
```

Chips are conserved per hand: `sum(stake) == sum(payout) + result.rake`.

## Hands on chain

When a hand ends, each player who put chips in gets one `CompactRound` in their session (core
`Hand::round_for`): `stake` = chips put in, `payout` = chips won after rake, `bet` =
`{"poker": {"table", "hand"}}`, `outcome` = `{"poker": {hand_seed_hash, history_hash, seat, board}}`.
All the hand's rounds are written to disk in one write before any is visible, then each session signs
its new state; settles and close are the usual ones (docs/sessions.md), so the table's pool sees `+rake`
per hand across the sessions. A hand whose rounds a session cannot take (closing session, stake over the
balance, result over `lock + max_win`) is void: nobody's stack moves. Before each deal, a player whose
best possible result could pass `lock + max_win` is stood up instead. Poker sessions are played only
through the table: `POST /sessions/{id}/rounds` answers `400`. Anyone can check a session with
`verify_poker_session` (core) from its settle batches and the hands' histories.

## Errors

| status | when |
| --- | --- |
| 400 | malformed body, bad seed, illegal action, buy-in outside the table's range |
| 401 | missing or wrong bearer token, not seated at this table |
| 404 | no such table / session |
| 409 | not your turn, wrong hand number, seeding over, table full, session not open on chain yet, session for another table, already seated, account already at the table, closing |
| 429 | rate limited: per IP; seeds, actions, joins and leaves 20/s per (table, token) |
| 503 | chain unavailable, retry later |

## Running it

`cargo run -p tilt-house-session-server -- --no-chain` serves `poker-demo` (dealer Faye) with NPCs from
the lineup (in-memory balances); the tables start on first request. Timings: 20 s to act, 3 s of
seeding, 4 s between hands, NPCs act after 1.2 s.
