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

/// SRD Medicine DC to stabilize a dying creature (see
/// [`EntityState::stabilize_attempt`]).
pub const STABILIZE_MEDICINE_DC: i32 = 10;

/// SRD reach for the Help action's combat use: the helped-against enemy must
/// be within 5 ft of the HELPER (see [`GameSession::take_help`]).
pub const HELP_REACH_FEET: f32 = 5.0;

/// Result of one stabilize attempt on a dying creature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StabilizeAttemptOutcome {
    pub dc: i32,
    pub natural_roll: i32,
    pub modifier: i32,
    pub total: i32,
    pub success: bool,
    /// Death-save success tally AFTER the attempt (3 => stabilized).
    pub successes_after: u8,
    /// Death-save failure tally AFTER the attempt (unchanged by this check).
    pub failures_after: u8,
    pub is_stabilized_after: bool,
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
    /// SRD Light weapon property. Serde default (false) keeps legacy stat
    /// blocks deserializing; Two-Weapon Fighting requires BOTH held weapons to
    /// be Light (see
    /// [`crate::actions::ActionResolver::resolve_offhand_attack`]).
    ///
    /// KNOWN LIMITATION (disclosed honestly): the SRD importer does not yet
    /// parse weapon properties out of monster text, so a stat block must opt
    /// in by declaring `"light": true` explicitly. Undeclared weapons are
    /// refused as non-Light — never silently permitted.
    #[serde(default)]
    pub light: bool,
}

