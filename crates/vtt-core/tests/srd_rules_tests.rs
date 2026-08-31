use vtt_core::actions::{ActionResolver, AttackOutcome};
use vtt_core::dice::DiceEngine;
use vtt_core::modifier_graph::{
    calculate_ability_modifier, calculate_armor_class, calculate_passive_perception,
    calculate_proficiency_bonus,
};
use vtt_core::rules::{ConcentrationBreakResult, RulesEvaluator};
use vtt_core::state::{ConcentrationState, EntityState};
use vtt_core::types::*;

fn dummy_entity(name: &str) -> EntityState {
    EntityState::new(
        uuid::Uuid::new_v4(),
        format!("compendium_{}", name),
        name.to_string(),
        false,
        20,
        14,
        30.0,
        AbilityScores::default(),
    )
}

#[test]
fn test_srd_ability_modifier_floored_formula() {
    assert_eq!(calculate_ability_modifier(1), -5);
    assert_eq!(calculate_ability_modifier(3), -4);
    assert_eq!(calculate_ability_modifier(8), -1);
    assert_eq!(calculate_ability_modifier(9), -1);
    assert_eq!(calculate_ability_modifier(10), 0);
    assert_eq!(calculate_ability_modifier(11), 0);
    assert_eq!(calculate_ability_modifier(12), 1);
    assert_eq!(calculate_ability_modifier(13), 1);
    assert_eq!(calculate_ability_modifier(14), 2);
    assert_eq!(calculate_ability_modifier(15), 2);
    assert_eq!(calculate_ability_modifier(18), 4);
    assert_eq!(calculate_ability_modifier(20), 5);
    assert_eq!(calculate_ability_modifier(30), 10);
}

#[test]
fn test_srd_proficiency_bonus_progression() {
    assert_eq!(calculate_proficiency_bonus(1), 2);
    assert_eq!(calculate_proficiency_bonus(4), 2);
    assert_eq!(calculate_proficiency_bonus(5), 3);
    assert_eq!(calculate_proficiency_bonus(8), 3);
    assert_eq!(calculate_proficiency_bonus(9), 4);
    assert_eq!(calculate_proficiency_bonus(12), 4);
    assert_eq!(calculate_proficiency_bonus(13), 5);
    assert_eq!(calculate_proficiency_bonus(16), 5);
    assert_eq!(calculate_proficiency_bonus(17), 6);
    assert_eq!(calculate_proficiency_bonus(20), 6);
}

#[test]
fn test_srd_all_armor_class_derivations() {
    // 1. Unarmored: 10 + DEX(+3) = 13
    assert_eq!(
        calculate_armor_class(ArmorType::Unarmored, 10, 16, false, None),
        13
    );

    // 2. Barbarian Unarmored Defense: 10 + DEX(+2) + CON(+3) = 15
    assert_eq!(
        calculate_armor_class(ArmorType::BarbarianUnarmored, 10, 14, false, Some(16)),
        15
    );

    // 3. Monk Unarmored Defense: 10 + DEX(+3) + WIS(+4) = 17
    assert_eq!(
        calculate_armor_class(ArmorType::MonkUnarmored, 10, 16, false, Some(18)),
        17
    );

    // 4. Light Armor (Studded Leather base 12) + DEX(+3) = 15
    assert_eq!(
        calculate_armor_class(ArmorType::LightArmor, 12, 16, false, None),
        15
    );

    // 5. Medium Armor (Breastplate base 14) + DEX 18 (+4 mod capped at +2) = 16
    assert_eq!(
        calculate_armor_class(ArmorType::MediumArmor, 14, 18, false, None),
        16
    );

    // 6. Heavy Armor (Plate base 18) - DEX ignored = 18
    assert_eq!(
        calculate_armor_class(ArmorType::HeavyArmor, 18, 18, false, None),
        18
    );

    // 7. Shield adds +2 AC to Plate = 20
    assert_eq!(
        calculate_armor_class(ArmorType::HeavyArmor, 18, 18, true, None),
        20
    );
}

#[test]
fn test_srd_passive_perception_formula() {
    // WIS 14 (+2), Proficient with Prof Bonus +3, Flat Bonus +5 (Observant feat) = 20
    assert_eq!(calculate_passive_perception(14, true, 3, 5), 20);

    // WIS 10 (+0), Not proficient = 10
    assert_eq!(calculate_passive_perception(10, false, 2, 0), 10);
}

