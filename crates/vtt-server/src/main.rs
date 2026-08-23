use actix_cors::Cors;
use actix_web::{middleware::Logger, web, App, HttpResponse, HttpServer, Responder};
use actix_ws::Message;
use dashmap::DashMap;
use futures_util::StreamExt;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use uuid::Uuid;

use vtt_core::{
    Ability, ActionResolver, Condition, DamageType, DeathSaveState, DiceEngine, GameSession,
    RulesEvaluator,
};
use vtt_crdt_sync::{CrdtRelayHub, CrdtSyncMessage, TokenTransform, VectorClock};
use vtt_scripting::{RhaiNarrativeEngine, SandboxedWasmEngine, ScriptExecutionContext};
use vtt_spatial::{AStarPathfinder, CoverCalculator, GridCollisionMap, Vector3};
use vtt_wfc::{DungeonGenerator, RoomDescriptor};

pub struct AppState {
    pub sessions: DashMap<Uuid, Arc<RwLock<GameSession>>>,
    pub crdt_hub: Arc<CrdtRelayHub>,
    pub peers: Arc<PeerRegistry>,
    pub wasm_engine: Arc<SandboxedWasmEngine>,
    pub rhai_engine: Arc<RhaiNarrativeEngine>,
    pub total_action_requests: AtomicU64,
    pub valid_action_executions: AtomicU64,
    pub total_audits: AtomicU64,
    pub auditor_rejections: AtomicU64,
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
    pub auditor_rejection_rate_pct: f64,
    pub target_sla_ms: u64,
}

async fn health_check() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "healthy".to_string(),
        service: "vtt-authoritative-engine".to_string(),
        version: "1.0.0".to_string(),
    })
}

