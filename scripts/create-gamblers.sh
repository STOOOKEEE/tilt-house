#!/usr/bin/env bash
# Creates the 24 NPC gambler accounts g-<name>.<ROOT> (docs/tycoon.md), funded by ROOT. Names are
# core/src/gambler_rules.rs LINEUP, lower case.
#
#   NETWORK=testnet scripts/create-gamblers.sh                      # ROOT defaults to tilthouse.testnet
#   NETWORK=mainnet ROOT=tilthouse.near scripts/create-gamblers.sh   # dry run: prints every command
#   NETWORK=mainnet ROOT=tilthouse.near CONFIRM_MAINNET=tilthouse.near scripts/create-gamblers.sh
#
# Testnet: each account keeps its full-access key (contract v2 NPCs deposit their own salary).
# Mainnet: each account ends with ONE key, a function-call key for the floor's session methods
# (open_session, close_session, force_close, claim_unrevealed) with a gas allowance; the
# full-access key is deleted, so nobody, us included, can move an NPC's NEAR or chips anywhere
# but the floor's tables. The keeper pays salaries in-contract (`credit_npc`), the floor refuses
# withdrawals for registered NPCs (scripts/deploy-floor.sh registers them).
#
# Needs near-cli-rs (`near`), node (key generation with the repo's near-api-js, agents/), and
# ROOT's key in ~/.near-credentials/<network>. Keys are written to KEYS_DIR (default
# ~/.near-credentials/<network>/<account>.json, mode 600), where the session server reads them
# (GAMBLER_KEYS_DIR); never in this repo, never printed. Existing accounts are skipped, so the
# script can be re-run after a failure.
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
if [[ $NETWORK == mainnet && ${CONFIRM_MAINNET:-} == "$ROOT" ]]; then DRY_RUN=0; fi
FLOOR=${FLOOR:-floor.$ROOT}
FUNDING=${FUNDING:-0.3 NEAR}
# Gas the session key may burn over its life. With no full-access key it can never be raised:
# 1 NEAR is ~100 days of measured NPC play (~0.01 NEAR/day on testnet).
ALLOWANCE=${ALLOWANCE:-1 NEAR}
SESSION_METHODS='open_session, close_session, force_close, claim_unrevealed'
KEYS_DIR=${KEYS_DIR:-$HOME/.near-credentials/$NETWORK}
REPO=$(cd "$(dirname "$0")/.." && pwd)
GAMBLERS=(
  mia noah zoe liam ines omar kai lea hugo nina theo ava
  yuki sam iris max rosa ezra vera paul june ravi lola tom
)

run() {
  if [[ $DRY_RUN == 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

exists() {
  near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1
}

public_key_of() {
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).public_key)' "$1"
}

# new_key_file <path> <account>: writes a fresh ed25519 key pair (near-cli format, mode 600).
new_key_file() {
  (cd "$REPO/agents" && umask 077 && node --input-type=module -e '
    import { writeFileSync } from "node:fs";
    import { KeyPair } from "near-api-js";
    const [file, account] = process.argv.slice(1);
    const key = KeyPair.fromRandom("ed25519");
    const json = { account_id: account, public_key: key.getPublicKey().toString(), private_key: key.toString() };
    writeFileSync(file, JSON.stringify(json), { mode: 0o600, flag: "wx" });
  ' "$1" "$2")
}

# Mainnet: swap the account's full-access key for a session-only function-call key.
lock_down() {
  local account=$1 full=$KEYS_DIR/$1.json session=$KEYS_DIR/$1.session.json
  if [[ $DRY_RUN == 1 ]]; then
    echo "[dry-run] write a new session key pair to $session (mode 600)"
    run near account add-key "$account" grant-function-call-access --allowance "$ALLOWANCE" \
      --contract-account-id "$FLOOR" --function-names "$SESSION_METHODS" \
      use-manually-provided-public-key '<SESSION_PUBLIC_KEY>' network-config "$NETWORK" sign-with-legacy-keychain send
    run near account delete-keys "$account" public-keys '<FULL_ACCESS_PUBLIC_KEY>' network-config "$NETWORK" sign-with-legacy-keychain send
    echo "[dry-run] mv $session $full"
    return
  fi
  [[ -f $session ]] || new_key_file "$session" "$account"
  near account add-key "$account" grant-function-call-access --allowance "$ALLOWANCE" \
    --contract-account-id "$FLOOR" --function-names "$SESSION_METHODS" \
    use-manually-provided-public-key "$(public_key_of "$session")" network-config "$NETWORK" sign-with-legacy-keychain send
  # Signed with the full-access key still in $full; the session key replaces it only afterwards.
  near account delete-keys "$account" public-keys "$(public_key_of "$full")" network-config "$NETWORK" sign-with-legacy-keychain send
  mv "$session" "$full"
}

[[ $DRY_RUN == 1 ]] && echo "DRY RUN on $NETWORK: nothing is signed (mainnet: set CONFIRM_MAINNET=$ROOT to send)"

for name in "${GAMBLERS[@]}"; do
  account="g-$name.$ROOT"
  if exists "$account"; then
    echo "skip $account (exists; check its keys: near account list-keys $account network-config $NETWORK now)"
    continue
  fi
  run near account create-account fund-myself "$account" "$FUNDING" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$ROOT" network-config "$NETWORK" sign-with-legacy-keychain send
  [[ $NETWORK == mainnet ]] && lock_down "$account"
  echo "created $account$([[ $DRY_RUN == 1 ]] && echo ' (dry run)')"
done
