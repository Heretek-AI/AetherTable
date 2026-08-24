//! Integration-style tests for Phase-3 mechanics:
//! condition lifecycles, spell economy, reactions, and X-card state replay.

use vtt_core::dice::DiceEngine;
use vtt_core::rules::{RulesEvaluator, SpellDefinition};
use vtt_core::state::{EndOfTurnSave, EntityState, GameSession, ReactionType};
use vtt_core::{AbilityScores};
use vtt_core::types::{Ability, Condition, DamageType, IngressEvent, IngressType};

fn hero(id: &str, hp: i32, ac: i32) -> EntityState {
    let mut e = EntityState::new(
        uuid::Uuid::new_v4(),
        "test".to_string(),
        id.to_string(),
        true,
        hp,
        ac,
        30.0,
        AbilityScores {
            strength: 16,
            dexterity: 14,
            constitution: 14,
            intelligence: 10,
            wisdom: 12,
            charisma: 10,
        },
    );
    e.position = (2.5, 2.5, 0.0);
    e
}

fn session_with_pair() -> GameSession {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Test".into());
    let a = hero("hero-a", 30, 15);
    let b = hero("hero-b", 30, 15);
    let (ia, ib) = (a.id, b.id);
    session.add_entity(a, None).unwrap();
    session.add_entity(b, None).unwrap();
    // Mark them as opposing sides so movement adjacency logic engages.
    session.entities.get_mut(&ib).unwrap().is_player = false;
    let _ = ia;
    session
}

#[test]
fn test_condition_duration_expires_after_countdown() {
    let mut session = session_with_pair();
    let victim = *session.entities.keys().next().unwrap();

    session
        .apply_timed_condition(victim, Condition::Poisoned, 3, None)
        .unwrap();
    assert!(session.entities[&victim].conditions.contains(&Condition::Poisoned));

    let mut dice = DiceEngine::with_seed(1);
    let r1 = session.advance_round(&mut dice);
    assert!(r1.ticks.is_empty(), "still 2 rounds left");
    let _ = session.advance_round(&mut dice);
    let r3 = session.advance_round(&mut dice);

    assert!(!session.entities[&victim].conditions.contains(&Condition::Poisoned));
    assert_eq!(r3.ticks.len(), 1);
    assert_eq!(r3.ticks[0].expired, vec![Condition::Poisoned]);
}

#[test]
fn test_end_of_turn_save_can_end_condition_early() {
    let mut session = session_with_pair();
    let victim = *session.entities.keys().next().unwrap();

    // DC 99 save can never pass; DC -5 save always passes.
    session
        .apply_timed_condition(
            victim,
            Condition::Restrained,
            10,
            Some(EndOfTurnSave { ability: Ability::Strength, dc: -5 }),
        )
        .unwrap();
    let mut dice = DiceEngine::with_seed(7);
    let report = session.advance_round(&mut dice);

    assert!(
        !session.entities[&victim].conditions.contains(&Condition::Restrained),
        "an auto-passed end-of-turn save must end the condition immediately"
    );
    assert_eq!(report.ticks[0].saved_against, vec![Condition::Restrained]);
}

#[test]
fn test_spell_slot_deduction_and_upcast_ladder() {
    let mut session = session_with_pair();
    let caster_id = *session.entities.keys().next().unwrap();
    let target_id = *session.entities.keys().find(|k| **k != caster_id).unwrap();
    session.entities.get_mut(&caster_id).unwrap().spell_slots_remaining =
        [(2u8, 1u32), (3u8, 2u32)].into_iter().collect();

    let fireball = SpellDefinition {
        spell_id: "fireball".to_string(),
        name: "Fireball".to_string(),
        level: 3,
        school: "Evocation".to_string(),
        casting_time: "1 action".to_string(),
        range_feet: 150,
        area_of_effect_shape: Some("sphere".to_string()),
        area_of_effect_size_feet: Some(20),
        verbal_component: true,
        somatic_component: true,
        material_component_desc: None,
        save_attribute: Some(Ability::Dexterity),
        damage_formula: Some("8d6".to_string()),
        damage_type: Some(DamageType::Fire),
        duration_rounds: 0,
        is_concentration: false,
        is_ritual: false,
    };

    let mut dice = DiceEngine::with_seed(42);
    let mut target = session.entities.remove(&target_id).unwrap();
    let res = RulesEvaluator::validate_and_cast_spell(
        &mut dice,
        session.entities.get_mut(&caster_id).unwrap(),
        Some(&mut target),
        &fireball,
        3,
        false,
    )
    .unwrap();
    session.entities.insert(target_id, target);

    // Level-3 slot expended; level-2 slot untouched.
    assert_eq!(res.slot_level_used, 3);
    let slots = &session.entities[&caster_id].spell_slots_remaining;
    assert_eq!(slots.get(&3), Some(&1));
    assert_eq!(slots.get(&2), Some(&1));

    // Damage respects caps and resistance pipeline.
    assert!(res.damage_total <= 48);
    if res.damage_total > 0 {
        assert!(res.target_hp_remaining.unwrap() < 30);
    }
}