#[test]
fn test_srd_conditions_and_auto_crit_mechanics() {
    // Paralyzed condition:
    let paralyzed = Condition::Paralyzed;
    assert!(paralyzed.is_incapacitated());
    assert!(paralyzed.fails_str_dex_saves());
    assert!(paralyzed.grants_advantage_to_attacker(5.0));
    assert!(paralyzed.grants_auto_crit_within_5ft(5.0));
    assert!(!paralyzed.grants_auto_crit_within_5ft(10.0));

    // Prone condition:
    let prone = Condition::Prone;
    assert!(prone.grants_advantage_to_attacker(5.0)); // within 5ft -> advantage
    assert!(prone.inflicts_disadvantage_on_attacker(15.0)); // > 5ft -> disadvantage
    assert!(prone.inflicts_disadvantage_on_attacks());

    // Exhaustion condition:
    assert!(!Condition::Exhaustion(2).inflicts_disadvantage_on_attacks());
    assert!(Condition::Exhaustion(3).inflicts_disadvantage_on_attacks());
}

#[test]
fn test_srd_restrained_condition_clauses() {
    // SRD 5.1 Restrained, clause by clause:
    // - "Attack rolls against the creature have advantage." (no range limit,
    //   unlike Prone's within-5ft rule)
    // - "The creature's attack rolls have disadvantage."
    // - "The creature has disadvantage on Dexterity saving throws."
    // - "Speed becomes 0." (covered by the effective_speed tests in
    //   mechanics_tests.rs; asserted here via the helper contract only.)
    let restrained = Condition::Restrained;
    assert!(
        restrained.grants_advantage_to_attacker(5.0),
        "attackers get advantage in melee"
    );
    assert!(
        restrained.grants_advantage_to_attacker(120.0),
        "attack advantage is NOT limited to 5 ft"
    );
    assert!(restrained.inflicts_disadvantage_on_attacks());

    // The save clause is its own helper (added this iteration) and must not
    // leak into the auto-fail or attack-disadvantage semantics.
    assert!(
        restrained.inflicts_disadvantage_on_dex_saves(),
        "Restrained imposes disadvantage on Dex saves"
    );
    assert!(
        !restrained.fails_str_dex_saves(),
        "disadvantage != auto-fail"
    );

    // No other condition carries the Dex-save disadvantage.
    for c in [
        Condition::Grappled,
        Condition::Blinded,
        Condition::Poisoned,
        Condition::Prone,
        Condition::Frightened,
        Condition::Exhaustion(6),
    ] {
        assert!(
            !c.inflicts_disadvantage_on_dex_saves(),
            "{:?} must not impose Dex-save disadvantage",
            c
        );
    }
}

#[test]
fn test_srd_attack_resolution() {
    // 1. Natural 20 is always Critical Hit with 2x damage dice multiplier
    let nat20_res = ActionResolver::resolve_attack(20, 3, 25, &[], &[], 10.0);
    assert_eq!(nat20_res.outcome, AttackOutcome::CriticalHit);
    assert!(nat20_res.is_hit);
    assert!(nat20_res.is_critical);
    assert_eq!(nat20_res.damage_dice_multiplier, 2);

    // 2. Natural 1 is always Critical Miss
    let nat1_res = ActionResolver::resolve_attack(1, 15, 10, &[], &[], 5.0);
    assert_eq!(nat1_res.outcome, AttackOutcome::CriticalMiss);
    assert!(!nat1_res.is_hit);

    // 3. Normal Hit vs AC
    let hit_res = ActionResolver::resolve_attack(12, 5, 16, &[], &[], 5.0);
    assert_eq!(hit_res.outcome, AttackOutcome::Hit);
    assert!(hit_res.is_hit);
    assert_eq!(hit_res.damage_dice_multiplier, 1);

    // 4. Attack vs Unconscious target within 5ft -> Auto Crit
    let auto_crit_res =
        ActionResolver::resolve_attack(10, 5, 14, &[], &[Condition::Unconscious], 5.0);
    assert!(auto_crit_res.is_hit);
    assert!(auto_crit_res.is_critical);
    assert_eq!(auto_crit_res.damage_dice_multiplier, 2);
}

