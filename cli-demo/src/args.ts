import { parseArgs } from "node:util";

export interface Funder {
  accountId: string;
  key: string;
}

/** Where everything lives; testnet only, checked at parse time. */
export interface Targets {
  floor: string;
  token: string;
  relayer: string;
  session: string;
  rpcUrl: string;
  /** Signs `settle_session` / `close_session`: where the settle and close txs are found. */
  serverAccount: string;
  nearblocksApi: string;
}

export type Command =
  | { name: "demo"; targets: Targets; funder: Funder | undefined; fresh: boolean }
  | { name: "verify-session"; targets: Targets; which: { sessionId: string } | { player: string } }
  | { name: "floor"; targets: Targets }
  | { name: "help" };

const SITE = "https://tilt-house-beta.vercel.app";
const DEFAULTS = {
  floor: "floor.tilthouse.testnet",
  token: "tusdc.tilthouse.testnet",
  relayer: `${SITE}/relayer`,
  session: `${SITE}/session`,
  rpcUrl: "https://test.rpc.fastnear.com",
  serverAccount: "sessions.tilthouse.testnet",
  nearblocksApi: "https://api-testnet.nearblocks.io",
};
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
/** `open_session`'s rule for session ids. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const USAGE = `Tilt House on NEAR testnet, from a terminal.

  pnpm --filter cli-demo demo                     throwaway account → deposit → 3 sessions (~20 rounds) → verify
  pnpm --filter cli-demo verify-session <id>      replay any closed session against its on-chain commitment
  pnpm --filter cli-demo verify-session --player <account>   … the account's latest closed session
  pnpm --filter cli-demo floor                    live economy: seats, rent, jackpot, tables, NPC gamblers

Options: --new (demo: a fresh account instead of reusing ~/.tilt-house/cli-demo-account.json)
         --floor <account> --token <account> --relayer <url> --session <url> --rpc <url>
Env:     FLOOR_CONTRACT TOKEN_CONTRACT RELAYER_URL SESSION_URL NEAR_RPC_URL SESSION_SERVER_ACCOUNT
         FUNDER_ACCOUNT + FUNDER_KEY (demo: fund the throwaway account yourself instead of the relayer)`;

export function testnetAccount(value: string, name: string): string {
  if (IMPLICIT_ACCOUNT.test(value)) return value;
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

const env1 = (env: NodeJS.ProcessEnv, name: string): string | undefined => env[name] || undefined;

/** Flags win over env, env over the public testnet defaults. */
export function parseCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Command {
  // `pnpm demo -- --new` forwards the separator on some pnpm versions.
  const args = argv.filter((arg, i) => !(arg === "--" && i <= 1));
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      floor: { type: "string" },
      token: { type: "string" },
      relayer: { type: "string" },
      session: { type: "string" },
      rpc: { type: "string" },
      player: { type: "string" },
      new: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [name, ...rest] = positionals;
  if (values.help || name === undefined || name === "help") return { name: "help" };
  const targets: Targets = {
    floor: testnetAccount(values.floor ?? env1(env, "FLOOR_CONTRACT") ?? DEFAULTS.floor, "floor"),
    token: testnetAccount(values.token ?? env1(env, "TOKEN_CONTRACT") ?? DEFAULTS.token, "token"),
    relayer: httpUrl(values.relayer ?? env1(env, "RELAYER_URL") ?? DEFAULTS.relayer, "relayer"),
    session: httpUrl(values.session ?? env1(env, "SESSION_URL") ?? DEFAULTS.session, "session"),
    rpcUrl: httpUrl(values.rpc ?? env1(env, "NEAR_RPC_URL") ?? DEFAULTS.rpcUrl, "rpc"),
    serverAccount: testnetAccount(env1(env, "SESSION_SERVER_ACCOUNT") ?? DEFAULTS.serverAccount, "SESSION_SERVER_ACCOUNT"),
    nearblocksApi: DEFAULTS.nearblocksApi,
  };
  const noMore = (allowed: number) => {
    if (rest.length > allowed) throw new Error(`unexpected argument: ${rest[allowed]}`);
  };
  const only = (flag: "player" | "new", command: string) => {
    if (values[flag]) throw new Error(`--${flag} only applies to ${command}`);
  };
  switch (name) {
    case "demo":
      noMore(0);
      only("player", "verify-session");
      return { name, targets, funder: funder(env), fresh: values.new };
    case "verify-session": {
      noMore(1);
      only("new", "demo");
      const sessionId = rest[0];
      const player = values.player;
      const oneOf = "verify-session needs a session id or --player <account> (one of them)";
      if (sessionId !== undefined && player !== undefined) throw new Error(oneOf);
      if (sessionId !== undefined) {
        if (!SESSION_ID.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
        return { name, targets, which: { sessionId } };
      }
      if (player === undefined) throw new Error(oneOf);
      return { name, targets, which: { player: testnetAccount(player, "--player") } };
    }
    case "floor":
      noMore(0);
      only("player", "verify-session");
      only("new", "demo");
      return { name, targets };
    default:
      throw new Error(`unknown command: ${name}`);
  }
}
