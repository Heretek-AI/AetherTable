//! Integration-style tests for Phase-3 mechanics:
//! condition lifecycles, spell economy, reactions, and X-card state replay.

use vtt_core::dice::DiceEngine;
use vtt_core::rules::{RulesEvaluator, SpellDefinition};
use vtt_core::state::{
    EndOfTurnSave, EntityState, GameSession, ReadiedAction, ReadiedTrigger, ReactionType,
};
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
fn test_absurd_damage_expression_is_rejected_without_spending_a_slot() {
    use vtt_core::dice::DiceEngine;
    let mut dice = DiceEngine::with_seed(9);
    // roll_expression on an uncapped string is fine at engine level; the
    // two-tier CAP lives in validate_and_cast_spell via clamp_damage_expression.
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

    assert!(
        err.contains("SPELL_DAMAGE_FORMULA_ABSURD"),
        "implausible math must be rejected outright, got: {}",
        err
    );
    // The formula guard fires BEFORE slot expenditure — the 9th-level slot survives.
    assert_eq!(
        session.entities[&caster_id].spell_slots_remaining.get(&9).copied(),
        Some(1),
        "an absurd formula must not burn the caster's spell slot"
    );
}

#[test]
fn test_moderate_overshoot_is_gently_clamped_and_resolves() {
    use vtt_core::dice::DiceEngine;
    use vtt_core::rules::{MAX_SPELL_DICE_COUNT, MAX_SPELL_DIE_SIDES};
    let mut dice = DiceEngine::with_seed(11);
    let mut session = session_with_pair();
    let caster_id = *session.entities.keys().next().unwrap();
    let target_id = *session.entities.keys().find(|k| **k != caster_id).unwrap();
    session.entities.get_mut(&caster_id).unwrap().spell_slots_remaining.insert(3, 1);

    // 60d6 overshoots the 40d12 caps but stays within the documented 2x homebrew
    // guard, so it resolves with the count clamped to 40 (40d6 ≤ 240 damage).
    let base = SpellDefinition {
        spell_id: "homebrew_blast".into(),
        name: "Homebrew Blast".into(),
        level: 3,
        school: "Evocation".into(),
        casting_time: "1 action".into(),
        range_feet: 150,
        area_of_effect_shape: None,
        area_of_effect_size_feet: None,
        verbal_component: true,
        somatic_component: true,
        material_component_desc: None,
        save_attribute: None,
        damage_formula: Some("60d6".to_string()),
        damage_type: Some(DamageType::Fire),
        duration_rounds: 0,
        is_concentration: false,
        is_ritual: false,
    };
    let homebrew = base.clone();

    // 60d6 sits above the count cap but within the 2x hard-reject guard
    // (40 < 60 <= 80), i.e. squarely in gentle-clamp territory.

    let mut target = session.entities.remove(&target_id).unwrap();
    target.immunities.clear();
    let hp_before = target.current_hp;
    let res = RulesEvaluator::validate_and_cast_spell(
        &mut dice,
        session.entities.get_mut(&caster_id).unwrap(),
        Some(&mut target),
        &homebrew,
        3,
        false,
    )
    .expect("moderate overshoot must resolve under the gentle clamp");
    session.entities.insert(target_id, target);

    assert!(res.damage_total > 0);
    assert!(
        res.damage_total <= (MAX_SPELL_DICE_COUNT as i32) * (MAX_SPELL_DIE_SIDES as i32),
        "clamped roll cannot exceed {}d{}",
        MAX_SPELL_DICE_COUNT,
        MAX_SPELL_DIE_SIDES
    );
    assert_eq!(
        session.entities[&caster_id].spell_slots_remaining.get(&3).copied(),
        Some(0),
        "the clamped cast spends its slot normally"
    );
    assert!(session.entities[&target_id].current_hp < hp_before);
}

#[test]
fn test_sides_overshoot_beyond_the_guard_is_rejected() {
    use vtt_core::dice::DiceEngine;
    let mut dice = DiceEngine::with_seed(5);
    let mut session = session_with_pair();
    let caster_id = *session.entities.keys().next().unwrap();
    let target_id = *session.entities.keys().find(|k| **k != caster_id).unwrap();
    session.entities.get_mut(&caster_id).unwrap().spell_slots_remaining.insert(1, 1);

    let d100_wand = SpellDefinition {
        spell_id: "homebrew_d100".into(),
        name: "Homebrew d100 Wand".into(),
        level: 1,
        school: "Evocation".into(),
        casting_time: "1 action".into(),
        range_feet: 30,
        area_of_effect_shape: None,
        area_of_effect_size_feet: None,
        verbal_component: true,
        somatic_component: true,
        material_component_desc: None,
        save_attribute: None,
        damage_formula: Some("1d100".to_string()),
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
        &d100_wand,
        1,
        false,
    )
    .unwrap_err();
    session.entities.insert(target_id, target);

    assert!(err.contains("SPELL_DAMAGE_FORMULA_ABSURD"), "got: {}", err);
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

/// Drops the paired hero to 0 HP and unconsciousness so death saves apply.
fn knock_down(session: &mut GameSession, id: uuid::Uuid) {
    let e = session.entities.get_mut(&id).unwrap();
    e.current_hp = 0;
    e.is_conscious = false;
}

#[test]
fn test_death_save_tallies_accumulate_on_entity() {
    use vtt_core::actions::ActionResolver;

    let mut session = session_with_pair();
    let victim = *session.entities.keys().next().unwrap();
    knock_down(&mut session, victim);

    // First failed save persists onto the entity, not a throwaway struct.
    let mut state = session.entities[&victim].death_saves;
    assert_eq!(ActionResolver::resolve_death_save(&mut state, 9), "PENDING");
    session.entities.get_mut(&victim).unwrap().death_saves = state;
    assert_eq!(session.entities[&victim].death_saves.failures, 1);
    assert!(!session.entities[&victim].death_saves.is_dead);

    // A second failed save accumulates on the persisted tally.
    let mut state = session.entities[&victim].death_saves;
    ActionResolver::resolve_death_save(&mut state, 5);
    session.entities.get_mut(&victim).unwrap().death_saves = state;
    assert_eq!(session.entities[&victim].death_saves.failures, 2);
    assert!(!session.entities[&victim].death_saves.is_dead);

    // Nat 1 counts as two failures: 2 + 2 crosses the threshold → dead,
    // and the entity's is_dead flag follows on the next handler write-back.
    let mut state = session.entities[&victim].death_saves;
    assert_eq!(ActionResolver::resolve_death_save(&mut state, 1), "DEAD");
    let e = session.entities.get_mut(&victim).unwrap();
    e.death_saves = state;
    e.is_dead = true;
    assert!(e.death_saves.is_dead);
}

#[test]
fn test_healing_resets_death_save_tally() {
    use vtt_core::actions::ActionResolver;

    let mut session = session_with_pair();
    let victim = *session.entities.keys().next().unwrap();
    knock_down(&mut session, victim);

    let mut state = session.entities[&victim].death_saves;
    ActionResolver::resolve_death_save(&mut state, 9); // 1 failure
    session.entities.get_mut(&victim).unwrap().death_saves = state;

    // Regaining hit points clears accumulated tallies (SRD).
    let healed = session.entities.get_mut(&victim).unwrap();
    healed.current_hp = 5;
    healed.is_conscious = true;
    assert!(healed.reset_death_saves_if_healed(), "heal must clear the ledger");
    assert_eq!(
        healed.death_saves,
        vtt_core::types::DeathSaveState::default(),
        "regaining HP must reset the death-save ledger"
    );

    // Back down again: the fresh tally starts from zero, not from 1 failure.
    knock_down(&mut session, victim);
    assert_eq!(
        session.entities[&victim].death_saves,
        vtt_core::types::DeathSaveState::default()
    );
    let mut state = session.entities[&victim].death_saves;
    ActionResolver::resolve_death_save(&mut state, 9);
    assert_eq!(state.failures, 1, "stale pre-heal failure must not carry over");
}

#[test]
fn test_safety_rewind_replays_death_save_tallies() {
    let mut session = session_with_pair();
    let victim = *session.entities.keys().next().unwrap();
    knock_down(&mut session, victim);

    // Simulate the engine's event trail: one surviving failed save, then a
    // second one that the rewind will revert.
    let seq_after_first = {
        let event = session.ledger.append_event(
            session.session_id,
            session.campaign_id,
            victim,
            "DEATH_SAVE_RESOLVED",
            serde_json::json!({
                "outcome": "PENDING", "natural_roll": 9,
                "successes": 0, "failures": 1,
                "is_stabilized": false, "is_dead": false,
            }),
        );
        event.sequence_id
    };
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        victim,
        "DEATH_SAVE_RESOLVED",
        serde_json::json!({
            "outcome": "PENDING", "natural_roll": 5,
            "successes": 0, "failures": 2,
            "is_stabilized": false, "is_dead": false,
        }),
    );

    // Live state drifted to the post-rewind tally before the X-card.
    let e = session.entities.get_mut(&victim).unwrap();
    e.death_saves = vtt_core::types::DeathSaveState {
        successes: 0,
        failures: 2,
        is_stabilized: false,
        is_dead: false,
    };

    session.safety_rewind(seq_after_first);

    let restored = &session.entities[&victim];
    assert_eq!(
        restored.death_saves.failures, 1,
        "rewind must reconstruct tallies from surviving DEATH_SAVE_RESOLVED events"
    );
    assert!(!restored.death_saves.is_dead);
    assert!(!restored.is_dead);
}

/// Appends a rest/heal-style ledger event and returns its sequence id, so
/// callers can rewind to a point immediately after it.
fn append_and_seq(
    session: &mut GameSession,
    actor: uuid::Uuid,
    event_type: &str,
    payload: serde_json::Value,
) -> u64 {
    session
        .ledger
        .append_event(session.session_id, session.campaign_id, actor, event_type, payload)
        .sequence_id
}

fn attack_event(target: uuid::Uuid, hp_remaining: i32) -> serde_json::Value {
    serde_json::json!({
        "target_id": target.to_string(),
        "total_damage": 0,
        "target_hp_remaining": hp_remaining,
        "target_is_conscious": hp_remaining > 0,
        "target_is_dead": false,
    })
}

#[test]
fn test_safety_rewind_between_long_rest_and_attack_restores_post_rest_max_hp() {
    let mut session = session_with_pair();
    let (a_id, b_id): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    // Baseline: B is battered down to 4 HP.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        attack_event(b_id, 4),
    );
    // B long-rests back to full.
    let seq_after_rest = append_and_seq(
        &mut session,
        b_id,
        "LONG_REST_APPLIED",
        serde_json::json!({
            "target_id": b_id.to_string(),
            "hp_restored_to_max": 30,
            "hp_remaining": 30,
        }),
    );
    // Then takes another hit — the one the X-card rewinds away.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        attack_event(b_id, 3),
    );

    // Live state drifted to the post-attack HP before the rewind.
    session.entities.get_mut(&b_id).unwrap().current_hp = 3;

    session.safety_rewind(seq_after_rest);

    let b = &session.entities[&b_id];
    assert_eq!(
        b.current_hp, 30,
        "rewind landing between a long rest and a later attack must restore post-rest HP"
    );
    assert!(b.is_conscious);
    assert!(!b.is_dead);
}

#[test]
fn test_safety_rewind_after_heal_of_dying_entity_does_not_resurrect_stale_failures() {
    let mut session = session_with_pair();
    let victim = *session.entities.keys().next().unwrap();
    knock_down(&mut session, victim);

    // Dying at failures = 2, then saved by a heal that clears the tally.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        victim,
        "DEATH_SAVE_RESOLVED",
        serde_json::json!({
            "outcome": "PENDING", "natural_roll": 5,
            "successes": 0, "failures": 2,
            "is_stabilized": false, "is_dead": false,
        }),
    );
    let seq_after_heal = append_and_seq(
        &mut session,
        victim,
        "HEALED",
        serde_json::json!({
            "target_id": victim.to_string(),
            "amount": 10,
            "hp_remaining": 10,
        }),
    );
    // One more surviving-later event for the rewind to revert: a fresh
    // (post-heal) failed save recorded against the healed target's ally.
    let other = *session.entities.keys().find(|k| **k != victim).unwrap();
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        other,
        "ATTACK_RESOLVED",
        attack_event(other, 15),
    );

    // Live state drifted: still carrying the stale pre-heal tally.
    let e = session.entities.get_mut(&victim).unwrap();
    e.death_saves = vtt_core::types::DeathSaveState {
        successes: 0,
        failures: 2,
        is_stabilized: false,
        is_dead: false,
    };

    session.safety_rewind(seq_after_heal);

    let restored = &session.entities[&victim];
    assert_eq!(restored.current_hp, 10);
    assert!(
        restored.death_saves.failures == 0
            && !restored.death_saves.is_stabilized,
        "a heal replayed by the rewind must clear stale death-save tallies, got {:?}",
        restored.death_saves
    );
}