#[test]
fn test_srd_concentration_and_death_saving_throws() {
    // Concentration Check: DC = max(10, damage / 2)
    // 12 damage -> DC 10
    let (pass1, _, dc1) = ActionResolver::resolve_concentration_check(8, 2, 12);
    assert_eq!(dc1, 10);
    assert!(pass1);

    // 50 damage -> DC 25
    let (pass2, _, dc2) = ActionResolver::resolve_concentration_check(18, 5, 50);
    assert_eq!(dc2, 25);
    assert!(!pass2);

    // Massive Damage Instant Death: Damage >= current_hp + max_hp
    assert!(ActionResolver::check_instant_death(50, 5, 40));
    assert!(!ActionResolver::check_instant_death(30, 5, 40));

    // Death Save State Progression:
    let mut death_state = DeathSaveState::default();
    assert_eq!(
        ActionResolver::resolve_death_save(&mut death_state, 12),
        "PENDING"
    );
    assert_eq!(death_state.successes, 1);

    assert_eq!(
        ActionResolver::resolve_death_save(&mut death_state, 1),
        "PENDING"
    ); // +2 failures
    assert_eq!(death_state.failures, 2);

    assert_eq!(
        ActionResolver::resolve_death_save(&mut death_state, 8),
        "DEAD"
    ); // 3rd failure
    assert!(death_state.is_dead);
}

#[test]
fn test_srd_3d_elevation_and_fall_damage() {
    let mut dice = vtt_core::dice::DiceEngine::with_seed(42);

    // Falling 30ft results in 3d6 bludgeoning damage
    let (dmg_30ft, is_prone) =
        vtt_core::rules::RulesEvaluator::calculate_fall_damage(&mut dice, 30.0, None);
    assert!((3..=18).contains(&dmg_30ft));
    assert!(is_prone);

    // Acrobatics save DC 15 lands on feet (not prone)
    let (_, lands_on_feet) =
        vtt_core::rules::RulesEvaluator::calculate_fall_damage(&mut dice, 20.0, Some(16));
    assert!(!lands_on_feet); // is_prone = false

    // High ground advantage (+2 to hit when >= 10ft higher)
    assert_eq!(
        vtt_core::rules::RulesEvaluator::calculate_high_ground_attack_bonus(20.0, 0.0),
        2
    );
    assert_eq!(
        vtt_core::rules::RulesEvaluator::calculate_high_ground_attack_bonus(5.0, 0.0),
        0
    );
}

#[test]
fn test_srd_concentration_state_machine() {
    let mut caster = dummy_entity("wizard");
    assert!(caster.concentration.is_none());

    // Begin concentration
    RulesEvaluator::begin_concentration(&mut caster, "spell_haste");
    let conc = caster.concentration.as_ref().expect("concentration active");
    // started_round defaults to 0 (rounds are not tracked at this layer)
    assert_eq!(conc.started_round, 0);

    // Replacement rule: casting a second concentration spell overwrites the first
    RulesEvaluator::begin_concentration(&mut caster, "spell_fly");
    let conc = caster.concentration.as_ref().expect("still concentrating");
    assert_eq!(conc.spell_id, "spell_fly");

    // Zero damage => no check is triggered (maintained, DC reported as 0)
    let noop = RulesEvaluator::apply_damage_to_concentration(&mut caster, 0, 5, -1);
    assert_eq!(
        noop,
        ConcentrationBreakResult {
            dc: 0,
            total: 4,
            maintained: true
        }
    );
    assert_eq!(
        caster.concentration.as_ref().expect("kept").spell_id,
        "spell_fly"
    );

    // DC floor: 12 damage would scale to DC 6 but the floor is DC 10 -> failed save breaks it
    let broken = RulesEvaluator::apply_damage_to_concentration(&mut caster, 12, 8, 1);
    assert_eq!(broken.dc, 10);
    assert_eq!(broken.total, 9);
    assert!(!broken.maintained);
    assert!(caster.concentration.is_none());

    // Re-concentrate; damage-scaled DC above floor: 50 damage -> DC 25 -> passed save keeps it
    RulesEvaluator::begin_concentration(&mut caster, "spell_web");
    let held = RulesEvaluator::apply_damage_to_concentration(&mut caster, 50, 20, 5);
    assert_eq!(held.dc, 25);
    assert_eq!(held.total, 25);
    assert!(held.maintained);
    assert_eq!(
        caster.concentration.as_ref().expect("kept").spell_id,
        "spell_web"
    );

    // Voluntary end reports whether a spell was actually dropped
    assert!(RulesEvaluator::end_concentration(
        &mut caster,
        "SPELL_ENDED"
    ));
    assert!(caster.concentration.is_none());
    assert!(!RulesEvaluator::end_concentration(
        &mut caster,
        "SPELL_ENDED"
    ));
}

