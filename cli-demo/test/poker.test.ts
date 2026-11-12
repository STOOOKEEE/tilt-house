import { describe, expect, it } from "vitest";
import { parseLastHand } from "../../web/src/near/poker-client";
import vectors from "../../web/src/near/poker-vectors.json";
import { parseCompactRound, roundBorsh } from "../../web/src/near/session-client";
import { pokerReplayer } from "../src/verify.ts";

// poker-vectors.json is produced by core_rules::poker (Rust): each hand as the table publishes it,
// with every player's session round as the server records it.
const hands = vectors.hands.map((v) => {
  const { start } = v.history;
  const hand = parseLastHand({
    number: start.hand,
    commitment: start.hand_seed_hash,
    history: v.history,
    history_hash: v.history_hash,
    result: v.result,
    deck: v.deck,
    players: v.result.seats.map((line, i) => ({
      seat: line.seat,
      player: line.player,
      name: line.player,
      npc: false,
      session_id: `s-${line.seat}`,
      hole: v.holes[i],
      stake: line.put_in,
      payout: line.won,
      nonce: null,
    })),
    ended_at: 0,
  });
  return { name: v.name, hand, rounds: v.rounds };
});

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("pokerReplayer", () => {
  it("rebuilds every player's session round from the replayed hand, byte for byte", () => {
    for (const { name, hand, rounds } of hands) {
      for (const vector of rounds) {
        const round = parseCompactRound(vector.round);
        const owner = hand.history.start.seats.find((s) => s.seat === vector.round.outcome.poker.seat)!.player;
        const replay = pokerReplayer(new Map([[hand.number, hand]]), hand.history.start.table, owner);
        expect(hex(roundBorsh(replay(round))), name).toBe(vector.borsh);
      }
    }
  });

  it("refuses a round of a hand it has not seen, of another table or of another player's seat", () => {
    const { hand, rounds } = hands[0]!;
    const round = parseCompactRound(rounds[0]!.round);
    const owner = hand.history.start.seats.find((s) => s.seat === rounds[0]!.round.outcome.poker.seat)!.player;
    const seen = new Map([[hand.number, hand]]);
    expect(() => pokerReplayer(new Map(), hand.history.start.table, owner)(round)).toThrow(/not available/);
    expect(() => pokerReplayer(seen, "another-table", owner)(round)).toThrow(/not available/);
    expect(() => pokerReplayer(seen, hand.history.start.table, "someone-else.testnet")(round)).toThrow(/is not/);
  });

  it("refuses a hand whose history does not replay", () => {
    const { hand, rounds } = hands[1]!;
    const round = parseCompactRound(rounds[0]!.round);
    const owner = hand.history.start.seats.find((s) => s.seat === rounds[0]!.round.outcome.poker.seat)!.player;
    const forged = { ...hand, history: { ...hand.history, hand_seed: "00".repeat(32) } };
    expect(() => pokerReplayer(new Map([[hand.number, forged]]), hand.history.start.table, owner)(round)).toThrow(/does not replay/);
  });
});
