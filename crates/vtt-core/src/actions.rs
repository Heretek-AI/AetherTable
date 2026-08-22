use crate::dice::DiceEngine;
use crate::types::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttackOutcome {
    CriticalHit,
    Hit,
    Miss,
    CriticalMiss,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttackResolution {
    pub natural_roll: i32,
    pub attack_modifier: i32,
    pub total_to_hit: i32,
    pub target_ac: i32,
    pub outcome: AttackOutcome,
    pub is_hit: bool,
    pub is_critical: bool,
    pub damage_dice_multiplier: u32,
}

pub struct ActionResolver;

impl ActionResolver {
    /// 4-tier task resolution (Rule of Cool / PbtA hybridized)
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

    /// Full SRD Attack Roll Resolution with Condition & Critical Hit multipliers
    pub fn resolve_attack(
        natural_roll: i32,
        attack_modifier: i32,
        target_ac: i32,
        _attacker_conditions: &[Condition],
        target_conditions: &[Condition],
        distance_feet: f32,
    ) -> AttackResolution {
        // Natural 1 is automatic miss
        if natural_roll == 1 {
            return AttackResolution {
                natural_roll: 1,
                attack_modifier,
                total_to_hit: 1 + attack_modifier,
                target_ac,
                outcome: AttackOutcome::CriticalMiss,
                is_hit: false,
                is_critical: false,
                damage_dice_multiplier: 1,
            };
        }

        // Natural 20 is automatic hit and critical
        let is_nat20 = natural_roll == 20;

        // Check if target condition inflicts automatic critical hit (e.g. Paralyzed / Unconscious within 5ft)
        let auto_crit = target_conditions
            .iter()
            .any(|c| c.grants_auto_crit_within_5ft(distance_feet));

        let total = natural_roll + attack_modifier;
        let is_hit = is_nat20 || total >= target_ac;

        let is_critical = is_hit && (is_nat20 || auto_crit);

        let outcome = if is_critical {
            AttackOutcome::CriticalHit
        } else if is_hit {
            AttackOutcome::Hit
        } else {
            AttackOutcome::Miss
        };

        AttackResolution {
            natural_roll,
            attack_modifier,
            total_to_hit: total,
            target_ac,
            outcome,
            is_hit,
            is_critical,
            damage_dice_multiplier: if is_critical { 2 } else { 1 },
        }
    }

    /// SRD Saving Throw Resolution
    pub fn resolve_saving_throw(
        natural_roll: i32,
        save_modifier: i32,
        dc: i32,
        target_conditions: &[Condition],
        ability: Ability,
    ) -> (bool, i32) {
        // Auto-fail Strength and Dexterity saves if Paralyzed / Petrified / Stunned / Unconscious
        if (ability == Ability::Strength || ability == Ability::Dexterity)
            && target_conditions.iter().any(|c| c.fails_str_dex_saves())
        {
            return (false, natural_roll + save_modifier);
        }

        let total = natural_roll + save_modifier;
        let passed = total >= dc;
        (passed, total)
    }

    /// SRD Concentration Check: CON save DC = max(10, damage / 2)
    pub fn resolve_concentration_check(
        con_save_roll: i32,
        con_modifier: i32,
        damage_taken: i32,
    ) -> (bool, i32, i32) {
        let dc = (damage_taken / 2).max(10);
        let total = con_save_roll + con_modifier;
        let passed = total >= dc;
        (passed, total, dc)
    }

    /// SRD Death Saving Throw State Machine
    pub fn resolve_death_save(state: &mut DeathSaveState, natural_roll: i32) -> &'static str {
        if state.is_dead {
            return "ALREADY_DEAD";
        }
        if state.is_stabilized {
            return "ALREADY_STABILIZED";
        }

        if natural_roll == 20 {
            state.is_stabilized = true;
            return "CRITICAL_SUCCESS_REVIVED_1HP";
        } else if natural_roll == 1 {
            state.failures += 2;
        } else if natural_roll >= 10 {
            state.successes += 1;
        } else {
            state.failures += 1;
        }

        if state.failures >= 3 {
            state.is_dead = true;
            "DEAD"
        } else if state.successes >= 3 {
            state.is_stabilized = true;
            "STABILIZED"
        } else {
            "PENDING"
        }
    }

    /// Massive Damage Instant Death: excess damage >= max_hp when dropping to 0 HP
    pub fn check_instant_death(damage_taken: i32, current_hp: i32, max_hp: i32) -> bool {
        damage_taken >= current_hp + max_hp
    }

    pub fn calculate_rule_of_cool_dc(
        base_dc: i32,
        cinematic_praise: bool,
        environmental_hazard_rating: i32,
    ) -> i32 {
        let mut dc = base_dc;
        if cinematic_praise {
            dc -= 2;
        }
        dc += environmental_hazard_rating;
        dc.max(5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_4tier_resolution() {
        let mut dice = DiceEngine::with_seed(42);
        let result = ActionResolver::resolve_check_4tier(&mut dice, 5, 15, 3);
        assert!(result.total >= 6);
    }

    #[test]
    fn test_attack_and_auto_crit() {
        // Attack vs Paralyzed within 5ft => Auto Crit
        let res = ActionResolver::resolve_attack(
            12,
            5,
            14,
            &[],
            &[Condition::Paralyzed],
            5.0,
        );
        assert!(res.is_hit);
        assert!(res.is_critical);
        assert_eq!(res.damage_dice_multiplier, 2);

        // Nat 1 is always critical miss
        let miss_res = ActionResolver::resolve_attack(
            1,
            10,
            10,
            &[],
            &[],
            10.0,
        );
        assert!(!miss_res.is_hit);
        assert_eq!(miss_res.outcome, AttackOutcome::CriticalMiss);
    }

    #[test]
    fn test_concentration_and_death_saves() {
        // Taking 30 damage requires DC 15 concentration check
        let (passed, total, dc) = ActionResolver::resolve_concentration_check(11, 4, 30);
        assert_eq!(dc, 15);
        assert_eq!(total, 15);
        assert!(passed);

        // Death Save State Machine
        let mut state = DeathSaveState::default();
        ActionResolver::resolve_death_save(&mut state, 15); // 1 success
        assert_eq!(state.successes, 1);
        ActionResolver::resolve_death_save(&mut state, 1); // +2 failures
        assert_eq!(state.failures, 2);
        ActionResolver::resolve_death_save(&mut state, 20); // Nat 20 revives
        assert!(state.is_stabilized);
    }
}
