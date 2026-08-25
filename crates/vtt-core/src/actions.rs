use crate::dice::DiceEngine;
use crate::rules::RulesEvaluator;
use crate::state::{AttackAction, EntityState};
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

// --- Contested checks: Grapple & Shove ---------------------------------------
//
// SRD 5e melee attack alternatives. Both replace ONE attack with a contested
// ability check: both sides roll a d20, add their skill modifier, and the
// HIGHER total wins — on an exact tie the attacker LOSES (SRD contested-check
// tie rule), so ties resolve to [`ContestedSide::Defender`].

/// Which side of a contested check won.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContestedSide {
    Attacker,
    Defender,
}

/// Effect chosen by the caller for a successful shove.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShoveEffect {
    /// Target is knocked `Condition::Prone`.
    Prone,
    /// Target is pushed 5 ft directly away from the shover (caller performs
    /// the positional translation; this engine call only rules on the check).
    Push5Feet,
}

/// SRD DC 15 Acrobatics check to land on your feet after a fall (avoiding
/// Prone). The caller rolls and supplies the total — see
/// [`ActionResolver::resolve_fall`].
pub const FALL_LAND_ON_FEET_DC: i32 = 15;

/// Outcome of a contested ability check.
///
/// `margin` is the winner's total minus the loser's total (0 on a tie, which
/// always resolves to [`ContestedSide::Defender`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContestedResolution {
    pub winner_side: ContestedSide,
    pub margin: i32,
}

/// Outcome of a grapple attempt. Success applies `Condition::Grappled`.
///
/// NOTE ON STATE MODELLING: the SRD distinguishes *Grappled* (speed 0) from
/// *Restrained* (speed 0 + attack/save disadv/adv). The `Condition` enum
/// carries BOTH variants, and a grapple applies the lighter
/// `Condition::Grappled` — NOT Restrained. Escape mechanics (documented
/// approximation): the grappled target escapes with an Athletics or Acrobatics
/// check against DC = 8 + grappler's Strength modifier
/// ([`ActionResolver::grapple_escape_dc`]; the stat-block model carries no
/// per-entity proficiency bonus, so it is omitted here).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GrappleResolution {
    pub contest: ContestedResolution,
    pub success: bool,
    /// `Some(Condition::Grappled)` exactly when `success` is true.
    pub applied_condition: Option<Condition>,
}

/// Outcome of a shove attempt. Success applies the caller-chosen effect:
/// `Condition::Prone`, or a 5 ft push (no condition; position is the caller's
/// concern).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ShoveResolution {
    pub contest: ContestedResolution,
    pub success: bool,
    pub effect: ShoveEffect,
    /// `Some(Condition::Prone)` when the shove succeeded AND chose `ShoveEffect::Prone`.
    pub applied_condition: Option<Condition>,
}

// --- Tactical falls ------------------------------------------------------------
//
// SRD 5e falling (PHB "Falling"): a creature that falls 10 ft or more takes
// 1d6 bludgeoning damage per 10 ft fallen (max 20d6) and lands Prone, unless
// it avoids damage. The DC 15 Acrobatics check to land on your feet is
// approximated here as an optional supplied save total (the engine's stat
// blocks carry no proficiency bonuses; the caller rolls and supplies the
// total). Landing on a soft surface halves the damage — the disclosed
// approximation for the feather-fall / soft-landing family of rulings.
//
// Massive damage instant death reuses [`RulesEvaluator::check_instant_death`]
// so falls kill exactly like every other damage source in this engine.

/// What the faller lands on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LandingSurface {
    /// Ordinary ground: full damage.
    Normal,
    /// Water, deep snow, soft earth, a heap of hay: damage halved (floor).
    Soft,
}

/// Coarse bucket for the fall outcome, mirroring the PILLAR-3 ladder:
/// nothing / prone only / prone + damage / massive-damage death.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallOutcome {
    /// Under 10 ft of drop: no damage, no condition.
    SafeDrop,
    /// 10 ft or more survived: prone, plus damage when any was rolled.
    InjuredLanding,
    /// Damage dropped the faller AND exceeded max HP: dead before hitting
    /// the ground (SRD massive damage instant death).
    MassiveDamage,
}

/// Full resolution of one fall. `damage_taken` is what actually applies to
/// the faller's HP (surface-adjusted); `raw_damage` is the pre-surface roll
/// so audits can see both.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FallResolution {
    pub drop_feet: f32,
    pub surface: LandingSurface,
    pub outcome: FallOutcome,
    /// Dice total before any surface adjustment (1d6 per 10 ft, capped 20d6).
    pub raw_damage: i32,
    /// Damage actually applied to HP (`raw_damage`, or half on a soft surface).
    pub damage_taken: i32,
    /// Landed Prone (always true at 10 ft+ unless a passed save total is supplied).
    pub knocked_prone: bool,
    pub hp_remaining: i32,
    pub is_conscious: bool,
    pub instant_death: bool,
}

