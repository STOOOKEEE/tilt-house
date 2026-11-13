import type { CompactRound } from "../../web/src/near/session-client";
import { parsePlayer } from "../../web/src/near/views";
import type { Targets } from "./args.ts";
import type { LastHand } from "../../web/src/near/poker-client";
import { archiveStart, findSessionTxs, getArchivedHand, getChainSession, getServerSession, view, type ChainSession, type SessionTxs } from "./chain.ts";
import { describeRound } from "./rounds.ts";
import { accountLink, BAD, color, count, heading, line, OK, txLink, money } from "./ui.ts";
import { pokerReplayer, settledRoundsProblem, unarchivedRounds, verifyAgainstChain } from "./verify.ts";

/** Beyond this, the round list is shortened to its head and tail. */
const ROUNDS_SHOWN = 24;

/**
 * The player's newest closed session that has rounds, else its newest closed one
 * (`get_player.sessions` is oldest first; a gambler often sits, looks and leaves without betting).
 */
export async function latestClosedSession(t: Targets, player: string): Promise<string> {
  const { sessions } = parsePlayer(await view(t, t.floor, "get_player", { account_id: player }));
  let emptyOne: string | null = null;
  for (const id of [...sessions].reverse()) {
    const session = await getChainSession(t, id);
    if (session?.status !== "closed") continue;
    if (session.settled_nonce > 0) return id;
    emptyOne ??= id;
  }
  if (emptyOne !== null) return emptyOne;
  throw new Error(`${player} has no closed session on ${t.floor}`);
}

/** The hands a poker session's rounds name, from the session server's archive. */
async function archivedHands(t: Targets, chain: ChainSession, rounds: readonly CompactRound[]): Promise<Map<number, LastHand>> {
  const hands = new Map<number, LastHand>();
  for (const { bet } of rounds) {
    if (bet === "blackjack" || !("poker" in bet) || hands.has(bet.poker.hand)) continue;
    const hand = await getArchivedHand(t, chain.dealer_id, bet.poker.hand);
    if (hand !== null) hands.set(bet.poker.hand, hand);
  }
  return hands;
}

/** Settle txs cover every round once, in order: then they alone are a full round list. */
function roundsFromSettles(txs: SessionTxs, settledNonce: number): CompactRound[] | null {
  const rounds = txs.settles.flatMap((s) => s.rounds);
  return rounds.length === settledNonce && rounds.every((r, i) => r.nonce === i + 1) ? rounds : null;
}

function printRounds(rounds: readonly CompactRound[], mark: (round: CompactRound) => string): void {
  const shown = rounds.length > ROUNDS_SHOWN ? [...rounds.slice(0, ROUNDS_SHOWN - 4), null, ...rounds.slice(-4)] : rounds;
  for (const round of shown) {
    line(round === null ? color.dim(`… ${rounds.length - ROUNDS_SHOWN} more`) : `${mark(round)} ${describeRound(round)}`);
  }
}

function printTxs(chain: ChainSession, txs: SessionTxs): void {
  const link = (label: string, hash: string | null) =>
    line(`${label.padEnd(7)} ${hash === null ? color.dim("not found in the indexer's latest txs") : txLink(hash)}`);
  link("open", txs.open);
  if (txs.settles.length === 0 && chain.settled_nonce > 0) link("settle", null);
  for (const s of txs.settles) {
    line(`${"settle".padEnd(7)} ${txLink(s.hash)} ${color.dim(`(rounds ${s.rounds[0]?.nonce ?? "?"}–${s.rounds.at(-1)?.nonce ?? "?"})`)}`);
  }
  link("close", txs.close);
  if (txs.error) line(color.warn(`tx lookup stopped: ${txs.error}`));
  line(color.dim(`player ${accountLink(chain.player)}`));
}

/**
 * Prints the whole check; true when every round replays against the on-chain commitment. Poker
 * rounds replay from their hands (`replayPoker`; by default the session server's hand archive).
 */
