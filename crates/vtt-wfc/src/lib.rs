//! # vtt-wfc: Procedural Map Synthesis via Wave Function Collapse
//!
//! Generates coherent, fully playable dungeon layouts using:
//! - Socket-matching WFC with entropy-driven collapse and restart-on-contradiction
//! - Sealed perimeters and a flood-fill walkability guarantee
//! - Deterministic, seed-derived dressing (altars, chests) and loot tables

pub mod loot_tables;
pub mod solver;
pub mod tile;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TileType {
    Empty,
    Floor,
    Wall,
    Door,
    Altar,
    Chest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomDescriptor {
    pub room_id: usize,
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
    pub theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DungeonMap {
    pub width: usize,
    pub height: usize,
    pub grid: Vec<Vec<TileType>>,
    pub seed: u64,
    pub rooms: Vec<RoomDescriptor>,
    /// Treasure containers placed by the dressing pass, each carrying its
    /// seeded loot roll. Positions are a deterministic function of the seed
    /// (dead-end-first placement) and always coincide with a
    /// [`TileType::Chest`] grid cell.
    #[serde(default)]
    pub loot_containers: Vec<LootContainer>,
}

pub struct DungeonGenerator {
    pub width: usize,
    pub height: usize,
}

pub type WfcDungeonGenerator = DungeonGenerator;

/// A walkable cell for connectivity purposes.
fn is_walkable(t: TileType) -> bool {
    matches!(t, TileType::Floor | TileType::Door | TileType::Altar | TileType::Chest)
}

impl DungeonGenerator {
    pub fn new(width: usize, height: usize) -> Self {
        Self { width, height }
    }

    /// Runs the REAL socket-matching WFC solver over the default dungeon
    /// tileset, enforces single-region walkability via flood fill, then
    /// dresses the largest open area deterministically from the seed.
    ///
    /// Same seed ⇒ byte-identical map; different seeds diverge.
    pub fn generate(&self, seed: u64) -> DungeonMap {
        let variants: Vec<tile::TileVariant> = tile::default_dungeon_tileset()
            .iter()
            .flat_map(|t| t.generate_variants())
            .collect();

        let mut solver =
            solver::WfcSolver::new(self.width, self.height, variants.clone(), Some(seed));

        // Restart on contradiction with deterministic reseeds; if EVERY
        // attempt contradicts, fall back to an open walled box — still a
        // valid playable map, never a generation error surfaced to players.
        let solved = match solver.solve_with_retries(16, seed) {
            Ok(res) => res,
            Err(_) => {
                let mut grid = vec![vec![TileType::Floor; self.width]; self.height];
                // Wall the four borders: top and bottom rows in full, then
                // the left and right edge of every row.
                if let Some((top, rest)) = grid.split_first_mut() {
                    for cell in top.iter_mut() {
                        *cell = TileType::Wall;
                    }
                    if let Some(bottom) = rest.last_mut() {
                        for cell in bottom.iter_mut() {
                            *cell = TileType::Wall;
                        }
                    }
                }
                for row in grid.iter_mut() {
                    if let Some(left) = row.first_mut() {
                        *left = TileType::Wall;
                    }
                    if let Some(right) = row.last_mut() {
                        *right = TileType::Wall;
                    }
                }
                return DungeonMap {
                    width: self.width,
                    height: self.height,
                    grid,
                    seed,
                    rooms: derive_room_descriptors_fallback(self.width, self.height),
                    loot_containers: Vec::new(),
                };
            }
        };

        // Variant → TileType. Wall tiles are those that block LoS without
        // being doors; everything else in this tileset is walkable floor.
        let mut grid: Vec<Vec<TileType>> = solved
            .grid
            .chunks(self.width)
            .map(|row| {
                row.iter()
                    .map(|v| {
                        if v.is_door {
                            TileType::Door
                        } else if v.blocks_line_of_sight {
                            TileType::Wall
                        } else {
                            TileType::Floor
                        }
                    })
                    .collect()
            })
            .collect();

        // Connectivity guarantee: keep ONLY the largest 4-connected walkable
        // region; every other pocket is sealed as wall (Pillar 8 anti-orphan).
        enforce_single_region(&mut grid, self.width, self.height);

        // Deterministic dressing inside the walkable region (altar + the
        // treasure containers that are exported in the payload).
        let loot_containers = dress_dungeon(&mut grid, seed);

        let rooms = derive_room_descriptors(&grid);

        DungeonMap {
            width: self.width,
            height: self.height,
            grid,
            seed,
            rooms,
            loot_containers,
        }
    }

    pub fn generate_room(desc: &RoomDescriptor, seed: Option<u64>) -> Result<Vec<Vec<u8>>, String> {
        let w = desc.width;
        let h = desc.height;
        let s = seed.unwrap_or(1337);
        let gen = DungeonGenerator::new(w, h);
        let map = gen.generate(s);

        let tiles = map
            .grid
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|t| match t {
                        TileType::Wall => 1,
                        TileType::Floor => 0,
                        TileType::Door => 2,
                        TileType::Altar => 3,
                        TileType::Chest => 4,
                        TileType::Empty => 0,
                    })
                    .collect()
            })
            .collect();

