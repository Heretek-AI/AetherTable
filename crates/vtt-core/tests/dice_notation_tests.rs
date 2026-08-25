//! Iteration 67: 5e shorthand dice notation — keep-highest/lowest ("kh"/"kl"),
//! reroll-once thresholds ("ro<N" / "ro>N"), and exploding dice ("!").
//!
//! Every expectation below is derived from an in-test oracle that replays the
//! exact RNG stream ([`StdRng::gen_range`] on a `StdRng::seed_from_u64` engine,
//! matching [`vtt_core::dice::DiceEngine::roll_die`]) so the tests pin down
//! determinism, keep/reroll/explosion semantics, and legacy-stream parity.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use vtt_core::dice::{DiceEngine, DiceRollResult};

/// Mirrors `DiceEngine::roll_die`: one uniform draw in 1..=sides.
fn d(rng: &mut StdRng, sides: u32) -> i32 {
    rng.gen_range(1..=sides as i32)
}

// ---------------------------------------------------------------------------
// Red-first: the shorthands must PARSE at all.
// ---------------------------------------------------------------------------

#[test]
fn test_shorthand_notations_parse_today_are_missing() {
    let mut engine = DiceEngine::with_seed(1337);
    assert!(engine.roll_expression("2d20kh1").is_ok(), "kh must parse");
    assert!(engine.roll_expression("2d20kl1").is_ok(), "kl must parse");
    assert!(engine.roll_expression("4d6ro<3").is_ok(), "ro< must parse");
    assert!(engine.roll_expression("1d8ro>6").is_ok(), "ro> must parse");
    assert!(engine.roll_expression("1d6!").is_ok(), "! must parse");
}

// ---------------------------------------------------------------------------
// Keep-highest / keep-lowest.
// ---------------------------------------------------------------------------

#[test]
fn test_kh_keeps_highest_die_oracle_exact() {
    // Underlying stream for "2d20kh1" is two d20 draws.
    for seed in [1u64, 42, 1337, 2024, 999_999] {
        let mut oracle = StdRng::seed_from_u64(seed);
        let r1 = d(&mut oracle, 20);
        let r2 = d(&mut oracle, 20);
        let expected_kept = r1.max(r2);

        let res = DiceEngine::with_seed(seed).roll_expression("2d20kh1").unwrap();
        assert_eq!(res.rolls, vec![expected_kept], "seed {seed}: kept must be max({r1},{r2})");
        assert_eq!(res.dropped_rolls.len(), 1);
        assert_eq!(res.total, expected_kept);
        // Invariant: total == kept sum + modifier.
        assert_eq!(res.total, res.rolls.iter().sum::<i32>() + res.modifier);
    }
}

#[test]
fn test_kl_keeps_lowest_die_oracle_exact() {
    for seed in [3u64, 77, 555] {
        let mut oracle = StdRng::seed_from_u64(seed);
        let r1 = d(&mut oracle, 20);
        let r2 = d(&mut oracle, 20);
        let expected_kept = r1.min(r2);

        let res = DiceEngine::with_seed(seed).roll_expression("2d20kl1").unwrap();
        assert_eq!(res.rolls, vec![expected_kept], "seed {seed}");
    }
}

#[test]
fn test_kh_n_keeps_n_of_m_ordered_as_rolled() {
    // 4d6kh2: kept values must be the two largest of the four underlying rolls.
    for seed in [11u64, 12, 13] {
        let mut oracle = StdRng::seed_from_u64(seed);
        let raw: Vec<i32> = (0..4).map(|_| d(&mut oracle, 6)).collect();
        let mut sorted = raw.clone();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        let mut expected: Vec<i32> = sorted[..2].to_vec();
        // Kept rolls preserve original roll order.
        let mut expected_ordered = raw.clone();
        expected_ordered.retain(|v| {
            match expected.iter().position(|e| e == v) {
                Some(pos) => {
                    expected.remove(pos);
                    true
                }
                None => false,
            }
        });

        let res = DiceEngine::with_seed(seed).roll_expression("4d6kh2").unwrap();
        assert_eq!(res.rolls, expected_ordered, "seed {seed}");
        assert_eq!(res.dropped_rolls.len(), 2);
        assert_eq!(res.total, expected_ordered.iter().sum::<i32>());
    }
}

#[test]
fn test_kh_defaults_to_one_die() {
    let mut engine = DiceEngine::with_seed(1337);
    let res = engine.roll_expression("2d20kh").unwrap();
    assert_eq!(res.rolls.len(), 1);
    assert_eq!(res.dropped_rolls.len(), 1);
}

