// The house test owners' bot (README, Disclosure): plays the owner of the team's labeled test
// tables `test-1`/`test-2` (accounts `test-owner-<n>.tilthouse.testnet`, set up by
// owner-setup.ts) so the floor's economy stays live. It only ever sends the owner calls below:
// never a session, never $TILT. Every pass (~20 s), per table, one action at most:
//
//   1. answer a gambler hesitating at the table (at most half of the asks, some skipped at random),
//   2. bid for a seat again when evicted (after the contract's cooldown),
//   3. raise its rent ~10 % when it is the weakest on the floor (under OWNER_BOT_MAX_RENT),
//   4. invest its in-contract balance when the free bankroll covers under 2 h of rent,
//   5. keep the max bet at the largest the pool covers (the contract's clamp), rake kept.
//
// Every transaction is logged as one JSON line (action, dealer, args, tx hash). On any error it
// logs at level error and exits: the unit (ops/th-owner-bot.service) restarts it a few times, then
// gives up rather than loop.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPairSigner, type JsonRpcProvider } from "near-api-js";
import { CALL_GAS, errorMessage, field, isDecimal, isGame, isInt, isRecord, isString, loadKeyPair, sleep, type GameKind } from "./near.ts";
import { FailoverProvider, rpcUrls } from "./rpc.ts";

/** The only calls the bot may send: an owner's, on its own table. */
const OWNER_METHODS = ["set_offer", "bid_for_seat", "invest"] as const;
type OwnerMethod = (typeof OWNER_METHODS)[number];

/** `core::rake_bounds(game)` (the contract clamps there too). */
const RAKE_BOUNDS: Record<GameKind, readonly [number, number]> = { dice: [100, 495], roulette: [0, 230], blackjack: [0, 389], poker: [0, 500] };
/** `core::dealer_rules::{MAX_BOOST_SECS, BOOST_COOLDOWN_SECS}`. */
const MAX_BOOST_SECS = 15 * 60;
const BOOST_COOLDOWN_SECS = 60 * 60;
/** An ask with less time left is let go: the transaction might land after the gambler decided. */
const ANSWER_MARGIN_SECS = 5;
/** Chance to let an answerable ask go anyway, so the bot is not a perfect owner. */
export const SKIP_CHANCE = 0.2;
/** A seat bid prepays 2 h of rent from the pool (`core::Floor::bid_for_seat`). */
const PREPAID_HOURS = 2n;
/** Invest once the free bankroll covers less than this many hours of rent. */
const INVEST_BELOW_HOURS = 2n;
const RAISE_PERCENT = 110n;
/** Lift the max bet to the cap once it falls under this share of it. */
const TOP_UP_BELOW_PERCENT = 90n;
/** `core::SESSION_MIN_BET` (0.1 tUSDC): a max bet under it closes the table. */
const SESSION_MIN_BET = 100_000n;

/** One of the bot's tables, from `get_lobby`. Amounts in base units. */
export interface OwnedTable {
  id: string;
  game: GameKind;
  controller: string;
  seat: number | null;
  rent: bigint | null;
  cooldownUntil: number;
  free: bigint;
  worstCaseMultiple: bigint;
  maxBet: bigint;
  rakeBp: number;
  baseEdgeBp: number;
  lastBoostAt: number;
}

export interface FloorRents {
  /** null when nobody is seated. */
  lowestRent: bigint | null;
  /** The rent an off-floor table bids now: the cheapest empty seat's minimum, else ⌈lowest × 1.1⌉. */
  outbidMin: bigint;
}

/** A gambler standing at one of the bot's tables (`hesitating` in `GET /gamblers/floor`). */
export interface Ask {
  gambler: string;
  dealerId: string;
  want: "lower_edge" | "higher_max_bet" | "boost";
  edgeBp: number | null;
  maxBet: bigint | null;
  until: number;
}

export interface Tally {
  seen: number;
  answered: number;
}

export interface SetOfferArgs {
  dealer_id: string;
  rake_bp: number;
  max_bet: string;
  boost_secs: number;
}

export type Action =
  | { method: "set_offer"; args: SetOfferArgs; why: string }
  | { method: "bid_for_seat"; args: { dealer_id: string; rent_per_hour: string }; why: string }
  | { method: "invest"; args: { dealer_id: string; amount: string }; why: string };

/** Answers at most half of the asks seen (this one counted), and lets `SKIP_CHANCE` of the rest go. */
export function shouldAnswer(tally: Tally, roll: number): boolean {
  return (tally.answered + 1) * 2 <= tally.seen && roll >= SKIP_CHANCE;
}

