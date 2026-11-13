import { describe, expect, it } from "vitest";
import {
  bytesProblem,
  edgeProblems,
  eventCounts,
  fieldMismatches,
  matchVerdict,
  parseJudgeArgs,
  parseTiltState,
  reportLine,
  scoreLine,
  sourceCommit,
  supplyProblem,
  tiltHourBurns,
} from "../src/claims.ts";
import fixture from "../src/claims.json";

const COMMIT = "faa7636fc197be1ad4d0f9f75c090c59decc43bf";

/** `get_state` as $TILT answered on 2026-11-13. */
const STATE = {
  total_supply: "1299600000000",
  treasury: "1000000000000",
  circulating: "299600000000",
  minted_total: "1300100000000",
  burned_total: "500000000",
  tilt_hour: { round: 1, burned: "0", burners: 0, window_end_ns: "0", triggers: 1, last_started_ns: "1794567731660003426" },
};

describe("parseJudgeArgs", () => {
  it("defaults to the live checks only", () => {
    expect(parseJudgeArgs([])).toEqual({ rust: false, tests: false, rpc: undefined, help: false });
  });

  it("takes --rust, --tests and --rpc, past pnpm's separator", () => {
    expect(parseJudgeArgs(["--", "--rust", "--tests", "--rpc", "https://rpc.test"])).toEqual({
      rust: true,
      tests: true,
      rpc: "https://rpc.test",
      help: false,
    });
  });

  it("refuses unknown flags", () => {
    expect(() => parseJudgeArgs(["--new"])).toThrow();
  });
});

describe("fixture comparison", () => {
  it("passes when the live params are the README's", () => {
    expect(matchVerdict(fixture.tilt_params, { ...fixture.tilt_params }, "README claim 20")).toEqual({
      status: "PASS",
      evidence: "21 fields = README claim 20",
    });
  });

  it("fails on a changed value with the key, expected and actual", () => {
    const verdict = matchVerdict(fixture.tilt_params, { ...fixture.tilt_params, mint_rate_bp: 90_000 }, "README claim 20");
    expect(verdict).toEqual({ status: "FAIL", evidence: "mint_rate_bp: expected 100000, got 90000" });
  });

  it("fails on a missing or an extra field", () => {
    const { burn_bp: _, ...missing } = fixture.tilt_params;
    expect(fieldMismatches(fixture.tilt_params, { ...missing, owner: "x.testnet" })).toEqual([
      "burn_bp: expected 100, got nothing",
      'owner: expected nothing, got "x.testnet"',
    ]);
  });

  it("tells a string amount from a number", () => {
    expect(fieldMismatches({ day_cap: "5000000000" }, { day_cap: 5_000_000_000 })).toEqual(['day_cap: expected "5000000000", got 5000000000']);
  });

  it("keeps long mismatch lists short", () => {
    const verdict = matchVerdict({ a: 1, b: 2, c: 3, d: 4, e: 5 }, {}, "x");
    expect(verdict.status).toBe("FAIL");
    expect(verdict.evidence).toMatch(/; \+2 more$/);
  });
});

describe("$TILT supply", () => {
  it("adds up on the live state", () => {
    const state = parseTiltState(STATE);
    expect(state.tilt_hour_triggers).toBe(1);
    expect(supplyProblem(state, 1_299_600_000_000n)).toBeNull();
  });

  it("catches a treasury that does not add up", () => {
    const state = parseTiltState({ ...STATE, treasury: "999999999999" });
    expect(supplyProblem(state, 1_299_600_000_000n)).toBe("treasury 999999999999 + circulating 299600000000 ≠ total_supply 1299600000000");
  });

  it("catches a burn missing from the books", () => {
    const state = parseTiltState({ ...STATE, burned_total: "0" });
    expect(supplyProblem(state, 1_299_600_000_000n)).toMatch(/^minted_total 1300100000000 − burned_total 0 ≠ total_supply/);
  });

  it("catches an NEP-141 supply other than the state's", () => {
    expect(supplyProblem(parseTiltState(STATE), 1n)).toBe("ft_total_supply 1 ≠ get_state.total_supply 1299600000000");
  });

  it("counts only Tilt Hour burns", () => {
    const log = [
      { kind: "mint", reason: "launch" },
      ...Array.from({ length: 5 }, () => ({ kind: "burn", reason: "tilt_hour" })),
      { kind: "burn", reason: "house_day" },
      { kind: "tilt_hour", reason: "started" },
    ];
    expect(tiltHourBurns(log)).toBe(5);
  });
});

