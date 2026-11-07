# Tilt House

A small casino on NEAR testnet where the players own the house. Every table is run by an NPC dealer,
and every dealer is a liquidity pool: players play at the tables or put money into a dealer's pool
and earn (or lose) with it.

Hackathon track: **`games`** (Games With Real Economies).

- Players own the house: depositing into a dealer's pool mints LP tokens (NEP-245, one token id per dealer).
- Each NPC dealer has its own NEAR account, bankroll and temperament (greedy, promoter, cautious).
- Dealers reprice their tables (house edge, max bet, short boosts) from rules that run on chain, in
  the contract, from the pool and the last hour of play. Each change has a one-line reason.
- The economy moves without a developer patch: no constant is edited to change prices; dealers
  react to volume, streaks, idle time and liquidity, go bust, and reopen when LPs rescue them.

## Game loop

- **Play (fast):** pick a table (dice, roulette, blackjack) and play a round. A new round can start
  as soon as the previous one settles, about every 10 s (the VRF answer takes ~6–7 s).
- **Liquidity (whenever you want):** invest into a dealer's pool to get its LP tokens; the pool earns
  the edge on losing bets and pays winning ones, so the LP token's value moves. Divest burns LP
  tokens at the current value.
- **Busts and rescues:** a pool that can no longer cover its minimum bet closes its table
  ("closed · needs X to reopen"). New liquidity reopens it; rescuers buying a near-empty pool get
  most of it and dilute the old holders.
- **Competition:** dealers compete for players (lower edge, boosts) and for liquidity (better
  returns). Greedy dealers earn more per round but lose players; promoters fill tables but can bust.

## How NEAR is used

- **One Rust contract** (`contract/`, near-sdk 5) holds player balances, dealer pools, rounds and
  the NEP-245 LP share ledger, and runs the dealer pricing rules (`reprice`). Game and pool math
  come from one pure Rust crate (`core/`), shared with the simulator.
- **Randomness: OutLayer VRF, verified on chain.** Each bet step makes the contract call OutLayer
  `request_execution` (yield/resume). When OutLayer resumes it, the callback checks the proof with
  `env::ed25519_verify` against the stored OutLayer VRF public key, checks that the alpha is exactly
  `vrf:{id}:{signer}:round-{round}-{step}` and that `value == sha256(signature)`, then seeds the
  game RNG. Every round stores its proofs, so anyone can re-check it (`get_round`). For a relayed
  round the `signer` in the alpha is the relayer (it signs the outer transaction); the player is
  bound through the round record. Details: `docs/vrf-notes.md`, `docs/contract-api.md`.
- **No gas, no popups while playing:** at first login the browser adds a function-call key to the
  player's account, limited to the house contract and the 7 game methods. Moves are signed by that
  key as NEP-366 meta-transactions (`SignedDelegate`) and sent by a relayer that pays the gas.
  Deposits, withdrawals and LP moves are signed by the full-access key, also relayed.
- **Login:** Privy social login (email, Google, X) with a NEAR embedded wallet (implicit account).
- **Money:** tUSDC, our NEP-141 test token (6 decimals), deposited with `ft_transfer_call`.
- **Dealers:** each dealer is a NEAR sub-account with a function-call key for `reprice` only. The
  contract computes and clamps the offer, so a dealer key cannot move money or price out of bounds.
- **Not used: NEAR Intents.** It has no testnet (hackathon rule Q-007), and this project is testnet only.

## Live deployment (NEAR testnet)

