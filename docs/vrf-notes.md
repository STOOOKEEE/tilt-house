# OutLayer VRF on NEAR testnet: spike notes

Spike: `spikes/vrf/` (throwaway contract, own `[workspace]`), deployed to
`vrfspike.tilthouse.testnet`. Measured on 2026-11-03.

## Result

A contract-initiated VRF round trip works and verifies on chain.

| Round | Tx | Callback log |
|---|---|---|
| 4 (first success) | [`BheWBR5zSFQreWoJW7HHVXc7oAMMvpMvcjThogKM28Jh`](https://testnet.nearblocks.io/txns/BheWBR5zSFQreWoJW7HHVXc7oAMMvpMvcjThogKM28Jh) | `round 4: verified VRF output a42bd982…93ae8b` |
| 8 (final committed code) | [`2y9qun8JJpwEPHiXycTpnqYGvN4cRxiTvA9wVKc2LBPv`](https://testnet.nearblocks.io/txns/2y9qun8JJpwEPHiXycTpnqYGvN4cRxiTvA9wVKc2LBPv) | `round 8: verified VRF output b14a557b5ce1dc05fa7463f10c1e1f3ec2fc137f26e583030f606c00ca1e96f1` |

Rounds 5–7 (`E3QCaKMEbreeyz4VxPLbCBqkUB5zYUvSTjrw6VSGJB83`, `3vMZPyoSQu7qjVK5NMNYRw9CFZyA8ApYMJgtAzdufpP9`,
`Gm3FbWFXRVWo9yYZCCfk2eRb5gbdrAQu9C3uHuw6L1Ww`) also verified.

## Which source to use, and why

We cannot call a published VRF wasm directly. What we tried:

1. **A published testnet VRF wasm/project:** none found. The docs' `alice.near/vrf-ark` is a
   placeholder; `zavodil.testnet` (OutLayer team) has no VRF project.
2. **`GitHub` source** (`out-layer/vrf-example` @ `15b5024`): refused by the worker with
   `"Building from a GitHub repository is not available right now. Build the .wasm locally, upload it to FastFS."`
   (round 2, tx `GjVWMpPieLoeHcc7qX6vV5RBKQL6XvkUbC8RuoCcnyoW`).
3. **Bare `WasmUrl`** of our own build of vrf-example: the worker fetched and compiled it, then failed
   with `"WASM imports near:storage/api but storage is not configured"` (round 3, tx
   `4EVGkyWj4BeuHAV35C6pGgtXQx4643eKBbCvZDGPtvgf`). vrf-example calls `storage::increment` (a per-signer call
   counter), and storage only exists for a `Project` source.
4. **`Project` source**: works. We built vrf-example ourselves and registered it as project
   **`tilthouse.testnet/tilt-vrf`** (`outlayer deploy`, storage deposit 0.00267 NEAR).

Build: `cargo build --target wasm32-wasip2 --release` in a checkout of `out-layer/vrf-example` @
`15b5024ed7f8032ed5d2a57d3f714e4d537ca154` → sha256
`898b0449aec714bc97dd9725dc6faaee19b2c1a702a87c9d457cf0d279b23d7a`, 121 222 bytes. The `outlayer` git
dependency pulls a submodule over SSH; build with
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=git@github.com: CARGO_NET_GIT_FETCH_WITH_CLI=true`.

**Use this source JSON** (pin `version_key` so a later `add_version` on the project cannot swap the code):

```json
{"Project": {"project_id": "tilthouse.testnet/tilt-vrf",
             "version_key": "898b0449aec714bc97dd9725dc6faaee19b2c1a702a87c9d457cf0d279b23d7a"}}
```

### FastFS testnet was down: hosting caveat

`outlayer upload` to `test.fastfs.io` succeeded on chain (tx `5ZWpqN1Ca6PnewQZ9N2usZvZZawjGfJQ8HsMqrREFvNs`,
"Exceeded the prepaid gas" is expected by design), but `https://test.fastfs.io/…` answered **502 for every
file**, including OutLayer's own, from 17:41 to at least 17:58 UTC. Round 1 failed with
`"wasm_url could not be fetched"`.

The OutLayer worker caches a fetched wasm **by sha256** in its coordinator (`worker/src/compiler/mod.rs`,
`download_and_cache_wasm`), so the URL only matters for the first fetch. We primed the cache once from a
72-hour temporary host (`https://litter.catbox.moe/55hwcp.wasm`, round 3). Since then every run logs
`Cached WASM from 2026-11-03T17:53:38`, even though the project version's URL is the dead FastFS one:
`https://test.fastfs.io/tilthouse.testnet/outlayer.testnet/898b0449aec714bc97dd9725dc6faaee19b2c1a702a87c9d457cf0d279b23d7a.wasm`.

**Risk for Task 4:** we don't know the cache eviction policy. Before the demo, check that the FastFS URL serves
the file (`curl … | sha256sum`). If it still doesn't, re-prime the cache from any https URL on port 443 (≤ 3
redirects) with a `WasmUrl` call, or add a project version with a working URL.

**Option for Task 4:** a minimal VRF wasm without `storage` (and without the verbose `verification` block)
could run as a bare `WasmUrl` with no project, and would return ~250 bytes instead of 895. That isn't
needed for correctness.

## The call

`outlayer.testnet` → `request_execution` (args JSON):

```json
{
  "source": {"Project": {"project_id": "tilthouse.testnet/tilt-vrf", "version_key": "898b0449…3d7a"}},
  "resource_limits": {"max_instructions": 1000000000, "max_memory_mb": 128, "max_execution_seconds": 30},
  "input_data": "{\"seed\":\"round-8\"}",
  "response_format": "Json"
}
```

- `resource_limits` is mandatory in practice: without it the request is compile-only and runs nothing.
- `input_data.seed` must not contain `:`. Leave `max` out so `value` is the raw 32-byte hex (`max` maps it
  to a small integer with a biased `u32 * (max+1) >> 32`; the house uses `core::Rng` on the raw output instead).
- `payer_account_id` omitted → the refund goes back to the calling contract.

### Deposit

- `estimate_execution_cost({max_instructions: 1e9, max_memory_mb: 128, max_execution_seconds: 30})` =
  **0.0040001 NEAR**. It is a worst case: `base_fee 0.001 + (instr / 1e6) × 1e14 + max_ms × 1e17` yocto
  (`get_pricing` = `[1e21, 1e14, 1e17, 1e17]`). The attached deposit must be ≥ this, or `request_execution`
  panics.
- We attach **0.01 NEAR**. Actual charge per round was **0.00105–0.00115 NEAR** (base fee + 545–1505 ms × 1e17);
  the rest is refunded to the payer in the same transaction.
- A failed run (fetch/build/runtime error) is charged what it used; the spike paid the 0.001 base fee. A yield
  timeout is charged the base fee (from the OutLayer source).

### Gas (round 8, burnt)

| Receipt | Burnt | Budget |
|---|---|---|
| `roll` (ours) | 2.1 TGas | tx prepaid 300 TGas |
| `request_execution` (OutLayer) | 4.0 TGas | we pass **100 TGas**; it reserves 50 TGas for its yield callback out of that |
| `on_execution_response` (OutLayer, after resume) | 3.1 TGas | from the 50 TGas reservation |
| `on_vrf` (ours: parse 895 B, ed25519_verify, sha256) | 1.64 TGas | static **15 TGas** |
| whole tx | 12.5 TGas | |

The minimum `REQUEST_GAS` was not probed; 100 TGas works. It must cover 50 TGas (reserved) + ~4 TGas.

### Output (callback value on success)

The promise result is the wasm's stdout JSON, verbatim (round 8):

```json
{
  "results": [{
    "alpha": "vrf:6802:vrfspike.tilthouse.testnet:round-8",
    "signature_hex": "67ddc53d31526f1374829cbb971416063cd8efd2d4917666eebdbaa73f874e843fe987dd7c2c711321c825da5bbc13c77eb02bcc379ac95093930418d740b20f",
    "value": "b14a557b5ce1dc05fa7463f10c1e1f3ec2fc137f26e583030f606c00ca1e96f1"
  }],
  "signer": "vrfspike.tilthouse.testnet",
  "total_calls": 5,
  "verification": { "vrf_public_key": "c0c5aeae…cfa8", "steps": ["…"], "pubkey_endpoint": "…", "near_code": "…" }
}
```

- `alpha` = `vrf:{request_id}:{sender_id}:{seed}`, and **`sender_id` is the transaction signer**
  (`env::signer_account_id()`), not the contract that called OutLayer (`contract/src/execution.rs`:
  `"sender_id": signer_id`). For a player's bet relayed as a meta-transaction it is the **relayer** (observed on testnet,
  round 7: `vrf:6817:relayer.tilthouse.testnet:round-7-0`).
