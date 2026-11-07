import { describe, expect, it } from "vitest";
import { parseCompactRound, parseTicket, roundWager, type CompactRound } from "../../web/src/near/session-client";
import vectors from "../../web/src/near/session-vectors.json";
import type { ChainSession } from "../src/chain.ts";
import { settledRoundsProblem, verifyAgainstChain } from "../src/verify.ts";

// session-vectors.json is produced by core_rules::session (Rust): what the contract and the
// session server compute. Each vector becomes the `get_session` the floor would hold once closed.
const sessions = vectors.sessions.map((s) => {
  const ticket = parseTicket(s.ticket);
  const rounds = s.rounds.map((r) => parseCompactRound(r));
  const last = s.states.at(-1)!.state;
  const chain: ChainSession = {
    id: ticket.session_id,
    player: ticket.player,
    dealer_id: ticket.dealer_id,
    game: ticket.game,
    status: "closed",
    lock: ticket.lock,
    rake_bp: ticket.rake_bp,
    max_bet: ticket.max_bet,
    max_win: ticket.max_win,
    server_seed_hash: ticket.server_seed_hash,
    client_seed: ticket.client_seed,
    server_seed: vectors.server_seed,
    opened_at: 1_762_190_000,
    closed_at: 1_762_190_060,
    settled_nonce: last.nonce,
    balance: "0",
    chain: last.chain,
    wagered: rounds.reduce((sum, r) => sum + roundWager(r), 0n).toString(),
    paid: rounds.reduce((sum, r) => sum + BigInt(r.payout), 0n).toString(),
    jackpot_won: "0",
    paid_out: last.balance,
  };
  return { chain, rounds };
});

const tampered = (rounds: readonly CompactRound[], nonce: number, change: Partial<CompactRound>) =>
  rounds.map((r) => (r.nonce === nonce ? { ...r, ...change } : r));

describe("verifyAgainstChain", () => {
  it.each(sessions.map((s) => [s.chain.game, s.rounds.length, s] as const))("%s, %i rounds: verifies", (_, __, s) => {
    const verdict = verifyAgainstChain(s.chain, s.rounds, vectors.server_seed);
    expect(verdict).toMatchObject({ ok: true, summary: { rounds: s.rounds.length, chain: s.chain.chain } });
  });

  const [dice] = sessions;
  if (!dice) throw new Error("no dice vector");

  it("refuses a session whose seed is not revealed on chain", () => {
    expect(verifyAgainstChain({ ...dice.chain, status: "open", server_seed: null }, dice.rounds)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/open/),
    });
    expect(verifyAgainstChain({ ...dice.chain, server_seed: null }, dice.rounds)).toMatchObject({ ok: false });
  });

  it("refuses a seed that does not match the on-chain commitment", () => {
    const other = "08".repeat(32);
    expect(verifyAgainstChain({ ...dice.chain, server_seed: other }, dice.rounds)).toMatchObject({
      ok: false,
      error: "server seed does not match its hash",
    });
  });

  it("refuses a server that shows another seed than the chain", () => {
    expect(verifyAgainstChain(dice.chain, dice.rounds, "08".repeat(32))).toMatchObject({ ok: false, error: expect.stringMatching(/another seed/) });
  });

  it("refuses a rewritten outcome, payout or bet, naming the round", () => {
    const roll = tampered(dice.rounds, 2, { outcome: { dice: { roll: 1 } } });
    expect(verifyAgainstChain(dice.chain, roll)).toMatchObject({ ok: false, nonce: 2 });
    const payout = tampered(dice.rounds, 1, { payout: (BigInt(dice.rounds[0]!.payout) + 1n).toString() });
    expect(verifyAgainstChain(dice.chain, payout)).toMatchObject({ ok: false, nonce: 1 });
    const bet = tampered(dice.rounds, 3, { bet: { dice: { chance_bp: 100, over: false } } });
    expect(verifyAgainstChain(dice.chain, bet)).toMatchObject({ ok: false, nonce: 3 });
  });

  it("refuses a round list that does not end on the chain's hash, count or totals", () => {
    expect(verifyAgainstChain(dice.chain, dice.rounds.slice(0, -1))).toMatchObject({ ok: false, error: expect.stringMatching(/settled 3/) });
    expect(verifyAgainstChain({ ...dice.chain, chain: "00".repeat(32) }, dice.rounds)).toMatchObject({ ok: false, error: "hash chain broken" });
    expect(verifyAgainstChain({ ...dice.chain, paid_out: "1" }, dice.rounds)).toMatchObject({ ok: false, error: "final balance wrong" });
    expect(verifyAgainstChain({ ...dice.chain, wagered: "1" }, dice.rounds)).toMatchObject({ ok: false, error: expect.stringMatching(/wagered/) });
    expect(verifyAgainstChain({ ...dice.chain, paid: "1" }, dice.rounds)).toMatchObject({ ok: false, error: expect.stringMatching(/paid/) });
  });

  it("replays with the chain's client seed and rake, not the rounds' claims", () => {
    expect(verifyAgainstChain({ ...dice.chain, client_seed: "someone-else" }, dice.rounds)).toMatchObject({ ok: false });
    expect(verifyAgainstChain({ ...dice.chain, rake_bp: dice.chain.rake_bp + 50 }, dice.rounds)).toMatchObject({ ok: false });
  });
});

describe("settledRoundsProblem", () => {
  const [dice] = sessions;
  if (!dice) throw new Error("no dice vector");

  it("accepts settle txs that carry the same rounds, all or some", () => {
    expect(settledRoundsProblem(dice.rounds, dice.rounds)).toBeNull();
    expect(settledRoundsProblem(dice.rounds, dice.rounds.slice(1))).toBeNull();
  });

  it("names a round that differs from its settle tx or is missing from the list", () => {
    const changed = tampered(dice.rounds, 2, { payout: "1" });
    expect(settledRoundsProblem(dice.rounds, changed)).toMatch(/round 2 differs/);
    expect(settledRoundsProblem(dice.rounds.slice(0, 1), dice.rounds)).toMatch(/round 2 is in a settle tx/);
  });
});