#[test]
fn test_kh1_equivalent_to_legacy_advantage_pair() {
    // Same seed, same two draws: kh1 keeps the max, like roll_d20_advantage.
    let mut pair_engine = DiceEngine::with_seed(64);
    let (adv_kept, r1, r2) = pair_engine.roll_d20_advantage();
    let res = DiceEngine::with_seed(64).roll_expression("2d20kh1").unwrap();
    assert_eq!(res.rolls, vec![adv_kept]);
    assert_eq!(res.dropped_rolls.len(), 1);
    let dropped_sum = adv_kept + res.dropped_rolls[0];
    assert_eq!(
        dropped_sum,
        r1 + r2,
        "kept + dropped must reconstruct ({r1},{r2})"
    );
}

#[test]
fn test_nat20_flag_follows_kept_die_for_single_d20_keep() {
    // Find a seed where the kept (highest) die is 20, then the crit flag holds.
    let seed = (0u64..10_000)
        .find(|&s| {
            let mut o = StdRng::seed_from_u64(s);
            let r1 = d(&mut o, 20);
            let r2 = d(&mut o, 20);
            r1.max(r2) == 20 && !(r1 == 20 && r2 == 20)
        })
        .expect("some seed yields a single natural 20");
    let res = DiceEngine::with_seed(seed).roll_expression("2d20kh1").unwrap();
    assert!(res.is_natural_20, "kept die is 20");
    assert!(!res.is_natural_1);

    // And the mirror: lowest-of-two == 1 flags a critical miss.
    let seed1 = (0u64..10_000)
        .find(|&s| {
            let mut o = StdRng::seed_from_u64(s);
            let r1 = d(&mut o, 20);
            let r2 = d(&mut o, 20);
            r1.min(r2) == 1 && !(r1 == 1 && r2 == 1)
        })
        .expect("some seed yields a single natural 1");
    let miss = DiceEngine::with_seed(seed1).roll_expression("2d20kl1").unwrap();
    assert!(miss.is_natural_1);
}

#[test]
fn test_flags_off_for_multi_dice_non_keep_terms() {
    let mut engine = DiceEngine::with_seed(29);
    let mixed = engine.roll_expression("2d20+1d4").unwrap();
    assert!(!mixed.is_natural_20 && !mixed.is_natural_1);
}

// ---------------------------------------------------------------------------
// Reroll-once thresholds.
// ---------------------------------------------------------------------------

#[test]
fn test_reroll_once_below_threshold_oracle_exact() {
    // 4d6ro<3: any die under 3 is rerolled ONCE; the second value stands even
    // if it is still under 3.
    for seed in [5u64, 88, 4242] {
        let mut oracle = StdRng::seed_from_u64(seed);
        let mut expected = Vec::new();
        let mut dropped = Vec::new();
        for _ in 0..4 {
            let first = d(&mut oracle, 6);
            if first < 3 {
                dropped.push(first);
                expected.push(d(&mut oracle, 6));
            } else {
                expected.push(first);
            }
        }
        let res = DiceEngine::with_seed(seed).roll_expression("4d6ro<3").unwrap();
        assert_eq!(res.rolls, expected, "seed {seed}");
        assert_eq!(res.dropped_rolls, dropped, "seed {seed}");
        assert_eq!(res.total, expected.iter().sum::<i32>());
    }
}

#[test]
fn test_reroll_once_above_threshold_oracle_exact() {
    for seed in [9u64, 101] {
        let mut oracle = StdRng::seed_from_u64(seed);
        let first = d(&mut oracle, 8);
        let expected = if first > 6 { d(&mut oracle, 8) } else { first };
        let dropped = if first > 6 { vec![first] } else { vec![] };

        let res = DiceEngine::with_seed(seed).roll_expression("1d8ro>6").unwrap();
        assert_eq!(res.rolls, vec![expected]);
        assert_eq!(res.dropped_rolls, dropped);
    }
}

#[test]
fn test_reroll_never_rerolls_twice() {
    // Force the pathological case: first roll < threshold AND reroll < threshold.
    // The result must be the second roll, whatever it is (no third draw).
    let seed = (0u64..100_000)
        .find(|&s| {
            let mut o = StdRng::seed_from_u64(s);
            d(&mut o, 6) < 2 && d(&mut o, 6) < 2
        })
        .expect("a seed where both draws are below 2 exists");
    let mut oracle = StdRng::seed_from_u64(seed);
    let first = d(&mut oracle, 6);
    let second = d(&mut oracle, 6);
    assert!(first < 2 && second < 2);

    let res = DiceEngine::with_seed(seed).roll_expression("1d6ro<2").unwrap();
    assert_eq!(res.rolls, vec![second], "second roll stands, no reroll #2");
    assert_eq!(res.dropped_rolls, vec![first]);
    // Exactly two draws were consumed: a following expression sees the stream
    // advanced past both.
    let third = d(&mut oracle, 6);
    let mut chained = DiceEngine::with_seed(seed);
    chained.roll_expression("1d6ro<2").unwrap();
    let next = chained.roll_expression("1d6").unwrap();
    assert_eq!(next.rolls[0], third, "reroll consumed exactly one extra draw");
}

