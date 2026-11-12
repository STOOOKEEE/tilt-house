# Floor contract API v3 (`contract/`, crate `tilt-house-contract`)

Deployed to `floor.tilthouse.testnet` (v2 upgraded in place with `migrate`) and, with play-money chips, to the
mainnet floor (`floor.<root>`, `scripts/deploy-floor.sh`). Rules come from `core_rules` (docs/floor.md,
docs/sessions.md, docs/tycoon.md); this file is the JSON contract between the chain, the web, the session
server, the relayer and the agents. v3 adds: the NPC gambler registry and their salary (`register_npcs`,
`credit_npc`), table rename and retirement, poker tables, the reproducible build.

## Conventions

- **Amounts** (token base units, 6 decimals; LP shares) are `u128` as **decimal strings** (`"100000"` = 0.10 tUSDC).
  Signed amounts (`player_net_1h`, `earnings_1h`, `pnl_1h`) are decimal strings with an optional `-`.
- **Times** are **seconds** since the Unix epoch (block time), JSON numbers. `0` = never / none.
- **Dealer id** = LP token id: `[a-z0-9-]{1,32}`, never starting with `seat-`.
- **Seats** are numbered **1..6** in JSON (seat 1 is by the entrance). Seat lease token id: `"seat-<n>"`.
- **32-byte values** (seeds, hashes, chains, public keys) are lowercase hex (64 chars); signatures are 128 hex chars.
- Errors are panics with a readable message; a panicking call changes nothing.
- Money token: tUSDC `tusdc.tilthouse.testnet` (6 decimals), an init argument.
- The contract pays every player's storage (testnet): no `storage_deposit` on the floor.

## Accounts and roles

| Role | Who | Can |
|---|---|---|
| owner | `tilthouse.testnet` | `add_dealer`, `launch_floor`, `set_server_pubkey`, `set_keeper`, `register_npcs` |
| keeper | config `keeper` | `reprice` (any dealer on autopilot), `rent_bid` (NPC dealers), NPC salary (`credit_npc` deposit msg) |
| controller | NPC dealer account (`ada.tilthouse.testnet`) or the player who opened the table | `bid_for_seat`, `set_offer`, `set_autopilot`, `set_temperament`, `list_seat`, `buy_seat`, `reprice`, `rent_bid` (NPC), `set_table_name`, `retire_table` |
| NPC gambler | an account in `get_npcs()` (at most `MAX_NPC_GAMBLERS = 24`, core `gambler_rules`) | sessions only: `open_session`, `close_session`, `force_close`, `claim_unrevealed`. Refused: `withdraw`, `invest` (also the `invest` deposit msg), `divest`, `open_table`, `list_seat`, `buy_seat`, `mt_transfer` (`"NPC gamblers can only play sessions"`). Their keys are function-call keys limited to the four session methods. |
| session server | holds the ed25519 key whose public half is config `server_pubkey` | signs tickets and states (no on-chain role besides `settle_session`, which anyone may send) |
| anyone | | `collect_rent`, `settle_session`, `close_session` (with the seed) |

Relayer allow-list (function-call, 0 deposit): `open_table`, `bid_for_seat`, `set_offer`, `set_autopilot`,
`set_temperament`, `set_table_name`, `retire_table`, `list_seat`, `buy_seat`, `invest`, `divest`, `open_session`,
`close_session`, `force_close`, `claim_unrevealed`. `withdraw` and `mt_transfer` need 1 yocto (full-access key).

## Init and owner

