/**
 * `pnpm judge`: the README's claims that need no Docker, checked live on testnet in a few minutes.
 * One line per check, a score, `judge-report.json` and the full transcript in `judge.log`.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, stripVTControlCharacters } from "node:util";
import { getLiveFloor } from "../../web/src/sim/gamblers";
import { amount, int, list, parseLobby, record, str } from "../../web/src/near/views";
import { parseCommand, SITE, type Funder, type Targets } from "./args.ts";
import { getChainSession, view } from "./chain.ts";
import fixture from "./claims.json";
import {
  bytesProblem,
  edgeEvidence,
  edgeProblems,
  eventCounts,
  fail,
  JUDGE_USAGE,
  matchVerdict,
  parseJudgeArgs,
  parseTiltState,
  pass,
  reportLine,
  scoreLine,
  skip,
  sourceCommit,
  supplyEvidence,
  supplyProblem,
  tiltHourBurns,
  type CheckResult,
  type JudgeOptions,
  type Status,
  type Verdict,
} from "./claims.ts";
import { runDemo } from "./demo.ts";
import { rpcFor, withRetry } from "./rpc.ts";
import { color, errorMessage } from "./ui.ts";
import { latestClosedSession, verifySessionById } from "./verify-session.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEPLOYMENT = join(ROOT, "deployments", "testnet.json");
const REPORT = join(ROOT, "judge-report.json");
const TRANSCRIPT = join(ROOT, "judge.log");
const SIM_JSON = join(ROOT, "web", "public", "tilt-sim.json");
const HTTP_TIMEOUT_MS = 20_000;
const NPC_COUNT = 24;
const MIN_TILT_HOUR_BURNS = 5;
const LOG_PAGE = 100;
/** NPC gamblers tried for a closed session with rounds before giving up. */
const NPC_TRIES = 6;

interface Check {
  claim: string;
  title: string;
  run: () => Promise<Verdict>;
}

interface Contract {
  name: string;
  accountId: string;
  codeHash: string;
  commit: string | null;
}

interface Deployment {
  contracts: Contract[];
  npcGamblers: string[];
}

async function readDeployment(): Promise<Deployment> {
  const d = record(JSON.parse(await readFile(DEPLOYMENT, "utf8")) as unknown, "deployments/testnet.json");
  const contracts = Object.entries(record(d.contracts, "contracts")).map(([name, value]) => {
    const c = record(value, `contracts.${name}`);
    return {
      name,
      accountId: str(c.account_id, `${name}.account_id`),
      codeHash: str(c.code_hash, `${name}.code_hash`),
      commit: c.reproducible === true ? str(c.commit, `${name}.commit`) : null,
    };
  });
  const accounts = record(d.accounts, "accounts");
  const npcGamblers = list(accounts.npc_gamblers, "accounts.npc_gamblers").map((v, i) => str(v, `npc_gamblers[${i}]`));
  return { contracts, npcGamblers };
}

function contractId(deployment: Deployment, name: string): string {
  const contract = deployment.contracts.find((c) => c.name === name);
  if (contract === undefined) throw new Error(`deployments/testnet.json has no contract "${name}"`);
  return contract.accountId;
}

// ---- I/O -------------------------------------------------------------------------------------

const transcript: string[] = [];

/** Runs `task` with its console output kept for judge.log instead of the screen. */
async function quietly<T>(title: string, task: () => Promise<T>): Promise<T> {
  const log = console.log;
  transcript.push(`\n===== ${title}`);
  console.log = (...args: unknown[]) => transcript.push(stripVTControlCharacters(format(...args)));
  try {
    return await task();
  } finally {
    console.log = log;
  }
}

async function getJson(url: string): Promise<unknown> {
  return withRetry(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (response.status === 429 || response.status >= 500) throw new Error(`${url}: HTTP ${response.status}`);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return (await response.json()) as unknown;
  });
}

