# House contract API (`contract/`, crate `tilt-house-contract`)

Deployed to `house.tilthouse.testnet` (testnet only). All rules come from `core_rules`; this file is
the JSON contract between the chain, the web, the relayer and the agents.

## Conventions

- **Amounts** (token base units, 6 decimals; LP shares) are `u128` as **decimal strings** (`"100000"` = 0.10 tUSDC).
- **Times** are **seconds** since the Unix epoch (block time), JSON numbers. `boost_until = 0`: no boost.
- **Round ids** are JSON numbers (`u64`, start at 1). History `seq` too.
- **Dealer id** = NEP-245 token id = short lowercase name (`"ada"`).
- Errors are panics with a readable message (`"stake below the table minimum"`); a panicking call changes nothing.
- Money token: our NEP-141 test token **tUSDC** `tusdc.tilthouse.testnet` (6 decimals) on testnet; the token
  account is an init argument, so any NEP-141 works.

## Init and owner

| Method | Args | Notes |
|---|---|---|
| `new` | `{owner: AccountId, token: AccountId, outlayer: AccountId, vrf_pubkey_hex: string (64 hex), vrf_source: object}` | `#[init]`. `vrf_source` is the OutLayer `source` JSON, e.g. `{"Project":{"project_id":"tilthouse.testnet/tilt-vrf","version_key":"898b…3d7a"}}` |
| `add_dealer` | `{id, name, game: "dice"\|"roulette"\|"blackjack", temperament: "greedy"\|"promoter"\|"cautious", dealer_account: AccountId, seed_amount: "U128"}` | owner only. `id`: 2–16 chars `[a-z0-9-]`, unique. **The seed is taken from the owner's in-contract balance** (deposit it first with `ft_transfer_call`, msg `""`) and minted as the owner's LP shares; `"0"` leaves the pool empty (closed). |
| `set_vrf_pubkey` | `{vrf_pubkey_hex}` | owner only (OutLayer key rotation). |
| `set_vrf_source` | `{vrf_source: object}` | owner only (new pinned VRF version). |

Temperaments are the core presets (`core_rules::dealer_rules::{GREEDY, PROMOTER, CAUTIOUS}`).

## Money in and out

- **Deposit**: the player calls the token: `ft_transfer_call({receiver_id: house, amount, msg})` (1 yocto). The house's
  `ft_on_transfer(sender_id, amount, msg)` accepts only calls from the configured token:
  - `msg = ""`: credits `amount` to the sender's in-contract balance.
  - `msg = "{\"invest\":\"<dealer_id>\"}"`: buys LP shares of that dealer for the sender (as `invest`).
  - anything else, an unknown dealer or an amount too small for one share: panics, the token refunds the transfer.
- `withdraw({amount: "U128"})` — **1 yocto** (full-access key). Debits the balance and sends `ft_transfer` to the caller;
  if the transfer fails the balance is credited back. Returns nothing useful (promise). Send ≥ 50 TGas. The caller must
  be registered on the token (tUSDC `storage_deposit`), or the transfer fails and is credited back.
- The contract pays the storage of every player (testnet): no `storage_deposit` on the house.

## LP shares (NEP-245 subset, token id = dealer id)

- `invest({dealer_id, amount: "U128"})` → `"U128"` shares minted. From the in-contract balance. Price: `core::Pool::buy_shares`
  (bankroll + open stakes). Emits `mt_mint`. Reopens a closed table when the pool can cover a min bet again.
- `divest({dealer_id, shares: "U128"})` → `"U128"` paid to the in-contract balance. Price: `core::Pool::sell_shares`
  (bankroll − reserved: money backing open bets never leaves). Emits `mt_burn`.
- `mt_transfer({receiver_id, token_id, amount, approval: null, memo?: string})` — **1 yocto**. `approval` must be null.
  Emits `mt_transfer`.
- Views: `mt_balance_of({account_id, token_id})` → `"U128"`; `mt_batch_balance_of({account_id, token_ids: string[]})` →
  `"U128"[]`; `mt_supply({token_id})` → `"U128" | null` (null: unknown dealer).

Events are NEP-297 logs `EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":…,"data":[…]}`:

```json
{"event":"mt_mint","data":[{"owner_id":"alice.testnet","token_ids":["ada"],"amounts":["1000000000000"]}]}
{"event":"mt_burn","data":[{"owner_id":"alice.testnet","token_ids":["ada"],"amounts":["500000000000"]}]}
{"event":"mt_transfer","data":[{"old_owner_id":"alice.testnet","new_owner_id":"bob.testnet","token_ids":["ada"],"amounts":["1"],"memo":"gift"}]}
```

