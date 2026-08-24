//! # vtt-crdt-sync: Real-Time CRDT State Synchronization & Relay Server
//!
//! Provides conflict-free replicated data types (CRDT) for multi-client tabletop synchronization:
//! - Last-Write-Wins (LWW) register resolution for token transforms and positions
//! - Vector clock sequencing and millisecond timestamp arbitration
//! - Fog of War exploration bitmasks and dynamic reveal syncing
//! - Live multiplayer cursor broadcasting (<16ms relay latency)

pub mod crdt;
pub mod relay;

pub use crdt::{
    CrdtSyncMessage, FogOfWarMask, RoomCrdtState, SnapshotToken, SyncSnapshot, TokenTransform,
    UserCursor, VectorClock,
};
pub use relay::CrdtRelayHub;

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    #[test]
    fn test_crdt_lww_conflict_resolution() {
        let mut room = RoomCrdtState::new("room_1");
        let token_id = Uuid::new_v4();

        let t1 = TokenTransform {
            token_id,
            x: 10.0,
            y: 10.0,
            z: 0.0,
            rotation: 0.0,
            scale: 1.0,
            elevation: 0.0,
            vector_clock: VectorClock { client_id: 1, sequence: 1 },
            timestamp: Utc::now(),
        };

        let t2 = TokenTransform {
            token_id,
            x: 20.0,
            y: 20.0,
            z: 0.0,
            rotation: 90.0,
            scale: 1.0,
            elevation: 0.0,
            vector_clock: VectorClock { client_id: 2, sequence: 2 },
            timestamp: Utc::now(),
        };

        assert!(room.apply_token_transform(t1.clone()));
        assert_eq!(room.token_transforms.get(&token_id).unwrap().x, 10.0);

        assert!(room.apply_token_transform(t2.clone()));
        assert_eq!(room.token_transforms.get(&token_id).unwrap().x, 20.0);

        // Stale update should be ignored
        assert!(!room.apply_token_transform(t1));
        assert_eq!(room.token_transforms.get(&token_id).unwrap().x, 20.0);
    }
}