/** `view_account` through the run's RPC (retries, then the fallback endpoint). */
async function codeHash(t: Targets, accountId: string): Promise<string> {
  const result = await rpcFor(t.rpcUrl).call(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tilt-house",
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: accountId },
      }),
    });
    if (!response.ok) throw new Error(`RPC view_account: HTTP ${response.status}`);
    const body = record(await response.json(), "rpc");
    if (body.error !== undefined) throw new Error(`RPC view_account: ${JSON.stringify(body.error)}`);
    return record(body.result, "rpc.result");
  });
  return str(result.code_hash, "view_account.code_hash");
}

/** Runs a command from the repo root, its output to judge.log; null when it is not installed. */
function command(cmd: string, args: readonly string[]): Promise<{ code: number; output: string } | null> {
  transcript.push(`$ ${cmd} ${args.join(" ")}`);
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; output: string } | null>();
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("error", (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? resolve(null) : reject(error)));
  child.on("close", (code) => {
    transcript.push(stripVTControlCharacters(output));
    resolve({ code: code ?? 1, output });
  });
  return promise;
}

const lastLine = (output: string, pattern: RegExp): string | undefined =>
  stripVTControlCharacters(output).split("\n").filter((l) => pattern.test(l)).at(-1)?.trim();

// ---- checks ----------------------------------------------------------------------------------

function serviceChecks(): Check[] {
  const health = (path: string): Check => ({
    claim: "live",
    title: `${path} answers`,
    run: async () => {
      const body = record(await getJson(`${SITE}${path}`), "health");
      if (body.ok !== true || body.network !== "testnet" || body.paused === true) return fail(JSON.stringify(body));
      return pass(JSON.stringify(body));
    },
  });
  return [
    health("/relayer/health"),
    health("/tilt/relayer/health"),
    {
      claim: "3",
      title: "/session/gamblers/floor answers",
      run: async () => {
        const gamblers = await getLiveFloor(`${SITE}/session`);
        // Arrivals are random draws: a quiet minute has nobody on the floor.
        if (gamblers.length === 0) return pass("valid list, nobody on the floor this minute (arrivals are random)");
        const seated = gamblers.filter((g) => g.state === "seated").length;
        const why = gamblers.find((g) => g.reason !== null);
        return pass(`${gamblers.length} gamblers, ${seated} seated${why ? ` · ${why.id}: "${why.reason}"` : ""}`);
      },
    },
    {
      claim: "28",
      title: "/session/poker/tables answers",
      run: async () => {
        const tables = list(await getJson(`${SITE}/session/poker/tables`), "poker tables").map((v, i) => record(v, `tables[${i}]`));
        if (tables.length === 0) return fail("no poker table");
        return pass(
          tables
            .map((t) => `${str(t.table_id, "table_id")}: ${t.open === true ? "open" : "closed"}, rake ${int(t.rake_bp, "rake_bp")} bp, hand #${int(t.hand_number, "hand_number")}`)
            .join("; "),
        );
      },
    },
  ];
}

function deploymentChecks(t: Targets, deployment: Deployment): Check[] {
  return deployment.contracts.map((c) => ({
    claim: "17",
    title: `${c.accountId} code_hash = record`,
    run: async () => {
      const onChain = await codeHash(t, c.accountId);
      if (onChain !== c.codeHash) return fail(`code_hash ${onChain} on chain, ${c.codeHash} recorded`);
      if (c.commit === null) return pass(`${onChain} = deployments/testnet.json (not a reproducible build)`);
      const named = sourceCommit(await view(t, c.accountId, "contract_source_metadata"));
      if (named !== c.commit) return fail(`NEP-330 names ${named ?? "no commit"}, recorded ${c.commit}`);
      return pass(`${onChain} = deployments/testnet.json · NEP-330 commit ${named.slice(0, 7)}`);
    },
  }));
}

