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

impl WfcTile {
    pub fn generate_variants(&self) -> Vec<TileVariant> {
        let rotations = match self.symmetry_type.as_str() {
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
