/**
 * Reads the live system: floor contract views over NEAR RPC, the session server's public session
 * view, and the txs of a session (listed by NearBlocks, their args read back from RPC).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseLastHand, type LastHand } from "../../web/src/near/poker-client";
import { parseCompactRound, parseTicket, type CompactRound, type SessionTicket } from "../../web/src/near/session-client";
import {
  amount,
  GAMES,
  int,
  list,
  oneOf,
  optional,
  record,
  str,
  viewCall,
  type Game,
} from "../../web/src/near/views";
import type { Targets } from "./args.ts";
import { errorMessage } from "./ui.ts";

const RETRIES = 6;
const RETRY_BASE_MS = 400;
/** RPC and NearBlocks rate-limit; a network blip is not a verdict either. */
const TRANSIENT = /HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;

async function withRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= RETRIES || !TRANSIENT.test(errorMessage(error))) throw error;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
}

export function view(t: Targets, contract: string, method: string, args: object = {}): Promise<unknown> {
  return withRetry(() => viewCall(t.rpcUrl, contract, method, args));
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  return withRetry(async () => {
    const response = await fetch(url, init);
    if (response.status === 429 || response.status >= 500) throw new Error(`${url}: HTTP ${response.status}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  });
}

// ---- on-chain session (`get_session`) -----------------------------------------------------

export const SESSION_STATUSES = ["open", "force_closed", "closed", "forfeited"] as const;

export interface ChainSession {
  id: string;
  player: string;
  dealer_id: string;
  game: Game;
  status: (typeof SESSION_STATUSES)[number];
  lock: string;
  rake_bp: number;
  max_bet: string;
  max_win: string;
  server_seed_hash: string;
  client_seed: string;
  server_seed: string | null;
  opened_at: number;
  closed_at: number;
  settled_nonce: number;
  balance: string;
  chain: string;
  wagered: string;
  paid: string;
  jackpot_won: string;
  paid_out: string;
}

export function parseChainSession(value: unknown): ChainSession {
  const s = record(value, "session");
  const p = (key: string) => `session.${key}`;
  return {
    id: str(s.id, p("id")),
    player: str(s.player, p("player")),
    dealer_id: str(s.dealer_id, p("dealer_id")),
    game: oneOf(GAMES, s.game, p("game")),
    status: oneOf(SESSION_STATUSES, s.status, p("status")),
    lock: amount(s.lock, p("lock")),
    rake_bp: int(s.rake_bp, p("rake_bp")),
    max_bet: amount(s.max_bet, p("max_bet")),
    max_win: amount(s.max_win, p("max_win")),
    server_seed_hash: str(s.server_seed_hash, p("server_seed_hash")).toLowerCase(),
    client_seed: str(s.client_seed, p("client_seed")),
    server_seed: optional(s.server_seed, (v) => str(v, p("server_seed")).toLowerCase()),
    opened_at: int(s.opened_at, p("opened_at")),
    closed_at: int(s.closed_at, p("closed_at")),
    settled_nonce: int(s.settled_nonce, p("settled_nonce")),
    balance: amount(s.balance, p("balance")),
    chain: str(s.chain, p("chain")).toLowerCase(),
    wagered: amount(s.wagered, p("wagered")),
    paid: amount(s.paid, p("paid")),
    jackpot_won: amount(s.jackpot_won, p("jackpot_won")),
    paid_out: amount(s.paid_out, p("paid_out")),
  };
}

export async function getChainSession(t: Targets, sessionId: string): Promise<ChainSession | null> {
  const value = await view(t, t.floor, "get_session", { session_id: sessionId });
  return value === null ? null : parseChainSession(value);
}

// ---- session server public view (GET /sessions/:id) ---------------------------------------

export interface ServerSessionView {
  ticket: SessionTicket;
  rounds: CompactRound[];
  server_seed: string | null;
}

export async function getServerSession(t: Targets, sessionId: string): Promise<ServerSessionView | null> {
  const { status, body } = await getJson(`${t.session}/sessions/${encodeURIComponent(sessionId)}`);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`session server: HTTP ${status}`);
  const v = record(body, "view");
  return {
    ticket: parseTicket(v.ticket),
    rounds: list(v.rounds, "view.rounds").map((r, i) => parseCompactRound(r, `view.rounds[${i}]`)),
    server_seed: optional(v.server_seed, (s) => str(s, "view.server_seed").toLowerCase()),
  };
}

// ---- poker hand archive (GET /poker/tables/:id/hands/:hand) --------------------------------

/** A finished hand as the session server archived it (untrusted: it must replay and match). */
export async function getArchivedHand(t: Targets, table: string, hand: number): Promise<LastHand | null> {
  const url = `${t.session}/poker/tables/${encodeURIComponent(table)}/hands/${hand}`;
  const { status, body } = await getJson(url);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`hand archive: HTTP ${status}`);
  return parseLastHand(body, `hand ${hand}`);
}

// ---- session txs ----------------------------------------------------------------------------

interface ListedTx {
  hash: string;
  signer: string;
  /** Unix seconds. */
  at: number;
  methods: string[];
}

interface FunctionCall {
  method: string;
  args: unknown;
}

export interface SessionTxs {
  open: string | null;
  /** Oldest first, with the rounds their args carry (public on chain forever). */
  settles: { hash: string; rounds: CompactRound[] }[];
  close: string | null;
  /** Why the lookup stopped early, if it did. */
  error: string | null;
}

const PAGE_SIZE = 50;
/** Pages walked back per account (≈ half a day of server txs): a bound, not a promise. */
const MAX_PAGES = 10;
/** Detail lookups per account, a bound on RPC calls. */
const MAX_LOOKUPS = 25;
/** Slack around the session's on-chain times (block time vs indexer time). */
const WINDOW_SLACK_SECS = 120;

function parseListedTx(entry: unknown, i: number): ListedTx {
  const tx = record(entry, `nearblocks.data[${i}]`);
  const actions = list(tx.actions ?? [], `nearblocks.data[${i}].actions`);
  return {
    hash: str(tx.transaction_hash, "transaction_hash"),
    signer: str(tx.signer_account_id, "signer_account_id"),
    at: Number(BigInt(str(tx.block_timestamp, "block_timestamp")) / 1_000_000_000n),
    methods: actions.flatMap((a) => {
      const method = record(a, "action").method;
      return typeof method === "string" ? [method] : [];
    }),
  };
}

/** The account's txs from newest back to `since` (unix seconds), as listed by NearBlocks. */
async function listTxs(t: Targets, account: string, since: number): Promise<ListedTx[]> {
  const txs: ListedTx[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const next = cursor === null ? "" : `&next=${encodeURIComponent(cursor)}`;
    const { status, body } = await getJson(`${t.nearblocksApi}/v3/accounts/${account}/txns?limit=${PAGE_SIZE}${next}`);
    if (status !== 200) throw new Error(`NearBlocks: HTTP ${status}`);
    const reply = record(body, "nearblocks");
    txs.push(...list(reply.data, "nearblocks.data").map(parseListedTx));
    cursor = optional(record(reply.meta ?? {}, "nearblocks.meta").next_page, (v) => str(v, "next_page"));
    if (cursor === null || (txs.at(-1)?.at ?? 0) < since) break;
  }
  return txs;
}

/** The function calls of a tx, read from RPC (a relayed tx carries them inside its Delegate action). */
async function txCalls(t: Targets, hash: string, signer: string): Promise<FunctionCall[]> {
  const { body } = await getJson(t.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tilt-house",
      method: "tx",
      params: { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" },
    }),
  });
  const reply = record(body, "rpc");
  if (reply.error !== undefined) throw new Error(`RPC tx ${hash}: ${JSON.stringify(reply.error)}`);
  const actions = list(record(record(reply.result, "rpc.result").transaction, "transaction").actions, "actions");
  return actions.flatMap(functionCalls);
}

function functionCalls(action: unknown): FunctionCall[] {
  if (typeof action !== "object" || action === null) return [];
  if ("FunctionCall" in action) {
    const call = record(action.FunctionCall, "FunctionCall");
    const text = Buffer.from(str(call.args, "FunctionCall.args"), "base64").toString("utf8");
    let args: unknown = null;
    try {
      args = JSON.parse(text);
    } catch {
      // Not JSON: not one of ours.
    }
    return [{ method: str(call.method_name, "FunctionCall.method_name"), args }];
  }
  if ("Delegate" in action) {
    const inner = record(record(action.Delegate, "Delegate").delegate_action, "delegate_action");
    return list(inner.actions, "delegate_action.actions").flatMap(functionCalls);
  }
  return [];
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Finds a session's open, settle and close txs: the server's recent txs and the player's around
 * `opened_at`, each confirmed by reading its args back from RPC. Best effort: a miss is reported,
 * never guessed.
 */
export async function findSessionTxs(t: Targets, session: ChainSession): Promise<SessionTxs> {
  const found: SessionTxs = { open: null, settles: [], close: null, error: null };
  const from = session.opened_at - WINDOW_SLACK_SECS;
  const to = (session.closed_at || Math.floor(Date.now() / 1000)) + WINDOW_SLACK_SECS;
  try {
    const serverTxs = (await listTxs(t, t.serverAccount, from)).filter(
      (tx) => tx.at >= from && tx.at <= to && tx.methods.some((m) => m === "settle_session" || m === "close_session"),
    );
    for (const tx of serverTxs.slice(0, MAX_LOOKUPS)) {
      for (const call of await txCalls(t, tx.hash, tx.signer)) {
        if (call.method === "close_session" && field(call.args, "session_id") === session.id) found.close = tx.hash;
        const batch = field(call.args, "batch");
        if (call.method === "settle_session" && field(batch, "session_id") === session.id) {
          const rounds = list(field(batch, "rounds"), "batch.rounds").map((r, i) => parseCompactRound(r, `batch.rounds[${i}]`));
          found.settles.push({ hash: tx.hash, rounds });
        }
      }
    }
    // A relayed open is signed by the relayer on the player's behalf: the player's own list has it.
    const playerTxs = (await listTxs(t, session.player, from)).filter((tx) => tx.at >= from && tx.at <= session.opened_at + WINDOW_SLACK_SECS);
    for (const tx of playerTxs.slice(0, MAX_LOOKUPS)) {
      const calls = await txCalls(t, tx.hash, tx.signer);
      if (calls.some((c) => c.method === "open_session" && field(field(c.args, "ticket"), "session_id") === session.id)) {
        found.open = tx.hash;
        break;
      }
    }
  } catch (error) {
    found.error = errorMessage(error);
  }
  found.settles.sort((a, b) => (a.rounds[0]?.nonce ?? 0) - (b.rounds[0]?.nonce ?? 0));
  return found;
}
