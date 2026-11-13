#!/usr/bin/env bash
# Deploys $TILT (meme/, docs/tilt.md) on NEAR testnet: tilt.<ROOT>, init with the launch
# parameters, and the TILT storage registration of the TILT floor. Testnet only.
#
#   scripts/deploy-tilt.sh            # build (reproducible), create, deploy + init, register floor-tilt
#   DRY_RUN=1 scripts/deploy-tilt.sh  # print every command instead of sending it
#
# Needs near-cli-rs (`near`), cargo-near, Docker (reproducible build: commit first), node, and ROOT's
# key in ~/.near-credentials/testnet (the new account's key is saved there by near-cli, never in
# this repo). The launch economics are `LAUNCH` in meme/src/rules.rs, printed by the simulator,
# so the deployed parameters are the simulated ones.
#
# The contract has no owner methods. To make the code immutable too, delete tilt.<ROOT>'s access
# keys afterwards: this script only PRINTS that lock step, it never runs it.
#
# Env:
#   ROOT          funding and parent account (default tilthouse.testnet)
#   TILT_BALANCE  NEAR given to tilt.<ROOT> (default '4 NEAR': ~2.2 NEAR of code, ~0.4 of log,
#                 the rest pays winners' storage registrations, see docs/tilt.md)
#   DRY_RUN=1     print the commands instead of sending them
set -euo pipefail

NETWORK=testnet
ROOT=${ROOT:-tilthouse.testnet}
[[ $ROOT == *.testnet ]] || { echo "ROOT must be a .testnet account" >&2; exit 1; }
TILT=tilt.$ROOT
FLOOR=floor.$ROOT
FLOOR_TILT=floor-tilt.$ROOT
WELCOME_OPERATOR=relayer.$ROOT
HOUSE_RECEIVER=$ROOT
TILT_BALANCE=${TILT_BALANCE:-4 NEAR}
STORAGE_DEPOSIT='0.00125 NEAR'
DRY_RUN=${DRY_RUN:-0}
REPO=$(cd "$(dirname "$0")/.." && pwd)
WASM=$REPO/target/near/tilt_house_meme/tilt_house_meme.wasm

# Runs a command, or prints it on a dry run.
run() {
  if [[ $DRY_RUN == 1 ]]; then
    printf '%q ' "$@"
    echo
  else
    "$@"
  fi
}

# Reproducible: the image is pinned in meme/Cargo.toml; the tree must be committed.
run bash -c "cd '$REPO/meme' && cargo near build reproducible-wasm"
[[ $DRY_RUN == 1 ]] || echo "wasm sha256: $(sha256sum "$WASM" | cut -d' ' -f1)"

ECONOMICS=$(cd "$REPO" && cargo run -q -p tilt-house-sim --release -- meme --days 1 |
  node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")).params))')
INIT_ARGS="{\"floor\":\"$FLOOR\",\"welcome_operator\":\"$WELCOME_OPERATOR\",\"house_receiver\":\"$HOUSE_RECEIVER\",\"economics\":$ECONOMICS}"

run near account create-account fund-myself "$TILT" "$TILT_BALANCE" \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$ROOT" network-config "$NETWORK" sign-with-legacy-keychain send

run near contract deploy "$TILT" use-file "$WASM" \
  with-init-call new json-args "$INIT_ARGS" \
  prepaid-gas '50 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

# The TILT floor holds TILT (dealer pools, player deposits): it needs a TILT storage balance.
run near contract call-function as-transaction "$TILT" storage_deposit \
  json-args "{\"account_id\":\"$FLOOR_TILT\",\"registration_only\":true}" \
  prepaid-gas '30 Tgas' attached-deposit "$STORAGE_DEPOSIT" \
  sign-as "$ROOT" network-config "$NETWORK" sign-with-legacy-keychain send

if [[ $DRY_RUN != 1 ]]; then
  near contract call-function as-read-only "$TILT" get_params json-args '{}' network-config "$NETWORK" now
  near contract call-function as-read-only "$TILT" get_state json-args '{}' network-config "$NETWORK" now
fi

cat <<EOF
\$TILT at $TILT on $NETWORK$([[ $DRY_RUN == 1 ]] && echo ' (dry run, nothing sent)').
Next (not run here): the floors must know TILT (FloorDay: floor set_meme $TILT, floor-tilt token $TILT).

Lock step, NOT run by this script (irreversible: no key can redeploy $TILT afterwards):
  near account list-keys $TILT network-config $NETWORK now
  near account delete-keys $TILT public-keys <every key listed above> network-config $NETWORK sign-with-legacy-keychain send
EOF
