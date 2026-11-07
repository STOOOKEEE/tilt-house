# Tilt House

**A casino tycoon on NEAR where players own the tables and 24 NPC gamblers with their own wallets are
the customers.** Rent a seat on the floor, set your house edge, out-price your rivals, and watch AI
gamblers walk in, compare offers and bet real (testnet) money at your table. Every round is instant
and provably fair, and every result is settled on NEAR.

**Play now: https://tilt-house-beta.vercel.app** (log in with email, Google or X; 100 tUSDC on the house)
· guided tour of the economy: https://tilt-house-beta.vercel.app/?tour=1

Hackathon track: **Games With Real Economies** (`games`).

## The economy in 60 seconds

```
 salary (5 tUSDC/h per gambler) ──► 24 NPC gamblers, each a NEAR account with a wallet and a persona
                                          │ walk in, score every seated table, sit where the offer wins
                                          ▼
     table owners ◄── house edge ──── bets at a table (dice · roulette · blackjack)
   (players or NPC dealers,               │ every settled bet can hit the jackpot
    each table = an LP pool)              ▼
          │ pay rent by the hour ───► JACKPOT ───► paid out to a lucky bettor
          ▼
     6 seats on the floor: the closer to the entrance, the more foot traffic (×1.5 … ×0.6),
     the higher the rent. Outbid a seat, buy one on the seat market, or get evicted.
```

- **Owners compete for customers.** Gamblers pick tables by edge, max bet, boosts, seat traffic and
  loyalty, and say why ("Ada's 1.0 % beats Bruno's 2.4 %"). Undercut a rival and the bargain hunters
  follow; they undercut back and a price war starts.
- **Owners compete for space.** Seats are leased by the hour. Outbid the weakest seat by 10 %, buy a
  listed seat (NEP-245 `seat-<n>` tokens), or lose yours when the rent can't be paid.
- **Money is real inside the game.** Bankrolls back every bet, liquidity providers own the pools,
  rent feeds a jackpot that pays out on chain. The only inflow is the gamblers' salary, so the
  economy has a measurable budget.
- **It runs by itself.** NPC dealers reprice their tables from on-chain rules (`core/src/dealer_rules.rs`),
  NPC gamblers play around the clock, and the keeper collects rent every minute. A simulated week
  (seed 42) shows 101 price wars, 59 jackpots, 16 evictions, a seat sale and busted tables reopened
  by new liquidity.

## Do X, see Y

Prerequisites: Node 22+, pnpm (`corepack enable`), Rust stable (for b and e). No keys needed anywhere:
the demo makes its own throwaway testnet account.

```sh
git clone https://github.com/STOOOKEEE/tilt-house && cd tilt-house && pnpm install
```

### a. Watch the live economy

```sh
pnpm --filter cli-demo floor
```

See: the 6 seats with rent, prepaid time, edge, max bet, bankroll, last-hour P&L and each table's
pricing reason; the jackpot; and the NPC gamblers on the floor right now with what they are doing
and why, e.g. `Nina  regular  deciding  QA Big  QA Big's 1.0 % beats Ada's 3.2 %`. Run it again a
minute later: offers, rents and gamblers move.

### b. Play and verify, end to end on testnet (~1 minute)

```sh
pnpm --filter cli-demo demo
```

See: a throwaway account activated gas-free by the relayer with 100 tUSDC, a deposit into
`floor.tilthouse.testnet`, then sessions at the best tables: dice rounds and multi-spot roulette
spins answered in ~40 ms each (latency printed per round), and a blackjack hand when a blackjack
table is seated. At the end every round is replayed from the revealed seed and checked against the
on-chain commitment, with NearBlocks links for the open, settle and close transactions and a final
`✓ VERIFIED`. Exit code 0 means every check passed.

### c. Verify anyone's session, including an NPC's

```sh
pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet
pnpm --filter cli-demo verify-session <session_id>
```

See: the gambler's latest closed session (dozens of rounds), `sha256(seed)` matching the hash
committed on chain, every round replayed bit for bit, the hash chain equal to the one the contract
accepted, the rounds read back from the `settle_session` transaction args byte-identical, then
`✓ VERIFIED`. The verifier trusts the session server for nothing.

### d. Play in the browser

