use crate::event_log::EventSourcingLedger;
use crate::inventory::InventoryManager;
use crate::types::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Tracks an entity's active concentration (SRD: one spell at a time).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConcentrationState {
    pub spell_id: String,
    pub started_round: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EntityState {
    pub id: Uuid,
    pub compendium_id: String,
    pub name: String,
    pub is_player: bool,
    pub current_hp: i32,
    pub max_hp: i32,
    pub temp_hp: i32,
    pub ac: i32,
    pub speed_feet: f32,
    pub position: (f32, f32, f32),
    pub zone_id: String,
    pub abilities: AbilityScores,
    pub conditions: Vec<Condition>,
    pub action_budget: ActionBudget,
    pub spell_slots_remaining: HashMap<u8, u32>,
    pub inventory: InventoryManager,
    pub is_conscious: bool,
    pub is_dead: bool,
    pub is_visible: bool,
    /// Active concentration spell, if any. Serde default keeps pre-existing
    /// persisted session / event-log JSON (without this field) deserializing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concentration: Option<ConcentrationState>,
}

impl EntityState {
    pub fn new(
        id: Uuid,
        compendium_id: String,
        name: String,
        is_player: bool,
        max_hp: i32,
        ac: i32,
        speed_feet: f32,
        abilities: AbilityScores,
    ) -> Self {
        Self {
            id,
            compendium_id,
            name,
            is_player,
            current_hp: max_hp,
            max_hp,
            temp_hp: 0,
            ac,
            speed_feet,
            position: (0.0, 0.0, 0.0),
            zone_id: "Zone_Default".to_string(),
            abilities,
            conditions: Vec::new(),
            action_budget: ActionBudget {
                action: true,
                bonus_action: true,
                reaction: true,
                movement_remaining_feet: speed_feet,
                free_object_interaction: true,
            },
            spell_slots_remaining: HashMap::new(),
            inventory: InventoryManager::new(),
            is_conscious: true,
            is_dead: false,
            is_visible: true,
            concentration: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct InitiativeCombatState {
    pub in_combat: bool,
    pub round: u32,
    pub turn_index: usize,
    pub order: Vec<Uuid>,
}

impl InitiativeCombatState {
    pub fn next_turn(&mut self) -> (usize, u32, Option<Uuid>) {
        if self.order.is_empty() {
            return (0, self.round, None);
        }

        self.turn_index += 1;
        if self.turn_index >= self.order.len() {
            self.turn_index = 0;
            self.round += 1;
        }

        let current_actor = self.order.get(self.turn_index).cloned();
        (self.turn_index, self.round, current_actor)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameSession {
    pub session_id: Uuid,
    pub campaign_id: Uuid,
    pub session_name: String,
    pub entities: HashMap<Uuid, EntityState>,
    pub combat: InitiativeCombatState,
    pub ledger: EventSourcingLedger,
    pub ingress_stack: Vec<IngressEvent>,
    pub egress_stack: Vec<EgressEvent>,
}

impl GameSession {
    pub fn new(session_id: Uuid, campaign_id: Uuid, session_name: String) -> Self {
        Self {
            session_id,
            campaign_id,
            session_name,
            entities: HashMap::new(),
            combat: InitiativeCombatState::default(),
            ledger: EventSourcingLedger::new(),
            ingress_stack: Vec::new(),
            egress_stack: Vec::new(),
        }
    }

    pub fn add_entity(&mut self, entity: EntityState, ingress: Option<IngressEvent>) -> Result<(), String> {
        let id = entity.id;
        if let Some(ing) = ingress {
            if ing.verified {
                self.ingress_stack.push(ing);
            } else {
                return Err("Unverified ingress event".to_string());
            }
        }
        self.entities.insert(id, entity);
        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            id,
            "ENTITY_SPAWN",
            serde_json::json!({"entity_id": id.to_string()}),
        );
        Ok(())
    }

    pub fn remove_entity(&mut self, entity_id: &Uuid, reason: &str) -> Option<EntityState> {
        if let Some(ent) = self.entities.remove(entity_id) {
            self.egress_stack.push(EgressEvent {
                entity_id: *entity_id,
                reason: reason.to_string(),
                position: ent.position,
            });
            self.ledger.append_event(
                self.session_id,
                self.campaign_id,
                *entity_id,
                "ENTITY_DESPAWN",
                serde_json::json!({"entity_id": entity_id.to_string(), "reason": reason}),
            );
            Some(ent)
        } else {
            None
        }
    }

    pub fn verify_entity_conservation(&self, previous_count: usize, ingress_count: usize, egress_count: usize) -> bool {
        let expected = previous_count + ingress_count - egress_count;
        self.entities.len() == expected
    }
}
