/**
 * The judge's comparisons (`judge.ts`): pure functions from live values to a verdict, so a
 * mismatch is a FAIL whose evidence says what differs.
 */
import { parseArgs } from "node:util";
import { formatUsdc } from "../../web/src/format";
import { RAKE_BOUNDS } from "../../web/src/tycoon";
import { amount, int, list, record, str, type DealerView } from "../../web/src/near/views";

export type Status = "PASS" | "FAIL" | "SKIP";

export interface Verdict {
  status: Status;
  evidence: string;
}

export interface CheckResult extends Verdict {
  /** The README claim number(s), or `live` for the services. */
  claim: string;
  title: string;
  ms: number;
}

export const pass = (evidence: string): Verdict => ({ status: "PASS", evidence });
export const fail = (evidence: string): Verdict => ({ status: "FAIL", evidence });
export const skip = (evidence: string): Verdict => ({ status: "SKIP", evidence });

/** `core/tests/edges.rs`: every casino table's total edge, base + rake, within 1–5 %. */
export const TOTAL_EDGE_BP = [100, 500] as const;

export interface JudgeOptions {
  rust: boolean;
  tests: boolean;
  rpc: string | undefined;
  help: boolean;
}

export const JUDGE_USAGE = `pnpm judge [--rust] [--tests] [--rpc <url>]

Checks the README's claims that need no Docker against the live testnet deployment, one line per
check, then writes judge-report.json (and the full transcript to judge.log) at the repo root.
Exit 1 if any check fails.

  --rust    also run cargo test -p tilt-house-core --test edges and the simulator checks (claims 5, 14, 23)
  --tests   also run pnpm -r test
  --rpc     NEAR RPC endpoint (default https://test.rpc.fastnear.com, falls back to dRPC when rate-limited)`;

export function parseJudgeArgs(argv: readonly string[]): JudgeOptions {
  // `pnpm judge -- --rust` forwards the separator on some pnpm versions.
  const args = argv.filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      rust: { type: "boolean", default: false },
      tests: { type: "boolean", default: false },
      rpc: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return { rust: values.rust, tests: values.tests, rpc: values.rpc, help: values.help };
}

/** Every key of either side whose value differs, as `key: expected X, got Y`. */
export function fieldMismatches(expected: Record<string, unknown>, actual: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  return keys.flatMap((key) => {
    const want = JSON.stringify(expected[key]);
    const got = JSON.stringify(actual[key]);
    return want === got ? [] : [`${key}: expected ${want ?? "nothing"}, got ${got ?? "nothing"}`];
  });
}

/** A fixture comparison as a verdict: the first mismatches are the evidence. */
export function matchVerdict(expected: Record<string, unknown>, actual: Record<string, unknown>, what: string): Verdict {
  const mismatches = fieldMismatches(expected, actual);
  if (mismatches.length === 0) return pass(`${Object.keys(expected).length} fields = ${what}`);
  const shown = mismatches.slice(0, 3).join("; ");
  return fail(mismatches.length > 3 ? `${shown}; +${mismatches.length - 3} more` : shown);
}

// ---- $TILT --------------------------------------------------------------------------------

export interface TiltSupply {
  total_supply: bigint;
  treasury: bigint;
  circulating: bigint;
  minted_total: bigint;
  burned_total: bigint;
  tilt_hour_triggers: number;
}

export function parseTiltState(value: unknown): TiltSupply {
  const s = record(value, "get_state");
  const big = (key: string) => BigInt(amount(s[key], `get_state.${key}`));
  return {
    total_supply: big("total_supply"),
    treasury: big("treasury"),
    circulating: big("circulating"),
    minted_total: big("minted_total"),
    burned_total: big("burned_total"),
    tilt_hour_triggers: int(record(s.tilt_hour, "get_state.tilt_hour").triggers, "get_state.tilt_hour.triggers"),
  };
}

/** Whole TILT (6 decimals), for evidence lines. */
const tilt = (units: bigint): string => formatUsdc(units, 0);

/** Null when the supply adds up: supply = treasury + circulating = minted − burned = `ft_total_supply`. */
export function supplyProblem(s: TiltSupply, ftTotalSupply: bigint): string | null {
  if (s.treasury + s.circulating !== s.total_supply) {
    return `treasury ${s.treasury} + circulating ${s.circulating} ≠ total_supply ${s.total_supply}`;
  }
  if (s.minted_total - s.burned_total !== s.total_supply) {
    return `minted_total ${s.minted_total} − burned_total ${s.burned_total} ≠ total_supply ${s.total_supply}`;
  }
  if (ftTotalSupply !== s.total_supply) return `ft_total_supply ${ftTotalSupply} ≠ get_state.total_supply ${s.total_supply}`;
  return null;
}

export function supplyEvidence(s: TiltSupply): string {
  return `supply ${tilt(s.total_supply)} = treasury ${tilt(s.treasury)} + circulating ${tilt(s.circulating)} = minted ${tilt(s.minted_total)} − burned ${tilt(s.burned_total)} TILT`;
}

/** `get_log` entries that are Tilt Hour burns. */
export function tiltHourBurns(log: readonly unknown[]): number {
  return log.filter((entry, i) => {
    const e = record(entry, `get_log[${i}]`);
    return str(e.kind, `get_log[${i}].kind`) === "burn" && e.reason === "tilt_hour";
  }).length;
}