impl ActionResolver {
    /// Resolves a tactical fall from `current_z` down to `target_z` (world
    /// units are feet).
    ///
    /// Errors are returned as static strings (clippy `result_large_err`):
    /// `"NON_FINITE_ELEVATION"` when either elevation is not finite, and
    /// `"NO_DOWNWARD_DROP"` when the target is at or above the start.
    #[allow(clippy::result_large_err)] // plain &'static str payload
    pub fn resolve_fall(
        current_z: f32,
        target_z: f32,
        surface: LandingSurface,
        dice: &mut DiceEngine,
        current_hp: i32,
        max_hp: i32,
        acrobatics_save_total: Option<i32>,
    ) -> Result<FallResolution, &'static str> {
        if !current_z.is_finite() || !target_z.is_finite() {
            return Err("NON_FINITE_ELEVATION");
        }
        let drop = current_z - target_z;
        if drop <= 0.0 {
            return Err("NO_DOWNWARD_DROP");
        }

        let raw_damage = RulesEvaluator::calculate_fall_damage(dice, drop, None).0;
        let damage_taken = match surface {
            LandingSurface::Normal => raw_damage,
            LandingSurface::Soft => raw_damage / 2,
        };

        // SRD massive-damage instant death, shared with every other damage
        // source in this engine.
        let instant_death = Self::check_instant_death(damage_taken, current_hp, max_hp);

        let landed_on_feet = acrobatics_save_total.is_some_and(|total| total >= FALL_LAND_ON_FEET_DC);
        let knocked_prone = !instant_death && drop >= 10.0 && !landed_on_feet;

        let hp_remaining = if instant_death {
            0
        } else {
            (current_hp - damage_taken).max(0)
        };
        let is_conscious = !instant_death && hp_remaining > 0;

        let outcome = if instant_death {
            FallOutcome::MassiveDamage
        } else if drop >= 10.0 {
            FallOutcome::InjuredLanding
        } else {
            FallOutcome::SafeDrop
        };

        Ok(FallResolution {
            drop_feet: drop,
            surface,
            outcome,
            raw_damage,
            damage_taken,
            knocked_prone,
            hp_remaining,
            is_conscious,
            instant_death,
        })
    }
}

// --- Two-Weapon Fighting ------------------------------------------------------
//
// SRD 5e: when you take the Attack action and wield TWO weapons that BOTH have
// the Light property, you may spend your Bonus Action to make one extra attack
// with the off-hand weapon. That extra attack adds NO positive ability
// modifier to its damage ("unless that modifier is negative") — the Two-Weapon
// Fighting fighting style is what restores it, and no style model exists in
// this stat-block engine yet (disclosed limitation).

/// Result of one SRD Two-Weapon Fighting off-hand strike.
///
/// `roll` is the full attack-pipeline result ([`crate::rules::AttackRollResult`])
/// so callers apply damage / ledger exactly as they do for a normal attack.
#[derive(Debug, Clone, PartialEq)]
pub struct OffhandAttackResolution {
    /// The complete hit/damage resolution for the off-hand swing.
    pub roll: crate::rules::AttackRollResult,
    /// The damage expression ACTUALLY rolled. When a POSITIVE ability modifier
    /// was withheld this differs from the weapon's own expression by that
    /// trailing `+N` term; a negative or zero modifier leaves it untouched.
    pub damage_expression_rolled: String,
    /// True when a POSITIVE ability modifier was withheld from the damage per
    /// SRD (the Two-Weapon Fighting style would restore it).
    pub ability_mod_withheld_from_damage: bool,
}

/// Strips ONE trailing positive `+N` term from a dice expression such as
/// `"1d4+3"`. Returns `(stripped_expression, withheld_amount)`. Negative terms
/// (`1d4-1`) are kept — SRD keeps negative modifiers in off-hand damage.
fn strip_positive_modifier(expression: &str) -> (&str, i32) {
    match expression.rfind('+') {
        Some(idx) => {
            let tail = expression[idx + 1..].trim();
            if let Ok(amount) = tail.parse::<i32>() {
                if amount > 0 {
                    return (expression[..idx].trim(), amount);
                }
            }
            (expression.trim(), 0)
        }
        None => (expression.trim(), 0),
    }
}

