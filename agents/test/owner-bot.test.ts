import { describe, expect, it } from "vitest";
import { decide, investAmount, loadBotConfig, maxBetAdjust, offerFor, parseAsks, parseFloorRents, parseOwnedTable, rebid, rentRaise, shouldAnswer, SKIP_CHANCE, type Ask, type FloorRents, type OwnedTable } from "../src/owner-bot.ts";

const NOW = 1_794_660_000;
const TUSDC = 1_000_000n;
const MAX_RENT = 3n * TUSDC;

function table(over: Partial<OwnedTable> = {}): OwnedTable {
  return {
    id: "test-1",
    game: "dice",
    controller: "test-owner-1.tilthouse.testnet",
    seat: 6,
    rent: 1_100_000n,
    cooldownUntil: 0,
    free: 450n * TUSDC,
    worstCaseMultiple: 100n,
    maxBet: 1n * TUSDC,
    rakeBp: 300,
    baseEdgeBp: 0,
    lastBoostAt: 0,
    ...over,
  };
}

const FLOOR: FloorRents = { lowestRent: 1_000_000n, outbidMin: 1_100_000n };

function ask(over: Partial<Ask>): Ask {
  return { gambler: "g-mia", dealerId: "test-1", want: "lower_edge", edgeBp: 200, maxBet: null, until: NOW + 20, ...over };
}

describe("shouldAnswer", () => {
  it("answers at most half of the asks", () => {
    const tally = { seen: 0, answered: 0 };
    for (let i = 0; i < 100; i++) {
      tally.seen += 1;
      if (shouldAnswer(tally, 0.99)) tally.answered += 1;
      expect(tally.answered * 2).toBeLessThanOrEqual(tally.seen);
    }
    expect(tally.answered).toBe(50);
  });

  it("leaves the first ask to the floor and lets some go at random", () => {
    expect(shouldAnswer({ seen: 1, answered: 0 }, 0.99)).toBe(false);
    expect(shouldAnswer({ seen: 2, answered: 0 }, 0.99)).toBe(true);
    expect(shouldAnswer({ seen: 2, answered: 0 }, SKIP_CHANCE / 2)).toBe(false);
  });
});

describe("offerFor", () => {
  it("cuts the rake to the edge asked, other terms kept", () => {
    expect(offerFor(table(), ask({ edgeBp: 200 }), NOW)).toEqual({ dealer_id: "test-1", rake_bp: 200, max_bet: "1000000", boost_secs: 0 });
    // Roulette: rake = edge − its 2.70 % base.
    expect(offerFor(table({ game: "roulette", baseEdgeBp: 270, rakeBp: 230, worstCaseMultiple: 36n }), ask({ edgeBp: 400 }), NOW)?.rake_bp).toBe(130);
  });

  it("never goes under the game's minimum or above the current rake", () => {
    expect(offerFor(table(), ask({ edgeBp: 90 }), NOW)).toBeNull(); // dice cannot go under 1 %
    expect(offerFor(table({ rakeBp: 150 }), ask({ edgeBp: 200 }), NOW)).toBeNull(); // already there
  });

  it("raises the max bet up to half of what the pool covers", () => {
    expect(offerFor(table(), ask({ want: "higher_max_bet", maxBet: 2n * TUSDC }), NOW)?.max_bet).toBe("2000000");
    // 450 tUSDC free / ×100 worst case = 4.5 tUSDC cap: the bot keeps half, 2.25.
    expect(offerFor(table(), ask({ want: "higher_max_bet", maxBet: 25n * TUSDC }), NOW)?.max_bet).toBe("2250000");
    expect(offerFor(table({ maxBet: 2_250_000n }), ask({ want: "higher_max_bet", maxBet: 25n * TUSDC }), NOW)).toBeNull();
  });

  it("boosts 15 min at most once an hour", () => {
    expect(offerFor(table(), ask({ want: "boost" }), NOW)?.boost_secs).toBe(900);
    expect(offerFor(table({ lastBoostAt: NOW - 1800 }), ask({ want: "boost" }), NOW)).toBeNull();
    expect(offerFor(table({ lastBoostAt: NOW - 3600 }), ask({ want: "boost" }), NOW)?.boost_secs).toBe(900);
  });

  it("lets an ask about to expire go", () => {
    expect(offerFor(table(), ask({ until: NOW + 3 }), NOW)).toBeNull();
  });
});

