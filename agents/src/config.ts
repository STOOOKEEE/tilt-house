import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  house: string;
  rpcUrl: string;
  token: string;
  /** The contract's configured keeper: signs `collect_rent`, `reprice`, `rent_bid` and pays salaries. */
  keeper: string;
  accountSuffix: string;
  /** near-cli credentials of the keeper and of the gamblers (who deposit their own salary). */
  keysDir: string;
  keeperIntervalMs: number;
  dryRun: boolean;
}

const TESTNET_RPC = "https://test.rpc.fastnear.com";
const DEFAULT_SUFFIX = "tilthouse.testnet";
const DEFAULT_TOKEN = "tusdc.tilthouse.testnet";
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
    token: accountId(env.TOKEN_CONTRACT ?? DEFAULT_TOKEN, "TOKEN_CONTRACT"),
    keeper: accountId(env.KEEPER_ACCOUNT ?? DEFAULT_SUFFIX, "KEEPER_ACCOUNT"),
    accountSuffix: accountId(env.ACCOUNT_SUFFIX ?? DEFAULT_SUFFIX, "ACCOUNT_SUFFIX"),
    keysDir: env.KEYS_DIR ?? defaultKeys,
    keeperIntervalMs: interval(env.KEEPER_INTERVAL_MS),
    dryRun: argv.includes("--dry-run"),
  };
}
