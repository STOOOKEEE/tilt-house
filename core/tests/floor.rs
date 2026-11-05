//! Properties of the floor over random sequences of bids, rent collections and pricing:
//! money is conserved, no pool pays more than its free bankroll, an outbid always evicts the
//! lowest rent, and the dealers' rent bids are always valid.

use core_rules::dealer_rules::{rent_bid, RentAction, Temperament};
use core_rules::floor::{
    Floor, FloorError, COOLDOWN_SECS, MIN_RENT_PER_HOUR, OUTBID_BP, PREPAY_HOURS, SEATS,
};
use core_rules::{Pool, Rng, Stats, BP};

const USDC: u128 = 1_000_000;
const DEALERS: usize = 10;
const START: u64 = 1_800_000_000;

fn random_pool(rng: &mut Rng) -> Pool {
    let bankroll = u128::from(rng.below(5_000)) * USDC + u128::from(rng.below(1_000_000));
    let reserved = bankroll * u128::from(rng.below(101)) / 100;
    Pool {
        bankroll,
        shares: bankroll,
        reserved,
        open_stakes: 0,
    }
}

fn random_rent(rng: &mut Rng) -> u128 {
    match rng.below(4) {
        0 => MIN_RENT_PER_HOUR - 1,
        1 => MIN_RENT_PER_HOUR,
        _ => u128::from(rng.below(200)) * USDC / 4,
    }
}

fn total(floor: &Floor, pools: &[Pool]) -> u128 {
    floor.jackpot + pools.iter().map(|p| p.bankroll).sum::<u128>()
}

/// Property: whatever happens, money only moves between pools' free bankroll and the jackpot,
/// reserves stay covered, and an outbid evicts the lowest rent (most recently seated on ties).
#[test]
fn rent_and_bids_keep_money_and_rules() {
    let mut rng = Rng::new(*b"floor property test seed 0000001");
    let (mut outbids, mut unpaid) = (0, 0);
    for _ in 0..300 {
        let ids: Vec<String> = (0..DEALERS).map(|i| format!("d{i}")).collect();
        let mut pools: Vec<Pool> = (0..DEALERS).map(|_| random_pool(&mut rng)).collect();
        let mut cooldowns = [0u64; DEALERS];
        let mut floor = Floor::default();
        let mut now = START;
        let money = total(&floor, &pools);

        for _ in 0..200 {
            now += u64::from(rng.below(1_800));
            let d = rng.below(DEALERS as u32) as usize;
            if rng.below(3) == 0 {
                let before = pools[d].clone();
                let outcome = floor.accrue_rent(&ids[d], &mut pools[d], now);
                assert!(outcome.paid <= before.free());
                assert_eq!(before.bankroll - outcome.paid, pools[d].bankroll);
                if outcome.evicted.is_some() {
                    assert_eq!(pools[d].free(), 0);
                    assert_eq!(floor.seat_of(&ids[d]), None);
                    cooldowns[d] = now + COOLDOWN_SECS;
                    unpaid += 1;
                }
            } else {
                // Settle everyone first, as the contract does on collect_rent.
                for (i, id) in ids.iter().enumerate() {
                    if floor.accrue_rent(id, &mut pools[i], now).evicted.is_some() {
                        cooldowns[i] = now + COOLDOWN_SECS;
                        unpaid += 1;
                    }
                }
                let rent = random_rent(&mut rng);
                let was_full = floor.empty_seats() == 0;
                let was_seated = floor.seat_of(&ids[d]).is_some();
                let weakest = floor.weakest_seat();
                let lowest = floor.lowest_rent();
                let snapshot = (floor.clone(), pools[d].clone());
                match floor.bid_for_seat(&ids[d], rent, &mut pools[d], now, cooldowns[d]) {
                    Ok(outcome) => {
                        assert!(rent >= MIN_RENT_PER_HOUR);
                        assert_eq!(floor.seat_of(&ids[d]), Some(outcome.seat));
                        if let Some(victim) = &outcome.evicted {
                            assert!(was_full && !was_seated);
                            assert_eq!(weakest, Some(outcome.seat));
                            assert!(rent * BP >= lowest.unwrap() * OUTBID_BP);
                            assert_eq!(
                                snapshot.0.seats[outcome.seat]
                                    .as_ref()
                                    .unwrap()
                                    .rent_per_hour,
                                lowest.unwrap()
                            );
                            let v = ids.iter().position(|id| id == victim).unwrap();
                            cooldowns[v] = now + COOLDOWN_SECS;
                            outbids += 1;
                        }
                        if !was_seated {
                            assert_eq!(outcome.paid, rent * u128::from(PREPAY_HOURS));
                        }
                    }
                    Err(error) => {
                        assert_eq!((floor.clone(), pools[d].clone()), snapshot, "{error}");
                        if let FloorError::BidTooLow { min } = error {
                            assert!(rent < min);
                        }
                    }
                }
            }
            assert!(floor.seated().count() <= SEATS);
            assert!(pools.iter().all(|p| p.reserved <= p.bankroll));
            assert_eq!(total(&floor, &pools), money);
        }
    }
    // The random walk did reach both kinds of eviction.
    assert!(outbids > 100 && unpaid > 100, "{outbids} {unpaid}");
}

/// Property: rent bids are always at least the minimum, and an off-floor bid can be prepaid.
#[test]
fn rent_bids_are_always_valid() {
    let mut rng = Rng::new(*b"rent bid property test seed 0001");
    for _ in 0..100_000 {
        let pool = random_pool(&mut rng);
        let stats = Stats {
            player_net_1h: i128::from(rng.below(u32::MAX)) * 1_000 - (1i128 << 41),
            ..Stats::default()
        };
        let temperament = Temperament {
            greed: rng.below(256) as u8,
            caution: rng.below(256) as u8,
            promo: rng.below(256) as u8,
        };
        let mut floor = Floor::default();
        for i in 0..rng.below(SEATS as u32 + 1) {
            floor
                .bid_for_seat(
                    &format!("s{i}"),
                    random_rent(&mut rng).max(MIN_RENT_PER_HOUR),
                    &mut Pool {
                        bankroll: u128::MAX / 2,
                        ..Pool::default()
                    },
                    START,
                    0,
                )
                .unwrap();
        }
        let me = if rng.below(2) == 0 { "s0" } else { "me" };
        let view = floor.view(me, START + u64::from(rng.below(2)) * COOLDOWN_SECS);
        let decision = rent_bid(&pool, &stats, &temperament, &view, START);
        match decision.action {
            RentAction::Raise(rent) | RentAction::Lower(rent) => {
                assert!(rent >= MIN_RENT_PER_HOUR);
                assert!(view.my_rent.is_some());
            }
            RentAction::BidEmpty(rent) | RentAction::Outbid(rent) => {
                assert!(view.my_rent.is_none());
                assert!(rent >= view.outbid_min);
                assert!(rent * u128::from(PREPAY_HOURS) <= pool.free());
                let mut floor = floor.clone();
                let mut pool = pool.clone();
                assert!(floor.bid_for_seat(me, rent, &mut pool, START, 0).is_ok());
            }
            RentAction::Keep | RentAction::Stay => assert!(decision.reason.is_none()),
        }
    }
}
