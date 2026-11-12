# @tilt-house/agents

**Keeper** (testnet, and mainnet with `NETWORK=mainnet`: `docs/mainnet.md`) that keeps the floor alive (contract v2, `docs/contract-api.md`). The NPC
gamblers themselves play inside the session server (`session-server/src/gamblers.rs`).

```sh
cp .env.example .env          # set HOUSE_CONTRACT=floor.tilthouse.testnet
pnpm keeper [--dry-run]
```

Every `KEEPER_INTERVAL_MS` (60 s), signed by the contract's keeper account `KEEPER_ACCOUNT`
(default `tilthouse.testnet`):

1. `collect_rent`: settles every seat's rent into the jackpot, evicts who can't pay.
2. `reprice({dealer_id})` for each table on autopilot, `rent_bid({dealer_id})` for each NPC dealer.

Every hour it also pays each of the 24 NPC gamblers `g-<name>.tilthouse.testnet` its salary
(5 tUSDC/h until its in-contract balance reaches 200 tUSDC, `core/src/gambler_rules.rs`): the keeper
sends tUSDC (`TOKEN_CONTRACT`, default `tusdc.tilthouse.testnet`) to the gambler's wallet, and the
gambler deposits it into the house with its own key, because a deposit credits its sender.

With `SALARY_MODE=credit_npc` (contract v3, the only mode on mainnet) the keeper instead deposits
the salary straight into each NPC's in-contract balance: tUSDC `ft_transfer_call` to the floor with
msg `{"credit_npc":"<npc>"}`, for the NPCs the floor lists in `get_npcs`. NPC keys never touch the
token, so on mainnet they only hold function-call keys for the floor's session methods.

Every 15 minutes it checks the NEAR left on the keeper, the session server's signer
(`SESSIONS_ACCOUNT`), the relayer (`RELAYER_ACCOUNT`) and every NPC; below its threshold
(`ALERT_*_NEAR`, `.env.example`) an account raises a JSON line at level `error` (stderr), also
POSTed to `ALERT_WEBHOOK_URL` when set.

One JSON line is logged per call; a failing call never stops the loop. `--dry-run` reads the chain,
prints each change call as `{"dry_run":true,"signer","receiver","method","args"}`, sends nothing and
exits after one pass.

## Keys

near-cli credential files `<KEYS_DIR>/<account>.json` (default `~/.near-credentials/testnet`), never
the repo: the keeper account's, and each gambler's (created by `scripts/create-gamblers.sh`).
