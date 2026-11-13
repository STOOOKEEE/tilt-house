# $TILT — the house on tilt (testnet)

$TILT is the Tilt House memecoin: a NEP-141 token whose supply reacts to the casino. When the
humans beat the house on a UTC day, the house "goes on tilt" and mints TILT to them; when the house
wins, the treasury burns. Holders can burn TILT together to start a **Tilt Hour** on the USD floor.
The whole mechanic is in the contract (`meme/`, `tilt.tilthouse.testnet`), not in a backend; every
parameter is fixed at launch and readable; nobody holds an admin method.

- Contract: `meme/src/contract.rs`; the rules as pure functions: `meme/src/rules.rs` (shared with
  the simulator, so the 60-day simulation runs the deployed rules).
- Metadata: name `Tilt`, symbol `TILT`, **6 decimals**. Same as tUSDC on purpose: the mint rate is
  then a plain ratio between tUSDC base units won and TILT base units minted, and the page formats
  both currencies with one helper.
- Standards: NEP-141 (fungible token), NEP-145 (storage management), NEP-148 (metadata), NEP-297
  (events), NEP-330 (source metadata, reproducible build).
- Ops (services of the TILT floor): [docs/ops-tilt.md](ops-tilt.md). The floor side of the
  interface: [docs/contract-api.md](contract-api.md) (`close_day`, `start_tilt_hour`).

## The mechanic

### 1. House on tilt (daily, the streak)

The USD floor (`floor.tilthouse.testnet`) counts, per UTC day, the human players' net result against
the house and each human's tUSDC wagered (NPC gamblers are excluded through the floor's NPC
registry). After the day ends anyone calls `floor.close_day(day)`, which calls
`tilt.report_day(day, players_net, wagers)`.

`report_day` is refused unless **all** of these hold (fail closed): the caller is the configured
floor; the day has ended (`day < today`); the day is after the last reported day (once per day, in
order); at most 50 players; no duplicate account; every wager in `1..2^64`.

Then, with `players_net` in tUSDC base units:

- **Humans ahead (`players_net > 0`).** The streak grows by one if the previous reported day is
  the day before, else it restarts at 1 (an unreported day breaks a streak). The day's pool is
  `min(day_cap, players_net × mint_rate_bp / 10000 × (1 + min(streak − 1, streak_bonus_max_days) × streak_bonus_bp / 10000))`.
  Each player gets `min(player_day_cap, pool × wagered / total wagered)` (rounded down). What
  rounding and the per-player cap leave over is **not** minted. A winner without a TILT storage
  registration is registered at the contract's expense while the contract keeps 0.5 NEAR free;
  below that the share is skipped (`mint_skipped` event) instead of failing the report.
- **House ahead or even (`players_net ≤ 0`).** `treasury × burn_bp / 10000` burns from the
  treasury and the streak resets to 0.
- The longest streak is kept like a high score, with the last day of that streak.

### 2. Tilt Hour (the ritual)

Holders call `burn_for_tilt_hour(amount)` (1 yoctoNEAR, `amount ≥ tilt_hour_min_burn`). A round's
window opens at its first burn and lasts `tilt_hour_window_secs`. When the round reaches
`tilt_hour_amount` burned **and** `tilt_hour_min_burners` distinct accounts, TILT calls
`floor.start_tilt_hour()` (only TILT may call it): every table on the USD floor plays at its minimum
edge for one hour (the floor extends a running Tilt Hour rather than stacking). The round resets.
A window that ends short of the goal is lost: the next burn starts a new round from zero.

The callback logs `started` or `failed`. **Nothing is refunded on failure**: the burn is the
ritual, the floor call is its effect; the floor's `start_tilt_hour` only checks the caller and
extends the hour, so it does not fail in practice, and a refund path would add a second way to
move TILT that could be raced.

### 3. Supply

