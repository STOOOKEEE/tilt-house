/**
 * The judge's tour, end to end on testnet: a throwaway account, a deposit, the live floor, three
 * provably fair sessions (dice, multi-spot roulette, blackjack) through the public session server,
 * then every round re-verified from on-chain data.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, PublicKey, type KeyPairString } from "near-api-js";
import { handTotal } from "../../web/src/house";
import { callAction, MOVE_GAS } from "../../web/src/near/delegate";
import { activate, claimFaucet, relay } from "../../web/src/near/relay";
import {
  checkNextState,
  NOT_OPEN_YET,
  randomClientSeed,
  SessionError,
  sessionClient,
  ticketProblem,
  verifySession,
  verifyTicket,
  type BjAction,
  type CompactRound,
  type RoundReply,
  type SignedState,
} from "../../web/src/near/session-client";
import { amount, parsePlayer, record, str, type Bet, type DealerView, type Game } from "../../web/src/near/views";
import type { Command, Funder, Targets } from "./args.ts";
import { getChainSession, view } from "./chain.ts";
import { printFloor, readFloor } from "./floor.ts";
import { describeRound, handText } from "./rounds.ts";
import { accountLink, BAD, color, errorMessage, heading, line, OK, txLink, usdc } from "./ui.ts";
import { verifySessionById } from "./verify-session.ts";

type DemoCommand = Extract<Command, { name: "demo" }>;

const ACCOUNT_FILE = join(homedir(), ".tilt-house", "cli-demo-account.json");
const TUSDC = 1_000_000n;
/** Locked per session; the three sessions run one after the other. */
const LOCK = 5n * TUSDC;
const DEPOSIT = 20n * TUSDC;
const DICE_STAKE = TUSDC / 10n;
const BJ_STAKE = TUSDC / 5n;
const ONE_YOCTO = 1n;
/** What the funder gives the account: gas for every demo tx, sent directly. */
const FUNDER_NEAR = nearToYocto("1");
/** `storage_deposit` on the token, NEP-145 minimum for an FT account. */
const TOKEN_STORAGE = nearToYocto("0.00125");
// The relayer refuses delegates valid for more than 600 blocks; ~2 minutes is plenty.
const DELEGATE_TTL_BLOCKS = 120;
const KEY_VISIBLE_TRIES = 10;
const OPEN_RETRIES = 30;
const POLL_MS = 1_500;
const CHAIN_CLOSE_TIMEOUT_MS = 120_000;
/** NearBlocks indexes a few seconds behind the chain; the verifier reads the tx list from it. */
const INDEXER_LAG_MS = 8_000;

const DICE_BETS: readonly { chance_bp: number; over: boolean }[] = [
  { chance_bp: 4_900, over: false },
  { chance_bp: 2_500, over: true },
  { chance_bp: 7_500, over: false },
  { chance_bp: 9_000, over: true },
];
const DICE_ROUNDS = 12;
/** One spin per number: a straight up, a split, a corner and red, settled by one draw. */
const ROULETTE_NUMBERS = [17, 0, 32, 5, 23, 11, 36];

function rouletteSpin(straight: number): { bet: Bet; stake: bigint } {
  const spots = [
    { bet: { straight }, stake: 100_000n },
    { bet: { split: [7, 10] as [number, number] }, stake: 100_000n },
    { bet: { corner: 8 }, stake: 100_000n },
    { bet: "red" as const, stake: 200_000n },
  ];
  return {
    bet: { roulette_spots: spots.map((s) => ({ bet: s.bet, stake: s.stake.toString() })) },
    stake: spots.reduce((sum, s) => sum + s.stake, 0n),
  };
}

const ROULETTE_STAKE = rouletteSpin(0).stake;

type Send = (receiverId: string, method: string, args: object, deposit: bigint) => Promise<string>;

interface Player {
  accountId: string;
  account: Account;
  send: Send;
}

interface Played {
  sessionId: string;
  game: Game;
  openTx: string;
  latencies: number[];
}

// ---- account ------------------------------------------------------------------------------

async function loadKey(): Promise<{ accountId: string; key: KeyPair } | null> {
  let text: string;
  try {
    text = await readFile(ACCOUNT_FILE, "utf8");
  } catch {
    return null;
  }
  const file = record(JSON.parse(text) as unknown, ACCOUNT_FILE);
  return {
    accountId: str(file.account_id, "account_id"),
    key: KeyPair.fromString(str(file.private_key, "private_key") as KeyPairString),
  };
}

