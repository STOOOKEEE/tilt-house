import type { DealerView, House } from "../src/near.ts";

export function dealer(over: Partial<DealerView> & Pick<DealerView, "id" | "game">): DealerView {
  return {
    name: over.id,
    rake_bp: 200,
    total_edge_bp: 200,
    max_bet: "50000000",
    min_bet: "1000000",
    boost_until: 0,
    reason: "steady",
    reason_text: "steady",
    open: true,
    bankroll: "1000000000",
    share_price_buy: "1000000",
    share_price_sell: "1000000",
    npc: true,
    autopilot: true,
    seated: true,
    ...over,
  };
}

export const LOBBY: DealerView[] = [
  dealer({ id: "ace", game: "blackjack" }),
  dealer({ id: "dora", game: "dice", total_edge_bp: 300 }),
  dealer({ id: "dina", game: "dice", total_edge_bp: 150, open: false }),
  dealer({ id: "dex", game: "dice", total_edge_bp: 180, npc: false, autopilot: false }),
  dealer({ id: "rita", game: "roulette", max_bet: "20000000" }),
  dealer({ id: "rex", game: "roulette", max_bet: "90000000" }),
  dealer({ id: "otto", game: "dice", seated: false }),
];

export interface FakeChainState {
  balances?: Record<string, bigint>;
  wallets?: Record<string, bigint>;
  npcs?: string[];
  /** NEAR per account; missing = the account does not exist. */
  near?: Record<string, bigint>;
}

export function fakeHouse(lobby: DealerView[], { balances = {}, wallets = {}, npcs = [], near = {} }: FakeChainState = {}): House {
  return {
    lobby: async () => lobby,
    balance: async (accountId) => balances[accountId] ?? 0n,
    wallet: async (accountId) => wallets[accountId] ?? 0n,
    npcs: async () => npcs,
    nearBalance: async (accountId) => near[accountId] ?? null,
  };
}