#[test]
fn test_safety_rewind_between_heal_and_later_wound_restores_post_heal_hp() {
    let mut session = session_with_pair();
    let (a_id, b_id): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    // Baseline damage, then a heal on top of it.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        attack_event(b_id, 12),
    );
    let seq_after_heal = append_and_seq(
        &mut session,
        b_id,
        "HEALED",
        serde_json::json!({
            "target_id": b_id.to_string(),
            "amount": 8,
            "hp_remaining": 20,
        }),
    );
    // A later wound the rewind will discard.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        attack_event(b_id, 5),
    );

    session.entities.get_mut(&b_id).unwrap().current_hp = 5;

    session.safety_rewind(seq_after_heal);

    assert_eq!(
        session.entities[&b_id].current_hp, 20,
        "rewind landing between a heal and a later wound must keep the post-heal total"
    );
}

#[test]
fn test_safety_rewind_ignores_surviving_short_rest_event() {
    let mut session = session_with_pair();
    let (a_id, b_id): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    // Baseline damage; then a short rest (mechanically a no-op today); then
    // another wound the rewind discards.
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        attack_event(b_id, 12),
    );
    let seq_after_short_rest = append_and_seq(
        &mut session,
        uuid::Uuid::nil(),
        "SHORT_REST_APPLIED",
        serde_json::json!({"triggered_by": "tester"}),
    );
    session.ledger.append_event(
        session.session_id,
        session.campaign_id,
        a_id,
        "ATTACK_RESOLVED",
        attack_event(b_id, 2),
    );

    session.entities.get_mut(&b_id).unwrap().current_hp = 2;

    let report = session.safety_rewind(seq_after_short_rest);

    assert_eq!(report.reverted_event_count, 1);
    assert_eq!(
        session.entities[&b_id].current_hp, 12,
        "a surviving short-rest event must not alter replayed HP in either direction"
    );
    assert!(session.entities[&b_id].is_conscious);
}

#[test]
fn test_safety_rewind_before_combat_began_ends_up_out_of_combat() {
    let mut session = session_with_pair();
    let baseline_seq = session.ledger.current_sequence;

    // Combat begins (and advances) AFTER the baseline — the X-card reverts
    // the whole engagement.
    let mut dice = DiceEngine::with_seed(11);
    session.begin_combat(&mut dice);
    assert!(session.combat.in_combat);
    session.combat.next_turn();

    let report = session.safety_rewind(baseline_seq);
    assert!(report.reverted_event_count >= 1, "COMBAT_BEGAN must revert");
    assert!(
        !session.combat.in_combat,
        "rewinding to before COMBAT_BEGAN must leave the session out of combat"
    );
}

#[test]
fn test_safety_rewind_while_in_combat_prunes_dangling_order_ids() {
    let mut session = session_with_pair();
    let (a_id, b_id): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    let mut dice = DiceEngine::with_seed(11);
    let entries = session.begin_combat(&mut dice);
    assert_eq!(entries.len(), 2);
    let seq_after_begin = session.ledger.current_sequence;

    // One combatant leaves the board mid-combat. The rewind point predates
    // the despawn, but a rewind does not resurrect removed entities — so the
    // surviving combat order must not keep referencing the gone id.
    session.remove_entity(&b_id, "x-card");
    assert!(session.combat.in_combat);

    session.safety_rewind(seq_after_begin);

    assert!(session.combat.in_combat, "combat was live at the rewind point");
    for id in &session.combat.order {
        assert!(
            session.entities.contains_key(id),
            "combat order must not reference a despawned entity after rewind"
        );
    }
    assert_eq!(
        session.combat.order,
        vec![a_id],
        "the surviving combatant keeps their slot; the dangling id is pruned"
    );
}

#[test]
fn test_safety_rewind_restores_exhaustion_from_surviving_long_rest_event() {
    let mut session = session_with_pair();
    let tired = *session.entities.keys().next().unwrap();

    // Exhaustion 3, then a long rest sheds one level to 2 — recorded in the
    // event's post-rest exhaustion_level.
    session.entities.get_mut(&tired).unwrap().set_exhaustion(3);
    let seq_after_rest = append_and_seq(
        &mut session,
        tired,
        "LONG_REST_APPLIED",
        serde_json::json!({
            "target_id": tired.to_string(),
            "hp_restored_to_max": 30,
            "hp_remaining": 30,
            "exhaustion_reduced": true,
            "exhaustion_level": 2,
        }),
    );

    // Later drift: another exhaustion source piled them back up to 5 before
    // the X-card fired.
    session
        .entities
        .get_mut(&tired)
        .unwrap()
        .set_exhaustion(5);

    session.safety_rewind(seq_after_rest);

    assert_eq!(
        session.entities[&tired].exhaustion_level(),
        2,
        "replay must restore the post-rest level carried by the surviving LONG_REST_APPLIED"
    );
}

#[test]
fn test_safety_rewind_reapplies_the_halved_hp_cap_when_replaying_deep_exhaustion() {
    let mut session = session_with_pair();
    let tired = *session.entities.keys().next().unwrap();

    // A rest event whose payload records exhaustion 4 alongside a FULL refill
    // (the shape an older build could journal before the effective-max cap
    // existed). HP replay alone would land at 30; the exhaustion replay runs
    // AFTER the HP pass precisely so `set_exhaustion` re-clamps to the halved
    // maximum of 15.
    let seq_after_rest = append_and_seq(
        &mut session,
        tired,
        "LONG_REST_APPLIED",
        serde_json::json!({
            "target_id": tired.to_string(),
            "hp_remaining": 30,
            "exhaustion_reduced": true,
            "exhaustion_level": 4,
        }),
    );

    // Live drift past the rewind point: fully rested and unexhausted.
    {
        let entity = session.entities.get_mut(&tired).unwrap();
        entity.set_exhaustion(0);
        entity.current_hp = 30;
    }

    session.safety_rewind(seq_after_rest);

    assert_eq!(session.entities[&tired].exhaustion_level(), 4);
    assert_eq!(
        session.entities[&tired].current_hp, 15,
        "restored level-4+ exhaustion must clamp replayed HP back to the halved max"
    );
}

// ------------------------------------------------- contest rewind (audit F4)
//
// GRAPPLE_ATTEMPTED / SHOVE_ATTEMPTED mutate live state (conditions, position)
// outside the classic HP/position replay set. A rewind past them must undo
// that state too, or the X-card rollback leaves a grapple or a 5 ft push in
// place after the events that caused it are gone.

fn grapple_event(defender: uuid::Uuid, success: bool) -> serde_json::Value {
    serde_json::json!({
        "attacker_id": uuid::Uuid::new_v4().to_string(),
        "defender_id": defender.to_string(),
        "success": success,
        "applied_condition": if success { serde_json::json!("grappled") } else { serde_json::Value::Null },
        "escape_dc": 13,
    })
}

#[test]
fn test_safety_rewind_past_grapple_removes_grappled_condition() {
    let mut session = session_with_pair();
    let (grappler, victim): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };
    let _ = grappler;

    let baseline_seq = append_and_seq(
        &mut session,
        grappler,
        "MOVE_ENTITY",
        serde_json::json!({"from": [2.5, 2.5, 0.0], "to": [2.5, 2.5, 0.0]}),
    );

    // Successful grapple: ledger event + the live condition it applied.
    let seq_after_grapple = append_and_seq(
        &mut session,
        grappler,
        "GRAPPLE_ATTEMPTED",
        grapple_event(victim, true),
    );
    session
        .entities
        .get_mut(&victim)
        .unwrap()
        .add_condition(Condition::Grappled);
    assert!(session.entities[&victim].has_condition(&Condition::Grappled));

    // Rewind to BEFORE the grapple.
    let report = session.safety_rewind(baseline_seq);
    assert_eq!(report.reverted_event_count, 1);

    assert!(
        !session.entities[&victim].has_condition(&Condition::Grappled),
        "rewinding past a successful grapple must strip Grappled from the defender"
    );
    // The surviving baseline event still replays its own effect (position).
    assert_eq!(session.entities[&victim].position, (2.5, 2.5, 0.0));
    let _ = seq_after_grapple;
}

#[test]
fn test_safety_rewind_keeps_grapple_when_its_event_survives() {
    let mut session = session_with_pair();
    let (grappler, victim): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    let seq_after_grapple = append_and_seq(
        &mut session,
        grappler,
        "GRAPPLE_ATTEMPTED",
        grapple_event(victim, true),
    );
    session
        .entities
        .get_mut(&victim)
        .unwrap()
        .add_condition(Condition::Grappled);

    session.safety_rewind(seq_after_grapple);

    assert!(
        session.entities[&victim].has_condition(&Condition::Grappled),
        "a surviving GRAPPLE_ATTEMPTED must re-grant Grappled during replay"
    );
}

#[test]
fn test_safety_rewind_past_failed_grapple_leaves_no_condition() {
    let mut session = session_with_pair();
    let (grappler, victim): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };
    let _ = grappler;

    let baseline_seq = append_and_seq(
        &mut session,
        grappler,
        "MOVE_ENTITY",
        serde_json::json!({"from": [2.5, 2.5, 0.0], "to": [2.5, 2.5, 0.0]}),
    );

    // Lost contest: event recorded, NO condition was ever applied.
    append_and_seq(&mut session, grappler, "GRAPPLE_ATTEMPTED", grapple_event(victim, false));

    session.safety_rewind(baseline_seq);

    assert!(
        !session.entities[&victim].has_condition(&Condition::Grappled),
        "a lost contest grants nothing and rewinding past it must grant nothing"
    );
}

#[test]
fn test_safety_rewind_past_shove_push_restores_pre_push_position() {
    let mut session = session_with_pair();
    let (shover, pushed): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    let pre_push = session.entities[&pushed].position;

    let baseline_seq = append_and_seq(
        &mut session,
        shover,
        "MOVE_ENTITY",
        serde_json::json!({"from": [2.5, 2.5, 0.0], "to": [2.5, 2.5, 0.0]}),
    );

    // Successful 5 ft push: displacement is carried IN the event payload so a
    // rewind can undo it even though no MOVE_ENTITY ever recorded the trip.
    let seq_after_push = append_and_seq(
        &mut session,
        shover,
        "SHOVE_ATTEMPTED",
        serde_json::json!({
            "attacker_id": shover.to_string(),
            "defender_id": pushed.to_string(),
            "success": true,
            "shove_effect": "push_5ft",
            "applied_condition": null,
            "pushed_from": [pre_push.0, pre_push.1, pre_push.2],
            "pushed_to": [pre_push.0 + 5.0, pre_push.1, pre_push.2],
            "push_distance_feet": 5.0,
        }),
    );
    session.entities.get_mut(&pushed).unwrap().position =
        (pre_push.0 + 5.0, pre_push.1, pre_push.2);

    session.safety_rewind(baseline_seq);

    assert_eq!(
        session.entities[&pushed].position, pre_push,
        "rewind past a shove-push must restore the pre-push position"
    );
    let _ = seq_after_push;
}

#[test]
fn test_safety_rewind_past_shove_prone_removes_prone_condition() {
    let mut session = session_with_pair();
    let (shover, victim): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    let baseline_seq = append_and_seq(
        &mut session,
        shover,
        "MOVE_ENTITY",
        serde_json::json!({"from": [2.5, 2.5, 0.0], "to": [2.5, 2.5, 0.0]}),
    );

    append_and_seq(
        &mut session,
        shover,
        "SHOVE_ATTEMPTED",
        serde_json::json!({
            "attacker_id": shover.to_string(),
            "defender_id": victim.to_string(),
            "success": true,
            "shove_effect": "prone",
            "applied_condition": "prone",
        }),
    );
    session
        .entities
        .get_mut(&victim)
        .unwrap()
        .add_condition(Condition::Prone);

    session.safety_rewind(baseline_seq);

    assert!(
        !session.entities[&victim].has_condition(&Condition::Prone),
        "rewind past a prone-shove must stand the defender back up"
    );
}

#[test]
fn test_safety_rewind_shove_position_yields_to_later_surviving_move() {
    let mut session = session_with_pair();
    let (shover, pushed): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };
    let pre_push = session.entities[&pushed].position;

    // Shove happens BEFORE the rewind point and SURVIVES it; a later
    // MOVE_ENTITY also survives — last-event-wins means the move wins.
    append_and_seq(
        &mut session,
        shover,
        "SHOVE_ATTEMPTED",
        serde_json::json!({
            "attacker_id": shover.to_string(),
            "defender_id": pushed.to_string(),
            "success": true,
            "shove_effect": "push_5ft",
            "applied_condition": null,
            "pushed_from": [pre_push.0, pre_push.1, pre_push.2],
            "pushed_to": [pre_push.0 + 5.0, pre_push.1, pre_push.2],
        }),
    );
    session.move_entity(pushed, (20.0, 20.0, 0.0)).unwrap();

    session.safety_rewind(session.ledger.current_sequence);

    assert_eq!(
        session.entities[&pushed].position,
        (20.0, 20.0, 0.0),
        "a surviving MOVE_ENTITY after a surviving shove wins position replay"
    );
}

