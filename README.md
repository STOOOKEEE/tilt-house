# Tilt House

[![CI](https://github.com/STOOOKEEE/tilt-house/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/STOOOKEEE/tilt-house/actions/workflows/ci.yml)
[![Verify deployment](https://github.com/STOOOKEEE/tilt-house/actions/workflows/verify-deployment.yml/badge.svg?branch=main)](https://github.com/STOOOKEEE/tilt-house/actions/workflows/verify-deployment.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![NEAR testnet](https://img.shields.io/badge/NEAR%20testnet-floor.tilthouse.testnet-00c08b)](https://testnet.nearblocks.io/address/floor.tilthouse.testnet)

![Tilt House: NPC gamblers walk the floor, a multi-spot roulette spin, a poker hand verified after the deal](docs/media/tilt-house.gif)

80-second demo video with voice-over: https://tilt-house-beta.vercel.app/tilt-house-demo.mp4 (file:
`web/public/tilt-house-demo.mp4`). The roulette and poker clips use the practice tables (same rules, local
seed, nothing signed); the terminal clip is a real `demo --new` run on testnet with the waits shortened.

**The problem.** An online casino asks players to trust a house they cannot inspect: the house sets
the odds, holds the money and keeps the edge. Tilt House turns that around: the players own the
tables, the odds and the money live in a NEAR contract, and every round can be replayed by anyone.

**What it is.** A casino tycoon on NEAR. Players own the tables; 24 NPC gamblers, each with its own NEAR wallet,
are the customers. Owners rent seats on the floor by the hour, set their house edge and compete for
the gamblers, who compare every table and say why they sit where they sit. Rent fills a jackpot that
any settled bet can win. Dice, roulette, blackjack and multiplayer no-limit hold'em, every round
answered in tens of milliseconds and provably fair, settled on NEAR testnet. Bet in test dollars
or in **$TILT**, a memecoin whose supply follows the house's luck: it mints to the players on the
days they beat the casino, burns on the days the house wins, and its holders can burn it together
to put the whole casino "on tilt" for an hour.

- **Play:** https://tilt-house-beta.vercel.app (email, Google or X login; test chips on the house).
  Guided tour of the economy: https://tilt-house-beta.vercel.app/?tour=1 · poker: https://tilt-house-beta.vercel.app/poker · $TILT: https://tilt-house-beta.vercel.app/tilt
  · no login, practice in the browser (local seed, nothing on chain): https://tilt-house-beta.vercel.app/table/ada?demo=1 (any table) and https://tilt-house-beta.vercel.app/poker?demo=1
- **Tracks:** `games` (Games With Real Economies) and `memecoins` (Memecoins With Mechanics).

## Judge it in one minute

Node 22+ and pnpm (`corepack enable`, or `npm i -g pnpm`). No keys, no config: the first run makes
its own throwaway testnet account and later runs reuse it (`--new` makes a fresh one).

```sh
git clone https://github.com/STOOOKEEE/tilt-house && cd tilt-house && pnpm install
pnpm --filter cli-demo demo
```

See: the relayer activates a brand-new account with no wallet and no gas, it deposits 20 test chips,
plays dice, a multi-spot roulette spin and a blackjack hand (each round answered in ~30–50 ms), then
replays every round from the seed revealed on chain and prints `✓ Demo complete: every round
verified against the chain.` (exit code 0 only if every check passed). If the public RPC rate-limits
your IP, the CLI switches to `https://near-testnet.drpc.org` by itself (`--rpc <url>` picks another).

Check every claim that needs no Docker in one command (~1 min, Node only): `pnpm judge` prints one
`PASS`/`FAIL` line per claim (live services, deployed code hashes vs `deployments/testnet.json`,
the NPC registry, $TILT parameters and supply, the live Tilt Hour, the last UTC day reported to
$TILT, edge bounds, seat tokens, a played and verified session, an NPC's verified session), ends
with `18/18 passed`, writes
`judge-report.json` and exits 1 on any failure; `pnpm judge --rust` adds the simulator and edge tests.

Then:

```sh
pnpm --filter cli-demo floor                                            # the live economy: seats, rents, prices and why, gamblers and why
pnpm --filter cli-demo poker                                            # two accounts play hold'em with the NPC bots, every hand verified
pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet  # verify an NPC gambler's latest session from chain data
cargo run -p tilt-house-sim --release -- meme --days 60 --scenario busy > /tmp/tilt-meme.json  # 60 days of $TILT supply under the contract's own rules (summary: claim 22)
```

## Track fit (`games`: Games With Real Economies)

Official text: "Build NPCs with wallets, player-owned markets and economies that evolve without a
dev patch. Judged on the game loop, not the token — bonus if players never notice the chain."
Hints: Agent NPCs, Social login, NEAR Intents, NEP-245.

| Criterion | What Tilt House does | Check it |
| --- | --- | --- |
| NPCs with wallets | 24 NPC gamblers, each its own NEAR account `g-<name>.tilthouse.testnet` with its own in-contract balance; they sign their own `open_session` transactions. 6 NPC dealers (`ada`, `bruno`, `chloe`, `dmitri`, `eve`, `faye`) control their tables from their own accounts. Every choice comes from one readable rules file. | `core/src/gambler_rules.rs`, `core/src/dealer_rules.rs`; claims 1–3 below |
| Player-owned markets | Any player opens a table (an LP pool they found), rents one of 6 seats by the hour, outbids the weakest seat, buys or sells seats on the seat market (seat leases are NEP-245 tokens `seat-<n>`), and anyone can buy LP shares of any table. | `docs/floor.md`, `docs/tycoon.md`; claims 7–10 |
| Economies that evolve without a dev patch | NPC dealers reprice from on-chain rules, gamblers move to better offers, unpaid rent evicts, rent fills a jackpot that pays a bettor, the only inflow is a capped hourly salary. A simulated week (seed 42) produces 165 price wars, 37 jackpots, 73 evictions, a seat sale and busted tables reopened by new liquidity, with money conserved at every frame. | claims 4–6, 10 |
| Players never notice the chain | Social login (Privy: email, Google, X) with an embedded NEAR wallet; a function-call key limited to the session methods; moves relayed as NEP-366 meta-transactions, so no gas and no popups; rounds answer in ~40 ms off chain and settle on chain in batches. | `relayer/src/policy.ts`, `docs/sessions.md`; claims 11, 16, 18 |
| Hint: Agent NPCs | Yes: gamblers, dealers (rule-based agents with personas and temperaments, each with a wallet). | `core/src/gambler_rules.rs` |
| Hint: Social login | Yes: Privy (email, Google, X), NEAR embedded wallet. | https://tilt-house-beta.vercel.app |
| Hint: NEP-245 | Yes: LP shares of every table and the seat leases `seat-<n>` are NEP-245 tokens of `floor.tilthouse.testnet`. | `contract/src/mt.rs`; claim 7 |
| Hint: NEAR Intents | Not used: Intents have no testnet (HACKATHON.md Q-007) and the game runs on testnet play money. | — |

## Track fit (`memecoins`: Memecoins With Mechanics)

Official text: "Build memecoins where the meme does something — supply that reacts to the
community, treasuries with rules, onchain rituals and challenges. Judged on the mechanic, not the
chart." Hints: Memecoins, Token mechanics, NEP-141. Design: `docs/tilt.md`.

| Criterion | What $TILT does | Check it |
| --- | --- | --- |
| The meme does something | The meme is "the house on tilt": when the humans beat the casino on a UTC day, the house tilts and mints TILT to them; when the house wins, the treasury burns. Burning TILT together starts a **Tilt Hour**: every table on the USD floor drops to its minimum edge for an hour. | `docs/tilt.md` (The mechanic); claims 25–26 |
| Supply that reacts to the community | Daily mint = 10 TILT per tUSDC the humans won that day (NPC gamblers excluded by the floor's registry), +10 % per streak day up to +70 %, split by wager, capped at 500 TILT per player and 5,000 per day. The floor reports each day itself (`close_day` → `report_day`), so nobody posts the numbers. Over 60 simulated days (seed 42) the supply goes from 1,300,000 to 957,710 TILT on a busy floor (30 players almost never beat the house: 8 player days) and to 1,118,479 when the players run hot for 14 days (the day cap binds): the treasury, not holders, carries the burn. Live: the first day (2026-11-13) closed with the house up, and 10,000 TILT of the treasury burned. | `meme/src/rules.rs`, `contract/` `close_day`; claims 22–25, 33 |
| Treasuries with rules | 1,000,000 TILT treasury held by the contract itself; 1 % of it burns on every house day; no method can move it otherwise. Welcome pool of 500,000 TILT paid 100 at a time, once per account, 200 claims a day. | `get_params`; claims 20, 22 |
| On-chain rituals and challenges | Tilt Hour: 500 TILT burned by at least 5 distinct accounts within one hour → the token contract calls `floor.start_tilt_hour()` (only TILT may call it). The streak is a public high score (`longest_streak`). Triggered live on testnet on 2026-11-13 by 5 accounts. | claims 24–26 |
| Judged on the mechanic, not the chart | Every parameter is fixed at `new` and readable (`get_params`); no owner, no setter, no admin method (the on-chain ABI lists every method); every mint and burn is a NEP-141 event and a line of the on-chain log (`get_log`). | claims 20–21, 26 |
| Hint: NEP-141 | Yes: `tilt.tilthouse.testnet` is NEP-141 + NEP-145 + NEP-148 + NEP-297 events + NEP-330; the TILT floor `floor-tilt.tilthouse.testnet` takes TILT deposits with `ft_transfer_call` (same contract as the USD floor). | claims 17, 27 |
| Hint: Token mechanics | Mint on player wins, burn on house wins, ritual burn with an on-chain effect, streak bonus, per-player and per-day caps, sybil limits stated plainly (`docs/tilt.md`, Sybil resistance). | `meme/src/rules.rs` (property tests) |

## Game loop

From `docs/tycoon.md` and `docs/floor.md`, by time scale (constants from the code):

- **Every 30 s: a customer decides.** A gambler arriving on the floor (arrivals are drawn every
  minute, with a day/night curve) scores every seated table on edge, boost, max bet, seat traffic,
  loyalty and the jackpot, then walks to the best one or leaves, and says why ("Ada's 1.0 % beats
  Bruno's 2.4 %"). Seated, it bets a round every 3 s; a human's round answers in ~40 ms. Every
  settled bet can hit the jackpot.
- **Every few minutes: the market moves.** The keeper passes every 3 minutes on the live floor (every minute by default): it collects rent into the
  jackpot, reprices autopilot and NPC tables from `core/src/dealer_rules.rs` (cut the edge after
  20 min without players, raise it when busy, undercut a rival that took the players, boosts of up
  to 15 min once an hour) and places NPC rent bids. Owners watch footfall and P&L on "My table"
  and answer: undercut, boost, outbid the weakest seat (+10 %), list their seat for sale, or switch to
  autopilot. Price wars start here; sessions settle on chain every 50 rounds or 60 s.
- **Every session: money moves on chain.** `open_session` escrows the stake and freezes the seed
  hash and the offer; rounds run off chain, signed and hash-chained; `settle_session` batches pay
  the table and the player; `close_session` reveals the seed so anyone can replay every round. The
  gambler remembers how the table treated it (loyalty up after a win, down after a loss).
- **Every hour and beyond.** Rent is due per seat (seat 1 by the entrance gets 1.5× the passers-by
  and costs most); a table that can't pay is evicted and its seat goes to the next bidder; each
  gambler gets a 5 tUSDC salary up to 200 tUSDC, the economy's only inflow. Over days seats change
  hands, tables go bust and reopen when LPs refill them; `sim/` plays a week in seconds.

## $TILT

`tilt.tilthouse.testnet`, NEP-141, crate `meme/`, design and parameters in `docs/tilt.md`.

- **House on tilt (daily).** The USD floor keeps each UTC day's book of the human players' result
  against the house (NPC gamblers excluded) and their chips wagered. After midnight anyone calls
  `floor.close_day(day)`, which reports the day to the token. Players up on the day: TILT is minted
  to them by chips wagered (streak bonus, per-player and per-day caps) and the streak grows (the
  longest streak is kept as a high score). House up: 1 % of the treasury burns and the streak resets.
  The first live day, 2026-11-13 (day 20770), closed at 00:05 UTC: the humans were 7.82 tUSDC down,
  so 10,000 TILT burned and the streak stayed at 0 (claim 33).
- **Tilt Hour (ritual).** `burn_for_tilt_hour(amount)`: when 5 distinct holders have burned 500
  TILT within an hour, the token calls `floor.start_tilt_hour()` and every USD table plays at its
  game's minimum edge for an hour. Done live on 2026-11-13 (claim 26).
- **Rules at launch.** Every parameter is set in `new` and readable (`get_params`); the contract
  has no owner method; every mint and burn is a NEP-297 event and an entry of the on-chain log
  (`get_log`). Supply at launch: 1,000,000 treasury (held by the contract), 300,000 for the TILT
  tables' bankrolls, 500,000 welcome pool (100 TILT once per Privy-verified account, 200 a day).
- **Bet in TILT.** `floor-tilt.tilthouse.testnet` is the same floor contract with TILT as its chip
  (USD | TILT switch in the site's top bar; `pnpm --filter cli-demo demo --tilt` for an account
  that holds TILT there).
- **Stated plainly.** Sybil resistance is one welcome claim per Privy login (an email address is
  enough), and the daily mint counts only accounts that played; caps bound what a farm can take.
  The token and floor accounts still hold their deploy keys during the hackathon, so the code could
  be redeployed until the lock step in `docs/tilt.md` is run.

## Check every claim yourself

Prerequisites: Node 22+, pnpm, Rust stable with `wasm32-unknown-unknown` and `cargo-near` (for
the sandbox tests), from the repo root after `pnpm install`. The claims that read the chain use this
helper, `view <contract> <method> [json args]`, which calls a view over public RPC:

```sh
view() { node -e 'fetch("https://test.rpc.fastnear.com",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:process.argv[1],method_name:process.argv[2],args_base64:btoa(process.argv[3]??"{}")}})}).then(r=>r.json()).then(j=>console.log(Buffer.from(j.result.result).toString()))' "$@"; }
```

If `test.rpc.fastnear.com` answers 429 from your IP (shared cloud IPs often do), use
`https://near-testnet.drpc.org` in the helper and in claim 21.

`pnpm judge` runs the claims below that need no Docker and reports them as JSON; the table gives
every command so each claim can also be checked by hand.

Outputs were pasted from runs on a clean checkout on 2026-11-12, 2026-11-13 and 2026-11-14. Live values
(balances, rents, jackpot, who is seated, sessions) move all the time, so yours will differ; the
shape and the `✓`/`ok` lines will not. Chain claims read through public RPC (the `view` helper);
the nearblocks address pages are for humans and refuse most scripted clients. CI
(`.github/workflows/ci.yml`) runs fmt, clippy, every Rust test including the sandbox, `pnpm -r
typecheck`, `pnpm -r test` and the site build on every push to `main`; "Verify deployment"
(`.github/workflows/verify-deployment.yml`) rebuilds the deployed contracts daily and compares the
hashes with the chain.

| # | Claim | Command | Output |
| --- | --- | --- | --- |
| 1 | NPC gamblers sign their own transactions from their own wallets | `node -e 'fetch("https://api-testnet.nearblocks.io/v3/accounts/g-mia.tilthouse.testnet/txns").then(r=>r.json()).then(j=>j.data.slice(0,3).forEach(t=>console.log(t.signer_account_id,t.actions[0].method,t.receiver_account_id)))'` | `g-mia.tilthouse.testnet open_session floor.tilthouse.testnet` (×3) |
| 2 | An NPC's session is provably fair, checked from on-chain data only | `pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet` | `✓ 23 rounds read back from settle tx args match` … `✓ sha256(revealed seed) = on-chain commitment · 23 rounds replay bit for bit · hash chain ends on chain's` … `✓ VERIFIED from on-chain data: every outcome follows from the seed committed before the first bet.` (exit 0) |
| 3 | The NPC gamblers are live, with a reason for every choice | `curl -s https://tilt-house-beta.vercel.app/session/gamblers/floor` | `[{"id":"g-iris","name":"Iris","persona":"thrill_seeker","state":"seated","dealer_id":"bruno","seat":1,"reason_code":"cheapest","reason":"Bruno's 1.0 % beats Dmitri's 2.7 %","balance":"183652889","session_net":"-3802755"}]` |
| 4 | The live economy: seats, rents, prices and why each table priced itself so | `pnpm --filter cli-demo floor` | `jackpot 105.882098 tUSDC · rent to take a seat now ≥ 1.10 tUSDC/h` … `1  Ada  dice  NPC  1.50  accruing  3.75% … cutting my edge under a rival's: players went to the cheaper table` … `6  Faye  poker  NPC  1.00  117 min  1.70% … raising my max bet and cutting my edge: fresh liquidity came in` (floor section as printed by `demo` in claim 18) |
| 5 | A week of the economy, same rules as the contract | `cargo run -p tilt-house-sim --release -- --days 7 --seed 42 --out /tmp/tilt-sim.json && node -e 'const d=require("/tmp/tilt-sim.json");const c={};for(const e of d.frames.flatMap(f=>f.events))c[e.kind]=(c[e.kind]\|\|0)+1;console.log(c)'` | `{ reprice: 2430, boost: 765, opened: 3, seated: 74, rent: 673, jackpot: 37, price_war: 165, bust: 4, evicted: 73, reopen: 3, seat_listed: 1, seat_sold: 1 }` |
| 6 | Money is conserved over that week (salary is the only inflow), pools stay solvent | `cargo test -p tilt-house-sim week_42` | `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 9 filtered out` |
| 7 | Seat leases are NEP-245 tokens held by the seated table's controller | `view floor.tilthouse.testnet get_floor` then `view floor.tilthouse.testnet mt_balance_of '{"account_id":"ada.tilthouse.testnet","token_id":"seat-1"}'` | `{"seats":[{"seat":1,"token_id":"seat-1","traffic_bp":15000,…,"dealer_id":"ada","controller":"ada.tilthouse.testnet",…` then `"1"` |
| 8 | A player opens a table, bids for a seat and an outbid evicts the weakest table | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test open_table_bid_and_outbid_eviction ... ok` |
| 9 | Seat market: a sale moves the seat and pays the seller | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test seat_sale_moves_the_seat_and_the_price ... ok` |
| 10 | Unpaid rent evicts the table and feeds the jackpot | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test unpaid_rent_evicts_and_feeds_the_jackpot ... ok` |
| 11 | A session opens, settles on chain and reveals a seed anyone can verify; every token stays accounted for (`assert_conserved`) | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test session_open_settle_close_reveals_a_verifiable_seed ... ok` |
| 12 | Multi-spot roulette spins settle and verify | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test multi_spot_roulette_rounds_settle_and_verify ... ok` |
| 13 | If the server stalls, the player exits on their last signed state, and is paid stake + max win if the seed is never revealed | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test force_close_after_timeout_then_claim_unrevealed ... ok`, then `test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` (~8 min on a warm machine, ~20 min cold; the run also covers claim 25, NPC lock-down, poker settlement, table rename/retire and the v3→v4 upgrade: `test upgrade_from_v3_keeps_every_balance_and_session ... ok`) |
| 14 | Every table's total edge stays within 1–5 % | `cargo test -p tilt-house-core --test edges` | `test dice_total_edge_bounds ... ok`, `test roulette_total_edge_bounds ... ok`, `test blackjack_total_edge_bounds ... ok`, `test blackjack_base_edge ... ok`, `test result: ok. 4 passed; 0 failed` |
| 15 | The browser/CLI verifier matches the Rust protocol (shared vectors) and refuses forged or rewritten rounds | `cargo test -p tilt-house-session-server --test vectors && pnpm --filter @tilt-house/web exec vitest run src/near/session-client.test.ts` | `test web_vectors_match_the_rust_protocol ... ok`, `test result: ok. 1 passed; 0 failed`, then `Test Files  1 passed (1)`, `Tests  29 passed (29)` |
| 16 | The relayer refuses everything outside its allow-list | `pnpm --filter @tilt-house/relayer test` | `Test Files  8 passed (8)`, `Tests  211 passed (211)` |
| 17 | The contracts on chain are reproducible builds of this repo (NEP-330 names the commit; pinned docker image): the USD floor, $TILT and the TILT floor | `scripts/verify-deployment.sh testnet` (needs docker and cargo-near; ~2–5 min) | `PASS  floor floor.tilthouse.testnet: reproducible build of contract/ at faa7636 = chain (54kbcER1UUe3p7CKuMogjnwijQvPvSTvnqgTd13A8xei)`, `PASS  tilt tilt.tilthouse.testnet: reproducible build of meme/ at 9120a49 = chain (EN6Q6tDX9SGAUbrFS7vEEVkA4CSGiacWZ4kut22wpc5H)`, `PASS  floor_tilt floor-tilt.tilthouse.testnet: reproducible build of contract/ at faa7636 = chain (54kbcER1UUe3p7CKuMogjnwijQvPvSTvnqgTd13A8xei)`, `PASS  token tusdc.tilthouse.testnet: chain code_hash 6P86ptN89U9Pj7RaUKsHE6T25AvWv35XkB3UnPEnK3M9 = recorded`, `SKIP  token …: not built reproducibly`, `PASS` (each contract also checks `chain code_hash … = recorded`) |
| 18 | Play end to end on testnet with a brand-new account, no wallet and no gas: rounds answer in tens of milliseconds and every one is verified against the chain | `pnpm --filter cli-demo demo --new` | `✓ the relayer activated it: gas money, token registration, welcome chips`, `✓ deposited 20.00 tUSDC into floor.tilthouse.testnet (ft_transfer_call)`, … `21 instant requests over 3 sessions: median 30 ms, p90 81 ms, max 94 ms`, `✓ dice …`, `✓ roulette …`, `✓ blackjack …`, `✓ Demo complete: every round verified against the chain.` (exit 0) |
| 19 | The NPC gamblers are a fixed list registered in the floor contract (their money can only go to tables) | `view floor.tilthouse.testnet get_npcs` | `["g-mia.tilthouse.testnet","g-noah.tilthouse.testnet","g-zoe.tilthouse.testnet",…` (24 accounts) |
| 20 | $TILT's parameters are fixed at launch and readable | `view tilt.tilthouse.testnet get_params` | `{"floor":"floor.tilthouse.testnet","welcome_operator":"relayer.tilthouse.testnet","house_receiver":"tilthouse.testnet","launch_day":20770,"treasury_initial":"1000000000000","house_allocation":"300000000000","welcome_pool":"500000000000","welcome_amount":"100000000","welcome_daily_claims":200,"mint_rate_bp":100000,"streak_bonus_bp":1000,"streak_bonus_max_days":7,"player_day_cap":"500000000","day_cap":"5000000000","burn_bp":100,"tilt_hour_amount":"500000000","tilt_hour_min_burners":5,"tilt_hour_min_burn":"20000000","tilt_hour_window_secs":3600,"max_players":50,"log_capacity":256}` |
| 21 | $TILT has no owner, no setter, no admin method: the method list embedded in the deployed wasm | `node -e 'fetch("https://test.rpc.fastnear.com",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:"tilt.tilthouse.testnet",method_name:"__contract_abi",args_base64:""}})}).then(r=>r.json()).then(j=>{for(const f of JSON.parse(require("zlib").zstdDecompressSync(Buffer.from(j.result.result))).body.functions)console.log(f.kind,f.name,(f.modifiers\|\|[]).join(","))})'` (Node ≥ 22.15 for zstd) | `call burn_for_tilt_hour payable`, `call claim_welcome_for payable`, `view contract_source_metadata`, `view ft_balance_of`, `view ft_metadata`, `call ft_resolve_transfer private`, `view ft_total_supply`, `call ft_transfer payable`, `call ft_transfer_call payable`, `view get_log`, `view get_params`, `view get_state`, `view has_claimed_welcome`, `call new init`, `call on_tilt_hour_started private`, `call report_day`, `view storage_balance_bounds`, `view storage_balance_of`, `call storage_deposit payable`, `call storage_unregister payable`, `call storage_withdraw payable`. (`report_day` refuses any caller but the floor, `claim_welcome_for` any caller but the relayer. The account still has its full-access key, so the code can be redeployed until the lock step in `docs/tilt.md` is run.) |
| 22 | The 60-day simulation runs the contract's own rules (`meme/src/rules.rs`) | `cargo run -p tilt-house-sim --release -- meme --days 60 --scenario busy \| node -e 'const d=JSON.parse(require("fs").readFileSync(0));for(const[n,s]of Object.entries(d.scenarios))console.log(n,JSON.stringify(s.summary))'` | `busy {"final_supply":"957710446302","final_treasury":"592966446419","player_days":8,"house_days":52,"longest_streak":2,"daily_minted":"4743999883","welcome_minted":"90000000000","treasury_burned":"407033553581","tilt_hour_burned":"30000000000","tilt_hours":60}` |
| 23 | The four scenarios on the site's $TILT page are exactly what the simulator produces | `cargo run -p tilt-house-sim --release -- meme --days 60 --out /tmp/tilt-sim-60.json && cmp /tmp/tilt-sim-60.json web/public/tilt-sim.json && echo same` | `same`; per scenario (supply day 60 in base units, player/house days, Tilt Hours): `busy 957710446302 8/52 60`, `hot-streak 1118479220332 18/42 120`, `quiet 975703040964 19/41 0`, `whales 992103410090 19/41 29` |
| 24 | $TILT's contract: daily mint, caps, treasury burn, refused reports, the Tilt Hour call and its refusal, welcome once / daily cap / pool (sandbox against a mock floor, plus rules property tests) | `cargo test -p tilt-house-meme` | unit and property tests: `test rules::tests::split_property_sum_bounded_and_monotonic ... ok`, `test rules::tests::streak_grows_resets_breaks_on_gaps_and_keeps_the_record ... ok`, `test rules::tests::tilt_hour_needs_amount_and_distinct_burners_within_the_window ... ok`, `test contract::tests::only_the_floor_reports - should panic ... ok`, … `test result: ok. 15 passed; 0 failed`; sandbox: `test tilt_hour_calls_the_floor_and_logs_a_refusal ... ok`, `test welcome_once_per_account_daily_cap_and_pool ... ok`, `test launch_daily_mint_caps_burn_and_guards ... ok`, `test result: ok. 3 passed; 0 failed` |
| 25 | The floor counts each UTC day's human result (NPCs excluded) and `close_day` reports it to $TILT; only $TILT can start a Tilt Hour, which drops every table to its minimum edge | `cargo test -p tilt-house-contract --test sandbox -- day_books_count_humans_and_close_day_reports_to_the_meme tilt_hour_only_from_the_meme_lowers_the_rake_in_force` | `test day_books_count_humans_and_close_day_reports_to_the_meme ... ok`, `test tilt_hour_only_from_the_meme_lowers_the_rake_in_force ... ok`, `test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out` (~3–4 min) |
| 26 | A Tilt Hour was triggered live on testnet: 5 accounts burned 100 TILT each, the token started the hour on the USD floor, and every table dropped to its minimum edge | `view tilt.tilthouse.testnet get_state`, `view tilt.tilthouse.testnet get_log '{"from":2,"limit":7}'`, `view floor.tilthouse.testnet get_floor`, then `view floor.tilthouse.testnet get_lobby \| node -e 'for(const d of JSON.parse(require("fs").readFileSync(0)))console.log(d.id,d.game,"rake_bp",d.rake_bp,"offer_rake_bp",d.offer_rake_bp)'` (run 2026-11-13 11:28 UTC, during the hour) | `"tilt_hour":{"round":1,"burned":"0","burners":0,"window_end_ns":"0","triggers":1,"last_started_ns":"1794567731660003426"}`, `"burned_total":"500000000"`; `{"seq":2,"kind":"burn","reason":"tilt_hour","account":"tilthouse.testnet","amount":"100000000",…}`, then the same for `qa-owner-1107.tilthouse.testnet`, `qa-player-1107.tilthouse.testnet`, `02ab08bb…8707`, `148b30eb…52f5` (seq 3–6), `{"seq":7,"kind":"tilt_hour","reason":"triggered",…,"amount":"500000000",…}`, `{"seq":8,"kind":"tilt_hour","reason":"started",…}`; `"tilt_hour_until":1794571331` (11:02:11 + 1 h); lobby `ada dice rake_bp 100 offer_rake_bp 435`, `bruno dice rake_bp 100 offer_rake_bp 198`, `chloe roulette rake_bp 0 offer_rake_bp 224`, `dmitri roulette rake_bp 0 offer_rake_bp 133`, `eve blackjack rake_bp 0 offer_rake_bp 8`, `faye poker rake_bp 0 offer_rake_bp 88` (the rake in force is the minimum, the owners' offers are kept for after the hour) |
| 27 | The TILT floor is the same contract with TILT as the chip: play, settle and verify end to end | `pnpm --filter cli-demo demo --tilt` (shorthand for `--floor floor-tilt.tilthouse.testnet --token tilt.tilthouse.testnet --relayer https://tilt-house-beta.vercel.app/tilt/relayer --session https://tilt-house-beta.vercel.app/tilt/session`; needs an account that already holds TILT on `floor-tilt`, e.g. one that claimed the welcome through a Privy login on the site: the CLI cannot claim it. This run reused `~/.tilt-house/cli-demo-account.json`) | `Tilt House demo · NEAR testnet · floor-tilt.tilthouse.testnet`, `✓ floor balance 26.536083 TILT, enough for the sessions`, `jackpot 2.671222 TILT · rent to take a seat now ≥ 0.60 TILT/h`, seats `1 Ada dice`, `2 Chloe roulette`, `3 Eve blackjack` (~50,000 TILT bankroll each), `✓ open_session on chain in 2152 ms, 5.00 TILT escrowed`, … `22 instant requests over 3 sessions: median 72 ms, p90 157 ms, max 173 ms`, `✓ dice …`, `✓ roulette …`, `✓ blackjack … re-check: pnpm --filter cli-demo verify-session … --tilt`, `✓ Demo complete: every round verified against the chain.` (exit 0) |
| 28 | Poker: several players at one table, every hand replayable from a seed committed before the deal, rake to the table, settled on chain per player | `pnpm --filter cli-demo poker` (two throwaway accounts play hold'em with the NPC bots, then verify) | `pot 1.10 tUSDC · rake 0.0187 · showdown · winner B +1.0813 (two pair)`, `✓ seed ↔ commitment · deck from 4 client seeds · legal replay · history hash · chips in 1.10 = out 1.0813 + rake 0.0187`, … `✓ VERIFIED: every hand replays from its revealed seed and every round matches the chain.` (exit 0) |
| 29 | Any closed poker session, an NPC's included, verifies later from the chain and the public hand archive | `pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet` (when Mia's last session was at Faye) or `verify-session <poker session id>` | `2 hands from the server's archive (untrusted: each must replay from its revealed seed into its round)` … `✓ VERIFIED from on-chain data: every round is its hand's replay from a seed committed before the deal.` |
| 30 | A poker hand settles for every player and the table pool keeps exactly the rake; books balance | `cargo test -p tilt-house-contract --test sandbox poker_hand_settles_for_both_players_and_the_pool_keeps_the_rake` | `test poker_hand_settles_for_both_players_and_the_pool_keeps_the_rake ... ok` |
| 31 | NPC gamblers can only play: withdraw, invest, divest, open a table, trade seats or tokens are refused; salary only from the keeper | `cargo test -p tilt-house-contract --test sandbox npc_gamblers_only_play_sessions_and_take_salary_from_the_keeper` | `test npc_gamblers_only_play_sessions_and_take_salary_from_the_keeper ... ok` |
| 32 | A table's owner can rename it and retire it once off the floor and fully owned; retired tables leave the lobby | `cargo test -p tilt-house-contract --test sandbox controller_renames_and_retires_an_off_floor_table` | `test controller_renames_and_retires_an_off_floor_table ... ok` |
| 33 | The first UTC day closed on chain by itself: the keeper's `close_day` reported day 20770 (2026-11-13) to $TILT; the humans lost to the house that day, so 1 % of the treasury burned and the streak reset | `view floor.tilthouse.testnet get_day '{"day":20770}'`, then `view tilt.tilthouse.testnet get_log '{"from":10,"limit":2}'` (close_day transaction `BNBmXPo3VMp3tE8rX9J2mfsFhetmcCSWFxJjG1NSpWwz`, 2026-11-14 00:05 UTC) | `{"day":20770,"closed":true,"report":"reported","players_net":"-7820524","wagered":"61300000","players":[…]}` (10 players), then `{"seq":10,"kind":"streak","reason":"reset",…,"day":20770,…}`, `{"seq":11,"kind":"burn","reason":"daily","account":"tilt.tilthouse.testnet","amount":"10000000000","day":20770,…}` (10,000 TILT = 1 % of the 1,000,000 treasury) |


## How NEAR is used

```mermaid
flowchart LR
  P["Player's browser<br/>Privy login, NEAR wallet,<br/>session-only game key"] -->|"NEP-366 meta-transactions"| R["Relayer<br/>allow-list, pays gas"]
  P -->|"instant rounds, signed states"| S["Session server<br/>rounds, poker tables,<br/>NPC gambler runner"]
  R --> F[("floor.tilthouse.testnet<br/>escrow, pools, seats, rent,<br/>jackpot, day books")]
  S -->|"settle_session, close_session"| F
  S -.->|"each NPC signs open_session<br/>with its own account"| F
  K["Keeper<br/>rent, NPC pricing,<br/>salaries, close_day"] --> F
  F -->|"report_day"| T[("tilt.tilthouse.testnet<br/>$TILT, NEP-141")]
  T -->|"start_tilt_hour"| F
  V["CLI and browser verifiers"] -.->|"replay every round from<br/>the seed revealed on chain"| F
```

- **One floor contract, deployed twice** (`floor.tilthouse.testnet` in tUSDC, `floor-tilt.tilthouse.testnet`
  in TILT; Rust, near-sdk 5): balances, table pools with NEP-245 LP shares, the floor and its seat
  leases (NEP-245 `seat-<n>`), rent, the jackpot, the registry of NPC gamblers, the daily books,
  the Tilt Hour, and session escrow and settlement for every game including poker. All rules come
  from the `core` crate, the same code the simulator, the session server and the verifiers use.
  Deployed code is a reproducible build of this repository: each contract publishes its commit
  (NEP-330 `contract_source_metadata`) and `scripts/verify-deployment.sh` rebuilds it and compares
  the hash with the chain (`deployments/testnet.json`, checked daily by CI).
- **Provably fair sessions, settled on chain.** `open_session` escrows the stake and freezes the
  server's seed hash, the client seed and the offer. Rounds run off chain, each one signed and
  hash-chained. `settle_session` posts batches (every 50 rounds or 60 s) with the full round list in
  the transaction args; the contract checks the server signature and the chain before moving money.
  `close_session` reveals the seed, so anyone can replay everything. If the server stops answering,
  the player exits with `force_close` on their last signed state.
- **Gasless, popup-free play.** At first login the browser adds a function-call key limited to the
  four session methods. Session moves are NEP-366 meta-transactions relayed by
  `relayer.tilthouse.testnet`; deposits, owner actions and TILT burns are signed by the Privy wallet
  and relayed too. Players never hold NEAR for gas.
- **Every NPC is a NEAR account.** The 24 gamblers (`g-<name>.tilthouse.testnet`) are registered in
  the contract, sign their own `open_session` transactions and hold their own balances, which can
  only go to tables. NPC dealers (`ada.tilthouse.testnet`, …) control their tables.
- **Tokens:** tUSDC (NEP-141 test dollars) and $TILT (NEP-141), deposited with `ft_transfer_call`.
  **Login:** Privy (email, Google, X) with a NEAR embedded wallet.

## Poker

No-limit hold'em, 2–6 seats, at a table that is an LP pool on the floor like the others (Faye's,
seat 6 on the live floor); the table keeps a capped rake instead of a house edge (no flop no drop).

- **A seat is a session.** The buy-in is the session's escrow; each hand becomes one round in every
  player's session (stake = chips put in, payout = chips won after rake), settled on chain like any
  other round.
- **Fair deal, checkable after every hand.** Before the deal the server publishes
  `sha256(hand_seed)`; the deck follows from the hand seed and every seated player's own seed; at the
  end the seed and the full history are published (`GET /session/poker/tables/:id/hands/:hand`) and
  the browser and the CLI replay the hand. The dealer sees hole cards during a hand, as in any online
  card room; it cannot choose them.
- **Bots are labeled and follow published rules.** `core/src/poker_npc.rs` holds their whole
  strategy (starting-hand chart, equity against pot odds, three styles). They only fill empty seats
  while a human is seated and give their seat up when a human needs it.

## Live on NEAR testnet

| What | Account |
| --- | --- |
| USD floor (game contract) | [`floor.tilthouse.testnet`](https://testnet.nearblocks.io/address/floor.tilthouse.testnet) |
| TILT floor (same contract, TILT chips) | [`floor-tilt.tilthouse.testnet`](https://testnet.nearblocks.io/address/floor-tilt.tilthouse.testnet) |
| $TILT (NEP-141 memecoin) | [`tilt.tilthouse.testnet`](https://testnet.nearblocks.io/address/tilt.tilthouse.testnet) |
| tUSDC (NEP-141 test dollars) | [`tusdc.tilthouse.testnet`](https://testnet.nearblocks.io/address/tusdc.tilthouse.testnet) |
| Session server (signs settle and close) | [`sessions.tilthouse.testnet`](https://testnet.nearblocks.io/address/sessions.tilthouse.testnet) |
| Relayer (pays gas, chips faucet, TILT welcome) | [`relayer.tilthouse.testnet`](https://testnet.nearblocks.io/address/relayer.tilthouse.testnet) |
| NPC dealers | [`ada`](https://testnet.nearblocks.io/address/ada.tilthouse.testnet), [`bruno`](https://testnet.nearblocks.io/address/bruno.tilthouse.testnet) (dice), [`chloe`](https://testnet.nearblocks.io/address/chloe.tilthouse.testnet), [`dmitri`](https://testnet.nearblocks.io/address/dmitri.tilthouse.testnet) (roulette), [`eve`](https://testnet.nearblocks.io/address/eve.tilthouse.testnet) (blackjack), [`faye`](https://testnet.nearblocks.io/address/faye.tilthouse.testnet) (poker) `.tilthouse.testnet` |
| NPC gamblers (24, registered in the contract) | `g-mia`, `g-noah`, `g-zoe`, … `.tilthouse.testnet`, e.g. [`g-mia`](https://testnet.nearblocks.io/address/g-mia.tilthouse.testnet) |
| Keeper (rent, NPC pricing, salaries, daily close) | [`tilthouse.testnet`](https://testnet.nearblocks.io/address/tilthouse.testnet) |

Code hashes, deploy transactions and commits: `deployments/testnet.json`. Public APIs, same origin
as the site: `/session` and `/relayer` (USD floor), `/tilt/session` and `/tilt/relayer` (TILT floor),
e.g. the live gamblers feed `https://tilt-house-beta.vercel.app/session/gamblers/floor`.

## Repo map

- `core/`: pure Rust rules shared by everything: games (dice, roulette with inside bets and
  multi-spot spins, blackjack, no-limit hold'em in `poker.rs`), RNG, pools, the floor and seats,
  jackpot, `dealer_rules.rs`, `gambler_rules.rs`, `poker_npc.rs`, `session.rs`.
- `contract/`: the floor contract; sandbox tests in `contract/tests/`.
- `meme/`: the $TILT token contract and its rules (`meme/src/rules.rs`), with sandbox tests.
- `session-server/`: axum server for instant rounds (sign, chain, batch-settle, reveal), the poker
  tables and their hand archive, and the NPC gambler runner.
- `relayer/`: NEP-366 relayer with a strict allow-list, Privy-verified account activation, chip faucet
  and TILT welcome.
- `agents/`: the keeper (rent, NPC repricing and rent bids, gambler salaries, daily close, balance alerts).
- `web/`: Vite + React + three.js: the 3D floor, full-screen tables, the poker room, the $TILT page,
  owner dashboard, seat market, pools, the guided tour, the in-browser verifiers.
- `cli-demo/`: the terminal client for judges (`demo`, `poker`, `floor`, `verify-session`).
- `sim/`: the fast-forward simulator (a casino week; 60 days of $TILT). `token/`: tUSDC.
  `scripts/`: deploy and verification scripts. `deployments/`: what is deployed where. `docs/`:
  design and API docs (`docs/archive/`: the retired v1). `ops/`: service units.

## Safety by design

- **Solvent by construction.** A session's possible win is reserved from the pool's free bankroll at
  open (at most 10× the stake and 10 % of the free pool), so every payout is covered before the
  first round. Total edge is bounded to 1–5 % by the contract for every casino table, NPC or player.
- **Fair by construction.** The seed hash is frozen on chain before any round; each round is derived
  from `HMAC-SHA256(seed, client_seed:nonce)`; states are signed and hash-chained; the contract
  checks signatures and the chain before settling; the reveal makes the whole session replayable.
- **The player always has the last word.** `force_close` pays out the last signed state if the server
  stalls (after 600 s), and `claim_unrevealed` returns stake plus max win if the seed is never revealed.
- **Least privilege everywhere.** The browser game key can only call the four session methods with no
  deposit; NPC gamblers can only play sessions; only the token can start a Tilt Hour and only the
  floor can report a day; the relayer refuses anything outside its allow-list (methods, deposits,
  gas, actions, TTL), activates an account once, and rate-limits per sender, per IP and globally
  under a daily NEAR budget with a kill switch; the session server's key can only call
  `settle_session` and `close_session`; owner offers are clamped by the contract.
- **Testnet play money.** tUSDC and $TILT live on testnet; nothing is deployed on mainnet
  (`docs/mainnet.md` describes how it would be).

## Disclosure

- Tilt House is a new code base started on 2026-11-03 for this hackathon; its rules were written
  from scratch in `core/`.
- Libraries: near-sdk, near-contract-standards, near-workspaces, cargo-near, near-api-js, axum,
  tokio, ed25519-dalek, borsh, Privy, Hono, Vite, React, three.js, vitest, @noble/hashes; plus serde,
  sha2, hmac, bs58, anyhow, react-router and the rest listed in each `Cargo.toml` and `package.json`.
- AI coding agents were used to write code and documentation. The demo video's voice is synthetic (Kokoro TTS,
  voice `af_heart`); its music is "Patron Saint of Heists" by Bryan Teoh (public domain, FreePD) and its sound
  effects come from Kenney's audio packs and freesound.org (CC0).

## License

MIT, see `LICENSE`.