- `value` = hex of SHA-256(signature). Recompute it; don't trust it.

### Latency (request → our callback, from block timestamps)

| Round | Blocks | ms |
|---|---|---|
| 4 | 11 | 6014 |
| 5 | 13 | 6789 |
| 6 | 13 | 6480 |
| 7 | 11 | 6163 |
| 8 | 12 | 6133 |

That is about **6–7 s, 11–13 blocks**, with a cached wasm. Failures come back just as fast (5.4–8.5 s). The first-ever
run of a new hash adds the fetch and a ~1.6 s compile. `near call` wall time end to end was about 9–15 s.

## Failure modes: what our callback receives

The OutLayer callback (`on_execution_response`) **returns `null`** instead of failing on every error that
happens after the request was accepted. Our `.then` callback always runs.

| Case | Our callback sees | Seen on testnet? |
|---|---|---|
| Success | `Ok(bytes)` = stdout JSON above | yes (rounds 4–8) |
| wasm URL unreachable (`wasm_url could not be fetched`) | `Ok(b"null")` | yes (round 1) |
| GitHub build refused | `Ok(b"null")` | yes (round 2) |
| wasm runtime error (e.g. missing storage import) | `Ok(b"null")` | yes (round 3) |
| Worker never resumes: NEAR yield timeout (~200 blocks) → `on_execution_response` gets `PromiseError` | `Ok(b"null")`, refund = deposit − base fee | no, from OutLayer source |
| `request_execution` panics (deposit < estimate, bad source/limits, unknown project/version, contract paused) | `Err(PromiseError::Failed)`; NEAR refunds the attached deposit | no, from OutLayer source and NEAR semantics |
| Output larger than our cap | `Err(PromiseError::TooLong(n))` via `promise_result_checked` | no |
| Our callback runs out of gas or panics | nothing: the round stays open → `refund_stuck_round` | no |

