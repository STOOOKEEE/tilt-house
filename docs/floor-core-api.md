# Floor: core API (`core_rules`)

Pure logic for docs/floor.md rules 1–3, 5–7 and the checks of rule 4, plus docs/tycoon.md (seat
traffic, seat market, owner offers, gambler rules). Amounts are base units
(`u128`, JSON strings), times are seconds. Every `Err` leaves floor and pool untouched.

## `core_rules::floor`

Constants: `SEATS = 6`, `MIN_RENT_PER_HOUR = 1_000_000`, `PREPAY_HOURS = 2`, `OUTBID_BP = 11_000`,
`COOLDOWN_SECS = 1800`, `MIN_TABLE_SEED = 200_000_000`, `MAX_DEALERS = 16`,
`TEMPERAMENT_COOLDOWN_SECS = 3600`, `MAX_TABLE_ID_LEN = 32`, `MAX_TABLE_NAME_LEN = 32`, `HOUR_SECS`.

- `Floor { seats: [Option<Seat>; SEATS], jackpot: u128 }` (borsh + serde, `Default` = empty).
- `Seat { dealer_id: String, rent_per_hour: u128, seated_at: u64, paid_until: u64, ask: Option<u128> }`
  (`ask`: listing price, JSON string or null, defaults to null).
- `Floor::launch(&[&str], now) -> Floor`: seats them in order, each at its seat's minimum
  (`seat_min_rent`), no prepay, rent from `now`.
- `floor.accrue_rent(dealer_id, &mut Pool, now) -> RentOutcome { paid, evicted: Option<EvictReason> }`:
  settles rent (per second, rounded up) from the pool's free bankroll into `floor.jackpot`;
  on shortfall pays all the free bankroll and evicts (`UnpaidRent`). Not seated: no-op.
