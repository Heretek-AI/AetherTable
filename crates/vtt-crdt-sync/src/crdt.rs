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

/// The owner-less layer id under which the relay serves its single
/// party-merged fog view to spectator peers (relay-audit structural limit #1).
pub const PARTY_MERGED_FOG_LAYER_ID: &str = "party-explored";

/// Merges several fog layers into ONE party-merged mask for spectator
/// delivery.
///
/// # Geometry honesty: this union is LIST CONCATENATION, not geometric ops
///
/// The merged mask's `revealed_polygons` is simply every input layer's polygon
/// list concatenated, in iteration order, duplicates and overlaps included.
/// There is NO polygon boolean algebra here — no geometric union, no
/// simplification, no hole punching. That is deliberate and CORRECT for this
/// domain: fog-of-war reveal is ADDITIVE rendering. A client paints every
/// revealed polygon as visible area, so overlapping polygons compose exactly
/// like their geometric union would (`A ∪ B = paint(A); paint(B)`), while any
/// difference/clipping pass would burn CPU on a result indistinguishable on
/// screen.
///
/// The corollary constraint: concatenation semantics are valid ONLY while all
/// participants treat reveal as monotone-additive. If a layer ever carried
/// subtractive semantics (re-hide / exclusion zones), naive concatenation
/// would over-reveal — such frames must NOT be fed through this merge.
///
/// Returns `None` when the inputs contain no geometry at all, so callers can
/// distinguish "nothing explored yet" from an empty merged layer. The merged
/// `version` is the max across inputs: a best-effort monotonically non-
/// decreasing watermark (per-layer versions are client-authored, so it is
/// advisory ordering, not a strict Lamport clock).
pub fn merge_fog_layers<'a>(
    layers: impl IntoIterator<Item = &'a FogOfWarMask>,
) -> Option<FogOfWarMask> {
    let mut merged_polygons: Vec<Vec<(f32, f32)>> = Vec::new();
    let mut version = 0u64;
    for layer in layers {
        merged_polygons.extend(layer.revealed_polygons.iter().cloned());
        version = version.max(layer.version);
    }
    if merged_polygons.is_empty() {
        return None;
    }
    Some(FogOfWarMask {
        layer_id: PARTY_MERGED_FOG_LAYER_ID.to_string(),
        revealed_polygons: merged_polygons,
        version,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(layer_id: &str, version: u64, polygons: &[(f32, f32)]) -> FogOfWarMask {
        FogOfWarMask {
            layer_id: layer_id.to_string(),
            revealed_polygons: vec![polygons.to_vec()],
            version,
        }
    }

    #[test]
    fn merge_is_list_concatenation_with_max_version_watermark() {
        let a = mask("fog:user-a", 2, &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]);
        let b = mask("fog:user-b", 7, &[(5.0, 5.0), (6.0, 5.0), (6.0, 6.0)]);

        let merged = merge_fog_layers([&a, &b]).expect("two non-empty layers must merge");

        assert_eq!(merged.layer_id, PARTY_MERGED_FOG_LAYER_ID);
        // Concatenation preserves every input polygon in order — overlaps
        // included, because reveal rendering is additive.
        assert_eq!(merged.revealed_polygons.len(), 2);
        assert_eq!(merged.revealed_polygons[0], a.revealed_polygons[0]);
        assert_eq!(merged.revealed_polygons[1], b.revealed_polygons[0]);
        // Watermark = max across inputs, never an input's own id.
        assert_eq!(merged.version, 7);
    }

    #[test]
    fn merge_returns_none_when_no_layer_has_geometry() {
        assert!(merge_fog_layers(std::iter::empty()).is_none());
        let empty = FogOfWarMask {
            layer_id: "fog:user-a".to_string(),
            revealed_polygons: Vec::new(),
            version: 4,
        };
        assert!(merge_fog_layers([&empty]).is_none());
    }

    #[test]
    fn merged_output_serializes_as_a_plain_camel_case_fog_frame() {
        let a = mask("fog:user-a", 3, &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]);
        let merged = merge_fog_layers([&a]).expect("non-empty layer must merge");
        let json = serde_json::to_value(CrdtSyncMessage::FogUpdate(merged)).unwrap();
        assert_eq!(json["type"], "FogUpdate");
        assert_eq!(json["payload"]["layerId"], PARTY_MERGED_FOG_LAYER_ID);
        assert!(json["payload"]["revealedPolygons"].is_array());
    }
}
