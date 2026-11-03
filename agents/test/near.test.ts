import { describe, expect, it } from "vitest";
import { gasFor, parseLobby, parsePlayer, parseRoundStatus } from "../src/near.ts";
import { LOBBY } from "./fixtures.ts";

describe("views", () => {
  it("accepts the lobby shape and rejects bad amounts", () => {
    expect(parseLobby(JSON.parse(JSON.stringify(LOBBY)))).toEqual(LOBBY);
    expect(() => parseLobby([{ ...LOBBY[0], max_bet: 5 }])).toThrow(/max_bet/);
    expect(() => parseLobby({})).toThrow();
  });

  it("reads the player and round views", () => {
    expect(parsePlayer({ account_id: "a.testnet", balance: "12", open_round: null })).toEqual({ balance: 12n, openRound: null });
    expect(parsePlayer({ balance: "0", open_round: 3 })).toEqual({ balance: 0n, openRound: 3 });
    expect(() => parsePlayer({ balance: "-1", open_round: null })).toThrow();
    expect(parseRoundStatus({ id: 1, status: "failed" })).toBe("failed");
    expect(parseRoundStatus(null)).toBeNull();
    expect(() => parseRoundStatus({ status: "done" })).toThrow();
  });

  it("gives play calls at least 150 TGas", () => {
    expect(gasFor("bet_dice")).toBeGreaterThanOrEqual(150_000_000_000_000n);
    expect(gasFor("refund_stuck_round")).toBeGreaterThanOrEqual(150_000_000_000_000n);
  });
});
