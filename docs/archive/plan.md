> **Archived.** This is the implementation plan of the retired v1 (per-round OutLayer VRF, contract `house.tilthouse.testnet`, LP shares). The live design is [tycoon.md](../tycoon.md), [floor.md](../floor.md) and [sessions.md](../sessions.md).

# Tilt House Implementation Plan

> For agentic workers: execute task by task; each task ends with its own tests green and a commit.

**Goal:** a NEAR testnet casino where each NPC dealer is a liquidity pool (LP shares as NEP-245), dealers reprice their table from on-chain rules, players play dice, roulette and blackjack with social login and no gas prompts, and a fast-forward page shows a week of the economy.

**Architecture:** all game and economy rules live in one pure Rust crate (`core`) compiled into the contract and into the simulator, so the live game and the fast-forward run the same code. The contract holds balances, pools, rounds and LP shares; randomness comes from OutLayer VRF through yield/resume. Dealers are NPC accounts that call `reprice` (rules in `core/src/dealer_rules.rs`); a TypeScript keeper drives them and the bots. Players use Privy (NEAR embedded wallet); game moves are signed by a browser function-call key and relayed as NEP-366 meta-transactions.

**Tech stack:** Rust (near-sdk 5.x, cargo-near 0.22), TypeScript (Node 22, near-api-js), Vite + React for web, Privy.

**Spec:** [`design.md`](design.md) (the "Calls" and "Game loop (revised)" sections override earlier ones).

## Global constraints

- NEAR testnet only. Master account `tilthouse.testnet` (key in `~/.near-credentials`, never in the repo).
- Money: Circle testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (6 decimals), token id configurable at init. Amounts are `u128` base units on chain and decimal strings across JSON boundaries. No floats for money anywhere.
- Randomness: OutLayer `outlayer.testnet` `request_execution`; VRF public key (testnet) `c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8`; verify with `env::ed25519_verify`; the alpha's user seed must contain the round id.
- Total edge per table in [100, 500] basis points against a perfect player; no game ever returns more than 99 %.
- A pool accepts a bet only if `bankroll − reserved ≥ worst_case_payout(bet)`.
- LP buy price = (bankroll + open stakes) / shares; LP sell price = (bankroll − open worst-case liabilities) / shares; price floor 1 base unit per share.
- Game rules are written fresh (not copied from the private Tilt repo).
- No secrets in the repo; `.env.example` files only.

## Review focus

1. A VRF callback that never comes (OutLayer down): the round must be refundable after a timeout (`refund_stuck_round`, stake back, reserve released). Test in Task 3.
2. Replayed or foreign VRF output (alpha for another round or another sender): rejected. Test in Task 3.
3. LP withdraw while bets are open: cannot take money reserved for open bets. Test in Task 2.
4. Dealer `reprice` called by anyone else or producing out-of-bounds values: rejected / clamped by `core`. Test in Tasks 1 and 3.
5. Relayer abuse: delegate actions to another receiver, other methods, or with deposits are refused; per-account rate limit. Test in Task 5.

---

### Task 1: `core` crate — games, pool math, dealer rules

**Files:** `core/Cargo.toml`, `core/src/{lib.rs,rng.rs,dice.rs,roulette.rs,blackjack.rs,pool.rs,dealer_rules.rs}`, tests inline (`#[cfg(test)]`) plus `core/tests/edges.rs`.

