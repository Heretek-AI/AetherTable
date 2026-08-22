pub mod dungeon;
pub mod solver;
pub mod tile;

pub use dungeon::{DungeonGenerator, RoomDescriptor};
pub use solver::{WfcGridResult, WfcSolver};
pub use tile::{TileVariant, WfcTile};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wfc_synthesis() {
        let desc = RoomDescriptor {
            name: "Boss Chamber".to_string(),
            width: 6,
            height: 6,
            theme: "dungeon".to_string(),
            has_doors: true,
        };

        let result = DungeonGenerator::generate_room(&desc, Some(42));
        assert!(result.is_ok());
        let grid = result.unwrap();
        assert_eq!(grid.len(), 36);
    }
}
