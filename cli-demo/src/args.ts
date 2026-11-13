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
  | { name: "poker"; targets: Targets; funder: Funder | undefined; fresh: boolean; hands: number }
  | { name: "verify-session"; targets: Targets; which: { sessionId: string } | { player: string } }
  | { name: "floor"; targets: Targets }
  | { name: "help" };

export const SITE = "https://tilt-house-beta.vercel.app";
const DEFAULTS = {
  floor: "floor.tilthouse.testnet",
  token: "tusdc.tilthouse.testnet",
  relayer: `${SITE}/relayer`,
  session: `${SITE}/session`,
  rpcUrl: "https://test.rpc.fastnear.com",
  serverAccount: "sessions.tilthouse.testnet",
  nearblocksApi: "https://api-testnet.nearblocks.io",
};
/** `--tilt`: the TILT floor, the same contract with $TILT as the chip (docs/ops-tilt.md). */
const TILT = {
  floor: "floor-tilt.tilthouse.testnet",
  token: "tilt.tilthouse.testnet",
  relayer: `${SITE}/tilt/relayer`,
  session: `${SITE}/tilt/session`,
};
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
/** `open_session`'s rule for session ids. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_HANDS = 3;
/** A poker run keeps two sessions open; this bounds its length. */
const MAX_HANDS = 20;

export const USAGE = `Tilt House on NEAR testnet, from a terminal.

  pnpm --filter cli-demo demo                     throwaway account → deposit → 3 sessions (~20 rounds) → verify
  pnpm --filter cli-demo verify-session <id>      replay any closed session against its on-chain commitment
  pnpm --filter cli-demo verify-session --player <account>   … the account's latest closed session
  pnpm --filter cli-demo floor                    live economy: seats, rent, jackpot, tables, NPC gamblers
  pnpm --filter cli-demo poker [--hands N]        two throwaway accounts play N hold'em hands (default 3) with the bots → verify

Options: --tilt (the TILT floor: --floor floor-tilt.tilthouse.testnet --token tilt.tilthouse.testnet
          --relayer ${SITE}/tilt/relayer --session ${SITE}/tilt/session; explicit flags still win)
         --new (demo, poker: fresh accounts instead of reusing the ones in ~/.tilt-house/)
         --floor <account> --token <account> --relayer <url> --session <url> --rpc <url>
Env:     FLOOR_CONTRACT TOKEN_CONTRACT RELAYER_URL SESSION_URL NEAR_RPC_URL SESSION_SERVER_ACCOUNT
         FUNDER_ACCOUNT + FUNDER_KEY (demo, poker: fund the throwaway accounts yourself instead of the relayer)`;

/**
 * The flags that point another command at the same targets, for the "re-check" hints: none for the
 * defaults, `--tilt` for the TILT floor, else each target that differs.
 */
export function targetFlags(t: Targets): string {
  const { floor, token, relayer, session } = t;
  if (floor === TILT.floor && token === TILT.token && relayer === TILT.relayer && session === TILT.session) return " --tilt";
  const flags = { floor, token, relayer, session };
  return Object.entries(flags)
    .filter(([name, value]) => DEFAULTS[name as keyof typeof flags] !== value)
    .map(([name, value]) => ` --${name} ${value}`)
    .join("");
}

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
      hands: { type: "string" },
      tilt: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [name, ...rest] = positionals;
  if (values.help || name === undefined || name === "help") return { name: "help" };
  // --tilt stands for its four flags: below explicit flags, above env.
  const tilt = values.tilt ? TILT : null;
  const targets: Targets = {
    floor: testnetAccount(values.floor ?? tilt?.floor ?? env1(env, "FLOOR_CONTRACT") ?? DEFAULTS.floor, "floor"),
    token: testnetAccount(values.token ?? tilt?.token ?? env1(env, "TOKEN_CONTRACT") ?? DEFAULTS.token, "token"),
    relayer: httpUrl(values.relayer ?? tilt?.relayer ?? env1(env, "RELAYER_URL") ?? DEFAULTS.relayer, "relayer"),
    session: httpUrl(values.session ?? tilt?.session ?? env1(env, "SESSION_URL") ?? DEFAULTS.session, "session"),
    rpcUrl: httpUrl(values.rpc ?? env1(env, "NEAR_RPC_URL") ?? DEFAULTS.rpcUrl, "rpc"),
    serverAccount: testnetAccount(env1(env, "SESSION_SERVER_ACCOUNT") ?? DEFAULTS.serverAccount, "SESSION_SERVER_ACCOUNT"),
    nearblocksApi: DEFAULTS.nearblocksApi,
  };
  const noMore = (allowed: number) => {
    if (rest.length > allowed) throw new Error(`unexpected argument: ${rest[allowed]}`);
  };
  const only = (flag: "player" | "new" | "hands", command: string) => {
    if (values[flag]) throw new Error(`--${flag} only applies to ${command}`);
  };
  switch (name) {
    case "demo":
      noMore(0);
      only("player", "verify-session");
      only("hands", "poker");
      return { name, targets, funder: funder(env), fresh: values.new };
    case "poker": {
      noMore(0);
      only("player", "verify-session");
      const hands = values.hands === undefined ? DEFAULT_HANDS : Number(values.hands);
      if (!Number.isInteger(hands) || hands < 1 || hands > MAX_HANDS) throw new Error(`--hands must be 1-${MAX_HANDS}`);
      return { name, targets, funder: funder(env), fresh: values.new, hands };
    }
    case "verify-session": {
      noMore(1);
      only("new", "demo");
      only("hands", "poker");
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
      only("hands", "poker");
      return { name, targets };
    default:
      throw new Error(`unknown command: ${name}`);
  }
}
