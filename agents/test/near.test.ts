import { describe, expect, it } from "vitest";
import { parseBalance, parseLobby } from "../src/near.ts";
import { LOBBY } from "./fixtures.ts";

describe("views", () => {
  it("accepts the lobby shape and rejects bad amounts", () => {
    expect(parseLobby(JSON.parse(JSON.stringify(LOBBY)))).toEqual(LOBBY);
    expect(() => parseLobby([{ ...LOBBY[0], max_bet: 5 }])).toThrow(/max_bet/);
    expect(() => parseLobby({})).toThrow();
  });

  it("reads the player balance", () => {
    expect(parseBalance({ balance: "12" })).toBe(12n);
    expect(parseBalance(null)).toBe(0n);
    expect(() => parseBalance({ balance: "-1" })).toThrow();
  });
});
