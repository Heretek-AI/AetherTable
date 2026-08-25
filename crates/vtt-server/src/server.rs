//! Authoritative VTT Engine Server.
//!
//! Zero-trust rules authority:
//! - Clients reference entities by id; ALL math (bonuses, AC, resistances,
//!   movement legality) resolves here from server-side `EntityState`.
//! - Every mutating endpoint requires a gateway-signed HMAC session token.
//! - Token movement over the CRDT relay is validated against the session map.
//!
//! Threat model — disclosed residual allowances (accepted, not fixed):
//! - Spectator inference from traffic silence: per-seat projection drops
//!   hidden-token deltas for player/spectator views (`project_frame_for_view`),
//!   but the ABSENCE of frames and their timestamp gaps still tells an
//!   observer that a hidden entity acted and roughly how often. Not where or
//!   what; closing this needs constant-rate cover traffic. (Audit A3#8.)
//! - Unowned player-flagged tokens may be spawned by any non-spectator seat
//!   (`MONSTER_SPAWN_FORBIDDEN` gate) — legacy-client compatibility.
//! - Egress/ingress ledger records for entities already removed from the
//!   board survive projection for non-GM views (unresolvable against the
//!   roster); the ledger itself is trusted wholesale for non-GMs.

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
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

use vtt_core::{
    Ability, ActionResolver, CheckOutcomeTier, Condition, CostSuggestion, DiceEngine,
    EntityState, GameSession, LightingZoneCell, RulesEvaluator, SessionMap, VisionMode,
};
use vtt_crdt_sync::{
    CrdtRelayHub, CrdtSyncMessage, FogOfWarMask, SnapshotToken, SyncSnapshot, TokenTransform,
    VectorClock,
};
use vtt_scripting::{RhaiNarrativeEngine, SandboxedWasmEngine, ScriptExecutionContext};
use vtt_spatial::{
    AStarPathfinder, CoverCalculator, CoverType, GridCollisionMap, LightingOverlay, TerrainOverlay,
    Vector3, visibility_polygon_z,
};
use vtt_wfc::{DungeonGenerator, RoomDescriptor};



/// Default per-update movement ceiling when no matching entity can be resolved.
const DEFAULT_MOVE_STEP_FEET: f32 = 30.0;

/// Default per-user concurrent WebSocket connection cap for `/ws/sync`
/// (`VTT_WS_PER_USER` overrides). Sized to cover one user with several tabs,
/// a reconnect storm's overlap window, and a spectator HUD, while capping the
/// fan-out multiplier a single identity can pin on the server.
pub const DEFAULT_WS_CONNECTIONS_PER_USER: usize = 8;

/// Fail-soft positive-usize env parser mirroring
/// [`crate::ratelimit::parse_per_minute`]: unset, garbage, zero or negative
/// input yields `default`.
fn parse_env_usize(raw: Option<String>, default: usize) -> usize {
    match raw {
        None => default,
        Some(s) => match s.trim().parse::<usize>() {
            Ok(n) if n > 0 => n,
            _ => {
                log::warn!(
                    "env value {:?} unusable; falling back to default {}",
                    s,
                    default
                );
                default
            }
        },
    }
}

/// Rules-content baseline for a session (GOALS.md Pillar 2: the campaign setup
/// wizard picks SRD 5.1 vs SRD 5.2 and that choice must stick).
///
/// HONEST SCOPE: today no engine logic branches on this value — the Rust rules
/// math (`vtt-core`) implements the SRD 5.1 baseline unconditionally, and all
/// version-specific CONTENT (spells, stat blocks, glossary) lives gateway-side
/// in the Python compendium store. This preference is persisted and projected
/// here so callers CAN branch: the orchestrator reads it back off
/// `GET /sessions/{id}` to pick which compendium slice it serves for the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RuleVersion {
    /// Legacy baseline — what the engine's own math implements (and the
    /// fleet-wide fallback when a create request omits the choice).
    #[default]
    Srd51,
    /// 2024 revision; content served gateway-side from the srd_5_2_* files.
    Srd52,
}

impl RuleVersion {
    pub const fn as_str(self) -> &'static str {
        match self {
            RuleVersion::Srd51 => "srd_5_1",
            RuleVersion::Srd52 => "srd_5_2",
        }
    }

    /// Strict wire-format parse. Unknown values are REJECTED (422 upstream),
    /// never silently coerced: a table silently running a different edition
    /// than its GM configured is worse than a loud error.
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "srd_5_1" => Ok(RuleVersion::Srd51),
            "srd_5_2" => Ok(RuleVersion::Srd52),
            other => Err(format!(
                "unknown rule_version {:?}; expected \"srd_5_1\" or \"srd_5_2\"",
                other
            )),
        }
    }
}

/// Fail-soft deployment-wide default for sessions created without an explicit
/// `rule_version` (`RuleVersion::default()` = legacy SRD 5.1, overridable via
/// VTT_DEFAULT_RULE_VERSION). Unset or unrecognized values fall back to SRD 5.1
/// baseline with a logged warning rather than refusing to boot.
fn default_rule_version_from_env() -> RuleVersion {
    match std::env::var("VTT_DEFAULT_RULE_VERSION") {
        Err(_) => RuleVersion::default(),
        Ok(raw) => match RuleVersion::parse(raw.trim()) {
            Ok(v) => v,
            Err(_) => {
                log::warn!(
                    "env VTT_DEFAULT_RULE_VERSION={:?} unusable; falling back to {}",
                    raw,
                    RuleVersion::default().as_str()
                );
                RuleVersion::default()
            }
        },
    }
}