describe("edgeProblems", () => {
  const table = (id: string, game: "dice" | "roulette" | "blackjack" | "poker", total_edge_bp: number, rake_bp: number) => ({ id, game, total_edge_bp, rake_bp });

  it("accepts the live lobby", () => {
    expect(
      edgeProblems([
        table("ada", "dice", 474, 474),
        table("chloe", "roulette", 494, 224),
        table("eve", "blackjack", 339, 222),
        table("faye", "poker", 0, 250),
      ]),
    ).toEqual([]);
  });

  it("refuses a casino edge outside 1–5 %", () => {
    expect(edgeProblems([table("ada", "dice", 99, 99)])).toEqual([
      "ada (dice) rake 99 bp outside 100–495",
      "ada (dice) total edge 99 bp outside 100–500",
    ]);
  });

  it("refuses a poker rake above its cap", () => {
    expect(edgeProblems([table("faye", "poker", 0, 501)])).toEqual(["faye (poker) rake 501 bp outside 0–500"]);
  });
});

describe("sourceCommit", () => {
  it("reads the commit from the NEP-330 source snapshot", () => {
    expect(sourceCommit({ build_info: { source_code_snapshot: `git+https://github.com/STOOOKEEE/tilt-house?rev=${COMMIT}` } })).toBe(COMMIT);
  });

  it("falls back to the link", () => {
    expect(sourceCommit({ link: `https://github.com/STOOOKEEE/tilt-house/tree/${COMMIT}` })).toBe(COMMIT);
  });

  it("is null without a commit", () => {
    expect(sourceCommit({ version: "0.4.0" })).toBeNull();
    expect(sourceCommit(null)).toBeNull();
  });
});

describe("simulator output", () => {
  it("counts events by kind, so a different week fails against the README", () => {
    const sim = { frames: [{ events: [{ kind: "reprice" }, { kind: "jackpot" }] }, { events: [{ kind: "reprice" }] }] };
    expect(eventCounts(sim)).toEqual({ reprice: 2, jackpot: 1 });
    expect(matchVerdict(fixture.week_42_events, eventCounts(sim), "README claim 5").status).toBe("FAIL");
  });

  it("compares files byte for byte", () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(bytesProblem(bytes, bytes)).toBeNull();
    expect(bytesProblem(new TextEncoder().encode('{"a":2}'), bytes)).toBe("differs at byte 6");
    expect(bytesProblem(bytes.subarray(0, 3), bytes)).toBe("sizes differ: 3 vs 7 bytes");
  });
});

describe("report", () => {
  it("prints one aligned line per check", () => {
    expect(reportLine({ status: "FAIL", claim: "20", title: "t", evidence: "mint_rate_bp: expected 100000, got 90000" })).toBe(
      `FAIL  20     ${"t".padEnd(50)}  mint_rate_bp: expected 100000, got 90000`,
    );
  });

  it("scores the checks that ran", () => {
    expect(scoreLine([{ status: "PASS" }, { status: "FAIL" }, { status: "PASS" }], 61.4)).toBe("2/3 passed in 61s");
    expect(scoreLine([{ status: "PASS" }, { status: "SKIP" }], 2)).toBe("1/1 passed in 2s (1 skipped)");
  });
});