#[test]
fn test_srd_invisible_attacker_gains_advantage() {
    // SRD 5.1 Invisible: "Attacks against the creature have disadvantage, and
    // the creature's attacks have advantage." The target-side clause is already
    // wired (inflicts_disadvantage_on_attacker); this pins the attacker-side
    // clause.
    let mut invisible_attacker = dummy_entity("shadow_dancer");
    invisible_attacker.conditions.push(Condition::Invisible);
    let visible_target = dummy_entity("watchman");

    let (adv, dis) =
        RulesEvaluator::edge_from_conditions(&invisible_attacker, &visible_target, 30.0, 0.0, 0.0);
    assert!(adv, "invisible creature's own attacks have advantage");
    assert!(
        !dis,
        "invisibility alone imposes no disadvantage on the attacker"
    );

    // Symmetric: the invisible creature as TARGET still imposes disadvantage on
    // the attacker (existing clause, must not regress).
    let visible_attacker = dummy_entity("swordsman");
    let mut invisible_target = dummy_entity("phantom");
    invisible_target.conditions.push(Condition::Invisible);
    let (adv_t, dis_t) =
        RulesEvaluator::edge_from_conditions(&visible_attacker, &invisible_target, 30.0, 0.0, 0.0);
    assert!(
        !adv_t,
        "an invisible target grants no advantage to the attacker"
    );
    assert!(
        dis_t,
        "attacks against an invisible target have disadvantage"
    );

    // Cancellation: an invisible attacker who is ALSO blinded — the SRD
    // disadvantage from blindness cancels the invisibility advantage into a
    // straight d20 (both flags set, resolved in resolve_attack).
    let mut blind_invisible = dummy_entity("cursed_wraith");
    blind_invisible.conditions.push(Condition::Invisible);
    blind_invisible.conditions.push(Condition::Blinded);
    let (adv_c, dis_c) =
        RulesEvaluator::edge_from_conditions(&blind_invisible, &visible_target, 30.0, 0.0, 0.0);
    assert!(
        adv_c && dis_c,
        "blindness cancels invisibility advantage into a straight roll"
    );
}

#[test]
fn test_srd_edge_from_conditions_cancellation() {
    // Blinded attacker vs restrained target: attacker's own blindness imposes
    // disadvantage while the target grants advantage — both flags set, and per SRD
    // they cancel to a straight d20 inside resolve_attack.
    let mut attacker = dummy_entity("blinded_archer");
    attacker.conditions.push(Condition::Blinded);
    let mut restrained_target = dummy_entity("restrained_ogre");
    restrained_target.conditions.push(Condition::Restrained);

    let (adv, dis) =
        RulesEvaluator::edge_from_conditions(&attacker, &restrained_target, 30.0, 0.0, 0.0);
    assert!(adv && dis, "expected both flags true for cancelling pair");

    // Blinded attacker vs prone target BEYOND 5 ft: prone grants no advantage at range,
    // so this is pure disadvantage (no cancellation).
    let mut prone_target = dummy_entity("prone_goblin");
    prone_target.conditions.push(Condition::Prone);
    let (adv_far, dis_far) =
        RulesEvaluator::edge_from_conditions(&attacker, &prone_target, 30.0, 0.0, 0.0);
    assert!(!adv_far && dis_far);

    // Prone target within 5 ft: melee attackers get pure advantage, no disadvantage.
    let clean_attacker = dummy_entity("barbarian");
    let (adv_close, dis_close) =
        RulesEvaluator::edge_from_conditions(&clean_attacker, &prone_target, 5.0, 0.0, 0.0);
    assert!(adv_close && !dis_close);

    // Exhaustion level 3+ on the attacker imposes disadvantage on its own attacks.
    let mut exhausted = dummy_entity("exhausted_ranger");
    exhausted.conditions.push(Condition::Exhaustion(3));
    let fresh_target = dummy_entity("orc");
    let (adv_ex, dis_ex) =
        RulesEvaluator::edge_from_conditions(&exhausted, &fresh_target, 30.0, 0.0, 0.0);
    assert!(!adv_ex && dis_ex);

    // High ground only counts when the existing bonus is > 0 (+2 requires >= 10 ft).
    let (adv_high, dis_high) =
        RulesEvaluator::edge_from_conditions(&clean_attacker, &fresh_target, 60.0, 15.0, 0.0);
    assert!(adv_high && !dis_high);
    let (adv_low, dis_low) =
        RulesEvaluator::edge_from_conditions(&clean_attacker, &fresh_target, 60.0, 5.0, 0.0);
    assert!(!adv_low && !dis_low);

    // Cancellation semantics in resolve_attack: adv + dis resolves as a single straight d20,
    // identical to a plain roll from an identically-seeded engine.
    const SEED: u64 = 90210;
    let mut straight = DiceEngine::with_seed(SEED);
    let expected = straight.roll_d20();

    let mut cancelled = DiceEngine::with_seed(SEED);
    let result = RulesEvaluator::resolve_attack(
        &mut cancelled,
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4(),
        5,
        13,
        "1d8+3",
        DamageType::Piercing,
        20,
        20,
        0,
        &[],
        &[],
        &[],
        true, // advantage
        true, // disadvantage — cancels to straight roll
    )
    .expect("attack resolves");
    assert_eq!(result.natural_roll, expected);

    // Sanity check that a real edge is applied: advantage-only takes max of two d20s
    // from an identically-seeded engine.
    let mut pair = DiceEngine::with_seed(SEED);
    let r1 = pair.roll_d20();
    let r2 = pair.roll_d20();
    let mut adv_engine = DiceEngine::with_seed(SEED);
    let adv_result = RulesEvaluator::resolve_attack(
        &mut adv_engine,
        uuid::Uuid::new_v4(),
        uuid::Uuid::new_v4(),
        5,
        13,
        "1d8+3",
        DamageType::Piercing,
        20,
        20,
        0,
        &[],
        &[],
        &[],
        true,
        false,
    )
    .expect("attack resolves");
    assert_eq!(adv_result.natural_roll, r1.max(r2));
}

