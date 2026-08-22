pub mod cover;
pub mod geometry;
pub mod pathfinding;
pub mod raycast;
pub mod zone_graph;

pub use cover::{CoverCalculator, CoverType};
pub use geometry::{AreaOfEffect, Vector3};
pub use pathfinding::{AStarPathfinder, PathResult};
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