Open https://tilt-house-beta.vercel.app and log in. See: the 3D floor with gamblers walking between
tables; **How the house works** in the top bar (7-step tour on live data, including a fairness demo
with a "try to cheat a roll" button); a table in full screen where you click the felt to place chips,
hit **TILT** and get the result instantly, then **Leave table** to reveal the seed and **Verify every
round**. `/open` opens your own table, `/my-table` is the owner dashboard (traffic, revenue, rent,
P&L, offer controls, autopilot), `/seats` is the seat market, `/pools` backs a dealer.

### e. Fast-forward a week (no network, ~1 s)

```sh
cargo run -p tilt-house-sim --release -- --days 7 --seed 42 --out /tmp/tilt-sim.json
node -e 'const d=require("/tmp/tilt-sim.json");const c={};for(const e of d.frames.flatMap(f=>f.events))c[e.kind]=(c[e.kind]||0)+1;console.log(c)'
```

See: `{ reprice: 2416, boost: 802, opened: 3, seated: 17, rent: 624, jackpot: 59, price_war: 101,
bust: 5, evicted: 16, reopen: 5, seat_listed: 1, seat_sold: 1 }`. The simulator runs the exact same
`core` rules as the contract and the session server, with the 24 gamblers, 5 NPC dealers and three
scripted owners (an undercutter, a premium table and an owner who also gambles). The site's
**Fast-forward** page (`/sim`) plays this week as charts.

### f. Read the rules

- `core/src/gambler_rules.rs`: how a gambler arrives, scores tables, plans a session and remembers a
  good night. Plain-English module doc first.
- `core/src/dealer_rules.rs`: how a dealer prices its table; every rule says in one line why it fires.
- `core/src/session.rs`: the provably fair protocol shared by contract, server, browser and CLI.
- `docs/tycoon.md`, `docs/sessions.md`, `docs/floor.md`: the design; `docs/contract-api.md`: every
  method, view and event.

### g. Run the tests

```sh
cargo test --workspace
pnpm -r test
```

Rust: core unit and property tests (payouts, edge bounds, scoring monotonicity, money conservation
in the simulator, protocol vectors), the session server's HTTP tests (1,000 rounds well under a
second), and near-workspaces sandbox tests of the contract (sessions open/settle/close/verify, forged
and tampered states refused, outbid and unpaid-rent evictions, seat sales, forced exits, and every
token accounted for). TypeScript: relayer policy (every refusal), keeper, web (felt mapping,
session verification against Rust vectors), CLI.

## How NEAR is used

- **One contract, `floor.tilthouse.testnet`** (Rust, near-sdk 5): balances, table pools with NEP-245
  LP shares, the floor and its seat leases (NEP-245 `seat-<n>`), rent, the jackpot, and session
  escrow and settlement. All rules come from the `core` crate, the same code the simulator, the
  session server and the browser verifier use.
- **Provably fair sessions, settled on chain.** `open_session` escrows the stake and freezes the
  server's seed hash, the client seed and the offer. Rounds run off chain in ~40 ms, each one signed
  and hash-chained. `settle_session` posts batches (every 50 rounds or 60 s) with the full round list
  in the transaction args, and the contract verifies the server signature and the chain before
  moving money. `close_session` reveals the seed, so anyone can replay everything. If the server
  ever stops answering, the player exits with `force_close` on their last signed state.
- **Gasless, popup-free play.** At first login the browser adds a function-call key limited to the
  four session methods. Session moves are NEP-366 meta-transactions relayed by
  `relayer.tilthouse.testnet`; deposits and owner actions are signed by the Privy wallet and relayed
  too. Players never hold NEAR for gas.
- **Every NPC is a NEAR account.** 24 gamblers (`g-<name>.tilthouse.testnet`) sign their own
  `open_session` transactions and hold their own balances; NPC dealers (`ada.tilthouse.testnet`, …)
  control their tables. Their whole history is on NearBlocks.
- **Login:** Privy (email, Google, X) with a NEAR embedded wallet. **Money:** tUSDC, a NEP-141 test
  token, deposited with `ft_transfer_call`.

## Live on NEAR testnet

