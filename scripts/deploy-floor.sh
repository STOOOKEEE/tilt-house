#!/usr/bin/env bash
# Deploys the Tilt House v2 floor contract (docs/contract-api.md) to a fresh
# floor.tilthouse.testnet and seats the five launch NPC dealers.
#
# Needs near-cli-rs (`near`) and cargo-near, tUSDC already deployed (scripts/deploy-token.sh),
# and the keys of tilthouse.testnet (owner) and relayer.tilthouse.testnet (tUSDC minter) in
# ~/.near-credentials. New account keys are saved there by near-cli, never in this repo.
#
# Env:
#   SESSION_SERVER_PUBKEY  (required) the session server's ed25519 public key, 64 hex chars
#   KEEPER                 account allowed to reprice / rent_bid for every dealer (default: owner)
#
# Steps: build; create floor.tilthouse.testnet (10 NEAR from the owner, pays player storage);
# deploy + init; register the floor on tUSDC; mint the owner's seed and deposit it; add_dealer x5
# (2,000 tUSDC each from the owner's in-contract balance, owner's LP shares, controlled by the
# dealer's own account, created if missing); launch_floor seats them (seats 1-5, seat 6 empty).
set -euo pipefail

: "${SESSION_SERVER_PUBKEY:?set SESSION_SERVER_PUBKEY to the session server ed25519 public key (hex)}"
if [[ ! $SESSION_SERVER_PUBKEY =~ ^[0-9a-f]{64}$ ]]; then
  echo "SESSION_SERVER_PUBKEY must be 64 lowercase hex characters" >&2
  exit 1
fi

NETWORK=testnet
OWNER=tilthouse.testnet
FLOOR=floor.$OWNER
TOKEN=tusdc.$OWNER
MINTER=relayer.$OWNER
KEEPER=${KEEPER:-$OWNER}
SEED=2000000000           # 2,000 tUSDC per dealer (6 decimals)
TOTAL_SEED=10000000000    # 5 dealers
STORAGE_DEPOSIT='0.00125 NEAR'
# id name game temperament (the launch lineup, as in sim/src/world.rs)
DEALERS=(
  "ada Ada dice greedy"
  "bruno Bruno dice promoter"
  "chloe Chloe roulette cautious"
  "dmitri Dmitri roulette greedy"
  "eve Eve blackjack promoter"
)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WASM=$ROOT/target/near/tilt_house_contract/tilt_house_contract.wasm

# call <signer> <contract> <method> <json args> <deposit> [gas]
call() {
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-100 Tgas}" attached-deposit "$5" \
    sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send
}

create_account() {
  near account create-account fund-myself "$1" "$2" \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send
}

account_exists() {
  near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1
}

(cd "$ROOT/contract" && cargo near build non-reproducible-wasm)

create_account "$FLOOR" '10 NEAR'
# The launch dealers' accounts usually exist already (v1 house); they sign reprice / rent_bid.
for dealer in "${DEALERS[@]}"; do
  read -r id _ _ _ <<<"$dealer"
  account_exists "$id.$OWNER" || create_account "$id.$OWNER" '0.5 NEAR'
done

near contract deploy "$FLOOR" use-file "$WASM" \
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"token\":\"$TOKEN\",\"keeper\":\"$KEEPER\",\"server_pubkey_hex\":\"$SESSION_SERVER_PUBKEY\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

# The floor must hold a tUSDC storage balance to receive deposits.
call "$OWNER" "$TOKEN" storage_deposit "{\"account_id\":\"$FLOOR\",\"registration_only\":true}" "$STORAGE_DEPOSIT"

# The owner is unlimited on tUSDC; the deposit registers it if needed (the rest is refunded).
call "$MINTER" "$TOKEN" mint_to "{\"account_id\":\"$OWNER\",\"amount\":\"$TOTAL_SEED\"}" "$STORAGE_DEPOSIT"
call "$OWNER" "$TOKEN" ft_transfer_call "{\"receiver_id\":\"$FLOOR\",\"amount\":\"$TOTAL_SEED\",\"msg\":\"\"}" '1 yoctoNEAR'

ids=()
for dealer in "${DEALERS[@]}"; do
  read -r id name game temperament <<<"$dealer"
  call "$OWNER" "$FLOOR" add_dealer \
    "{\"id\":\"$id\",\"name\":\"$name\",\"game\":\"$game\",\"temperament\":\"$temperament\",\"look\":null,\"dealer_account\":\"$id.$OWNER\",\"seed_amount\":\"$SEED\"}" \
    '0 NEAR'
  ids+=("\"$id\"")
done

call "$OWNER" "$FLOOR" launch_floor "{\"dealer_ids\":[$(IFS=,; echo "${ids[*]}")]}" '0 NEAR' '150 Tgas'

near contract call-function as-read-only "$FLOOR" get_floor json-args '{}' \
  network-config "$NETWORK" now
echo "Tilt House floor deployed at $FLOOR (token $TOKEN, keeper $KEEPER, seated: ada bruno chloe dmitri eve)"
