use crate::geometry::Vector3;
use crate::raycast::GridCollisionMap;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

#[derive(Clone, Eq, PartialEq)]
struct Node {
    cost: usize,
    pos: (usize, usize, usize),
}

impl Ord for Node {
    fn cmp(&self, other: &Self) -> Ordering {
        other.cost.cmp(&self.cost)
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PathResult {
    pub path: Vec<Vector3>,
    pub total_distance_feet: f32,
    pub is_reachable: bool,
    pub speed_budget_exceeded: bool,
}

pub struct AStarPathfinder;

impl AStarPathfinder {
    pub fn find_path(
        grid: &GridCollisionMap,
        start_world: &Vector3,
        end_world: &Vector3,
        speed_budget_feet: f32,
    ) -> PathResult {
        let start = grid.world_to_grid(start_world);
        let goal = grid.world_to_grid(end_world);

        if grid.is_solid(start.0, start.1, start.2) || grid.is_solid(goal.0, goal.1, goal.2) {
            return PathResult {
                path: Vec::new(),
                total_distance_feet: 0.0,
                is_reachable: false,
                speed_budget_exceeded: false,
            };
        }

        let mut dist: HashMap<(usize, usize, usize), usize> = HashMap::new();
        let mut came_from: HashMap<(usize, usize, usize), (usize, usize, usize)> = HashMap::new();
        let mut heap = BinaryHeap::new();

        dist.insert(start, 0);
        heap.push(Node { cost: 0, pos: start });

        let neighbors_offset: [(i32, i32, i32); 6] = [
            (1, 0, 0), (-1, 0, 0),
            (0, 1, 0), (0, -1, 0),
            (0, 0, 1), (0, 0, -1),
        ];

        let mut found = false;

        while let Some(Node { cost, pos }) = heap.pop() {
            if pos == goal {
                found = true;
                break;
            }

            if let Some(&d) = dist.get(&pos) {
                if cost > d {
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
                        let next_cost = cost + 1;
                        if next_cost < *dist.get(&npos).unwrap_or(&usize::MAX) {
                            dist.insert(npos, next_cost);
                            came_from.insert(npos, pos);
                            heap.push(Node { cost: next_cost, pos: npos });
                        }
                    }
                }
            }
        }

        if !found {
            return PathResult {
                path: Vec::new(),
                total_distance_feet: 0.0,
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
        let budget_exceeded = total_distance > speed_budget_feet;

        PathResult {
            path: world_path,
            total_distance_feet: total_distance,
            is_reachable: true,
            speed_budget_exceeded: budget_exceeded,
        }
    }
}
