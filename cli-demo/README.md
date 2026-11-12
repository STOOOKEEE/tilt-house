# cli-demo: Tilt House from a terminal

For anyone who cannot click a Privy login (AI judges, CI, curious devs): one command plays the real game
on NEAR testnet and proves every round fair from on-chain data. Nothing to configure, no keys to bring.

```sh
pnpm install
pnpm --filter cli-demo demo                      # play ~20 rounds, then verify them against the chain
pnpm --filter cli-demo verify-session <id>       # replay ANY closed session (yours, an NPC gambler's)
pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet   # that account's latest closed session
pnpm --filter cli-demo floor                     # the live economy
pnpm --filter cli-demo poker                     # two accounts play 3 hold'em hands with the bots, then verify
```

Exit code 0 means everything checked out; anything that does not verify prints `✗`, says why and exits 1.

## `demo`

1. **Account.** Creates a throwaway *implicit* testnet account (its id is its public key) and stores the key in
   `~/.tilt-house/cli-demo-account.json` (mode 600, testnet only). Later runs reuse it; `--new` makes a fresh one.
   The public relayer (`/relayer/activate`) funds it gas-free and mints 100 tUSDC; every tx of the account is a
   NEP-366 meta-transaction the relayer pays for. With `FUNDER_ACCOUNT` + `FUNDER_KEY` (a testnet account you own)
   in the environment, that account sends 1 NEAR, the demo registers on the token itself and sends its txs directly.
2. **Deposit.** `ft_transfer_call` of 20 tUSDC into `floor.tilthouse.testnet` (the faucet tops the wallet up once an hour).
3. **Floor.** Seats, rent, jackpot, every table's offer and why, and the NPC gamblers (each with its own wallet).
4. **Sessions** at the cheapest seated table of each game, through the public session server
   (`/session`): 12 dice rounds, 7 multi-spot roulette spins (number + split + corner + red, one draw), one
   blackjack hand played move by move. Before any money moves it checks that the server key is the one in the
   contract config and that the ticket (player, table, lock, client seed, rake) is what was asked. `open_session`
   escrows 5 tUSDC on chain; then each round is one HTTP request (latency printed) whose signed state is checked
   (signature, nonce, hash chain, balance). At close the server reveals its seed; the demo replays locally, waits
   for the server's `settle_session` + `close_session` on chain, then runs the same check as `verify-session`.
   A game whose only tables are off the floor (outbid, or short of rent) is skipped with a warning.

## `poker`

Multiplayer No-Limit Hold'em (docs/poker-api.md) with two players you control and the NPC bots the table calls in.

1. **Two accounts**, A and B, set up like `demo`'s (keys in `~/.tilt-house/cli-poker-a.json` and `cli-poker-b.json`,
   mode 600, reused; `--new` for fresh ones), each with at least 5 tUSDC on the floor.
2. **Table.** The cheapest seated, open poker table whose max bet takes a 5 tUSDC buy-in (blinds 0.1 / 0.2).
3. **Sit.** Each player starts a session there (the buy-in is its lock, ticket checked as in `demo`), signs
   `open_session` and joins the table with its session token. A human at the table makes the seat rule call bots in
   (`npc: true`, each with its own wallet and session).
4. **Play** `--hands N` hands (default 3, at most 20). Each player sends a fresh client seed for every hand after the
   server has published `sha256(hand_seed)`. A opens every unopened pot for the minimum raise; both check when they
   can, call up to 4 big blinds and fold to more; every move is checked against the server's `legal` first. On every
   poll it checks that no one else's cards are visible mid-hand, and that each recorded hand moves the player's signed
   session state by exactly its round (signature, nonce, hash chain, balance).
5. **Each hand** is printed once the server reveals it: the two players' hole cards (checked against what each saw),
   the bots, the actions street by street, the board, pot, rake and winners. It is then verified: the hand seed
   matches its commitment, the deck comes from the seeds, the actions replay legally to the published result,
   the history hash is right and the chips add up (in = out + rake).
6. **Leave**, wait for the server's `settle_session` + `close_session` on chain, then run `verify-session`'s check on
   both sessions, with each poker round rebuilt from its replayed hand (`Hand::round_for`): the rounds must be
   byte for byte the ones the chain settled, hash-chain to its value, and pay out exactly what it paid.

The hand histories come from this run: `verify-session` on a poker session alone cannot replay its rounds (the
session server publishes only the latest hand of a table).

## `verify-session`

Trusts the session server for nothing. From `get_session` on the floor contract it takes the commitment frozen
at `open_session` (server seed hash, client seed, rake, lock), the revealed seed, the settled round count, the
final hash chain, wagered/paid totals and the payout. The round list comes from the session server
(`GET /session/sessions/:id`) or, if it does not answer, from the `settle_session` tx args alone. It then checks:

- `sha256(revealed seed)` equals the on-chain seed hash;
- every round replays bit for bit from `HMAC-SHA256(seed, client_seed:nonce)` (dice roll, roulette pocket, cards);
- the rounds hash-chain to exactly the `chain` the contract accepted, and balance, wagered and paid match;
- the rounds read back from the `settle_session` txs (found through NearBlocks, args read from RPC) are the same bytes.

It prints NearBlocks links for the open, settle and close txs (looked up over the last ~10 pages of txs).

The replay is `web/src/near/session-client.ts`, the browser's verifier, which mirrors `core_rules::session` and is
cross-checked against `web/src/near/session-vectors.json` (produced by the Rust code); this package's tests run the
same vectors through the chain-anchored check, tampered rounds included.

## Options

| Flag | Env | Default |
|---|---|---|
| `--floor` | `FLOOR_CONTRACT` | `floor.tilthouse.testnet` |
| `--token` | `TOKEN_CONTRACT` | `tusdc.tilthouse.testnet` |
| `--relayer` | `RELAYER_URL` | `https://tilt-house-beta.vercel.app/relayer` |
| `--session` | `SESSION_URL` | `https://tilt-house-beta.vercel.app/session` |
| `--rpc` | `NEAR_RPC_URL` | `https://test.rpc.fastnear.com` |
| | `SESSION_SERVER_ACCOUNT` | `sessions.tilthouse.testnet` (signer of settle/close txs) |
| | `FUNDER_ACCOUNT`, `FUNDER_KEY` | none: the relayer funds the account |

Only `.testnet` (or implicit) accounts are accepted.

```sh
pnpm --filter cli-demo test        # argument parsing, chain-anchored verification, poker rounds (Rust vectors)
pnpm --filter cli-demo typecheck
```