| Method | Args | Notes |
|---|---|---|
| `new` | `{owner, token, keeper, server_pubkey_hex}` | `#[init]`. `server_pubkey_hex`: the session server's ed25519 public key. |
| `set_server_pubkey` | `{server_pubkey_hex}` | owner. Open sessions keep working only if signed by the new key. |
| `set_keeper` | `{keeper}` | owner. |
| `add_dealer` | `{id, name, game: "dice"\|"roulette"\|"blackjack"\|"poker", temperament: "greedy"\|"promoter"\|"cautious", look: string\|null, dealer_account, seed_amount}` | owner. An **NPC** dealer, controlled by `dealer_account`, always on autopilot, off the floor. Seed from the owner's in-contract balance, minted as the owner's LP shares (`"0"`: empty pool). |
| `launch_floor` | `{dealer_ids: string[]}` | owner, only while nobody is seated. `core::Floor::launch`: seats them in order (seat 1 first) at their seat's minimum rent, rent accruing from now (no prepay). Retired tables are refused. |
| `register_npcs` | `{accounts: string[]}` | owner. Appends NPC gamblers (already registered ones are skipped); panics past `MAX_NPC_GAMBLERS = 24` in total. No removal. |
| `migrate` | `{}` | `#[private]` init, run once as the init call of the v3 deploy over a v2 state (`near contract deploy … with-init-call migrate`). Keeps every collection; adds an empty NPC list and retired list. A v3 state does not read as v2, so a second call panics. |

## Money in and out

- **Deposit**: `ft_transfer_call({receiver_id: floor, amount, msg})` on the token (1 yocto). `ft_on_transfer` accepts
  only the configured token: `msg = ""` credits the sender's balance; `msg = "{\"invest\":\"<dealer_id>\"}"` buys LP
  shares for the sender (refused for NPC gamblers); `msg = "{\"credit_npc\":\"<account>\"}"` is the NPC salary:
  accepted only when the token sender is the config `keeper` and `<account>` is a registered NPC gambler whose
  balance stays ≤ `GAMBLER_MAX_BALANCE` (200 tUSDC) after the credit; anything else panics and the token refunds.
- `withdraw({amount})` — **1 yocto**. Debits now, `ft_transfer` to the caller, credited back if the transfer fails.
  Send ≥ 50 TGas. The caller must be registered on tUSDC.

## LP shares and seat leases (NEP-245 subset)

