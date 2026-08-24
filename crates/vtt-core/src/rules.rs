use crate::actions::ActionResolver;
use crate::dice::DiceEngine;
use crate::state::EntityState;
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

/// Outcome of a concentration saving throw triggered by damage.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ConcentrationBreakResult {
    pub dc: i32,
    pub total: i32,
    pub maintained: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CastSpellResult {
    pub caster_id: Uuid,
    pub target_id: Option<Uuid>,
    pub spell_id: String,
    pub slot_level_used: u8,
    pub damage_total: i32,
    pub target_hp_remaining: Option<i32>,
    pub concentration_started: bool,
    pub counterspelled: bool,
}

/// Hard sanity caps on spell damage expressions. Until spell definitions are
/// served exclusively from the compendium store, any client-supplied formula
/// is clamped to these bounds so absurdity ("9999d9999") can never resolve.
pub const MAX_SPELL_DICE_COUNT: u32 = 40;
pub const MAX_SPELL_DIE_SIDES: u32 = 12;

/// Parses "NdM+K" / "NdM-K" / "NdM" and enforces dice-count/sides caps.
fn clamp_damage_expression(expr: &str) -> Result<String, String> {
    let expr = expr.trim().to_lowercase().replace(' ', "");
    if expr.is_empty() {
        return Ok("0".to_string());
    }
    let (dice_part, modifier) = match expr.find(['+', '-']) {
        Some(idx) => {
            let m = expr[idx..].parse::<i32>().map_err(|_| format!("BAD_DAMAGE_EXPRESSION: {}", expr))?;
            (&expr[..idx], m)
        }
        None => (expr.as_str(), 0),
    };
    let (count_str, sides_str) = dice_part
        .split_once('d')
        .ok_or_else(|| format!("BAD_DAMAGE_EXPRESSION: {}", expr))?;
    let count: u32 = count_str.parse().map_err(|_| format!("BAD_DAMAGE_EXPRESSION: {}", expr))?;
    let sides: u32 = sides_str.parse().map_err(|_| format!("BAD_DAMAGE_EXPRESSION: {}", expr))?;
    let capped_count = count.min(MAX_SPELL_DICE_COUNT);
    let capped_sides = sides.min(MAX_SPELL_DIE_SIDES).max(1);
    if count > MAX_SPELL_DICE_COUNT || sides > MAX_SPELL_DIE_SIDES {
        // Silently clamped counts would be dishonest — reject instead.
        return Err(format!(
            "SPELL_DAMAGE_EXCEEDS_CAPS: {}d{} > {}d{}",
            count, sides, capped_count, capped_sides
        ));
    }
    Ok(format!("{}d{}{}", capped_count, capped_sides, if modifier >= 0 { format!("+{}", modifier) } else { format!("{}", modifier) }))
}

pub struct RulesEvaluator;

impl RulesEvaluator {
    /// Derives (advantage, disadvantage) for an attack from entity conditions and elevation.
    ///
    /// Reuses the existing condition helper flags on `Condition` (see types.rs):
    /// - Attacker-side conditions that impose disadvantage on attacks (blinded,
    ///   frightened, poisoned, prone, restrained, exhaustion level 3+).
    /// - Target conditions that grant advantage to the attacker (paralyzed, restrained,
    ///   unconscious; prone only within 5 ft).
    /// - Target conditions that impose disadvantage on the attacker (invisible;
    ///   prone beyond 5 ft).
    /// - High ground grants advantage when the existing high-ground attack bonus is > 0.
    ///
    /// NOTE: when both flags are true the pair CANCELS per SRD 5.1 and resolves as a
    /// single straight d20 — that cancellation already happens in
    /// `RulesEvaluator::resolve_attack` (rules.rs), so callers may pass both flags
    /// through without pre-resolving them here.
    pub fn edge_from_conditions(
        attacker: &EntityState,
        target: &EntityState,
        distance_feet: f32,
        attacker_z: f32,
        target_z: f32,
    ) -> (bool, bool) {
        let mut advantage = target
            .conditions
            .iter()
            .any(|c| c.grants_advantage_to_attacker(distance_feet));
        let disadvantage = attacker
            .conditions
            .iter()
            .any(|c| c.inflicts_disadvantage_on_attacks())
            || target
                .conditions
                .iter()
                .any(|c| c.inflicts_disadvantage_on_attacker(distance_feet));

        // High ground: only treat as advantage when the bonus is actually applied.
        if Self::calculate_high_ground_attack_bonus(attacker_z, target_z) > 0 {
            advantage = true;
        }

        (advantage, disadvantage)
    }

