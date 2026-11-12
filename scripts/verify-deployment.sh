#!/usr/bin/env bash
# Checks that the contracts live on chain are the ones in this repo.
#
#   scripts/verify-deployment.sh            # every network in deployments/*.json
#   scripts/verify-deployment.sh testnet    # one network
#
# For each contract in deployments/<network>.json it reads the account's `code_hash` over RPC and
# compares it with the recorded one. For contracts marked "reproducible": true it also builds the
# wasm with `cargo near build reproducible-wasm` (docker, pinned toolchain image) from a clean
# checkout of the recorded "commit" (HEAD if none) and compares base58(sha256(wasm)), the same
# encoding as NEAR's `code_hash`.
# Prints PASS/FAIL per check and exits 1 if anything fails.
#
# Needs: git, node 22+; for the build: cargo-near and docker.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

if [[ $# -gt 0 ]]; then
  networks=("$@")
else
  networks=()
  for file in deployments/*.json; do networks+=("$(basename "$file" .json)"); done
fi

# The reproducible build refuses uncommitted changes, so build from clean worktrees.
BUILD_DIR=$(mktemp -d)
cleanup() {
  for tree in "$BUILD_DIR"/src-*; do
    [[ -d $tree ]] && git worktree remove --force "$tree" >/dev/null 2>&1
  done
  rm -rf "$BUILD_DIR"
  git worktree prune
}
trap cleanup EXIT

# Builds <source dir> at <commit> once and prints the wasm path.
build_wasm() {
  local source=$1 commit=$2
  local tree="$BUILD_DIR/src-$commit" out="$BUILD_DIR/out-$commit/$source"
  if [[ ! -d "$out" ]]; then
    [[ -d "$tree" ]] || git worktree add --quiet --detach "$tree" "$commit"
    mkdir -p "$out"
    (cd "$tree/$source" && cargo near build reproducible-wasm --out-dir "$out") >&2
  fi
  local wasm=("$out"/*.wasm)
  echo "${wasm[0]}"
}

code_hash_of_file() {
  node -e '
    const bytes = require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest()
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    let n = BigInt("0x" + bytes.toString("hex")), out = ""
    while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n }
    for (const b of bytes) { if (b !== 0) break; out = "1" + out }
    console.log(out)
  ' "$1"
}

# Prints one line per contract: name, account, recorded hash, chain hash, reproducible, source,
# commit.
contracts_of() {
  node -e '
    const deployment = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const rpc = async (accountId) => {
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(deployment.rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method: "query",
            params: { request_type: "view_account", finality: "final", account_id: accountId } }),
        })
        if (response.ok) {
          const body = await response.json()
          if (body.result) return body.result.code_hash
          if (attempt >= 3) return "error:" + JSON.stringify(body.error?.cause ?? body.error)
        } else if (attempt >= 3) {
          return "error:http-" + response.status
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
    ;(async () => {
      for (const [name, c] of Object.entries(deployment.contracts)) {
        console.log([name, c.account_id, c.code_hash, await rpc(c.account_id), c.reproducible === true, c.source, c.commit ?? "HEAD"].join(" "))
      }
    })()
  ' "$1"
}

failed=0
report() { # status, message
  echo "$1  $2"
  [[ $1 == PASS || $1 == SKIP ]] || failed=1
}

for network in "${networks[@]}"; do
  file="deployments/$network.json"
  [[ -f $file ]] || { report FAIL "$network: no $file"; continue; }
  echo "== $network ($file)"
  while read -r name account recorded chain reproducible source commit; do
    if [[ $chain == "$recorded" ]]; then
      report PASS "$name $account: chain code_hash $chain = recorded"
    else
      report FAIL "$name $account: chain code_hash $chain != recorded $recorded"
    fi
    if [[ $reproducible != true ]]; then
      report SKIP "$name $account: not built reproducibly, no source build to compare"
      continue
    fi
    commit=$(git rev-parse --short "$commit")
    built=$(code_hash_of_file "$(build_wasm "$source" "$commit")")
    if [[ $built == "$chain" ]]; then
      report PASS "$name $account: reproducible build of $source/ at $commit = chain ($built)"
    else
      report FAIL "$name $account: reproducible build of $source/ at $commit is $built, chain has $chain"
    fi
  done < <(contracts_of "$file")
done

if [[ $failed == 0 ]]; then echo "PASS"; else echo "FAIL"; exit 1; fi
