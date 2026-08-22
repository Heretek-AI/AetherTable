use crate::dice::DiceEngine;
use crate::types::*;
use std::collections::HashMap;

pub struct ActionResolver;

impl ActionResolver {
    pub fn resolve_check_4tier(
        dice: &mut DiceEngine,
        modifier: i32,
        dc: i32,
        cost_margin: i32,
    ) -> TaskResolutionResult {
        let natural_roll = dice.roll_d20();
        let total = natural_roll + modifier;

        let (outcome, complication) = if natural_roll == 20 || total >= dc + 10 {
            (TaskOutcome::CriticalSuccess, None)
        } else if natural_roll == 1 || total < (dc - 5) {
            let mut res = HashMap::new();
            res.insert("stamina".to_string(), 5);
            (
                TaskOutcome::CriticalFailure,
                Some(Complication {
                    description: "Catastrophic stumble or tool breakage".to_string(),
                    resource_deductions: res,
                    inflicted_conditions: vec![Condition::Prone],
                    tactical_penalty: Some("Grants advantage to enemy next turn".to_string()),
                }),
            )
        } else if total >= dc {
            (TaskOutcome::Success, None)
        } else if total >= dc - cost_margin {
            let mut res = HashMap::new();
            res.insert("stamina".to_string(), 3);
            (
                TaskOutcome::SuccessAtACost,
                Some(Complication {
                    description: "You barely manage to pull it off, but overextend your position".to_string(),
                    resource_deductions: res,
                    inflicted_conditions: vec![],
                    tactical_penalty: Some("Loss of footing, movement halved next turn".to_string()),
                }),
            )
        } else {
            (TaskOutcome::CriticalFailure, None)
        };

        TaskResolutionResult {
            roll: natural_roll,
            modifier,
            total,
            dc,
            outcome,
            complication,
        }
    }

    pub fn calculate_rule_of_cool_dc(
        base_dc: i32,
        complexity_delta: i32,
        spent_inspiration: bool,
        resource_cost_bonus: i32,
    ) -> (i32, i32) {
        let delta_insp = if spent_inspiration { 5 } else { 0 };
        let final_dc = (base_dc + complexity_delta - delta_insp - resource_cost_bonus).max(5);

        let bonus_dice_count = ((final_dc - 10) / 5).max(0);
        (final_dc, bonus_dice_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_4tier_resolution() {
        let mut dice = DiceEngine::with_seed(1234);
        let result = ActionResolver::resolve_check_4tier(&mut dice, 5, 15, 3);
        assert!(result.total >= 6);
    }

    #[test]
    fn test_rule_of_cool_formula() {
        let (final_dc, bonus_dice) = ActionResolver::calculate_rule_of_cool_dc(15, 5, true, 2);
        assert_eq!(final_dc, 13);
        assert_eq!(bonus_dice, 0);

        let (hard_dc, hard_dice) = ActionResolver::calculate_rule_of_cool_dc(20, 10, false, 0);
        assert_eq!(hard_dc, 30);
        assert_eq!(hard_dice, 4);
    }
}
