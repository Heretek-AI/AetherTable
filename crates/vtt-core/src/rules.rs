use crate::dice::DiceEngine;
use crate::types::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonsterArchetype {
    pub monster_id: String,
    pub name: String,
    pub challenge_rating: f32,
    pub size_category: String,
    pub creature_type: String,
    pub base_ac: i32,
    pub hit_dice_count: i32,
    pub hit_dice_sides: i32,
    pub base_speed: u32,
    pub burrow_speed: u32,
    pub fly_speed: u32,
    pub swim_speed: u32,
    pub abilities: AbilityScores,
    pub resistances: Vec<DamageType>,
    pub immunities: Vec<DamageType>,
    pub vulnerabilities: Vec<DamageType>,
    pub condition_immunities: Vec<Condition>,
    pub action_deck: serde_json::Value,
}

impl MonsterArchetype {
    pub fn proficiency_bonus(&self) -> i32 {
        if self.challenge_rating < 1.0 {
            2
        } else {
            ((self.challenge_rating - 1.0) / 4.0).floor() as i32 + 2
        }
    }

    pub fn average_hp(&self) -> i32 {
        let avg_die = (self.hit_dice_sides as f32 + 1.0) / 2.0;
        let con_mod = self.abilities.modifier(Ability::Constitution);
        let hp = (self.hit_dice_count as f32 * avg_die) + (self.hit_dice_count * con_mod) as f32;
        hp.floor().max(1.0) as i32
    }

