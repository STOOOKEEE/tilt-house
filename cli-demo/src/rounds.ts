import { cardLabel, handTotal, pocketColor, rouletteBetLabel } from "../../web/src/house";
import { roundWager, rouletteSpots, type CompactRound } from "../../web/src/near/session-client";
import type { Bet, BlackjackHand } from "../../web/src/near/views";
import { color, usdc } from "./ui.ts";

function betText(bet: Bet, stake: string): string {
  if (bet === "blackjack") return "blackjack";
  if ("dice" in bet) return `dice ${bet.dice.over ? "over" : "under"} ${(bet.dice.chance_bp / 100).toFixed(2)}%`;
  if ("poker" in bet) return `poker ${bet.poker.table} hand ${bet.poker.hand}`;
  return `roulette ${rouletteSpots(bet, stake).map((spot) => rouletteBetLabel(spot.bet)).join(" + ")}`;
}

export function handText(hand: BlackjackHand): string {
  const side = (cards: number[]) => `${cards.map(cardLabel).join(" ")} (${handTotal(cards).total})`;
  return `you ${side(hand.player)} · dealer ${side(hand.dealer)}`;
}

/** One line: bet, outcome, wager → payout. */
export function describeRound(round: CompactRound): string {
  const outcome = round.outcome;
  const result =
    "dice" in outcome
      ? `roll ${outcome.dice.roll}`
      : "roulette" in outcome
        ? `pocket ${outcome.roulette.pocket} ${pocketColor(outcome.roulette.pocket)}`
        : "poker" in outcome
          ? `seat ${outcome.poker.seat + 1} · board ${outcome.poker.board.join(" ") || "—"}`
          : `${handText(outcome.blackjack)}${round.actions.length ? ` [${round.actions.join(",")}]` : ""}`;
  const payout = BigInt(round.payout);
  const paid = payout > 0n ? color.ok(`paid ${usdc(payout)}`) : color.dim("lost");
  return `#${String(round.nonce).padStart(2, "0")} ${betText(round.bet, round.stake)} · ${result} · ${usdc(roundWager(round))} → ${paid}`;
}
