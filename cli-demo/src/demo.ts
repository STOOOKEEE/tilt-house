import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Account,
  actions,
  getTransactionLastResult,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  nearToYocto,
  teraToGas,
  type KeyPairString,
} from "near-api-js";
import { parseOptions, USAGE, type Options } from "./args.ts";
import { GAME_KEY_ALLOWANCE, GAME_METHODS, relayActions } from "./relay.ts";
import { verifyVrfProof, type VrfProof } from "./vrf.ts";

/** Sponsors a new named `.testnet` account (what `near account create-account sponsor-by-faucet-service` calls). */
const FAUCET_HELPER = "https://helper.nearprotocol.com/account";
const EXPLORER = "https://testnet.nearblocks.io";
const KEY_FILE = join(homedir(), ".tilt-house", "demo-key.json");

const TUSDC = 1_000_000n;
const DEPOSIT = 20n * TUSDC;
const STAKE = TUSDC / 10n;
const INVEST = 5n * TUSDC;
const CHANCE_BP = 4900;
const OVER = false;
/** NEAR the funder gives the sub-account: enough gas for every demo transaction. */
const FUNDER_GIFT = nearToYocto("0.5");
const ONE_YOCTO = 1n;
const CALL_GAS = teraToGas(100);
/** The house asks for ≥ 150 TGas on bets (OutLayer request + callback). */
const BET_GAS = teraToGas(200);
const POLL_MS = 2_000;
const BET_POLL_MS = 400;
const BET_VISIBLE_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 60_000;
const ACCOUNT_READY_TIMEOUT_MS = 30_000;

const STEPS = [
  "creating a throwaway testnet account",
  "getting test tUSDC from the relayer faucet",
  `depositing ${tusdc(DEPOSIT)} tUSDC into the house`,
  "reading the lobby",
  `playing one dice round (chance ${CHANCE_BP / 100}%, ${OVER ? "over" : "under"}, stake ${tusdc(STAKE)} tUSDC)`,
  `investing ${tusdc(INVEST)} tUSDC into that dealer, then divesting half the shares`,
  "summarising explorer links",
];

interface Tx {
  label: string;
  hash: string;
}

interface Dealer {
  id: string;
  game: string;
  totalEdgeBp: number;
  minBet: bigint;
  maxBet: bigint;
  open: boolean;
  reasonText: string;
  sharePriceBuy: bigint;
}

interface Round {
  status: string;
  roll: number | null;
  payout: string | null;
  error: string | null;
  proofs: (VrfProof & { step: number })[];
}

function step(n: number): void {
  console.log(`\nStep ${n}: ${STEPS[n - 1]}`);
}

function see(what: string): void {
  console.log(`See: ${what}`);
}

function tusdc(amount: bigint): string {
  const whole = amount / TUSDC;
  const frac = (amount % TUSDC).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const txLink = (hash: string) => `${EXPLORER}/txns/${hash}`;
const accountLink = (id: string) => `${EXPLORER}/address/${id}`;
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`unexpected contract response: ${key} is not a string`);
  return value;
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) throw new Error(`unexpected contract response: ${key} is not an integer`);
  return value as number;
}

function amount(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`unexpected ${what}: ${String(value)}`);
  return BigInt(value);
}

function parseDealer(entry: unknown): Dealer {
  if (!isRecord(entry)) throw new Error("get_lobby: entry is not an object");
  return {
    id: str(entry, "id"),
    game: str(entry, "game"),
    totalEdgeBp: num(entry, "total_edge_bp"),
    minBet: amount(entry.min_bet, "min_bet"),
    maxBet: amount(entry.max_bet, "max_bet"),
    open: entry.open === true,
    reasonText: str(entry, "reason_text"),
    sharePriceBuy: amount(entry.share_price_buy, "share_price_buy"),
  };
}

function parseProof(entry: unknown): VrfProof & { step: number } {
  if (!isRecord(entry)) throw new Error("get_round: proof is not an object");
  return {
    step: num(entry, "step"),
    alpha: str(entry, "alpha"),
    signature_hex: str(entry, "signature_hex"),
    output_hex: str(entry, "output_hex"),
  };
}

function parseRound(value: unknown): Round {
  if (!isRecord(value)) throw new Error("get_round: round not found");
  const proofs = value.proofs;
  return {
    status: str(value, "status"),
    roll: typeof value.roll === "number" ? value.roll : null,
    payout: typeof value.payout === "string" ? value.payout : null,
    error: typeof value.error === "string" ? value.error : null,
    proofs: Array.isArray(proofs) ? proofs.map(parseProof) : [],
  };
}