describe("rent", () => {
  it("raises ~10 % only when its rent is the floor's lowest", () => {
    expect(rentRaise(table(), { lowestRent: 1_100_000n, outbidMin: 1_210_000n }, MAX_RENT)).toBe(1_210_000n);
    expect(rentRaise(table(), FLOOR, MAX_RENT)).toBeNull();
    expect(rentRaise(table({ seat: null, rent: null }), FLOOR, MAX_RENT)).toBeNull();
  });

  it("stays under the cap and within what the pool can prepay", () => {
    const lowest = { lowestRent: 2_900_000n, outbidMin: 3_190_000n };
    expect(rentRaise(table({ rent: 2_900_000n }), lowest, MAX_RENT)).toBeNull();
    expect(rentRaise(table({ free: 2n * TUSDC }), { lowestRent: 1_100_000n, outbidMin: 1_210_000n }, MAX_RENT)).toBeNull();
  });

  it("bids again when evicted, once the cooldown is over", () => {
    const evicted = table({ seat: null, rent: null, cooldownUntil: NOW + 60 });
    expect(rebid(evicted, FLOOR, MAX_RENT, NOW)).toBeNull();
    expect(rebid(evicted, FLOOR, MAX_RENT, NOW + 60)).toBe(1_100_000n);
    expect(rebid(table(), FLOOR, MAX_RENT, NOW)).toBeNull();
    expect(rebid(evicted, { lowestRent: 3n * TUSDC, outbidMin: 3_300_000n }, MAX_RENT, NOW + 60)).toBeNull();
  });
});

describe("investAmount", () => {
  it("invests the whole balance once the free bankroll covers under 2 h of rent", () => {
    expect(investAmount(table({ free: 2_000_000n }), FLOOR, 50n * TUSDC)).toBe(50n * TUSDC);
    expect(investAmount(table({ free: 2_200_000n }), FLOOR, 50n * TUSDC)).toBe(0n);
    expect(investAmount(table({ seat: null, rent: null, free: 2_000_000n }), FLOOR, 50n * TUSDC)).toBe(50n * TUSDC);
    expect(investAmount(table({ free: 0n }), FLOOR, 0n)).toBe(0n);
  });
});

describe("maxBetAdjust", () => {
  it("keeps the max bet at half of what the pool covers, rake kept", () => {
    // 450 tUSDC free / ×100 (dice) = 4.5 cap → 2.25; roulette ×36 = 12.5 cap → 6.25.
    expect(maxBetAdjust(table())).toEqual({ dealer_id: "test-1", rake_bp: 300, max_bet: "2250000", boost_secs: 0 });
    expect(maxBetAdjust(table({ game: "roulette", worstCaseMultiple: 36n, maxBet: 170_000n, rakeBp: 79 }))).toMatchObject({ rake_bp: 79, max_bet: "6250000" });
  });

  it("cuts a max bet pinned at the cap, which would refuse concurrent players", () => {
    expect(maxBetAdjust(table({ maxBet: 4_500_000n }))?.max_bet).toBe("2250000");
    expect(maxBetAdjust(table({ maxBet: 4_050_001n }))?.max_bet).toBe("2250000");
  });

  it("leaves a max bet inside 40-90 % of the cap alone, and never offers under the minimum bet", () => {
    expect(maxBetAdjust(table({ maxBet: 1_800_000n }))).toBeNull();
    expect(maxBetAdjust(table({ maxBet: 4_050_000n }))).toBeNull();
    expect(maxBetAdjust(table({ maxBet: 1_799_999n }))?.max_bet).toBe("2250000");
    expect(maxBetAdjust(table({ maxBet: 50_000n, free: 15n * TUSDC }))).toBeNull();
  });
});

