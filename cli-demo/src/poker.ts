/**
 * Multiplayer hold'em on testnet from a terminal (docs/poker-api.md): two throwaway accounts sit at
 * the cheapest seated poker table with the NPC bots its seat rule calls in, play N hands through the
 * public session server, leave, and every hand is then re-verified: revealed seed against its
 * commitment, deck from the seeds, legal replay, and each session round against the chain.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonRpcProvider } from "near-api-js";
import {
  actionProblem,
  pokerClient,
  verifyHand,
  type LastHand,
  type PokerClient,
  type TableState,
} from "../../web/src/near/poker-client";
import { categoryOf, PokerHand, type Legal, type PokerAction } from "../../web/src/near/poker-rules";
import {
  checkNextState,
  randomClientSeed,
  SessionError,
  sessionClient,
  ticketProblem,
  verifyTicket,
  type SignedState,
} from "../../web/src/near/session-client";
import { parsePlayer, record, str, type DealerView } from "../../web/src/near/views";
import { targetFlags, type Command, type Targets } from "./args.ts";
import { getArchivedHand, getChainSession, view } from "./chain.ts";
import { ensureBalance, floorBalance, serverKeyHex, setUpPlayer, type Player } from "./demo.ts";
import { readFloor } from "./floor.ts";
import { formatUsdc } from "../../web/src/format";
import { accountLink, BAD, color, heading, line, money, OK, txLink } from "./ui.ts";
import { verifySessionById } from "./verify-session.ts";

type PokerCommand = Extract<Command, { name: "poker" }>;

const TUSDC = 1_000_000n;
/** Each player's buy-in (the session lock): 25 big blinds at 0.1/0.2. */
const BUY_IN = 5n * TUSDC;
/** The share of a dealer's max bet a ticket carries (session server `ticket_max_bet`). */
const TICKET_MAX_BET_PCT = 80n;
const LABELS = ["A", "B"] as const;
const POLL_MS = 400;
/** NPCs to call in, a seeding, 20 s clocks: a hand can take a while. */
const HAND_TIMEOUT_MS = 180_000;
const JOIN_TIMEOUT_MS = 60_000;
/** The server stands up, settles and reveals on chain; its tick retries with backoff. */
const CHAIN_CLOSE_TIMEOUT_MS = 300_000;
/** NearBlocks indexes a few seconds behind the chain; the verifier reads the tx list from it. */
const INDEXER_LAG_MS = 8_000;
/** Calls up to this many big blinds; folds to anything bigger. */
const CALL_LIMIT_BB = 4n;

interface Seated {
  label: (typeof LABELS)[number];
  player: Player;
  sessionId: string;
  token: string;
  serverKey: string;
  openTx: string;
  seat: number | null;
  /** Latest signed state checked round by round. */
  state: SignedState;
  /** Hole cards as this player saw them, by hand number. */
  holes: Map<number, string[]>;
  /** Client seed sent per hand number. */
  seeds: Map<number, string>;
  left: boolean;
}

const chips = (amount: string | bigint) => formatUsdc(amount);

function actionText(action: PokerAction): string {
  if (typeof action === "object") return `raise to ${chips(action.raise_to)}`;
  return action.replace("_", " ");
}

/**
 * A simple legal player. A opens every pot it can for the minimum raise preflop; both check when
 * free, call up to `CALL_LIMIT_BB` big blinds, fold to more. Always checked against `legal`.
 */
function decide(seat: Seated, legal: Legal, state: TableState): PokerAction {
  const bigBlind = BigInt(state.config.big_blind);
  const hand = state.hand;
  const unopened = hand?.phase === "preflop" && BigInt(hand.current_bet) === bigBlind;
  if (seat.label === "A" && unopened && legal.raise) return { raise_to: legal.raise.min_to };
  if (legal.can_check) return "check";
  return legal.call <= CALL_LIMIT_BB * bigBlind ? "call" : "fold";
}

/** The cheapest seated, open poker table that takes our buy-in. */
async function pickTable(t: Targets, poker: PokerClient): Promise<DealerView> {
  const [live, served] = await Promise.all([readFloor(t), poker.tables()]);
  const candidates = live.dealers
    .filter((d) => d.game === "poker" && d.open && d.seat !== null)
    .filter((d) => served.some((s) => s.table_id === d.id && BigInt(s.min_buy_in) <= BUY_IN && BUY_IN <= BigInt(s.max_buy_in)))
    .filter((d) => (BigInt(d.max_bet) * TICKET_MAX_BET_PCT) / 100n >= BUY_IN)
    .sort((a, b) => a.rake_bp - b.rake_bp || a.id.localeCompare(b.id));
  const best = candidates[0];
  if (!best) throw new Error(`no seated, open poker table takes a ${money(BUY_IN)} buy-in right now`);
  return best;
}

