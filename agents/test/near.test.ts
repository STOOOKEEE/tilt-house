import { describe, expect, it } from "vitest";
import { gasFor, parseBalance, parseDay, parseLobby, parseNpcs } from "../src/near.ts";
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

describe("get_day", () => {
  const record = { day: 20_404, closed: true, report: "ok", players_net: "-1500000", wagered: "9000000", players: [{ account_id: "a.testnet", wagered: "9000000", net: "-1500000" }] };

  it("reads a day record, or null when the floor keeps none", () => {
    expect(parseDay(record)).toEqual({ ...record, players: 1 });
    expect(parseDay({ ...record, closed: false, report: null, players: [] })).toMatchObject({ closed: false, report: null, players: 0 });
    expect(parseDay(null)).toBeNull();
  });

  it("rejects anything else", () => {
    expect(() => parseDay({ ...record, players_net: "1.5" })).toThrow(/players_net/);
    expect(() => parseDay({ ...record, report: "maybe" })).toThrow(/report/);
    expect(() => parseDay({ ...record, closed: "yes" })).toThrow(/closed/);
    expect(() => parseDay("x")).toThrow();
  });

  it("gives close_day room for the report to the TILT token", () => {
    expect(gasFor("close_day")).toBeGreaterThanOrEqual(200_000_000_000_000n);
  });
});

describe("get_npcs", () => {
  it("accepts a list of account ids and rejects anything else", () => {
    expect(parseNpcs(["g-mia.tilthouse.near"])).toEqual(["g-mia.tilthouse.near"]);
    expect(() => parseNpcs([1])).toThrow();
    expect(() => parseNpcs({})).toThrow();
  });
});
