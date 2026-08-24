//! Relay-level RBAC for the live CRDT WebSocket (`/ws/sessions/{id}/sync`).
//!
//! Iteration 31 documented that client-side spectator filtering "protects
//! rendering, not the wire": CrdtRelayHub + PeerRegistry fan every accepted
//! frame out to EVERY connected peer regardless of role. These tests pin the
//! relay-level contract:
//! - hidden entities (`is_visible == false`) reach GM peers ONLY on live
//!   deltas, matching the initial-snapshot policy that hides them from every
//!   non-GM role (snapshot/delta hidden-policy alignment);
//! - spectators cannot inject token moves (mirrors FORBIDDEN_ROLE on every
//!   mutating HTTP route), and neither can a player moving someone else's
//!   token — ownership is resolved by display name against session state,
//!   mirroring `may_control_entity` on HTTP `POST /move`;
//! - per-peer CursorAwareness frames are capped (~120/min, sliding minute);
//!   over-cap frames are silently dropped;
//! - spectators receive ONE party-merged fog layer (`party-explored`) whose
//!   polygons are the union of every layer retained in the relay hub — never
//!   the individual per-user layers themselves (relay-audit structural limit
//!   #1), while GM/player peers keep receiving each individual layer as-is;
//! - the initial `SyncStep2` snapshot serves spectators the same merged view.
//!
//! The tests drive a REAL server over real sockets (actix `test::start` +
//! tokio-tungstenite clients) so the assertion is about bytes on the wire,
//! not about rendering.

use actix_web::{dev::Service, http::StatusCode, test, web, App};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use hmac::Mac;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use uuid::Uuid;
use vtt_server::{
    AppState, AuthMiddleware, AuthVerifier, RateLimits,
};

const TEST_SECRET: &str = "ws-relay-test-secret";

fn sign_token_with_role(user_id: &str, role: &str) -> String {
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        + 3600.0;
    let payload = serde_json::json!({"user_id": user_id, "role": role, "exp": exp});
    let raw = serde_json::to_vec(&payload).unwrap();
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(TEST_SECRET.as_bytes()).unwrap();
    mac.update(&raw);
    let sig = hex::encode(mac.finalize().into_bytes());
    format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE.encode(&raw),
        sig
    )
}

/// Boots one shared AppState behind BOTH an in-process service (for REST
/// setup calls) and a real listening server (for socket-level WS clients).
async fn start_table() -> (
    impl Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<
            actix_web::body::EitherBody<actix_web::body::BoxBody>,
        >,
        Error = actix_web::Error,
    >,
    String, // ws:// address of the live server
) {
    start_table_with(AppState::new()).await
}

/// Variant letting a test customize AppState (e.g. the per-user WS
/// connection cap) before it is shared by both the in-process REST service
/// and the live socket server.
async fn start_table_with(
    state_value: AppState,
) -> (
    impl Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<
            actix_web::body::EitherBody<actix_web::body::BoxBody>,
        >,
        Error = actix_web::Error,
    >,
    String, // ws:// address of the live server
) {
    let verifier = Arc::new(AuthVerifier {
        secret: Arc::new(TEST_SECRET.to_string()),
    });
    let state = web::Data::new(state_value);
    let limits = RateLimits::explicit(1_000_000, 1_000_000, 1_000_000);

    let app = test::init_service(
        App::new()
            .wrap(AuthMiddleware {
                verifier: Arc::clone(&verifier),
            })
            .app_data(state.clone())
            .configure(move |cfg| vtt_server::configure_app_with(cfg, &limits)),
    )
    .await;

    // Bind an OS-assigned port ourselves so the tests know the address,
    // then hand the listener to a real HttpServer running alongside the
    // in-process REST service.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind test port");
    let addr = listener.local_addr().expect("local addr").to_string();

    let verifier_for_server = Arc::clone(&verifier);
    let state_for_server = state.clone();
    let server = actix_web::HttpServer::new(move || {
        App::new()
            .wrap(AuthMiddleware {
                verifier: Arc::clone(&verifier_for_server),
            })
            .app_data(state_for_server.clone())
            .configure(move |cfg| vtt_server::configure_app_with(cfg, &limits))
    })
    .listen(listener)
    .expect("listen")
    .run();
    actix_web::rt::spawn(server);

    (app, addr)
}

