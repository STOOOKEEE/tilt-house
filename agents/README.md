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
- **whale**: 1 turn in 5, roulette `Red` at the open roulette table with the largest max bet, stake = half its balance capped by the table max.

Each turn: bet, poll `get_round` until settled (calls `refund_stuck_round` after 130 s), pause 5–20 s.
A bot sits out while its in-contract balance is below the table min.

## Contract shapes assumed (plan Task 3)

Change these in `src/near.ts` / `src/bots.ts` if the contract differs:

- `get_lobby()` → array of `{ id, name, game, rake_bp, total_edge_bp, max_bet, min_bet, boost_until, reason, reason_text, open, bankroll, share_price_buy, share_price_sell }`, amounts as decimal strings.
- `get_player({ account_id })` → `{ balance: "<decimal>" }` or `null`.
- `get_round({ round_id })` → object with `status` (`"settled"`/`"refunded"` when done, any case) or `settled: true`.
- `bet_dice({ dealer_id, stake, chance_bp, over })`, `bet_roulette({ dealer_id, stake, bet: "Red" })` return the round id (number or `{ round_id }`).
  If no id comes back, the bot logs the bet and does not wait.
