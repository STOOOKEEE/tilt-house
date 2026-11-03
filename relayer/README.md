# relayer

Pays gas for Tilt House players (NEP-366 meta-transactions), activates new Privy
accounts and runs the tUSDC faucet. Testnet only.

```sh
cp .env.example .env   # fill RELAYER_PRIVATE_KEY
pnpm --filter @tilt-house/relayer start
pnpm --filter @tilt-house/relayer test
```

The relayer account pays for every transaction, the 0.02 NEAR activations and token
storage deposits, and must be the minter of `TOKEN_CONTRACT` (`mint_to`).

## Endpoints

Every error is `{ "error": "<code>" }`. Amounts are decimal strings in base units.

### `POST /relay` `{ signedDelegate }`

`signedDelegate` is base64 of the borsh `SignedDelegate` (`encodeSignedDelegate` in
near-api-js). Only these shapes are relayed (`src/policy.ts`):

| receiver | actions | signing key |
| --- | --- | --- |
| `HOUSE_CONTRACT` | FunctionCall `bet_dice`, `bet_roulette`, `bj_deal`, `bj_hit`, `bj_double`, `bj_stand`, `refund_stuck_round`, deposit 0 | any |
| `HOUSE_CONTRACT` | FunctionCall `withdraw`, `invest`, `divest`, `mt_transfer`, deposit 0 or 1 yocto | full access |
| `TOKEN_CONTRACT` | one `ft_transfer_call`, 1 yocto, `receiver_id` = house | full access |
| the sender | one AddKey: function-call key for the house, exactly the 7 game methods, allowance null or ≤ 0.25 NEAR | full access |

Also: at most 4 actions and 300 Tgas in total, valid ed25519 signature, the key exists
on chain with a nonce below the delegate's, `maxBlockHeight` in (now, now + 600].

- `200 { txHash, status: "success" | "failure", failure? }`
- `400 invalid_body | invalid_encoding`, `403 <reason>` (see `RefusalReason`),
  `429 rate_limited` (30/min per sender, 600/min overall), `502 rpc_error`,
  `504 rpc_timeout` (the transaction may still land)

### `POST /activate` `{ accountId }`

For a 64-hex implicit account (Privy wallet), once per account: sends `ACTIVATION_NEAR`
if it holds less, registers it on the token (`storage_deposit`) and mints 100 tUSDC.

- `200 { funded, registered, minted: "100000000" }` (`funded`/`registered`: done by this call)
- `403 not_implicit_account`, `409 already_activated`, `429 rate_limited`
  (5/min per IP, 100/hour overall), `502 rpc_error` (retry is safe)

### `POST /faucet` `{ accountId }`

Mints 100 tUSDC to any valid account id (attaching the storage deposit if the account
is not registered). One claim per account per hour; the token contract caps mints at
1,000 tUSDC per 24 h.

- `200 { minted: "100000000" }`
- `403 invalid_account`, `429 already_claimed | rate_limited` (5/min per IP,
  100/hour overall), `502 mint_failed` (the claim stays spent for the hour)

### `GET /health`

`{ ok: true }`

Limits and the activated/claimed sets live in memory and reset on restart.