function chainChecks(t: Targets, deployment: Deployment): Check[] {
  const floor = contractId(deployment, "floor");
  const meme = contractId(deployment, "tilt");
  return [
    {
      claim: "19",
      title: "get_npcs: 24 registered NPC gamblers",
      run: async () => {
        const npcs = list(await view(t, floor, "get_npcs"), "get_npcs").map((v, i) => str(v, `get_npcs[${i}]`));
        if (npcs.length !== NPC_COUNT) return fail(`${npcs.length} accounts, expected ${NPC_COUNT}`);
        const missing = deployment.npcGamblers.filter((id) => !npcs.includes(id));
        if (missing.length > 0) return fail(`not registered: ${missing.join(", ")}`);
        return pass(`${npcs.length} accounts = deployments/testnet.json (${npcs[0]}, …)`);
      },
    },
    {
      claim: "20",
      title: "$TILT get_params = README claim 20",
      run: async () => matchVerdict(fixture.tilt_params, record(await view(t, meme, "get_params"), "get_params"), "README claim 20"),
    },
    {
      claim: "20",
      title: "$TILT supply adds up",
      run: async () => {
        const state = parseTiltState(await view(t, meme, "get_state"));
        const ftSupply = BigInt(amount(await view(t, meme, "ft_total_supply"), "ft_total_supply"));
        const problem = supplyProblem(state, ftSupply);
        return problem === null ? pass(supplyEvidence(state)) : fail(problem);
      },
    },
    {
      claim: "26",
      title: "Tilt Hour triggered live, burns in get_log",
      run: async () => {
        const state = parseTiltState(await view(t, meme, "get_state"));
        if (state.tilt_hour_triggers < 1) return fail(`tilt_hour.triggers ${state.tilt_hour_triggers}`);
        const log: unknown[] = [];
        for (let from = 0; ; from += LOG_PAGE) {
          const page = list(await view(t, meme, "get_log", { from, limit: LOG_PAGE }), "get_log");
          log.push(...page);
          if (page.length < LOG_PAGE) break;
        }
        const burns = tiltHourBurns(log);
        if (burns < MIN_TILT_HOUR_BURNS) return fail(`${burns} tilt_hour burns in get_log (${log.length} entries), expected ≥ ${MIN_TILT_HOUR_BURNS}`);
        return pass(`tilt_hour.triggers ${state.tilt_hour_triggers} · ${burns} tilt_hour burns in get_log`);
      },
    },
    {
      claim: "14",
      title: "every live table within its edge/rake bounds",
      run: async () => {
        const tables = parseLobby(await view(t, floor, "get_lobby"));
        if (tables.length === 0) return fail("empty lobby");
        const problems = edgeProblems(tables);
        return problems.length === 0 ? pass(edgeEvidence(tables)) : fail(problems.join("; "));
      },
    },
    {
      claim: "7",
      title: "seat-1 NEP-245 token held by its controller",
      run: async () => {
        const seats = list(record(await view(t, floor, "get_floor"), "get_floor").seats, "get_floor.seats").map((s, i) => record(s, `seats[${i}]`));
        const seat = seats.find((s) => s.token_id === "seat-1");
        if (seat === undefined) return fail("get_floor has no seat-1");
        if (typeof seat.controller !== "string") return fail("seat-1 is empty");
        const held = amount(await view(t, floor, "mt_balance_of", { account_id: seat.controller, token_id: "seat-1" }), "mt_balance_of");
        if (held !== "1") return fail(`mt_balance_of(${seat.controller}, seat-1) = ${held}`);
        return pass(`seat-1 → ${String(seat.dealer_id)}, mt_balance_of(${seat.controller}) = 1`);
      },
    },
    {
      claim: "25",
      title: "floor ↔ $TILT linked both ways",
      run: async () => {
        const configMeme = record(await view(t, floor, "get_config"), "get_config").meme;
        const paramsFloor = record(await view(t, meme, "get_params"), "get_params").floor;
        if (configMeme !== meme) return fail(`${floor} get_config.meme = ${JSON.stringify(configMeme)}`);
        if (paramsFloor !== floor) return fail(`${meme} get_params.floor = ${JSON.stringify(paramsFloor)}`);
        return pass(`${floor} meme = ${meme} · ${meme} floor = ${floor}`);
      },
    },
  ];
}

