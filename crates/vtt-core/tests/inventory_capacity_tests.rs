//! Iteration 48 (Pillar-7 gap, first audit): container capacity is NEVER
//! enforced — `container_capacity_lbs` was a decorative field and volume did
//! not exist at all — despite recursive nested inventories being fully built
//! (`InventoryManager::get_item_effective_weight_guarded`). GOALS.md P7
//! requires volume AND weight limit enforcement for container hierarchies.
//!
//! These tests pin the enforcement contract:
//! - weight-limit violation rejected
//! - volume-limit violation rejected
//! - a pouch inside a chest is enforced TRANSITIVELY (the walk descends)
//! - exactly-at-capacity is allowed
//! - when BOTH limits are exceeded the error names both with honest deltas

use uuid::Uuid;
use vtt_core::inventory::{InventoryManager, Item};

fn item(id: Uuid, name: &str, weight_lbs: f32, quantity: u32) -> Item {
    Item {
        id,
        compendium_id: format!("item_{}", name.to_lowercase().replace(' ', "_")),
        name: name.to_string(),
        base_weight_lbs: weight_lbs,
        quantity,
        is_container: false,
        container_capacity_lbs: None,
        container_volume_cu_ft: None,
        volume_cu_ft: 0.1,
        parent_container_id: None,
        is_equipped: false,
        is_attuned: false,
        is_cursed: false,
        is_curse_revealed: false,
        true_state: serde_json::json!({}),
        perceived_state: serde_json::json!({}),
    }
}

fn container(
    id: Uuid,
    name: &str,
    own_weight_lbs: f32,
    capacity_lbs: Option<f32>,
    capacity_cu_ft: Option<f32>,
) -> Item {
    Item {
        is_container: true,
        container_capacity_lbs: capacity_lbs,
        container_volume_cu_ft: capacity_cu_ft,
        volume_cu_ft: 0.5,
        ..item(id, name, own_weight_lbs, 1)
    }
}

/// A chest that holds 10 lbs gets offered an 11 lb anvil → rejected, naming
/// which limit and by how much.
#[test]
fn weight_over_capacity_is_rejected_with_delta() {
    let mut inv = InventoryManager::new();
    let chest = Uuid::new_v4();
    inv.add_item(container(chest, "Chest", 5.0, Some(10.0), Some(100.0)));

    let anvil_item = item(Uuid::new_v4(), "Anvil", 11.0, 1);
    let err = inv
        .insert_into_container(&anvil_item, &chest)
        .expect_err("11 lbs cannot fit in a 10 lb chest");
    assert_eq!(err.code, "CONTAINER_OVERFILLED");
    assert_eq!(err.container_id, chest);
    // Exactly one violated limit, honestly quantified.
    assert_eq!(err.violations.len(), 1);
    let v = &err.violations[0];
    assert_eq!(v.limit, "weight_lbs");
    assert!((v.current - 11.0).abs() < 1e-6, "current={}", v.current);
    assert!((v.max - 10.0).abs() < 1e-6);
}

#[test]
fn weight_at_exact_capacity_is_allowed() {
    let mut inv = InventoryManager::new();
    let chest = Uuid::new_v4();
    inv.add_item(container(chest, "Chest", 5.0, Some(10.0), Some(100.0)));

    let anvil_id = Uuid::new_v4();
    let anvil_item = item(anvil_id, "Anvil", 10.0, 1);
    inv.insert_into_container(&anvil_item, &chest)
        .expect("exactly at capacity must be allowed");
    assert!(inv.items.contains_key(&anvil_id));
    assert_eq!(
        inv.items[&anvil_id].parent_container_id,
        Some(chest),
        "insert must bind the item to its new container"
    );
}

