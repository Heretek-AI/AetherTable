use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WfcTile {
    pub tile_id: String,
    pub socket_north: String,
    pub socket_east: String,
    pub socket_south: String,
    pub socket_west: String,
    pub socket_top: String,
    pub socket_bottom: String,
    pub symmetry_type: String, // "X", "I", "L", "T", "\\", "F"
    pub weight: f64,
    pub movement_cost_modifier: f32,
    pub blocks_line_of_sight: bool,
    pub is_door: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TileVariant {
    pub base_tile_id: String,
    pub rotation: u8, // 0, 90, 180, 270 (0, 1, 2, 3)
    pub socket_north: String,
    pub socket_east: String,
    pub socket_south: String,
    pub socket_west: String,
    pub socket_top: String,
    pub socket_bottom: String,
    pub weight: f64,
    pub movement_cost_modifier: f32,
    pub blocks_line_of_sight: bool,
    pub is_door: bool,
}

/// Socket scheme: exact-match sockets ("open"/"open") with "any" wildcards
/// on structural tiles so walls never force contradictions at sealed borders.
/// Layout variety is driven by tile weights and the entropy collapse order;
/// the solver seals the perimeter and post-generation flood-fill guarantees
/// a single walkable region joined by doors.
pub fn default_dungeon_tileset() -> Vec<WfcTile> {
    vec![
        WfcTile {
            tile_id: "tile_floor".to_string(),
            socket_north: "open".to_string(),
            socket_east: "open".to_string(),
            socket_south: "open".to_string(),
            socket_west: "open".to_string(),
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
            socket_north: "any".to_string(),
            socket_east: "any".to_string(),
            socket_south: "any".to_string(),
            socket_west: "any".to_string(),
            socket_top: "solid".to_string(),
            socket_bottom: "foundation".to_string(),
            symmetry_type: "X".to_string(),
            weight: 3.0,
            movement_cost_modifier: 999.0,
            blocks_line_of_sight: true,
            is_door: false,
            tags: vec!["wall".to_string()],
        },
        WfcTile {
            tile_id: "tile_door".to_string(),
            socket_north: "open".to_string(),
            socket_east: "any".to_string(),
            socket_south: "open".to_string(),
            socket_west: "any".to_string(),
            socket_top: "solid".to_string(),
            socket_bottom: "foundation".to_string(),
            symmetry_type: "I".to_string(),
            weight: 1.0,
            movement_cost_modifier: 1.0,
            blocks_line_of_sight: true,
            is_door: true,
            tags: vec!["door".to_string()],
        },
        WfcTile {
            tile_id: "tile_rubble".to_string(),
            socket_north: "open".to_string(),
            socket_east: "open".to_string(),
            socket_south: "any".to_string(),
            socket_west: "any".to_string(),
            socket_top: "air".to_string(),
            socket_bottom: "foundation".to_string(),
            symmetry_type: "L".to_string(),
            weight: 1.5,
            movement_cost_modifier: 2.0,
            blocks_line_of_sight: false,
            is_door: false,
            tags: vec!["rubble".to_string(), "difficult_terrain".to_string()],
        },
    ]
}

impl WfcTile {
    pub fn generate_variants(&self) -> Vec<TileVariant> {        let rotations = match self.symmetry_type.as_str() {
            "X" => vec![0],
            "I" => vec![0, 1],
            "\\" => vec![0, 1],
            "L" | "T" | "F" => vec![0, 1, 2, 3],
            _ => vec![0],
        };

        rotations.into_iter().map(|rot| {
            let (n, e, s, w) = match rot {
                0 => (self.socket_north.clone(), self.socket_east.clone(), self.socket_south.clone(), self.socket_west.clone()),
                1 => (self.socket_west.clone(), self.socket_north.clone(), self.socket_east.clone(), self.socket_south.clone()),
                2 => (self.socket_south.clone(), self.socket_west.clone(), self.socket_north.clone(), self.socket_east.clone()),
                3 => (self.socket_east.clone(), self.socket_south.clone(), self.socket_west.clone(), self.socket_north.clone()),
                _ => (self.socket_north.clone(), self.socket_east.clone(), self.socket_south.clone(), self.socket_west.clone()),
            };

            TileVariant {
                base_tile_id: self.tile_id.clone(),
                rotation: rot,
                socket_north: n,
                socket_east: e,
                socket_south: s,
                socket_west: w,
                socket_top: self.socket_top.clone(),
                socket_bottom: self.socket_bottom.clone(),
                weight: self.weight,
                movement_cost_modifier: self.movement_cost_modifier,
                blocks_line_of_sight: self.blocks_line_of_sight,
                is_door: self.is_door,
            }
        }).collect()
    }
}
