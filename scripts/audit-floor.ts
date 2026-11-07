// Accounting check of the floor contract: the tUSDC it holds must equal what it owes.
//
//   held = Σ player balances + Σ open-session escrows + Σ pool bankrolls (+ open stakes) + jackpot
//
// Every view is read at the same block. Players live in a LookupMap (no enumeration), so the
// candidates are every account that ever moved tUSDC to or from the floor (NearBlocks ft-txns:
// deposits, invests, withdrawals), every table controller, the owner and the NPC gamblers: no
// one else can be credited (session payouts, jackpots, divests and seat sales only reach
// accounts that deposited or control a table).
//
// Usage: node scripts/audit-floor.ts   (env FLOOR, TOKEN, NEAR_RPC_URL, NEARBLOCKS_API)
// Exit 0 when the books balance, 1 when they don't.

import { setTimeout as sleep } from "node:timers/promises";

const FLOOR = process.env.FLOOR ?? "floor.tilthouse.testnet";
const TOKEN = process.env.TOKEN ?? "tusdc.tilthouse.testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const NEARBLOCKS = process.env.NEARBLOCKS_API ?? "https://api-testnet.nearblocks.io";
/** core/src/gambler_rules.rs `LINEUP`: NPC gamblers whose salary is deposited by the keeper. */
const GAMBLERS = [
  "mia", "noah", "zoe", "liam", "ines", "omar", "kai", "lea", "hugo", "nina", "theo", "ava",
  "yuki", "sam", "iris", "max", "rosa", "ezra", "vera", "paul", "june", "ravi", "lola", "tom",
];
const GAMBLER_SUFFIX = ".tilthouse.testnet";
const PAGE_SIZE = 50;
const MAX_PAGES = 1_000;
const RETRIES = 8;
/** NearBlocks' free tier throttles to a few requests per few seconds: back off this much more each try. */
const BACKOFF_MS = 3_000;

type Json = Record<string, unknown>;
/** Narrows one JSON value read from RPC or NearBlocks; fields stay `unknown` until checked. */
function record(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what}: expected an object`);
  return value as Json;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

function amount(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${what}: expected a decimal string`);
  return BigInt(value);
}

/** GET/POST with retries on rate limits and server errors (public endpoints throttle). */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init);
    if (response.ok) return response.json();
    if (attempt >= RETRIES || (response.status !== 429 && response.status < 500)) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    await sleep(BACKOFF_MS * attempt);
  }
}

async function rpc(method: string, params: Json): Promise<Json> {
  const body = record(
    await fetchJson(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "audit", method, params }),
    }),
    "rpc",
  );
  if (body.error !== undefined) throw new Error(`rpc ${method}: ${JSON.stringify(body.error)}`);
  return record(body.result, `rpc ${method} result`);
}

function viewer(blockId: number) {
  return async (contract: string, method: string, args: Json): Promise<unknown> => {
    const result = await rpc("query", {
      request_type: "call_function",
      block_id: blockId,
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    const bytes = list(result.result, `${method} result`).map(Number);
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  };
}

/** Every account on the other side of a tUSDC transfer to or from the floor. */
async function tokenCounterparties(): Promise<Set<string>> {
  const accounts = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const next = cursor === null ? "" : `&next=${encodeURIComponent(cursor)}`;
    const reply = record(await fetchJson(`${NEARBLOCKS}/v3/accounts/${FLOOR}/ft-txns?limit=${PAGE_SIZE}${next}`), "nearblocks");
    const rows = list(reply.data, "nearblocks.data");
    for (const row of rows) {
      const entry = record(row, "ft-txn");
      if (entry.contract_account_id === TOKEN && typeof entry.involved_account_id === "string") {
        accounts.add(entry.involved_account_id);
      }
    }
    const meta = reply.meta === undefined ? {} : record(reply.meta, "nearblocks.meta");
    cursor = typeof meta.next_page === "string" ? meta.next_page : null;
    if (cursor === null || rows.length === 0) return accounts;
  }
  throw new Error(`more than ${MAX_PAGES} pages of token transfers`);
}

const usdc = (units: bigint) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;

async function main(): Promise<void> {
  const counterparties = await tokenCounterparties();
  const block = record((await rpc("block", { finality: "final" })).header, "block header");
  const height = Number(block.height);
  const view = viewer(height);

  const lobby = list(await view(FLOOR, "get_lobby", {}), "get_lobby").map((d) => record(d, "dealer"));
  const floor = record(await view(FLOOR, "get_floor", {}), "get_floor");
  const config = record(await view(FLOOR, "get_config", {}), "get_config");
  const held = amount(await view(TOKEN, "ft_balance_of", { account_id: FLOOR }), "ft_balance_of");

  const candidates = new Set(counterparties);
  if (typeof config.owner === "string") candidates.add(config.owner);
  for (const dealer of lobby) if (typeof dealer.controller === "string") candidates.add(dealer.controller);
  for (const name of GAMBLERS) candidates.add(`g-${name}${GAMBLER_SUFFIX}`);

  let balances = 0n;
  let escrow = 0n;
  for (const account of [...candidates].sort()) {
    const player = record(await view(FLOOR, "get_player", { account_id: account }), "get_player");
    balances += amount(player.balance, `${account} balance`);
    if (typeof player.open_session !== "string") continue;
    const session = record(await view(FLOOR, "get_session", { session_id: player.open_session }), "get_session");
    // Force-closed sessions already paid their escrow; their reserve is still in the pool.
    if (session.status === "open") escrow += amount(session.balance, `${player.open_session} escrow`);
  }
  let pools = 0n;
  for (const dealer of lobby) {
    pools += amount(dealer.bankroll, `${String(dealer.id)} bankroll`) + amount(dealer.open_stakes, `${String(dealer.id)} open_stakes`);
  }
  const jackpot = amount(floor.jackpot, "jackpot");
  const owed = balances + escrow + pools + jackpot;

  console.log(`block ${height} · ${candidates.size} accounts checked · ${lobby.length} tables`);
  console.log(`  player balances  ${usdc(balances)}`);
  console.log(`  session escrows  ${usdc(escrow)}`);
  console.log(`  pool bankrolls   ${usdc(pools)}`);
  console.log(`  jackpot          ${usdc(jackpot)}`);
  console.log(`  owed (sum)       ${usdc(owed)}`);
  console.log(`  tUSDC held       ${usdc(held)}`);
  if (held === owed) {
    console.log("✓ books balance: the floor holds exactly what it owes");
    return;
  }
  // More held than owed: an account we could not list holds the rest (or money is stuck).
  // Less held than owed: the contract owes more than it has, which must never happen.
  console.log(`✗ held − owed = ${held > owed ? "" : "-"}${usdc(held > owed ? held - owed : owed - held)} tUSDC`);
  process.exitCode = 1;
}

await main();