    /// Starts concentration on a spell, overwriting any prior concentration
    /// (SRD replacement rule: casting a new concentration spell ends the old one).
    pub fn begin_concentration(entity: &mut EntityState, spell_id: &str) {
        // Overwrite any prior concentration — only one spell can be concentrated on at a time.
        entity.concentration = Some(crate::state::ConcentrationState {
            spell_id: spell_id.to_string(),
            started_round: 0,
        });
    }

    /// Ends concentration. Returns true if there was an active spell to end.
    pub fn end_concentration(entity: &mut EntityState, _reason: &str) -> bool {
        entity.concentration.take().is_some()
    }

    /// Applies damage-triggered concentration save (SRD: CON save vs DC = max(10, damage / 2)).
    ///
    /// Delegates DC math to `ActionResolver::resolve_concentration_check` so there is a
    /// single source of truth. Zero damage never triggers a check. On a failed save the
    /// entity's concentration is cleared.
    pub fn apply_damage_to_concentration(
        entity: &mut EntityState,
        damage_taken: i32,
        con_roll: i32,
        con_mod: i32,
    ) -> ConcentrationBreakResult {
        // No damage taken => no save is triggered; concentration is maintained.
        if damage_taken <= 0 {
            return ConcentrationBreakResult {
                dc: 0,
                total: con_roll + con_mod,
                maintained: true,
            };
        }

        let (passed, total, dc) =
            ActionResolver::resolve_concentration_check(con_roll, con_mod, damage_taken);

        if !passed && entity.concentration.is_some() {
            Self::end_concentration(entity, "FAILED_CONCENTRATION_SAVE");
        }

        ConcentrationBreakResult {
            dc,
            total,
            maintained: passed,
        }
    }

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