/** The biggest max bet the pool covers: free bankroll / worst-case multiple (the contract's clamp). */
export function maxBetCap(table: OwnedTable): bigint {
  return table.worstCaseMultiple > 0n ? table.free / table.worstCaseMultiple : 0n;
}

/** The `set_offer` that gives the gambler what it asks, every other term kept; null when it can't or needn't. */
export function offerFor(table: OwnedTable, ask: Ask, now: number): SetOfferArgs | null {
  if (ask.until - now < ANSWER_MARGIN_SECS) return null;
  const cap = maxBetCap(table);
  const keep = { dealer_id: table.id, rake_bp: table.rakeBp, max_bet: String(table.maxBet < cap ? table.maxBet : cap), boost_secs: 0 };
  switch (ask.want) {
    case "lower_edge": {
      const [low] = RAKE_BOUNDS[table.game];
      const rake = Math.max((ask.edgeBp ?? 0) - table.baseEdgeBp, low);
      if (table.baseEdgeBp + rake > (ask.edgeBp ?? 0) || rake >= table.rakeBp) return null;
      return { ...keep, rake_bp: rake };
    }
    case "higher_max_bet": {
      // Up to what the pool covers: it may fall short of the ask, but never past the contract's cap.
      const wanted = ask.maxBet ?? 0n;
      const target = wanted < cap ? wanted : cap;
      return target > table.maxBet ? { ...keep, max_bet: String(target) } : null;
    }
    case "boost":
      if (table.lastBoostAt > 0 && now < table.lastBoostAt + BOOST_COOLDOWN_SECS) return null;
      return { ...keep, boost_secs: MAX_BOOST_SECS };
  }
}

/** ⌈rent × 110 %⌉ when the table holds the floor's lowest rent and can afford it; else null. */
export function rentRaise(table: OwnedTable, floor: FloorRents, maxRent: bigint): bigint | null {
  if (table.seat === null || table.rent === null || floor.lowestRent === null || table.rent > floor.lowestRent) return null;
  const raised = (table.rent * RAISE_PERCENT + 99n) / 100n;
  return raised <= maxRent && raised * PREPAID_HOURS <= table.free ? raised : null;
}

/** The rent to bid back onto the floor; null while seated, cooling down, or when too dear. */
export function rebid(table: OwnedTable, floor: FloorRents, maxRent: bigint, now: number): bigint | null {
  if (table.seat !== null || now < table.cooldownUntil) return null;
  return floor.outbidMin <= maxRent && floor.outbidMin * PREPAID_HOURS <= table.free ? floor.outbidMin : null;
}

/** The whole in-contract balance once the free bankroll covers under 2 h of rent (the bid's rent off the floor); else 0. */
export function investAmount(table: OwnedTable, floor: FloorRents, balance: bigint): bigint {
  const rent = table.rent ?? floor.outbidMin;
  return table.free < rent * INVEST_BELOW_HOURS ? balance : 0n;
}

/**
 * The `set_offer` that lifts the max bet to the cap, rake kept, once it sits under
 * `TOP_UP_BELOW_PERCENT` of what the pool covers (sessions reserving and releasing the pool move
 * the cap a little all the time: no offer for that); null otherwise.
 */
export function maxBetTopUp(table: OwnedTable): SetOfferArgs | null {
  const cap = maxBetCap(table);
  if (cap < SESSION_MIN_BET || table.maxBet * 100n >= cap * TOP_UP_BELOW_PERCENT) return null;
  return { dealer_id: table.id, rake_bp: table.rakeBp, max_bet: String(cap), boost_secs: 0 };
}

/** This pass's one action for a table; `answer` says whether the live ask (if any) gets answered. */
export function decide(table: OwnedTable, floor: FloorRents, ask: Ask | null, answer: boolean, balance: bigint, maxRent: bigint, now: number): Action | null {
  const offer = ask && answer ? offerFor(table, ask, now) : null;
  if (ask && offer) return { method: "set_offer", args: offer, why: `${ask.gambler} asks ${ask.want}` };
  const bid = rebid(table, floor, maxRent, now);
  if (bid !== null) return { method: "bid_for_seat", args: { dealer_id: table.id, rent_per_hour: String(bid) }, why: "off the floor" };
  const raise = rentRaise(table, floor, maxRent);
  if (raise !== null) return { method: "bid_for_seat", args: { dealer_id: table.id, rent_per_hour: String(raise) }, why: "weakest rent on the floor" };
  const invest = investAmount(table, floor, balance);
  if (invest > 0n) return { method: "invest", args: { dealer_id: table.id, amount: String(invest) }, why: "free bankroll under 2 h of rent" };
  const topUp = maxBetTopUp(table);
  if (topUp) return { method: "set_offer", args: topUp, why: "max bet under what the pool covers" };
  return null;
}