async fn connect_ws(addr: &str, session_id: Uuid, token: &str) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    connect_ws_room(addr, &session_id.to_string(), token).await
}

/// Variant accepting an ARBITRARY room id — free rooms like the legacy
/// `'aethertable-live'` fallback are not Uuids but real clients use them.
async fn connect_ws_room(
    addr: &str,
    room_id: &str,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://{}/ws/sessions/{}/sync?token={}", addr, room_id, token);
    let (stream, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("websocket handshake");
    stream
}

/// Attempts a WS handshake and returns the HTTP status outcome: 101 on
/// success, otherwise the refusal status the server answered with.
async fn ws_handshake_status(addr: &str, room_id: &str, token: &str) -> u16 {
    let url = format!("ws://{}/ws/sessions/{}/sync?token={}", addr, room_id, token);
    match tokio_tungstenite::connect_async(url).await {
        Ok(_) => 101,
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => resp.status().as_u16(),
        Err(e) => panic!("unexpected handshake failure: {e}"),
    }
}

async fn send_json(
    stream: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    value: serde_json::Value,
) {
    stream
        .send(WsMessage::Text(value.to_string().into()))
        .await
        .expect("ws send");
}

/// Reads the next TEXT frame or `None` on timeout — `None` is how these
/// tests assert that a peer did NOT receive a frame.
async fn next_frame(
    stream: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    timeout_ms: u64,
) -> Option<String> {
    let msg = match tokio::time::timeout(Duration::from_millis(timeout_ms), stream.next()).await {
        // Timeout, stream end, or transport error all count as "silence".
        Ok(Some(Ok(m))) => m,
        _ => return None,
    };
    match msg {
        WsMessage::Text(t) => Some(t.to_string()),
        WsMessage::Ping(_) | WsMessage::Pong(_) => None,
        _ => None,
    }
}

/// Reads frames until an APPLICATION frame arrives, i.e. anything that is
/// not the role-projected `SyncStep2` initial-state snapshot every new peer
/// now receives right after the WS handshake. `None` on timeout/silence —
/// same contract as `next_frame`.
async fn next_delta_frame(
    stream: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    timeout_ms: u64,
) -> Option<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.checked_duration_since(tokio::time::Instant::now())?;
        let frame = next_frame(stream, remaining.as_millis() as u64).await?;
        let is_snapshot = serde_json::from_str::<serde_json::Value>(&frame)
            .ok()
            .and_then(|v| {
                v.get("type")
                    .and_then(|t| t.as_str())
                    .map(|t| t == "SyncStep2")
            })
            .unwrap_or(false);
        if !is_snapshot {
            return Some(frame);
        }
    }
}

/// Reads the post-handshake initial-state snapshot frame, asserting it IS a
/// `SyncStep2` frame, and returns its parsed payload.
async fn read_initial_snapshot(
    stream: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) -> serde_json::Value {
    let frame = next_frame(stream, 1500)
        .await
        .expect("newly connected peer must receive a SyncStep2 snapshot frame");
    let value: serde_json::Value =
        serde_json::from_str(&frame).expect("snapshot frame must be valid JSON");
    assert_eq!(
        value["type"].as_str(),
        Some("SyncStep2"),
        "first application frame must be the initial-state snapshot, got {}",
        frame
    );
    value["payload"].clone()
}

