import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./guards.ts";

/** One paid activation, keyed by the Privy user id (DID) that asked for it. */
export interface ActivationRecord {
  accountId: string;
  /** Unix ms. */
  at: number;
}

/** The daily NEAR budget's counter (see budget.ts). Yocto amounts are decimal strings. */
export interface BudgetDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  spentYocto: string;
  lastBalanceYocto: string;
}

export interface RelayerState {
  activations: Record<string, ActivationRecord>;
  budget: BudgetDay | null;
}

const DECIMAL = /^\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseActivation(value: unknown): ActivationRecord {
  if (!isRecord(value) || typeof value.accountId !== "string" || typeof value.at !== "number" || !Number.isSafeInteger(value.at)) {
    throw new Error("relayer state: invalid activation record");
  }
  return { accountId: value.accountId, at: value.at };
}

function parseBudget(value: unknown): BudgetDay | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.day !== "string" ||
    !DAY.test(value.day) ||
    typeof value.spentYocto !== "string" ||
    !DECIMAL.test(value.spentYocto) ||
    typeof value.lastBalanceYocto !== "string" ||
    !DECIMAL.test(value.lastBalanceYocto)
  ) {
    throw new Error("relayer state: invalid budget");
  }
  return { day: value.day, spentYocto: value.spentYocto, lastBalanceYocto: value.lastBalanceYocto };
}

/**
 * The relayer's durable memory: who was activated (one per Privy user, one per account) and how
 * much NEAR left today. A small JSON file rewritten atomically (temp file + rename) on every
 * change; writes are synchronous so two requests never interleave a half-written state.
 * A corrupt file stops the relayer at startup instead of forgetting who was already paid.
 */
export class StateStore {
  readonly state: RelayerState;
  private readonly file: string | null;
  private readonly accounts = new Set<string>();

  /** `file` null: memory only (tests). */
  constructor(file: string | null) {
    this.file = file;
    this.state = file ? StateStore.read(file) : { activations: {}, budget: null };
    for (const record of Object.values(this.state.activations)) this.accounts.add(record.accountId);
  }

  private static read(file: string): RelayerState {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { activations: {}, budget: null };
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.activations)) throw new Error(`relayer state ${file}: invalid file`);
    const activations: Record<string, ActivationRecord> = {};
    for (const [user, record] of Object.entries(parsed.activations)) activations[user] = parseActivation(record);
    return { activations, budget: parseBudget(parsed.budget ?? null) };
  }

  hasUser(userId: string): boolean {
    return Object.hasOwn(this.state.activations, userId);
  }

  hasAccount(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  /** Persisted before any NEAR moves: a crash mid-activation leaves the user bound (fail closed). */
  bind(userId: string, accountId: string, at: number): void {
    this.state.activations[userId] = { accountId, at };
    this.accounts.add(accountId);
    this.save();
  }

  /** Undoes `bind` after a failed activation so the player can retry. */
  unbind(userId: string): void {
    const record = this.state.activations[userId];
    if (!record) return;
    delete this.state.activations[userId];
    this.accounts.delete(record.accountId);
    this.save();
  }

  setBudget(budget: BudgetDay): void {
    this.state.budget = budget;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
