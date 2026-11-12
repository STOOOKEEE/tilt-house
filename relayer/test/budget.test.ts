import { describe, expect, it } from "vitest";
import { BALANCE_TTL_MS, DailyBudget } from "../src/budget.ts";
import { StateStore } from "../src/state.ts";

const LIMIT = 1_000n;
const DAY_MS = 24 * 60 * 60_000;

function setup(start = 10_000n) {
  const chain = { balance: start, reads: 0 };
  const store = new StateStore(null);
  const budget = new DailyBudget(LIMIT, store, async () => (chain.reads++, chain.balance));
  return { chain, store, budget };
}

describe("DailyBudget", () => {
  it("counts every drop of the relayer balance and refuses past the limit", async () => {
    const { chain, budget } = setup();
    expect(await budget.allows(0, 1_000n)).toBe(true);
    expect(await budget.allows(0, 1_001n)).toBe(false);
    chain.balance -= 600n;
    expect(await budget.allows(BALANCE_TTL_MS, 400n)).toBe(true);
    expect(await budget.allows(BALANCE_TTL_MS, 401n)).toBe(false);
    chain.balance -= 400n;
    expect(await budget.allows(2 * BALANCE_TTL_MS, 0n)).toBe(false);
  });

  it("ignores top-ups: they neither refund nor hide spending", async () => {
    const { chain, budget } = setup();
    await budget.allows(0, 0n);
    chain.balance -= 900n;
    await budget.allows(BALANCE_TTL_MS, 0n);
    chain.balance += 50_000n;
    await budget.allows(2 * BALANCE_TTL_MS, 0n);
    chain.balance -= 100n;
    expect(await budget.allows(3 * BALANCE_TTL_MS, 0n)).toBe(false);
  });

  it("reads the balance at most once per TTL, and coalesces concurrent reads", async () => {
    const { chain, budget } = setup();
    await Promise.all([budget.allows(0, 0n), budget.allows(0, 0n), budget.allows(0, 0n)]);
    await budget.allows(BALANCE_TTL_MS - 1, 0n);
    expect(chain.reads).toBe(1);
    await budget.allows(BALANCE_TTL_MS, 0n);
    expect(chain.reads).toBe(2);
  });

  it("starts again at 0 on the next UTC day", async () => {
    const { chain, budget } = setup();
    await budget.allows(0, 0n);
    chain.balance -= LIMIT;
    expect(await budget.allows(BALANCE_TTL_MS, 0n)).toBe(false);
    expect(await budget.allows(DAY_MS, 0n)).toBe(true);
  });

  it("persists the counter in the store", async () => {
    const { chain, store, budget } = setup();
    await budget.allows(0, 0n);
    chain.balance -= 250n;
    await budget.allows(BALANCE_TTL_MS, 0n);
    expect(store.state.budget).toEqual({ day: "1970-01-01", spentYocto: "250", lastBalanceYocto: "9750" });
  });

  it("propagates a failed balance read (the caller refuses)", async () => {
    const budget = new DailyBudget(LIMIT, new StateStore(null), () => Promise.reject(new Error("rpc down")));
    await expect(budget.allows(0, 0n)).rejects.toThrow("rpc down");
  });
});