## Dealers

- `reprice({dealer_id})` → `Offer` (below). Callable **only by that dealer's `dealer_account`** (function-call key is
  enough). Runs `core::reprice(game, pool, stats_1h, temperament, now)`; the result is always inside core's bounds.
- Stats = 6 buckets × 10 min (the last hour): bets, volume (total wagered), players' net, LP inflow; `idle_secs` since the
  last settled bet (or since the dealer was added).
- Open/closed = `core::Pool::is_open(min_bet, game)` (free bankroll covers a min bet at the game's worst case).
  The contract logs `bust` / `reopen` in the dealer's history on each transition.

## Play

Function-call key allowed, **no deposit**; these are the methods the relayer forwards as meta-transactions.
Each needs **prepaid gas ≥ 150 TGas** (send 200 TGas). One open round per player at a time.

| Method | Args | Returns |
|---|---|---|
| `bet_dice` | `{dealer_id, stake: "U128", chance_bp: 100..=9800, over: bool}` | round id |
| `bet_roulette` | `{dealer_id, stake, bet: RouletteBet}` | round id |
| `bj_deal` | `{dealer_id, stake}` | round id |
| `bj_hit` / `bj_stand` | `{round_id}` | nothing |
| `bj_double` | `{round_id}` | nothing; takes another `stake` from the balance |
| `refund_stuck_round` | `{round_id}` | nothing; anyone may call |

`RouletteBet` (core serde): `"red"`, `"black"`, `"odd"`, `"even"`, `"low"`, `"high"`, `{"straight": 0..=36}`,
`{"dozen": 1..=3}`, `{"column": 1..=3}`.

A bet is refused unless: the dealer exists and is open, `min_bet ≤ stake ≤ max_bet` (lobby `max_bet`), the balance
covers it, the pool's free bankroll covers `worst_case_payout` (reserved until the round ends), and the player has no
open round. The rake locked into the round is the dealer's rake in force when the bet is placed (boost included).

Flow: stake → `round.status = "waiting_vrf"` → the house calls OutLayer `request_execution` (attaching 0.01 NEAR of its
own) with seed `round-{id}-{step}` (step 0 = bet/deal, then 1, 2… per blackjack move) → `on_vrf` (private) checks the
proof and the round advances:

- dice / roulette: settled at once (`"settled"`, `payout` credited to the balance).
- blackjack: after the deal, `"player_turn"` (or `"settled"` on a natural); `bj_hit` → new card (bust or 21 end the
  hand), `bj_double` → one card then the dealer plays, `bj_stand` → the dealer plays. Each move is its own VRF step.
  Only the round's player may move; **after 600 s in `player_turn` anyone may `bj_stand`** so an abandoned hand cannot
  lock the pool's reserve forever.

VRF checks (any failure = step `failed`, never a panic): exactly one result; alpha is exactly
`vrf:{digits}:{signer}:round-{id}-{step}` where `signer` is the account that signed the transaction that requested the
step (stored with the round; for a relayed meta-transaction the delegate sender, i.e. the player); Ed25519 signature over
alpha with the configured key; `value == sha256(signature)`. The 32-byte output seeds `core::Rng`.

`refund_stuck_round` refunds the whole wager (double included) to the player and releases the pool's reserve when the
round is `"failed"` (now), or `"waiting_vrf"` for ≥ 120 s. A late VRF answer for a refunded round is ignored. A failed
round stays the player's `open_round` (no new bet) until someone calls `refund_stuck_round`; clients should call it as
soon as they see `"failed"`.

Statuses: `"waiting_vrf" | "player_turn" | "failed" | "settled" | "refunded"`. Done = `settled` or `refunded`.

## Views

### `get_lobby()` → `DealerView[]` (by id)

```json
{
  "id": "ada", "name": "Ada", "game": "dice", "temperament": "greedy",
  "traits": {"greed": 85, "caution": 30, "promo": 10},
  "dealer_account": "ada.tilthouse.testnet",
  "rake_bp": 420,               // rake in force now (the game's minimum during a boost)
  "offer_rake_bp": 420,         // rake the dealer set (outside a boost)
  "base_edge_bp": 0,            // core base_edge_bp(game)
  "total_edge_bp": 420,         // base_edge_bp + rake_bp (upper bound of the true edge)
  "min_bet": "100000",
  "max_bet": "9000000",         // min(offer max bet, free / worst_case_multiple)
  "worst_case_multiple": "100", // core worst_case_multiple(game)
  "boost_until": 0,
  "reason": "steady", "reason_text": "steady: nothing to react to",
  "repriced_at": 1762190000,
  "open": true,
  "bankroll": "2000000000", "reserved": "0", "open_stakes": "0",
  "shares": "2000000000000000",
  "share_price_buy": "1000000",  // millionths of the launch price: (bankroll + open_stakes) per launch share
  "share_price_sell": "1000000", // free bankroll (bankroll − reserved) per launch share
  "stats": {"bets_1h": 0, "volume_1h": "0", "player_net_1h": "0", "idle_secs": 12, "inflow_1h": "2000000000"}
}
```

"Closed · needs X" = `min_bet × worst_case_multiple − (bankroll − reserved)`.

### `get_player({account_id})` → `PlayerView` (always an object; unknown player = zeros)

```json
{"account_id": "alice.testnet", "balance": "5000000",
 "lp": [{"dealer_id": "ada", "shares": "1000000", "value": "1"}],
 "open_round": 12, "last_round": 12, "rounds": [3, 7, 12]}
```

`lp` lists dealers where the player holds shares; `value` = sell value now. `open_round` = the round not yet
`settled`/`refunded` (null if none); `last_round` = the latest round, whatever its status. `rounds` = the player's last
50 round ids, oldest first (older rounds are deleted from storage).

### `get_round({round_id})` → `RoundView | null`

Moves are legal when `status == "player_turn"` (double: also `bj.player.length == 2`); `"waiting_vrf"` = waiting for
OutLayer.

```json
{
  "id": 12, "player": "alice.testnet", "dealer_id": "eve", "game": "blackjack",
  "bet": "blackjack",                  // core Bet: {"dice":{"chance_bp":5000,"over":true}} | {"roulette":"red"} | "blackjack"
  "stake": "1000000", "wager": "2000000", // wager = total at risk (2 × stake after a double)
  "rake_bp": 120, "status": "settled", "step": 2,
  "created_at": 1762190000, "updated_at": 1762190021,
  "roll": null, "pocket": null,        // dice roll 0..9999 / roulette pocket 0..36 once known
  "bj": {"player": [10, 1], "dealer": [9, 7, 5], "doubled": false, "done": true},
  "payout": "4950000",                 // after rake, null until settled ("0" on a loss)
  "proofs": [{"step": 0, "alpha": "vrf:6802:alice.testnet:round-12-0", "signature_hex": "…", "output_hex": "…"}],
  "error": null                        // why the last step failed, when status = failed
}
```

### `get_history({dealer_id, from: number | null, limit: number})` → `HistoryEntry[]`

The dealer's log, the last 100 entries kept, oldest first. `from` = first `seq` wanted (null: the latest `limit`);
`limit` ≤ 50.

```json
{"seq": 41, "t": 1762190000, "kind": "boost",
 "text": "cutting my edge: nobody has played for 20 min · boost on",
 "reason": "idle", "reason_text": "cutting my edge: nobody has played for 20 min",
 "rake_bp": 300, "max_bet": "9000000", "boost_until": 1762190810,
 "account_id": null, "amount": null}
```

Every entry carries the dealer's offer at that time (`reason`, `rake_bp` as set by the dealer, `max_bet`, `boost_until`)
and a display line `text` (same wording as the simulator's events).
`kind`: `"reprice"` (the reason changed), `"boost"` (a reprice that starts a boost), `"bust"` (`amount` = free bankroll
still needed to reopen), `"reopen"`, `"invest"` / `"divest"` (`account_id`, `amount` = tUSDC in / out; the launch seed is
the owner's first `invest`). Rounds are not in this log (see `get_round`).

### `get_config()`

```json
{"owner": "tilthouse.testnet", "token": "tusdc.tilthouse.testnet", "outlayer": "outlayer.testnet",
 "vrf_pubkey_hex": "c0c5…cfa8", "vrf_source": {"Project": {…}},
 "min_bet": "100000", "refund_after_secs": 120, "abandon_after_secs": 600,
 "rounds_per_player": 50, "history_per_dealer": 100, "next_round_id": 13, "dealer_ids": ["ada", "bruno"]}
```

### `Offer` (return of `reprice`)

`{"rake_bp": 300, "max_bet": "9000000", "boost_until": 0, "reason": "steady"}`.
