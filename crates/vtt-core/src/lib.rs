//! # vtt-core: Authoritative Headless D&D 5e Rules & State Machine Engine
//!
//! Provides deterministic, zero-allocation calculations for:
//! - D&D 5e SRD 5.1 rules, ability modifiers, and proficiency bonuses
//! - 7 distinct Armor Class derivation formulas (unarmored, monk, barbarian, light, medium, heavy, shield)
//! - 15 deterministic condition states and auto-critical hit evaluation
//! - Action budget economy (Action, Bonus Action, Reaction, Movement)
//! - 4-tier task resolution (Critical Success, Success, Success at a Cost, Critical Failure)
//! - Death Saving Throw state machine and massive damage instant death checks
//! - Nested inventory encumbrance and item hierarchies
//! - Event sourcing state ledger with complete rewind capabilities

pub mod actions;
pub mod dice;
pub mod event_log;
pub mod inventory;
pub mod modifier_graph;
pub mod rules;
pub mod state;
pub mod types;

pub use actions::ActionResolver;
pub use dice::{DiceEngine, DiceRollResult};
pub use event_log::{EventSourcingLedger, GameEvent};
pub use inventory::{EncumbranceStatus, InventoryManager, Item};
pub use modifier_graph::{
    calculate_ability_modifier, calculate_armor_class, calculate_passive_perception,
    calculate_proficiency_bonus, AbilityModifier, AbilityScoreNode, AbilityType, ArmorCategory,
    ArmorClassCalculator, ModifierPriority, MulticlassSpellSlotMatrix, SpellcastingStats,
};
pub use rules::{
    AttackRollResult, ConcentrationBreakResult, MonsterArchetype, RulesEvaluator,
    SavingThrowResult, SpellDefinition,
};
pub use state::{ConcentrationState, EntityState, GameSession, InitiativeCombatState};
pub use types::*;