async function sit(t: Targets, player: Player, label: Seated["label"], dealer: DealerView, serverKey: string): Promise<Seated> {
  const client = sessionClient(t.session);
  const poker = pokerClient(t.session);
  const clientSeed = randomClientSeed();
  const started = await client.start({ player: player.accountId, dealer_id: dealer.id, lock: BUY_IN, client_seed: clientSeed });
  // Fail closed before any money moves: right key, right ticket, start state = ticket.
  if (serverKeyHex(started.server_public_key) !== serverKey) throw new Error("the session server's key is not the one the contract trusts");
  if (!verifyTicket(started.server_public_key, started.ticket, started.ticket_signature)) throw new Error("bad ticket signature");
  const problem = ticketProblem(started.ticket, { player: player.accountId, dealer, lock: BUY_IN, clientSeed });
  if (problem) throw new Error(problem);
  if (started.state.nonce !== 0 || started.state.chain !== started.ticket.server_seed_hash || started.state.balance !== started.ticket.lock) {
    throw new Error("the server's start state does not match its ticket");
  }
  const openTx = await player.send(t.floor, "open_session", { ticket: started.ticket, server_sig: started.ticket_signature }, 0n);
  line(`${OK} ${label}: session ${color.bold(started.session_id)} · ${money(BUY_IN)} buy-in escrowed by open_session ${color.dim(txLink(openTx))}`);
  const deadline = Date.now() + JOIN_TIMEOUT_MS;
  for (;;) {
    try {
      const joined = await poker.join(dealer.id, started.token, started.session_id, null);
      line(`${OK} ${label}: ${joined.seat === null ? "queued for a bot's seat" : `seat ${joined.seat + 1}`}, dealt in from the next hand`);
      break;
    } catch (error) {
      // 409 until the open tx is final on chain.
      if (!(error instanceof SessionError && error.status === 409 && /not open on chain/.test(error.message)) || Date.now() > deadline) throw error;
      await sleep(1_000);
    }
  }
  return {
    label,
    player,
    sessionId: started.session_id,
    token: started.token,
    serverKey: started.server_public_key,
    openTx,
    seat: null,
    state: started.state,
    holes: new Map(),
    seeds: new Map(),
    left: false,
  };
}

/** One look at the table for one player: seed, act, check the signed state. */
async function step(poker: PokerClient, tableId: string, seat: Seated, state: TableState): Promise<void> {
  const { you, hand } = state;
  if (you === null) {
    if (!seat.left) throw new Error(`${seat.label} was stood up by the table`);
    seat.seat = null;
    return;
  }
  seat.seat = you.seat;
  // Privacy: while a hand is live, no other seat's cards are visible to this player.
  if (hand !== null && hand.to_act !== null && state.seats.some((s) => s !== null && s.seat !== you.seat && s.cards !== null)) {
    throw new Error(`${seat.label} can see someone else's cards mid-hand`);
  }
  if (you.state !== null && you.last_round !== null && you.state.nonce === seat.state.nonce + 1) {
    const bad = checkNextState(seat.serverKey, seat.state, you.last_round, you.state);
    if (bad) throw new Error(`${seat.label}: hand round ${you.last_round.nonce} refused: ${bad}`);
    seat.state = you.state;
  }
  if (hand === null || you.seat === null || !hand.seats.includes(you.seat)) return;
  if (you.hole !== null) seat.holes.set(hand.number, you.hole);
  if (hand.phase === "seeding" && !hand.seeds_in.includes(you.seat) && !seat.seeds.has(hand.number)) {
    const clientSeed = randomClientSeed();
    seat.seeds.set(hand.number, clientSeed);
    await tolerate(poker.seed(tableId, seat.token, hand.number, clientSeed));
  }
  if (you.legal !== null && !seat.left) {
    const action = decide(seat, you.legal, state);
    const problem = actionProblem(you.legal, action);
    if (problem) throw new Error(`${seat.label}'s strategy chose an illegal ${actionText(action)}: ${problem}`);
    await tolerate(poker.act(tableId, seat.token, hand.number, action));
  }
}

