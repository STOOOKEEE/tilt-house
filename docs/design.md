# Tilt House — design (NEAR Hackathon, track `games`)

> Update after Armand's review (2026-11-03): play has no fixed rhythm (a new round as soon as the
> previous one ends, typically every ~10 s), and ownership is described plainly as **liquidity
> pools**: each dealer is a pool, its shares are LP tokens. Sections "Game loop" and goal 3 below
> are superseded by the "Game loop (revised)" section at the end.

Date: 2026-11-03. Deadline: submissions close 2026-11-14 23:59 UTC. Judging by Claude Code and
Codex (screening) then humans, on the game loop; bonus if players never notice the chain.

## Intent

A small casino where **players own the house**. Every table is run by an NPC dealer: an agent
with its own NEAR account, a bankroll and a temperament. The dealer prices its table (house edge,
max bet, short boosts) from its bankroll and recent play. Players either play at the tables or
buy shares of a dealer and live off its margin. A dealer that goes broke closes its table until
players refill it. The economy moves by itself: no developer patch changes prices.

Why this angle (decided with Armand): it keeps what Tilt already does well (fast casino games,
verifiable draws, login without a wallet, play while your coding agent works) and adds the
economy the track judges. "Players become owners of the house" is the part Armand cares most about.

## Goals

1. Three games: dice, roulette (single bet types, no chip layouts), blackjack (1 hand, hit, stand,
   double; no split). Rules written fresh for this repo (decided at build time: nothing is copied
   from the private Tilt code base).
2. Dealers: 3 to 5 NPC dealers at launch, each with one table (one game), its own NEAR sub-account,
   a bankroll and a temperament (cautious, greedy, promoter…).
3. Player ownership: any player can invest USDC into a dealer and receive its shares as NEP-245
   tokens (one token id per dealer, one contract for all). Shares are priced at the dealer's net
   asset value (bankroll ÷ shares). Profits and losses show up as the share value moving; selling
   burns shares at the current value. Money backing open bets cannot be withdrawn.
4. Pricing that reacts: the dealer's rules live in ONE readable file. Inputs: bankroll, reserve
   needed for open bets, bets and player wins over the last hour, time since the last bet, share
   inflows/outflows. Outputs: house edge (bounded 1 %–5 %), max bet (bounded by what the bankroll
   can cover), optional boost. Each change carries a one-line reason shown to players in a tooltip
   ("lowering my edge: nobody played for 20 min").
5. Bust and rescue: when a dealer's bankroll can no longer cover its minimum bet, the table closes
   ("closed · needs 40 USDC to reopen"). It reopens when investors bring it back above the threshold.
6. Fast-forward: a simulation that runs a week of play (simulated players with simple strategies)
   in about a minute, using the same game rules and dealer rules as production, and shows edges,
   bankrolls, share values, busts and reopenings moving on a timeline. For judges.
7. Chain invisible: login with email/Google/X; no seed phrase, no wallet popup, no gas prompt in
   the game loop. Deposit and withdraw are the only explicit money moments.
8. A README written for AI judges: what it is, then numbered "do X, see Y" steps that work on
   testnet.

## Game loop

- Every 30 s (player): pick a table, play a round (dice roll, roulette spin, blackjack hand).
- Every 5 min (player/owner): compare tables (edge, max bet, boost, dealer mood), move to the best
  offer; see your dealers' share value; buy or sell shares; rescue a closed table cheaply.
- Every session: your net from play + your owner P&L; the leaderboard of owners and dealers; the
  log of what dealers did and why.
- Tension: owners want players at their dealer (volume × edge) but fear a big winner; players
  hunt low edges and boosts, which pushes dealers to tighten. Greedy dealers earn more per round
  but empty their tables; promoters fill tables but bleed on streaks.

## Constraints

- NEAR testnet only. No mainnet deploy, no real money. Never sign mainnet transactions.
- Money: Circle's testnet USDC on NEAR (NEP-141, `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
  per Circle's address list; faucet availability to verify). Amounts are integer base units
  (6 decimals) as decimal strings across every boundary.
- Randomness: OutLayer VRF on testnet (yield/resume: the contract requests, OutLayer resumes it
  with a VRF output; the contract verifies the Ed25519 proof against the stored VRF public key).
  Each round records its randomness so anyone can replay it.
- Solvency: a dealer accepts a bet only if its bankroll, minus what already backs open bets,
  covers the bet's worst case. Edges stay ≥ 1 % so no game returns more than 99 % on average.
  Fail closed on any doubt.
- Security posture of the existing project: server never trusted for results, idempotent money
  moves, balances can't go negative (enforced in the contract), keys only in env, never in the repo.
