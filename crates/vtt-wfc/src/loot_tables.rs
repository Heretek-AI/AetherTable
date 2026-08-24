//! Weighted thematic loot generation.
//!
//! Unlike the rest of the procedural dressing helpers (which use cheap modulo
//! arithmetic on the seed), this module drives everything off a real seeded
//! PRNG ([`rand::rngs::StdRng`]) so that:
//!
//! * replaying the same seed reproduces the exact same hoard, and
//! * distinct seeds consume independent draws and therefore diverge.
//!
//! ## Draw protocol (per hoard, in order)
//!
//! 1. **Theme selection** - one uniform draw picks which themed table is used.
//! 2. **Hoard size** - one draw picks how many entries are drawn (1..=3).
//! 3. Per entry: **weighted table roll** - one draw over the remaining entry
//!    weights (drawn without replacement, so a hoard never repeats an entry).
//! 4. Per entry: **value roll** - one draw inside the entry's gp value band.
//! 5. Per entry: **quantity roll** - one draw inside the entry's qty band.
//!
//! ## Treasure-tier convention
//!
//! The tier parameter represents the party level / encounter CR band
//! (clamped to the D&D range 1..=20). It scales gold-piece values by a
//! DMG-style exponential multiplier:
//!
//! | Tier   | Multiplier |
//! |--------|------------|
//! | 1..=4  | x1         |
//! | 5..=10 | x3         |
//! | 11..=16| x9         |
//! | 17..=20| x27        |

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

/// Number of themed tables available for RNG selection.
const THEMES: usize = 3;

/// Item rarity, carrying its canonical relative table weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rarity {
    Common,
    Uncommon,
    Rare,
    VeryRare,
}

/// Themed loot tables. Each theme owns its own entry list with explicit
/// rarity weights and a gold-piece value band per entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LootTheme {
    Crypt,
    Arcane,
    Wilderness,
}

impl LootTheme {
    /// All themes, in stable RNG-selection order.
    pub const ALL: [LootTheme; THEMES] = [
        LootTheme::Crypt,
        LootTheme::Arcane,
        LootTheme::Wilderness,
    ];

    pub fn name(&self) -> &'static str {
        match self {
            LootTheme::Crypt => "crypt",
            LootTheme::Arcane => "arcane",
            LootTheme::Wilderness => "wilderness",
        }
    }

    /// The themed table itself. Weights are explicit so aggregate rarity
    /// frequencies are auditable: per theme the totals are
    /// common 200, uncommon 80, rare 30, very_rare 5 (of 315).
    pub fn table(&self) -> &'static [LootEntry] {
        match self {
            LootTheme::Crypt => CRYPT_TABLE,
            LootTheme::Arcane => ARCANE_TABLE,
            LootTheme::Wilderness => WILDERNESS_TABLE,
        }
    }
}

/// A single row of a themed loot table.
#[derive(Debug, Clone, Copy)]
pub struct LootEntry {
    pub name: &'static str,
    pub item_type: &'static str,
    pub rarity: Rarity,
    /// Relative selection weight against the other rows of this table only.
    pub weight: u32,
    /// Inclusive gp value band for one unit of the item (before tier scaling).
    pub value_band_gp: (u32, u32),
    /// Inclusive stack-size band rolled per draw.
    pub qty_band: (u32, u32),
}

const CRYPT_TABLE: &[LootEntry] = &[
    LootEntry { name: "Moldering Coin Purse", item_type: "Coinage", rarity: Rarity::Common, weight: 100, value_band_gp: (5, 40), qty_band: (1, 2) },
    LootEntry { name: "Grave Moss Salve", item_type: "Consumable", rarity: Rarity::Common, weight: 100, value_band_gp: (10, 30), qty_band: (1, 3) },
    LootEntry { name: "Silvered Ritual Dagger", item_type: "Weapon", rarity: Rarity::Uncommon, weight: 40, value_band_gp: (120, 260), qty_band: (1, 1) },
    LootEntry { name: "Vial of Grave-Iron Salt", item_type: "Alchemical", rarity: Rarity::Uncommon, weight: 40, value_band_gp: (90, 180), qty_band: (1, 2) },
    LootEntry { name: "Signet Ring of House Vane", item_type: "Treasure", rarity: Rarity::Rare, weight: 15, value_band_gp: (700, 1400), qty_band: (1, 1) },
    LootEntry { name: "Bone-Charm of Warding", item_type: "Magic Item", rarity: Rarity::Rare, weight: 15, value_band_gp: (900, 1600), qty_band: (1, 1) },
    LootEntry { name: "Crown of the Drowned King", item_type: "Magic Item", rarity: Rarity::VeryRare, weight: 5, value_band_gp: (6000, 9000), qty_band: (1, 1) },
];

