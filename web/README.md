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
| `VITE_PRIVY_APP_ID` | Privy app id. Needs a real app from dashboard.privy.io with NEAR embedded wallets enabled and `http://localhost:5173` (and the deployed origin) allowed. Optional: empty (or rejected by Privy) runs the app read-only: lobby, tables, dealers and sim work, login is off. |
| `VITE_HOUSE_CONTRACT` | Floor contract (`floor.tilthouse.testnet`); receiver of session calls and of the browser game key. |
| `VITE_TOKEN_CONTRACT` | Chip token (NEP-141), `tusdc.tilthouse.testnet`. |
| `VITE_RELAYER_URL` | Relayer base URL (`/activate`, `/relay`, `/faucet`); `/relayer` on the public site. |
| `VITE_RELAYER_ACCOUNT` | Account the relayer signs with (`relayer.tilthouse.testnet`). |
| `VITE_NEAR_RPC_URL` | NEAR testnet RPC. |
| `VITE_SESSION_URL` | Session server (provably fair sessions, live NPC gamblers, poker); `/session` on the public site. Optional: empty runs the floor from the `sim.json` demo, no session play. |
| `VITE_MAINNET_HOUSE_CONTRACT` | Mainnet floor (play money). Optional: empty hides the network switch. Once set, `VITE_MAINNET_TOKEN_CONTRACT` and `VITE_MAINNET_RELAYER_ACCOUNT` are required (`.near` accounts). |
| `VITE_MAINNET_RELAYER_URL`, `VITE_MAINNET_SESSION_URL`, `VITE_MAINNET_NEAR_RPC_URL` | Optional, default `/mainnet/relayer`, `/mainnet/session`, `https://rpc.mainnet.fastnear.com`. |
| `VITE_TILT_FLOOR` | The floor instance that plays in $TILT (`floor-tilt.tilthouse.testnet`). Optional: empty hides the USD / TILT switch (the `/tilt` page still works). Must differ from `VITE_HOUSE_CONTRACT`. |
| `VITE_TILT_TOKEN`, `VITE_TILT_RELAYER_URL`, `VITE_TILT_SESSION_URL`, `VITE_TILT_RELAYER_ACCOUNT` | Optional, default `tilt.tilthouse.testnet`, `/tilt/relayer`, `/tilt/session`, `VITE_RELAYER_ACCOUNT`. |

The app refuses to start if a required variable is missing (`src/config.ts`). `.env.public` holds
the public site's values (`vite build --mode public`); `vercel.json` proxies `/relayer`, `/session`
and their `/mainnet/…` and `/tilt/…` twins to the API gateway (the `vite preview` proxy in `vite.config.ts`).

## Currency and network switches

The top bar toggles USD / TILT: the tables play in tUSDC on `VITE_HOUSE_CONTRACT` or in $TILT on
`VITE_TILT_FLOOR` (same contract code, its own relayer and session server). Every amount shows the
active currency's symbol. The choice is stored in `localStorage` (`tilt-house:currency`) and the
page reloads, so every provider, poll and game key uses that floor's contracts, relayer and
session server. The switch is hidden until `VITE_TILT_FLOOR` is set; a stored TILT choice then
falls back to USD.

The Testnet / Mainnet toggle works the same way (`tilt-house:network`) and stays hidden until
mainnet is configured (no TILT on mainnet). Runbook: `docs/mainnet.md`.

## Login and keys

1. Privy login (email, Google, X); a NEAR wallet (implicit account) is created on first login.
2. `src/near/session.ts` `ensureGameKey`: if this browser has no game key for the account, the
   relayer activates the account (`POST /activate` with the Privy access token: one activation
   per Privy user), then the Privy key signs a NEP-366 delegate adding an ed25519 function-call key
   (floor contract only, the session methods `open_session`, `close_session`, `force_close`,
   `claim_unrevealed`, 0.25 NEAR allowance), relayed through `POST /relay`. The key lives in
   `localStorage`.
3. `gameKeyCall` signs session calls with that key and relays them: no popup, no gas. Rounds inside
   a session are signed off chain by the session server (`docs/sessions.md`).
4. `fullAccessCall` signs deposits, withdrawals, LP, table and seat moves with the Privy key, also
   relayed.

## Pages and data

Views are read with JSON-RPC `call_function` (`src/near/views.ts`, no wallet needed) and checked at
runtime against `docs/contract-api.md`; tables poll every 2 s, other pages every 5 s.

- `/` lobby: a 3D casino floor (three.js, `src/scene/lobby`): each dealer at its table with a nameplate,
  a mood from its pool and offer (`src/scene/mood.ts`) and its reason in a speech bubble; click a table to
  open it. Below, a compact table per dealer (edge, max bet, pool, boost, LP price vs launch, open/closed).
- `/table/:dealer`: a seat at a dice, roulette or blackjack table, full screen (3D felt). Play opens a
  session (buy-in in escrow on chain), rounds are dealt by the session server from a committed seed;
  closing settles on chain. "Verify every round" replays the session from the revealed seed in the
  browser and checks the final balance and hash chain.
- `/open`: open your own table (game, seed for its pool, rent offered for a seat). `/my-table`: run
  it (offer, autopilot and temperament, footfall, rename, retire once off the floor with no play and
  every LP share held). `/seats`: seats listed for sale on the floor;
  buy one for a table that is off the floor.
- `/pools`: house balance, deposit (`ft_transfer_call`) and withdraw, test tUSDC faucet (in TILT: the
  one-time welcome, `POST /faucet` on the TILT relayer), LP positions, invest/divest (rescue a closed dealer).
- `/tilt`: the $TILT memecoin (`docs/tilt.md`): supply, treasury, streak and longest streak, today's
  count on the USD floor (`get_day`), Tilt Hour progress with a burn form (`burn_for_tilt_hour`, 1 yocto,
  Privy-signed and relayed), every mint and burn (`get_log`), the launch parameters (`get_params`) and the
  60-day simulation (`public/tilt-sim.json`, from `sim meme`). Shows labelled mock data until the token is
  deployed. The lobby shows a banner while a Tilt Hour runs (`get_floor.tilt_hour_until`).
- `/dealers`: each dealer's log (`get_history`): reprices with reasons, boosts, busts, reopenings, LP flows.
- `/sim`: plays `public/sim.json` (from `cargo run -p tilt-house-sim`) with SVG charts and an events timeline.
- `/poker`, `/poker/:table`: No-Limit Hold'em tables on the session server (`docs/poker-api.md`);
  `/poker?demo=1` is a practice table. Not in the nav yet.
