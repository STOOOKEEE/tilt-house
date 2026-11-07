# QA: the economy loop, live on testnet (2026-11-07)

Contract `floor.tilthouse.testnet`, token `tusdc.tilthouse.testnet`, session server and keeper as
deployed on 2026-11-07 (session server binary from 2026-11-06, keeper restarted at 12:59 UTC with
`KEEPER_INTERVAL_MS=180000`). Times are UTC. Hashes link as
`https://testnet.nearblocks.io/txns/<hash>`. Amounts in tUSDC.

Test accounts (sub-accounts of `tilthouse.testnet`, keys in `~/.near-credentials/testnet/`):
`qa-owner-1107.tilthouse.testnet` (owner) and `qa-player-1107.tilthouse.testnet` (player).
Test tables: `qa-min`, `qa-big` (owner), `qa-pl` (player).

## Setup

| Step | Tx | Result |
|---|---|---|
| 3.2 NEAR from the retired `house.tilthouse.testnet` to `tilthouse.testnet` (storage + 0.5 NEAR left there) | `5WQBYhU9hcgDusXHPwkfm8zpuCZks4gzxRuL4r4bQFcC` | ok |
| create qa-owner / qa-player (1 NEAR each) | `HQVyPmETxKENEwcJDW4eb4zJGwZZDS62kDH1W1Rfcga5`, `x2qmZrgDKhdmMaGTSy9pJd2wpWvQU9PrBCFrxsqWkXF` | ok |
| tUSDC from `tilthouse.testnet`: 1500 / 400 | `G7rTopCYkM34Q9BCrfxQfVP6C1rSS8TSFM2iFcVME65d`, `CoJUe1nk7qQLchELFhVP1mv5iKELu9NrPS1J5aoSm1ei` | ok |

## Flows