        Ok(tiles)
    }
}

/// Fallback room descriptors for the walled-box fallback layout.
fn derive_room_descriptors_fallback(width: usize, height: usize) -> Vec<RoomDescriptor> {
    if width < 3 || height < 3 {
        return Vec::new();
    }
    vec![RoomDescriptor {
        room_id: 1,
        x: 1,
        y: 1,
        width: width - 2,
        height: height - 2,
        theme: "Great Hall".to_string(),
    }]
}

/// Keeps only the largest connected walkable region; seals the rest.
fn enforce_single_region(grid: &mut [Vec<TileType>], width: usize, height: usize) {
    let mut region_id = vec![vec![0usize; width]; height];
    let mut current_region = 0usize;
    let mut sizes: Vec<usize> = vec![0];

    for y in 0..height {
        for x in 0..width {
            if !is_walkable(grid[y][x]) || region_id[y][x] != 0 {
                continue;
            }
            current_region += 1;
            let mut size = 0usize;
            let mut stack = vec![(x, y)];
            region_id[y][x] = current_region;
            while let Some((cx, cy)) = stack.pop() {
                size += 1;
                for (nx, ny) in [
                    (cx + 1, cy),
                    (cx.wrapping_sub(1), cy),
                    (cx, cy + 1),
                    (cx, cy.saturating_sub(1)),
                ] {
                    if nx < width && ny < height && is_walkable(grid[ny][nx]) && region_id[ny][nx] == 0
                    {
                        region_id[ny][nx] = current_region;
                        stack.push((nx, ny));
                    }
                }
            }
            sizes.push(size);
        }
    }

    if current_region <= 1 {
        return; // already a single region (or empty)
    }
    let largest = sizes
        .iter()
        .enumerate()
        .skip(1)
        .max_by_key(|(_, &s)| s)
        .map(|(id, _)| id)
        .expect("current_region > 1");

    for y in 0..height {
        for x in 0..width {
            if is_walkable(grid[y][x]) && region_id[y][x] != largest {
                grid[y][x] = TileType::Wall;
            }
        }
    }
}

/// Places the altar plus [`TREASURE_CONTAINERS_PER_DUNGEON`] treasure
/// containers deterministically within open cells.
///
/// Chest tiles on the finished map are EXACTLY the exported containers:
/// `place_loot_containers` picks dead-end-first positions from still-floor
/// cells, each is stamped [`TileType::Chest`], and every container carries its
/// seeded loot roll so the map payload alone describes all treasure.
fn dress_dungeon(grid: &mut [Vec<TileType>], seed: u64) -> Vec<LootContainer> {
    let height = grid.len();
    let width = grid.first().map(|r| r.len()).unwrap_or(0);
    if width == 0 || height == 0 {
        return Vec::new();
    }

    // Altar first, drawn from a dedicated stream so adding/removing containers
    // never shifts the altar draw.
    let altar = {
        let mut altar_rng = StdRng::seed_from_u64(seed ^ 0xA17A_9000);
        let open: Vec<(usize, usize)> = (0..height)
            .flat_map(|y| (0..width).map(move |x| (x, y)))
            .filter(|&(x, y)| grid[y][x] == TileType::Floor)
            .collect();
        match open.is_empty() {
            true => None,
            false => Some(open[altar_rng.gen_range(0..open.len())]),
        }
    };
    if let Some((ax, ay)) = altar {
        grid[ay][ax] = TileType::Altar;
    }

    let containers = place_loot_containers(grid, seed, TREASURE_CONTAINERS_PER_DUNGEON);
    for c in &containers {
        grid[c.y][c.x] = TileType::Chest;
    }
    containers
}