#[test]
fn volume_over_capacity_is_rejected_with_delta() {
    let mut inv = InventoryManager::new();
    let scroll_case = Uuid::new_v4();
    inv.add_item(container(scroll_case, "Scroll Case", 0.5, Some(50.0), Some(1.0)));

    let mut boulder_item = item(Uuid::new_v4(), "Boulder", 2.0, 1);
    // Give it explicit bulk so it cannot ride the default.
    boulder_item.volume_cu_ft = 1.5;

    let err = inv
        .insert_into_container(&boulder_item, &scroll_case)
        .expect_err("1.5 cu ft cannot fit in a 1.0 cu ft case");
    assert_eq!(err.code, "CONTAINER_OVERFILLED");
    assert_eq!(err.violations.len(), 1);
    let v = &err.violations[0];
    assert_eq!(v.limit, "volume_cu_ft");
    assert!((v.current - 1.5).abs() < 1e-6, "current={}", v.current);
    assert!((v.max - 1.0).abs() < 1e-6);
}

/// The transitive case from the audit: the pouch itself fits in the chest, but
/// what the pouch CONTAINS pushes the chest over. The subtree walk must see it.
#[test]
fn nested_container_contents_are_enforced_transitively() {
    let mut inv = InventoryManager::new();
    let chest_id = Uuid::new_v4();
    let pouch_id = Uuid::new_v4();
    inv.add_item(container(chest_id, "Chest", 5.0, Some(10.0), Some(100.0)));
    inv.add_item(container(pouch_id, "Pouch", 0.5, Some(8.0), Some(2.0)));
    // Pouch already lives in the chest.
    inv.items.get_mut(&pouch_id).unwrap().parent_container_id = Some(chest_id);

    // Pouch takes exactly its own 8 lb capacity of coins.
    let mut coin_pile = item(Uuid::new_v4(), "Gold Coins", 4.0, 2); // 8 lbs
    coin_pile.volume_cu_ft = 0.05;
    inv.insert_into_container(&coin_pile, &pouch_id)
        .expect("8 lbs fits the pouch's 8 lb capacity");

    // Now drop a 3 lb bar into the chest: projected chest CONTENTS =
    // pouch(0.5) + coins(8) + bar(3) = 11.5 > 10 → rejected. (A container's
    // own empty weight does not eat its own rated capacity.)
    let bar_item = item(Uuid::new_v4(), "Iron Bar", 3.0, 1);
    let err = inv
        .insert_into_container(&bar_item, &chest_id)
        .expect_err("chest subtree weight must include nested pouch contents");
    assert_eq!(err.code, "CONTAINER_OVERFILLED");
    let v = err
        .violations
        .iter()
        .find(|v| v.limit == "weight_lbs")
        .expect("weight violation named");
    assert!((v.current - 11.5).abs() < 1e-4, "current={}", v.current);
    assert!((v.max - 10.0).abs() < 1e-6);

    // And the same via the POUCH: filling the pouch past ITS OWN limit while
    // the pouch sits inside the chest is caught on the pouch's own check.
    let extra = item(Uuid::new_v4(), "More Coins", 1.0, 1);
    let err2 = inv
        .insert_into_container(&extra, &pouch_id)
        .expect_err("pouch is at its own weight capacity");
    assert_eq!(err2.code, "CONTAINER_OVERFILLED");
    assert_eq!(err2.container_id, pouch_id, "the failing container is named");
}

#[test]
fn both_limits_exceeded_are_named_together() {
    let mut inv = InventoryManager::new();
    let thimble = Uuid::new_v4();
    inv.add_item(container(thimble, "Thimble", 0.01, Some(1.0), Some(0.25)));

    let mut statue_item = item(Uuid::new_v4(), "Stone Statue", 40.0, 1);
    statue_item.volume_cu_ft = 3.0;

    let err = inv
        .insert_into_container(&statue_item, &thimble)
        .expect_err("both limits blown");
    assert_eq!(err.code, "CONTAINER_OVERFILLED");
    assert_eq!(err.violations.len(), 2, "both violations reported");
    let limits: Vec<&str> = err.violations.iter().map(|v| v.limit.as_str()).collect();
    assert!(limits.contains(&"weight_lbs"), "limits={:?}", limits);
    assert!(limits.contains(&"volume_cu_ft"), "limits={:?}", limits);
}