const ARCANE_TABLE: &[LootEntry] = &[
    LootEntry { name: "Cracked Arcane Focus", item_type: "Arcana", rarity: Rarity::Common, weight: 100, value_band_gp: (15, 45), qty_band: (1, 1) },
    LootEntry { name: "Chalk of Minor Warding", item_type: "Tool", rarity: Rarity::Common, weight: 100, value_band_gp: (10, 35), qty_band: (1, 3) },
    LootEntry { name: "Scroll of Magic Missile (Level 1)", item_type: "Scroll", rarity: Rarity::Uncommon, weight: 40, value_band_gp: (80, 150), qty_band: (1, 2) },
    LootEntry { name: "Lesser Mana Draught", item_type: "Potion", rarity: Rarity::Uncommon, weight: 40, value_band_gp: (110, 220), qty_band: (1, 2) },
    LootEntry { name: "Staff of Emberlight", item_type: "Magic Item", rarity: Rarity::Rare, weight: 15, value_band_gp: (850, 1500), qty_band: (1, 1) },
    LootEntry { name: "Grimoire Page: Firebolt", item_type: "Tome", rarity: Rarity::Rare, weight: 15, value_band_gp: (700, 1300), qty_band: (1, 1) },
    LootEntry { name: "Orb of the Ninth Circle", item_type: "Magic Item", rarity: Rarity::VeryRare, weight: 5, value_band_gp: (6500, 9500), qty_band: (1, 1) },
];

const WILDERNESS_TABLE: &[LootEntry] = &[
    LootEntry { name: "Bundle of Dried Herbs", item_type: "Provision", rarity: Rarity::Common, weight: 100, value_band_gp: (5, 25), qty_band: (1, 4) },
    LootEntry { name: "Hunter's Snare Kit", item_type: "Tool", rarity: Rarity::Common, weight: 100, value_band_gp: (8, 30), qty_band: (1, 2) },
    LootEntry { name: "Masterwork Elven Arrows", item_type: "Ammo", rarity: Rarity::Uncommon, weight: 40, value_band_gp: (100, 200), qty_band: (1, 2) },
    LootEntry { name: "Antler Talisman", item_type: "Trinket", rarity: Rarity::Uncommon, weight: 40, value_band_gp: (90, 170), qty_band: (1, 1) },
    LootEntry { name: "Cloak of the Stag Lord", item_type: "Magic Item", rarity: Rarity::Rare, weight: 15, value_band_gp: (800, 1500), qty_band: (1, 1) },
    LootEntry { name: "Heartwood Longbow", item_type: "Weapon", rarity: Rarity::Rare, weight: 15, value_band_gp: (1000, 1800), qty_band: (1, 1) },
    LootEntry { name: "Horn of the Ancient Wilds", item_type: "Wondrous Item", rarity: Rarity::VeryRare, weight: 5, value_band_gp: (7000, 10000), qty_band: (1, 1) },
];

/// One rolled loot item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LootItem {
    pub name: String,
    pub item_type: String,
    /// Unit value in gold pieces, already scaled by the treasure-tier
    /// multiplier (the stack quantity is reported separately).
    pub value_gp: u32,
    pub rarity: Rarity,
    /// Stack size rolled from the entry's quantity band.
    #[serde(default = "default_qty")]
    pub quantity: u32,
}

fn default_qty() -> u32 {
    1
}

/// Full result of a themed hoard roll, including which table was selected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThematicLootRoll {
    pub theme: LootTheme,
    pub treasure_tier: u8,
    pub tier_multiplier: u32,
    pub items: Vec<LootItem>,
}

/// Treasure-tier multiplier convention (see module docs): tiers map to party
/// level / CR bands and scale gp values exponentially.
pub fn treasure_tier_multiplier(tier: u8) -> u32 {
    let tier = clamp_tier(tier);
    match tier {
        1..=4 => 1,
        5..=10 => 3,
        11..=16 => 9,
        _ => 27,
    }
}

fn clamp_tier(tier: u8) -> u8 {
    tier.clamp(1, 20)
}

pub struct LootTableGenerator;

