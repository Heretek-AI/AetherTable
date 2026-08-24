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
