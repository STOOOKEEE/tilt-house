#!/usr/bin/env bash
# Deploys tUSDC, the Tilt House chip token (play money: no value, no redemption), on NEAR.
#
#   NETWORK=testnet scripts/deploy-token.sh                      # ROOT defaults to tilthouse.testnet
#   NETWORK=mainnet ROOT=tilthouse.near scripts/deploy-token.sh   # dry run: prints every command
#   NETWORK=mainnet ROOT=tilthouse.near CONFIRM_MAINNET=tusdc.tilthouse.near scripts/deploy-token.sh
#
# Needs near-cli-rs (`near`) and cargo-near, with ROOT's key in ~/.near-credentials/<network>.
# Creates tusdc.<ROOT> (token, 3 NEAR: ~1.8 NEAR of contract storage) and relayer.<ROOT> (minter
# and gas relayer, RELAYER_FUNDING, default 5 NEAR); near-cli saves the new keys in
# ~/.near-credentials, never in this repo. On mainnet nothing is sent unless CONFIRM_MAINNET
# names the token account (docs/mainnet.md).
set -euo pipefail

NETWORK=${NETWORK:-testnet}
case $NETWORK in
  testnet) ROOT=${ROOT:-tilthouse.testnet}; SUFFIX=.testnet; DRY_RUN=${DRY_RUN:-0} ;;
  mainnet) : "${ROOT:?set ROOT to the mainnet root account, e.g. tilthouse.near}"; SUFFIX=.near; DRY_RUN=1 ;;
  *) echo "NETWORK must be testnet or mainnet" >&2; exit 1 ;;
esac
if [[ $ROOT != *"$SUFFIX" ]]; then
  echo "ROOT=$ROOT is not a $NETWORK account (*$SUFFIX)" >&2
  exit 1
fi
OWNER=$ROOT
TOKEN=tusdc.$OWNER
MINTER=relayer.$OWNER
RELAYER_FUNDING=${RELAYER_FUNDING:-5 NEAR}
if [[ $NETWORK == mainnet && ${CONFIRM_MAINNET:-} == "$TOKEN" ]]; then DRY_RUN=0; fi
REPO=$(cd "$(dirname "$0")/.." && pwd)
WASM=$REPO/target/near/tilt_house_token/tilt_house_token.wasm

# run <command…>: prints it in a dry run, runs it otherwise.
run() {
  if [[ $DRY_RUN == 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

[[ $DRY_RUN == 1 ]] && echo "DRY RUN on $NETWORK: nothing is signed (mainnet: set CONFIRM_MAINNET=$TOKEN to send)"

run bash -c "cd '$REPO/token' && cargo near build non-reproducible-wasm"

run near account create-account fund-myself "$TOKEN" '3 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send

run near account create-account fund-myself "$MINTER" "$RELAYER_FUNDING" \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send

run near contract deploy "$TOKEN" use-file "$WASM" \
  with-init-call new json-args "{\"owner_id\":\"$OWNER\",\"minter_id\":\"$MINTER\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

# The owner (also the keeper) receives uncapped mints from the minter: the floor seed and the
# chips it pays as NPC salaries.
run near contract call-function as-transaction "$TOKEN" set_unlimited \
  json-args "{\"account_id\":\"$OWNER\",\"unlimited\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send

echo "tUSDC at $TOKEN on $NETWORK (owner $OWNER, minter $MINTER)$([[ $DRY_RUN == 1 ]] && echo ': dry run, nothing sent')"
