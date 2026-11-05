# Floor: core API (`core_rules`)

Pure logic for docs/floor.md rules 1–3, 5–7 and the checks of rule 4. Amounts are base units
(`u128`, JSON strings), times are seconds. Every `Err` leaves floor and pool untouched.

## `core_rules::floor`

Constants: `SEATS = 6`, `MIN_RENT_PER_HOUR = 1_000_000`, `PREPAY_HOURS = 2`, `OUTBID_BP = 11_000`,
`COOLDOWN_SECS = 1800`, `MIN_TABLE_SEED = 200_000_000`, `MAX_DEALERS = 16`,
`TEMPERAMENT_COOLDOWN_SECS = 3600`, `MAX_TABLE_ID_LEN = 32`, `MAX_TABLE_NAME_LEN = 32`, `HOUR_SECS`.

- `Floor { seats: [Option<Seat>; SEATS], jackpot: u128 }` (borsh + serde, `Default` = empty).
- `Seat { dealer_id: String, rent_per_hour: u128, seated_at: u64, paid_until: u64 }`.
- `Floor::launch(&[&str], now) -> Floor`: seats them at `MIN_RENT_PER_HOUR`, no prepay, rent from `now`.
- `floor.accrue_rent(dealer_id, &mut Pool, now) -> RentOutcome { paid, evicted: Option<EvictReason> }`:
  settles rent (per second, rounded up) from the pool's free bankroll into `floor.jackpot`;
  on shortfall pays all the free bankroll and evicts (`UnpaidRent`). Not seated: no-op.
- `floor.bid_for_seat(dealer_id, rent, &mut Pool, now, cooldown_until) -> Result<BidOutcome { seat, evicted: Option<String>, paid }, FloorError>`:
  off the floor: empty seat, or the weakest seat if `rent >= outbid_min()`; prepays 2 h into
  the jackpot. Seated: changes its own rent (≥ min); the prepaid time left is converted at the
  new rate (no refund, no free protection). **Settle rent first**: if the bidder or the seat it
  would take has rent due, returns `RentDue` (contract: call `accrue_rent` for every seated
  dealer, i.e. `collect_rent`, before bidding).
- Caller duties: on any eviction (`RentOutcome.evicted`, `BidOutcome.evicted`) store
  `cooldown_until(now)` for the evicted dealer and emit `evicted` with `EvictReason::code()`
  (`unpaid_rent` | `outbid`); the bidder's cooldown is passed back to `bid_for_seat`.
- Views: `seat_of(id) -> Option<usize>`, `seat(id)`, `seated()`, `empty_seats()`,
  `rent_owed(id, now)`, `lowest_rent() -> Option<u128>` (None if nobody seated),
  `outbid_min()` (min rent while a seat is empty, else ⌈lowest × 1.1⌉), `weakest_seat()`
  (lowest rent, ties: most recently seated, then highest index),
  `view(id, cooldown_until) -> FloorView { my_rent, lowest_rent, empty_seats, outbid_min, cooldown_until }`.
- `validate_new_table(id, name, seed_amount, dealers) -> Result<(), FloorError>` (id `[a-z0-9-]{1,32}`,
  name 1–32 bytes, no control chars, no outer spaces; seed ≥ min; `dealers < MAX_DEALERS`).
  `can_set_temperament(last_change, now) -> bool` (`last_change = 0`: never).
- `FloorError`: `RentTooLow`, `RentTooHigh`, `CannotPrepay { need }`, `BidTooLow { min }`,
  `Cooldown { until }`, `RentDue { dealer_id }`, `SeedTooLow`, `TooManyDealers`, `BadTableId`,
  `BadTableName` (implements `Display`).

## `core_rules::jackpot`

`JACKPOT_ODDS_UNIT = 2_000_000_000`, `MIN_JACKPOT = 10_000_000`, `JACKPOT_DOMAIN`.

- `jackpot_hit(&[u8; 32], stake) -> bool`: reads `sha256(vrf_output || "tilt-house/jackpot")`,
  independent of the game's draws on the same output; `p = min(1, stake / JACKPOT_ODDS_UNIT)`.
- `draw_jackpot(&mut pot, &vrf_output, stake) -> u128`: the whole pot (pot becomes 0) or 0;
  never pays a pot under `MIN_JACKPOT`. Call once per settled round with the round's last
  VRF output and its total stake; pay the result to the player and emit `jackpot`.

## `core_rules::dealer_rules`

- `reprice(game, &Pool, &Stats, &Temperament, rivals: &[RivalOffer], now) -> Offer`.
  `RivalOffer { edge_bp: u16, boost_until: u64 }`, build with `RivalOffer::new(game, &offer, now)`
  for every other **seated** dealer of the same game. New `Reason`s (appended, borsh-compatible):
  `Undercut` (`undercut`), `MatchBoost` (`match_boost`).
- `Stats` gains `game_share_bp: u16`: this table's share of the bets at all seated tables of its
  game over the hour (10 000 = all). Undercut fires when `share × tables < 10 000`.
- `rent_bid(&Pool, &Stats, &Temperament, &FloorView, now) -> RentDecision { action, reason: Option<RentReason> }`.
  `RentAction`: `Keep`, `Raise(u128)`, `Lower(u128)` (seated: call `bid_for_seat` with it),
  `BidEmpty(u128)`, `Outbid(u128)` (off floor: call `bid_for_seat`), `Stay`.
  `RentReason`: `DefendingSeat` (`defending_seat`), `BiddingForSeat` (`bidding_for_seat`),
  `CuttingRent` (`cutting_rent`), each with `code()` and `explain()`. Earnings are
  `-player_net_1h` (what players lost at the table). JSON: `{"action":{"outbid":"1000000"},"reason":"bidding_for_seat"}`.