const isSeat = (v: unknown): v is number | null => v === null || isInt(v);
const isRent = (v: unknown): v is string | null => v === null || isDecimal(v);

export function parseOwnedTable(entry: unknown): OwnedTable {
  if (!isRecord(entry)) throw new Error("get_lobby: entry is not an object");
  const rent = field(entry, "rent_per_hour", isRent);
  const free = BigInt(field(entry, "bankroll", isDecimal)) - BigInt(field(entry, "reserved", isDecimal));
  return {
    id: field(entry, "id", isString),
    game: field(entry, "game", isGame),
    controller: field(entry, "controller", isString),
    seat: field(entry, "seat", isSeat),
    rent: rent === null ? null : BigInt(rent),
    cooldownUntil: field(entry, "cooldown_until", isInt),
    free: free > 0n ? free : 0n,
    worstCaseMultiple: BigInt(field(entry, "worst_case_multiple", isDecimal)),
    maxBet: BigInt(field(entry, "max_bet", isDecimal)),
    rakeBp: field(entry, "offer_rake_bp", isInt),
    baseEdgeBp: field(entry, "base_edge_bp", isInt),
    lastBoostAt: field(entry, "last_boost_at", isInt),
  };
}

export function parseFloorRents(value: unknown): FloorRents {
  if (!isRecord(value)) throw new Error("get_floor: not an object");
  const { lowest_rent, outbid_min } = value;
  if (!isRent(lowest_rent) || !isDecimal(outbid_min)) throw new Error("get_floor: invalid lowest_rent or outbid_min");
  return { lowestRent: lowest_rent === null ? null : BigInt(lowest_rent), outbidMin: BigInt(outbid_min) };
}

const WANTS: readonly string[] = ["lower_edge", "higher_max_bet", "boost"];
const isWant = (v: unknown): v is Ask["want"] => typeof v === "string" && WANTS.includes(v);

/** The live asks at `dealerIds` in the gamblers feed. */
export function parseAsks(feed: unknown, dealerIds: readonly string[]): Ask[] {
  if (!Array.isArray(feed)) throw new Error("gamblers feed: not an array");
  const asks: Ask[] = [];
  for (const entry of feed) {
    if (!isRecord(entry) || !isString(entry.id)) throw new Error("gamblers feed: invalid entry");
    const h = entry.hesitating;
    if (h === null || h === undefined) continue;
    if (!isRecord(h) || !isString(h.dealer_id) || !isWant(h.want) || !isInt(h.until)) throw new Error("gamblers feed: invalid hesitating");
    if (!dealerIds.includes(h.dealer_id)) continue;
    const edgeBp = isInt(h.edge_bp) ? h.edge_bp : null;
    const maxBet = isDecimal(h.max_bet) ? BigInt(h.max_bet) : null;
    asks.push({ gambler: entry.id, dealerId: h.dealer_id, want: h.want, edgeBp, maxBet, until: h.until });
  }
  return asks;
}

export interface BotConfig {
  house: string;
  /** dealer id → its controller (a test owner account). */
  tables: Map<string, string>;
  sessionUrl: string;
  rpcUrls: string[];
  keysDir: string;
  intervalMs: number;
  maxRent: bigint;
}

const TESTNET_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)+testnet$/;
const TABLE_ID = /^[a-z0-9-]{1,32}$/;

function testnetAccount(value: string | undefined, name: string): string {
  if (!value || !TESTNET_ACCOUNT.test(value)) throw new Error(`env ${name} must be a .testnet account`);
  return value;
}

/** `OWNER_TABLES=test-1=test-owner-1.tilthouse.testnet,test-2=…` (testnet only). */
export function loadBotConfig(env: NodeJS.ProcessEnv): BotConfig {
  const tables = new Map<string, string>();
  for (const pair of (env.OWNER_TABLES ?? "").split(",").filter((p) => p.trim())) {
    const [id = "", owner] = pair.trim().split("=");
    if (!TABLE_ID.test(id)) throw new Error(`env OWNER_TABLES: bad table id ${id}`);
    tables.set(id, testnetAccount(owner, "OWNER_TABLES"));
  }
  if (tables.size === 0) throw new Error("env OWNER_TABLES is empty");
  const intervalMs = Number(env.OWNER_BOT_INTERVAL_MS ?? 20_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 5_000) throw new Error("env OWNER_BOT_INTERVAL_MS must be an integer >= 5000");
  const maxRent = env.OWNER_BOT_MAX_RENT ?? "2000000";
  if (!isDecimal(maxRent)) throw new Error("env OWNER_BOT_MAX_RENT must be base units");
  return {
    house: testnetAccount(env.HOUSE_CONTRACT, "HOUSE_CONTRACT"),
    tables,
    sessionUrl: (env.SESSION_URL ?? "http://127.0.0.1:8791").replace(/\/+$/, ""),
    rpcUrls: rpcUrls(env, ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"]),
    keysDir: env.KEYS_DIR ?? join(homedir(), ".near-credentials", "testnet"),
    intervalMs,
    maxRent: BigInt(maxRent),
  };
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));

