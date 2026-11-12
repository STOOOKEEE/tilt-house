#!/usr/bin/env bash
# Deploys the Tilt House floor contract (docs/contract-api.md) on testnet or mainnet.
#
#   scripts/deploy-floor.sh create    fresh floor.<ROOT>: deploy + init, seed and seat the launch dealers,
#                                     register the NPC gamblers
#   scripts/deploy-floor.sh upgrade   new code on the existing floor.<ROOT> with the `migrate` init call (v2 → v3),
#                                     then add the poker dealer (off the floor) and register the NPC gamblers
#   scripts/deploy-floor.sh npcs      register_npcs only (g-<name>.<ROOT>, names from core gambler_rules LINEUP)
#
# Needs near-cli-rs (`near`), cargo-near and Docker (reproducible build: commit first), the token already deployed
# (scripts/deploy-token.sh) and the keys of ROOT (owner), MINTER and, for `upgrade`, the floor account in
# ~/.near-credentials. New account keys are saved there by near-cli, never in this repo.
#
# Env:
#   NETWORK                testnet (default) | mainnet
#   ROOT                   owner account; every other account derives from it (default tilthouse.testnet)
#   SESSION_SERVER_PUBKEY  (create) the session server's ed25519 public key, 64 lowercase hex chars
#   KEEPER                 reprice / rent_bid / NPC salary account (default: ROOT)
#   TOKEN, MINTER          money token and its minter (default tusdc.<ROOT>, relayer.<ROOT>)
#   FLOOR_BALANCE          NEAR given to a new floor account for storage (default '10 NEAR')
#   CONFIRM_MAINNET        mainnet only: must equal floor.<ROOT> to send anything. Without it every mainnet
#                          command is only printed (dry run): agents never sign on mainnet.
#   DRY_RUN=1              print the commands instead of sending them (any network)
set -euo pipefail

ACTION=${1:-}
NETWORK=${NETWORK:-testnet}
ROOT=${ROOT:-tilthouse.testnet}
FLOOR=floor.$ROOT
TOKEN=${TOKEN:-tusdc.$ROOT}
MINTER=${MINTER:-relayer.$ROOT}
KEEPER=${KEEPER:-$ROOT}
FLOOR_BALANCE=${FLOOR_BALANCE:-10 NEAR}
DRY_RUN=${DRY_RUN:-0}

case $NETWORK in
  testnet) [[ $ROOT == *.testnet ]] || { echo "ROOT must be a .testnet account on testnet" >&2; exit 1; } ;;
  mainnet)
    [[ $ROOT != *.testnet ]] || { echo "ROOT must be a mainnet account on mainnet" >&2; exit 1; }
    if [[ ${CONFIRM_MAINNET:-} != "$FLOOR" ]]; then
      DRY_RUN=1
      echo "mainnet: dry run (set CONFIRM_MAINNET=$FLOOR to send)" >&2
    fi
    ;;
  *) echo "NETWORK must be testnet or mainnet" >&2; exit 1 ;;
esac

SEED=2000000000           # 2,000 chips per launch dealer (6 decimals)
STORAGE_DEPOSIT='0.00125 NEAR'
# id name game temperament look (the launch lineup, as in sim/src/world.rs, plus the poker host)
DEALERS=(
  "ada Ada dice greedy null"
  "bruno Bruno dice promoter null"
  "chloe Chloe roulette cautious null"
  "dmitri Dmitri roulette greedy null"
  "eve Eve blackjack promoter null"
)
POKER_DEALER="faye Faye poker cautious top-hat"
REPO=$(cd "$(dirname "$0")/.." && pwd)
WASM=$REPO/target/near/tilt_house_contract/tilt_house_contract.wasm

# Runs a command, or prints it on a dry run.
run() {
  if [[ $DRY_RUN == 1 ]]; then
    printf '%q ' "$@"
    echo
  else
    "$@"
  fi
}

# call <signer> <contract> <method> <json args> <deposit> [gas]
call() {
  run near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-100 Tgas}" attached-deposit "$5" \
    sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send
}

create_account() {
  run near account create-account fund-myself "$1" "$2" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$ROOT" network-config "$NETWORK" sign-with-legacy-keychain send
}

# Read-only: never signs.
account_exists() {
  near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1
}