fn snapshot_token_names(snapshot: &serde_json::Value) -> Vec<String> {
    snapshot["tokens"]
        .as_array()
        .map(|tokens| {
            tokens
                .iter()
                .filter_map(|t| t["tokenName"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn snapshot_fog_layer_ids(snapshot: &serde_json::Value) -> Vec<String> {
    snapshot["fogLayers"]
        .as_array()
        .map(|layers| {
            layers
                .iter()
                .filter_map(|l| l["layerId"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn token_update(token_name: &str, x: f64, y: f64) -> serde_json::Value {
    serde_json::json!({
        "type": "TokenUpdate",
        "payload": {"tokenId": token_name, "x": x, "y": y, "timestamp": 1}
    })
}

fn cursor_frame(x: f64, y: f64) -> serde_json::Value {
    serde_json::json!({
        "type": "CursorAwareness",
        "payload": {"x": x, "y": y}
    })
}

/// A minimal valid EntityState wire shape for the relay tests.
fn entity_json(id: Uuid, name: &str, visible: bool, owner: Option<&str>) -> serde_json::Value {
    let mut entity = serde_json::json!({
        "id": id,
        "compendium_id": format!("test_{}", name),
        "name": name,
        "is_player": false,
        "current_hp": 20,
        "max_hp": 20,
        "temp_hp": 0,
        "ac": 12,
        "speed_feet": 30.0,
        "position": [2.5, 2.5, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {
            "strength": 14, "dexterity": 12, "constitution": 12,
            "intelligence": 10, "wisdom": 10, "charisma": 10
        },
        "conditions": [],
        "action_budget": {
            "action": true, "bonus_action": true, "reaction": true,
            "movement_remaining_feet": 30.0, "free_object_interaction": true
        },
        "spell_slots_remaining": {},
        "attacks": [{"name": "Club", "attack_bonus": 3,
                     "damage_expression": "1d6", "damage_type": "bludgeoning"}],
        "resistances": [], "vulnerabilities": [], "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": true, "is_dead": false,
        "is_visible": visible
    });
    if let Some(owner) = owner {
        entity["owner_player_id"] = serde_json::json!(owner);
    }
    entity
}

/// Creates one empty session as the GM, returning its id.
async fn create_session(
    app: &impl Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<
            actix_web::body::EitherBody<actix_web::body::BoxBody>,
        >,
        Error = actix_web::Error,
    >,
) -> Uuid {
    let gm = format!("Bearer {}", sign_token_with_role("gm-1", "gm"));
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(("Authorization", gm))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Relay RBAC"}))
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    body["session_id"].as_str().unwrap().parse().unwrap()
}

/// Spawns one entity into the session as the GM.
async fn spawn_entity(
    app: &impl Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<
            actix_web::body::EitherBody<actix_web::body::BoxBody>,
        >,
        Error = actix_web::Error,
    >,
    session_id: Uuid,
    entity: serde_json::Value,
) {
    let name = entity["name"].as_str().unwrap_or("?").to_string();
    let gm = format!("Bearer {}", sign_token_with_role("gm-1", "gm"));
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(("Authorization", gm))
        .set_json(entity)
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "spawn of {}", name);
}

/// Creates a session and spawns one HIDDEN entity ("Orc") plus one visible
/// one ("Hero"), both unowned, returning the session id.
async fn seed_hidden_and_visible_entities(
    app: &impl Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse<
            actix_web::body::EitherBody<actix_web::body::BoxBody>,
        >,
        Error = actix_web::Error,
    >,
) -> Uuid {
    let session_id = create_session(app).await;
    spawn_entity(app, session_id, entity_json(Uuid::new_v4(), "Orc", false, None)).await;
    spawn_entity(app, session_id, entity_json(Uuid::new_v4(), "Hero", true, None)).await;
    session_id
}

/// Hidden-policy alignment (relay audit MED): the initial snapshot hides
/// hidden entities from every non-GM role, so live deltas must match — a
/// hidden token's transform reaches GM peers ONLY. Players used to receive
/// hidden-token movement deltas even though their snapshot never contained
/// the token; that inconsistency is what this test pins shut.
#[actix_web::test]
async fn hidden_token_transform_reaches_gm_peers_only() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut gm2 = connect_ws(&table, session_id, &sign_token_with_role("gm-2", "gm")).await;
    let mut player =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;
    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    // GM moves the HIDDEN orc.
    send_json(&mut gm, token_update("Orc", 5.0, 5.0)).await;

    let other_gm_frame = next_delta_frame(&mut gm2, 1500).await;
    assert!(
        other_gm_frame.as_deref().map(|f| f.contains("Orc")).unwrap_or(false),
        "GM peers must still receive hidden-token transforms, got {:?}",
        other_gm_frame
    );

    let player_frame = next_delta_frame(&mut player, 400).await;
    assert!(
        player_frame.is_none(),
        "player peers must NOT receive hidden-token transforms (snapshot parity), got {:?}",
        player_frame
    );

    let spectator_frame = next_delta_frame(&mut spectator, 400).await;
    assert!(
        spectator_frame.is_none(),
        "spectator peer must NOT receive hidden-token transforms, got {:?}",
        spectator_frame
    );
}

// --- TokenUpdate ownership gate ------------------------------------------------
//
// Relay audit HIGH: the relay arm gated only spectators, so any PLAYER could
// move ANY token (including GM-owned NPCs) over the WebSocket, while the HTTP
// /move route correctly enforces `may_control_entity`. The fix resolves the
// token's entity by display name against session state and accepts/relays a
// transform only when the sender is a GM, owns that entity, or the entity is
// unowned. Rejected moves fan out to NOBODY.

#[actix_web::test]
async fn player_cannot_move_gm_owned_npc_but_moves_own_token() {
    let (app, table) = start_table().await;
    let session_id = create_session(&app).await;
    spawn_entity(
        &app,
        session_id,
        entity_json(Uuid::new_v4(), "Goblin", true, Some("gm-1")),
    )
    .await;
    spawn_entity(
        &app,
        session_id,
        entity_json(Uuid::new_v4(), "Hero", true, Some("player-a")),
    )
    .await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    // A second, uninvolved player observes fan-out: the hijacked move must not
    // reach ANYONE, not just the rightful owner.
    let mut other_player =
        connect_ws(&table, session_id, &sign_token_with_role("player-b", "player")).await;
    let mut owner =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;

    // Player A tries to move the GM-owned goblin.
    send_json(&mut owner, token_update("Goblin", 9.0, 9.0)).await;

    let gm_frame = next_delta_frame(&mut gm, 400).await;
    assert!(
        gm_frame.is_none(),
        "hijacked move of a GM-owned NPC must not reach the GM, got {:?}",
        gm_frame
    );
    let bystander_frame = next_delta_frame(&mut other_player, 400).await;
    assert!(
        bystander_frame.is_none(),
        "rejected moves must fan out to nobody, got {:?}",
        bystander_frame
    );

    // The same player moving their OWN token still works end to end.
    send_json(&mut owner, token_update("Hero", 6.0, 6.0)).await;
    let own_move = next_delta_frame(&mut gm, 1500).await;
    assert!(
        own_move.as_deref().map(|f| f.contains("Hero")).unwrap_or(false),
        "a player's move of their own token must be accepted and relayed, got {:?}",
        own_move
    );
    let bystander_echo = next_delta_frame(&mut other_player, 1500).await;
    assert!(
        bystander_echo.as_deref().map(|f| f.contains("Hero")).unwrap_or(false),
        "legitimate moves still reach other players, got {:?}",
        bystander_echo
    );
}

// --- CursorAwareness ingress flood cap ------------------------------------------

/// Relay audit: any peer could fan arbitrary cursor frames room-wide. The cap
/// is per peer id over a sliding minute; over-cap frames are silently dropped.
#[actix_web::test]
async fn cursor_flood_beyond_per_peer_cap_is_not_fanned_out() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut observer =
        connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut flooder =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;

    for i in 0..200u32 {
        send_json(&mut flooder, cursor_frame(f64::from(i), 0.0)).await;
    }

    // Count the cursor frames actually fanned out to the observer until the
    // wire goes quiet.
    let mut received = 0usize;
    while let Some(frame) = next_delta_frame(&mut observer, 800).await {
        if frame.contains("CursorAwareness") {
            received += 1;
        }
    }

    assert!(
        received > 0,
        "cursor frames under the cap must still fan out"
    );
    assert!(
        received <= 120,
        "per-peer cursor cap (~120/min) must drop later frames in a 200-frame burst; \
         fanned out {}",
        received
    );
}

#[actix_web::test]
async fn visible_token_transform_reaches_every_role() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut player =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;
    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    send_json(&mut gm, token_update("Hero", 7.0, 3.0)).await;

    for (role, stream) in [("player", &mut player), ("spectator", &mut spectator)] {
        let frame = next_delta_frame(stream, 1500).await;
        assert!(
            frame.as_deref().map(|f| f.contains("Hero")).unwrap_or(false),
            "{} peer must receive visible-token transforms, got {:?}",
            role,
            frame
        );
    }
}

#[actix_web::test]
async fn spectator_cannot_inject_token_moves() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut player =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;
    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    // The spectator tries to move the GM's hidden orc anyway.
    send_json(&mut spectator, token_update("Orc", 99.0, 99.0)).await;

    let gm_frame = next_delta_frame(&mut gm, 400).await;
    assert!(gm_frame.is_none(), "GM must not receive spectator-injected moves, got {:?}", gm_frame);
    let player_frame = next_delta_frame(&mut player, 400).await;
    assert!(
        player_frame.is_none(),
        "players must not receive spectator-injected moves, got {:?}",
        player_frame
    );
}

// --- Party-merged fog for spectators ------------------------------------------
//
// Relay-audit structural limit #1: composing users' masks into one unioned
// polygon set requires rewriting frame payloads — until now spectators got
// FEWER frames rather than a merged one (they saw only their own layer plus
// owner-less shared layers). These tests pin the fix: on every accepted
// FogUpdate the relay recomputes ONE merged layer ("party-explored") from all
// layers currently retained in the hub and delivers that single frame to every
// spectator peer, while GM/player peers keep receiving the individual layer.

#[actix_web::test]
async fn spectator_receives_single_party_merged_fog_frame() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    // GM reveals one region on its OWN private layer.
    send_json(
        &mut gm,
        serde_json::json!({
            "type": "FogUpdate",
            "payload": {"layerId": "fog:gm-1",
                        "revealedPolygons": [[[2.0, 2.0], [4.0, 2.0], [4.0, 4.0]]],
                        "version": 3}
        }),
    )
    .await;

    let frame = next_delta_frame(&mut spectator, 1500)
        .await
        .expect("spectator must receive a party-merged fog frame");
    let value: serde_json::Value = serde_json::from_str(&frame).expect("frame must be JSON");
    assert_eq!(value["type"].as_str(), Some("FogUpdate"), "{}", frame);
    assert_eq!(
        value["payload"]["layerId"].as_str(),
        Some("party-explored"),
        "the frame must be the SINGLE merged layer, not an individual one: {}",
        frame
    );
    assert!(
        !frame.contains("fog:gm-1"),
        "merged frames must never carry another user's private layer id: {}",
        frame
    );
    assert_eq!(
        value["payload"]["revealedPolygons"][0][0],
        serde_json::json!([2.0, 2.0]),
        "merged polygons must contain the GM's revealed geometry: {}",
        frame
    );

    // Exactly ONE frame per fog change: no echo of the raw layer follows.
    let extra = next_delta_frame(&mut spectator, 400).await;
    assert!(
        extra.is_none(),
        "spectator must receive a SINGLE merged frame per change, got {:?}",
        extra
    );
}

#[actix_web::test]
async fn second_users_fog_layer_merges_into_party_view_while_players_keep_individual_layers() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut player =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;
    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    let layer_a = serde_json::json!({
        "type": "FogUpdate",
        "payload": {"layerId": "fog:gm-1",
                    "revealedPolygons": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]],
                    "version": 2}
    });
    let layer_b = serde_json::json!({
        "type": "FogUpdate",
        "payload": {"layerId": "fog:player-a",
                    "revealedPolygons": [[[5.0, 5.0], [6.0, 5.0], [6.0, 6.0]]],
                    "version": 7}
    });

    // First user reveals region A.
    send_json(&mut gm, layer_a.clone()).await;

    // PLAYER peers still receive the individual layer as before.
    let player_frame = next_delta_frame(&mut player, 1500).await;
    assert!(
        player_frame.as_deref().map(|f| f.contains("fog:gm-1")).unwrap_or(false),
        "player peers must keep receiving individual layers unchanged, got {:?}",
        player_frame
    );

    // ...while the spectator sees only the merged view of it.
    let spectator_frame = next_delta_frame(&mut spectator, 1500)
        .await
        .expect("spectator must receive the merged frame for the first layer");
    assert!(
        !spectator_frame.contains("fog:gm-1") && spectator_frame.contains("party-explored"),
        "spectator must see the merged layer id, not the individual one: {}",
        spectator_frame
    );

    // A SECOND user reveals region B on their own private layer.
    send_json(&mut player, layer_b.clone()).await;

    let gm_frame = next_delta_frame(&mut gm, 1500).await;
    assert!(
        gm_frame.as_deref().map(|f| f.contains("fog:player-a")).unwrap_or(false),
        "GM peers must keep receiving individual layers unchanged, got {:?}",
        gm_frame
    );

    let spectator_frame = next_delta_frame(&mut spectator, 1500)
        .await
        .expect("spectator must receive the merged frame for the second layer");
    let value: serde_json::Value =
        serde_json::from_str(&spectator_frame).expect("frame must be JSON");
    let polygons = &value["payload"]["revealedPolygons"];
    // Hub layers live in a map, so merged order is unspecified — assert as a
    // SET: both users' geometry present in one frame.
    let origins: Vec<&serde_json::Value> = (0..polygons.as_array().map_or(0, Vec::len))
        .map(|i| &polygons[i][0])
        .collect();
    assert!(
        origins.contains(&&serde_json::json!([0.0, 0.0])),
        "merged view must retain user A's geometry: {}",
        spectator_frame
    );
    assert!(
        origins.contains(&&serde_json::json!([5.0, 5.0])),
        "second user's layer must merge into the same party view: {}",
        spectator_frame
    );
}

#[actix_web::test]
async fn private_layer_geometry_merges_for_spectators_without_identity_leak() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut player =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;
    let mut spectator_b =
        connect_ws(&table, session_id, &sign_token_with_role("watcher-b", "spectator")).await;

    // Player A writes THEIR private fog layer.
    send_json(
        &mut player,
        serde_json::json!({
            "type": "FogUpdate",
            "payload": {"layerId": "fog:player-a",
                        "revealedPolygons": [[[3.0, 3.0], [4.0, 3.0], [4.0, 4.0]]],
                        "version": 9}
        }),
    )
    .await;

    // The spectator receives the accumulated party exploration — but as ONE
    // owner-less merged layer. What must never leak is the per-user LAYER
    // IDENTITY (`fog:player-a`), which is what attributed reveal history to a
    // specific user on the wire.
    let frame = next_delta_frame(&mut spectator_b, 1500)
        .await
        .expect("spectator must receive the party-merged exploration");
    assert!(
        !frame.contains("fog:player-a"),
        "private layer ids must never appear in a spectator's frames, got {}",
        frame
    );
    let value: serde_json::Value = serde_json::from_str(&frame).expect("frame must be JSON");
    assert_eq!(value["payload"]["layerId"].as_str(), Some("party-explored"));
    assert_eq!(
        value["payload"]["revealedPolygons"][0][0],
        serde_json::json!([3.0, 3.0]),
        "the revealed geometry itself is the party's shared map state: {}",
        frame
    );
}

#[actix_web::test]
async fn ownerless_shared_fog_layers_reach_every_role() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    // A party-shared layer carries no per-user owner marker. Writing such
    // layers stays a GM privilege (ingress unchanged) — this test pins the
    // DELIVERY side: once written, they fan out to every role.
    let fog = serde_json::json!({
        "type": "FogUpdate",
        "payload": {"layerId": "party-explored", "revealedPolygons": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]], "version": 1}
    });
    send_json(&mut gm, fog).await;

    let spectator_frame = next_delta_frame(&mut spectator, 1500).await;
    assert!(
        spectator_frame
            .as_deref()
            .map(|f| f.contains("party-explored"))
            .unwrap_or(false),
        "ownerless shared layers must still fan out to spectators, got {:?}",
        spectator_frame
    );
}

