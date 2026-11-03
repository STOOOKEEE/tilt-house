//! Proves the fairness bounds: every game's base edge, and a total edge (base + rake) between
//! 100 and 500 bp against a perfect player, for every rake `rake_bounds` allows.

use core_rules::{
    apply_rake, base_edge_bp, bj_deal, bj_double, bj_gross, bj_hit, bj_stand, bj_wager, dice_gross,
    rake_bounds, roulette_gross, BjMove, BjStrategy, DiceBet, Game, Rng, RouletteBet,
    BLACKJACK_BASE_EDGE_BP,
};

const MIN_TOTAL_EDGE_BP: f64 = 100.0;
const MAX_TOTAL_EDGE_BP: f64 = 500.0;
/// Large stake so integer rounding does not blur the exact edges.
const STAKE: u128 = 1_000_000_000_000;

fn assert_in_bounds(edge_bp: f64, what: &str) {
    assert!(
        (MIN_TOTAL_EDGE_BP..=MAX_TOTAL_EDGE_BP).contains(&edge_bp),
        "{what}: total edge {edge_bp:.3} bp"
    );
}

fn rakes(game: Game) -> std::ops::RangeInclusive<u16> {
    let (min, max) = rake_bounds(game);
    min..=max
}

/// Exact: a dice bet wins on exactly `chance_bp` of the 10 000 rolls.
#[test]
fn dice_total_edge_bounds() {
    assert_eq!(base_edge_bp(Game::Dice), 0);
    for rake in rakes(Game::Dice) {
        for chance_bp in 100..=9_800u16 {
            let bet = DiceBet {
                chance_bp,
                over: false,
            };
            let paid = apply_rake(dice_gross(STAKE, &bet, 0), STAKE, rake);
            let returned = paid as f64 * f64::from(chance_bp) / 10_000.0;
            let edge_bp = (1.0 - returned / STAKE as f64) * 10_000.0;
            assert_in_bounds(edge_bp, &format!("dice chance {chance_bp} rake {rake}"));
        }
    }
}

/// Exact: sum over the 37 pockets.
#[test]
fn roulette_total_edge_bounds() {
    use RouletteBet::*;
    let mut bets = vec![Red, Black, Odd, Even, Low, High];
    bets.extend((0..=36).map(Straight));
    bets.extend((1..=3).flat_map(|n| [Dozen(n), Column(n)]));

    let fair: u128 = (0..37).map(|p| roulette_gross(STAKE, &Red, p)).sum();
    let base_bp = (1.0 - fair as f64 / (37.0 * STAKE as f64)) * 10_000.0;
    assert_eq!(base_bp.floor() as u16, base_edge_bp(Game::Roulette));

    for rake in rakes(Game::Roulette) {
        for bet in &bets {
            let returned: u128 = (0..37)
                .map(|p| apply_rake(roulette_gross(STAKE, bet, p), STAKE, rake))
                .sum();
            let edge_bp = (1.0 - returned as f64 / (37.0 * STAKE as f64)) * 10_000.0;
            assert_in_bounds(edge_bp, &format!("roulette {bet:?} rake {rake}"));
        }
    }
}

/// Exact: perfect play is recomputed for each rake, since a smaller win can change close calls.
#[test]
fn blackjack_total_edge_bounds() {
    for rake in rakes(Game::Blackjack) {
        let edge_bp = -BjStrategy::optimal(rake).player_ev() * 10_000.0;
        assert_in_bounds(edge_bp, &format!("blackjack rake {rake}"));
    }
}

/// Plays `hands` hands of perfect play (at rake 0) through the real game functions. Returns the
/// mean and standard error of the net result per unit of initial stake.
fn simulate_blackjack(hands: u32, seed: [u8; 32]) -> (f64, f64) {
    // A stake of 2 makes the 3:2 payout exact.
    const BJ_STAKE: u128 = 2;
    let strategy = BjStrategy::optimal(0);
    let mut rng = Rng::new(seed);
    let (mut sum, mut sum_sq) = (0.0f64, 0.0f64);
    for _ in 0..hands {
        let mut state = bj_deal(&mut rng);
        while !state.done {
            let step = match strategy.decide(&state) {
                BjMove::Hit => bj_hit(&mut state, &mut rng),
                BjMove::Stand => bj_stand(&mut state, &mut rng),
                BjMove::Double => bj_double(&mut state, &mut rng),
            };
            step.expect("perfect play only makes legal moves");
        }
        let wager = bj_wager(&state, BJ_STAKE);
        let paid = apply_rake(bj_gross(&state, BJ_STAKE), wager, 0);
        let net = (paid as f64 - wager as f64) / BJ_STAKE as f64;
        sum += net;
        sum_sq += net * net;
    }
    let n = f64::from(hands);
    let mean = sum / n;
    let variance = sum_sq / n - mean * mean;
    (mean, (variance / n).sqrt())
}

/// The hard-coded base edge matches the exact computation, and 2 000 000 simulated hands of
/// perfect play agree with it.
#[test]
fn blackjack_base_edge() {
    const HANDS: u32 = 2_000_000;
    let exact_bp = -BjStrategy::optimal(0).player_ev() * 10_000.0;
    assert!(
        (exact_bp - f64::from(BLACKJACK_BASE_EDGE_BP)).abs() <= 0.5,
        "exact base edge {exact_bp:.3} bp"
    );
    assert!(
        exact_bp > 0.0,
        "blackjack must not favour the player before rake"
    );

    let (mean, standard_error) = simulate_blackjack(HANDS, *b"tilt-house blackjack base edge!!");
    let simulated_bp = -mean * 10_000.0;
    let tolerance_bp = 4.0 * standard_error * 10_000.0;
    println!("blackjack base edge: exact {exact_bp:.2} bp, simulated {simulated_bp:.2} bp ± {tolerance_bp:.2}");
    assert!(
        (simulated_bp - exact_bp).abs() <= tolerance_bp,
        "simulated {simulated_bp:.2} bp vs exact {exact_bp:.2} bp (± {tolerance_bp:.2})"
    );
}