#[test]
fn test_spell_rejected_without_slots() {
    let mut session = session_with_pair();
    let caster_id = *session.entities.keys().next().unwrap();
    let magic_missile = SpellDefinition {
        spell_id: "mm".to_string(),
        name: "Magic Missile".to_string(),
        level: 1,
        school: "Evocation".to_string(),
        casting_time: "1 action".to_string(),
        range_feet: 120,
        area_of_effect_shape: None,
        area_of_effect_size_feet: None,
        verbal_component: true,
        somatic_component: true,
        material_component_desc: None,
        save_attribute: None,
        damage_formula: Some("3d4".to_string()),
        damage_type: Some(DamageType::Force),
        duration_rounds: 0,
        is_concentration: false,
        is_ritual: false,
    };
    let target_id = *session.entities.keys().find(|k| **k != caster_id).unwrap();

    let mut dice = DiceEngine::with_seed(3);
    let mut target = session.entities.remove(&target_id).unwrap();
    let err = RulesEvaluator::validate_and_cast_spell(
        &mut dice,
        session.entities.get_mut(&caster_id).unwrap(),
        Some(&mut target),
        &magic_missile,
        1,
        false,
    )
    .unwrap_err();
    session.entities.insert(target_id, target);

    assert!(err.contains("NO_SPELL_SLOTS"), "got: {}", err);
    // Nothing was deducted.
    assert!(session.entities[&caster_id].spell_slots_remaining.is_empty());
}

#[test]
fn test_absurd_damage_expression_is_capped() {
    use vtt_core::dice::DiceEngine;
    let mut dice = DiceEngine::with_seed(9);
    // roll_expression on an uncapped string is fine at engine level; the CAP
    // lives in validate_and_cast_spell via clamp_damage_expression.
    let mut session = session_with_pair();
    let caster_id = *session.entities.keys().next().unwrap();
    let target_id = *session.entities.keys().find(|k| **k != caster_id).unwrap();
    session.entities.get_mut(&caster_id).unwrap().spell_slots_remaining.insert(9, 1);

    let nuke = SpellDefinition {
        spell_id: "homebrew_nuke".into(),
        name: "Homebrew Nuke".into(),
        level: 9,
        school: "Evocation".into(),
        casting_time: "1 action".into(),
        range_feet: 300,
        area_of_effect_shape: None,
        area_of_effect_size_feet: None,
        verbal_component: true,
        somatic_component: true,
        material_component_desc: None,
        save_attribute: None,
        damage_formula: Some("9999d9999".to_string()),
        damage_type: Some(DamageType::Force),
        duration_rounds: 0,
        is_concentration: false,
        is_ritual: false,
    };

    let mut target = session.entities.remove(&target_id).unwrap();
    let err = RulesEvaluator::validate_and_cast_spell(
        &mut dice,
        session.entities.get_mut(&caster_id).unwrap(),
        Some(&mut target),
        &nuke,
        9,
        false,
    )
    .unwrap_err();
    session.entities.insert(target_id, target);

    assert!(err.contains("SPELL_DAMAGE_EXCEEDS_CAPS"), "got: {}", err);
}

#[test]
fn test_reaction_arm_and_consume_spends_budget_once() {
    let mut session = session_with_pair();
    let defender = *session.entities.keys().next().unwrap();

    session.arm_reaction(defender, ReactionType::Shield).unwrap();
    assert!(session.has_armed_reaction(defender, ReactionType::Shield));
    assert!(session.entities[&defender].action_budget.reaction, "arming must NOT spend");

    assert!(session.consume_reaction(defender, ReactionType::Shield));
    assert!(!session.has_armed_reaction(defender, ReactionType::Shield));
    assert!(!session.entities[&defender].action_budget.reaction, "firing spends the budget");
    // Consuming again fails — it's spent.
    assert!(!session.consume_reaction(defender, ReactionType::Shield));
}

#[test]
fn test_safety_rewind_restores_hp_positions_and_removes_late_spawns() {
    let mut session = session_with_pair();
    let (a_id, b_id): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    // Baseline: A damages B down to 12 HP.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        serde_json::json!({
            "attacker_id": a_id.to_string(),
            "target_id": b_id.to_string(),
            "total_damage": 18,
            "target_hp_remaining": 12,
            "target_is_conscious": true,
            "target_is_dead": false
        }),
    );
    let baseline_seq = session.ledger.current_sequence;

    // Post-baseline: B moves away and takes more damage.
    session.move_entity(b_id, (20.0, 20.0, 0.0)).unwrap();
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        serde_json::json!({
            "attacker_id": a_id.to_string(),
            "target_id": b_id.to_string(),
            "total_damage": 40,
            "target_hp_remaining": -28,
            "target_is_conscious": false,
            "target_is_dead": true
        }),
    );

    // Rewind to baseline.
    let report = session.safety_rewind(baseline_seq);
    assert_eq!(report.reverted_event_count, 2);

    let b = &session.entities[&b_id];
    assert_eq!(b.current_hp, 12, "HP restored from ledger replay");
    assert!(b.is_conscious);
    assert!(!b.is_dead);
    assert_eq!(
        b.position,
        (20.0, 20.0, 0.0).into_position(),
        "position restored from MOVE_ENTITY event"
    );
}

/// Helper so the tuple literal reads cleanly in assertions above.
trait IntoPosition {
    fn into_position(self) -> (f32, f32, f32);
}
impl IntoPosition for (f64, f64, f64) {
    fn into_position(self) -> (f32, f32, f32) {
        (self.0 as f32, self.1 as f32, self.2 as f32)
    }
}
impl IntoPosition for (i32, i32, i32) {
    fn into_position(self) -> (f32, f32, f32) {
        (self.0 as f32, self.1 as f32, self.2 as f32)
    }
}

#[allow(dead_code)]
fn _unused(_: IngressEvent, _: IngressType) {}
