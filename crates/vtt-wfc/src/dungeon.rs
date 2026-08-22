use crate::solver::WfcSolver;
use crate::tile::{TileVariant, WfcTile};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomDescriptor {
    pub name: String,
    pub width: usize,
    pub height: usize,
    pub theme: String,
    pub has_doors: bool,
}

pub struct DungeonGenerator;

impl DungeonGenerator {
    pub fn default_tileset() -> Vec<WfcTile> {
        vec![
            WfcTile {
                tile_id: "tile_floor".to_string(),
                socket_north: "floor".to_string(),
                socket_east: "floor".to_string(),
                socket_south: "floor".to_string(),
                socket_west: "floor".to_string(),
                socket_top: "air".to_string(),
                socket_bottom: "foundation".to_string(),
                symmetry_type: "X".to_string(),
                weight: 5.0,
                movement_cost_modifier: 1.0,
                blocks_line_of_sight: false,
                is_door: false,
                tags: vec!["floor".to_string()],
            },
            WfcTile {
                tile_id: "tile_wall".to_string(),
                socket_north: "wall".to_string(),
                socket_east: "wall".to_string(),
                socket_south: "wall".to_string(),
                socket_west: "wall".to_string(),
                socket_top: "solid".to_string(),
                socket_bottom: "foundation".to_string(),
                symmetry_type: "X".to_string(),
                weight: 2.0,
                movement_cost_modifier: 999.0,
                blocks_line_of_sight: true,
                is_door: false,
                tags: vec!["wall".to_string()],
            },
            WfcTile {
                tile_id: "tile_door".to_string(),
                socket_north: "floor".to_string(),
                socket_east: "wall".to_string(),
                socket_south: "floor".to_string(),
                socket_west: "wall".to_string(),
                socket_top: "solid".to_string(),
                socket_bottom: "foundation".to_string(),
                symmetry_type: "I".to_string(),
                weight: 1.0,
                movement_cost_modifier: 1.0,
                blocks_line_of_sight: true,
                is_door: true,
                tags: vec!["door".to_string()],
            },
        ]
    }

    pub fn generate_room(desc: &RoomDescriptor, seed: Option<u64>) -> Result<Vec<TileVariant>, String> {
        let tiles = Self::default_tileset();
        let mut variants = Vec::new();
        for t in &tiles {
            variants.extend(t.generate_variants());
        }

        let mut solver = WfcSolver::new(desc.width, desc.height, variants, seed);
        let res = solver.solve()?;
        Ok(res.grid)
    }
}