- Separate repository (Armand's request), private until the team decides to publish (the
  hackathon requires a public repo by Nov 14; publishing needs Eli's agreement because of the
  project's privacy rule). Only Armand's code may be reused from the private Tilt repo (game rules,
  risk math); nothing from Eli's zone (mod, web, api) is copied.
- Disclose in the README that Tilt exists on Solana and that this NEAR build is new (hackathon rule
  Q-002), list reused libraries/code (Q-005), add a LICENSE.

## How it is built (decided)

- Contract: Rust, near-sdk, one contract `house` on testnet. Holds: player balances (deposited via
  `ft_transfer_call` of testnet USDC), dealers (bankroll, shares, offer, open-bet reserve), the
  NEP-245 share ledger, open rounds awaiting VRF, round history.
- Dealers: one off-chain agent process (TypeScript) running all NPC dealers. Each dealer has its
  own NEAR sub-account with a function-call key restricted to `set_offer` on the contract; the
  contract re-checks every bound, so a buggy or hostile dealer cannot move money or break solvency.
- Players: Privy social login with a NEAR embedded wallet (supported natively by Privy per NEAR
  docs). At first login the browser creates a function-call key limited to the game methods and
  adds it to the player's account in one sponsored transaction; game moves are then signed silently
  by that key and relayed as meta-transactions (NEP-366) by a small relayer that pays gas. Deposit,
  withdraw, buy and sell shares need a full-access signature through Privy (shown as a plain
  "confirm" step), also gas-sponsored.
- Web app (main surface, hosted demo): lobby of tables with live offers and dealer moods, the table
  screens, the owner view (shares, value history, invest/sell/rescue), the dealer log, the
  fast-forward page.
- NEAR partners used: OutLayer (VRF), Privy (social login), Circle USDC (testnet), NEP-245 standard.
  Not used on purpose: NEAR Intents (mainnet only, no testnet per rule Q-007).

## Non-goals

- The other 9 games, roulette chip layouts, blackjack split, multi-hand.
- Mainnet, KYC, geo-blocking, sponsors and competitions, licensing.
- Porting the Solana program or the MagicBlock rollup.
- Any change to the private Tilt repo.

## Anti-goals (a failure even if it works)

- Players see seed phrases, wallet popups or gas prompts while playing.
- A dealer (or the dealer process) can move player or owner money, or price outside the bounds.
- Prices only change when a developer edits a constant.
- A judge cannot reproduce the demo from the README on testnet.

## Left to the builder

- Contract storage layout, method names, how NEP-245 is implemented (in-contract minimal
  implementation is fine), event format.
- Exact pricing formulas and temperaments, within the bounds above.
- Web framework and styling (Tilt's terminal look is welcome), hosting.
- Simulator implementation, as long as it uses the same Rust rules as the contract (e.g. a shared
  crate compiled into both).

## Stretch (only if Goals are done)

- A terminal panel to play from a coding agent (omp / Claude Code), built from scratch in the new
  repo against the same contract.
- Dealer reasoning lines phrased by an LLM through NEAR AI Cloud (the decision itself stays in the
  rules file).
- List the dealers on Agent Market.

## Timeline (Nov 3 → Nov 14)

1. Nov 3–4: contract core (balances, dealers, dice) + OutLayer VRF round trip on testnet.
2. Nov 5–6: roulette, blackjack, shares (NEP-245), bust/rescue, solvency checks; tests.
3. Nov 7: dealer agents + rules file + reasons.
4. Nov 8–10: web (Privy login, function-call key, relayer, lobby, tables, owner view, dealer log).
5. Nov 11: fast-forward simulation page.
6. Nov 12–13: README for judges, demo video, hosted demo, fixes.
7. Nov 14: buffer and submission (payload confirmed by Armand).

## Calls made by the designer (Armand: check these)

1. **How the edge is applied.** Games keep their own rules and payouts (dice, roulette with its
   zero, blackjack 3:2, dealer stands on 17, no hole card, infinite shoe, no split). On top, the
   dealer sets a **rake** taken from every payout. The table shows the **total edge** = the game's
   own edge + the rake, kept between 1 % and 5 % **against a perfect player** (blackjack basic
   strategy without split computed once, so its rake floor is whatever brings it to 1 %). The
   contract stores each game's base edge as a constant and refuses an offer outside the bounds.
2. **Boost.** A boost is a temporary lower rake on one table, with an end time, still inside the
   1 %–5 % total edge. Nothing ever pays above 99 %.
3. **Share value with open rounds.** No blocking. Buys are priced as if every open bet lost for
   the players (bankroll + open stakes); sells as if every open bet won at its worst case
   (bankroll − open worst-case liabilities). The spread removes the "sell before a known loss"
   trade. A dealer's share value never drops below a tiny floor so rescues stay possible:
   rescuers buying a near-zero dealer get most of it; old holders are diluted. That is part of the game.
4. **Seed funding.** At launch the team's house account funds every dealer and holds its founding
   shares; it sells them like anyone else. Tables are open for judges from minute one.
5. **Live activity.** A few NPC regulars play on testnet during the demo window so dealers have
   something to react to. They are shown as bots in the lobby, funded by the team, testnet only.
6. **Path for AI judges.** Besides the hosted web demo (humans), the README offers `sim`
   (fast-forward, no keys, runs locally) and a CLI demo that creates a throwaway testnet account,
   funds it, plays a round and buys a share, printing what to look at on chain.
7. **Test money.** Circle testnet USDC if its faucet serves NEAR testnet without friction
   (checked on day 1); otherwise a project test token (NEP-141 "tUSDC") with a free claim per
   account. The contract takes the token account id at init, so the switch costs nothing.

## Game loop (revised)

Two layers, each at its own pace; neither has a schedule.

- **Play (fast):** a new round as soon as the previous one has settled, about every 10 s. The player
  sits at the table with the offer they like (edge, max bet, boost).
- **Liquidity (slow, whenever the player wants):** each dealer is a liquidity pool, like an LP pool
  in DeFi. Depositing USDC mints LP tokens (NEP-245, one token id per dealer); the pool earns the
  edge on every losing bet and pays every winning one, so the LP token's value rises or falls;
  withdrawing burns LP tokens at the current value (with the spread of call 3). A pool that can no
  longer cover its minimum bet closes its table until new liquidity reopens it.
- **Why several pools and not one:** with a single pool it is a vault, not an economy. With one pool
  per dealer, dealers compete for players (lower edge, boosts) and for liquidity (better returns),
  greedy dealers earn more per round but lose players, promoters fill tables but can go bust, and
  LPs move their money between dealers. That competition is what the track judges.