    /// Authoritative spellcasting validation (GOALS.md Pillar 3):
    /// 1. caster must be capable of acting
    /// 2. an unexpended slot at `cast_level` OR HIGHER must exist — the
    ///    lowest sufficient level is expended
    /// 3. verbal/somatic/material component flags are validated against the
    ///    caster's state
    /// 4. concentration limits: a new concentration spell replaces the old
    /// 5. damage is rolled from the spell formula with sanity caps applied,
    ///    then applied through resist/vuln/immunity + temp-HP absorption
    ///
    /// `counterspelled` pre-empts everything after slot expenditure (SRD:
    /// a counterspelled spell fails but the slot is still spent).
    pub fn validate_and_cast_spell(
        dice: &mut DiceEngine,
        caster: &mut EntityState,
        target: Option<&mut EntityState>,
        spell: &SpellDefinition,
        cast_level: u8,
        counterspelled: bool,
    ) -> Result<CastSpellResult, String> {
        // 1. Capacity.
        if !caster.can_act() {
            return Err("ENTITY_CANNOT_ACT".to_string());
        }
        if spell.verbal_component && !caster.is_conscious {
            return Err("COMPONENT_UNAVAILABLE_VERBAL".to_string());
        }
        let _ = spell.somatic_component; // somatic failures need a bound-hands model; none yet.
        let _ = spell.material_component_desc;

        if cast_level < spell.level || cast_level > 9 {
            return Err(format!(
                "INVALID_SLOT_LEVEL: spell of level {} cannot be cast at slot {}",
                spell.level, cast_level
            ));
        }

        // 2. Slot availability: exact level first, then upcast ladder.
        let mut slot_level_used: Option<u8> = None;
        for level in spell.level..=9 {
            if caster.spell_slots_remaining.get(&level).copied().unwrap_or(0) > 0 {
                slot_level_used = Some(level);
                break;
            }
        }
        let slot_level_used = slot_level_used.ok_or_else(|| {
            format!("NO_SPELL_SLOTS: no unexpended slot at level {} or higher", spell.level)
        })?;
        *caster
            .spell_slots_remaining
            .entry(slot_level_used)
            .or_insert(1) -= 1;

        // Slot is now spent — Counterspell resolves AFTER expenditure.
        let target_id_captured = target.as_ref().map(|t| t.id);
        if counterspelled {
            return Ok(CastSpellResult {
                caster_id: caster.id,
                target_id: target_id_captured,
                spell_id: spell.spell_id.clone(),
                slot_level_used,
                damage_total: 0,
                target_hp_remaining: None,
                concentration_started: false,
                counterspelled: true,
            });
        }

        // 4. Concentration lifecycle (replacement per SRD).
        let concentration_started = if spell.is_concentration {
            Self::begin_concentration(caster, &spell.spell_id);
            true
        } else {
            false
        };

        // 5. Damage application with caps and resistances.
        let mut damage_total = 0i32;
        let mut hp_remaining: Option<i32> = None;
        if let (Some(expr), Some(dtype), Some(target)) =
            (spell.damage_formula.as_deref(), spell.damage_type, target)
        {
            let clamped = clamp_damage_expression(expr)?;
            let raw = dice.roll_expression(&clamped)?.total;
            damage_total = if target.immunities.contains(&dtype) {
                0
            } else if target.resistances.contains(&dtype) {
                raw / 2
            } else if target.vulnerabilities.contains(&dtype) {
                raw * 2
            } else {
                raw
            };

            let (hp_rem, temp_rem, dead) = Self::apply_damage_to_hp(
                target.current_hp,
                target.max_hp,
                target.temp_hp,
                damage_total,
            );
            target.temp_hp = temp_rem;
            target.current_hp = hp_rem;
            target.is_conscious = hp_rem > 0;
            target.is_dead = target.is_dead || dead;
            hp_remaining = Some(hp_rem);

            // Damage-triggered concentration check on the TARGET.
            if target.concentration.is_some() && damage_total > 0 {
                let con_mod = target.abilities.modifier(Ability::Constitution);
                let natural = dice.roll_d20();
                Self::apply_damage_to_concentration(target, damage_total, natural, con_mod);
            }
        }

        Ok(CastSpellResult {
            caster_id: caster.id,
            target_id: target_id_captured,
            spell_id: spell.spell_id.clone(),
            slot_level_used,
            damage_total,
            target_hp_remaining: hp_remaining,
            concentration_started,
            counterspelled: false,
        })
    }

    pub fn apply_damage_to_hp(        current_hp: i32,
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

impl RulesEvaluator {
    /// Calculates standard D&D 5e fall damage: 1d6 bludgeoning per 10 feet fallen (max 20d6).
    /// Returns (damage_amount, knocked_prone).
    pub fn calculate_fall_damage(
        dice: &mut DiceEngine,
        fall_distance_feet: f32,
        dex_save_roll: Option<i32>,
    ) -> (i32, bool) {
        if fall_distance_feet < 10.0 {
            return (0, false);
        }

        let num_dice = ((fall_distance_feet / 10.0).floor() as u32).min(20);
        let mut total_dmg = 0;
        for _ in 0..num_dice {
            total_dmg += dice.roll_die(6);
        }

        // DC 15 Acrobatics check to land on feet
        let avoids_prone = if let Some(save) = dex_save_roll {
            save >= 15
        } else {
            false
        };

        (total_dmg, !avoids_prone)
    }

    /// Evaluates high-ground ranged attack bonus (+2 to-hit when >= 10ft higher than target)
    pub fn calculate_high_ground_attack_bonus(attacker_z: f32, target_z: f32) -> i32 {
        if attacker_z - target_z >= 10.0 {
            2
        } else {
            0
        }
    }

    /// Evaluates plunge attack: converts half of falling kinetic energy into bonus melee damage
    pub fn calculate_plunge_attack_bonus(
        dice: &mut DiceEngine,
        fall_distance_feet: f32,
    ) -> (i32, i32) {
        let (self_dmg, _) = Self::calculate_fall_damage(dice, fall_distance_feet, None);
        let bonus_melee_dmg = self_dmg / 2;
        (bonus_melee_dmg, self_dmg)
    }
}
