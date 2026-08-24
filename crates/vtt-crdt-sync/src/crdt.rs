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
#[serde(rename_all = "camelCase")]
pub struct FogOfWarMask {
    pub layer_id: String,
    pub revealed_polygons: Vec<Vec<(f32, f32)>>,
    pub version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "payload")]
pub enum CrdtSyncMessage {
    /// Peer → relay: "here is what I already have" (state vector). The relay
    /// answers with a fresh `SyncStep2` snapshot so late/reconnecting peers
    /// can resynchronize on demand, not only at connect time.
    SyncStep1 { state_vector: HashMap<u64, u64> },
    /// Relay → peer: initial-state snapshot (role-projected). This is the
    /// frame a newly connected peer receives right after the handshake;
    /// deltas (`TokenUpdate` / `FogUpdate` / `CursorAwareness`) flow after it
    /// exactly as before. Newtype over `SyncSnapshot` so the wire payload IS
    /// the snapshot (`payload` = `SyncSnapshot`), with no extra nesting level.
    SyncStep2(SyncSnapshot),
    TokenUpdate(TokenTransform),
    CursorAwareness(UserCursor),
    FogUpdate(FogOfWarMask),
    Heartbeat { timestamp_ms: u64 },
}

/// One board token inside a `SyncStep2` initial-state snapshot.
///
/// The token is keyed by its entity DISPLAY NAME because that is the relay's
/// wire key everywhere else (`tokenId` on `TokenUpdate` frames): the CRDT's
/// internal `token_id` UUID is an fnv1a hash of the name and therefore not
/// reversible into something a client can echo back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotToken {
    pub token_name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub rotation: f32,
    pub scale: f32,
    pub elevation: f32,
    /// LWW watermark of the last accepted transform for this token
    /// (0 = never moved since the room was created).
    pub sequence: u64,
}

/// The full entitlement-scoped state of one room, sent to a peer as a single
/// `SyncStep2` frame. The RELAY decides what belongs in here per the peer's
/// authenticated role — hidden entities are excluded for non-GM peers and fog
/// layers follow delivery rules — so the snapshot is safe to apply blindly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub room_id: String,
    /// Role-projected board tokens.
    pub tokens: Vec<SnapshotToken>,
    /// Fog layers this peer may receive under live-delivery rules.
    pub fog_layers: Vec<FogOfWarMask>,
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
