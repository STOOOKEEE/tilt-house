import { homedir } from "node:os";
import { join } from "node:path";
import { nearToYocto } from "near-api-js";

export type Network = "testnet" | "mainnet";

export interface Config {
  network: Network;
  house: string;
  token: string;
  relayerAccount: string;
  relayerPrivateKey: string;
  rpcUrl: string;
  /** Interface to listen on: loopback unless a deployment says otherwise. */
  host: string;
  port: number;
  activationYocto: bigint;
  /** NEAR the relayer may spend per UTC day, activations and gas included (budget.ts). */
  dailyBudgetYocto: bigint;
  /** Kill switch: every endpoint that spends NEAR refuses with 503 `paused`. */
  paused: boolean;
  /**
   * Testnet only: `/activate` also serves callers without a Privy login (the judges' CLI demo),
   * one per account, under a tighter global limit. Refused on mainnet.
   */
  anonymousActivation: boolean;
  privyAppId: string;
  /** Holds state.json (activations, budget counter). */
  dataDir: string;
}

/** The Tilt House Privy app (web/.env.public). */
const DEFAULT_PRIVY_APP_ID = "cmw3anyvt021d0hjy746afxqi";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

/**
 * Per-network defaults. Activation: an implicit account with its Privy full-access key (182 bytes,
 * as measured on testnet) plus the browser game key (a function-call key for the floor's 4
 * session methods, ~195 bytes) stores ~380 bytes, i.e. ~0.0038 NEAR of storage staking; every
 * transaction it signs is relayed, so it never pays gas. 0.01 NEAR leaves 2.5x headroom.
 * Testnet keeps its historical 0.02.
 */
const NETWORKS = {
  testnet: { rpc: "https://test.rpc.fastnear.com", suffix: ".testnet", activation: "0.02", budget: "5" },
  mainnet: { rpc: "https://rpc.mainnet.fastnear.com", suffix: ".near", activation: "0.01", budget: undefined },
} as const satisfies Record<Network, { rpc: string; suffix: string; activation: string; budget: string | undefined }>;

export const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const NEAR_AMOUNT = /^\d+(\.\d{1,24})?$/;
const PRIVY_APP_ID = /^[a-z0-9]{10,40}$/;
const TRUE_FLAGS: Record<string, true> = { "1": true, true: true, yes: true };
const FALSE_FLAGS: Record<string, true> = { "": true, "0": true, false: true, no: true };

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

/** A named account of this network: mixing a testnet id into a mainnet relayer must not start. */
function accountId(env: NodeJS.ProcessEnv, name: string, suffix: string): string {
  const value = required(env, name);
  if (!ACCOUNT_ID.test(value)) throw new Error(`env ${name} is not a NEAR account id`);
  if (!value.endsWith(suffix)) throw new Error(`env ${name} must be a ${suffix} account`);
  return value;
}

function nearAmount(value: string | undefined, name: string): bigint {
  if (value === undefined) throw new Error(`missing env ${name}`);
  if (!NEAR_AMOUNT.test(value)) throw new Error(`env ${name} is not a NEAR amount`);
  return nearToYocto(value as `${number}`);
}

function network(value: string | undefined): Network {
  if (value === undefined || value === "testnet") return "testnet";
  if (value === "mainnet") return "mainnet";
  throw new Error("env NETWORK must be testnet or mainnet");
}

/** Unknown spellings refuse to start rather than guess whether the kill switch is on. */
function flag(value: string | undefined, name: string): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (TRUE_FLAGS[normalized]) return true;
  if (FALSE_FLAGS[normalized]) return false;
  throw new Error(`env ${name} must be 1/0, true/false or yes/no`);
}

/** On by default on testnet (the README's CLI demo relies on it); never on mainnet. */
function anonymousActivation(value: string | undefined, net: Network): boolean {
  if (net === "testnet") return value === undefined || flag(value, "ANONYMOUS_ACTIVATION");
  if (value !== undefined && flag(value, "ANONYMOUS_ACTIVATION")) throw new Error("ANONYMOUS_ACTIVATION is testnet only");
  return false;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const net = network(env.NETWORK);
  const defaults = NETWORKS[net];
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("env PORT is invalid");
  const privyAppId = env.PRIVY_APP_ID ?? DEFAULT_PRIVY_APP_ID;
  if (!PRIVY_APP_ID.test(privyAppId)) throw new Error("env PRIVY_APP_ID is invalid");
  // Mainnet has no default budget: whoever funds the relayer decides what it may spend.
  const dailyBudgetYocto = nearAmount(env.DAILY_BUDGET_NEAR ?? defaults.budget, "DAILY_BUDGET_NEAR");
  return {
    network: net,
    house: accountId(env, "HOUSE_CONTRACT", defaults.suffix),
    token: accountId(env, "TOKEN_CONTRACT", defaults.suffix),
    relayerAccount: accountId(env, "RELAYER_ACCOUNT", defaults.suffix),
    relayerPrivateKey: required(env, "RELAYER_PRIVATE_KEY"),
    rpcUrl: env.NEAR_RPC_URL ?? defaults.rpc,
    host: env.HOST ?? DEFAULT_HOST,
    port,
    activationYocto: nearAmount(env.ACTIVATION_NEAR ?? defaults.activation, "ACTIVATION_NEAR"),
    dailyBudgetYocto,
    paused: flag(env.RELAYER_PAUSED, "RELAYER_PAUSED"),
    anonymousActivation: anonymousActivation(env.ANONYMOUS_ACTIVATION, net),
    privyAppId,
    dataDir: env.RELAYER_DATA_DIR ?? join(homedir(), ".tilt-house", `relayer-${net}`),
  };
}