async function saveKey(accountId: string, key: KeyPair): Promise<void> {
  await mkdir(dirname(ACCOUNT_FILE), { recursive: true, mode: 0o700 });
  const file = { account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() };
  await writeFile(ACCOUNT_FILE, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/** A just-created account's key reaches `final` a block or two after the funding tx. */
async function whenKeyVisible<T>(sign: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sign();
    } catch (error) {
      const missing = /access key .* does not exist|does not exist while viewing/i.test(errorMessage(error));
      if (!missing || attempt >= KEY_VISIBLE_TRIES) throw error;
      await sleep(POLL_MS);
    }
  }
}

/** Gas-free for the player: every tx is a NEP-366 delegate the public relayer pays for. */
function relayedSend(t: Targets, account: Account): Send {
  return async (receiverId, method, args, deposit) => {
    const { signedDelegate } = await whenKeyVisible(() =>
      account.createSignedMetaTransaction({
        receiverId,
        actions: [callAction(method, args, deposit)],
        blockHeightTtl: DELEGATE_TTL_BLOCKS,
      }),
    );
    return (await relay(t.relayer, signedDelegate)).txHash;
  };
}

function directSend(account: Account): Send {
  return async (contractId, methodName, args, deposit) => {
    const outcome = await whenKeyVisible(() => account.callFunctionRaw({ contractId, methodName, args, deposit, gas: MOVE_GAS }));
    return outcome.transaction.hash;
  };
}

async function fundWithFunder(t: Targets, provider: JsonRpcProvider, funder: Funder, player: Player): Promise<void> {
  const funderAccount = new Account(funder.accountId, provider, new KeyPairSigner(KeyPair.fromString(funder.key as KeyPairString)));
  const gift = await funderAccount.transfer({ receiverId: player.accountId, amount: FUNDER_NEAR });
  line(`${OK} ${funder.accountId} sent 1 NEAR for gas ${color.dim(txLink(gift.transaction.hash))}`);
  const storage = await player.send(t.token, "storage_deposit", { account_id: player.accountId, registration_only: true }, TOKEN_STORAGE);
  line(`${OK} registered on ${t.token} ${color.dim(txLink(storage))}`);
  const held = BigInt(amount(await view(t, t.token, "ft_balance_of", { account_id: funder.accountId }), "ft_balance_of"));
  if (held < DEPOSIT) return;
  const sent = await funderAccount.callFunctionRaw({
    contractId: t.token,
    methodName: "ft_transfer",
    args: { receiver_id: player.accountId, amount: DEPOSIT.toString() },
    deposit: ONE_YOCTO,
  });
  line(`${OK} ${funder.accountId} sent ${usdc(DEPOSIT)} ${color.dim(txLink(sent.transaction.hash))}`);
}