pub struct AppState {
    pub sessions: DashMap<Uuid, Arc<RwLock<GameSession>>>,
    /// Per-session rules baseline (GOALS.md Pillar 2). Kept beside the session
    /// because `GameSession` itself is owned by `vtt-core` and carries no such
    /// field; travels through the snapshot persist/hydrate bridge via an
    /// injected/accepted `rule_version` key on the serialized snapshot.
    pub session_rule_versions: DashMap<Uuid, RuleVersion>,
    /// Deployment default when a create request omits `rule_version`
    /// (`VTT_DEFAULT_RULE_VERSION`, fail-soft; legacy default SRD 5.1).
    pub default_rule_version: RuleVersion,
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
    /// Per-user concurrent WebSocket connection cap (`VTT_WS_PER_USER`,
    /// default [`DEFAULT_WS_CONNECTIONS_PER_USER`]). Fail-soft parse.
    pub ws_per_user_cap: usize,
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
            session_rule_versions: DashMap::new(),
            default_rule_version: default_rule_version_from_env(),
            crdt_hub: Arc::new(CrdtRelayHub::new()),
            peers: Arc::new(PeerRegistry::new()),
            wasm_engine: Arc::new(SandboxedWasmEngine::new().expect("Failed Wasm engine init")),
            rhai_engine: Arc::new(RhaiNarrativeEngine::new()),
            movement: DashMap::new(),
            session_owners: DashMap::new(),
            db: None,
            flush_watermarks: DashMap::new(),
            persistence_failures: Arc::new(AtomicU64::new(0)),
            ws_per_user_cap: parse_env_usize(
                std::env::var("VTT_WS_PER_USER").ok(),
                DEFAULT_WS_CONNECTIONS_PER_USER,
            ),
            total_action_requests: AtomicU64::new(0),
            valid_action_executions: AtomicU64::new(0),
            rejected_action_requests: AtomicU64::new(0),
            total_audits: AtomicU64::new(0),
            auditor_rejections: AtomicU64::new(0),
        }
    }

    /// Effective rules baseline for a session: the recorded wizard choice, or
    /// the deployment default when the session predates preference tracking
    /// (or was hydrated from a snapshot that predated it).
    pub fn rule_version_for(&self, session_id: Uuid) -> RuleVersion {
        self.session_rule_versions
            .get(&session_id)
            .map(|v| *v)
            .unwrap_or(self.default_rule_version)
    }

    /// Stamps the session's effective rule version onto a projected snapshot.
    /// Applied AFTER `project_snapshot_for_role`: the preference is non-
    /// sensitive campaign configuration, so every role's projection carries it
    /// and any role's snapshot can be fed back through `/restore` losslessly.
    fn attach_rule_version(
        &self,
        mut snapshot: serde_json::Value,
        session_id: Uuid,
    ) -> serde_json::Value {
        if let Some(obj) = snapshot.as_object_mut() {
            obj.insert(
                "rule_version".to_string(),
                serde_json::json!(self.rule_version_for(session_id).as_str()),
            );
        }
        snapshot
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

/// Canonical orchestrator service principal id minted by the Python gateway
/// (`routing/engine_client.py` signs tokens with this user_id and no role
/// claim). Treated as privileged alongside GMs wherever privilege exists.
const SERVICE_PRINCIPAL_ID: &str = "orchestrator-service";

/// True when this caller may invoke the stateless compute utilities
/// (`/actions/*` rolls, `/spatial/*` solvers, `/maps/generate`): players and
/// GMs yes, spectators no. Spectators watch the board — they have no combat
/// math to resolve, and every one of these routes leaks tactical information
/// (cover bands, path costs, tile grids) that the spectator projection of
/// `/sessions/{id}` deliberately withholds.
fn may_compute(role: Role) -> bool {
    !matches!(role, Role::Spectator)
}

/// True when this caller may EXECUTE attacker-controlled script programs
/// (`/scripts/wasm`, `/scripts/rhai`) or PIN DETERMINISTIC DICE SEEDS on the
/// stateless roll routes: GMs and the orchestrator service principal only.
///
/// Scripts: homebrew mechanics are authored by the table's GM (GOALS.md P10);
/// players reach homebrew effects through session-scoped actions resolved by
/// the GM, never by running programs directly, so direct script execution is a
/// GM/service tool. Seeds: a pinned seed lets its caller pre-compute favorable
/// outcomes offline before sending the request — acceptable for the trusted
/// principals running determinism harnesses, unacceptable for clients.
fn is_privileged_principal(identity: &AuthIdentity) -> bool {
    Role::from_identity(identity).is_gm() || identity.user_id == SERVICE_PRINCIPAL_ID
}

/// Shared spectator gate for the stateless routes: returns the 403 response
/// when this caller may not use them at all.
fn refuse_non_compute_role(data: &AppState, what: &str, role: Role) -> Option<HttpResponse> {
    if may_compute(role) {
        None
    } else {
        Some(reject(
            data,
            403,
            "FORBIDDEN_ROLE",
            &format!("spectators cannot {what}"),
        ))
    }
}

/// One live WebSocket peer plus the verified role of its connection.
/// Role travels WITH the registration so fan-out can be filtered per frame —
/// client-side spectator filtering protects rendering, not the wire.
/// (Identity is stamped onto outgoing frames where needed — e.g. cursors —
/// at send time from the connection's own auth context, so no peer field
/// retains it.)
struct PeerConnection {
    socket: actix_ws::Session,
    role: Role,
}

/// Per-peer CursorAwareness fan-out cap, frames per sliding minute
/// (relay-audit ingress flood). Chosen to sit far above legitimate pointer-
/// update rates (~2/s) while capping the fan-out multiplier a single peer can
/// impose on a full room.
const CURSOR_FRAMES_PER_MINUTE: u32 = 120;
const CURSOR_WINDOW: Duration = Duration::from_secs(60);

/// Live WebSocket peer registry per room. The CrdtRelayHub merges state
/// (LWW arbitration); this struct handles the fan-out to connected clients.
pub struct PeerRegistry {
    rooms: DashMap<String, DashMap<u64, PeerConnection>>,
    next_peer_id: AtomicU64,
    /// Sliding-window hit log per peer id for cursor-frame admission.
    cursor_hits: DashMap<u64, VecDeque<Instant>>,
    /// LIVE WebSocket connections per authenticated user id (relay audit,
    /// iteration 4): `/ws/sync` is deliberately unmetered by the rate
    /// limiter, so this is the only bound on how many sockets one identity
    /// can hold. Slots are acquired at upgrade time and released when the
    /// peer's message loop ends, so a reconnect storm cannot lock a user out
    /// permanently — closing any live socket frees its slot immediately.
    user_connections: DashMap<String, usize>,
}

impl PeerRegistry {
    pub fn new() -> Self {
        Self {
            rooms: DashMap::new(),
            next_peer_id: AtomicU64::new(1),
            cursor_hits: DashMap::new(),
            user_connections: DashMap::new(),
        }
    }

    /// Acquires one of `cap` concurrent connection slots for `user_id`.
    /// Check-and-increment happens under the entry's shard guard, so two
    /// simultaneous upgrades cannot both squeeze under the cap. `false`
    /// means the caller must refuse the upgrade.
    fn acquire_user_slot(&self, user_id: &str, cap: usize) -> bool {
        let cap = cap.max(1); // a cap of 0 would silently lock everyone out
        let mut count = self
            .user_connections
            .entry(user_id.to_string())
            .or_insert(0);
        if *count >= cap {
            return false;
        }
        *count += 1;
        true
    }

    /// Releases one slot when a connection ends. Saturating so a double
    /// release can never push the count negative.
    fn release_user_slot(&self, user_id: &str) {
        if let Some(mut count) = self.user_connections.get_mut(user_id) {
            *count = count.saturating_sub(1);
        }
    }

    /// Live connection count for one user (test/metrics introspection).
    pub fn user_connection_count(&self, user_id: &str) -> usize {
        self.user_connections.get(user_id).map(|c| *c).unwrap_or(0)
    }

    fn join(&self, room_id: &str, session: &actix_ws::Session, role: Role) -> u64 {
        let peer_id = self.next_peer_id.fetch_add(1, Ordering::Relaxed);
        self.rooms
            .entry(room_id.to_string())
            .or_default()
            .insert(
                peer_id,
                PeerConnection {
                    socket: session.clone(),
                    role,
                },
            );
        peer_id
    }

    fn leave(&self, room_id: &str, peer_id: u64) {
        if let Some(peers) = self.rooms.get(room_id) {
            peers.remove(&peer_id);
        }
        self.cursor_hits.remove(&peer_id);
    }

    /// Admits at most [`CURSOR_FRAMES_PER_MINUTE`] frames per peer id over the
    /// last [`CURSOR_WINDOW`] sliding window; `false` means the caller drops
    /// the frame silently. Keyed by the server-assigned peer id — never by
    /// anything client-supplied.
    fn admit_cursor_frame(&self, peer_id: u64) -> bool {
        let now = Instant::now();
        let mut entry = self.cursor_hits.entry(peer_id).or_default();
        while let Some(front) = entry.front() {
            if now.duration_since(*front) >= CURSOR_WINDOW {
                entry.pop_front();
            } else {
                break;
            }
        }
        if entry.len() >= CURSOR_FRAMES_PER_MINUTE as usize {
            return false;
        }
        entry.push_back(now);
        true
    }

    /// Fan `text` out to every peer in the room except `except_peer` whose
    /// connection satisfies `eligible`. This is where relay-level RBAC lives:
    /// eligibility is decided from the PEER's authenticated role/identity,
    /// never from anything the frame claims about itself.
    async fn broadcast_if(
        &self,
        room_id: &str,
        except_peer: u64,
        text: &str,
        eligible: impl Fn(&PeerConnection) -> bool,
    ) {
        if let Some(peers) = self.rooms.get(room_id) {
            for entry in peers.iter() {
                if *entry.key() != except_peer && eligible(entry.value()) {
                    let mut peer_session = entry.value().socket.clone();
                    // actix-ws Session::text is async; dropped futures never flush.
                    let _ = peer_session.text(text).await;
                }
            }
        }
    }

    async fn broadcast(&self, room_id: &str, except_peer: u64, text: &str) {
        self.broadcast_if(room_id, except_peer, text, |_| true).await;
    }

    /// Per-seat fan-out (iteration 36): every recipient gets the projection
    /// computed for ITS [`DeliveryView`] rather than a single role-filtered
    /// choice between "the raw frame" and "nothing". `projections` memoizes at
    /// most ONE projection per view class per call, so N sockets sharing a
    /// class cost exactly one projection plus N sends — never one projection
    /// per socket. Ordering matches `broadcast_if`: a single pass over the
    /// registry, each peer's frame written before the next peer is considered,
    /// so relative delivery order between peers is unchanged.
    async fn broadcast_per_seat<F>(
        &self,
        room_id: &str,
        except_peer: u64,
        projections: &PerFrameProjections,
        project: F,
    ) where
        F: Fn(DeliveryView, &serde_json::Value) -> Option<String>,
    {
        if let Some(peers) = self.rooms.get(room_id) {
            for entry in peers.iter() {
                if *entry.key() == except_peer {
                    continue;
                }
                let view = DeliveryView::of(entry.value().role);
                // The memoized string is cloned BEFORE the await so no RefCell
                // borrow is ever held across a socket write.
                let Some(text) =
                    projections.for_view(view, || project(view, projections.frame()))
                else {
                    continue; // this view's projection dropped the whole frame
                };
                let mut peer_session = entry.value().socket.clone();
                let _ = peer_session.text(text).await;
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

/// Recipient view classes for per-seat delta fan-out (iteration 36). Every
/// authenticated role maps onto exactly one view; all connections within a
/// view are entitled to byte-identical deltas, which is what makes per-class
/// caching sound — a projection computed once per (frame, view) can be reused
/// across every socket in that class without any seat seeing another seat's
/// data.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DeliveryView {
    /// GMs/admins: full authoritative deltas, verbatim.
    Gm,
    /// Players: hidden tokens dropped, surviving payloads reduced to
    /// board-token geometry (snapshot parity with `project_snapshot_for_role`).
    Player,
    /// Spectators: same projection as players.
    Spectator,
}

impl DeliveryView {
    fn of(role: Role) -> Self {
        if role.is_gm() {
            Self::Gm
        } else if role == Role::Spectator {
            Self::Spectator
        } else {
            Self::Player
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Gm => 0,
            Self::Player => 1,
            Self::Spectator => 2,
        }
    }
}

/// Per-frame projection cache: one instance lives for exactly ONE relayed
/// frame and memoizes each view's projected wire text the first time a peer of
/// that view asks for it. Slots are `None` until computed; the inner
/// `Option<String>` distinguishes "projected frame" (`Some(text)`) from
/// "dropped entirely for this view" (`None`).
struct PerFrameProjections {
    frame: serde_json::Value,
    slots: [std::cell::RefCell<Option<Option<String>>>; 3],
}

impl PerFrameProjections {
    fn new(frame: serde_json::Value) -> Self {
        Self {
            frame,
            slots: [
                std::cell::RefCell::new(None),
                std::cell::RefCell::new(None),
                std::cell::RefCell::new(None),
            ],
        }
    }

    /// The unprojected frame this cache was built around.
    fn frame(&self) -> &serde_json::Value {
        &self.frame
    }

    /// Returns the projected text for `view`, computing it at most once. The
    /// returned `String` is cloned out so no borrow survives the call (the
    /// caller awaits socket writes immediately after).
    fn for_view(
        &self,
        view: DeliveryView,
        compute: impl FnOnce() -> Option<String>,
    ) -> Option<String> {
        let mut slot = self.slots[view.index()].borrow_mut();
        if slot.is_none() {
            *slot = Some(compute());
        }
        slot.as_ref().and_then(|text| text.as_ref()).cloned()
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
    /// Optional rules baseline (GOALS.md Pillar 2 wizard choice). Absent =>
    /// the deployment default (`VTT_DEFAULT_RULE_VERSION`, legacy SRD 5.1).
    /// Parsed manually rather than as an enum so an unknown value yields a
    /// 422 INVALID_RULE_VERSION instead of actix's generic 400 parse error.
    #[serde(default)]
    pub rule_version: Option<String>,
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
    // Validate BEFORE creating anything: a rejected create must not leave a
    // half-initialized table behind.
    let rule_version = match req.rule_version.as_deref() {
        None => data.default_rule_version,
        Some(raw) => match RuleVersion::parse(raw.trim()) {
            Ok(v) => v,
            Err(reason) => return reject(&data, 422, "INVALID_RULE_VERSION", &reason),
        },
    };
    let session_id = Uuid::new_v4();
    data.session_owners.insert(session_id, identity.user_id.clone());
    data.session_rule_versions.insert(session_id, rule_version);
    let mut session = GameSession::new(session_id, req.campaign_id, req.session_name.clone());
    session.ledger.append_event(
        session_id,
        req.campaign_id,
        Uuid::nil(),
        "SESSION_CREATED",
        serde_json::json!({"name": req.session_name, "rule_version": rule_version.as_str()}),
    );
    data.sessions.insert(session_id, Arc::new(RwLock::new(session)));

    HttpResponse::Ok().json(serde_json::json!({
        "session_id": session_id,
        "campaign_id": req.campaign_id,
        "session_name": req.session_name,
        "rule_version": rule_version.as_str(),
        "status": "created"
    }))
}

async fn get_session(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    identity: AuthIdentity,
) -> impl Responder {
    let session_id = path.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let session = session_lock.read();
        // AUDIT (MED): this route used to serialize the FULL GameSession to any
        // authenticated caller, letting spectators and non-owner players read
        // hidden NPCs' stat blocks/HP/attacks straight off HTTP even though the
        // WS initial snapshot and x-card response already projected by role.
        // Same projection here keeps all three read paths identical; entity ids
        // survive (public_board_token always emits `id`), so targeting flows
        // that need them keep working.
        let role = Role::from_identity(&identity);
        let snapshot = data.attach_rule_version(
            project_snapshot_for_role(
                serde_json::to_value(&*session).unwrap_or(serde_json::Value::Null),
                role,
                &identity.user_id,
            ),
            session_id,
        );
        HttpResponse::Ok().json(snapshot)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

/// Hydrates a FULL GameSession snapshot (as previously exported by
/// `get_session`) into live state. This is the durability bridge: the
/// orchestrator persists snapshots in PostgreSQL and pushes them back here
/// after an engine restart or when migrating rooms.
///
/// The body is parsed from raw JSON rather than typed as `GameSession` so the
/// `rule_version` preference — which lives server-side beside the session, not
/// inside the vtt-core struct — survives the persist/hydrate round trip.
async fn restore_session(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    body: web::Json<serde_json::Value>,
    identity: AuthIdentity,
) -> impl Responder {
    let session_id = path.into_inner();
    // Restoring overwrites a table wholesale — only a GM, the session's
    // recorded owner, or the gateway's server-mediated durability principal
    // (post-restart hydration) may do that.
    let role = Role::from_identity(&identity);
    let is_service_principal = identity.user_id == SERVICE_PRINCIPAL_ID;
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
    // Rule-version preference rides on the snapshot: validate it BEFORE
    // touching live state so a corrupted snapshot cannot silently re-baseline
    // a table (or smuggle an unknown edition past hydration). Absent/null keeps
    // whatever this process already believes about the table, then the
    // deployment default — matching legacy snapshots that never carried the key.
    let payload = body.into_inner();
    let rule_version = match payload.get("rule_version") {
        None | Some(serde_json::Value::Null) => data.rule_version_for(session_id),
        Some(v) => match v.as_str().map(str::trim) {
            Some(raw) => match RuleVersion::parse(raw) {
                Ok(parsed) => parsed,
                Err(reason) => return reject(&data, 422, "INVALID_RULE_VERSION", &reason),
            },
            None => {
                return reject(
                    &data,
                    422,
                    "INVALID_RULE_VERSION",
                    "rule_version must be a string (\"srd_5_1\" or \"srd_5_2\")",
                )
            }
        },
    };
    let session: GameSession = match serde_json::from_value(payload) {
        Ok(s) => s,
        Err(e) => return reject(&data, 422, "MALFORMED_SNAPSHOT", &e.to_string()),
    };
    if session.session_id != session_id {
        return reject(
            &data,
            422,
            "SESSION_ID_MISMATCH",
            "snapshot session_id does not match the URL",
        );
    }
    let entity_count = session.entities.len();
    let event_count = session.ledger.events.len();
    data.session_owners.insert(session_id, identity.user_id.clone());
    data.session_rule_versions.insert(session_id, rule_version);
    data.sessions.insert(session_id, Arc::new(RwLock::new(session)));

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

    // Spawn-authority gating: GM-controlled creatures (non-player entities) are
    // board-warping content — spawning one requires a GM seat. The orchestrator
    // service principal keeps its deploy privilege (it binds `owner_player_id`
    // on behalf of authenticated players, so its spawns are owned player
    // characters by construction). Spectators never reach this point
    // (FORBIDDEN_ROLE above).
    //
    // Disclosed residual allowance: an UNOWNED player-flagged token may still
    // be spawned by any participant. It confers no authority beyond what the
    // control rules already grant (anyone non-spectator may act as an unowned
    // entity), and legacy clients rely on it.
    if !role.is_gm() && identity.user_id != SERVICE_PRINCIPAL && !entity.is_player {
        return reject(
            &data,
            403,
            "MONSTER_SPAWN_FORBIDDEN",
            "spawning GM-controlled monsters requires a GM seat",
        );
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

/// Rolls initiative for every entity on the board and opens combat. RBAC
/// matches every other session mutation (`may_mutate_session`): GMs and
/// players may start the fight, spectators may not.
async fn begin_combat(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot start combat");
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        if session.entities.is_empty() {
            return reject(
                &data,
                422,
                "COMBAT_NO_ENTITIES",
                "cannot begin combat with no entities on the board",
            );
        }
        // Same deterministic seeding convention as next_turn: derived from the
        // session id and ledger position, never client-supplied.
        let seed = session_id.as_u128() as u64 ^ (session.ledger.current_sequence << 32);
        let mut dice = DiceEngine::with_seed(seed);
        let order = session.begin_combat(&mut dice);
        HttpResponse::Ok().json(serde_json::json!({
            "status": "COMBAT_BEGAN",
            "in_combat": true,
            "round": session.combat.round,
            "turn_index": session.combat.turn_index,
            "order": order,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

/// Clears the initiative tracker and closes combat. The full serialized
/// `combat` object (with `order`) flows to clients automatically through
/// GET /sessions/{id}.
async fn end_combat(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot end combat");
    }
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();
        let rounds_fought = session.combat.round;
        let had_combat = session.combat.in_combat;
        session.end_combat();
        HttpResponse::Ok().json(serde_json::json!({
            "status": "COMBAT_ENDED",
            "had_active_combat": had_combat,
            "rounds_fought": rounds_fought,
            "in_combat": false,
            "round": 0,
            "turn_index": 0,
            "order": [],
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
    /// compendium-backed store, damage formulas are bounded by the two-tier
    /// caps inside vtt-core (MAX_SPELL_DICE_COUNT / MAX_SPELL_DIE_SIDES):
    /// overshoot within 2x is gently clamped; beyond that
    /// (`SPELL_DAMAGE_FORMULA_ABSURD`) the cast is rejected outright — and the
    /// check runs BEFORE any spell slot is spent.
    pub spell: vtt_core::SpellDefinition,
    /// Slot level to expend. Omitted/0 means "the spell's own level" (cantrips
    /// included). An explicit level BELOW the spell's level is rejected with
    /// HTTP 422 `INVALID_SLOT_LEVEL` rather than silently upgraded.
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
    // Seed policy (see `refuse_client_seed`): refused BEFORE the spell slot
    // can be spent — a rejected cast must cost nothing.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
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

        // Explicit UNDER-LEVEL slot requests are refused, never silently
        // upgraded. The spell's stats are client-authored here (until the
        // compendium store owns them), so a request like "cast Fireball
        // (level 3) with cast_level 1" is either a client bug or an attempt to
        // underpay for upcast math — both deserve a machine rejection rather
        // than a quiet `cast_level.max(spell.level)` rewrite.
        //
        // Scope: only when the caller EXPLICITLY asked for a lower slot
        // (`cast_level >= 1`). A bare `0` means "unspecified" (serde default —
        // cantrips and ordinary un-upcast casts travel that way) and keeps the
        // historical normalization to the spell's own level.
        if req.cast_level >= 1 && req.cast_level < req.spell.level {
            return reject(
                &data,
                422,
                "INVALID_SLOT_LEVEL",
                &format!(
                    "spell of level {} cannot be cast at slot {}; send cast_level >= {} or omit it",
                    req.spell.level, req.cast_level, req.spell.level
                ),
            );
        }

        // Reaction interrupt stack: an armed Counterspell fizzles the spell
        // (the slot is still spent per SRD — handled inside core).
        let counterspelled = match req.target_id {
            Some(tid) => session.consume_reaction(tid, vtt_core::ReactionType::Counterspell),
            None => false,
        };

        let spell = req.spell.clone();
        // Only the "unspecified" (0) case reaches here — explicit under-level
        // requests were rejected above. Normalize 0 up to the spell's own level
        // so cantrips and plain casts need no client-side slot math.
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
            Err(e) => {
                // A bound-hands refusal is a malformed request against the
                // caster's current state (422), not an in-fiction conflict
                // like the other spell rejections.
                if e == "CANNOT_SOMATIZE" {
                    reject(&data, 422, "CANNOT_SOMATIZE", "the caster has no free hand for the somatic component")
                } else {
                    reject(&data, 409, "SPELL_REJECTED", &e)
                }
            }
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
                if !outcome.opportunity_attacks.is_empty() {
                    // Full report: EVERY provoked attacker, not just the first.
                    body["opportunity_attacks_detail"] = serde_json::json!(
                        outcome.opportunity_attacks.iter().map(|trigger| serde_json::json!({
                            "provoked_by": trigger.attacker_id,
                            "reaction_type": "opportunity_attack",
                            "available": true,
                        })).collect::<Vec<_>>()
                    );
                    // Back-compat: old clients read the singular field, which
                    // mirrors the first detail entry.
                    let trigger = &outcome.opportunity_attacks[0];
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
    /// SRD inspiration spend (GOALS.md P5): burn this attacker's held point to
    /// buy Advantage on THIS roll. The engine decides atomically whether the
    /// point is actually consumed (a roll already advantaged or disadvantaged
    /// cancels into a straight d20 and keeps the point); a caller with no hold
    /// simply gets no edge and nothing is journalled.
    #[serde(default)]
    pub spend_inspiration: bool,
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
    // Seed policy (see `refuse_client_seed`): a pinned seed is a determinism
    // opt-in for privileged principals only, and it must be refused BEFORE any
    // validation side effect (Action spend, ledger append) can occur.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
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

        // Spatial edges: condition-derived adv/dis + cover from the session
        // map, plus the optional SRD inspiration spend computed ATOMICALLY with
        // the edge decision (so an SRD cancellation never wastes a point).
        // The spend lands on this scratch copy only; it is persisted to the
        // live entity and journalled further down, after every rejection gate
        // has passed — a refused attack must not burn a held point.
        let mut attacker = attacker;
        let distance = attacker.distance_to_feet(&target);
        let (attacker_z, target_z) = (attacker.position.2, target.position.2);
        let (advantage, disadvantage, inspiration_spent) =
            RulesEvaluator::edge_from_conditions_with_inspiration(
                &mut attacker,
                &target,
                distance,
                attacker_z,
                target_z,
                req.spend_inspiration,
            );

        let grid = build_collision_grid(&session.map);
        let attacker_pos = Vector3::new(attacker.position.0, attacker.position.1, attacker.position.2);
        let target_pos = Vector3::new(target.position.0, target.position.1, target.position.2);
        let half_cell = session.map.cell_size_feet / 2.0;

        // LOS / total-cover rejections happen BEFORE the Help promise is
        // touched: a refused attack must not permanently burn an ally's
        // standing Advantage (mirrors the off-hand route's ordering).
        //
        // Lighting-aware: the attacker's SRD vision mode (darkvision,
        // blindsight, truesight) is evaluated against the session map's
        // per-cell lighting zones. Maps without declared zones are Bright
        // everywhere, so this reproduces the old wall-only behavior exactly.
        let (attacker_vision_mode, attacker_sense_range, attacker_is_blinded) = {
            let a = session
                .entities
                .get(&req.attacker_id)
                .expect("checked above");
            (
                a.effective_vision_mode(),
                a.effective_sense_range_feet(),
                a.is_blinded(),
            )
        };
        let lighting = build_lighting_overlay(&session.map);
        if !grid.has_line_of_sight_for_viewer(
            &lighting,
            attacker_vision_mode,
            attacker_sense_range,
            attacker_is_blinded,
            &attacker_pos,
            &target_pos,
        ) {
            return reject(
                &data,
                409,
                "NO_LINE_OF_SIGHT",
                "walls fully occlude the attack line or the target lies in lighting the attacker cannot see through",
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

        // SRD Help: an ally's standing promise grants Advantage on THIS attack
        // roll and is consumed exactly once. A hostile attacker never benefits
        // (consume_help_advantage checks side parity) and leaves it standing.
        let help_advantage = session.consume_help_advantage(req.attacker_id, req.target_id);
        let advantage = advantage || (help_advantage && !disadvantage);

        // The inspiration ask survived every rejection gate: persist the burn
        // to the live entity and journal exactly ONE spend event so a safety
        // rewind past this roll restores the point.
        if inspiration_spent {
            if let Some(a) = session.entities.get_mut(&req.attacker_id) {
                a.inspiration = false;
            }
            let campaign_id = session.campaign_id;
            session.ledger.append_event(
                session_id,
                campaign_id,
                req.attacker_id,
                "INSPIRATION_CHANGED",
                serde_json::json!({
                    "granted": false,
                    "reason": "spent",
                }),
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
                body["help_advantage_consumed"] = serde_json::json!(help_advantage);
                body["inspiration_consumed"] = serde_json::json!(inspiration_spent);
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

// --- Grapple & Shove (contested melee alternatives) ---------------------------
//
// SRD 5e melee attack alternatives that replace one attack with a contested
// ability check. Both reuse the attack contract wholesale: ids-only payloads
// (`deny_unknown_fields` makes smuggled client math structurally impossible),
// server-side stats only, session dice seeded like every other combat action,
// Action-budget spend, ledger events, and attack-identical RBAC
// (`may_mutate_session` + `may_control_entity`).

/// The defender's choice of contested skill for a grapple (SRD: Athletics or
/// Acrobatics). Mapped server-side to Str / Dex ability modifiers — stat
/// blocks carry no per-skill proficiency bonuses in this engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DefenderSkill {
    #[serde(rename = "athletics")]
    Athletics,
    #[serde(rename = "acrobatics")]
    Acrobatics,
}

impl DefenderSkill {
    fn ability(self) -> Ability {
        match self {
            DefenderSkill::Athletics => Ability::Strength,
            DefenderSkill::Acrobatics => Ability::Dexterity,
        }
    }
}

/// The caller-chosen effect of a successful shove.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShoveEffectChoice {
    #[serde(rename = "prone")]
    Prone,
    #[serde(rename = "push_5ft")]
    Push5Feet,
}

impl From<ShoveEffectChoice> for vtt_core::actions::ShoveEffect {
    fn from(choice: ShoveEffectChoice) -> Self {
        match choice {
            ShoveEffectChoice::Prone => vtt_core::actions::ShoveEffect::Prone,
            ShoveEffectChoice::Push5Feet => vtt_core::actions::ShoveEffect::Push5Feet,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrappleActionReq {
    pub attacker_id: Uuid,
    pub defender_id: Uuid,
    /// Defender's choice of contested skill ("athletics" | "acrobatics").
    pub defender_skill: DefenderSkill,
    /// Optional deterministic seed pinning the rolls (engine decides meaning).
    #[serde(default)]
    pub seed: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShoveActionReq {
    pub attacker_id: Uuid,
    pub defender_id: Uuid,
    /// Chosen effect on success ("prone" | "push_5ft").
    pub shove_effect: ShoveEffectChoice,
    /// Ledge convention (SRD edge case): when set alongside `push_5ft`, a
    /// WON shove sends the defender over the edge instead of sliding them 5
    /// ft along the deck — the defender resolves a full tactical fall to this
    /// elevation (damage, Prone, massive-damage death) via the same
    /// FALL_RESOLVED ledger event as /action/fall. Requires a downward drop;
    /// meaningless with the `prone` effect (rejected).
    #[serde(default)]
    pub ledge_target_z: Option<f32>,
    #[serde(default)]
    pub seed: Option<u64>,
}

/// Melee reach for grapple/shove contests (SRD 5 ft; no reach weapons modelled).
const CONTEST_REACH_FEET: f32 = 5.0;

/// Small rejection record so the shared validator's `Err` variant stays tiny
/// (clippy result_large_err) — callers render it through `reject`.
struct ContestRejection {
    status: u16,
    code: &'static str,
    detail: &'static str,
}

impl ContestRejection {
    fn render(self, data: &AppState) -> HttpResponse {
        reject(data, self.status, self.code, self.detail)
    }
}

/// Shared validation + roll plumbing for both contest endpoints.
///
/// Returns `(attacker_snapshot, defender_snapshot, attacker_athletics_mod)`
/// once every gate passes; the caller then spends the Action and rolls.
fn validate_contest(
    session: &GameSession,
    role: Role,
    user_id: &str,
    attacker_id: Uuid,
    defender_id: Uuid,
) -> Result<(EntityState, EntityState, i32), ContestRejection> {
    let attacker = match session.entities.get(&attacker_id) {
        Some(a) => a.clone(),
        None => {
            return Err(ContestRejection {
                status: 404,
                code: "ATTACKER_NOT_FOUND",
                detail: "attacker_id does not exist in this session",
            })
        }
    };
    if !may_control_entity(attacker.owner_player_id.as_ref(), role, user_id) {
        return Err(ContestRejection {
            status: 403,
            code: "ENTITY_NOT_OWNED",
            detail: "you do not control the attacking entity",
        });
    }
    let defender = match session.entities.get(&defender_id) {
        Some(t) => t.clone(),
        None => {
            return Err(ContestRejection {
                status: 404,
                code: "DEFENDER_NOT_FOUND",
                detail: "defender_id does not exist in this session",
            })
        }
    };

    if !attacker.can_act() {
        return Err(ContestRejection {
            status: 409,
            code: "ENTITY_CANNOT_ACT",
            detail: "attacker is unconscious, dead, or incapacitated",
        });
    }
    if defender.is_dead {
        return Err(ContestRejection {
            status: 409,
            code: "TARGET_ALREADY_DEAD",
            detail: "defender has expired",
        });
    }
    if attacker.id == defender.id {
        return Err(ContestRejection {
            status: 422,
            code: "SELF_TARGET_INVALID",
            detail: "attacker and defender coincide",
        });
    }
    // Checked now, spent only after every other gate passes — an illegal
    // contest must not consume the turn.
    if !attacker.action_budget.action {
        return Err(ContestRejection {
            status: 409,
            code: "ACTION_ECONOMY_EXHAUSTED",
            detail: "the attacker has already used their Action this turn",
        });
    }
    let distance = attacker.distance_to_feet(&defender);
    if distance > CONTEST_REACH_FEET {
        return Err(ContestRejection {
            status: 409,
            code: "OUT_OF_REACH",
            detail: "grapple and shove require the target within 5 ft",
        });
    }

    // Athletics is keyed off Strength; the defender's skill choice maps to
    // Str or Dex at the call site (stat blocks carry no per-skill proficiencies).
    let attacker_mod = attacker.abilities.modifier(Ability::Strength);
    Ok((attacker, defender, attacker_mod))
}


async fn resolve_grapple_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<GrappleActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    // Seed policy (see `refuse_client_seed`): refused BEFORE any validation
    // side effect (Action spend, ledger append) can occur.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        let (attacker, defender, attacker_mod) =
            match validate_contest(
                &session,
                role,
                &identity.user_id,
                req.attacker_id,
                req.defender_id,
            ) {
                Ok(v) => v,
                Err(rejection) => return rejection.render(&data),
            };
        let defender_mod = defender.abilities.modifier(req.defender_skill.ability());

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
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);
        let attacker_roll = dice.roll_d20();
        let defender_roll = dice.roll_d20();

        let resolution =
            ActionResolver::resolve_grapple(attacker_roll, attacker_mod, defender_roll, defender_mod);

        let campaign_id = session.campaign_id;
        if let Some(condition) = resolution.applied_condition {
            if let Some(t) = session.entities.get_mut(&req.defender_id) {
                t.add_condition(condition);
            }
            // Bound-hands model: a WON grapple keeps one of the grappler's
            // hands busy (SRD: the creature has a hand occupied by the hold).
            // Saturating, so a second won grapple cannot phantom-bind a third
            // hand; the live release path is /action/escape-grapple below (and
            // the x-card rewind replay for reverted events).
            if let Some(a) = session.entities.get_mut(&req.attacker_id) {
                a.occupy_hand();
            }
            // Stamp the hold attribution (audit F-A4#3): the defender now
            // carries a Grappled condition GRANTED BY this attacker, so only
            // an escape naming THIS attacker may end it and free the hand.
            session.record_hold(req.defender_id, req.attacker_id);
        }

        let escape_dc = ActionResolver::grapple_escape_dc(attacker_mod);
        let payload = serde_json::json!({
            "attacker_id": req.attacker_id.to_string(),
            "defender_id": req.defender_id.to_string(),
            "attacker_natural_roll": attacker_roll,
            "attacker_total": attacker_roll + attacker_mod,
            "defender_natural_roll": defender_roll,
            "defender_total": defender_roll + defender_mod,
            "defender_skill": req.defender_skill,
            "success": resolution.success,
            "applied_condition": resolution.applied_condition,
            "escape_dc": escape_dc,
        });
        let event = session.ledger.append_event(
            session_id,
            campaign_id,
            req.attacker_id,
            "GRAPPLE_ATTEMPTED",
            payload.clone(),
        );

        data.count_valid();
        let mut body = payload;
        body["contest"] = serde_json::to_value(resolution.contest).unwrap_or_default();
        body["winner_side"] = serde_json::json!(resolution.contest.winner_side);
        body["margin"] = serde_json::json!(resolution.contest.margin);
        body["distance_feet"] = serde_json::json!(attacker.distance_to_feet(&defender));
        body["event_sequence"] = serde_json::json!(event.sequence_id);
        HttpResponse::Ok().json(body)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

/// SRD escape from a grapple: the grappled creature spends its Action on an
/// Athletics or Acrobatics check against DC 8 + the grappler's Strength
/// modifier ([`ActionResolver::grapple_escape_dc`]). Winning ends the hold on
/// BOTH sides of it — the victim's `Condition::Grappled` is stripped and the
/// grappler's occupied hand is released through the existing
/// `EntityState::release_hand` path (iteration 41 bound hands but had no live
/// release; this route is that release).
///
/// DISCLOSED LIMITATION (bound-hands, weapon wielding): this engine has no
/// equip/wield pipeline — attacks reference indexes into `EntityState.attacks`
/// and `InventoryManager.is_equipped` is never read mechanically — so weapons,
/// shields, and two-weapon off-hands do NOT occupy hands anywhere. The only
/// writers of `hands_occupied` today are won grapples (the `/action/grapple`
/// route) and their undoings (this route + x-card rewind replay). Wiring a
/// future equip route must call `occupy_hand`/`release_hand` alongside it, and
/// the somatic gate in `RulesEvaluator::validate_and_cast_spell` already
/// enforces the free-hand check those writers must respect.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EscapeGrappleReq {
    /// The currently-grappled creature attempting to break out.
    pub entity_id: Uuid,
    /// The creature whose hold is being escaped (its STR sets the DC).
    pub grappler_id: Uuid,
    /// Escaper's choice of skill ("athletics" | "acrobatics").
    pub skill: DefenderSkill,
    /// GM/service override (Pillar 11): skip the check entirely and end the
    /// hold. Privileged principals only — see the handler's RBAC gate.
    #[serde(default)]
    pub force: Option<bool>,
    /// Optional deterministic seed pinning the roll (engine decides meaning).
    #[serde(default)]
    pub seed: Option<u64>,
}

async fn resolve_escape_grapple_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<EscapeGrappleReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    // Seed policy (see `refuse_client_seed`): refused BEFORE any validation
    // side effect (Action spend, ledger append) can occur.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }
    let force = req.force.unwrap_or(false);
    if force && !role.is_gm() && identity.user_id != SERVICE_PRINCIPAL_ID {
        return reject(
            &data,
            403,
            "ESCAPE_OVERRIDE_FORBIDDEN",
            "forcing an escape without a check is a GM/service override only",
        );
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        let (escapee, grappler) = match (
            session.entities.get(&req.entity_id),
            session.entities.get(&req.grappler_id),
        ) {
            (Some(e), Some(g)) => (e.clone(), g.clone()),
            (None, _) => {
                return reject(
                    &data,
                    404,
                    "ENTITY_NOT_FOUND",
                    "entity_id does not exist in this session",
                )
            }
            (_, None) => {
                return reject(
                    &data,
                    404,
                    "GRAPPLER_NOT_FOUND",
                    "grappler_id does not exist in this session",
                )
            }
        };
        if !may_control_entity(escapee.owner_player_id.as_ref(), role, &identity.user_id) {
            return reject(
                &data,
                403,
                "ENTITY_NOT_OWNED",
                "you do not control the escaping entity",
            );
        }
        if escapee.id == grappler.id {
            return reject(
                &data,
                422,
                "SELF_TARGET_INVALID",
                "an entity cannot escape its own hold",
            );
        }
        if !escapee.can_act() {
            return reject(
                &data,
                409,
                "ENTITY_CANNOT_ACT",
                "escaper is unconscious, dead, or incapacitated",
            );
        }
        // No reach gate here ON PURPOSE: unlike a grapple ATTEMPT (which needs
        // touch), ending a hold must stay possible even when engine
        // simplifications have let the pair drift past 5 ft — refusing would
        // strand a permanent Grappled + phantom-bound hand with no way out.
        // A non-forced escape also requires a standing hold to break.
        if !force && !escapee.has_condition(&Condition::Grappled) {
            return reject(
                &data,
                409,
                "NOT_GRAPPLED",
                "entity_id carries no Grappled condition to escape",
            );
        }

        // Attribution gate (audit F-A4#3): the escape must name the creature
        // ACTUALLY holding this escaper. Without it, naming any unrelated
        // hands-occupied bystander released the BYSTANDER's hand while the
        // true holder kept theirs — a free hand-laundering exploit. The hold's
        // attribution is stamped onto the victim at grapple-resolve time (see
        // `resolve_grapple_action`); a legacy hold with no stamp falls back to
        // the ledger: the latest surviving won GRAPPLE_ATTEMPTED naming both
        // parties. `force` overrides the CHECK, never the ATTRIBUTION.
        if !session.holds(&req.entity_id, &req.grappler_id) {
            return reject(
                &data,
                409,
                "NOT_YOUR_GRAPPLER",
                "grappler_id does not hold entity_id — escapes must name the recorded holder",
            );
        }

        // All gates passed — spend the escaper's Action now. A forced GM
        // release is an intervention, not the victim's action: no spend.
        if !force {
            if let Err(e) = session
                .entities
                .get_mut(&req.entity_id)
                .expect("checked above")
                .spend_action()
            {
                return reject(&data, 409, &e, "action budget exhausted or entity incapable");
            }
        }

        let seed = req.seed.unwrap_or_else(|| {
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);

        let escape_dc = ActionResolver::grapple_escape_dc(grappler.abilities.modifier(Ability::Strength));
        let escape_mod = escapee.abilities.modifier(req.skill.ability());
        let (natural_roll, total, success) = if force {
            // No dice for an override — the outcome is authored, not rolled.
            (None, None, true)
        } else {
            let natural = dice.roll_d20();
            let total = natural + escape_mod;
            (Some(natural), Some(total), total >= escape_dc)
        };

        // On a win the hold ends on both sides: the condition leaves the
        // escaper and the grappler's hand goes back through the saturating
        // release path (a stray release can never mint a phantom hand).
        let mut released_hands = 0u8;
        if success {
            if let Some(e) = session.entities.get_mut(&req.entity_id) {
                e.remove_condition(&Condition::Grappled);
            }
            if let Some(g) = session.entities.get_mut(&req.grappler_id) {
                if g.hands_occupied > 0 {
                    released_hands = 1;
                }
                g.release_hand();
            }
        }

        let payload = serde_json::json!({
            "entity_id": req.entity_id.to_string(),
            "grappler_id": req.grappler_id.to_string(),
            "skill": req.skill,
            "escape_dc": escape_dc,
            "natural_roll": natural_roll,
            "total": total,
            "forced": force,
            "success": success,
            "grappler_hands_released": released_hands,
        });

        let grappler_hands_after =
            session.entities.get(&req.grappler_id).map(|g| g.hands_occupied);

        // A won escape ends the attribution too, so the freed victim can be
        // re-held by someone else later without stale-stamp interference.
        if success {
            session.release_hold(req.entity_id);
        }

        let campaign_id = session.campaign_id;
        let event = session.ledger.append_event(
            session_id,
            campaign_id,
            req.entity_id,
            "GRAPPLE_ESCAPED",
            payload.clone(),
        );

        data.count_valid();
        let mut body = payload;
        body["grappler_hands_occupied"] = serde_json::json!(grappler_hands_after);
        body["event_sequence"] = serde_json::json!(event.sequence_id);
        HttpResponse::Ok().json(body)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

async fn resolve_shove_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<ShoveActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    // Seed policy (see `refuse_client_seed`): refused BEFORE any validation
    // side effect (Action spend, ledger append) can occur.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        let (attacker, defender, attacker_mod) =
            match validate_contest(
                &session,
                role,
                &identity.user_id,
                req.attacker_id,
                req.defender_id,
            ) {
                Ok(v) => v,
                Err(rejection) => return rejection.render(&data),
            };
        // The shover contests the defender's choice of Athletics/Acrobatics too
        // — same skill mapping as grapple.
        let defender_skill = if defender.abilities.modifier(Ability::Strength)
            >= defender.abilities.modifier(Ability::Dexterity)
        {
            DefenderSkill::Athletics
        } else {
            DefenderSkill::Acrobatics
        };

        // Ledge-convention gates run BEFORE the Action is spent: a malformed
        // ledge request must never consume the turn.
        if let Some(ledge_z) = req.ledge_target_z {
            if !landing_z_in_bounds(ledge_z) {
                return reject(
                    &data,
                    422,
                    "INVALID_LEDGE_Z",
                    &format!(
                        "ledge_target_z must be a finite elevation between {MIN_LANDING_Z_FEET} and {MAX_LANDING_Z_FEET} feet (got {})",
                        ledge_z
                    ),
                );
            }
            if req.shove_effect != ShoveEffectChoice::Push5Feet {
                return reject(
                    &data,
                    422,
                    "LEDGE_REQUIRES_PUSH",
                    "ledge_target_z only applies to the push_5ft effect",
                );
            }
            if defender.position.2 - ledge_z <= 0.0 {
                return reject(
                    &data,
                    422,
                    "NO_DOWNWARD_DROP",
                    "the ledge must sit below the defender",
                );
            }
        }
        let defender_mod = defender.abilities.modifier(defender_skill.ability());

        if let Err(e) = session
            .entities
            .get_mut(&req.attacker_id)
            .expect("checked above")
            .spend_action()
        {
            return reject(&data, 409, &e, "action budget exhausted or entity incapable");
        }

        let seed = req.seed.unwrap_or_else(|| {
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);
        let attacker_roll = dice.roll_d20();
        let defender_roll = dice.roll_d20();

        let effect: vtt_core::actions::ShoveEffect = req.shove_effect.into();
        let resolution = ActionResolver::resolve_shove(
            attacker_roll,
            attacker_mod,
            defender_roll,
            defender_mod,
            effect,
        );

        let campaign_id = session.campaign_id;
        // Positional provenance for a successful push: recorded in the ledger
        // event below so `safety_rewind` can undo the displacement, and used
        // to refresh the WS movement baseline (see resolve_clamped_push docs
        // for the blocked-push design decision).
        let mut pushed_from: Option<(f32, f32, f32)> = None;
        let mut pushed_to: Option<(f32, f32, f32)> = None;
        let mut push_distance_feet = 0.0f32;
        let mut ledge_fall_payload: Option<serde_json::Value> = None;
        // Ledge convention: set when a won push carried the defender over the
        // requested ledge and a fall resolved on top of the displacement.
        let mut ledge_fall: Option<vtt_core::actions::FallResolution> = None;

        if let Some(condition) = resolution.applied_condition {
            if let Some(t) = session.entities.get_mut(&req.defender_id) {
                t.add_condition(condition);
            }
        } else if resolution.success && effect == vtt_core::actions::ShoveEffect::Push5Feet {
            // Push 5 ft directly away from the shover along their connecting
            // line, clamped cell-by-cell against solid cells and map bounds.
            let (from, mut to, moved) =
                resolve_clamped_push(&session.map, attacker.position, defender.position);
            if moved > 0.0 {
                if let Some(ledge_z) = req.ledge_target_z {
                    // Ledge convention: the push goes OVER the edge instead of
                    // along the deck — same 5 ft of horizontal travel, then a
                    // full tactical fall to the ledge floor. Only a shove that
                    // actually displaces the defender can carry them off; a
                    // fully wall-blocked push leaves them standing.
                    if let Ok(fall) = ActionResolver::resolve_fall(
                        defender.position.2,
                        ledge_z,
                        vtt_core::actions::LandingSurface::Normal,
                        &mut dice,
                        defender.current_hp,
                        defender.max_hp,
                        None,
                    ) {
                        to = (to.0, to.1, ledge_z);
                        ledge_fall = Some(fall);
                    }
                }
            }
            if let Some(t) = session.entities.get_mut(&req.defender_id) {
                t.position = to;
                if let Some(fall) = &ledge_fall {
                    t.current_hp = fall.hp_remaining;
                    t.is_conscious = fall.is_conscious;
                    t.is_dead = fall.instant_death;
                    if fall.knocked_prone {
                        t.add_condition(Condition::Prone);
                    }
                }
            }
            // Keep the WS relay's movement baseline consistent: the token was
            // displaced engine-side, so the next TokenTransform update must be
            // speed-checked from where the shove LEFT it, not from a stale
            // pre-shove origin.
            data.movement
                .entry(session_id.to_string())
                .or_default()
                .insert(fnv1a_hash(&defender.name), (to.0, to.1));
            pushed_from = Some(from);
            pushed_to = Some(to);
            push_distance_feet = moved;

            // The fall is its OWN ledger event so a rewind past either record
            // undoes exactly its half of the story (the SHOVE_ATTEMPTED seeds
            // the landing position via `pushed_to`; FALL_RESOLVED replays HP,
            // consciousness and Prone).
            if let Some(fall) = &ledge_fall {
                let fall_payload = serde_json::json!({
                    "entity_id": req.defender_id.to_string(),
                    "dropped_from": [from.0, from.1, defender.position.2],
                    "landed_at": [to.0, to.1, to.2],
                    "drop_feet": fall.drop_feet,
                    "surface": "normal",
                    "outcome": fall.outcome,
                    "raw_damage": fall.raw_damage,
                    "damage_taken": fall.damage_taken,
                    "knocked_prone": fall.knocked_prone,
                    "hp_before": defender.current_hp,
                    "hp_remaining": fall.hp_remaining,
                    "instant_death": fall.instant_death,
                });
                session.ledger.append_event(
                    session_id,
                    campaign_id,
                    req.defender_id,
                    "FALL_RESOLVED",
                    fall_payload.clone(),
                );
                ledge_fall_payload = Some(fall_payload);
            }
        }

        let mut payload = serde_json::json!({
            "attacker_id": req.attacker_id.to_string(),
            "defender_id": req.defender_id.to_string(),
            "attacker_natural_roll": attacker_roll,
            "attacker_total": attacker_roll + attacker_mod,
            "defender_natural_roll": defender_roll,
            "defender_total": defender_roll + defender_mod,
            "defender_skill": defender_skill,
            "shove_effect": req.shove_effect,
            "success": resolution.success,
            "applied_condition": resolution.applied_condition,
        });
        if let (Some(from), Some(to)) = (pushed_from, pushed_to) {
            payload["pushed_from"] =
                serde_json::json!([from.0, from.1, from.2]);
            payload["pushed_to"] = serde_json::json!([to.0, to.1, to.2]);
        }
        payload["push_distance_feet"] = serde_json::json!(push_distance_feet);
        let event = session.ledger.append_event(
            session_id,
            campaign_id,
            req.attacker_id,
            "SHOVE_ATTEMPTED",
            payload.clone(),
        );

        data.count_valid();
        let mut body = payload;
        body["contest"] = serde_json::to_value(resolution.contest).unwrap_or_default();
        body["winner_side"] = serde_json::json!(resolution.contest.winner_side);
        body["margin"] = serde_json::json!(resolution.contest.margin);
        body["effect"] = serde_json::json!(req.shove_effect);
        if let Some(fall_payload) = ledge_fall_payload {
            body["fall"] = fall_payload;
        }
        body["distance_feet"] = serde_json::json!(attacker.distance_to_feet(&defender));
        body["event_sequence"] = serde_json::json!(event.sequence_id);
        HttpResponse::Ok().json(body)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}


// --- Tactical falls (PILLAR-3 gap) --------------------------------------------
//
// Gravity is not an action: a creature that goes off a ledge (knocked off,
// shoved off, or voluntarily stepping down) falls NOW. The route models the
// resolution only — the caller (or the shove push below) supplies the landing
// elevation. Contract mirrors the grapple/shove endpoints: ids-only payload
// (`deny_unknown_fields`), server-measured geometry only, session-scoped
// deterministic seed, ledger event for rewind.
//
// Disclosed approximations:
// - the vertical descent is charged against the movement budget (SRD leaves
//   falling free; charging it keeps the budget meaningful without inventing
//   an extra resource) — but no Action is ever spent by gravity;
// - the DC 15 Acrobatics land-on-your-feet check is supplied as a save total
//   (stat blocks carry no proficiency bonuses), not rolled here.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FallActionReq {
    /// The creature going over the edge.
    pub entity_id: Uuid,
    /// Landing elevation in feet (may be negative — pits below ground level).
    pub target_z: f32,
    /// Landing surface ("normal" | "soft"). Absent = normal ground.
    #[serde(default)]
    pub surface: FallSurfaceChoice,
    /// Optional client-declared drop distance. The engine measures the fall
    /// from authoritative positions; a declaration that disagrees with the
    /// board by more than half a foot is refused (DROP_MISMATCH) rather than
    /// trusted — same trust model as refusing smuggled attack math.
    #[serde(default)]
    pub declared_drop_feet: Option<f32>,
    /// Total of a DC 15 Acrobatics check to land on your feet. Absent = no
    /// check attempted (prone on any 10 ft+ landing).
    #[serde(default)]
    pub acrobatics_total: Option<i32>,
    /// Optional deterministic seed pinning the damage roll.
    #[serde(default)]
    pub seed: Option<u64>,
}

/// Caller-chosen landing surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallSurfaceChoice {
    #[default]
    Normal,
    Soft,
}

impl From<FallSurfaceChoice> for vtt_core::actions::LandingSurface {
    fn from(choice: FallSurfaceChoice) -> Self {
        match choice {
            FallSurfaceChoice::Normal => vtt_core::actions::LandingSurface::Normal,
            FallSurfaceChoice::Soft => vtt_core::actions::LandingSurface::Soft,
        }
    }
}

async fn resolve_fall_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<FallActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    // Seed policy (see `refuse_client_seed`): refused BEFORE any validation
    // side effect (movement spend, ledger append) can occur.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        let faller = match session.entities.get(&req.entity_id) {
            Some(e) => e.clone(),
            None => {
                return reject(
                    &data,
                    404,
                    "ENTITY_NOT_FOUND",
                    "entity_id does not exist in this session",
                )
            }
        };
        if !may_control_entity(faller.owner_player_id.as_ref(), role, &identity.user_id) {
            return reject(
                &data,
                403,
                "ENTITY_NOT_OWNED",
                "you do not control the falling entity",
            );
        }
        if !faller.position.0.is_finite()
            || !faller.position.1.is_finite()
            || !faller.position.2.is_finite()
        {
            return reject(
                &data,
                422,
                "NON_FINITE_POSITION",
                "the entity's stored position is not finite",
            );
        }

        if !landing_z_in_bounds(req.target_z) {
            // Off-map landings are refused, not resolved: a target_z of
            // -10000 used to come back as a guaranteed instant death (audit
            // F-A4#6). Pits below ground stay legal inside the bounded stack.
            return reject(
                &data,
                422,
                "INVALID_TARGET_Z",
                &format!(
                    "target_z must be a finite elevation between {MIN_LANDING_Z_FEET} and {MAX_LANDING_Z_FEET} feet (got {})",
                    req.target_z
                ),
            );
        }

        let seed = req.seed.unwrap_or_else(|| {
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);
        // Resolve FIRST (pure math, no state touched yet): a rejected fall
        // must leave neither HP scars nor ledger records behind.
        let surface: vtt_core::actions::LandingSurface = req.surface.into();
        let resolution = ActionResolver::resolve_fall(
            faller.position.2,
            req.target_z,
            surface,
            &mut dice,
            faller.current_hp,
            faller.max_hp,
            req.acrobatics_total,
        );
        let resolution = match resolution {
            Ok(r) => r,
            Err(code @ ("NON_FINITE_ELEVATION" | "NO_DOWNWARD_DROP")) => {
                return reject(&data, 422, code, "not a legal downward fall")
            }
            Err(other) => return reject(&data, 422, other, "fall rejected"),
        };
        if let Some(declared) = req.declared_drop_feet {
            if !declared.is_finite() || (declared - resolution.drop_feet).abs() > 0.5 {
                return reject(
                    &data,
                    422,
                    "DROP_MISMATCH",
                    "declared_drop_feet disagrees with the board-measured fall",
                );
            }
        }

        // Movement cost AFTER every gate passes: the vertical drop comes out
        // of the speed budget, clamped at zero (a long fall can exceed a
        // turn's movement; the fall still happens — gravity does not stop).
        if let Some(entity) = session.entities.get_mut(&req.entity_id) {
            entity.action_budget.movement_remaining_feet = (entity
                .action_budget
                .movement_remaining_feet
                - resolution.drop_feet)
                .max(0.0);
            entity.position = (faller.position.0, faller.position.1, req.target_z);
            if resolution.instant_death {
                entity.current_hp = 0;
                entity.is_conscious = false;
                entity.is_dead = true;
            } else {
                entity.current_hp = resolution.hp_remaining;
                entity.is_conscious = resolution.is_conscious;
                if resolution.knocked_prone {
                    entity.add_condition(Condition::Prone);
                }
            }
        }

        let campaign_id = session.campaign_id;
        let payload = serde_json::json!({
            "entity_id": req.entity_id.to_string(),
            "dropped_from": [faller.position.0, faller.position.1, faller.position.2],
            "landed_at": [faller.position.0, faller.position.1, req.target_z],
            "drop_feet": resolution.drop_feet,
            "surface": req.surface,
            "outcome": resolution.outcome,
            "raw_damage": resolution.raw_damage,
            "damage_taken": resolution.damage_taken,
            "knocked_prone": resolution.knocked_prone,
            "hp_before": faller.current_hp,
            "hp_remaining": resolution.hp_remaining,
            "instant_death": resolution.instant_death,
        });
        let event =
            session
                .ledger
                .append_event(session_id, campaign_id, req.entity_id, "FALL_RESOLVED", payload.clone());

        data.count_valid();
        let mut body = payload;
        body["is_conscious"] = serde_json::json!(resolution.is_conscious);
        body["event_sequence"] = serde_json::json!(event.sequence_id);
        HttpResponse::Ok().json(body)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Dodge / Dash / Disengage / Stabilize (standard action options) -----------
//
// SRD 5e standard action alternatives, following the grapple/shove contract
// wholesale: ids-only payloads (`deny_unknown_fields` makes smuggled client
// math structurally impossible), server-side stats only, attack-identical RBAC
// (`may_mutate_session` + `may_control_entity`), Action-budget spend AFTER all
// validation passes (a rejected action must never consume the turn), and one
// ledger event per resolution.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimpleActionReq {
    pub entity_id: Uuid,
}

/// Which standard action a shared handler should perform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StandardAction {
    Dodge,
    Dash,
    Disengage,
}

impl StandardAction {
    fn ledger_event(self) -> &'static str {
        match self {
            StandardAction::Dodge => "DODGE",
            StandardAction::Dash => "DASH",
            StandardAction::Disengage => "DISENGAGE_TAKEN",
        }
    }

    fn status(self) -> &'static str {
        match self {
            StandardAction::Dodge => "DODGE_TAKEN",
            StandardAction::Dash => "DASH_TAKEN",
            StandardAction::Disengage => "DISENGAGE_TAKEN",
        }
    }
}

/// Rejection from the standard-action path: same shape as [`ContestRejection`]
/// but the code comes from core's dynamic error strings.
struct StandardActionRejection {
    status: u16,
    code: String,
    detail: &'static str,
}

impl StandardActionRejection {
    fn render(self, data: &AppState) -> HttpResponse {
        reject(data, self.status, &self.code, self.detail)
    }
}

/// Shared plumbing for Dodge / Dash / Disengage: RBAC, entity lookup and the
/// core action-economy enforcement point ([`EntityState`] spends its own
/// Action). Returns the post-action entity snapshot for the response body.
fn perform_standard_action(
    session: &mut GameSession,
    role: Role,
    user_id: &str,
    entity_id: Uuid,
    action: StandardAction,
) -> Result<serde_json::Value, StandardActionRejection> {
    let owner = session.entities.get(&entity_id).and_then(|e| e.owner_player_id.clone());
    if !may_control_entity(owner.as_ref(), role, user_id) {
        return Err(StandardActionRejection {
            status: 403,
            code: "ENTITY_NOT_OWNED".to_string(),
            detail: "you do not control this entity",
        });
    }

    // Core rejects with ENTITY_CANNOT_ACT / ACTION_ECONOMY_EXHAUSTED /
    // DASH_ALREADY_TAKEN — surfaced verbatim as 409 codes.
    let result = match session.entities.get_mut(&entity_id) {
        None => {
            return Err(StandardActionRejection {
                status: 404,
                code: "ENTITY_NOT_FOUND".to_string(),
                detail: "entity does not exist in this session",
            })
        }
        Some(entity) => match action {
            StandardAction::Dodge => entity.take_dodge(),
            StandardAction::Dash => entity.take_dash(),
            StandardAction::Disengage => entity.take_disengage(),
        },
    };
    let entity = match result {
        Ok(()) => &session.entities[&entity_id],
        Err(e) => {
            return Err(StandardActionRejection {
                status: 409,
                code: e,
                detail: "action rejected by the action economy",
            })
        }
    };

    Ok(match action {
        StandardAction::Dodge => serde_json::json!({
            "entity_id": entity_id.to_string(),
            "dodge_until_next_turn": entity.dodge_until_next_turn,
        }),
        StandardAction::Dash => serde_json::json!({
            "entity_id": entity_id.to_string(),
            "dashed_this_turn": entity.dashed_this_turn,
            "movement_remaining_feet": entity.action_budget.movement_remaining_feet,
        }),
        StandardAction::Disengage => serde_json::json!({
            "entity_id": entity_id.to_string(),
            "disengaged_until_next_turn": entity.disengaged_until_next_turn,
        }),
    })
}

macro_rules! standard_action_route {
    ($name:ident, $action:expr) => {
        async fn $name(
            data: web::Data<AppState>,
            path: web::Path<Uuid>,
            req: web::Json<SimpleActionReq>,
            identity: AuthIdentity,
        ) -> impl Responder {
            data.count_request();
            let session_id = path.into_inner();
            let role = Role::from_identity(&identity);
            if !may_mutate_session(&data, session_id, role, &identity.user_id) {
                return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
            }
            let req = req.into_inner();
            if let Some(session_lock) = data.sessions.get(&session_id) {
                let mut session = session_lock.write();
                if !session.entities.contains_key(&req.entity_id) {
                    return reject(&data, 404, "ENTITY_NOT_FOUND", "entity does not exist in session");
                }
                let payload = match perform_standard_action(
                    &mut session,
                    role,
                    &identity.user_id,
                    req.entity_id,
                    $action,
                ) {
                    Ok(p) => p,
                    Err(rejection) => return rejection.render(&data),
                };
                data.count_valid();
                let campaign_id = session.campaign_id;
                let event = session.ledger.append_event(
                    session_id,
                    campaign_id,
                    req.entity_id,
                    $action.ledger_event(),
                    payload.clone(),
                );
                let mut body = serde_json::json!({ "status": $action.status() });
                for (k, v) in payload.as_object().into_iter().flatten() {
                    body[k.clone()] = v.clone();
                }
                body["event_sequence"] = serde_json::json!(event.sequence_id);
                HttpResponse::Ok().json(body)
            } else {
                HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
            }
        }
    };
}

standard_action_route!(resolve_dodge, StandardAction::Dodge);
standard_action_route!(resolve_dash, StandardAction::Dash);
standard_action_route!(resolve_disengage, StandardAction::Disengage);

// --- Ready action --------------------------------------------------------------
//
// SRD "Ready": spend your Action to hold a triggered response ("I attack the
// goblin when it moves"). Same contract as the standard actions above —
// ids-plus-description payload with `deny_unknown_fields`, attack-identical
// RBAC (`may_mutate_session` + `may_control_entity`), Action spent only after
// every validation passes, one READY_ACTION_SET ledger event per arming.
// The engine stores/surfaces/clears the declaration; matching the trigger and
// resolving the held action stays GM adjudication (no automatic trigger
// matching in this iteration).

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyActionReq {
    pub entity_id: Uuid,
    /// What the entity is holding ("I attack the goblin").
    pub description: String,
    /// Optional declared trigger ("when it moves"), folded into the stored
    /// description for display.
    #[serde(default)]
    pub trigger_hint: Option<String>,
}

async fn resolve_ready_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<ReadyActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    let req = req.into_inner();
    if req.description.trim().is_empty() {
        return reject(
            &data,
            422,
            "EMPTY_DESCRIPTION",
            "a readied action needs a non-empty description",
        );
    }

    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // Attack-identical RBAC: spectators already rejected above; a player
        // may only ready an action FOR an entity they control.
        let owner = session
            .entities
            .get(&req.entity_id)
            .and_then(|e| e.owner_player_id.clone());
        if !session.entities.contains_key(&req.entity_id) {
            return reject(&data, 404, "ENTITY_NOT_FOUND", "entity does not exist in this session");
        }
        if !may_control_entity(owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control this entity");
        }

        // Core spends the Action and ledgers READY_ACTION_SET itself; a
        // rejection (ENTITY_CANNOT_ACT / ACTION_ECONOMY_EXHAUSTED) changes
        // nothing.
        let readied = match session.ready_action(
            req.entity_id,
            &req.description,
            req.trigger_hint.as_deref(),
        ) {
            Ok(r) => r,
            Err(e) => {
                return reject(&data, 409, &e, "action rejected by the action economy")
            }
        };
        data.count_valid();
        let event_sequence = session.ledger.current_sequence;
        HttpResponse::Ok().json(serde_json::json!({
            "status": "READY_ACTION_SET",
            "entity_id": req.entity_id.to_string(),
            "readied_action": readied,
            "event_sequence": event_sequence,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StabilizeActionReq {
    pub healer_id: Uuid,
    pub target_id: Uuid,
    /// Optional deterministic seed pinning the Medicine roll.
    #[serde(default)]
    pub seed: Option<u64>,
}

/// Melee reach for stabilize (a Medicine check requires touching the patient).
const STABILIZE_REACH_FEET: f32 = 5.0;

async fn resolve_stabilize(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<StabilizeActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    // Seed policy (see `refuse_client_seed`): refused BEFORE the healer's
    // Action can be spent.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // Healer must exist, be controllable, and be able to act.
        let healer_owner = session
            .entities
            .get(&req.healer_id)
            .and_then(|e| e.owner_player_id.clone());
        if !session.entities.contains_key(&req.healer_id) {
            return reject(&data, 404, "HEALER_NOT_FOUND", "healer_id does not exist in this session");
        }
        if !may_control_entity(healer_owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control the healer");
        }
        let target_exists = session.entities.contains_key(&req.target_id);
        if !target_exists {
            return reject(&data, 404, "TARGET_NOT_FOUND", "target_id does not exist in this session");
        }
        if req.healer_id == req.target_id {
            return reject(&data, 422, "SELF_TARGET_INVALID", "the healer cannot treat themself");
        }

        // Read-only gates BEFORE any state changes or budget spends.
        let (healer_can_act, healer_has_action, distance) = {
            let healer = &session.entities[&req.healer_id];
            let target = &session.entities[&req.target_id];
            (
                healer.can_act() && healer.action_budget.action,
                healer.action_budget.action,
                healer.distance_to_feet(target),
            )
        };
        if !healer_can_act {
            return reject(
                &data,
                409,
                if healer_has_action { "ENTITY_CANNOT_ACT" } else { "ACTION_ECONOMY_EXHAUSTED" },
                "healer is unconscious, dead, incapacitated, or out of Actions",
            );
        }
        if distance > STABILIZE_REACH_FEET {
            return reject(
                &data,
                409,
                "OUT_OF_REACH",
                "stabilizing requires the dying ally within 5 ft",
            );
        }

        // Dying-state gates on the TARGET (a rejected attempt must not burn
        // the healer's Action).
        let dying_gate = {
            let target = &session.entities[&req.target_id];
            if target.is_dead {
                Err("TARGET_ALREADY_DEAD")
            } else if target.current_hp > 0 {
                Err("TARGET_NOT_DYING")
            } else if target.death_saves.is_stabilized {
                Err("ALREADY_STABILIZED")
            } else {
                Ok(())
            }
        };
        if let Err(code) = dying_gate {
            return reject(&data, 409, code, "target is not a saveable dying creature");
        }

        // All validations passed — spend the healer's Action now.
        if let Err(e) = session
            .entities
            .get_mut(&req.healer_id)
            .expect("checked above")
            .spend_action()
        {
            return reject(&data, 409, &e, "action budget exhausted or entity incapable");
        }

        // Server-side roll + Wisdom modifier (stat blocks carry no per-skill
        // proficiency bonuses; Medicine is keyed off Wisdom in this engine).
        let medicine_mod = session.entities[&req.healer_id]
            .abilities
            .modifier(Ability::Wisdom);
        let seed = req.seed.unwrap_or_else(|| {
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);
        let natural_roll = dice.roll_d20();

        let outcome = session
            .entities
            .get_mut(&req.target_id)
            .expect("checked above")
            .stabilize_attempt(natural_roll, medicine_mod)
            .expect("gates re-verified above");

        let payload = serde_json::json!({
            "healer_id": req.healer_id.to_string(),
            "target_id": req.target_id.to_string(),
            "natural_roll": outcome.natural_roll,
            "medicine_modifier": outcome.modifier,
            "total": outcome.total,
            "dc": outcome.dc,
            "success": outcome.success,
            "successes": outcome.successes_after,
            "failures": outcome.failures_after,
            "is_stabilized": outcome.is_stabilized_after,
        });
        let campaign_id = session.campaign_id;
        let event = session.ledger.append_event(
            session_id,
            campaign_id,
            req.healer_id,
            "STABILIZE_ATTEMPTED",
            payload.clone(),
        );

        data.count_valid();
        let mut body = payload;
        body["event_sequence"] = serde_json::json!(event.sequence_id);
        HttpResponse::Ok().json(body)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}


// --- Two-Weapon Fighting (bonus-action off-hand strike) -----------------------
//
// SRD 5e: after taking the Attack action with two Light weapons, one bonus-
// action attack with the off-hand weapon — no POSITIVE ability modifier to
// its damage. Contract matches every other combat endpoint: ids-only payload
// (`deny_unknown_fields`), server-side stat blocks, seeded session dice,
// Bonus-Action spend AFTER all validation passes, one OFFHAND_ATTACK ledger
// event per resolution.
//
// DISCLOSED LIMITATION (weapon "light"): the SRD importer does not yet parse
// weapon properties out of monster text, so `light` is an explicit opt-in flag
// on each stat-block attack entry (`AttackAction::light`, serde-defaulted to
// false). This endpoint therefore enforces BOTH budget (Bonus Action) and the
// light requirement whenever the flag is present; a stat block that has not
// declared its weapons Light is refused (`*_WEAPON_NOT_LIGHT`) rather than
// silently permitted.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OffhandActionReq {
    pub attacker_id: Uuid,
    pub target_id: Uuid,
    /// Index into the attacker's stat-block attack list for the OFF-HAND
    /// weapon (the main-hand weapon is index 0, so it may not be reused here —
    /// `OFFHAND_INDEX_MATCHES_MAIN`). Server-side only.
    #[serde(default)]
    pub offhand_index: usize,
    /// Optional deterministic seed pinning the roll.
    #[serde(default)]
    pub seed: Option<u64>,
}

async fn resolve_offhand_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<OffhandActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }
    // Seed policy (see `refuse_client_seed`): refused BEFORE the Bonus Action
    // can be spent.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

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
                return reject(&data, 404, "TARGET_NOT_FOUND", "target_id does not exist in this session")
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

        // SRD Two-Weapon Fighting presupposes the Attack action was already
        // taken this turn; the engine enforces that indirectly by requiring a
        // spent Action here (a fresh turn means no Attack happened yet).
        if attacker.action_budget.action {
            return reject(
                &data,
                409,
                "ATTACK_ACTION_REQUIRED",
                "two-weapon fighting follows the Attack action, which has not been taken this turn",
            );
        }
        // Bonus Action is checked now but spent only AFTER every other gate.
        if !attacker.action_budget.bonus_action {
            return reject(
                &data,
                409,
                "BONUS_ACTION_ECONOMY_EXHAUSTED",
                "the attacker has already used their Bonus Action this turn",
            );
        }

        // Melee reach for an off-hand weapon swing.
        let distance = attacker.distance_to_feet(&target);
        if distance > CONTEST_REACH_FEET {
            return reject(&data, 409, "OUT_OF_REACH", "an off-hand strike requires the target within 5 ft");
        }

        // The off-hand weapon must be a DIFFERENT weapon than the main hand:
        // index 0 IS the main-hand entry, so accepting it would let one Light
        // weapon satisfy two-weapon fighting by itself.
        if req.offhand_index == 0 {
            return reject(
                &data,
                422,
                "OFFHAND_INDEX_MATCHES_MAIN",
                "the off-hand weapon cannot be the main-hand weapon (index 0)",
            );
        }

        // Both weapons must be Light — server-side stat blocks decide.
        let main_weapon = attacker.attack_for_index(0);
        let offhand_weapon = attacker.attack_for_index(req.offhand_index);
        if !main_weapon.light {
            return reject(
                &data,
                422,
                "MAIN_HAND_WEAPON_NOT_LIGHT",
                "two-weapon fighting requires both weapons to have the Light property",
            );
        }
        if !offhand_weapon.light {
            return reject(
                &data,
                422,
                "OFFHAND_WEAPON_NOT_LIGHT",
                "the off-hand weapon must have the Light property",
            );
        }

        // Spatial edges: condition-derived adv/dis (Help / Dodge / prone etc.
        // apply to the off-hand swing exactly like any other attack).
        let (advantage, disadvantage) = RulesEvaluator::edge_from_conditions(
            &attacker,
            &target,
            distance,
            attacker.position.2,
            target.position.2,
        );
        // A standing Help promise consumed by THIS attack grants advantage.
        let help_advantage = session.consume_help_advantage(req.attacker_id, req.target_id);
        let advantage = advantage || (help_advantage && !disadvantage);

        // All validations passed — spend the Bonus Action now.
        if let Err(e) = session
            .entities
            .get_mut(&req.attacker_id)
            .expect("checked above")
            .spend_bonus_action()
        {
            return reject(&data, 409, &e, "bonus-action budget exhausted or entity incapable");
        }

        let seed = req.seed.unwrap_or_else(|| {
            (session_id.as_u128() as u64) ^ (session.ledger.current_sequence << 32)
        });
        let mut dice = DiceEngine::with_seed(seed);

        let resolution = match ActionResolver::resolve_offhand_attack(
            &mut dice,
            &attacker,
            &target,
            &main_weapon,
            &offhand_weapon,
            target.ac,
            advantage,
            disadvantage,
        ) {
            Ok(r) => r,
            Err(e) => return reject(&data, 400, "RESOLUTION_FAILED", &e),
        };
        let result = resolution.roll;

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
            "OFFHAND_ATTACK",
            serde_json::json!({
                "attacker_id": req.attacker_id.to_string(),
                "target_id": req.target_id.to_string(),
                "natural_roll": result.natural_roll,
                "attack_roll": result.attack_roll,
                "target_ac": target.ac,
                "is_hit": result.is_hit,
                "total_damage": result.total_damage,
                "damage_expression_rolled": resolution.damage_expression_rolled,
                "ability_mod_withheld_from_damage": resolution.ability_mod_withheld_from_damage,
                "offhand_index": req.offhand_index,
            }),
        );

        let mut body = serde_json::to_value(&result).unwrap_or_default();
        body["action_name"] = serde_json::json!(offhand_weapon.name);
        body["offhand_index"] = serde_json::json!(req.offhand_index);
        body["damage_expression_rolled"] =
            serde_json::json!(resolution.damage_expression_rolled);
        body["ability_mod_withheld_from_damage"] =
            serde_json::json!(resolution.ability_mod_withheld_from_damage);
        body["help_advantage_consumed"] = serde_json::json!(help_advantage);
        body["advantage"] = serde_json::json!(advantage);
        body["disadvantage"] = serde_json::json!(disadvantage);
        body["event_sequence"] = serde_json::json!(event.sequence_id);
        HttpResponse::Ok().json(body)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}


// --- Help action ---------------------------------------------------------------
//
// SRD 5e: spend your Action to give an ally Advantage on their next attack
// roll against a creature within your reach. The promise lives ON THE TARGET
// entity (`next_attacker_has_advantage_against` naming the helper), is
// consumed by the first qualifying same-side attack (normal attacks AND the
// off-hand strike both check it), and clears at the round refresh or on a
// safety rewind past the HELP_ACTION event. Same contract as grapple/shove:
// ids-only payload, attack-identical RBAC, Action spent only after every
// validation passes, one HELP_ACTION ledger event per grant.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelpActionReq {
    pub helper_id: Uuid,
    pub target_entity_id: Uuid,
}

async fn resolve_help_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<HelpActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // Attack-identical RBAC on the HELPER.
        let owner = session
            .entities
            .get(&req.helper_id)
            .and_then(|e| e.owner_player_id.clone());
        if !session.entities.contains_key(&req.helper_id) {
            return reject(&data, 404, "ENTITY_NOT_FOUND", "helper_id does not exist in this session");
        }
        if !may_control_entity(owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control the helping entity");
        }

        // Core enforces reach, liveness, self-targeting and the action
        // economy; a rejection changes nothing.
        if let Err(e) = session.take_help(req.helper_id, req.target_entity_id) {
            let status = match e.as_str() {
                "ENTITY_NOT_FOUND" | "TARGET_NOT_FOUND" => 404u16,
                "SELF_TARGET_INVALID" => 422,
                _ => 409,
            };
            return reject(&data, status, &e, "help rejected by the rules engine");
        }

        data.count_valid();
        let event_sequence = session.ledger.current_sequence;
        HttpResponse::Ok().json(serde_json::json!({
            "status": "HELP_GRANTED",
            "helper_id": req.helper_id.to_string(),
            "target_entity_id": req.target_entity_id.to_string(),
            "next_attacker_has_advantage_against": req.helper_id.to_string(),
            "event_sequence": event_sequence,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Help action: ability check flavor -----------------------------------------
//
// SRD 5e Help aimed at an ABILITY CHECK ("I'll boost you up while you pick
// that lock"). Mirrors `/action/help` wholesale — attack-identical RBAC on the
// helper, ids-only `deny_unknown_fields` payload, Action spent only after every
// validation passes, one ledger event per grant — but delegates to
// `GameSession::take_help_check`, whose promise lives ON THE BENEFICIARY as
// `next_check_has_advantage_from` and is cashed exactly once by a session-
// grounded ability check (`/actions/check` with `session_id` + `entity_id`).
// The two currencies are deliberately distinct: an attack-help token can never
// be eaten by a check nor vice versa.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelpCheckActionReq {
    pub helper_id: Uuid,
    pub beneficiary_id: Uuid,
}

async fn resolve_help_check_action(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<HelpCheckActionReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot take actions");
    }

    let req = req.into_inner();
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        // Attack-help-identical RBAC on the HELPER.
        if !session.entities.contains_key(&req.helper_id) {
            return reject(&data, 404, "ENTITY_NOT_FOUND", "helper_id does not exist in this session");
        }
        let owner = session
            .entities
            .get(&req.helper_id)
            .and_then(|e| e.owner_player_id.clone());
        if !may_control_entity(owner.as_ref(), role, &identity.user_id) {
            return reject(&data, 403, "ENTITY_NOT_OWNED", "you do not control the helping entity");
        }

        // Core enforces reach, liveness, self-targeting and the action
        // economy; a rejection changes nothing.
        if let Err(e) = session.take_help_check(req.helper_id, req.beneficiary_id) {
            let status = match e.as_str() {
                "ENTITY_NOT_FOUND" | "TARGET_NOT_FOUND" => 404u16,
                "SELF_TARGET_INVALID" => 422,
                _ => 409,
            };
            return reject(&data, status, &e, "help-check rejected by the rules engine");
        }

        data.count_valid();
        let event_sequence = session.ledger.current_sequence;
        HttpResponse::Ok().json(serde_json::json!({
            "status": "HELP_CHECK_GRANTED",
            "helper_id": req.helper_id.to_string(),
            "beneficiary_id": req.beneficiary_id.to_string(),
            "next_check_has_advantage_from": req.helper_id.to_string(),
            "event_sequence": event_sequence,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

// --- Inspiration (GM fiat grant/revoke) ----------------------------------------
//
// SRD inspiration lives at most ONE point per character. Every accepted
// transition journals an `INSPIRATION_CHANGED` event so safety rewind replays
// the correct holding; these routes are the HTTP surfaces for the GRANT and
// REVOKE sides that make "rewind past a spend restores the point" reachable
// end-to-end.
//
// RBAC (audit F-A4#2): inspiration is GM FIAT (SRD "Inspiration"). Granting
// used to ride standard ownership RBAC, which let any PLAYER mint a point on
// their own character every round — a per-turn Advantage faucet. Both
// directions are therefore privileged-principal-only: GM/admin seats and the
// orchestrator service principal. Players RECEIVE points; they never confer
// them, not even on entities they own outright.

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspirationGrantReq {
    pub entity_id: Uuid,
    #[serde(default)]
    pub reason: Option<String>,
}

/// True when this caller may grant or revoke inspiration (GM fiat privilege):
/// GM/admin roles and the orchestrator service principal only.
fn may_fiat_inspiration(role: Role, user_id: &str) -> bool {
    role.is_gm() || user_id == SERVICE_PRINCIPAL_ID
}

/// Shared body of the grant/revoke routes once the caller passed the fiat
/// gate. `apply` performs the core transition (`grant_inspiration` /
/// `revoke_inspiration`) under the session write lock.
fn inspiration_transition(
    data: web::Data<AppState>,
    session_id: Uuid,
    req: InspirationGrantReq,
    apply: fn(&mut GameSession, Uuid, Option<&str>) -> Result<(), String>,
    ok_status: &'static str,
) -> HttpResponse {
    if let Some(session_lock) = data.sessions.get(&session_id) {
        let mut session = session_lock.write();

        if !session.entities.contains_key(&req.entity_id) {
            return reject(&data, 404, "ENTITY_NOT_FOUND", "entity_id does not exist in this session");
        }

        if let Err(e) = apply(&mut session, req.entity_id, req.reason.as_deref()) {
            let status = match e.as_str() {
                "ENTITY_NOT_FOUND" => 404u16,
                _ => 409,
            };
            return reject(
                &data,
                status,
                &e,
                "inspiration transition rejected by the rules engine",
            );
        }

        data.count_valid();
        HttpResponse::Ok().json(serde_json::json!({
            "status": ok_status,
            "entity_id": req.entity_id.to_string(),
            "event_sequence": session.ledger.current_sequence,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({"error": "Session not found"}))
    }
}

async fn grant_inspiration_route(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<InspirationGrantReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot mutate sessions");
    }
    if !may_fiat_inspiration(role, &identity.user_id) {
        return reject(
            &data,
            403,
            "INSPIRATION_GM_ONLY",
            "inspiration is granted by GM fiat only (SRD); players receive points through grants",
        );
    }
    inspiration_transition(
        data,
        session_id,
        req.into_inner(),
        GameSession::grant_inspiration,
        "INSPIRATION_GRANTED",
    )
}

async fn revoke_inspiration_route(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<InspirationGrantReq>,
    identity: AuthIdentity,
) -> impl Responder {
    data.count_request();
    let session_id = path.into_inner();
    let role = Role::from_identity(&identity);
    if !may_mutate_session(&data, session_id, role, &identity.user_id) {
        return reject(&data, 403, "FORBIDDEN_ROLE", "spectators cannot mutate sessions");
    }
    if !may_fiat_inspiration(role, &identity.user_id) {
        return reject(
            &data,
            403,
            "INSPIRATION_GM_ONLY",
            "inspiration is revoked by GM fiat only (SRD)",
        );
    }
    inspiration_transition(
        data,
        session_id,
        req.into_inner(),
        GameSession::revoke_inspiration,
        "INSPIRATION_REVOKED",
    )
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
    // Seed policy (see `refuse_client_seed`): refused BEFORE the damage is
    // applied and its concentration save rolled.
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
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

// --- Inventory container transfer (Pillar-7: capacity enforcement) -----------

/// Places an item the entity ALREADY carries into one of its containers. The
/// item is referenced by id (spawn-time inventories create items); the engine
/// decides whether it fits — the server never does inventory arithmetic.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemTransferReq {
    pub entity_id: Uuid,
    /// The item being moved; must already exist in this entity's inventory.
    pub item_id: Uuid,
    /// Destination container in the same inventory.
    pub container_id: Uuid,
}

async fn transfer_item(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    req: web::Json<ItemTransferReq>,
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

        // Where the item lives NOW, recorded in the ledger event so an X-card
        // rewind past the transfer can put it back (audit F-A4#7). Null =
        // it was loose at the root.
        let prior_placement = session
            .entities
            .get(&req.entity_id)
            .and_then(|entity| entity.inventory.items.get(&req.item_id))
            .map(|item| item.parent_container_id)
            .unwrap_or(None);

        // Engine-owned verdict: weight AND volume limits, nested contents AND
        // every ancestor's limits included. A refusal here leaves the
        // inventory untouched.
        let outcome = {
            let entity = session.entities.get_mut(&req.entity_id).expect("checked above");
            entity.inventory.reparent_item_into_container(&req.item_id, &req.container_id)
        };
        match outcome {
            Ok(()) => {
                data.count_valid();
                let campaign_id = session.campaign_id;
                session.ledger.append_event(
                    session_id,
                    campaign_id,
                    req.entity_id,
                    "ITEM_TRANSFERRED",
                    serde_json::json!({
                        "item_id": req.item_id.to_string(),
                        "container_id": req.container_id.to_string(),
                        "from_container_id": prior_placement,
                    }),
                );
                HttpResponse::Ok().json(serde_json::json!({
                    "status": "TRANSFERRED",
                    "entity_id": req.entity_id,
                    "item_id": req.item_id,
                    "container_id": req.container_id,
                    "from_container_id": prior_placement,
                }))
            }
            Err(e) => {
                // Every refusal counts exactly once against the rejection
                // metric — numeric overfills and structural refusals alike
                // (audit F-A4#9) — so count here instead of relying on the
                // shared `reject` helper in only one of the two branches.
                data.count_rejected();
                if e.violations.is_empty() {
                    // Structural refusals (unknown container / not a container /
                    // self-nesting / parent cycle): distinct codes, still a
                    // client error.
                    let status = if e.code == "ITEM_NOT_FOUND" { 404 } else { 422 };
                    HttpResponse::build(
                        actix_web::http::StatusCode::from_u16(status)
                            .unwrap_or(actix_web::http::StatusCode::BAD_REQUEST),
                    )
                    .json(serde_json::json!({"error": e.code, "detail": e.summary()}))
                } else {
                    HttpResponse::build(actix_web::http::StatusCode::UNPROCESSABLE_ENTITY)
                        .json(serde_json::json!({
                            "error": e.code,
                            "detail": e.summary(),
                            "container_id": e.container_id,
                            "violations": e.violations,
                        }))
                }
            }
        }
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
            // Short rest: no mechanical effect, and deliberately so for
            // exhaustion — SRD 5e grants NO exhaustion recovery on a short
            // rest (only hit dice / class features do). HP restoration via
            // hit-dice spending is a future hook. Ledgered so the intent is
            // auditable and rewirable.
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
            // Long rest: SRD restores hit points and sheds ONE exhaustion
            // level (not all of them). Spell slots are NOT refilled because
            // slot MAXIMA are not tracked engine-side yet; only remaining
            // counts live on EntityState.
            //
            // Ordering decision: exhaustion is shed FIRST, then HP is filled
            // to `effective_max_hp()` — i.e. the cap implied by the POST-rest
            // exhaustion level. This keeps the two SRD clauses consistent:
            // resting at level 4 lands on level 3 and returns to full max,
            // while resting at level 5 lands on level 4 and tops out at the
            // still-halved maximum. Filling first would strand HP below the
            // lifted cap until the next rest. (`set_exhaustion` inside
            // `take_long_rest_effects` also clamps current HP down to any
            // surviving cap via `enforce_exhaustion_hp_cap`, so no overfill
            // can slip through.)
            //
            // Dead entities are skipped entirely: our dead stay dead — no
            // resurrection, and therefore no exhaustion bookkeeping either
            // (SRD lets a corpse's exhaustion decay, but a dead creature has
            // nothing left to rest toward). They emit no LONG_REST_APPLIED.
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
                    let (hp_restored_to, hp_remaining, exhaustion_reduced, exhaustion_level) = {
                        let entity = session.entities.get_mut(&id).expect("checked above");
                        // Shed one level first so the refill below uses the
                        // post-rest effective maximum (see ordering note above).
                        let exhaustion_reduced = entity.take_long_rest_effects();
                        let cap = entity.effective_max_hp();
                        entity.current_hp = cap;
                        entity.temp_hp = 0;
                        entity.is_conscious = true;
                        entity.reset_death_saves_if_healed();
                        // POST-rest level, recorded on the event so a rewind
                        // replay can restore exactly this much exhaustion
                        // (events carry no pre-rest level, and conditions are
                        // not replayed — see safety_rewind).
                        let exhaustion_level = entity.exhaustion_level();
                        (cap, entity.current_hp, exhaustion_reduced, exhaustion_level)
                    };
                    session.ledger.append_event(
                        session_id,
                        campaign_id,
                        id,
                        "LONG_REST_APPLIED",
                        serde_json::json!({
                            "target_id": id.to_string(),
                            "hp_restored_to_max": hp_restored_to,
                            "hp_remaining": hp_remaining,
                            "exhaustion_reduced": exhaustion_reduced,
                            "exhaustion_level": exhaustion_level,
                        }),
                    );
                    restored.push(serde_json::json!({
                        "entity_id": id,
                        "hp_remaining": hp_remaining,
                        "exhaustion_reduced": exhaustion_reduced,
                        "exhaustion_level": exhaustion_level,
                    }));
                }

                HttpResponse::Ok().json(serde_json::json!({
                    "status": "LONG_REST_APPLIED",
                    "restored_entities": restored.len(),
                    "entities": restored,
                    "note": "spell slots are not refilled (slot maxima untracked engine-side); each long rest sheds exactly one exhaustion level",
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
    /// Determinism opt-in: pins the d20 (any value is equally valid — the
    /// engine decides what the seed means). Honored ONLY for privileged
    /// principals (GM role / orchestrator service identity) running
    /// determinism harnesses; any other caller supplying it gets 422
    /// SEED_NOT_PERMITTED rather than a silently-ignored seed. Omitted →
    /// server entropy, always.
    pub seed: Option<u64>,
    /// Session-scoped engine wiring (iteration 56): supplying BOTH pins this
    /// roll to a live engine entity. A standing Help-on-check promise held by
    /// that entity is cashed exactly once by THIS roll, and an optional SRD
    /// inspiration spend is resolved atomically with the condition edges.
    /// Omitted → the legacy stateless contract, byte-for-byte unchanged.
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub entity_id: Option<Uuid>,
    /// SRD inspiration spend (GOALS.md P5): burn the checker's held point to
    /// buy Advantage on THIS roll. The engine decides atomically whether the
    /// point is actually consumed (a disadvantaged or already-advantaged roll
    /// cancels into a straight d20 and keeps the point); no hold → no edge,
    /// nothing journalled.
    #[serde(default)]
    pub spend_inspiration: bool,
}

/// What session-grounding decided for one roll: the effective edge pair after
/// merging engine-derived edges with the caller's ask, plus the disclosure
/// flags for the response body.
struct RollGrounding {
    advantage: bool,
    disadvantage: bool,
    inspiration_consumed: bool,
    help_check_consumed: bool,
}

/// Either grounded roll inputs or the ready-to-send refusal. (A dedicated
/// enum keeps `HttpResponse` out of a `Result`'s `Err` slot — it is far larger
/// than the `Ok` payload.)
enum RollGroundingOutcome {
    Grounded(RollGrounding),
    Refused(HttpResponse),
}

/// Session-scoped grounding shared by `/actions/check` and `/actions/save`:
/// resolves `session_id` + `entity_id` against live engine state under full
/// mutation RBAC (spectators blocked, ownership enforced), then cashes any
/// standing Help-on-check promise (`check_only`) and spends inspiration
/// atomically with the condition-edge decision.
///
/// Every rejection path here happens BEFORE any state change: an illegal
/// request must not cash a token, burn a point, or journal anything.
fn ground_roll_in_session(
    data: &AppState,
    identity: &AuthIdentity,
    session_id: Uuid,
    entity_id: Uuid,
    spend_inspiration: bool,
    check_only: bool,
) -> RollGroundingOutcome {
    let role = Role::from_identity(identity);
    if !may_mutate_session(data, session_id, role, &identity.user_id) {
        return RollGroundingOutcome::Refused(reject(
            data,
            403,
            "FORBIDDEN_ROLE",
            "spectators cannot ground a roll in session state",
        ));
    }
    let Some(session_lock) = data.sessions.get(&session_id) else {
        return RollGroundingOutcome::Refused(reject(
            data,
            404,
            "SESSION_NOT_FOUND",
            "session_id does not exist",
        ));
    };
    let mut session = session_lock.write();

    let entity = match session.entities.get(&entity_id) {
        Some(e) => e.clone(),
        None => {
            return RollGroundingOutcome::Refused(reject(
                data,
                404,
                "ENTITY_NOT_FOUND",
                "entity_id does not exist in this session",
            ))
        }
    };
    if !may_control_entity(entity.owner_player_id.as_ref(), role, &identity.user_id) {
        return RollGroundingOutcome::Refused(reject(
            data,
            403,
            "ENTITY_NOT_OWNED",
            "you do not control this entity",
        ));
    }

    // Cash the standing Help-on-check promise FIRST so it can never be eaten
    // by anything but an ability check (saves pass `check_only == false`).
    let help_check_consumed = if check_only {
        session.consume_help_check_advantage(entity_id)
    } else {
        false
    };

    // Condition edges + the inspiration spend, decided atomically on a scratch
    // copy so a rejection after this point could not have half-spent a point.
    let mut scratch = entity.clone();
    let (advantage, disadvantage, spent) = RulesEvaluator::edge_from_conditions_with_inspiration(
        &mut scratch,
        &entity,
        0.0,
        entity.position.2,
        entity.position.2,
        spend_inspiration,
    );
    if spent {
        // Persist the burn and journal exactly ONE spend event so a safety
        // rewind past this roll restores the point.
        if let Some(e) = session.entities.get_mut(&entity_id) {
            e.inspiration = false;
        }
        let campaign_id = session.campaign_id;
        session.ledger.append_event(
            session_id,
            campaign_id,
            entity_id,
            "INSPIRATION_CHANGED",
            serde_json::json!({
                "granted": false,
                "reason": "spent",
            }),
        );
    }
    RollGroundingOutcome::Grounded(RollGrounding {
        advantage,
        disadvantage,
        inspiration_consumed: spent,
        help_check_consumed,
    })
}

/// Shared seed policy for EVERY route that consumes a caller-supplied seed —
/// the stateless roll routes (`/actions/check|save`, see [`CheckActionReq`])
/// and the session-scoped dice routes (`attack`, `cast-spell`, `grapple`,
/// `shove`, `stabilize`, `offhand`, `damage`) alike: returns the 422 rejection
/// when a non-privileged caller tried to pin one. Policy (refuse) and
/// mechanics (build the engine) stay separate so the hot path never wraps a
/// large response in a Result. Call it at the TOP of each handler, before any
/// validation side effect (budget spends, ledger appends), so a refused
/// request costs its caller nothing.
fn refuse_client_seed(
    data: &AppState,
    identity: &AuthIdentity,
    seed: Option<u64>,
) -> Option<HttpResponse> {
    if seed.is_some() && !is_privileged_principal(identity) {
        Some(reject(
            data,
            422,
            "SEED_NOT_PERMITTED",
            "deterministic seeds are reserved for GM/service principals; omit `seed` for a server-rolled d20",
        ))
    } else {
        None
    }
}

async fn resolve_check(
    data: web::Data<AppState>,
    identity: AuthIdentity,
    req: web::Json<CheckActionReq>,
) -> impl Responder {
    data.count_request();
    if let Some(resp) = refuse_non_compute_role(&data, "resolve checks", Role::from_identity(&identity)) {
        return resp;
    }
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }
    // Session-scoped grounding (Help-on-check cash + inspiration spend). Any
    // rejection here happens before a single die is rolled.
    let (engine_advantage, engine_disadvantage, inspiration_consumed, help_check_consumed) =
        match (req.session_id, req.entity_id) {
            (Some(sid), Some(eid)) => match ground_roll_in_session(
                &data,
                &identity,
                sid,
                eid,
                req.spend_inspiration,
                true,
            ) {
                RollGroundingOutcome::Grounded(g) => {
                    (g.advantage, g.disadvantage, g.inspiration_consumed, g.help_check_consumed)
                }
                RollGroundingOutcome::Refused(resp) => return resp,
            },
            _ => (false, false, false, false),
        };
    let mut dice = match req.seed {
        // Privilege already verified above.
        Some(seed) => DiceEngine::with_seed(seed),
        None => DiceEngine::new(),
    };
    // Honor advantage/disadvantage by pre-selecting the kept d20
    // (tuples are (used_roll, r1, r2)) before 4-tier resolution. Engine-derived
    // edges (conditions / cashed Help promise / spent inspiration) merge with
    // the caller's explicit ask; SRD cancellation resolves in the branch order
    // below exactly as it did for legacy payloads.
    let disadvantage = engine_disadvantage || req.disadvantage.unwrap_or(false);
    let advantage =
        engine_advantage || help_check_consumed || req.advantage.unwrap_or(false);
    let kept_roll = if disadvantage {
        Some(dice.roll_d20_disadvantage().0)
    } else if advantage {
        Some(dice.roll_d20_advantage().0)
    } else {
        None
    };
    let mut body = if let Some(natural_roll) = kept_roll {
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
    // Additive disclosure (iteration 56): the effective edges and exactly what
    // was consumed grounding this roll in session state.
    body["advantage"] = serde_json::json!(advantage);
    body["disadvantage"] = serde_json::json!(disadvantage);
    body["inspiration_consumed"] = serde_json::json!(inspiration_consumed);
    body["help_check_advantage_consumed"] = serde_json::json!(help_check_consumed);
    data.count_valid();
    HttpResponse::Ok().json(body)
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
    /// Determinism opt-in (see `CheckActionReq`): honored only for
    /// GM/service principals; other callers get 422 SEED_NOT_PERMITTED.
    #[serde(default)]
    pub seed: Option<u64>,
    /// Session-scoped grounding (see `CheckActionReq`): pins this save to a
    /// live engine entity so an SRD inspiration spend resolves against real
    /// engine state. Saves never cash Help-on-check promises — that token is
    /// ability-check currency only.
    #[serde(default)]
    pub session_id: Option<Uuid>,
    #[serde(default)]
    pub entity_id: Option<Uuid>,
    /// SRD inspiration spend (GOALS.md P5): burn the saver's held point to buy
    /// Advantage on THIS save, atomically with the condition-edge decision.
    #[serde(default)]
    pub spend_inspiration: bool,
}

async fn resolve_save(
    data: web::Data<AppState>,
    identity: AuthIdentity,
    req: web::Json<SaveActionReq>,
) -> impl Responder {
    data.count_request();
    if let Some(resp) = refuse_non_compute_role(&data, "resolve saves", Role::from_identity(&identity)) {
        return resp;
    }
    if let Some(resp) = refuse_client_seed(&data, &identity, req.seed) {
        return resp;
    }
    // Session-scoped grounding (iteration 56): inspiration spend only — a save
    // never cashes a Help-on-check promise.
    let (engine_advantage, engine_disadvantage, inspiration_consumed) =
        match (req.session_id, req.entity_id) {
            (Some(sid), Some(eid)) => match ground_roll_in_session(
                &data,
                &identity,
                sid,
                eid,
                req.spend_inspiration,
                false,
            ) {
                RollGroundingOutcome::Grounded(g) => {
                    (g.advantage, g.disadvantage, g.inspiration_consumed)
                }
                RollGroundingOutcome::Refused(resp) => return resp,
            },
            _ => (false, false, false),
        };
    let mut dice = match req.seed {
        // Privilege already verified above.
        Some(seed) => DiceEngine::with_seed(seed),
        None => DiceEngine::new(),
    };
    // Advantage tuples are (used_roll, r1, r2). Engine-derived edges merge
    // with the caller's explicit ask; the legacy branch order is preserved.
    let disadvantage = engine_disadvantage || req.disadvantage.unwrap_or(false);
    let advantage = engine_advantage || req.advantage.unwrap_or(false);
    let natural_roll = if disadvantage {
        dice.roll_d20_disadvantage().0
    } else if advantage {
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
    // Additive disclosure (iteration 56): the effective edges and exactly what
    // was consumed grounding this save in session state.
    body["advantage"] = serde_json::json!(advantage);
    body["disadvantage"] = serde_json::json!(disadvantage);
    body["inspiration_consumed"] = serde_json::json!(inspiration_consumed);
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
    identity: AuthIdentity,
    req: web::Json<ConcentrationActionReq>,
) -> impl Responder {
    data.count_request();
    if let Some(resp) =
        refuse_non_compute_role(&data, "resolve concentration checks", Role::from_identity(&identity))
    {
        return resp;
    }
    // No seed field by design: this route is always server-entropy.
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

/// Validation ceilings for the stateless `/api/v1/spatial/*` compute routes.
///
/// These routes deserialize raw client integers straight into allocations, so
/// every dimension is bounded BEFORE a collision grid is constructed
/// (audit F-A2#2): an unbounded `grid_width * grid_height * depth` usize pair
/// was a one-POST OOM, an uncapped occluder Vec flooded the allocator, and
/// unbounded `f32` ranges / elevation layers fed pathological loops.
pub const MAX_SPATIAL_GRID_DIM: usize = 256;
/// Maximum occluder cells accepted per stateless spatial request.
pub const MAX_SPATIAL_SOLID_CELLS: usize = 4_096;
/// Inclusive upper bound (feet) for any client-supplied sight/range value.
pub const MAX_SPATIAL_RANGE_FEET: f32 = 500.0;
/// Highest elevation layer index addressable by a spatial request.
pub const MAX_SPATIAL_Z: usize = 32;

/// Validates one bounded grid dimension, returning the field-naming error
/// string on violation (`None` = acceptable).
fn check_spatial_dim(value: usize, field: &str) -> Option<String> {
    if value == 0 || value > MAX_SPATIAL_GRID_DIM {
        Some(format!(
            "{field} must be between 1 and {MAX_SPATIAL_GRID_DIM} (got {value})"
        ))
    } else {
        None
    }
}

/// Validates the shared grid/occluder parameters of ALL three stateless
/// spatial routes BEFORE any allocation happens. Returns `(code, detail)` for
/// the FIRST violation so responses stay single-error and predictable.
fn validate_spatial_grid_params(
    grid_width: usize,
    grid_height: usize,
    solid_cells_len: usize,
) -> Result<(), (String, String)> {
    if let Some(detail) = check_spatial_dim(grid_width, "grid_width") {
        return Err(("INVALID_GRID_WIDTH".into(), detail));
    }
    if let Some(detail) = check_spatial_dim(grid_height, "grid_height") {
        return Err(("INVALID_GRID_HEIGHT".into(), detail));
    }
    if solid_cells_len > MAX_SPATIAL_SOLID_CELLS {
        return Err((
            "INVALID_SOLID_CELLS".into(),
            format!(
                "solid_cells must hold at most {MAX_SPATIAL_SOLID_CELLS} entries (got {solid_cells_len})"
            ),
        ));
    }
    Ok(())
}

fn build_collision_grid(map: &SessionMap) -> GridCollisionMap {
    let mut grid = GridCollisionMap::new(map.width, map.height, 1, map.cell_size_feet);
    for &(x, y) in &map.solid_cells {
        grid.set_solid(x, y, 0, true);
    }
    grid
}

/// Whether a world-space point lands in a solid cell or outside the authored
/// map rectangle. Bounds are checked in RAW grid space (not via
/// `world_to_grid`, which clamps out-of-bounds coordinates back onto the edge
/// of the map and would silently allow pushing a token off-world).
fn world_point_blocked(grid: &GridCollisionMap, p: (f32, f32, f32)) -> bool {
    let gx = (p.0 / grid.cell_size_feet).floor();
    let gy = (p.1 / grid.cell_size_feet).floor();
    if gx < 0.0 || gy < 0.0 || gx >= grid.width as f32 || gy >= grid.height as f32 {
        return true;
    }
    grid.is_solid(gx as usize, gy as usize, 0)
}

/// Resolves a 5 ft shove push of the defender directly away from the shover,
/// stepping cell-by-cell (cell-size increments) along the push direction.
///
/// SRD 5e shove is EITHER/OR: knock prone OR push 5 feet. DESIGN DECISION
/// (audit F4): when the chosen effect was push but the path is obstructed,
/// the contest itself still resolves — the roll stands, the Action is spent
/// and the winner is declared — but displacement is reduced to whatever
/// fits before the first solid cell or map bound, and to ZERO if not even
/// one step is possible. Forced movement never drags a creature through an
/// obstruction, and the shover does not get a free fallback to the prone
/// effect they did not choose. The applied displacement is returned so the
/// caller can record it in the ledger event (rewind provenance) and refresh
/// the WS movement baseline.
///
/// Degenerate same-point attackers/defenders push along +x (matching the
/// pre-clamping behaviour).
fn resolve_clamped_push(
    map: &SessionMap,
    attacker_pos: (f32, f32, f32),
    defender_pos: (f32, f32, f32),
) -> ((f32, f32, f32), (f32, f32, f32), f32) {
    const PUSH_FEET: f32 = 5.0;
    let grid = build_collision_grid(map);
    let cell = if map.cell_size_feet > 0.0 {
        map.cell_size_feet
    } else {
        5.0
    };

    let dx = defender_pos.0 - attacker_pos.0;
    let dy = defender_pos.1 - attacker_pos.1;
    let len = (dx * dx + dy * dy).sqrt();
    let (ux, uy) = if len > f32::EPSILON {
        (dx / len, dy / len)
    } else {
        (1.0, 0.0)
    };

    // Whole-cell steps fit into the 5 ft budget.
    let steps = (PUSH_FEET / cell + 1e-4).floor().max(0.0) as usize;
    let mut landed = defender_pos;
    let mut moved = 0.0f32;
    for step in 1..=steps {
        let candidate = (
            defender_pos.0 + ux * (step as f32 * cell),
            defender_pos.1 + uy * (step as f32 * cell),
            defender_pos.2,
        );
        if world_point_blocked(&grid, candidate) {
            break; // stop BEFORE the blocking cell — never clip into it
        }
        landed = candidate;
        moved += cell;
    }
    (defender_pos, landed, moved)
}

fn build_terrain_overlay(map: &SessionMap) -> TerrainOverlay {
    let mut overlay = TerrainOverlay::new();
    for &(x, y) in &map.difficult_terrain {
        overlay.set_cost(x, y, 0, 2);
    }
    overlay
}

/// Builds the per-cell lighting overlay from a session map's declared
/// `lighting_zones` (cells absent from the map are Bright by convention).
fn build_lighting_overlay(map: &SessionMap) -> LightingOverlay {
    LightingOverlay::from_cells(&map.lighting_zones)
}

#[derive(Debug, Deserialize)]
pub struct LosReq {
    pub attacker_pos: Vector3,
    pub target_pos: Vector3,
    pub target_radius: f32,
    pub grid_width: usize,
    pub grid_height: usize,
    pub solid_cells: Vec<(usize, usize)>,
    /// Number of elevation layers the caller is modeling. Absent or 1 keeps
    /// the legacy single-layer behavior; values > 1 make head-height corner
    /// rays sample real voxels instead of clamping back onto layer 0
    /// (audit F-A2#1: iteration 20's elevation-aware cover was a no-op here).
    #[serde(default)]
    pub z_layers: Option<usize>,
    /// Occluders as full `(x, y, z)` grid voxels. Only meaningful together
    /// with `z_layers > 1`; ground-layer payloads keep using `solid_cells`.
    #[serde(default)]
    pub solid_cells_3d: Vec<(usize, usize, usize)>,
    /// Per-cell lighting zones to evaluate against (PHB bright/dim/darkness/
    /// magical darkness). Serde default keeps legacy payloads (no lighting)
    /// working — absent zones are Bright.
    #[serde(default)]
    pub lighting_zones: Vec<LightingZoneCell>,
    /// Viewer's SRD vision mode. Absent = Normal sight.
    #[serde(default)]
    pub viewer_vision_mode: Option<VisionMode>,
    /// Range in feet of the viewer's special sense; absent = unlimited.
    #[serde(default)]
    pub viewer_vision_range_feet: Option<f32>,
    /// Viewer carries the SRD Blinded condition. True suppresses every
    /// special sense (darkvision/blindsight/truesight give nothing) and the
    /// check evaluates plain normal sight. Absent = sighted.
    #[serde(default)]
    pub viewer_is_blinded: bool,
}

/// Resolves the collision-grid depth for a stateless spatial request:
/// an explicit multi-layer declaration wins; otherwise the request stays on
/// the legacy single ground layer. Depth is bounded by [`MAX_SPATIAL_Z`].
fn resolve_spatial_depth(z_layers: Option<usize>, fallback: usize) -> Result<usize, String> {
    let depth = z_layers.unwrap_or(fallback);
    if depth == 0 || depth > MAX_SPATIAL_Z {
        return Err(format!(
            "z_layers must be between 1 and {MAX_SPATIAL_Z} (got {depth})"
        ));
    }
    Ok(depth)
}

/// Builds a validated depth-aware occluder grid from a stateless spatial
/// request: ground-layer cells from `solid_cells`, elevated voxels via
/// `fill`. Returns `(code, detail)` for the first validation violation so the
/// caller renders the field-naming 422 (keeps the Err variant small).
fn build_validated_grid(
    width: usize,
    height: usize,
    depth: usize,
    solid_cells_len: usize,
    fill: impl FnOnce(&mut GridCollisionMap),
) -> Result<GridCollisionMap, (String, String)> {
    validate_spatial_grid_params(width, height, solid_cells_len)?;
    let mut grid = GridCollisionMap::new(width, height, depth, SPATIAL_CELL_SIZE_FEET);
    fill(&mut grid);
    Ok(grid)
}

/// Convenience wrapper: validates then rejects through `reject()` on failure.
macro_rules! validated_grid_or_reject {
    ($data:expr, $($args:tt)*) => {
        match build_validated_grid($($args)*) {
            Ok(g) => g,
            Err((code, detail)) => return reject($data, 422, &code, &detail),
        }
    };
}

/// Feet per cell assumed by every stateless spatial route payload (world
/// coordinates in these requests are plain feet on a 5 ft grid).
const SPATIAL_CELL_SIZE_FEET: f32 = 5.0;

/// Inclusive elevation bounds (feet) for any client-supplied fall or ledge
/// landing elevation. Tied to the same budget as [`MAX_SPATIAL_Z`]: one
/// stack of layers `SPATIAL_CELL_SIZE_FEET` thick above and below the ground
/// plane. Anything outside is off-map — a `-10000` "ledge" used to resolve as
/// a guaranteed-death fall instead of an honest 422 (audit F-A4#6).
pub const MIN_LANDING_Z_FEET: f32 = -(MAX_SPATIAL_Z as f32) * SPATIAL_CELL_SIZE_FEET;
pub const MAX_LANDING_Z_FEET: f32 = (MAX_SPATIAL_Z as f32) * SPATIAL_CELL_SIZE_FEET;

/// True when a client-supplied landing elevation is finite and on-map.
fn landing_z_in_bounds(z: f32) -> bool {
    z.is_finite() && (MIN_LANDING_Z_FEET..=MAX_LANDING_Z_FEET).contains(&z)
}

/// Upper bound on elevated-voxel entries so a `z_layers > 1` payload cannot
/// smuggle past the flat-list ceiling via `solid_cells_3d`.
const MAX_SPATIAL_VOXELS_3D: usize = MAX_SPATIAL_SOLID_CELLS * MAX_SPATIAL_Z;

async fn compute_los(
    data: web::Data<AppState>,
    identity: AuthIdentity,
    req: web::Json<LosReq>,
) -> impl Responder {
    data.count_request();
    if let Some(resp) =
        refuse_non_compute_role(&data, "query line-of-sight", Role::from_identity(&identity))
    {
        return resp;
    }
    let depth = match resolve_spatial_depth(req.z_layers, 1) {
        Ok(d) => d,
        Err(detail) => return reject(&data, 422, "INVALID_Z_LAYERS", &detail),
    };
    if req.solid_cells_3d.len() > MAX_SPATIAL_VOXELS_3D {
        return reject(
            &data,
            422,
            "INVALID_SOLID_CELLS",
            &format!(
                "solid_cells_3d must hold at most {MAX_SPATIAL_VOXELS_3D} entries (got {})",
                req.solid_cells_3d.len()
            ),
        );
    }
    let grid = validated_grid_or_reject!(
        &data,
        req.grid_width,
        req.grid_height,
        depth,
        req.solid_cells.len() + req.solid_cells_3d.len(),
        |grid| {
            for &(x, y) in &req.solid_cells {
                grid.set_solid(x, y, 0, true);
            }
            for &(x, y, z) in &req.solid_cells_3d {
                grid.set_solid(x, y, z, true);
            }
        }
    );

    let lighting = LightingOverlay::from_cells(&req.lighting_zones);
    // Vision defaults keep the route backward compatible: no mode/range given
    // means Normal sight with unlimited range.
    let vision_mode = req.viewer_vision_mode.unwrap_or(VisionMode::Normal);
    let vision_range_feet = req.viewer_vision_range_feet.unwrap_or(f32::INFINITY);

    let has_los = grid.has_line_of_sight_for_viewer(
        &lighting,
        vision_mode,
        vision_range_feet,
        req.viewer_is_blinded,
        &req.attacker_pos,
        &req.target_pos,
    );
    let cover = CoverCalculator::calculate_cover(
        &grid,
        &req.attacker_pos,
        &req.target_pos,
        req.target_radius,
    );
    let (tx, ty, _) = grid.world_to_grid(&req.target_pos);
    let target_cell_zone = lighting.zone_at(tx, ty, 0);

    HttpResponse::Ok().json(serde_json::json!({
        "has_line_of_sight": has_los,
        "cover_type": cover,
        "ac_bonus": cover.ac_bonus(),
        "dex_save_bonus": cover.dex_save_bonus(),
        "viewer_vision_mode": vision_mode,
        "target_cell_zone": target_cell_zone
    }))
}

/// Request for POST /api/v1/spatial/visibility: the raycasted visibility
/// polygon (GOALS.md Pillar 4) for one viewer position against the map's
/// wall/door occluders, truncated at `max_range_feet` (a viewer's sense range).
#[derive(Debug, Deserialize)]
pub struct VisibilityReq {
    /// Viewer position in world feet.
    pub origin: Vector3,
    pub grid_width: usize,
    pub grid_height: usize,
    pub solid_cells: Vec<(usize, usize)>,
    /// Sight radius in feet bounding the polygon.
    #[serde(default = "default_visibility_range")]
    pub max_range_feet: f32,
    /// Elevation layer to cast against (defaults to the ground floor).
    #[serde(default)]
    pub z: usize,
}

fn default_visibility_range() -> f32 {
    30.0
}

async fn compute_visibility(
    data: web::Data<AppState>,
    identity: AuthIdentity,
    req: web::Json<VisibilityReq>,
) -> impl Responder {
    data.count_request();
    if let Some(resp) =
        refuse_non_compute_role(&data, "query visibility polygon", Role::from_identity(&identity))
    {
        return resp;
    }
    if req.z > MAX_SPATIAL_Z {
        return reject(
            &data,
            422,
            "INVALID_Z",
            &format!("z must be at most {MAX_SPATIAL_Z} (got {})", req.z),
        );
    }
    if !(req.max_range_feet > 0.0 && req.max_range_feet.is_finite()) {
        return reject(
            &data,
            422,
            "INVALID_MAX_RANGE_FEET",
            &format!(
                "max_range_feet must be finite and greater than 0 (got {})",
                req.max_range_feet
            ),
        );
    }
    if req.max_range_feet > MAX_SPATIAL_RANGE_FEET {
        return reject(
            &data,
            422,
            "INVALID_MAX_RANGE_FEET",
            &format!(
                "max_range_feet must be at most {MAX_SPATIAL_RANGE_FEET} (got {})",
                req.max_range_feet
            ),
        );
    }
    let grid = validated_grid_or_reject!(
        &data,
        req.grid_width,
        req.grid_height,
        req.z + 1,
        req.solid_cells.len(),
        |grid| {
            for &(x, y) in &req.solid_cells {
                grid.set_solid(x, y, req.z, true);
            }
        }
    );
    let z = req.z;

    let polygon = if req.origin.x.is_finite() && req.origin.y.is_finite() {
        visibility_polygon_z(&grid, &req.origin, z, req.max_range_feet)
    } else {
        Vec::new()
    };

    HttpResponse::Ok().json(serde_json::json!({
        "polygon": polygon,
        "max_range_feet": req.max_range_feet,
        "z": req.z
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
    /// Number of elevation layers to route through. Absent or 1 keeps the
    /// legacy single-layer behavior (audit F-A2#1 applied here too — /path
    /// had the SAME forced depth-1 collision grid as /los).
    #[serde(default)]
    pub z_layers: Option<usize>,
}

async fn compute_path(
    data: web::Data<AppState>,
    identity: AuthIdentity,
    req: web::Json<PathReq>,
) -> impl Responder {
    data.count_request();
    if let Some(resp) =
        refuse_non_compute_role(&data, "query pathfinding", Role::from_identity(&identity))
    {
        return resp;
    }
    let depth = match resolve_spatial_depth(req.z_layers, 1) {
        Ok(d) => d,
        Err(detail) => return reject(&data, 422, "INVALID_Z_LAYERS", &detail),
    };
    let grid = validated_grid_or_reject!(
        &data,
        req.grid_width,
        req.grid_height,
        depth,
        req.solid_cells.len(),
        |grid| {
            for &(x, y) in &req.solid_cells {
                grid.set_solid(x, y, 0, true);
            }
        }
    );
    let terrain = build_terrain_overlay(&SessionMap {
        width: req.grid_width,
        height: req.grid_height,
        solid_cells: vec![],
        difficult_terrain: req.difficult_terrain.clone(),
        lighting_zones: vec![],
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

/// Map generation keeps its caller-supplied `seed`: unlike the roll routes,
/// WFC determinism is a design feature (same seed ⇒ identical tile grid for
/// collaborative map editing) and a pre-computed dungeon reveals nothing an
/// attacker can exploit. The ROUTE itself is still spectator-gated.
async fn generate_wfc_map(
    data: web::Data<AppState>,
    identity: AuthIdentity,
    req: web::Json<WfcReq>,
) -> impl Responder {
    data.count_request();
    if let Some(resp) =
        refuse_non_compute_role(&data, "generate maps", Role::from_identity(&identity))
    {
        return resp;
    }
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
    identity: AuthIdentity,
    req: web::Json<WasmScriptReq>,
) -> impl Responder {
    data.count_request();
    // Attacker-controlled programs: GM/service only (see `is_privileged_principal`).
    if !is_privileged_principal(&identity) {
        return reject(
            &data,
            403,
            "FORBIDDEN_ROLE",
            "script execution is reserved for GM and service principals",
        );
    }
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
    identity: AuthIdentity,
    req: web::Json<RhaiScriptReq>,
) -> impl Responder {
    data.count_request();
    // Attacker-controlled programs: GM/service only (see `is_privileged_principal`).
    if !is_privileged_principal(&identity) {
        return reject(
            &data,
            403,
            "FORBIDDEN_ROLE",
            "script execution is reserved for GM and service principals",
        );
    }
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

/// Board-token facts every participant may see about any entity: identity,
/// placement, shown/hidden, PC-or-NPC, and whether it still stands. Deliberately
/// EXCLUDES current_hp/max_hp/temp_hp/ac/speed/abilities/attacks/conditions/
/// spell slots/resistances/owner markers — anything a player could use to
/// optimize against the sheet rather than watch the board.
const PUBLIC_ENTITY_FIELDS: [&str; 5] = [
    "name", "is_visible", "position", "is_player", "is_dead",
];

/// An absent flag means visible: the engine defaults entities to shown, so a
/// missing field must not silently blank the whole board (gateway parity).
fn entity_is_visible(entity: &serde_json::Value) -> bool {
    entity
        .get("is_visible")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// The board-token view of one entity: who it is and where it stands. No HP,
/// AC, abilities, attacks, conditions, or ownership markers.
fn public_board_token(entity_id: &str, entity: &serde_json::Value) -> serde_json::Value {
    let mut projected = serde_json::Map::new();
    projected.insert("id".to_string(), serde_json::json!(entity_id));
    for field in PUBLIC_ENTITY_FIELDS {
        if let Some(value) = entity.get(field) {
            projected.insert(field.to_string(), value.clone());
        }
    }
    serde_json::Value::Object(projected)
}

/// Projects a serialized GameSession snapshot for the calling role, mirroring
/// the gateway's `_project_session_state` matrix in
/// python/vtt_orchestrator/server.py:
///
/// ================  ========================================================
/// Caller role       Entities received
/// ================  ========================================================
/// gm / admin        Full authoritative stat blocks, including hidden entities.
/// player            Entities they OWN (`owner_player_id` == user_id) in full;
///                   every OTHER visible entity reduced to the public
///                   board-token projection; hidden entities dropped.
/// spectator         All visible entities as board tokens; hidden dropped.
///                   (Unreachable on the x-card route — spectators 403 — but
///                   kept for fails-closed symmetry.)
/// ================  ========================================================
///
/// AUDIT F7: entity projection alone is not enough — the same serialized
/// GameSession also carries:
/// - `ingress_stack` / `egress_stack`: entries referencing a hidden entity are
///   DROPPED entirely for non-GMs (an id without points, or points without an
///   id, still leak half the transit). Visible entities' records survive so
///   conservation auditing keeps working.
/// - `combat.order`: hidden combatants' slots are stripped; visible actors'
///   slots survive so turn tracking still works, and `turn_index` is re-mapped
///   onto the projected slice.
///
/// Ledger events need no redaction here: only gm/player roles reach this route,
/// and both are trusted with exact ledger numbers under the gateway policy.
fn project_snapshot_for_role(
    mut snapshot: serde_json::Value,
    role: Role,
    user_id: &str,
) -> serde_json::Value {
    if role.is_gm() {
        return snapshot;
    }

    // Ids of entities hidden from every non-GM viewer. Collected BEFORE the
    // entity projection drops them so the stack/order redaction below can
    // match entries against the same set.
    let mut hidden_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(entities) = snapshot.get_mut("entities").and_then(|e| e.as_object_mut()) {
        let projected: serde_json::Map<String, serde_json::Value> = entities
            .iter()
            .filter_map(|(id, entity)| {
                if !entity_is_visible(entity) {
                    hidden_ids.insert(id.clone());
                    return None; // hidden from everyone but GM/admin
                }
                if entity.get("owner_player_id").and_then(|o| o.as_str()) == Some(user_id) {
                    Some((id.clone(), entity.clone())) // your own sheet, unredacted
                } else {
                    Some((id.clone(), public_board_token(id, entity)))
                }
            })
            .collect();
        *entities = projected;
    }

    // AUDIT F7: ingress/egress stack records carry entity_id plus exact
    // source_point/target_point coordinates — for a hidden NPC that reveals
    // where an invisible creature teleported from and to. Entries referencing
    // a hidden entity are DROPPED entirely rather than nulled: partial data
    // (an id without points, points without an id) still leaks half the
    // transit, and conservation auditing from non-GM views only needs the
    // VISIBLE entities' records anyway. Residual allowance: an egress record
    // for an entity ALREADY REMOVED from the board cannot be resolved against
    // the roster, so it survives even if that entity was hidden at despawn —
    // matching the ledger, which non-GMs are trusted with wholesale.
    for key in ["ingress_stack", "egress_stack"] {
        if let Some(stack) = snapshot.get_mut(key).and_then(|s| s.as_array_mut()) {
            stack.retain(|entry| {
                entry
                    .get("entity_id")
                    .and_then(|v| v.as_str())
                    .map(|id| !hidden_ids.contains(id))
                    .unwrap_or(true)
            });
        }
    }

    // AUDIT F7 (combat half): `combat.order` lists every combatant in
    // initiative sequence, so its length and a hidden NPC's POSITION reveal
    // when the invisible creature acts (relative initiative leak). Non-GM
    // views keep the visible actors' entries — players can still track whose
    // turn it is — while hidden ones are dropped. `turn_index` is re-mapped
    // onto the projected slice: it advances to the first VISIBLE combatant at
    // or after the authoritative index (wrapping), so it never dangles past
    // the shortened order and keeps naming the acting visible token whenever
    // one exists.
    if let Some(combat) = snapshot.get_mut("combat").and_then(|c| c.as_object_mut()) {
        let old_turn = combat
            .get("turn_index")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        if let Some(order) = combat.get_mut("order").and_then(|o| o.as_array_mut()) {
            let visible_positions: Vec<usize> = order
                .iter()
                .enumerate()
                .filter(|(_, id)| {
                    id.as_str()
                        .map(|s| !hidden_ids.contains(s))
                        .unwrap_or(true)
                })
                .map(|(i, _)| i)
                .collect();
            *order = order
                .iter()
                .enumerate()
                .filter(|(i, _)| visible_positions.contains(i))
                .map(|(_, v)| v.clone())
                .collect();
            let in_combat = combat
                .get("in_combat")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if in_combat && !visible_positions.is_empty() {
                let mapped = visible_positions
                    .iter()
                    .position(|&pos| pos >= old_turn)
                    .unwrap_or(0);
                combat.insert(
                    "turn_index".to_string(),
                    serde_json::json!(mapped),
                );
            }
        }
    }

    snapshot
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
        // AUDIT (MED): any non-spectator may raise an X-card, so the snapshot
        // is projected by caller role before it leaves the engine — non-GMs
        // get public board tokens only and never see hidden NPCs' stat blocks.
        let snapshot = data.attach_rule_version(
            project_snapshot_for_role(
                serde_json::to_value(&*session).unwrap_or(serde_json::Value::Null),
                role,
                &identity.user_id,
            ),
            session_id,
        );

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

/// The token name carried by a TokenUpdate frame, if any (camelCase wire
/// shape; `tokenId` is an entity DISPLAY NAME on this relay, see
/// `validate_token_move`).
fn payload_token_name(value: &serde_json::Value) -> Option<&str> {
    value
        .pointer("/payload/tokenId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// Whether the entity behind a token-name-keyed transform is hidden from
/// non-GM viewers (`is_visible == false` in the authoritative session state).
///
/// The CRDT frame itself carries NO visibility field — `TokenTransform` has
/// only geometry — so the decision is made against the server-side session
/// map, resolved by display name exactly like movement-speed validation.
/// Unknown tokens (free rooms, unregistered names, non-session rooms)
/// default to visible: we never invent a restriction the data cannot back.
fn token_is_hidden(data: &AppState, room_id: &str, token_name: &str) -> bool {
    Uuid::parse_str(room_id)
        .ok()
        .and_then(|id| data.sessions.get(&id))
        .map(|lock| {
            lock.read()
                .entities
                .values()
                .any(|e| e.name.eq_ignore_ascii_case(token_name) && !e.is_visible)
        })
        .unwrap_or(false)
}

/// The payload fields a non-GM seat is entitled to on a TokenUpdate delta —
/// exactly the transform geometry a client needs to render movement. Anything
/// else a sender's client stuffs into the frame (HP, conditions, AC,
/// abilities...) is stat-block data that `project_snapshot_for_role` already
/// refuses to show non-GM seats for someone else's entity; per-seat projection
/// (iteration 36) applies the same rule to live deltas.
const TOKEN_UPDATE_PUBLIC_FIELDS: &[&str] = &[
    "tokenId",
    "x",
    "y",
    "z",
    "rotation",
    "scale",
    "elevation",
    "timestamp",
];

/// Projects one relayed frame for a single recipient view class.
///
/// - GM views get the frame verbatim: they are entitled to the full
///   authoritative state, including hidden tokens and any extra fields the
///   sending client attached.
/// - Player/spectator views get snapshot-parity projection:
///   `TokenUpdate` frames for HIDDEN tokens are dropped entirely (`None`), and
///   surviving frames are rebuilt down to board-token geometry so nothing the
///   sender attached beyond the transform can leak onto their wire.
///
/// Resolution of a frame the session map CANNOT answer for splits by what
/// exactly is unresolvable (audit A3#8):
/// - No extractable `payload.tokenId` (missing or empty): FAIL-CLOSED — the
///   frame is dropped (`None`) for non-GM views. Visibility cannot be resolved
///   against any roster, so nothing is forwarded rather than trusting it.
///   (Inbound relay validation already rejects such frames before fan-out;
///   this is defense in depth for future callers.)
/// - Resolvable room but unknown token NAME, or non-session/free room:
///   FAIL-OPEN, same as `token_is_hidden` — the frame survives, reduced to the
///   public geometry fields. We never invent a restriction the data cannot
///   back, because these names match nothing in the authoritative roster.
///
/// Disclosed residual (audit A3#8): even correct dropping is not
/// information-theoretically silent. A spectator who watches the relay sees
/// WHICH frames vanish and when — traffic silence and timestamp gaps around a
/// hidden token's turns let them infer that *something* moved and roughly how
/// often, though not where or what. Closing that channel would require
/// constant-rate cover traffic; accepted as out of scope.
fn project_frame_for_view(
    data: &AppState,
    room_id: &str,
    frame: &serde_json::Value,
    view: DeliveryView,
) -> Option<String> {
    if view == DeliveryView::Gm {
        return Some(frame.to_string());
    }
    if frame.get("type").and_then(|t| t.as_str()) != Some("TokenUpdate") {
        // Only token deltas carry entity-derived data today; fog/cursor frames
        // keep their existing dedicated delivery paths.
        return Some(frame.to_string());
    }
    let name = payload_token_name(frame)?;
    if token_is_hidden(data, room_id, name) {
        return None;
    }
    let mut projected = frame.clone();
    if let Some(payload) = projected.get_mut("payload").and_then(|p| p.as_object_mut()) {
        payload.retain(|key, _| TOKEN_UPDATE_PUBLIC_FIELDS.contains(&key.as_str()));
    }
    Some(projected.to_string())
}

/// Whether this SENDER may drive the token identified by display name — the
/// relay-path counterpart of the ownership gate on HTTP `POST /move`
/// (`may_control_entity`): GMs control everything; players control only the
/// entities bound to their own user id; unowned entities inside a LIVE
/// session are DM-controlled and usable by any non-spectator until claimed.
///
/// NON-SESSION rooms fail CLOSED (relay audit, iteration 4). When the room id
/// is not a Uuid or resolves to no live session there is NO authoritative
/// roster to resolve ownership against, so the old behavior — treating every
/// token as unowned/DM-controlled — handed any authenticated player total
/// control of the free room (`aethertable-live`, lobby). Semantics chosen:
/// - Players/SPECTATORS: no token writes in a room without an authoritative
///   roster (spectators were always denied).
/// - GMs: keep administrative control everywhere — they already control
///   every entity in every session, and this preserves ops/admin utility of
///   free rooms.
/// - READ-ONLY fan-out in free rooms stays open to all roles: existing
///   clients ride the legacy `'aethertable-live'` fallback transport and must
///   still receive deltas; only control claims are refused.
///
/// Inside a live session the resolution stays exactly `may_control_entity`:
/// an unknown token NAME in a real session is still treated as DM-owned
/// (fail-open by documented design), because the session itself provides the
/// authoritative context those checks lean on.
fn may_control_token(
    data: &AppState,
    room_id: &str,
    token_name: &str,
    role: Role,
    user_id: &str,
) -> bool {
    if role == Role::Spectator {
        return false;
    }
    let session = Uuid::parse_str(room_id)
        .ok()
        .and_then(|id| data.sessions.get(&id));
    let Some(session_lock) = session else {
        return role.is_gm();
    };
    let entity_owner = session_lock
        .read()
        .entities
        .values()
        .find(|e| e.name.eq_ignore_ascii_case(token_name))
        .and_then(|e| e.owner_player_id.clone());
    may_control_entity(entity_owner.as_ref(), role, user_id)
}

/// Recomputes the party-merged fog view for SPECTATOR peers from the layers
/// currently retained in the relay hub (relay-audit structural limit #1).
///
/// Delivery policy, replacing the old "spectators get fewer frames" rule:
///
/// - Layer ids are "fog:{user_id}" for per-user private layers; any other id
///   is owner-less and party-shared. Previously a spectator could receive
///   only its own layer plus shared ones and simply MISSED every other user's
///   reveals, because composing masks into one union polygon set requires
///   rewriting frame payloads. Now the hub state IS rewritten on each fog
///   change into ONE merged layer (`party-explored`, see
///   `merge_fog_layers`) whose polygons are the concatenation-union of every
///   retained layer — spectators see accumulated party exploration without
///   per-player reveal HISTORY or ATTRIBUTION.
///
/// - What still never crosses the wire to a spectator is an individual
///   layer's IDENTITY: no "fog:{user_id}" id, no per-layer versioning. The
///   reveal GEOMETRY itself becomes the party's shared map state by design —
///   that aggregation is exactly what a spectator at the table is entitled
///   to watch.
///
/// The merge is recomputed from retained hub state AFTER the triggering
/// update was retained, so the frame a spectator receives always includes the
/// geometry that caused it. Returns `None` when nothing has been explored
/// yet, in which case spectators get no frame (there is no map state to show).
fn party_merged_spectator_fog(data: &AppState, room_id: &str) -> Option<FogOfWarMask> {
    let hub_room = data.crdt_hub.get_or_create_room(room_id);
    let state = hub_room.read();
    vtt_crdt_sync::crdt::merge_fog_layers(state.fog_masks.values())
}

/// Parses a browser-shaped FogUpdate frame into the CRDT model. The relay hub
/// must RETAIN fog state (not merely fan it out) — otherwise there is nothing
/// to put into a SyncStep2 initial snapshot for late joiners.
fn parse_fog_mask(value: &serde_json::Value, layer_id: &str) -> Option<FogOfWarMask> {
    let payload = value.get("payload")?;
    let polygons = payload
        .get("revealedPolygons")
        .or_else(|| payload.get("revealed_polygons"))?;
    let revealed_polygons: Vec<Vec<(f32, f32)>> = serde_json::from_value(polygons.clone()).ok()?;
    let version = payload.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(FogOfWarMask {
        layer_id: layer_id.to_string(),
        revealed_polygons,
        version,
    })
}

/// Builds the `SyncStep2` initial-state frame for one newly connected peer.
///
/// Relay-audit structural limit #4: until now a peer that joined mid-session
/// received deltas only and started from an empty board. This closes that gap:
/// after the WS handshake (and again on any client-sent `SyncStep1` resync
/// request) the peer gets ONE snapshot frame holding exactly what its
/// authenticated role is entitled to, then deltas flow as before.
///
/// Entitlement mirrors the live-delivery rules already enforced on fan-out:
/// - Tokens come from the AUTHORITATIVE session roster — that is where
///   visibility lives (`project_snapshot_for_role` semantics): non-GM peers
///   never see hidden entities. Positions overlay any accepted CRDT transform
///   so moved tokens appear where play left them, not at spawn points.
/// - Fog follows `party_merged_spectator_fog` semantics: spectators get ONE
///   party-merged layer (`party-explored`) covering everything the hub has
///   retained; GMs/players get every individual layer.
///
/// AUDIT F7 cross-check: the SyncStep2 frame carries ONLY tokens + fog — it
/// never embeds `ingress_stack`, `egress_stack`, or `combat.order`, so the
/// transit/initiative leaks fixed on the HTTP projection paths have no WS
/// counterpart here. Hidden-entity filtering above keeps the token list in
/// agreement with `project_snapshot_for_role`.
fn build_initial_snapshot(
    data: &AppState,
    room_id: &str,
    role: Role,
    // Retained on the signature so call sites stay symmetric across roles;
    // spectator fog projection is now aggregate, not per-viewer.
    _user_id: &str,
) -> CrdtSyncMessage {
    let hub_room = data.crdt_hub.get_or_create_room(room_id);
    let state = hub_room.read();

    // CRDT token ids are name-hash-derived (see accept_token_update), so an
    // accepted transform is matched back to its entity by the same hash.
    let live_transform = |name: &str| {
        let key = fnv1a_hash(name);
        state
            .token_transforms
            .values()
            .find(|t| t.vector_clock.client_id == key)
    };

    let mut tokens = Vec::new();
    if let Some(session_lock) = Uuid::parse_str(room_id).ok().and_then(|id| data.sessions.get(&id))
    {
        let session = session_lock.read();
        for entity in session.entities.values() {
            if !role.is_gm() && !entity.is_visible {
                continue; // hidden from everyone but GM/admin
            }
            let token = match live_transform(&entity.name) {
                Some(t) => SnapshotToken {
                    token_name: entity.name.clone(),
                    x: t.x,
                    y: t.y,
                    z: t.z,
                    rotation: t.rotation,
                    scale: t.scale,
                    elevation: t.elevation,
                    sequence: t.vector_clock.sequence,
                },
                // Never moved over the relay: fall back to the engine's
                // authored position with sequence 0 so ANY future delta wins
                // LWW against it.
                None => SnapshotToken {
                    token_name: entity.name.clone(),
                    x: entity.position.0,
                    y: entity.position.1,
                    z: entity.position.2,
                    rotation: 0.0,
                    scale: 1.0,
                    elevation: 0.0,
                    sequence: 0,
                },
            };
            tokens.push(token);
        }
    }

    // Relay-audit structural limit #1: the snapshot applies the SAME fog
    // delivery policy as live fan-out — spectators receive a single
    // party-merged layer recomputed from retained state, never a list of
    // individual per-user layers.
    let fog_layers: Vec<vtt_crdt_sync::FogOfWarMask> = if role == Role::Spectator {
        vtt_crdt_sync::crdt::merge_fog_layers(state.fog_masks.values())
            .into_iter()
            .collect()
    } else {
        state.fog_masks.values().cloned().collect()
    };

    CrdtSyncMessage::SyncStep2(SyncSnapshot {
        room_id: room_id.to_string(),
        tokens,
        fog_layers,
    })
}

/// Serialize + deliver the initial snapshot to one peer's socket. Failures are
/// logged but never fatal: a peer that misses its snapshot degrades to today's
/// delta-only behavior rather than being disconnected.
async fn send_initial_snapshot(session: &mut actix_ws::Session, frame: &CrdtSyncMessage) {
    match serde_json::to_string(frame) {
        Ok(text) => {
            if let Err(e) = session.text(text).await {
                log::warn!("Failed to deliver SyncStep2 snapshot: {}", e);
            }
        }
        Err(e) => log::warn!("Failed to serialize SyncStep2 snapshot: {}", e),
    }
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

    // Per-user concurrency cap (relay audit, iteration 4): refused BEFORE the
    // upgrade so an excess socket gets an honest HTTP 429 instead of a silent
    // half-open upgrade. The slot is released when the peer's message loop
    // ends (any close/disconnect), so reconnect storms self-heal.
    if !data
        .peers
        .acquire_user_slot(&identity.user_id, data.ws_per_user_cap)
    {
        log::warn!(
            "WS upgrade refused: user '{}' at per-user cap of {} live connections",
            identity.user_id,
            data.ws_per_user_cap
        );
        return HttpResponse::TooManyRequests().json(serde_json::json!({
            "error": "WS_CONNECTION_LIMIT",
            "detail": format!(
                "concurrent WebSocket limit ({}) reached for this user; close another tab or retry once one closes",
                data.ws_per_user_cap
            ),
            "limit": data.ws_per_user_cap,
        }));
    }

    let (response, session, mut msg_stream) = match actix_ws::handle(&req, body) {
        Ok(handshake) => handshake,
        Err(e) => {
            data.peers.release_user_slot(&identity.user_id);
            return HttpResponse::BadRequest().json(serde_json::json!({"error": e.to_string()}));
        }
    };

    let mut session = session;

    // Initial-state sync (relay-audit structural limit #4): the snapshot is
    // built and written BEFORE the peer joins the fan-out registry. That
    // ordering is the whole contract — a delta broadcast can never overtake
    // the snapshot on this socket, so clients may apply it blindly.
    let snapshot = build_initial_snapshot(&data, &room_id, role, &identity.user_id);
    send_initial_snapshot(&mut session, &snapshot).await;

    let peer_id = data.peers.join(&room_id, &session, role);
    let hub = Arc::clone(&data.crdt_hub);
    let peers = Arc::clone(&data.peers);
    let app_state = data.clone();
    let rid = room_id.clone();

    actix_web::rt::spawn(async move {
        while let Some(Ok(msg)) = msg_stream.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) {
                        match value.get("type").and_then(|t| t.as_str()) {
                            Some("TokenUpdate") => {
                                // Ingress RBAC mirrors every mutating HTTP
                                // route (`FORBIDDEN_ROLE`): spectators watch
                                // the board; they do not drive it.
                                if role == Role::Spectator {
                                    log::warn!(
                                        "Dropped TokenUpdate from spectator {}",
                                        identity.user_id
                                    );
                                // Ownership gate mirrors HTTP `POST /move`
                                // (`ENTITY_NOT_OWNED`): a player may move only
                                // tokens bound to their own user id; GMs move
                                // everything. Rejected moves are retained in
                                // NO CRDT state and fanned out to NOBODY.
                                } else if !payload_token_name(&value)
                                    .map(|name| {
                                        may_control_token(
                                            &app_state,
                                            &rid,
                                            name,
                                            role,
                                            &identity.user_id,
                                        )
                                    })
                                    .unwrap_or(false)
                                {
                                    log::warn!(
                                        "Dropped TokenUpdate from {} over a token they do not control",
                                        identity.user_id
                                    );
                                // Validate movement, then relay only updates that win LWW arbitration.
                                } else if accept_token_update(&app_state, &hub, &rid, &value) {
                                    // Per-seat delivery (iteration 36): instead of one class-wide
                                    // decision between "raw frame" and "GM-only", each recipient
                                    // gets the projection for ITS view — GMs verbatim, non-GMs
                                    // through the same visibility rules as their SyncStep2
                                    // snapshot (hidden tokens dropped entirely; surviving payloads
                                    // reduced to board-token geometry so nothing the sender's
                                    // client attached beyond the transform leaks onto player
                                    // wire). Hiddenness still comes from the authoritative session
                                    // state: the frame carries no visibility field.
                                    //
                                    // The projection runs at most ONCE per view class per frame
                                    // (`PerFrameProjections`), never per socket.
                                    let projections = PerFrameProjections::new(value.clone());
                                    peers
                                        .broadcast_per_seat(&rid, peer_id, &projections, |view, frame| {
                                            project_frame_for_view(&app_state, &rid, frame, view)
                                        })
                                        .await;
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
                                    // Retain the layer in CRDT state so future
                                    // SyncStep2 initial snapshots can serve it
                                    // to peers that connect later.
                                    match parse_fog_mask(&value, &layer_id) {
                                        Some(mask) => {
                                            hub.handle_incoming_message(
                                                &rid,
                                                CrdtSyncMessage::FogUpdate(mask),
                                            );
                                        }
                                        None => log::warn!(
                                            "FogUpdate for layer '{}' not parseable; relayed but not retained",
                                            layer_id
                                        ),
                                    }
                                    // Delivery, split by role:
                                    //
                                    // GM/player peers keep receiving the raw
                                    // individual layer exactly as before —
                                    // per-user layers are how each player's
                                    // client tracks its own reveal history.
                                    peers
                                        .broadcast_if(&rid, peer_id, &text, |peer| {
                                            peer.role != Role::Spectator
                                        })
                                        .await;
                                    // Spectator peers instead receive ONE
                                    // party-merged frame (relay-audit
                                    // structural limit #1): the union of all
                                    // retained layers under a single owner-less
                                    // id ("party-explored"), recomputed AFTER
                                    // the update above was retained so this
                                    // change's own geometry is included. No
                                    // "fog:{user_id}" id or per-layer version
                                    // ever reaches a spectator.
                                    if let Some(merged) = party_merged_spectator_fog(&app_state, &rid)
                                    {
                                        match serde_json::to_string(&CrdtSyncMessage::FogUpdate(
                                            merged,
                                        )) {
                                            Ok(merged_text) => {
                                                peers
                                                    .broadcast_if(&rid, peer_id, &merged_text, |peer| {
                                                        peer.role == Role::Spectator
                                                    })
                                                    .await;
                                            }
                                            Err(e) => log::warn!(
                                                "Failed to serialize party-merged fog frame: {}",
                                                e
                                            ),
                                        }
                                    }
                                } else {
                                    log::warn!(
                                        "Dropped FogUpdate from {} for foreign layer '{}'",
                                        identity.user_id,
                                        layer_id
                                    );
                                }
                            }
                            Some("CursorAwareness") => {
                                // Ingress flood cap (relay audit): cursors are
                                // high-frequency by design, so a misbehaving
                                // peer must not multiply its traffic across
                                // every room member. Over-cap frames are
                                // dropped SILENTLY before any fan-out — no
                                // error frame, no disconnect.
                                if peers.admit_cursor_frame(peer_id) {
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
                                } else {
                                    log::debug!(
                                        "Dropped over-cap CursorAwareness frame from peer {}",
                                        peer_id
                                    );
                                }
                            }
                            Some("Heartbeat") => {
                                let _ = session.text(text.clone()).await;
                            }
                            // Resync request: instead of echoing the caller's
                            // own state vector back, answer with the same
                            // entitlement-scoped snapshot a new connection
                            // receives.
                            Some("SyncStep1") => {
                                let resync =
                                    build_initial_snapshot(&app_state, &rid, role, &identity.user_id);
                                send_initial_snapshot(&mut session, &resync).await;
                            }
                            // Server-to-peer frame; a client sending one has
                            // nothing the room needs. Dropped, never fanned out.
                            Some("SyncStep2") => {}
                            _ => {}
                        }
                    }
                }
                Message::Ping(bytes) => {
                    let _ = session.pong(&bytes).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        peers.leave(&rid, peer_id);
        peers.release_user_slot(&identity.user_id);
        // Intentionally not awaited: the task is ending anyway and the close
        // frame is best-effort. `drop` (rather than `let _ =`) makes the
        // immediate-drop explicit for clippy::let_underscore_future.
        drop(session.close(None));
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

/// Registers all routes with env-tuned rate limits (`VTT_SCRIPT_RATE`,
/// `VTT_ACTION_RATE`, `VTT_READ_RATE`). Shared between `main` and integration
/// tests so tests exercise exactly the production route set.
pub fn configure_app(cfg: &mut web::ServiceConfig) {
    let limits = crate::ratelimit::RateLimits::from_env();
    configure_app_with(cfg, &limits);
}

/// Route registration with EXPLICIT quotas — dependency-injected variant used
/// by tests to pin deterministic limits (see `tests/rate_limiting.rs`).
///
/// Bucket topology (all per client IP, 60 s sliding windows):
/// - `/health`, `/metrics`, `/ws/sessions/{id}/sync`: UNMETERED (ops probes
///   and the sync channel must never throttle). The sync channel is instead
///   bounded by a PER-USER concurrent connection cap (`VTT_WS_PER_USER`,
///   default 8) enforced in `ws_sync` — excess upgrades get HTTP 429.
/// - `/api/v1` outer scope: generous READ bucket — safety net over everything,
///   including read-only `/rooms/{id}/presence`.
/// - `/api/v1/scripts/*`: strict SCRIPT bucket — wasm compile / Rhai
///   evaluation run attacker-controlled programs, so that work is metered.
/// - Mutation/compute subtrees (`/actions`, `/spatial`, `/maps`,
///   `/sessions/{id}`): moderate ACTION bucket. The session snapshot GET lives
///   inside the action bucket by construction (same URL prefix as the
///   mutations); polling one table faster than ~2 req/s per IP is not a
///   legitimate pattern.
pub fn configure_app_with(
    cfg: &mut web::ServiceConfig,
    limits: &crate::ratelimit::RateLimits,
) {
    use crate::ratelimit::{Bucket, RateLimit, RateLimitFilter};

    let wrap = |bucket| RateLimitFilter::new(RateLimit::new(limits, bucket));
    let read = wrap(Bucket::Read);
    // ONE RateLimit instance for the whole moderate bucket, shared by every
    // action scope below. `RateLimit` is an Arc-backed cheap clone (the
    // SlidingWindows store lives behind a single Arc), so cloning the filter
    // counts every action scope's traffic against the SAME per-IP window —
    // /actions/*, /spatial/*, /maps and /sessions/{id} share one 120/min
    // budget instead of each silently getting their own. Constructing a fresh
    // limiter per scope (the pre-audit behavior) multiplied the effective
    // quota by the number of scopes.
    let action = wrap(Bucket::Action);
    let script = wrap(Bucket::Script);

    cfg.route("/health", web::get().to(health_check))
        .route("/metrics", web::get().to(get_metrics))
        .route("/ws/sessions/{id}/sync", web::get().to(ws_sync))
        .service(
            web::scope("/api/v1")
                .wrap(read)
                // Session creation is cheap + GM-gated; rides the read net.
                .route("/sessions", web::post().to(create_session))
                .service(
                    web::scope("/scripts")
                        .wrap(script)
                        .route("/wasm", web::post().to(execute_wasm_script))
                        .route("/rhai", web::post().to(execute_rhai_script)),
                )
                .service(
                    web::scope("/actions")
                        .wrap(action.clone())
                        .route("/check", web::post().to(resolve_check))
                        .route("/save", web::post().to(resolve_save))
                        .route("/concentration", web::post().to(resolve_concentration)),
                )
                .service(
                    web::scope("/spatial")
                        .wrap(action.clone())
                        .route("/los", web::post().to(compute_los))
                        .route("/path", web::post().to(compute_path))
                        .route("/visibility", web::post().to(compute_visibility)),
                )
                .service(
                    web::scope("/maps")
                        .wrap(action.clone())
                        .route("/generate", web::post().to(generate_wfc_map)),
                )
                // Presence is a pure read: only the generous outer bucket.
                .service(
                    web::scope("/rooms")
                        .route("/{id}/presence", web::get().to(room_presence)),
                )
                .service(
                    web::scope("/sessions/{id}")
                        .wrap(action.clone())
                        .route("", web::get().to(get_session))
                        .route("/restore", web::put().to(restore_session))
                        .route("/entities", web::post().to(add_entity))
                        .route("/entities/{eid}", web::delete().to(remove_entity))
                        .route("/map", web::put().to(set_session_map))
                        .route("/action/attack", web::post().to(resolve_attack))
                        .route("/action/grapple", web::post().to(resolve_grapple_action))
                        .route("/action/escape-grapple", web::post().to(resolve_escape_grapple_action))
                        .route("/action/shove", web::post().to(resolve_shove_action))
                        .route("/action/fall", web::post().to(resolve_fall_action))
                        .route("/action/dodge", web::post().to(resolve_dodge))
                        .route("/action/dash", web::post().to(resolve_dash))
                        .route("/action/disengage", web::post().to(resolve_disengage))
                        .route("/action/ready", web::post().to(resolve_ready_action))
                        .route("/action/stabilize", web::post().to(resolve_stabilize))
                        .route("/action/offhand", web::post().to(resolve_offhand_action))
                        .route("/action/help", web::post().to(resolve_help_action))
                        .route("/action/help-check", web::post().to(resolve_help_check_action))
                        .route("/action/cast-spell", web::post().to(resolve_cast_spell))
                        .route("/move", web::post().to(move_entity))
                        .route("/reactions/arm", web::post().to(arm_reaction))
                        .route("/turn/next", web::post().to(next_turn))
                        .route("/combat/begin", web::post().to(begin_combat))
                        .route("/combat/end", web::post().to(end_combat))
                        .route("/action/death-save", web::post().to(resolve_death_save))
                        .route("/damage", web::post().to(apply_damage))
                        .route("/heal", web::post().to(heal_entity))
                        .route("/inventory/transfer", web::post().to(transfer_item))
                        .route("/rest", web::post().to(take_rest))
                        .route("/inspiration/grant", web::post().to(grant_inspiration_route))
                        .route("/inspiration/revoke", web::post().to(revoke_inspiration_route))
                        .route("/safety/x-card", web::post().to(trigger_safety_rewind))
                        .route("/sync", web::get().to(ws_sync)),
                ),
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
                        crate::persistence::ensure_session_row(
                            &pool,
                            sid,
                            campaign_id,
                            &name,
                            round,
                            state2.rule_version_for(sid).as_str(),
                        )
                        .await
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

// --- Per-seat projection cache unit tests ------------------------------------

#[cfg(test)]
mod per_seat_projection_tests {
    use super::*;

    /// The whole point of `PerFrameProjections`: a view's projection is
    /// computed AT MOST ONCE per frame, no matter how many sockets of that
    /// class ask for it — fan-out cost is one projection per (frame, class),
    /// not one per literal connection.
    #[test]
    fn projections_are_memoized_per_view_class() {
        let frame = serde_json::json!({"type": "TokenUpdate", "payload": {"tokenId": "Orc"}});
        let cache = PerFrameProjections::new(frame);

        let computes = std::cell::Cell::new(0u32);
        let compute = |view: DeliveryView| -> Option<String> {
            computes.set(computes.get() + 1);
            Some(format!("{:?}", view))
        };

        // Three "sockets" in the player class, two in the GM class.
        let _ = cache.for_view(DeliveryView::Player, || compute(DeliveryView::Player));
        let _ = cache.for_view(DeliveryView::Player, || compute(DeliveryView::Player));
        let _ = cache.for_view(DeliveryView::Player, || compute(DeliveryView::Player));
        assert_eq!(computes.get(), 1, "player-class projection must be cached");

        let _ = cache.for_view(DeliveryView::Gm, || compute(DeliveryView::Gm));
        let _ = cache.for_view(DeliveryView::Gm, || compute(DeliveryView::Gm));
        assert_eq!(computes.get(), 2, "each class computes exactly once");

        // The spectator slot was never touched.
        let spectator =
            cache.for_view(DeliveryView::Spectator, || compute(DeliveryView::Spectator));
        assert_eq!(spectator.as_deref(), Some("Spectator"));
        assert_eq!(computes.get(), 3);
    }

    /// A dropped projection (`None`) is memoized too: a hidden token stays
    /// hidden for every subsequent peer of that class within the same frame,
    /// without re-consulting session state per socket.
    #[test]
    fn dropped_projections_are_memoized_as_none() {
        let frame = serde_json::json!({"type": "TokenUpdate", "payload": {"tokenId": "Orc"}});
        let cache = PerFrameProjections::new(frame);

        let first = cache.for_view(DeliveryView::Player, || None);
        let second = cache.for_view(DeliveryView::Player, || Some("leaked".to_string()));
        assert!(first.is_none() && second.is_none());
    }

    /// Role-to-view mapping is total: every role lands in exactly one class,
    /// and the admin role CLAIM (which folds into `Role::Gm` in
    /// `Role::from_identity`) therefore lands in the GM view too.
    #[test]
    fn every_role_maps_to_one_delivery_view() {
        assert_eq!(DeliveryView::of(Role::Gm), DeliveryView::Gm);
        assert_eq!(DeliveryView::of(Role::Player), DeliveryView::Player);
        assert_eq!(DeliveryView::of(Role::Spectator), DeliveryView::Spectator);
    }
}
