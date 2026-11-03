#!/usr/bin/env bash
# Deploys tUSDC, the testnet-only Tilt House test token (no value), to NEAR testnet.
#
# Needs near-cli-rs (`near`) and cargo-near, with tilthouse.testnet's key in ~/.near-credentials.
# Creates tusdc.tilthouse.testnet (token, 3 NEAR) and relayer.tilthouse.testnet (minter, 5 NEAR);
# near-cli saves the new keys in ~/.near-credentials, never in this repo.
set -euo pipefail

NETWORK=testnet
OWNER=tilthouse.testnet
TOKEN=tusdc.$OWNER
MINTER=relayer.$OWNER
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WASM=$ROOT/target/near/tilt_house_token/tilt_house_token.wasm

(cd "$ROOT/token" && cargo near build non-reproducible-wasm)

near account create-account fund-myself "$TOKEN" '3 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send

near account create-account fund-myself "$MINTER" '5 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send

near contract deploy "$TOKEN" use-file "$WASM" \
  with-init-call new json-args "{\"owner_id\":\"$OWNER\",\"minter_id\":\"$MINTER\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

near contract call-function as-transaction "$TOKEN" set_unlimited \
  json-args "{\"account_id\":\"$OWNER\",\"unlimited\":true}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send

echo "tUSDC deployed at $TOKEN (owner $OWNER, minter $MINTER)"
