use crate::types::ArmorType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AbilityType {
    Strength,
    Dexterity,
    Constitution,
    Intelligence,
    Wisdom,
    Charisma,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModifierPriority {
    Base = 0,
    Additive = 1,
    Multiplier = 2,
    HardOverride = 3,
}

/// Source hierarchy from the platform spec (GOALS.md Pillar 3). Modifiers are
/// resolved in strict topological sequence by these layers — a node may only
/// depend on effects from equal-or-earlier ranks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModifierSource {
    BaseScore,
    RacialTrait,
    ClassFeature,
    Feat,
    StaticEquipment,
    DynamicItemOverride,
    TransientBuffDebuff,
    SituationalCondition,
}

impl ModifierSource {
    /// Topological rank — lower ranks are applied first.
    pub fn rank(&self) -> u8 {
        match self {
            ModifierSource::BaseScore => 0,
            ModifierSource::RacialTrait => 1,
            ModifierSource::ClassFeature => 2,
            ModifierSource::Feat => 3,
            ModifierSource::StaticEquipment => 4,
            ModifierSource::DynamicItemOverride => 5,
            ModifierSource::TransientBuffDebuff => 6,
            ModifierSource::SituationalCondition => 7,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbilityModifier {
    pub name: String,
    pub priority: ModifierPriority,
    pub value: i32,
    /// Provenance layer. Serde default keeps legacy serialized characters
    /// (without this field) deserializing; unattributed modifiers resolve in
    /// the additive bucket after all sourced layers.
    #[serde(default)]
    pub source: Option<ModifierSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbilityScoreNode {
    pub ability: AbilityType,
    pub base_score: i32,
    pub modifiers: Vec<AbilityModifier>,
}

/// One step of a resolved score computation (provenance audit trail).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolutionStep {
    pub modifier_name: String,
    pub source: ModifierSource,
    pub priority: ModifierPriority,
    pub value_applied: i32,
    pub score_after: i64,
}

impl AbilityScoreNode {
    pub fn new(ability: AbilityType, base_score: i32) -> Self {
        Self {
            ability,
            base_score,
            modifiers: Vec::new(),
        }
    }

    pub fn add_sourced_modifier(
        &mut self,
        name: &str,
        priority: ModifierPriority,
        value: i32,
        source: Option<ModifierSource>,
    ) {
        self.modifiers.push(AbilityModifier {
            name: name.to_string(),
            priority,
            value,
            source,
        });
    }

    /// Canonical topological order: source-rank layers (Base → Racial →
    /// Class → Feat → Equipment → Item Override → Buff → Condition),
    /// insertion-stable within a layer. Unattributed modifiers sort after
    /// Condition so legacy payloads keep resolving.
    fn ordered_modifiers(&self) -> Vec<&AbilityModifier> {
        let mut ordered: Vec<&AbilityModifier> = self.modifiers.iter().collect();
        ordered.sort_by_key(|m| match m.source {
            Some(src) => src.rank(),
            None => u8::MAX,
        });
        ordered
    }

    pub fn calculate_score(&self) -> i32 {
        self.resolve_with_trace(None)
    }

    /// Applies every modifier in topological sequence. Pass `Some(&mut vec)`
    /// to capture the full provenance trace (audit requirement).
    pub fn resolve_with_trace(&self, mut trace: Option<&mut Vec<ResolutionStep>>) -> i32 {
        let mut score: i64 = self.base_score as i64;

        if let Some(t) = trace.as_deref_mut() {
            t.push(ResolutionStep {
                modifier_name: "<base>".to_string(),
                source: ModifierSource::BaseScore,
                priority: ModifierPriority::Base,
                value_applied: self.base_score,
                score_after: score,
            });
        }

        for m in self.ordered_modifiers() {
            let source = m.source.unwrap_or(ModifierSource::SituationalCondition);
            match m.priority {
                ModifierPriority::Base => { /* informational */ }
                ModifierPriority::Additive => score += m.value as i64,
                ModifierPriority::Multiplier => score *= m.value.max(0) as i64,
                ModifierPriority::HardOverride => score = m.value as i64,
            }
            if let Some(t) = trace.as_deref_mut() {
                t.push(ResolutionStep {
                    modifier_name: m.name.clone(),
                    source,
                    priority: m.priority,
                    value_applied: m.value,
                    score_after: score,
                });
            }
        }

        score.clamp(0, u8::MAX as i64) as i32
    }

    pub fn calculate_modifier(&self) -> i32 {
        calculate_ability_modifier(self.calculate_score())
    }
}

/// Standard floored ability modifier: floor((score - 10) / 2)
#[inline]
pub fn calculate_ability_modifier(score: i32) -> i32 {
    (score - 10).div_euclid(2)
}

/// SRD 5e proficiency bonus progression: 2 + ((level - 1) / 4)
#[inline]
pub fn calculate_proficiency_bonus(level: u32) -> i32 {
    let lvl = level.max(1);
    2 + ((lvl - 1) / 4) as i32
}

/// Standard SRD 5e Armor Class derivation
pub fn calculate_armor_class(
    armor_type: ArmorType,
    base_ac: i32,
    dex_score: i32,
    has_shield: bool,
    unarmored_secondary_score: Option<i32>,
) -> i32 {
    let dex_mod = calculate_ability_modifier(dex_score);
    let shield_bonus = if has_shield { 2 } else { 0 };

    let base = match armor_type {
        ArmorType::Unarmored => 10 + dex_mod,
        ArmorType::BarbarianUnarmored => {
            let con_mod = calculate_ability_modifier(unarmored_secondary_score.unwrap_or(10));
            10 + dex_mod + con_mod
        }
        ArmorType::MonkUnarmored => {
            let wis_mod = calculate_ability_modifier(unarmored_secondary_score.unwrap_or(10));
            10 + dex_mod + wis_mod
        }
        ArmorType::NaturalArmor => base_ac + dex_mod,
        ArmorType::LightArmor => base_ac + dex_mod,
        ArmorType::MediumArmor => base_ac + dex_mod.min(2),
        ArmorType::HeavyArmor => base_ac,
        ArmorType::Shield => 10 + dex_mod,
    };

    base + shield_bonus
}

/// Passive Perception: 10 + WIS mod + (proficient ? prof_bonus : 0) + flat_bonus
#[inline]
pub fn calculate_passive_perception(
    wis_score: i32,
    proficient: bool,
    prof_bonus: i32,
    flat_bonus: i32,
) -> i32 {
    let wis_mod = calculate_ability_modifier(wis_score);
    10 + wis_mod + (if proficient { prof_bonus } else { 0 }) + flat_bonus
}

/// Multiclass Spell Slot Table (Level 1..=20)
pub fn calculate_multiclass_spell_slots(total_caster_level: u32) -> [u8; 9] {
    match total_caster_level {
        0 => [0, 0, 0, 0, 0, 0, 0, 0, 0],
        1 => [2, 0, 0, 0, 0, 0, 0, 0, 0],
        2 => [3, 0, 0, 0, 0, 0, 0, 0, 0],
        3 => [4, 2, 0, 0, 0, 0, 0, 0, 0],
        4 => [4, 3, 0, 0, 0, 0, 0, 0, 0],
        5 => [4, 3, 2, 0, 0, 0, 0, 0, 0],
        6 => [4, 3, 3, 0, 0, 0, 0, 0, 0],
        7 => [4, 3, 3, 1, 0, 0, 0, 0, 0],
        8 => [4, 3, 3, 2, 0, 0, 0, 0, 0],
        9 => [4, 3, 3, 3, 1, 0, 0, 0, 0],
        10 => [4, 3, 3, 3, 2, 0, 0, 0, 0],
        11 => [4, 3, 3, 3, 2, 1, 0, 0, 0],
        12 => [4, 3, 3, 3, 2, 1, 0, 0, 0],
        13 => [4, 3, 3, 3, 2, 1, 1, 0, 0],
        14 => [4, 3, 3, 3, 2, 1, 1, 0, 0],
        15 => [4, 3, 3, 3, 2, 1, 1, 1, 0],
        16 => [4, 3, 3, 3, 2, 1, 1, 1, 0],
        17 => [4, 3, 3, 3, 2, 1, 1, 1, 1],
        18 => [4, 3, 3, 3, 3, 1, 1, 1, 1],
        19 => [4, 3, 3, 3, 3, 2, 1, 1, 1],
        _ => [4, 3, 3, 3, 3, 2, 2, 1, 1],
    }
}

pub type ArmorCategory = ArmorType;

pub struct ArmorClassCalculator;
impl ArmorClassCalculator {
    pub fn calculate(
        armor_type: ArmorType,
        base_ac: i32,
        dex_score: i32,
        has_shield: bool,
        unarmored_secondary_score: Option<i32>,
    ) -> i32 {
        calculate_armor_class(armor_type, base_ac, dex_score, has_shield, unarmored_secondary_score)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ability_score_modifiers_and_overrides() {
        let mut node = AbilityScoreNode::new(AbilityType::Strength, 14);
        assert_eq!(node.calculate_score(), 14);
        assert_eq!(node.calculate_modifier(), 2);

        node.add_sourced_modifier(
            "Belt of Giant Strength",
            ModifierPriority::HardOverride,
            21,
            Some(ModifierSource::DynamicItemOverride),
        );
        assert_eq!(node.calculate_score(), 21);
        assert_eq!(node.calculate_modifier(), 5);
    }

    #[test]
    fn test_topological_source_layering_is_insertion_order_independent() {
        // Same modifiers inserted in OPPOSITE orders must resolve identically.
        let build = |reversed: bool| -> i32 {
            let mut node = AbilityScoreNode::new(AbilityType::Strength, 8);
            let mut entries: Vec<(&str, ModifierPriority, i32, ModifierSource)> = vec![
                ("Toughness", ModifierPriority::Additive, 2, ModifierSource::Feat),
                ("Hill Dwarf", ModifierPriority::Additive, 2, ModifierSource::RacialTrait),
                ("Bull's Strength", ModifierPriority::Additive, 4, ModifierSource::TransientBuffDebuff),
            ];
            if reversed {
                entries.reverse();
            }
            for (name, prio, val, src) in entries {
                node.add_sourced_modifier(name, prio, val, Some(src));
            }
            node.calculate_score()
        };
        assert_eq!(build(false), build(true), "layer order must not depend on insertion order");
        assert_eq!(build(false), 16); // 8 + racial 2 + feat 2 + buff 4
    }

    #[test]
    fn test_hard_override_wins_regardless_of_layer() {
        let mut node = AbilityScoreNode::new(AbilityType::Strength, 10);
        node.add_sourced_modifier("Curse of Weakness", ModifierPriority::HardOverride, 6, Some(ModifierSource::SituationalCondition));
        node.add_sourced_modifier("Gauntlets +2", ModifierPriority::Additive, 2, Some(ModifierSource::StaticEquipment));
        // Equipment applies first (+12), then the condition override replaces it.
        assert_eq!(node.calculate_score(), 6);

        let mut trace = Vec::new();
        node.resolve_with_trace(Some(&mut trace));
        assert_eq!(trace.len(), 3);
        assert_eq!(trace[0].source, ModifierSource::BaseScore);
        assert_eq!(trace[1].source, ModifierSource::StaticEquipment);
        assert_eq!(trace[2].source, ModifierSource::SituationalCondition);
    }

    #[test]
    fn test_unarmored_defense_and_armor_caps() {
        // Barbarian Unarmored: 10 + DEX(+2) + CON(+3) = 15
        assert_eq!(
            calculate_armor_class(ArmorType::BarbarianUnarmored, 10, 14, false, Some(16)),
            15
        );

        // Medium Armor (Breastplate AC 14) with DEX 18 (+4 mod capped at +2) = 16
        assert_eq!(
            calculate_armor_class(ArmorType::MediumArmor, 14, 18, false, None),
            16
        );

        // Heavy Armor (Plate AC 18) with Shield (+2) = 20
        assert_eq!(
            calculate_armor_class(ArmorType::HeavyArmor, 18, 10, true, None),
            20
        );
    }

    #[test]
    fn test_spell_stats_and_multiclass_slots() {
        let slots_lvl5 = calculate_multiclass_spell_slots(5);
        assert_eq!(slots_lvl5[0], 4); // 4 1st-level
        assert_eq!(slots_lvl5[1], 3); // 3 2nd-level
        assert_eq!(slots_lvl5[2], 2); // 2 3rd-level
    }
}
