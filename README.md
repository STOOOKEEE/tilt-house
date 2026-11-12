# Tilt House

[![CI](https://github.com/STOOOKEEE/tilt-house/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/STOOOKEEE/tilt-house/actions/workflows/ci.yml)
[![Verify deployment](https://github.com/STOOOKEEE/tilt-house/actions/workflows/verify-deployment.yml/badge.svg?branch=main)](https://github.com/STOOOKEEE/tilt-house/actions/workflows/verify-deployment.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![NEAR testnet](https://img.shields.io/badge/NEAR%20testnet-floor.tilthouse.testnet-00c08b)](https://testnet.nearblocks.io/address/floor.tilthouse.testnet)

A casino tycoon on NEAR. Players own the tables; 24 NPC gamblers, each with its own NEAR wallet,
are the customers. Owners rent seats on the floor by the hour, set their house edge and compete for
the gamblers, who compare every table and say why they sit where they sit. Rent fills a jackpot that
any settled bet can win. Dice, roulette, blackjack and multiplayer no-limit hold'em, every round
answered in tens of milliseconds and provably fair, settled on NEAR testnet.

- **Play:** https://tilt-house-beta.vercel.app (email, Google or X login; 100 test chips on the house).
  Guided tour of the economy: https://tilt-house-beta.vercel.app/?tour=1 · poker: https://tilt-house-beta.vercel.app/poker
- **Track:** `games` (Games With Real Economies).

## Judge it in one minute

Node 22+ and pnpm (`corepack enable`). No keys, no config: the command makes its own throwaway
testnet account.

```sh
git clone https://github.com/STOOOKEEE/tilt-house && cd tilt-house && pnpm install
pnpm --filter cli-demo demo --new
```

See: the relayer activates a brand-new account with no wallet and no gas, it deposits 20 test chips,
plays dice, a multi-spot roulette spin and a blackjack hand (each round answered in ~30–40 ms), then
replays every round from the seed revealed on chain and prints `✓ Demo complete: every round
verified against the chain.` (exit code 0 only if every check passed).

Then:

```sh
pnpm --filter cli-demo floor                                            # the live economy: seats, rents, prices and why, gamblers and why
pnpm --filter cli-demo poker                                            # two accounts play hold'em with the NPC bots, every hand verified
pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet  # verify an NPC gambler's latest session from chain data
```

## Track fit (`games`: Games With Real Economies)

Official text: "Build NPCs with wallets, player-owned markets and economies that evolve without a
dev patch. Judged on the game loop, not the token — bonus if players never notice the chain."
Hints: Agent NPCs, Social login, NEAR Intents, NEP-245.

| Criterion | What Tilt House does | Check it |
| --- | --- | --- |
| NPCs with wallets | 24 NPC gamblers, each its own NEAR account `g-<name>.tilthouse.testnet` with its own in-contract balance; they sign their own `open_session` transactions. 5 NPC dealers (`ada`, `bruno`, `chloe`, `dmitri`, `eve`) control their tables from their own accounts. Every choice comes from one readable rules file. | `core/src/gambler_rules.rs`, `core/src/dealer_rules.rs`; claims 1–3 below |
| Player-owned markets | Any player opens a table (an LP pool they found), rents one of 6 seats by the hour, outbids the weakest seat, buys or sells seats on the seat market (seat leases are NEP-245 tokens `seat-<n>`), and anyone can buy LP shares of any table. | `docs/floor.md`, `docs/tycoon.md`; claims 7–10 |
| Economies that evolve without a dev patch | NPC dealers reprice from on-chain rules, gamblers move to better offers, unpaid rent evicts, rent fills a jackpot that pays a bettor, the only inflow is a capped hourly salary. A simulated week (seed 42) produces 101 price wars, 59 jackpots, 16 evictions, a seat sale and busted tables reopened by new liquidity, with money conserved at every frame. | claims 4–6, 10 |
| Players never notice the chain | Social login (Privy: email, Google, X) with an embedded NEAR wallet; a function-call key limited to the session methods; moves relayed as NEP-366 meta-transactions, so no gas and no popups; rounds answer in ~40 ms off chain and settle on chain in batches. | `relayer/src/policy.ts`, `docs/sessions.md`; claims 11, 16, 18 |
| Hint: Agent NPCs | Yes: gamblers, dealers (rule-based agents with personas and temperaments, each with a wallet). | `core/src/gambler_rules.rs` |
| Hint: Social login | Yes: Privy (email, Google, X), NEAR embedded wallet. | https://tilt-house-beta.vercel.app |
| Hint: NEP-245 | Yes: LP shares of every table and the seat leases `seat-<n>` are NEP-245 tokens of `floor.tilthouse.testnet`. | `contract/src/mt.rs`; claim 7 |
| Hint: NEAR Intents | Not used: Intents have no testnet (HACKATHON.md Q-007) and the game runs on testnet play money. | — |

## Game loop

From `docs/tycoon.md` and `docs/floor.md`, by time scale (constants from the code):

- **Every 30 s: a customer decides.** A gambler arriving on the floor (arrivals are drawn every
  minute, with a day/night curve) scores every seated table on edge, boost, max bet, seat traffic,
  loyalty and the jackpot, then walks to the best one or leaves, and says why ("Ada's 1.0 % beats
  Bruno's 2.4 %"). Seated, it bets a round every 3 s; a human's round answers in ~40 ms. Every
  settled bet can hit the jackpot.
- **Every 5 min: the market moves.** The keeper passes every minute: it collects rent into the
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

## Check every claim yourself

Prerequisites: Node 22+, pnpm, Rust stable with `wasm32-unknown-unknown` and `cargo-near` (for
the sandbox tests), from the repo root after `pnpm install`. Claims 7 and 19 use this helper, which calls a view of
`floor.tilthouse.testnet` over public RPC:

```sh
view() { node -e 'fetch("https://test.rpc.fastnear.com",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:"floor.tilthouse.testnet",method_name:process.argv[1],args_base64:btoa(process.argv[2]??"{}")}})}).then(r=>r.json()).then(j=>console.log(Buffer.from(j.result.result).toString()))' "$@"; }
```

| # | Claim | Command | Output (2026-11-12) |
| --- | --- | --- | --- |
| 1 | NPC gamblers sign their own transactions from their own wallets | `node -e 'fetch("https://api-testnet.nearblocks.io/v3/accounts/g-mia.tilthouse.testnet/txns").then(r=>r.json()).then(j=>j.data.slice(0,3).forEach(t=>console.log(t.signer_account_id,t.actions[0].method,t.receiver_account_id)))'` | `g-mia.tilthouse.testnet open_session floor.tilthouse.testnet` (×3) |
| 2 | An NPC's session is provably fair, checked from on-chain data only | `pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet` | `✓ 23 rounds read back from settle tx args match` … `✓ sha256(revealed seed) = on-chain commitment · 23 rounds replay bit for bit · hash chain ends on chain's` … `✓ VERIFIED from on-chain data: every outcome follows from the seed committed before the first bet.` (exit 0) |
| 3 | The NPC gamblers are live, with a reason for every choice | `curl -s https://tilt-house-beta.vercel.app/session/gamblers/floor` | `[{"id":"g-iris","name":"Iris","persona":"thrill_seeker","state":"seated","dealer_id":"bruno","seat":1,"reason_code":"cheapest","reason":"Bruno's 1.0 % beats Dmitri's 2.7 %","balance":"183652889","session_net":"-3802755"}]` |
| 4 | The live economy: seats, rents, prices and why each table priced itself so | `pnpm --filter cli-demo floor` | `jackpot 105.882098 tUSDC · rent to take a seat now ≥ 1.10 tUSDC/h` … `1  Ada  dice  NPC  1.50  accruing  3.75% … cutting my edge under a rival's: players went to the cheaper table` … `6  Faye  poker  NPC  1.00  117 min  1.70% … raising my max bet and cutting my edge: fresh liquidity came in` (floor section as printed by `demo` in claim 18) |
| 5 | A week of the economy, same rules as the contract | `cargo run -p tilt-house-sim --release -- --days 7 --seed 42 --out /tmp/tilt-sim.json && node -e 'const d=require("/tmp/tilt-sim.json");const c={};for(const e of d.frames.flatMap(f=>f.events))c[e.kind]=(c[e.kind]\|\|0)+1;console.log(c)'` | `{ reprice: 2416, boost: 802, opened: 3, seated: 17, rent: 624, jackpot: 59, price_war: 101, bust: 5, evicted: 16, reopen: 5, seat_listed: 1, seat_sold: 1 }` |
| 6 | Money is conserved over that week (salary is the only inflow), pools stay solvent | `cargo test -p tilt-house-sim week_42` | `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out` |
| 7 | Seat leases are NEP-245 tokens held by the seated table's controller | `view get_floor` then `view mt_balance_of '{"account_id":"ada.tilthouse.testnet","token_id":"seat-1"}'` | `{"seats":[{"seat":1,"token_id":"seat-1","traffic_bp":15000,…,"dealer_id":"ada","controller":"ada.tilthouse.testnet",…` then `"1"` |
| 8 | A player opens a table, bids for a seat and an outbid evicts the weakest table | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test open_table_bid_and_outbid_eviction ... ok` |
| 9 | Seat market: a sale moves the seat and pays the seller | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test seat_sale_moves_the_seat_and_the_price ... ok` |
| 10 | Unpaid rent evicts the table and feeds the jackpot | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test unpaid_rent_evicts_and_feeds_the_jackpot ... ok` |
| 11 | A session opens, settles on chain and reveals a seed anyone can verify; every token stays accounted for (`assert_conserved`) | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test session_open_settle_close_reveals_a_verifiable_seed ... ok` |
| 12 | Multi-spot roulette spins settle and verify | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test multi_spot_roulette_rounds_settle_and_verify ... ok` |
| 13 | If the server stalls, the player exits on their last signed state, and is paid stake + max win if the seed is never revealed | `cargo test -p tilt-house-contract --test sandbox` (one run covers claims 8–13) | `test force_close_after_timeout_then_claim_unrevealed ... ok`, then `test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` (6–25 min: the rent test fast-forwards the sandbox by 2 h 10 min) |
| 14 | Every table's total edge stays within 1–5 % | `cargo test -p tilt-house-core --test edges` | `test dice_total_edge_bounds ... ok`, `test roulette_total_edge_bounds ... ok`, `test blackjack_total_edge_bounds ... ok`, `test blackjack_base_edge ... ok`, `test result: ok. 4 passed; 0 failed` |
| 15 | The browser/CLI verifier matches the Rust protocol (shared vectors) and refuses forged or rewritten rounds | `cargo test -p tilt-house-session-server --test vectors && pnpm --filter @tilt-house/web exec vitest run src/near/session-client.test.ts` | `test web_vectors_match_the_rust_protocol ... ok`, `test result: ok. 1 passed; 0 failed`, then `Test Files  1 passed (1)`, `Tests  29 passed (29)` |
| 16 | The relayer refuses everything outside its allow-list | `pnpm --filter @tilt-house/relayer test` | `Test Files  7 passed (7)`, `Tests  158 passed (158)` |
| 17 | The floor contract on chain is a reproducible build of this repo (NEP-330 names the commit; pinned docker image) | `scripts/verify-deployment.sh testnet` (needs docker and cargo-near; ~1–5 min) | `PASS  floor floor.tilthouse.testnet: chain code_hash 4w1gvFSNptiPii6ckeiokJ13KkX5XKZR9MQhNTZvmQee = recorded`, `PASS  floor floor.tilthouse.testnet: reproducible build of contract/ at 5266c54 = chain (4w1gvFSNptiPii6ckeiokJ13KkX5XKZR9MQhNTZvmQee)`, `PASS  token tusdc.tilthouse.testnet: chain code_hash 6P86ptN89U9Pj7RaUKsHE6T25AvWv35XkB3UnPEnK3M9 = recorded`, `SKIP  token …: not built reproducibly`, `PASS` |
| 18 | Play end to end on testnet with a brand-new account, no wallet and no gas: rounds answer in tens of milliseconds and every one is verified against the chain | `pnpm --filter cli-demo demo --new` | `✓ the relayer activated it: gas money, token registration, 100 tUSDC`, `✓ deposited 20.00 tUSDC into floor.tilthouse.testnet (ft_transfer_call)`, … `21 instant requests over 3 sessions: median 30 ms, p90 81 ms, max 94 ms`, `✓ dice …`, `✓ roulette …`, `✓ blackjack …`, `✓ Demo complete: every round verified against the chain.` (exit 0) |
| 19 | The NPC gamblers are a fixed list registered in the floor contract (their money can only go to tables) | `view get_npcs` | `["g-mia.tilthouse.testnet","g-noah.tilthouse.testnet","g-zoe.tilthouse.testnet",…` (24 accounts) |
| 20 | Poker: several players at one table, every hand replayable from a seed committed before the deal, rake to the table, settled on chain per player | `pnpm --filter cli-demo poker` (two throwaway accounts play hold'em with the NPC bots, then verify) | `pot 1.10 tUSDC · rake 0.0187 · showdown · winner B +1.0813 (two pair)`, `✓ seed ↔ commitment · deck from 4 client seeds · legal replay · history hash · chips in 1.10 = out 1.0813 + rake 0.0187`, … `✓ VERIFIED: every hand replays from its revealed seed and every round matches the chain.` (exit 0) |
| 21 | NPC gamblers can only play: withdraw, invest, divest, open a table, trade seats or tokens are refused; salary arrives only from the keeper | `cargo test -p tilt-house-contract --test sandbox npc_gamblers_only_play_sessions_and_take_salary_from_the_keeper` | `test npc_gamblers_only_play_sessions_and_take_salary_from_the_keeper ... ok` |
| 22 | A poker hand settles for every player and the table pool keeps exactly the rake; books balance | `cargo test -p tilt-house-contract --test sandbox poker_hand_settles_for_both_players_and_the_pool_keeps_the_rake` | `test poker_hand_settles_for_both_players_and_the_pool_keeps_the_rake ... ok` |
| 23 | A table's owner can rename it and retire it once off the floor and fully owned; retired tables leave the lobby | `cargo test -p tilt-house-contract --test sandbox controller_renames_and_retires_an_off_floor_table` | `test controller_renames_and_retires_an_off_floor_table ... ok` |


## How NEAR is used

- **One contract, `floor.tilthouse.testnet`** (Rust, near-sdk 5): balances, table pools with NEP-245
  LP shares, the floor and its seat leases (NEP-245 `seat-<n>`), rent, the jackpot, the registry of
  NPC gamblers, and session escrow and settlement for every game including poker. All rules come
  from the `core` crate, the same code the simulator, the session server and the verifiers use.
  The deployed code is a reproducible build of this repository: the contract publishes its commit
  (NEP-330 `contract_source_metadata`) and `scripts/verify-deployment.sh` rebuilds it and compares
  the hash with the chain (`deployments/testnet.json`).
- **Provably fair sessions, settled on chain.** `open_session` escrows the stake and freezes the
  server's seed hash, the client seed and the offer. Rounds run off chain, each one signed and
  hash-chained. `settle_session` posts batches (every 50 rounds or 60 s) with the full round list in
  the transaction args; the contract checks the server signature and the chain before moving money.
  `close_session` reveals the seed, so anyone can replay everything. If the server stops answering,
  the player exits with `force_close` on their last signed state.
- **Gasless, popup-free play.** At first login the browser adds a function-call key limited to the
  four session methods. Session moves are NEP-366 meta-transactions relayed by
  `relayer.tilthouse.testnet`; deposits and owner actions are signed by the Privy wallet and relayed
  too. Players never hold NEAR for gas.
- **Every NPC is a NEAR account.** The 24 gamblers (`g-<name>.tilthouse.testnet`) are registered in
  the contract, sign their own `open_session` transactions and hold their own balances, which can
  only go to tables. NPC dealers (`ada.tilthouse.testnet`, …) control their tables. Their whole
  history is on NearBlocks.
- **Login:** Privy (email, Google, X) with a NEAR embedded wallet. **Chips:** tUSDC, a NEP-141 test
  token, deposited with `ft_transfer_call`.

## Poker

No-limit hold'em, 2–6 seats, at a table that is an LP pool on the floor like the others (Faye's,
seat 6 on the live floor); the table keeps a capped rake instead of a house edge (1.70 % at Faye,
no flop no drop).

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
| Game contract | [`floor.tilthouse.testnet`](https://testnet.nearblocks.io/address/floor.tilthouse.testnet) |
| Chips (tUSDC, NEP-141) | [`tusdc.tilthouse.testnet`](https://testnet.nearblocks.io/address/tusdc.tilthouse.testnet) |
| Session server (signs settle and close) | [`sessions.tilthouse.testnet`](https://testnet.nearblocks.io/address/sessions.tilthouse.testnet) |
| Relayer (pays gas, mints chips) | [`relayer.tilthouse.testnet`](https://testnet.nearblocks.io/address/relayer.tilthouse.testnet) |
| NPC dealers | [`ada`](https://testnet.nearblocks.io/address/ada.tilthouse.testnet), [`bruno`](https://testnet.nearblocks.io/address/bruno.tilthouse.testnet) (dice), [`chloe`](https://testnet.nearblocks.io/address/chloe.tilthouse.testnet), [`dmitri`](https://testnet.nearblocks.io/address/dmitri.tilthouse.testnet) (roulette), [`eve`](https://testnet.nearblocks.io/address/eve.tilthouse.testnet) (blackjack), [`faye`](https://testnet.nearblocks.io/address/faye.tilthouse.testnet) (poker) `.tilthouse.testnet` |
| NPC gamblers (24, registered in the contract) | `g-mia`, `g-noah`, `g-zoe`, … `.tilthouse.testnet`, e.g. [`g-mia`](https://testnet.nearblocks.io/address/g-mia.tilthouse.testnet) |
| Keeper (rent, NPC pricing, salaries) | [`tilthouse.testnet`](https://testnet.nearblocks.io/address/tilthouse.testnet) |

Code hashes, deploy transactions and commits: `deployments/testnet.json`. Public APIs, same origin
as the site: `https://tilt-house-beta.vercel.app/session` (sessions, poker tables, the live gamblers
feed `GET /session/gamblers/floor`) and `https://tilt-house-beta.vercel.app/relayer`.

A mainnet deployment with play-money chips is prepared in `docs/mainnet.md` (NPC accounts with
session-only keys, relayer activation bound to a verified Privy login, daily NEAR budget, kill
switch); the site has a testnet/mainnet switch that turns on once it is deployed.

## Repo map

- `core/`: pure Rust rules shared by everything: games (dice, roulette with inside bets and
  multi-spot spins, blackjack, no-limit hold'em in `poker.rs`), RNG, pools, the floor and seats,
  jackpot, `dealer_rules.rs`, `gambler_rules.rs`, `poker_npc.rs`, `session.rs`.
- `contract/`: the game contract; sandbox tests in `contract/tests/`.
- `session-server/`: axum server for instant rounds (sign, chain, batch-settle, reveal), the poker
  tables and their hand archive, and the NPC gambler runner.
- `relayer/`: NEP-366 relayer with a strict allow-list, Privy-verified account activation, chip faucet.
- `agents/`: the keeper (rent, NPC repricing and rent bids, gambler salaries, balance alerts).
- `web/`: Vite + React + three.js: the 3D floor, full-screen tables, the poker room, owner dashboard,
  seat market, pools, the guided tour, the in-browser verifiers.
- `cli-demo/`: the terminal client for judges (`demo`, `poker`, `floor`, `verify-session`).
- `sim/`: the fast-forward simulator. `token/`: tUSDC. `scripts/`: deploy and verification scripts.
  `deployments/`: what is deployed where. `docs/`: design and API docs (`docs/archive/`: the retired v1).

## Safety by design

- **Solvent by construction.** A session's possible win is reserved from the pool's free bankroll at
  open (at most 10× the stake and 10 % of the free pool), so every payout is covered before the
  first round. Total edge is bounded to 1–5 % by the contract for every table, NPC or player.
- **Fair by construction.** The seed hash is frozen on chain before any round; each round is derived
  from `HMAC-SHA256(seed, client_seed:nonce)`; states are signed and hash-chained; the contract
  checks signatures and the chain before settling; the reveal makes the whole session replayable.
- **The player always has the last word.** `force_close` pays out the last signed state if the server
  stalls (after 600 s), and `claim_unrevealed` returns stake plus max win if the seed is never revealed.
- **Least privilege everywhere.** The browser game key can only call the four session methods with no
  deposit; NPC gamblers can only play sessions; the relayer refuses anything outside its allow-list
  (methods, deposits, gas, actions, TTL), activates an account once, and rate-limits per sender, per
  IP and globally under a daily NEAR budget with a kill switch; the session server's key can only
  call `settle_session` and `close_session`; owner offers are clamped by the contract.
- **Testnet play money.** tUSDC is a test token with no value.

## Disclosure

- Tilt is an earlier casino project by the same team on Solana (private). Tilt House is a separate
  code base started on 2026-11-03 for this hackathon; its rules were written from scratch in `core/`.
- Libraries: near-sdk, near-contract-standards, near-workspaces, cargo-near, near-api-js, axum,
  tokio, ed25519-dalek, borsh, Privy, Hono, Vite, React, three.js, vitest, @noble/hashes.
- AI coding agents were used to write code and documentation.

## License

MIT, see `LICENSE`.
