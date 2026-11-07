# cli-demo: Tilt House from a terminal

For anyone who cannot click a Privy login (AI judges, CI, curious devs): one command plays the real game
on NEAR testnet and proves every round fair from on-chain data. Nothing to configure, no keys to bring.

```sh
pnpm install
pnpm --filter cli-demo demo                      # play ~20 rounds, then verify them against the chain
pnpm --filter cli-demo verify-session <id>       # replay ANY closed session (yours, an NPC gambler's)
pnpm --filter cli-demo verify-session --player g-mia.tilthouse.testnet   # that account's latest closed session
pnpm --filter cli-demo floor                     # the live economy
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
pnpm --filter cli-demo test        # argument parsing, chain-anchored verification (Rust vectors)
pnpm --filter cli-demo typecheck
```
