# Running the TILT floor (testnet)

The TILT floor `floor-tilt.tilthouse.testnet` is a second instance of the floor contract, playing
in $TILT (`tilt.tilthouse.testnet`, `docs/tilt.md`). It gets its own relayer, session server and
keeper, next to the tUSDC ones; nothing about the USD services changes except two env lines (§5).

| Unit | Port | Gateway prefix | Env file (template) |
| --- | --- | --- | --- |
| `th-relayer-tilt` | 127.0.0.1:8789 | `/tilt/relayer` | `~/.tilt-house/relayer-tilt.env` (`ops/relayer-tilt.env.example`) |
| `th-sessions-tilt` | 127.0.0.1:8793 | `/tilt/session` | `~/.tilt-house/session-server-tilt.env` (`ops/session-server-tilt.env.example`) |
| `th-keeper-tilt` | — | — | `~/.tilt-house/keeper-tilt.env` (`ops/keeper-tilt.env.example`) |

The gateway (`th-gateway`, `web/vite.config.ts`) proxies both prefixes, and the site
(`web/vercel.json`) rewrites them to the gateway, so the web reaches them same-origin.

What differs from the USD instances:

- **Relayer** (`FAUCET_MODE=welcome`): `/faucet` claims the TILT welcome allowance
  (`claim_welcome_for`, the relayer being the token's welcome operator) once per Privy user, for
  the account this relayer activated for them; activation mints nothing and sends NEAR only to an
  account that does not exist yet. Same account `relayer.tilthouse.testnet`, its own access key
  (no nonce races with `th-relayer`) and its own `RELAYER_DATA_DIR`. Both relayers relay
  `burn_for_tilt_hour` on TILT (`TILT_CONTRACT`). Their daily budgets both watch the shared
  account's balance, so each caps the account's total spend. Details: `relayer/README.md`.
- **Session server** (`GAMBLERS=off`): same binary, no NPC gamblers, no NPC at poker tables. Same
  account `sessions.tilthouse.testnet`, a new key (floor-tilt's `server_pubkey`, own nonces).
- **Keeper** (`SALARY_MODE=off`): rent, repricing and rent bids for floor-tilt's NPC dealers; no
  salaries, no NPC registry. The USD keeper also closes each UTC day (`CLOSE_DAY=1`, §5).

Nothing below is run by agents: the orchestrator runs it, in this order.

## 1. Session server key (before deploying floor-tilt)

A new key, appended to the env file, never printed; only the public key is.

```sh
cd ~/dev/STOOOKEEE/tilt-house
mkdir -p ~/.tilt-house && cp ops/session-server-tilt.env.example ~/.tilt-house/session-server-tilt.env
chmod 600 ~/.tilt-house/session-server-tilt.env
(cd agents && umask 077 && node --input-type=module -e '
  import { appendFileSync } from "node:fs";
  import { KeyPair } from "near-api-js";
  const key = KeyPair.fromRandom("ed25519");
  appendFileSync(process.argv[1], `SESSION_SERVER_PRIVATE_KEY=${key.toString()}\n`);
  console.log(key.getPublicKey().toString(), Buffer.from(key.getPublicKey().data).toString("hex"));
' ~/.tilt-house/session-server-tilt.env)
# prints: ed25519:<base58 public key>  <hex public key>  → SESSION_PUBKEY, SESSION_SERVER_PUBKEY
near account add-key sessions.tilthouse.testnet grant-function-call-access --allowance unlimited \
  --contract-account-id floor-tilt.tilthouse.testnet --function-names 'settle_session, close_session' \
  use-manually-provided-public-key "$SESSION_PUBKEY" network-config testnet sign-with-legacy-keychain send
```

## 2. Contracts

`scripts/deploy-tilt.sh` (TILT token, `docs/tilt.md`), then
`SESSION_SERVER_PUBKEY=<hex> scripts/deploy-floor.sh tilt` (floor-tilt, its 3 NPC dealers) and
`scripts/deploy-floor.sh meme` (the USD floor reports to TILT). See each script's header.

## 3. Relayer key

A second full-access key of `relayer.tilthouse.testnet` (activation transfers and relayed
delegate actions need full access), appended to the env file, never printed.

```sh
cp ops/relayer-tilt.env.example ~/.tilt-house/relayer-tilt.env && chmod 600 ~/.tilt-house/relayer-tilt.env
(cd agents && umask 077 && node --input-type=module -e '
  import { appendFileSync } from "node:fs";
  import { KeyPair } from "near-api-js";
  const key = KeyPair.fromRandom("ed25519");
  appendFileSync(process.argv[1], `RELAYER_PRIVATE_KEY=${key.toString()}\n`);
  console.log(key.getPublicKey().toString());
' ~/.tilt-house/relayer-tilt.env)
# prints: ed25519:<base58 public key> → RELAYER_TILT_PUBKEY
near account add-key relayer.tilthouse.testnet grant-full-access \
  use-manually-provided-public-key "$RELAYER_TILT_PUBKEY" network-config testnet sign-with-legacy-keychain send
```

## 4. Keeper env and session server binary

```sh
cp ops/keeper-tilt.env.example ~/.tilt-house/keeper-tilt.env
(cd agents && node --env-file=$HOME/.tilt-house/keeper-tilt.env src/keeper.ts --dry-run)   # prints the calls, sends nothing
cargo build -p tilt-house-session-server --release
install -m 755 target/release/tilt-house-session-server ~/.tilt-house/bin/tilt-house-session-server
```

The binary is shared with `th-sessions`, which picks it up at its next restart (§6).

## 5. USD instances

```sh
echo 'TILT_CONTRACT=tilt.tilthouse.testnet' >> relayer/.env   # th-relayer relays Tilt Hour burns
echo 'CLOSE_DAY=1' >> agents/.env                             # th-keeper closes each UTC day
(cd agents && node --env-file=.env src/keeper.ts --dry-run)   # shows the close_day call it would send
```

RPC (all six services): `NEAR_RPC_URLS=https://test.rpc.fastnear.com,https://near-testnet.drpc.org`
(the default when unset). Reads fail over to drpc on 429/5xx with backoff; transactions go to
the first URL only (drpc times out on `send_tx`). Remove any lone `NEAR_RPC_URL` pointing at
drpc. The session servers log `rpc last minute: N requests, …` once a minute.

## 6. Start

```sh
cp ops/th-relayer-tilt.service ops/th-sessions-tilt.service ops/th-keeper-tilt.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now th-relayer-tilt th-sessions-tilt th-keeper-tilt
systemctl --user restart th-relayer th-keeper th-sessions th-gateway
```

## 7. Check

```sh
G=https://debian-docker.tail8b5861.ts.net:10000
curl -s $G/tilt/relayer/health              # {"ok":true,"network":"testnet","paused":false}
curl -s $G/tilt/session/gamblers/floor      # []
curl -s https://tilt-house-beta.vercel.app/tilt/session/gamblers/floor   # [] once the site is redeployed
journalctl --user -u th-relayer-tilt -n 5   # "... for floor-tilt.tilthouse.testnet ..., faucet welcome (live)"
journalctl --user -u th-sessions-tilt -n 5  # "NPC gamblers off"
journalctl --user -u th-keeper-tilt -n 20   # one JSON line per call: collect_rent, reprice, rent_bid
journalctl --user -u th-keeper | grep close_day   # after 00:02 UTC: {"action":"close_day","day":...}
```

Kill switch for the TILT relayer: `RELAYER_PAUSED=1` in its env, then
`systemctl --user restart th-relayer-tilt`.
