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
pub mod lighting;
pub mod pathfinding;
pub mod raycast;
pub mod visibility;
pub mod zone_graph;
pub use raycast::GridCollisionMap;
pub use visibility::{point_in_polygon, visibility_polygon, visibility_polygon_z};

pub use cover::{CoverCalculator, CoverType};
pub use geometry::{AreaOfEffect, Vector3};
pub use lighting::{cell_visible, LightingOverlay};
// One definition shared with session maps (vtt-core), re-exported for
// spatial callers.
pub use vtt_core::types::{LightingZone, LightingZoneCell, VisionMode};
pub use pathfinding::{AStarPathfinder, PathResult, TerrainOverlay};
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

    // ------------------------------------------------------- lighting + vision

    const UNLIMITED: f32 = f32::INFINITY;

    /// Viewer at cell (0,0), target at cell (2,0) — 10 ft apart on a 5 ft grid.
    fn lit_grid() -> GridCollisionMap {
        GridCollisionMap::new(10, 10, 1, 5.0)
    }

    fn viewer() -> Vector3 {
        Vector3::new(2.5, 2.5, 0.0)
    }

    fn dark_target() -> Vector3 {
        Vector3::new(12.5, 2.5, 0.0)
    }

    #[test]
    fn test_lighting_overlay_absent_cells_are_bright() {
        let mut overlay = LightingOverlay::new();
        assert_eq!(overlay.zone_at(3, 4, 0), LightingZone::Bright);
        overlay.set_zone(3, 4, 0, LightingZone::MagicalDarkness);
        assert_eq!(overlay.zone_at(3, 4, 0), LightingZone::MagicalDarkness);
        // Neighbors stay Bright — the overlay is per-cell.
        assert_eq!(overlay.zone_at(3, 5, 0), LightingZone::Bright);
    }

    #[test]
    fn test_cell_visible_matrix_across_modes_zones_and_ranges() {
        use VisionMode::*;
        // Bright and Dim are visible to every mode at any distance.
        for zone in [LightingZone::Bright, LightingZone::Dim] {
            for mode in [Normal, Darkvision, Blindsight, Truesight] {
                assert!(
                    cell_visible(zone, mode, 30.0, 500.0),
                    "{:?} must see {:?} at any distance",
                    mode,
                    zone
                );
            }
        }

        // Darkness: invisible to Normal; visible to the special senses WITHIN
        // their range; beyond range every sense reverts to normal sight.
        for (mode, range) in [(Normal, UNLIMITED), (Darkvision, 60.0), (Blindsight, 30.0), (Truesight, 60.0)] {
            let expect = mode != Normal;
            assert_eq!(
                cell_visible(LightingZone::Darkness, mode, range, 10.0),
                expect,
                "darkness @10ft for {:?}",
                mode
            );
            if mode != Normal {
                assert!(!cell_visible(LightingZone::Darkness, mode, range, range + 0.1));
            }
        }

        // Magical darkness: only Truesight (and Blindsight, which does not
        // rely on sight) penetrates — Darkvision does NOT.
        assert!(!cell_visible(LightingZone::MagicalDarkness, Darkvision, 120.0, 10.0));
        assert!(!cell_visible(LightingZone::MagicalDarkness, Normal, UNLIMITED, 10.0));
        assert!(cell_visible(LightingZone::MagicalDarkness, Truesight, 60.0, 10.0));
        assert!(cell_visible(LightingZone::MagicalDarkness, Blindsight, 30.0, 10.0));
        // ...but even Truesight/Blindsight fail beyond their range.
        assert!(!cell_visible(LightingZone::MagicalDarkness, Truesight, 60.0, 60.1));
        assert!(!cell_visible(LightingZone::MagicalDarkness, Blindsight, 30.0, 30.1));
    }

    #[test]
    fn test_darkvision_sees_into_darkness_while_normal_sight_cannot() {
        let grid = lit_grid();
        let mut lighting = LightingOverlay::new();
        lighting.set_zone(2, 0, 0, LightingZone::Darkness);

        assert!(
            !grid.has_line_of_sight_with_lighting(&lighting, VisionMode::Normal, UNLIMITED, &viewer(), &dark_target()),
            "normal sight must not reach into a darkness cell"
        );
        assert!(
            grid.has_line_of_sight_with_lighting(&lighting, VisionMode::Darkvision, 60.0, &viewer(), &dark_target()),
            "in-range darkvision must see into darkness"
        );
        assert!(
            !grid.has_line_of_sight_with_lighting(&lighting, VisionMode::Darkvision, 5.0, &viewer(), &dark_target()),
            "darkvision beyond its range reverts to normal sight"
        );
    }

    #[test]
    fn test_magical_darkness_blocks_darkvision_but_not_truesight_or_blindsight() {
        let grid = lit_grid();
        let mut lighting = LightingOverlay::new();
        lighting.set_zone(2, 0, 0, LightingZone::MagicalDarkness);

        assert!(!grid.has_line_of_sight_with_lighting(
            &lighting, VisionMode::Darkvision, 120.0, &viewer(), &dark_target()
        ));
        assert!(grid.has_line_of_sight_with_lighting(
            &lighting, VisionMode::Truesight, 60.0, &viewer(), &dark_target()
        ));
        assert!(grid.has_line_of_sight_with_lighting(
            &lighting, VisionMode::Blindsight, 30.0, &viewer(), &dark_target()
        ));
    }

    #[test]
    fn test_darkness_wall_mid_path_blocks_normal_sight() {
        // A belt of darkness BETWEEN viewer and a lit target: normal sight
        // cannot see through heavily obscured cells either.
        let grid = lit_grid();
        let mut lighting = LightingOverlay::new();
        lighting.set_zone(1, 0, 0, LightingZone::Darkness);
        // The target cell itself is lit.
        assert!(!grid.has_line_of_sight_with_lighting(
            &lighting, VisionMode::Normal, UNLIMITED, &viewer(), &dark_target()
        ));

        // A dim belt is mere obscurement — sight still reaches through it.
        let mut dim = LightingOverlay::new();
        dim.set_zone(1, 0, 0, LightingZone::Dim);
        assert!(grid.has_line_of_sight_with_lighting(
            &dim, VisionMode::Normal, UNLIMITED, &viewer(), &dark_target()
        ));
    }

    #[test]
    fn test_walls_still_block_every_vision_mode() {
        let mut grid = lit_grid();
        grid.set_solid(1, 0, 0, true); // wall between viewer and target
        let mut lighting = LightingOverlay::new();
        lighting.set_zone(2, 0, 0, LightingZone::MagicalDarkness);

        for mode in [VisionMode::Truesight, VisionMode::Blindsight] {
            assert!(
                !grid.has_line_of_sight_with_lighting(&lighting, mode, 120.0, &viewer(), &dark_target()),
                "{:?} must still be stopped by a physical wall",
                mode
            );
        }
    }

    #[test]
    fn test_empty_lighting_overlay_matches_plain_los_backcompat() {
        let empty = GridCollisionMap::new(10, 10, 1, 5.0);
        let mut walled = GridCollisionMap::new(10, 10, 1, 5.0);
        walled.set_solid(5, 5, 0, true);

        let no_overlay = LightingOverlay::new();
        for (grid, from, to) in [
            (
                &empty as &GridCollisionMap,
                viewer(),
                dark_target(),
            ),
            (
                &walled as &GridCollisionMap,
                viewer(),
                Vector3::new(27.5, 27.5, 0.0),
            ),
        ] {
            for mode in [VisionMode::Normal, VisionMode::Darkvision, VisionMode::Blindsight, VisionMode::Truesight] {
                assert_eq!(
                    grid.has_line_of_sight(&from, &to),
                    grid.has_line_of_sight_with_lighting(&no_overlay, mode, UNLIMITED, &from, &to),
                    "absent lighting must behave exactly like plain LoS ({:?})",
                    mode
                );
            }
        }
    }
}