impl ActionResolver {
    /// SRD Two-Weapon Fighting bonus-action off-hand strike.
    ///
    /// Requirements enforced here:
    /// - BOTH held weapons carry the Light property (`AttackAction::light`);
    ///   violations reject with `MAIN_HAND_WEAPON_NOT_LIGHT` /
    ///   `OFFHAND_WEAPON_NOT_LIGHT` WITHOUT rolling anything;
    /// - the attacker can act (`EntityState::can_act`) — an unconscious or
    ///   dead creature cannot buy even a bonus strike;
    /// - a POSITIVE Strength/Dexterity-style ability modifier on the weapon's
    ///   damage expression is withheld (SRD), while a NEGATIVE one stays.
    ///
    /// Hit math, crits, cover-free AC comparison and resist/vuln/immunity all
    /// reuse [`RulesEvaluator::resolve_attack`] unchanged — the ONLY delta from
    /// a normal attack is the stripped damage expression. Advantage/disadvantage
    /// flags pass straight through (Help, Dodge etc. apply to the off-hand too).
    ///
    /// NOTE ON THE ABILITY MODIFIER SOURCE: stat blocks bake the modifier into
    /// `damage_expression` (e.g. `"1d4+3"`) rather than modelling it
    /// separately, so "withholding the ability mod" means stripping that baked
    /// trailing `+N` term. The caller decides WHICH ability score backs the
    /// finesse weapon; this function only needs the expressions themselves.
    #[allow(clippy::too_many_arguments)]
    pub fn resolve_offhand_attack(
        dice: &mut DiceEngine,
        attacker: &EntityState,
        target: &EntityState,
        main_hand_weapon: &AttackAction,
        offhand_weapon: &AttackAction,
        target_ac: i32,
        advantage: bool,
        disadvantage: bool,
    ) -> Result<OffhandAttackResolution, String> {
        // Light-property gates FIRST — an unqualified request must not roll.
        if !main_hand_weapon.light {
            return Err("MAIN_HAND_WEAPON_NOT_LIGHT".to_string());
        }
        if !offhand_weapon.light {
            return Err("OFFHAND_WEAPON_NOT_LIGHT".to_string());
        }
        if !attacker.can_act() {
            return Err("ENTITY_CANNOT_ACT".to_string());
        }

        // SRD: no POSITIVE ability modifier to off-hand damage (a negative one
        // stays). Stat blocks bake it into the expression, so strip it here.
        let (stripped_expression, withheld) = strip_positive_modifier(&offhand_weapon.damage_expression);
        let withheld = withheld.max(0);

        let roll = RulesEvaluator::resolve_attack(
            dice,
            attacker.id,
            target.id,
            offhand_weapon.attack_bonus,
            target_ac,
            stripped_expression,
            offhand_weapon.damage_type,
            target.current_hp,
            target.max_hp,
            target.temp_hp,
            &target.resistances,
            &target.vulnerabilities,
            &target.immunities,
            advantage,
            disadvantage,
        )?;

        Ok(OffhandAttackResolution {
            roll,
            damage_expression_rolled: stripped_expression.to_string(),
            ability_mod_withheld_from_damage: withheld > 0,
        })
    }
}

impl ActionResolver {
    /// Pure contested-check math: totals are compared and the higher wins,
    /// with ties awarded to the defender per SRD. Rolls are supplied by the
    /// caller (the server draws them from its seeded dice engine).
    pub fn resolve_contested_check(
        attacker_roll: i32,
        attacker_mod: i32,
        defender_roll: i32,
        defender_mod: i32,
    ) -> (ContestedSide, i32) {
        let attacker_total = attacker_roll + attacker_mod;
        let defender_total = defender_roll + defender_mod;

        // Tie -> attacker loses (defender wins).
        if attacker_total > defender_total {
            (ContestedSide::Attacker, attacker_total - defender_total)
        } else {
            (ContestedSide::Defender, defender_total - attacker_total)
        }
    }

    /// SRD Grapple: attacker's Athletics vs the DEFENDER'S CHOICE of Athletics
    /// or Acrobatics (pass their chosen skill modifier in as `defender_skill_mod`;
    /// the server maps "athletics" -> Str mod, "acrobatics" -> Dex mod).
    /// Success -> target gains `Condition::Grappled` (see the struct docs for
    /// the Grappled-vs-Restrained modelling note).
    pub fn resolve_grapple(
        attacker_roll: i32,
        attacker_athletics_mod: i32,
        defender_roll: i32,
        defender_skill_mod: i32,
    ) -> GrappleResolution {
        let (winner_side, margin) = ActionResolver::resolve_contested_check(
            attacker_roll,
            attacker_athletics_mod,
            defender_roll,
            defender_skill_mod,
        );
        let success = winner_side == ContestedSide::Attacker;
        GrappleResolution {
            contest: ContestedResolution { winner_side, margin },
            success,
            applied_condition: if success {
                Some(Condition::Grappled)
            } else {
                None
            },
        }
    }

    /// Escape DC for a creature trying to break out of an existing grapple:
    /// 8 + grappler's Strength modifier (+ prof bonus, which the stat-block
    /// model does not track — see module notes).
    pub fn grapple_escape_dc(attacker_strength_mod: i32) -> i32 {
        8 + attacker_strength_mod
    }

    /// SRD Shove: same contest as grapple (attacker Athletics vs defender's
    /// Athletics/Acrobatics choice); success inflicts the caller-chosen effect.
    pub fn resolve_shove(
        attacker_roll: i32,
        attacker_athletics_mod: i32,
        defender_roll: i32,
        defender_skill_mod: i32,
        effect: ShoveEffect,
    ) -> ShoveResolution {
        let (winner_side, margin) = ActionResolver::resolve_contested_check(
            attacker_roll,
            attacker_athletics_mod,
            defender_roll,
            defender_skill_mod,
        );
        let success = winner_side == ContestedSide::Attacker;
        let applied_condition = match (success, effect) {
            (true, ShoveEffect::Prone) => Some(Condition::Prone),
            _ => None,
        };
        ShoveResolution {
            contest: ContestedResolution { winner_side, margin },
            success,
            effect,
            applied_condition,
        }
    }
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
