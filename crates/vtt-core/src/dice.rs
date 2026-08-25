use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiceRollResult {
    pub expression: String,
    /// Kept dice in original roll order. For keep/reroll notation these are
    /// post-keep / post-reroll values; rerolled-away and unkept dice land in
    /// [`DiceRollResult::dropped_rolls`].
    pub rolls: Vec<i32>,
    pub modifier: i32,
    pub total: i32,
    pub is_natural_20: bool,
    pub is_natural_1: bool,
    /// Dice discarded by "kh"/"kl" keeps and by "ro" reroll-once, in draw order.
    /// Empty for legacy expressions.
    #[serde(default)]
    pub dropped_rolls: Vec<i32>,
}

pub struct DiceEngine {
    rng: StdRng,
}

impl Default for DiceEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl DiceEngine {
    pub fn new() -> Self {
        Self {
            rng: StdRng::from_entropy(),
        }
    }

    pub fn with_seed(seed: u64) -> Self {
        Self {
            rng: StdRng::seed_from_u64(seed),
        }
    }

    pub fn roll_die(&mut self, sides: u32) -> i32 {
        if sides == 0 {
            return 0;
        }
        self.rng.gen_range(1..=sides as i32)
    }

    pub fn roll_d20(&mut self) -> i32 {
        self.roll_die(20)
    }

    pub fn roll_d20_advantage(&mut self) -> (i32, i32, i32) {
        let r1 = self.roll_d20();
        let r2 = self.roll_d20();
        (r1.max(r2), r1, r2)
    }

    pub fn roll_d20_disadvantage(&mut self) -> (i32, i32, i32) {
        let r1 = self.roll_d20();
        let r2 = self.roll_d20();
        (r1.min(r2), r1, r2)
    }