// ---------------------------------------------------------------------------
// Exploding dice.
// ---------------------------------------------------------------------------

#[test]
fn test_exploding_die_adds_bonus_dice_oracle_exact() {
    for seed in [21u64, 22, 23] {
        let mut oracle = StdRng::seed_from_u64(seed);
        let mut expected = Vec::new();
        let mut roll = d(&mut oracle, 6);
        expected.push(roll);
        while roll == 6 {
            roll = d(&mut oracle, 6);
            expected.push(roll);
        }
        let res = DiceEngine::with_seed(seed).roll_expression("1d6!").unwrap();
        assert_eq!(res.rolls, expected, "seed {seed}");
        assert_eq!(res.total, expected.iter().sum::<i32>());
    }
}

#[test]
fn test_explosion_cap_bounded_at_ten_extra_dice_per_die() {
    // A d2 chain that keeps hitting max face walks straight into the hard cap:
    // exactly 1 + 10 dice, terminating fast (no runaway loop).
    let seed = (0u64..100_000)
        .find(|&s| {
            let mut o = StdRng::seed_from_u64(s);
            (0..MAX_EXPLOSIONS_PER_DIE).all(|_| d(&mut o, 2) == 2)
        })
        .expect("some seed explodes a d2 ten times in a row");
    let start = std::time::Instant::now();
    let res = DiceEngine::with_seed(seed).roll_expression("1d2!").unwrap();
    assert!(start.elapsed().as_millis() < 500, "cap must prevent runaway loops");
    assert_eq!(res.rolls.len(), 1 + MAX_EXPLOSIONS_PER_DIE);
    assert!(res.rolls.iter().all(|&r| r == 1 || r == 2));
    assert_eq!(res.total, res.rolls.iter().sum::<i32>());
}

#[test]
fn test_explosions_terminate_normally_below_cap() {
    // A seed that explodes only once: chain length must be exactly 2, proving
    // the cap is not truncating ordinary chains.
    let seed = (0u64..1000)
        .find(|&s| {
            let mut o = StdRng::seed_from_u64(s);
            d(&mut o, 6) == 6 && d(&mut o, 6) != 6
        })
        .expect("a single-explosion seed exists");
    let res = DiceEngine::with_seed(seed).roll_expression("1d6!").unwrap();
    assert_eq!(res.rolls.len(), 2);
    assert_eq!(res.rolls[0], 6);
    assert_ne!(res.rolls[1], 6);
}

#[test]
fn test_explosion_cap_applies_per_die_in_a_pool() {
    // Seed where every one of 4 dice explodes at least once but no die reaches
    // the cap: total = 4 base + sum of extras, all finite, all d6 faces.
    let seed = (0u64..100_000)
        .find(|&s| {
            let mut o = StdRng::seed_from_u64(s);
            (0..4).all(|_| {
                let first = d(&mut o, 6);
                if first != 6 {
                    return false;
                }
                d(&mut o, 6) != 6
            })
        })
        .expect("a seed where four d6s each explode exactly once exists");
    let res = DiceEngine::with_seed(seed).roll_expression("4d6!").unwrap();
    assert_eq!(res.rolls.len(), 8, "each of 4 dice granted exactly one bonus roll");
    assert_eq!(res.total, res.rolls.iter().sum::<i32>());
}

#[test]
fn test_total_dice_cap_counts_explosion_extras() {
    // Even with explosions, the global 2000-die cap cannot be exceeded:
    // "2000d2!" sits exactly at the cap, so ANY single explosion (overwhelmingly
    // certain across 2000 coins) must trip the rejection instead of overflowing.
    let res = DiceEngine::with_seed(4).roll_expression("2000d2!");
    assert!(
        res.is_err(),
        "an explosion past the 2000-die cap must be rejected; got {:?}",
        res.map(|r| r.rolls.len())
    );
    // And a pool comfortably inside even the worst case stays fine.
    let mut engine = DiceEngine::with_seed(5);
    assert!(engine.roll_expression("150d2!").is_ok());
}

// ---------------------------------------------------------------------------
// Combinations and modifiers.
// ---------------------------------------------------------------------------

