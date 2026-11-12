import { describe, expect, it } from "vitest";
import { gasFor, parseBalance, parseLobby, parseNpcs } from "../src/near.ts";
import { LOBBY } from "./fixtures.ts";

describe("views", () => {
  it("accepts the lobby shape and rejects bad amounts", () => {
    expect(parseLobby(JSON.parse(JSON.stringify(LOBBY)))).toEqual(LOBBY);
    expect(() => parseLobby([{ ...LOBBY[0], max_bet: 5 }])).toThrow(/max_bet/);
    expect(() => parseLobby([{ ...LOBBY[0], npc: "yes" }])).toThrow(/npc/);
    expect(() => parseLobby({})).toThrow();
    // A poker table on the floor must not stop the keeper from reading the lobby.
    expect(parseLobby([{ ...LOBBY[0], game: "poker" }])[0]?.game).toBe("poker");
    expect(() => parseLobby([{ ...LOBBY[0], game: "craps" }])).toThrow(/game/);
  });

  it("reads a player's balance", () => {
    expect(parseBalance({ account_id: "a.testnet", balance: "12" })).toBe(12n);
    expect(() => parseBalance({ balance: "-1" })).toThrow();
  });

  it("gives collect_rent more gas, and keeps deposits affordable for small wallets", () => {
    expect(gasFor("collect_rent")).toBeGreaterThan(gasFor("reprice"));
    // A gambler with 0.15 NEAR must still be able to deposit its salary.
    expect(gasFor("ft_transfer_call")).toBeLessThanOrEqual(100_000_000_000_000n);
  });
});

describe("get_npcs", () => {
  it("accepts a list of account ids and rejects anything else", () => {
    expect(parseNpcs(["g-mia.tilthouse.near"])).toEqual(["g-mia.tilthouse.near"]);
    expect(() => parseNpcs([1])).toThrow();
    expect(() => parseNpcs({})).toThrow();
  });
});