| What | Account | Explorer |
| --- | --- | --- |
| House contract | `house.tilthouse.testnet` | https://testnet.nearblocks.io/address/house.tilthouse.testnet |
| Money token (tUSDC, NEP-141) | `tusdc.tilthouse.testnet` | https://testnet.nearblocks.io/address/tusdc.tilthouse.testnet |
| Relayer (pays gas, tUSDC minter) | `relayer.tilthouse.testnet` | https://testnet.nearblocks.io/address/relayer.tilthouse.testnet |
| Dealer Ada (dice, greedy) | `ada.tilthouse.testnet` | https://testnet.nearblocks.io/address/ada.tilthouse.testnet |
| Dealer Bruno (dice, promoter) | `bruno.tilthouse.testnet` | https://testnet.nearblocks.io/address/bruno.tilthouse.testnet |
| Dealer Chloe (roulette, cautious) | `chloe.tilthouse.testnet` | https://testnet.nearblocks.io/address/chloe.tilthouse.testnet |
| Dealer Dmitri (roulette, greedy) | `dmitri.tilthouse.testnet` | https://testnet.nearblocks.io/address/dmitri.tilthouse.testnet |
| Dealer Eve (blackjack, promoter) | `eve.tilthouse.testnet` | https://testnet.nearblocks.io/address/eve.tilthouse.testnet |
| Bots (play continuously, labeled as bots) | `bot-hunter`, `bot-loyal`, `bot-whale` `.tilthouse.testnet` | https://testnet.nearblocks.io/address/bot-hunter.tilthouse.testnet |
| OutLayer contract | `outlayer.testnet` | https://testnet.nearblocks.io/address/outlayer.testnet |
| OutLayer VRF project | `tilthouse.testnet/tilt-vrf`, version `898b0449aec714bc97dd9725dc6faaee19b2c1a702a87c9d457cf0d279b23d7a` (sha256 of the wasm) | |

A keeper process (`agents/`) makes each dealer call `reprice` every 60 s.

## Do X, see Y

<!-- TODO hosted URLs -->
**Hosted relayer and web URLs: to be filled before submission.** Until then, steps c and e need a
relayer URL in `$TILT_HOUSE_RELAYER`. Steps a, b, d and f need no keys and no relayer.

Prerequisites: Rust (stable), Node 22+, pnpm 12 (`corepack enable`), curl.

### a. Fast-forward a week of the economy (no keys, ~1 s)

```sh
cargo run -p tilt-house-sim --release -- --days 7 --seed 42 > /tmp/tilt-sim.json
node -e 'const d=JSON.parse(require("fs").readFileSync("/tmp/tilt-sim.json","utf8"));const ev=d.frames.flatMap(f=>f.events);console.log(ev.filter(e=>e.kind==="bust"||e.kind==="reopen").map(e=>`${e.t}s ${e.dealer} ${e.kind}: ${e.text}`).join("\n"));for(const x of d.frames.at(-1).dealers)console.log(x.id,"rake",x.rake_bp,"share",x.share_price,x.open?"open":"closed",x.reason)'
```

The simulator runs the same `core` rules as the contract (games, pools, `dealer_rules.rs`) with
simulated players (price hunters, loyal players, whales) and LPs. Deterministic per seed.

See: JSON with `dealers` (5) and `frames` (1 008, one per simulated 10 min). Each frame has every
dealer's `bankroll`, `share_price` (millionths of the launch price), `rake_bp`, `max_bet`, `boost`,
`open`, `reason`, plus `events` (`reprice`, `boost`, `bust`, `reopen`) with a readable `text`.
With seed 42: Bruno and Eve each bust twice and reopen after LPs bring liquidity back
(`closed: my pool can no longer cover a 0.10 USDC bet · needs 9.99 USDC to reopen`), about 290
boosts, and edges move within each dealer's bounds (Ada's rake between 100 and 487 bp). The web
app's `/sim` page plays this file as charts (`web/public/sim.json`).

### b. Read the live lobby (no keys)

```sh
curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"tilt","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"house.tilthouse.testnet","method_name":"get_lobby","args_base64":"e30="}}' \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s).result;for(const d of JSON.parse(Buffer.from(r.result).toString()))console.log(d.id,d.game,"edge",d.total_edge_bp,"bp","max",d.max_bet,d.open?"open":"closed","-",d.reason_text)})'
```

