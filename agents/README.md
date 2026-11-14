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

With `SALARY_MODE=off` (the TILT floor `floor-tilt.tilthouse.testnet`, which has no NPC gamblers)
it pays no salary and watches no NPC; rent, repricing and NPC dealer rent bids run as above.

With `CLOSE_DAY=1` (the USD floor only) it also closes each UTC day: once 2 minutes past midnight,
`close_day({day: yesterday})` (unix days), which reports the day's human results to the $TILT token
(`docs/tilt.md`). It reads `get_day` first and only logs a day already closed; a refusal as already
closed counts as done, any other failure is retried at the next pass. One JSON line per day with
the `get_day` record after the close.

Every 15 minutes it checks the NEAR left on the keeper, the session server's signer
(`SESSIONS_ACCOUNT`), the relayer (`RELAYER_ACCOUNT`) and every NPC; below its threshold
(`ALERT_*_NEAR`, `.env.example`) an account raises a JSON line at level `error` (stderr), also
POSTed to `ALERT_WEBHOOK_URL` when set.

RPC: `NEAR_RPC_URLS`, preferred first (testnet default: fastnear, then drpc); 429/408/5xx answers
cool the endpoint down (1 s doubling to 30 s) and reads move to the next, transactions use the
first only (`src/rpc.ts`, same as the relayer's).

One JSON line is logged per call; a failing call never stops the loop. `--dry-run` reads the chain,
prints each change call as `{"dry_run":true,"signer","receiver","method","args"}`, sends nothing and
exits after one pass.

## Keys

near-cli credential files `<KEYS_DIR>/<account>.json` (default `~/.near-credentials/testnet`), never
the repo: the keeper account's, and each gambler's (created by `scripts/create-gamblers.sh`).

## Owner bot (house test tables)

`pnpm owner-bot` (unit `ops/th-owner-bot.service`, env `ops/owner-bot.env.example`) plays the owner of
the team's two labeled house test tables, `test-1` and `test-2` (accounts
`test-owner-1.tilthouse.testnet` and `test-owner-2.tilthouse.testnet`, made once by
`src/owner-setup.ts`; README, Disclosure). Every `OWNER_BOT_INTERVAL_MS` (20 s), for each table, one
action at most: answer a gambler hesitating at the table (`set_offer`, at most half of the asks and
some left at random), bid for a seat again when evicted, raise its rent ~10 % when it is the
floor's weakest (up to `OWNER_BOT_MAX_RENT`, 2 tUSDC/h), invest its in-contract balance when the
free bankroll covers under 2 h of rent. It sends only `set_offer`, `bid_for_seat` and `invest`:
never a session, never $TILT. One JSON line per decision and per transaction (with its hash); on
any error it logs at level error and exits, and the unit gives up after 3 restarts in an hour.
