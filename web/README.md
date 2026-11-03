# @tilt-house/web

Vite + React front end. Login is Privy with a NEAR embedded wallet (same integration as
[near-examples/hello-privy](https://github.com/near-examples/hello-privy)).

```sh
cp .env.example .env   # then fill it in
pnpm --filter @tilt-house/web dev
pnpm --filter @tilt-house/web test
pnpm --filter @tilt-house/web build
```

## Environment

| Variable | Meaning |
| - | - |
| `VITE_PRIVY_APP_ID` | Privy app id. Needs a real app from dashboard.privy.io with NEAR embedded wallets enabled and `http://localhost:5173` (and the deployed origin) allowed. There is no working default: without it you cannot log in. |
| `VITE_HOUSE_CONTRACT` | House contract account; receiver of game moves and of the browser game key. |
| `VITE_TOKEN_CONTRACT` | Test USDC token (NEP-141). |
| `VITE_RELAYER_URL` | Relayer base URL (`/activate`, `/relay`). |
| `VITE_NEAR_RPC_URL` | NEAR testnet RPC. |

The app refuses to start if any of them is missing.

## Login and keys

1. Privy login (email, Google, X); a NEAR wallet (implicit account) is created on first login.
2. `src/near/session.ts` `ensureGameKey`: if this browser has no game key for the account, the
   relayer activates the account (`POST /activate`), then the Privy key signs a NEP-366 delegate
   adding an ed25519 function-call key (house contract only, game methods only, 0.25 NEAR
   allowance), relayed through `POST /relay`. The key lives in `localStorage`.
3. `playMove` signs moves with that key and relays them: no popup, no gas.
4. `fullAccessCall` signs deposits, withdrawals and LP moves with the Privy key, also relayed.
