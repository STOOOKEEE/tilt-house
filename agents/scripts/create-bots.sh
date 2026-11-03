#!/usr/bin/env bash
# Creates the three bot players on NEAR testnet and gives each 200 tUSDC inside the house.
#
# Needs near-cli-rs (`near`), the house and tUSDC already deployed (scripts/deploy-testnet.sh), and the
# keys of tilthouse.testnet (pays the accounts) and relayer.tilthouse.testnet (tUSDC minter) in
# ~/.near-credentials. New full-access keys are saved there by near-cli, never in this repo.
#
# Steps per bot: create bot-<name>.tilthouse.testnet (1 NEAR for gas); mint 200 tUSDC to it
# (the 0.01 NEAR attached pays its token registration); deposit it in the house (ft_transfer_call, msg "").
set -euo pipefail

NETWORK=testnet
OWNER=tilthouse.testnet
HOUSE=house.$OWNER
TOKEN=tusdc.$OWNER
MINTER=relayer.$OWNER
AMOUNT=200000000   # 200 tUSDC (6 decimals)
BOTS=(hunter loyal whale)

# call <signer> <contract> <method> <json args> <deposit>
call() {
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas '100 Tgas' attached-deposit "$5" \
    sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send
}

for name in "${BOTS[@]}"; do
  bot=bot-$name.$OWNER
  near account create-account fund-myself "$bot" '1 NEAR' \
    autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send
  call "$MINTER" "$TOKEN" mint_to "{\"account_id\":\"$bot\",\"amount\":\"$AMOUNT\"}" '0.01 NEAR'
  call "$bot" "$TOKEN" ft_transfer_call "{\"receiver_id\":\"$HOUSE\",\"amount\":\"$AMOUNT\",\"msg\":\"\"}" '1 yoctoNEAR'
  near contract call-function as-read-only "$HOUSE" get_player json-args "{\"account_id\":\"$bot\"}" \
    network-config "$NETWORK" now
done
echo "bots ready: ${BOTS[*]/#/bot-} (.$OWNER)"
