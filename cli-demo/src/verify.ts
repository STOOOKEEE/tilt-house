/**
 * Verifies a session against what the floor contract recorded, trusting the session server for
 * nothing: the ticket (seed hash, client seed, rake) comes from `get_session`, the rounds only have
 * to hash-chain to the `chain` the contract accepted at settle, and the seed is the one revealed on
 * chain. The replay itself is the web client's (`verifySession`), which mirrors `core_rules`.
 */
import { expectedRound, verifyHand, type LastHand } from "../../web/src/near/poker-client";
import { roundBorsh, verifySession, type CompactRound, type SessionSummary, type SessionTicket } from "../../web/src/near/session-client";
import type { ChainSession } from "./chain.ts";
import { count } from "./ui.ts";

export type ChainVerdict = { ok: true; summary: SessionSummary } | { ok: false; error: string; nonce: number | null };

/** The ticket as the contract froze it at `open_session` (`expires_at` plays no part in a replay). */
export function chainTicket(s: ChainSession): SessionTicket {
  return {
    session_id: s.id,
    player: s.player,
    dealer_id: s.dealer_id,
    game: s.game,
    lock: s.lock,
    server_seed_hash: s.server_seed_hash,
    client_seed: s.client_seed,
    rake_bp: s.rake_bp,
    max_bet: s.max_bet,
    max_win: s.max_win,
    expires_at: 0,
  };
}

const fail = (error: string): ChainVerdict => ({ ok: false, error, nonce: null });

/**
 * `rounds`: the full round list from anywhere (session server, settle txs). `serverSeed`: the seed
 * the session server reveals, cross-checked against the chain's when given. `replayPoker`: what a
 * poker round must be, from its replayed hand history (poker rounds do not replay from the session
 * seed).
 */
export function verifyAgainstChain(
  chain: ChainSession,
  rounds: readonly CompactRound[],
  serverSeed: string | null = null,
  replayPoker?: (round: CompactRound) => CompactRound,
): ChainVerdict {
  if (chain.status !== "closed") return fail(`session is ${chain.status}: its seed is not revealed on chain yet`);
  if (chain.server_seed === null) return fail("closed without a revealed seed");
  if (serverSeed !== null && serverSeed !== chain.server_seed) return fail("the session server shows another seed than the chain");
  if (rounds.length !== chain.settled_nonce) {
    return fail(`${count(rounds.length, "round")} given, the chain settled ${chain.settled_nonce}`);
  }
  // Closed from open: the escrow paid out is the signed balance at the last settled round.
  const final = { session_id: chain.id, nonce: chain.settled_nonce, balance: chain.paid_out, chain: chain.chain };
  const verdict = verifySession(chain.server_seed, chainTicket(chain), rounds, final, replayPoker);
  if (!verdict.ok) return verdict;
  if (verdict.summary.wagered.toString() !== chain.wagered) return fail("total wagered differs from the chain's");
  if (verdict.summary.paid.toString() !== chain.paid) return fail("total paid differs from the chain's");
  return verdict;
}

/**
 * Every round found in settle tx args must be, byte for byte, the round of the same nonce in
 * `rounds`. Returns the problem, or null.
 */
export function settledRoundsProblem(rounds: readonly CompactRound[], settled: readonly CompactRound[]): string | null {
  const byNonce = new Map(rounds.map((r) => [r.nonce, Buffer.from(roundBorsh(r)).toString("hex")]));
  for (const round of settled) {
    const theirs = byNonce.get(round.nonce);
    if (theirs === undefined) return `round ${round.nonce} is in a settle tx but not in the list`;
    if (theirs !== Buffer.from(roundBorsh(round)).toString("hex")) return `round ${round.nonce} differs from its settle tx`;
  }
  return null;
}

/**
 * What a session's poker round must be (core `Hand::round_for`), from the hands given (seen while
 * playing, or read from the session server's archive: untrusted either way). The hand must replay
 * from its revealed seed and the seat be the player's; the caller compares the result, byte for
 * byte, with the round the chain settled, whose outcome commits to the history hash.
 */
export function pokerReplayer(hands: ReadonlyMap<number, LastHand>, tableId: string, player: string): (round: CompactRound) => CompactRound {
  return (round) => {
    const { bet, outcome } = round;
    if (bet === "blackjack" || !("poker" in bet) || !("poker" in outcome)) throw new Error("not a poker round");
    const hand = hands.get(bet.poker.hand);
    if (!hand || bet.poker.table !== tableId) throw new Error(`hand ${bet.poker.hand} of ${bet.poker.table} is not available`);
    if (!verifyHand(hand).ok) throw new Error(`hand ${hand.number} does not replay`);
    const seat = hand.history.start.seats.find((s) => s.seat === outcome.poker.seat);
    if (seat?.player !== player) throw new Error(`seat ${outcome.poker.seat + 1} of hand ${hand.number} is not ${player}'s`);
    return expectedRound(hand, outcome.poker.seat, round.nonce);
  };
}

/**
 * The nonces of a poker session's rounds whose hand was played before the session server kept a
 * hand archive (2026-11-12), so cannot be replayed: the session closed before the table's first
 * archived hand (`archiveStartMs`; hand numbers start over at 1 with the archive), or the archive's
 * hand of that number has another commitment and ended after the session closed (a later hand that
 * reused the number). Any other missing or different hand is a real mismatch, not listed here.
 */
export function unarchivedRounds(
  rounds: readonly CompactRound[],
  hands: ReadonlyMap<number, LastHand>,
  closedMs: number,
  archiveStartMs: number,
): Set<number> {
  const unarchived = new Set<number>();
  for (const round of rounds) {
    const { bet, outcome } = round;
    if (bet === "blackjack" || !("poker" in bet) || !("poker" in outcome)) continue;
    const archived = hands.get(bet.poker.hand);
    const reused = archived !== undefined && archived.commitment !== outcome.poker.hand_seed_hash && archived.ended_at > closedMs;
    if (closedMs < archiveStartMs || reused) unarchived.add(round.nonce);
  }
  return unarchived;
}
