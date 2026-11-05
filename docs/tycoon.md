# Casino Tycoon (approved by Armand, 2026-11-05)

Builds on docs/floor.md (seats, rent, jackpot) and docs/sessions.md (sub-second provably fair
play). The player's main role is **table owner**; the customers are **NPC gamblers**, agents with
their own NEAR wallets. Betting yourself stays possible (secondary loop).

## Roles

- **Owner (player):** opens a table (`open_table`, floor.md rule 4), rents a seat, sets the offer
  directly or puts the table on autopilot (a temperament: the NPC dealer rules), manages the pool
  (invest/divest), buys and sells seats. Earns the table's edge minus rent; loses on lucky streaks.
- **NPC dealers:** the 5 launch tables, same rules as before (dealer_rules.rs), competing with
  owners for seats and gamblers.
- **NPC gamblers:** `GAMBLERS = 24` agents, each a NEAR sub-account (`g-<name>.tilthouse.testnet`)
  with an in-contract balance, a persona and a mood. They walk the floor, compare tables, sit,
  play sessions (docs/sessions.md) and leave. All their choices come from ONE readable file,
  `core/src/gambler_rules.rs`, shared by the live runner and the simulator.
- **LPs:** anyone backing any table's pool (unchanged).

## Gambler rules (core/src/gambler_rules.rs)

- Personas: `bargain_hunter` (weights total edge heavily), `regular` (loyal to the last table that
  treated it well), `whale` (needs a high max bet, rare, big stakes), `thrill_seeker` (chases boosts
  and the jackpot), `tourist` (mostly picks by seat traffic, i.e. whatever is near the entrance).
- Arrival: Poisson per minute with a day/night curve; on arrival a gambler scores every open seated
  table: `score = persona weights · (−edge, boost, max_bet fit, seat_traffic, loyalty, jackpot)` plus
  noise, sits at the best one above a threshold, else leaves ("nothing worth it"). It plays a session
  of `N` rounds (persona-dependent stake and length), then leaves; it remembers net result per table
  (loyalty up after wins, down after losses).
- Money source: every gambler receives `GAMBLER_SALARY = 5 tUSDC/hour` from the house treasury
  (minted tUSDC on testnet), capped at `GAMBLER_MAX_BALANCE = 200 tUSDC`. This is the economy's
  only external inflow; rent → jackpot → winners recirculates it.
- Each decision records a one-line reason (e.g. "Ada's 1.0 % beats Bruno's 2.4 %") shown in the 3D
  floor above the gambler.

## Seats

- `SEAT_TRAFFIC_BP = [15000, 13000, 11000, 10000, 8000, 6000]`: seat 1 is by the entrance and gets
  1.5× the passers-by; the last gets 0.6×. Gamblers' `seat_traffic` input uses it; the minimum rent
  of a seat scales with it (`MIN_RENT_PER_HOUR × traffic`).
- Seat market: a seated dealer's controller can `list_seat(dealer_id, price)`; another controller
  `buy_seat(seat, dealer_id)` pays the price to the seller's balance and its dealer takes the seat
  (the seller's dealer goes off the floor, no cooldown). Seat leases are NEP-245 tokens
  `seat-<n>` held by the seated dealer's controller (transfer = via buy_seat only, so a seat never
  sits with a dealer that can't use it).

## Owner controls

- `set_offer(dealer_id, rake_bp, max_bet, boost_secs)` by the controller: clamped by core to the same
  bounds as NPCs (total edge 1–5 %, max bet ≤ what the pool covers, boost ≤ 15 min, one boost per
  hour). `set_autopilot(dealer_id, temperament | null)`. Offers apply to sessions opened after the
  change (sessions freeze their offer, docs/sessions.md).

## Contract (v2, fresh deploy at `floor.tilthouse.testnet`)

Everything in floor.md + sessions.md + this file. Per-round on-chain betting (bet_* with OutLayer)
is removed from v2; sessions replace it. Dealer stats buckets are fed by `settle_session`
(volume, player net, gamblers count, last bet time).

## Front

- Lobby = the floor with NPC gamblers walking in from the entrance (seat 1 side), pausing in front of
  tables (thought bubble with their reason), sitting, playing, leaving; dealers as before.
- "My table" dashboard: footfall (gamblers passing / sitting), revenue, rent, P&L per hour, the offer
  controls with a live preview of how many gamblers it would attract (computed with gambler_rules in
  the browser? no: from the last hour's arrivals, server-provided), seat market.
- Play (secondary): sit at any table yourself; sessions make rounds instant.

## Sim

The simulator runs owners (scripted strategies), NPC dealers and the gambler population with the
same rules, and shows the week: seats changing hands, owners going bust, price wars.