/// Derives themed room rectangles from the remaining open space.
fn derive_room_descriptors(grid: &[Vec<TileType>]) -> Vec<RoomDescriptor> {
    let height = grid.len();
    let width = grid.first().map(|r| r.len()).unwrap_or(0);
    if width == 0 || height == 0 {
        return Vec::new();
    }

    // Split at the widest internal wall column/row that still leaves two
    // walkable halves; otherwise emit one hall descriptor.
    for mid_x in (2..width.saturating_sub(2)).rev() {
        let left_open = (1..height - 1).any(|y| is_walkable(grid[y][mid_x - 1]));
        let right_open = (1..height - 1).any(|y| is_walkable(grid[y][mid_x + 1]));
        let column_sealed = (1..height - 1).all(|y| !is_walkable(grid[y][mid_x]));
        if column_sealed && left_open && right_open && mid_x > 1 && mid_x + 1 < width - 1 {
            return vec![
                RoomDescriptor {
                    room_id: 1,
                    x: 1,
                    y: 1,
                    width: mid_x - 1,
                    height: height - 2,
                    theme: "West Chamber".to_string(),
                },
                RoomDescriptor {
                    room_id: 2,
                    x: mid_x + 1,
                    y: 1,
                    width: width - mid_x - 2,
                    height: height - 2,
                    theme: "East Chamber".to_string(),
                },
            ];
        }
    }

    vec![RoomDescriptor {
        room_id: 1,
        x: 1,
        y: 1,
        width: width - 2,
        height: height - 2,
        theme: "Great Hall".to_string(),
    }]
}

/// Treasure containers exported per generated dungeon.
pub const TREASURE_CONTAINERS_PER_DUNGEON: usize = 4;

/// Party-level / CR band used for every container's loot roll. Tier 3 keeps
/// generated-dungeon treasure in the low-hero band; the multiplier convention
/// lives in [`loot_tables::treasure_tier_multiplier`].
const TREASURE_TIER: u8 = 3;

/// One placed treasure container: its grid position plus the seeded loot roll
/// it carries (see [`loot_tables::LootTableGenerator::roll_themed_hoard`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LootContainer {
    pub x: usize,
    pub y: usize,
    /// Party-level / CR band used to scale the contents' gp values.
    pub tier: u8,
    pub contents: Vec<loot_tables::LootItem>,
}

/// Deterministic dead-end-first placement of `count` treasure containers.
///
/// Candidates are walkable [`TileType::Floor`] cells with exactly one
/// orthogonal walkable neighbour (dead ends); when those run out, remaining
/// open floor is used so the requested count is honoured whenever the map has
/// enough space. Positions and rolled contents are pure functions of
/// `(grid, seed)` — same inputs, byte-identical payload.
fn place_loot_containers(
    grid: &[Vec<TileType>],
    seed: u64,
    count: usize,
) -> Vec<LootContainer> {
    let height = grid.len();
    let width = grid.first().map(|r| r.len()).unwrap_or(0);
    if width == 0 || height == 0 || count == 0 {
        return Vec::new();
    }

    let mut rng = StdRng::seed_from_u64(seed ^ 0x7EA5_11D0);

    let mut dead_ends = Vec::new();
    let mut open_floor = Vec::new();
    for (y, row) in grid.iter().enumerate() {
        for (x, cell) in row.iter().enumerate() {
            if *cell != TileType::Floor {
                continue;
            }
            let neighbours = [
                x.checked_sub(1).map(|nx| (nx, y)),
                Some((x + 1, y)).filter(|&(nx, _)| nx < width),
                y.checked_sub(1).map(|ny| (x, ny)),
                Some((x, y + 1)).filter(|&(_, ny)| ny < height),
            ];
            let walkable_neighbours = neighbours
                .into_iter()
                .flatten()
                .filter(|&(nx, ny)| is_walkable(grid[ny][nx]))
                .count();
            if walkable_neighbours == 1 {
                dead_ends.push((x, y));
            }
            open_floor.push((x, y));
        }
    }

    // Non-dead-end open floor forms the overflow pool.
    let mut overflow: Vec<(usize, usize)> = open_floor
        .into_iter()
        .filter(|cell| !dead_ends.contains(cell))
        .collect();

    // Deterministic Fisher-Yates shuffles of each pool.
    for pool in [&mut dead_ends, &mut overflow] {
        for i in (1..pool.len()).rev() {
            let j = rng.gen_range(0..=i);
            pool.swap(i, j);
        }
    }

    // Dead ends always outrank ordinary floor regardless of draw order.
    let mut chosen: Vec<(usize, usize)> = Vec::with_capacity(count);
    chosen.extend(dead_ends.into_iter().take(count));
    if chosen.len() < count {
        chosen.extend(overflow.into_iter().take(count - chosen.len()));
    }

    chosen.sort(); // stable export order independent of RNG draw order

    chosen
        .into_iter()
        .enumerate()
        .map(|(slot, (x, y))| LootContainer {
            x,
            y,
            tier: TREASURE_TIER,
            contents: loot_tables::LootTableGenerator::roll_thematic_loot(
                TREASURE_TIER,
                seed ^ mix_container_seed(slot),
            ),
        })
        .collect()
}

