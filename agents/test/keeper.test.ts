import { describe, expect, it } from "vitest";
import { GAMBLERS, MAX_BALANCE, SALARY_PER_HOUR, keeperPass, salaryFor, salaryPass, type KeeperDeps } from "../src/keeper.ts";
import { dryRunSend, type Call, type Send } from "../src/near.ts";
import { fakeHouse, LOBBY } from "./fixtures.ts";

const KEEPER = "tilthouse.testnet";

function deps(send: Send, log: (line: string) => void = () => {}, balances: Record<string, bigint> = {}, wallets: Record<string, bigint> = {}): KeeperDeps {
  return { house: fakeHouse(LOBBY, balances, wallets), send, houseId: "floor.tilthouse.testnet", token: "tusdc.tilthouse.testnet", keeper: KEEPER, accountSuffix: "tilthouse.testnet", log };
}

describe("keeperPass", () => {
  it("collects rent, then reprices autopilot tables and runs rent bids for NPC dealers, all as the keeper", async () => {
    const calls: Call[] = [];
    await keeperPass(deps(async (call) => void calls.push(call)));
    expect(calls[0]).toEqual({ signer: KEEPER, method: "collect_rent", args: {} });
    expect(calls.every((c) => c.signer === KEEPER)).toBe(true);
    expect(calls.filter((c) => c.args.dealer_id === "dex")).toEqual([]);
    expect(calls.filter((c) => c.args.dealer_id === "ace").map((c) => c.method)).toEqual(["reprice", "rent_bid"]);
  });

  it("keeps going after an error and logs one line per call", async () => {
    const lines: string[] = [];
    await keeperPass(
      deps(async ({ method, args }) => {
        if (method === "collect_rent" || args.dealer_id === "dora") throw new Error("boom");
      }, (l) => lines.push(l)),
    );
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ action: "collect_rent", error: "boom" });
    expect(parsed.filter((p) => p.dealer === "rex")).toHaveLength(2);
  });

  it("dry run prints calls without sending", async () => {
    const printed: string[] = [];
    await keeperPass(deps(dryRunSend("floor.tilthouse.testnet", (l) => printed.push(l))));
    expect(JSON.parse(printed[0] ?? "")).toEqual({ dry_run: true, signer: KEEPER, receiver: "floor.tilthouse.testnet", method: "collect_rent", args: {} });
  });
});

describe("salary", () => {
  it("pays the hourly salary up to the cap, never past it", () => {
    expect(salaryFor(0n)).toBe(SALARY_PER_HOUR);
    expect(salaryFor(MAX_BALANCE - 1n)).toBe(1n);
    expect(salaryFor(MAX_BALANCE)).toBe(0n);
    expect(salaryFor(MAX_BALANCE + 5n)).toBe(0n);
  });

  it("sends tUSDC to each gambler, which deposits it with its own key; gamblers at the cap are skipped", async () => {
    const calls: Call[] = [];
    await salaryPass(deps(async (call) => void calls.push(call), () => {}, { "g-mia.tilthouse.testnet": MAX_BALANCE }));
    expect(calls.some((c) => c.signer === "g-mia.tilthouse.testnet" || c.args.receiver_id === "g-mia.tilthouse.testnet")).toBe(false);
    const noah = calls.filter((c) => c.signer === "g-noah.tilthouse.testnet" || c.args.receiver_id === "g-noah.tilthouse.testnet");
    expect(noah.map((c) => [c.signer, c.method, c.args.amount])).toEqual([
      [KEEPER, "ft_transfer", "5000000"],
      ["g-noah.tilthouse.testnet", "ft_transfer_call", "5000000"],
    ]);
    expect(noah[1]).toMatchObject({ receiver: "tusdc.tilthouse.testnet", deposit: 1n, args: { receiver_id: "floor.tilthouse.testnet", msg: "" } });
    expect(calls.filter((c) => c.method === "ft_transfer_call")).toHaveLength(GAMBLERS.length - 1);
  });

  // Regression: g-ines' key was refused every hour, so each pass sent it another salary that it
  // could never deposit (270 tUSDC piled up in its wallet on testnet).
  it("deposits what an earlier failed deposit left in the wallet before sending more", async () => {
    const calls: Call[] = [];
    const wallets = { "g-mia.tilthouse.testnet": 7_000_000n, "g-noah.tilthouse.testnet": 2_000_000n };
    await salaryPass(deps(async (call) => void calls.push(call), () => {}, {}, wallets));
    const about = (gambler: string) =>
      calls.filter((c) => c.signer === gambler || c.args.receiver_id === gambler || c.args.account_id === gambler).map((c) => [c.method, c.args.amount]);
    expect(about("g-mia.tilthouse.testnet")).toEqual([["ft_transfer_call", "5000000"]]);
    expect(about("g-noah.tilthouse.testnet")).toEqual([
      ["storage_deposit", undefined],
      ["ft_transfer", "3000000"],
      ["ft_transfer_call", "5000000"],
    ]);
  });
});