    pub fn spell_save_dc(&self, primary: Ability) -> i32 {
        8 + self.proficiency_bonus() + self.abilities.modifier(primary)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpellDefinition {
    pub spell_id: String,
    pub name: String,
    pub level: u8,
    pub school: String,
    pub casting_time: String,
    pub range_feet: u32,
    pub area_of_effect_shape: Option<String>,
    pub area_of_effect_size_feet: Option<u32>,
    pub verbal_component: bool,
    pub somatic_component: bool,
    pub material_component_desc: Option<String>,
    pub save_attribute: Option<Ability>,
    pub damage_formula: Option<String>,
    pub damage_type: Option<DamageType>,
    pub duration_rounds: u32,
    pub is_concentration: bool,
    pub is_ritual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttackRollResult {
    pub attacker_id: Uuid,
    pub target_id: Uuid,
    pub attack_roll: i32,
    pub natural_roll: i32,
    pub target_ac: i32,
    pub is_hit: bool,
    pub is_critical_hit: bool,
    pub is_critical_miss: bool,
    pub total_damage: i32,
    pub damage_instances: Vec<DamageInstance>,
    pub target_hp_remaining: i32,
    pub target_is_conscious: bool,
    pub target_is_dead: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavingThrowResult {
    pub target_id: Uuid,
    pub ability: Ability,
    pub dc: i32,
    pub roll: i32,
    pub modifier: i32,
    pub total: i32,
    pub passed: bool,
    pub damage_taken: i32,
    pub target_hp_remaining: i32,
    pub target_is_conscious: bool,
    pub target_is_dead: bool,
}

pub struct RulesEvaluator;

impl RulesEvaluator {
    pub fn resolve_attack(
        dice: &mut DiceEngine,
        attacker_id: Uuid,
        target_id: Uuid,
        attack_bonus: i32,
        target_ac: i32,
        damage_expression: &str,
        damage_type: DamageType,
        target_current_hp: i32,
        target_max_hp: i32,
        target_temp_hp: i32,
        resistances: &[DamageType],
        vulnerabilities: &[DamageType],
        immunities: &[DamageType],
        advantage: bool,
        disadvantage: bool,
    ) -> Result<AttackRollResult, String> {
        let (natural_roll, _, _) = if advantage && !disadvantage {
            dice.roll_d20_advantage()
        } else if disadvantage && !advantage {
            dice.roll_d20_disadvantage()
        } else {
            let r = dice.roll_d20();
            (r, r, r)
        };

        let attack_total = natural_roll + attack_bonus;
        let is_critical_hit = natural_roll == 20;
        let is_critical_miss = natural_roll == 1;

        let is_hit = (attack_total >= target_ac || is_critical_hit) && !is_critical_miss;

        if !is_hit {
            return Ok(AttackRollResult {
                attacker_id,
                target_id,
                attack_roll: attack_total,
                natural_roll,
                target_ac,
                is_hit: false,
                is_critical_hit,
                is_critical_miss,
                total_damage: 0,
                damage_instances: Vec::new(),
                target_hp_remaining: target_current_hp,
                target_is_conscious: target_current_hp > 0,
                target_is_dead: target_current_hp <= -target_max_hp,
            });
        }

        let raw_dmg_roll = dice.roll_expression(damage_expression)?;
        let mut base_dmg = raw_dmg_roll.total;
        if is_critical_hit {
            let crit_bonus_roll = dice.roll_expression(damage_expression)?;
            base_dmg += crit_bonus_roll.total - crit_bonus_roll.modifier;
        }

        let final_dmg = if immunities.contains(&damage_type) {
            0
        } else if resistances.contains(&damage_type) {
            base_dmg / 2
        } else if vulnerabilities.contains(&damage_type) {
            base_dmg * 2
        } else {
            base_dmg
        };

        let (hp_rem, _temp_rem, is_dead) = Self::apply_damage_to_hp(
            target_current_hp,
            target_max_hp,
            target_temp_hp,
            final_dmg,
        );

        Ok(AttackRollResult {
            attacker_id,
            target_id,
            attack_roll: attack_total,
            natural_roll,
            target_ac,
            is_hit: true,
            is_critical_hit,
            is_critical_miss,
            total_damage: final_dmg,
            damage_instances: vec![DamageInstance {
                amount: final_dmg,
                damage_type,
                is_magical: false,
            }],
            target_hp_remaining: hp_rem,
            target_is_conscious: hp_rem > 0,
            target_is_dead: is_dead,
        })
    }

    pub fn apply_damage_to_hp(
        current_hp: i32,
        max_hp: i32,
        temp_hp: i32,
        damage: i32,
    ) -> (i32, i32, bool) {
        if damage <= 0 {
            return (current_hp, temp_hp, false);
        }

        let mut rem_damage = damage;
        let mut final_temp_hp = temp_hp;

        if final_temp_hp > 0 {
            if final_temp_hp >= rem_damage {
                final_temp_hp -= rem_damage;
                rem_damage = 0;
            } else {
                rem_damage -= final_temp_hp;
                final_temp_hp = 0;
            }
        }

        let final_hp = current_hp - rem_damage;
        let is_instant_death = final_hp <= -max_hp;

        (final_hp.max(-max_hp), final_temp_hp, is_instant_death)
    }

    pub fn resolve_saving_throw(
        dice: &mut DiceEngine,
        target_id: Uuid,
        ability: Ability,
        save_modifier: i32,
        dc: i32,
        damage_expression: Option<&str>,
        damage_type: Option<DamageType>,
        half_on_save: bool,
        target_current_hp: i32,
        target_max_hp: i32,
        target_temp_hp: i32,
        resistances: &[DamageType],
        vulnerabilities: &[DamageType],
        immunities: &[DamageType],
    ) -> Result<SavingThrowResult, String> {
        let natural_roll = dice.roll_d20();
        let total = natural_roll + save_modifier;
        let passed = total >= dc;

        let dmg_taken = if let (Some(expr), Some(dtype)) = (damage_expression, damage_type) {
            let roll = dice.roll_expression(expr)?;
            let raw_dmg = if passed {
                if half_on_save { roll.total / 2 } else { 0 }
            } else {
                roll.total
            };

            if immunities.contains(&dtype) {
                0
            } else if resistances.contains(&dtype) {
                raw_dmg / 2
            } else if vulnerabilities.contains(&dtype) {
                raw_dmg * 2
            } else {
                raw_dmg
            }
        } else {
            0
        };

        let (hp_rem, _, is_dead) = Self::apply_damage_to_hp(
            target_current_hp,
            target_max_hp,
            target_temp_hp,
            dmg_taken,
        );

        Ok(SavingThrowResult {
            target_id,
            ability,
            dc,
            roll: natural_roll,
            modifier: save_modifier,
            total,
            passed,
            damage_taken: dmg_taken,
            target_hp_remaining: hp_rem,
            target_is_conscious: hp_rem > 0,
            target_is_dead: is_dead,
        })
    }
}
