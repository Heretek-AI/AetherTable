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
    AbilityModifier, AbilityScoreNode, AbilityType, ArmorCategory, ArmorClassCalculator,
    ModifierPriority, MulticlassSpellSlotMatrix, SpellcastingStats,
};
pub use rules::{AttackRollResult, MonsterArchetype, RulesEvaluator, SavingThrowResult, SpellDefinition};
pub use state::{EntityState, GameSession, InitiativeCombatState};
pub use types::*;