/** The table moves on its own clock: a move that arrives late is refused (409), not an error. */
async function tolerate(move: Promise<unknown>): Promise<void> {
  try {
    await move;
  } catch (error) {
    if (!(error instanceof SessionError && error.status === 409)) throw error;
  }
}

/** Prints a revealed hand compactly; false when it does not verify. */
function printHand(hand: LastHand, ours: readonly Seated[]): boolean {
  const { history, result } = hand;
  const nameOf = (seat: number) => {
    const p = hand.players.find((x) => x.seat === seat);
    const mine = ours.find((s) => s.sessionId === p?.session_id);
    if (mine) return color.bold(mine.label);
    return p ? `${p.name}${p.npc ? color.dim("(bot)") : ""}` : `seat ${seat + 1}`;
  };
  heading(`Hand ${hand.number} · button ${nameOf(history.start.button)} · commitment ${hand.commitment.slice(0, 16)}…`);
  for (const p of hand.players) {
    const mine = ours.find((s) => s.sessionId === p.session_id);
    if (!mine) continue;
    const saw = mine.holes.get(hand.number);
    if (saw !== undefined && saw.join(" ") !== p.hole.join(" ")) {
      line(`${BAD} ${mine.label} was shown ${saw.join(" ")} but the seed deals ${p.hole.join(" ")}`);
      return false;
    }
    line(`${color.bold(mine.label)} seat ${p.seat + 1}  ${color.bold(p.hole.join(" "))}  ${color.dim(`${p.player.slice(0, 6)}…${p.player.slice(-4)}`)}`);
  }
  const bots = hand.players.filter((p) => p.npc).map((p) => `${p.name} (seat ${p.seat + 1})`);
  if (bots.length) line(color.dim(`bots: ${bots.join(", ")}`));
  // Replay move by move to put each action on its street.
  const replay = new PokerHand(history.start, Buffer.from(history.hand_seed, "hex"));
  const [sb, bb] = replay.blindSeats();
  const streets = new Map<string, string[]>([["preflop", [`${nameOf(sb)} sb ${chips(history.start.config.small_blind)}`, `${nameOf(bb)} bb ${chips(history.start.config.big_blind)}`]]]);
  for (const { seat, action } of history.actions) {
    const street = replay.street;
    replay.act(seat, action);
    streets.set(street, [...(streets.get(street) ?? []), `${nameOf(seat)} ${actionText(action)}`]);
  }
  for (const [street, moves] of streets) line(`${street.padEnd(8)} ${moves.join(" · ")}`);
  line(`board    ${result.board.join(" ") || "—"}`);
  const pot = result.seats.reduce((sum, s) => sum + BigInt(s.put_in), 0n);
  const won = result.seats.reduce((sum, s) => sum + BigInt(s.won), 0n);
  const winners = result.seats
    .filter((s) => BigInt(s.won) > 0n)
    .map((s) => `${nameOf(s.seat)} +${chips(s.won)}${s.value !== null ? ` (${categoryOf(s.value)})` : ""}`);
  line(`pot ${money(pot)} · rake ${chips(result.rake)} · ${result.showdown ? "showdown" : "no showdown"} · winner ${winners.join(", ")}`);
  const check = verifyHand(hand);
  const conserved = pot === won + BigInt(result.rake);
  if (!check.ok || !conserved) {
    line(`${BAD} ${check.ok ? "chips not conserved" : check.error}`);
    return false;
  }
  line(`${OK} ${color.dim(`seed ↔ commitment · deck from ${history.start.seats.length} client seeds · legal replay · history hash · chips in ${chips(pot)} = out ${chips(won)} + rake ${chips(result.rake)}`)}`);
  return true;
}

async function waitClosedOnChain(t: Targets, seated: readonly Seated[]): Promise<void> {
  const deadline = Date.now() + CHAIN_CLOSE_TIMEOUT_MS;
  for (const s of seated) {
    while ((await getChainSession(t, s.sessionId))?.status !== "closed") {
      if (Date.now() > deadline) throw new Error(`the server did not settle and close ${s.sessionId} on chain in time`);
      await sleep(1_500);
    }
    line(`${OK} ${s.label}: settled and revealed on chain; the stack is back in the floor balance (${money(await floorBalance(t, s.player.accountId))})`);
  }
}