/// Default unarmed strike used when an entity has no explicit attacks.
impl Default for AttackAction {
    fn default() -> Self {
        Self {
            name: "Unarmed Strike".to_string(),
            attack_bonus: 0,
            damage_expression: "1".to_string(),
            damage_type: DamageType::Bludgeoning,
            light: false,
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
    /// Per-cell lighting zones ([`LightingZoneCell`]). Cells absent from this
    /// list are Bright by convention. Serde default keeps older maps
    /// (lighting-less) deserializing.
    #[serde(default)]
    pub lighting_zones: Vec<LightingZoneCell>,
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
            lighting_zones: Vec::new(),
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
        for cell in &self.lighting_zones {
            if cell.x >= self.width || cell.y >= self.height {
                return Err(format!(
                    "lighting cell ({}, {}) out of {}x{} bounds",
                    cell.x, cell.y, self.width, self.height
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
    /// SRD Dodge action taken this turn: attackers roll against this entity at
    /// disadvantage until its next turn refresh clears the flag.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dodge_until_next_turn: bool,
    /// SRD Disengage action taken this turn: leaving an adjacent hostile's
    /// reach provokes NO opportunity attacks until the next turn refresh.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disengaged_until_next_turn: bool,
    /// SRD Dash latch: the movement-budget top-up is granted once per turn;
    /// the next turn refresh re-arms it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dashed_this_turn: bool,
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
    /// SRD Ready action declaration held until the actor's next turn refresh.
    /// Serde default keeps pre-existing persisted sessions deserializing; the
    /// engine stores and displays it only — resolution is GM adjudication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readied_action: Option<ReadiedAction>,
    /// SRD Help action promise, stored ON THE BENEFICIARY: the id of the
    /// helper whose aid grants Advantage on the NEXT attack roll made against
    /// this entity by an ally of that helper (see
    /// [`GameSession::take_help`] / [`GameSession::consume_help_advantage`]).
    /// Consumed once by the first qualifying attack and cleared at the round
    /// refresh. Serde default keeps legacy payloads deserializing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attacker_has_advantage_against: Option<String>,
    /// SRD Help action promise for ABILITY CHECKS, stored ON THE BENEFICIARY:
    /// the id of the helper whose aid grants Advantage on this entity's NEXT
    /// ability check (see [`GameSession::take_help_check`] /
    /// [`GameSession::consume_help_check_advantage`]). Consumed exactly once
    /// by the first check the beneficiary rolls and cleared at the round
    /// refresh. Kept separate from
    /// [`EntityState::next_attacker_has_advantage_against`] so an attack-help
    /// promise can never be cashed by a check nor vice versa. Serde default
    /// keeps legacy payloads deserializing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_check_has_advantage_from: Option<String>,
    /// SRD inspiration (GOALS.md P5): at most ONE point per character, granted
    /// by GM fiat for heroic play and spent to gain Advantage on one d20 roll
    /// (attack / check / save). Spent atomically with the edge computation in
    /// [`crate::rules::RulesEvaluator::edge_from_conditions_with_inspiration`];
    /// every transition journals an `INSPIRATION_CHANGED` ledger event so a
    /// safety rewind can restore a point whose spend was undone. Serde
    /// default keeps legacy serialized entities deserializing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inspiration: bool,
    /// Active SRD vision/sense mode ([`VisionMode`]). None = ordinary sight.
    /// Feeds lighting-aware line-of-sight in `vtt_spatial::lighting`; serde
    /// default keeps pre-existing persisted entities deserializing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision_mode: Option<VisionMode>,
    /// Range in feet of the active special sense (darkvision 60/120,
    /// blindsight 10-30, truesight 60+ — see
    /// [`VisionMode::typical_range_feet`]). None = normal sight, unlimited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sense_range_feet: Option<f32>,
    /// Bound-hands model for somatic spell components: how many of the
    /// creature's two hands are currently occupied (a hand holding a won
    /// grapple is the only writer this engine has today; weapon wielding is
    /// not tracked). Casting a spell with a somatic component requires at
    /// least one free hand — see
    /// [`crate::rules::RulesEvaluator::validate_and_cast_spell`]. Serde
    /// default keeps legacy serialized entities deserializing.
    #[serde(default)]
    pub hands_occupied: u8,
    /// Remaining unspent hit dice (SRD short-rest healing pool). The die SIZE
    /// lives in [`Self::hit_dice_size`] (0 = unknown / no class modelled), so a
    /// fighter's d10 and a wizard's d6 can coexist on one board. Both fields
    /// serde-default to keep legacy payloads deserializing; an empty pool just
    /// means a short rest cannot fund any healing for this creature.
    #[serde(default)]
    pub hit_dice_remaining: u32,
    /// Hit-die size of this creature's class (d6/d8/d10/d12). 0 = not
    /// modelled — spending is refused until a value exists.
    #[serde(default)]
    pub hit_dice_size: u32,
}

impl EntityState {
    /// Hands on a standard humanoid body — the bound-hands model's ceiling
    /// (`hands_occupied` saturates here).
    pub const MODELED_HANDS: u8 = 2;

    /// The vision this entity effectively sees with: unset => Normal sight.
    pub fn effective_vision_mode(&self) -> VisionMode {
        self.vision_mode.unwrap_or(VisionMode::Normal)
    }

    /// How far the active sense reaches. Unset/Normal => unlimited (the
    /// spatial layer treats infinity as "no range gate").
    pub fn effective_sense_range_feet(&self) -> f32 {
        self.sense_range_feet.unwrap_or(f32::INFINITY)
    }

    /// SRD Blinded condition present? Feeds the lighting-aware line-of-sight
    /// override in `vtt_spatial` (blindness suppresses darkvision and every
    /// other special sense) — the attack-roll disadvantage side of the
    /// condition is carried by [`Condition::inflicts_disadvantage_on_attacks`].
    pub fn is_blinded(&self) -> bool {
        self.conditions.contains(&Condition::Blinded)
    }

    /// Free hands left out of this creature's modeled two.
    pub fn free_hands(&self) -> u8 {
        Self::MODELED_HANDS.saturating_sub(self.hands_occupied.min(Self::MODELED_HANDS))
    }

    /// Occupies one hand (e.g. a won grapple keeps a hold). Saturates at two:
    /// a humanoid has no third hand to bind.
    pub fn occupy_hand(&mut self) {
        self.hands_occupied = self.hands_occupied.saturating_add(1).min(Self::MODELED_HANDS);
    }

    /// Frees one hand (e.g. the grapple was escaped or broken). Saturating at
    /// zero so stray releases can never underflow into phantom hands.
    pub fn release_hand(&mut self) {
        self.hands_occupied = self.hands_occupied.saturating_sub(1);
    }
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

    /// Spends the entity's Bonus Action — same enforcement contract as
    /// [`EntityState::spend_action`], against `action_budget.bonus_action`.
    /// This is where Two-Weapon Fighting's off-hand strike (and any future
    /// bonus-action spell pipeline) must buy its turn resource.
    pub fn spend_bonus_action(&mut self) -> Result<(), String> {
        if !self.can_act() {
            return Err("ENTITY_CANNOT_ACT".to_string());
        }
        if !self.action_budget.bonus_action {
            return Err("BONUS_ACTION_ECONOMY_EXHAUSTED".to_string());
        }
        self.action_budget.bonus_action = false;
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

    // ------------------------------------------------- standard action options

    /// SRD Dodge: until this entity's next turn refresh, every attack against
    /// it is made at disadvantage (consumed by
    /// [`crate::rules::RulesEvaluator::edge_from_conditions`]). Spends the
    /// Action; idempotence is naturally prevented by the action economy.
    pub fn take_dodge(&mut self) -> Result<(), String> {
        self.spend_action()?;
        self.dodge_until_next_turn = true;
        Ok(())
    }

    /// SRD Dash: adds exactly one speed's worth of movement to the remaining
    /// budget (exhaustion-modified speed — a level-5 creature dashes for 0 ft).
    /// Once per turn: a second Dash within the same turn is rejected with
    /// `DASH_ALREADY_TAKEN` WITHOUT spending anything. The latch and the bonus
    /// movement both clear at the next turn refresh.
    pub fn take_dash(&mut self) -> Result<(), String> {
        if self.dashed_this_turn {
            return Err("DASH_ALREADY_TAKEN".to_string());
        }
        self.spend_action()?;
        self.dashed_this_turn = true;
        self.action_budget.movement_remaining_feet += self.effective_speed_feet();
        Ok(())
    }

    /// SRD Disengage: [`GameSession::move_entity`] reports no opportunity-
    /// attack triggers for this entity's movement until its next turn refresh.
    /// Spends the Action.
    pub fn take_disengage(&mut self) -> Result<(), String> {
        self.spend_action()?;
        self.disengaged_until_next_turn = true;
        Ok(())
    }

    /// SRD Stabilize: a DC 10 Medicine check on a dying creature. On a pass,
    /// the creature's death-save SUCCESS tally gains +1 (existing tallies are
    /// preserved — see [`DeathSaveState`]); reaching three successes marks it
    /// stabilized. A failed check changes nothing (the Action is still spent by
    /// the caller). Rolls are supplied by the caller so seeded server dice stay
    /// authoritative — same contract as [`ActionResolver::resolve_death_save`].
    ///
    /// Rejections: `ENTITY_DEAD`, `TARGET_NOT_DYING` (has hit points),
    /// `ALREADY_STABILIZED`.
    pub fn stabilize_attempt(
        &mut self,
        medicine_natural_roll: i32,
        medicine_modifier: i32,
    ) -> Result<StabilizeAttemptOutcome, String> {
        if self.is_dead {
            return Err("ENTITY_DEAD".to_string());
        }
        if self.current_hp > 0 {
            return Err("TARGET_NOT_DYING".to_string());
        }
        if self.death_saves.is_stabilized {
            return Err("ALREADY_STABILIZED".to_string());
        }

        let total = medicine_natural_roll + medicine_modifier;
        let success = total >= STABILIZE_MEDICINE_DC;
        if success {
            self.death_saves.successes = self.death_saves.successes.saturating_add(1);
            if self.death_saves.successes >= 3 {
                self.death_saves.is_stabilized = true;
            }
        }

        Ok(StabilizeAttemptOutcome {
            dc: STABILIZE_MEDICINE_DC,
            natural_roll: medicine_natural_roll,
            modifier: medicine_modifier,
            total,
            success,
            successes_after: self.death_saves.successes,
            failures_after: self.death_saves.failures,
            is_stabilized_after: self.death_saves.is_stabilized,
        })
    }

    /// Adds a condition if not already present. Matching is by variant
    /// discriminant, so payload-carrying variants (e.g. `Exhaustion(u8)`) are
    /// treated as singletons regardless of their level. Idempotent — safe to
    /// call on every successful grapple/shove.
    pub fn add_condition(&mut self, condition: Condition) {
        let disc = std::mem::discriminant(&condition);
        if self.conditions.iter().any(|c| std::mem::discriminant(c) == disc) {
            return;
        }
        self.conditions.push(condition);
    }

    /// True when this entity carries the given condition (matched by variant
    /// discriminant — see [`EntityState::add_condition`]).
    pub fn has_condition(&self, condition: &Condition) -> bool {
        let disc = std::mem::discriminant(condition);
        self.conditions.iter().any(|c| std::mem::discriminant(c) == disc)
    }

    /// Removes every instance of the given condition (by variant
    /// discriminant). Returns true when something was actually removed.
    pub fn remove_condition(&mut self, condition: &Condition) -> bool {
        let disc = std::mem::discriminant(condition);
        let before = self.conditions.len();
        self.conditions.retain(|c| std::mem::discriminant(c) != disc);
        before != self.conditions.len()
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

    /// Speed as modified by conditions: SRD Grappled zeroes it outright
    /// (see [`crate::actions::GrappleResolution`] — a grapple applies
    /// `Condition::Grappled`, NOT Restrained, and "its speed becomes 0"),
    /// exhaustion halves it at level >= 2 and zeroes it at level >= 5.
    /// All movement-budget seeding must use THIS value instead of the raw
    /// `speed_feet`.
    pub fn effective_speed_feet(&self) -> f32 {
        if self.has_condition(&Condition::Grappled) {
            return 0.0;
        }
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

    /// Short-rest hit-dice spend (SRD 5e): roll one class hit die per die
    /// spent and heal that many hit points plus the Constitution modifier PER
    /// DIE, drawing down [`Self::hit_dice_remaining`]. Healing clamps at max
    /// HP (the pool is spent even when the clamp wastes rolled faces — SRD
    /// leaves no change back). The spend is refused whole (no partial
    /// draw-down) unless `dice` is at least 1, fully funded by the pool AND
    /// the die size is modelled.
    ///
    /// All randomness is drawn through the caller's [`DiceEngine`] so a seeded
    /// engine reproduces the exact same faces (same contract as every other
    /// combat roll). The caller owns the ledger: a spend is only
    /// auditable/rewindable once its `SHORT_REST_APPLIED` event (carrying the
    /// returned rolls and `hp_remaining`) reaches the ledger — see the
    /// gateway's rest endpoint.
    pub fn spend_hit_dice(
        &mut self,
        dice_engine: &mut DiceEngine,
        dice: u32,
    ) -> Result<HitDiceSpendReport, String> {
        if dice == 0 {
            return Err("a short rest must spend at least one hit die".to_string());
        }
        if self.hit_dice_size == 0 {
            return Err("entity has no modelled hit-die size; cannot spend hit dice".to_string());
        }
        if dice > self.hit_dice_remaining {
            return Err(format!(
                "not enough hit dice: requested {dice}, only {} remain",
                self.hit_dice_remaining
            ));
        }
        // Roll first, then commit — an early return above must not touch state.
        let con_modifier = self.abilities.modifier(Ability::Constitution);
        let mut rolls = Vec::with_capacity(dice as usize);
        for _ in 0..dice {
            rolls.push(dice_engine.roll_die(self.hit_dice_size));
        }
        let hit_dice_before = self.hit_dice_remaining;
        self.hit_dice_remaining -= dice;

        let hp_before = self.current_hp;
        let healing = (rolls.iter().sum::<i32>() + con_modifier * dice as i32).max(0);
        self.current_hp = (self.current_hp + healing).min(self.effective_max_hp());
        // Regaining hit points ends the dying state (SRD) and wipes any
        // accumulated death-save tally, mirroring reset_death_saves_if_healed.
        if self.current_hp > 0 {
            self.is_conscious = true;
            self.reset_death_saves_if_healed();
        }
        Ok(HitDiceSpendReport {
            dice_spent: dice,
            die_size: self.hit_dice_size,
            rolls,
            con_modifier,
            healing,
            hp_before,
            hp_after: self.current_hp,
            hit_dice_remaining: self.hit_dice_remaining,
            hit_dice_before,
        })
    }
}

/// Outcome of one short-rest hit-dice spend ([`EntityState::spend_hit_dice`]).
/// Everything the caller needs to journal a rewindable `SHORT_REST_APPLIED`
/// ledger event in one pass.
#[derive(Debug, Clone, PartialEq)]
pub struct HitDiceSpendReport {
    pub dice_spent: u32,
    pub die_size: u32,
    /// Kept faces in roll order.
    pub rolls: Vec<i32>,
    /// Per-die CON modifier applied to each die's contribution.
    pub con_modifier: i32,
    /// Total healed BEFORE the max-HP clamp (`sum(rolls) + con_modifier *
    /// dice`, floored at zero).
    pub healing: i32,
    pub hp_before: i32,
    /// Post-heal HP after the max-HP clamp — this is what a surviving
    /// `SHORT_REST_APPLIED` replay restores.
    pub hp_after: i32,
    pub hit_dice_remaining: u32,
    /// Pool size BEFORE this spend — journaled as `hit_dice_before` so a
    /// safety rewind past the spend can restore the pre-spend pool even when
    /// no earlier short-rest event survives.
    pub hit_dice_before: u32,
}

impl EntityState {
    // Allowed: 8-arg constructor, one arg per struct field — a params
    // struct would just re-list the same fields.
    #[allow(clippy::too_many_arguments)]
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
            dodge_until_next_turn: false,
            disengaged_until_next_turn: false,
            dashed_this_turn: false,
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
            readied_action: None,
            next_attacker_has_advantage_against: None,
            next_check_has_advantage_from: None,
            inspiration: false,
            vision_mode: None,
            sense_range_feet: None,
            hands_occupied: 0,
            hit_dice_remaining: 0,
            hit_dice_size: 0,
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

/// The structured trigger specification of a readied action (SRD Ready).
///
/// Mechanical variants let clients render and eventually auto-detect the
/// common triggers; [`ReadiedTrigger::Freeform`] keeps anything else as a
/// string for GM adjudication — the engine never *fires* a trigger by itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadiedTrigger {
    /// A hostile creature moves into the actor's melee reach.
    EnemyEntersReach,
    /// A hostile creature attacks (the actor or an ally).
    EnemyAttacks,
    /// The actor's own next turn begins.
    TurnStart,
    /// Any other declared condition ("when the bell tolls") — GM adjudicated.
    Freeform(String),
}

impl Default for ReadiedTrigger {
    fn default() -> Self {
        // Legacy readied actions predate structured triggers: they were pure
        // GM adjudication, so they default to an empty freeform rather than
        // inventing a mechanical trigger they never had.
        ReadiedTrigger::Freeform(String::new())
    }
}

impl ReadiedTrigger {
    /// Human-readable text folded into the stored description for display.
    /// Empty for an empty freeform so legacy-style declarations stay clean.
    pub fn hint_text(&self) -> String {
        match self {
            ReadiedTrigger::EnemyEntersReach => "enemy enters reach".to_string(),
            ReadiedTrigger::EnemyAttacks => "enemy attacks".to_string(),
            ReadiedTrigger::TurnStart => "turn start".to_string(),
            ReadiedTrigger::Freeform(text) => text.trim().to_string(),
        }
    }
}

/// SRD Ready action: an Action spent to hold a triggered response ("I attack
/// the goblin when it moves"). The engine stores and surfaces the declaration;
/// resolving the held action goes through [`GameSession::release_readied_action`]
/// (which spends the Reaction). An unreleased entry clears at the round refresh
/// (see [`GameSession::advance_round`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadiedAction {
    pub description: String,
    /// Combat round the action was readied on (0 outside combat).
    pub set_on_round: u32,
    /// Structured trigger spec; `serde(default)` keeps legacy payloads
    /// deserializing as an empty [`ReadiedTrigger::Freeform`].
    #[serde(default)]
    pub trigger: ReadiedTrigger,
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
    /// Entities whose UNRELEASED readied action expired this round (SRD: the
    /// held Action is lost when the trigger never fires). Serde default keeps
    /// legacy reports deserializing.
    #[serde(default)]
    pub readied_expired: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RewindReport {
    pub reverted_event_count: usize,
    pub restored_entities: usize,
    pub removed_entities: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
pub struct OpportunityAttackTrigger {
    pub attacker_id: Uuid,
    pub mover_id: Uuid,
}

/// A provoked-but-NOT-YET-RESOLVED opportunity attack: the mover left an
/// armed enemy's reach and the enemy may now take one melee swing against the
/// REACTION economy through [`GameSession::take_opportunity_attack`]. The
/// entry is cleared when taken, cancelled by Disengage
/// ([`GameSession::cancel_opportunity_attacks_against`]), or expired by the
/// round refresh — never carried across rounds.
///
/// Serde default keeps legacy serialized sessions (without pending OAs)
/// deserializing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PendingOpportunityAttack {
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
    /// Opportunity attacks provoked this round but not yet resolved. Written
    /// by [`GameSession::move_entity`], consumed by
    /// [`GameSession::take_opportunity_attack`], cancelled by Disengage and by
    /// the round refresh (an OA offer does not survive the round).
    /// Serde default keeps legacy serialized sessions deserializing.
    #[serde(default)]
    pub pending_opportunity_attacks: Vec<PendingOpportunityAttack>,
    pub ledger: EventSourcingLedger,
    pub ingress_stack: Vec<IngressEvent>,
    pub egress_stack: Vec<EgressEvent>,
    /// Grapple-hold attribution (audit F-A4#3): escaper id -> the creature
    /// actually holding it, stamped when a won grapple resolves. Without it an
    /// escape could free ANY hands-occupied bystander's hand while the true
    /// holder kept theirs. Serde default keeps legacy sessions deserializing;
    /// [`GameSession::holds`] falls back to the surviving ledger for unstamped
    /// holds.
    #[serde(default)]
    pub grapple_holders: HashMap<Uuid, Uuid>,
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
            pending_opportunity_attacks: Vec::new(),
            ledger: EventSourcingLedger::new(),
            ingress_stack: Vec::new(),
            egress_stack: Vec::new(),
            grapple_holders: HashMap::new(),
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

    // -------------------------------------------- opportunity attack resolution

    /// SRD Opportunity Attack RESOLUTION: the reacting side takes its melee
    /// swing against a mover who just left its reach. Spends the REACTION —
    /// never the Action — and clears the pending trigger.
    ///
    /// Only legal against the exact attacker/mover pairing whose movement
    /// armed it this round (`OA_NOT_PENDING` otherwise): a stranger cannot
    /// borrow someone else's provocation. A spent or unavailable reaction is
    /// rejected with `REACTION_UNAVAILABLE` and leaves the pending entry
    /// standing (it expires at the round refresh either way).
    pub fn take_opportunity_attack(
        &mut self,
        attacker_id: Uuid,
        mover_id: Uuid,
    ) -> Result<PendingOpportunityAttack, String> {
        let index = self.pending_opportunity_attacks.iter().position(|p| {
            p.attacker_id == attacker_id && p.mover_id == mover_id
        });
        let index = match index {
            Some(i) => i,
            None => return Err("OA_NOT_PENDING".to_string()),
        };
        if !self.consume_reaction(attacker_id, ReactionType::OpportunityAttack) {
            // The pairing is real but the reaction is gone: leave the entry
            // standing (it expires at the round refresh) — a caller that
            // re-arms and retries must find the trigger, not a black hole.
            return Err("REACTION_UNAVAILABLE".to_string());
        }
        let pending = self.pending_opportunity_attacks.remove(index);
        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            attacker_id,
            "OPPORTUNITY_ATTACK_TAKEN",
            serde_json::json!({
                "attacker_id": attacker_id,
                "mover_id": mover_id,
            }),
        );
        Ok(pending)
    }

    /// Withdraws every pending opportunity attack AGAINST this mover — the
    /// Disengage path. The provoking enemies keep their readied reactions:
    /// nothing fired, so nothing is consumed. Returns how many entries were
    /// dropped.
    pub fn cancel_opportunity_attacks_against(&mut self, mover_id: Uuid) -> usize {
        let before = self.pending_opportunity_attacks.len();
        self.pending_opportunity_attacks
            .retain(|p| p.mover_id != mover_id);
        before - self.pending_opportunity_attacks.len()
    }

    // ------------------------------------------------------------ ready action

    /// SRD Ready: spends the entity's Action to hold a triggered response
    /// ("I attack the goblin when it moves") until its next turn refresh.
    ///
    /// The declaration carries a STRUCTURED [`ReadiedTrigger`] spec; its text
    /// is folded into the stored description so a single string carries the
    /// whole declaration for display. The engine never fires the trigger by
    /// itself — resolving it goes through [`GameSession::release_readied_action`]
    /// or stays a GM adjudication.
    ///
    /// Rejections: `ENTITY_NOT_FOUND`, `ENTITY_CANNOT_ACT`,
    /// `ACTION_ECONOMY_EXHAUSTED`. A rejected Ready stores nothing and
    /// overwrites nothing.
    pub fn ready_action(
        &mut self,
        entity_id: Uuid,
        description: &str,
        trigger: ReadiedTrigger,
    ) -> Result<ReadiedAction, String> {
        let mut description = description.trim().to_string();
        let hint = trigger.hint_text();
        if !hint.is_empty() {
            description = format!("{} (trigger: {})", description, hint);
        }
        let round = self.combat.round;

        let entity = self
            .entities
            .get_mut(&entity_id)
            .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
        // Single action-economy enforcement point: rejects incapacitated or
        // Action-less actors BEFORE anything is stored.
        entity.spend_action()?;

        let readied = ReadiedAction {
            description,
            set_on_round: round,
            trigger,
        };
        entity.readied_action = Some(readied.clone());

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "READY_ACTION_SET",
            serde_json::json!({
                "description": readied.description,
                "set_on_round": readied.set_on_round,
                "trigger": readied.trigger,
            }),
        );
        Ok(readied)
    }

    /// SRD: resolving a readied action ("I attack the goblin when it moves" —
    /// and now it moved) takes the actor's REACTION. This spends that Reaction,
    /// clears the stored declaration and ledgers READY_ACTION_RELEASED with an
    /// explicit `reaction_spent` marker so replay can see WHY the budget is
    /// gone. The engine resolves only the bookkeeping — the held action itself
    /// (the attack roll, the spell) still flows through its normal endpoint.
    ///
    /// Rejections (nothing spent, nothing cleared): `ENTITY_NOT_FOUND`,
    /// `NO_READIED_ACTION`, `ENTITY_CANNOT_ACT` (an incapacitated creature
    /// cannot take reactions), `REACTION_SPENT`.
    pub fn release_readied_action(&mut self, entity_id: Uuid) -> Result<ReadiedAction, String> {
        let entity = self
            .entities
            .get_mut(&entity_id)
            .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
        if entity.readied_action.is_none() {
            return Err("NO_READIED_ACTION".to_string());
        }
        if !entity.can_act() {
            return Err("ENTITY_CANNOT_ACT".to_string());
        }
        if !entity.action_budget.reaction {
            return Err("REACTION_SPENT".to_string());
        }
        entity.action_budget.reaction = false;
        let released = entity.readied_action.take().expect("checked above");

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "READY_ACTION_RELEASED",
            serde_json::json!({
                "description": released.description,
                "set_on_round": released.set_on_round,
                "trigger": released.trigger,
                "reaction_spent": true,
            }),
        );
        Ok(released)
    }

    // ------------------------------------------------------------- help action

    /// SRD Help: spends the helper's Action to promise Advantage on the NEXT
    /// attack roll made against `target_entity_id` by an ally of the helper
    /// (the helper themself qualifies — they are on their own side).
    ///
    /// The promise is stored ON THE TARGET as
    /// [`EntityState::next_attacker_has_advantage_against`] naming the helper,
    /// and is consumed exactly once by [`GameSession::consume_help_advantage`]
    /// when a qualifying attack is rolled. A second Help before the first is
    /// cashed simply overwrites it (last aid wins); the round refresh clears
    /// an unconsumed promise.
    ///
    /// Rejections (nothing is spent or overwritten):
    /// `ENTITY_NOT_FOUND`, `TARGET_NOT_FOUND`, `SELF_TARGET_INVALID`,
    /// `OUT_OF_REACH` (SRD: the helped-against enemy must be within 5 ft of
    /// the helper), `ENTITY_CANNOT_ACT`, `ACTION_ECONOMY_EXHAUSTED`,
    /// `TARGET_ALREADY_DEAD`.
    pub fn take_help(&mut self, entity_id: Uuid, target_entity_id: Uuid) -> Result<(), String> {
        if !self.entities.contains_key(&entity_id) {
            return Err("ENTITY_NOT_FOUND".to_string());
        }
        if !self.entities.contains_key(&target_entity_id) {
            return Err("TARGET_NOT_FOUND".to_string());
        }
        if entity_id == target_entity_id {
            return Err("SELF_TARGET_INVALID".to_string());
        }

        // Read-only gates BEFORE any state changes or budget spends.
        let (helper_can_act, in_reach, target_dead) = {
            let helper = &self.entities[&entity_id];
            let target = &self.entities[&target_entity_id];
            (
                helper.can_act(),
                helper.distance_to_feet(target) <= HELP_REACH_FEET,
                target.is_dead,
            )
        };
        if !in_reach {
            return Err("OUT_OF_REACH".to_string());
        }
        if !helper_can_act {
            return Err("ENTITY_CANNOT_ACT".to_string());
        }
        if target_dead {
            return Err("TARGET_ALREADY_DEAD".to_string());
        }

        // Single action-economy enforcement point: rejects an Action-less or
        // incapacitated helper BEFORE anything is granted. The lookups cannot
        // miss here — both ids were `contains_key`-checked above — but they
        // propagate as `ENTITY_NOT_FOUND` instead of panicking, matching the
        // `Result`-returning style of every other GameSession mutator.
        let helper = self
            .entities
            .get_mut(&entity_id)
            .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
        helper.spend_action()?;

        let beneficiary = self
            .entities
            .get_mut(&target_entity_id)
            .ok_or_else(|| "TARGET_NOT_FOUND".to_string())?;
        beneficiary.next_attacker_has_advantage_against = Some(entity_id.to_string());

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "HELP_ACTION",
            serde_json::json!({
                "helper_id": entity_id.to_string(),
                "target_entity_id": target_entity_id.to_string(),
            }),
        );
        Ok(())
    }

    /// Consumes a standing Help promise against `target_id` for `attacker_id`.
    ///
    /// Returns true only when an unconsumed promise exists AND its helper is
    /// still in the session AND the attacker is on the helper's side
    /// (`is_player` parity) — that attacker gains Advantage and the token is
    /// burned. A hostile attacker neither benefits from nor burns the promise,
    /// so the aided ally keeps it. A stale promise whose helper has left the
    /// session is discarded without granting anything.
    pub fn consume_help_advantage(&mut self, attacker_id: Uuid, target_id: Uuid) -> bool {
        let helper_id = match self
            .entities
            .get(&target_id)
            .and_then(|t| t.next_attacker_has_advantage_against.clone())
        {
            Some(h) => h,
            None => return false,
        };

        let helper = match helper_id
            .parse::<Uuid>()
            .ok()
            .and_then(|h| self.entities.get(&h))
        {
            Some(helper) => helper,
            None => {
                // Helper despawned: the promise can no longer be kept.
                if let Some(t) = self.entities.get_mut(&target_id) {
                    t.next_attacker_has_advantage_against = None;
                }
                return false;
            }
        };
        let attacker_side = match self.entities.get(&attacker_id) {
            Some(a) => a.is_player,
            None => return false,
        };
        if helper.is_player != attacker_side {
            return false; // hostile attack: the ally's benefit stays standing
        }

        // The target was `contains_key`-checked at the top, so this branch is
        // unreachable in practice; guard anyway rather than panic — a racing
        // despawn simply means there is no promise left to clear.
        match self.entities.get_mut(&target_id) {
            Some(t) => {
                t.next_attacker_has_advantage_against = None;
                true
            }
            None => false,
        }
    }

    // ------------------------------------------------------------ inspiration

    /// SRD inspiration (GOALS.md P5): grants ONE point of inspiration to
    /// `entity_id` (GM fiat for heroic play). RAW caps a character at a single
    /// point: granting to someone who already holds one is rejected with
    /// `INSPIRATION_ALREADY_HELD` and changes nothing. Every accepted grant
    /// journals an `INSPIRATION_CHANGED` ledger event `{granted: true, reason}`
    /// so safety rewinds replay the correct holding.
    ///
    /// Rejections: `ENTITY_NOT_FOUND`, `INSPIRATION_ALREADY_HELD`.
    pub fn grant_inspiration(&mut self, entity_id: Uuid, reason: Option<&str>) -> Result<(), String> {
        let entity = self
            .entities
            .get_mut(&entity_id)
            .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
        if entity.inspiration {
            return Err("INSPIRATION_ALREADY_HELD".to_string());
        }
        entity.inspiration = true;

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "INSPIRATION_CHANGED",
            serde_json::json!({
                "granted": true,
                "reason": reason,
            }),
        );
        Ok(())
    }

    /// Removes a held inspiration point (GM fiat). Revoking from someone who
    /// holds none is rejected with `INSPIRATION_NOT_HELD` and changes nothing.
    /// Journals `INSPIRATION_CHANGED {granted: false, reason}` on success.
    ///
    /// Rejections: `ENTITY_NOT_FOUND`, `INSPIRATION_NOT_HELD`.
    pub fn revoke_inspiration(&mut self, entity_id: Uuid, reason: Option<&str>) -> Result<(), String> {
        let entity = self
            .entities
            .get_mut(&entity_id)
            .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
        if !entity.inspiration {
            return Err("INSPIRATION_NOT_HELD".to_string());
        }
        entity.inspiration = false;

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "INSPIRATION_CHANGED",
            serde_json::json!({
                "granted": false,
                "reason": reason,
            }),
        );
        Ok(())
    }

    /// Spends the entity's held inspiration point for Advantage on one d20
    /// roll. Returns true when a point was actually held and burned; false is
    /// a silent no-op (nothing held — callers simply get no edge). The spend
    /// journals `INSPIRATION_CHANGED {granted: false, reason: "spent"}` so a
    /// safety rewind past the roll restores the point.
    ///
    /// Prefer [`crate::rules::RulesEvaluator::edge_from_conditions_with_inspiration`]
    /// at roll time: it consumes the point atomically WITH the advantage/
    /// disadvantage computation so an SRD cancellation never wastes it.
    pub fn consume_inspiration(&mut self, entity_id: Uuid) -> bool {
        let held = match self.entities.get_mut(&entity_id) {
            Some(e) => {
                let held = e.inspiration;
                e.inspiration = false;
                held
            }
            None => return false,
        };
        if !held {
            return false;
        }

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            entity_id,
            "INSPIRATION_CHANGED",
            serde_json::json!({
                "granted": false,
                "reason": "spent",
            }),
        );
        true
    }

    // ------------------------------------------------- help action: ability check

    /// SRD Help used on an ABILITY CHECK: spends the helper's Action to grant
    /// Advantage on the BENEFICIARY's next ability check ("I'll boost you up
    /// while you pick that lock"). The promise lives ON THE BENEFICIARY as
    /// [`EntityState::next_check_has_advantage_from`] naming the helper, and
    /// is consumed exactly once by [`GameSession::consume_help_check_advantage`].
    ///
    /// Distinct from [`GameSession::take_help`] (the combat use): attack-help
    /// promises can only be cashed by attack rolls, check-help only by checks,
    /// so one flavor can never silently eat the other's token.
    ///
    /// Reach: the helper must be able to physically assist — this engine uses
    /// the same 5 ft convention as the combat use ([`HELP_REACH_FEET`]), a
    /// disclosed approximation of the SRD's looser "within reach" wording.
    ///
    /// Rejections (nothing is spent): `ENTITY_NOT_FOUND`, `TARGET_NOT_FOUND`,
    /// `SELF_TARGET_INVALID`, `OUT_OF_REACH`, `ENTITY_CANNOT_ACT`,
    /// `ACTION_ECONOMY_EXHAUSTED`, `TARGET_ALREADY_DEAD`.
    pub fn take_help_check(
        &mut self,
        helper_id: Uuid,
        beneficiary_id: Uuid,
    ) -> Result<(), String> {
        if !self.entities.contains_key(&helper_id) {
            return Err("ENTITY_NOT_FOUND".to_string());
        }
        if !self.entities.contains_key(&beneficiary_id) {
            return Err("TARGET_NOT_FOUND".to_string());
        }
        if helper_id == beneficiary_id {
            return Err("SELF_TARGET_INVALID".to_string());
        }

        // Read-only gates BEFORE any state changes or budget spends.
        let (helper_can_act, in_reach, beneficiary_dead) = {
            let helper = &self.entities[&helper_id];
            let beneficiary = &self.entities[&beneficiary_id];
            (
                helper.can_act(),
                helper.distance_to_feet(beneficiary) <= HELP_REACH_FEET,
                beneficiary.is_dead,
            )
        };
        if !in_reach {
            return Err("OUT_OF_REACH".to_string());
        }
        if !helper_can_act {
            return Err("ENTITY_CANNOT_ACT".to_string());
        }
        if beneficiary_dead {
            return Err("TARGET_ALREADY_DEAD".to_string());
        }

        // Action economy AFTER every other gate passes, mirroring take_help:
        // an illegal help must not consume the turn.
        let helper = self
            .entities
            .get_mut(&helper_id)
            .ok_or_else(|| "ENTITY_NOT_FOUND".to_string())?;
        helper.spend_action()?;

        let beneficiary = self
            .entities
            .get_mut(&beneficiary_id)
            .ok_or_else(|| "TARGET_NOT_FOUND".to_string())?;
        beneficiary.next_check_has_advantage_from = Some(helper_id.to_string());

        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            helper_id,
            "HELP_CHECK_ACTION",
            serde_json::json!({
                "helper_id": helper_id.to_string(),
                "beneficiary_id": beneficiary_id.to_string(),
            }),
        );
        Ok(())
    }

    /// Consumes a standing check-help promise held BY `beneficiary_id`.
    /// Returns true exactly once — the first check cashes the token; a stale
    /// promise whose helper has left the session is discarded without
    /// granting anything.
    pub fn consume_help_check_advantage(&mut self, beneficiary_id: Uuid) -> bool {
        let helper_id = match self
            .entities
            .get(&beneficiary_id)
            .and_then(|b| b.next_check_has_advantage_from.clone())
        {
            Some(h) => h,
            None => return false,
        };

        let helper_present = match helper_id.parse::<Uuid>() {
            Ok(h) => self.entities.contains_key(&h),
            Err(_) => false,
        };

        match self.entities.get_mut(&beneficiary_id) {
            Some(b) => b.next_check_has_advantage_from = None,
            None => return false,
        }
        helper_present
    }

    // ---------------------------------------------------- condition lifecycle

    // --- grapple-hold attribution (audit F-A4#3) ---

    /// Records that `holder_id` is the creature holding `escaper_id` in a
    /// won grapple. Called when a grapple resolves as a win; the escape route
    /// consults it so only the TRUE holder's hand can be freed. A second won
    /// grapple against the same victim overwrites the stamp — last hold wins,
    /// mirroring how the single `Grappled` condition entry behaves.
    pub fn record_hold(&mut self, escaper_id: Uuid, holder_id: Uuid) {
        self.grapple_holders.insert(escaper_id, holder_id);
    }

    /// Drops the escaper's hold attribution when the hold ends (escape or GM
    /// release). Returns true when an attribution actually existed.
    pub fn release_hold(&mut self, escaper_id: Uuid) -> bool {
        self.grapple_holders.remove(&escaper_id).is_some()
    }

    /// True when `holder_id` currently holds `escaper_id` per this session's
    /// attribution map. Unstamped holds (legacy sessions persisted before the
    /// map existed, or snapshots restored without it) fall back to the
    /// surviving ledger: the latest surviving WON GRAPPLE_ATTEMPTED whose
    /// attacker/defender pair matches. The ledger fallback keeps pre-iteration-60
    /// holds escapable while never widening who may be named.
    pub fn holds(&self, escaper_id: &Uuid, holder_id: &Uuid) -> bool {
        if let Some(recorded) = self.grapple_holders.get(escaper_id) {
            return recorded == holder_id;
        }
        let is_won_hold_by = |e: &crate::event_log::GameEvent| {
            e.payload.get("success").and_then(|v| v.as_bool()) == Some(true)
                && e.payload.get("applied_condition").is_some()
                && e.actor_id == *holder_id
                && e.payload
                    .get("defender_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
                    == Some(*escaper_id)
        };
        self.ledger
            .events
            .iter()
            .rev()
            .filter(|e| !e.is_reverted)
            .find(|e| e.event_type == "GRAPPLE_ATTEMPTED" && is_won_hold_by(e))
            .is_some()
    }

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
            readied_expired: Vec::new(),
        };

        // An unresolved opportunity attack is a THIS-round offer: the mover is
        // already gone and the reacting side's readied reaction refreshes
        // below, so carrying the trigger across the round boundary would let a
        // stale pairing swing out of turn.
        self.pending_opportunity_attacks.clear();

        for (id, entity) in self.entities.iter_mut() {
            entity.shield_ac_bonus_active = false; // Shield lasts until the start of the caster's next turn
            // Dodge / Disengage last until the actor's next turn; the Dash
            // once-per-turn latch re-arms here too.
            entity.dodge_until_next_turn = false;
            entity.disengaged_until_next_turn = false;
            entity.dashed_this_turn = false;
            // A Help promise lasts only until the beneficiary's next turn —
            // the attack flavor AND the ability-check flavor alike.
            entity.next_attacker_has_advantage_against = None;
            entity.next_check_has_advantage_from = None;
            // SRD: a readied action lasts until the start of the actor's next
            // turn. If the trigger never fired, the held Action is simply lost
            // — but the LOSS is ledgered and reported so audit/replay can see
            // an actor's spent Action evaporating instead of it vanishing
            // silently.
            if let Some(expired) = entity.readied_action.take() {
                report.readied_expired.push(*id);
                self.ledger.append_event(
                    self.session_id,
                    self.campaign_id,
                    *id,
                    "READIED_ACTION_EXPIRED",
                    serde_json::json!({
                        "description": expired.description,
                        "set_on_round": expired.set_on_round,
                        "trigger": expired.trigger,
                    }),
                );
            }
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
        // A mover who took the Disengage action provokes nothing this turn —
        // and a provoked-but-suppressed enemy keeps its readied reaction,
        // because no trigger actually fired.
        //
        // Detection PENDS the swing instead of spending it: the reacting side
        // resolves through [`GameSession::take_opportunity_attack`] against its
        // REACTION budget (one per round). Forced displacement — a shove push,
        // a ledge fall landing — never passes through here at all, so it never
        // arms an OA in the first place.
        let mut opportunity_attacks = Vec::new();
        {
            let (mover_pos, disengaged) = match self.entities.get(&entity_id) {
                Some(m) => (m.position, m.disengaged_until_next_turn),
                None => return Err("ENTITY_NOT_FOUND".to_string()),
            };
            for enemy_id in adjacent_enemies_before {
                if disengaged {
                    break;
                }
                let still_adjacent = self
                    .entities
                    .get(&enemy_id)
                    .map(|enemy| {
                        let dx = enemy.position.0 - mover_pos.0;
                        let dy = enemy.position.1 - mover_pos.1;
                        (dx * dx + dy * dy).sqrt() <= 5.5
                    })
                    .unwrap_or(false);
                if !still_adjacent && self.has_armed_reaction(enemy_id, ReactionType::OpportunityAttack)
                {
                    let trigger = OpportunityAttackTrigger {
                        attacker_id: enemy_id,
                        mover_id: entity_id,
                    };
                    opportunity_attacks.push(trigger);
                    self.pending_opportunity_attacks.push(PendingOpportunityAttack {
                        attacker_id: enemy_id,
                        mover_id: entity_id,
                    });
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
        // Contest-derived conditions (Grappled from a won grapple, Prone from
        // a prone-shove or a tactical fall): last surviving grant per entity
        // wins. Anything not backed by a surviving event is stripped below —
        // these two conditions are only ever granted by GRAPPLE_ATTEMPTED /
        // SHOVE_ATTEMPTED / FALL_RESOLVED flows, so a rewind past those events
        // must un-grant them even though they live outside the HP/position
        // replay set (audit F4: the rewind-blind-spot class).
        let mut condition_state: HashMap<Uuid, Condition> = HashMap::new();

        // Seed positions from REVERTED shove pushes first (`or_insert`, so any
        // surviving event below overrides): a push displaces its target
        // WITHOUT a MOVE_ENTITY, so when the SHOVE_ATTEMPTED is reverted the
        // only record of where the target stood before is that event's own
        // "pushed_from" payload. Without this seeding, rewinding past a push
        // would strand the target at the pushed-to point whenever no earlier
        // move event exists to fall back on.
        for ev in reverted.iter().filter(|e| e.event_type == "SHOVE_ATTEMPTED") {
            if ev.payload.get("success").and_then(|v| v.as_bool()) != Some(true) {
                continue;
            }
            if let (Some(id), Some(from)) = (
                ev.payload
                    .get("defender_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok()),
                parse_payload_position(ev.payload.get("pushed_from")),
            ) {
                pos_state.entry(id).or_insert(from);
            }
        }
        // Same blind-spot class for tactical falls: a fall moves its victim
        // and wounds them WITHOUT any MOVE_ENTITY or DAMAGE_APPLIED event, so
        // when the FALL_RESOLVED itself is reverted the only record of the
        // pre-fall world is that event's own payload. Seed the pre-fall
        // position ("dropped_from") and pre-fall HP ("hp_before", with
        // consciousness derived as hp > 0 — a disclosed approximation: an
        // already-dying creature rewinds to conscious-but-wounded).
        // `or_insert` keeps any surviving later event authoritative.
        for ev in reverted.iter().filter(|e| e.event_type == "FALL_RESOLVED") {
            let Some(id) = ev
                .payload
                .get("entity_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            if let Some(from) = parse_payload_position(ev.payload.get("dropped_from")) {
                pos_state.entry(id).or_insert(from);
            }
            if let Some(hp) = ev.payload.get("hp_before").and_then(|v| v.as_i64()) {
                let hp = hp as i32;
                hp_state.entry(id).or_insert((hp, hp > 0, false));
            }
        }
        // Last-seen post-rest exhaustion level per entity, from surviving
        // LONG_REST_APPLIED events carrying "exhaustion_level".
        let mut exhaustion_state: HashMap<Uuid, u8> = HashMap::new();
        // Last-seen combat phase from surviving COMBAT_BEGAN / COMBAT_ENDED
        // events (`None` = no surviving combat events at all).
        let mut combat_active: Option<bool> = None;

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
                // wipes death-save tallies — same cleanup. Events that also
                // carry the post-rest "exhaustion_level" (emitted by the
                // server's rest endpoint) restore the shed exhaustion level;
                // exhaustion lives in `conditions` and no other event type
                // records it, so last surviving rest event wins. Legacy
                // payloads without the field replay HP only.
                // SHORT_REST_APPLIED (iteration 86+) now carries a funded
                // hit-dice spend and replays exactly like HEALED: absolute
                // hp_remaining restores the post-rest total so a later wound's
                // replay does not strand the entity at its wounded value.
                // Legacy payloads without a target/hp stay a no-op.
                "LONG_REST_APPLIED" | "SHORT_REST_APPLIED" => {
                    if let Some(tid) = ev
                        .payload
                        .get("target_id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| Uuid::parse_str(s).ok())
                    {
                        if let Some(hp) = ev.payload.get("hp_remaining").and_then(|v| v.as_i64()) {
                            let hp = hp as i32;
                            hp_state.insert(tid, (hp, hp > 0, false));
                            if hp > 0 {
                                death_save_state.insert(tid, DeathSaveState::default());
                            }
                        }
                        if let Some(level) =
                            ev.payload.get("exhaustion_level").and_then(|v| v.as_u64())
                        {
                            exhaustion_state.insert(tid, (level as u8).min(6));
                        }
                    }
                }
                // Combat phase: the LAST surviving begin/end decides whether
                // an engagement is active at the rewind point.
                "COMBAT_BEGAN" => combat_active = Some(true),
                "COMBAT_ENDED" => combat_active = Some(false),
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
                        if let Some(to) = parse_payload_position(ev.payload.get("to")) {
                            pos_state.insert(ev.actor_id, to);
                        }
                    }
                }
                // Contest outcomes replay their mechanical side effects so a
                // rewind past them cannot leave a grapple or a push behind
                // (audit F4). A WON grapple re-grants Grappled to the
                // defender; a lost contest grants nothing. For shoves the
                // effect decides: Prone rides `condition_state`, Push5Feet
                // rides `pos_state` via the payload's post-push position —
                // both last-surviving-event-wins.
                "GRAPPLE_ATTEMPTED"
                    if ev.payload.get("success").and_then(|v| v.as_bool()) == Some(true) =>
                {
                    if let (Some(id), Some(condition)) = (
                        ev.payload
                            .get("defender_id")
                            .and_then(|v| v.as_str())
                            .and_then(|s| Uuid::parse_str(s).ok()),
                        parse_contest_condition(ev.payload.get("applied_condition")),
                    ) {
                        condition_state.insert(id, condition);
                    }
                }
                "SHOVE_ATTEMPTED" => {
                    if ev.payload.get("success").and_then(|v| v.as_bool()) != Some(true) {
                        continue;
                    }
                    let defender = ev
                        .payload
                        .get("defender_id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| Uuid::parse_str(s).ok());
                    let condition =
                        parse_contest_condition(ev.payload.get("applied_condition"));
                    match (defender, condition) {
                        (Some(id), Some(condition)) => {
                            condition_state.insert(id, condition);
                        }
                        // No condition granted: a successful shove is either
                        // prone OR a 5 ft push. Only a push carries position
                        // data ("pushed_to"), and only it moves the board.
                        (Some(id), None) => {
                            if let Some(to) = parse_payload_position(ev.payload.get("pushed_to")) {
                                pos_state.insert(id, to);
                            }
                        }
                        _ => {}
                    }
                }
                // Tactical falls (iteration 53): a surviving FALL_RESOLVED
                // re-applies its landing point, post-fall HP/consciousness and
                // the Prone grant, so rewinding past a fall cannot leave a
                // wound, a prone token or a changed elevation behind. A
                // MASSIVE_DAMAGE outcome replays as dead exactly like
                // DAMAGE_APPLIED does; `knocked_prone: false` leaves any
                // earlier Prone grant untouched (last surviving grant wins).
                "FALL_RESOLVED" => {
                    if let Some(id) = ev
                        .payload
                        .get("entity_id")
                        .and_then(|v| v.as_str())
                        .and_then(|s| Uuid::parse_str(s).ok())
                    {
                        if let Some(to) = parse_payload_position(ev.payload.get("landed_at")) {
                            pos_state.insert(id, to);
                        }
                        if let Some(hp) = ev.payload.get("hp_remaining").and_then(|v| v.as_i64()) {
                            let hp = hp as i32;
                            hp_state.insert(
                                id,
                                (
                                    hp,
                                    ev.payload
                                        .get("is_conscious")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(hp > 0),
                                    ev.payload
                                        .get("instant_death")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false),
                                ),
                            );
                        }
                        if ev.payload.get("knocked_prone").and_then(|v| v.as_bool()) == Some(true) {
                            condition_state.insert(id, Condition::Prone);
                        }
                    }
                }
                _ => {}            }
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
        // Inventory-placement replay (audit F-A4#7): ITEM_TRANSFERRED moves an
        // item WITHOUT any MOVE_ENTITY/DAMAGE_APPLIED-style trace elsewhere, so
        // a rewind past one used to leave the item wherever the transfer had
        // put it — the rewind-blind-spot class again. Seed placements from the
        // REVERTED transfers' own payloads ("from_container_id" = where the
        // item lived before; explicit null = root), then let every SURVIVING
        // transfer re-assert its destination last-event-wins, mirroring the
        // position seeding above. Legacy payloads that predate the field carry
        // no prior placement and are left untouched rather than guessed at.
        let mut item_placements: HashMap<Uuid, (Uuid, Option<Uuid>)> = HashMap::new();
        for ev in reverted.iter().filter(|e| e.event_type == "ITEM_TRANSFERRED") {
            let Some(item_id) = ev
                .payload
                .get("item_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            if ev.payload.get("from_container_id").is_none() {
                continue;
            }
            let prior = ev
                .payload
                .get("from_container_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok());
            item_placements.entry(item_id).or_insert((ev.actor_id, prior));
        }
        for ev in self
            .ledger
            .events
            .iter()
            .filter(|e| !e.is_reverted && e.event_type == "ITEM_TRANSFERRED")
        {
            let parse = |key: &str| {
                ev.payload
                    .get(key)
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
            };
            if let (Some(item_id), Some(container_id)) = (parse("item_id"), parse("container_id")) {
                item_placements.insert(item_id, (ev.actor_id, Some(container_id)));
            }
        }
        for (item_id, (owner_id, parent)) in item_placements {
            if let Some(stored) = self
                .entities
                .get_mut(&owner_id)
                .and_then(|entity| entity.inventory.items.get_mut(&item_id))
            {
                stored.parent_container_id = parent;
                restored += 1;
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
        // Exhaustion replay (after HP so `set_exhaustion`'s level-4+ cap
        // clamp wins over a replayed higher total, mirroring live ordering
        // where the rest sheds the level before refilling to the effective
        // max). Last surviving LONG_REST_APPLIED event wins.
        for (id, level) in exhaustion_state {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.set_exhaustion(level);
                restored += 1;
            }
        }

        // Contest-condition replay: strip Grappled/Prone everywhere first (the
        // live grants came from events that may just have been reverted), then
        // re-apply exactly what the surviving ledger still vouches for. Both
        // conditions are granted ONLY by the grapple/shove contest endpoints
        // and the fall route, so nothing else can be lost by the sweep.
        for entity in self.entities.values_mut() {
            entity.remove_condition(&Condition::Grappled);
            entity.remove_condition(&Condition::Prone);
            // Bound-hands sweep: the only hand occupier this engine writes is
            // a WON grapple (see the server's grapple route), which is exactly
            // one hand. Rewinding past the GRAPPLE_ATTEMPTED event must
            // release it, so every surviving grapple re-occupies from zero.
            entity.hands_occupied = 0;
        }
        // Re-occupy one grappler hand per surviving won-grapple event.
        let mut surviving_grapplers: Vec<Uuid> = Vec::new();
        for ev in self.ledger.events.iter().filter(|e| !e.is_reverted) {
            if ev.event_type == "GRAPPLE_ATTEMPTED"
                && ev.payload.get("success").and_then(|v| v.as_bool()) == Some(true)
                && ev.payload.get("applied_condition").is_some()
            {
                surviving_grapplers.push(ev.actor_id);
            }
        }
        for id in surviving_grapplers {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.occupy_hand();
            }
        }
        // Hold-attribution replay (audit F-A4#3): rebuild the escaper->holder
        // map from the surviving ledger exactly like the hands above — a won
        // GRAPPLE_ATTEMPTED stamps its holder, and a surviving successful
        // escape drops the stamp (chronological order, so a later hold over
        // the same victim wins). Rewind past an escape must not resurrect an
        // attribution whose hold no longer exists.
        self.grapple_holders.clear();
        let mut escaped_actors: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
        for ev in self.ledger.events.iter().filter(|e| !e.is_reverted) {
            if ev.event_type == "GRAPPLE_ESCAPED"
                && ev.payload.get("success").and_then(|v| v.as_bool()) == Some(true)
            {
                if let Some(id) = ev
                    .payload
                    .get("entity_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
                {
                    escaped_actors.insert(id);
                }
            }
        }
        for ev in self.ledger.events.iter().filter(|e| !e.is_reverted) {
            if ev.event_type != "GRAPPLE_ATTEMPTED"
                || ev.payload.get("success").and_then(|v| v.as_bool()) != Some(true)
                || ev.payload.get("applied_condition").is_none()
            {
                continue;
            }
            if let Some(defender) = ev
                .payload
                .get("defender_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            {
                if !escaped_actors.contains(&defender) {
                    self.grapple_holders.insert(defender, ev.actor_id);
                }
            }
        }
        // Surviving escapes release what their hold took: a successful
        // GRAPPLE_ESCAPED always follows the GRAPPLE_ATTEMPTED it undoes
        // (chronological append), and a reverted escape is excluded by the
        // filter above — so applying releases after occupations nets out to
        // exactly the holds the ledger still vouches for. Without this, a
        // rewind past an escaped grapple would resurrect both the condition
        // sweep below refuses to keep and a hand the escaper already freed.
        let mut freed_grapplers: Vec<Uuid> = Vec::new();
        for ev in self.ledger.events.iter().filter(|e| !e.is_reverted) {
            if ev.event_type == "GRAPPLE_ESCAPED"
                && ev.payload.get("success").and_then(|v| v.as_bool()) == Some(true)
            {
                if let Some(id) = ev
                    .payload
                    .get("grappler_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
                {
                    freed_grapplers.push(id);
                }
            }
        }
        for id in freed_grapplers {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.release_hand();
            }
        }
        // An escaped hold must not re-grant its Grappled either: drop the
        // defender from the contest-condition replay set when a surviving
        // successful escape names them.
        for ev in self.ledger.events.iter().filter(|e| !e.is_reverted) {
            if ev.event_type != "GRAPPLE_ESCAPED"
                || ev.payload.get("success").and_then(|v| v.as_bool()) != Some(true)
            {
                continue;
            }
            if let Some(id) = ev
                .payload
                .get("entity_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            {
                condition_state.remove(&id);
            }
        }
        for (id, condition) in condition_state {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.add_condition(condition);
                restored += 1;
            }
        }

        // Inspiration replay: strip drifted holds first (a GRANT that was
        // just reverted, or a SPEND that was rewound past leaving the point
        // held) so we end up with exactly what the surviving ledger vouches
        // for, then re-apply any surviving GRANT. Last-surviving-INSPIRATION
        // -CHANGED-event-wins, mirroring the exhaustion / concentration
        // patterns above. Entities spawned after the rewind point are gone by
        // now; their ids simply find no live entity to restore.
        for entity in self.entities.values_mut() {
            entity.inspiration = false;
        }
        let mut inspiration_state: HashMap<Uuid, bool> = HashMap::new();
        for ev in self.ledger.events.iter().filter(|e| !e.is_reverted) {
            if ev.event_type == "INSPIRATION_CHANGED" {
                if let Some(granted) = ev.payload.get("granted").and_then(|v| v.as_bool()) {
                    inspiration_state.insert(ev.actor_id, granted);
                }
            }
        }
        for (id, granted) in inspiration_state {
            if let Some(entity) = self.entities.get_mut(&id) {
                if granted {
                    entity.inspiration = true;
                    restored += 1;
                }
            }
        }

        // Combat-state replay: the ledger is authoritative at the rewind
        // point. A surviving end (or no surviving begin at all) means no
        // engagement is active — clear any drifted tracker. A surviving
        // begin keeps combat live; entities removed after their spawn are
        // NOT resurrected by this rewind (step 1 only despawns late spawns),
        // so prune order slots referencing ids that no longer exist rather
        // than leaving dangling entries that would reference ghosts.
        // Simplification: round and turn_index are kept as-is — recomputing
        // initiative mid-rewind is out of scope; `next_turn` tolerates an
        // out-of-range index by yielding no actor until it wraps back in
        // bounds.
        match combat_active {
            Some(false) | None => {
                self.combat = InitiativeCombatState::default();
            }
            Some(true) => {
                self.combat.in_combat = true;
                self.combat.order.retain(|id| self.entities.contains_key(id));
            }
        }

        // Hit-dice pool replay (short-rest rewind, iteration 86+): the pool
        // draw-down of a reverted SHORT_REST_APPLIED is otherwise invisible to
        // the HP replay above — a rewind past the spend would leave the dice
        // consumed while the healed HP vanished. Rebuild each entity's pool
        // from the last surviving spend (absolute `hit_dice_remaining`),
        // seeded first from REVERTED spends' own payloads so a rewind with no
        // earlier spend history still restores the pre-spend pool.
        let mut hit_dice_state: HashMap<Uuid, u32> = HashMap::new();
        for ev in reverted.iter().filter(|e| e.event_type == "SHORT_REST_APPLIED") {
            let Some(id) = ev
                .payload
                .get("target_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            if let Some(remaining) = ev.payload.get("hit_dice_before").and_then(|v| v.as_u64()) {
                hit_dice_state.entry(id).or_insert(remaining as u32);
            }
        }
        for ev in self
            .ledger
            .events
            .iter()
            .filter(|e| !e.is_reverted && e.event_type == "SHORT_REST_APPLIED")
        {
            let Some(id) = ev
                .payload
                .get("target_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            if let Some(remaining) = ev.payload.get("hit_dice_remaining").and_then(|v| v.as_u64()) {
                hit_dice_state.insert(id, remaining as u32);
            }
        }
        for (id, remaining) in hit_dice_state {
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.hit_dice_remaining = remaining;
                restored += 1;
            }
        }

        // Concentration is cleared wholesale on a rewind: any spell granting
        // it may have been undone, so conservatively end all concentration.
        for entity in self.entities.values_mut() {
            entity.concentration = None;
            entity.dodge_until_next_turn = false;
            entity.disengaged_until_next_turn = false;
            entity.dashed_this_turn = false;
            // Turn-scoped Help promises clear wholesale on a rewind too: the
            // HELP_ACTION / HELP_CHECK_ACTION events backing them may just
            // have been reverted.
            entity.next_attacker_has_advantage_against = None;
            entity.next_check_has_advantage_from = None;
            // Inspiration is replayed from the surviving INSPIRATION_CHANGED
            // history in step 3 above — no wholesale clear here, or it would
            // clobber the restored point.
            // Turn-scoped declarations are cleared wholesale on a rewind: the
            // Ready event backing them may just have been reverted.
            entity.readied_action = None;
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
    ///   (teleport / portal / burrow); StealthReveal may appear in place at
    ///   the target point
    /// - SpawnEvent is only legal during setup (before combat starts) — once
    ///   [`Self::begin_combat`] has run, materializing a token from nothing is
    ///   exactly the "popping" GOALS.md P6's conservation law forbids. The
    ///   transit protocols stay legal mid-combat because each carries a
    ///   verifiable traversal story (see [`IngressType`] docs)
    /// - the target point must land on open, in-bounds map terrain: no
    ///   teleporting into a wall cell or off the authored map rectangle
    /// - the entity must not already exist on the board
    ///
    /// Returns a stable machine-readable error string per failure mode so the
    /// server can surface them as 422 INGRESS_REJECTED details.
    pub fn validate_ingress(&self, ing: &IngressEvent) -> Result<(), String> {
        let finite = |p: &(f32, f32, f32)| p.0.is_finite() && p.1.is_finite() && p.2.is_finite();
        if !finite(&ing.source_point) || !finite(&ing.target_point) {
            return Err("INGRESS_NON_FINITE_COORDINATES".to_string());
        }
        match ing.ingress_type {
            IngressType::Teleportation | IngressType::PortalDoor | IngressType::Burrowing
                if ing.source_point == ing.target_point =>
            {
                return Err("INGRESS_DEGENERATE_TRANSIT".to_string());
            }
            IngressType::SpawnEvent if self.combat.in_combat => {
                return Err("INGRESS_SPAWN_FORBIDDEN_IN_COMBAT".to_string());
            }
            _ => {}
        }
        if self.ingress_target_blocked(ing.target_point) {
            return Err("INGRESS_TARGET_BLOCKED".to_string());
        }
        Ok(())
    }

    /// Whether an arrival point lands inside a solid (wall) cell or outside
    /// the authored map rectangle. A session with no authored walls still
    /// bounds arrivals to its width x height rectangle — the world does not
    /// extend past the battle map just because nobody drew a wall yet.
    fn ingress_target_blocked(&self, p: (f32, f32, f32)) -> bool {
        let cell = self.map.cell_size_feet.max(f32::EPSILON);
        let gx = (p.0 / cell).floor();
        let gy = (p.1 / cell).floor();
        if gx < 0.0 || gy < 0.0 || gx >= self.map.width as f32 || gy >= self.map.height as f32 {
            return true;
        }
        self.map.solid_cells.contains(&(gx as usize, gy as usize))
    }

    pub fn add_entity(&mut self, entity: EntityState, ingress: Option<IngressEvent>) -> Result<(), String> {
        let id = entity.id;
        if self.entities.contains_key(&id) {
            return Err("INGRESS_ENTITY_ALREADY_PRESENT".to_string());
        }
        if let Some(ing) = &ingress {
            // The caller-supplied `verified` flag is advisory only: validation
            // below is authoritative, and only a fully validated event earns
            // `verified = true` on its stack record. Rejected events never
            // reach the stack at all.
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
    /// Sweeps the round-scoped combat offers that must not cross a combat
    /// boundary (audit A5 F7): pending opportunity attacks are dropped and
    /// every readied action expires, each loss ledgered as
    /// READIED_ACTION_EXPIRED exactly like the round refresh does. Returns
    /// `(dropped_oas, expired_readied_ids)`.
    fn sweep_cross_combat_state(&mut self) -> (usize, Vec<Uuid>) {
        let dropped_oas = self.pending_opportunity_attacks.len();
        self.pending_opportunity_attacks.clear();

        let mut expired_readied = Vec::new();
        for (id, entity) in self.entities.iter_mut() {
            if let Some(expired) = entity.readied_action.take() {
                expired_readied.push(*id);
                self.ledger.append_event(
                    self.session_id,
                    self.campaign_id,
                    *id,
                    "READIED_ACTION_EXPIRED",
                    serde_json::json!({
                        "description": expired.description,
                        "set_on_round": expired.set_on_round,
                        "trigger": expired.trigger,
                    }),
                );
            }
        }
        (dropped_oas, expired_readied)
    }

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

        // Nothing left over from a previous fight may leak into this one.
        let (cleared_oas, cleared_readied) = self.sweep_cross_combat_state();

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
                "cleared_pending_opportunity_attacks": cleared_oas,
                "cleared_readied_actions": cleared_readied,
            }),
        );
        entries
    }

    /// Ends combat and clears the initiative tracker. Entities stay on the
    /// board untouched apart from the combat-scoped sweep (pending OAs and
    /// readied actions do not survive the fight); returns how many combatants
    /// were tracked.
    pub fn end_combat(&mut self) -> usize {
        let cleared = self.combat.order.len();
        let round_fought = self.combat.round;
        self.combat = InitiativeCombatState::default();

        let (cleared_oas, cleared_readied) = self.sweep_cross_combat_state();
        self.ledger.append_event(
            self.session_id,
            self.campaign_id,
            Uuid::nil(),
            "COMBAT_ENDED",
            serde_json::json!({
                "rounds_fought": round_fought,
                "cleared_pending_opportunity_attacks": cleared_oas,
                "cleared_readied_actions": cleared_readied,
            }),
        );
        cleared
    }
}

/// Parses a `[x, y, z]` payload coordinate array into a position tuple.
fn parse_payload_position(value: Option<&serde_json::Value>) -> Option<(f32, f32, f32)> {
    let a = value?.as_array()?;
    Some((
        a.first()?.as_f64()? as f32,
        a.get(1)?.as_f64()? as f32,
        a.get(2).and_then(|z| z.as_f64()).unwrap_or(0.0) as f32,
    ))
}

/// Maps a contest event's `applied_condition` payload string to the condition
/// the rewind replay can re-grant. Only Grappled and Prone are ever written by
/// the grapple/shove endpoints; anything else replays as nothing.
fn parse_contest_condition(value: Option<&serde_json::Value>) -> Option<Condition> {
    match value.and_then(|v| v.as_str()) {
        Some("grappled") => Some(Condition::Grappled),
        Some("prone") => Some(Condition::Prone),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dice::DiceEngine;
    use crate::RulesEvaluator;

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

    // ------------------------------------------------ standard action options

    fn enemy(id: Uuid, name: &str) -> EntityState {
        let mut e = entity(id, name, 10);
        e.is_player = false;
        e
    }

    #[test]
    fn test_take_dodge_sets_flag_and_edge_from_conditions_applies_it_until_refresh() {
        let attacker_id = Uuid::new_v4();
        let dodger_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(attacker_id, "Attacker", 10), None).unwrap();
        session.add_entity(entity(dodger_id, "Dodger", 10), None).unwrap();

        // Baseline: nobody dodging -> no condition-derived disadvantage.
        let attacker = session.entities[&attacker_id].clone();
        let target = session.entities[&dodger_id].clone();
        let (adv, dis) = RulesEvaluator::edge_from_conditions(&attacker, &target, 5.0, 0.0, 0.0);
        assert!(!adv && !dis, "clean board must be straight d20");

        // Dodge spends the Action and flags the entity.
        session.entities.get_mut(&dodger_id).unwrap().take_dodge().unwrap();
        assert!(session.entities[&dodger_id].dodge_until_next_turn);
        assert!(!session.entities[&dodger_id].action_budget.action, "dodge spends the Action");

        // Attacks against the dodger are made at disadvantage.
        let attacker = session.entities[&attacker_id].clone();
        let target = session.entities[&dodger_id].clone();
        let (adv, dis) = RulesEvaluator::edge_from_conditions(&attacker, &target, 5.0, 0.0, 0.0);
        assert!(!adv);
        assert!(dis, "attackers gain disadvantage against a dodging target");

        // The dodger's next-turn refresh clears the flag and the edge with it.
        let mut dice = DiceEngine::with_seed(1);
        session.advance_round(&mut dice);
        assert!(!session.entities[&dodger_id].dodge_until_next_turn);
        let attacker = session.entities[&attacker_id].clone();
        let target = session.entities[&dodger_id].clone();
        let (_, dis) = RulesEvaluator::edge_from_conditions(&attacker, &target, 5.0, 0.0, 0.0);
        assert!(!dis, "dodge must expire at the start of the dodger's next turn");
    }

    #[test]
    fn test_take_dash_adds_speed_to_budget_once_then_resets() {
        let id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(id, "Runner", 10), None).unwrap(); // speed 30

        // Spend some movement first — Dash adds on top of whatever remains.
        session.move_entity(id, (10.0, 0.0, 0.0)).unwrap();
        assert_eq!(session.entities[&id].action_budget.movement_remaining_feet, 20.0);

        session.entities.get_mut(&id).unwrap().take_dash().unwrap();
        assert_eq!(
            session.entities[&id].action_budget.movement_remaining_feet, 50.0,
            "dash adds exactly one speed worth of movement"
        );
        assert!(session.entities[&id].dashed_this_turn);

        // Once per turn: a second Dash is rejected WITHOUT double-spending.
        let err = session.entities.get_mut(&id).unwrap().take_dash().unwrap_err();
        assert_eq!(err, "DASH_ALREADY_TAKEN");
        assert_eq!(
            session.entities[&id].action_budget.movement_remaining_feet, 50.0,
            "rejected dash must not add movement again"
        );

        // Next-turn refresh resets both the budget and the once-per-turn latch.
        let mut dice = DiceEngine::with_seed(1);
        session.advance_round(&mut dice);
        assert_eq!(session.entities[&id].action_budget.movement_remaining_feet, 30.0);
        assert!(!session.entities[&id].dashed_this_turn);
        session.entities.get_mut(&id).unwrap().take_dash().unwrap();
        assert_eq!(session.entities[&id].action_budget.movement_remaining_feet, 60.0);
    }

    #[test]
    fn test_take_disengage_suppresses_opportunity_attacks_until_refresh() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        // Adjacent (5 ft) hostile with an ARMED opportunity reaction.
        session.entities.get_mut(&enemy_id).unwrap().position = (5.0, 0.0, 0.0);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();

        // Baseline: leaving adjacency provokes.
        let outcome = session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();
        assert_eq!(outcome.opportunity_attacks.len(), 1);
        assert_eq!(outcome.opportunity_attacks[0].attacker_id, enemy_id);

        // Re-arm (the baseline provoke consumed it), step back in, disengage.
        session.entities.get_mut(&enemy_id).unwrap().action_budget.reaction = true;
        session.entities.get_mut(&mover_id).unwrap().action_budget.movement_remaining_feet = 30.0;
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        session.move_entity(mover_id, (5.0, 0.0, 0.0)).unwrap();
        session.entities.get_mut(&mover_id).unwrap().action_budget.movement_remaining_feet = 30.0;
        session.entities.get_mut(&mover_id).unwrap().take_disengage().unwrap();

        // Walking away produces NO triggers and does NOT consume the enemy's
        // readied reaction.
        let outcome = session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();
        assert!(outcome.opportunity_attacks.is_empty(), "disengage suppresses OAs");
        assert!(session.has_armed_reaction(enemy_id, ReactionType::OpportunityAttack));

        // Refresh clears the protection: the same walk provokes again.
        let mut dice = DiceEngine::with_seed(1);
        session.advance_round(&mut dice);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        session.move_entity(mover_id, (5.0, 0.0, 0.0)).unwrap();
        session.entities.get_mut(&mover_id).unwrap().action_budget.movement_remaining_feet = 30.0;
        let outcome = session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();
        assert_eq!(outcome.opportunity_attacks.len(), 1, "protection expires");
    }

    // ---------------------------------------------------- opportunity attacks

    #[test]
    fn test_move_out_of_reach_pends_oa_without_spending_the_reaction() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        session.entities.get_mut(&enemy_id).unwrap().position = (5.0, 0.0, 0.0);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();

        let outcome = session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();
        assert_eq!(outcome.opportunity_attacks.len(), 1);
        assert_eq!(outcome.opportunity_attacks[0].attacker_id, enemy_id);
        assert_eq!(outcome.opportunity_attacks[0].mover_id, mover_id);

        // Detection PENDS the trigger; it must NOT silently eat the reaction —
        // the reacting side resolves the swing through the OA attack path.
        assert_eq!(
            session.pending_opportunity_attacks,
            vec![PendingOpportunityAttack {
                attacker_id: enemy_id,
                mover_id,
            }],
            "leaving reach must disclose exactly one pending OA"
        );
        assert!(
            session.entities[&enemy_id].action_budget.reaction,
            "arming a pending OA must not spend the enemy's reaction"
        );
        assert!(session.has_armed_reaction(enemy_id, ReactionType::OpportunityAttack));
    }

