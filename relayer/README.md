# relayer

Pays gas for Tilt House players (NEP-366 meta-transactions), activates new Privy
accounts and runs the tUSDC faucet. One process per network (`NETWORK=testnet|mainnet`);
the mainnet runbook is `docs/mainnet.md`. The TILT floor has its own instance
(`FAUCET_MODE=welcome`, runbook `docs/ops-tilt.md`).

```sh
cp .env.example .env   # fill RELAYER_PRIVATE_KEY
pnpm --filter @tilt-house/relayer start
pnpm --filter @tilt-house/relayer test
```

The relayer account pays for every transaction, the activations (0.02 NEAR on testnet,
0.01 on mainnet) and token storage deposits, and must be the minter of `TOKEN_CONTRACT`
(`mint_to`). Settings: `.env.example`.

## Spending guards

- **Kill switch**: `RELAYER_PAUSED=1` makes every `POST` answer `503 paused`; `/health`
  reports it.
- **Daily budget**: `DAILY_BUDGET_NEAR` (default 5 on testnet, required on mainnet) caps what
  the relayer spends per UTC day. It watches its own balance (every drop counts, top-ups are
  ignored), so activations, storage deposits and gas are all counted; once spent, spending
  endpoints answer `503 daily_budget_exhausted` until 00:00 UTC.
- **State**: activated Privy users and the budget counter live in
  `$RELAYER_DATA_DIR/state.json` (default `~/.tilt-house/relayer-<network>/`) and survive
  restarts. Rate limits live in memory.

## Endpoints

Every error is `{ "error": "<code>" }`. Amounts are decimal strings in base units.

### `POST /relay` `{ signedDelegate }`

`signedDelegate` is base64 of the borsh `SignedDelegate` (`encodeSignedDelegate` in
near-api-js). Only these shapes are relayed (`src/policy.ts`):

| receiver | actions | signing key |
| --- | --- | --- |
| `HOUSE_CONTRACT` | FunctionCall `open_session`, `close_session`, `force_close`, `claim_unrevealed` (`GAME_METHODS`), deposit 0 | any |
| `HOUSE_CONTRACT` | FunctionCall `MONEY_METHODS` (`withdraw`, `invest`, `divest`, table and seat owner actions, `set_table_name`, `retire_table`), exactly the contract's deposit: 1 yocto for `withdraw`, 0 for the others | full access |
| `TOKEN_CONTRACT` | one `ft_transfer_call`, 1 yocto, `receiver_id` = house | full access |
| `TILT_CONTRACT` (optional, may equal `TOKEN_CONTRACT`) | one `burn_for_tilt_hour`, 1 yocto, `amount` a positive decimal string | full access |
| the sender | one AddKey: function-call key for the house, exactly the 4 game methods, allowance null or ≤ 0.25 NEAR | full access |

Also: at most 4 actions and 300 Tgas in total, valid ed25519 signature, the key exists
on chain with a nonce below the delegate's, `maxBlockHeight` in (now, now + 600].

- `200 { txHash, status: "success" | "failure" | "pending", failure? }`
- `400 invalid_body | invalid_encoding`, `403 <reason>` (see `RefusalReason`),
  `503 paused | daily_budget_exhausted`,
  `429 rate_limited` (30/min per sender, 600/min overall), `502 rpc_error`,
  `504 rpc_timeout` (the transaction may still land)

### `POST /activate` `{ accountId }`, header `Authorization: Bearer <Privy access token>`

For a 64-hex implicit account (Privy wallet), once per Privy user and once per account:
sends `ACTIVATION_NEAR` if it holds less, registers it on the token (`storage_deposit`) and
mints 100 tUSDC. The token is an ES256 JWT checked against the app's JWKS
(`https://auth.privy.io/api/v1/apps/<PRIVY_APP_ID>/jwks.json`, cached 1 h): signature,
issuer `privy.io`, audience = the app id, expiry, subject `did:privy:…` (`src/privy.ts`).

On testnet (`ANONYMOUS_ACTIVATION`, default on; refused on mainnet) a request without an
`Authorization` header is activated anonymously, once per account and at most 20 per hour
overall, for the CLI demo (`cli-demo/`). A token that is sent must verify.

With `FAUCET_MODE=welcome` (the TILT floor's relayer, `TOKEN_CONTRACT` = `TILT_CONTRACT` = the
TILT token) activation sends NEAR only to an account that does not exist yet (the tUSDC relayer
may have funded it already; each instance keeps its own `RELAYER_DATA_DIR`), registers it on TILT
and mints nothing: `minted: "0"`.

- `200 { funded, registered, minted: "100000000" }` (`funded`/`registered`: done by this call)
- `401 missing_token | invalid_token`, `403 not_implicit_account`, `409 already_activated`,
  `429 rate_limited` (5/min per IP, 100/hour overall), `502 rpc_error` (retry is safe),
  `503 paused | daily_budget_exhausted | auth_unavailable` (Privy keys unreachable)

### `POST /faucet` `{ accountId }`

Mints 100 tUSDC to any valid account id (attaching the storage deposit if the account
is not registered). One claim per account per hour; the token contract caps mints at
1,000 tUSDC per 24 h. On mainnet it also needs the Privy bearer token and mints only to the
account activated for that user, one claim per user per hour.

- `200 { minted: "100000000" }`
- `401 missing_token | invalid_token` (mainnet), `403 invalid_account | not_your_account`,
  `429 already_claimed | rate_limited` (5/min per IP, 100/hour overall),
  `502 mint_failed` (the claim stays spent for the hour), `503 paused | daily_budget_exhausted`

With `FAUCET_MODE=welcome` it claims the TILT welcome allowance instead
(`claim_welcome_for(account)` on the TILT token, signed by the relayer, the token's welcome
operator, with the storage deposit if the account is not registered). It always needs the Privy
bearer token, only for the account this relayer activated for that user, once per user (kept in
`state.json`); the token also refuses a second claim per account and caps claims per day.

- `200 { welcomed: "<TILT base units>" }`
- `401 missing_token | invalid_token`, `403 invalid_account | not_your_account`,
  `409 already_claimed` (also when the token says so), `429 rate_limited`, `502 welcome_failed`
  (daily welcome cap, empty pool or RPC failure; the claim is not spent, retry later), `503 paused | daily_budget_exhausted | auth_unavailable`

### `GET /health`

`{ ok: true, network, paused }`