/** The NPC gamblers to look at: those on the floor now, then the rest of the registry. */
async function npcCandidates(deployment: Deployment): Promise<string[]> {
  const onFloor = await getLiveFloor(`${SITE}/session`).catch(() => []);
  const fromFloor = onFloor.flatMap((g) => deployment.npcGamblers.filter((id) => id.startsWith(`${g.id}.`)));
  return [...new Set([...fromFloor, ...deployment.npcGamblers])];
}

function playChecks(t: Targets, funder: Funder | undefined, deployment: Deployment): Check[] {
  return [
    {
      claim: "18",
      title: "play dice, roulette, blackjack; all VERIFIED",
      run: async () => {
        const result = await runDemo({ name: "demo", targets: t, funder, fresh: false });
        const sessions = result.sessions.map((s) => `${s.game} ${s.verified ? "VERIFIED" : "NOT VERIFIED"}`).join(", ");
        const skipped = result.skipped.length > 0 ? ` · skipped (no seated table): ${result.skipped.join(", ")}` : "";
        const evidence = `${sessions || "no session played"} · median ${result.medianMs} ms${skipped}`;
        return result.ok ? pass(evidence) : fail(evidence);
      },
    },
    {
      claim: "2/29",
      title: "an NPC gambler's closed session VERIFIED",
      run: async () => {
        const tried: string[] = [];
        for (const player of (await npcCandidates(deployment)).slice(0, NPC_TRIES)) {
          const sessionId = await latestClosedSession(t, player).catch(() => null);
          const session = sessionId === null ? null : await getChainSession(t, sessionId);
          if (sessionId === null || session === null || session.settled_nonce === 0) {
            tried.push(player);
            continue;
          }
          const what = `${player} ${session.game} session ${sessionId}, ${session.settled_nonce} rounds`;
          return (await verifySessionById(t, sessionId)) ? pass(`${what} VERIFIED`) : fail(`${what} NOT VERIFIED`);
        }
        return fail(`no closed session with rounds for ${tried.join(", ")}`);
      },
    },
  ];
}