export async function verifySessionById(
  t: Targets,
  sessionId: string,
  replayPoker?: (round: CompactRound) => CompactRound,
): Promise<boolean> {
  const chain = await getChainSession(t, sessionId);
  if (chain === null) {
    line(`${BAD} no session ${sessionId} on ${t.floor} (a player keeps only its last 20 sessions in storage)`);
    return false;
  }
  heading(`Verifying session ${chain.id}`);
  line(`${color.bold(chain.player)} at ${color.bold(chain.dealer_id)} (${chain.game}), status ${chain.status}, lock ${money(chain.lock)}`);
  line(color.dim(`on chain: seed hash ${chain.server_seed_hash} · client seed ${chain.client_seed} · rake ${chain.rake_bp} bp`));
  line(color.dim(`          revealed seed ${chain.server_seed ?? "—"} · ${count(chain.settled_nonce, "round")} settled · chain ${chain.chain}`));

  const [server, txs] = await Promise.all([getServerSession(t, sessionId), findSessionTxs(t, chain)]);
  const settleRounds = roundsFromSettles(txs, chain.settled_nonce);
  const rounds = server?.rounds ?? settleRounds;
  if (rounds === null) {
    line(`${BAD} no round list: the session server does not know this session and its settle txs are out of reach`);
    printTxs(chain, txs);
    return false;
  }
  line(color.dim(`rounds from ${server ? "the session server (untrusted: they must hash-chain to the chain's value)" : "the settle tx args"}`));

  let replay = replayPoker;
  let unarchived = new Set<number>();
  let archiveStartMs = Infinity;
  if (chain.game === "poker" && replay === undefined) {
    const hands = await archivedHands(t, chain, rounds);
    archiveStartMs = (await archiveStart(t, chain.dealer_id)) ?? Infinity;
    unarchived = unarchivedRounds(rounds, hands, chain.closed_at * 1000, archiveStartMs);
    line(color.dim(`${count(hands.size, "hand")} from the server's archive (untrusted: each must replay from its revealed seed into its round)`));
    const fromArchive = pokerReplayer(hands, chain.dealer_id, chain.player);
    // Without its history a round is taken as is: still hash-chained, balanced and paid as the chain says.
    replay = (round) => (unarchived.has(round.nonce) ? round : fromArchive(round));
  }
  const verdict = verifyAgainstChain(chain, rounds, server?.server_seed ?? null, replay);
  const badNonce = verdict.ok ? null : verdict.nonce;
  const NOT_REPLAYED = color.dim("–");
  printRounds(rounds, (r) => (r.nonce === badNonce ? BAD : !verdict.ok ? " " : unarchived.has(r.nonce) ? NOT_REPLAYED : OK));

  const settled = txs.settles.flatMap((s) => s.rounds);
  const settleProblem = settledRoundsProblem(rounds, settled);
  if (settled.length > 0) {
    line(settleProblem === null ? `${OK} ${count(settled.length, "round")} read back from settle tx args match` : `${BAD} ${settleProblem}`);
  }
  printTxs(chain, txs);

  if (!verdict.ok) {
    console.log(`\n  ${BAD} ${color.bad("NOT VERIFIED")}: ${verdict.error}`);
    return false;
  }
  const { summary } = verdict;
  const replayed = summary.rounds - unarchived.size;
  const replayText = unarchived.size === 0 ? `${count(replayed, "round")} replayed bit for bit` : `${replayed} of ${count(summary.rounds, "round")} replayed`;
  line(`${OK} sha256(revealed seed) = on-chain commitment · ${replayText} · hash chain ends on chain's`);
  line(`${OK} wagered ${money(summary.wagered)}, paid ${money(summary.paid)}, ${money(chain.lock)} → ${money(summary.balance)} paid out = chain` +
    (chain.jackpot_won !== "0" ? color.money(` · jackpot ${money(chain.jackpot_won)}`) : ""));
  if (settleProblem !== null) {
    console.log(`\n  ${BAD} ${color.bad("NOT VERIFIED")}: ${settleProblem}`);
    return false;
  }
  if (unarchived.size > 0) {
    const before = new Date(Math.min(archiveStartMs, chain.closed_at * 1000)).toISOString().replace(".000Z", "Z");
    line(`– hand history not archived (played before ${before}): rounds checked against the chain only`);
    console.log(`\n  ${OK} ${color.ok("CHECKED AGAINST THE CHAIN")}: rounds, hash chain, totals and payout match; not replayed: ${count(unarchived.size, "round")} without a hand history.`);
    return true;
  }
  const why =
    chain.game === "poker"
      ? "every round is its hand's replay from a seed committed before the deal"
      : "every outcome follows from the seed committed before the first bet";
  console.log(`\n  ${OK} ${color.ok("VERIFIED")} from on-chain data: ${why}.`);
  return true;
}
