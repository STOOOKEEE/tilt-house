import { describe, expect, it } from "vitest";
import { keeperPass } from "../src/keeper.ts";
import { dryRunSend, type Call } from "../src/near.ts";
import { fakeHouse, LOBBY } from "./fixtures.ts";

describe("keeperPass", () => {
  it("signs reprice with each dealer's own account", async () => {
    const calls: Call[] = [];
    await keeperPass({
      house: fakeHouse(LOBBY),
      send: async (call) => void calls.push(call),
      accountSuffix: "tilthouse.testnet",
      log: () => {},
    });
    expect(calls).toEqual(LOBBY.map((d) => ({ signer: `${d.id}.tilthouse.testnet`, method: "reprice", args: { dealer_id: d.id } })));
  });

  it("keeps going after a dealer error and logs one line per dealer", async () => {
    const lines: string[] = [];
    const reached: string[] = [];
    await keeperPass({
      house: fakeHouse(LOBBY),
      send: async ({ args }) => {
        const id = String(args.dealer_id);
        reached.push(id);
        if (id === "dora") throw new Error("key missing");
      },
      accountSuffix: "tilthouse.testnet",
      log: (l) => lines.push(l),
    });
    expect(reached).toEqual(LOBBY.map((d) => d.id));
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(LOBBY.length);
    expect(parsed[1]).toMatchObject({ dealer: "dora", error: "key missing" });
    expect(parsed[3]).toMatchObject({ dealer: "dex", offer: { total_edge_bp: 180, max_bet: "50000000", open: true } });
  });

  it("dry run prints reprice calls without sending", async () => {
    const printed: string[] = [];
    await keeperPass({
      house: fakeHouse(LOBBY.slice(0, 1)),
      send: dryRunSend("house.tilthouse.testnet", (l) => printed.push(l)),
      accountSuffix: "tilthouse.testnet",
      log: () => {},
    });
    expect(printed.map((l) => JSON.parse(l))).toEqual([
      { dry_run: true, signer: "ace.tilthouse.testnet", receiver: "house.tilthouse.testnet", method: "reprice", args: { dealer_id: "ace" } },
    ]);
  });
});