(`e30=` is base64 of `{}`.) Without the `node` part, `result.result` is the JSON as a byte array.

See: one line per dealer with its total edge (100–500 bp), max bet (tUSDC base units), open/closed
and the reason for its last reprice, e.g.
`bruno dice edge 152 bp max 1686880 open - raising my max bet and cutting my edge: fresh liquidity came in`.
Run it again later: the keeper reprices every 60 s, so max bets move as the bots play, and edges and reasons change when a dealer's situation does (idle table, streak, low bankroll…).
The full shape of `get_lobby`, `get_round`, `get_history` and `get_player` is in `docs/contract-api.md`.

### c. Play and verify from the terminal (CLI demo, no keys, no login)

```sh
pnpm install
pnpm --filter cli-demo demo                      # ~45 s end to end
pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet   # an NPC gambler's last session
pnpm --filter cli-demo floor                     # seats, rent, jackpot, tables, gamblers and their reasons
```

See: a throwaway implicit account activated gas-free by the public relayer (100 tUSDC), a 20 tUSDC deposit
into `floor.tilthouse.testnet`, the live floor, then sessions at the cheapest seated tables (12 dice rounds,
7 multi-spot roulette spins, a blackjack hand) with the latency of every round (tens of ms) and the signed
state checked each time; after close, every round is replayed from the revealed seed against the commitment
stored on chain (`get_session`), cross-checked with the `settle_session` tx args, with explorer links for the
open, settle and close txs, ending in `VERIFIED`. `verify-session <id>` runs that check alone on any session.
Details and options: `cli-demo/README.md`.

### d. Read the dealer rules

Open `core/src/dealer_rules.rs`. The module comment explains how a dealer prices its table; each
rule (`Idle`, `HotTable`, `LosingStreak`, `WinningStreak`, `LowBankroll`, `FreshLiquidity`, `Steady`)
says in one sentence why it fires. The contract runs this file in `reprice`, the simulator runs it
in step a, and the result is always clamped to a total edge of 1–5 % and a max bet the free bankroll
can cover.

### e. Web app

```sh
cd web && cp .env.example .env
# fill VITE_PRIVY_APP_ID, VITE_HOUSE_CONTRACT=house.tilthouse.testnet, VITE_RELAYER_URL=$TILT_HOUSE_RELAYER
pnpm dev
```

It needs a Privy app id: create an app on dashboard.privy.io with NEAR embedded wallets enabled
and `http://localhost:5173` in its allowed origins. There is no working default; without it you
cannot log in. The app refuses to start if a variable is missing (`web/README.md`).

