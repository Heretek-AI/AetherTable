//! Public-API regression guard for the Loop-3 iteration-27 dead-code purge.
//!
//! Dead-code removal must never silently drop a wire-format-relevant export.
//! This test pins the engine's re-export surface (`vtt_core/src/lib.rs` `pub
//! use` lists) as a sentinel SET. If a future purge removes any pinned export,
//! the test fails until that name is moved into `MUST_BE_ABSENT` — forcing a
//! human to sign off that the removal was deliberate.
//!
//! It also asserts the exact names iteration 27 deleted are now ABSENT,
//! proving the purge is clean and the removed surface does not regrow.

use std::fs;

/// Exports that MUST still appear in `lib.rs` (the wire-format surface).
const MUST_KEEP: &[&str] = &[
    "ActionResolver",
    "DiceEngine",
    "DiceRollResult",
    "EventSourcingLedger",
    "GameEvent",
    "CapacityViolation",
    "ContainerOverfillError",
    "InventoryManager",
    "Item",
    "calculate_ability_modifier",
    "calculate_armor_class",
    "calculate_passive_perception",
    "calculate_proficiency_bonus",
    "AbilityModifier",
    "AbilityScoreNode",
    "AbilityType",
    "ArmorCategory",
    "ArmorClassCalculator",
    "ModifierPriority",
    "AttackRollResult",
    "CheckOutcomeTier",
    "ConcentrationBreakResult",
    "CostSuggestion",
    "MonsterArchetype",
    "RulesEvaluator",
    "SavingThrowResult",
    "SpellDefinition",
    "ArmedReaction",
    "AttackAction",
    "ConditionTimer",
    "ConcentrationState",
    "EndOfTurnSave",
    "EntityState",
    "GameSession",
    "InitiativeCombatState",
    "InitiativeEntry",
    "MoveOutcome",
    "OpportunityAttackTrigger",
    "PendingOpportunityAttack",
    "ReadiedAction",
    "ReadiedTrigger",
    "ReactionType",
    "RewindReport",
    "RoundAdvanceReport",
    "SessionMap",
];

/// Re-exports removed by the purge: these MUST NOT appear in `lib.rs`.
const MUST_BE_ABSENT: &[&str] = &[
    "EncumbranceStatus",         // removed: only consumer `check_encumbrance` deleted
    "MulticlassSpellSlotMatrix", // removed: only consumer `slots_for_level` deleted
    "SpellcastingStats",         // removed: only consumer `SpellcastingStats::calculate` deleted
];

/// Collect every identifier-shaped token in the file (alphanumerics + '_').
/// Short identifier tokenization is fine for a sentinel snapshot: an export
/// name like `GameSession` appears nowhere else in `lib.rs`.
fn identifiers(src: &str) -> Vec<String> {
    src.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

#[test]
fn pinned_reexports_are_all_still_present() {
    let tokens = identifiers(&lib_rs());
    let missing: Vec<&str> = MUST_KEEP
        .iter()
        .copied()
        .filter(|name| !tokens.iter().any(|t| t == name))
        .collect();
    assert!(
        missing.is_empty(),
        "public API regression: these exports are MISSING from lib.rs: {missing:?}.\n\
         If removed deliberately, move each into MUST_BE_ABSENT above."
    );
}

#[test]
fn purge_removed_exports_stay_absent() {
    let tokens = identifiers(&lib_rs());
    let leaked: Vec<&str> = MUST_BE_ABSENT
        .iter()
        .copied()
        .filter(|name| tokens.iter().any(|t| t == name))
        .collect();
    assert!(
        leaked.is_empty(),
        "purge should have removed these re-exports but they are still present: {leaked:?}"
    );
}

#[allow(dead_code)]
/// Compile-time sentinel: forces the referenced types to still resolve to real
/// items. If a pinned export pointed at a purged symbol, this fails to build.
fn _compile_time_sentinels() {
    #[allow(unused_imports)]
    use vtt_core::{
        ActionResolver, DiceEngine, DiceRollResult, EventSourcingLedger, GameEvent,
        CapacityViolation, ContainerOverfillError, InventoryManager, Item,
        calculate_ability_modifier, AbilityScoreNode, ArmorClassCalculator, ModifierPriority,
        RulesEvaluator, SpellDefinition, EntityState, GameSession, InitiativeEntry, MoveOutcome,
        ReadiedTrigger, SessionMap,
    };
}

fn lib_rs() -> String {
    fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("vtt-core src/lib.rs readable")
}