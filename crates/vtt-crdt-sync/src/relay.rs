use crate::crdt::{CrdtSyncMessage, RoomCrdtState};
use dashmap::DashMap;
use parking_lot::RwLock;
use std::sync::Arc;

pub struct CrdtRelayHub {
    rooms: DashMap<String, Arc<RwLock<RoomCrdtState>>>,
}

impl Default for CrdtRelayHub {
    fn default() -> Self {
        Self::new()
    }
}

impl CrdtRelayHub {
    pub fn new() -> Self {
        Self {
            rooms: DashMap::new(),
        }
    }

    pub fn get_or_create_room(&self, room_id: &str) -> Arc<RwLock<RoomCrdtState>> {
        self.rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Arc::new(RwLock::new(RoomCrdtState::new(room_id))))
            .clone()
    }

    pub fn handle_incoming_message(&self, room_id: &str, msg: CrdtSyncMessage) -> Option<CrdtSyncMessage> {
        let room = self.get_or_create_room(room_id);
        let mut state = room.write();

        match msg {
            CrdtSyncMessage::TokenUpdate(transform) => {
                let updated = state.apply_token_transform(transform.clone());
                if updated {
                    Some(CrdtSyncMessage::TokenUpdate(transform))
                } else {
                    None
                }
            }
            CrdtSyncMessage::CursorAwareness(cursor) => {
                state.update_cursor(cursor.clone());
                Some(CrdtSyncMessage::CursorAwareness(cursor))
            }
            CrdtSyncMessage::FogUpdate(fog) => {
                state.update_fog(fog.clone());
                Some(CrdtSyncMessage::FogUpdate(fog))
            }
            CrdtSyncMessage::Heartbeat { timestamp_ms } => {
                Some(CrdtSyncMessage::Heartbeat { timestamp_ms })
            }
            _ => None,
        }
    }
}
