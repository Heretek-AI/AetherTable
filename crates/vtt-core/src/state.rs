use crate::dice::DiceEngine;
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

/// One weapon / natural attack from an entity's stat block. Attack bonuses
/// and damage dice live HERE — on the server-side authoritative stat block —
/// never in client requests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttackAction {
    pub name: String,
    pub attack_bonus: i32,
    pub damage_expression: String,
    pub damage_type: DamageType,
}

/// Default unarmed strike used when an entity has no explicit attacks.
impl Default for AttackAction {
    fn default() -> Self {
        Self {
            name: "Unarmed Strike".to_string(),
            attack_bonus: 0,
            damage_expression: "1".to_string(),
            damage_type: DamageType::Bludgeoning,
        }
    }
}

/// A timed condition with an optional end-of-turn repeat save (SRD duration
/// lifecycle: rounds countdown, "save ends" effects re-roll each turn).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EndOfTurnSave {
    pub ability: Ability,
    pub dc: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConditionTimer {
    pub condition: Condition,
    pub remaining_rounds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_of_turn_save: Option<EndOfTurnSave>,
}

/// Authoritative battle map geometry for a session. Walls declared here are
/// the single source of truth for cover, LoS and movement validation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMap {
    pub width: usize,
    pub height: usize,
    /// Solid (wall/occluder) cells as (x, y) grid coordinates.
    pub solid_cells: Vec<(usize, usize)>,
    /// Difficult-terrain cells as (x, y) grid coordinates — each step into
    /// these cells consumes double movement (SRD difficult terrain).
    #[serde(default)]
    pub difficult_terrain: Vec<(usize, usize)>,
    /// Feet per grid cell.
    pub cell_size_feet: f32,
}

impl Default for SessionMap {
    fn default() -> Self {
        Self {
            width: 32,
            height: 32,
            solid_cells: Vec::new(),
            difficult_terrain: Vec::new(),
            cell_size_feet: 5.0,
        }
    }
}

impl SessionMap {
    /// Validates that all declared solid cells are inside map bounds.
    pub fn validate(&self) -> Result<(), String> {
        for &(x, y) in &self.solid_cells {
            if x >= self.width || y >= self.height {
                return Err(format!(
                    "solid cell ({}, {}) out of {}x{} bounds",
                    x, y, self.width, self.height
                ));
            }
        }
        Ok(())
    }
}

/// JSON round-trip helpers for integer-keyed slot maps (serde_json only
/// accepts string map keys, so "3": 1 must parse into u8 → u32).
mod slots_serde {
    use serde::{Deserialize, Deserializer, Serializer};
    use std::collections::HashMap;