See on http://localhost:5173: the lobby (`/`) with each dealer's edge, max bet, boost, reason and
pool; a table (`/table/:dealer`) where rounds play without any wallet popup and the VRF proofs are
re-checked in the browser; `/pools` (deposit, faucet, invest/divest, rescue a closed dealer);
`/dealers` (each dealer's log); `/sim` (step a as charts).

### f. Tests

```sh
cargo test --workspace
pnpm install && pnpm -r test
```

`cargo test --workspace` runs the `core` unit and property tests (payouts, edge bounds, pool math,
`reprice` bounds), the simulator tests, and near-workspaces sandbox tests of the token and the
house (deposit → bet → VRF callback → settle against a mock OutLayer, forged proofs rejected,
stuck-round refunds, bust and reopen, LP moves with open bets). The sandbox tests compile the
contracts to wasm (needs the `wasm32-unknown-unknown` target) and download the NEAR sandbox binary
on first run. `pnpm -r test` runs the vitest suites of the relayer (every refusal of the policy),
agents, web and cli-demo.

## Repo map

- `core/`: pure Rust rules shared by the contract and the simulator: dice, roulette, blackjack, RNG, pool math, `dealer_rules.rs`.
- `contract/`: the house contract (balances, pools, rounds, OutLayer VRF, NEP-245 LP shares, views); sandbox tests in `contract/tests/`.
- `token/`: tUSDC, the NEP-141 test token (minter-only `mint_to`, daily cap).
- `sim/`: fast-forward simulator (`tilt-house-sim`), a week of play in about a second, JSON out.
- `relayer/`: Hono server that relays NEP-366 meta-transactions under an allow-list, activates new accounts, runs the tUSDC faucet.
- `agents/`: the dealer keeper (each dealer calls `reprice` every 60 s) and the three bots.
- `web/`: Vite + React app: Privy login, lobby, tables, pools, dealer logs, sim charts.
- `cli-demo/`: terminal demo for judges (step c).
- `spikes/vrf/`: throwaway contract that proved the OutLayer VRF round trip on testnet (`vrfspike.tilthouse.testnet`).
- `scripts/`: testnet deploy scripts for the token and the house.
- `docs/`: design (`design.md`), plan (`plan.md`), contract API (`contract-api.md`), VRF notes (`vrf-notes.md`).

## Disclosure (rules Q-002, Q-005)

- **Existing project:** Tilt is an existing casino project on Solana by the same team (private
  repository). Tilt House is a new, separate code base started on 2026-11-03 for this hackathon. No
  code was copied from Tilt; the game rules were written fresh in `core/`.
- **Third-party libraries and tools:** near-sdk and near-contract-standards (Rust contracts),
  near-workspaces (sandbox tests), cargo-near, near-api-js (relayer, agents, web, CLI), OutLayer
  and its `vrf-example` wasm (`out-layer/vrf-example` @ `15b5024`, MIT/Apache-2.0, built by us and
  registered as the `tilt-vrf` project), Privy (`@privy-io/react-auth`), Hono, Vite and React
  (with react-router), vitest, borsh, ed25519-dalek, @noble/hashes.
- **AI:** AI coding agents were used to write code and documentation.

## Security notes

- **Testnet only, no real money.** tUSDC is a test token with no value; nothing is deployed on mainnet.
- **Solvency:** a pool accepts a bet only if its free bankroll (bankroll minus what backs open bets)
  covers the bet's worst-case payout; that amount stays reserved until the round ends. Total edge
  stays between 1 % and 5 %, so no table returns more than 99 % on average.
- **LP spread:** shares are bought at (bankroll + open stakes) and sold at (bankroll − reserved),
  so nobody can sell just before a known loss, and money backing open bets never leaves the pool.
- **Stuck rounds:** if OutLayer fails or never answers, anyone can call `refund_stuck_round`
  (at once for a `failed` round, after 120 s for `waiting_vrf`): the wager goes back to the player
  and the reserve is released. An abandoned blackjack hand can be stood by anyone after 600 s.
- **VRF checks:** one result only, exact alpha (round and step bound, so proofs cannot be replayed),
  ed25519 signature against the configured OutLayer key, output = sha256(signature). Any failure
  marks the step failed (refundable), never pays out.
- **Dealer keys** are function-call keys for `reprice` only; the contract computes and bounds the offer.
- **Relayer allow-list:** it only relays delegates to the house (game methods with no deposit;
  `withdraw`/`invest`/`divest`/`mt_transfer` with a full-access key), one `ft_transfer_call` to the
  house on the token, or one AddKey of a function-call key limited to the 7 game methods; at most
  4 actions and 300 TGas; rate limits per sender and overall (`relayer/README.md`).
- **Known limits:**
  - The VRF wasm's FastFS testnet URL was down when we registered it; OutLayer runs it from its
    cache (keyed by sha256). If the cache is evicted while FastFS is still down, rounds fail and are
    refunded until the cache is primed again (`docs/vrf-notes.md`).
  - Relayer rate limits and faucet/activation records are in memory and reset on restart.
  - The contract owner can change the VRF key and the pinned VRF version (needed for OutLayer key
    rotation); players trust the owner for that.
  - Not audited.

## License

MIT, see `LICENSE`.