#[test]
fn test_srd_concentration_state_serialization_roundtrip() {
    // New field is skipped when None and deserializes back from legacy JSON without it.
    let json = r#"{
        "id": "00000000-0000-0000-0000-000000000001",
        "compendium_id": "goblin",
        "name": "Goblin",
        "is_player": false,
        "current_hp": 7,
        "max_hp": 7,
        "temp_hp": 0,
        "ac": 15,
        "speed_feet": 30.0,
        "position": [0.0, 0.0, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {
            "strength": 8, "dexterity": 14, "constitution": 10,
            "intelligence": 10, "wisdom": 8, "charisma": 8
        },
        "conditions": [],
        "action_budget": {
            "action": true, "bonus_action": true, "reaction": true,
            "movement_remaining_feet": 30.0, "free_object_interaction": true
        },
        "spell_slots_remaining": {},
        "inventory": { "items": {} },
        "is_conscious": true,
        "is_dead": false,
        "is_visible": true
    }"#;
    let legacy: EntityState = serde_json::from_str(json).expect("legacy JSON deserializes");
    assert!(legacy.concentration.is_none());
    assert!(!serde_json::to_string(&legacy)
        .expect("serializes")
        .contains("\"concentration\""));

    let mut concentrated = legacy.clone();
    concentrated.concentration = Some(ConcentrationState {
        spell_id: "spell_hunters_mark".to_string(),
        started_round: 3,
    });
    let serialized = serde_json::to_string(&concentrated).expect("serializes");
    assert!(serialized.contains("\"concentration\""));
    let roundtrip: EntityState =
        serde_json::from_str(&serialized).expect("concentration roundtrips");
    let conc = roundtrip.concentration.expect("present");
    assert_eq!(conc.spell_id, "spell_hunters_mark");
    assert_eq!(conc.started_round, 3);
}

// --- Contested checks: Grapple & Shove (SRD 5e melee attack alternatives) -----
//
// Grapple and Shove are contested ability checks that replace one attack:
//   - Grapple: Athletics(A) vs Athletics/Acrobatics(D, defender's choice)
//     success -> target becomes Grappled.
//   - Shove: same contest; success -> target knocked Prone OR pushed 5 ft.

use vtt_core::actions::{ContestedSide, ShoveEffect};

#[test]
fn test_contested_check_attacker_wins_by_margin() {
    // 15+3 = 18 vs 11+2 = 13 -> attacker wins by 5.
    let (winner, margin) = ActionResolver::resolve_contested_check(15, 3, 11, 2);
    assert_eq!(winner, ContestedSide::Attacker);
    assert_eq!(margin, 5);
}