**Interfaces (produces):**
- `pub struct Rng` from a 32-byte seed: `Rng::new(seed: [u8; 32])`, `below(n: u32) -> u32` (unbiased, rejection sampling).
- `pub enum Game { Dice, Roulette, Blackjack }`; `BASE_EDGE_BP: fn(Game) -> u16` (dice 0 because dice pays fair before rake, roulette 270, blackjack computed by test `blackjack_base_edge` and hard-coded).
- Dice: `DiceBet { chance_bp: u16 /*100..=9800*/, over: bool }`, `dice_gross(stake: u128, bet, roll: u32 /*0..10000*/) -> u128` fair payout (stake × 10000 / chance).
- Roulette: `RouletteBet` (straight n, red, black, odd, even, low, high, dozen 1-3, column 1-3), `roulette_gross(stake, bet, pocket 0..=36) -> u128` (35:1, 1:1, 2:1).
- Blackjack: infinite shoe, 3:2, dealer stands on all 17, no hole card (dealer draws after player), 1 hand, hit/stand/double on first two cards. `BjState { player: Vec<u8>, dealer: Vec<u8>, doubled: bool, done: bool }`, `bj_deal(&mut Rng) -> BjState`, `bj_hit`, `bj_double`, `bj_stand(&mut Rng)` (dealer plays), `bj_gross(&BjState, stake) -> u128`, `bj_total(&[u8]) -> (u8 total, bool soft)`.
- Rake: `apply_rake(gross: u128, stake: u128, rake_bp: u16) -> u128` takes `rake_bp` of the gain only when gross > stake… must make total edge ≥ 1 %: the test `total_edge_bounds` simulates (dice: exact formula; roulette: exact; blackjack: 2 000 000 hands with basic strategy without split) and asserts `base + effective rake ∈ [100, 500]` for every allowed rake. `rake_bounds(Game) -> (u16 min, u16 max)` returns the rake range that keeps total edge in [100, 500].
- Worst case: `worst_case_payout(game, stake, &bet) -> u128` (blackjack: doubled blackjack-free max = 4 × stake… use 2 × (2 × stake)).
- Pool: `Pool { bankroll: u128, shares: u128, reserved: u128, open_stakes: u128 }`, `buy_shares(&mut self, amount) -> u128`, `sell_shares(&mut self, shares) -> Result<u128, PoolError>` (refuses if payout > bankroll − reserved), `can_cover(&self, worst: u128) -> bool`, `is_open(&self, min_bet: u128, game) -> bool`.
- Dealer rules (the ONE readable file, comments are the explanation shown to judges): `Temperament { greed: u8, caution: u8, promo: u8 }`, `Stats { bets_1h: u32, volume_1h: u128, player_net_1h: i128, idle_secs: u64, inflow_1h: i128 }`, `Offer { rake_bp: u16, max_bet: u128, boost_until: u64, reason: Reason }`, `enum Reason { Idle, HotTable, LosingStreak, WinningStreak, LowBankroll, FreshLiquidity, Steady }`, `reprice(game, &Pool, &Stats, &Temperament, now: u64) -> Offer` (always within `rake_bounds`, `max_bet` ≤ what the pool covers, boost ≤ 15 min).

**Tests:** fairness of `Rng::below` (chi-square smoke on 1e6 draws), each game's payouts, `total_edge_bounds`, pool buy/sell/withdraw-with-reserve, `reprice` bounds as a property test over random inputs, one test per `Reason`.

### Task 2: simulator (fast-forward)

**Files:** `sim/Cargo.toml`, `sim/src/main.rs`, `sim/src/players.rs`.
**Consumes:** all of `core`.
**Produces:** `cargo run -p sim -- --days 7 --seed 42 --out web/public/sim.json`. JSON: `{ "dealers": [{ "id", "name", "game", "temperament" }], "frames": [{ "t": secs, "dealers": [{ "id", "bankroll", "share_price", "rake_bp", "max_bet", "open", "reason" }], "events": [{ "dealer", "kind": "bust"|"reopen"|"boost"|"reprice", "text" }] }] }`, one frame per simulated 10 minutes (1 008 frames), amounts as strings.
Simulated agents: price-hunting players (go to lowest edge), loyal players, whales (rare big bets), LPs that move liquidity toward the best 24 h return and rescue busted dealers when cheap. Deterministic for a seed.
**Tests:** same seed → same JSON; at least one bust and one reopen with seed 42 over 7 days (tune player mix, not rules, to get it).

### Task 3: `house` contract