#[test]
fn test_keep_with_modifier_and_second_term() {
    for seed in [31u64, 32] {
        let mut oracle = StdRng::seed_from_u64(seed);
        let r1 = d(&mut oracle, 20);
        let r2 = d(&mut oracle, 20);
        let flat = d(&mut oracle, 6);
        let kept = r1.max(r2);

        let res = DiceEngine::with_seed(seed).roll_expression("2d20kh1+1d6+3").unwrap();
        assert_eq!(res.rolls, vec![kept, flat]);
        assert_eq!(res.modifier, 3);
        assert_eq!(res.total, kept + flat + 3);
        assert!(!res.is_natural_20, "flags stay off when more than the keep pool exists");
    }
}

#[test]
fn test_reroll_combined_with_explode_is_supported() {
    let mut engine = DiceEngine::with_seed(51);
    let res = engine.roll_expression("4d6ro<2!").unwrap();
    // Every reported die is a final (post-reroll) d6; totals line up.
    assert!(!res.rolls.is_empty());
    assert!(res.rolls.iter().all(|&r| (1..=6).contains(&r)));
    assert_eq!(res.total, res.rolls.iter().sum::<i32>());
}

#[test]
fn test_seeded_determinism_for_all_new_notations() {
    let run = || {
        let mut engine = DiceEngine::with_seed(2024);
        (
            engine.roll_expression("2d20kh1").unwrap(),
            engine.roll_expression("3d6kl2").unwrap(),
            engine.roll_expression("4d6ro<3").unwrap(),
            engine.roll_expression("1d6!").unwrap(),
        )
    };
    let (a, b, c, d2) = run();
    let (a2, b2, c2, d3) = run();
    assert_eq!(a, a2);
    assert_eq!(b, b2);
    assert_eq!(c, c2);
    assert_eq!(d2, d3);
}

// ---------------------------------------------------------------------------
// Rejections.
// ---------------------------------------------------------------------------

#[test]
fn test_invalid_suffix_forms_rejected() {
    let mut engine = DiceEngine::with_seed(61);
    for bad in [
        "2d20kh9",     // keep more than rolled
        "2d20kh0",     // keep zero
        "2d20kl0",
        "2d20kh1kl1",  // mutually exclusive
        "2d6kh",       // handled: defaults to 1, so NOT bad -- excluded below
        "1d6ro<0",     // threshold below die range
        "1d6ro<7",     // threshold above die range
        "1d6ro>",      // missing threshold
        "1d6ro",       // missing comparator
        "1d6!",        // NOT bad -- excluded below
        "1d6!!",       // repeated explode marker
        "1d6x",        // unknown suffix
    ]
    .into_iter()
    .filter(|bad| *bad != "2d6kh" && *bad != "1d6!")
    {
        let err = engine
            .roll_expression(bad)
            .err()
            .unwrap_or_else(|| panic!("expected Err for {:?}", bad));
        assert!(!err.is_empty(), "descriptive error required for {:?}", bad);
    }
}

// ---------------------------------------------------------------------------
// Legacy parity: pre-existing grammar must produce byte-identical results
// (captured from the pre-change implementation).
// ---------------------------------------------------------------------------

fn assert_parity(res: &DiceRollResult, expression: &str, rolls: &[i32], modifier: i32, total: i32) {
    assert_eq!(res.expression, expression);
    assert_eq!(res.rolls, rolls.to_vec(), "{expression}");
    assert_eq!(res.modifier, modifier, "{expression}");
    assert_eq!(res.total, total, "{expression}");
}

#[test]
fn test_legacy_notation_stream_parity() {
    let mut e = DiceEngine::with_seed(1337);
    let a = e.roll_expression("8d6 + 4").unwrap();
    assert_parity(&a, "8d6 + 4", &[6, 3, 4, 5, 4, 6, 5, 5], 4, 42);

    let mut e = DiceEngine::with_seed(2024);
    let b = e.roll_expression("2d6+1d4+3").unwrap();
    assert_parity(&b, "2d6+1d4+3", &[4, 5, 3], 3, 15);
    let c = e.roll_expression("4d8-2").unwrap();
    assert_parity(&c, "4d8-2", &[4, 5, 1, 2], -2, 10);

    let mut e = DiceEngine::with_seed(42);
    let dd = e.roll_expression("1d20 + 3").unwrap();
    assert_parity(&dd, "1d20 + 3", &[11], 3, 14);

    let mut e = DiceEngine::with_seed(7);
    let ee = e.roll_expression("2d10-1d4").unwrap();
    assert_parity(&ee, "2d10-1d4", &[5, 1, 2], 0, 8);
}

const MAX_EXPLOSIONS_PER_DIE: usize = 10;