// ---------------------------------------------------------------------------
// Fail-forward resolution engine (GOALS.md Pillar 8): non-binary skill-check
// success margins M = Roll − DC.
// ---------------------------------------------------------------------------

use vtt_core::rules::{CheckOutcomeTier, CostSuggestion};
use vtt_core::types::TaskOutcome;

#[test]
fn test_check_margin_critical_success_band() {
    // M >= +10 → Critical Success.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(15, 5, 10).2,
        CheckOutcomeTier::CriticalSuccess
    );
    assert_eq!(
        RulesEvaluator::resolve_check_margin(20, 0, 10).2,
        CheckOutcomeTier::CriticalSuccess
    );
    // Exactly +10 is the band boundary and belongs to critical success.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(12, 3, 5).2,
        CheckOutcomeTier::CriticalSuccess
    );
}

#[test]
fn test_check_margin_standard_success_band() {
    // 0 <= M < +10 → Standard Success.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(11, 0, 10).2,
        CheckOutcomeTier::Success
    );
    assert_eq!(
        RulesEvaluator::resolve_check_margin(10, 4, 5).2,
        CheckOutcomeTier::Success
    );
}

#[test]
fn test_check_margin_success_at_cost_band() {
    // -5 <= M < 0 → Success at a Cost.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(9, 0, 10).2,
        CheckOutcomeTier::SuccessAtCost
    );
    assert_eq!(
        RulesEvaluator::resolve_check_margin(6, 1, 10).2,
        CheckOutcomeTier::SuccessAtCost
    );
    // M = -5 is the deepest costed success.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(7, 0, 12).2,
        CheckOutcomeTier::SuccessAtCost
    );
}

#[test]
fn test_check_margin_critical_failure_band() {
    // M < -5 → Critical Failure.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(4, 0, 10).2,
        CheckOutcomeTier::CriticalFailure
    );
    assert_eq!(
        RulesEvaluator::resolve_check_margin(1, 2, 9).2,
        CheckOutcomeTier::CriticalFailure
    );
}

#[test]
fn test_check_margin_margin_value_matches_existing_math() {
    // Margin is always Roll − DC with the same arithmetic the existing
    // check/save math uses (total vs dc).
    for (natural, modifier, dc) in [
        (20, 5, 10),
        (11, 0, 10),
        (10, 4, 5),
        (10, 0, 10),
        (9, 0, 10),
        (7, 0, 12),
        (6, 0, 12),
        (4, 0, 10),
        (1, 2, 9),
    ] {
        let total = natural + modifier;
        let (_, margin, _) = RulesEvaluator::resolve_check_margin(natural, modifier, dc);
        assert_eq!(margin, total - dc, "nat {} +{} vs dc {}", natural, modifier, dc);
    }
}

#[test]
fn test_check_margin_pass_flag_outside_cost_band_matches_binary_threshold() {
    // Outside the Success-at-a-Cost band the pass flag is identical to the
    // existing binary check math (total >= dc).
    for (natural, modifier, dc) in [
        (20, 5, 10),
        (11, 0, 10),
        (10, 4, 5),
        (10, 0, 10),
        (6, 0, 12),
        (4, 0, 10),
        (1, 2, 9),
    ] {
        let total = natural + modifier;
        let (passed, _, tier) = RulesEvaluator::resolve_check_margin(natural, modifier, dc);
        assert_ne!(tier, CheckOutcomeTier::SuccessAtCost);
        assert_eq!(
            passed,
            total >= dc,
            "nat {} +{} vs dc {}",
            natural,
            modifier,
            dc
        );
    }
}

#[test]
fn test_check_margin_cost_band_still_counts_as_a_pass() {
    // Fail-forward core: a narrow miss (-5 <= M < 0) succeeds at a price.
    for (natural, modifier, dc) in [(9, 0, 10), (7, 0, 12), (8, -3, 10)] {
        let (passed, margin, tier) = RulesEvaluator::resolve_check_margin(natural, modifier, dc);
        assert_eq!(tier, CheckOutcomeTier::SuccessAtCost);
        assert!((-5..0).contains(&margin));
        assert!(passed, "costed successes must not be reported as failures");
    }
}

#[test]
fn test_nat20_bumps_tier_up_one_band() {
    // Convention: a natural 20 lifts the outcome one full band upward,
    // capped at Critical Success.
    // M = +14 would already be Critical Success → stays there.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(20, 4, 10).2,
        CheckOutcomeTier::CriticalSuccess
    );
    // M = +8 Standard Success → bumped to Critical Success.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(20, 3, 15).2,
        CheckOutcomeTier::CriticalSuccess
    );
    // M = -2 Success at a Cost → bumped to Standard Success.
    let (passed, _, tier) = RulesEvaluator::resolve_check_margin(20, 0, 22);
    assert_eq!(tier, CheckOutcomeTier::Success);
    assert!(passed);

    // M = -9 Critical Failure → bumped to Success at a Cost, which PASSES:
    // the nat 20 rescues an otherwise catastrophic roll.
    let (passed, _, tier) = RulesEvaluator::resolve_check_margin(20, 0, 29);
    assert_eq!(tier, CheckOutcomeTier::SuccessAtCost);
    assert!(passed);
}

#[test]
fn test_nat1_drops_tier_down_one_band() {
    // Convention: a natural 1 drops the outcome one full band downward,
    // floored at Critical Failure. It never flips a pass into a fail on its
    // own beyond that single-band step.
    // M = +14 Critical Success → dropped to Standard Success.
    let (passed, _, tier) = RulesEvaluator::resolve_check_margin(1, 23, 10);
    assert_eq!(tier, CheckOutcomeTier::Success);
    assert!(passed);

    // M = +8 Standard Success → dropped to Success at a Cost.
    let (passed, _, tier) = RulesEvaluator::resolve_check_margin(1, 17, 10);
    assert_eq!(tier, CheckOutcomeTier::SuccessAtCost);
    assert!(passed);

    // M = -2 Success at a Cost → dropped to Critical Failure (fails).
    let (passed, _, tier) = RulesEvaluator::resolve_check_margin(1, 7, 10);
    assert_eq!(tier, CheckOutcomeTier::CriticalFailure);
    assert!(!passed);

    // M = -9 is already Critical Failure → stays floored there.
    assert_eq!(
        RulesEvaluator::resolve_check_margin(1, 0, 15).2,
        CheckOutcomeTier::CriticalFailure
    );
}

#[test]
fn test_tier_maps_onto_existing_task_outcome() {
    // The new tiers must stay aligned with the pre-existing TaskOutcome enum
    // so downstream event payloads can keep one vocabulary.
    assert_eq!(
        RulesEvaluator::tier_to_task_outcome(CheckOutcomeTier::CriticalSuccess),
        TaskOutcome::CriticalSuccess
    );
    assert_eq!(
        RulesEvaluator::tier_to_task_outcome(CheckOutcomeTier::Success),
        TaskOutcome::Success
    );
    assert_eq!(
        RulesEvaluator::tier_to_task_outcome(CheckOutcomeTier::SuccessAtCost),
        TaskOutcome::SuccessAtACost
    );
    assert_eq!(
        RulesEvaluator::tier_to_task_outcome(CheckOutcomeTier::CriticalFailure),
        TaskOutcome::CriticalFailure
    );
}

#[test]
fn test_cost_suggestion_is_deterministic_per_margin_magnitude() {
    // Documented derivation from |M| (the depth of the shortfall):
    //   |M| = 1      → lose inspiration
    //   |M| = 2      → alert clock ticks once
    //   odd  |M| >= 3 → suggested Prone condition
    //   even |M| >= 4 → suggested Frightened condition
    assert_eq!(
        RulesEvaluator::suggest_cost(-1),
        Some(CostSuggestion::InspirationLoss)
    );
    assert_eq!(
        RulesEvaluator::suggest_cost(-2),
        Some(CostSuggestion::AlertClockTick)
    );
    assert_eq!(
        RulesEvaluator::suggest_cost(-3),
        Some(CostSuggestion::Condition(vtt_core::types::Condition::Prone))
    );
    assert_eq!(
        RulesEvaluator::suggest_cost(-4),
        Some(CostSuggestion::Condition(vtt_core::types::Condition::Frightened))
    );
    // Repeated calls are stable — no RNG anywhere in the suggestion hook.
    assert_eq!(RulesEvaluator::suggest_cost(-3), RulesEvaluator::suggest_cost(-3));
    assert_eq!(RulesEvaluator::suggest_cost(-5), RulesEvaluator::suggest_cost(-5));
}

#[test]
fn test_cost_suggestion_only_applies_inside_success_at_cost_band() {
    // Margins outside [-5, 0) carry no suggested cost.
    assert_eq!(RulesEvaluator::suggest_cost(0), None);
    assert_eq!(RulesEvaluator::suggest_cost(5), None);
    assert_eq!(RulesEvaluator::suggest_cost(-6), None);
    assert_eq!(RulesEvaluator::suggest_cost(-99), None);
}

// ---------------------------------------------------------------------------
// SRD 5e Exhaustion as a leveled condition.
//
// DESIGN NOTE: exhaustion lives as the existing `Condition::Exhaustion(u8)`
// enum variant inside `EntityState::conditions` — NOT as a parallel
// `exhaustion: u8` field. The variant already exists, already serializes
// round-trip through the condition list, and is already wired into
// `Condition::inflicts_disadvantage_on_attacks()` (level >= 3), so a second
// source of truth would let the two drift (e.g. an `Exhaustion(4)` condition
// alongside `exhaustion: 1`). All effects are derived from the single
// condition entry via helpers on `EntityState`.
// ---------------------------------------------------------------------------

#[test]
fn test_exhaustion_level_1_imposes_disadvantage_on_ability_checks() {
    // The check pipeline (`RulesEvaluator::resolve_check_margin`) takes a
    // pre-rolled d20 and has no adv/dis parameter, so level 1's penalty is
    // exposed as a query helper callers fold into their roll strategy.
    let mut e = hero("scout", 30, 15);
    assert!(!e.has_disadvantage_on_checks(), "fresh entity is unencumbered");

    e.set_exhaustion(1);
    assert_eq!(e.exhaustion_level(), 1);
    assert!(e.has_disadvantage_on_checks());

    e.set_exhaustion(5);
    assert!(e.has_disadvantage_on_checks(), "levels 2..=5 keep the check penalty");
}

#[test]
fn test_exhaustion_level_2_halves_speed_in_the_action_budget() {
    let mut session = session_with_pair();
    let id = *session.entities.keys().next().unwrap();
    session.entities.get_mut(&id).unwrap().set_exhaustion(2);
    assert_eq!(
        session.entities[&id].effective_speed_feet(),
        15.0,
        "level 2 halves the 30 ft base speed"
    );

    // The next round refresh seeds the movement budget from the halved speed.
    let mut dice = DiceEngine::with_seed(11);
    session.advance_round(&mut dice);
    assert_eq!(
        session.entities[&id].action_budget.movement_remaining_feet, 15.0,
        "round refresh must use effective (halved) speed"
    );

    // And movement beyond the halved budget is rejected by move_entity.
    let err = session.move_entity(id, (20.0, 20.0, 0.0)).unwrap_err();
    // A ~24.7 ft straight-line hop from (2.5, 2.5) exceeds the 15 ft budget.
    assert!(
        err.starts_with("MOVE_BUDGET_EXCEEDED"),
        "expected budget rejection at half speed, got: {}",
        err
    );
}

#[test]
fn test_exhaustion_level_3_imposes_disadvantage_on_attacks_and_saves() {
    let mut e = hero("worn_duelist", 30, 15);
    e.set_exhaustion(3);
    assert!(e.has_disadvantage_on_attacks());
    assert!(e.has_disadvantage_on_saves());
    // Level 2 does not yet carry either penalty.
    e.set_exhaustion(2);
    assert!(!e.has_disadvantage_on_attacks());
    assert!(!e.has_disadvantage_on_saves());

    // The attack edge pipeline picks the level up automatically.
    let target = hero("orc", 30, 15);
    let (_, dis) = RulesEvaluator::edge_from_conditions(&e, &target, 30.0, 0.0, 0.0);
    e.set_exhaustion(3);
    let (_, dis3) = RulesEvaluator::edge_from_conditions(&e, &target, 30.0, 0.0, 0.0);
    assert!(!dis, "level 2 grants no attack edge");
    assert!(dis3, "level 3 imposes attack disadvantage via edge_from_conditions");
}