// --- Initial-state sync (SyncStep2) -------------------------------------------
//
// Relay-audit structural limit #4: "the relay has no initial-state sync
// message at all — a newly connected peer gets deltas only". These tests pin
// the fix: after the WS handshake the server sends ONE SyncStep2 snapshot
// frame containing exactly what that peer's role is entitled to, BEFORE any
// broadcast delta can reach it.

#[actix_web::test]
async fn initial_snapshot_shows_spectator_only_visible_board_tokens() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    let snapshot = read_initial_snapshot(&mut spectator).await;
    let names = snapshot_token_names(&snapshot);
    assert!(
        names.iter().any(|n| n == "Hero"),
        "snapshot must include visible board tokens, got {:?}",
        names
    );
    assert!(
        !names.iter().any(|n| n == "Orc"),
        "snapshot must EXCLUDE hidden entities from spectators, got {:?}",
        names
    );
}

#[actix_web::test]
async fn initial_snapshot_includes_hidden_entities_for_gm() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;

    let snapshot = read_initial_snapshot(&mut gm).await;
    let names = snapshot_token_names(&snapshot);
    assert!(
        names.iter().any(|n| n == "Hero") && names.iter().any(|n| n == "Orc"),
        "GM snapshot must include hidden AND visible entities, got {:?}",
        names
    );
}