| Flow | Tx | Result |
|---|---|---|
| deposit 1400 (owner), `ft_transfer_call` msg `""` | `DceDK1uf7DQjRVbvvXuEK7qyz9cNy67rcmMiDxtTGkry` | balance 1400 |
| deposit 350 (player) | `45MYZGEdDksfqseDLSCZ86vY2LiJKkdNvKMxftc4jGqU` | balance 350 |
| `open_table` qa-min, seed 200 (minimum) | `HkAtoFLBZFgrZjeCAWpk8hUiQ4kEZ8NYAxpGh5uCXAZU` | `opened`, 200e12 shares |
| `open_table` seed 199.999999 | refused: "a table needs a seed of at least 200000000" | ok (fail closed) |
| `open_table` qa-big, seed 800 | `u4sW57qVrWSt96pEEBmYSRLXskJTMDEoWuymr17vna7` | ok |
| `bid_for_seat` qa-big 1.2/h on a full floor (outbid NPC) | `CsKYyQeVLGvy3oPnuv9L9481XteBSPacZ4P7E2ju9GdP` | Eve (1.0/h, weakest) `evicted: outbid`, qa-big seat 5, prepaid 2.4 into the jackpot |
| `bid_for_seat` qa-min 1.0/h < `outbid_min` | refused: "the floor is full: bid at least 1210000" | ok |
| `invest` player 50 in qa-big | `DbbQh4cjEEySXtopSa4KfwXBcgMAVvB2zrR6X2BL9CTw` | 50.15e12 shares at 0.997 (the prepay had cost the founder 0.3 %) |
| `divest` 95 % of qa-min | `E15GLJ5tL11Dmv8AfRc6n8DcrsaBX39t6SWRocfa3fdN` | 190 paid, pool 10 |
| `bid_for_seat` qa-min at `outbid_min` 1.21/h | `2NS2dGdhhckEqeKF8ePxNvjXLaC5x3MpA4kXYRjQmDn7` | Chloe evicted (outbid); qa-min seated **and immediately `bust`** (7.58 left < 10 a dice min bet needs) → **bug 4** |
| qa-min raises rent to 100/h (prepaid time converted at the new rate) | `7Ss8Kcv7kX6AjrXHYrUYnffMAW1PW5mJuQhVk5EFM6q5` | paid_until 7200 s → 87 s |
| unpaid-rent eviction (keeper `collect_rent`) | 1794053562 (history of qa-min) | `evicted: unpaid_rent`, pool paid out to 0, never negative |
| `set_offer` qa-big rake 1 %, max bet 5, boost 10 min | `BNccGX8K34tT5ZBsJMvmohdTGQnugATYSjBNCVe8i5Kt` | autopilot off, boost until +600 s |
| `set_offer` rake 0.1 %, max bet 1e6, boost again | `KZVnCjJvLD1L4uZESbgA9LDLDuETPzkM24vzMhH5Drt` | rake/max bet clamped (100 bp, 8.476 = pool cover); second boost refused, **and the running boost was cancelled** → **bug 2** |
| player session at qa-big: `POST /sessions` (lock 20) → `open_session` | `8qA2iRCKRSk4GV74BptwJ3QjN1iH2gL3t5xXkMd56Zbd` | ticket rake 100 bp, max bet 6.33 (80 % headroom) |
| 60 dice rounds (1 tUSDC), `POST /sessions/:id/close` | settles `8seR9XyCmGvGXmLeyDJRg2C9tskaX7AjeoyE7bui3Hur` (1–50), `47DXrc6kPPmWuqrExJpncZJDJ6vgoAg8p8EJw8Ce6RM5` (51–60); close `2fjWfc2Rj5wkThtsYSm9uqhbyxMRUBEnKuoi8ntvoej7` | status `closed`, wagered 60, paid 55.879975, 15.879975 paid out |
| verify session `9a75fd1f0e504ae1afc2c7fe31b27bd2` | `core_rules::session::verify_session` over the settle tx args + revealed seed (read from RPC) | OK: 60 rounds, chain `b999aba0…267f` = on-chain chain, wagered/paid match `get_session`; `pnpm --filter cli-demo verify-session` also VERIFIED |
| `open_table` qa-pl (player, roulette, 200) | `CtBUXkMQgPEpdfwxi7hJocptzFCqLkvkMCCcJUJH4aL1` | ok |
| `list_seat` qa-big seat 5 at 5 | `EkriodtkeCNC28eVTvyezvxmGnkEquZFQsBX8N5Grnr5` | `seat_listed` |
| `buy_seat` max_price 4 < ask | refused: "the seat costs 5000000, above your maximum" | ok |
| `buy_seat` seat 5 for qa-pl, max_price 5 | `9LA1iigEngc8Zsz9fSrn57ThPnEQLrZ8dtaLjizX2RA5` | `seat_sold`; owner +5, player −5; qa-pl keeps rent and prepaid time |
| `set_autopilot` qa-big greedy | `8MWPZGAPVcU18P36wahYBKjjKn6Gx9iUShXHCJMu51n7` | autopilot on, temperament changed |
| `set_temperament` again within the hour | refused: "the temperament can change once an hour" | ok |
| `set_autopilot` null / `set_temperament` qa-min | `CnS1TCPBarS5zemWQngmHniWaVZNzkTthsrg13zxQMpH`, `CbKKHEexBV3LjkeD7pouAqPi7ipnYkBsFZd31AjGsgLf` | ok |
| keeper reprice of autopilot tables | th-keeper log 12:33:25 | qa-big `{"rake_bp":345,"reason":"fresh_liquidity"}`, qa-pl `low_bankroll` |
| `set_offer` qa-pl rake 0, max bet 100, boost 15 min | `3mSh3WUPeZKGZ3MdGxnkt1eji7KrospEWCUsj7Fz3MZv` | clamped to rake 0 (roulette edge 2.7 %), max bet 5.56 |
| share price after losses; player `divest` all qa-big | `C4fc1YPm9E2tYsdKdwwdZi2UgKXZpr8AbFAvTNqmpWEo` | NPCs won 33.1 at qa-big in the hour: price 0.997 → 0.958; 50 invested → 48.045071 back |
| seat sold → `bid_for_seat` qa-big right away (no cooldown after a sale) | `FpuR3oAEFxj2ZD6jsfwNKg1zLKfehUWAEcykEFixpq1k` | seated (evicted Chloe: lowest rent) |
| cut rents to the seat minimum (qa-pl 0.8, qa-big 1.0) | `9k9t46c3wfJuNkZ2y7keBBASuMvsafUx8DsppdmNeJ4s`, `9nBuLFy9pJJuaoUTdM2LSsWv5m6UCCff8CYLdeAwZ5te` | `rent_changed`; prepaid time stretched |
| qa-min (pool 0) bids | refused: "the pool's free bankroll cannot prepay 10000000" | ok |
| NPC outbids a player table | keeper 13:09:43 `dmitri {"outbid":"880000"}` | qa-pl `evicted: outbid` |
| qa-pl bids again (cooldown) | `5UvSEC26W7k5jXXuWtn65BMYBzWqCahYBTyp3jfBffw8` (failed) | "evicted: cannot bid again before 1794058782" (30 min) |
| NPC reseats after its cooldown | keeper 12:34:48 `eve {"bid_empty":"1100000"}` | Eve back on the empty seat 3 |

