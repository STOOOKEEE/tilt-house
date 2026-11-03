import { describe, expect, it } from "vitest";
import { botTurn, chooseTable, parseRoundId, stakeFor, type BotDeps } from "../src/bots.ts";
import { dryRunSend, type Call } from "../src/near.ts";
import { dealer, fakeHouse, LOBBY } from "./fixtures.ts";

function deps(over: Partial<BotDeps> = {}): BotDeps & { lines: string[] } {
  const lines: string[] = [];
  let clock = 0;
  return {
    house: fakeHouse(LOBBY),
    send: dryRunSend("house.tilthouse.testnet", (l) => lines.push(l)),
    accountSuffix: "tilthouse.testnet",
    loyalDealer: undefined,
    log: (l) => lines.push(l),
    rand: () => 0,
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    lines,
    ...over,
  };
}

describe("chooseTable", () => {
  it("price hunter picks the lowest-edge open dice table", () => {
    expect(chooseTable("hunter", LOBBY)?.id).toBe("dex");
  });

  it("loyal sticks to its dealer, and sits out while it is closed", () => {
    expect(chooseTable("loyal", LOBBY, "rita")?.id).toBe("rita");
    expect(chooseTable("loyal", LOBBY)?.id).toBe("dex");
    expect(chooseTable("loyal", LOBBY, "dina")).toBeNull();
  });

  it("whale picks the open roulette table with the largest max bet", () => {
    expect(chooseTable("whale", LOBBY)?.id).toBe("rex");
    expect(chooseTable("whale", LOBBY.filter((d) => d.game !== "roulette"))).toBeNull();
  });
});

describe("stakeFor", () => {
  const table = dealer({ id: "rex", game: "roulette", min_bet: "1000000", max_bet: "90000000" });

  it("stops betting below the table min", () => {
    expect(stakeFor("hunter", table, 999_999n, () => 0)).toBeNull();
    expect(stakeFor("whale", table, 999_999n, () => 0)).toBeNull();
  });

  it("whale bets rarely, large, capped by the table max", () => {
    expect(stakeFor("whale", table, 1_000_000_000n, () => 0.9)).toBeNull();
    expect(stakeFor("whale", table, 1_000_000_000n, () => 0)).toBe(90_000_000n);
    expect(stakeFor("whale", table, 40_000_000n, () => 0)).toBe(20_000_000n);
  });

  it("regulars bet the table min", () => {
    expect(stakeFor("loyal", table, 5_000_000n, () => 0)).toBe(1_000_000n);
  });
});

describe("rounds", () => {
  function recording(house = fakeHouse(LOBBY)) {
    const calls: Call[] = [];
    const d = deps({
      house,
      send: async (call) => {
        calls.push(call);
        return call.method.startsWith("bet_") ? 42 : null;
      },
    });
    return { calls, d };
  }

  it("reads the round id a bet returns", () => {
    expect(parseRoundId(7)).toBe(7);
    expect(() => parseRoundId(undefined)).toThrow();
  });

  it("polls get_round until settled", async () => {
    const { calls, d } = recording(fakeHouse(LOBBY, 10_000_000n, ["waiting_vrf", "waiting_vrf", "settled"]));
    await botTurn(d, { name: "hunter", strategy: "hunter" });
    expect(calls.map((c) => c.method)).toEqual(["bet_dice"]);
    expect(JSON.parse(d.lines.at(-1) ?? "")).toMatchObject({ bot: "hunter", round: 42, status: "settled" });
  });

  it("refunds a failed round at once", async () => {
    const { calls, d } = recording(fakeHouse(LOBBY, 10_000_000n, ["waiting_vrf", "failed"]));
    await botTurn(d, { name: "hunter", strategy: "hunter" });
    expect(calls).toEqual([
      expect.objectContaining({ method: "bet_dice" }),
      { signer: "bot-hunter.tilthouse.testnet", method: "refund_stuck_round", args: { round_id: 42 } },
    ]);
  });

  it("refunds a round still waiting for VRF after 120 s", async () => {
    const { calls, d } = recording({ ...fakeHouse(LOBBY), roundStatus: async () => "waiting_vrf" });
    await botTurn(d, { name: "hunter", strategy: "hunter" });
    expect(calls.map((c) => c.method)).toEqual(["bet_dice", "refund_stuck_round"]);
    expect(d.now()).toBeGreaterThanOrEqual(120_000);
  });

  it("finishes a leftover open round before betting again", async () => {
    const { calls, d } = recording(fakeHouse(LOBBY, 10_000_000n, ["failed"], 5));
    await botTurn(d, { name: "loyal", strategy: "loyal" });
    expect(calls).toEqual([{ signer: "bot-loyal.tilthouse.testnet", method: "refund_stuck_round", args: { round_id: 5 } }]);
  });
});

describe("dry run", () => {
  it("prints the bet call as one JSON line and sends nothing", async () => {
    const d = deps();
    await botTurn(d, { name: "hunter", strategy: "hunter" });
    expect(JSON.parse(d.lines[0] ?? "")).toEqual({
      dry_run: true,
      signer: "bot-hunter.tilthouse.testnet",
      receiver: "house.tilthouse.testnet",
      method: "bet_dice",
      args: { dealer_id: "dex", stake: "1000000", chance_bp: 4950, over: true },
    });
  });

  it("prints a roulette bet for the whale", async () => {
    const d = deps();
    await botTurn(d, { name: "whale", strategy: "whale" });
    expect(JSON.parse(d.lines[0] ?? "")).toMatchObject({
      signer: "bot-whale.tilthouse.testnet",
      method: "bet_roulette",
      args: { dealer_id: "rex", stake: "5000000", bet: "red" },
    });
  });
});
