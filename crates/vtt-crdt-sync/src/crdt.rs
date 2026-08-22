use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VectorClock {
    pub client_id: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenTransform {
    pub token_id: Uuid,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub rotation: f32,
    pub scale: f32,
    pub elevation: f32,
    pub vector_clock: VectorClock,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserCursor {
    pub client_id: u64,
    pub user_name: String,
    pub x: f32,
    pub y: f32,
    pub color_hex: String,
    pub active_tool: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FogOfWarMask {
    pub layer_id: String,
    pub revealed_polygons: Vec<Vec<(f32, f32)>>,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum CrdtSyncMessage {
    SyncStep1 { state_vector: HashMap<u64, u64> },
    SyncStep2 { update_bytes: Vec<u8> },
    TokenUpdate(TokenTransform),
    CursorAwareness(UserCursor),
    FogUpdate(FogOfWarMask),
    Heartbeat { timestamp_ms: u64 },
}

#[derive(Debug, Clone, Default)]
pub struct RoomCrdtState {
    pub room_id: String,
    pub token_transforms: HashMap<Uuid, TokenTransform>,
    pub user_cursors: HashMap<u64, UserCursor>,
    pub fog_masks: HashMap<String, FogOfWarMask>,
    pub vector_clocks: HashMap<u64, u64>,
}

impl RoomCrdtState {
    pub fn new(room_id: &str) -> Self {
        Self {
            room_id: room_id.to_string(),
            token_transforms: HashMap::new(),
            user_cursors: HashMap::new(),
            fog_masks: HashMap::new(),
            vector_clocks: HashMap::new(),
        }
    }

    /// LWW Conflict Resolution for Token Transforms
    pub fn apply_token_transform(&mut self, transform: TokenTransform) -> bool {
        let entry = self.token_transforms.entry(transform.token_id).or_insert_with(|| transform.clone());
        if transform.vector_clock.sequence > entry.vector_clock.sequence ||
           (transform.vector_clock.sequence == entry.vector_clock.sequence && transform.timestamp >= entry.timestamp) {
            *entry = transform;
            true
        } else {
            false
        }
    }

    pub fn update_cursor(&mut self, cursor: UserCursor) {
        self.user_cursors.insert(cursor.client_id, cursor);
    }

    pub fn update_fog(&mut self, fog: FogOfWarMask) {
        self.fog_masks.insert(fog.layer_id.clone(), fog);
    }
}