- `floor.bid_for_seat(dealer_id, rent, &mut Pool, now, cooldown_until) -> Result<BidOutcome { seat, evicted: Option<String>, paid }, FloorError>`:
  off the floor: the busiest empty seat whose `seat_min_rent` the bid covers (`RentTooLow` if
  none, or if `rent < MIN_SEAT_RENT`), or the weakest seat of a full floor if `rent >= outbid_min()`;
  prepays 2 h into the jackpot. Seated: changes its own rent (≥ its seat's minimum); the prepaid time left is converted at the
  new rate (no refund, no free protection). **Settle rent first**: if the bidder or the seat it
  would take has rent due, returns `RentDue` (contract: call `accrue_rent` for every seated
  dealer, i.e. `collect_rent`, before bidding).
- Caller duties: on any eviction (`RentOutcome.evicted`, `BidOutcome.evicted`) store
  `cooldown_until(now)` for the evicted dealer and emit `evicted` with `EvictReason::code()`
  (`unpaid_rent` | `outbid`); the bidder's cooldown is passed back to `bid_for_seat`.
- Views: `seat_of(id) -> Option<usize>`, `seat(id)`, `seated()`, `empty_seats()`,
  `rent_owed(id, now)`, `lowest_rent() -> Option<u128>` (None if nobody seated),
  `outbid_min()` (the cheapest empty seat's minimum while a seat is empty, else ⌈lowest × 1.1⌉),
  `weakest_seat()` (lowest rent, ties: most recently seated, then highest index),
  `view(id, cooldown_until) -> FloorView { my_rent, lowest_rent, empty_seats, outbid_min, cooldown_until, my_min_rent }`
  (`my_min_rent`: the dealer's seat minimum, 0 off the floor; `rent_bid` never cuts below it).
- `validate_new_table(id, name, seed_amount, dealers) -> Result<(), FloorError>` (id `[a-z0-9-]{1,32}`,
  name 1–32 bytes, no control chars, no outer spaces; seed ≥ min; `dealers < MAX_DEALERS`).
  `can_set_temperament(last_change, now) -> bool` (`last_change = 0`: never).
- `FloorError`: `RentTooLow`, `RentTooHigh`, `CannotPrepay { need }`, `BidTooLow { min }`,
  `Cooldown { until }`, `RentDue { dealer_id }`, `SeedTooLow`, `TooManyDealers`, `BadTableId`,
  `BadTableName`, and for the seat market `NotSeated`, `AlreadySeated`, `NotListed`,
  `PriceAbove { ask }`, `BadPrice` (implements `Display`).

## `core_rules::seats` (docs/tycoon.md, "Seats")

- `SEAT_TRAFFIC_BP = [15000, 13000, 11000, 10000, 8000, 6000]` (seat 1 = index 0, by the entrance).
- `seat_min_rent(seat) -> u128 = MIN_RENT_PER_HOUR × traffic / 10 000` (1.5, 1.3, 1.1, 1.0, 0.8,
  0.6 USDC/h); `MIN_SEAT_RENT = 600_000` (the back seat's, the absolute minimum).
- `floor.list_seat(dealer_id, price: Option<u128>) -> Result<(), FloorError>`: a seated dealer's
  controller lists (`Some`) or unlists (`None`) its seat. `Some(0)` → `BadPrice`; not seated →
  `NotSeated`.
- `floor.buy_seat(seat, buyer_id, max_price, now) -> Result<SeatSale { seller, price }, FloorError>`:
  the buyer's dealer takes the seat with its rent and remaining prepaid time (`seated_at = now`,
  listing cleared); the seller's dealer goes off the floor, **no cooldown**. Refuses a buyer
  already seated, the seller's own dealer included (`AlreadySeated`), an empty, unlisted or
  out-of-range seat (`NotListed`), `ask > max_price` (`PriceAbove { ask }`), and rent due on the
  seat (`RentDue`: settle first). Caller duty: move `price` from the buyer's controller balance
  to the seller's controller balance, transfer the `seat-<n>` token, emit `seat_sold`.

## Owner offers (`core_rules::dealer_rules`)

- `clamp_owner_offer(game, &Pool, rake_bp, max_bet, boost_secs, last_boost_at, now) -> Offer`:
  the owner's `set_offer`, clamped like NPC offers (rake in `rake_bounds`, i.e. total edge 1–5 %;
  `max_bet` from `min_max_bet(game)` (`SESSION_MIN_BET`; poker: `POKER_MIN_MAX_BET` = 25 ×
  `POKER_BIG_BLIND` = 5.00, so the 20-big-blind minimum buy-in always fits) up to
  `pool.free / worst_case_multiple`, the cap winning when the pool is smaller; boost ≤ `MAX_BOOST_SECS` = 15 min). One boost per
  hour: a boost asked within `BOOST_COOLDOWN_SECS = 3600` of `last_boost_at` (0 = never) is
  dropped (`boost_until = 0`). Never fails. `reason = Reason::Owner` (code `owner`, appended last:
  borsh index 9). Caller: store `last_boost_at = now` when the result's `boost_until > now`.

## `core_rules::gambler_rules` (docs/tycoon.md, "Gambler rules")

Plain-English rules in the module doc. Every function takes its randomness as `&mut Rng`.

- Constants: `GAMBLERS = 24`, `GAMBLER_SALARY_PER_HOUR = 5_000_000`,
  `GAMBLER_MAX_BALANCE = 200_000_000`, `DAY_CURVE_BP: [u16; 24]` (share of peak arrivals per UTC
  hour, low at 04:00, peak 20–21:00), `NOISE_POINTS = 25`, `STAKE_BALANCE_DIVISOR = 5`,
  `LOYALTY_MAX = 100`, `MEMORY_TABLES = MAX_DEALERS`.
- `Persona`: `BargainHunter | Regular | Whale | ThrillSeeker | Tourist` (JSON `bargain_hunter`,
  …, `code()`), `Persona::ALL`. `LINEUP: [(&str, Persona); 24]`: names (account `g-<name>`
  lower case) and personas.
- `weights(persona) -> Weights { edge, boost, fit, traffic, loyalty, jackpot, threshold }` (percent;
  threshold in points).
- `day_curve_bp(now)`, `arrives(persona, balance, now, rng) -> bool`: call once a minute per
  gambler off the floor (false under `SESSION_MIN_BET`).
- `desired_stake(persona, balance, rng) -> u128` (persona range, ≤ balance / 5).
- `TableView { dealer_id, name, game, seat, edge_bp, boosting, max_bet }`: a seated, open table
  (`edge_bp`: total edge in force, boost included).
- `Memory` (borsh + serde): `loyalty(dealer_id) -> i16`, `remember(dealer_id, net: i128, lock)`
  (fade ×3/4, then ±(20 + 60 × |net|/lock), clamped to ±100; keeps `MEMORY_TABLES`).
- `parts(&TableView, stake, loyalty, jackpot) -> Parts` (each 0–100, loyalty −100–100) and
  `score(persona, &Parts, noise) -> i32`. Property (tested): a higher edge never raises a score.
- `choose_table(persona, balance, stake, &[TableView], &Memory, jackpot, rng) -> Decision { table: Option<usize>, reason: GamblerReason, text }`:
  one noise draw per table in order; best score wins if ≥ threshold (ties: nearest the entrance).
  `GamblerReason` codes: `cheapest`, `loyal`, `fits_my_bets`, `boosting`, `jackpot`,
  `near_entrance`, `best_overall`, `nothing_worth_it`, `broke`. `text` is the line shown above the
  gambler, e.g. `Ada's 1.0 % beats Bruno's 2.4 %`.
- `plan_session(persona, stake, max_bet, balance, rng) -> Option<SessionPlan { stake, rounds, lock }>`
  (`SESSION_MIN_BET ≤ stake ≤ max_bet`, `lock = min(stake × rounds, balance)`; `None` if the
  minimum does not fit).
- `pick_bet(persona, game, rng) -> Bet` (always valid; whales and thrill seekers chase long shots).
- `salary_for(balance, secs) -> u128`: 5 USDC/h rounded down, never above the cap; pay hourly.

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
  `-player_net_1h` (what players lost at the table). A defensive raise is capped at
  `defend_cap(lowest) = lowest × (BP + DEFEND_MARGIN_BP) / BP + 1`: one unit above the at-risk
  band, never straight to the target. JSON: `{"action":{"outbid":"1000000"},"reason":"bidding_for_seat"}`.

## Sim JSON (`web/public/sim.json`, `sim --days 7 --seed 42`)

Top level: `seed, days, frame_secs, min_bet, seat_traffic_bp, dealers: [{ id, name, game,
temperament ("manual" for hand-set offers), traits, owner: name|null, strategy:
"undercutter"|"premium"|"gambler_owner"|null }], gamblers: [{ id, name, persona }], frames`.
Dealers are listed once they exist (owners open tables during the run). Frame: `{ t, jackpot,
dealers: [{ id, bankroll, share_price, rake_bp, edge_bp, max_bet, boost, open, reason, seat|null,
rent_per_hour }], seats: [{ seat, dealer_id|null, rent_per_hour, min_rent, traffic_bp, ask|null }],
gamblers: [{ id, state: walking|deciding|seated|leaving, dealer_id|null, seat|null, reason_code|null,
reason|null, balance, session_net }] (off the floor: absent), events: [{ t, dealer, kind, text }] }`.
Event kinds: `reprice`, `boost`, `bust`, `reopen`, `rent`, `seated`, `evicted`, `opened`,
`seat_listed`, `seat_sold`, `jackpot`, `price_war`.
