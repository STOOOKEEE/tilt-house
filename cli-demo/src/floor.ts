import { formatBp, formatUsdc } from "../../web/src/format";
import { parseFloor, type FloorView } from "../../web/src/near/floor";
import { parseLobby, type DealerView } from "../../web/src/near/views";
import { getLiveFloor, type GamblerSnapshot } from "../../web/src/sim/gamblers";
import type { Targets } from "./args.ts";
import { view } from "./chain.ts";
import { accountLink, color, heading, line, table, money } from "./ui.ts";

export interface LiveFloor {
  floor: FloorView;
  dealers: DealerView[];
  gamblers: GamblerSnapshot[];
}

export async function readFloor(t: Targets): Promise<LiveFloor> {
  const [floor, lobby, gamblers] = await Promise.all([
    view(t, t.floor, "get_floor"),
    view(t, t.floor, "get_lobby"),
    getLiveFloor(t.session),
  ]);
  return { floor: parseFloor(floor), dealers: parseLobby(lobby), gamblers };
}

const signed = (value: string | null) => {
  if (value === null) return "—";
  const text = formatUsdc(BigInt(value));
  return value.startsWith("-") ? color.bad(text) : color.ok(`+${text}`);
};

/** Implicit accounts are 64 hex chars: keep the table readable. */
function shortAccount(id: string): string {
  return id.length > 24 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function minutesLeft(until: number, now: number): string {
  const minutes = Math.floor((until - now) / 60);
  // Past the prepaid time, rent accrues as `rent_owed` and is settled on the next interaction.
  return minutes >= 0 ? `${minutes} min` : color.dim("accruing");
}

export function printFloor({ floor, dealers, gamblers }: LiveFloor): void {
  const now = Math.floor(Date.now() / 1000);
  const byId = new Map(dealers.map((d) => [d.id, d]));
  heading("Floor");
  line(`jackpot ${color.money(money(floor.jackpot))} · rent to take a seat now ≥ ${money(floor.outbid_min)}/h · every rent payment goes to the jackpot`);
  const rows = [["seat", "table", "game", "owner", "rent/h", "prepaid", "edge", "max bet", "bankroll", "P&L 1h", "players 1h", "why this price"]];
  for (const seat of floor.seats) {
    const d = seat.dealer_id === null ? undefined : byId.get(seat.dealer_id);
    if (d === undefined) {
      rows.push([String(seat.seat + 1), color.dim("empty"), "", "", `${formatUsdc(seat.min_rent)} min`, "", "", "", "", "", "", ""]);
      continue;
    }
    rows.push([
      String(seat.seat + 1),
      color.bold(d.name),
      d.game,
      d.npc ? "NPC" : color.warn(shortAccount(d.controller ?? "player")),
      formatUsdc(seat.rent_per_hour),
      minutesLeft(seat.paid_until, now),
      formatBp(d.total_edge_bp),
      formatUsdc(d.max_bet),
      formatUsdc(d.bankroll),
      signed(d.pnl_1h),
      String(d.gamblers_1h ?? 0),
      color.dim(d.reason_text),
    ]);
  }
  table(rows);
  const off = dealers.filter((d) => d.seat === null);
  if (off.length > 0) line(color.dim(`off the floor: ${off.map((d) => `${d.name} (${d.game})`).join(", ")}`));

  if (gamblers.length === 0) {
    heading("NPC gamblers");
    line(color.dim("none on this floor right now"));
    return;
  }
  heading(`NPC gamblers on the floor (${gamblers.length}, each with its own wallet)`);
  const gamblerRows = [["gambler", "persona", "doing", "table", "balance", "session", "why"]];
  for (const g of gamblers) {
    gamblerRows.push([
      g.name ?? g.id,
      g.persona ?? "",
      g.state,
      g.dealer_id === null ? "" : (byId.get(g.dealer_id)?.name ?? g.dealer_id),
      formatUsdc(g.balance),
      g.session_net === "0" ? "" : signed(g.session_net),
      color.dim(g.reason ?? ""),
    ]);
  }
  table(gamblerRows);
  const first = `${gamblers[0]!.id}.tilthouse.testnet`;
  line(color.dim(`wallets are g-<name>.tilthouse.testnet, e.g. ${accountLink(first)}`));
  line(color.dim(`verify any of their sessions: pnpm --filter cli-demo verify-session --player ${first}`));
}
