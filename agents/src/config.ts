import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  house: string;
  rpcUrl: string;
  accountSuffix: string;
  dealerKeysDir: string;
  botKeysDir: string;
  keeperIntervalMs: number;
  loyalDealer: string | undefined;
  dryRun: boolean;
}

const TESTNET_RPC = "https://test.rpc.fastnear.com";
const DEFAULT_SUFFIX = "tilthouse.testnet";
const DEFAULT_INTERVAL_MS = 60_000;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function accountId(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing env ${name}`);
  if (!ACCOUNT_ID.test(value)) throw new Error(`env ${name} is not a NEAR account id`);
  if (!value.endsWith(".testnet")) throw new Error(`env ${name} must be a testnet account`);
  return value;
}

function interval(value: string | undefined): number {
  const ms = Number(value ?? DEFAULT_INTERVAL_MS);
  if (!Number.isInteger(ms) || ms < 1000) throw new Error("env KEEPER_INTERVAL_MS must be an integer >= 1000");
  return ms;
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const defaultKeys = join(homedir(), ".near-credentials", "testnet");
  return {
    house: accountId(env.HOUSE_CONTRACT, "HOUSE_CONTRACT"),
    rpcUrl: env.NEAR_RPC_URL ?? TESTNET_RPC,
    accountSuffix: accountId(env.ACCOUNT_SUFFIX ?? DEFAULT_SUFFIX, "ACCOUNT_SUFFIX"),
    dealerKeysDir: env.DEALER_KEYS_DIR ?? defaultKeys,
    botKeysDir: env.BOT_KEYS_DIR ?? defaultKeys,
    keeperIntervalMs: interval(env.KEEPER_INTERVAL_MS),
    loyalDealer: env.BOT_LOYAL_DEALER || undefined,
    dryRun: argv.includes("--dry-run"),
  };
}