#[actix_web::test]
async fn initial_snapshot_precedes_broadcast_deltas_for_new_peers() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;
    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;

    // The delta is already in flight while the spectator is handshaking; the
    // snapshot frame must STILL arrive first.
    send_json(&mut gm, token_update("Hero", 7.0, 3.0)).await;

    let first = next_frame(&mut spectator, 1500)
        .await
        .expect("spectator must receive the snapshot");
    let first_value: serde_json::Value =
        serde_json::from_str(&first).expect("frame must be JSON");
    assert_eq!(
        first_value["type"].as_str(),
        Some("SyncStep2"),
        "the FIRST application frame must be the snapshot, not a delta: {}",
        first
    );

    let second = next_delta_frame(&mut spectator, 1500).await;
    assert!(
        second.as_deref().map(|f| f.contains("Hero")).unwrap_or(false),
        "after the snapshot the live delta must flow as today, got {:?}",
        second
    );
}

#[actix_web::test]
async fn initial_snapshot_serves_spectators_the_party_merged_fog_view() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    // GM seeds two distinct layers (one private per-user layer, one shared)
    // before the spectator connects — the snapshot must serve the same merged
    // view live fan-out does, not a list of individual layers.
    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    for (layer, origin) in [("fog:gm-1", [0.0, 0.0]), ("party-shared", [7.0, 7.0])] {
        send_json(
            &mut gm,
            serde_json::json!({
                "type": "FogUpdate",
                "payload": {"layerId": layer,
                            "revealedPolygons": [[origin, [origin[0] + 1.0, origin[1]],
                                                  [origin[0] + 1.0, origin[1] + 1.0]]],
                            "version": 4}
            }),
        )
        .await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;
    let snapshot = read_initial_snapshot(&mut spectator).await;
    let layers = snapshot_fog_layer_ids(&snapshot);

    assert_eq!(
        layers,
        vec!["party-explored".to_string()],
        "spectator snapshots must contain exactly ONE party-merged fog layer, got {:?}",
        layers
    );

    // The merged layer carries BOTH layers' geometry (union by concatenation;
    // hub map order is unspecified so assert as a set).
    let polygons = &snapshot["fogLayers"][0]["revealedPolygons"];
    assert_eq!(polygons.as_array().map(Vec::len), Some(2));
    let origins: Vec<&serde_json::Value> = (0..2).map(|i| &polygons[i][0]).collect();
    assert!(origins.contains(&&serde_json::json!([0.0, 0.0])));
    assert!(origins.contains(&&serde_json::json!([7.0, 7.0])));

    // GMs keep receiving every individual layer.
    let mut gm2 = connect_ws(&table, session_id, &sign_token_with_role("gm-2", "gm")).await;
    let gm_snapshot = read_initial_snapshot(&mut gm2).await;
    let gm_layers = snapshot_fog_layer_ids(&gm_snapshot);
    assert!(
        gm_layers.contains(&"fog:gm-1".to_string()) && gm_layers.contains(&"party-shared".to_string()),
        "GM snapshots must keep listing individual layers, got {:?}",
        gm_layers
    );
}