    /// Evaluates a Standard Dice Notation subset with common 5e shorthands,
    /// e.g. "2d6+1d4+3", "4d8-2", "d20", "2d20kh1", "4d6ro<3", "1d6!".
    ///
    /// Grammar:
    ///   expression := ['+' | '-'] term (('+' | '-') term)*
    ///   term       := NdX [suffixes] | dX [suffixes] | integer
    ///                 (N in 1..=1000, X in 2..=1000)
    ///   suffixes   := keep? reroll? explode?      (each at most once; any order)
    ///   keep       := ('kh' | 'kl') [N]           (N defaults to 1; N <= dice count)
    ///   reroll     := 'ro' ('<' | '>') T          (T within the die's range;
    ///                                              each failing die is rerolled ONCE,
    ///                                              the second value stands)
    ///   explode    := '!'                         (a max-face die grants one bonus
    ///                                              roll of the same size, chaining
    ///                                              up to MAX_EXPLOSIONS_PER_DIE times)
    ///
    /// Skipped (deliberately unsupported): "r N" infinite reroll, "ro=N" exact
    /// thresholds, per-die arithmetic modifiers ("d6+1" per die), target
    /// success/failure counts (">N"/fN), FATE/Fudge dice, and parenthesised groups.
    /// Callers that model advantage/disadvantage via explicit flags continue to
    /// use [`DiceEngine::roll_d20_advantage`] / `roll_d20_disadvantage`; "kh"/"kl"
    /// notation is an equivalent alternative, not a replacement of that path.
    ///
    /// Whitespace is tolerated anywhere between tokens. Total dice across all
    /// terms are capped at `MAX_DICE_PER_EXPRESSION` (2000), counting explosion
    /// extras. All randomness is drawn through [`DiceEngine::roll_die`] so seeded
    /// engines replay identically for identical expressions.
    pub fn roll_expression(&mut self, expression: &str) -> Result<DiceRollResult, String> {
        let expr = expression.trim();
        let mut parser = ExprParser { bytes: expr.as_bytes(), pos: 0 };

        let mut rolls: Vec<i32> = Vec::new();
        let mut dropped_rolls: Vec<i32> = Vec::new();
        let mut modifier: i64 = 0;
        let mut total_dice: usize = 0;
        let mut dice_terms: u32 = 0;
        // The single kept value when the whole expression is exactly one d20 roll
        // (including a keep/rework of a d20 pool down to one kept die).
        let mut single_d20_kept: Option<i32> = None;

        // Optional leading sign.
        let leading_sign = parser.take_sign();
        if parser.at_end() {
            return Err(format!("Empty dice expression: {:?}", expression));
        }

        let mut first_term = true;
        loop {
            let term_sign: i64 = if first_term {
                first_term = false;
                leading_sign as i64
            } else {
                match parser.peek()? {
                    b'+' | b'-' => {}
                    other => {
                        return Err(format!(
                            "Expected '+' or '-' at position {} in dice expression '{}', found '{}'",
                            parser.pos, expression, other as char
                        ))
                    }
                }
                parser.take_sign() as i64
            };
            let term = parser.parse_term()?;

            match term.sides {
                Some(sides) => {
                    total_dice += term.count as usize;
                    if total_dice > MAX_DICE_PER_EXPRESSION {
                        return Err(format!(
                            "Dice expression '{}' exceeds cap of {} total dice",
                            expression, MAX_DICE_PER_EXPRESSION
                        ));
                    }

                    let resolved = self.resolve_dice_pool(sides, &term, expression)?;
                    // The global cap counts explosion bonus dice too.
                    total_dice += resolved.dropped.len();
                    if total_dice > MAX_DICE_PER_EXPRESSION {
                        return Err(format!(
                            "Dice expression '{}' exceeds cap of {} total dice",
                            expression, MAX_DICE_PER_EXPRESSION
                        ));
                    }

                    rolls.extend_from_slice(&resolved.kept);
                    rolls.extend_from_slice(&resolved.extras);
                    dropped_rolls.extend_from_slice(&resolved.dropped);
                    dice_terms += 1;

                    // Natural-20/1 flags apply when the whole expression is a
                    // single d20 roll — either a bare "1d20" or a d20 pool kept
                    // down to exactly one die with no explosion extras
                    // ("2d20kh1"/"2d20kl1").
                    if sides == 20
                        && dice_terms == 1
                        && resolved.kept.len() == 1
                        && resolved.extras.is_empty()
                    {
                        single_d20_kept = Some(resolved.kept[0]);
                    } else {
                        single_d20_kept = None;
                    }
                }
                None => {
                    modifier += term_sign * term.count as i64;
                }
            }

            if parser.at_end() {
                break;
            }
        }

        if modifier > i32::MAX as i64 || modifier < i32::MIN as i64 {
            return Err(format!("Modifier out of range in dice expression '{}'", expression));
        }

        // Back-compat: a bare constant keeps its historical shape.
        if rolls.is_empty() && dice_terms == 0 {
            rolls.push(modifier as i32);
            modifier = 0;
        }

        let die_sum: i64 = rolls.iter().map(|r| *r as i64).sum();
        let total_i64 = die_sum + modifier;
        if total_i64 > i32::MAX as i64 || total_i64 < i32::MIN as i64 {
            return Err(format!("Total out of range for dice expression '{}'", expression));
        }

        let is_d20 = dice_terms == 1 && single_d20_kept.is_some();
        let is_natural_20 = is_d20 && single_d20_kept == Some(20);
        let is_natural_1 = is_d20 && single_d20_kept == Some(1);

        Ok(DiceRollResult {
            expression: expression.to_string(),
            rolls,
            modifier: modifier as i32,
            total: total_i64 as i32,
            is_natural_20,
            is_natural_1,
            dropped_rolls,
        })
    }