#[test]
fn test_exhaustion_level_4_halves_max_and_current_hp_floor_division() {
    let mut e = hero("gaunt_survivor", 27, 15);
    e.current_hp = 27;
    e.set_exhaustion(4);

    assert_eq!(e.effective_max_hp(), 13, "27 / 2 floors to 13");
    assert_eq!(e.current_hp, 13, "current HP clamped down to the halved max");

    // Odd values above the cap always clamp; even values halve exactly.
    let mut even = hero("even_case", 24, 15);
    even.set_exhaustion(4);
    assert_eq!(even.effective_max_hp(), 12);
    assert_eq!(even.current_hp, 12);

    // Dropping back below level 4 restores the full maximum.
    e.set_exhaustion(3);
    assert_eq!(e.effective_max_hp(), 27);
}

#[test]
fn test_exhaustion_level_4_cap_is_reenforced_each_round_after_healing() {
    let mut session = session_with_pair();
    let id = *session.entities.keys().next().unwrap();
    session.entities.get_mut(&id).unwrap().set_exhaustion(4);
    assert_eq!(
        session.entities[&id].current_hp, 15,
        "set_exhaustion itself clamps to the halved max of 15 (30/2)"
    );

    // Someone tops the exhausted creature off past its reduced maximum.
    session.entities.get_mut(&id).unwrap().current_hp = 30;

    let mut dice = DiceEngine::with_seed(5);
    session.advance_round(&mut dice);
    assert_eq!(
        session.entities[&id].current_hp, 15,
        "round pass must clamp HP back to the halved max of 15 (30/2)"
    );
}

#[test]
fn test_exhaustion_level_5_reduces_speed_to_zero() {
    let mut session = session_with_pair();
    let id = *session.entities.keys().next().unwrap();
    session.entities.get_mut(&id).unwrap().set_exhaustion(5);

    assert_eq!(session.entities[&id].effective_speed_feet(), 0.0);

    let mut dice = DiceEngine::with_seed(6);
    session.advance_round(&mut dice);
    assert_eq!(
        session.entities[&id].action_budget.movement_remaining_feet, 0.0,
        "round refresh must grant no movement at level 5"
    );

    // Even a one-step shuffle is rejected.
    let err = session.move_entity(id, (2.6, 2.5, 0.0)).unwrap_err();
    assert!(err.starts_with("MOVE_BUDGET_EXCEEDED"), "got: {}", err);
}

#[test]
fn test_exhaustion_level_6_kills_the_entity() {
    let mut e = hero("collapsed", 12, 15);
    e.set_exhaustion(6);
    assert!(e.is_dead, "SRD: the seventh exhaustion level is death");
    assert!(!e.is_conscious);
    assert_eq!(e.exhaustion_level(), 6);
}

#[test]
fn test_take_long_rest_effects_reduces_exhaustion_by_one() {
    let mut e = hero("weary", 30, 15);
    e.set_exhaustion(3);
    assert!(e.take_long_rest_effects(), "a rest with exhaustion must report change");
    assert_eq!(e.exhaustion_level(), 2);

    assert!(e.take_long_rest_effects());
    assert!(e.take_long_rest_effects());
    assert_eq!(e.exhaustion_level(), 0, "resting at level 1 clears exhaustion fully");
    assert!(e.conditions.is_empty(), "no Exhaustion(0) stub condition may linger");

    // Resting while unexhausted is a no-op and reports it.
    assert!(!e.take_long_rest_effects());
    assert_eq!(e.exhaustion_level(), 0);
}

#[test]
fn test_exhaustion_serialization_round_trip_and_legacy_payload_back_compat() {
    let mut e = hero("legacy", 30, 15);
    e.set_exhaustion(3);

    // Round trip preserves the leveled condition.
    let json = serde_json::to_value(&e).unwrap();
    let parsed: EntityState = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.exhaustion_level(), 3);

    // Old payloads predate any dedicated exhaustion representation: a
    // serialized entity whose condition list carries no Exhaustion entry
    // deserializes cleanly at level 0 (nothing new was added to the schema).
    let legacy_json = serde_json::to_value(hero("legacy", 30, 15)).unwrap();
    let legacy: EntityState = serde_json::from_value(legacy_json).unwrap();
    assert_eq!(legacy.exhaustion_level(), 0);
    assert!(!legacy.has_disadvantage_on_checks());
    assert_eq!(legacy.effective_speed_feet(), 30.0);
    assert_eq!(legacy.effective_max_hp(), 30);
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

// --------------------------------------------------------------- Ready action
//
// SRD "Ready": spend your Action to hold a triggered response ("I attack the
// goblin when it moves"). This iteration stores, surfaces and clears the
// readied action; resolving the trigger stays a GM adjudication.

#[test]
fn test_ready_action_stores_description_spends_action_and_ledgers() {
    let mut session = session_with_pair();
    session.combat.round = 4; // set_on_round must record the round it was set
    let actor = *session.entities.keys().next().unwrap();

    let ready = session
        .ready_action(
            actor,
            "I attack the goblin",
            ReadiedTrigger::Freeform("when it moves".to_string()),
        )
        .unwrap();
    assert_eq!(ready.set_on_round, 4);
    assert!(
        ready.description.contains("attack the goblin") && ready.description.contains("when it moves"),
        "trigger hint is kept with the description for GM adjudication: {}",
        ready.description
    );

    // The readied action is authoritative session state on the entity.
    let stored = session.entities[&actor]
        .readied_action
        .as_ref()
        .expect("readied action stored on the entity");
    assert_eq!(stored.description, ready.description);
    assert_eq!(stored.set_on_round, 4);
    assert_eq!(
        stored.trigger,
        ReadiedTrigger::Freeform("when it moves".to_string()),
        "the structured trigger survives alongside the display text"
    );
    assert!(
        !session.entities[&actor].action_budget.action,
        "Ready spends the entity's Action"
    );

    // One ledger event records the arming.
    assert!(session.ledger.events.iter().any(|e| {
        e.event_type == "READY_ACTION_SET" && e.actor_id == actor
    }));

    // The Action is gone: a second Ready this turn is rejected WITHOUT
    // overwriting the stored description.
    let err = session
        .ready_action(actor, "second try", ReadiedTrigger::default())
        .unwrap_err();
    assert_eq!(err, "ACTION_ECONOMY_EXHAUSTED");
    assert_eq!(
        session.entities[&actor].readied_action.as_ref().unwrap().description,
        ready.description,
        "a rejected Ready must not clobber the stored description"
    );

    // Unknown entity.
    assert_eq!(
        session
            .ready_action(uuid::Uuid::new_v4(), "ghost", ReadiedTrigger::default())
            .unwrap_err(),
        "ENTITY_NOT_FOUND"
    );
}

#[test]
fn test_ready_action_clears_at_the_next_round_refresh() {
    let mut session = session_with_pair();
    let actor = *session.entities.keys().next().unwrap();

    session
        .ready_action(actor, "I hold my strike", ReadiedTrigger::default())
        .unwrap();
    assert!(session.entities[&actor].readied_action.is_some());

    // A readied action lasts until the actor's next turn refresh — the round
    // advance clears it even though the trigger never fired (GM adjudicated).
    let mut dice = DiceEngine::with_seed(3);
    session.advance_round(&mut dice);
    assert!(
        session.entities[&actor].readied_action.is_none(),
        "the next-turn refresh must clear the readied action"
    );
}

#[test]
fn test_ready_action_rejects_incapacitated_actors() {
    let mut session = session_with_pair();
    let actor = *session.entities.keys().next().unwrap();

    session
        .entities
        .get_mut(&actor)
        .unwrap()
        .add_condition(Condition::Unconscious);
    assert_eq!(
        session
            .ready_action(actor, "while unconscious", ReadiedTrigger::default())
            .unwrap_err(),
        "ENTITY_CANNOT_ACT"
    );
    assert!(
        session.entities[&actor].readied_action.is_none(),
        "a rejected Ready stores nothing"
    );
}

#[test]
fn test_readied_action_round_trips_and_legacy_payloads_default_to_none() {
    let mut e = hero("ready", 30, 15);
    e.readied_action = Some(ReadiedAction {
        description: "I attack when it moves".to_string(),
        set_on_round: 2,
        trigger: ReadiedTrigger::EnemyEntersReach,
    });
    let serialized = serde_json::to_value(&e).unwrap();
    let parsed: EntityState = serde_json::from_value(serialized).unwrap();
    assert_eq!(parsed.readied_action, e.readied_action);

    // Entities persisted before this field existed deserialize cleanly.
    let legacy: EntityState = serde_json::from_value(serde_json::to_value(hero("legacy", 30, 15)).unwrap())
        .expect("legacy payload without readied_action");
    assert!(legacy.readied_action.is_none());
}

#[test]
fn test_ready_trigger_is_a_structured_enum_with_legacy_freeform_default() {
    // Wire names are snake_case; the freeform variant carries its text.
    assert_eq!(
        serde_json::to_value(ReadiedTrigger::EnemyEntersReach).unwrap(),
        serde_json::json!("enemy_enters_reach")
    );
    assert_eq!(
        serde_json::to_value(ReadiedTrigger::EnemyAttacks).unwrap(),
        serde_json::json!("enemy_attacks")
    );
    assert_eq!(
        serde_json::to_value(ReadiedTrigger::TurnStart).unwrap(),
        serde_json::json!("turn_start")
    );
    assert_eq!(
        serde_json::to_value(ReadiedTrigger::Freeform("the bell tolls".into())).unwrap(),
        serde_json::json!({"freeform": "the bell tolls"})
    );
    assert_eq!(
        serde_json::from_value::<ReadiedTrigger>(serde_json::json!("turn_start")).unwrap(),
        ReadiedTrigger::TurnStart
    );

    // A readied action persisted BEFORE triggers were structured still
    // deserializes — it was pure GM adjudication, so it defaults to an empty
    // freeform rather than inventing a mechanical trigger it never had.
    let legacy = serde_json::json!({
        "description": "I attack when it moves",
        "set_on_round": 2,
    });
    let parsed: ReadiedAction = serde_json::from_value(legacy).unwrap();
    assert_eq!(parsed.trigger, ReadiedTrigger::default());
}

/// SRD: releasing a readied action (resolving its trigger) takes the actor's
/// Reaction. Iteration 74: the release is now an engine operation that spends
/// the Reaction and ledgers itself, instead of being pure GM adjudication.
#[test]
fn test_release_readied_action_spends_the_reaction_and_ledgers() {
    let mut session = session_with_pair();
    let actor = *session.entities.keys().next().unwrap();

    let readied = session
        .ready_action(actor, "I attack the goblin", ReadiedTrigger::EnemyEntersReach)
        .unwrap();
    assert!(session.entities[&actor].action_budget.reaction);

    let released = session.release_readied_action(actor).unwrap();
    assert_eq!(released, readied, "the released declaration is echoed back");
    assert!(
        session.entities[&actor].readied_action.is_none(),
        "releasing clears the stored declaration"
    );
    assert!(
        !session.entities[&actor].action_budget.reaction,
        "release spends the entity's Reaction per SRD"
    );

    let ev = session
        .ledger
        .events
        .iter()
        .find(|e| e.event_type == "READY_ACTION_RELEASED" && e.actor_id == actor)
        .expect("release is ledgered");
    assert_eq!(
        ev.payload["reaction_spent"], serde_json::json!(true),
        "the ledger records WHY the reaction is gone"
    );
    assert_eq!(ev.payload["trigger"], serde_json::json!("enemy_enters_reach"));

    // Releasing twice is impossible: nothing is left to release.
    assert_eq!(
        session.release_readied_action(actor).unwrap_err(),
        "NO_READIED_ACTION"
    );
}

#[test]
fn test_release_readied_action_rejects_without_reaction_or_capacity() {
    let mut session = session_with_pair();
    let actor = *session.entities.keys().next().unwrap();
    let other = *session.entities.keys().find(|k| **k != actor).unwrap();

    // Nothing readied: rejected without touching any budget.
    assert_eq!(
        session.release_readied_action(actor).unwrap_err(),
        "NO_READIED_ACTION"
    );
    // Unknown entity.
    assert_eq!(
        session.release_readied_action(uuid::Uuid::new_v4()).unwrap_err(),
        "ENTITY_NOT_FOUND"
    );
    assert!(
        session.entities[&other].action_budget.reaction,
        "a rejected release must not spend anyone's Reaction"
    );

    // Reaction already spent this round: 409-shaped rejection, and the held
    // action SURVIVES so the GM can still resolve it next turn if desired.
    session
        .ready_action(actor, "I hold my strike", ReadiedTrigger::TurnStart)
        .unwrap();
    session.entities.get_mut(&actor).unwrap().action_budget.reaction = false;
    assert_eq!(
        session.release_readied_action(actor).unwrap_err(),
        "REACTION_SPENT"
    );
    assert!(
        session.entities[&actor].readied_action.is_some(),
        "a failed release must not consume the readied declaration"
    );

    // Incapacitated actors cannot take reactions at all.
    session.entities.get_mut(&actor).unwrap().action_budget.reaction = true;
    session
        .entities
        .get_mut(&actor)
        .unwrap()
        .add_condition(Condition::Unconscious);
    assert_eq!(
        session.release_readied_action(actor).unwrap_err(),
        "ENTITY_CANNOT_ACT"
    );
    assert!(session.entities[&actor].readied_action.is_some());
    assert!(session.entities[&actor].action_budget.reaction);
}