describe("decide", () => {
  it("does one thing per pass: the ask first, then the seat, then the bankroll", () => {
    const weakest = { lowestRent: 1_100_000n, outbidMin: 1_210_000n };
    expect(decide(table(), weakest, ask({}), true, 0n, MAX_RENT, NOW)?.method).toBe("set_offer");
    expect(decide(table(), weakest, ask({}), false, 0n, MAX_RENT, NOW)).toMatchObject({ method: "bid_for_seat", args: { rent_per_hour: "1210000" } });
    expect(decide(table({ seat: null, rent: null }), FLOOR, null, false, 0n, MAX_RENT, NOW)).toMatchObject({ method: "bid_for_seat", why: "off the floor" });
    expect(decide(table({ free: 2_000_000n }), FLOOR, null, false, 5n * TUSDC, MAX_RENT, NOW)).toMatchObject({ method: "invest", args: { amount: "5000000" } });
    expect(decide(table(), FLOOR, null, false, 5n * TUSDC, MAX_RENT, NOW)).toMatchObject({ method: "set_offer", args: { max_bet: "2250000" } });
    expect(decide(table({ maxBet: 2_250_000n }), FLOOR, null, false, 5n * TUSDC, MAX_RENT, NOW)).toBeNull();
  });
});

describe("parsing", () => {
  it("reads its table from get_lobby", () => {
    const entry = {
      id: "test-2", game: "roulette", controller: "test-owner-2.tilthouse.testnet", seat: null, rent_per_hour: null, cooldown_until: 7,
      bankroll: "100", reserved: "30", worst_case_multiple: "36", max_bet: "100000", offer_rake_bp: 230, base_edge_bp: 270, last_boost_at: 0,
    };
    expect(parseOwnedTable(entry)).toMatchObject({ id: "test-2", seat: null, rent: null, free: 70n, worstCaseMultiple: 36n, rakeBp: 230 });
    expect(() => parseOwnedTable({ ...entry, bankroll: 5 })).toThrow(/bankroll/);
    expect(() => parseOwnedTable(undefined)).toThrow();
  });

  it("reads the floor's rents", () => {
    expect(parseFloorRents({ lowest_rent: "1100000", outbid_min: "1210000" })).toEqual({ lowestRent: 1_100_000n, outbidMin: 1_210_000n });
    expect(parseFloorRents({ lowest_rent: null, outbid_min: "1500000" }).lowestRent).toBeNull();
    expect(() => parseFloorRents({ lowest_rent: null })).toThrow();
  });

  it("keeps the asks at its own tables", () => {
    const feed = [
      { id: "g-mia", hesitating: { dealer_id: "test-1", rival_id: "ada", want: "higher_max_bet", edge_bp: null, max_bet: "25000000", until: NOW } },
      { id: "g-noah", hesitating: { dealer_id: "someone-else", want: "boost", edge_bp: null, max_bet: null, until: NOW } },
      { id: "g-zoe", hesitating: null },
      { id: "g-kai" },
    ];
    expect(parseAsks(feed, ["test-1", "test-2"])).toEqual([{ gambler: "g-mia", dealerId: "test-1", want: "higher_max_bet", edgeBp: null, maxBet: 25_000_000n, until: NOW }]);
    expect(() => parseAsks([{ id: "g-mia", hesitating: { dealer_id: "test-1", want: "free drinks", until: NOW } }], ["test-1"])).toThrow();
  });
});

describe("loadBotConfig", () => {
  const env = { HOUSE_CONTRACT: "floor.tilthouse.testnet", OWNER_TABLES: "test-1=test-owner-1.tilthouse.testnet,test-2=test-owner-2.tilthouse.testnet" };

  it("reads the tables and their owners", () => {
    const config = loadBotConfig(env);
    expect([...config.tables]).toEqual([["test-1", "test-owner-1.tilthouse.testnet"], ["test-2", "test-owner-2.tilthouse.testnet"]]);
    expect(config.intervalMs).toBe(20_000);
    expect(config.maxRent).toBe(2_000_000n);
  });

  it("refuses anything but testnet accounts", () => {
    expect(() => loadBotConfig({ ...env, OWNER_TABLES: "test-1=owner.near" })).toThrow(/testnet/);
    expect(() => loadBotConfig({ ...env, HOUSE_CONTRACT: "floor.near" })).toThrow(/testnet/);
    expect(() => loadBotConfig({ ...env, OWNER_TABLES: "" })).toThrow(/empty/);
  });
});