**Files:** `contract/Cargo.toml`, `contract/src/{lib.rs,ft.rs,mt.rs,rounds.rs,dealers.rs,vrf.rs,views.rs}`, `contract/tests/sandbox.rs` (near-workspaces).
**Consumes:** `core`.
**Interface (methods, JSON):**
- `new(owner, token: AccountId, outlayer: AccountId, vrf_pubkey_hex: String, vrf_source: serde_json::Value)`.
- Deposits: `ft_on_transfer(sender_id, amount, msg)` with msg `""` (credit balance) or `{"invest": dealer_id}` (buy LP shares).
- `withdraw(amount: U128)` (1 yocto, full key) → `ft_transfer` with rollback on failure.
- `invest(dealer_id, amount)` / `divest(dealer_id, shares)` from in-contract balance.
- NEP-245 subset: `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_transfer` (1 yocto), events `mt_mint`, `mt_burn`, `mt_transfer` per NEP-245 event format. Token id = dealer id.
- Dealers: `add_dealer(id, name, game, temperament, dealer_account, seed_amount)` (owner; seed bought as owner's LP shares), `reprice(dealer_id)` callable only by that dealer's account; stats kept in 6 × 10-min buckets.
- Play (function-call key allowed, no deposit): `bet_dice(dealer_id, stake: U128, chance_bp, over)`, `bet_roulette(dealer_id, stake, bet)`, `bj_deal(dealer_id, stake)`, `bj_hit(round_id)`, `bj_double(round_id)`, `bj_stand(round_id)`. Each stake is taken from the player balance, reserve = worst case, then a VRF request with seed `round-{id}-{step}`; `on_vrf(round_id, step)` (private) parses OutLayer output, checks the signature and that alpha ends with `:round-{id}-{step}`, settles or advances. `refund_stuck_round(round_id)` after 120 s without a result.
- The contract attaches its own NEAR to OutLayer calls (players hold no NEAR).
- Views: `get_lobby() -> Vec<DealerView>`, `get_player(account) -> PlayerView`, `get_round(id)`, `get_history(dealer_id, from, limit)`.
**Tests:** sandbox: deposit → bet → (mock OutLayer contract in tests that answers with a signature from a test keypair) → settle; invest/divest with open bets; bust closes the table and invest reopens it; stuck round refund; forged alpha rejected; `reprice` by a stranger rejected.

### Task 4: VRF module and testnet deploy script

**Files:** `vrf/` (only if the published `out-layer/vrf-example` wasm cannot be called through `WasmUrl`), `scripts/deploy-testnet.sh`, `scripts/.env.example`.
Deploys to `house.tilthouse.testnet`, creates dealer accounts `<name>.tilthouse.testnet` with function-call keys for `reprice`, funds the contract with testnet NEAR for OutLayer fees, seeds dealers with test USDC if available.
**Test:** one real dice round on testnet settles through OutLayer; tx hashes printed.

### Task 5: relayer

**Files:** `relayer/` (Node, Hono): `POST /relay` takes a base64 `SignedDelegate`; accepts only receiver = house contract, actions = FunctionCall with zero deposit to the allow-list (`bet_*`, `bj_*`, `refund_stuck_round`) or the one-time `AddKey` of a function-call key for the house contract; per-account and global rate limits; submits with the relayer key from env. Unit tests for every refusal.

### Task 6: dealer keeper and bots

**Files:** `agents/src/{keeper.ts,bots.ts,near.ts}`. Keeper: every 60 s, for each dealer, sign `reprice` with its own key. Bots: 3 regulars with funded testnet accounts playing through the relayer path, labeled `bot-*` in the lobby. Tests: dry-run mode that prints the calls.

### Task 7: web

**Files:** `web/` (Vite + React + TS). Pages: lobby (dealers: game, edge, max bet, boost, mood + reason tooltip, pool size, LP price 24 h change, open/closed), table (dice, roulette, blackjack; next round as soon as the previous settles), pools (my LP tokens, invest/divest, rescue closed dealers), dealer log, `/sim` (renders `sim.json`: bankrolls, share prices, edges, events timeline with a play button). Login: Privy NEAR embedded wallet; first login adds a browser function-call key via the relayer; moves signed by that key and relayed. Deposit/withdraw/invest via Privy signature. Terminal look from Tilt's palette (pink, gold, green, red on dark). Tests: vitest for the formatting and the delegate-action builder; one Playwright smoke on the lobby with a mocked RPC.

### Task 8: judge path, README, LICENSE

**Files:** `cli-demo/` (creates a throwaway testnet account through the faucet helper, gets test USDC, plays a dice round, buys an LP share, prints explorer links), `README.md` (what, why, NEAR role, "do X, see Y" for web, sim and CLI, list of reused libraries), `LICENSE` (MIT).
