use vtt_core::actions::{ActionResolver, AttackOutcome};
use vtt_core::modifier_graph::{
    calculate_ability_modifier, calculate_armor_class, calculate_passive_perception,
    calculate_proficiency_bonus,
};
use vtt_core::types::*;

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
    let auto_crit_res = ActionResolver::resolve_attack(
        10,
        5,
        14,
        &[],
        &[Condition::Unconscious],
        5.0,
    );
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
    assert_eq!(ActionResolver::resolve_death_save(&mut death_state, 12), "PENDING");
    assert_eq!(death_state.successes, 1);

    assert_eq!(ActionResolver::resolve_death_save(&mut death_state, 1), "PENDING"); // +2 failures
    assert_eq!(death_state.failures, 2);

    assert_eq!(ActionResolver::resolve_death_save(&mut death_state, 8), "DEAD"); // 3rd failure
    assert!(death_state.is_dead);
}

#[test]
fn test_srd_3d_elevation_and_fall_damage() {
    let mut dice = vtt_core::dice::DiceEngine::with_seed(42);

    // Falling 30ft results in 3d6 bludgeoning damage
    let (dmg_30ft, is_prone) = vtt_core::rules::RulesEvaluator::calculate_fall_damage(&mut dice, 30.0, None);
    assert!(dmg_30ft >= 3 && dmg_30ft <= 18);
    assert!(is_prone);

    // Acrobatics save DC 15 lands on feet (not prone)
    let (_, lands_on_feet) = vtt_core::rules::RulesEvaluator::calculate_fall_damage(&mut dice, 20.0, Some(16));
    assert!(!lands_on_feet); // is_prone = false

    // High ground advantage (+2 to hit when >= 10ft higher)
    assert_eq!(vtt_core::rules::RulesEvaluator::calculate_high_ground_attack_bonus(20.0, 0.0), 2);
    assert_eq!(vtt_core::rules::RulesEvaluator::calculate_high_ground_attack_bonus(5.0, 0.0), 0);
}