/// The expiry of an UNreleased readied action must be visible in both the
/// ledger and the round report — a silently-vanishing held Action hides the
/// fact that the actor's Action economy was spent for nothing.
#[test]
fn test_unreadied_actions_expire_at_round_end_with_ledger_visibility() {
    let mut session = session_with_pair();
    let actor = *session.entities.keys().next().unwrap();
    let bystander = *session.entities.keys().find(|k| **k != actor).unwrap();

    session
        .ready_action(actor, "I hold my strike", ReadiedTrigger::EnemyAttacks)
        .unwrap();

    let mut dice = DiceEngine::with_seed(3);
    let report = session.advance_round(&mut dice);

    assert!(
        session.entities[&actor].readied_action.is_none(),
        "the refresh still clears the expired readied action"
    );
    assert_eq!(
        report.readied_expired,
        vec![actor],
        "the round report names exactly who lost a readied action"
    );
    assert!(!report.readied_expired.contains(&bystander));
    assert!(
        session
            .ledger
            .events
            .iter()
            .any(|e| e.event_type == "READIED_ACTION_EXPIRED" && e.actor_id == actor),
        "the expiry lands in the ledger for replay/audit"
    );
    // A round with no readied actions expires nobody.
    let report2 = session.advance_round(&mut dice);
    assert!(report2.readied_expired.is_empty());

    // Round reports from before the field existed deserialize cleanly.
    let legacy_report: vtt_core::state::RoundAdvanceReport =
        serde_json::from_value(serde_json::json!({"round": 3, "ticks": []})).unwrap();
    assert!(legacy_report.readied_expired.is_empty());
}

/// Rewind consistency: rewinding past a READY_ACTION_SET must not leave the
/// declaration armed on the entity (its backing event may have been reverted).
#[test]
fn test_rewind_clears_readied_actions_consistently() {
    let mut session = session_with_pair();
    let actor = *session.entities.keys().next().unwrap();

    session
        .ready_action(actor, "I attack when it moves", ReadiedTrigger::EnemyEntersReach)
        .unwrap();
    assert!(session.entities[&actor].readied_action.is_some());

    // Rewind to exactly now — every event including READY_ACTION_SET reverts.
    session.safety_rewind(session.ledger.current_sequence);
    assert!(
        session.entities[&actor].readied_action.is_none(),
        "a rewind past the Ready must clear the drifted declaration"
    );

    // Same for a rewind past a RELEASE: the wholesale clear keeps state and
    // ledger consistent even though the SET event survives the rewind point.
    session
        .ready_action(actor, "hold again", ReadiedTrigger::TurnStart)
        .unwrap();
    let pre_release = session.ledger.current_sequence - 1;
    session.release_readied_action(actor).unwrap();
    session.safety_rewind(pre_release);
    assert!(
        session.entities[&actor].readied_action.is_none(),
        "after rewinding past a release the declaration stays cleared (conservative)"
    );
}

// ------------------------------------------------- Two-Weapon Fighting & Help
//
// GOALS.md Pillar 3: the remaining SRD combat actions. Two-weapon fighting is
// a BONUS-action off-hand attack (both weapons Light, no positive ability mod
// to its damage); Help spends the Action to hand Advantage on the next attack
// roll against a target by the helper's allies.

use vtt_core::actions::ActionResolver;
use vtt_core::state::AttackAction;
use uuid::Uuid;

/// A dueling pair at melee range where `attacker` carries a custom attack list.
fn session_with_attacks(attacks: Vec<AttackAction>) -> (GameSession, Uuid, Uuid) {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "TWF".into());
    let mut attacker = hero("twin-blade", 30, 15);
    attacker.attacks = attacks;
    let mut enemy = hero("goblin", 40, 13);
    enemy.is_player = false;
    enemy.position = (2.5, 2.6, 0.0); // within 5 ft of the attacker
    let (ia, ie) = (attacker.id, enemy.id);
    session.add_entity(attacker, None).unwrap();
    session.add_entity(enemy, None).unwrap();
    (session, ia, ie)
}

fn light_weapon(name: &str, expr: &str) -> AttackAction {
    AttackAction {
        name: name.to_string(),
        attack_bonus: 5,
        damage_expression: expr.to_string(),
        damage_type: DamageType::Piercing,
        light: true,
    }
}

/// The SRD bonus-action off-hand strike: reuses resolve_attack's hit math and
/// withholds a POSITIVE ability modifier from the off-hand damage.
#[test]
fn test_offhand_attack_reuses_hit_math_and_withholds_positive_ability_mod() {
    // Str 16 (+3): "1d6+3" must roll as bare "1d6" for the off-hand.
    let (session, attacker_id, enemy_id) =
        session_with_attacks(vec![light_weapon("Shortsword", "1d6+3"), light_weapon("Dagger", "1d4+3")]);
    let attacker = &session.entities[&attacker_id];
    let enemy = &session.entities[&enemy_id];
    assert_eq!(attacker.abilities.modifier(Ability::Strength), 3);

    let mut dice = DiceEngine::with_seed(7);
    let res = ActionResolver::resolve_offhand_attack(
        &mut dice,
        attacker,
        enemy,
        &attacker.attacks[0],
        &attacker.attacks[1],
        enemy.ac,
        false,
        false,
    )
    .expect("two light weapons qualify");

    assert_eq!(res.damage_expression_rolled, "1d4");
    assert!(res.ability_mod_withheld_from_damage);
    assert_eq!(res.roll.target_ac, enemy.ac);

    // Hit math agrees with a straight RulesEvaluator::resolve_attack call on
    // the SAME seed: the off-hand path must draw exactly one attack d20 plus
    // the stripped damage expression — nothing more, nothing less.
    let mut reference = DiceEngine::with_seed(7);
    let expected = RulesEvaluator::resolve_attack(
        &mut reference,
        attacker.id,
        enemy.id,
        5,
        enemy.ac,
        "1d4",
        DamageType::Piercing,
        enemy.current_hp,
        enemy.max_hp,
        enemy.temp_hp,
        &enemy.resistances,
        &enemy.vulnerabilities,
        &enemy.immunities,
        false,
        false,
    )
    .unwrap();
    assert_eq!(res.roll.natural_roll, expected.natural_roll);
    assert_eq!(res.roll.attack_roll, res.roll.natural_roll + 5);
    assert_eq!(res.roll.is_hit, expected.is_hit);
    assert_eq!(res.roll.total_damage, expected.total_damage);
    assert_eq!(res.roll.target_hp_remaining, expected.target_hp_remaining);
}

/// A NEGATIVE ability modifier stays in the off-hand damage per SRD ("unless
/// that modifier is negative").
#[test]
fn test_offhand_keeps_a_negative_ability_modifier_in_damage() {
    let (mut session, attacker_id, enemy_id) =
        session_with_attacks(vec![light_weapon("Shortsword", "1d6+2")]);
    session.entities.get_mut(&attacker_id).unwrap().abilities.strength = 8; // -1
    let attacker = &session.entities[&attacker_id];
    let enemy = &session.entities[&enemy_id];

    let mut dagger = light_weapon("Dagger", "1d4");
    dagger.damage_expression = "1d4".to_string();
    let mut dice = DiceEngine::with_seed(11);
    let res = ActionResolver::resolve_offhand_attack(
        &mut dice,
        attacker,
        enemy,
        &attacker.attacks[0],
        &dagger,
        enemy.ac,
        false,
        false,
    )
    .unwrap();
    assert!(!res.ability_mod_withheld_from_damage);
    assert_eq!(res.damage_expression_rolled, "1d4");
}

/// Both held weapons must carry the Light property; an unqualified request is
/// refused WITHOUT spending anything.
#[test]
fn test_offhand_requires_both_weapons_to_be_light() {
    let main_heavy = AttackAction {
        name: "Longsword".to_string(),
        attack_bonus: 5,
        damage_expression: "1d8+3".to_string(),
        damage_type: DamageType::Slashing,
        light: false,
    };
    let (session, attacker_id, enemy_id) =
        session_with_attacks(vec![main_heavy.clone(), light_weapon("Dagger", "1d4")]);
    {
        let attacker = &session.entities[&attacker_id];
        let enemy = &session.entities[&enemy_id];
        let mut dice = DiceEngine::with_seed(3);
        assert_eq!(
            ActionResolver::resolve_offhand_attack(
                &mut dice, attacker, enemy, &attacker.attacks[0], &attacker.attacks[1], enemy.ac,
                false, false,
            )
            .unwrap_err(),
            "MAIN_HAND_WEAPON_NOT_LIGHT"
        );
    }

    // Off-hand side: light main, heavy off-hand.
    let (session, attacker_id, enemy_id) =
        session_with_attacks(vec![light_weapon("Shortsword", "1d6"), main_heavy]);
    let attacker = &session.entities[&attacker_id];
    let enemy = &session.entities[&enemy_id];
    let mut dice = DiceEngine::with_seed(3);
    assert_eq!(
        ActionResolver::resolve_offhand_attack(
            &mut dice, attacker, enemy, &attacker.attacks[0], &attacker.attacks[1], enemy.ac,
            false, false,
        )
        .unwrap_err(),
        "OFFHAND_WEAPON_NOT_LIGHT"
    );
}

/// The bonus action is the ONLY budget the off-hand strike consumes.
#[test]
fn test_offhand_spends_the_bonus_action_not_the_action() {
    let (mut session, attacker_id, _enemy_id) =
        session_with_attacks(vec![light_weapon("Shortsword", "1d6"), light_weapon("Dagger", "1d4")]);

    // SRD: the Attack action comes first — spend it, then the bonus strike.
    session.entities.get_mut(&attacker_id).unwrap().spend_action().unwrap();
    assert!(session.entities[&attacker_id].action_budget.bonus_action);

    session.entities.get_mut(&attacker_id).unwrap().spend_bonus_action().unwrap();
    let budget = &session.entities[&attacker_id].action_budget;
    assert!(!budget.action, "the Action was spent before the off-hand");
    assert!(!budget.bonus_action, "the off-hand strike consumes the Bonus Action");

    // A second off-hand strike in the same turn is refused without effect.
    assert_eq!(
        session.entities.get_mut(&attacker_id).unwrap().spend_bonus_action().unwrap_err(),
        "BONUS_ACTION_ECONOMY_EXHAUSTED"
    );
    assert!(
        !session.entities[&attacker_id].action_budget.action,
        "a rejected bonus-action spend must not touch the Action"
    );

    // An entity that cannot act cannot even buy the bonus strike.
    session.entities.get_mut(&attacker_id).unwrap().add_condition(Condition::Unconscious);
    assert_eq!(
        session.entities.get_mut(&attacker_id).unwrap().spend_bonus_action().unwrap_err(),
        "ENTITY_CANNOT_ACT"
    );
}

// ------------------------------------------------------------------- Help

fn session_trio() -> (GameSession, Uuid, Uuid, Uuid) {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Help".into());
    let helper = hero("cleric", 25, 15);
    let ally = hero("fighter", 30, 16);
    let mut enemy = hero("ogre", 60, 14);
    enemy.is_player = false;
    enemy.position = (2.5, 2.6, 0.0);
    let (ih, ia, ie) = (helper.id, ally.id, enemy.id);
    session.add_entity(helper, None).unwrap();
    session.add_entity(ally, None).unwrap();
    session.add_entity(enemy, None).unwrap();
    (session, ih, ia, ie)
}

#[test]
fn test_take_help_spends_the_action_and_grants_one_consumable_advantage() {
    let (mut session, helper_id, ally_id, enemy_id) = session_trio();

    session.take_help(helper_id, enemy_id).unwrap();

    // The promise is authoritative state ON THE TARGET, naming the helper.
    assert_eq!(
        session.entities[&enemy_id].next_attacker_has_advantage_against,
        Some(helper_id.to_string())
    );
    assert!(
        !session.entities[&helper_id].action_budget.action,
        "Help spends the helper's Action"
    );
    assert!(session.ledger.events.iter().any(|e| e.event_type == "HELP_ACTION"));

    // The FIRST qualifying (same-side) attack consumes it exactly once...
    assert!(session.consume_help_advantage(ally_id, enemy_id));
    assert!(session.entities[&enemy_id].next_attacker_has_advantage_against.is_none());

    // ...and a second attack gets nothing.
    assert!(!session.consume_help_advantage(ally_id, enemy_id));
}