/** Lowest edge first; the stake must fit the table's bet range. */
export function pickDiceDealer(lobby: readonly Dealer[], stake: bigint): Dealer | undefined {
  return lobby
    .filter((d) => d.game === "dice" && d.open && d.minBet <= stake && stake <= d.maxBet)
    .sort((a, b) => a.totalEdgeBp - b.totalEdgeBp || a.id.localeCompare(b.id))[0];
}

function printLobby(lobby: readonly Dealer[]): void {
  const rows = [
    ["dealer", "game", "edge %", "max bet", "open", "reason"],
    ...lobby.map((d) => [
      d.id,
      d.game,
      (d.totalEdgeBp / 100).toFixed(2),
      tusdc(d.maxBet),
      d.open ? "yes" : "no",
      d.reasonText,
    ]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const row of rows) console.log("  " + row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
}

function newAccountId(options: Options): string {
  const tag = `tilt-demo-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  return options.funder ? `${tag}.${options.funder.accountId}` : `${tag}.testnet`;
}

async function saveKey(accountId: string, key: KeyPair): Promise<void> {
  await mkdir(join(homedir(), ".tilt-house"), { recursive: true, mode: 0o700 });
  const file = { account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() };
  await writeFile(KEY_FILE, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

async function waitForAccount(provider: JsonRpcProvider, accountId: string): Promise<void> {
  const deadline = Date.now() + ACCOUNT_READY_TIMEOUT_MS;
  for (;;) {
    try {
      await provider.viewAccount({ accountId });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`account ${accountId} not visible after 30 s: ${errorMessage(error)}`);
      await sleep(POLL_MS);
    }
  }
}

/** Step 1. Returns the transaction hash when the funder created it (the faucet helper returns none). */
async function createAccount(options: Options, provider: JsonRpcProvider, accountId: string, key: KeyPair) {
  const publicKey = key.getPublicKey();
  if (options.funder) {
    const signer = new KeyPairSigner(KeyPair.fromString(options.funder.key as KeyPairString));
    const funder = new Account(options.funder.accountId, provider, signer);
    const outcome = await funder.createAccount({ newAccountId: accountId, publicKey, nearToTransfer: FUNDER_GIFT });
    return outcome.transaction.hash;
  }
  const response = await fetch(FAUCET_HELPER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey.toString() }),
  });
  if (!response.ok) throw new Error(`faucet helper answered ${response.status}: ${await response.text()}`);
  await waitForAccount(provider, accountId);
  return undefined;
}

async function relayerFaucet(relayer: string, accountId: string): Promise<bigint> {
  const response = await fetch(`${relayer}/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body)) {
    const code = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(`relayer faucet refused: ${code}`);
  }
  return amount(body.minted, "minted amount");
}

function printPlan(options: Options): void {
  const accountId = newAccountId(options);
  console.log("Dry run: nothing is sent. Plan:");
  step(1);
  see(
    options.funder
      ? `${options.funder.accountId} would create ${accountId} with ${FUNDER_GIFT} yoctoNEAR`
      : `POST ${FAUCET_HELPER} {"newAccountId":"${accountId}","newAccountPublicKey":"ed25519:…"}`,
  );
  see(`the new key would be stored in ${KEY_FILE}`);
  step(2);
  see(options.relayer ? `POST ${options.relayer}/faucet {"accountId":"${accountId}"}` : "skipped: no RELAYER_URL");
  step(3);
  const deposit = { receiver_id: options.house, amount: DEPOSIT.toString(), msg: "" };
  see(`${options.token}.ft_transfer_call(${JSON.stringify(deposit)}), 1 yocto`);
  step(4);
  see(`${options.house}.get_lobby()`);
  step(5);
  const bet = { dealer_id: "<lowest-edge open dice dealer>", stake: STAKE.toString(), chance_bp: CHANCE_BP, over: OVER };
  see(`${options.house}.bet_dice(${JSON.stringify(bet)}), then get_round every ${POLL_MS / 1000} s for up to 60 s`);
  if (options.relayed) {
    see(`relayed: AddKey (game key for ${GAME_METHODS.join(", ")}) and bet_dice sent as SignedDelegates to ${options.relayer}/relay`);
  }
  see(`VRF proof checked locally against ${options.house}.get_config().vrf_pubkey_hex`);
  step(6);
  see(`${options.house}.invest({"dealer_id":"<same dealer>","amount":"${INVEST}"}), then divest(half the shares)`);
  step(7);
  see(`${accountLink(accountId)} and every transaction on ${EXPLORER}/txns/<hash>`);
}

