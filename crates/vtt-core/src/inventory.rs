use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: Uuid,
    pub compendium_id: String,
    pub name: String,
    pub base_weight_lbs: f32,
    /// Bulk of ONE unit in cubic feet. Serde default keeps pre-volume
    /// persisted snapshots deserializing (durability bridge compatibility).
    #[serde(default)]
    pub volume_cu_ft: f32,
    pub quantity: u32,
    pub is_container: bool,
    pub container_capacity_lbs: Option<f32>,
    /// Interior volume of a container in cubic feet. `None` = unlimited.
    #[serde(default)]
    pub container_volume_cu_ft: Option<f32>,
    pub parent_container_id: Option<Uuid>,
    pub is_equipped: bool,
    pub is_attuned: bool,
    pub is_cursed: bool,
    pub is_curse_revealed: bool,
    pub true_state: serde_json::Value,
    pub perceived_state: serde_json::Value,
}

impl Item {
    fn unit_volume_cu_ft(&self) -> f32 {
        self.volume_cu_ft * self.quantity as f32
    }

    fn unit_weight_lbs(&self) -> f32 {
        self.base_weight_lbs * self.quantity as f32
    }
}

/// One exceeded limit on one container, quantified honestly: what the
/// container would hold, what it holds at most, and the overshoot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapacityViolation {
    /// `"weight_lbs"` or `"volume_cu_ft"` — the limit that was breached.
    pub limit: String,
    pub current: f32,
    pub max: f32,
    pub over_by: f32,
}

/// Typed rejection from [`InventoryManager::insert_into_container`] /
/// [`InventoryManager::reparent_item_into_container`]. `code` doubles as the
/// HTTP error code the server surfaces (422 for every variant here).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContainerOverfillError {
    /// `CONTAINER_OVERFILLED`, `CONTAINER_NOT_FOUND`,
    /// `CONTAINER_NOT_A_CONTAINER`, or `CONTAINER_SELF_NESTING`.
    pub code: String,
    /// The container whose acceptance was refused (or that was not found /
    /// was not a container).
    pub container_id: Uuid,
    /// Per-limit detail. EMPTY for the structural errors (not found / not a
    /// container / self-nesting) — there are no numeric deltas to report.
    pub violations: Vec<CapacityViolation>,
    /// Placement the item had BEFORE a rejected reparent attempt; restored by
    /// [`InventoryManager::reparent_item_into_container`] so a refused
    /// transfer leaves state untouched. Always `None` on freshly-built errors.
    #[serde(skip)]
    pub(crate) restored_parent: Option<Option<Uuid>>,
}

impl ContainerOverfillError {
    fn structural(code: &str, container_id: Uuid) -> Self {
        Self { code: code.to_string(), container_id, violations: Vec::new(), restored_parent: None }
    }

    /// Human-readable summary for an HTTP `detail` field: names EVERY violated
    /// limit with its numbers, never just the first.
    pub fn summary(&self) -> String {
        if self.violations.is_empty() {
            return self.code.clone();
        }
        let parts: Vec<String> = self
            .violations
            .iter()
            .map(|v| {
                format!(
                    "{} {} exceeds {} {} by {:.3}",
                    v.limit, v.current, v.max, v.limit, v.over_by
                )
            })
            .collect();
        format!("{}: {}", self.code, parts.join("; "))
    }
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

    /// Weight of the item's NESTED CONTENTS only (its own weight excluded —
    /// callers add that separately, whether the item is a stored map entry or
    /// a fresh payload). Cycle-guarded identically to
    /// [`Self::get_item_effective_weight_guarded`]: a crafted
    /// `parent_container_id` cycle terminates instead of overflowing.
    fn subtree_weight_contents(&self, container_id: &Uuid, visited: &mut std::collections::HashSet<Uuid>) -> f32 {
        if !visited.insert(*container_id) {
            return 0.0; // cycle — already counted once on this walk
        }
        let Some(item) = self.items.get(container_id) else {
            return 0.0;
        };
        let mut total = 0.0;
        if item.is_container {
            for other in self.items.values() {
                if other.parent_container_id == Some(*container_id) {
                    // Contents of a child = child's own weight + its contents.
                    total += other.unit_weight_lbs()
                        + self.subtree_weight_contents(&other.id, visited);
                }
            }
        }
        total
    }