/// Per-container seed derivation (SplitMix64 finalizer): distinct draws per
/// container slot without ever reusing the base seed directly.
fn mix_container_seed(slot: usize) -> u64 {
    let mut z = (slot as u64).wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_same_seed_reproduces_identical_map() {
        let gen = DungeonGenerator::new(24, 16);
        let a = gen.generate(1337);
        let b = gen.generate(1337);
        assert_eq!(a.grid, b.grid, "same seed must be byte-identical");
    }

    #[test]
    fn test_different_seeds_diverge() {
        let gen = DungeonGenerator::new(24, 16);
        let seeds = [11u64, 42, 777];
        let maps: Vec<DungeonMap> = seeds.iter().map(|&s| gen.generate(s)).collect();

        let distinct_pairs = (0..maps.len())
            .flat_map(|i| ((i + 1)..maps.len()).map(move |j| (i, j)))
            .filter(|&(i, j)| maps[i].grid != maps[j].grid)
            .count();

        assert!(
            distinct_pairs >= 2,
            "at least 2 of 3 seed pairs must differ — generator may still be constant"
        );
    }

    #[test]
    fn test_perimeter_sealed_and_walkable_region_exists() {
        let gen = DungeonGenerator::new(20, 14);
        for seed in [1u64, 99, 4242] {
            let map = gen.generate(seed);
            for x in 0..20 {
                assert_eq!(map.grid[0][x], TileType::Wall);
                assert_eq!(map.grid[13][x], TileType::Wall);
            }
            for y in 0..14 {
                assert_eq!(map.grid[y][0], TileType::Wall);
                assert_eq!(map.grid[y][19], TileType::Wall);
            }
            let walkables = map
                .grid
                .iter()
                .flatten()
                .filter(|t| is_walkable(**t))
                .count();
            assert!(walkables > 10, "seed {}: playable space required", seed);
        }
    }

    #[test]
    fn test_connectivity_single_region() {
        let gen = DungeonGenerator::new(28, 18);
        for seed in [5u64, 6, 7, 8, 9] {
            let map = gen.generate(seed);
            // Flood fill from the first walkable cell; everything walkable
            // must be reachable.
            let start = (0..map.height)
                .find_map(|y| (0..map.width).find_map(|x| is_walkable(map.grid[y][x]).then_some((x, y))));
            let (sx, sy) = start.expect("walkable space required");
            let mut seen = vec![vec![false; map.width]; map.height];
            let mut stack = vec![(sx, sy)];
            seen[sy][sx] = true;
            while let Some((cx, cy)) = stack.pop() {
                for (nx, ny) in [
                    (cx + 1, cy),
                    (cx.wrapping_sub(1), cy),
                    (cx, cy + 1),
                    (cx, cy.saturating_sub(1)),
                ] {
                    if nx < map.width && ny < map.height && !seen[ny][nx] && is_walkable(map.grid[ny][nx]) {
                        seen[ny][nx] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            for (y, (row, seen_row)) in map.grid.iter().zip(seen.iter()).enumerate() {
                for (x, (cell, reached)) in row.iter().zip(seen_row.iter()).enumerate() {
                    assert!(
                        !is_walkable(*cell) || *reached,
                        "seed {}: unreachable walkable cell at ({},{})",
                        seed,
                        x,
                        y
                    );
                }
            }
        }
    }

    #[test]
    fn generated_maps_export_n_seeded_treasure_containers_on_chest_tiles() {
        let gen = DungeonGenerator::new(24, 16);
        for seed in [1u64, 42, 1337, 90210] {
            let map = gen.generate(seed);
            assert_eq!(
                map.loot_containers.len(),
                TREASURE_CONTAINERS_PER_DUNGEON,
                "seed {}: expected {} exported containers",
                seed,
                TREASURE_CONTAINERS_PER_DUNGEON
            );
            let mut seen = std::collections::HashSet::new();
            for c in &map.loot_containers {
                assert!(c.x < map.width && c.y < map.height, "seed {seed}: out of bounds");
                assert_eq!(
                    map.grid[c.y][c.x],
                    TileType::Chest,
                    "seed {seed}: container at ({},{}) must sit on a chest tile",
                    c.x,
                    c.y
                );
                assert!(
                    seen.insert((c.x, c.y)),
                    "seed {seed}: duplicate container position"
                );
                assert!(
                    !c.contents.is_empty(),
                    "seed {seed}: every exported container carries rolled contents"
                );
                assert!(
                    c.contents.iter().all(|item| item.value_gp > 0),
                    "seed {seed}: rolled contents must carry positive gp values"
                );
            }
            // Every chest tile on the map is accounted for by the payload.
            let chest_tiles: Vec<(usize, usize)> = (0..map.height)
                .flat_map(|y| (0..map.width).map(move |x| (x, y)))
                .filter(|&(x, y)| map.grid[y][x] == TileType::Chest)
                .collect();
            assert_eq!(
                chest_tiles.len(),
                map.loot_containers.len(),
                "seed {seed}: every chest tile must correspond to one exported container"
            );
        }
    }

    #[test]
    fn container_payload_replays_identically_per_seed_and_diverges_across_seeds() {
        let gen = DungeonGenerator::new(24, 16);

        let payload = |m: &DungeonMap| {
            m.loot_containers
                .iter()
                .map(|c| {
                    (
                        c.x,
                        c.y,
                        c.tier,
                        c.contents
                            .iter()
                            .map(|i| (i.name.clone(), i.value_gp, i.quantity))
                            .collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>()
        };

        for seed in [7u64, 555, 31_337] {
            let a = payload(&gen.generate(seed));
            let b = payload(&gen.generate(seed));
            assert_eq!(a, b, "same seed must reproduce the full container payload");
        }

        let mut distinct = std::collections::HashSet::new();
        for seed in 0..40u64 {
            distinct.insert(format!("{:?}", payload(&gen.generate(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15)))));
        }
        assert!(
            distinct.len() >= 20,
            "container payloads barely diverge across seeds: {} distinct of 40",
            distinct.len()
        );
    }

    #[test]
    fn placement_prefers_dead_end_cells_when_available() {
        // Synthetic corridor map: a wide-open hall with a one-cell spur off
        // its west side. With one container requested it must land on the
        // dead-end spur cell (2,3), whose only walkable neighbour is (3,3).
        let mut grid = vec![vec![TileType::Wall; 9]; 7];
        for row in grid.iter_mut().skip(2).take(3) {
            for cell in row.iter_mut().skip(3).take(5) {
                *cell = TileType::Floor;
            }
        }
        grid[3][2] = TileType::Floor;

        let containers = place_loot_containers(&grid, 1234, 1);
        assert_eq!(containers.len(), 1);
        assert_eq!(
            (containers[0].x, containers[0].y),
            (2, 3),
            "sole container must occupy the dead-end cell"
        );

        // With more containers than dead ends, the remainder spill onto open
        // floor rather than being dropped.
        let mut grid2 = vec![vec![TileType::Wall; 9]; 7];
        for row in grid2.iter_mut().skip(2).take(3) {
            for cell in row.iter_mut().skip(3).take(5) {
                *cell = TileType::Floor;
            }
        }
        let many = place_loot_containers(&grid2, 99, 4);
        assert_eq!(many.len(), 4, "overflow placements go to ordinary floor");
        let mut spots = std::collections::HashSet::new();
        for c in &many {
            assert!(spots.insert((c.x, c.y)), "no two containers share a cell");
            assert_eq!(grid2[c.y][c.x], TileType::Floor);
        }
    }

    #[test]
    fn degenerate_grids_place_containers_without_panic_or_overflow() {
        let single = vec![vec![TileType::Floor]];
        assert_eq!(place_loot_containers(&single, 1, TREASURE_CONTAINERS_PER_DUNGEON).len(), 1);

        let sealed = vec![vec![TileType::Wall; 6]; 6];
        assert!(place_loot_containers(&sealed, 1, TREASURE_CONTAINERS_PER_DUNGEON).is_empty());

        let empty: Vec<Vec<TileType>> = Vec::new();
        assert!(place_loot_containers(&empty, 1, 3).is_empty());
    }

    #[test]
    fn test_generate_room_helper() {
        let desc = RoomDescriptor {
            room_id: 1,
            x: 0,
            y: 0,
            width: 12,
            height: 10,
            theme: "Catacombs".to_string(),
        };
        let tiles = DungeonGenerator::generate_room(&desc, Some(42)).unwrap();
        assert_eq!(tiles.len(), 10);
        assert_eq!(tiles[0].len(), 12);
        // u8 encoding contract preserved for the server route.
        assert_eq!(tiles[0][0], 1); // sealed perimeter
    }
}
