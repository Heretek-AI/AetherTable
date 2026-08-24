//! Authoritative VTT Engine Server.
//!
//! Zero-trust rules authority:
//! - Clients reference entities by id; ALL math (bonuses, AC, resistances,
//!   movement legality) resolves here from server-side `EntityState`.
//! - Every mutating endpoint requires a gateway-signed HMAC session token.
//! - Token movement over the CRDT relay is validated against the session map.

use crate::auth::{AuthIdentity, AuthVerifier};

use actix_cors::Cors;
use actix_web::{
    http::header,
    middleware::Logger,
    web, App, HttpResponse, HttpMessage, HttpServer, Responder,
};
use actix_ws::Message;
use dashmap::DashMap;
use futures_util::StreamExt;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use uuid::Uuid;

use vtt_core::{
    Ability, ActionResolver, CheckOutcomeTier, Condition, CostSuggestion, DiceEngine,
    GameSession, RulesEvaluator, SessionMap,
};
use vtt_crdt_sync::{CrdtRelayHub, CrdtSyncMessage, TokenTransform, VectorClock};
use vtt_scripting::{RhaiNarrativeEngine, SandboxedWasmEngine, ScriptExecutionContext};
use vtt_spatial::{
    AStarPathfinder, CoverCalculator, CoverType, GridCollisionMap, TerrainOverlay, Vector3,
};
use vtt_wfc::{DungeonGenerator, RoomDescriptor};



/// Default per-update movement ceiling when no matching entity can be resolved.
const DEFAULT_MOVE_STEP_FEET: f32 = 30.0;

pub struct AppState {
    pub sessions: DashMap<Uuid, Arc<RwLock<GameSession>>>,
    pub crdt_hub: Arc<CrdtRelayHub>,
    pub peers: Arc<PeerRegistry>,
    pub wasm_engine: Arc<SandboxedWasmEngine>,
    pub rhai_engine: Arc<RhaiNarrativeEngine>,
    /// Last accepted position per (room, token) for movement validation.
    pub movement: DashMap<String, DashMap<u64, (f32, f32)>>,
    /// Session creator (gateway user id) for ownership checks.
    pub session_owners: DashMap<Uuid, String>,
    /// Optional Postgres pool — present when DATABASE_URL is reachable at
    /// boot. Absent => memory-only mode (availability-first persistence).
    pub db: Option<sqlx::PgPool>,
    /// Per-session last-flushed ledger sequence (persistence tailer).
    pub flush_watermarks: DashMap<Uuid, u64>,
    /// Count of failed durable writes since boot (surfaced via /metrics).
    pub persistence_failures: Arc<AtomicU64>,
    // --- Honest metrics: every counter reflects a verified outcome. ---
    pub total_action_requests: AtomicU64,
    pub valid_action_executions: AtomicU64,
    pub rejected_action_requests: AtomicU64,
    pub total_audits: AtomicU64,
    pub auditor_rejections: AtomicU64,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            crdt_hub: Arc::new(CrdtRelayHub::new()),
            peers: Arc::new(PeerRegistry::new()),
            wasm_engine: Arc::new(SandboxedWasmEngine::new().expect("Failed Wasm engine init")),
            rhai_engine: Arc::new(RhaiNarrativeEngine::new()),
            movement: DashMap::new(),
            session_owners: DashMap::new(),
            db: None,
            flush_watermarks: DashMap::new(),
            persistence_failures: Arc::new(AtomicU64::new(0)),
            total_action_requests: AtomicU64::new(0),
            valid_action_executions: AtomicU64::new(0),
            rejected_action_requests: AtomicU64::new(0),
            total_audits: AtomicU64::new(0),
            auditor_rejections: AtomicU64::new(0),
        }
    }

    fn count_request(&self) {
        self.total_action_requests.fetch_add(1, Ordering::Relaxed);
    }

    fn count_valid(&self) {
        self.valid_action_executions.fetch_add(1, Ordering::Relaxed);
    }

    fn count_rejected(&self) {
        self.rejected_action_requests.fetch_add(1, Ordering::Relaxed);
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn reject(data: &AppState, status: u16, code: &str, detail: &str) -> HttpResponse {
    data.count_rejected();
    HttpResponse::build(
        actix_web::http::StatusCode::from_u16(status)
            .unwrap_or(actix_web::http::StatusCode::BAD_REQUEST),
    )
    .json(serde_json::json!({"error": code, "detail": detail}))
}

// --- RBAC ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Gm,
    Spectator,
    Player,
}

impl Role {
    pub fn from_identity(identity: &AuthIdentity) -> Role {
        match identity.role.as_deref() {
            Some("gm") | Some("admin") => Role::Gm,
            Some("spectator") => Role::Spectator,
            _ => Role::Player,
        }
    }

    pub fn is_gm(&self) -> bool {
        *self == Role::Gm
    }
}

/// True when this caller may perform ANY mutation in the given session:
/// GMs/admins always; spectators never; any other authenticated participant
/// may act at the table (entity-level ownership checks still apply).
fn may_mutate_session(
    _data: &AppState,
    _session_id: Uuid,
    role: Role,
    _user_id: &str,
) -> bool {
    !matches!(role, Role::Spectator)
}

/// True when the caller may act WITH (move/attack as/cast as) this entity.
/// Unowned entities are DM-controlled and usable by any authenticated
/// participant until an owner claims them.
fn may_control_entity(entity_owner: Option<&String>, role: Role, user_id: &str) -> bool {
    match entity_owner {
        None => !matches!(role, Role::Spectator),
        Some(owner) => {
            role.is_gm() || (role == Role::Player && owner == user_id)
        }
    }
}

/// Live WebSocket peer registry per room. The CrdtRelayHub merges state
/// (LWW arbitration); this struct handles the fan-out to connected clients.
pub struct PeerRegistry {
    rooms: DashMap<String, DashMap<u64, actix_ws::Session>>,
    next_peer_id: AtomicU64,
}

impl PeerRegistry {
    pub fn new() -> Self {
        Self {
            rooms: DashMap::new(),
            next_peer_id: AtomicU64::new(1),
        }
    }

    fn join(&self, room_id: &str, session: &actix_ws::Session) -> u64 {
        let peer_id = self.next_peer_id.fetch_add(1, Ordering::Relaxed);
        self.rooms
            .entry(room_id.to_string())
            .or_default()
            .insert(peer_id, session.clone());
        peer_id
    }

    fn leave(&self, room_id: &str, peer_id: u64) {
        if let Some(peers) = self.rooms.get(room_id) {
            peers.remove(&peer_id);
        }
    }

    async fn broadcast(&self, room_id: &str, except_peer: u64, text: &str) {
        if let Some(peers) = self.rooms.get(room_id) {
            for entry in peers.iter() {
                if *entry.key() != except_peer {
                    let mut peer_session = entry.value().clone();
                    // actix-ws Session::text is async; dropped futures never flush.
                    let _ = peer_session.text(text).await;
                }
            }
        }
    }

    fn count(&self, room_id: &str) -> usize {
        self.rooms.get(room_id).map(|p| p.len()).unwrap_or(0)
    }
}

impl Default for PeerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// --- Health & metrics -------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MetricsResponse {
    pub mechanical_compliance_rate_pct: f64,
    pub total_actions: u64,
    pub valid_actions: u64,
    pub rejected_actions: u64,
    pub auditor_total: u64,
    pub auditor_rejection_rate_pct: f64,
    pub persistence_failures: u64,
    pub target_sla_ms: u64,
}

async fn health_check() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "healthy".to_string(),
        service: "vtt-authoritative-engine".to_string(),
        version: "2.0.0".to_string(),
    })
}

async fn get_metrics(data: web::Data<AppState>) -> impl Responder {
    let total_act = data.total_action_requests.load(Ordering::Relaxed);
    let valid_act = data.valid_action_executions.load(Ordering::Relaxed);
    let rejected_act = data.rejected_action_requests.load(Ordering::Relaxed);
    // MCR counts only adjudicated outcomes — never fabricated defaults.
    let decided = valid_act + rejected_act;
    let mcr = if decided > 0 {
        (valid_act as f64 / decided as f64) * 100.0
    } else {
        0.0
    };

    let total_aud = data.total_audits.load(Ordering::Relaxed);
    let audit_rej = data.auditor_rejections.load(Ordering::Relaxed);
    let rejection_rate = if total_act > 0 {
        (audit_rej as f64 / total_act as f64) * 100.0
    } else {
        0.0
    };

    HttpResponse::Ok().json(MetricsResponse {
        mechanical_compliance_rate_pct: mcr,
        total_actions: total_act,
        valid_actions: valid_act,
        rejected_actions: rejected_act,
        auditor_total: total_aud,
        auditor_rejection_rate_pct: rejection_rate,
        persistence_failures: data.persistence_failures.load(Ordering::Relaxed),
        target_sla_ms: 10,
    })
}

// --- Sessions ---------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateSessionReq {
    pub campaign_id: Uuid,
    pub session_name: String,
}

