use crate::geometry::Vector3;
use crate::raycast::GridCollisionMap;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

#[derive(Clone, Eq, PartialEq)]
struct Node {
    /// Priority = g + h: cost so far plus the admissible heuristic.
    priority: usize,
    g_cost: usize,
    pos: (usize, usize, usize),
}

impl Ord for Node {
    fn cmp(&self, other: &Self) -> Ordering {
        other.priority.cmp(&self.priority)
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Admissible Manhattan heuristic in grid steps. Every step costs at least 1
/// movement point regardless of terrain, so this never overestimates the
/// remaining weighted cost and A* stays optimal.
fn manhattan_heuristic(a: (usize, usize, usize), b: (usize, usize, usize)) -> usize {
    a.0.abs_diff(b.0) + a.1.abs_diff(b.1) + a.2.abs_diff(b.2)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PathResult {
    pub path: Vec<Vector3>,
    /// Geometric path length (hops × cell size), ignoring terrain.
    pub total_distance_feet: f32,
    /// Terrain-weighted movement expenditure (Σ step costs × cell size) —
    /// this is what the speed budget actually consumes on difficult terrain.
    #[serde(default)]
    pub movement_cost_feet: f32,
    pub is_reachable: bool,
    pub speed_budget_exceeded: bool,
}

pub struct AStarPathfinder;

/// Per-cell movement cost overlay for difficult terrain. A cost of 2 means
/// "each step into this cell consumes 2 steps of movement" (SRD difficult
/// terrain). Cells absent from the map cost 1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TerrainOverlay {
    pub costs: HashMap<(usize, usize, usize), u32>,
}

impl TerrainOverlay {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_cost(&mut self, x: usize, y: usize, z: usize, cost: u32) {
        self.costs.insert((x, y, z), cost.max(1));
    }

    fn step_cost(&self, pos: (usize, usize, usize)) -> usize {
        *self.costs.get(&pos).unwrap_or(&1) as usize
    }
}

impl AStarPathfinder {
    pub fn find_path(
        grid: &GridCollisionMap,
        start_world: &Vector3,
        end_world: &Vector3,
        speed_budget_feet: f32,
    ) -> PathResult {
        Self::find_path_with_terrain(grid, &TerrainOverlay::new(), start_world, end_world, speed_budget_feet)
    }

    /// Dijkstra pathfinding honoring per-cell difficult-terrain multipliers.
    /// Movement cost accumulates `step_cost` per entered cell so a 2x-cost
    /// cell consumes twice the speed budget.
    pub fn find_path_with_terrain(
        grid: &GridCollisionMap,
        terrain: &TerrainOverlay,
        start_world: &Vector3,
        end_world: &Vector3,
        speed_budget_feet: f32,
    ) -> PathResult {        let start = grid.world_to_grid(start_world);
        let goal = grid.world_to_grid(end_world);

        if grid.is_solid(start.0, start.1, start.2) || grid.is_solid(goal.0, goal.1, goal.2) {
            return PathResult {
                path: Vec::new(),
                total_distance_feet: 0.0,
                movement_cost_feet: 0.0,
                is_reachable: false,
                speed_budget_exceeded: false,
            };
        }

        let mut dist: HashMap<(usize, usize, usize), usize> = HashMap::new();
        let mut came_from: HashMap<(usize, usize, usize), (usize, usize, usize)> = HashMap::new();
        let mut heap = BinaryHeap::new();

        dist.insert(start, 0);
        heap.push(Node {
            priority: manhattan_heuristic(start, goal),
            g_cost: 0,
            pos: start,
        });

        let neighbors_offset: [(i32, i32, i32); 6] = [
            (1, 0, 0), (-1, 0, 0),
            (0, 1, 0), (0, -1, 0),
            (0, 0, 1), (0, 0, -1),
        ];

        let mut found = false;

        while let Some(Node { g_cost, pos, .. }) = heap.pop() {
            if pos == goal {
                found = true;
                break;
            }

            if let Some(&d) = dist.get(&pos) {
                if g_cost > d {
                    continue;
                }
            }

            for (dx, dy, dz) in &neighbors_offset {
                let nx = pos.0 as i32 + dx;
                let ny = pos.1 as i32 + dy;
                let nz = pos.2 as i32 + dz;

                if nx >= 0 && nx < grid.width as i32 &&
                   ny >= 0 && ny < grid.height as i32 &&
                   nz >= 0 && nz < grid.depth as i32 {
                    let npos = (nx as usize, ny as usize, nz as usize);
                    if !grid.is_solid(npos.0, npos.1, npos.2) {
                        let next_g = g_cost + terrain.step_cost(npos);
                        if next_g < *dist.get(&npos).unwrap_or(&usize::MAX) {
                            dist.insert(npos, next_g);
                            came_from.insert(npos, pos);
                            heap.push(Node {
                                priority: next_g + manhattan_heuristic(npos, goal),
                                g_cost: next_g,
                                pos: npos,
                            });
                        }
                    }
                }
            }
        }

        if !found {
            return PathResult {
                path: Vec::new(),
                total_distance_feet: 0.0,
                movement_cost_feet: 0.0,
                is_reachable: false,
                speed_budget_exceeded: false,
            };
        }

        // Reconstruct path
        let mut curr = goal;
        let mut grid_path = vec![curr];
        while let Some(&prev) = came_from.get(&curr) {
            grid_path.push(prev);
            curr = prev;
        }
        grid_path.reverse();

        let world_path: Vec<Vector3> = grid_path
            .iter()
            .map(|&(x, y, z)| Vector3::new(
                x as f32 * grid.cell_size_feet + grid.cell_size_feet / 2.0,
                y as f32 * grid.cell_size_feet + grid.cell_size_feet / 2.0,
                z as f32 * grid.cell_size_feet + grid.cell_size_feet / 2.0,
            ))
            .collect();

        let total_distance = (world_path.len().saturating_sub(1) as f32) * grid.cell_size_feet;
        // The speed budget consumes TERRAIN-WEIGHTED cost, never raw hops.
        let weighted_cost = dist.get(&goal).copied().unwrap_or(0) as f32 * grid.cell_size_feet;
        let budget_exceeded = weighted_cost > speed_budget_feet;

        PathResult {
            path: world_path,
            total_distance_feet: total_distance,
            movement_cost_feet: weighted_cost,
            is_reachable: true,
            speed_budget_exceeded: budget_exceeded,
        }
    }
}