function rustChecks(): Check[] {
  let cargo: Promise<boolean> | undefined;
  const hasCargo = () => (cargo ??= command("cargo", ["--version"]).then((r) => r !== null && r.code === 0));
  const withCargo = (run: () => Promise<Verdict>) => async () => ((await hasCargo()) ? run() : skip("cargo not installed (rustup.rs)"));
  /** `cargo run` of the simulator, its `--out` file read back. */
  const simulate = async (args: readonly string[]): Promise<{ bytes: Buffer } | { error: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "tilt-judge-"));
    try {
      const out = join(dir, "sim.json");
      const run = await command("cargo", ["run", "-q", "-p", "tilt-house-sim", "--release", "--", ...args, "--out", out]);
      if (run === null || run.code !== 0) return { error: `cargo run exit ${run?.code ?? "?"}: ${lastLine(run?.output ?? "", /error/i) ?? "see judge.log"}` };
      return { bytes: await readFile(out) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return [
    {
      claim: "14",
      title: "cargo test -p tilt-house-core --test edges",
      run: withCargo(async () => {
        const run = await command("cargo", ["test", "-p", "tilt-house-core", "--test", "edges"]);
        const result = lastLine(run?.output ?? "", /^test result:/) ?? "no test result";
        return run?.code === 0 ? pass(result) : fail(result);
      }),
    },
    {
      claim: "5",
      title: "simulated week (seed 42) = README claim 5",
      run: withCargo(async () => {
        const sim = await simulate(["--days", "7", "--seed", "42"]);
        if ("error" in sim) return fail(sim.error);
        return matchVerdict(fixture.week_42_events, eventCounts(JSON.parse(sim.bytes.toString("utf8")) as unknown), "README claim 5 event counts");
      }),
    },
    {
      claim: "23",
      title: "60-day $TILT sim = web/public/tilt-sim.json",
      run: withCargo(async () => {
        const sim = await simulate(["meme", "--days", "60"]);
        if ("error" in sim) return fail(sim.error);
        const problem = bytesProblem(sim.bytes, await readFile(SIM_JSON));
        return problem === null ? pass(`byte for byte (${sim.bytes.length} bytes)`) : fail(problem);
      }),
    },
  ];
}

function testChecks(): Check[] {
  return [
    {
      claim: "CI",
      title: "pnpm -r test",
      run: async () => {
        const run = await command("pnpm", ["-r", "test"]);
        if (run === null) return skip("pnpm not installed");
        const text = stripVTControlCharacters(run.output);
        const tests = [...text.matchAll(/^\s*Tests\s+(\d+) passed/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
        const files = [...text.matchAll(/^\s*Test Files\s+(\d+) passed/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
        const evidence = `exit ${run.code} · ${tests} tests in ${files} files passed`;
        return run.code === 0 ? pass(evidence) : fail(`${evidence} · ${lastLine(run.output, /failed/i) ?? "see judge.log"}`);
      },
    },
  ];
}

// ---- runner ----------------------------------------------------------------------------------

const PAINT: Record<Status, (text: string) => string> = { PASS: color.ok, FAIL: color.bad, SKIP: color.warn };

async function runCheck(check: Check): Promise<CheckResult> {
  const tty = process.stdout.isTTY === true;
  if (tty) process.stdout.write(color.dim(`…     ${check.claim.padEnd(5)}  ${check.title}`));
  const started = performance.now();
  let verdict: Verdict;
  try {
    verdict = await quietly(`${check.claim} ${check.title}`, check.run);
  } catch (error) {
    verdict = fail(errorMessage(error));
  }
  const result: CheckResult = { claim: check.claim, title: check.title, ...verdict, ms: Math.round(performance.now() - started) };
  transcript.push(`----- ${reportLine(result)}`);
  if (tty) process.stdout.write("\r\x1b[2K");
  const text = reportLine(result);
  console.log(PAINT[result.status](result.status) + text.slice(result.status.length));
  return result;
}

async function judge(options: JudgeOptions): Promise<boolean> {
  // Only the RPC is configurable: the claims are about the deployment of record.
  const env: NodeJS.ProcessEnv = { NEAR_RPC_URL: process.env.NEAR_RPC_URL, FUNDER_ACCOUNT: process.env.FUNDER_ACCOUNT, FUNDER_KEY: process.env.FUNDER_KEY };
  const demo = parseCommand(["demo", ...(options.rpc === undefined ? [] : ["--rpc", options.rpc])], env);
  if (demo.name !== "demo") throw new Error("unreachable: demo command expected");
  const t = demo.targets;
  const deployment = await readDeployment();
  console.log(color.title(`Tilt House judge · NEAR testnet · README claims, live (${t.rpcUrl})`));
  const checks = [
    ...serviceChecks(),
    ...deploymentChecks(t, deployment),
    ...chainChecks(t, deployment),
    ...playChecks(t, demo.funder, deployment),
    ...(options.rust ? rustChecks() : []),
    ...(options.tests ? testChecks() : []),
  ];
  const started = performance.now();
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await runCheck(check));
  const seconds = (performance.now() - started) / 1000;
  const score = scoreLine(results, seconds);
  const ok = results.every((r) => r.status !== "FAIL");
  console.log(`\n${ok ? color.ok(score) : color.bad(score)}`);
  const report = { network: "testnet", rpc: t.rpcUrl, finished_at: new Date().toISOString(), score, checks: results };
  await writeFile(REPORT, JSON.stringify(report, null, 2) + "\n");
  await writeFile(TRANSCRIPT, transcript.join("\n") + "\n");
  console.log(color.dim(`report ${REPORT} · full output ${TRANSCRIPT}`));
  return ok;
}

let options: JudgeOptions;
try {
  options = parseJudgeArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${errorMessage(error)}\n\n${JUDGE_USAGE}`);
  process.exit(2);
}
if (options.help) {
  console.log(JUDGE_USAGE);
} else {
  judge(options).then(
    (ok) => {
      process.exitCode = ok ? 0 : 1;
    },
    (error: unknown) => {
      console.error(`judge stopped: ${errorMessage(error)}`);
      process.exitCode = 1;
    },
  );
}
