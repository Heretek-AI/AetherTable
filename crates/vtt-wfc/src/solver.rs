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

    pub fn solve(&mut self) -> Result<WfcGridResult, String> {
        let total_cells = self.width * self.height;
        if self.variants.is_empty() {
            return Err("No tile variants available for WFC".to_string());
        }

        // Each cell starts with all variants possible
        let mut possibilities: Vec<Vec<usize>> = vec![(0..self.variants.len()).collect(); total_cells];

        for _ in 0..total_cells {
            // Find cell with minimum non-zero entropy > 1
            let mut min_entropy = f64::MAX;
            let mut min_cell = None;

            for (idx, poss) in possibilities.iter().enumerate() {
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
                None => break, // All collapsed
            };

            // Collapse cell
            let poss = &possibilities[cell_to_collapse];
            let total_w: f64 = poss.iter().map(|&i| self.variants[i].weight).sum();
            let mut roll = self.rng.gen_range(0.0..total_w);
            let mut chosen = poss[0];
            for &idx in poss {
                roll -= self.variants[idx].weight;
                if roll <= 0.0 {
                    chosen = idx;
                    break;
                }
            }

            possibilities[cell_to_collapse] = vec![chosen];

            // Propagate constraints
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
                                    0 => c_var.socket_north == n_var.socket_south,
                                    1 => c_var.socket_east == n_var.socket_west,
                                    2 => c_var.socket_south == n_var.socket_north,
                                    3 => c_var.socket_west == n_var.socket_east,
                                    _ => false,
                                }
                            });
                            if is_compatible {
                                valid_n_poss.push(n_var_idx);
                            }
                        }

                        if valid_n_poss.is_empty() {
                            // Fallback on boundary constraint: retain chosen variant or most weighted
                            valid_n_poss.push(n_poss[0]);
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
            .map(|p| self.variants[p[0]].clone())
            .collect();

        Ok(WfcGridResult {
            width: self.width,
            height: self.height,
            grid: resolved_grid,
        })
    }
}
