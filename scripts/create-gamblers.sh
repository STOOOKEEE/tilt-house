#!/usr/bin/env bash
# Creates the 24 NPC gambler accounts g-<name>.tilthouse.testnet (docs/tycoon.md), 0.3 NEAR each
# from tilthouse.testnet. Names are core/src/gambler_rules.rs LINEUP, lower case.
#
# Needs near-cli-rs (`near`) and tilthouse.testnet's key in ~/.near-credentials. near-cli saves
# each new key in the legacy keychain (~/.near-credentials/testnet/<account>.json), where the
# session server reads them (GAMBLER_KEYS_DIR); never in this repo. Existing accounts are skipped,
# so the script can be re-run after a failure.
set -euo pipefail

NETWORK=testnet
OWNER=tilthouse.testnet
FUNDING='0.3 NEAR'
GAMBLERS=(
  mia noah zoe liam ines omar kai lea hugo nina theo ava
  yuki sam iris max rosa ezra vera paul june ravi lola tom
)

exists() {
  near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1
}

for name in "${GAMBLERS[@]}"; do
  account="g-$name.$OWNER"
  if exists "$account"; then
    echo "skip $account (exists)"
    continue
  fi
  near account create-account fund-myself "$account" "$FUNDING" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send
  echo "created $account"
done
