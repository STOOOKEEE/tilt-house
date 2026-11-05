import { describe, expect, it } from "vitest";
import { gasFor, parseBalance, parseLobby } from "../src/near.ts";
import { LOBBY } from "./fixtures.ts";

describe("views", () => {
  it("accepts the lobby shape and rejects bad amounts", () => {
    expect(parseLobby(JSON.parse(JSON.stringify(LOBBY)))).toEqual(LOBBY);
    expect(() => parseLobby([{ ...LOBBY[0], max_bet: 5 }])).toThrow(/max_bet/);
    expect(() => parseLobby([{ ...LOBBY[0], npc: "yes" }])).toThrow(/npc/);
    expect(() => parseLobby({})).toThrow();
  });

  it("reads a player's balance", () => {
    expect(parseBalance({ account_id: "a.testnet", balance: "12" })).toBe(12n);
    expect(() => parseBalance({ balance: "-1" })).toThrow();
  });

  it("gives collect_rent and deposits more gas than a reprice", () => {
    expect(gasFor("collect_rent")).toBeGreaterThan(gasFor("reprice"));
    expect(gasFor("ft_transfer_call")).toBeGreaterThan(gasFor("ft_transfer"));
  });
});
