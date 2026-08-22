use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GameEvent {
    pub sequence_id: u64,
    pub session_id: Uuid,
    pub campaign_id: Uuid,
    pub actor_id: Uuid,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub state_hash: String,
    pub is_reverted: bool,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EventSourcingLedger {
    pub events: Vec<GameEvent>,
    pub current_sequence: u64,
    pub last_state_hash: String,
}

impl EventSourcingLedger {
    pub fn new() -> Self {
        Self {
            events: Vec::new(),
            current_sequence: 0,
            last_state_hash: "GENESIS_HASH".to_string(),
        }
    }

    pub fn append_event(
        &mut self,
        session_id: Uuid,
        campaign_id: Uuid,
        actor_id: Uuid,
        event_type: &str,
        payload: serde_json::Value,
    ) -> &GameEvent {
        self.current_sequence += 1;

        let mut hasher = Sha256::new();
        hasher.update(self.last_state_hash.as_bytes());
        hasher.update(self.current_sequence.to_le_bytes());
        hasher.update(event_type.as_bytes());
        let payload_str = payload.to_string();
        hasher.update(payload_str.as_bytes());
        let hash_result = format!("{:x}", hasher.finalize());

        let event = GameEvent {
            sequence_id: self.current_sequence,
            session_id,
            campaign_id,
            actor_id,
            event_type: event_type.to_string(),
            payload,
            state_hash: hash_result.clone(),
            is_reverted: false,
            timestamp: Utc::now(),
        };

        self.last_state_hash = hash_result;
        self.events.push(event);
        self.events.last().unwrap()
    }

    pub fn rewind_to_sequence(&mut self, target_sequence_id: u64) -> Vec<GameEvent> {
        let mut reverted_events = Vec::new();
        for event in self.events.iter_mut().rev() {
            if event.sequence_id > target_sequence_id && !event.is_reverted {
                event.is_reverted = true;
                reverted_events.push(event.clone());
            }
        }
        reverted_events
    }

    pub fn get_active_events(&self) -> Vec<&GameEvent> {
        self.events.iter().filter(|e| !e.is_reverted).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_sourcing_and_rewind() {
        let mut ledger = EventSourcingLedger::new();
        let session = Uuid::new_v4();
        let campaign = Uuid::new_v4();
        let actor = Uuid::new_v4();

        ledger.append_event(session, campaign, actor, "MOVE", serde_json::json!({"x": 10, "y": 20}));
        ledger.append_event(session, campaign, actor, "ATTACK", serde_json::json!({"damage": 15}));
        ledger.append_event(session, campaign, actor, "DAMAGE", serde_json::json!({"hp": 5}));

        assert_eq!(ledger.events.len(), 3);
        assert_eq!(ledger.get_active_events().len(), 3);

        let reverted = ledger.rewind_to_sequence(1);
        assert_eq!(reverted.len(), 2);
        assert_eq!(ledger.get_active_events().len(), 1);
        assert_eq!(ledger.get_active_events()[0].sequence_id, 1);
    }
}
