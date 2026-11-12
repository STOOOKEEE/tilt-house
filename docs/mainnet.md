# Mainnet runbook

Tilt House on NEAR mainnet runs next to testnet, with the same code. Chips on mainnet are **play
money**: the token has no value and no redemption. Every mainnet script is a **dry run** unless
`CONFIRM_MAINNET` names the account it would create; agents only ever dry-run. The orchestrator
runs the real deployment after a human funds the root account.

`ROOT` below is the mainnet root account (e.g. `tilthouse.near`). Every other account derives
from it. near-cli-rs is `~/.cargo/bin/near`: `export PATH=$HOME/.cargo/bin:$PATH`.

## Safety rules

| Rule | Where it is enforced |
| --- | --- |
| NPC gamblers: at most 24, registered in the floor | floor `register_npcs` (cap in `core/src/gambler_rules.rs`) |
| NPCs hold **one** key: function-call, floor only, `open_session, close_session, force_close, claim_unrevealed`, 1 NEAR gas allowance; no full-access key | `scripts/create-gamblers.sh` (mainnet) |
| The floor refuses `withdraw`, `invest`, `divest`, seat and table moves, `mt_transfer` for registered NPCs | contract v3 (`docs/contract-api.md`) |
| NPC salary goes straight into the NPC's in-contract balance, only from the keeper, capped at 200 chips | floor `credit_npc` + `agents/` `SALARY_MODE=credit_npc` (forced on mainnet) |
| The relayer activates only Privy-authenticated users (ES256 JWT, JWKS of app `cmw3anyvt021d0hjy746afxqi`), one account per Privy user, persisted | `relayer/src/privy.ts`, `relayer/src/state.ts` |
| Activation sends the minimum NEAR (0.01: ~0.0038 of storage for the account and its two keys) | `relayer/src/config.ts` |
| Daily global NEAR cap on everything the relayer spends | `DAILY_BUDGET_NEAR`, `relayer/src/budget.ts` |
| Kill switch | `RELAYER_PAUSED=1` (see [Kill switch](#kill-switch)) |
| Mainnet faucet: Privy login, only to the account activated for that user, 1/hour | `relayer/src/app.ts` |
| Low NEAR on keeper, session server, relayer or any NPC raises an alert | keeper, every 15 min |

## Accounts and NEAR budget

Costs measured on testnet on 2026-11-12 (same gas price as mainnet: 10^8 yocto/gas = 0.0001 NEAR per Tgas):
keeper ~12 tx/min at ~0.00035 NEAR each, session server ~0.42-0.49 NEAR/day (settle + close),
an NPC 0.001-0.01 NEAR/day (`open_session` only), storage 1 NEAR per 100 kB.

| Account | Role | Created by | Initial NEAR | Locked by storage | Burn per day | Alert below |
| --- | --- | --- | --- | --- | --- | --- |
| `ROOT` | owner, keeper (rent, reprice, salaries) | human | 45 (funds all below, keeps ~12) | 0.002 | ~1.9 (60 s passes), ~0.4 with `KEEPER_INTERVAL_MS=300000` | 2 |
| `tusdc.ROOT` | chip token (play money) | `deploy-token.sh` | 3 | ~1.8 (177 kB wasm) | 0 | — |
| `relayer.ROOT` | token minter, gas relayer, activations | `deploy-token.sh` | 5 | 0.002 | ≤ `DAILY_BUDGET_NEAR` (2): 0.011 per new player + ~0.0003-0.003 per relayed move | 1 |
| `floor.ROOT` | floor contract (player storage) | `deploy-floor.sh create` | 10 (`FLOOR_BALANCE`; 12 advised) | ~4.2 (417 kB wasm) + state (testnet: 7.3 total) | 0 (grows with players) | — |
| `sessions.ROOT` | session server signer (`settle_session`, `close_session`) | manual (below) | 5 | 0.003 | ~0.5 | 1 |
| `ada…eve.ROOT` (5) | NPC dealer controllers | `deploy-floor.sh create` | 0.5 each = 2.5 | 0.002 | 0 (the keeper signs for them) | — |
| `g-<name>.ROOT` (24) | NPC gamblers | `create-gamblers.sh` | 0.3 each = 7.2 | ~0.004 each | 0.001-0.01 each | 0.05 |
| **Total** | | | **~45 NEAR** to `ROOT` | ~16 | **~2.5/day** idle, **≤ 4.5/day** with the relayer budget spent | |

At ~2.5-4.5 NEAR/day, 45 NEAR covers the launch plus about a week; the keeper's alerts say
which account to top up (`near tokens ROOT send-near <account> '<n> NEAR' network-config mainnet
sign-with-legacy-keychain send`). Anyone can top up an NPC; nobody can take NEAR out of one.

## Prerequisites

- `ROOT` exists on mainnet, funded (45 NEAR), its key in `~/.near-credentials/mainnet/ROOT.json`.
- Floor contract v3 (`credit_npc`, `register_npcs`, NPC refusals) committed: the build is
  reproducible (`deploy-floor.sh` uses Docker; commit first).
- Session server with `GAMBLER_ACCOUNT_SUFFIX` support (NPC accounts `g-<name><suffix>`; the
  testnet default is `.tilthouse.testnet`), built to `~/.tilt-house/bin/tilt-house-session-server`.
- Mainnet NPC keys never leave `~/.near-credentials/mainnet/` (mode 600).

## 1. Dry run everything

```sh
export NETWORK=mainnet ROOT=tilthouse.near
scripts/deploy-token.sh
SESSION_SERVER_PUBKEY=0000000000000000000000000000000000000000000000000000000000000000 scripts/deploy-floor.sh create
scripts/create-gamblers.sh
(cd agents && NETWORK=mainnet HOUSE_CONTRACT=floor.$ROOT ACCOUNT_SUFFIX=$ROOT node src/keeper.ts --dry-run)  # once the floor exists
```

Each prints `[dry-run] near …` lines and sends nothing. Read them: every account must end in
`.$ROOT`, every `network-config` must be `mainnet`.

## 2. Token and relayer

```sh
CONFIRM_MAINNET=tusdc.$ROOT scripts/deploy-token.sh
```

Creates `tusdc.ROOT` (owner `ROOT`, minter `relayer.ROOT`) and `relayer.ROOT`; `ROOT` gets
uncapped mints (floor seed, NPC salaries).

## 3. Session server key and account

A new key, not testnet's. It is appended to the env file, never printed; only the public key is.

```sh
mkdir -p ~/.tilt-house && cp ops/session-server-mainnet.env.example ~/.tilt-house/session-server-mainnet.env
sed -i "s/ROOT/$ROOT/g" ~/.tilt-house/session-server-mainnet.env && chmod 600 ~/.tilt-house/session-server-mainnet.env
(cd agents && umask 077 && node --input-type=module -e '
  import { appendFileSync } from "node:fs";
  import { KeyPair } from "near-api-js";
  const key = KeyPair.fromRandom("ed25519");
  appendFileSync(process.argv[1], `SESSION_SERVER_PRIVATE_KEY=${key.toString()}\n`);
  console.log(key.getPublicKey().toString(), Buffer.from(key.getPublicKey().data).toString("hex"));
' ~/.tilt-house/session-server-mainnet.env)
# prints: ed25519:<base58 public key>  <hex public key>  → SESSION_PUBKEY, SESSION_SERVER_PUBKEY
```

The account keeps an offline full-access key (in the keychain, to top up allowances) and the
server gets a function-call key limited to the floor's settlement methods:

```sh
near account create-account fund-myself sessions.$ROOT '5 NEAR' autogenerate-new-keypair save-to-legacy-keychain \
  sign-as $ROOT network-config mainnet sign-with-legacy-keychain send
near account add-key sessions.$ROOT grant-function-call-access --allowance unlimited \
  --contract-account-id floor.$ROOT --function-names 'settle_session, close_session' \
  use-manually-provided-public-key "$SESSION_PUBKEY" network-config mainnet sign-with-legacy-keychain send
```

If the poker server signs more floor methods, list them in `--function-names` too
(`docs/poker-api.md`).

## 4. Floor

```sh
SESSION_SERVER_PUBKEY=<hex> CONFIRM_MAINNET=floor.$ROOT scripts/deploy-floor.sh create
```

Deploys and initializes `floor.ROOT` (keeper = `ROOT`), seeds and seats the launch dealers and
registers the 24 NPCs (`register_npcs`; accounts need not exist yet). See the script header.

## 5. NPC gamblers

```sh
CONFIRM_MAINNET=$ROOT scripts/create-gamblers.sh
```

For each `g-<name>.ROOT`: create with 0.3 NEAR, add the session key (floor only, 4 methods,
1 NEAR allowance: ~100 days of play; it can never be raised, there is no full-access key), delete
the full-access key, store the session key as `~/.near-credentials/mainnet/g-<name>.ROOT.json`.

Chips for salaries (the keeper pays up to 5 chips/h per NPC until each holds 200):

```sh
near contract call-function as-transaction tusdc.$ROOT mint_to json-args "{\"account_id\":\"$ROOT\",\"amount\":\"10000000000\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as relayer.$ROOT network-config mainnet sign-with-legacy-keychain send
```

## 6. Services

```sh
cp ops/relayer-mainnet.env.example ~/.tilt-house/relayer-mainnet.env
cp ops/keeper-mainnet.env.example ~/.tilt-house/keeper-mainnet.env
sed -i "s/ROOT/$ROOT/g" ~/.tilt-house/relayer-mainnet.env ~/.tilt-house/keeper-mainnet.env
chmod 600 ~/.tilt-house/relayer-mainnet.env
node -e 'const fs = require("fs"); const k = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).private_key;
  fs.appendFileSync(process.argv[2], `RELAYER_PRIVATE_KEY=${k}\n`)' \
  ~/.near-credentials/mainnet/relayer.$ROOT.json ~/.tilt-house/relayer-mainnet.env
cp ops/th-relayer-mainnet.service ops/th-sessions-mainnet.service ops/th-keeper-mainnet.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now th-relayer-mainnet th-sessions-mainnet th-keeper-mainnet
systemctl --user restart th-gateway   # picks up the /mainnet/relayer and /mainnet/session proxies
```

| Unit | Port | Gateway prefix |
| --- | --- | --- |
| `th-relayer-mainnet` | 127.0.0.1:8798 | `/mainnet/relayer` |
| `th-sessions-mainnet` | 127.0.0.1:8792 | `/mainnet/session` |
| `th-keeper-mainnet` | — | — |

## 7. Site

Add to `web/.env.public` (the network switch stays "coming soon" until
`VITE_MAINNET_HOUSE_CONTRACT` is set):

```sh
VITE_MAINNET_HOUSE_CONTRACT=floor.tilthouse.near
VITE_MAINNET_TOKEN_CONTRACT=tusdc.tilthouse.near
VITE_MAINNET_RELAYER_ACCOUNT=relayer.tilthouse.near
```

Relayer and session URLs default to `/mainnet/relayer` and `/mainnet/session`, which
`web/vercel.json` rewrites to the gateway. Then build and deploy as usual
(`npx vite build --mode public`, rsync, `npx vercel deploy --prod --yes`).

## 8. Verify

```sh
R=https://tilt-house-beta.vercel.app/mainnet/relayer
curl -s $R/health                                  # {"ok":true,"network":"mainnet","paused":false}
curl -s -XPOST $R/activate -H 'content-type: application/json' -d "{\"accountId\":\"$(printf 'a%.0s' {1..64})\"}"
                                                   # {"error":"missing_token"}: no Privy login, no NEAR
curl -s -XPOST $R/faucet -H 'content-type: application/json' -d '{"accountId":"alice.near"}'   # {"error":"missing_token"}
near contract call-function as-read-only floor.$ROOT get_npcs json-args '{}' network-config mainnet now   # 24 accounts
for n in mia noah zoe liam ines omar kai lea hugo nina theo ava yuki sam iris max rosa ezra vera paul june ravi lola tom; do
  near account list-keys g-$n.$ROOT network-config mainnet now 2>&1 | grep -q FullAccess && echo "FULL ACCESS KEY ON g-$n"
done                                               # prints nothing
near account list-keys sessions.$ROOT network-config mainnet now
journalctl --user -u th-keeper-mainnet -n 50       # salary lines say {"credited":…}; no "level":"error"
journalctl --user -u th-relayer-mainnet -n 20
```

Then log in on the site, switch to Mainnet: the game key is set up (one activation, 0.01 NEAR),
a session opens and settles; `https://nearblocks.io/address/floor.ROOT` shows it.

If an NPC run stopped between "add key" and "delete key", the account still has its full-access
key: delete it by hand (`near account delete-keys g-<name>.ROOT public-keys <full-access key>
network-config mainnet sign-with-legacy-keychain send`, signed with
`~/.near-credentials/mainnet/g-<name>.ROOT.json`) and rename `g-<name>.ROOT.session.json` over it.

## Kill switch

| What | How | Effect |
| --- | --- | --- |
| Relayer | `RELAYER_PAUSED=1` in `~/.tilt-house/relayer-mainnet.env`, `systemctl --user restart th-relayer-mainnet` | every POST answers `503 paused`: no activation, no gas paid, no mint |
| Relayer spending | lower `DAILY_BUDGET_NEAR`, restart | `503 daily_budget_exhausted` once reached (resets 00:00 UTC; counter survives restarts in `~/.tilt-house/relayer-mainnet/state.json`) |
| NPC play | `systemctl --user stop th-sessions-mainnet` | no new sessions; a player's open session can be `force_close`d after 600 s (`docs/sessions.md`) |
| Salaries, rent | `systemctl --user stop th-keeper-mainnet` | no salary, no rent collection |
| Site | remove `VITE_MAINNET_HOUSE_CONTRACT` from `web/.env.public`, rebuild, redeploy | Mainnet shows "coming soon"; stored mainnet choices fall back to testnet |

The floor contract has no pause method: stopping the relayer and the session server stops all
sponsored traffic; a player with their own NEAR can still call the floor directly, which only
moves their own chips.
