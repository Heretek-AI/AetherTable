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
                for x in 0..self.width {
                    grid[0][x] = TileType::Wall;
                    grid[self.height - 1][x] = TileType::Wall;
                }
                for y in 0..self.height {
                    grid[y][0] = TileType::Wall;
                    grid[y][self.width - 1] = TileType::Wall;
                }
                return DungeonMap {
                    width: self.width,
                    height: self.height,
                    grid,
                    seed,
                    rooms: derive_room_descriptors_fallback(self.width, self.height),
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

        // Deterministic dressing inside the walkable region.
        dress_dungeon(&mut grid, seed);

        let rooms = derive_room_descriptors(&grid);

        DungeonMap {
            width: self.width,
            height: self.height,
            grid,
            seed,
            rooms,
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

/// Places an altar and a few chests deterministically within open cells.
fn dress_dungeon(grid: &mut [Vec<TileType>], seed: u64) {
    let height = grid.len();
    let width = grid.first().map(|r| r.len()).unwrap_or(0);
    if width == 0 || height == 0 {
        return;
    }

    let mut rng = StdRng::seed_from_u64(seed ^ 0xD00D_5EED);
    let open_cells: Vec<(usize, usize)> = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .filter(|&(x, y)| grid[y][x] == TileType::Floor)
        .collect();
    if open_cells.is_empty() {
        return;
    }

    let pick = |rng: &mut StdRng| open_cells[rng.gen_range(0..open_cells.len())];

    let altar = pick(&mut rng);
    grid[altar.1][altar.0] = TileType::Altar;

    let chest_count = rng.gen_range(1..=3);
    for _ in 0..chest_count {
        let cell = pick(&mut rng);
        if grid[cell.1][cell.0] == TileType::Floor {
            grid[cell.1][cell.0] = TileType::Chest;
        }
    }
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
            for y in 0..map.height {
                for x in 0..map.width {
                    assert!(
                        !is_walkable(map.grid[y][x]) || seen[y][x],
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