At `new`: the **treasury** is minted to the contract itself (the only balance the daily rule
burns; TILT anyone sends to the contract joins it) and the **house allocation** to the house
receiver (`tilthouse.testnet`, which seeds the TILT floor's NPC dealers). The **welcome pool** is a
reserve minted one claim at a time: `claim_welcome_for(account_id)`, callable only by the welcome
operator (`relayer.tilthouse.testnet`, which does it only for a Privy-verified login), once per
account, at most `welcome_daily_claims` per UTC day.

No other mint path exists: launch, daily mint, welcome. Burns: daily treasury burn, Tilt Hour
burns, and the NEP-145 forced unregister (`storage_unregister(force: true)` burns the leaver's
balance, as the standard does). Every one of them is a NEP-141 `ft_mint` / `ft_burn` event (memo =
reason) and a line of the on-chain log.

Upper bound on supply after `n` days: `1,300,000 + 500,000 (welcome pool) + 5,000 × n` TILT.

## Launch parameters

Fixed by `new` (`LAUNCH` in `meme/src/rules.rs`), readable with `get_params`:

| Parameter | Value | Why |
| --- | --- | --- |
| `treasury_initial` | 1,000,000 TILT | The fuel the house burns. |
| `house_allocation` | 300,000 TILT | Bankroll of the TILT floor's 3 NPC dealers. |
| `welcome_pool` | 500,000 TILT | 5,000 welcomes. |
| `welcome_amount` | 100 TILT | Five newcomers together can start a Tilt Hour. |
| `welcome_daily_claims` | 200 | Caps a signup farm at 20,000 TILT a day. |
| `mint_rate_bp` | 100,000 (10 TILT per tUSDC won) | A winning day of the busy floor (+8 to +128 tUSDC in the simulation) mints 80–1,300 TILT: visible, below the cap. |
| `streak_bonus_bp` / `streak_bonus_max_days` | 1,000 / 7 | +10 % per extra streak day, at most +70 %: the streak matters, then stops compounding. |
| `player_day_cap` | 500 TILT | One whale gets at most 10 % of a day. |
| `day_cap` | 5,000 TILT | Bounds the worst case (a 60-day streak adds ≤ 300,000). |
| `burn_bp` | 100 (1 % of the treasury per house day) | The treasury halves in ~70 house days: 34–41 % burns in 60 days. 2 % would empty it in a season; 0.5 % is invisible on the page. |
| `tilt_hour_amount` | 500 TILT | Five welcome grants. |
| `tilt_hour_min_burners` | 5 | A ritual, not a purchase: one holder cannot start it with one account. |
| `tilt_hour_min_burn` | 20 TILT | A dust burn does not make a burner. |
| `tilt_hour_window_secs` | 3,600 | Burners must show up within the same hour. |

Fixed in code: at most 50 players per report, log of 256 entries.

## Sybil resistance: the limits, plainly

Good enough for a testnet demo, not more:

- **Welcome.** One claim per NEAR account, only through the relayer, which only claims for an
  account behind a Privy login (email, Google or X). The contract cannot check that a human is
  behind it: it trusts the operator. One person with N email addresses gets N × 100 TILT. The global
  limits hold whatever the operator does: 200 claims a day, 500,000 TILT in total.
- **Daily mint.** It only reacts to tUSDC actually won from the house on the floor (NPC gamblers
  excluded by the floor). Splitting play over several accounts dodges the 500 TILT per-player cap,
  not the 5,000 TILT day cap, and still needs the humans as a whole to beat the house that day,
  which costs the edge in expectation. A player who owns a table and plays at it moves money from
  their own pool to themselves at almost no cost; it still counts as beating the house, bounded by
  the same caps. The floor reports at most the 50 largest wagerers: smaller players that day get
  nothing.
- **Tilt Hour.** "Distinct burners" means distinct NEAR accounts: one holder with five funded
  accounts can start a Tilt Hour alone. It costs 500 TILT burned, and the effect is bounded (one
  hour at the minimum edge, extended, not stacked).
- **Trust.** `report_day` trusts the floor contract (itself a reproducible build, its day counts
  on chain, docs/contract-api.md). `claim_welcome_for` trusts the relayer. Nothing else is trusted.

## No admin key

The contract has no owner and no setter: no method changes a parameter, the floor, the operator or
the house receiver. The account's full-access key can still redeploy the code until it is deleted;
`scripts/deploy-tilt.sh` prints that lock step (`near account delete-keys`) and never runs it, so
it stays a conscious, irreversible decision.

## API

All amounts are decimal strings of base units (6 decimals); `*_ns` are decimal strings of
nanoseconds; days are UTC day numbers (`block_timestamp_ns / 86_400_000_000_000`), JSON numbers.

### Calls

| Method | Caller | Deposit / gas | Effect |
| --- | --- | --- | --- |
| `new({floor, welcome_operator, house_receiver, economics})` | deploy (init) | 0, 50 Tgas | Fixes the parameters, mints treasury and house allocation. |
| `report_day({day, players_net, wagers})` | the floor only | 0, 150 Tgas | `players_net`: signed decimal string; `wagers`: `[[account, "amount"], …]`, ≤ 50. |
| `burn_for_tilt_hour({amount})` | any holder | 1 yoctoNEAR, 100 Tgas | Returns `true` if this burn started a Tilt Hour on the floor. |
| `claim_welcome_for({account_id})` | welcome operator only | `storage_balance_bounds().min` if the account is unregistered (rest refunded), else 0; 30 Tgas | Returns the amount minted. |
| `on_tilt_hour_started({round, burned})` | private (callback) | | Logs `started` / `failed`. |
| NEP-141 `ft_transfer`, `ft_transfer_call`; NEP-145 `storage_deposit`, `storage_withdraw`, `storage_unregister` | | as the standards | |

Errors (panics): `Only the floor can report a day`, `The day has not ended`, `Day already reported
(or older than the last report)`, `At most 50 players per day`, `Duplicate player`, `Each wager
must be positive and below 2^64`, `Burn at least tilt_hour_min_burn`, `Only the welcome operator can
claim`, `Welcome already claimed`, `Daily welcome cap reached`, `Welcome pool is empty`, `Attach at
least … to register the account`, `Invalid economics: …`.

### Views

`get_params()`:

```json
{ "floor": "floor.tilthouse.testnet", "welcome_operator": "relayer.tilthouse.testnet",
  "house_receiver": "tilthouse.testnet", "launch_day": 20770,
  "treasury_initial": "1000000000000", "house_allocation": "300000000000",
  "welcome_pool": "500000000000", "welcome_amount": "100000000", "welcome_daily_claims": 200,
  "mint_rate_bp": 100000, "streak_bonus_bp": 1000, "streak_bonus_max_days": 7,
  "player_day_cap": "500000000", "day_cap": "5000000000", "burn_bp": 100,
  "tilt_hour_amount": "500000000", "tilt_hour_min_burners": 5, "tilt_hour_min_burn": "20000000",
  "tilt_hour_window_secs": 3600, "max_players": 50, "log_capacity": 256 }
```

`get_state()`:

```json
{ "total_supply": "1300000000000", "treasury": "1000000000000", "circulating": "300000000000",
  "welcome_remaining": "500000000000", "welcome_claims": 0, "welcome_claims_today": 0,
  "minted_total": "1300000000000", "burned_total": "0", "today": 20770,
  "last_reported_day": null, "streak": 0, "longest_streak": 0, "longest_streak_day": null,
  "tilt_hour": { "round": 0, "burned": "0", "burners": 0, "window_end_ns": "0", "triggers": 0,
                 "last_started_ns": null },
  "log_next_seq": 2 }
```

`circulating` = supply − treasury. `tilt_hour` shows the open window (an ended window shows as
empty, `window_end_ns` `"0"`). Whether a Tilt Hour is running: the USD floor's
`get_floor.tilt_hour_until`.

`get_log({from?, limit?})`: entries with `seq ≥ from` (default: the oldest kept), ascending,
`limit` default 50, max 100. The last 256 are kept; for the newest N use `from = log_next_seq − N`.

```json
{ "seq": 3, "kind": "mint", "reason": "daily", "account": "alice.testnet", "amount": "40000000",
  "day": 20770, "timestamp_ns": "1794614520000000000" }
```

| kind | reasons | account | amount |
| --- | --- | --- | --- |
| `mint` | `launch`, `daily`, `welcome` | receiver | TILT |
| `burn` | `daily` (treasury), `tilt_hour`, `unregister` | owner | TILT |
| `streak` | `grow`, `reset` (one per reported day) | null | the new streak |
| `tilt_hour` | `triggered`, `started`, `failed` | null | TILT burned in the round |

`day` is the reported day for `daily` and `streak` entries, the current day otherwise.

`has_claimed_welcome({account_id})` → bool; NEP-141 `ft_total_supply`, `ft_balance_of`; NEP-145
`storage_balance_of`, `storage_balance_bounds`; NEP-148 `ft_metadata`.

### Events (NEP-297)

`nep141` `ft_mint` / `ft_burn` (memo = reason) for every mint and burn, and standard `tilt`
version `1.0.0`: `day_reported {day, players_net, players, minted, burned, streak,
longest_streak}`, `mint_skipped {day, account_id, amount}`, `tilt_hour_triggered {round, burned,
burners}`, `tilt_hour_started {round, started}`.

## Simulation (60 days)

```sh
cargo run -p tilt-house-sim --release -- meme --days 60 --scenario busy        # one scenario, JSON on stdout
cargo run -p tilt-house-sim --release -- meme --days 60 --out web/public/tilt-sim.json   # all four (the /tilt page)
```

`sim/src/meme.rs` calls the contract's rules (`day_pool`, `split`, `treasury_burn`, `Streak`,
`TiltHourProgress`) with `LAUNCH`. Model: humans play even-money rounds at a 2 % house edge
(each player 1/3 to 5/3 of the scenario's mean rounds); the floor reports the 50 largest wagerers;
new players claim the welcome; holders run Tilt Hour rituals (5 burners × 100 TILT) when they hold
enough. Not modelled: transfers, play on the TILT floor, the lower edge during a Tilt Hour. Output:
`{params, days, seed, edge_bp, scenarios: {<name>: {description, summary, series: [{day, supply,
treasury, minted, burned, streak, players_net, tilt_hours}]}}}`.

Seed 42, launch supply 1,300,000 TILT (amounts in TILT):

| Scenario | Supply day 60 | Treasury day 60 | Player / house days | Longest streak | Daily mint | Welcome | Treasury burn | Tilt Hour burn (hours) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quiet (4 players) | 975,703 | 662,282 | 19 / 41 | 5 | 1,421 | 12,000 | 337,718 | 0 (0) |
| busy (30 players) | 957,710 | 592,966 | 8 / 52 | 2 | 4,744 | 90,000 | 407,034 | 30,000 (60) |
| whales (3 + 10) | 992,103 | 662,282 | 19 / 41 | 2 | 26,321 | 18,000 | 337,718 | 14,500 (29) |
| hot-streak (dice favour players 14 days) | 1,118,479 | 655,659 | 18 / 42 | 14 | 72,820 | 150,000 | 344,341 | 60,000 (120) |

What it shows: the law of large numbers works against busy floors (30 players almost never beat
the house: 8 player days in 60), while a quiet floor wins a third of its days and builds real
streaks; whales win as often as the small floor but the 500 TILT per-player cap stops them taking
the pool; only a sustained run (hot-streak) grows the supply, by 12 % over 60 days, with the day cap
binding every day of the streak. In every scenario the treasury, not holders, carries the burn.

## Build and deploy

Reproducible build (Docker, image pinned by digest in `meme/Cargo.toml`, committed tree):

```sh
cd meme && cargo near build reproducible-wasm     # → target/near/tilt_house_meme/tilt_house_meme.wasm
```

The wasm embeds the commit it was built from (NEP-330), so build in a clean clone of the commit you
deploy. Launch build: commit `9120a49`, 215,753 bytes, sha256
`c68f3b1cfc6db3d670c5b0046de10640708437bc5c22ca2251b40fa650961cfc` (NEAR code hash
`EN6Q6tDX9SGAUbrFS7vEEVkA4CSGiacWZ4kut22wpc5H`):

```sh
git clone https://github.com/STOOOKEEE/tilt-house /tmp/tilt-repro && cd /tmp/tilt-repro && git checkout 9120a49
cd meme && cargo near build reproducible-wasm
```

Deploy (testnet; the orchestrator runs it): `scripts/deploy-tilt.sh` creates `tilt.tilthouse.testnet`
(4 NEAR from `tilthouse.testnet`: ~2.2 NEAR of code, ~0.4 NEAR of log, the rest pays winners'
storage), deploys and calls `new` with the floor `floor.tilthouse.testnet`, the welcome operator
`relayer.tilthouse.testnet`, the house receiver `tilthouse.testnet` and the economics printed by the
simulator, registers `floor-tilt.tilthouse.testnet` for TILT storage, then prints the lock step.
`DRY_RUN=1` prints every command instead; `WASM=<path>` deploys a wasm built as above instead of
building in the working tree:

```sh
WASM=/tmp/tilt-repro/target/near/tilt_house_meme/tilt_house_meme.wasm scripts/deploy-tilt.sh
```

Tests: `cargo test -p tilt-house-meme` (rules, contract unit tests, and sandbox tests against a mock
floor in `meme/tests/mock-floor`: daily mint, caps, burn, refused reports, Tilt Hour call and its
refusal, welcome once / daily cap / pool, unauthorized callers, the log).