/**
 * The last UTC day the floor reported to $TILT (`get_state.last_reported_day`): its book on the
 * floor is closed and reported, and the token logged that day's mint to the players or its
 * treasury burn (`docs/tilt.md`, the daily report).
 */
export function dayCloseVerdict(day: number | null, book: unknown, log: readonly unknown[]): Verdict {
  if (day === null) return fail("no day reported to $TILT yet (last_reported_day null)");
  const b = record(book, "get_day");
  if (b.closed !== true) return fail(`day ${day}: the floor's book is still open`);
  if (b.report !== "reported") return fail(`day ${day}: report ${String(b.report)}`);
  const daily = log
    .map((entry, i) => record(entry, `get_log[${i}]`))
    .filter((e) => e.day === day && e.reason === "daily" && (e.kind === "mint" || e.kind === "burn"));
  if (daily.length === 0) return fail(`day ${day}: no daily mint or burn in get_log`);
  const total = (kind: string) =>
    daily.filter((e) => e.kind === kind).reduce((sum, e, i) => sum + BigInt(amount(e.amount, `daily[${i}].amount`)), 0n);
  const mints = daily.filter((e) => e.kind === "mint").length;
  const outcome = mints > 0 ? `mint ${tilt(total("mint"))} TILT to ${mints} player${mints === 1 ? "" : "s"}` : `burn ${tilt(total("burn"))} TILT`;
  const net = BigInt(amount(String(b.players_net).replace(/^-/, ""), "get_day.players_net"));
  const sign = String(b.players_net).startsWith("-") ? "−" : "+";
  return pass(`day ${day} closed and reported · players ${sign}${formatUsdc(net)} tUSDC vs the house · ${outcome}`);
}

// ---- tables -------------------------------------------------------------------------------

type Table = Pick<DealerView, "id" | "game" | "total_edge_bp" | "rake_bp">;

/**
 * Each table outside its bounds: casino games keep a total edge within 1–5 % and a rake within
 * `core::rake_bounds`; poker's rake (of the pot, not an edge) stays within its own bounds.
 */
export function edgeProblems(tables: readonly Table[]): string[] {
  const [minEdge, maxEdge] = TOTAL_EDGE_BP;
  return tables.flatMap((t) => {
    const [minRake, maxRake] = RAKE_BOUNDS[t.game];
    const problems: string[] = [];
    if (t.rake_bp < minRake || t.rake_bp > maxRake) problems.push(`${t.id} (${t.game}) rake ${t.rake_bp} bp outside ${minRake}–${maxRake}`);
    if (t.game !== "poker" && (t.total_edge_bp < minEdge || t.total_edge_bp > maxEdge)) {
      problems.push(`${t.id} (${t.game}) total edge ${t.total_edge_bp} bp outside ${minEdge}–${maxEdge}`);
    }
    return problems;
  });
}

export function edgeEvidence(tables: readonly Table[]): string {
  return tables.map((t) => `${t.id} ${t.game === "poker" ? `rake ${t.rake_bp}` : t.total_edge_bp} bp`).join(", ");
}

// ---- deployment ---------------------------------------------------------------------------

const REV = /[?&]rev=([0-9a-f]{40})\b/;
const TREE = /\/tree\/([0-9a-f]{40})\b/;

/** The commit a NEP-330 `contract_source_metadata` names (its source snapshot, else its link). */
export function sourceCommit(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const build = typeof m.build_info === "object" && m.build_info !== null ? (m.build_info as Record<string, unknown>) : {};
  const snapshot = typeof build.source_code_snapshot === "string" ? build.source_code_snapshot : "";
  const link = typeof m.link === "string" ? m.link : "";
  return REV.exec(snapshot)?.[1] ?? TREE.exec(link)?.[1] ?? null;
}

// ---- simulator ----------------------------------------------------------------------------

/** How many events of each kind a simulator run produced (README claim 5). */
export function eventCounts(sim: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [i, frame] of list(record(sim, "sim").frames, "sim.frames").entries()) {
    for (const [j, event] of list(record(frame, `frames[${i}]`).events, `frames[${i}].events`).entries()) {
      const kind = str(record(event, `frames[${i}].events[${j}]`).kind, `frames[${i}].events[${j}].kind`);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  return counts;
}

/** `cmp`: null when the bytes are the same, else where they first differ. */
export function bytesProblem(actual: Uint8Array, expected: Uint8Array): string | null {
  const length = Math.min(actual.length, expected.length);
  for (let i = 0; i < length; i++) {
    if (actual[i] !== expected[i]) return `differs at byte ${i + 1}`;
  }
  return actual.length === expected.length ? null : `sizes differ: ${actual.length} vs ${expected.length} bytes`;
}

// ---- report -------------------------------------------------------------------------------

const CLAIM_WIDTH = 5;
const TITLE_WIDTH = 50;

/** `PASS  20     $TILT parameters …  evidence`, plain text. */
export function reportLine(r: Pick<CheckResult, "status" | "claim" | "title" | "evidence">): string {
  return `${r.status}  ${r.claim.padEnd(CLAIM_WIDTH)}  ${r.title.padEnd(TITLE_WIDTH)}  ${r.evidence}`;
}

export function scoreLine(results: readonly Pick<CheckResult, "status">[], seconds: number): string {
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const ran = results.length - skipped;
  return `${passed}/${ran} passed in ${Math.round(seconds)}s${skipped > 0 ? ` (${skipped} skipped)` : ""}`;
}
