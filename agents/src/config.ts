import { homedir } from "node:os";
import { join } from "node:path";
import { nearToYocto } from "near-api-js";
import { rpcUrls } from "./rpc.ts";

export type Network = "testnet" | "mainnet";

/**
 * How the hourly NPC salary reaches the floor. `deposit` (contract v2): the keeper sends tUSDC to
 * the NPC's wallet and the NPC deposits it with its own key. `credit_npc` (contract v3): the keeper
 * deposits it straight into the NPC's in-contract balance (`ft_transfer_call` msg `credit_npc`),
 * so NPC keys never touch the token. Mainnet NPCs only hold floor session keys: credit_npc only.
 * `off`: no NPC gamblers, no salaries (the TILT floor).
 */
export type SalaryMode = "deposit" | "credit_npc" | "off";

/** Below these NEAR balances the keeper raises an alert. */
export interface AlertThresholds {
  keeper: bigint;
  sessions: bigint;
  relayer: bigint;
  npc: bigint;
}

export interface Config {
  network: Network;
  house: string;
  /** Preferred first (`NEAR_RPC_URLS`): reads fail over, transactions use the first (rpc.ts). */
  rpcUrls: string[];
  token: string;
  /** The contract's configured keeper: signs `collect_rent`, `reprice`, `rent_bid` and pays salaries. */
  keeper: string;
  /** NPC gamblers are `g-<name>.<accountSuffix>`. */
  accountSuffix: string;
  /** Watched for low NEAR: the session server's signer and the gas relayer. */
  sessionsAccount: string;
  relayerAccount: string;
  /** near-cli credentials of the keeper and, in `deposit` mode, of the gamblers. */
  keysDir: string;
  keeperIntervalMs: number;
  salaryMode: SalaryMode;
  alertThresholds: AlertThresholds;
  /** Optional: low-balance alerts are also POSTed here (Slack/Discord-style `{text, content}`). */
  alertWebhookUrl: string | null;
  /** Calls `close_day(yesterday)` on the house after each UTC midnight (the USD floor, $TILT). */
  closeDay: boolean;
  dryRun: boolean;
}

const NETWORKS = {
  // drpc: reads only in practice (it times out on send_tx); rpc.testnet.near.org is deprecated.
  testnet: { rpc: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"], suffix: ".testnet", root: "tilthouse.testnet" },
  mainnet: { rpc: ["https://rpc.mainnet.fastnear.com"], suffix: ".near", root: undefined },
} as const satisfies Record<Network, { rpc: readonly string[]; suffix: string; root: string | undefined }>;

/**
 * Defaults from testnet's measured burn (docs/mainnet.md): keeper ~1.5 NEAR/day, session server
 * ~0.5/day, each NPC ~0.01/day. Each threshold leaves at least a day to top up.
 */
const DEFAULT_THRESHOLDS = { keeper: "2", sessions: "1", relayer: "1", npc: "0.05" } as const;
const DEFAULT_INTERVAL_MS = 60_000;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const NEAR_AMOUNT = /^\d+(\.\d{1,24})?$/;

function accountId(value: string | undefined, name: string, suffix: string): string {
  if (!value) throw new Error(`missing env ${name}`);
  if (!ACCOUNT_ID.test(value)) throw new Error(`env ${name} is not a NEAR account id`);
  if (!value.endsWith(suffix)) throw new Error(`env ${name} must be a ${suffix} account`);
  return value;
}

function interval(value: string | undefined): number {
  const ms = Number(value ?? DEFAULT_INTERVAL_MS);
  if (!Number.isInteger(ms) || ms < 1000) throw new Error("env KEEPER_INTERVAL_MS must be an integer >= 1000");
  return ms;
}

function nearAmount(value: string, name: string): bigint {
  if (!NEAR_AMOUNT.test(value)) throw new Error(`env ${name} is not a NEAR amount`);
  return nearToYocto(value as `${number}`);
}

function network(value: string | undefined): Network {
  if (value === undefined || value === "testnet") return "testnet";
  if (value === "mainnet") return "mainnet";
  throw new Error("env NETWORK must be testnet or mainnet");
}

function salaryMode(value: string | undefined, net: Network): SalaryMode {
  const mode = value ?? (net === "mainnet" ? "credit_npc" : "deposit");
  if (mode !== "deposit" && mode !== "credit_npc" && mode !== "off") throw new Error("env SALARY_MODE must be deposit, credit_npc or off");
  if (net === "mainnet" && mode === "deposit") throw new Error("mainnet NPCs hold no token key: SALARY_MODE must be credit_npc or off");
  return mode;
}

const TRUE_FLAGS: Record<string, true> = { "1": true, true: true, yes: true };
const FALSE_FLAGS: Record<string, true> = { "": true, "0": true, false: true, no: true };

/** Unknown spellings refuse to start rather than guess. */
function flag(value: string | undefined, name: string): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (TRUE_FLAGS[normalized]) return true;
  if (FALSE_FLAGS[normalized]) return false;
  throw new Error(`env ${name} must be 1/0, true/false or yes/no`);
}

function webhook(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("https://")) throw new Error("env ALERT_WEBHOOK_URL must be an https URL");
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const net = network(env.NETWORK);
  const { rpc, suffix, root } = NETWORKS[net];
  // Mainnet has no default root: every account is named explicitly or derived from ACCOUNT_SUFFIX.
  const accountSuffix = accountId(env.ACCOUNT_SUFFIX ?? root, "ACCOUNT_SUFFIX", suffix);
  return {
    network: net,
    house: accountId(env.HOUSE_CONTRACT, "HOUSE_CONTRACT", suffix),
    rpcUrls: rpcUrls(env, rpc),
    token: accountId(env.TOKEN_CONTRACT ?? `tusdc.${accountSuffix}`, "TOKEN_CONTRACT", suffix),
    keeper: accountId(env.KEEPER_ACCOUNT ?? accountSuffix, "KEEPER_ACCOUNT", suffix),
    accountSuffix,
    sessionsAccount: accountId(env.SESSIONS_ACCOUNT ?? `sessions.${accountSuffix}`, "SESSIONS_ACCOUNT", suffix),
    relayerAccount: accountId(env.RELAYER_ACCOUNT ?? `relayer.${accountSuffix}`, "RELAYER_ACCOUNT", suffix),
    keysDir: env.KEYS_DIR ?? join(homedir(), ".near-credentials", net),
    keeperIntervalMs: interval(env.KEEPER_INTERVAL_MS),
    salaryMode: salaryMode(env.SALARY_MODE, net),
    alertThresholds: {
      keeper: nearAmount(env.ALERT_KEEPER_NEAR ?? DEFAULT_THRESHOLDS.keeper, "ALERT_KEEPER_NEAR"),
      sessions: nearAmount(env.ALERT_SESSIONS_NEAR ?? DEFAULT_THRESHOLDS.sessions, "ALERT_SESSIONS_NEAR"),
      relayer: nearAmount(env.ALERT_RELAYER_NEAR ?? DEFAULT_THRESHOLDS.relayer, "ALERT_RELAYER_NEAR"),
      npc: nearAmount(env.ALERT_NPC_NEAR ?? DEFAULT_THRESHOLDS.npc, "ALERT_NPC_NEAR"),
    },
    alertWebhookUrl: webhook(env.ALERT_WEBHOOK_URL),
    closeDay: flag(env.CLOSE_DAY, "CLOSE_DAY"),
    dryRun: argv.includes("--dry-run"),
  };
}
