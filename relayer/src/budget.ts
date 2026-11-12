import type { StateStore } from "./state.ts";

/** The relayer's balance is read at most this often; spending in between is bounded by the rate limits. */
export const BALANCE_TTL_MS = 10_000;

export const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/**
 * Daily global cap on the NEAR the relayer spends: activations, storage deposits and the gas of
 * every relayed transaction. Instead of estimating each cost, it watches the relayer's own
 * balance: every drop counts as spent, every rise (a top-up, a gas refund) is ignored, so the
 * count can only overstate what was spent (fail closed). The counter is persisted, so a restart
 * does not hand out a fresh budget; it resets at 00:00 UTC.
 */
export class DailyBudget {
  private readonly limit: bigint;
  private readonly store: StateStore;
  private readonly readBalance: () => Promise<bigint>;
  private readAt = -Infinity;
  private reading: Promise<void> | null = null;

  constructor(limitYocto: bigint, store: StateStore, readBalance: () => Promise<bigint>) {
    this.limit = limitYocto;
    this.store = store;
    this.readBalance = readBalance;
  }

  /**
   * Whether `plannedYocto` more can be spent today. Throws when the balance cannot be read (the
   * caller refuses). One read at a time: answers arriving out of order would double count.
   */
  async allows(nowMs: number, plannedYocto: bigint): Promise<boolean> {
    const day = utcDay(nowMs);
    if (this.store.state.budget?.day !== day || nowMs - this.readAt >= BALANCE_TTL_MS) {
      this.reading ??= this.readBalance()
        .then((balance) => {
          this.observe(day, balance);
          this.readAt = nowMs;
        })
        .finally(() => {
          this.reading = null;
        });
      await this.reading;
    }
    const spent = BigInt(this.store.state.budget?.spentYocto ?? "0");
    return spent < this.limit && spent + plannedYocto <= this.limit;
  }

  private observe(day: string, balance: bigint): void {
    const current = this.store.state.budget;
    if (!current || current.day !== day) {
      this.store.setBudget({ day, spentYocto: "0", lastBalanceYocto: balance.toString() });
      return;
    }
    const last = BigInt(current.lastBalanceYocto);
    if (balance === last) return;
    const spent = BigInt(current.spentYocto) + (balance < last ? last - balance : 0n);
    this.store.setBudget({ day, spentYocto: spent.toString(), lastBalanceYocto: balance.toString() });
  }
}