    /// Volume of the item's NESTED CONTENTS only (its own bulk excluded —
    /// callers add that separately). A container's interior is its own space;
    /// contents do not add to the container's OWN displaced volume, but DO
    /// count against every ANCESTOR's volume limit.
    fn subtree_volume_contents(&self, container_id: &Uuid, visited: &mut std::collections::HashSet<Uuid>) -> f32 {
        if !visited.insert(*container_id) {
            return 0.0;
        }
        let Some(item) = self.items.get(container_id) else {
            return 0.0;
        };
        let mut total = 0.0;
        if item.is_container {
            for other in self.items.values() {
                if other.parent_container_id == Some(*container_id) {
                    total += other.unit_volume_cu_ft()
                        + self.subtree_volume_contents(&other.id, visited);
                }
            }
        }
        total
    }

    /// Checks placing `item` into `container_id` WITHOUT mutating anything:
    /// subtree weight and subtree volume must each fit the target's capacity.
    ///
    /// Every breached limit is reported together — a statue that blows both a
    /// thimble's weight AND volume gets named twice, not once.
    pub fn check_container_capacity(
        &self,
        item: &Item,
        container_id: &Uuid,
    ) -> Result<(), ContainerOverfillError> {
        // Nothing contains itself — the degenerate payload where the moved
        // item IS the target container.
        if *container_id == item.id {
            return Err(ContainerOverfillError::structural(
                "CONTAINER_SELF_NESTING",
                *container_id,
            ));
        }
        let Some(container) = self.items.get(container_id) else {
            return Err(ContainerOverfillError::structural(
                "CONTAINER_NOT_FOUND",
                *container_id,
            ));
        };
        if !container.is_container {
            return Err(ContainerOverfillError::structural(
                "CONTAINER_NOT_A_CONTAINER",
                *container_id,
            ));
        }

        let mut violations = Vec::new();
        // The projected load = the container's nested CONTENTS (its own empty
        // weight does not consume its own interior capacity — a 5 lb chest
        // rated for 10 lbs still holds 10 lbs) + the incoming item's own
        // subtree. Contents are counted transitively: overfilling a pouch
        // inside a chest is caught at the chest too.
        if let Some(max_lbs) = container.container_capacity_lbs {
            let mut visited = std::collections::HashSet::new();
            let mut current = self.subtree_weight_contents(container_id, &mut visited);
            if self.items.contains_key(&item.id) {
                current += item.unit_weight_lbs()
                    + self.subtree_weight_contents(&item.id, &mut visited);
            } else {
                current += item.unit_weight_lbs();
            }
            if current > max_lbs + f32::EPSILON.max(max_lbs * 1e-6) {
                violations.push(CapacityViolation {
                    limit: "weight_lbs".to_string(),
                    current,
                    max: max_lbs,
                    over_by: current - max_lbs,
                });
            }
        }
        if let Some(max_cu_ft) = container.container_volume_cu_ft {
            let mut visited = std::collections::HashSet::new();
            // Same interior semantics as weight: the case's own shell bulk
            // does not eat its rated volume.
            let mut current = self.subtree_volume_contents(container_id, &mut visited);
            if self.items.contains_key(&item.id) {
                current += item.unit_volume_cu_ft()
                    + self.subtree_volume_contents(&item.id, &mut visited);
            } else {
                current += item.unit_volume_cu_ft();
            }
            if current > max_cu_ft + f32::EPSILON.max(max_cu_ft * 1e-6) {
                violations.push(CapacityViolation {
                    limit: "volume_cu_ft".to_string(),
                    current,
                    max: max_cu_ft,
                    over_by: current - max_cu_ft,
                });
            }
        }
        if violations.is_empty() {
            Ok(())
        } else {
            Err(ContainerOverfillError {
                code: "CONTAINER_OVERFILLED".to_string(),
                container_id: *container_id,
                violations,
                restored_parent: None,
            })
        }
    }

    /// Checks placing `item` into `container_id` AND every ancestor above it:
    /// filling a pouch inside a chest consumes chest capacity too, so each
    /// link of the containment chain must accept the projected load (audit
    /// F-A4#4). The first refusing link wins; its error names THAT container,
    /// so a refusal always points at the ancestor whose limit was breached.
    pub fn check_container_capacity_chain(
        &self,
        item: &Item,
        container_id: &Uuid,
    ) -> Result<(), ContainerOverfillError> {
        let mut seen = std::collections::HashSet::new();
        let mut cursor = Some(*container_id);
        while let Some(id) = cursor {
            // Crafted parent cycles terminate the walk instead of looping;
            // cycle CREATION through reparenting is refused separately (see
            // `reparent_item_into_container`).
            if !seen.insert(id) {
                break;
            }
            self.check_container_capacity(item, &id)?;
            cursor = self.items.get(&id).and_then(|c| c.parent_container_id);
        }
        Ok(())
    }

