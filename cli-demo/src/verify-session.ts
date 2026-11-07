import type { CompactRound } from "../../web/src/near/session-client";
import { parsePlayer } from "../../web/src/near/views";
import type { Targets } from "./args.ts";
import { findSessionTxs, getChainSession, getServerSession, view, type ChainSession, type SessionTxs } from "./chain.ts";
import { describeRound } from "./rounds.ts";
import { accountLink, BAD, color, heading, line, OK, txLink, usdc } from "./ui.ts";
import { settledRoundsProblem, verifyAgainstChain } from "./verify.ts";

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

/** Prints the whole check; true when every round replays against the on-chain commitment. */
export async function verifySessionById(t: Targets, sessionId: string): Promise<boolean> {
  const chain = await getChainSession(t, sessionId);
  if (chain === null) {
    line(`${BAD} no session ${sessionId} on ${t.floor} (a player keeps only its last 20 sessions in storage)`);
    return false;
  }
  heading(`Verifying session ${chain.id}`);
  line(`${color.bold(chain.player)} at ${color.bold(chain.dealer_id)} (${chain.game}), status ${chain.status}, lock ${usdc(chain.lock)}`);
  line(color.dim(`on chain: seed hash ${chain.server_seed_hash} · client seed ${chain.client_seed} · rake ${chain.rake_bp} bp`));
  line(color.dim(`          revealed seed ${chain.server_seed ?? "—"} · ${chain.settled_nonce} rounds settled · chain ${chain.chain}`));

  const [server, txs] = await Promise.all([getServerSession(t, sessionId), findSessionTxs(t, chain)]);
  const settleRounds = roundsFromSettles(txs, chain.settled_nonce);
  const rounds = server?.rounds ?? settleRounds;
  if (rounds === null) {
    line(`${BAD} no round list: the session server does not know this session and its settle txs are out of reach`);
    printTxs(chain, txs);
    return false;
  }
  line(color.dim(`rounds from ${server ? "the session server (untrusted: they must hash-chain to the chain's value)" : "the settle tx args"}`));

  const verdict = verifyAgainstChain(chain, rounds, server?.server_seed ?? null);
  const badNonce = verdict.ok ? null : verdict.nonce;
  printRounds(rounds, (r) => (verdict.ok ? OK : r.nonce === badNonce ? BAD : " "));

  const settled = txs.settles.flatMap((s) => s.rounds);
  const settleProblem = settledRoundsProblem(rounds, settled);
  if (settled.length > 0) {
    line(settleProblem === null ? `${OK} ${settled.length} rounds read back from settle tx args match` : `${BAD} ${settleProblem}`);
  }
  printTxs(chain, txs);

  if (!verdict.ok) {
    console.log(`\n  ${BAD} ${color.bad("NOT VERIFIED")}: ${verdict.error}`);
    return false;
  }
  const { summary } = verdict;
  line(`${OK} sha256(revealed seed) = on-chain commitment · ${summary.rounds} rounds replay bit for bit · hash chain ends on chain's`);
  line(`${OK} wagered ${usdc(summary.wagered)}, paid ${usdc(summary.paid)}, ${usdc(chain.lock)} → ${usdc(summary.balance)} paid out = chain` +
    (chain.jackpot_won !== "0" ? color.money(` · jackpot ${usdc(chain.jackpot_won)}`) : ""));
  if (settleProblem !== null) {
    console.log(`\n  ${BAD} ${color.bad("NOT VERIFIED")}: ${settleProblem}`);
    return false;
  }
  console.log(`\n  ${OK} ${color.ok("VERIFIED")} from on-chain data: every outcome follows from the seed committed before the first bet.`);
  return true;
}
