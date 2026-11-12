# The Floor — economy spec (approved by Armand, 2026-11-05)

Supersedes the "economy" parts of the v1 design ([archive/design.md](archive/design.md)) where they conflict. Goal: a closed economic
loop the track can judge: scarcity (seats), circulation (rent → jackpot → players), player-owned
businesses (players open tables), NPC agents that compete and react, all without a dev patch.

## The loop

players bet → tables earn the edge → table owners (LPs) earn → tables pay **rent** for their seat
→ rent fills the **jackpot** → the jackpot drops on a random bet → back to players.
Tables that earn attract LPs and can afford higher rent; tables that don't lose their seat.

## Rules (all in core/, pure Rust, shared by contract and sim; numbers are constants with comments)

1. **Seats.** The floor has `SEATS = 6` seats. A dealer is either *seated* (takes bets) or
   *off the floor* (takes no bets; its LPs can still invest/divest). Launch: the 5 NPC dealers are
   seated, 1 seat empty.
2. **Rent.** Every seated dealer pays its `rent_per_hour` (its own bid, base units/hour) from its
   pool's free bankroll into the jackpot, accrued per second, settled lazily on every interaction
   with that dealer and by a public `collect_rent()` (keeper calls it every minute).
   `MIN_RENT_PER_HOUR = 1 tUSDC` (1_000_000). A dealer that cannot pay its accrued rent from its
   free bankroll is **evicted** (event `evicted`, reason `unpaid_rent`), and pays what it can.
3. **Bidding for a seat.** `bid_for_seat(dealer_id, rent_per_hour)` by the dealer's controller:
   - empty seat → seated at that rent if `rent >= MIN_RENT_PER_HOUR` and the pool can prepay
     `PREPAY_HOURS = 2` hours of rent (moved to the jackpot at once);
   - floor full → allowed only if `rent >= lowest seated rent × 110 %` (`OUTBID_BP = 11_000`);
     the lowest-rent seated dealer is evicted (reason `outbid`) and the bidder takes its seat
     (same prepay). Ties on lowest rent: the most recently seated is evicted.
   - a seated dealer can raise its own rent any time (protects it); lowering it is allowed only
     to `>= MIN_RENT_PER_HOUR`.
   An evicted dealer cannot bid again for `COOLDOWN_SECS = 30 min` (prevents flip-flop wars).
4. **Player-owned tables.** `open_table(id, name, game, temperament, seed_amount)` by any player,
   from their in-contract balance, `seed_amount >= MIN_TABLE_SEED = 200 tUSDC`; the player becomes
   the dealer's controller and gets the founding LP shares. The table starts off the floor; the
   controller then calls `bid_for_seat`. Player-run dealers price with the same
   `dealer_rules::reprice` and the temperament the owner picked (no free-form pricing: keeps the
   1–5 % edge bounds), repriced by the keeper like NPCs; the owner can change temperament
   (`set_temperament`) at most once an hour. Max `MAX_DEALERS = 16` dealers total.
5. **NPC rent bidding (agents).** NPC dealers decide their rent in core
   `dealer_rules::rent_bid(pool, stats, temperament, floor: &FloorView) -> RentDecision` (in the
   same readable file): target rent = a share of the last hour's earnings (greedy pays less,
   promoter pays more to stay visible), raise when within 15 % of the lowest seated rent and
   earnings allow, bid for an empty seat or to outbid the weakest table when off the floor and the
   pool can prepay. Reason codes added: `defending_seat`, `bidding_for_seat`, `cutting_rent`.
6. **Competition-aware pricing.** `reprice` gets a new input `rivals: &[RivalOffer]` (other
   seated dealers of the same game: total edge, max bet, boost). Rules added before `Steady`:
   `Undercut` (a rival's total edge is lower and our share of the game's bets over the hour fell
   below 1/n → cut rake to just under the rival, within bounds), `MatchBoost` (a rival is boosting
   → promo-weighted counter-boost). Reason codes `undercut`, `match_boost`.
7. **Jackpot.** A global pot. Fed by rent only. Every settled round has a chance to win the whole
   pot: `p = stake / JACKPOT_ODDS_UNIT` with `JACKPOT_ODDS_UNIT = 2_000 tUSDC` (a 1 tUSDC bet has a
   1/2000 chance), decided from the round's hash-chain value in the session (no extra draw), paid
   to the player's balance (event `jackpot`). Pot never pays below `MIN_JACKPOT = 10 tUSDC`
   (below that the drop is skipped). Shown live everywhere.

## Contract API additions (house)

- `collect_rent()` (anyone), `bid_for_seat(dealer_id, rent_per_hour: U128)` (dealer controller:
  NPC dealer account or owning player), `open_table(id, name, game, temperament, look, seed_amount)`
  where `look` is a preset name from web/src/scene/looks.ts (validated against a fixed list, max 32 chars), `set_temperament(dealer_id, temperament)`.
- Views: `get_floor() -> { seats: [{ seat, dealer_id|null, rent_per_hour, seated_at }], lowest_rent,
  outbid_min, jackpot, jackpot_odds_unit }`; DealerView gains `seated`, `seat`, `rent_per_hour`,
  `rent_owed`, `controller`, `look`, `earnings_1h`, `cooldown_until`; history kinds add `seated`, `evicted`,
  `rent`, `jackpot`, `opened`.
- Relayer allow-list adds (full-access key, 0 deposit): `open_table`, `bid_for_seat`,
  `set_temperament`. Keeper calls `collect_rent` and NPC `bid_for_seat`.
- Fresh deployment at `floor.tilthouse.testnet` (state layout changes; the old `house` stays as is).

## Sim

Same rules via core: seats, rent, jackpot drops, evictions, simulated entrepreneurs who open tables
when the floor is profitable and LPs follow returns. JSON adds per frame `jackpot`, `seats`, and
events `seated|evicted|jackpot|opened`. Seed 42 / 7 days must show at least: 1 player-opened
table, 1 eviction by outbid, 1 eviction by unpaid rent, 3 jackpot drops.

## Front (3D)

Lobby = the floor with 6 seats: empty seat shows a "FOR RENT · from X/h" sign; jackpot counter
above the floor; eviction = dealer stands up, walks off, sign appears; new dealer walks in and sits.
"Open your table" flow (pick game, temperament, look preset, seed). Table page shows rent, rent
owed, seat status, rivals' edges.