| What | Account |
| --- | --- |
| Game contract | [`floor.tilthouse.testnet`](https://testnet.nearblocks.io/address/floor.tilthouse.testnet) |
| Money token (tUSDC, NEP-141) | [`tusdc.tilthouse.testnet`](https://testnet.nearblocks.io/address/tusdc.tilthouse.testnet) |
| Session server (signs settle and close) | [`sessions.tilthouse.testnet`](https://testnet.nearblocks.io/address/sessions.tilthouse.testnet) |
| Relayer (pays gas, mints tUSDC) | [`relayer.tilthouse.testnet`](https://testnet.nearblocks.io/address/relayer.tilthouse.testnet) |
| NPC dealers | [`ada`](https://testnet.nearblocks.io/address/ada.tilthouse.testnet), [`bruno`](https://testnet.nearblocks.io/address/bruno.tilthouse.testnet) (dice), [`chloe`](https://testnet.nearblocks.io/address/chloe.tilthouse.testnet), [`dmitri`](https://testnet.nearblocks.io/address/dmitri.tilthouse.testnet) (roulette), [`eve`](https://testnet.nearblocks.io/address/eve.tilthouse.testnet) (blackjack) `.tilthouse.testnet` |
| NPC gamblers (24) | `g-mia`, `g-noah`, `g-zoe`, … `.tilthouse.testnet`, e.g. [`g-mia`](https://testnet.nearblocks.io/address/g-mia.tilthouse.testnet) |
| Keeper (rent, NPC pricing, salaries) | [`tilthouse.testnet`](https://testnet.nearblocks.io/address/tilthouse.testnet) |

Public APIs (same origin as the site): `https://tilt-house-beta.vercel.app/session` (sessions and
the live gamblers feed, `GET /session/gamblers/floor`) and `https://tilt-house-beta.vercel.app/relayer`.

## Repo map

- `core/`: pure Rust rules shared by everything: games (dice, roulette with inside bets and
  multi-spot spins, blackjack), RNG, pools, the floor and seats, jackpot, `dealer_rules.rs`,
  `gambler_rules.rs`, `session.rs`.
- `contract/`: the game contract; sandbox tests in `contract/tests/`.
- `session-server/`: axum server for instant rounds (sign, chain, batch-settle, reveal) and the NPC
  gambler runner.
- `relayer/`: NEP-366 relayer with a strict allow-list, account activation, tUSDC faucet.
- `agents/`: the keeper (rent, NPC repricing and rent bids, gambler salaries).
- `web/`: Vite + React + three.js: the 3D floor, full-screen tables, owner dashboard, seat market,
  pools, the guided tour, the in-browser verifier.
- `cli-demo/`: the terminal client for judges (steps a to c).
- `sim/`: the fast-forward simulator (step e).
- `token/`: tUSDC. `scripts/`: testnet deploy scripts. `docs/`: design and API docs.

## Safety by design

- **Solvent by construction.** A session's possible win is reserved from the pool's free bankroll at
  open (at most 10× the stake and 10 % of the free pool), so every payout is covered before the
  first round. Total edge is bounded to 1–5 % by the contract for every table, NPC or player.
- **Fair by construction.** The seed hash is frozen on chain before any round; each round is derived
  from `HMAC-SHA256(seed, client_seed:nonce)`; states are signed and hash-chained; the contract
  verifies signatures and the chain before settling; the reveal makes the whole session replayable.
- **The player always has the last word.** `force_close` pays out the last signed state if the server
  stalls (after 600 s), and `claim_unrevealed` returns stake plus max win if the seed is never revealed.
- **Least privilege everywhere.** The browser game key can only call the four session methods with no
  deposit; the relayer refuses anything outside its allow-list (methods, deposits, gas, actions, TTL)
  and rate-limits per sender, per IP and globally; the session server's key can only call
  `settle_session` and `close_session`; owner offers are clamped by the contract.
- **Testnet only.** tUSDC is a test token; nothing is deployed on mainnet.

## Disclosure

- Tilt is an earlier casino project by the same team on Solana (private). Tilt House is a separate
  code base started on 2026-11-03 for this hackathon; its rules were written from scratch in `core/`.
- Libraries: near-sdk, near-contract-standards, near-workspaces, cargo-near, near-api-js, axum,
  tokio, ed25519-dalek, borsh, Privy, Hono, Vite, React, three.js, vitest, @noble/hashes.
- AI coding agents were used to write code and documentation.

## License

MIT, see `LICENSE`.
