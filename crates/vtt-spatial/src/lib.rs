//! # vtt-spatial: High-Performance Spatial Geometry & Line-of-Sight Engine
//!
//! Provides deterministic spatial calculations:
//! - Bresenham and SIMD raycasting on 3D discrete voxel/grid collision maps
//! - Dynamic Cover calculation (No Cover, Half Cover +2 AC, Three-Quarters Cover +5 AC, Total Cover)
//! - A* Pathfinding across variable-cost terrain grids
//! - Topological Zone Graphs and distance range-bands (Engaged, Near, Far, Distant)
//! - Standard D&D 5e area-of-effect templates (Sphere, Cone, Cylinder, Line, Cube)

pub mod cover;
pub mod geometry;
pub mod pathfinding;
pub mod raycast;
pub mod zone_graph;

pub use cover::{CoverCalculator, CoverType};
pub use geometry::{AreaOfEffect, Vector3};
pub use pathfinding::{AStarPathfinder, PathResult, TerrainOverlay};
pub use raycast::GridCollisionMap;
pub use zone_graph::{RangeBand, TopologicalZoneGraph, ZoneEdge, ZoneNode};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_los_and_cover() {
        let mut grid = GridCollisionMap::new(10, 10, 1, 5.0);
        grid.set_solid(5, 5, 0, true);

        let attacker = Vector3::new(2.5, 27.5, 0.0);       // Grid (0, 5)
        let target_direct = Vector3::new(47.5, 27.5, 0.0);   // Grid (9, 5)
        assert!(!grid.has_line_of_sight(&attacker, &target_direct));

        let target_clear = Vector3::new(2.5, 42.5, 0.0);    // Grid (0, 8)
        assert!(grid.has_line_of_sight(&attacker, &target_clear));

        let cover = CoverCalculator::calculate_cover(&grid, &attacker, &target_direct, 5.0);
        assert_eq!(cover, CoverType::HalfCover);
    }

    #[test]
    fn test_astar_pathfinding() {
        let mut grid = GridCollisionMap::new(10, 10, 1, 5.0);
        // Wall from y=0 to y=8 at x=5
        for y in 0..8 {
            grid.set_solid(5, y, 0, true);
        }

        let start = Vector3::new(2.5, 2.5, 0.0);
        let goal = Vector3::new(37.5, 2.5, 0.0);

        let res = AStarPathfinder::find_path(&grid, &start, &goal, 150.0);
        assert!(res.is_reachable);
        assert!(!res.path.is_empty());
        assert!(!res.speed_budget_exceeded);
    }

    #[test]
    fn test_difficult_terrain_weights_movement_budget() {
        let grid = GridCollisionMap::new(10, 10, 1, 5.0);
        let mut terrain = TerrainOverlay::new();
        // A difficult-terrain BELT spanning every row: any path must cross
        // its 3 doubled cells, so detouring cannot dodge the surcharge.
        for y in 0..10 {
            for x in 2..=4 {
                terrain.set_cost(x, y, 0, 2);
            }
        }

        let start = Vector3::new(0.5, 0.5, 0.0);
        let goal = Vector3::new(45.5, 0.5, 0.0);

        let res = AStarPathfinder::find_path_with_terrain(&grid, &terrain, &start, &goal, 50.0);
        assert!(res.is_reachable);

        // 9 hops = 45 ft geometric; the 3 doubled cells push weighted cost
        // to 12 steps = 60 ft.
        assert_eq!(res.total_distance_feet, 45.0);
        assert_eq!(res.movement_cost_feet, 60.0);
        assert!(res.speed_budget_exceeded, "60 ft weighted > 50 ft budget");

        // The same trip on clear ground fits comfortably in the budget.
        let clear = AStarPathfinder::find_path(&grid, &start, &goal, 50.0);
        assert!(!clear.speed_budget_exceeded);
        assert_eq!(clear.movement_cost_feet, 45.0);
    }

    #[test]
    fn test_astar_heuristic_preserves_optimal_paths() {
        let mut grid = GridCollisionMap::new(10, 10, 1, 5.0);
        for y in 0..9 {
            grid.set_solid(5, y, 0, true);
        }

        let start = Vector3::new(0.5, 0.5, 0.0);
        let goal = Vector3::new(45.5, 0.5, 0.0);
        let res = AStarPathfinder::find_path(&grid, &start, &goal, 500.0);
        assert!(res.is_reachable);

        // Only crossing point is (5,9): optimal = manhattan(start→cross) +
        // manhattan(cross→goal) = (5+9) + (4+9) = 27 hops = 135 ft.
        // The heuristic must not cost any optimality.
        let hops = res.path.len() - 1;
        assert_eq!(hops, 27, "A* must return a shortest path");
        assert_eq!(res.movement_cost_feet, 135.0);
    }

    #[test]
    fn test_zone_graph() {
        let mut graph = TopologicalZoneGraph::new();
        graph.add_zone(ZoneNode {
            zone_id: "Tavern_Main".to_string(),
            name: "Main Room".to_string(),
            description: "Crowded tavern".to_string(),
            environmental_tags: vec!["indoor".to_string()],
            max_capacity: Some(20),
            is_hazardous: false,
            hazard_damage_formula: None,
        });
        graph.add_zone(ZoneNode {
            zone_id: "Tavern_Balcony".to_string(),
            name: "Upper Balcony".to_string(),
            description: "Overlooking main room".to_string(),
            environmental_tags: vec!["elevated".to_string()],
            max_capacity: Some(10),
            is_hazardous: false,
            hazard_damage_formula: None,
        });
        graph.add_edge(ZoneEdge {
            from_zone: "Tavern_Main".to_string(),
            to_zone: "Tavern_Balcony".to_string(),
            base_range_band: RangeBand::Near,
            movement_cost_actions: 1,
            is_blocked: false,
            requires_climb_or_fly: true,
        });

        assert_eq!(graph.get_range_between_zones("Tavern_Main", "Tavern_Balcony"), Some(RangeBand::Near));
        assert_eq!(graph.get_range_between_zones("Tavern_Main", "Tavern_Main"), Some(RangeBand::Engaged));
    }
}