    /// Inserts a NEW item bound to `container_id`, refusing when either the
    /// weight or the volume capacity would be exceeded — on the target OR any
    /// of its ancestors. On success the item's `parent_container_id` is
    /// stamped to the container.
    pub fn insert_into_container(
        &mut self,
        item: &Item,
        container_id: &Uuid,
    ) -> Result<(), ContainerOverfillError> {
        self.check_container_capacity_chain(item, container_id)?;
        let mut stored = item.clone();
        stored.parent_container_id = Some(*container_id);
        self.items.insert(stored.id, stored);
        Ok(())
    }

    /// Walks the ancestor chain of `container_id`; `true` when `ancestor_id`
    /// appears anywhere above it (or IS it). Cycle-guarded like every other
    /// parent-chain walk.
    fn is_descendant_of(&self, container_id: &Uuid, ancestor_id: &Uuid) -> bool {
        let mut seen = std::collections::HashSet::new();
        let mut cursor = Some(*container_id);
        while let Some(id) = cursor {
            if id == *ancestor_id {
                return true;
            }
            if !seen.insert(id) {
                return false;
            }
            cursor = self.items.get(&id).and_then(|c| c.parent_container_id);
        }
        false
    }

    /// Moves an EXISTING item into `container_id` under the same limits — the
    /// transfer/give boundary. The item's CURRENT placement is excluded from
    /// the subtree math (moving it out must not count it as still inside),
    /// then rebound to the new container on success.
    ///
    /// Two structural gates run before any capacity math: the move must not
    /// plant a container inside its own subtree (`CONTAINER_CYCLE`), which
    /// would otherwise drop the whole subtree out of the root-based weight
    /// totals even when no capacities are configured (audit F-A4#5).
    pub fn reparent_item_into_container(
        &mut self,
        item_id: &Uuid,
        container_id: &Uuid,
    ) -> Result<(), ContainerOverfillError> {
        let item = self
            .items
            .get(item_id)
            .cloned()
            .ok_or_else(|| ContainerOverfillError::structural("ITEM_NOT_FOUND", *item_id))?;
        // Cycle gate: the destination must not be the mover itself nor live
        // anywhere inside the mover's own subtree. (The mover-is-destination
        // degenerate case keeps its dedicated CONTAINER_SELF_NESTING verdict
        // from `check_container_capacity`.)
        if *container_id != item.id && self.is_descendant_of(container_id, item_id) {
            return Err(ContainerOverfillError::structural(
                "CONTAINER_CYCLE",
                *container_id,
            ));
        }
        let previous_parent = item.parent_container_id;
        // Detach first so the source chain is evaluated WITHOUT the mover:
        // reparenting within one tree must reflect post-move reality.
        if let Some(stored) = self.items.get_mut(item_id) {
            stored.parent_container_id = None;
        }
        match self.check_container_capacity_chain(&item, container_id) {
            Ok(()) => {
                if let Some(stored) = self.items.get_mut(item_id) {
                    stored.parent_container_id = Some(*container_id);
                }
                Ok(())
            }
            Err(mut e) => {
                // Restore prior placement on refusal — a rejected transfer
                // leaves the inventory exactly as it was.
                if let Some(prev) = self.items.get_mut(item_id) {
                    prev.parent_container_id = previous_parent;
                }
                e.restored_parent = Some(previous_parent);
                Err(e)
            }
        }
    }

    pub fn get_item_effective_weight(&self, item_id: &Uuid) -> f32 {
        self.get_item_effective_weight_guarded(item_id, &mut std::collections::HashSet::new())
    }

    /// Recursive container weight walk with a visited-node cycle guard:
    /// a crafted `parent_container_id` cycle must terminate, not overflow.
    fn get_item_effective_weight_guarded(
        &self,
        item_id: &Uuid,
        visited: &mut std::collections::HashSet<Uuid>,
    ) -> f32 {
        if !visited.insert(*item_id) {
            // Cycle detected — count this item once and stop descending.
            return self
                .items
                .get(item_id)
                .map(|i| i.base_weight_lbs * i.quantity as f32)
                .unwrap_or(0.0);
        }
        if let Some(item) = self.items.get(item_id) {
            let mut total = item.base_weight_lbs * item.quantity as f32;
            if item.is_container {
                for other in self.items.values() {
                    if other.parent_container_id == Some(*item_id) {
                        total += self.get_item_effective_weight_guarded(&other.id, visited);
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
            container_volume_cu_ft: Some(30.0),
            volume_cu_ft: 1.0,
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
            container_volume_cu_ft: None,
            volume_cu_ft: 0.1,
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