async function accountExists(provider: JsonRpcProvider, accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

async function setUpPlayer(cmd: DemoCommand, provider: JsonRpcProvider): Promise<Player> {
  const t = cmd.targets;
  heading("Account");
  const stored = cmd.fresh ? null : await loadKey();
  const key = stored?.key ?? KeyPair.fromRandom("ed25519");
  // An implicit account: its id is its public key, so it exists as soon as it holds NEAR.
  const accountId = stored?.accountId ?? Buffer.from(key.getPublicKey().data).toString("hex");
  if (!stored) await saveKey(accountId, key);
  const account = new Account(accountId, provider, new KeyPairSigner(key));
  const player = { accountId, account, send: cmd.funder ? directSend(account) : relayedSend(t, account) };
  line(`${stored ? "reusing" : "new"} throwaway account ${color.bold(accountId)}`);
  line(color.dim(`key in ${ACCOUNT_FILE} (testnet only; --new for a fresh one) · ${accountLink(accountId)}`));
  if (await accountExists(provider, accountId)) return player;
  if (cmd.funder) {
    await fundWithFunder(t, provider, cmd.funder, player);
  } else {
    await activate(t.relayer, accountId);
    line(`${OK} the relayer activated it: gas money, token registration, 100 tUSDC ${color.dim(`(POST ${t.relayer}/activate)`)}`);
  }
  return player;
}

async function floorBalance(t: Targets, accountId: string): Promise<bigint> {
  return BigInt(parsePlayer(await view(t, t.floor, "get_player", { account_id: accountId })).balance);
}

async function ensureBalance(t: Targets, player: Player): Promise<void> {
  heading("Deposit");
  const before = await floorBalance(t, player.accountId);
  if (before >= LOCK) {
    line(`${OK} floor balance ${usdc(before)}, enough for the sessions`);
    return;
  }
  const walletOf = async () => BigInt(amount(await view(t, t.token, "ft_balance_of", { account_id: player.accountId }), "ft_balance_of"));
  let wallet = await walletOf();
  if (wallet < LOCK - before) {
    const minted = await claimFaucet(t.relayer, player.accountId);
    line(`${OK} faucet: +${usdc(minted)} ${color.dim(`(POST ${t.relayer}/faucet, once an hour)`)}`);
    wallet = await walletOf();
  }
  const deposit = wallet < DEPOSIT ? wallet : DEPOSIT;
  const hash = await player.send(t.token, "ft_transfer_call", { receiver_id: t.floor, amount: deposit.toString(), msg: "" }, ONE_YOCTO);
  for (let i = 0; (await floorBalance(t, player.accountId)) < before + deposit; i++) {
    if (i > 20) throw new Error(`the floor did not credit the deposit ${hash}`);
    await sleep(POLL_MS);
  }
  line(`${OK} deposited ${usdc(deposit)} into ${t.floor} (ft_transfer_call) ${color.dim(txLink(hash))}`);
}

// ---- sessions ------------------------------------------------------------------------------

function pickTable(dealers: readonly DealerView[], game: Game, stake: bigint): DealerView | undefined {
  return dealers
    .filter((d) => d.game === game && d.open && d.seat !== null && BigInt(d.min_bet) <= stake && stake <= BigInt(d.max_bet))
    .sort((a, b) => a.total_edge_bp - b.total_edge_bp || a.id.localeCompare(b.id))[0];
}

function serverKeyHex(publicKey: string): string {
  return Buffer.from(PublicKey.fromString(publicKey).data).toString("hex");
}

/** The basic hit-under-17 player: enough to show a hand played move by move. */
function nextAction(reply: RoundReply): BjAction {
  const cards = reply.hand?.state.player ?? [];
  return handTotal(cards).total < 17 ? "hit" : "stand";
}

async function playSession(
  t: Targets,
  player: Player,
  dealer: DealerView,
  serverKey: string,
  moves: readonly { bet: Bet; stake: bigint }[],
): Promise<Played> {
  const client = sessionClient(t.session);
  heading(`Session at ${dealer.name} (${dealer.game}, seat ${(dealer.seat ?? 0) + 1}, edge ${(dealer.total_edge_bp / 100).toFixed(2)} %)`);
  const clientSeed = randomClientSeed();
  const started = await client.start({ player: player.accountId, dealer_id: dealer.id, lock: LOCK, client_seed: clientSeed });
  // Fail closed before any money moves: right key, right ticket, start state = ticket.
  if (serverKeyHex(started.server_public_key) !== serverKey) throw new Error("the session server's key is not the one the contract trusts");
  if (!verifyTicket(started.server_public_key, started.ticket, started.ticket_signature)) throw new Error("bad ticket signature");
  const problem = ticketProblem(started.ticket, { player: player.accountId, dealer, lock: LOCK, clientSeed });
  if (problem) throw new Error(problem);
  if (started.state.nonce !== 0 || started.state.chain !== started.ticket.server_seed_hash || started.state.balance !== started.ticket.lock) {
    throw new Error("the server's start state does not match its ticket");
  }
  line(`${OK} ticket ${color.bold(started.session_id)} signed by the key in the contract config · seed hash ${color.dim(started.ticket.server_seed_hash)}`);
  const openAt = performance.now();
  const openTx = await player.send(t.floor, "open_session", { ticket: started.ticket, server_sig: started.ticket_signature }, 0n);
  line(`${OK} open_session on chain in ${Math.round(performance.now() - openAt)} ms, ${usdc(LOCK)} escrowed ${color.dim(txLink(openTx))}`);

  let state: SignedState = started.state;
  const rounds: CompactRound[] = [];
  const latencies: number[] = [];
  /** One request, timed; retried only while the server has not seen the open tx yet. */
  const send = async (move: Parameters<typeof client.play>[3]): Promise<RoundReply> => {
    for (let attempt = 1; ; attempt++) {
      const at = performance.now();
      try {
        const reply = await client.play(started.session_id, started.token, state.nonce + 1, move);
        latencies.push(performance.now() - at);
        return reply;
      } catch (error) {
        if (!(error instanceof SessionError && error.status === NOT_OPEN_YET) || attempt >= OPEN_RETRIES) throw error;
        await sleep(POLL_MS / 3);
      }
    }
  };
  const ms = () => color.dim(`${Math.round(latencies.at(-1) ?? 0)} ms`);
  const accept = (reply: RoundReply): CompactRound => {
    if (!reply.done || reply.round === null) throw new Error("the server did not finish the round");
    const bad = checkNextState(started.server_public_key, state, reply.round, reply.state);
    if (bad) throw new Error(`round ${reply.round.nonce} refused: ${bad}`);
    state = reply.state;
    rounds.push(reply.round);
    return reply.round;
  };

  for (const move of moves) {
    let reply = await send(move);
    if (move.bet === "blackjack") {
      while (!reply.done) {
        if (reply.hand === null || reply.state.nonce !== state.nonce) throw new Error("the server moved the state mid-hand");
        const action = nextAction(reply);
        line(color.dim(`   ${handText(reply.hand.state)} → ${action}`) + `  ${ms()}`);
        reply = await send({ action });
      }
    }
    const round = accept(reply);
    line(`${describeRound(round)}  ${OK} ${color.dim("signed state checked")}  ${ms()}`);
  }

  const closed = await client.close(started.session_id, started.token);
  if (closed.state.nonce !== state.nonce || closed.state.chain !== state.chain) throw new Error("the server closed on a state other than our last one");
  const local = verifySession(closed.server_seed, started.ticket, rounds, state);
  if (!local.ok) throw new Error(`revealed seed does not replay: ${local.error}`);
  line(`${OK} closed: seed revealed, ${rounds.length} rounds replay locally · balance ${usdc(LOCK)} → ${usdc(state.balance)}`);
  for (let waited = 0; (await getChainSession(t, started.session_id))?.status !== "closed"; waited += POLL_MS) {
    if (waited > CHAIN_CLOSE_TIMEOUT_MS) throw new Error("the server did not settle and close on chain within 2 minutes");
    await sleep(POLL_MS);
  }
  line(`${OK} the server settled and revealed on chain; the escrow is back in the floor balance`);
  return { sessionId: started.session_id, game: dealer.game, openTx, latencies };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

export async function runDemo(cmd: DemoCommand): Promise<boolean> {
  const t = cmd.targets;
  console.log(color.title(`Tilt House demo · NEAR testnet · ${t.floor}`));
  const provider = new JsonRpcProvider({ url: t.rpcUrl });
  const player = await setUpPlayer(cmd, provider);
  const open = parsePlayer(await view(t, t.floor, "get_player", { account_id: player.accountId })).open_session;
  if (open !== null) throw new Error(`session ${open} is still open for this account (a crashed run?): the server closes idle sessions; retry later or use --new`);
  await ensureBalance(t, player);

  const live = await readFloor(t);
  printFloor(live);
  const config = record(await view(t, t.floor, "get_config"), "config");
  const serverKey = str(config.server_pubkey_hex, "config.server_pubkey_hex").toLowerCase();

  const plans: { game: Game; stake: bigint; moves: { bet: Bet; stake: bigint }[] }[] = [
    {
      game: "dice",
      stake: DICE_STAKE,
      moves: Array.from({ length: DICE_ROUNDS }, (_, i) => ({ bet: { dice: DICE_BETS[i % DICE_BETS.length]! }, stake: DICE_STAKE })),
    },
    { game: "roulette", stake: ROULETTE_STAKE, moves: ROULETTE_NUMBERS.map(rouletteSpin) },
    { game: "blackjack", stake: BJ_STAKE, moves: [{ bet: "blackjack", stake: BJ_STAKE }] },
  ];
  const played: Played[] = [];
  for (const plan of plans) {
    const dealer = pickTable(live.dealers, plan.game, plan.stake);
    if (!dealer) {
      heading(`No ${plan.game} session`);
      line(color.warn(`skipped: no seated, open ${plan.game} table takes a ${usdc(plan.stake)} bet right now (tables lose their seat when outbid or short of rent)`));
      continue;
    }
    played.push(await playSession(t, player, dealer, serverKey, plan.moves));
  }

  heading("Independent verification from on-chain data (same code as verify-session)");
  await sleep(INDEXER_LAG_MS);
  const verified: boolean[] = [];
  for (const p of played) verified.push(await verifySessionById(t, p.sessionId));

  const latencies = played.flatMap((p) => p.latencies);
  // A game without a seated table is skipped (the economy decides who holds a seat), not failed.
  const allOk = played.length > 0 && verified.every(Boolean);
  heading("Summary");
  line(`${latencies.length} instant requests over ${played.length} sessions: median ${Math.round(percentile(latencies, 0.5))} ms, p90 ${Math.round(percentile(latencies, 0.9))} ms, max ${Math.round(Math.max(...latencies))} ms`);
  line(`floor balance now ${usdc(await floorBalance(t, player.accountId))} · ${accountLink(player.accountId)}`);
  for (const [i, p] of played.entries()) {
    line(`${verified[i] ? OK : BAD} ${p.game.padEnd(9)} ${p.sessionId}  re-check: pnpm --filter cli-demo verify-session ${p.sessionId}`);
  }
  console.log(allOk ? `\n  ${OK} ${color.ok("Demo complete: every round verified against the chain.")}` : `\n  ${BAD} ${color.bad("Demo incomplete")}`);
  return allOk;
}