    /// Draws, rerolls, keeps and explodes one dice term according to its parsed
    /// suffixes. RNG draw order — the contract seeded tests rely on:
    ///   1. for each of `count` dice: initial roll;
    ///   2. if a reroll threshold applies and the first roll fails it, ONE
    ///      immediate replacement roll (the second value stands unconditionally);
    ///   3. explosion bonus rolls are drawn after all base+reroll draws, in die
    ///      order (each exploding die chains before moving to the next die).
    fn resolve_dice_pool(
        &mut self,
        sides: u32,
        term: &ParsedTerm,
        expression: &str,
    ) -> Result<ResolvedPool, String> {
        let keep = match (&term.keep, term.count) {
            (Some(KeepMode::Highest(n)), _) => {
                if *n == 0 || *n as usize > term.count as usize {
                    return Err(format!(
                        "Keep count {} out of range for '{}' (1-{} dice)",
                        n, expression, term.count
                    ));
                }
                Some((*n as usize, true))
            }
            (Some(KeepMode::Lowest(n)), _) => {
                if *n == 0 || *n as usize > term.count as usize {
                    return Err(format!(
                        "Keep count {} out of range for '{}' (1-{} dice)",
                        n, expression, term.count
                    ));
                }
                Some((*n as usize, false))
            }
            (None, _) => None,
        };

        let max_face = sides as i32;

        // A reroll threshold outside the die's own range could never match
        // ("1d6ro<7") or always matched trivially against nothing ("ro<0");
        // reject rather than silently accept dead notation.
        if let Some(reroll) = &term.reroll_once {
            if reroll.threshold < 1 || reroll.threshold > max_face {
                return Err(format!(
                    "Reroll threshold {} out of range for 'd{}' (1-{})",
                    reroll.threshold, sides, max_face
                ));
            }
        }

        let mut kept_final: Vec<(i32, usize)> = Vec::with_capacity(term.count as usize);
        let mut dropped: Vec<i32> = Vec::new();
        let mut explosion_extras: Vec<Vec<i32>> = Vec::with_capacity(term.count as usize);

        for die_index in 0..term.count as usize {
            let mut value = self.roll_die(sides);
            if let Some(reroll) = &term.reroll_once {
                let fails = match reroll.comparator {
                    RerollComparator::Below => value < reroll.threshold,
                    RerollComparator::Above => value > reroll.threshold,
                };
                if fails {
                    dropped.push(value);
                    // Reroll happens ONCE; the second value stands even if it
                    // also fails the threshold.
                    value = self.roll_die(sides);
                }
            }
            kept_final.push((value, die_index));

            // Explosion chain: each max face grants one more roll, up to the cap.
            if term.explode {
                let mut extras = Vec::new();
                let mut current = value;
                while current == max_face && extras.len() < MAX_EXPLOSIONS_PER_DIE {
                    current = self.roll_die(sides);
                    extras.push(current);
                }
                explosion_extras.push(extras);
            } else {
                explosion_extras.push(Vec::new());
            }
        }

        // Apply the keep AFTER explosions resolve so a dropped die's explosion
        // still lands in the result (5e-style pools usually don't mix these; we
        // choose total-preserving semantics).
        let mut kept: Vec<i32> = Vec::with_capacity(kept_final.len());
        let mut kept_indices: Vec<usize> = Vec::with_capacity(kept_final.len());
        match keep {
            Some((n, highest)) => {
                let mut order: Vec<usize> = (0..kept_final.len()).collect();
                order.sort_by(|&a, &b| {
                    let cmp = kept_final[b].0.cmp(&kept_final[a].0);
                    if highest {
                        cmp.then(a.cmp(&b))
                    } else {
                        cmp.reverse().then(a.cmp(&b))
                    }
                });
                let keep_set: std::collections::HashSet<usize> =
                    order.into_iter().take(n).collect();
                for (value, idx) in &kept_final {
                    if keep_set.contains(idx) {
                        kept.push(*value);
                        kept_indices.push(*idx);
                    } else {
                        dropped.push(*value);
                    }
                }
            }
            None => {
                kept.extend(kept_final.iter().map(|(v, _)| *v));
                kept_indices.extend(0..kept_final.len());
            }
        }

        // Explosion extras are appended after the kept dice in draw order.
        let mut extras_flat: Vec<i32> = Vec::new();
        for (idx, extras) in explosion_extras.iter().enumerate() {
            if keep.is_none() || kept_indices.contains(&idx) || !extras.is_empty() {
                extras_flat.extend_from_slice(extras);
            }
        }

        Ok(ResolvedPool { kept, dropped, extras: extras_flat })
    }
}

/// Result of resolving one dice term through [`DiceEngine::resolve_dice_pool`].
struct ResolvedPool {
    /// Final kept dice, in original roll order.
    kept: Vec<i32>,
    /// Dice discarded by rerolls and keeps, in draw order.
    dropped: Vec<i32>,
    /// Explosion bonus rolls, appended after the kept dice.
    extras: Vec<i32>,
}

