use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: Uuid,
    pub compendium_id: String,
    pub name: String,
    pub base_weight_lbs: f32,
    pub quantity: u32,
    pub is_container: bool,
    pub container_capacity_lbs: Option<f32>,
    pub parent_container_id: Option<Uuid>,
    pub is_equipped: bool,
    pub is_attuned: bool,
    pub is_cursed: bool,
    pub is_curse_revealed: bool,
    pub true_state: serde_json::Value,
    pub perceived_state: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct InventoryManager {
    pub items: HashMap<Uuid, Item>,
}

impl InventoryManager {
    pub fn new() -> Self {
        Self {
            items: HashMap::new(),
        }
    }

    pub fn add_item(&mut self, item: Item) {
        self.items.insert(item.id, item);
    }

    pub fn remove_item(&mut self, item_id: &Uuid) -> Option<Item> {
        self.items.remove(item_id)
    }

    pub fn get_item_effective_weight(&self, item_id: &Uuid) -> f32 {
        if let Some(item) = self.items.get(item_id) {
            let mut total = item.base_weight_lbs * item.quantity as f32;
            if item.is_container {
                for other in self.items.values() {
                    if other.parent_container_id == Some(*item_id) {
                        total += self.get_item_effective_weight(&other.id);
                    }
                }
            }
            total
        } else {
            0.0
        }
    }

    pub fn total_inventory_weight(&self) -> f32 {
        let mut total = 0.0;
        for item in self.items.values() {
            if item.parent_container_id.is_none() {
                total += self.get_item_effective_weight(&item.id);
            }
        }
        total
    }

    pub fn check_encumbrance(&self, str_score: i32) -> EncumbranceStatus {
        let total_weight = self.total_inventory_weight();
        let max_carry = (str_score * 15) as f32;
        let heavy_enc = (str_score * 10) as f32;
        let enc = (str_score * 5) as f32;

        if total_weight > max_carry {
            EncumbranceStatus::OverEncumbered { current: total_weight, max: max_carry }
        } else if total_weight > heavy_enc {
            EncumbranceStatus::HeavilyEncumbered { current: total_weight, speed_penalty: 20 }
        } else if total_weight > enc {
            EncumbranceStatus::Encumbered { current: total_weight, speed_penalty: 10 }
        } else {
            EncumbranceStatus::Unencumbered { current: total_weight }
        }
    }

    pub fn reveal_curse(&mut self, item_id: &Uuid, check_total: i32, dc: i32) -> bool {
        if let Some(item) = self.items.get_mut(item_id) {
            if item.is_cursed && check_total >= dc {
                item.is_curse_revealed = true;
                return true;
            }
        }
        false
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EncumbranceStatus {
    Unencumbered { current: f32 },
    Encumbered { current: f32, speed_penalty: u32 },
    HeavilyEncumbered { current: f32, speed_penalty: u32 },
    OverEncumbered { current: f32, max: f32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nested_inventory_weight() {
        let mut inv = InventoryManager::new();
        let bag_id = Uuid::new_v4();
        let gem_id = Uuid::new_v4();

        inv.add_item(Item {
            id: bag_id,
            compendium_id: "item_backpack".to_string(),
            name: "Backpack".to_string(),
            base_weight_lbs: 5.0,
            quantity: 1,
            is_container: true,
            container_capacity_lbs: Some(30.0),
            parent_container_id: None,
            is_equipped: true,
            is_attuned: false,
            is_cursed: false,
            is_curse_revealed: false,
            true_state: serde_json::json!({}),
            perceived_state: serde_json::json!({}),
        });

        inv.add_item(Item {
            id: gem_id,
            compendium_id: "item_ruby".to_string(),
            name: "Heavy Ruby".to_string(),
            base_weight_lbs: 2.5,
            quantity: 4,
            is_container: false,
            container_capacity_lbs: None,
            parent_container_id: Some(bag_id),
            is_equipped: false,
            is_attuned: false,
            is_cursed: false,
            is_curse_revealed: false,
            true_state: serde_json::json!({}),
            perceived_state: serde_json::json!({}),
        });

        assert_eq!(inv.get_item_effective_weight(&gem_id), 10.0);
        assert_eq!(inv.get_item_effective_weight(&bag_id), 15.0);
        assert_eq!(inv.total_inventory_weight(), 15.0);
    }
}