export async function runPoker(cmd: PokerCommand): Promise<boolean> {
  const t = cmd.targets;
  console.log(color.title(`Tilt House poker · NEAR testnet · ${t.floor}`));
  const provider = new JsonRpcProvider({ url: t.rpcUrl });
  const players: Player[] = [];
  for (const label of LABELS) {
    const player = await setUpPlayer(cmd, provider, join(homedir(), ".tilt-house", `cli-poker-${label.toLowerCase()}.json`), `Player ${label}`);
    const open = parsePlayer(await view(t, t.floor, "get_player", { account_id: player.accountId })).open_session;
    if (open !== null) throw new Error(`session ${open} is still open for ${label} (a crashed run?): the server closes it soon; retry later or use --new`);
    await ensureBalance(t, player, BUY_IN, `Player ${label} deposit`);
    players.push(player);
  }

  const poker = pokerClient(t.session);
  const dealer = await pickTable(t, poker);
  heading(`Table ${dealer.name} (${dealer.id}, floor seat ${(dealer.seat ?? 0) + 1}, rake ${(dealer.rake_bp / 100).toFixed(2)} %)`);
  const config = record(await view(t, t.floor, "get_config"), "config");
  const serverKey = str(config.server_pubkey_hex, "config.server_pubkey_hex").toLowerCase();
  const seated: Seated[] = [];
  for (const [i, label] of LABELS.entries()) seated.push(await sit(t, players[i]!, label, dealer, serverKey));

  const hands = new Map<number, LastHand>();
  const ours = (hand: LastHand) => hand.players.some((p) => seated.some((s) => s.sessionId === p.session_id));
  let played = 0;
  let verifiedHands = true;
  let deadline = Date.now() + HAND_TIMEOUT_MS;
  line(color.dim(`waiting for the bots the seat rule calls in and the first deal…`));
  // Play until N of our hands are over, then leave and keep watching until both are stood up
  // (a hand left mid-way still ends, and becomes a round in the leaver's session).
  while (seated.some((s) => !s.left || s.seat !== null)) {
    if (Date.now() > deadline) throw new Error("the table stopped dealing");
    for (const s of seated) await step(poker, dealer.id, s, await poker.state(dealer.id, s.token, null));
    const last = (await poker.state(dealer.id, null, null)).last_hand;
    if (last !== null && !hands.has(last.number)) {
      hands.set(last.number, last);
      if (ours(last)) {
        verifiedHands = printHand(last, seated) && verifiedHands;
        played += 1;
        deadline = Date.now() + HAND_TIMEOUT_MS;
      }
    }
    if (played >= cmd.hands && seated.some((s) => !s.left)) {
      heading("Leaving");
      for (const s of seated) {
        const { left } = await poker.leave(dealer.id, s.token);
        s.left = true;
        line(`${OK} ${s.label}: ${left ? "stood up" : "folds at its turn, stood up when this hand ends"}; the server closes the session`);
      }
    }
    await sleep(POLL_MS);
  }

  heading("Settle and reveal on chain");
  await waitClosedOnChain(t, seated);

  heading("The server's hand archive");
  // What anyone can replay later must be the hands as they were played here.
  let archiveOk = true;
  for (const hand of [...hands.values()].filter(ours)) {
    const archived = await getArchivedHand(t, dealer.id, hand.number);
    const same = archived !== null && archived.history_hash === hand.history_hash;
    archiveOk &&= same;
    line(`${same ? OK : BAD} hand ${hand.number} ${same ? "archived as played" : "missing or different"} ${color.dim(`${t.session}/poker/tables/${dealer.id}/hands/${hand.number}`)}`);
  }

  heading("Independent verification from on-chain data (same code as verify-session)");
  await sleep(INDEXER_LAG_MS);
  const verified: boolean[] = [];
  for (const s of seated) verified.push(await verifySessionById(t, s.sessionId));

  heading("Summary");
  const allOk = verifiedHands && archiveOk && verified.every(Boolean) && played >= cmd.hands;
  line(`${played} hands played at ${dealer.name}, ${[...hands.values()].filter(ours).length} revealed and replayed`);
  for (const [i, s] of seated.entries()) {
    line(`${verified[i] ? OK : BAD} ${s.label} ${s.sessionId} · open ${txLink(s.openTx)}`);
    line(color.dim(`   ${accountLink(s.player.accountId)} · re-check: pnpm --filter cli-demo verify-session ${s.sessionId}${targetFlags(t)}`));
  }
  console.log(allOk ? `\n  ${OK} ${color.ok("VERIFIED: every hand replays from its revealed seed and every round matches the chain.")}` : `\n  ${BAD} ${color.bad("NOT VERIFIED")}`);
  return allOk;
}
