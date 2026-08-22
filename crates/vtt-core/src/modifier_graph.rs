use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
        // Sort modifiers by priority: Base -> Additive -> Multiplier -> HardOverride
        let mut score = self.base_score;

        // 1. Additive
        for m in self.modifiers.iter().filter(|m| m.priority == ModifierPriority::Additive) {
            score += m.value;
        }

        // 2. Hard Overrides (e.g. Gauntlets of Ogre Power = 19)
        let mut highest_override: Option<i32> = None;
        for m in self.modifiers.iter().filter(|m| m.priority == ModifierPriority::HardOverride) {
            highest_override = Some(highest_override.map_or(m.value, |curr| curr.max(m.value)));
        }

        if let Some(override_val) = highest_override {
            if override_val > score {
                score = override_val;
            }
        }

        score
    }

    pub fn calculate_modifier(&self) -> i32 {
        let score = self.calculate_score();
        (score - 10).div_euclid(2)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArmorCategory {
    Unarmored,
    BarbarianUnarmored,
    MonkUnarmored,
    DraconicResilience,
    LightArmor,
    MediumArmor,
    HeavyArmor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArmorClassCalculator;

impl ArmorClassCalculator {
    pub fn compute_ac(
        category: ArmorCategory,
        armor_base_ac: i32,
        dex_mod: i32,
        con_mod: i32,
        wis_mod: i32,
        has_shield: bool,
        bonus_ac: i32,
    ) -> i32 {
        let shield_bonus = if has_shield { 2 } else { 0 };

        let base_ac = match category {
            ArmorCategory::Unarmored => 10 + dex_mod,
            ArmorCategory::BarbarianUnarmored => 10 + dex_mod + con_mod,
            ArmorCategory::MonkUnarmored => 10 + dex_mod + wis_mod,
            ArmorCategory::DraconicResilience => 13 + dex_mod,
            ArmorCategory::LightArmor => armor_base_ac + dex_mod,
            ArmorCategory::MediumArmor => armor_base_ac + dex_mod.min(2),
            ArmorCategory::HeavyArmor => armor_base_ac,
        };

        base_ac + shield_bonus + bonus_ac
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpellcastingStats;

impl SpellcastingStats {
    pub fn compute_spell_save_dc(proficiency_bonus: i32, casting_mod: i32, magic_bonus: i32) -> i32 {
        8 + proficiency_bonus + casting_mod + magic_bonus
    }

    pub fn compute_spell_attack_bonus(proficiency_bonus: i32, casting_mod: i32, magic_bonus: i32) -> i32 {
        proficiency_bonus + casting_mod + magic_bonus
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MulticlassSpellSlotMatrix;

impl MulticlassSpellSlotMatrix {
    pub fn calculate_slots(effective_caster_level: u32) -> [u32; 9] {
        // [1st, 2nd, 3rd, 4th, 5th, 6th, 7th, 8th, 9th]
        match effective_caster_level {
            0 => [0; 9],
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
            11..=12 => [4, 3, 3, 3, 2, 1, 0, 0, 0],
            13..=14 => [4, 3, 3, 3, 2, 1, 1, 0, 0],
            15..=16 => [4, 3, 3, 3, 2, 1, 1, 1, 0],
            17 => [4, 3, 3, 3, 2, 1, 1, 1, 1],
            18 => [4, 3, 3, 3, 3, 1, 1, 1, 1],
            19 => [4, 3, 3, 3, 3, 2, 1, 1, 1],
            _ => [4, 3, 3, 3, 3, 2, 2, 1, 1],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ability_score_modifiers_and_overrides() {
        let mut str_node = AbilityScoreNode::new(AbilityType::Strength, 14);
        assert_eq!(str_node.calculate_score(), 14);
        assert_eq!(str_node.calculate_modifier(), 2);

        // Add Racial Bonus (+2)
        str_node.add_modifier("Dwarf Strength", ModifierPriority::Additive, 2);
        assert_eq!(str_node.calculate_score(), 16);
        assert_eq!(str_node.calculate_modifier(), 3);

        // Equip Gauntlets of Ogre Power (Hard Override = 19)
        str_node.add_modifier("Gauntlets of Ogre Power", ModifierPriority::HardOverride, 19);
        assert_eq!(str_node.calculate_score(), 19);
        assert_eq!(str_node.calculate_modifier(), 4);
    }

    #[test]
    fn test_unarmored_defense_and_armor_caps() {
        // Barbarian: 10 + DEX(+2) + CON(+3) + Shield(+2) = 17 AC
        let ac_barb = ArmorClassCalculator::compute_ac(
            ArmorCategory::BarbarianUnarmored,
            10,
            2,
            3,
            0,
            true,
            0,
        );
        assert_eq!(ac_barb, 17);

        // Medium Armor (Breastplate 14) + DEX(+4 capped at +2) = 16 AC
        let ac_medium = ArmorClassCalculator::compute_ac(
            ArmorCategory::MediumArmor,
            14,
            4,
            0,
            0,
            false,
            0,
        );
        assert_eq!(ac_medium, 16);
    }

    #[test]
    fn test_spell_stats_and_multiclass_slots() {
        // Level 5 Wizard: Prof +3, INT +4 -> Save DC = 8 + 3 + 4 = 15, Attack = +7
        let dc = SpellcastingStats::compute_spell_save_dc(3, 4, 0);
        let atk = SpellcastingStats::compute_spell_attack_bonus(3, 4, 0);
        assert_eq!(dc, 15);
        assert_eq!(atk, 7);

        // Level 5 Caster Slots: [4, 3, 2, 0, 0, 0, 0, 0, 0]
        let slots = MulticlassSpellSlotMatrix::calculate_slots(5);
        assert_eq!(slots[0], 4);
        assert_eq!(slots[1], 3);
        assert_eq!(slots[2], 2);
        assert_eq!(slots[3], 0);
    }
}