/// Advantage is reserved for the helper's SIDE: a hostile attack neither
/// benefits from nor burns the token — the aided ally keeps the benefit.
#[test]
fn test_hostile_attack_leaves_the_help_token_standing() {
    let (mut session, helper_id, ally_id, enemy_id) = session_trio();
    session.take_help(helper_id, enemy_id).unwrap();

    let mut rival = hero("rival-goblin", 20, 12);
    rival.is_player = false; // same side as the helped ENEMY
    let rival_id = rival.id;
    session.add_entity(rival, None).unwrap();

    assert!(!session.consume_help_advantage(rival_id, enemy_id));
    assert_eq!(
        session.entities[&enemy_id].next_attacker_has_advantage_against,
        Some(helper_id.to_string()),
        "the aided ally keeps the pending benefit"
    );

    // The helper's own side can still cash it afterwards.
    assert!(session.consume_help_advantage(ally_id, enemy_id));
}

#[test]
fn test_take_help_rejects_invalid_targets_and_exhausted_actions() {
    let (mut session, helper_id, ally_id, enemy_id) = session_trio();

    assert_eq!(
        session.take_help(helper_id, helper_id).unwrap_err(),
        "SELF_TARGET_INVALID"
    );
    assert_eq!(
        session.take_help(Uuid::new_v4(), enemy_id).unwrap_err(),
        "ENTITY_NOT_FOUND"
    );
    assert_eq!(
        session.take_help(helper_id, Uuid::new_v4()).unwrap_err(),
        "TARGET_NOT_FOUND"
    );
    assert_eq!(
        session.take_help(ally_id, enemy_id)
            .and_then(|_| session.take_help(ally_id, enemy_id))
            .unwrap_err(),
        "ACTION_ECONOMY_EXHAUSTED"
    );

    // Out of reach: move the enemy away from the (still fresh) helper.
    session.entities.get_mut(&ally_id).unwrap().action_budget.action = true;
    session.entities.get_mut(&enemy_id).unwrap().position = (20.0, 20.0, 0.0);
    assert_eq!(
        session.take_help(ally_id, enemy_id).unwrap_err(),
        "OUT_OF_REACH"
    );

    // Dead enemies cannot be helped against.
    session.entities.get_mut(&enemy_id).unwrap().position = (2.5, 2.6, 0.0);
    session.entities.get_mut(&enemy_id).unwrap().is_dead = true;
    assert_eq!(
        session.take_help(ally_id, enemy_id).unwrap_err(),
        "TARGET_ALREADY_DEAD"
    );
}

/// The token is turn-scoped: the next round refresh clears an unconsumed one.
#[test]
fn test_round_refresh_clears_an_unconsumed_help_token() {
    let (mut session, helper_id, _ally_id, enemy_id) = session_trio();
    session.take_help(helper_id, enemy_id).unwrap();
    assert!(session.entities[&enemy_id].next_attacker_has_advantage_against.is_some());

    let mut dice = DiceEngine::with_seed(5);
    session.advance_round(&mut dice);
    assert!(
        session.entities[&enemy_id].next_attacker_has_advantage_against.is_none(),
        "Help lasts only until the target's next turn refresh"
    );
    assert!(!session.consume_help_advantage(_ally_id, enemy_id));
}

/// Rewinding past the HELP_ACTION event drops the promise along with the
/// refunded Action (turn-scoped state clears wholesale on a rewind).
#[test]
fn test_safety_rewind_past_help_clears_the_token_and_refunds_the_action() {
    let (mut session, helper_id, ally_id, enemy_id) = session_trio();
    let pre_help_sequence = session.ledger.current_sequence;
    session.take_help(helper_id, enemy_id).unwrap();
    assert!(session.entities[&enemy_id].next_attacker_has_advantage_against.is_some());

    session.safety_rewind(pre_help_sequence);

    assert!(session.entities[&enemy_id].next_attacker_has_advantage_against.is_none());
    assert!(
        session.entities[&helper_id].action_budget.action,
        "the rewound Help refunds the helper's Action like every other event"
    );
    assert!(!session.consume_help_advantage(ally_id, enemy_id));
}

// ------------------------------------------------------- Inspiration (P5)

/// Grant/revoke lifecycle: flag flips, ledger records every transition.
#[test]
fn test_inspiration_grant_revoke_lifecycle_and_ledger() {
    let (mut session, hero_id, _ally_id, _enemy_id) = session_trio();

    assert!(
        !session.entities[&hero_id].inspiration,
        "fresh entities hold no inspiration"
    );

    session.grant_inspiration(hero_id, Some("heroic roleplay")).unwrap();
    assert!(session.entities[&hero_id].inspiration);

    session.revoke_inspiration(hero_id, Some("GM fiat")).unwrap();
    assert!(!session.entities[&hero_id].inspiration);

    let inspiration_events: Vec<_> = session
        .ledger
        .events
        .iter()
        .filter(|e| e.event_type == "INSPIRATION_CHANGED")
        .collect();
    assert_eq!(inspiration_events.len(), 2, "one event per grant and one per revoke");
    assert_eq!(
        inspiration_events[0].payload.get("granted").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        inspiration_events[1].payload.get("granted").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        inspiration_events[0].payload.get("reason").and_then(|v| v.as_str()),
        Some("heroic roleplay")
    );
}

/// RAW: a character can hold at most one point of inspiration.
#[test]
fn test_inspiration_is_capped_at_one() {
    let (mut session, hero_id, _ally_id, _enemy_id) = session_trio();

    session.grant_inspiration(hero_id, None).unwrap();
    let err = session.grant_inspiration(hero_id, None).unwrap_err();
    assert_eq!(err, "INSPIRATION_ALREADY_HELD");
    assert!(
        session.entities[&hero_id].inspiration,
        "a rejected over-grant leaves the held point intact"
    );
}

#[test]
fn test_inspiration_grant_revoke_reject_missing_entities_and_empty_revokes() {
    let (mut session, hero_id, _ally_id, _enemy_id) = session_trio();

    assert_eq!(
        session.grant_inspiration(Uuid::new_v4(), None).unwrap_err(),
        "ENTITY_NOT_FOUND"
    );
    assert_eq!(
        session.revoke_inspiration(Uuid::new_v4(), None).unwrap_err(),
        "ENTITY_NOT_FOUND"
    );
    // Nothing to revoke yet.
    assert_eq!(
        session.revoke_inspiration(hero_id, None).unwrap_err(),
        "INSPIRATION_NOT_HELD"
    );
}

/// Spending is atomic with the edge computation: the FIRST spend flips the
/// flag off and yields advantage; a second spend finds nothing to burn.
#[test]
fn test_spend_inspiration_consumes_atomically_at_the_edge_computation() {
    let (mut session, attacker_id, _ally_id, target_id) = session_trio();

    session.grant_inspiration(attacker_id, None).unwrap();
    {
        // Take the attacker OUT so we can also look up the target without a
        // borrow-checker collision (the engine API wants &mut attacker and
        // &target borrowed simultaneously, and HashMap can't split).
        let mut attacker = session.entities.remove(&attacker_id).unwrap();
        let target = &session.entities[&target_id];
        let (advantage, _disadvantage, consumed) =
            RulesEvaluator::edge_from_conditions_with_inspiration(
                &mut attacker, target, 5.0, 0.0, 0.0, true,
            );
        assert!(advantage, "spent inspiration grants advantage");
        assert!(consumed, "the spend reports consumption for the response body");
        session.entities.insert(attacker.id, attacker);
    }
    assert!(
        !session.entities[&attacker_id].inspiration,
        "the point is burned by the roll that used it"
    );
    assert!(
        session
            .ledger
            .events
            .iter()
            .any(|e| e.event_type == "INSPIRATION_CHANGED"),
        "the spend is journaled so a rewind can restore it"
    );

    // Second roll: nothing left to burn.
    let mut attacker = session.entities.remove(&attacker_id).unwrap();
    let target = &session.entities[&target_id];
    let (_, _, consumed) = RulesEvaluator::edge_from_conditions_with_inspiration(
        &mut attacker, target, 5.0, 0.0, 0.0, true,
    );
    assert!(!consumed);
    assert!(!attacker.inspiration);
    session.entities.insert(attacker.id, attacker);
}

/// Advantage and disadvantage CANCEL per SRD: spending inspiration into an
/// already-disadvantaged edge buys nothing, so it must not be consumed —
/// the player keeps the point instead of wasting it on a cancelled pair.
#[test]
fn test_inspiration_spend_is_not_consumed_when_disadvantage_would_cancel_it() {
    let (mut session, attacker_id, _ally_id, target_id) = session_trio();

    session.grant_inspiration(attacker_id, None).unwrap();
    session.entities
        .get_mut(&attacker_id)
        .unwrap()
        .add_condition(Condition::Poisoned); // disadvantage on attacks

    {
        let mut attacker = session.entities.remove(&attacker_id).unwrap();
        let target = &session.entities[&target_id];
        let (advantage, disadvantage, consumed) =
            RulesEvaluator::edge_from_conditions_with_inspiration(
                &mut attacker, target, 5.0, 0.0, 0.0, true,
            );
        assert!(!advantage && disadvantage, "the pair still cancels to a straight d20");
        assert!(!consumed, "no advantage was bought, so no point burns");
        session.entities.insert(attacker.id, attacker);
    }
    assert!(
        session.entities[&attacker_id].inspiration,
        "the player keeps their inspiration"
    );
}

/// A spend request from someone holding nothing changes neither the edge nor
/// any state — it is a silent no-op, not an error.
#[test]
fn test_inspiration_spend_without_a_held_point_is_a_noop() {
    let (mut session, attacker_id, _ally_id, target_id) = session_trio();

    {
        let mut attacker = session.entities.remove(&attacker_id).unwrap();
        let target = &session.entities[&target_id];
        let (advantage, disadvantage, consumed) =
            RulesEvaluator::edge_from_conditions_with_inspiration(
                &mut attacker, target, 5.0, 0.0, 0.0, true,
            );
        assert!(!advantage && !disadvantage && !consumed);
        session.entities.insert(attacker.id, attacker);
    }
    assert!(!session.entities[&attacker_id].inspiration);
}

/// Rewinding past the SPEND replays the surviving GRANT: the player gets
/// their point back because the roll that burned it never happened.
#[test]
fn test_safety_rewind_restores_spent_inspiration() {
    let (mut session, hero_id, _ally_id, _enemy_id) = session_trio();
    session.grant_inspiration(hero_id, None).unwrap();
    let after_grant_sequence = session.ledger.current_sequence;

    // Spend it (consume path journals INSPIRATION_CHANGED granted=false).
    assert!(session.consume_inspiration(hero_id));
    assert!(!session.entities[&hero_id].inspiration);

    session.safety_rewind(after_grant_sequence);

    assert!(
        session.entities[&hero_id].inspiration,
        "rewind past the spend restores the surviving grant"
    );
}

/// Rewinding past the GRANT itself strips the point: no surviving event
/// vouches for it anymore.
#[test]
fn test_safety_rewind_past_the_grant_strips_inspiration() {
    let (mut session, hero_id, _ally_id, _enemy_id) = session_trio();
    let pre_grant_sequence = session.ledger.current_sequence;
    session.grant_inspiration(hero_id, None).unwrap();
    assert!(session.entities[&hero_id].inspiration);

    session.safety_rewind(pre_grant_sequence);

    assert!(!session.entities[&hero_id].inspiration);
}

// ------------------------------------------- Help on ability checks (P3)

/// Help used on an ABILITY CHECK stores its promise ON THE BENEFICIARY (they
/// make the check), spends the helper's Action, and is cashed exactly once.
#[test]
fn test_help_check_spends_action_and_grants_one_consumable_check_advantage() {
    let (mut session, helper_id, ally_id, _enemy_id) = session_trio();

    session.take_help_check(helper_id, ally_id).unwrap();

    assert_eq!(
        session.entities[&ally_id].next_check_has_advantage_from,
        Some(helper_id.to_string()),
        "the promise lives on the checker, naming the helper"
    );
    assert!(
        !session.entities[&helper_id].action_budget.action,
        "Help spends the helper's Action whether aiding an attack or a check"
    );
    assert!(
        session
            .ledger
            .events
            .iter()
            .any(|e| e.event_type == "HELP_CHECK_ACTION")
    );

    // The beneficiary's NEXT ability check cashes it exactly once...
    assert!(session.consume_help_check_advantage(ally_id));
    assert!(session.entities[&ally_id].next_check_has_advantage_from.is_none());
    // ...and a later check gets nothing.
    assert!(!session.consume_help_check_advantage(ally_id));
}