async fn get_metrics(data: web::Data<AppState>) -> impl Responder {
    let total_act = data.total_action_requests.load(Ordering::Relaxed);
    let valid_act = data.valid_action_executions.load(Ordering::Relaxed);
    let mcr = if total_act > 0 {
        (valid_act as f64 / total_act as f64) * 100.0
    } else {
        100.0
    };

    let total_aud = data.total_audits.load(Ordering::Relaxed);
    let audit_rej = data.auditor_rejections.load(Ordering::Relaxed);
    let afpr = if total_aud > 0 {
        (audit_rej as f64 / total_aud as f64) * 100.0
    } else {
        0.0
    };

    HttpResponse::Ok().json(MetricsResponse {
        mechanical_compliance_rate_pct: mcr,
        total_actions: total_act,
        valid_actions: valid_act,
        auditor_rejection_rate_pct: afpr,
        target_sla_ms: 10,
    })
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionReq {
    pub campaign_id: Uuid,
    pub session_name: String,
}

async fn create_session(
    data: web::Data<AppState>,
    req: web::Json<CreateSessionReq>,
) -> impl Responder {
    let session_id = Uuid::new_v4();
    let session = GameSession::new(session_id, req.campaign_id, req.session_name.clone());
    data.sessions.insert(session_id, Arc::new(RwLock::new(session)));

    HttpResponse::Ok().json(serde_json::json!({
        "session_id": session_id,
        "campaign_id": req.campaign_id,
        "session_name": req.session_name,
        "status": "created"
    }))
}

async fn get_session(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
) -> impl Responder {
    let session_id = path.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let session = session_lock.read();
        HttpResponse::Ok().json(&*session)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[derive(Debug, Deserialize)]
pub struct AttackActionReq {
    pub attacker_id: Uuid,
    pub target_id: Uuid,
    pub attack_bonus: i32,
    pub target_ac: i32,
    pub damage_expression: String,
    pub damage_type: DamageType,
    pub advantage: bool,
    pub disadvantage: bool,
}

async fn resolve_attack(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<AttackActionReq>,
) -> impl Responder {
    data.total_action_requests.fetch_add(1, Ordering::Relaxed);
    let session_id = path.into_inner();

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        let campaign_id = session.campaign_id;
        let mut dice = DiceEngine::new();

        let (cur_hp, max_hp, temp_hp) = if let Some(target) = session.entities.get(&req.target_id) {
            (target.current_hp, target.max_hp, target.temp_hp)
        } else {
            (20, 20, 0)
        };

        match RulesEvaluator::resolve_attack(
            &mut dice,
            req.attacker_id,
            req.target_id,
            req.attack_bonus,
            req.target_ac,
            &req.damage_expression,
            req.damage_type,
            cur_hp,
            max_hp,
            temp_hp,
            &[],
            &[],
            &[],
            req.advantage,
            req.disadvantage,
        ) {
            Ok(res) => {
                data.valid_action_executions.fetch_add(1, Ordering::Relaxed);
                if let Some(target) = session.entities.get_mut(&req.target_id) {
                    target.current_hp = res.target_hp_remaining;
                    target.is_conscious = res.target_is_conscious;
                    target.is_dead = res.target_is_dead;
                }

                session.ledger.append_event(
                    session_id,
                    campaign_id,
                    req.attacker_id,
                    "ATTACK_RESOLVED",
                    serde_json::to_value(&res).unwrap_or_default(),
                );

                HttpResponse::Ok().json(res)
            }
            Err(e) => HttpResponse::BadRequest().json(serde_json::json!({"error": e})),
        }
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[derive(Debug, Deserialize)]
pub struct CheckActionReq {
    pub modifier: i32,
    pub dc: i32,
    pub cost_margin: i32,
    pub advantage: Option<bool>,
    pub disadvantage: Option<bool>,
}

async fn resolve_check(
    data: web::Data<AppState>,
    req: web::Json<CheckActionReq>,
) -> impl Responder {
    data.total_action_requests.fetch_add(1, Ordering::Relaxed);
    let mut dice = DiceEngine::new();
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
        serde_json::json!({
            "roll": natural_roll,
            "modifier": req.modifier,
            "total": total,
            "dc": req.dc,
            "outcome": outcome,
        })
    } else {
        let res = ActionResolver::resolve_check_4tier(&mut dice, req.modifier, req.dc, req.cost_margin);
        serde_json::json!(res)
    };
    data.valid_action_executions.fetch_add(1, Ordering::Relaxed);
    HttpResponse::Ok().json(res)
}

#[derive(Debug, Deserialize)]
pub struct SaveActionReq {
    pub save_modifier: i32,
    pub dc: i32,
    pub ability: Option<Ability>,
    pub advantage: Option<bool>,
    pub disadvantage: Option<bool>,
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

async fn resolve_save(
    data: web::Data<AppState>,
    req: web::Json<SaveActionReq>,
) -> impl Responder {
    data.total_action_requests.fetch_add(1, Ordering::Relaxed);
    let mut dice = DiceEngine::new();
    // Advantage tuples are (used_roll, r1, r2).
    let natural_roll = if req.disadvantage.unwrap_or(false) {
        dice.roll_d20_disadvantage().0
    } else if req.advantage.unwrap_or(false) {
        dice.roll_d20_advantage().0
    } else {
        dice.roll_d20()
    };

    let (passed, total) = ActionResolver::resolve_saving_throw(
        natural_roll,
        req.save_modifier,
        req.dc,
        &req.conditions,
        req.ability.unwrap_or(Ability::Strength),
    );
    data.valid_action_executions.fetch_add(1, Ordering::Relaxed);

    HttpResponse::Ok().json(serde_json::json!({
        "ability": req.ability.unwrap_or(Ability::Strength),
        "natural_roll": natural_roll,
        "save_modifier": req.save_modifier,
        "total": total,
        "dc": req.dc,
        "passed": passed,
    }))
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
    data.total_action_requests.fetch_add(1, Ordering::Relaxed);
    let mut dice = DiceEngine::new();
    let natural_roll = dice.roll_d20();
    let (passed, total, dc) =
        ActionResolver::resolve_concentration_check(natural_roll, req.con_modifier, req.damage_taken);
    data.valid_action_executions.fetch_add(1, Ordering::Relaxed);

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
    pub successes: u8,
    pub failures: u8,
    pub is_stabilized: Option<bool>,
    pub is_dead: Option<bool>,
    pub natural_roll: Option<i32>,
}

async fn resolve_death_save(
    data: web::Data<AppState>,
    req: web::Json<DeathSaveActionReq>,
) -> impl Responder {
    data.total_action_requests.fetch_add(1, Ordering::Relaxed);
    let mut dice = DiceEngine::new();
    let natural_roll = req.natural_roll.unwrap_or_else(|| dice.roll_d20());

    let mut state = DeathSaveState {
        successes: req.successes,
        failures: req.failures,
        is_stabilized: req.is_stabilized.unwrap_or(false),
        is_dead: req.is_dead.unwrap_or(false),
    };
    let outcome = ActionResolver::resolve_death_save(&mut state, natural_roll);
    data.valid_action_executions.fetch_add(1, Ordering::Relaxed);

    HttpResponse::Ok().json(serde_json::json!({
        "outcome": outcome,
        "natural_roll": natural_roll,
        "successes": state.successes,
        "failures": state.failures,
        "is_stabilized": state.is_stabilized,
        "is_dead": state.is_dead,
    }))
}

// --- Live CRDT Sync WebSocket (/ws/sessions/{id}/sync) ---------------------

fn fnv1a_hash(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Normalize the browser's camelCase TokenUpdate payload into the CRDT
/// model and run it through LWW arbitration; true means "accept & relay".
fn accept_token_update(hub: &CrdtRelayHub, room_id: &str, value: &serde_json::Value) -> bool {
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

    let transform = TokenTransform {
        token_id: Uuid::from_u64_pair(
            fnv1a_hash(&token_name),
            fnv1a_hash(&format!("{}#y", token_name)),
        ),
        x: num("x"),
        y: num("y"),
        z: num("z"),
        rotation: num("rotation"),
        scale: num("scale"),
        elevation: num("elevation"),
        vector_clock: VectorClock {
            client_id: fnv1a_hash(&token_name),
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
    let rid = room_id.clone();

    actix_web::rt::spawn(async move {
        while let Some(Ok(msg)) = msg_stream.next().await {
            match msg {
                Message::Text(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(value) => {
                        match value.get("type").and_then(|t| t.as_str()) {
                            Some("TokenUpdate") => {
                                // Relay only updates that win LWW arbitration.
                                if accept_token_update(&hub, &rid, &value) {
                                    peers.broadcast(&rid, peer_id, &text).await;
                                }
                            }
                            Some("CursorAwareness") | Some("FogUpdate") => {
                                peers.broadcast(&rid, peer_id, &text).await;
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

#[derive(Debug, Deserialize)]
pub struct LosReq {
    pub attacker_pos: Vector3,
    pub target_pos: Vector3,
    pub target_radius: f32,
    pub grid_width: usize,
    pub grid_height: usize,
    pub solid_cells: Vec<(usize, usize)>,
}

async fn compute_los(
    req: web::Json<LosReq>,
) -> impl Responder {
    let mut grid = GridCollisionMap::new(req.grid_width, req.grid_height, 1, 5.0);
    for &(x, y) in &req.solid_cells {
        grid.set_solid(x, y, 0, true);
    }

    let has_los = grid.has_line_of_sight(&req.attacker_pos, &req.target_pos);
    let cover = CoverCalculator::calculate_cover(&grid, &req.attacker_pos, &req.target_pos, req.target_radius);

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
}

async fn compute_path(
    req: web::Json<PathReq>,
) -> impl Responder {
    let mut grid = GridCollisionMap::new(req.grid_width, req.grid_height, 1, 5.0);
    for &(x, y) in &req.solid_cells {
        grid.set_solid(x, y, 0, true);
    }

    let path_res = AStarPathfinder::find_path(&grid, &req.start, &req.end, req.speed_budget);
    HttpResponse::Ok().json(path_res)
}

#[derive(Debug, Deserialize)]
pub struct WfcReq {
    pub room_desc: RoomDescriptor,
    pub seed: Option<u64>,
}

async fn generate_wfc_map(
    req: web::Json<WfcReq>,
) -> impl Responder {
    match DungeonGenerator::generate_room(&req.room_desc, req.seed) {
        Ok(tiles) => HttpResponse::Ok().json(serde_json::json!({
            "width": req.room_desc.width,
            "height": req.room_desc.height,
            "tiles": tiles
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({"error": e})),
    }
}

#[derive(Debug, Deserialize)]
pub struct WasmScriptReq {
    pub wat_source: String,
    pub function_name: String,
    pub params: Vec<i32>,
    pub fuel_limit: u64,
}

async fn execute_wasm_script(
    data: web::Data<AppState>,
    req: web::Json<WasmScriptReq>,
) -> impl Responder {
    match data.wasm_engine.execute_wat(&req.wat_source, &req.function_name, &req.params, req.fuel_limit) {
        Ok(res) => HttpResponse::Ok().json(res),
        Err(e) => HttpResponse::BadRequest().json(serde_json::json!({"error": e})),
    }
}

#[derive(Debug, Deserialize)]
pub struct RhaiScriptReq {
    pub script: String,
    pub context: ScriptExecutionContext,
}

async fn execute_rhai_script(
    data: web::Data<AppState>,
    req: web::Json<RhaiScriptReq>,
) -> impl Responder {
    match data.rhai_engine.evaluate_spell_hook(&req.script, &req.context) {
        Ok(res) => HttpResponse::Ok().json(serde_json::json!({"result": res.to_string()})),
        Err(e) => HttpResponse::BadRequest().json(serde_json::json!({"error": e.to_string()})),
    }
}

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
) -> impl Responder {
    let session_id = path.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        let campaign_id = session.campaign_id;
        let reverted = session.ledger.rewind_to_sequence(req.target_sequence_id);

        session.ledger.append_event(
            session_id,
            campaign_id,
            Uuid::nil(),
            "SAFETY_REWIND_APPLIED",
            serde_json::json!({
                "triggered_by": req.player_id,
                "topic": req.topic,
                "reverted_to_sequence": req.target_sequence_id,
                "reverted_event_count": reverted.len()
            }),
        );

        HttpResponse::Ok().json(serde_json::json!({
            "status": "SAFETY_REWIND_SUCCESS",
            "reverted_events": reverted
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8088);

    let state = web::Data::new(AppState {
        sessions: DashMap::new(),
        crdt_hub: Arc::new(CrdtRelayHub::new()),
        peers: Arc::new(PeerRegistry::new()),
        wasm_engine: Arc::new(SandboxedWasmEngine::new().expect("Failed Wasm engine init")),
        rhai_engine: Arc::new(RhaiNarrativeEngine::new()),
        total_action_requests: AtomicU64::new(0),
        valid_action_executions: AtomicU64::new(0),
        total_audits: AtomicU64::new(0),
        auditor_rejections: AtomicU64::new(0),
    });

    log::info!("Starting AI-Native VTT Authoritative Engine Server on 0.0.0.0:{}", port);

    HttpServer::new(move || {
        let cors = Cors::permissive();

        App::new()
            .wrap(cors)
            .wrap(Logger::default())
            .app_data(state.clone())
            .route("/health", web::get().to(health_check))
            .route("/metrics", web::get().to(get_metrics))
            // Root-path alias matching the browser client's sync URL contract.
            .route("/ws/sessions/{id}/sync", web::get().to(ws_sync))
            .service(
                web::scope("/api/v1")
                    .route("/sessions", web::post().to(create_session))
                    .route("/sessions/{id}", web::get().to(get_session))
                    .route("/sessions/{id}/action/attack", web::post().to(resolve_attack))
                    .route("/sessions/{id}/safety/x-card", web::post().to(trigger_safety_rewind))
                    .route("/ws/sessions/{id}/sync", web::get().to(ws_sync))
                    .route("/rooms/{id}/presence", web::get().to(room_presence))
                    .route("/actions/check", web::post().to(resolve_check))
                    .route("/actions/save", web::post().to(resolve_save))
                    .route("/actions/concentration", web::post().to(resolve_concentration))
                    .route("/actions/death-save", web::post().to(resolve_death_save))
                    .route("/spatial/los", web::post().to(compute_los))
                    .route("/spatial/path", web::post().to(compute_path))
                    .route("/maps/generate", web::post().to(generate_wfc_map))
                    .route("/scripts/wasm", web::post().to(execute_wasm_script))
                    .route("/scripts/rhai", web::post().to(execute_rhai_script))
            )
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