impl LootTableGenerator {
    /// Rolls a full themed hoard using independent seeded RNG draws.
    ///
    /// `treasure_tier` is clamped to 1..=20 and interpreted as the party
    /// level / encounter CR band (see [`treasure_tier_multiplier`]).
    /// Degenerate inputs (tier 0, empty or all-zero-weight tables) never
    /// panic: they yield fewer or zero items.
    pub fn roll_themed_hoard(treasure_tier: u8, seed: u64) -> ThematicLootRoll {
        let mut rng = StdRng::seed_from_u64(seed);

        // Draw 1: theme (table) selection.
        let theme_idx = rng.gen_range(0..THEMES);
        let theme = LootTheme::ALL[theme_idx];
        let table = theme.table();

        let multiplier = treasure_tier_multiplier(treasure_tier);

        // Draw 2: hoard size.
        let slots = rng.gen_range(1..=3usize);

        // Remaining selectable indices; picked entries cannot repeat.
        let mut remaining: Vec<usize> = (0..table.len()).collect();
        let mut items = Vec::with_capacity(slots);

        for _ in 0..slots {
            let weights: Vec<u32> = remaining
                .iter()
                .map(|&i| table[i].weight)
                .collect();
            let Some(pick) = weighted_pick(&mut rng, &weights) else {
                break; // table exhausted or all-zero weights: stop cleanly
            };
            let entry = table[remaining.remove(pick)];

            // Draw 3: weighted entry roll happened above; now the value roll.
            let (vmin, vmax) = entry.value_band_gp;
            let value = if vmax > vmin {
                rng.gen_range(vmin..=vmax)
            } else {
                vmin
            };

            // Draw 4: quantity roll.
            let (qmin, qmax) = entry.qty_band;
            let qty = if qmax > qmin {
                rng.gen_range(qmin..=qmax)
            } else {
                qmin.max(1)
            };

            items.push(LootItem {
                name: entry.name.to_string(),
                item_type: entry.item_type.to_string(),
                value_gp: value.saturating_mul(multiplier),
                rarity: entry.rarity,
                quantity: qty,
            });
        }

        ThematicLootRoll {
            theme,
            treasure_tier: clamp_tier(treasure_tier),
            tier_multiplier: multiplier,
            items,
        }
    }

