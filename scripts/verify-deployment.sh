#!/usr/bin/env bash
# Checks that the contracts live on chain are the ones in this repo.
#
#   scripts/verify-deployment.sh            # every network in deployments/*.json
#   scripts/verify-deployment.sh testnet    # one network
#
# For each contract in deployments/<network>.json it reads the account's `code_hash` over RPC and
# compares it with the recorded one. For contracts marked "reproducible": true it also builds the
# wasm with `cargo near build reproducible-wasm` (docker, pinned toolchain image) from a clean
# checkout of the commit the contract names in its NEP-330 `contract_source_metadata` (which must
# match the recorded "commit") and compares base58(sha256(wasm)), the same encoding as NEAR's
# `code_hash`.
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

# The reproducible build refuses uncommitted changes and mounts the crate's repo in docker, so
# build from a fresh clone (a worktree's .git points outside the mount).
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

# Builds <source dir> at <commit> once and prints the wasm path.
build_wasm() {
  local source=$1 commit=$2
  local tree="$BUILD_DIR/src-$commit" out="$BUILD_DIR/out-$commit/$source"
  if [[ ! -d "$out" ]]; then
    if [[ ! -d "$tree" ]]; then
      git clone --quiet --no-checkout "$ROOT" "$tree"
      git -C "$tree" checkout --quiet --detach "$commit"
    fi
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
# recorded commit, commit named on chain ("-" if none).
contracts_of() {
  node -e '
    const deployment = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const query = async (params) => {
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(deployment.rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method: "query",
            params: { finality: "final", ...params } }),
        })
        if (response.ok) {
          const body = await response.json()
          if (body.result && !body.result.error) return body.result
          if (attempt >= 3) throw new Error(JSON.stringify(body.error?.cause ?? body.error ?? body.result.error))
        } else if (attempt >= 3) {
          throw new Error("http " + response.status)
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
    const codeHash = (accountId) =>
      query({ request_type: "view_account", account_id: accountId })
        .then((r) => r.code_hash, (e) => "error:" + e.message.replaceAll(" ", "_"))
    // NEP-330: a reproducible build records `source_code_snapshot = git+<repo>?rev=<commit>`.
    const sourceRev = (accountId) =>
      query({ request_type: "call_function", account_id: accountId,
        method_name: "contract_source_metadata", args_base64: "" })
        .then((r) => JSON.parse(Buffer.from(r.result).toString()).build_info?.source_code_snapshot ?? "")
        .then((snapshot) => /[?&]rev=([0-9a-f]{7,40})/.exec(snapshot)?.[1] ?? "-", () => "-")
    ;(async () => {
      for (const [name, c] of Object.entries(deployment.contracts)) {
        const reproducible = c.reproducible === true
        const chainRev = reproducible ? await sourceRev(c.account_id) : "-"
        console.log([name, c.account_id, c.code_hash, await codeHash(c.account_id), reproducible, c.source, c.commit ?? "-", chainRev].join(" "))
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
  while read -r name account recorded chain reproducible source commit chain_rev; do
    if [[ $chain == "$recorded" ]]; then
      report PASS "$name $account: chain code_hash $chain = recorded"
    else
      report FAIL "$name $account: chain code_hash $chain != recorded $recorded"
    fi
    if [[ $reproducible != true ]]; then
      report SKIP "$name $account: not built reproducibly, no source build to compare"
      continue
    fi
    if [[ $chain_rev == - ]] || ! git cat-file -e "$chain_rev^{commit}" 2>/dev/null; then
      report FAIL "$name $account: source commit '$chain_rev' named on chain unknown or not in this clone (git fetch)"
      continue
    fi
    if [[ $commit != - && $(git rev-parse "$commit^{commit}" 2>/dev/null) != "$(git rev-parse "$chain_rev")" ]]; then
      report FAIL "$name $account: chain names commit $chain_rev, $file records $commit"
    fi
    commit=$(git rev-parse --short "$chain_rev")
    built=$(code_hash_of_file "$(build_wasm "$source" "$commit")")
    if [[ $built == "$chain" ]]; then
      report PASS "$name $account: reproducible build of $source/ at $commit = chain ($built)"
    else
      report FAIL "$name $account: reproducible build of $source/ at $commit is $built, chain has $chain"
    fi
  done < <(contracts_of "$file")
done

if [[ $failed == 0 ]]; then echo "PASS"; else echo "FAIL"; exit 1; fi