async fn create_session(
    data: web::Data<AppState>,
    req: web::Json<CreateSessionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, Uuid::nil(), role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot create sessions");
    }
    let session_id = Uuid::new_v4();
    data.session_owners.insert(session_id, identity.user_id.clone());
    let mut session = GameSession::new(session_id, req.campaign_id, req.session_name.clone());
    session.ledger.append_event(
        session_id,
        req.campaign_id,
        Uuid::nil(),
        "SESSION_CREATED",
        serde_json::json!({"name": req.session_name}),
    );
    data.sessions.insert(session_id, Arc::new(RwLock::new(session)));

    HttpResponse::Ok().json(serde_json::json!({
        "session_id": session_id,
        "campaign_id": req.campaign_id,
        "session_name": req.session_name,
        "status": "created"
    }))
}

async fn get_session(data: web::Data<AppState>, path: web::Path<Uuid>) -> impl Responder {
    let session_id = path.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let session = session_lock.read();
        HttpResponse::Ok().json(&*session)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

/// Hydrates a FULL GameSession snapshot (as previously exported by
/// `get_session`) into live state. This is the durability bridge: the
/// orchestrator persists snapshots in PostgreSQL and pushes them back here
/// after an engine restart or when migrating rooms.
async fn restore_session(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    body: web::Json<GameSession>,
    identity: AuthIdentity,
) -> impl Responder {
    let session_id = path.into_inner();
    // Restoring overwrites a table wholesale — only a GM, the session's
    // recorded owner, or the gateway's server-mediated durability principal
    // (post-restart hydration) may do that.
    let role = Role::from_identity(&identity);
    let is_service_principal = identity.user_id == "orchestrator-service";
    if !role.is_gm() && !is_service_principal {
        let is_owner = data
            .session_owners
            .get(&session_id)
            .map(|owner| *owner == identity.user_id)
            .unwrap_or(false);
        if !is_owner {
            return reject(
                &data,
                403,
                "FORBIDDEN_ROLE",
                "only the session owner or a GM may restore this session",
            );
        }
    }
    if body.session_id != session_id {
        return reject(
            &data,
            422,
            "SESSION_ID_MISMATCH",
            "snapshot session_id does not match the URL",
        );
    }
    let entity_count = body.entities.len();
    let event_count = body.ledger.events.len();
    data.session_owners.insert(session_id, identity.user_id.clone());
    data.sessions.insert(session_id, Arc::new(RwLock::new(body.into_inner())));

    HttpResponse::Ok().json(serde_json::json!({
        "status": "RESTORED",
        "session_id": session_id,
        "entities": entity_count,
        "events": event_count,
    }))
}

// --- Entity management (spawn/despawn with ingress gating) -------------------

#[derive(Debug, Deserialize)]
pub struct AddEntityReq {
    #[serde(flatten)]
    pub entity: vtt_core::EntityState,
    pub ingress: Option<vtt_core::IngressEvent>,
}

async fn add_entity(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<AddEntityReq>,
    identity: AuthIdentity,
) -> impl Responder {
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot mutate sessions");
    }

    // Ownership claim validation: players may only claim entities for
    // themselves; claiming someone else's identity is a GM privilege.
    // The orchestrator service principal is trusted to bind ownership on
    // behalf of authenticated players (e.g. character deploy).
    const SERVICE_PRINCIPAL: &str = "orchestrator-service";
    let entity = req.entity.clone();
    if let Some(claimed) = &entity.owner_player_id {
        if claimed != &identity.user_id
            && !role.is_gm()
            && identity.user_id != SERVICE_PRINCIPAL
        {
            return reject(
                &data,
                403,
                "OWNERSHIP_CLAIM_FORBIDDEN",
                "only GMs may bind an entity to another user",
            );
        }
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        match session.add_entity(entity, req.ingress.clone()) {
            Ok(()) => HttpResponse::Ok().json(serde_json::json!({
                "status": "SPAWNED",
                "entity_id": req.entity.id,
                "entity_name": req.entity.name,
            })),
            Err(e) => reject(&data, 422, "INGRESS_REJECTED", &e),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

async fn remove_entity(
    data: web::Data<AppState>,
    path: web::Path<(Uuid, Uuid)>,
    identity: AuthIdentity,
) -> impl Responder {
    let (session_id, entity_id) = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot mutate sessions");
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        match session.remove_entity(&entity_id, "DESPAWN") {
            Some(_) => HttpResponse::Ok().json(serde_json::json!({"status": "DESPAWNED"})),
            None => HttpResponse::NotFound().json(serde_json::json!({"error": "Entity not found"})),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

async fn set_session_map(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<SessionMap>,
    identity: AuthIdentity,
) -> impl Responder {
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot mutate sessions");
    }
    let new_map = req.into_inner();
    if let Err(e) = new_map.validate() {
        return reject(&data, 422, "INVALID_MAP", &e);
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        let map_payload = serde_json::json!({
            "width": new_map.width,
            "height": new_map.height,
            "solid_cell_count": new_map.solid_cells.len()
        });
        session.map = new_map;
        let campaign_id = session.campaign_id;
        session.ledger.append_event(
            session_id,
            campaign_id,
            Uuid::nil(),
            "MAP_UPDATED",
            map_payload,
        );
        HttpResponse::Ok().json(serde_json::json!({"status": "MAP_SET"}))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

/// Advances one full round via the core lifecycle engine: action budgets
/// refresh AND condition clocks tick (countdowns, end-of-turn saves, expiries).
async fn next_turn(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    identity: AuthIdentity,
) -> impl Responder {
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot advance the round");
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        let campaign_id = session.campaign_id;
        let seed = session_id.as_u128() as u64 ^ (session.ledger.current_sequence << 32);
        let mut dice = DiceEngine::with_seed(seed);
        let report = session.advance_round(&mut dice);
        let round = report.round;
        session.ledger.append_event(
            session_id,
            campaign_id,
            Uuid::nil(),
            "TURN_ADVANCED",
            serde_json::json!({
                "round": round,
                "condition_ticks": serde_json::to_value(&report.ticks).unwrap_or_default(),
            }),
        );
        HttpResponse::Ok().json(serde_json::json!({
            "status": "TURN_ADVANCED",
            "round": round,
            "report": report,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CastSpellReq {
    pub caster_id: Uuid,
    #[serde(default)]
    pub target_id: Option<Uuid>,
    /// Full spell definition. Until spells are served exclusively from a
    /// compendium-backed store, damage formulas are clamped by hard caps
    /// inside vtt-core (MAX_SPELL_DICE_COUNT / MAX_SPELL_DIE_SIDES).
    pub spell: vtt_core::SpellDefinition,
    #[serde(default)]
    pub cast_level: u8,
    #[serde(default)]
    pub seed: Option<u64>,
}

async fn resolve_cast_spell(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<CastSpellReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        if !session.entities.contains_key(&req.caster_id) {
            return reject(&data, 404, "CASTER_NOT_FOUND", "caster_id does not exist");
        }
        let caster_owner = session.entities[&req.caster_id].owner_player_id.clone();
        if !may_control_entity(caster_owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control the caster");
        }
        if let Some(tid) = req.target_id {
            if !session.entities.contains_key(&tid) {
                return reject(&data, 404, "TARGET_NOT_FOUND", "target_id does not exist");
            }
        }

        // Reaction interrupt stack: an armed Counterspell fizzles the spell
        // (the slot is still spent per SRD — handled inside core).
        let counterspelled = match req.target_id {
            Some(tid) => session.consume_reaction(tid, vtt_core::ReactionType::Counterspell),
            None => false,
        };

        let spell = req.spell.clone();
        let cast_level = req.cast_level.max(spell.level);
        let target_present = req.target_id.is_some();
        let target_id_val = req.target_id;

        // Split borrows: caster and target are distinct entities.
        let mut caster = session.entities.remove(&req.caster_id).expect("checked");
        let mut target_opt = target_id_val.map(|tid| {
            session.entities.remove(&tid).expect("checked")
        });

        let seed = req.seed.unwrap_or_else(|| {
            session_id.as_u128() as u64 ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);

        let result = RulesEvaluator::validate_and_cast_spell(
            &mut dice,
            &mut caster,
            target_opt.as_mut(),
            &spell,
            cast_level,
            counterspelled,
        );

        // Restore entities and commit the ledger entry under one write lock
        // (re-acquiring a DashMap shard while holding its guard deadlocks).
        session.entities.insert(caster.id, caster);
        if let Some(t) = target_opt {
            session.entities.insert(t.id, t);
        }

        match result {
            Ok(res) => {
                data.count_valid();
                let campaign_id = session.campaign_id;
                session.ledger.append_event(
                    session_id,
                    campaign_id,
                    req.caster_id,
                    if res.counterspelled { "SPELL_COUNTERSPELLED" } else { "SPELL_CAST" },
                    serde_json::to_value(&res).unwrap_or_default(),
                );
                HttpResponse::Ok().json(serde_json::json!({
                    "result": res,
                    "target_was_present": target_present,
                }))
            }
            Err(e) => reject(&data, 409, "SPELL_REJECTED", &e),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveEntityReq {
    pub entity_id: Uuid,
    pub x: f32,
    pub y: f32,
    #[serde(default)]
    pub z: f32,
}

async fn move_entity(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<MoveEntityReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // Wall-clip validation against the session map before moving.
        if !session.map.solid_cells.is_empty() {
            let grid = build_collision_grid(&session.map);
            let entity_pos = session
                .entities
                .get(&req.entity_id)
                .map(|e| e.position);
            if let Some((px, py, _)) = entity_pos {
                let cell = session.map.cell_size_feet;
                let dx = req.x - px;
                let dy = req.y - py;
                let dist = (dx * dx + dy * dy).sqrt();
                let steps = ((dist / (cell * 0.5)).ceil() as usize).max(1);
                for i in 0..=steps {
                    let t = i as f32 / steps as f32;
                    let sx = px + dx * t;
                    let sy = py + dy * t;
                    let (gx, gy, gz) = grid.world_to_grid(&Vector3::new(sx, sy, 0.0));
                    if grid.is_solid(gx, gy, gz) {
                        return reject(
                            &data,
                            409,
                            "WALL_CLIPPING",
                            "move segment crosses solid occluder",
                        );
                    }
                }
            }
        }

        let mover_owner = session.entities.get(&req.entity_id).and_then(|e| e.owner_player_id.clone());
        if !may_control_entity(mover_owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control this entity");
        }

        match session.move_entity(req.entity_id, (req.x, req.y, req.z)) {
            Ok(outcome) => {
                data.count_valid();
                // Additive Pillar-3 report: when leaving adjacency provoked an
                // opportunity attack from an enemy with an ARMED reaction, say
                // so in the response instead of resolving silently. The OA is
                // NOT auto-executed here — polling/prompting the reacting
                // entity is the reaction stack's behavior. The field is
                // omitted entirely when nothing could be provoked (mover
                // disengaged / no adjacent armed enemy / reaction already
                // spent) — matching `GameSession::move_entity` semantics,
                // which consumes the readied reaction at detection time.
                let mut body = serde_json::json!({ "status": "MOVED", "outcome": outcome });
                if let Some(trigger) = outcome.opportunity_attacks.first() {
                    body["opportunity_attack"] = serde_json::json!({
                        "provoked_by": trigger.attacker_id,
                        "reaction_type": "opportunity_attack",
                        "available": true,
                    });
                }
                HttpResponse::Ok().json(body)
            }
            Err(e) => reject(&data, 409, "MOVE_REJECTED", &e),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArmReactionReq {
    pub entity_id: Uuid,
    pub reaction_type: vtt_core::ReactionType,
}

async fn arm_reaction(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<ArmReactionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        let owner = session.entities.get(&req.entity_id).and_then(|e| e.owner_player_id.clone());
        if !may_control_entity(owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control this entity");
        }
        match session.arm_reaction(req.entity_id, req.reaction_type) {
            Ok(()) => {
                data.count_valid();
                HttpResponse::Ok().json(serde_json::json!({"status": "REACTION_ARMED"}))
            }
            Err(e) => reject(&data, 409, "REACTION_REJECTED", &e),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Authoritative combat ----------------------------------------------------

/// Clients may ONLY reference entities. Any attempt to smuggle attack_bonus /
/// target_ac / damage_expression through this payload fails deserialization
/// (`deny_unknown_fields`) and is rejected with HTTP 422.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttackActionReq {
    pub attacker_id: Uuid,
    pub target_id: Uuid,
    #[serde(default)]
    pub action_index: usize,
    /// Optional deterministic seed pinning the roll (any value is equally
    /// valid — the engine, not the client, decides what the seed means).
    #[serde(default)]
    pub seed: Option<u64>,
}

async fn resolve_attack(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<AttackActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // Both parties must exist server-side. No fallback stats, ever.
        let attacker = match session.entities.get(&req.attacker_id) {
            Some(a) => a.clone(),
            None => {
                return reject(
                    &data,
                    404,
                    "ATTACKER_NOT_FOUND",
                    "attacker_id does not exist in this session",
                )
            }
        };
        if !may_control_entity(attacker.owner_player_id.as_ref(), role, &identity.user_id) {
            return reject(
                &data,
                403,
                "ENTITY_NOT_OWNED",
                "you do not control the attacking entity",
            );
        }
        let target = match session.entities.get(&req.target_id) {
            Some(t) => t.clone(),
            None => {
                return reject(
                    &data,
                    404,
                    "TARGET_NOT_FOUND",
                    "target_id does not exist in this session",
                )
            }
        };

        if !attacker.can_act() {
            return reject(
                &data,
                409,
                "ENTITY_CANNOT_ACT",
                "attacker is unconscious, dead, or incapacitated",
            );
        }
        if target.is_dead {
            return reject(&data, 409, "TARGET_ALREADY_DEAD", "target has expired");
        }
        if attacker.id == target.id {
            return reject(&data, 422, "SELF_ATTACK_INVALID", "attacker and target coincide");
        }

        // Action economy is checked now but spent only AFTER every other
        // validation passes — an illegal attack must not consume the turn.
        if !attacker.action_budget.action {
            return reject(
                &data,
                409,
                "ACTION_ECONOMY_EXHAUSTED",
                "the attacker has already used their Action this turn",
            );
        }

        // Spatial edges: condition-derived adv/dis + cover from the session map.
        let distance = attacker.distance_to_feet(&target);
        let (advantage, disadvantage) = RulesEvaluator::edge_from_conditions(
            &attacker,
            &target,
            distance,
            attacker.position.2,
            target.position.2,
        );

        let grid = build_collision_grid(&session.map);
        let attacker_pos = Vector3::new(attacker.position.0, attacker.position.1, attacker.position.2);
        let target_pos = Vector3::new(target.position.0, target.position.1, target.position.2);
        let half_cell = session.map.cell_size_feet / 2.0;

        if !grid.has_line_of_sight(&attacker_pos, &target_pos) {
            return reject(
                &data,
                409,
                "NO_LINE_OF_SIGHT",
                "walls fully occlude the attack line",
            );
        }
        let cover = CoverCalculator::calculate_cover(&grid, &attacker_pos, &target_pos, half_cell);
        if cover == CoverType::TotalCover {
            return reject(
                &data,
                409,
                "TOTAL_COVER",
                "target is fully covered and cannot be targeted",
            );
        }

        // Reaction interrupt: a readied Shield spell raises AC by +5 when the
        // attack would land. The reaction is spent whether or not it matters.
        let mut shield_interrupt = false;
        if session.has_armed_reaction(req.target_id, vtt_core::ReactionType::Shield) {
            session.consume_reaction(req.target_id, vtt_core::ReactionType::Shield);
            shield_interrupt = true;
            if let Some(t) = session.entities.get_mut(&req.target_id) {
                t.shield_ac_bonus_active = true;
            }
        }

        let shield_bonus = if target.shield_ac_bonus_active || shield_interrupt { 5 } else { 0 };
        let effective_ac = target.ac + cover.ac_bonus() + shield_bonus;
        let attack = attacker.attack_for_index(req.action_index);

        // All validations passed — spend the Action now.
        if let Err(e) = session
            .entities
            .get_mut(&req.attacker_id)
            .expect("checked above")
            .spend_action()
        {
            return reject(&data, 409, &e, "action budget exhausted or entity incapable");
        }

        let seed = req.seed.unwrap_or_else(|| {
            // Server-derived fallback seed: session-scoped, replayable from the ledger length.
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);

        let res = RulesEvaluator::resolve_attack(
            &mut dice,
            req.attacker_id,
            req.target_id,
            attack.attack_bonus,
            effective_ac,
            &attack.damage_expression,
            attack.damage_type,
            target.current_hp,
            target.max_hp,
            target.temp_hp,
            &target.resistances,
            &target.vulnerabilities,
            &target.immunities,
            advantage,
            disadvantage,
        );

        match res {
            Ok(result) => {
                data.count_valid();
                let campaign_id = session.campaign_id;
                if let Some(t) = session.entities.get_mut(&req.target_id) {
                    t.current_hp = result.target_hp_remaining;
                    t.is_conscious = result.target_is_conscious;
                    t.is_dead = result.target_is_dead || result.target_hp_remaining <= -t.max_hp;
                }
                let event = session.ledger.append_event(
                    session_id,
                    campaign_id,
                    req.attacker_id,
                    "ATTACK_RESOLVED",
                    serde_json::to_value(&result).unwrap_or_default(),
                );
                let seq = event.sequence_id;

                // SRD automation (backlog 4.11): damage that lands on a still-
                // conscious concentrating target triggers a server-side CON
                // save — one per damage instance.
                let damage_amounts: Vec<i32> =
                    result.damage_instances.iter().map(|d| d.amount).collect();
                let conc_checks = roll_concentration_checks(
                    &mut session,
                    session_id,
                    req.attacker_id,
                    req.target_id,
                    &damage_amounts,
                    &mut dice,
                );

                let mut body = serde_json::to_value(&result).unwrap_or_default();
                body["action_name"] = serde_json::json!(attack.name);
                body["effective_target_ac"] = serde_json::json!(effective_ac);
                body["cover"] = serde_json::json!(cover);
                body["distance_feet"] = serde_json::json!(distance);
                body["advantage"] = serde_json::json!(advantage);
                body["disadvantage"] = serde_json::json!(disadvantage);
                if shield_interrupt {
                    body["reaction_interrupt"] =
                        serde_json::json!({"type": "shield", "ac_bonus": 5});
                }
                // Additive back-compat: present only when a check was triggered.
                match conc_checks.len() {
                    0 => {}
                    1 => {
                        body["concentration_check"] =
                            serde_json::to_value(&conc_checks[0]).unwrap_or_default();
                    }
                    _ => {
                        body["concentration_check"] =
                            serde_json::to_value(&conc_checks[0]).unwrap_or_default();
                        body["concentration_checks"] =
                            serde_json::to_value(&conc_checks).unwrap_or_default();
                    }
                }
                body["event_sequence"] = serde_json::json!(seq);
                HttpResponse::Ok().json(body)
            }
            Err(e) => reject(&data, 400, "RESOLUTION_FAILED", &e),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Damage-triggered concentration automation (backlog 4.11) -----------------

/// One server-side damage-triggered concentration save, serialized additively
/// into action responses as `concentration_check` when a check was triggered.
///
/// The DC math lives in vtt-core (`ActionResolver::resolve_concentration_check`:
/// SRD CON save vs DC = max(10, damage / 2)); the engine owns the roll so no
/// client ever supplies the outcome.
#[derive(Debug, Clone, Serialize)]
struct ConcentrationCheckOutcome {
    dc: i32,
    total: i32,
    passed: bool,
    broken: bool,
}

/// Runs the SRD concentration automation for every damage instance that just
/// landed on `target_id`.
///
/// Rules enforced here:
/// - zero/negative damage never triggers a save;
/// - an unconscious or dead target never saves (the spell ends by other
///   means — incapacitation — not through this path);
/// - each damage instance gets its OWN check, re-reading the entity between
///   instances because a failed earlier save may already have ended the spell;
/// - a failed save clears the concentration and appends one
///   `CONCENTRATION_BROKEN` ledger event `{target_id, spell_id, dc, total}`.
fn roll_concentration_checks(
    session: &mut GameSession,
    session_id: Uuid,
    actor_id: Uuid,
    target_id: Uuid,
    damage_instances: &[i32],
    dice: &mut DiceEngine,
) -> Vec<ConcentrationCheckOutcome> {
    let campaign_id = session.campaign_id;
    let mut outcomes = Vec::new();

    for &damage in damage_instances {
        if damage <= 0 {
            continue;
        }

        // Snapshot candidacy + CON modifier first; the mutable half happens
        // below so the borrow of `entities` is not held across the mutation.
        let (is_candidate, con_mod, active_spell) = match session.entities.get(&target_id) {
            Some(t) => (
                t.is_conscious && !t.is_dead && t.concentration.is_some(),
                t.abilities.modifier(Ability::Constitution),
                t.concentration.as_ref().map(|c| c.spell_id.clone()),
            ),
            None => break,
        };
        if !is_candidate {
            continue;
        }

        // Session dice only — the client never chooses the save roll.
        let natural = dice.roll_d20();
        let (passed, total, dc) =
            ActionResolver::resolve_concentration_check(natural, con_mod, damage);
        let broken = !passed;

        if broken {
            if let Some(t) = session.entities.get_mut(&target_id) {
                RulesEvaluator::end_concentration(t, "FAILED_CONCENTRATION_SAVE");
            }
            session.ledger.append_event(
                session_id,
                campaign_id,
                actor_id,
                "CONCENTRATION_BROKEN",
                serde_json::json!({
                    "target_id": target_id.to_string(),
                    "spell_id": active_spell.unwrap_or_default(),
                    "dc": dc,
                    "total": total,
                }),
            );
        }

        outcomes.push(ConcentrationCheckOutcome { dc, total, passed, broken });
    }

    outcomes
}

/// Applies damage that the ENGINE already rolled. The request references a
/// prior ATTACK_RESOLVED ledger event; the applied amount is taken from that
/// event's payload, never from the request body.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyDamageReq {
    pub target_id: Uuid,
    pub source_event_sequence: u64,
    /// Optional deterministic seed pinning the concentration save (if one is
    /// triggered). Additive and defaulted — pre-existing callers are unaffected.
    #[serde(default)]
    pub seed: Option<u64>,
}

async fn apply_damage(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<ApplyDamageReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        let source_event = session
            .ledger
            .events
            .iter()
            .find(|e| e.sequence_id == req.source_event_sequence && e.event_type == "ATTACK_RESOLVED")
            .cloned();
        let source_event = match source_event {
            Some(e) => e,
            None => {
                return reject(
                    &data,
                    422,
                    "SOURCE_EVENT_NOT_FOUND",
                    "no ATTACK_RESOLVED event at the given sequence — engine-rolled damage required",
                )
            }
        };

        let payload_target = source_event
            .payload
            .get("target_id")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok());
        let rolled_damage = source_event
            .payload
            .get("total_damage")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32;

        if payload_target != Some(req.target_id) {
            return reject(
                &data,
                422,
                "TARGET_MISMATCH",
                "source event was not rolled against this target",
            );
        }

        let target = match session.entities.get(&req.target_id) {
            Some(t) => t.clone(),
            None => return reject(&data, 404, "TARGET_NOT_FOUND", "target no longer exists"),
        };

        let (hp_rem, temp_rem, instant_death) = RulesEvaluator::apply_damage_to_hp(
            target.current_hp,
            target.max_hp,
            target.temp_hp,
            rolled_damage,
        );
        data.count_valid();
        let campaign_id = session.campaign_id;
        if let Some(t) = session.entities.get_mut(&req.target_id) {
            t.current_hp = hp_rem;
            t.temp_hp = temp_rem;
            t.is_dead = t.is_dead || instant_death;
            t.is_conscious = hp_rem > 0;
        }
        session.ledger.append_event(
            session_id,
            campaign_id,
            source_event.actor_id,
            "DAMAGE_APPLIED",
            serde_json::json!({
                "target_id": req.target_id.to_string(),
                "amount": rolled_damage,
                "source_event_sequence": req.source_event_sequence,
                "hp_remaining": hp_rem,
                "instant_death": instant_death
            }),
        );

        // SRD automation (backlog 4.11): applied damage challenges an active
        // concentration exactly like freshly-rolled attack damage.
        let seed = req.seed.unwrap_or_else(|| {
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);
        let conc_checks = roll_concentration_checks(
            &mut session,
            session_id,
            source_event.actor_id,
            req.target_id,
            &[rolled_damage],
            &mut dice,
        );
        let mut body = serde_json::json!({
            "status": "DAMAGE_APPLIED",
            "amount": rolled_damage,
            "hp_remaining": hp_rem,
            "instant_death": instant_death
        });
        if let Some(check) = conc_checks.first() {
            // Additive back-compat: present only when a check was triggered.
            body["concentration_check"] = serde_json::to_value(check).unwrap_or_default();
        }

        HttpResponse::Ok().json(body)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Healing & rests ---------------------------------------------------------

/// Ids-only heal request: the client names WHO gets how much — never how the
/// math works. Unknown fields are structurally rejected (HTTP 422), so no
/// client can smuggle an HP override or a bonus multiplier.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealEntityReq {
    pub entity_id: Uuid,
    /// Requested hit points to restore. Clamped server-side to
    /// `max_hp - current_hp`; negative values are rejected outright.
    pub amount: i32,
}

async fn heal_entity(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<HealEntityReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // A negative "heal" is damage smuggled through the wrong endpoint.
        if req.amount < 0 {
            return reject(
                &data,
                422,
                "NEGATIVE_HEAL_AMOUNT",
                "heal amounts must be zero or positive",
            );
        }
        if !session.entities.contains_key(&req.entity_id) {
            return reject(
                &data,
                404,
                "ENTITY_NOT_FOUND",
                "entity does not exist in session",
            );
        }
        let owner = session.entities[&req.entity_id].owner_player_id.clone();
        if !may_control_entity(owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control this entity");
        }
        if session.entities[&req.entity_id].is_dead {
            return reject(
                &data,
                409,
                "CANNOT_HEAL_DEAD",
                "dead entities cannot be healed (resurrection is out of scope)",
            );
        }

        // Server-authoritative math: clamp to the missing deficit, restore
        // consciousness above 0 HP, and wipe any stale death-save tally.
        let (applied, hp_remaining, death_saves_reset) = {
            let entity = session
                .entities
                .get_mut(&req.entity_id)
                .expect("existence checked above");
            let applied = req.amount.min(entity.max_hp - entity.current_hp).max(0);
            entity.current_hp += applied;
            if entity.current_hp > 0 && !entity.is_dead {
                entity.is_conscious = true;
            }
            let wiped = entity.reset_death_saves_if_healed();
            (applied, entity.current_hp, wiped)
        };

        data.count_valid();
        let campaign_id = session.campaign_id;
        session.ledger.append_event(
            session_id,
            campaign_id,
            req.entity_id,
            "HEALED",
            serde_json::json!({
                "target_id": req.entity_id.to_string(),
                "amount": applied,
                "hp_remaining": hp_remaining,
            }),
        );

        HttpResponse::Ok().json(serde_json::json!({
            "status": "HEALED",
            "entity_id": req.entity_id,
            "amount_applied": applied,
            "hp_remaining": hp_remaining,
            "death_saves_reset": death_saves_reset,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestKind {
    Short,
    Long,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestReq {
    pub kind: RestKind,
}

async fn take_rest(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<RestReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        data.count_valid();
        let campaign_id = session.campaign_id;

        match req.kind {
            // Short rest: no mechanical effect yet (SRD hit-dice spending is a
            // future hook). Ledgered so the intent is auditable and rewirable.
            RestKind::Short => {
                session.ledger.append_event(
                    session_id,
                    campaign_id,
                    Uuid::nil(),
                    "SHORT_REST_APPLIED",
                    serde_json::json!({"triggered_by": identity.user_id}),
                );
                HttpResponse::Ok().json(serde_json::json!({
                    "status": "SHORT_REST_APPLIED",
                    "restored_entities": 0,
                    "hook": "short-rest mechanics (hit dice) not yet implemented",
                }))
            }
            // Long rest: SRD restores hit points (and clears exhaustion —
            // exhaustion tracking is engine-side TODO). Spell slots are NOT
            // refilled because slot MAXIMA are not tracked engine-side yet;
            // only remaining counts live on EntityState.
            RestKind::Long => {
                // Only player characters / owned creatures rest here, and only
                // those the caller controls (a player long-rests their own
                // party members; a GM rests everyone at the table).
                let candidates: Vec<Uuid> = session
                    .entities
                    .values()
                    .filter(|e| (e.is_player || e.owner_player_id.is_some()) && !e.is_dead)
                    .filter(|e| may_control_entity(e.owner_player_id.as_ref(), role, &identity.user_id))
                    .map(|e| e.id)
                    .collect();

                let mut restored: Vec<serde_json::Value> = Vec::new();
                for id in candidates {
                    let (max_hp, hp_remaining) = {
                        let entity = session.entities.get_mut(&id).expect("checked above");
                        entity.current_hp = entity.max_hp;
                        entity.temp_hp = 0;
                        entity.is_conscious = true;
                        entity.reset_death_saves_if_healed();
                        (entity.max_hp, entity.current_hp)
                    };
                    session.ledger.append_event(
                        session_id,
                        campaign_id,
                        id,
                        "LONG_REST_APPLIED",
                        serde_json::json!({
                            "target_id": id.to_string(),
                            "hp_restored_to_max": max_hp,
                            "hp_remaining": hp_remaining,
                        }),
                    );
                    restored.push(serde_json::json!({
                        "entity_id": id,
                        "hp_remaining": hp_remaining,
                    }));
                }

                HttpResponse::Ok().json(serde_json::json!({
                    "status": "LONG_REST_APPLIED",
                    "restored_entities": restored.len(),
                    "entities": restored,
                    "note": "spell slots are not refilled (slot maxima untracked engine-side); exhaustion not modeled",
                }))
            }
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Stateless rule calculators (dice utilities; still authenticated) -------

/// Snake-case wire name for a [`CheckOutcomeTier`]. (The core enum itself
/// serializes SCREAMING_SNAKE_CASE for ledger payloads; the HTTP contract is
/// snake_case, matching the rest of this endpoint's response vocabulary.)
fn tier_wire_name(tier: CheckOutcomeTier) -> &'static str {
    match tier {
        CheckOutcomeTier::CriticalSuccess => "critical_success",
        CheckOutcomeTier::Success => "success",
        CheckOutcomeTier::SuccessAtCost => "success_at_cost",
        CheckOutcomeTier::CriticalFailure => "critical_failure",
    }
}

/// Deterministic wire name for a [`CostSuggestion`] — no RNG involved, so
/// replays of the same margin always render the same suggestion.
fn cost_suggestion_name(suggestion: &CostSuggestion) -> String {
    match suggestion {
        CostSuggestion::InspirationLoss => "inspiration_loss".to_string(),
        CostSuggestion::AlertClockTick => "alert_clock_tick".to_string(),
        CostSuggestion::Condition(condition) => {
            let name = serde_json::to_value(condition)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| format!("{condition:?}").to_lowercase());
            format!("condition_{name}")
        }
    }
}

/// Annotate an already-serialized roll response with the fail-forward fields
/// derived from the shared core engine ([`RulesEvaluator::resolve_check_margin`]).
///
/// Legacy fields on `body` are left untouched so existing clients keep their
/// exact current semantics; the tier/margin/cost fields are purely additive.
fn with_fail_forward_fields(
    mut body: serde_json::Value,
    natural_roll: i32,
    modifier: i32,
    dc: i32,
) -> serde_json::Value {
    let (_, margin, tier) = RulesEvaluator::resolve_check_margin(natural_roll, modifier, dc);
    body["margin"] = serde_json::json!(margin);
    body["tier"] = serde_json::json!(tier_wire_name(tier));
    if tier == CheckOutcomeTier::SuccessAtCost {
        if let Some(cost) = RulesEvaluator::suggest_cost(margin) {
            body["cost_suggestion"] = serde_json::json!(cost_suggestion_name(&cost));
        }
    }
    body
}


#[derive(Debug, Deserialize)]
pub struct CheckActionReq {
    pub modifier: i32,
    pub dc: i32,
    pub cost_margin: i32,
    pub advantage: Option<bool>,
    pub disadvantage: Option<bool>,
    /// Optional deterministic seed pinning the d20 (any value is equally
    /// valid — the engine decides what the seed means). Omitted → server
    /// entropy. Mirrors the seed field on the other roll endpoints.
    pub seed: Option<u64>,
}

async fn resolve_check(data: web::Data<AppState>, req: web::Json<CheckActionReq>) -> impl Responder {
    data.count_request();
    let mut dice = match req.seed {
        Some(seed) => DiceEngine::with_seed(seed),
        None => DiceEngine::new(),
    };
    // Honor advantage/disadvantage by pre-selecting the kept d20
    // (tuples are (used_roll, r1, r2)) before 4-tier resolution.
    let kept_roll = if req.disadvantage.unwrap_or(false) {
        Some(dice.roll_d20_disadvantage().0)
    } else if req.advantage.unwrap_or(false) {
        Some(dice.roll_d20_advantage().0)
    } else {
        None
    };
    let res = if let Some(natural_roll) = kept_roll {
        let total = natural_roll + req.modifier;
        let outcome = if natural_roll == 20 || total >= req.dc + 10 {
            "CRITICAL_SUCCESS"
        } else if natural_roll == 1 || total < (req.dc - 5) {
            "CRITICAL_FAILURE"
        } else if total >= req.dc {
            "SUCCESS"
        } else if total >= req.dc - req.cost_margin {
            "SUCCESS_AT_A_COST"
        } else {
            "CRITICAL_FAILURE"
        };
        with_fail_forward_fields(
            serde_json::json!({
                "roll": natural_roll,
                "modifier": req.modifier,
                "total": total,
                "dc": req.dc,
                "outcome": outcome,
            }),
            natural_roll,
            req.modifier,
            req.dc,
        )
    } else {
        let res =
            ActionResolver::resolve_check_4tier(&mut dice, req.modifier, req.dc, req.cost_margin);
        with_fail_forward_fields(serde_json::json!(res), res.roll, req.modifier, req.dc)
    };
    data.count_valid();
    HttpResponse::Ok().json(res)
}

#[derive(Debug, Deserialize)]
pub struct SaveActionReq {
    pub save_modifier: i32,
    pub dc: i32,
    #[serde(default)]
    pub ability: Option<Ability>,
    pub advantage: Option<bool>,
    pub disadvantage: Option<bool>,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    /// Optional deterministic seed pinning the d20 (see `CheckActionReq`).
    #[serde(default)]
    pub seed: Option<u64>,
}

async fn resolve_save(data: web::Data<AppState>, req: web::Json<SaveActionReq>) -> impl Responder {
    data.count_request();
    let mut dice = match req.seed {
        Some(seed) => DiceEngine::with_seed(seed),
        None => DiceEngine::new(),
    };
    // Advantage tuples are (used_roll, r1, r2).
    let natural_roll = if req.disadvantage.unwrap_or(false) {
        dice.roll_d20_disadvantage().0
    } else if req.advantage.unwrap_or(false) {
        dice.roll_d20_advantage().0
    } else {
        dice.roll_d20()
    };
    // Conditions that auto-fail STR/DEX saves are enforced server-side.
    let auto_fail = req.conditions.iter().any(|c| c.fails_str_dex_saves());

    let (passed, total) = if auto_fail {
        (false, 0)
    } else {
        let total = natural_roll + req.save_modifier;
        (total >= req.dc, total)
    };

    // Fail-forward annotation (Pillar 8): tier bands come from the shared
    // core engine. The binary `passed` flag keeps today's threshold semantics;
    // SuccessAtCost is surfaced additively so clients can render "succeeded,
    // but pay a price". Auto-failing conditions override the tier — no roll
    // can rescue them — while margin stays consistent with the reported total.
    let (_, engine_margin, engine_tier) =
        RulesEvaluator::resolve_check_margin(natural_roll, req.save_modifier, req.dc);
    let (margin, tier) = if auto_fail {
        (total - req.dc, CheckOutcomeTier::CriticalFailure)
    } else {
        (engine_margin, engine_tier)
    };
    data.count_valid();

    let mut body = serde_json::json!({
        "ability": req.ability.unwrap_or(Ability::Strength),
        "natural_roll": natural_roll,
        "save_modifier": req.save_modifier,
        "total": total,
        "dc": req.dc,
        "auto_failed": auto_fail,
        "passed": passed,
    });
    body["margin"] = serde_json::json!(margin);
    body["tier"] = serde_json::json!(tier_wire_name(tier));
    if tier == CheckOutcomeTier::SuccessAtCost {
        if let Some(cost) = RulesEvaluator::suggest_cost(margin) {
            body["cost_suggestion"] = serde_json::json!(cost_suggestion_name(&cost));
        }
    }
    HttpResponse::Ok().json(body)
}

#[derive(Debug, Deserialize)]
pub struct ConcentrationActionReq {
    pub con_modifier: i32,
    pub damage_taken: i32,
}

async fn resolve_concentration(
    data: web::Data<AppState>,
    req: web::Json<ConcentrationActionReq>,
) -> impl Responder {
    data.count_request();
    let mut dice = DiceEngine::new();
    let natural_roll = dice.roll_d20();
    let (passed, total, dc) =
        ActionResolver::resolve_concentration_check(natural_roll, req.con_modifier, req.damage_taken);
    data.count_valid();

    HttpResponse::Ok().json(serde_json::json!({
        "natural_roll": natural_roll,
        "con_modifier": req.con_modifier,
        "total": total,
        "dc": dc,
        "damage_taken": req.damage_taken,
        "passed": passed,
        "concentration_maintained": passed,
    }))
}

#[derive(Debug, Deserialize)]
pub struct DeathSaveActionReq {
    pub successes: Option<u8>,
    pub failures: Option<u8>,
    pub is_stabilized: bool,
    pub is_dead: bool,
}

/// Death saves now operate on the SERVER-side entity's death save state when
/// an entity context is provided; bare calls start from a clean state.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityDeathSaveReq {
    pub entity_id: Uuid,
}

async fn resolve_death_save(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<EntityDeathSaveReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        let owner = session.entities.get(&req.entity_id).and_then(|e| e.owner_player_id.clone());
        if !may_control_entity(owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control this entity");
        }

        let entity = match session.entities.get(&req.entity_id) {
            Some(e) => e,
            None => return reject(&data, 404, "ENTITY_NOT_FOUND", "entity does not exist in session"),
        };
        // SRD: regaining hit points wipes the death-save ledger. A healed
        // entity has no business rolling death saves, but clear any stale
        // tally eagerly so it can never leak into a later drop.
        if entity.current_hp > 0 {
            if let Some(e) = session.entities.get_mut(&req.entity_id) {
                e.reset_death_saves_if_healed();
            }
            return reject(
                &data,
                400,
                "INVALID_STATE",
                "entity has hit points and is not making death saves",
            );
        }

        let mut state = entity.death_saves;
        let was_dead = entity.is_dead;
        let campaign_id = session.campaign_id;
        let mut dice = DiceEngine::new();
        let natural_roll = dice.roll_d20();
        let outcome = ActionResolver::resolve_death_save(&mut state, natural_roll);
        data.count_valid();
        if let Some(entity) = session.entities.get_mut(&req.entity_id) {
            entity.death_saves = state;
            if state.is_dead && !was_dead {
                entity.is_dead = true;
            }
        }
        session.ledger.append_event(
            session_id,
            campaign_id,
            req.entity_id,
            "DEATH_SAVE_RESOLVED",
            serde_json::json!({
                "outcome": outcome,
                "natural_roll": natural_roll,
                "successes": state.successes,
                "failures": state.failures,
                "is_stabilized": state.is_stabilized,
                "is_dead": state.is_dead,
            }),
        );

        HttpResponse::Ok().json(serde_json::json!({
            "outcome": outcome,
            "natural_roll": natural_roll,
            "successes": state.successes,
            "failures": state.failures,
            "is_stabilized": state.is_stabilized,
            "is_dead": state.is_dead,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Spatial utilities ------------------------------------------------------

fn build_collision_grid(map: &SessionMap) -> GridCollisionMap {
    let mut grid = GridCollisionMap::new(map.width, map.height, 1, map.cell_size_feet);
    for &(x, y) in &map.solid_cells {
        grid.set_solid(x, y, 0, true);
    }
    grid
}

fn build_terrain_overlay(map: &SessionMap) -> TerrainOverlay {
    let mut overlay = TerrainOverlay::new();
    for &(x, y) in &map.difficult_terrain {
        overlay.set_cost(x, y, 0, 2);
    }
    overlay
}

#[derive(Debug, Deserialize)]
pub struct LosReq {
    pub attacker_pos: Vector3,
    pub target_pos: Vector3,
    pub target_radius: f32,
    pub grid_width: usize,
    pub grid_height: usize,
    pub solid_cells: Vec<(usize, usize)>,
}

async fn compute_los(req: web::Json<LosReq>) -> impl Responder {
    let mut grid = GridCollisionMap::new(req.grid_width, req.grid_height, 1, 5.0);
    for &(x, y) in &req.solid_cells {
        grid.set_solid(x, y, 0, true);
    }

    let has_los = grid.has_line_of_sight(&req.attacker_pos, &req.target_pos);
    let cover = CoverCalculator::calculate_cover(
        &grid,
        &req.attacker_pos,
        &req.target_pos,
        req.target_radius,
    );

    HttpResponse::Ok().json(serde_json::json!({
        "has_line_of_sight": has_los,
        "cover_type": cover,
        "ac_bonus": cover.ac_bonus(),
        "dex_save_bonus": cover.dex_save_bonus()
    }))
}

#[derive(Debug, Deserialize)]
pub struct PathReq {
    pub start: Vector3,
    pub end: Vector3,
    pub speed_budget: f32,
    pub grid_width: usize,
    pub grid_height: usize,
    pub solid_cells: Vec<(usize, usize)>,
    #[serde(default)]
    pub difficult_terrain: Vec<(usize, usize)>,
}

async fn compute_path(req: web::Json<PathReq>) -> impl Responder {
    let mut grid = GridCollisionMap::new(req.grid_width, req.grid_height, 1, 5.0);
    for &(x, y) in &req.solid_cells {
        grid.set_solid(x, y, 0, true);
    }
    let terrain = build_terrain_overlay(&SessionMap {
        width: req.grid_width,
        height: req.grid_height,
        solid_cells: vec![],
        difficult_terrain: req.difficult_terrain.clone(),
        cell_size_feet: 5.0,
    });

    let path_res =
        AStarPathfinder::find_path_with_terrain(&grid, &terrain, &req.start, &req.end, req.speed_budget);
    HttpResponse::Ok().json(path_res)
}

// --- WFC ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct WfcReq {
    pub room_desc: RoomDescriptor,
    pub seed: Option<u64>,
}

async fn generate_wfc_map(req: web::Json<WfcReq>) -> impl Responder {
    match DungeonGenerator::generate_room(&req.room_desc, req.seed) {
        Ok(tiles) => HttpResponse::Ok().json(serde_json::json!({
            "width": req.room_desc.width,
            "height": req.room_desc.height,
            "tiles": tiles
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({"error": e})),
    }
}

// --- Scripting ----------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct WasmScriptReq {
    pub wat_source: String,
    pub function_name: String,
    pub params: Vec<i32>,
    /// Requested fuel budget. Clamped server-side to MAX_FUEL_CEILING inside
    /// the sandbox engine — clients cannot grant themselves more compute.
    pub fuel_limit: u64,
}

async fn execute_wasm_script(
    data: web::Data<AppState>,
    req: web::Json<WasmScriptReq>,
) -> impl Responder {
    match data.wasm_engine.execute_wat(
        &req.wat_source,
        &req.function_name,
        &req.params,
        req.fuel_limit,
    ) {
        Ok(res) => HttpResponse::Ok().json(res),
        Err(e) => HttpResponse::BadRequest().json(serde_json::json!({"error": e})),
    }
}

#[derive(Debug, Deserialize)]
pub struct RhaiScriptReq {
    pub script: String,
    pub context: ScriptExecutionContext,
    #[serde(default)]
    pub seed: Option<u64>,
}

async fn execute_rhai_script(
    data: web::Data<AppState>,
    req: web::Json<RhaiScriptReq>,
) -> impl Responder {
    // Deterministic default seed derived from script content hash position.
    let seed = req
        .seed
        .unwrap_or_else(|| fnv1a_hash(&req.script));
    match data.rhai_engine.evaluate_spell_hook_seeded(&req.script, &req.context, seed) {
        Ok(res) => HttpResponse::Ok().json(serde_json::json!({"result": res.to_string(), "seed": seed})),
        Err(e) => HttpResponse::BadRequest().json(serde_json::json!({"error": e.to_string()})),
    }
}

// --- Safety X-card ------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SafetyXCardReq {
    pub player_id: String,
    pub topic: String,
    pub target_sequence_id: u64,
}

async fn trigger_safety_rewind(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<SafetyXCardReq>,
    identity: AuthIdentity,
) -> impl Responder {
    let session_id = path.into_inner();
    // Safety tools are player-veto authority (Pillar 11): any authenticated
    // non-spectator participant may raise an X-card.
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot trigger safety rewind");
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // FULL state restoration: HP, consciousness, death, positions,
        // concentration and budgets are replayed from the surviving ledger —
        // not just flag-flipping bookkeeping.
        let report = session.safety_rewind(req.target_sequence_id);
        let campaign_id = session.campaign_id;

        // Mirror the revert flags into durable storage when connected.
        if let Some(pool) = &data.db {
            let pool = pool.clone();
            let sid = session_id;
            let target_seq = req.target_sequence_id as i64;
            tokio::spawn(async move {
                let result = sqlx::query(
                    "UPDATE narrative_state.event_sourcing_log SET is_reverted = TRUE \
                     WHERE session_id = $1 AND ledger_sequence > $2",
                )
                .bind(sid)
                .bind(target_seq)
                .execute(&pool)
                .await;
                if let Err(e) = result {
                    log::warn!("persistence: rewind flag update failed: {}", e);
                }
            });
        }

        // Record the safety intervention itself (never reverted by later rewinds
        // of the same range since its sequence is beyond target).
        let event = session.ledger.append_event(
            session_id,
            campaign_id,
            Uuid::nil(),
            "SAFETY_REWIND_APPLIED",
            serde_json::json!({
                "triggered_by": req.player_id,
                "raised_by_identity": identity.user_id,
                "topic": req.topic,
                "reverted_to_sequence": req.target_sequence_id,
                "reverted_event_count": report.reverted_event_count,
                "restored_entities": report.restored_entities,
                "removed_entities": report.removed_entities,
            }),
        );
        let seq = event.sequence_id;

        // Post-rewind authority travels WITH the response so a browser can
        // converge its local tokens in one round trip — it holds no HMAC
        // token and therefore cannot call GET /sessions/{id} itself.
        // Payload size is fine here: in-memory sessions are small (entities +
        // ledger), and this is an explicit safety intervention, not a hot path.
        let snapshot = serde_json::to_value(&*session)
            .unwrap_or_else(|_| serde_json::Value::Null);

        HttpResponse::Ok().json(serde_json::json!({
            "status": "SAFETY_REWIND_SUCCESS",
            "rewind_report": report,
            "intervention_event_sequence": seq,
            "snapshot": snapshot
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Live CRDT Sync WebSocket (/ws/sessions/{id}/sync) ------------------------

fn fnv1a_hash(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Validates a token move against the session map: no wall clipping and no
/// per-update movement beyond the entity's speed. Returns Ok(()) when legal.
fn validate_token_move(
    data: &AppState,
    room_id: &str,
    token_key: u64,
    token_name: &str,
    x: f32,
    y: f32,
) -> Result<(), String> {
    let session_uuid = Uuid::parse_str(room_id).ok();
    let (grid, cell, speed_cap) = match &session_uuid.and_then(|id| data.sessions.get(&id)) {
        Some(session_lock) => {
            let session = session_lock.read();
            if session.map.solid_cells.is_empty() && session.map.difficult_terrain.is_empty() {
                return Ok(()); // No authored geometry yet — nothing to violate.
            }
            // Resolve the entity behind this token by display name.
            let speed = session
                .entities
                .values()
                .find(|e| e.name.eq_ignore_ascii_case(token_name))
                .map(|e| e.speed_feet)
                .unwrap_or(DEFAULT_MOVE_STEP_FEET);
            (build_collision_grid(&session.map), session.map.cell_size_feet, speed + cell_hint(&session.map))
        }
        None => return Ok(()), // Free rooms (e.g. lobby) carry no map constraints.
    };

    let last_positions = data
        .movement
        .entry(room_id.to_string())
        .or_default();

    if let Some(prev_ref) = last_positions.get(&token_key) {
        let (px, py) = *prev_ref;
        let dx = x - px;
        let dy = y - py;
        let dist = (dx * dx + dy * dy).sqrt();
        if dist > speed_cap {
            return Err(format!(
                "MOVE_TOO_FAST: {:.1} ft in one update exceeds {:.1} ft cap",
                dist, speed_cap
            ));
        }
        // Sample along the segment at sub-cell steps; any solid cell clips.
        let steps = ((dist / (cell * 0.5)).ceil() as usize).max(1);
        for i in 0..=steps {
            let t = i as f32 / steps as f32;
            let sx = px + dx * t;
            let sy = py + dy * t;
            let (gx, gy, gz) = grid.world_to_grid(&Vector3::new(sx, sy, 0.0));
            if grid.is_solid(gx, gy, gz) {
                return Err("WALL_CLIPPING: path crosses solid occluder".to_string());
            }
        }
    }

    last_positions.insert(token_key, (x, y));
    Ok(())
}

fn cell_hint(map: &SessionMap) -> f32 {
    map.cell_size_feet
}

/// Normalize the browser's camelCase TokenUpdate payload into the CRDT
/// model, validate the movement, and run LWW arbitration; true means
/// "accept & relay".
fn accept_token_update(
    data: &AppState,
    hub: &CrdtRelayHub,
    room_id: &str,
    value: &serde_json::Value,
) -> bool {
    let payload = match value.get("payload") {
        Some(p) => p,
        None => return false,
    };
    let token_name = match payload.get("tokenId").and_then(|v| v.as_str()) {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => return false,
    };

    let num = |key: &str| -> f32 {
        payload
            .get(key)
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32
    };
    let ts_ms = payload
        .get("timestamp")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as u64);

    let token_key = fnv1a_hash(&token_name);
    let (x, y) = (num("x"), num("y"));
    if let Err(reason) = validate_token_move(data, room_id, token_key, &token_name, x, y) {
        log::info!("Rejected token move for '{}': {}", token_name, reason);
        return false;
    }

    let transform = TokenTransform {
        token_id: Uuid::from_u64_pair(
            token_key,
            fnv1a_hash(&format!("{}#y", token_name)),
        ),
        x,
        y,
        z: num("z"),
        rotation: num("rotation"),
        scale: num("scale"),
        elevation: num("elevation"),
        vector_clock: VectorClock {
            client_id: token_key,
            sequence: ts_ms,
        },
        timestamp: chrono::Utc::now(),
    };

    matches!(
        hub.handle_incoming_message(room_id, CrdtSyncMessage::TokenUpdate(transform)),
        Some(CrdtSyncMessage::TokenUpdate(_))
    )
}

async fn ws_sync(
    data: web::Data<AppState>,
    path: web::Path<String>,
    req: actix_web::HttpRequest,
    body: web::Payload,
) -> impl Responder {
    let room_id = path.into_inner();

    // Identity was inserted into extensions by the auth middleware during the
    // upgrade request — capture it so per-message ownership checks apply.
    let identity = req
        .extensions()
        .get::<AuthIdentity>()
        .cloned()
        .unwrap_or(AuthIdentity {
            user_id: "anonymous".to_string(),
            role: None,
        });
    let role = Role::from_identity(&identity);

    let (response, session, mut msg_stream) = match actix_ws::handle(&req, body) {
        Ok(handshake) => handshake,
        Err(e) => {
            return HttpResponse::BadRequest().json(serde_json::json!({"error": e.to_string()}))
        }
    };

    let mut session = session;
    let peer_id = data.peers.join(&room_id, &session);
    let hub = Arc::clone(&data.crdt_hub);
    let peers = Arc::clone(&data.peers);
    let app_state = data.clone();
    let rid = room_id.clone();

    actix_web::rt::spawn(async move {
        while let Some(Ok(msg)) = msg_stream.next().await {
            match msg {
                Message::Text(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(mut value) => {
                        match value.get("type").and_then(|t| t.as_str()) {
                            Some("TokenUpdate") => {
                                // Validate movement, then relay only updates that win LWW arbitration.
                                if accept_token_update(&app_state, &hub, &rid, &value) {
                                    peers.broadcast(&rid, peer_id, &text).await;
                                }
                            }
                            Some("FogUpdate") => {
                                // Fog layers are OWNED: a layer id is
                                // "fog:{user_id}" and only its owner (or a
                                // GM) may write it. Spoofs are dropped.
                                let layer_id = value
                                    .pointer("/payload/layerId")
                                    .or_else(|| value.pointer("/payload/layer_id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let owned_by_sender =
                                    layer_id == format!("fog:{}", identity.user_id);
                                if owned_by_sender || role.is_gm() {
                                    peers.broadcast(&rid, peer_id, &text).await;
                                } else {
                                    log::warn!(
                                        "Dropped FogUpdate from {} for foreign layer '{}'",
                                        identity.user_id,
                                        layer_id
                                    );
                                }
                            }
                            Some("CursorAwareness") => {
                                // Stamp server-verified identity onto the
                                // cursor so clients cannot impersonate peers.
                                if let Some(payload) =
                                    value.get_mut("payload").and_then(|p| p.as_object_mut())
                                {
                                    payload.insert(
                                        "clientId".to_string(),
                                        serde_json::json!(fnv1a_hash(&identity.user_id)),
                                    );
                                }
                                peers
                                    .broadcast(&rid, peer_id, &value.to_string())
                                    .await;
                            }
                            Some("Heartbeat") | Some("SyncStep1") => {
                                let _ = session.text(text.clone()).await;
                            }
                            _ => {}
                        }
                    }
                    Err(_) => {}
                },
                Message::Ping(bytes) => {
                    let _ = session.pong(&bytes).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        peers.leave(&rid, peer_id);
        let _ = session.close(None);
    });

    response
}

async fn room_presence(data: web::Data<AppState>, path: web::Path<String>) -> impl Responder {
    let room_id = path.into_inner();
    HttpResponse::Ok().json(serde_json::json!({
        "room_id": room_id,
        "connected_peers": data.peers.count(&room_id),
    }))
}

// --- App assembly ------------------------------------------------------------

/// Registers all routes. Shared between `main` and the integration tests so
/// tests exercise exactly the production configuration.
pub fn configure_app(cfg: &mut web::ServiceConfig) {
    cfg.route("/health", web::get().to(health_check))
        .route("/metrics", web::get().to(get_metrics))
        .route("/ws/sessions/{id}/sync", web::get().to(ws_sync))
        .service(
        web::scope("/api/v1")
            .route("/sessions", web::post().to(create_session))
            .route("/sessions/{id}", web::get().to(get_session))
            .route("/sessions/{id}/restore", web::put().to(restore_session))
            .route("/sessions/{id}/entities", web::post().to(add_entity))
            .route("/sessions/{id}/entities/{eid}", web::delete().to(remove_entity))
            .route("/sessions/{id}/map", web::put().to(set_session_map))
            .route("/sessions/{id}/action/attack", web::post().to(resolve_attack))
            .route("/sessions/{id}/action/cast-spell", web::post().to(resolve_cast_spell))
            .route("/sessions/{id}/move", web::post().to(move_entity))
            .route("/sessions/{id}/reactions/arm", web::post().to(arm_reaction))
            .route("/sessions/{id}/turn/next", web::post().to(next_turn))
            .route("/sessions/{id}/action/death-save", web::post().to(resolve_death_save))
            .route("/sessions/{id}/damage", web::post().to(apply_damage))
            .route("/sessions/{id}/heal", web::post().to(heal_entity))
            .route("/sessions/{id}/rest", web::post().to(take_rest))
            .route("/sessions/{id}/safety/x-card", web::post().to(trigger_safety_rewind))
            .route("/ws/sessions/{id}/sync", web::get().to(ws_sync))
            .route("/rooms/{id}/presence", web::get().to(room_presence))
            .route("/actions/check", web::post().to(resolve_check))
            .route("/actions/save", web::post().to(resolve_save))
            .route("/actions/concentration", web::post().to(resolve_concentration))
            .route("/spatial/los", web::post().to(compute_los))
            .route("/spatial/path", web::post().to(compute_path))
            .route("/maps/generate", web::post().to(generate_wfc_map))
            .route("/scripts/wasm", web::post().to(execute_wasm_script))
            .route("/scripts/rhai", web::post().to(execute_rhai_script)),
    );
}

/// Strict origin policy: only origins listed in VTT_ALLOWED_ORIGINS may call
/// the engine. Defaults to the local dev client.
fn strict_cors() -> Cors {
    let origins = std::env::var("VTT_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:3000,http://127.0.0.1:3000".to_string());
    let mut cors = Cors::default()
        .allowed_methods(vec!["GET", "POST", "PUT", "DELETE", "OPTIONS"])
        .allowed_headers(vec![header::AUTHORIZATION, header::CONTENT_TYPE])
        .max_age(3600);
    for origin in origins.split(',').map(str::trim).filter(|o| !o.is_empty()) {
        cors = cors.allowed_origin(origin);
    }
    cors
}

#[actix_web::main]
pub async fn run() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8088);

    let verifier = Arc::new(AuthVerifier::from_env().map_err(|e| {
        log::error!("{e}");
        std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string())
    })?);
    log::info!("HMAC auth enabled (gateway-shared secret)");

    let mut app_state = AppState::new();

    // Availability-first persistence: connect when DATABASE_URL is present,
    // degrade gracefully to memory-only otherwise.
    if let Ok(db_url) = std::env::var("DATABASE_URL") {
        if !db_url.is_empty() {
            match crate::persistence::connect(&db_url).await {
                Ok(pool) => {
                    log::info!("Postgres persistence active (write-through tailer)");
                    app_state.db = Some(pool);
                }
                Err(e) => log::warn!("DATABASE_URL unreachable ({}); continuing memory-only", e),
            }
        }
    }

    let state = web::Data::new(app_state);

    // Persistence tailer: drains ledger deltas to Postgres ~every 1.5 s.
    // Holds the Data<AppState> handle itself — DashMap::clone deep-copies,
    // so cloning the maps would isolate the tailer from live state.
    if state.db.is_some() {
        let state2 = state.clone();
        actix_web::rt::spawn(async move {
            let pool = state2.db.as_ref().expect("checked").clone();
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(1500));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                for entry in state2.sessions.iter() {
                    let sid = *entry.key();
                    let lock = entry.value().clone();
                    let last = state2.flush_watermarks.get(&sid).map(|r| *r).unwrap_or(0);

                    // Short-lived read guard: gather the pending batch.
                    let (campaign_id, round, name, batch) = {
                        let s = lock.read();
                        let batch: Vec<(Uuid, String, serde_json::Value, String, u64, bool)> = s
                            .ledger
                            .events
                            .iter()
                            .filter(|e| e.sequence_id > last)
                            .map(|e| {
                                (
                                    e.actor_id,
                                    e.event_type.clone(),
                                    e.payload.clone(),
                                    e.state_hash.clone(),
                                    e.sequence_id,
                                    e.is_reverted,
                                )
                            })
                            .collect();
                        (s.campaign_id, s.combat.round, s.session_name.clone(), batch)
                    };
                    if batch.is_empty() {
                        continue;
                    }

                    let mut failed = false;
                    if let Err(e) =
                        crate::persistence::ensure_session_row(&pool, sid, campaign_id, &name, round).await
                    {
                        failed = true;
                        state2.persistence_failures.fetch_add(1, Ordering::Relaxed);
                        log::warn!("persistence: session upsert failed: {}", e);
                    }
                    // Track the highest sequence that actually landed so a
                    // mid-batch failure only retries the failed suffix next
                    // tick. insert_event is idempotent (ON CONFLICT DO
                    // NOTHING), so re-draining an already-flushed prefix is
                    // harmless rather than a unique-index poison-pill.
                    let mut last_flushed = last;
                    if !failed {
                        for (actor_id, event_type, payload, state_hash, seq, is_reverted) in &batch {
                            if let Err(e) = crate::persistence::insert_event(
                                &pool, sid, campaign_id, *actor_id, event_type, payload.clone(),
                                state_hash, *seq, *is_reverted,
                            )
                            .await
                            {
                                state2.persistence_failures.fetch_add(1, Ordering::Relaxed);
                                log::warn!("persistence: event insert failed: {}", e);
                                break;
                            }
                            last_flushed = *seq;
                        }
                    }
                    if last_flushed > last {
                        state2.flush_watermarks.insert(sid, last_flushed);
                    }
                }
            }
        });
    }

    log::info!("Starting AI-Native VTT Authoritative Engine Server on 0.0.0.0:{}", port);

    HttpServer::new(move || {
        App::new()
            .wrap(Logger::default())
            .wrap(strict_cors())
            .wrap(crate::AuthMiddleware {
                verifier: Arc::clone(&verifier),
            })
            .app_data(state.clone())
            .route("/health", web::get().to(health_check))
            .route("/metrics", web::get().to(get_metrics))
            // Root-path alias matching the browser client's sync URL contract.
            .route("/ws/sessions/{id}/sync", web::get().to(ws_sync))
            .configure(configure_app)
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