### NPC gamblers react to offers

- With qa-big seated at rake 1 % and the floor's highest max bet (8.48, NPC dice tables ≤ 0.82),
  five NPC gamblers sat there within 15 min (sessions by g-june, g-nina, g-rosa, g-sam, g-noah,
  tickets at 100 bp), and its `stats` showed 323 bets / 7 gamblers in the hour. Footfall arrival
  reason: "QA Big takes my 1.1 bets".
- qa-pl (roulette, 2.7 % edge) drew no one against Ada/Bruno at 1.0 %: reasons "Ada's 1.0 % beats
  QA Player's 2.7 %" (footfall `passed_1h` 8, `sat_1h` 0). Reasons sampled from `/gamblers/floor`
  matched the lobby offers (edges, entrance seat, loyalty), except the max-bet one → **bug 3**.
- Footfall `arrivals_1h` matched the session log (24 arrivals vs 28 sessions created at 13:00).

### Jackpot

Not forceable (draws come from the hash chain). Paid on chain from NPC/player play:

| Settle tx | Winner | Table | Amount |
|---|---|---|---|
| `Hg3q5w18UpEQSsfSv1thfEpahfh5SEEbns5CJtMx1QYh` | `e1f94d53…bcc4` (implicit) | bruno, nonce 4 | 26.2315 |
| `GdUuXMQCYP93Erbfaagu4F5hWgy2tQVu5tWoVDAxEva2` | g-rosa | eve, nonce 38 | 59.96982 |
| (history seq 225, t 1794029012) | g-rosa | eve | 82.812966 |

Both verified sessions replay with their jackpot (`verify-session`). Rent refills the pot
(11.88 at start, 15.07 after the two prepays, 14.70 at the end).

### Keeper salary

Log 12:13 UTC: g-mia 1.396695, g-kai 5, g-theo 5, g-ava 2.165461, g-max 1.988557 paid (to the cap
200), the others "at the cap"; in-contract balances match (`get_player`). g-ines fails every hour:
"Access key ed25519:FY3H… does not exist" — its local key is not its on-chain key
(`D5eRP6…`): the gambler never plays, and the keeper had sent it 270 tUSDC it could never
deposit → **bug 5**.

### Accounting invariant

`node scripts/audit-floor.ts` (new): all views at one block; accounts = every tUSDC counterparty
of the floor (NearBlocks ft-txns) + controllers + owner + gamblers.

- block 276632305: balances 5686.292135 + escrows 0 + pools 11121.533730 + jackpot 7.364466 =
  16815.190331 = tUSDC held. ✓
- block 276636095 (after cleanup withdrawals): 5019.055236 + 0 + 10098.805290 + 14.409781 =
  15132.270307 = held. ✓

## Bugs found and fixed

1. **73 % of NPC sessions closed with 0 rounds** (1008 of 1389 in the log; 87 of 119 in the last
   6 h). Gamblers planned their stake on the table's max bet while tickets carry 80 % of it, so the
   first bet was refused. Fixed in the session server (`ticket_max_bet`, plan on it, never bet
   above the ticket) — `af5f562`, test `plans_fit_the_ticket_max_bet` + every-session-has-a-round
   check in `tests/gamblers.rs`.
