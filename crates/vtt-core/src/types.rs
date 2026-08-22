use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Ability {
    Strength,
    Dexterity,
    Constitution,
    Intelligence,
    Wisdom,
    Charisma,
}

impl Ability {
    pub fn modifier(score: i32) -> i32 {
        (score - 10).div_euclid(2)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AbilityScores {
    pub strength: i32,
    pub dexterity: i32,
    pub constitution: i32,
    pub intelligence: i32,
    pub wisdom: i32,
    pub charisma: i32,
}

impl Default for AbilityScores {
    fn default() -> Self {
        Self {
            strength: 10,
            dexterity: 10,
            constitution: 10,
            intelligence: 10,
            wisdom: 10,
            charisma: 10,
        }
    }
}

impl AbilityScores {
    pub fn get(&self, ability: Ability) -> i32 {
        match ability {
            Ability::Strength => self.strength,
            Ability::Dexterity => self.dexterity,
            Ability::Constitution => self.constitution,
            Ability::Intelligence => self.intelligence,
            Ability::Wisdom => self.wisdom,
            Ability::Charisma => self.charisma,
        }
    }

    pub fn modifier(&self, ability: Ability) -> i32 {
        Ability::modifier(self.get(ability))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    Blinded,
    Charmed,
    Deafened,
    Frightened,
    Grappled,
    Incapacitated,
    Invisible,
    Paralyzed,
    Petrified,
    Poisoned,
    Prone,
    Restrained,
    Stunned,
    Unconscious,
    Exhaustion(u8),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionBudget {
    pub action: bool,
    pub bonus_action: bool,
    pub reaction: bool,
    pub movement_remaining_feet: f32,
    pub free_object_interaction: bool,
}

impl Default for ActionBudget {
    fn default() -> Self {
        Self {
            action: true,
            bonus_action: true,
            reaction: true,
            movement_remaining_feet: 30.0,
            free_object_interaction: true,
        }
    }
}

impl ActionBudget {
    pub fn reset(&mut self, speed: f32) {
        self.action = true;
        self.bonus_action = true;
        self.reaction = true;
        self.movement_remaining_feet = speed;
        self.free_object_interaction = true;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DamageType {
    Slashing,
    Piercing,
    Bludgeoning,
    Fire,
    Cold,
    Lightning,
    Thunder,
    Poison,
    Acid,
    Psychic,
    Radiant,
    Necrotic,
    Force,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DamageInstance {
    pub amount: i32,
    pub damage_type: DamageType,
    pub is_magical: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskOutcome {
    CriticalSuccess,
    Success,
    SuccessAtACost,
    CriticalFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Complication {
    pub description: String,
    pub resource_deductions: HashMap<String, i32>,
    pub inflicted_conditions: Vec<Condition>,
    pub tactical_penalty: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskResolutionResult {
    pub roll: i32,
    pub modifier: i32,
    pub total: i32,
    pub dc: i32,
    pub outcome: TaskOutcome,
    pub complication: Option<Complication>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IngressType {
    Teleportation,
    PortalDoor,
    StealthReveal,
    Burrowing,
    SpawnEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IngressEvent {
    pub entity_id: Uuid,
    pub ingress_type: IngressType,
    pub source_point: (f32, f32, f32),
    pub target_point: (f32, f32, f32),
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EgressEvent {
    pub entity_id: Uuid,
    pub reason: String, // "DEAD", "DESPAWN", "PLANAR_SHIFT"
    pub position: (f32, f32, f32),
}
