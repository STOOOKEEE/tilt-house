import type { DealerView, House } from "../src/near.ts";

export function dealer(over: Partial<DealerView> & Pick<DealerView, "id" | "game">): DealerView {
  return {
    name: over.id,
    rake_bp: 200,
    total_edge_bp: 200,
    max_bet: "50000000",
    min_bet: "1000000",
    boost_until: 0,
    reason: "Steady",
    reason_text: "steady",
    open: true,
    bankroll: "1000000000",
    share_price_buy: "1000000",
    share_price_sell: "1000000",
    ...over,
  };
}

export const LOBBY: DealerView[] = [
  dealer({ id: "ace", game: "blackjack" }),
  dealer({ id: "dora", game: "dice", total_edge_bp: 300 }),
  dealer({ id: "dina", game: "dice", total_edge_bp: 150, open: false }),
  dealer({ id: "dex", game: "dice", total_edge_bp: 180 }),
  dealer({ id: "rita", game: "roulette", max_bet: "20000000" }),
  dealer({ id: "rex", game: "roulette", max_bet: "90000000" }),
];

export function fakeHouse(lobby: DealerView[], balance = 10_000_000n, rounds: unknown[] = []): House {
  return {
    lobby: async () => lobby,
    balance: async () => balance,
    round: async () => rounds.shift() ?? { status: "settled" },
  };
}