// --- Iteration 4: fail-closed control in non-session rooms -------------------

/// Relay audit (iteration 4): `may_control_token` parsed the room id as a Uuid
/// and, on failure, fell through to "unowned entity" semantics — controllable
/// by ANY non-spectator. Free rooms (`aethertable-live`, lobby names) carry no
/// authoritative roster, so every player could drive every token. Control
/// claims must FAIL CLOSED there; read-only fan-out stays open.
#[actix_web::test]
async fn player_cannot_drive_tokens_in_free_rooms() {
    let (app, table) = start_table().await;
    let _ = &app; // free room needs no REST seeding
    let free_room = "aethertable-live";

    let mut sender = connect_ws_room(&table, free_room, &sign_token_with_role("player-1", "player")).await;
    let _snapshot = read_initial_snapshot(&mut sender).await;
    let mut watcher = connect_ws_room(&table, free_room, &sign_token_with_role("player-2", "player")).await;
    let _snapshot = read_initial_snapshot(&mut watcher).await;

    send_json(&mut sender, token_update("Hero", 4.0, 5.0)).await;

    assert!(
        next_delta_frame(&mut watcher, 700).await.is_none(),
        "a player's TokenUpdate in a NON-SESSION room must be dropped, not fanned out"
    );
}

/// Same fail-closed rule for rooms whose id LOOKS like a session but has no
/// live session behind it — no authoritative roster, so no ownership to lean on.
#[actix_web::test]
async fn player_cannot_drive_tokens_in_uuid_rooms_without_a_session() {
    let (app, table) = start_table().await;
    let _ = &app;
    let ghost_room = Uuid::new_v4().to_string();

    let mut sender = connect_ws_room(&table, &ghost_room, &sign_token_with_role("player-1", "player")).await;
    let _snapshot = read_initial_snapshot(&mut sender).await;
    let mut watcher = connect_ws_room(&table, &ghost_room, &sign_token_with_role("player-2", "player")).await;
    let _snapshot = read_initial_snapshot(&mut watcher).await;

    send_json(&mut sender, token_update("Hero", 4.0, 5.0)).await;

    assert!(
        next_delta_frame(&mut watcher, 700).await.is_none(),
        "TokenUpdate over an unresolvable session id must be dropped"
    );
}