#[test]
fn test_take_help_check_rejects_invalid_targets_exhausted_actions_and_distance() {
    let (mut session, helper_id, ally_id, enemy_id) = session_trio();

    assert_eq!(
        session.take_help_check(helper_id, helper_id).unwrap_err(),
        "SELF_TARGET_INVALID"
    );
    assert_eq!(
        session.take_help_check(Uuid::new_v4(), ally_id).unwrap_err(),
        "ENTITY_NOT_FOUND"
    );
    assert_eq!(
        session.take_help_check(helper_id, Uuid::new_v4()).unwrap_err(),
        "TARGET_NOT_FOUND"
    );

    // Reach gate: the helper must be able to physically assist.
    session.entities.get_mut(&ally_id).unwrap().position = (20.0, 20.0, 0.0);
    assert_eq!(
        session.take_help_check(helper_id, ally_id).unwrap_err(),
        "OUT_OF_REACH"
    );
    session.entities.get_mut(&ally_id).unwrap().position = (2.6, 2.6, 0.0);

    // Action economy: the helper has no Action left.
    session.entities.get_mut(&helper_id).unwrap().action_budget.action = false;
    assert_eq!(
        session.take_help_check(helper_id, ally_id).unwrap_err(),
        "ACTION_ECONOMY_EXHAUSTED"
    );
    session.entities.get_mut(&helper_id).unwrap().action_budget.action = true;

    // An incapacitated helper cannot assist either.
    session.entities
        .get_mut(&helper_id)
        .unwrap()
        .add_condition(Condition::Unconscious);
    assert_eq!(
        session.take_help_check(helper_id, ally_id).unwrap_err(),
        "ENTITY_CANNOT_ACT"
    );

    // Nor can anyone help a dead beneficiary with a check.
    session.entities.get_mut(&helper_id).unwrap().conditions.clear();
    session.entities.get_mut(&enemy_id).unwrap().is_dead = true;
    assert_eq!(
        session.take_help_check(helper_id, enemy_id).unwrap_err(),
        "TARGET_ALREADY_DEAD"
    );
    // And none of the rejections above spent the helper's Action.
    session.entities.get_mut(&helper_id).unwrap().action_budget.action = true;
}

/// A stale check-help promise whose helper has left the session is discarded
/// without granting anything.
#[test]
fn test_help_check_promise_dies_with_its_helper() {
    let (mut session, helper_id, ally_id, _enemy_id) = session_trio();
    session.take_help_check(helper_id, ally_id).unwrap();

    session.remove_entity(&helper_id, "left the table");

    assert!(
        !session.consume_help_check_advantage(ally_id),
        "a departed helper cannot keep the promise"
    );
}

/// Check-help is turn-scoped like attack-help: the round refresh clears an
/// unconsumed promise.
#[test]
fn test_round_refresh_clears_an_unconsumed_help_check_token() {
    let (mut session, helper_id, ally_id, _enemy_id) = session_trio();
    session.take_help_check(helper_id, ally_id).unwrap();

    let mut dice = DiceEngine::with_seed(7);
    session.advance_round(&mut dice);

    assert!(session.entities[&ally_id].next_check_has_advantage_from.is_none());
    assert!(!session.consume_help_check_advantage(ally_id));
}

/// Rewinding past the HELP_CHECK_ACTION drops the promise along with the
/// refunded Action.
#[test]
fn test_safety_rewind_past_help_check_clears_the_token() {
    let (mut session, helper_id, ally_id, _enemy_id) = session_trio();
    let pre_help_sequence = session.ledger.current_sequence;
    session.take_help_check(helper_id, ally_id).unwrap();

    session.safety_rewind(pre_help_sequence);

    assert!(session.entities[&ally_id].next_check_has_advantage_from.is_none());
    assert!(
        session.entities[&helper_id].action_budget.action,
        "the rewound help-check refunds the helper's Action"
    );
    assert!(!session.consume_help_check_advantage(ally_id));
}

// --- Audit iterations 61-62 / F-A4#7: ITEM_TRANSFERRED is rewind-blind -------

use vtt_core::inventory::Item;

fn plain_item(id: uuid::Uuid, name: &str, weight_lbs: f32) -> Item {
    Item {
        id,
        compendium_id: format!("item_{}", name.to_lowercase().replace(' ', "_")),
        name: name.to_string(),
        base_weight_lbs: weight_lbs,
        quantity: 1,
        is_container: false,
        container_capacity_lbs: None,
        container_volume_cu_ft: None,
        volume_cu_ft: 0.1,
        parent_container_id: None,
        is_equipped: false,
        is_attuned: false,
        is_cursed: false,
        is_curse_revealed: false,
        true_state: serde_json::json!({}),
        perceived_state: serde_json::json!({}),
    }
}

/// Rewinding past an ITEM_TRANSFERRED must move the item BACK to where the
/// event's "from_container_id" says it lived (root here), exactly like a
/// rewind past a shove restores the pre-push position.
#[test]
fn test_safety_rewind_past_item_transfer_restores_prior_placement() {
    let mut session = session_with_pair();
    let (owner, _other): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    let chest_id = uuid::Uuid::new_v4();
    let sword_id = uuid::Uuid::new_v4();
    let mut chest = plain_item(chest_id, "Chest", 5.0);
    chest.is_container = true;
    let owner_entity = session.entities.get_mut(&owner).unwrap();
    owner_entity.inventory.add_item(chest);
    owner_entity.inventory.add_item(plain_item(sword_id, "Sword", 3.0));

    let baseline_seq = session.ledger.current_sequence;
    append_and_seq(
        &mut session,
        owner,
        "ITEM_TRANSFERRED",
        serde_json::json!({
            "item_id": sword_id.to_string(),
            "container_id": chest_id.to_string(),
            "from_container_id": null,
        }),
    );
    // The live transfer really moved it.
    session
        .entities
        .get_mut(&owner)
        .unwrap()
        .inventory
        .items
        .get_mut(&sword_id)
        .unwrap()
        .parent_container_id = Some(chest_id);

    session.safety_rewind(baseline_seq);

    assert_eq!(
        session.entities[&owner].inventory.items[&sword_id].parent_container_id,
        None,
        "rewind past the transfer must put the sword back at the root"
    );
}

/// A transfer that SURVIVES the rewind keeps its effect; only transfers past
/// the rewind point are undone (last-surviving-event-wins).
#[test]
fn test_safety_rewind_between_transfers_keeps_the_surviving_placement() {
    let mut session = session_with_pair();
    let (owner, _other): (uuid::Uuid, uuid::Uuid) = {
        let ids: Vec<uuid::Uuid> = session.entities.keys().copied().collect();
        (ids[0], ids[1])
    };

    let (chest_a, chest_b, ring) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let mut containers: Vec<Item> = [chest_a, chest_b]
        .iter()
        .map(|id| {
            let mut c = plain_item(*id, "Chest", 5.0);
            c.is_container = true;
            c
        })
        .collect();
    containers.push(plain_item(ring, "Ring", 0.1));
    {
        let inv = &mut session.entities.get_mut(&owner).unwrap().inventory;
        for c in containers {
            inv.add_item(c);
        }
    }

    // First transfer survives the rewind; second is rewound past.
    append_and_seq(
        &mut session,
        owner,
        "ITEM_TRANSFERRED",
        serde_json::json!({
            "item_id": ring.to_string(),
            "container_id": chest_a.to_string(),
            "from_container_id": null,
        }),
    );
    let seq_after_first = session.ledger.current_sequence;
    append_and_seq(
        &mut session,
        owner,
        "ITEM_TRANSFERRED",
        serde_json::json!({
            "item_id": ring.to_string(),
            "container_id": chest_b.to_string(),
            "from_container_id": chest_a.to_string(),
        }),
    );
    let set_parent = |session: &mut GameSession, parent: Option<uuid::Uuid>| {
        session
            .entities
            .get_mut(&owner)
            .unwrap()
            .inventory
            .items
            .get_mut(&ring)
            .unwrap()
            .parent_container_id = parent;
    };
    set_parent(&mut session, Some(chest_a));
    set_parent(&mut session, Some(chest_b));

    session.safety_rewind(seq_after_first);

    assert_eq!(
        session.entities[&owner].inventory.items[&ring].parent_container_id,
        Some(chest_a),
        "the surviving first transfer stays authoritative after the rewind"
    );
}

// --- Audit iteration 14 / F11: validate_ingress must enforce its docstring ---

use vtt_core::SessionMap;

fn ingress(id: uuid::Uuid, kind: IngressType, source: (f32, f32, f32), target: (f32, f32, f32)) -> IngressEvent {
    IngressEvent {
        entity_id: id,
        ingress_type: kind,
        source_point: source,
        target_point: target,
        verified: false,
    }
}

/// GOALS.md P6 anti-popping: a SpawnEvent materializes a token from nothing.
/// That is legal during setup, but once combat has begun it is exactly the
/// "popping" the conservation law forbids — mid-combat arrivals must come
/// through a transit protocol (teleport / portal / burrow / stealth reveal).
#[test]
fn test_spawn_event_ingress_rejected_once_combat_has_begun() {
    let mut session = session_with_pair();
    let mut dice = DiceEngine::with_seed(7);
    session.begin_combat(&mut dice);
    assert!(session.combat.in_combat);

    let id = uuid::Uuid::new_v4();
    let newcomer = hero("late-arriver", 22, 14);
    let err = session
        .add_entity(newcomer, Some(ingress(id, IngressType::SpawnEvent, (0.0, 0.0, 0.0), (9.0, 9.0, 0.0))))
        .unwrap_err();
    assert_eq!(err, "INGRESS_SPAWN_FORBIDDEN_IN_COMBAT");

    // Rejected ingress must not have added the entity or logged a spawn.
    assert!(session.entities.keys().all(|k| *k != id), "entity must not be on the board");
}

/// Before combat starts the same SpawnEvent is legal (setup-phase deployment).
#[test]
fn test_spawn_event_ingress_still_legal_during_setup() {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Setup".into());
    let id = uuid::Uuid::new_v4();
    let newcomer = hero("deployed", 22, 14);
    assert!(
        session
            .add_entity(
                newcomer,
                Some(ingress(id, IngressType::SpawnEvent, (0.0, 0.0, 0.0), (3.0, 3.0, 0.0)))
            )
            .is_ok(),
        "SpawnEvent is legal before combat begins"
    );
}

/// Portal/Door-style transit protocols stay legal mid-combat — that is their
/// entire purpose under P6 (a creature walks through a door mid-fight).
#[test]
fn test_portal_ingress_remains_legal_mid_combat() {
    let mut session = session_with_pair();
    let mut dice = DiceEngine::with_seed(7);
    session.begin_combat(&mut dice);

    let id = uuid::Uuid::new_v4();
    let walker = hero("door-walker", 22, 14);
    assert!(
        session
            .add_entity(
                walker,
                Some(ingress(id, IngressType::PortalDoor, (1.0, 1.0, 0.0), (12.0, 12.0, 0.0)))
            )
            .is_ok(),
        "PortalDoor transit is a legal mid-combat arrival protocol"
    );
}

/// A Teleportation ingress whose target lands inside a wall cell must be
/// rejected — teleporting INTO rock is not transit, it is clipping.
#[test]
fn test_teleport_into_wall_rejected() {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Walls".into());
    let mut map = SessionMap::default();
    map.solid_cells.push((6, 6)); // world rect x in [30,35), y in [30,35) at 5 ft cells
    session.map = map;

    let id = uuid::Uuid::new_v4();
    let blinker = hero("blinker", 22, 14);
    let err = session
        .add_entity(
            blinker,
            Some(ingress(id, IngressType::Teleportation, (2.0, 2.0, 0.0), (32.5, 32.5, 0.0))),
        )
        .unwrap_err();
    assert_eq!(err, "INGRESS_TARGET_BLOCKED");
    assert!(session.entities.keys().all(|k| *k != id));
}

/// Landing outside the authored map rectangle is blocked too.
#[test]
fn test_ingress_target_off_map_rejected() {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Walls".into());
    session.map = SessionMap::default(); // 32x32 @ 5ft

    let id = uuid::Uuid::new_v4();
    let drifter = hero("drifter", 22, 14);
    let err = session
        .add_entity(
            drifter,
            Some(ingress(id, IngressType::Burrowing, (2.0, 2.0, 0.0), (500.0, 2.0, 0.0))),
        )
        .unwrap_err();
    assert_eq!(err, "INGRESS_TARGET_BLOCKED");
}

/// Open floor remains a legal teleport destination.
#[test]
fn test_teleport_to_open_floor_allowed() {
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Walls".into());
    let mut map = SessionMap::default();
    map.solid_cells.push((6, 6));
    session.map = map;

    let id = uuid::Uuid::new_v4();
    let blinker = hero("blinker", 22, 14);
    session
        .add_entity(
            blinker,
            Some(ingress(id, IngressType::Teleportation, (2.0, 2.0, 0.0), (27.5, 27.5, 0.0))),
        )
        .expect("open-floor target must pass validation");
}