    pub fn serialize<S: Serializer>(
        map: &HashMap<u8, u32>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_map(map.iter().map(|(k, v)| (k.to_string(), v)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<HashMap<u8, u32>, D::Error> {
        let raw: HashMap<String, u32> = HashMap::deserialize(deserializer)?;
        let mut out = HashMap::with_capacity(raw.len());
        for (key, value) in raw {
            let level: u8 = key
                .parse()
                .map_err(|_| serde::de::Error::custom(format!("bad spell slot level '{}'", key)))?;
            out.insert(level, value);
        }
        Ok(out)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EntityState {
    pub id: Uuid,
    pub compendium_id: String,
    pub name: String,
    pub is_player: bool,
    /// Gateway user that controls this entity (RBAC). None = unowned /
    /// DM-controlled. Serde default keeps legacy payloads deserializing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_player_id: Option<String>,
    pub current_hp: i32,
    pub max_hp: i32,
    pub temp_hp: i32,
    pub ac: i32,
    pub speed_feet: f32,
    pub position: (f32, f32, f32),
    pub zone_id: String,
    pub abilities: AbilityScores,
    pub conditions: Vec<Condition>,
    /// Duration clocks backing `conditions`. Serde default keeps legacy
    /// serialized entities deserializing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub condition_timers: Vec<ConditionTimer>,
    /// Shield spell bonus (+5 AC) granted by a consumed Reaction; cleared at
    /// the entity's next turn refresh.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shield_ac_bonus_active: bool,
    pub action_budget: ActionBudget,
    #[serde(with = "slots_serde", default)]
    pub spell_slots_remaining: HashMap<u8, u32>,
    /// Stat-block attack entries. The ONLY source of attack bonuses and damage
    /// dice — clients reference these by index, they never supply their own.
    #[serde(default)]
    pub attacks: Vec<AttackAction>,
    #[serde(default)]
    pub resistances: Vec<DamageType>,
    #[serde(default)]
    pub vulnerabilities: Vec<DamageType>,
    #[serde(default)]
    pub immunities: Vec<DamageType>,
    pub inventory: InventoryManager,
    pub is_conscious: bool,
    pub is_dead: bool,
    /// Cumulative death-save tallies, persisted on the entity so successive
    /// saves progress toward stabilization or death. Serde default keeps
    /// legacy serialized entities deserializing.
    #[serde(default)]
    pub death_saves: DeathSaveState,
    pub is_visible: bool,
    /// Active concentration spell, if any. Serde default keeps pre-existing
    /// persisted session / event-log JSON (without this field) deserializing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concentration: Option<ConcentrationState>,
}

impl EntityState {
    /// Distance in feet between this entity and another, using the session's
    /// cell size convention (5 ft per world unit step on x/y planes).
    pub fn distance_to_feet(&self, other: &EntityState) -> f32 {
        let dx = self.position.0 - other.position.0;
        let dy = self.position.1 - other.position.1;
        let dz = self.position.2 - other.position.2;
        // Positions are stored in feet already (world units == feet).
        (dx * dx + dy * dy + dz * dz).sqrt()
    }

    /// True when this entity can take actions at all.
    pub fn can_act(&self) -> bool {
        self.is_conscious && !self.is_dead && !self.conditions.iter().any(|c| c.is_incapacitated())
    }

    /// SRD: regaining any hit points clears accumulated death-save tallies.
    /// Returns true when a stale tally was wiped. Callers that restore HP
    /// (future heal endpoints) should invoke this alongside the HP write;
    /// the death-save endpoint also calls it defensively so a healed entity's
    /// leftover counters never leak into a later drop.
    pub fn reset_death_saves_if_healed(&mut self) -> bool {
        if self.current_hp <= 0 {
            return false;
        }
        let had_tally = self.death_saves.successes > 0
            || self.death_saves.failures > 0
            || self.death_saves.is_stabilized;
        if had_tally {
            self.death_saves.reset();
        }
        had_tally
    }

    /// Spends the entity's Action. Rejects when the budget is exhausted or the
    /// entity is incapacitated — this is the action-economy enforcement point.
    pub fn spend_action(&mut self) -> Result<(), String> {
        if !self.can_act() {
            return Err("ENTITY_CANNOT_ACT".to_string());
        }
        if !self.action_budget.action {
            return Err("ACTION_ECONOMY_EXHAUSTED".to_string());
        }
        self.action_budget.action = false;
        Ok(())
    }

    /// Resolves the attack entry for `action_index`, falling back to an
    /// unarmed strike for stat blocks without explicit attacks.
    pub fn attack_for_index(&self, action_index: usize) -> AttackAction {
        self.attacks
            .get(action_index)
            .cloned()
            .unwrap_or_default()
    }
}

// ------------------------------------------------------------- exhaustion
//
// SRD 5e Exhaustion is modeled as the existing `Condition::Exhaustion(u8)`
// variant inside `conditions` — NOT as a parallel numeric field on this
// struct. The variant already round-trips through serde via the condition
// list and is already consulted by `Condition::inflicts_disadvantage_on_
// attacks()` (level >= 3); a second source of truth would let the two drift.
// Every mechanical effect below derives from that single condition entry.

impl EntityState {
    /// Current exhaustion level: 0 (none) through 6 (death). Derived from the
    /// strongest `Condition::Exhaustion` entry in `conditions`.
    pub fn exhaustion_level(&self) -> u8 {
        self.conditions
            .iter()
            .map(|c| match c {
                Condition::Exhaustion(level) => *level,
                _ => 0,
            })
            .max()
            .unwrap_or(0)
        .min(6)
    }

    /// Sets the exhaustion level, replacing any prior `Exhaustion` condition.
    /// Level 0 clears the condition entirely; levels above 6 clamp to 6.
    ///
    /// This is the enforcement point for level 4's HP cap and level 6's death:
    /// callers mutate exhaustion only through here so the derived penalties can
    /// never be stale relative to stored HP / liveness.
    pub fn set_exhaustion(&mut self, level: u8) {
        let level = level.min(6);
        self.conditions.retain(|c| !matches!(c, Condition::Exhaustion(_)));
        if level > 0 {
            self.conditions.push(Condition::Exhaustion(level));
        }
        if level >= 6 {
            // SRD: reaching the seventh exhaustion level kills the creature.
            self.is_dead = true;
            self.is_conscious = false;
        }
        self.enforce_exhaustion_hp_cap();
    }

    /// Level >= 4 halves the hit-point maximum (floor division, min 1).
    pub fn effective_max_hp(&self) -> i32 {
        if self.exhaustion_level() >= 4 {
            (self.max_hp / 2).max(1)
        } else {
            self.max_hp
        }
    }

    /// Speed as modified by exhaustion: halved at level >= 2, zero at
    /// level >= 5. All movement-budget seeding must use THIS value instead of
    /// the raw `speed_feet`.
    pub fn effective_speed_feet(&self) -> f32 {
        match self.exhaustion_level() {
            5..=6 => 0.0,
            2..=4 => self.speed_feet / 2.0,
            _ => self.speed_feet,
        }
    }

    /// Level >= 1: disadvantage on ability checks. The check pipeline
    /// (`RulesEvaluator::resolve_check_margin`) consumes a pre-rolled d20 and
    /// has no adv/dis parameter, so callers fold this flag into their roll
    /// strategy (roll twice keep lower) before invoking it.
    pub fn has_disadvantage_on_checks(&self) -> bool {
        self.exhaustion_level() >= 1
    }

    /// Level >= 3: disadvantage on attack rolls. Also surfaced automatically
    /// by `RulesEvaluator::edge_from_conditions` through
    /// `Condition::inflicts_disadvantage_on_attacks`.
    pub fn has_disadvantage_on_attacks(&self) -> bool {
        self.exhaustion_level() >= 3
    }

    /// Level >= 3: disadvantage on saving throws. `resolve_saving_throw`
    /// likewise takes a raw d20, so callers roll twice/keep lower when true.
    pub fn has_disadvantage_on_saves(&self) -> bool {
        self.exhaustion_level() >= 3
    }

    /// Clamps current HP down to the level-4+ halved maximum. Idempotent and a
    /// no-op below level 4; called by [`Self::set_exhaustion`] and by the
    /// round-advance pass so healing above the reduced maximum is undone.
    pub fn enforce_exhaustion_hp_cap(&mut self) {
        let cap = self.effective_max_hp();
        if self.current_hp > cap {
            self.current_hp = cap;
        }
    }

    /// Long-rest hook (SRD 5e): one long rest reduces exhaustion by one level.
    /// Returns true when a level was shed. Exported for the server's rest
    /// endpoint to adopt. Death at level 6 is final — resting does not
    /// resurrect, so this is never called for a dead creature by the engine.
    pub fn take_long_rest_effects(&mut self) -> bool {
        let level = self.exhaustion_level();
        if level == 0 {
            return false;
        }
        self.set_exhaustion(level - 1);
        true
    }
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
            owner_player_id: None,
            current_hp: max_hp,
            max_hp,
            temp_hp: 0,
            ac,
            speed_feet,
            position: (0.0, 0.0, 0.0),
            zone_id: "Zone_Default".to_string(),
            abilities,
            conditions: Vec::new(),
            condition_timers: Vec::new(),
            shield_ac_bonus_active: false,
            action_budget: ActionBudget {
                action: true,
                bonus_action: true,
                reaction: true,
                movement_remaining_feet: speed_feet,
                free_object_interaction: true,
            },
            spell_slots_remaining: HashMap::new(),
            attacks: Vec::new(),
            resistances: Vec::new(),
            vulnerabilities: Vec::new(),
            immunities: Vec::new(),
            inventory: InventoryManager::new(),
            is_conscious: true,
            is_dead: false,
            death_saves: DeathSaveState::default(),
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
    /// Entity ids in initiative order (index 0 acts first). Serde default
    /// keeps legacy serialized sessions (combat without an order) parsing.
    #[serde(default)]
    pub order: Vec<Uuid>,
}

/// One rolled initiative slot, as reported by [`GameSession::begin_combat`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InitiativeEntry {
    pub entity_id: Uuid,
    pub name: String,
    pub dexterity: i32,
    /// d20 natural roll + DEX modifier.
    pub initiative_total: i32,
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

/// Orders initiative entries: total descending, ties by higher DEX score,
/// then alphabetically by name. Free function so the tie-break ladder is
/// unit-testable without forcing equal dice rolls.
pub fn sort_initiative_entries(entries: &mut [InitiativeEntry]) {
    entries.sort_by(|a, b| {
        b.initiative_total
            .cmp(&a.initiative_total)
            .then_with(|| b.dexterity.cmp(&a.dexterity))
            .then_with(|| a.name.cmp(&b.name))
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReactionType {
    Shield,
    Counterspell,
    OpportunityAttack,
}

/// A reaction an entity has readied. The reaction budget is consumed only
/// when the trigger actually fires.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ArmedReaction {
    pub entity_id: Uuid,
    pub reaction_type: ReactionType,
}

/// Outcome of a round tick for one entity's condition clocks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConditionTickOutcome {
    pub entity_id: Uuid,
    pub expired: Vec<Condition>,
    pub saved_against: Vec<Condition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RoundAdvanceReport {
    pub round: u32,
    pub ticks: Vec<ConditionTickOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RewindReport {
    pub reverted_event_count: usize,
    pub restored_entities: usize,
    pub removed_entities: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct OpportunityAttackTrigger {
    pub attacker_id: Uuid,
    pub mover_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MoveOutcome {
    pub from: (f32, f32, f32),
    pub to: (f32, f32, f32),
    pub movement_spent_feet: f32,
    pub opportunity_attacks: Vec<OpportunityAttackTrigger>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameSession {
    pub session_id: Uuid,
    pub campaign_id: Uuid,
    pub session_name: String,
    pub entities: HashMap<Uuid, EntityState>,
    pub combat: InitiativeCombatState,
    /// Authoritative battle map. Serde default keeps older serialized
    /// sessions (without a map) deserializing.
    #[serde(default)]
    pub map: SessionMap,
    #[serde(default)]
    pub reaction_arms: Vec<ArmedReaction>,
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
            map: SessionMap::default(),
            reaction_arms: Vec::new(),
            ledger: EventSourcingLedger::new(),
            ingress_stack: Vec::new(),
            egress_stack: Vec::new(),
        }
    }

    // ------------------------------------------------------------ reactions

    /// Readies a reaction for this entity's next trigger. Does NOT spend the
    /// reaction budget — that happens when the trigger fires.
    pub fn arm_reaction(&mut self, entity_id: Uuid, reaction_type: ReactionType) -> Result<(), String> {
        let entity = self
            .entities
            .get(&entity_id)
            .ok_or_else(|| "REACTION_ENTITY_NOT_FOUND".to_string())?;
        if !entity.can_act() && !entity.action_budget.reaction {
            return Err("REACTION_UNAVAILABLE".to_string());
        }
        if !entity.action_budget.reaction {
            return Err("REACTION_SPENT".to_string());
        }
        if self
            .reaction_arms
            .iter()
            .any(|r| r.entity_id == entity_id && r.reaction_type == reaction_type)
        {
            return Ok(()); // already armed — idempotent
        }
        self.reaction_arms.push(ArmedReaction {
            entity_id,
            reaction_type,
        });
        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "REACTION_ARMED",
            serde_json::json!({"reaction": reaction_type}),
        );
        Ok(())
    }

    /// Consumes an armed reaction when its trigger fires. Returns true if the
    /// reaction was available and is now spent.
    pub fn consume_reaction(&mut self, entity_id: Uuid, reaction_type: ReactionType) -> bool {
        let before = self.reaction_arms.len();
        self.reaction_arms
            .retain(|r| !(r.entity_id == entity_id && r.reaction_type == reaction_type));
        let consumed = self.reaction_arms.len() < before;
        if consumed {
            if let Some(entity) = self.entities.get_mut(&entity_id) {
                entity.action_budget.reaction = false;
            }
            self.ledger.append_event(
                self.session_id,
                self.campaign_id,
                entity_id,
                "REACTION_CONSUMED",
                serde_json::json!({"reaction": reaction_type}),
            );
        }
        consumed
    }

    pub fn has_armed_reaction(&self, entity_id: Uuid, reaction_type: ReactionType) -> bool {
        self.reaction_arms
            .iter()
            .any(|r| r.entity_id == entity_id && r.reaction_type == reaction_type)
    }

    // ---------------------------------------------------- condition lifecycle

    /// Applies a timed condition and registers its duration clock.
    pub fn apply_timed_condition(
        &mut self,
        entity_id: Uuid,
        condition: Condition,
        duration_rounds: u32,
        end_of_turn_save: Option<EndOfTurnSave>,
    ) -> Result<(), String> {
        let entity = self
            .entities
            .get_mut(&entity_id)
            .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
        if !entity.conditions.contains(&condition) {
            entity.conditions.push(condition);
        }
        entity.condition_timers.push(ConditionTimer {
            condition,
            remaining_rounds: duration_rounds,
            end_of_turn_save,
        });
        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "CONDITION_APPLIED",
            serde_json::json!({
                "condition": condition,
                "duration_rounds": duration_rounds,
            }),
        );
        Ok(())
    }

    /// End-of-round lifecycle pass over every entity:
    /// - decrement each condition clock by one round
    /// - roll configured end-of-turn saves (`dice` must be server-seeded)
    /// - expire conditions whose clock ran out or whose save succeeded
    /// - clear expired conditions AND their mechanical flags
    pub fn advance_round(&mut self, dice: &mut DiceEngine) -> RoundAdvanceReport {
        self.combat.round += 1;
        let mut report = RoundAdvanceReport {
            round: self.combat.round,
            ticks: Vec::new(),
        };

        for (id, entity) in self.entities.iter_mut() {
            entity.shield_ac_bonus_active = false; // Shield lasts until the start of the caster's next turn
            // Start-of-round action-economy refresh. Exhaustion modifies the
            // speed the budget seeds from (halved at level 2+, zero at 5+).
            entity.action_budget.reset(entity.effective_speed_feet());
            // Re-clamp HP to the halved maximum at exhaustion 4+ so healing
            // past the reduced cap between rounds cannot stick.
            entity.enforce_exhaustion_hp_cap();
            if entity.condition_timers.is_empty() {
                continue;
            }

            let mut expired: Vec<Condition> = Vec::new();
            let mut saved_against: Vec<Condition> = Vec::new();
            let mut surviving: Vec<ConditionTimer> = Vec::new();

            for mut timer in entity.condition_timers.drain(..) {
                timer.remaining_rounds = timer.remaining_rounds.saturating_sub(1);

                // End-of-turn repeat save (e.g. Hold Person, Ray of Enfeeblement).
                if let Some(save_cfg) = &timer.end_of_turn_save {
                    let natural = dice.roll_d20();
                    let modifier = entity.abilities.modifier(save_cfg.ability);
                    if natural + modifier >= save_cfg.dc {
                        saved_against.push(timer.condition);
                        continue; // save succeeded — condition ends now
                    }
                }

                if timer.remaining_rounds == 0 {
                    expired.push(timer.condition);
                    continue;
                }
                surviving.push(timer);
            }

            entity.condition_timers = surviving;
            // Remove BOTH naturally-expired and saved-away conditions.
            for cond in expired.iter().chain(saved_against.iter()) {
                entity.conditions.retain(|c| c != cond);
            }

            for cond in &expired {
                self.ledger.append_event(
                    self.session_id,
                    self.campaign_id,
                    *id,
                    "CONDITION_EXPIRED",
                    serde_json::json!({ "condition": cond }),
                );
            }

            if !expired.is_empty() || !saved_against.is_empty() {
                report.ticks.push(ConditionTickOutcome {
                    entity_id: *id,
                    expired,
                    saved_against,
                });
            }
        }

        report
    }

    // ------------------------------------------------- movement + opportunity

    /// Authoritative movement primitive: straight-line segment validated
    /// against the session map, speed budget deducted, opportunity attacks
    /// detected when the mover leaves an adjacent enemy with a readied OA,
    /// and the resulting position appended to the event ledger so rewinds
    /// can restore it.
    pub fn move_entity(
        &mut self,
        entity_id: Uuid,
        to: (f32, f32, f32),
    ) -> Result<MoveOutcome, String> {
        let finite = to.0.is_finite() && to.1.is_finite() && to.2.is_finite();
        if !finite {
            return Err("MOVE_NON_FINITE_COORDINATES".to_string());
        }

        let from = {
            let entity = self
                .entities
                .get(&entity_id)
                .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
            entity.position
        };

        let dx = to.0 - from.0;
        let dy = to.1 - from.1;
        let distance = (dx * dx + dy * dy).sqrt();

        // Adjacency snapshot BEFORE moving (5 ft adjacency in feet units).
        let adjacent_enemies_before: Vec<Uuid> = self
            .entities
            .iter()
            .filter(|(other_id, other)| {
                **other_id != entity_id
                    && other.is_player != self.entities[&entity_id].is_player
                    && self.entities[&entity_id].distance_to_feet(other) <= 5.0
            })
            .map(|(id, _)| *id)
            .collect();

        // Spend movement out of the round budget.
        {
            let entity = self
                .entities
                .get_mut(&entity_id)
                .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
            if !entity.is_conscious || entity.is_dead {
                return Err("ENTITY_CANNOT_MOVE".to_string());
            }
            if distance > entity.action_budget.movement_remaining_feet + 0.001 {
                return Err(format!(
                    "MOVE_BUDGET_EXCEEDED: {:.1}ft requested, {:.1}ft remaining",
                    distance, entity.action_budget.movement_remaining_feet
                ));
            }
            entity.action_budget.movement_remaining_feet -= distance;
            entity.position = to;
        }

        // Opportunity attacks: enemies who WERE adjacent and no longer are.
        let mut opportunity_attacks = Vec::new();
        {
            let (mover_pos, _) = match self.entities.get(&entity_id) {
                Some(m) => (m.position, ()),
                None => return Err("ENTITY_NOT_FOUND".to_string()),
            };
            for enemy_id in adjacent_enemies_before {
                let still_adjacent = self
                    .entities
                    .get(&enemy_id)
                    .map(|enemy| {
                        let dx = enemy.position.0 - mover_pos.0;
                        let dy = enemy.position.1 - mover_pos.1;
                        (dx * dx + dy * dy).sqrt() <= 5.5
                    })
                    .unwrap_or(false);
                if !still_adjacent
                    && self.has_armed_reaction(enemy_id, ReactionType::OpportunityAttack)
                {
                    opportunity_attacks.push(OpportunityAttackTrigger {
                        attacker_id: enemy_id,
                        mover_id: entity_id,
                    });
                    self.consume_reaction(enemy_id, ReactionType::OpportunityAttack);
                }
            }
        }

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "MOVE_ENTITY",
            serde_json::json!({
                "from": [from.0, from.1, from.2],
                "to": [to.0, to.1, to.2],
                "distance_feet": distance,
                "opportunity_attacks": opportunity_attacks,
            }),
        );

        Ok(MoveOutcome {
            from,
            to,
            movement_spent_feet: distance,
            opportunity_attacks,
        })
    }

    // ------------------------------------------------------- safety rewind

    /// Full X-card rollback: reverts ledger events past `sequence_id` AND
    /// restores live game state (HP, consciousness, positions, concentration)
    /// by replaying the surviving event history.
    pub fn safety_rewind(&mut self, sequence_id: u64) -> RewindReport {
        let reverted = self.ledger.rewind_to_sequence(sequence_id);
        let reverted_count = reverted.len();

        // 1. Remove entities spawned after the rewind point (anti-popping).
        let spawn_seqs: HashMap<Uuid, u64> = self
            .ledger
            .events
            .iter()
            .filter(|e| e.event_type == "ENTITY_SPAWN")
            .filter(|e| !e.is_reverted)
            .map(|e| {
                (
                    e.payload
                        .get("entity_id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| Uuid::parse_str(s).ok())
                        .unwrap_or_else(Uuid::nil),
                    e.sequence_id,
                )
            })
            .collect();
        let doomed: Vec<Uuid> = spawn_seqs
            .into_iter()
            .filter(|(_, seq)| *seq > sequence_id)
            .map(|(id, _)| id)
            .collect();
        let removed_entities = doomed.len();
        for id in doomed {
            self.entities.remove(&id);
        }

        // 2. Replay surviving events to rebuild mechanical state.
        let mut hp_state: HashMap<Uuid, (i32, bool, bool)> = HashMap::new();
        let mut death_save_state: HashMap<Uuid, DeathSaveState> = HashMap::new();
        let mut pos_state: HashMap<Uuid, (f32, f32, f32)> = HashMap::new();

        for ev in self.ledger.events.iter().filter(|e| !e.is_reverted) {
            match ev.event_type.as_str() {
                "ATTACK_RESOLVED" => {
                    let tid = ev.payload.get("target_id").and_then(|v| v.as_str());
                    let hp = ev.payload.get("target_hp_remaining").and_then(|v| v.as_i64());
                    if let (Some(tid), Some(hp)) = (tid, hp) {
                        if let Ok(tid) = Uuid::parse_str(tid) {
                            hp_state.insert(tid, (hp as i32, hp > 0, ev.payload.get("target_is_dead").and_then(|v| v.as_bool()).unwrap_or(false)));
                        }
                    }
                }
                "DAMAGE_APPLIED" => {
                    let tid = ev.payload.get("target_id").and_then(|v| v.as_str());
                    let hp = ev.payload.get("hp_remaining").and_then(|v| v.as_i64());
                    if let (Some(tid), Some(hp)) = (tid, hp) {
                        if let Ok(tid) = Uuid::parse_str(tid) {
                            hp_state.insert(tid, (hp as i32, hp > 0, ev.payload.get("instant_death").and_then(|v| v.as_bool()).unwrap_or(false)));
                        }
                    }
                }
                // HEALED carries absolute hp_remaining like DAMAGE_APPLIED, so
                // replays landing between a heal and a later wound keep the
                // post-heal total instead of regressing to the last damage.
                // Regaining hit points also wipes accumulated death-save
                // tallies (SRD, mirrored from reset_death_saves_if_healed on
                // the live heal endpoint): recording a cleared baseline here
                // means an earlier surviving DEATH_SAVE_RESOLVED (e.g. a dying
                // entity saved at failures = 2) no longer overrides the heal,
                // and live-drifted tallies are reset too. A save resolved
                // AFTER the heal re-inserts its tally and still wins.
                "HEALED" => {
                    let tid = ev.payload.get("target_id").and_then(|v| v.as_str());
                    let hp = ev.payload.get("hp_remaining").and_then(|v| v.as_i64());
                    if let (Some(tid), Some(hp)) = (tid, hp) {
                        if let Ok(tid) = Uuid::parse_str(tid) {
                            let hp = hp as i32;
                            hp_state.insert(tid, (hp, hp > 0, false));
                            if hp > 0 {
                                death_save_state.insert(tid, DeathSaveState::default());
                            }
                        }
                    }
                }
                // LONG_REST_APPLIED restores HP exactly like HEALED (absolute
                // hp_remaining, conscious unless dead) and by SRD design also
                // wipes death-save tallies — same cleanup.
                // SHORT_REST_APPLIED is intentionally NOT handled: it is a
                // mechanical no-op today (hit-dice spending is a future hook),
                // so a surviving short-rest event must change nothing during
                // replay; it falls through to the catch-all arm.
                "LONG_REST_APPLIED" => {
                    let tid = ev.payload.get("target_id").and_then(|v| v.as_str());
                    let hp = ev.payload.get("hp_remaining").and_then(|v| v.as_i64());
                    if let (Some(tid), Some(hp)) = (tid, hp) {
                        if let Ok(tid) = Uuid::parse_str(tid) {
                            let hp = hp as i32;
                            hp_state.insert(tid, (hp, hp > 0, false));
                            if hp > 0 {
                                death_save_state.insert(tid, DeathSaveState::default());
                            }
                        }
                    }
                }
                "DEATH_SAVE_RESOLVED" => {
                    let tally = DeathSaveState {
                        successes: ev.payload.get("successes").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                        failures: ev.payload.get("failures").and_then(|v| v.as_u64()).unwrap_or(0) as u8,
                        is_stabilized: ev.payload.get("is_stabilized").and_then(|v| v.as_bool()).unwrap_or(false),
                        is_dead: ev.payload.get("is_dead").and_then(|v| v.as_bool()).unwrap_or(false),
                    };
                    death_save_state.insert(ev.actor_id, tally);
                }
                "MOVE_ENTITY" => {
                    let aid_ok = ev.payload.get("to").is_some();
                    if aid_ok {
                        if let (Some(to), true) = (
                            ev.payload.get("to").and_then(|v| v.as_array()).map(|a| (
                                a.first().and_then(|x| x.as_f64()).unwrap_or(0.0) as f32,
                                a.get(1).and_then(|y| y.as_f64()).unwrap_or(0.0) as f32,
                                a.get(2).and_then(|z| z.as_f64()).unwrap_or(0.0) as f32,
                            )),
                            true,
                        ) {
                            pos_state.insert(ev.actor_id, to);
                        }
                    }
                }
                _ => {}
            }
        }

        // 3. Apply restored state to live entities.
        let mut restored = 0usize;
        for (id, (hp, conscious, dead)) in hp_state {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.current_hp = hp;
                entity.is_conscious = conscious;
                entity.is_dead = dead;
                restored += 1;
            }
        }
        for (id, pos) in pos_state {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.position = pos;
            }
        }
        // Death-save tallies replay after HP so the last surviving save event
        // wins (its counters already reflect any heal-reset at save time).
        for (id, tally) in death_save_state {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.death_saves = tally;
                if tally.is_dead {
                    entity.is_dead = true;
                }
                if tally.is_stabilized {
                    entity.is_dead = false;
                }
            }
        }
        // Concentration is cleared wholesale on a rewind: any spell granting
        // it may have been undone, so conservatively end all concentration.
        for entity in self.entities.values_mut() {
            entity.concentration = None;
            entity.action_budget.reset(entity.effective_speed_feet());
        }

        RewindReport {
            reverted_event_count: reverted_count,
            restored_entities: restored,
            removed_entities,
        }
    }

    /// Validates an ingress event against internal invariants instead of
    /// trusting a caller-supplied `verified` boolean (anti-popping gate).
    ///
    /// Checks:
    /// - coordinates must be finite
    /// - source and target points must differ for movement-style ingress
    ///   (teleport / portal / burrow); StealthReveal and SpawnEvent may pop
    ///   in place at the target point
    /// - SpawnEvent is only legal during setup (before combat starts)
    /// - the entity must not already exist on the board
    pub fn validate_ingress(&self, ing: &IngressEvent) -> Result<(), String> {
        let finite = |p: &(f32, f32, f32)| p.0.is_finite() && p.1.is_finite() && p.2.is_finite();
        if !finite(&ing.source_point) || !finite(&ing.target_point) {
            return Err("INGRESS_NON_FINITE_COORDINATES".to_string());
        }
        match ing.ingress_type {
            IngressType::Teleportation | IngressType::PortalDoor | IngressType::Burrowing => {
                if ing.source_point == ing.target_point {
                    return Err("INGRESS_DEGENERATE_TRANSIT".to_string());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn add_entity(&mut self, entity: EntityState, ingress: Option<IngressEvent>) -> Result<(), String> {
        let id = entity.id;
        if self.entities.contains_key(&id) {
            return Err("INGRESS_ENTITY_ALREADY_PRESENT".to_string());
        }
        if let Some(ing) = &ingress {
            // The caller-supplied `verified` flag is advisory only; the
            // authoritative check is structural validation below.
            self.validate_ingress(ing)?;
            let mut verified_ing = ing.clone();
            verified_ing.verified = true;
            self.ingress_stack.push(verified_ing);
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

    // ------------------------------------------------------------- combat flow

    /// Starts combat: rolls initiative (d20 + DEX modifier per entity), orders
    /// combatants by total (ties broken by DEX score, then name) and stores the
    /// ordered ids on [`InitiativeCombatState`]. Round starts at 1 with entity
    /// `order[0]` on turn.
    ///
    /// Rolls are drawn through the caller's [`DiceEngine`] in sorted-id order,
    /// so a seeded engine reproduces identical initiative for identical state.
    /// Returns the full rolled order for reporting.
    pub fn begin_combat(&mut self, dice: &mut DiceEngine) -> Vec<InitiativeEntry> {
        // Deterministic visit order — HashMap iteration order must never leak
        // into which die lands on which entity.
        let mut ids: Vec<Uuid> = self.entities.keys().copied().collect();
        ids.sort();

        let mut entries = Vec::with_capacity(ids.len());
        for id in ids {
            let entity = &self.entities[&id];
            let dexterity = entity.abilities.dexterity;
            let natural = dice.roll_d20();
            entries.push(InitiativeEntry {
                entity_id: id,
                name: entity.name.clone(),
                dexterity,
                initiative_total: natural + Ability::modifier(dexterity),
            });
        }
        sort_initiative_entries(&mut entries);

        self.combat.in_combat = true;
        self.combat.round = 1;
        self.combat.turn_index = 0;
        self.combat.order = entries.iter().map(|e| e.entity_id).collect();
        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            Uuid::nil(),
            "COMBAT_BEGAN",
            serde_json::json!({
                "round": 1,
                "order": entries.iter().map(|e| serde_json::json!({
                    "entity_id": e.entity_id,
                    "initiative_total": e.initiative_total,
                })).collect::<Vec<_>>(),
            }),
        );
        entries
    }

    /// Ends combat and clears the initiative tracker. Entities stay on the
    /// board untouched; returns how many combatants were tracked.
    pub fn end_combat(&mut self) -> usize {
        let cleared = self.combat.order.len();
        let round_fought = self.combat.round;
        self.combat = InitiativeCombatState::default();
        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            Uuid::nil(),
            "COMBAT_ENDED",
            serde_json::json!({ "rounds_fought": round_fought }),
        );
        cleared
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dice::DiceEngine;

    fn entity(id: Uuid, name: &str, dex: i32) -> EntityState {
        EntityState::new(
            id,
            format!("test_{}", name),
            name.to_string(),
            true,
            10,
            12,
            30.0,
            AbilityScores {
                strength: 10,
                dexterity: dex,
                constitution: 10,
                intelligence: 10,
                wisdom: 10,
                charisma: 10,
            },
        )
    }

    #[test]
    fn test_begin_combat_rolls_dex_modified_initiative_and_orders_desc() {
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        session.add_entity(entity(a, "Ann", 14), None).unwrap(); // DEX mod +2
        session.add_entity(entity(b, "Bob", 8), None).unwrap(); // DEX mod -1

        let seed = 0xC0FFEE;
        let mut dice = DiceEngine::with_seed(seed);
        let entries = session.begin_combat(&mut dice);
        assert_eq!(entries.len(), 2);
        assert!(session.combat.in_combat);
        assert_eq!(session.combat.round, 1);
        assert_eq!(session.combat.turn_index, 0);
        // Order stored on the combat state mirrors the reported entries.
        assert_eq!(
            session.combat.order,
            entries.iter().map(|e| e.entity_id).collect::<Vec<_>>()
        );
        // Every total is its d20 natural + that entity's DEX modifier.
        let mut dice = DiceEngine::with_seed(seed);
        let mut ids: Vec<Uuid> = vec![a, b];
        ids.sort();
        let expected: HashMap<Uuid, i32> = ids
            .into_iter()
            .map(|id| {
                let natural = dice.roll_d20();
                (
                    id,
                    natural + Ability::modifier(session.entities[&id].abilities.dexterity),
                )
            })
            .collect();
        for entry in &entries {
            assert_eq!(entry.initiative_total, expected[&entry.entity_id]);
            assert_eq!(entry.name, session.entities[&entry.entity_id].name);
            assert_eq!(
                entry.dexterity,
                session.entities[&entry.entity_id].abilities.dexterity
            );
        }
        // Ordering is non-increasing in initiative total.
        let ordered: Vec<i32> = entries.iter().map(|e| e.initiative_total).collect();
        let mut sorted = ordered.clone();
        sorted.sort_by(|x, y| y.cmp(x));
        assert_eq!(ordered, sorted);
    }

    #[test]
    fn test_initiative_sort_tie_breaks_by_dexterity_then_name() {
        // Same total, higher DEX wins; same total AND same DEX → name asc.
        let mut entries = vec![
            InitiativeEntry { entity_id: Uuid::new_v4(), name: "Zed".into(), dexterity: 14, initiative_total: 12 },
            InitiativeEntry { entity_id: Uuid::new_v4(), name: "Amy".into(), dexterity: 14, initiative_total: 12 },
            InitiativeEntry { entity_id: Uuid::new_v4(), name: "Quick".into(), dexterity: 18, initiative_total: 12 },
            InitiativeEntry { entity_id: Uuid::new_v4(), name: "Slow".into(), dexterity: 8, initiative_total: 15 },
        ];
        sort_initiative_entries(&mut entries);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Slow", "Quick", "Amy", "Zed"],
            "total desc, then DEX desc, then name asc"
        );
    }

    #[test]
    fn test_end_combat_clears_state() {
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(Uuid::new_v4(), "Solo", 10), None).unwrap();
        let mut dice = DiceEngine::with_seed(7);
        session.begin_combat(&mut dice);
        assert!(session.combat.in_combat);
        // A couple of turns so round > 1 before ending.
        session.combat.next_turn();

        session.end_combat();
        assert!(!session.combat.in_combat);
        assert_eq!(session.combat.round, 0);
        assert_eq!(session.combat.turn_index, 0);
        assert!(session.combat.order.is_empty());

        // Combat can begin again cleanly afterwards.
        let entries = session.begin_combat(&mut dice);
        assert_eq!(entries.len(), 1);
        assert_eq!(session.combat.round, 1);
    }

    #[test]
    fn test_next_turn_wraps_order_and_increments_round() {
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        let ids: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
        for (i, id) in ids.iter().enumerate() {
            session.add_entity(entity(*id, &format!("E{}", i), 10), None).unwrap();
        }
        session.begin_combat(&mut DiceEngine::with_seed(3));
        assert_eq!(session.combat.round, 1);
        // Turn order is the rolled initiative order, not spawn order.
        let order = session.combat.order.clone();
        assert_eq!(order.len(), 3);

        for (step, expected_idx) in [1usize, 2, 0].iter().enumerate() {
            let (idx, round, actor) = session.combat.next_turn();
            assert_eq!(idx, *expected_idx, "step {}", step);
            assert_eq!(actor, Some(order[*expected_idx]), "step {}", step);
            if step < 2 {
                assert_eq!(round, 1);
            }
        }
        // Wrapping back to index 0 bumped the round.
        assert_eq!(session.combat.round, 2);

        let (_, _, actor) = session.combat.next_turn();
        assert_eq!(actor, Some(order[1]));
        assert_eq!(session.combat.turn_index, 1);
    }

    #[test]
    fn test_next_turn_without_order_is_a_noop() {
        let mut state = InitiativeCombatState::default();
        let (idx, round, actor) = state.next_turn();
        assert_eq!((idx, round, actor), (0, 0, None));
    }

    #[test]
    fn test_legacy_combat_payload_without_order_deserializes() {
        let raw = serde_json::json!({ "in_combat": false, "round": 2, "turn_index": 1 });
        let state: InitiativeCombatState = serde_json::from_value(raw).expect("legacy payload");
        assert!(state.order.is_empty());
        assert_eq!(state.round, 2);
    }

    #[test]
    fn test_seeded_begin_combat_is_reproducible() {
        // Fixed ids so the deterministic sorted-id roll visitation matches
        // run to run; only the seed varies.
        let a = Uuid::from_u128(0xA);
        let b = Uuid::from_u128(0xB);
        let build = |seed: u64| {
            let mut session = GameSession::new(Uuid::from_u128(1), Uuid::from_u128(2), "t".into());
            session.add_entity(entity(a, "Ann", 16), None).unwrap();
            session.add_entity(entity(b, "Bob", 12), None).unwrap();
            let mut dice = DiceEngine::with_seed(seed);
            (session.begin_combat(&mut dice), session.combat.order.clone())
        };
        assert_eq!(build(1234), build(1234));
        assert_ne!(build(1234), build(5678), "different seeds may reorder");
    }
}
