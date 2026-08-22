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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbilityModifier {
    pub name: String,
    pub priority: ModifierPriority,
    pub value: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbilityScoreNode {
    pub ability: AbilityType,
    pub base_score: i32,
    pub modifiers: Vec<AbilityModifier>,
}

impl AbilityScoreNode {
    pub fn new(ability: AbilityType, base_score: i32) -> Self {
        Self {
            ability,
            base_score,
            modifiers: Vec::new(),
        }
    }

    pub fn add_modifier(&mut self, name: &str, priority: ModifierPriority, value: i32) {
        self.modifiers.push(AbilityModifier {
            name: name.to_string(),
            priority,
            value,
        });
    }

    pub fn calculate_score(&self) -> i32 {
        let mut score = self.base_score;

        // 1. Additive
        for m in self.modifiers.iter().filter(|m| m.priority == ModifierPriority::Additive) {
            score += m.value;
        }

        // 2. Multiplier
        for m in self.modifiers.iter().filter(|m| m.priority == ModifierPriority::Multiplier) {
            score *= m.value;
        }

        // 3. HardOverride
        if let Some(m) = self.modifiers.iter().filter(|m| m.priority == ModifierPriority::HardOverride).last() {
            score = m.value;
        }

        score
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

pub struct MulticlassSpellSlotMatrix;
impl MulticlassSpellSlotMatrix {
    pub fn slots_for_level(level: u32) -> [u8; 9] {
        calculate_multiclass_spell_slots(level)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpellcastingStats {
    pub spell_save_dc: i32,
    pub spell_attack_bonus: i32,
}

impl SpellcastingStats {
    pub fn calculate(ability_score: i32, prof_bonus: i32) -> Self {
        let mod_val = calculate_ability_modifier(ability_score);
        Self {
            spell_save_dc: 8 + prof_bonus + mod_val,
            spell_attack_bonus: prof_bonus + mod_val,
        }
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

        node.add_modifier("Belt of Giant Strength", ModifierPriority::HardOverride, 21);
        assert_eq!(node.calculate_score(), 21);
        assert_eq!(node.calculate_modifier(), 5);
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