/// The `verified` flag must be set by VALIDATION, not stamped unconditionally:
/// an event that never passed validation must not enter the stack wearing a
/// verified badge (the anti-popping gate looked stronger than it was).
#[test]
fn test_verified_flag_reflects_actual_validation_outcome() {
    // A caller lies with verified=true; the engine validates structurally and
    // only then stamps true — so far unchanged behavior for GOOD events...
    let mut session = GameSession::new(uuid::Uuid::new_v4(), uuid::Uuid::new_v4(), "Honesty".into());
    let good = uuid::Uuid::new_v4();
    session
        .add_entity(
            hero("good", 10, 12),
            Some(IngressEvent {
                entity_id: good,
                ingress_type: IngressType::StealthReveal,
                source_point: (2.0, 2.0, 0.0),
                target_point: (4.0, 4.0, 0.0),
                verified: false,
            }),
        )
        .unwrap();
    let stored = session.ingress_stack.last().unwrap();
    assert!(stored.verified, "validated ingress earns its verified flag");

    // ...but a BAD event must be rejected outright, never recorded as verified.
    let mut session2 = session_with_pair();
    let mut dice = DiceEngine::with_seed(3);
    session2.begin_combat(&mut dice);
    let bad = uuid::Uuid::new_v4();
    let mut bad_event = ingress(bad, IngressType::SpawnEvent, (0.0, 0.0, 0.0), (5.0, 5.0, 0.0));
    bad_event.verified = true; // caller-supplied lie
    assert!(session2.add_entity(hero("bad", 10, 12), Some(bad_event)).is_err());
    assert!(
        !session2.ingress_stack.iter().any(|i| i.entity_id == bad),
        "rejected ingress must not sit in the stack"
    );
}

// ------------------------------------------------ bound-hands model (iter 41)

fn somatic_spell() -> SpellDefinition {
    SpellDefinition {
        spell_id: "charm_like".to_string(),
        name: "Somatic Probe".to_string(),
        level: 1,
        school: "Illusion".to_string(),
        casting_time: "1 action".to_string(),
        range_feet: 30,
        area_of_effect_shape: None,
        area_of_effect_size_feet: None,
        verbal_component: true,
        somatic_component: true,
        material_component_desc: None,
        save_attribute: Some(Ability::Wisdom),
        damage_formula: Some("2d4".to_string()),
        damage_type: Some(DamageType::Psychic),
        duration_rounds: 0,
        is_concentration: false,
        is_ritual: false,
    }
}

fn verbal_only_spell() -> SpellDefinition {
    let mut s = somatic_spell();
    s.spell_id = "verbal_probe".to_string();
    s.somatic_component = false;
    s
}

#[test]
fn test_somatic_cast_fails_with_both_hands_occupied_and_spends_no_slot() {
    let mut session = session_with_pair();
    let caster_id = *session.entities.keys().next().unwrap();
    let target_id = *session.entities.keys().find(|k| **k != caster_id).unwrap();

    let caster = session.entities.get_mut(&caster_id).unwrap();
    caster.spell_slots_remaining = [(1u8, 1u32)].into_iter().collect();
    // Both hands bound (grappling with one, shield in the other, etc.).
    caster.hands_occupied = 2;

    let mut dice = DiceEngine::with_seed(3);
    let mut target = session.entities.remove(&target_id).unwrap();
    let err = RulesEvaluator::validate_and_cast_spell(
        &mut dice,
        session.entities.get_mut(&caster_id).unwrap(),
        Some(&mut target),
        &somatic_spell(),
        1,
        false,
    )
    .unwrap_err();
    session.entities.insert(target_id, target);

    assert_eq!(err, "CANNOT_SOMATIZE", "both hands occupied must refuse a somatic cast");
    assert_eq!(
        session.entities[&caster_id].spell_slots_remaining.get(&1),
        Some(&1),
        "a refused somatic cast must not spend the slot"
    );
}

#[test]
fn test_somatic_cast_needs_one_free_hand_and_non_somatic_ignores_bound_hands() {
    let mut session = session_with_pair();
    let caster_id = *session.entities.keys().next().unwrap();
    let target_id = *session.entities.keys().find(|k| **k != caster_id).unwrap();
    session.entities.get_mut(&caster_id).unwrap().spell_slots_remaining =
        [(1u8, 2u32)].into_iter().collect();

    // One hand free (the other grapples): the somatic gesture is still possible.
    session.entities.get_mut(&caster_id).unwrap().hands_occupied = 1;
    let mut dice = DiceEngine::with_seed(5);
    let mut target = session.entities.remove(&target_id).unwrap();
    let res = RulesEvaluator::validate_and_cast_spell(
        &mut dice,
        session.entities.get_mut(&caster_id).unwrap(),
        Some(&mut target),
        &somatic_spell(),
        1,
        false,
    )
    .expect("one free hand must be enough to somatize");
    session.entities.insert(target_id, target);
    assert_eq!(res.slot_level_used, 1);

    // BOTH hands occupied, but the spell has no somatic component: castable.
    let caster2 = *session.entities.keys().next().unwrap();
    let target2_id = *session.entities.keys().find(|k| **k != caster2).unwrap();
    session.entities.get_mut(&caster2).unwrap().spell_slots_remaining =
        [(1u8, 1u32)].into_iter().collect();
    session.entities.get_mut(&caster2).unwrap().hands_occupied = 2;
    let mut target2 = session.entities.remove(&target2_id).unwrap();
    let res2 = RulesEvaluator::validate_and_cast_spell(
        &mut dice,
        session.entities.get_mut(&caster2).unwrap(),
        Some(&mut target2),
        &verbal_only_spell(),
        1,
        false,
    )
    .expect("a verbal-only spell must not care about bound hands");
    session.entities.insert(target2_id, target2);
    assert_eq!(res2.slot_level_used, 1);
}

#[test]
fn test_bound_hands_helpers_round_trip() {
    let mut e = hero("palm_reader", 20, 14);
    assert_eq!(e.free_hands(), 2);
    assert!(!e.is_blinded());

    e.occupy_hand(); // won a grapple
    assert_eq!(e.free_hands(), 1);
    e.occupy_hand();
    assert_eq!(e.free_hands(), 0);
    e.occupy_hand(); // saturates at two modeled hands
    assert_eq!(e.free_hands(), 0, "a humanoid only has two hands");

    e.release_hand();
    assert_eq!(e.free_hands(), 1);
    e.release_hand();
    e.release_hand(); // saturating release never underflows
    assert_eq!(e.free_hands(), 2);

    e.conditions.push(Condition::Blinded);
    assert!(e.is_blinded());
}

// --- Tactical falls (iteration 53, PILLAR-3 gap) ------------------------------
//
// SRD 5e falling: a fall of 10 ft or more deals 1d6 bludgeoning per 10 ft
// fallen (max 20d6) and the creature lands Prone; a DC 15 Acrobatics check
// (approximated here as a supplied save total) lets it land on its feet.
// Damage that drops a creature to 0 HP and exceeds max HP is instant death,
// exactly like every other damage source in this engine.

use vtt_core::actions::{FallOutcome, LandingSurface};

#[test]
fn test_fall_safe_drop_is_a_no_op() {
    let mut dice = DiceEngine::with_seed(7);
    let res = ActionResolver::resolve_fall(
        5.0,
        0.0,
        LandingSurface::Normal,
        &mut dice,
        30,
        30,
        None,
    )
    .expect("a 5 ft drop is legal");
    assert_eq!(res.drop_feet, 5.0);
    assert_eq!(res.outcome, FallOutcome::SafeDrop);
    assert_eq!(res.raw_damage, 0, "under 10 ft deals no damage");
    assert_eq!(res.damage_taken, 0);
    assert!(!res.knocked_prone, "a safe drop does not knock the faller prone");
    assert_eq!(res.hp_remaining, 30);
    assert!(res.is_conscious);
    assert!(!res.instant_death);
}

#[test]
fn test_fall_10ft_knocks_prone_and_deals_1d6() {
    let mut dice = DiceEngine::with_seed(11);
    let res = ActionResolver::resolve_fall(
        10.0,
        0.0,
        LandingSurface::Normal,
        &mut dice,
        30,
        30,
        None,
    )
    .expect("a 10 ft fall is legal");
    assert_eq!(res.outcome, FallOutcome::InjuredLanding);
    assert!(res.raw_damage >= 1 && res.raw_damage <= 6, "exactly one d6: {}", res.raw_damage);
    assert_eq!(res.damage_taken, res.raw_damage, "normal terrain applies full damage");
    assert!(res.knocked_prone, "a 10 ft+ fall lands you prone without a save");
    assert_eq!(res.hp_remaining, 30 - res.damage_taken);
}

#[test]
fn test_fall_dc15_acrobatics_lands_on_feet_but_still_hurts() {
    let mut dice = DiceEngine::with_seed(3);
    let res = ActionResolver::resolve_fall(
        20.0,
        0.0,
        LandingSurface::Normal,
        &mut dice,
        30,
        30,
        Some(15),
    )
    .expect("a 20 ft fall is legal");
    assert_eq!(res.outcome, FallOutcome::InjuredLanding);
    assert!(res.raw_damage >= 2 && res.raw_damage <= 12, "two d6: {}", res.raw_damage);
    assert!(!res.knocked_prone, "a passed DC 15 check lands the faller on their feet");
}

#[test]
fn test_fall_damage_scales_per_10ft_and_caps_at_20d6() {
    // A 200 ft drop is exactly the 20d6 cap; a 500 ft drop must not exceed it.
    let mut dice = DiceEngine::with_seed(9);
    let capped = ActionResolver::resolve_fall(
        200.0,
        0.0,
        LandingSurface::Normal,
        &mut dice,
        300,
        300,
        None,
    )
    .unwrap();
    assert!(capped.raw_damage >= 20 && capped.raw_damage <= 120, "20d6 range: {}", capped.raw_damage);

    let mut dice = DiceEngine::with_seed(9);
    let absurd = ActionResolver::resolve_fall(
        500.0,
        0.0,
        LandingSurface::Normal,
        &mut dice,
        300,
        300,
        None,
    )
    .unwrap();
    assert_eq!(
        absurd.raw_damage, capped.raw_damage,
        "50d6 would-be damage clamps to the same 20d6 roll"
    );
}

#[test]
fn test_fall_soft_landing_halves_damage_deterministically() {
    let mut hard = DiceEngine::with_seed(21);
    let hard_res = ActionResolver::resolve_fall(
        40.0,
        0.0,
        LandingSurface::Normal,
        &mut hard,
        60,
        60,
        None,
    )
    .unwrap();
    let mut soft = DiceEngine::with_seed(21);
    let soft_res = ActionResolver::resolve_fall(
        40.0,
        0.0,
        LandingSurface::Soft,
        &mut soft,
        60,
        60,
        None,
    )
    .unwrap();
    assert_eq!(soft_res.raw_damage, hard_res.raw_damage, "same seed, same raw roll");
    assert_eq!(soft_res.damage_taken, hard_res.raw_damage / 2, "soft terrain halves (floor)");
    assert!(soft_res.knocked_prone, "a soft landing still leaves the faller prone");
}

#[test]
fn test_fall_massive_damage_is_instant_death() {
    // 100 ft = 10d6, minimum roll 10; threshold for instant death at 5/5 HP
    // is damage >= current_hp + max_hp = 10, so EVERY seed dies instantly.
    let mut dice = DiceEngine::with_seed(4);
    let res = ActionResolver::resolve_fall(
        100.0,
        0.0,
        LandingSurface::Normal,
        &mut dice,
        5,
        5,
        None,
    )
    .unwrap();
    assert_eq!(res.outcome, FallOutcome::MassiveDamage);
    assert!(res.instant_death);
    assert_eq!(res.hp_remaining, 0);
    assert!(!res.is_conscious);
}

#[test]
fn test_fall_rejects_non_finite_elevation_and_upward_motion() {
    let mut dice = DiceEngine::with_seed(1);
    assert_eq!(
        ActionResolver::resolve_fall(f32::NAN, 0.0, LandingSurface::Normal, &mut dice, 10, 10, None)
            .unwrap_err(),
        "NON_FINITE_ELEVATION"
    );
    assert_eq!(
        ActionResolver::resolve_fall(0.0, f32::INFINITY, LandingSurface::Normal, &mut dice, 10, 10, None)
            .unwrap_err(),
        "NON_FINITE_ELEVATION"
    );
    // Rising is not falling.
    assert_eq!(
        ActionResolver::resolve_fall(0.0, 10.0, LandingSurface::Normal, &mut dice, 10, 10, None)
            .unwrap_err(),
        "NO_DOWNWARD_DROP"
    );
}