#[test]
fn test_contested_check_defender_wins_by_margin() {
    // 6+0 = 6 vs 17+4 = 21 -> defender wins by 15.
    let (winner, margin) = ActionResolver::resolve_contested_check(6, 0, 17, 4);
    assert_eq!(winner, ContestedSide::Defender);
    assert_eq!(margin, 15);
}

#[test]
fn test_contested_check_tie_goes_to_defender() {
    // SRD: on equal contested totals the attacker LOSES the tie.
    let (winner, margin) = ActionResolver::resolve_contested_check(10, 3, 13, 0);
    assert_eq!(winner, ContestedSide::Defender);
    assert_eq!(margin, 0);
}

#[test]
fn test_grapple_success_applies_grappled_condition() {
    // 16+3 = 19 vs 8+1 = 9 -> grappler wins, target is Grappled.
    let res = ActionResolver::resolve_grapple(16, 3, 8, 1);
    assert!(res.success);
    assert_eq!(res.contest.winner_side, ContestedSide::Attacker);
    assert_eq!(res.applied_condition, Some(Condition::Grappled));
}

#[test]
fn test_grapple_tie_or_loss_applies_nothing() {
    let tie = ActionResolver::resolve_grapple(10, 3, 13, 0);
    assert!(!tie.success);
    assert_eq!(tie.applied_condition, None);

    let lost = ActionResolver::resolve_grapple(5, 0, 14, 2);
    assert!(!lost.success);
    assert_eq!(lost.applied_condition, None);
}

#[test]
fn test_shove_prone_applies_prone_condition() {
    let res = ActionResolver::resolve_shove(14, 3, 10, 1, ShoveEffect::Prone);
    assert!(res.success);
    assert_eq!(res.effect, ShoveEffect::Prone);
    assert_eq!(res.applied_condition, Some(Condition::Prone));
}

#[test]
fn test_shove_push_5ft_applies_no_condition() {
    let res = ActionResolver::resolve_shove(14, 3, 10, 1, ShoveEffect::Push5Feet);
    assert!(res.success);
    assert_eq!(res.effect, ShoveEffect::Push5Feet);
    assert_eq!(res.applied_condition, None);
}

#[test]
fn test_shove_failure_has_no_effect() {
    let res = ActionResolver::resolve_shove(7, 0, 15, 3, ShoveEffect::Prone);
    assert!(!res.success);
    assert_eq!(res.applied_condition, None);
}

/// SRD escape DC = 8 + grappler's Strength (Athletics) + proficiency. The
/// stat-block model carries no proficiency bonus per entity, so the engine
/// uses the documented approximation 8 + Str mod.
#[test]
fn test_grapple_escape_dc_is_eight_plus_strength_mod() {
    assert_eq!(ActionResolver::grapple_escape_dc(3), 11);
    assert_eq!(ActionResolver::grapple_escape_dc(-1), 7);
}

// --- EntityState condition mutation helpers -----------------------------------

#[test]
fn test_add_and_remove_condition_helpers_are_idempotent() {
    use vtt_core::types::Condition;
    let mut e = dummy_entity("brawler");

    e.add_condition(Condition::Grappled);
    e.add_condition(Condition::Grappled); // duplicate is a no-op
    assert_eq!(
        e.conditions
            .iter()
            .filter(|c| **c == Condition::Grappled)
            .count(),
        1
    );
    assert!(e.has_condition(&Condition::Grappled));

    assert!(e.remove_condition(&Condition::Grappled));
    assert!(!e.has_condition(&Condition::Grappled));
    assert!(!e.remove_condition(&Condition::Grappled)); // nothing left to remove

    // Exhaustion(u8) matches by variant discriminant, not payload value.
    e.add_condition(Condition::Exhaustion(2));
    assert!(e.has_condition(&Condition::Exhaustion(5)));
    assert!(e.remove_condition(&Condition::Exhaustion(4)));
}

#[test]
fn test_srd_blinded_target_grants_attacker_advantage() {
    // SRD blinded (PHB appendix A): attacks against a blinded creature have
    // advantage. The attacker itself sees fine, so no disadvantage applies.
    let attacker = dummy_entity("sighted_archer");
    let mut blinded_target = dummy_entity("blinded_owlbear");
    blinded_target.conditions.push(Condition::Blinded);

    let (adv, dis) =
        RulesEvaluator::edge_from_conditions(&attacker, &blinded_target, 30.0, 0.0, 0.0);
    assert!(adv, "attacks against a blinded target roll with advantage");
    assert!(
        !dis,
        "blindness of the TARGET never disadvantages the attacker"
    );
}
