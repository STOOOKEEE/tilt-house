# Provably fair sessions (approved by Armand, 2026-11-05)

Goal: rounds resolve in < 1 s while money, pools, rent and jackpot stay on NEAR and every round
stays verifiable from on-chain data. Model: commit–reveal per session (the Stake model), settled on
chain in batches, with a forced-exit path so the server can never hold player money hostage.

## Flow

1. **Start.** Browser → session server `POST /sessions` `{ player, dealer_id, lock, client_seed }`.
   Server draws a fresh 32-byte `server_seed`, answers `{ session_id, server_seed_hash =
   sha256(server_seed), offer }` signed by the server key (ed25519, `SESSION_SERVER_PUBKEY` in the
   contract config).
2. **Open on chain (one relayed tx, ~1–2 s, once).** `open_session(session_id, dealer_id, lock,
   server_seed_hash, client_seed, server_sig)`: checks the server signature, moves `lock` from the
   player's balance to the session escrow, reserves the session's max liability on the dealer pool
   (`max_win = min(lock × SESSION_WIN_MULTIPLE, pool.free × SESSION_POOL_SHARE_BP)`), records the
   dealer's offer (rake, max bet) frozen for the session.
3. **Play (off chain, ~100 ms).** Browser → `POST /sessions/:id/rounds` `{ nonce, bet }`. Server
   computes the round with `core_rules` (same Rust as the contract): seed for round n =
   `HMAC-SHA256(server_seed, client_seed || ":" || n)` → `Rng`. Answers `{ nonce, bet, outcome,
   payout, balance, signature }`, where the signature covers `(session_id, nonce, balance,
   round_hash_chain)`; `round_hash_chain_n = sha256(chain_{n-1} || borsh(nonce, bet, outcome))`.
   The browser keeps the last signed state. The server refuses a bet whose worst case would push
   the session past `max_win` or `lock`. A roulette round may carry several chip stacks
   (`{"roulette_spots": [{bet, stake}, …]}`, up to 20, each ≥ the minimum bet, total ≤ max bet
   and = the round's stake): one draw settles them all, each paid and raked as if alone, and the
   round's wager (limits, jackpot odds) is the total.
4. **Settle (batch, every 60 s or 50 rounds, and at close).** Server → `settle_session(session_id,
   upto_nonce, balance, chain, rounds: Vec<CompactRound>, server_sig)`: the round list is in the tx
   args (public on chain forever); the contract applies the net to escrow/pool, updates the dealer's
   stats buckets (volume, player net, last bet time) so dealer rules and rent see the play, and
   credits rent/jackpot logic as before. It cannot check outcomes yet (seed secret) but checks the
   signed balance, the chain continuity and `max_win`.
5. **Close and reveal.** `close_session(session_id, server_seed)` (server, or player via the relayer
   after a final settle): contract checks `sha256(server_seed) == server_seed_hash`, releases the
   escrow to the player's balance and the reserve to the pool, emits `session_revealed` with the
   seed. Jackpot draws for the session's rounds use `sha256(round_seed || "tilt-house/jackpot")` and
   are paid at settle time.
6. **Forced exit.** If the server stops settling or revealing, the player calls
   `force_close(session_id, last_signed_state)` after `SESSION_TIMEOUT_SECS = 600`: the contract
   pays the signed balance (bounded by `lock + max_win`); if the server never reveals the seed for a
   settled session within `REVEAL_TIMEOUT_SECS`, the player may claim `lock + max_win` minus what
   was already paid (the server loses for hiding its seed).

## Verifiability

After close, anyone can rebuild every round from chain data only: the `server_seed_hash` (open tx),
the `client_seed` (open tx), the round lists (settle txs args), the revealed `server_seed` (close tx
event). `web/` gets a verifier that does it in the browser; `cli-demo` gets `verify-session <id>`.

## What changes vs the per-round VRF

- No OutLayer call per round. OutLayer VRF may still seed the server's seeds (later, optional).
- Per-round on-chain proofs become per-session proofs (commit–reveal), the industry standard.
- During a session the player trusts the server for *liveness* only; the forced exit bounds it.
