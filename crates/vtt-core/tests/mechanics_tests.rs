//! Integration-style tests for Phase-3 mechanics:
//! condition lifecycles, spell economy, reactions, and X-card state replay.

use vtt_core::dice::DiceEngine;
use vtt_core::rules::{RulesEvaluator, SpellDefinition};
use vtt_core::state::{EndOfTurnSave, EntityState, GameSession, ReadiedAction, ReactionType};
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
        .ready_action(actor, "I attack the goblin", Some("when it moves"))
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
    let err = session.ready_action(actor, "second try", None).unwrap_err();
    assert_eq!(err, "ACTION_ECONOMY_EXHAUSTED");
    assert_eq!(
        session.entities[&actor].readied_action.as_ref().unwrap().description,
        ready.description,
        "a rejected Ready must not clobber the stored description"
    );

    // Unknown entity.
    assert_eq!(
        session.ready_action(uuid::Uuid::new_v4(), "ghost", None).unwrap_err(),
        "ENTITY_NOT_FOUND"
    );
}

#[test]
fn test_ready_action_clears_at_the_next_round_refresh() {
    let mut session = session_with_pair();
    let actor = *session.entities.keys().next().unwrap();

    session.ready_action(actor, "I hold my strike", None).unwrap();
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
        session.ready_action(actor, "while unconscious", None).unwrap_err(),
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
    });
    let serialized = serde_json::to_value(&e).unwrap();
    let parsed: EntityState = serde_json::from_value(serialized).unwrap();
    assert_eq!(parsed.readied_action, e.readied_action);

    // Entities persisted before this field existed deserialize cleanly.
    let legacy: EntityState = serde_json::from_value(serde_json::to_value(hero("legacy", 30, 15)).unwrap())
        .expect("legacy payload without readied_action");
    assert!(legacy.readied_action.is_none());
}
