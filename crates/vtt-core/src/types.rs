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
    #[inline]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArmorType {
    Unarmored,
    BarbarianUnarmored,
    MonkUnarmored,
    NaturalArmor,
    LightArmor,
    MediumArmor,
    HeavyArmor,
    Shield,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

impl Condition {
    pub fn is_incapacitated(&self) -> bool {
        matches!(
            self,
            Condition::Incapacitated
                | Condition::Paralyzed
                | Condition::Petrified
                | Condition::Stunned
                | Condition::Unconscious
        )
    }

    pub fn grants_advantage_to_attacker(&self, distance_feet: f32) -> bool {
        match self {
            Condition::Blinded
            | Condition::Paralyzed
            | Condition::Petrified
            | Condition::Restrained
            | Condition::Stunned
            | Condition::Unconscious => true,
            Condition::Prone => distance_feet <= 5.0,
            _ => false,
        }
    }

    pub fn inflicts_disadvantage_on_attacker(&self, distance_feet: f32) -> bool {
        match self {
            Condition::Invisible => true,
            Condition::Prone => distance_feet > 5.0,
            _ => false,
        }
    }

    /// SRD Invisible: "the creature's attacks have advantage." The attacker-side
    /// half of the Invisible entry, distinct from
    /// [`Self::inflicts_disadvantage_on_attacker`] (the target-side half).
    pub fn grants_advantage_on_own_attacks(&self) -> bool {
        matches!(self, Condition::Invisible)
    }

    pub fn inflicts_disadvantage_on_attacks(&self) -> bool {
        match self {
            Condition::Blinded
            | Condition::Frightened
            | Condition::Poisoned
            | Condition::Prone
            | Condition::Restrained => true,
            Condition::Exhaustion(level) => *level >= 3,
            _ => false,
        }
    }

    pub fn fails_str_dex_saves(&self) -> bool {
        matches!(
            self,
            Condition::Paralyzed
                | Condition::Petrified
                | Condition::Stunned
                | Condition::Unconscious
        )
    }

    /// SRD Restrained: "Disadvantage on Dexterity saving throws." Distinct
    /// from [`Self::fails_str_dex_saves`] (an auto-fail, not a roll penalty)
    /// and from [`Self::inflicts_disadvantage_on_attacks`] — the save clause is
    /// its own line of the Restrained entry, so it gets its own helper.
    pub fn inflicts_disadvantage_on_dex_saves(&self) -> bool {
        matches!(self, Condition::Restrained)
    }

    pub fn grants_auto_crit_within_5ft(&self, distance_feet: f32) -> bool {
        matches!(self, Condition::Paralyzed | Condition::Unconscious) && distance_feet <= 5.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DeathSaveState {
    pub successes: u8,
    pub failures: u8,
    pub is_stabilized: bool,
    pub is_dead: bool,
}

impl DeathSaveState {
    pub fn reset(&mut self) {
        self.successes = 0;
        self.failures = 0;
        self.is_stabilized = false;
        self.is_dead = false;
    }
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

// ------------------------------------------------------------------- senses

/// SRD vision/sense modes (PHB ch. 9 "Vision and Light"). Consumed by the
/// spatial crate's lighting-aware line-of-sight evaluation
/// (`vtt_spatial::lighting`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisionMode {
    /// Ordinary sight: needs light; darkness is heavily obscured.
    Normal,
    /// Sees in non-magical darkness within its range as if dim light.
    Darkvision,
    /// Special sense that does not rely on sight: perceives within range even
    /// in darkness AND magical darkness (and while blinded).
    Blindsight,
    /// Sees in normal and magical darkness within range, and pierces illusions.
    Truesight,
}

impl VisionMode {
    /// Typical SRD range for this sense in feet, where one applies. Normal
    /// sight is unlimited (no modeled horizon), hence None.
    pub fn typical_range_feet(self) -> Option<f32> {
        match self {
            VisionMode::Normal => None,
            // PHB examples: darkvision 60 ft is standard, 120 ft for drow et al.
            VisionMode::Darkvision => Some(60.0),
            // Blindsight spans roughly 10-30 ft for most stat blocks.
            VisionMode::Blindsight => Some(30.0),
            VisionMode::Truesight => Some(60.0),
        }
    }
}

/// Per-cell ambient lighting on a battle map (PHB "Lighting" table: bright
/// light, dim light, darkness; plus magically conjured darkness).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LightingZone {
    Bright,
    Dim,
    Darkness,
    /// Magically conjured darkness (e.g. Darkness spell): impenetrable to
    /// darkvision — only truesight and blindsight see through it.
    MagicalDarkness,
}

/// One lit cell on a [`SessionMap`], mirroring how `difficult_terrain` cells
/// are declared. Cells absent from the map are Bright by convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LightingZoneCell {
    pub x: usize,
    pub y: usize,
    pub zone: LightingZone,
}

// ------------------------------------------------------------------ senses

#[cfg(test)]
mod senses_tests {
    use super::*;

    #[test]
    fn test_vision_mode_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&VisionMode::Normal).unwrap(),
            "\"normal\""
        );
        assert_eq!(
            serde_json::to_string(&VisionMode::Darkvision).unwrap(),
            "\"darkvision\""
        );
        assert_eq!(
            serde_json::to_string(&VisionMode::Blindsight).unwrap(),
            "\"blindsight\""
        );
        assert_eq!(
            serde_json::to_string(&VisionMode::Truesight).unwrap(),
            "\"truesight\""
        );

        let mode: VisionMode = serde_json::from_str("\"truesight\"").unwrap();
        assert_eq!(mode, VisionMode::Truesight);
        // Unknown modes are refused, never silently downgraded.
        assert!(serde_json::from_str::<VisionMode>("\"echolocation\"").is_err());
    }

    #[test]
    fn test_lighting_zone_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&LightingZone::Bright).unwrap(),
            "\"bright\""
        );
        assert_eq!(
            serde_json::to_string(&LightingZone::Dim).unwrap(),
            "\"dim\""
        );
        assert_eq!(
            serde_json::to_string(&LightingZone::Darkness).unwrap(),
            "\"darkness\""
        );
        assert_eq!(
            serde_json::to_string(&LightingZone::MagicalDarkness).unwrap(),
            "\"magical_darkness\""
        );

        let zone: LightingZone = serde_json::from_str("\"magical_darkness\"").unwrap();
        assert_eq!(zone, LightingZone::MagicalDarkness);
    }

    #[test]
    fn test_vision_mode_typical_ranges() {
        // Normal sight has no modeled range limit.
        assert_eq!(VisionMode::Normal.typical_range_feet(), None);
        // Common SRD values: darkvision 60 ft (120 for some races), blindsight
        // 10-30 ft, truesight 60+ ft.
        assert_eq!(VisionMode::Darkvision.typical_range_feet(), Some(60.0));
        assert_eq!(VisionMode::Blindsight.typical_range_feet(), Some(30.0));
        assert_eq!(VisionMode::Truesight.typical_range_feet(), Some(60.0));
    }
}
