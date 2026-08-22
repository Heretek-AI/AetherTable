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

    pub fn roll_expression(&mut self, expression: &str) -> Result<DiceRollResult, String> {
        let expr = expression.trim().replace(' ', "");
        let (dice_part, mod_part) = if let Some(idx) = expr.find('+') {
            let m: i32 = expr[idx + 1..].parse().map_err(|e| format!("Invalid modifier: {}", e))?;
            (&expr[..idx], m)
        } else if let Some(idx) = expr.rfind('-') {
            if idx > 0 {
                let m: i32 = expr[idx + 1..].parse().map_err(|e| format!("Invalid modifier: {}", e))?;
                (&expr[..idx], -m)
            } else {
                (expr.as_str(), 0)
            }
        } else {
            (expr.as_str(), 0)
        };

        let parts: Vec<&str> = dice_part.split('d').collect();
        if parts.len() != 2 {
            // Check if it's just a constant
            if let Ok(c) = expr.parse::<i32>() {
                return Ok(DiceRollResult {
                    expression: expression.to_string(),
                    rolls: vec![c],
                    modifier: 0,
                    total: c,
                    is_natural_20: false,
                    is_natural_1: false,
                });
            }
            return Err(format!("Invalid dice expression: {}", expression));
        }

        let count: u32 = if parts[0].is_empty() { 1 } else { parts[0].parse().map_err(|e| format!("Invalid count: {}", e))? };
        let sides: u32 = parts[1].parse().map_err(|e| format!("Invalid sides: {}", e))?;

        let mut rolls = Vec::with_capacity(count as usize);
        for _ in 0..count {
            rolls.push(self.roll_die(sides));
        }

        let sum: i32 = rolls.iter().sum();
        let total = sum + mod_part;

        let is_d20 = count == 1 && sides == 20;
        let is_natural_20 = is_d20 && rolls[0] == 20;
        let is_natural_1 = is_d20 && rolls[0] == 1;

        Ok(DiceRollResult {
            expression: expression.to_string(),
            rolls,
            modifier: mod_part,
            total,
            is_natural_20,
            is_natural_1,
        })
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
}