2. **set_offer cancelled the owner's running boost** (the web form sends `boost_secs = 0` when
   only the rake/max bet changes), and the hourly limit then refused a new one. Fixed in core
   (`keep_running_boost`) + contract — `58c35c5`, core test + sandbox regression.
3. **Wrong fits_my_bets reason** ("Bruno takes my 2.4 bets" at a 0.82 max bet). Now
   "Bruno takes the biggest bets, up to 0.8" when the table caps the stake — `61a5f00`.
4. **A table could take a seat it cannot play at**: prepaying left the pool under the minimum bet's
   cover, after evicting an open NPC table (qa-min / Chloe). `bid_for_seat` now refuses it —
   `24bc8a7`, sandbox regression in `unpaid_rent_evicts_and_feeds_the_jackpot`.
5. **Keeper piled salaries into a gambler that cannot deposit** (g-ines, 270 tUSDC stuck in its
   wallet). The keeper now deposits what is already in the wallet first and only tops up —
   `cccc728`, keeper test.
6. **Keeper gas**: measured ≈ 0.27–0.31 NEAR/h at a 1-min interval (≈ 7 NEAR/day); it also
   repriced off-floor tables every pass. Now only seated autopilot tables are repriced —
   `a88a92d` (live since the 12:59 restart; interval raised to 3 min by ops).

## Not fixed (noted)

- `open_session` sometimes fails "rake differs from the table's offer" (4 times in ~33 h): a boost
  ends or the keeper reprices up between the ticket and the open. The gambler just leaves; costs one
  failed tx.
- Every NPC dealer is boosting almost all the time (`reason: idle` with a 5-min boost each pass),
  so "boosting" barely tells tables apart. Design call.
- Autopilot dice max bets are tiny next to the pools (Ada: 0.72 on 1894 tUSDC), which is what made
  bug 1 so frequent and keeps whales unhappy. Design call.
- g-ines needs its key fixed (or dropping from the lineup); 270 tUSDC stay in its wallet until then.
- `get_lobby` keeps listing the three QA tables (off the floor, empty pools, `open: false`): the
  contract has no way to delete a table.

## Final state (13:20 UTC)

`get_floor`: seat 1 ada 1.5/h · seat 2 bruno 1.441753/h · seat 3 eve 1.1/h · seat 4 empty ·
seat 5 dmitri 1.0/h · seat 6 zob-zob 2.0/h; jackpot 14.703189; `outbid_min` 1.0. Dice, roulette
and blackjack are all on the floor; Chloe (cooldown until 13:28:46) takes the empty seat at the
next keeper pass. QA tables qa-big, qa-min, qa-pl: off the floor, pools 0. Test accounts: balance
0, tUSDC withdrawn (`Cmw2sz6XjZcWhxNgaLMMazCL7tsrahdeWpDvSHJ7MbfL`,
`Gzh9CK76g7zxHXHEdUNp7HEtbQs1gs3y2JzKkr2Bdn5S`) and returned to `tilthouse.testnet`
(`7vsok69QBxnhkC3dFay1LddgDrX1P7PXoVdVzpYxws1J`, `2Q1ngDHseDdgc2pASc8Q6KAw6dnrjFfgnqwMeHPGk14R`),
NEAR swept back (`8su9HheVJiZwnXkF9UmwEd2bapkoaX1HZUrSfXX7mnVr`,
`8tuFdGjJ3xTDQ7oNMpB8ixUKiJeWqc12m8YXjLchSPrq`).

## Needs a deploy / restart

- **Contract redeploy** (bugs 2 and 4): `target/near/tilt_house_contract/tilt_house_contract.wasm`,
  sha256 `9e780d706ad0dfae81bc8759b8cb3b22152a899ff12fb59afbb304b5e92f0f58`. State layout unchanged.
- **Session server**: rebuild + restart th-sessions (bugs 1 and 3; the running process predates them).
- **Keeper**: bugs 5 and 6 are live since the 12:59 restart.