    /// Backwards-compatible wrapper around [`Self::roll_thematic_loot_full`].
    /// `cr_tier` is treated as the treasure tier (party level / CR band).
    pub fn roll_thematic_loot(cr_tier: u8, seed: u64) -> Vec<LootItem> {
        LootTableGenerator::roll_themed_hoard(cr_tier, seed).items
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

/// Weighted index selection. Returns `None` for empty or all-zero weight
/// slices instead of panicking. Consumes exactly one RNG draw when it returns
/// `Some`.
fn weighted_pick<R: Rng>(rng: &mut R, weights: &[u32]) -> Option<usize> {
    let total: u32 = weights.iter().sum();
    if weights.is_empty() || total == 0 {
        return None;
    }
    let mut roll = rng.gen_range(0..total);
    for (idx, w) in weights.iter().enumerate() {
        if roll < *w {
            return Some(idx);
        }
        roll -= *w;
    }
    // Only reachable on overflow-style inconsistencies; degrade gracefully.
    Some(weights.len().saturating_sub(1))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DungeonRoomDressing {
    pub room_id: usize,
    pub feature_name: String,
    pub description: String,
    pub searchable_loot: Option<String>,
    pub environmental_hazard: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn signature(roll: &ThematicLootRoll) -> String {
        let mut parts: Vec<String> = roll
            .items
            .iter()
            .map(|i| format!("{}|{}|{}", i.name, i.value_gp, i.quantity))
            .collect();
        parts.sort();
        format!("{}::{}", roll.theme.name(), parts.join(";"))
    }

    #[test]
    fn same_seed_replay_is_identical() {
        for seed in [0u64, 1, 42, 1337, u64::MAX - 7] {
            for tier in [1u8, 5, 12, 20] {
                let a = LootTableGenerator::roll_themed_hoard(tier, seed);
                let b = LootTableGenerator::roll_themed_hoard(tier, seed);
                assert_eq!(signature(&a), signature(&b), "seed={seed} tier={tier}");
                assert_eq!(a.items, b.items);
                // Wrapper must replay identically too.
                assert_eq!(
                    LootTableGenerator::roll_thematic_loot(tier, seed),
                    LootTableGenerator::roll_thematic_loot(tier, seed)
                );
            }
        }
    }

    #[test]
    fn distinct_seeds_diverge_across_many_rolls() {
        // 300 independent seeds: expected distinct outputs is ~300 because the
        // output space (theme x entry subsets x bands x quantities) has
        // millions of outcomes, so pairwise collision probability is far below
        // one-in-a-billion. Threshold 150 leaves an enormous safety margin.
        let mut seen = HashSet::new();
        for seed in 0..300u64 {
            let roll = LootTableGenerator::roll_themed_hoard(3, seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            seen.insert(signature(&roll));
        }
        assert!(seen.len() >= 150, "only {} distinct hoards across 300 seeds", seen.len());
    }

    #[test]
    fn all_drawn_entries_belong_to_selected_theme() {
        let mut names_by_theme: HashMap<&str, HashSet<&str>> = HashMap::new();
        for theme in LootTheme::ALL {
            let set: HashSet<&str> = theme.table().iter().map(|e| e.name).collect();
            names_by_theme.insert(theme.name(), set);
        }

        for seed in 0..500u64 {
            let roll = LootTableGenerator::roll_themed_hoard(7, seed);
            let allowed = &names_by_theme[roll.theme.name()];
            assert!(!allowed.is_empty());
            for item in &roll.items {
                assert!(
                    allowed.contains(item.name.as_str()),
                    "seed={seed} item '{}' not in {} table",
                    item.name,
                    roll.theme.name()
                );
            }
        }
    }

    #[test]
    fn weight_distribution_common_dominates_very_rare() {
        // Aggregate weights per theme: common 200, very_rare 5 of 315, so the
        // expected ratio is ~40x. Over 4000 hoards (~8000 draws) we expect
        // ~5000 commons and ~127 very rares; asserting a 5x margin and at
        // least one very_rare hit is robust against any plausible fluctuation
        // (P(no very_rare in 8000 draws) < 1e-160).
        let mut counts: HashMap<Rarity, u32> = HashMap::new();
        for seed in 0..4000u64 {
            for item in LootTableGenerator::roll_themed_hoard(2, seed).items {
                *counts.entry(item.rarity).or_insert(0) += 1;
            }
        }
        let common = counts.get(&Rarity::Common).copied().unwrap_or(0);
        let very_rare = counts.get(&Rarity::VeryRare).copied().unwrap_or(0);
        assert!(common > 0, "no commons drawn at all");
        assert!(
            very_rare >= 1,
            "very_rare never appeared in 4000 hoards despite positive weight"
        );
        assert!(
            common > very_rare * 5,
            "expected commons to dominate very_rares: common={common} very_rare={very_rare}"
        );
    }

    #[test]
    fn values_stay_within_entry_bands_scaled_by_tier() {
        for seed in 0..200u64 {
            let roll = LootTableGenerator::roll_themed_hoard(11, seed);
            let table: HashMap<&str, &LootEntry> =
                roll.theme.table().iter().map(|e| (e.name, e)).collect();
            for item in &roll.items {
                let entry = table[item.name.as_str()];
                let (vmin, vmax) = entry.value_band_gp;
                assert!(
                    item.value_gp >= vmin * roll.tier_multiplier
                        && item.value_gp <= vmax * roll.tier_multiplier,
                    "value {} outside band {:?} x {}",
                    item.value_gp,
                    entry.value_band_gp,
                    roll.tier_multiplier
                );
                let (qmin, qmax) = entry.qty_band;
                assert!(item.quantity >= qmin && item.quantity <= qmax);
            }
        }
    }

    #[test]
    fn tier_multiplier_follows_documented_convention() {
        assert_eq!(treasure_tier_multiplier(1), 1);
        assert_eq!(treasure_tier_multiplier(4), 1);
        assert_eq!(treasure_tier_multiplier(5), 3);
        assert_eq!(treasure_tier_multiplier(10), 3);
        assert_eq!(treasure_tier_multiplier(11), 9);
        assert_eq!(treasure_tier_multiplier(16), 9);
        assert_eq!(treasure_tier_multiplier(17), 27);
        assert_eq!(treasure_tier_multiplier(20), 27);
        // Out-of-range tiers clamp instead of misbehaving.
        assert_eq!(treasure_tier_multiplier(0), 1);
        assert_eq!(treasure_tier_multiplier(u8::MAX), 27);
    }

    #[test]
    fn degenerate_inputs_do_not_panic() {
        // Extreme / zero tiers and seeds.
        assert!(!LootTableGenerator::roll_thematic_loot(0, 0).is_empty());
        assert!(!LootTableGenerator::roll_thematic_loot(u8::MAX, u64::MAX).is_empty());

        // Empty and all-zero-weight slices must return None, not panic.
        let mut rng = StdRng::seed_from_u64(1);
        assert!(weighted_pick(&mut rng, &[]).is_none());
        assert!(weighted_pick(&mut rng, &[0, 0, 0]).is_none());
        // Zero-weight rows are skipped, non-zero rows still selectable.
        for _ in 0..50 {
            assert_eq!(weighted_pick(&mut rng, &[0, 0, 5]), Some(2));
        }
    }

    #[test]
    fn compatible_wrapper_returns_nonempty_items_with_positive_values() {
        let loot = LootTableGenerator::roll_thematic_loot(1, 1337);
        assert!(!loot.is_empty());
        assert!(loot[0].value_gp > 0);
    }
}