Token ids: a dealer id (LP shares of that dealer's pool) or `seat-<n>` (the lease of seat n: supply 1 while
seated, 0 while empty, held by the seated dealer's controller).

- `invest({dealer_id, amount})` → shares minted (`"U128"`). From the in-contract balance, price `core::Pool::buy_shares`.
- `divest({dealer_id, shares})` → paid (`"U128"`) to the balance, price `core::Pool::sell_shares` (free bankroll only:
  money reserved for open sessions never leaves).
- `mt_transfer({receiver_id, token_id, amount, approval: null, memo?})` — **1 yocto**, LP tokens only. Seat tokens
  move only through `buy_seat`, so a seat never sits with an account whose dealer can't use it.
- Views: `mt_balance_of({account_id, token_id})`, `mt_batch_balance_of({account_id, token_ids})`,
  `mt_supply({token_id})` (`null`: unknown token).

NEP-297 events, `standard: "nep245"`, `version: "1.0.0"`: `mt_mint` (invest, seated), `mt_burn` (divest,
evicted), `mt_transfer` (LP transfer, seat sale):

```json
{"event":"mt_mint","data":[{"owner_id":"alice.testnet","token_ids":["ada"],"amounts":["1000000000000"]}]}
{"event":"mt_transfer","data":[{"old_owner_id":"bob.testnet","new_owner_id":"alice.testnet","token_ids":["seat-2"],"amounts":["1"]}]}
```

## Tables (dealers)

| Method | Args | Who | Notes |
|---|---|---|---|
| `open_table` | `{id, name, game: "dice"\|"roulette"\|"blackjack"\|"poker", temperament, look, seed_amount}` | any player | `core::validate_new_table` (seed ≥ 200 tUSDC, ≤ 16 dealers); `look` ∈ `gold-visor`, `top-hat`, `beanie`, `bare`. Seed from the caller's balance, caller = controller and founding LP. Off the floor, on autopilot with `temperament`. Returns nothing. |
| `set_offer` | `{dealer_id, rake_bp, max_bet, boost_secs}` | controller | `core::clamp_owner_offer` (total edge 1–5 %, max bet ≤ what the pool covers, boost ≤ 15 min, one boost per hour). Turns autopilot **off**. Returns the `Offer`. Applies to sessions opened afterwards. |
| `set_autopilot` | `{dealer_id, temperament: string\|null}` | controller (player tables) | `null`: manual (keeps the current offer). A temperament: autopilot on with it (a temperament *change* follows `set_temperament`'s hourly limit). |
| `set_temperament` | `{dealer_id, temperament}` | controller | at most once an hour (`core::can_set_temperament`). |
| `reprice` | `{dealer_id}` | keeper or controller | autopilot only. `core::reprice(game, pool, stats_1h, traits, rivals, now)`; rivals = other seated dealers of the same game. Returns the `Offer`. |
| `rent_bid` | `{dealer_id}` | keeper or controller | NPC dealers only. Settles rent, runs `core::rent_bid`, applies it through `bid_for_seat`. Returns the `RentDecision` (`{"action":{"outbid":"1000000"},"reason":"bidding_for_seat"}`, `{"action":"keep","reason":null}`). |
| `set_table_name` | `{dealer_id, name}` | controller | same name rule as `open_table` (`core::floor::validate_table_name`: 1–32 bytes, no control characters, no surrounding spaces). Logs `renamed`. |
| `retire_table` | `{dealer_id}` | controller | the table must be off the floor, with no open session and nothing reserved (force-closed sessions revealed), and the controller must hold every LP share (other LPs divest first). The controller's shares are paid the whole bankroll; a bankroll left with no shares at all goes to the jackpot. The table leaves `get_lobby`, `get_player.tables` and the 16-dealer count, shows in `get_retired`, keeps its id, and refuses every later call (`"the table is retired"`). At most 64 retired tables. Returns the amount paid (`"U128"`). |

`Offer` = `{"rake_bp": 300, "max_bet": "9000000", "boost_until": 0, "reason": "steady"}` (`reason` `"owner"` for
`set_offer`).

Stats = 6 buckets × 10 min (last hour), fed by `settle_session` (rounds, volume, players' net, last bet time) and
`open_session` (gamblers = sessions opened), plus LP flows and rent paid.

## Floor (seats, rent, market)

| Method | Args | Who | Notes |
|---|---|---|---|
| `collect_rent` | `{}` | anyone | settles every seated dealer's rent into the jackpot; evicts who can't pay (`unpaid_rent`). The keeper calls it every minute. Rent is also settled lazily on every interaction with a dealer. |
| `bid_for_seat` | `{dealer_id, rent_per_hour}` | controller | `core::Floor::bid_for_seat` after settling all rent: off the floor → best-traffic empty seat whose minimum it covers, or outbid the weakest seat (≥ 110 % of the lowest rent), prepaying 2 h from the pool into the jackpot; seated → change own rent (≥ the seat's minimum). 30 min cooldown after an eviction. Returns the seat number (1..6). |
| `list_seat` | `{dealer_id, price: "U128"\|null}` | controller of a seated dealer | lists the seat for sale at `price` (`null` unlists). |
| `buy_seat` | `{seat, dealer_id, max_price}` | controller of an off-floor `dealer_id` | pays the ask (≤ `max_price`) from the caller's balance to the seller controller's balance; `dealer_id` takes the seat with its rent and prepaid time; the seller's dealer goes off the floor (no cooldown). |

Seat minimum rents: `MIN_RENT_PER_HOUR × SEAT_TRAFFIC_BP[n]` = 1.5, 1.3, 1.1, 1.0, 0.8, 0.6 tUSDC/h (seat 1 → 6).

## Sessions (docs/sessions.md)

The bytes signed and hashed are built by `core_rules::session` (`ticket_message`, `state_message`, `chain_step`).

| Method | Args | Who |
|---|---|---|
| `open_session` | `{ticket: SessionTicket, server_sig: hex}` | `ticket.player` (relayed) |
| `settle_session` | `{batch: SettleBatch}` | anyone (the server) |
| `close_session` | `{session_id, server_seed: hex}` | anyone holding the seed (the server after its final settle, or the player) |
| `force_close` | `{session_id, state: SessionState, server_sig: hex}` | the player, after `SESSION_TIMEOUT_SECS = 600` without open/settle |
| `claim_unrevealed` | `{session_id}` | the player, after `REVEAL_TIMEOUT_SECS = 3600` without open/settle, if rounds were played and no seed was revealed |

`SessionTicket` (core serde):
`{"session_id": "s-…", "player": "alice.testnet", "dealer_id": "ada", "game": "dice", "lock": "10000000",
"server_seed_hash": "hex", "client_seed": "lucky-7", "rake_bp": 300, "max_bet": "1000000", "max_win": "100000000",
"expires_at": 1762190120}`.
`SessionState`: `{"session_id", "nonce": 12, "balance": "9500000", "chain": "hex"}`.
`SettleBatch`: `{"session_id", "upto_nonce": 12, "balance", "chain", "rounds": CompactRound[], "server_sig": "hex"}`.
`CompactRound`: `{"nonce": 12, "bet": {"dice":{"chance_bp":5000,"over":true}}, "stake": "100000", "actions": [],
"outcome": {"dice":{"roll":4210}}, "payout": "0"}` (blackjack: `"bet": "blackjack"`, `"actions": ["hit","stand"]`,
`"outcome": {"blackjack": BjState}`).
Roulette `bet`: `{"roulette": RouletteBet}` for one bet, or `{"roulette_spots": [{"bet": RouletteBet, "stake":
"100000"}, …]}` for 1–20 chip stacks settled by one spin (`stake` = their total; each spot pays and is raked as if
played alone; `outcome` stays `{"roulette":{"pocket":n}}`). `RouletteBet`: `"red"|"black"|"odd"|"even"|"low"|"high"`,
`{"straight":n}` 35:1, `{"split":[a,b]}` 17:1 (adjacent, smaller first, incl. `[0,1|2|3]`), `{"street":n}` 11:1
(n = 1, 4 … 34), `{"corner":n}` 8:1 (n, n+1, n+3, n+4), `{"six_line":n}` 5:1 (n..n+5, n = 1, 4 … 31),
`{"dozen":d}`, `{"column":c}` 2:1. Borsh variants are only appended, so older rounds keep their bytes.

**Poker** (docs/poker-api.md): each buy-in is a session (`lock` = buy-in, `max_bet` = the most one hand may take
from the stack, so `lock ≤ max_bet ≤` the dealer's max bet, where `worst_case_multiple("poker") = 6` seats);
each hand is one round per player who put chips in: `"bet": {"poker":{"table":"<table>","hand":7}}`, `stake` =
chips put in the pot, `payout` = chips won after rake (0 for a loser), `"outcome": {"poker":{"hand_seed_hash":
"hex","history_hash":"hex","seat":2,"board":["As","Kd","7h","2c","9s"]}}`. Across a hand's rounds the pool gets
Σ stakes − Σ payouts = the rake (`rake_bounds("poker") = 0..500` bp). The contract checks bounds only
(`0 ≤ stake ≤ max_bet`, `payout ≤ 6 × stake`, the running balance ≤ `lock + max_win`); it never replays a hand
(hand seeds are per hand): the server signature and the hash chain bind every round, and
`core_rules::session::verify_poker_session` replays them off chain from the published hand histories.

**open_session** checks: server signature over `ticket_message(ticket)`; `now ≤ expires_at`; caller = `player`;
`session_id` 1–64 chars of `[A-Za-z0-9_-]`, unused; `client_seed_is_valid`; no other `open` session for the player;
the dealer is seated (rent settled first), open, of `game`; `lock ≥ 0.1 tUSDC` and ≤ balance;
`rake_bp` within `rake_bounds(game)` and ≥ the dealer's rake in force now; `0.1 tUSDC ≤ max_bet ≤` the dealer's max
bet now (poker: also `lock ≤ max_bet`); `max_win ≤ session_max_win(lock, pool.free)`. Then `lock` leaves the balance (escrow), the pool reserves
`max_win`, the offer is frozen.

**settle_session** checks: session `open`; rounds non-empty, nonces `settled_nonce+1 ..= upto_nonce`; each round
of the session's game with `core::session::stake_is_valid` (`0.1 tUSDC ≤ stake ≤ max_bet`; a multi-spot spin also
needs every spot ≥ 0.1 tUSDC and the spots summing to `stake`), wager ≤ running balance, payout ≤
`worst_case_payout`; running balance (`− wager + payout`) ends at `balance` ≤ `lock + max_win`; `chain_step` over the
rounds from the stored chain gives `chain`; server signature over `state_message({session_id, nonce: upto_nonce,
balance, chain})`. Then the difference moves between escrow and pool (the reserve always equals
`lock + max_win − escrow`), the dealer's stats are fed, and **the jackpot is drawn for every round**:
`core::draw_jackpot(pot, chain_n, wager)` where `chain_n` is the hash chain right after that round. (The round
seed is secret until close; `chain_n` is fixed by the committed seeds and the player's choices, unpredictable to
the player and not steerable by the server, and public at settle.) Wins go to the player's balance.

**close_session**: `sha256(server_seed) == server_seed_hash`. Open → escrow to the player's balance, reserve back to
the pool; force-closed → reserve back to the pool. Status `closed`, seed stored, event `session_revealed`. The last
settled state counts: the player should settle (server) before closing.

**force_close**: signed `state` with `nonce ≥ settled_nonce` (equal: must match the settled balance and chain),
`balance ≤ lock + max_win`. Pays `balance` to the player. Nonce 0 → `closed` (nothing to reveal). Otherwise status
`force_closed`: the reserve stays held until the seed is revealed (`close_session`) or `claim_unrevealed` pays it
to the player (`lock + max_win` in total: the server loses for hiding its seed).

Trust limits: `force_close` accepts any server-signed state newer than the last settle, so the server should
settle often (every 50 rounds / 60 s) and close only after a final settle: `close_session` makes the last settled
state final.

Statuses: `"open" | "force_closed" | "closed" | "forfeited"`. Done = `closed` or `forfeited`.

## Views

### `get_floor()`

```json
{
  "seats": [
    {"seat": 1, "token_id": "seat-1", "traffic_bp": 15000, "min_rent": "1500000",
     "dealer_id": "ada", "controller": "ada.tilthouse.testnet", "rent_per_hour": "1500000",
     "seated_at": 1762190000, "paid_until": 1762197200, "rent_owed": "0", "ask": null},
    {"seat": 6, "token_id": "seat-6", "traffic_bp": 6000, "min_rent": "600000",
     "dealer_id": null, "controller": null, "rent_per_hour": null, "seated_at": null, "paid_until": null,
     "rent_owed": "0", "ask": null}
  ],
  "lowest_rent": "1000000",       // null when nobody is seated
  "outbid_min": "600000",         // cheapest empty seat's minimum, else ⌈lowest × 1.1⌉
  "jackpot": "12000000", "jackpot_odds_unit": "2000000000", "min_jackpot": "10000000"
}
```

### `get_lobby()` → `DealerView[]` (by id)

```json
{
  "id": "ada", "name": "Ada", "game": "dice", "look": "gold-visor",
  "npc": true, "controller": "ada.tilthouse.testnet",
  "autopilot": true, "temperament": "greedy", "traits": {"greed": 85, "caution": 30, "promo": 10},
  "temperament_changed_at": 0, "last_boost_at": 0,
  "rake_bp": 420, "offer_rake_bp": 420, "base_edge_bp": 0, "total_edge_bp": 420,
  "min_bet": "100000", "max_bet": "9000000", "worst_case_multiple": "100",
  "boost_until": 0, "reason": "steady", "reason_text": "steady: nothing to react to", "repriced_at": 1762190000,
  "open": true,
  "seated": true, "seat": 1, "seat_traffic_bp": 15000, "rent_per_hour": "1500000", "rent_owed": "250",
  "paid_until": 1762190000, "ask": null, "cooldown_until": 0,
  "bankroll": "2000000000", "reserved": "100000000", "open_stakes": "0", "shares": "2000000000000000",
  "share_price_buy": "1000000", "share_price_sell": "950000",
  "open_sessions": 1,
  "earnings_1h": "1200000", "rent_1h": "1500000", "pnl_1h": "-300000",
  "stats": {"bets_1h": 40, "volume_1h": "4000000", "player_net_1h": "-1200000", "idle_secs": 12,
            "inflow_1h": "0", "game_share_bp": 6000, "gamblers_1h": 3}
}
```

`rake_bp` = rake in force now (the game's minimum during a boost); `offer_rake_bp` = the dealer's set rake.
`max_bet` = min(offer max bet, free / worst_case_multiple). `seat`, `rent_per_hour`, `paid_until`, `ask`: null off
the floor. `earnings_1h` = −`player_net_1h` (what players lost at the table), `pnl_1h` = earnings − rent paid.
`game_share_bp` = this table's share of the bets at seated tables of its game over the hour (10 000 if none).

### `get_retired()` → `DealerView[]`

Retired tables (`retire_table`), oldest retirement first, same shape as `get_lobby` (bankroll and shares `"0"`).

### `get_npcs()` → `string[]`

Registered NPC gamblers, in registration order.

### `get_player({account_id})` → `PlayerView` (unknown player = zeros)

```json
{"account_id": "alice.testnet", "balance": "5000000",
 "lp": [{"dealer_id": "ada", "shares": "1000000", "value": "1"}],
 "tables": ["alice-dice"], "seats": [3],
 "open_session": "s-17", "sessions": ["s-3", "s-9", "s-17"]}
```

`tables` = dealers the account controls; `seats` = seat numbers it holds (`seat-<n>` tokens); `sessions` = the last
20 session ids, oldest first (older finished sessions are deleted from storage; their data stays in the txs).

### `get_session({session_id})` → `SessionView | null`

```json
{"id": "s-17", "player": "alice.testnet", "dealer_id": "ada", "game": "dice", "status": "open",
 "lock": "10000000", "rake_bp": 300, "max_bet": "1000000", "max_win": "100000000",
 "server_seed_hash": "hex", "client_seed": "lucky-7", "server_seed": null,
 "opened_at": 1762190000, "last_settle_at": 1762190060, "closed_at": 0,
 "settled_nonce": 50, "balance": "9500000", "reserve": "100500000", "chain": "hex",
 "wagered": "5000000", "paid": "4500000", "jackpot_won": "0", "paid_out": "0",
 "force_close_after": 1762190660, "claim_after": 1762193660}
```

`balance` = escrow (signed balance at `settled_nonce`, or paid at force close); `paid_out` = paid to the player's
balance so far (jackpots excluded).

### `get_history({dealer_id, from: number|null, limit: number})` → `HistoryEntry[]`

Last 100 entries per dealer, oldest first; `limit` ≤ 50.

```json
{"seq": 41, "t": 1762190000, "kind": "evicted", "text": "lost my seat: outbid",
 "reason": "steady", "reason_text": "…", "rake_bp": 300, "max_bet": "9000000", "boost_until": 0,
 "account_id": null, "amount": "0", "detail": "outbid"}
```

`kind`: `reprice`, `boost`, `offer` (owner `set_offer`), `autopilot`, `temperament`, `bust`, `reopen`, `invest`,
`divest`, `opened`, `seated` (`amount` = prepay, `detail` = `"seat-<n>"`), `evicted` (`detail` = `unpaid_rent` |
`outbid`; `amount` = rent paid at eviction), `rent` (seated dealer's rent change, `amount` = new rent/h),
`listed` (`amount` = ask, 0 = unlisted), `sold` / `bought` (`amount` = price, `detail` = `"seat-<n>"`, `account_id` = the other side), `jackpot` (`account_id` won `amount`), `renamed` (`detail` = new name), `retired` (`amount` = paid to the controller).

### `get_config()`

```json
{"owner": "tilthouse.testnet", "token": "tusdc.tilthouse.testnet", "keeper": "tilthouse.testnet",
 "server_pubkey_hex": "…", "min_bet": "100000", "history_per_dealer": 100, "sessions_per_player": 20,
 "session_timeout_secs": 600, "reveal_timeout_secs": 3600, "dealer_ids": ["ada", "bruno"]}
```

## Events (NEP-297, `standard: "tilthouse"`, `version: "2.0.0"`)

`EVENT_JSON:{"standard":"tilthouse","version":"2.0.0","event":…,"data":{…}}`

| event | data |
|---|---|
| `opened` | `{dealer_id, controller, game, seed_amount}` |
| `seated` | `{dealer_id, seat, rent_per_hour, prepaid}` |
| `evicted` | `{dealer_id, seat, reason: "unpaid_rent"\|"outbid", paid}` |
| `rent_changed` | `{dealer_id, seat, rent_per_hour}` |
| `rent_collected` | `{total}` (only when > 0) |
| `seat_listed` | `{dealer_id, seat, price: string\|null}` |
| `seat_sold` | `{seat, seller, buyer, from_dealer, to_dealer, price}` |
| `offer` | `{dealer_id, rake_bp, max_bet, boost_until, reason}` (set_offer, reprice) |
| `session_opened` | `{session_id, player, dealer_id, lock, max_win, rake_bp, max_bet}` |
| `session_settled` | `{session_id, upto_nonce, balance, rounds}` |
| `jackpot` | `{account_id, dealer_id, session_id, nonce, amount}` |
| `session_force_closed` | `{session_id, nonce, balance}` |
| `session_revealed` | `{session_id, server_seed, paid_out}` |
| `session_forfeited` | `{session_id, paid}` |
| `npcs_registered` | `{account_ids}` (newly added only) |
| `npc_credited` | `{account_id, amount}` (keeper salary) |
| `table_renamed` | `{dealer_id, name}` |
| `table_retired` | `{dealer_id, controller, paid, to_jackpot}` |

## Verifying a session

From chain data only: `server_seed_hash` and `client_seed` (open tx args / `get_session`), the round lists
(`settle_session` tx args), the revealed `server_seed` (`session_revealed`). `core_rules::session::verify_session`
replays everything; jackpot draws replay with `jackpot_hit(chain_n, wager)`. Poker sessions:
`verify_poker_session(server_seed, session, player, batches, hand_histories)`.

## Build and verify the code

`cd contract && cargo near build reproducible-wasm` (committed tree, Docker) builds in the image pinned in
`contract/Cargo.toml` (`[package.metadata.near.reproducible_build]`, by digest) and writes
`target/near/tilt_house_contract/tilt_house_contract.wasm`. The deployed code hash is `base58(sha256(wasm))`
(`view_account.code_hash`); `contract_source_metadata()` (NEP-330) returns the version, the repo link
(`https://github.com/STOOOKEEE/tilt-house`) and the build command, image and commit. `scripts/verify-deployment.sh`
rebuilds and compares with the chain.
