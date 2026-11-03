# @tilt-house/agents

Testnet-only processes that keep the house alive: the dealer **keeper** and three **bot** regulars.

```sh
cp .env.example .env          # set HOUSE_CONTRACT
pnpm keeper [--dry-run]       # every KEEPER_INTERVAL_MS (60 s), each dealer signs reprice({dealer_id})
pnpm bots [--dry-run]         # bot-hunter, bot-loyal, bot-whale play forever
```

`--dry-run` reads the lobby from the chain, prints each change call as one JSON line
(`{"dry_run":true,"signer","receiver","method","args"}`), sends nothing, and exits after one pass.

## Keys

Keys are read from near-cli credential files `<dir>/<account>.json` (`private_key`), never from the repo.

- Keeper: dealer `<id>` signs as `<id>.tilthouse.testnet`; dir `DEALER_KEYS_DIR` (default `~/.near-credentials/testnet`).
  A function-call key for `reprice` on the house is enough.
- Bots: `bot-<name>.tilthouse.testnet` with full-access keys, holding testnet NEAR for gas; dir `BOT_KEYS_DIR`.
  They call the house directly, not through the relayer.

## Bots

- **hunter**: dice at the open dice table with the lowest `total_edge_bp`, stake = table min.
- **loyal**: always the same dealer (`BOT_LOYAL_DEALER`, default the first dice/roulette dealer by id), stake = table min.
- **whale**: 1 turn in 5, roulette `"red"` at the open roulette table with the largest max bet, stake = half its balance capped by the table max.

Each turn: finish any `open_round` left from a previous run, else bet (200 TGas), poll `get_round` until
`settled`/`refunded`, pause 5–20 s. A `failed` round blocks new bets, so the bot calls `refund_stuck_round`
at once; it also does after 120 s still `waiting_vrf`. A bot sits out while its in-contract balance is below the table min.

Create and fund the bots once (1 NEAR each, 200 tUSDC deposited in the house): `agents/scripts/create-bots.sh`.

## Contract

Shapes follow `docs/contract-api.md`; the views are parsed in `src/near.ts` (`get_lobby`, `get_player`, `get_round`).