Details on the OutLayer side are in the error string of its `execution_completed` event and log
(`Execution failed: "…"`). The error string is not passed to our callback. OutLayer also has
`cancel_stale_execution(request_id)` (callable by the requesting contract after 10 min), which only matters if
a request is still pending in OutLayer state. The yield timeout normally settles it first.

**For the house:** treat `null`, `Err`, unparseable output and any failed check the same way (refund the stake,
release the reserve) and never panic in the callback. Keep `refund_stuck_round` for the last row.

## Checks the house callback must do

1. Exactly one entry in `results`.
2. `alpha` split on `:` gives exactly `["vrf", digits, signer, "round-{id}"]`. `signer` is the account that
   signed the bet tx: store `env::signer_account_id()` with the round when requesting. The exact match on the
   seed rejects `round-41` for round 4 and any other round's proof. The signer match rejects proofs requested
   by someone else.
3. `env::ed25519_verify(sig[64], alpha.as_bytes(), VRF_PUBKEY[32])`, with the testnet key
   `c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8` (`GET https://testnet-api.outlayer.ai/vrf/pubkey`).
   Keep it in state with an owner-only setter: the key can rotate (rare, per the docs).
4. `output = env::sha256_array(sig)`, and require `hex(value) == output`. Seed `core::Rng::new(output)`.
5. Pin `version_key` in the source (above).

Request ids are global and increasing, so a fresh alpha can't be replayed into a later request. The checks
above block the remaining cases, where the wasm or OutLayer hands back a valid proof for another
round or another signer.

## Snippet to reuse (near-sdk 5.x, from `spikes/vrf/src/lib.rs`)

```rust
const OUTLAYER: &str = "outlayer.testnet";
const VRF_PROJECT_ID: &str = "tilthouse.testnet/tilt-vrf";
const VRF_WASM_SHA256: &str = "898b0449aec714bc97dd9725dc6faaee19b2c1a702a87c9d457cf0d279b23d7a";
const REQUEST_DEPOSIT: NearToken = NearToken::from_millinear(10); // ≥ estimate 0.0040001
const REQUEST_GAS: Gas = Gas::from_tgas(100);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
const MAX_OUTPUT_LEN: usize = 8 * 1024;

fn request_vrf(round: u64) -> Promise {
    let args = json!({
        "source": {"Project": {"project_id": VRF_PROJECT_ID, "version_key": VRF_WASM_SHA256}},
        "resource_limits": {"max_instructions": 1_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 30},
        "input_data": json!({ "seed": format!("round-{round}") }).to_string(),
        "response_format": "Json",
    });
    Promise::new(OUTLAYER.parse().unwrap())
        .function_call("request_execution".into(), args.to_string().into_bytes(), REQUEST_DEPOSIT, REQUEST_GAS)
    // .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_vrf(round, signer))
}

// In the #[private] callback:
//   let raw = env::promise_result_checked(0, MAX_OUTPUT_LEN)  // Err → refund
//   let output: [u8; 32] = verified_output(&raw, round, &signer)?;  // Err → refund
// with verified_output / verify_entry / check_alpha / decode_hex copied from spikes/vrf/src/lib.rs.
```

Unit tests in `spikes/vrf` use the real round-4 proof as a vector: valid proof accepted; tampered signature,
tampered value, other round, other signer, `round-41`, empty request id and `null` all rejected
(`cargo test` in `spikes/vrf`, 4 passing).

## Unverified

- Yield-timeout and `request_execution`-panic rows above (read from the OutLayer contract source, not triggered).
- Coordinator wasm cache retention (FastFS testnet still 502 at the end of the spike).
- Minimum workable `REQUEST_GAS` below 100 TGas.
