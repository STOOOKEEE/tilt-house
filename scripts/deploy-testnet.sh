#!/usr/bin/env bash
# Deploys the Tilt House contract to NEAR testnet and opens the five launch tables.
#
# Needs near-cli-rs (`near`) and cargo-near, tUSDC already deployed (scripts/deploy-token.sh),
# and the keys of tilthouse.testnet (owner) and relayer.tilthouse.testnet (tUSDC minter) in
# ~/.near-credentials. New account keys are saved there by near-cli, never in this repo.
#
# Steps: build; create house.tilthouse.testnet (5 NEAR, pays OutLayer fees and player storage)
# and one account per dealer (0.5 NEAR, it signs `reprice`); deploy + init; register the house on
# tUSDC; mint the owner's seed and deposit it in the house; add_dealer x5, each seeded with
# 2,000 tUSDC taken from the owner's in-contract balance (minted as the owner's LP shares).
set -euo pipefail

NETWORK=testnet
OWNER=tilthouse.testnet
HOUSE=house.$OWNER
TOKEN=tusdc.$OWNER
MINTER=relayer.$OWNER
OUTLAYER=outlayer.testnet
# OutLayer's testnet VRF key (GET https://testnet-api.outlayer.ai/vrf/pubkey).
VRF_PUBKEY=c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8
# vrf-example @ 15b5024 registered as an OutLayer project; the pinned version cannot be swapped.
VRF_SOURCE='{"Project":{"project_id":"tilthouse.testnet/tilt-vrf","version_key":"898b0449aec714bc97dd9725dc6faaee19b2c1a702a87c9d457cf0d279b23d7a"}}'
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

(cd "$ROOT/contract" && cargo near build non-reproducible-wasm)

create_account "$HOUSE" '5 NEAR'
for dealer in "${DEALERS[@]}"; do
  read -r id _ _ _ <<<"$dealer"
  create_account "$id.$OWNER" '0.5 NEAR'
done

near contract deploy "$HOUSE" use-file "$WASM" \
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"token\":\"$TOKEN\",\"outlayer\":\"$OUTLAYER\",\"vrf_pubkey_hex\":\"$VRF_PUBKEY\",\"vrf_source\":$VRF_SOURCE}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

# The house must hold a tUSDC storage balance to receive deposits.
call "$OWNER" "$TOKEN" storage_deposit "{\"account_id\":\"$HOUSE\",\"registration_only\":true}" "$STORAGE_DEPOSIT"

# The owner is unlimited on tUSDC; the deposit registers it if needed (the rest is refunded).
call "$MINTER" "$TOKEN" mint_to "{\"account_id\":\"$OWNER\",\"amount\":\"$TOTAL_SEED\"}" "$STORAGE_DEPOSIT"
call "$OWNER" "$TOKEN" ft_transfer_call "{\"receiver_id\":\"$HOUSE\",\"amount\":\"$TOTAL_SEED\",\"msg\":\"\"}" '1 yoctoNEAR'

for dealer in "${DEALERS[@]}"; do
  read -r id name game temperament <<<"$dealer"
  call "$OWNER" "$HOUSE" add_dealer \
    "{\"id\":\"$id\",\"name\":\"$name\",\"game\":\"$game\",\"temperament\":\"$temperament\",\"dealer_account\":\"$id.$OWNER\",\"seed_amount\":\"$SEED\"}" \
    '0 NEAR'
done

near contract call-function as-read-only "$HOUSE" get_lobby json-args '{}' \
  network-config "$NETWORK" now
echo "Tilt House deployed at $HOUSE (token $TOKEN, dealers: ada bruno chloe dmitri eve)"