build() {
  # Reproducible: the image is pinned in contract/Cargo.toml; the tree must be committed.
  (cd "$REPO/contract" && cargo near build reproducible-wasm)
  echo "wasm sha256: $(sha256sum "$WASM" | cut -d' ' -f1)"
}

# add_dealer <id> <name> <game> <temperament> <look|null>
add_dealer() {
  local look=null
  [[ $5 == null ]] || look="\"$5\""
  account_exists "$1.$ROOT" || create_account "$1.$ROOT" '0.5 NEAR'
  call "$ROOT" "$FLOOR" add_dealer \
    "{\"id\":\"$1\",\"name\":\"$2\",\"game\":\"$3\",\"temperament\":\"$4\",\"look\":$look,\"dealer_account\":\"$1.$ROOT\",\"seed_amount\":\"$SEED\"}" \
    '0 NEAR'
}

# Seed money for `count` dealers: minted to the owner, deposited into the floor.
fund_owner() {
  local total=$(($1 * SEED))
  call "$MINTER" "$TOKEN" mint_to "{\"account_id\":\"$ROOT\",\"amount\":\"$total\"}" "$STORAGE_DEPOSIT"
  call "$ROOT" "$TOKEN" ft_transfer_call "{\"receiver_id\":\"$FLOOR\",\"amount\":\"$total\",\"msg\":\"\"}" '1 yoctoNEAR'
}

register_npcs() {
  local names accounts
  names=$(sed -n '/pub const LINEUP/,/^];/s/^ *("\([A-Za-z]*\)".*/\1/p' "$REPO/core/src/gambler_rules.rs")
  accounts=$(for name in $names; do printf '"g-%s.%s",' "${name,,}" "$ROOT"; done)
  call "$ROOT" "$FLOOR" register_npcs "{\"accounts\":[${accounts%,}]}" '0 NEAR'
}

create() {
  : "${SESSION_SERVER_PUBKEY:?set SESSION_SERVER_PUBKEY to the session server ed25519 public key (hex)}"
  if [[ ! $SESSION_SERVER_PUBKEY =~ ^[0-9a-f]{64}$ ]]; then
    echo "SESSION_SERVER_PUBKEY must be 64 lowercase hex characters" >&2
    exit 1
  fi
  build
  create_account "$FLOOR" "$FLOOR_BALANCE"
  run near contract deploy "$FLOOR" use-file "$WASM" \
    with-init-call new json-args "{\"owner\":\"$ROOT\",\"token\":\"$TOKEN\",\"keeper\":\"$KEEPER\",\"server_pubkey_hex\":\"$SESSION_SERVER_PUBKEY\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
  # The floor must hold a token storage balance to receive deposits.
  call "$ROOT" "$TOKEN" storage_deposit "{\"account_id\":\"$FLOOR\",\"registration_only\":true}" "$STORAGE_DEPOSIT"
  local lineup=("${DEALERS[@]}" "$POKER_DEALER") ids=()
  fund_owner "${#lineup[@]}"
  for dealer in "${lineup[@]}"; do
    read -r id name game temperament look <<<"$dealer"
    add_dealer "$id" "$name" "$game" "$temperament" "$look"
    ids+=("\"$id\"")
  done
  call "$ROOT" "$FLOOR" launch_floor "{\"dealer_ids\":[$(IFS=,; echo "${ids[*]}")]}" '0 NEAR' '200 Tgas'
  register_npcs
}

upgrade() {
  build
  # `migrate` is #[private]: the deploy is signed by the floor account itself.
  run near contract deploy "$FLOOR" use-file "$WASM" \
    with-init-call migrate json-args '{}' \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
  # The live floor is full: the poker host starts off the floor and wins a seat through rent_bid.
  read -r id name game temperament look <<<"$POKER_DEALER"
  fund_owner 1
  add_dealer "$id" "$name" "$game" "$temperament" "$look"
  register_npcs
}

case $ACTION in
  create) create ;;
  upgrade) upgrade ;;
  npcs) register_npcs ;;
  *) echo "usage: [NETWORK=testnet|mainnet] [ROOT=…] $0 create|upgrade|npcs" >&2; exit 1 ;;
esac

if [[ $DRY_RUN != 1 ]]; then
  near contract call-function as-read-only "$FLOOR" get_config json-args '{}' network-config "$NETWORK" now
fi
echo "floor $FLOOR on $NETWORK: $ACTION done$([[ $DRY_RUN == 1 ]] && echo ' (dry run, nothing sent)')"