async function run(options: Options): Promise<void> {
  const provider = new JsonRpcProvider({ url: options.rpcUrl });
  const view = (contractId: string, method: string, args: Record<string, unknown> = {}) =>
    provider.callFunction({ contractId, method, args });
  const txs: Tx[] = [];

  step(1);
  const accountId = newAccountId(options);
  const key = KeyPair.fromRandom("ed25519");
  await saveKey(accountId, key);
  const createdBy = await createAccount(options, provider, accountId, key);
  if (createdBy) txs.push({ label: "create account", hash: createdBy });
  const player = new Account(accountId, provider, new KeyPairSigner(key));
  const call = async (label: string, contractId: string, methodName: string, args: object, deposit = 0n, gas = CALL_GAS) => {
    const outcome = await player.callFunctionRaw({ contractId, methodName, args, deposit, gas });
    txs.push({ label, hash: outcome.transaction.hash });
    return { hash: outcome.transaction.hash, result: getTransactionLastResult(outcome) };
  };
  see(accountLink(accountId));
  see(`throwaway key stored in ${KEY_FILE} (testnet only)`);

  step(2);
  if (options.relayer) {
    const minted = await relayerFaucet(options.relayer, accountId);
    see(`minted ${tusdc(minted)} tUSDC to ${accountId}`);
  } else {
    see(`skipped: no RELAYER_URL (or --relayer). Send ≥ ${tusdc(DEPOSIT)} tUSDC to ${accountId} to continue.`);
  }
  const wallet = amount(await view(options.token, "ft_balance_of", { account_id: accountId }), "ft_balance_of");
  see(`wallet balance ${tusdc(wallet)} tUSDC`);

  step(3);
  if (wallet < DEPOSIT) {
    throw new Error(`${accountId} holds ${tusdc(wallet)} tUSDC, needs ${tusdc(DEPOSIT)}: run with --relayer <url>`);
  }
  const deposit = await call(
    "deposit",
    options.token,
    "ft_transfer_call",
    { receiver_id: options.house, amount: DEPOSIT.toString(), msg: "" },
    ONE_YOCTO,
  );
  if (amount(deposit.result, "ft_transfer_call result") !== DEPOSIT) throw new Error("the house refused the deposit");
  const player0 = await view(options.house, "get_player", { account_id: accountId });
  see(txLink(deposit.hash));
  see(`house balance ${tusdc(isRecord(player0) ? amount(player0.balance, "balance") : 0n)} tUSDC`);

  step(4);
  const lobbyRaw = await view(options.house, "get_lobby");
  if (!Array.isArray(lobbyRaw)) throw new Error("get_lobby: not an array");
  const lobby = lobbyRaw.map(parseDealer);
  printLobby(lobby);
  see(`${lobby.length} dealers, ${lobby.filter((d) => d.open).length} open`);

  step(5);
  const dealer = pickDiceDealer(lobby, STAKE);
  if (!dealer) throw new Error(`no open dice table takes a ${tusdc(STAKE)} tUSDC stake`);
  console.log(`  dealer: ${dealer.id} (edge ${(dealer.totalEdgeBp / 100).toFixed(2)}%)`);
  const betArgs = { dealer_id: dealer.id, stake: STAKE.toString(), chance_bp: CHANCE_BP, over: OVER };
  let roundId: unknown;
  // The contract binds the VRF alpha to the signer of the transaction that placed the bet.
  let vrfSigner = accountId;
  if (options.relayed && options.relayer) {
    // Browser-style session: a function-call key for the house, added and used through the relayer.
    const gameKey = KeyPair.fromRandom("ed25519");
    const addKeyAction = actions.addFunctionCallAccessKey(
      gameKey.getPublicKey(),
      options.house,
      [...GAME_METHODS],
      GAME_KEY_ALLOWANCE,
    );
    const addKey = await relayActions(options.relayer, player, accountId, [addKeyAction]);
    txs.push({ label: "add game key (relayed)", hash: addKey });
    see(`game key ${gameKey.getPublicKey().toString()} added, relayer tx ${txLink(addKey)}`);
    const gamePlayer = new Account(accountId, provider, new KeyPairSigner(gameKey));
    const betAction = actions.functionCall("bet_dice", betArgs, BET_GAS, 0n);
    const before = lastRound(await view(options.house, "get_player", { account_id: accountId }));
    const bet = await relayActions(options.relayer, gamePlayer, options.house, [betAction]);
    txs.push({ label: "dice bet (relayed)", hash: bet });
    see(`bet signed by the game key, relayer tx ${txLink(bet)}`);
    const betTx = await provider.viewTransactionStatus({ txHash: bet, accountId, waitUntil: "NONE" });
    vrfSigner = betTx.transaction.signer_id;
    see(`outer transaction signed (and gas paid) by ${vrfSigner}`);
    // The relayer answers a game move once it is in a block, before the bet runs: the new round
    // is the player's latest one as soon as it shows up.
    roundId = await waitForNewRound(view, options.house, accountId, before);
  } else {
    const bet = await call("dice bet", options.house, "bet_dice", betArgs, 0n, BET_GAS);
    roundId = bet.result;
    see(txLink(bet.hash));
  }
  if (typeof roundId !== "number") throw new Error(`no round id after bet_dice: ${String(roundId)}`);
  const round = await waitForRound(view, options.house, roundId);
  await reportRound(round, roundId, vrfSigner, options, view, call);

  step(6);
  const invested = await call("invest", options.house, "invest", { dealer_id: dealer.id, amount: INVEST.toString() });
  const shares = amount(invested.result, "invest result");
  console.log(`  share price (buy): ${tusdc(dealer.sharePriceBuy)}× launch price`);
  console.log(`  LP shares received: ${shares}`);
  see(txLink(invested.hash));
  const half = shares / 2n;
  const divested = await call("divest", options.house, "divest", { dealer_id: dealer.id, shares: half.toString() });
  console.log(`  divested ${half} shares: ${tusdc(amount(divested.result, "divest result"))} tUSDC back to the balance`);
  see(txLink(divested.hash));

  step(7);
  see(accountLink(accountId));
  for (const tx of txs) see(`${tx.label}: ${txLink(tx.hash)}`);
}