/// The chosen semantics: GMs keep administrative control everywhere (they
/// already control every entity), and READ-ONLY fan-out in free rooms stays
/// allowed so existing clients on the legacy `'aethertable-live'` fallback
/// still see state. Pinned here so the fail-closed change cannot silently
/// break either property.
#[actix_web::test]
async fn gm_writes_and_read_only_fanout_survive_in_free_rooms() {
    let (_app, table) = start_table().await;
    let free_room = "aethertable-live";

    let mut gm = connect_ws_room(&table, free_room, &sign_token_with_role("gm-1", "gm")).await;
    let _snapshot = read_initial_snapshot(&mut gm).await;
    let mut watcher = connect_ws_room(&table, free_room, &sign_token_with_role("watcher", "spectator")).await;
    let _snapshot = read_initial_snapshot(&mut watcher).await;

    send_json(&mut gm, token_update("Hero", 4.0, 5.0)).await;

    let frame = next_delta_frame(&mut watcher, 1500)
        .await
        .expect("GM TokenUpdate in a free room must still fan out");
    assert!(
        frame.contains("TokenUpdate"),
        "expected the GM's TokenUpdate delta, got {frame}"
    );
}

// --- Iteration 4: per-user concurrent WS connection cap ----------------------

/// `/ws/sync` used to be unmetered AND uncapped per user. Now each user may
/// hold at most `VTT_WS_PER_USER` (default 8) LIVE connections: excess
/// upgrades get an honest HTTP refusal, and slots are released on close so a
/// reconnect storm can never lock a user out permanently.
#[actix_web::test]
async fn ws_connections_beyond_per_user_cap_are_refused_and_released_on_close() {
    let cap_state = {
        let mut s = AppState::new();
        s.ws_per_user_cap = 2;
        s
    };
    let (_app, table) = start_table_with(cap_state).await;
    let room = Uuid::new_v4().to_string();
    let flooder = sign_token_with_role("flooder-user", "gm");

    let mut s1 = connect_ws_room(&table, &room, &flooder).await;
    read_initial_snapshot(&mut s1).await;
    let mut s2 = connect_ws_room(&table, &room, &flooder).await;
    read_initial_snapshot(&mut s2).await;

    // Third concurrent socket for the SAME user is refused honestly.
    let status = ws_handshake_status(&table, &room, &flooder).await;
    assert_eq!(
        status, 429,
        "upgrade beyond the per-user cap must be refused with HTTP 429, got {status}"
    );

    // A DIFFERENT user is unaffected by someone else's cap.
    let other = connect_ws_room(&table, &room, &sign_token_with_role("other-user", "gm")).await;
    drop(other);

    // Release on close: closing one live socket frees its slot, so the
    // flooder can reconnect after a bounded wait (no permanent lockout).
    drop(s1);
    let mut reconnected = None;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if ws_handshake_status(&table, &room, &flooder).await == 101 {
            reconnected = Some(true);
            break;
        }
    }
    assert_eq!(
        reconnected,
        Some(true),
        "closing a live connection must release its per-user slot"
    );
    drop(s2);
}
