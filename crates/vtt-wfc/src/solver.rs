//! Socket-matching Wave Function Collapse solver with restart-on-contradiction
//! semantics (matching kahuna/simple_wfc conventions): a constraint conflict
//! fails the attempt deterministically and `solve_with_retries` reseeds from
//! the master seed until a consistent global arrangement is found.

use crate::tile::TileVariant;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WfcGridResult {
    pub width: usize,
    pub height: usize,
    pub grid: Vec<TileVariant>,
}

pub struct WfcSolver {
    pub width: usize,
    pub height: usize,
    pub variants: Vec<TileVariant>,
    rng: StdRng,
}

/// SplitMix64 finalizer — deterministic per-attempt reseeding.
fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Socket compatibility: exact match, with "any" as a wildcard so structural
/// tiles (walls) never force contradictions at sealed borders — variety is
/// driven by weights instead.
fn sockets_match(a: &str, b: &str) -> bool {
    a == b || a == "any" || b == "any"
}

impl WfcSolver {
    pub fn new(width: usize, height: usize, variants: Vec<TileVariant>, seed: Option<u64>) -> Self {
        let rng = match seed {
            Some(s) => StdRng::seed_from_u64(s),
            None => StdRng::from_entropy(),
        };

        Self {
            width,
            height,
            variants,
            rng,
        }
    }

    /// Single attempt. On a constraint contradiction this returns
    /// `Err(WFC_CONTRADICTION)` — callers retry via [`solve_with_retries`].
    pub fn solve(&mut self) -> Result<WfcGridResult, String> {
        let total_cells = self.width * self.height;
        if self.variants.is_empty() {
            return Err("No tile variants available for WFC".to_string());
        }

        // Each cell starts with all variants possible.
        let mut possibilities: Vec<Vec<usize>> = vec![(0..self.variants.len()).collect(); total_cells];

        // Deterministic structure: seal the perimeter with wall tiles so every
        // dungeon is enclosed regardless of interior collapse outcomes.
        let wall_variants: Vec<usize> = self
            .variants
            .iter()
            .enumerate()
            .filter(|(_, v)| v.base_tile_id.contains("wall"))
            .map(|(i, _)| i)
            .collect();
        if !wall_variants.is_empty() {
            for y in 0..self.height {
                for x in 0..self.width {
                    if x == 0 || y == 0 || x == self.width - 1 || y == self.height - 1 {
                        possibilities[y * self.width + x] = wall_variants.clone();
                    }
                }
            }
        }

        for _ in 0..total_cells {
            // Find the frontier cell with minimum entropy > 1.
            let mut min_entropy = f64::MAX;
            let mut min_cell: Option<usize> = None;

            for (idx, poss) in possibilities.iter().enumerate() {
                debug_assert!(
                    !poss.is_empty(),
                    "empty domains must abort as contradictions immediately"
                );
                if poss.len() > 1 {
                    let entropy = poss.len() as f64 + self.rng.gen_range(0.0..0.01);
                    if entropy < min_entropy {
                        min_entropy = entropy;
                        min_cell = Some(idx);
                    }
                }
            }

            let cell_to_collapse = match min_cell {
                Some(c) => c,
                None => break, // everything is down to a single candidate
            };

            // Weighted roulette over the remaining candidates.
            let poss = &possibilities[cell_to_collapse];
            let total_w: f64 = poss.iter().map(|&i| self.variants[i].weight).sum();
            let chosen = if total_w <= 0.0 {
                poss[0]
            } else {
                let mut roll = self.rng.gen_range(0.0..total_w);
                let mut picked = *poss.last().expect("non-empty checked");
                for &idx in poss {
                    roll -= self.variants[idx].weight;
                    if roll <= 0.0 {
                        picked = idx;
                        break;
                    }
                }
                picked
            };

            possibilities[cell_to_collapse] = vec![chosen];

            // Propagate constraints through the neighborhood.
            let mut stack = vec![cell_to_collapse];
            while let Some(curr) = stack.pop() {
                let cx = curr % self.width;
                let cy = curr / self.width;

                let neighbors = [
                    (cx as i32, cy as i32 - 1, 0), // North
                    (cx as i32 + 1, cy as i32, 1), // East
                    (cx as i32, cy as i32 + 1, 2), // South
                    (cx as i32 - 1, cy as i32, 3), // West
                ];

                for &(nx, ny, dir) in &neighbors {
                    if nx >= 0 && nx < self.width as i32 && ny >= 0 && ny < self.height as i32 {
                        let n_idx = (ny as usize) * self.width + (nx as usize);
                        let n_poss = possibilities[n_idx].clone();
                        let curr_poss = &possibilities[curr];

                        let mut valid_n_poss = Vec::new();
                        for &n_var_idx in &n_poss {
                            let n_var = &self.variants[n_var_idx];
                            let is_compatible = curr_poss.iter().any(|&c_var_idx| {
                                let c_var = &self.variants[c_var_idx];
                                match dir {
                                    0 => sockets_match(&c_var.socket_north, &n_var.socket_south),
                                    1 => sockets_match(&c_var.socket_east, &n_var.socket_west),
                                    2 => sockets_match(&c_var.socket_south, &n_var.socket_north),
                                    3 => sockets_match(&c_var.socket_west, &n_var.socket_east),
                                    _ => false,
                                }
                            });
                            if is_compatible {
                                valid_n_poss.push(n_var_idx);
                            }
                        }

                        if valid_n_poss.is_empty() {
                            // A neighbor with zero compatible candidates is a
                            // genuine contradiction — fail the attempt instead
                            // of papering over it with an incompatible tile.
                            return Err("WFC_CONTRADICTION".to_string());
                        }

                        if valid_n_poss.len() < n_poss.len() {
                            possibilities[n_idx] = valid_n_poss;
                            stack.push(n_idx);
                        }
                    }
                }
            }
        }

        let resolved_grid: Vec<TileVariant> = possibilities
            .into_iter()
            .map(|p| {
                // Single-candidate cells resolve directly; anything else picks
                // its highest-weight candidate (deterministic tie-break).
                if p.len() == 1 {
                    self.variants[p[0]].clone()
                } else {
                    let best = p
                        .iter()
                        .copied()
                        .max_by(|&a, &b| {
                            self.variants[a]
                                .weight
                                .partial_cmp(&self.variants[b].weight)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        })
                        .expect("cells never end empty");
                    self.variants[best].clone()
                }
            })
            .collect();

        Ok(WfcGridResult {
            width: self.width,
            height: self.height,
            grid: resolved_grid,
        })
    }

    /// Restarts on contradiction with deterministic per-attempt reseeds.
    /// Same master seed ⇒ same attempt sequence ⇒ reproducible maps.
    pub fn solve_with_retries(&mut self, max_attempts: u32, master_seed: u64) -> Result<WfcGridResult, String> {
        for attempt in 0..max_attempts {
            let sub_seed = splitmix64(master_seed ^ ((attempt as u64) << 32));
            self.rng = StdRng::seed_from_u64(sub_seed);
            match self.solve() {
                Ok(result) => return Ok(result),
                Err(e) if e == "WFC_CONTRADICTION" => continue,
                Err(other) => return Err(other),
            }
        }
        Err(format!("WFC_CONTRADICTION_EXHAUSTED after {} attempts", max_attempts))
    }
}
