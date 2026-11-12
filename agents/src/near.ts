import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, teraToGas, type KeyPairString } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";

export type GameKind = "dice" | "roulette" | "blackjack";

/** One entry of the house `get_lobby()` view. Amounts are token base units as decimal strings. */
export interface DealerView {
  id: string;
  name: string;
  game: GameKind;
  rake_bp: number;
  total_edge_bp: number;
  max_bet: string;
  min_bet: string;
  boost_until: number;
  reason: string;
  reason_text: string;
  open: boolean;
  bankroll: string;
  share_price_buy: string;
  share_price_sell: string;
  npc: boolean;
  autopilot: boolean;
  seated: boolean;
}

/** A change call signed by `signer`, to the house contract unless `receiver` says otherwise. */
export interface Call {
  signer: string;
  method: string;
  args: Record<string, unknown>;
  receiver?: string;
  /** In yoctoNEAR; token transfers need exactly 1. */
  deposit?: bigint;
}

/** Sends a call and returns the contract's JSON return value. */
export type Send = (call: Call) => Promise<unknown>;

/** Read-only views of the house contract; faked in tests. */
export interface House {
  lobby(): Promise<DealerView[]>;
  /** A player's in-contract balance (0 for an unknown player). */
  balance(accountId: string): Promise<bigint>;
  /** tUSDC held in the account's own wallet (on the token, not in the house). */
  wallet(accountId: string): Promise<bigint>;
  /** NPC gamblers registered in the floor (contract v3 `get_npcs`). */
  npcs(): Promise<string[]>;
  /** NEAR the account can spend (balance minus what its storage locks), yocto; null if it does not exist. */
  nearBalance(accountId: string): Promise<bigint | null>;
}

/** NEAR locked per byte of account storage (protocol storage staking cost). */
const YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;

/** `collect_rent` settles every seat in one call: it needs room. */
const BIG_GAS = teraToGas(200);
/**
 * Enough for `reprice`, `rent_bid` and token transfers, `ft_transfer_call` into the house included.
 * Kept low on purpose: a signer must hold prepaid gas × the maximum gas price (0.1 NEAR at 100 TGas),
 * and the NPC gamblers who deposit their own salary have small NEAR wallets.
 */
export const CALL_GAS = teraToGas(100);
const BIG_METHODS: readonly string[] = ["collect_rent"];

export function gasFor(method: string): bigint {
  return BIG_METHODS.includes(method) ? BIG_GAS : CALL_GAS;
}

const GAMES: readonly string[] = ["dice", "roulette", "blackjack"];
const DECIMAL = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field<T>(entry: Record<string, unknown>, key: string, check: (v: unknown) => v is T): T {
  const value = entry[key];
  if (!check(value)) throw new Error(`get_lobby: invalid ${key}`);
  return value;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isDecimal = (v: unknown): v is string => typeof v === "string" && DECIMAL.test(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isGame = (v: unknown): v is GameKind => typeof v === "string" && GAMES.includes(v);

function parseDealer(entry: unknown): DealerView {
  if (!isRecord(entry)) throw new Error("get_lobby: entry is not an object");
  return {
    id: field(entry, "id", isString),
    name: field(entry, "name", isString),
    game: field(entry, "game", isGame),
    rake_bp: field(entry, "rake_bp", isInt),
    total_edge_bp: field(entry, "total_edge_bp", isInt),
    max_bet: field(entry, "max_bet", isDecimal),
    min_bet: field(entry, "min_bet", isDecimal),
    boost_until: field(entry, "boost_until", isInt),
    reason: field(entry, "reason", isString),
    reason_text: field(entry, "reason_text", isString),
    open: field(entry, "open", isBool),
    bankroll: field(entry, "bankroll", isDecimal),
    share_price_buy: field(entry, "share_price_buy", isDecimal),
    share_price_sell: field(entry, "share_price_sell", isDecimal),
    npc: field(entry, "npc", isBool),
    autopilot: field(entry, "autopilot", isBool),
    seated: field(entry, "seated", isBool),
  };
}

export function parseLobby(value: unknown): DealerView[] {
  if (!Array.isArray(value)) throw new Error("get_lobby: not an array");
  return value.map(parseDealer);
}

/** `get_player` always returns an object (zeros for an unknown player). */
export function parseBalance(value: unknown): bigint {
  if (!isRecord(value) || !isDecimal(value.balance)) throw new Error("get_player: invalid balance");
  return BigInt(value.balance);
}

export function parseNpcs(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isString)) throw new Error("get_npcs: not a list of accounts");
  return value;
}

export function houseViews(provider: JsonRpcProvider, house: string, token: string): House {
  const view = (method: string, args: Record<string, unknown>, contractId = house) =>
    provider.callFunction({ contractId, method, args });
  return {
    async lobby() {
      return parseLobby(await view("get_lobby", {}));
    },
    async balance(accountId) {
      return parseBalance(await view("get_player", { account_id: accountId }));
    },
    async wallet(accountId) {
      const balance = await view("ft_balance_of", { account_id: accountId }, token);
      if (!isDecimal(balance)) throw new Error("ft_balance_of: invalid balance");
      return BigInt(balance);
    },
    async npcs() {
      return parseNpcs(await view("get_npcs", {}));
    },
    async nearBalance(accountId) {
      try {
        const account = await provider.viewAccount({ accountId });
        const locked = BigInt(account.storage_usage) * YOCTO_PER_BYTE;
        return account.amount > locked ? account.amount - locked : 0n;
      } catch (error) {
        if (error instanceof AccountDoesNotExistError) return null;
        throw error;
      }
    },
  };
}

function isKeyPairString(value: unknown): value is KeyPairString {
  return typeof value === "string" && (value.startsWith("ed25519:") || value.startsWith("secp256k1:"));
}

/** Loads `<dir>/<accountId>.json` (near-cli credentials format). */
export async function loadKeyPair(dir: string, accountId: string): Promise<KeyPair> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, `${accountId}.json`), "utf8"));
  const key = isRecord(parsed) ? parsed.private_key : undefined;
  if (!isKeyPairString(key)) throw new Error(`no private_key for ${accountId} in ${dir}`);
  return KeyPair.fromString(key);
}

/** Signs each call with the signer's own key from `keysDir`; accounts are cached per signer. */
export function nearSend(provider: JsonRpcProvider, house: string, keysDir: string): Send {
  const accounts = new Map<string, Promise<Account>>();
  const accountFor = (signer: string): Promise<Account> => {
    let account = accounts.get(signer);
    if (!account) {
      account = loadKeyPair(keysDir, signer).then((key) => new Account(signer, provider, new KeyPairSigner(key)));
      account.catch(() => accounts.delete(signer));
      accounts.set(signer, account);
    }
    return account;
  };
  return async ({ signer, method, args, receiver = house, deposit = 0n }) => {
    const account = await accountFor(signer);
    return account.callFunction({ contractId: receiver, methodName: method, args, gas: gasFor(method), deposit });
  };
}

/** Prints each call as one JSON line and sends nothing. */
export function dryRunSend(house: string, print: (line: string) => void): Send {
  return async ({ signer, method, args, receiver = house }) => {
    print(JSON.stringify({ dry_run: true, signer, receiver, method, args }));
    return undefined;
  };
}

export function sendFor(dryRun: boolean, provider: JsonRpcProvider, house: string, keysDir: string): Send {
  return dryRun ? dryRunSend(house, console.log) : nearSend(provider, house, keysDir);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
