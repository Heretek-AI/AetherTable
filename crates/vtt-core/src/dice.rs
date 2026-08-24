use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiceRollResult {
    pub expression: String,
    pub rolls: Vec<i32>,
    pub modifier: i32,
    pub total: i32,
    pub is_natural_20: bool,
    pub is_natural_1: bool,
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

    /// Evaluates a Standard Dice Notation subset, e.g. "2d6+1d4+3", "4d8-2", "d20".
    ///
    /// Grammar:
    ///   expression := ['+' | '-'] term (('+' | '-') term)*
    ///   term       := NdX | dX | integer      (N in 1..=1000, X in 2..=1000)
    ///
    /// Whitespace is tolerated anywhere between tokens. Total dice across all
    /// terms are capped at `MAX_DICE_PER_EXPRESSION` (2000). All randomness is
    /// drawn through [`DiceEngine::roll_die`] so seeded engines replay
    /// identically for identical expressions.
    pub fn roll_expression(&mut self, expression: &str) -> Result<DiceRollResult, String> {
        let expr = expression.trim();
        let mut parser = ExprParser { bytes: expr.as_bytes(), pos: 0 };

        let mut rolls: Vec<i32> = Vec::new();
        let mut modifier: i64 = 0;
        let mut total_dice: usize = 0;
        let mut dice_terms: u32 = 0;
        let mut lone_d20_roll: Option<i32> = None;

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
                    dice_terms += 1;
                    if term.count == 1 && sides == 20 {
                        lone_d20_roll = Some(self.roll_die(20));
                        rolls.push(lone_d20_roll.unwrap());
                    } else {
                        lone_d20_roll = None;
                        for _ in 0..term.count {
                            rolls.push(self.roll_die(sides));
                        }
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

        let is_d20 = dice_terms == 1 && lone_d20_roll.is_some();
        let is_natural_20 = is_d20 && lone_d20_roll == Some(20);
        let is_natural_1 = is_d20 && lone_d20_roll == Some(1);

        Ok(DiceRollResult {
            expression: expression.to_string(),
            rolls,
            modifier: modifier as i32,
            total: total_i64 as i32,
            is_natural_20,
            is_natural_1,
        })
    }
}

const MAX_DICE_PER_EXPRESSION: usize = 2000;
const MAX_DICE_COUNT: u32 = 1000;
const MIN_DIE_SIDES: u32 = 2;
const MAX_DIE_SIDES: u32 = 1000;
/// Upper bound while scanning digit runs so accumulation cannot overflow.
const MAX_PARSED_NUMBER: u64 = 1_000_000_000;

struct ParsedTerm {
    /// Number of dice, or the constant value when `sides` is `None`.
    count: u32,
    sides: Option<u32>,
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
                Ok(ParsedTerm { count: count as u32, sides: Some(sides as u32) })
            }
            _ => {
                let value =
                    count.ok_or_else(|| "expected dice notation or a number".to_string())?;
                if value > i32::MAX as u64 {
                    return Err(format!("Constant {} out of range", value));
                }
                Ok(ParsedTerm { count: value as u32, sides: None })
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
