import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "near-api-js";
import { loadConfig } from "./config.ts";
import { errorMessage, houseViews, sendFor, sleep, type Call, type DealerView, type House, type RoundStatus, type Send } from "./near.ts";

export type Strategy = "hunter" | "loyal" | "whale";

export interface Bot {
  name: string;
  strategy: Strategy;
}

export const BOTS: readonly Bot[] = [
  { name: "hunter", strategy: "hunter" },
  { name: "loyal", strategy: "loyal" },
  { name: "whale", strategy: "whale" },
];

/** Dice bet the bots place: 49.5 % chance, roll over. */
const DICE_CHANCE_BP = 4950;
/** Roulette bet the whale places (serde unit variant of `RouletteBet`). */
const ROULETTE_BET = "red";
/** The whale only plays this share of its turns. */
const WHALE_PLAY_ODDS = 0.2;
const PAUSE_MIN_MS = 5_000;
const PAUSE_MAX_MS = 20_000;
const POLL_MS = 2_000;
/** The contract refunds a round still `waiting_vrf` after 120 s. */
const REFUND_AFTER_MS = 120_000;

const byId = (a: DealerView, b: DealerView): number => a.id.localeCompare(b.id);

/** The table a strategy wants right now, or null if none fits. */
export function chooseTable(strategy: Strategy, lobby: readonly DealerView[], loyalDealer?: string): DealerView | null {
  const open = lobby.filter((d) => d.open);
  if (strategy === "hunter") {
    const dice = open.filter((d) => d.game === "dice").sort((a, b) => a.total_edge_bp - b.total_edge_bp || byId(a, b));
    return dice[0] ?? null;
  }
  if (strategy === "loyal") {
    const home = loyalDealer ?? [...lobby].sort(byId).find((d) => d.game !== "blackjack")?.id;
    return open.find((d) => d.id === home && d.game !== "blackjack") ?? null;
  }
  const roulette = open
    .filter((d) => d.game === "roulette")
    .sort((a, b) => (BigInt(b.max_bet) > BigInt(a.max_bet) ? 1 : BigInt(b.max_bet) < BigInt(a.max_bet) ? -1 : byId(a, b)));
  return roulette[0] ?? null;
}

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Stake for this turn, or null when the bot sits out (balance below the table min, or whale resting). */
export function stakeFor(strategy: Strategy, table: DealerView, balance: bigint, rand: () => number): bigint | null {
  const min = BigInt(table.min_bet);
  const max = BigInt(table.max_bet);
  if (balance < min || max < min) return null;
  if (strategy !== "whale") return min;
  if (rand() >= WHALE_PLAY_ODDS) return null;
  return maxBig(min, minBig(max, balance / 2n));
}

export function betCall(signer: string, table: DealerView, stake: bigint): Call {
  const base = { dealer_id: table.id, stake: stake.toString() };
  if (table.game === "dice") return { signer, method: "bet_dice", args: { ...base, chance_bp: DICE_CHANCE_BP, over: true } };
  if (table.game === "roulette") return { signer, method: "bet_roulette", args: { ...base, bet: ROULETTE_BET } };
  throw new Error(`bots do not play ${table.game}`);
}

/** Bets return the round id as a JSON number. */
export function parseRoundId(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("bet did not return a round id");
  return value as number;
}

const DONE: readonly (RoundStatus | null)[] = ["settled", "refunded"];

export interface BotDeps {
  house: House;
  send: Send;
  accountSuffix: string;
  loyalDealer: string | undefined;
  log: (line: string) => void;
  rand: () => number;
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

function logLine(deps: BotDeps, bot: Bot, data: Record<string, unknown>): void {
  deps.log(JSON.stringify({ at: new Date(deps.now()).toISOString(), bot: bot.name, ...data }));
}

/**
 * Polls `get_round` until the round is done. A `failed` round blocks the bot's next bet, so it is
 * refunded at once; one still `waiting_vrf` after 120 s is refunded too.
 */
export async function settle(deps: BotDeps, signer: string, roundId: number): Promise<RoundStatus | null> {
  const refundAt = deps.now() + REFUND_AFTER_MS;
  for (;;) {
    const status = await deps.house.roundStatus(roundId);
    if (DONE.includes(status)) return status;
    const stuck = status === "waiting_vrf" && deps.now() >= refundAt;
    if (status === "failed" || stuck) {
      await deps.send({ signer, method: "refund_stuck_round", args: { round_id: roundId } });
      return "refunded";
    }
    if (deps.now() >= refundAt) return status;
    await deps.wait(POLL_MS);
  }
}

/** One bot turn: finish any open round, else pick a table, bet, and wait for the round to end. */
export async function botTurn(deps: BotDeps, bot: Bot): Promise<void> {
  const signer = `bot-${bot.name}.${deps.accountSuffix}`;
  const player = await deps.house.player(signer);
  if (player.openRound !== null) {
    const status = await settle(deps, signer, player.openRound);
    return logLine(deps, bot, { round: player.openRound, status });
  }
  const table = chooseTable(bot.strategy, await deps.house.lobby(), deps.loyalDealer);
  if (!table) return logLine(deps, bot, { skip: "no table" });
  const stake = stakeFor(bot.strategy, table, player.balance, deps.rand);
  if (stake === null) return logLine(deps, bot, { skip: "sitting out", dealer: table.id, balance: player.balance.toString() });
  const call = betCall(signer, table, stake);
  const result = await deps.send(call);
  if (result === undefined) return; // dry run: the call was printed, nothing was sent
  const roundId = parseRoundId(result);
  const status = await settle(deps, signer, roundId);
  logLine(deps, bot, { dealer: table.id, method: call.method, stake: stake.toString(), round: roundId, status });
}

export function pauseMs(rand: () => number): number {
  return PAUSE_MIN_MS + Math.floor(rand() * (PAUSE_MAX_MS - PAUSE_MIN_MS));
}

async function runBot(deps: BotDeps, bot: Bot): Promise<never> {
  for (;;) {
    try {
      await botTurn(deps, bot);
    } catch (error) {
      logLine(deps, bot, { error: errorMessage(error) });
    }
    await deps.wait(pauseMs(deps.rand));
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv);
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const deps: BotDeps = {
    house: houseViews(provider, config.house),
    send: sendFor(config.dryRun, provider, config.house, config.botKeysDir),
    accountSuffix: config.accountSuffix,
    loyalDealer: config.loyalDealer,
    log: console.log,
    rand: Math.random,
    wait: sleep,
    now: Date.now,
  };
  if (config.dryRun) {
    for (const bot of BOTS) await botTurn(deps, bot);
    return;
  }
  await Promise.all(BOTS.map((bot) => runBot(deps, bot)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