type View = (contractId: string, method: string, args?: Record<string, unknown>) => Promise<unknown>;

function lastRound(player: unknown): number | null {
  return isRecord(player) && typeof player.last_round === "number" ? player.last_round : null;
}

async function waitForNewRound(view: View, house: string, accountId: string, before: number | null): Promise<number> {
  const deadline = Date.now() + BET_VISIBLE_TIMEOUT_MS;
  for (;;) {
    const latest = lastRound(await view(house, "get_player", { account_id: accountId }));
    if (latest !== null && latest !== before) return latest;
    if (Date.now() > deadline) throw new Error(`bet_dice made no new round after ${BET_VISIBLE_TIMEOUT_MS / 1000} s`);
    await sleep(BET_POLL_MS);
  }
}

async function waitForRound(view: View, house: string, roundId: number): Promise<Round> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const round = parseRound(await view(house, "get_round", { round_id: roundId }));
    if (round.status !== "waiting_vrf" || Date.now() > deadline) return round;
    await sleep(POLL_MS);
  }
}

async function reportRound(
  round: Round,
  roundId: number,
  vrfSigner: string,
  options: Options,
  view: View,
  call: (label: string, contractId: string, methodName: string, args: object) => Promise<{ hash: string }>,
): Promise<void> {
  console.log(`  round ${roundId}: ${round.status}`);
  if (round.status === "waiting_vrf") {
    see(`OutLayer has not answered after 60 s; anyone may call refund_stuck_round after 120 s`);
    return;
  }
  if (round.status === "failed") {
    console.log(`  VRF step failed: ${round.error ?? "unknown"}; refunding the stake`);
    const refund = await call("refund", options.house, "refund_stuck_round", { round_id: roundId });
    see(txLink(refund.hash));
    return;
  }
  const config = await view(options.house, "get_config");
  if (!isRecord(config)) throw new Error("get_config: not an object");
  const pubkey = str(config, "vrf_pubkey_hex");
  console.log(`  roll: ${round.roll ?? "?"} (wins ${OVER ? "over" : "under"} ${CHANCE_BP})`);
  console.log(`  payout: ${round.payout === null ? "?" : tusdc(amount(round.payout, "payout"))} tUSDC`);
  for (const proof of round.proofs) {
    const verdict = verifyVrfProof(proof, pubkey, vrfSigner, `round-${roundId}-${proof.step}`);
    console.log(`  VRF output: ${proof.output_hex}`);
    console.log(`  alpha: ${proof.alpha}`);
    console.log(`  signature: ${proof.signature_hex}`);
    see(`local verification with OutLayer key ${pubkey}: ${verdict.ok ? "VALID" : `INVALID (${verdict.reason})`}`);
  }
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`${errorMessage(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  console.log(`Tilt House demo on NEAR testnet: house ${options.house}, token ${options.token}`);
  if (options.dryRun) return printPlan(options);
  await run(options);
}

main().catch((error: unknown) => {
  console.error(`\nDemo stopped: ${errorMessage(error)}`);
  process.exitCode = 1;
});