const MAX_DICE_PER_EXPRESSION: usize = 2000;
const MAX_DICE_COUNT: u32 = 1000;
const MIN_DIE_SIDES: u32 = 2;
const MAX_DIE_SIDES: u32 = 1000;
/// Upper bound while scanning digit runs so accumulation cannot overflow.
const MAX_PARSED_NUMBER: u64 = 1_000_000_000;
/// Hard cap on bonus rolls a single exploding die may grant, so "d2!"-style
/// always-exploding pools terminate deterministically.
const MAX_EXPLOSIONS_PER_DIE: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq)]
enum KeepMode {
    Highest(u32),
    Lowest(u32),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum RerollComparator {
    Below,
    Above,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct RerollOnce {
    comparator: RerollComparator,
    threshold: i32,
}

struct ParsedTerm {
    /// Number of dice, or the constant value when `sides` is `None`.
    count: u32,
    sides: Option<u32>,
    keep: Option<KeepMode>,
    reroll_once: Option<RerollOnce>,
    explode: bool,
}

struct ExprParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> ExprParser<'a> {
    fn at_end(&mut self) -> bool {
        self.skip_ws();
        self.pos >= self.bytes.len()
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    /// Consumes an optional '+'/'-' and returns its signed value (+1/-1).
    fn take_sign(&mut self) -> i32 {
        self.skip_ws();
        match self.bytes.get(self.pos) {
            Some(b'+') => {
                self.pos += 1;
                1
            }
            Some(b'-') => {
                self.pos += 1;
                -1
            }
            _ => 1,
        }
    }

    fn peek(&mut self) -> Result<u8, String> {
        self.skip_ws();
        self.bytes
            .get(self.pos)
            .copied()
            .ok_or_else(|| "unexpected end of dice expression".to_string())
    }

    /// Parses an unsigned integer run, guarding against overflow.
    fn parse_number(&mut self, what: &str) -> Result<Option<u64>, String> {
        self.skip_ws();
        let start = self.pos;
        let mut value: u64 = 0;
        while let Some(&b) = self.bytes.get(self.pos) {
            if !b.is_ascii_digit() {
                break;
            }
            value = value * 10 + u64::from(b - b'0');
            if value > MAX_PARSED_NUMBER {
                return Err(format!("{} is too large", what));
            }
            self.pos += 1;
        }
        if self.pos == start {
            return Ok(None);
        }
        Ok(Some(value))
    }

    fn parse_term(&mut self) -> Result<ParsedTerm, String> {
        let count = self.parse_number("dice count")?;
        self.skip_ws();

        match self.bytes.get(self.pos) {
            Some(b'd') | Some(b'D') => {
                self.pos += 1;
                let sides = self
                    .parse_number("die size")?
                    .ok_or_else(|| "missing die size after 'd'".to_string())?;
                let count = count.unwrap_or(1); // bare "dX" means one die

                if count == 0 || count > MAX_DICE_COUNT as u64 {
                    return Err(format!("Dice count {} out of range (1-{})", count, MAX_DICE_COUNT));
                }
                if sides < MIN_DIE_SIDES as u64 || sides > MAX_DIE_SIDES as u64 {
                    return Err(format!(
                        "Die size {} out of range ({}-{})",
                        sides, MIN_DIE_SIDES, MAX_DIE_SIDES
                    ));
                }

                let mut term = ParsedTerm {
                    count: count as u32,
                    sides: Some(sides as u32),
                    keep: None,
                    reroll_once: None,
                    explode: false,
                };
                self.parse_suffixes(&mut term)?;
                Ok(term)
            }
            _ => {
                let value =
                    count.ok_or_else(|| "expected dice notation or a number".to_string())?;
                if value > i32::MAX as u64 {
                    return Err(format!("Constant {} out of range", value));
                }
                Ok(ParsedTerm {
                    count: value as u32,
                    sides: None,
                    keep: None,
                    reroll_once: None,
                    explode: false,
                })
            }
        }
    }

    /// Parses the optional keep/reroll/explode suffixes of a dice term. Each may
    /// appear at most once; anything unrecognised is left for the caller's
    /// term-boundary check so legacy error messages are unchanged.
    fn parse_suffixes(&mut self, term: &mut ParsedTerm) -> Result<(), String> {
        loop {
            self.skip_ws();
            match self.bytes.get(self.pos) {
                Some(b'k') | Some(b'K') => {
                    if term.keep.is_some() {
                        return Err("keep suffix ('kh'/'kl') may only appear once per dice term".to_string());
                    }
                    self.pos += 1;
                    match self.bytes.get(self.pos) {
                        Some(b'h') | Some(b'H') | Some(b'l') | Some(b'L') => {
                            let highest = matches!(self.bytes[self.pos], b'h' | b'H');
                            self.pos += 1;
                            // Optional count; bare "kh"/"kl" means keep one.
                            let n = self.parse_number("keep count")?.unwrap_or(1);
                            if n > MAX_DICE_COUNT as u64 {
                                return Err(format!(
                                    "Keep count {} out of range (1-{})",
                                    n, MAX_DICE_COUNT
                                ));
                            }
                            term.keep = Some(if highest {
                                KeepMode::Highest(n as u32)
                            } else {
                                KeepMode::Lowest(n as u32)
                            });
                        }
                        _ => {
                            // Not a keep suffix ("kd...", unknown): rewind.
                            self.pos -= 1;
                            return Ok(());
                        }
                    }
                }
                Some(b'r') | Some(b'R')
                    if matches!(self.bytes.get(self.pos + 1), Some(b'o') | Some(b'O')) =>
                {
                    // Only "ro<"/"ro>" is supported here.
                    if term.reroll_once.is_some() {
                        return Err(
                            "reroll suffix ('ro') may only appear once per dice term".to_string()
                        );
                    }
                    self.pos += 2;
                    let comparator = match self.bytes.get(self.pos) {
                        Some(b'<') => RerollComparator::Below,
                        Some(b'>') => RerollComparator::Above,
                        _ => {
                            return Err(
                                "reroll-once requires a '<' or '>' comparator (e.g. 'ro<3')"
                                    .to_string()
                            )
                        }
                    };
                    self.pos += 1;
                    let threshold = self
                        .parse_number("reroll threshold")?
                        .ok_or_else(|| "missing reroll threshold".to_string())?;
                    if threshold > MAX_DIE_SIDES as u64 {
                        return Err(format!(
                            "Reroll threshold {} outside plausible die range",
                            threshold
                        ));
                    }
                    term.reroll_once = Some(RerollOnce {
                        comparator,
                        threshold: threshold as i32,
                    });
                }
                Some(b'!') => {
                    if term.explode {
                        return Err(
                            "explode suffix ('!') may only appear once per dice term".to_string()
                        );
                    }
                    self.pos += 1;
                    term.explode = true;
                }
                _ => return Ok(()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dice_engine_seeded() {
        let mut engine = DiceEngine::with_seed(1337);
        let res = engine.roll_expression("8d6 + 4").unwrap();
        assert_eq!(res.rolls.len(), 8);
        assert_eq!(res.modifier, 4);
        assert_eq!(res.total, res.rolls.iter().sum::<i32>() + 4);
    }

    #[test]
    fn test_d20_crit() {
        let mut engine = DiceEngine::with_seed(42);
        let res = engine.roll_expression("1d20 + 3").unwrap();
        assert_eq!(res.rolls.len(), 1);
    }

    #[test]
    fn test_multi_term_sum() {
        let mut engine = DiceEngine::with_seed(7);
        let res = engine.roll_expression("2d6+1d4+3").unwrap();
        assert_eq!(res.expression, "2d6+1d4+3");
        assert_eq!(res.rolls.len(), 3); // 2d6 + 1d4
        assert_eq!(res.modifier, 3);
        assert!(res.total >= 3 + 3 && res.total <= 12 + 4 + 3);
        assert_eq!(res.total, res.rolls.iter().sum::<i32>() + res.modifier);
    }

    #[test]
    fn test_subtraction_of_flat_term() {
        let mut engine = DiceEngine::with_seed(11);
        let res = engine.roll_expression("4d8-2").unwrap();
        assert_eq!(res.rolls.len(), 4);
        assert_eq!(res.modifier, -2);
        assert_eq!(res.total, res.rolls.iter().sum::<i32>() - 2);
    }

    #[test]
    fn test_subtraction_of_dice_term() {
        let mut engine = DiceEngine::with_seed(13);
        let res = engine.roll_expression("2d10-1d4").unwrap();
        assert_eq!(res.rolls.len(), 3);
        // Total is the signed combination; each d10 in [1,10], each d4 in [1,4].
        assert!(res.total >= 2 - 4 && res.total <= 20 - 2);
    }

    #[test]
    fn test_single_die_shorthand() {
        let mut engine = DiceEngine::with_seed(17);
        let res = engine.roll_expression("d6+2").unwrap();
        assert_eq!(res.rolls.len(), 1);
        assert_eq!(res.modifier, 2);
        assert!(res.rolls[0] >= 1 && res.rolls[0] <= 6);
    }

    #[test]
    fn test_flat_constant_only() {
        let mut engine = DiceEngine::with_seed(19);
        let res = engine.roll_expression("5").unwrap();
        assert_eq!(res.total, 5);

        let neg = engine.roll_expression("-5").unwrap();
        assert_eq!(neg.total, -5);
    }

    #[test]
    fn test_whitespace_tolerance() {
        let mut engine = DiceEngine::with_seed(23);
        let res = engine.roll_expression(" 2d6 + 1d4 + 3 ").unwrap();
        assert_eq!(res.rolls.len(), 3);
        assert_eq!(res.modifier, 3);
    }

    #[test]
    fn test_seeded_determinism_across_terms() {
        let run = || {
            let mut engine = DiceEngine::with_seed(2024);
            let a = engine.roll_expression("2d6+1d4+3").unwrap();
            let b = engine.roll_expression("4d8-2").unwrap();
            (
                a.rolls.clone(),
                a.modifier,
                a.total,
                b.rolls.clone(),
                b.modifier,
                b.total,
            )
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn test_natural_20_flag_only_for_lone_d20() {
        let mut engine = DiceEngine::with_seed(29);
        let lone = engine.roll_expression("1d20").unwrap();
        assert!(lone.is_natural_20 == (lone.rolls[0] == 20));
        assert!(lone.is_natural_1 == (lone.rolls[0] == 1));

        let mixed = engine.roll_expression("1d20+1d4").unwrap();
        assert!(!mixed.is_natural_20 && !mixed.is_natural_1);
    }

    #[test]
    fn test_invalid_expressions_rejected() {
        let mut engine = DiceEngine::with_seed(31);
        for bad in [
            "2d",
            "d",
            "2d6+apple",
            "1d1",
            "",
            "   ",
            "+",
            "2d6++3",
            "2d6+",
            "+2d6+",
            "2x6",
            "d6d6",
            "1.5d6",
            "2d6*3",
            "1d0",
            "0d6",
            "1d1001",
            "1001d6",
            "(1d6)",
        ] {
            let err = engine
                .roll_expression(bad)
                .err()
                .unwrap_or_else(|| panic!("expected Err for {:?}", bad));
            assert!(!err.is_empty(), "descriptive error required for {:?}", bad);
        }
    }

    #[test]
    fn test_total_dice_cap_enforced() {
        let mut engine = DiceEngine::with_seed(37);
        // 2000 dice total is allowed (two terms of 1000).
        assert!(engine.roll_expression("1000d6+1000d6").is_ok());
        // 2001 dice total exceeds the cap.
        let err = engine.roll_expression("1000d6+1000d6+1d6").unwrap_err();
        assert!(err.contains("cap") || err.to_lowercase().contains("dice"), "got: {}", err);
    }

    #[test]
    fn test_modifier_overflow_rejected() {
        let mut engine = DiceEngine::with_seed(41);
        assert!(engine.roll_expression("2 000000000 000d6").is_err());
        assert!(engine.roll_expression("99999999999999999999").is_err());
    }
}
