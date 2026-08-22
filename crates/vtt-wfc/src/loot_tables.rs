use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DungeonRoomDressing {
    pub room_id: usize,
    pub feature_name: String,
    pub description: String,
    pub searchable_loot: Option<String>,
    pub environmental_hazard: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LootItem {
    pub name: String,
    pub item_type: String,
    pub value_gp: u32,
    pub rarity: String,
}

pub struct LootTableGenerator;

impl LootTableGenerator {
    pub fn roll_thematic_loot(cr_tier: u8, seed: u64) -> Vec<LootItem> {
        let mut items = Vec::new();
        let roll = ((seed % 100) + 1) as u32;

        match cr_tier {
            0..=4 => {
                // Tier 1 Loot (Dungeoneer Table Port)
                items.push(LootItem {
                    name: format!("Pouch of {} Gold Pieces", (roll % 50) + 10),
                    item_type: "Coinage".to_string(),
                    value_gp: (roll % 50) + 10,
                    rarity: "Common".to_string(),
                });
                if roll > 60 {
                    items.push(LootItem {
                        name: "Potion of Healing".to_string(),
                        item_type: "Potion".to_string(),
                        value_gp: 50,
                        rarity: "Common".to_string(),
                    });
                }
                if roll > 85 {
                    items.push(LootItem {
                        name: "Spell Scroll of Magic Missile (Level 1)".to_string(),
                        item_type: "Scroll".to_string(),
                        value_gp: 75,
                        rarity: "Uncommon".to_string(),
                    });
                }
            }
            _ => {
                // Tier 2+ Loot
                items.push(LootItem {
                    name: format!("Jeweled Chest of {} Platinum Pieces", (roll % 40) + 20),
                    item_type: "Treasure".to_string(),
                    value_gp: ((roll % 40) + 20) * 10,
                    rarity: "Rare".to_string(),
                });
                items.push(LootItem {
                    name: "Ring of Spell Storing".to_string(),
                    item_type: "Magic Item".to_string(),
                    value_gp: 4000,
                    rarity: "Rare".to_string(),
                });
            }
        }
        items
    }

    pub fn generate_room_dressing(room_id: usize, theme: &str, seed: u64) -> DungeonRoomDressing {
        let dressings = match theme {
            "Baron's Crypt" => vec![
                ("Ancient Sarcophagus", "A heavy stone sarcophagus carved with the likeness of a forgotten knight. The stone lid is slightly ajar.", Some("Signet Ring of House Vane (50 gp)"), None),
                ("Desecrated Altar", "An obsidian altar stained with ancient wax and soot. Cold air radiates from its hollow basin.", None, Some("Necrotic Frost (DC 13 CON save or 1d6 cold damage)")),
                ("Shattered Reliquary", "Glass shards and splintered gold-leaf wood litter the floor.", Some("Intact Vial of Holy Water"), None),
            ],
            _ => vec![
                ("Iron Maiden Casket", "Rusted torture apparatus embedded into the stone alcove.", None, Some("Rusted Spring Trap")),
                ("Rotting Supply Crate", "A moldering wooden crate bearing the insignia of the castle garrison.", Some("12 Iron Crossbow Bolts, 15 GP"), None),
                ("Fungal Bloom Patch", "Luminescent violet spores growing in thick carpets across the damp stones.", None, Some("Choking Spores (DC 12 CON save or Blinded 1 turn)")),
            ],
        };

        let idx = ((seed as usize) + room_id) % dressings.len();
        let (feat, desc, loot, haz) = dressings[idx];

        DungeonRoomDressing {
            room_id,
            feature_name: feat.to_string(),
            description: desc.to_string(),
            searchable_loot: loot.map(|s| s.to_string()),
            environmental_hazard: haz.map(|s| s.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loot_generation() {
        let loot = LootTableGenerator::roll_thematic_loot(1, 1337);
        assert!(!loot.is_empty());
        assert!(loot[0].value_gp > 0);
    }

    #[test]
    fn test_room_dressing_generation() {
        let dressing = LootTableGenerator::generate_room_dressing(1, "Baron's Crypt", 42);
        assert!(!dressing.feature_name.is_empty());
        assert!(!dressing.description.is_empty());
    }
}