    #[test]
    fn test_oa_resolution_spends_reaction_not_action_and_second_is_refused() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        session.entities.get_mut(&enemy_id).unwrap().position = (5.0, 0.0, 0.0);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();

        // The trigger is live but the enemy's reaction is already gone (spent
        // on something else this round): the swing is refused with
        // REACTION_UNAVAILABLE and nothing else changes.
        session.consume_reaction(enemy_id, ReactionType::OpportunityAttack);
        assert_eq!(
            session.take_opportunity_attack(enemy_id, mover_id).unwrap_err(),
            "REACTION_UNAVAILABLE"
        );
        assert_eq!(session.pending_opportunity_attacks.len(), 1);

        // Re-arm, then resolve properly.
        session.entities.get_mut(&enemy_id).unwrap().action_budget.reaction = true;
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        session.take_opportunity_attack(enemy_id, mover_id).unwrap();
        assert!(
            !session.entities[&enemy_id].action_budget.reaction,
            "resolving the OA spends the REACTION"
        );
        assert!(
            session.entities[&enemy_id].action_budget.action,
            "an opportunity attack must NEVER spend the Action"
        );
        assert!(
            session.pending_opportunity_attacks.is_empty(),
            "a resolved trigger must be cleared"
        );

        // One reaction per round: a second OA attempt against the same pairing
        // finds no pending trigger left (the first take CONSUMED it) — refused
        // with OA_NOT_PENDING, and the Action stays unspent.
        assert_eq!(
            session.take_opportunity_attack(enemy_id, mover_id).unwrap_err(),
            "OA_NOT_PENDING"
        );
        assert!(session.entities[&enemy_id].action_budget.action);
    }

    #[test]
    fn test_oa_only_legal_against_the_mover_whose_movement_triggered_it() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let bystander_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        session.add_entity(entity(bystander_id, "Bystander", 10), None).unwrap();
        session.entities.get_mut(&enemy_id).unwrap().position = (5.0, 0.0, 0.0);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();

        // Right attacker, wrong target: nobody else's movement armed this.
        assert_eq!(
            session.take_opportunity_attack(enemy_id, bystander_id).unwrap_err(),
            "OA_NOT_PENDING"
        );
        // A stranger with no trigger at all cannot invent one.
        assert_eq!(
            session.take_opportunity_attack(bystander_id, mover_id).unwrap_err(),
            "OA_NOT_PENDING"
        );
        // The real pairing still resolves.
        assert!(session.take_opportunity_attack(enemy_id, mover_id).is_ok());
    }

    #[test]
    fn test_disengage_cancels_pending_oas_but_keeps_the_readied_reaction() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        session.entities.get_mut(&enemy_id).unwrap().position = (5.0, 0.0, 0.0);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();
        assert_eq!(session.pending_opportunity_attacks.len(), 1);

        // Disengage AFTER the move withdraws the invitation: the pending OA is
        // dropped and the enemy's readied reaction is handed back intact.
        let cancelled = session.cancel_opportunity_attacks_against(mover_id);
        assert_eq!(cancelled, 1, "exactly the mover's own pending OA is dropped");
        assert!(session.pending_opportunity_attacks.is_empty());
        assert!(
            session.has_armed_reaction(enemy_id, ReactionType::OpportunityAttack),
            "cancelling the OA must not consume the readied reaction"
        );
        assert!(session.entities[&enemy_id].action_budget.reaction);

        // Cancelling twice finds nothing the second time.
        assert_eq!(session.cancel_opportunity_attacks_against(mover_id), 0);
    }

    #[test]
    fn test_round_refresh_expires_untaken_opportunity_attacks() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        session.entities.get_mut(&enemy_id).unwrap().position = (5.0, 0.0, 0.0);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();
        assert!(!session.pending_opportunity_attacks.is_empty());

        let mut dice = DiceEngine::with_seed(1);
        session.advance_round(&mut dice);
        assert!(
            session.pending_opportunity_attacks.is_empty(),
            "a pending OA is a THIS-round offer; the refresh sweeps it"
        );
        assert!(
            session.entities[&enemy_id].action_budget.reaction,
            "the untaken reaction refreshes too"
        );
    }

    #[test]
    fn test_begin_combat_sweeps_pending_oas_and_stale_readied_actions() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        session.entities.get_mut(&enemy_id).unwrap().position = (5.0, 0.0, 0.0);
        session.arm_reaction(enemy_id, ReactionType::OpportunityAttack).unwrap();
        let outcome = session.move_entity(mover_id, (30.0, 0.0, 0.0)).unwrap();
        assert_eq!(outcome.opportunity_attacks.len(), 1);
        assert!(!session.pending_opportunity_attacks.is_empty());

        // A readied action declared OUTSIDE this fight must not carry in.
        session
            .ready_action(mover_id, "Swing when it returns", ReadiedTrigger::EnemyEntersReach)
            .unwrap();
        assert!(session.entities[&mover_id].readied_action.is_some());

        session.begin_combat(&mut DiceEngine::with_seed(9));
        assert!(
            session.pending_opportunity_attacks.is_empty(),
            "pending OAs are combat-scoped offers; they must not survive into a new fight"
        );
        assert!(
            session
                .entities
                .values()
                .all(|e| e.readied_action.is_none()),
            "a readied action must not persist across the combat boundary"
        );
    }

    #[test]
    fn test_end_combat_sweeps_pending_oas_and_readied_actions_with_ledger_visibility() {
        let mover_id = Uuid::new_v4();
        let enemy_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(mover_id, "Mover", 10), None).unwrap();
        session.add_entity(enemy(enemy_id, "Enemy"), None).unwrap();
        session.begin_combat(&mut DiceEngine::with_seed(5));

        // Pending OA left standing mid-fight plus a live readied action.
        session.pending_opportunity_attacks.push(PendingOpportunityAttack {
            attacker_id: enemy_id,
            mover_id,
        });
        session
            .ready_action(enemy_id, "Swing when it moves", ReadiedTrigger::EnemyAttacks)
            .unwrap();

        session.end_combat();
        assert!(
            session.pending_opportunity_attacks.is_empty(),
            "combat end must sweep pending OAs"
        );
        assert!(
            session.entities.values().all(|e| e.readied_action.is_none()),
            "combat end must sweep readied actions"
        );

        // Ledger visibility matches the round-refresh expiry convention: each
        // dropped readied action is ledgered as READIED_ACTION_EXPIRED, and
        // the combat-transition event discloses what it swept.
        assert!(
            session
                .ledger
                .events
                .iter()
                .any(|e| e.event_type == "READIED_ACTION_EXPIRED" && e.actor_id == enemy_id),
            "the dropped readied action must be visible in the ledger"
        );
        let ended = session
            .ledger
            .events
            .iter()
            .rev()
            .find(|e| e.event_type == "COMBAT_ENDED")
            .expect("COMBAT_ENDED must be ledgered");
        assert_eq!(
            ended.payload.get("cleared_pending_opportunity_attacks"),
            Some(&serde_json::json!(1)),
            "COMBAT_ENDED must disclose how many pending OAs were swept"
        );
        assert_eq!(
            session.combat.round, 0,
            "end_combat still resets the tracker"
        );
    }

    #[test]
    fn test_standard_actions_reject_incapacitated_or_spent_actors() {
        let id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        session.add_entity(entity(id, "Actor", 10), None).unwrap();

        // Exhaustion 5 = speed 0; dash still works (adds zero) but the point is
        // incapacity gating, so use an unconscious actor instead.
        session.entities.get_mut(&id).unwrap().add_condition(Condition::Unconscious);
        assert_eq!(session.entities.get_mut(&id).unwrap().take_dodge().unwrap_err(), "ENTITY_CANNOT_ACT");
        assert_eq!(session.entities.get_mut(&id).unwrap().take_dash().unwrap_err(), "ENTITY_CANNOT_ACT");
        assert_eq!(session.entities.get_mut(&id).unwrap().take_disengage().unwrap_err(), "ENTITY_CANNOT_ACT");

        // Conscious again, but the Action is already gone.
        let actor = session.entities.get_mut(&id).unwrap();
        actor.remove_condition(&Condition::Unconscious);
        actor.action_budget.action = false;
        assert_eq!(session.entities.get_mut(&id).unwrap().take_dodge().unwrap_err(), "ACTION_ECONOMY_EXHAUSTED");
        assert_eq!(session.entities.get_mut(&id).unwrap().take_dash().unwrap_err(), "ACTION_ECONOMY_EXHAUSTED");
        assert_eq!(session.entities.get_mut(&id).unwrap().take_disengage().unwrap_err(), "ACTION_ECONOMY_EXHAUSTED");
        assert!(!session.entities[&id].dodge_until_next_turn);
        assert!(!session.entities[&id].disengaged_until_next_turn);
        assert!(!session.entities[&id].dashed_this_turn, "a rejected dash must not latch");
    }

    #[test]
    fn test_stabilize_attempt_success_tallies_and_stabilizes_at_three() {
        let dying_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        let mut dying = entity(dying_id, "Dying", 10);
        dying.current_hp = 0;
        dying.is_conscious = false;
        // Existing tallies: the new success must ADD, never overwrite.
        dying.death_saves.successes = 1;
        dying.death_saves.failures = 2;
        session.add_entity(dying, None).unwrap();

        // DC 10 Medicine check passed (natural 14 + 2).
        let out = session
            .entities
            .get_mut(&dying_id)
            .unwrap()
            .stabilize_attempt(14, 2)
            .unwrap();
        assert!(out.success);
        assert_eq!(out.dc, 10);
        assert_eq!(out.total, 16);
        let state = &session.entities[&dying_id].death_saves;
        assert_eq!(state.successes, 2, "+1 success on top of the existing tally");
        assert_eq!(state.failures, 2, "failures untouched by a Medicine check");
        assert!(!state.is_stabilized);

        // Second success reaches three -> stabilized.
        let out = session
            .entities
            .get_mut(&dying_id)
            .unwrap()
            .stabilize_attempt(10, 0)
            .unwrap();
        assert!(out.success);
        let state = &session.entities[&dying_id].death_saves;
        assert_eq!(state.successes, 3);
        assert!(state.is_stabilized);
        assert!(out.is_stabilized_after);

        // A stabilized creature is past saving.
        let err = session.entities.get_mut(&dying_id).unwrap().stabilize_attempt(20, 5).unwrap_err();
        assert_eq!(err, "ALREADY_STABILIZED");
    }

    #[test]
    fn test_stabilize_attempt_failed_check_and_invalid_targets_change_nothing() {
        let dying_id = Uuid::new_v4();
        let healthy_id = Uuid::new_v4();
        let dead_id = Uuid::new_v4();
        let mut session = GameSession::new(Uuid::new_v4(), Uuid::new_v4(), "t".into());
        let mut dying = entity(dying_id, "Dying", 10);
        dying.current_hp = 0;
        dying.is_conscious = false;
        dying.death_saves.failures = 1;
        session.add_entity(dying, None).unwrap();
        session.add_entity(entity(healthy_id, "Healthy", 10), None).unwrap();
        let mut dead = entity(dead_id, "Dead", 10);
        dead.current_hp = 0;
        dead.is_dead = true;
        session.add_entity(dead, None).unwrap();

        // Failed check (total 9 < DC 10): tallies unchanged.
        let out = session
            .entities
            .get_mut(&dying_id)
            .unwrap()
            .stabilize_attempt(7, 2)
            .unwrap();
        assert!(!out.success);
        let state = &session.entities[&dying_id].death_saves;
        assert_eq!((state.successes, state.failures), (0, 1));
        assert!(!state.is_stabilized && !state.is_dead);

        // Healthy targets are not dying; corpses cannot be saved.
        assert_eq!(
            session.entities.get_mut(&healthy_id).unwrap().stabilize_attempt(20, 5).unwrap_err(),
            "TARGET_NOT_DYING"
        );
        assert_eq!(
            session.entities.get_mut(&dead_id).unwrap().stabilize_attempt(20, 5).unwrap_err(),
            "ENTITY_DEAD"
        );
    }

    #[test]
    fn test_legacy_combat_payload_without_order_deserializes() {
        let raw = serde_json::json!({ "in_combat": false, "round": 2, "turn_index": 1 });
        let state: InitiativeCombatState = serde_json::from_value(raw).expect("legacy payload");
        assert!(state.order.is_empty());
        assert_eq!(state.round, 2);
    }

    #[test]
    fn test_entity_defaults_to_normal_vision_and_serializes_backward_compatible() {
        // New entities default to Normal, unlimited-range vision (stored as
        // Option so legacy payloads stay backward compatible).
        let e = entity(Uuid::new_v4(), "Seer", 10);
        assert_eq!(e.vision_mode, None);
        assert_eq!(e.effective_vision_mode(), VisionMode::Normal);
        assert_eq!(e.sense_range_feet, None);
        assert_eq!(e.effective_sense_range_feet(), f32::INFINITY);

        // A legacy payload WITHOUT the new fields still deserializes.
        let legacy = serde_json::json!({
            "id": Uuid::new_v4(),
            "compendium_id": "legacy",
            "name": "Legacy",
            "is_player": true,
            "current_hp": 10,
            "max_hp": 10,
            "temp_hp": 0,
            "ac": 12,
            "speed_feet": 30.0,
            "position": [0.0, 0.0, 0.0],
            "zone_id": "Zone_Default",
            "abilities": {
                "strength": 10, "dexterity": 10, "constitution": 10,
                "intelligence": 10, "wisdom": 10, "charisma": 10
            },
            "conditions": [],
            "action_budget": {
                "action": true, "bonus_action": true, "reaction": true,
                "movement_remaining_feet": 30.0, "free_object_interaction": true
            },
            "spell_slots_remaining": {},
            "inventory": {"items": {}},
            "is_conscious": true,
            "is_dead": false,
            "is_visible": true
        });
        let parsed: EntityState = serde_json::from_value(legacy).expect("legacy payload");
        assert_eq!(parsed.vision_mode, None);
        assert_eq!(parsed.effective_vision_mode(), VisionMode::Normal);

        // A modern payload round-trips its senses.
        let mut seer = entity(Uuid::new_v4(), "Drow", 12);
        seer.vision_mode = Some(VisionMode::Darkvision);
        seer.sense_range_feet = Some(120.0);
        let json = serde_json::to_string(&seer).unwrap();
        assert!(json.contains("darkvision"), "vision mode must serialize: {}", json);
        let back: EntityState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.vision_mode, Some(VisionMode::Darkvision));
        assert_eq!(back.sense_range_feet, Some(120.0));
    }

    #[test]
    fn test_session_map_validates_lighting_zone_bounds() {
        let mut map = SessionMap::default();
        map.lighting_zones.push(LightingZoneCell {
            x: 3,
            y: 4,
            zone: LightingZone::MagicalDarkness,
        });
        assert!(map.validate().is_ok());

        map.lighting_zones.push(LightingZoneCell {
            x: 99,
            y: 0,
            zone: LightingZone::Dim,
        });
        assert!(map.validate().is_err());
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
