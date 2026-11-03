import { parseArgs } from "node:util";

export interface Funder {
  accountId: string;
  key: string;
}

export interface Options {
  house: string;
  token: string;
  relayer: string | undefined;
  rpcUrl: string;
  funder: Funder | undefined;
  dryRun: boolean;
}

const DEFAULT_HOUSE = "house.tilthouse.testnet";
const DEFAULT_TOKEN = "tusdc.tilthouse.testnet";
const TESTNET_RPC = "https://test.rpc.fastnear.com";
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const USAGE = `Usage: pnpm demo [--house <account>] [--token <account>] [--relayer <url>] [--dry-run]

Env: HOUSE_CONTRACT, TOKEN_CONTRACT, RELAYER_URL, NEAR_RPC_URL,
     FUNDER_ACCOUNT + FUNDER_KEY (create the demo account as a sub-account of the funder).`;

function testnetAccount(value: string, name: string): string {
  if (!ACCOUNT_ID.test(value)) throw new Error(`${name} is not a NEAR account id: ${value}`);
  if (!value.endsWith(".testnet")) throw new Error(`${name} must be a testnet account: ${value}`);
  return value;
}

function httpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be http(s): ${value}`);
  return value.replace(/\/+$/, "");
}

function funder(env: NodeJS.ProcessEnv): Funder | undefined {
  const accountId = env.FUNDER_ACCOUNT || undefined;
  const key = env.FUNDER_KEY || undefined;
  if (!accountId && !key) return undefined;
  if (!accountId || !key) throw new Error("set both FUNDER_ACCOUNT and FUNDER_KEY, or neither");
  if (!key.startsWith("ed25519:")) throw new Error("FUNDER_KEY must be an ed25519:… private key");
  return { accountId: testnetAccount(accountId, "FUNDER_ACCOUNT"), key };
}

/** Flags win over env; everything is checked to be a testnet target. */
export function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  // `pnpm demo -- --dry-run` forwards the separator on some pnpm versions.
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      house: { type: "string" },
      token: { type: "string" },
      relayer: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const relayer = values.relayer ?? (env.RELAYER_URL || undefined);
  return {
    house: testnetAccount(values.house ?? env.HOUSE_CONTRACT ?? DEFAULT_HOUSE, "house"),
    token: testnetAccount(values.token ?? env.TOKEN_CONTRACT ?? DEFAULT_TOKEN, "token"),
    relayer: relayer === undefined ? undefined : httpUrl(relayer, "relayer"),
    rpcUrl: httpUrl(env.NEAR_RPC_URL ?? TESTNET_RPC, "NEAR_RPC_URL"),
    funder: funder(env),
    dryRun: values["dry-run"],
  };
}