#[test]
fn unknown_target_container_is_a_distinct_error() {
    let mut inv = InventoryManager::new();
    let loose = item(Uuid::new_v4(), "Rock", 1.0, 1);
    let missing = Uuid::new_v4();
    let err = inv
        .insert_into_container(&loose, &missing)
        .expect_err("cannot insert into a nonexistent container");
    assert_eq!(err.code, "CONTAINER_NOT_FOUND");
    assert_eq!(err.container_id, missing);
}

#[test]
fn inserting_into_a_non_container_is_rejected() {
    let mut inv = InventoryManager::new();
    let rock = item(Uuid::new_v4(), "Rock", 1.0, 1);
    inv.add_item(rock.clone());
    let pebble = item(Uuid::new_v4(), "Pebble", 0.2, 1);
    let err = inv
        .insert_into_container(&pebble, &rock.id)
        .expect_err("a rock has no interior");
    assert_eq!(err.code, "CONTAINER_NOT_A_CONTAINER");
}

#[test]
fn nesting_an_item_inside_itself_is_rejected() {
    let mut inv = InventoryManager::new();
    let bag = container(Uuid::new_v4(), "Bag of Holding?", 1.0, Some(50.0), Some(20.0));
    let bag_id = bag.id;
    inv.add_item(bag);
    let mut moved = item(bag_id, "The Bag Itself", 1.0, 1);
    moved.is_container = true;
    moved.container_capacity_lbs = Some(50.0);
    let err = inv
        .insert_into_container(&moved, &bag_id)
        .expect_err("nothing contains itself");
    assert_eq!(err.code, "CONTAINER_SELF_NESTING");
}

/// A crafted `parent_container_id` cycle must not hang or overflow the
/// subtree walk used for capacity checks (mirrors the guard on the weight walk).
#[test]
fn cyclic_parent_chain_does_not_overflow_the_subtree_walk() {
    let mut inv = InventoryManager::new();
    let a = container(Uuid::new_v4(), "A", 1.0, Some(5.0), Some(5.0));
    let b = container(Uuid::new_v4(), "B", 1.0, Some(5.0), Some(5.0));
    let (a_id, b_id) = (a.id, b.id);
    inv.add_item(a);
    inv.add_item(b);
    // A -> B -> A by direct field mutation (crafted state).
    inv.items.get_mut(&a_id).unwrap().parent_container_id = Some(b_id);
    inv.items.get_mut(&b_id).unwrap().parent_container_id = Some(a_id);

    let coin = item(Uuid::new_v4(), "Coin", 1.0, 1);
    // Must terminate with a verdict either way — never recurse forever.
    let _ = inv.insert_into_container(&coin, &a_id);
}

/// Reparenting an existing item (the transfer/give flow) runs the same checks.
#[test]
fn reparent_existing_item_enforces_and_binds_on_success() {
    let mut inv = InventoryManager::new();
    let chest = Uuid::new_v4();
    inv.add_item(container(chest, "Chest", 0.5, Some(6.0), Some(100.0)));
    let sword = Uuid::new_v4();
    inv.add_item(item(sword, "Sword", 3.0, 1));

    inv.reparent_item_into_container(&sword, &chest)
        .expect("3 lbs of contents fits the 6 lb chest");
    assert_eq!(inv.items[&sword].parent_container_id, Some(chest));

    // Second transfer of another 4 lb item now exceeds the 6 lb chest
    // (contents 3 + 4 = 7 > 6).
    let mace = Uuid::new_v4();
    inv.add_item(item(mace, "Mace", 4.0, 1));
    let err = inv
        .reparent_item_into_container(&mace, &chest)
        .expect_err("3+4 > 6 of contents");
    assert_eq!(err.code, "CONTAINER_OVERFILLED");
    // The refused transfer left the mace unattached, not corrupted mid-move.
    assert_eq!(inv.items[&mace].parent_container_id, None);
}