/** Sends an owner call (allow-listed) and returns its transaction hash. */
async function send(provider: JsonRpcProvider, config: BotConfig, signer: string, method: OwnerMethod, args: Record<string, unknown>): Promise<string> {
  if (!OWNER_METHODS.includes(method) || ![...config.tables.values()].includes(signer)) throw new Error(`refused: ${signer} ${method}`);
  const account = new Account(signer, provider, new KeyPairSigner(await loadKeyPair(config.keysDir, signer)));
  const outcome = await account.callFunctionRaw({ contractId: config.house, methodName: method, args, gas: CALL_GAS });
  return outcome.transaction.hash;
}

async function pass(provider: JsonRpcProvider, config: BotConfig, tallies: Map<string, Tally>, decided: Map<string, number>): Promise<void> {
  const view = (method: string, args: Record<string, unknown> = {}) => provider.callFunction({ contractId: config.house, method, args });
  const lobby: unknown = await view("get_lobby");
  if (!Array.isArray(lobby)) throw new Error("get_lobby: not an array");
  const floor = parseFloorRents(await view("get_floor"));
  const response = await fetch(`${config.sessionUrl}/gamblers/floor`);
  if (!response.ok) throw new Error(`gamblers feed: HTTP ${response.status}`);
  const asks = parseAsks(await response.json(), [...config.tables.keys()]);
  const now = Math.floor(Date.now() / 1000);
  for (const [key, until] of decided) if (until < now) decided.delete(key);

  for (const [dealerId, owner] of config.tables) {
    const table = parseOwnedTable(lobby.find((d: unknown) => isRecord(d) && d.id === dealerId));
    if (table.controller !== owner) throw new Error(`${dealerId} is controlled by ${table.controller}, not ${owner}`);
    const player: unknown = await view("get_player", { account_id: owner });
    if (!isRecord(player) || !isDecimal(player.balance)) throw new Error("get_player: invalid balance");

    // Each ask is decided once (answer or skip), whatever the number of passes it stays live.
    const ask = asks.find((a) => a.dealerId === dealerId && !decided.has(`${a.gambler}@${a.until}`)) ?? null;
    let answer = false;
    if (ask) {
      decided.set(`${ask.gambler}@${ask.until}`, ask.until);
      const tally = tallies.get(dealerId) ?? { seen: 0, answered: 0 };
      tally.seen += 1;
      const turn = shouldAnswer(tally, Math.random());
      answer = turn && offerFor(table, ask, now) !== null;
      if (answer) tally.answered += 1;
      tallies.set(dealerId, tally);
      const why = answer ? "answered" : turn ? "nothing to change within the contract's bounds" : "left to the floor (half the asks at most, some at random)";
      log({ decision: answer ? "answer" : "let_go", why, dealer: dealerId, gambler: ask.gambler, want: ask.want, edge_bp: ask.edgeBp, max_bet: ask.maxBet?.toString() ?? null, ...tally });
    }
    const action = decide(table, floor, ask, answer, BigInt(player.balance), config.maxRent, now);
    if (!action) continue;
    // The floor may move between the read and the send (an NPC outbids the seat): name the call that failed.
    const tx = await send(provider, config, owner, action.method, { ...action.args }).catch((error: unknown) => {
      throw new Error(`${action.method} ${dealerId} (${action.why}): ${errorMessage(error)}`);
    });
    log({ action: action.method, dealer: dealerId, signer: owner, args: action.args, why: action.why, tx });
  }
}

async function main(): Promise<void> {
  const config = loadBotConfig(process.env);
  const provider = new FailoverProvider(config.rpcUrls);
  const tallies = new Map<string, Tally>();
  const decided = new Map<string, number>();
  log({ start: "owner-bot", house: config.house, tables: Object.fromEntries(config.tables), max_rent: config.maxRent.toString() });
  for (;;) {
    try {
      await pass(provider, config, tallies, decided);
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), level: "error", error: errorMessage(error), stopping: true }));
      process.exitCode = 1;
      return;
    }
    await sleep(config.intervalMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
