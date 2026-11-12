import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GAMBLERS,
  MAX_BALANCE,
  SALARY_PER_HOUR,
  alertFor,
  balancePass,
  keeperPass,
  salaryFor,
  salaryPass,
  watchList,
  type KeeperDeps,
} from "../src/keeper.ts";
import { dryRunSend, type Call, type Send } from "../src/near.ts";
import { fakeHouse, LOBBY, type FakeChainState } from "./fixtures.ts";

const KEEPER = "tilthouse.testnet";

function deps(
  send: Send,
  log: (line: string) => void = () => {},
  balances: Record<string, bigint> = {},
  wallets: Record<string, bigint> = {},
  over: Partial<KeeperDeps> & { chain?: FakeChainState } = {},
): KeeperDeps {
  const { chain, ...rest } = over;
  return {
    house: fakeHouse(LOBBY, { balances, wallets, ...chain }),
    send,
    houseId: "floor.tilthouse.testnet",
    token: "tusdc.tilthouse.testnet",
    keeper: KEEPER,
    accountSuffix: "tilthouse.testnet",
    salaryMode: "deposit",
    log,
    ...rest,
  };
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

  it("reprices only tables on the floor (off the floor an NPC only bids for a seat)", async () => {
    const calls: Call[] = [];
    await keeperPass(deps(async (call) => void calls.push(call)));
    expect(calls.filter((c) => c.args.dealer_id === "otto").map((c) => c.method)).toEqual(["rent_bid"]);
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

describe("salary in credit_npc mode (contract v3)", () => {
  const NPCS = ["g-mia.tilthouse.testnet", "g-noah.tilthouse.testnet", "g-zoe.tilthouse.testnet"];
  const credit = (balances: Record<string, bigint> = {}) => {
    const calls: Call[] = [];
    const d = deps(async (call) => void calls.push(call), () => {}, balances, {}, { salaryMode: "credit_npc", chain: { npcs: NPCS } });
    return { calls, d };
  };

  it("credits each registered NPC from the keeper with one ft_transfer_call, NPC keys never sign", async () => {
    const { calls, d } = credit();
    await salaryPass(d);
    expect(calls).toHaveLength(NPCS.length);
    for (const [i, npc] of NPCS.entries()) {
      expect(calls[i]).toEqual({
        signer: KEEPER,
        receiver: "tusdc.tilthouse.testnet",
        method: "ft_transfer_call",
        args: { receiver_id: "floor.tilthouse.testnet", amount: "5000000", msg: JSON.stringify({ credit_npc: npc }) },
        deposit: 1n,
      });
    }
  });

  it("pays only the floor's registered NPCs, not the hard-coded lineup", async () => {
    const { calls, d } = credit();
    await salaryPass(d);
    expect(calls.some((c) => String(c.args.msg).includes("g-tom."))).toBe(false);
  });

  it("respects the 200 tUSDC cap", async () => {
    const { calls, d } = credit({ "g-mia.tilthouse.testnet": MAX_BALANCE, "g-noah.tilthouse.testnet": MAX_BALANCE - 2n });
    await salaryPass(d);
    expect(calls.map((c) => [JSON.parse(String(c.args.msg)).credit_npc, c.args.amount])).toEqual([
      ["g-noah.tilthouse.testnet", "2"],
      ["g-zoe.tilthouse.testnet", "5000000"],
    ]);
  });
});

describe("low NEAR alerts", () => {
  const THRESHOLDS = { keeper: 2n, sessions: 1n, relayer: 1n, npc: 5n };
  const NPCS = ["g-mia.tilthouse.testnet", "g-noah.tilthouse.testnet"];

  it("watches the keeper, the session signer, the relayer and every NPC", async () => {
    const d = deps(async () => undefined, () => {}, {}, {}, { salaryMode: "credit_npc", chain: { npcs: NPCS } });
    const watches = await watchList(d, THRESHOLDS, "sessions.tilthouse.testnet", "relayer.tilthouse.testnet");
    expect(watches).toEqual([
      { role: "keeper", account: KEEPER, min: 2n },
      { role: "sessions", account: "sessions.tilthouse.testnet", min: 1n },
      { role: "relayer", account: "relayer.tilthouse.testnet", min: 1n },
      { role: "npc", account: NPCS[0], min: 5n },
      { role: "npc", account: NPCS[1], min: 5n },
    ]);
  });

  it("alerts for accounts below their threshold or missing, and only for those", async () => {
    const near = { [KEEPER]: 2n, "sessions.tilthouse.testnet": 0n, [NPCS[0] ?? ""]: 4n };
    const d = deps(async () => undefined, () => {}, {}, {}, { salaryMode: "credit_npc", chain: { npcs: NPCS, near } });
    const alerts: Record<string, unknown>[] = [];
    await balancePass(d, await watchList(d, THRESHOLDS, "sessions.tilthouse.testnet", "relayer.tilthouse.testnet"), async (f) => void alerts.push(f));
    expect(alerts).toEqual([
      { alert: "low_near", role: "sessions", account: "sessions.tilthouse.testnet", balance: "0", min: "1" },
      { alert: "low_near", role: "relayer", account: "relayer.tilthouse.testnet", balance: "missing", min: "1" },
      { alert: "low_near", role: "npc", account: NPCS[0], balance: "4", min: "5" },
      { alert: "low_near", role: "npc", account: NPCS[1], balance: "missing", min: "5" },
    ]);
  });

  it("alerts when a balance cannot be read, and keeps checking the others", async () => {
    const d = deps(async () => undefined);
    d.house.nearBalance = async (account) => {
      if (account === KEEPER) throw new Error("rpc down");
      return 10n;
    };
    const alerts: Record<string, unknown>[] = [];
    await balancePass(d, [{ role: "keeper", account: KEEPER, min: 1n }, { role: "relayer", account: "r.testnet", min: 100n }], async (f) => void alerts.push(f));
    expect(alerts).toEqual([
      { alert: "balance_unreadable", role: "keeper", account: KEEPER, error: "rpc down" },
      { alert: "low_near", role: "relayer", account: "r.testnet", balance: "10", min: "100" },
    ]);
  });

  describe("alertFor", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("logs at error level, without a webhook", async () => {
      const errors: string[] = [];
      await alertFor(null, (l) => errors.push(l))({ alert: "low_near" });
      expect(JSON.parse(errors[0] ?? "")).toMatchObject({ level: "error", alert: "low_near" });
    });

    it("also POSTs to the webhook, and only logs a webhook failure", async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      const errors: string[] = [];
      await alertFor("https://hooks.example/x", (l) => errors.push(l))({ alert: "low_near", account: "a.testnet" });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://hooks.example/x");
      expect(String(init.body)).toContain("a.testnet");
      expect(errors).toHaveLength(2);
      expect(JSON.parse(errors[1] ?? "")).toEqual({ level: "error", webhook: 500 });
    });
  });
});
