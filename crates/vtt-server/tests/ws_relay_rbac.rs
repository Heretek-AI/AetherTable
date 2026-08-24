//! Relay-level RBAC for the live CRDT WebSocket (`/ws/sessions/{id}/sync`).
//!
//! Iteration 31 documented that client-side spectator filtering "protects
//! rendering, not the wire": CrdtRelayHub + PeerRegistry fan every accepted
//! frame out to EVERY connected peer regardless of role. These tests pin the
//! relay-level contract:
//! - hidden entities (`is_visible == false`) never reach spectator peers,
//!   while GM and player peers keep receiving their transforms;
//! - spectators cannot inject token moves (mirrors FORBIDDEN_ROLE on every
//!   mutating HTTP route);
//! - per-user fog layers (`fog:{user_id}`) are not delivered to other users'
//!   spectator connections; owner-less/shared layers reach everyone.
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
    let verifier = Arc::new(AuthVerifier {
        secret: Arc::new(TEST_SECRET.to_string()),
    });
    let state = web::Data::new(AppState::new());
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
    let url = format!("ws://{}/ws/sessions/{}/sync?token={}", addr, session_id, token);
    let (stream, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("websocket handshake");
    stream
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

fn token_update(token_name: &str, x: f64, y: f64) -> serde_json::Value {
    serde_json::json!({
        "type": "TokenUpdate",
        "payload": {"tokenId": token_name, "x": x, "y": y, "timestamp": 1}
    })
}

/// Creates a session and spawns one HIDDEN entity ("Orc") plus one visible
/// one ("Hero"), returning the session id.
async fn seed_hidden_and_visible_entities(
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
        .insert_header(("Authorization", gm.clone()))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Relay RBAC"}))
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    for (id, name, visible) in [
        (Uuid::new_v4(), "Orc", false),
        (Uuid::new_v4(), "Hero", true),
    ] {
        let entity = serde_json::json!({
            "id": id,
            "compendium_id": format!("test_{}", name),
            "name": name,
            "is_player": name == "Hero",
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
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(("Authorization", gm.clone()))
            .set_json(entity)
            .to_request();
        let res = test::call_service(app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "spawn of {}", name);
    }
    session_id
}

#[actix_web::test]
async fn hidden_token_transform_never_reaches_spectator_but_reaches_player() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut gm = connect_ws(&table, session_id, &sign_token_with_role("gm-1", "gm")).await;
    let mut player =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;
    let mut spectator =
        connect_ws(&table, session_id, &sign_token_with_role("watcher", "spectator")).await;

    // GM moves the HIDDEN orc.
    send_json(&mut gm, token_update("Orc", 5.0, 5.0)).await;

    let player_frame = next_frame(&mut player, 1500).await;
    assert!(
        player_frame.as_deref().map(|f| f.contains("Orc")).unwrap_or(false),
        "player peer must receive hidden-token transforms, got {:?}",
        player_frame
    );

    let spectator_frame = next_frame(&mut spectator, 400).await;
    assert!(
        spectator_frame.is_none(),
        "spectator peer must NOT receive hidden-token transforms, got {:?}",
        spectator_frame
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
        let frame = next_frame(stream, 1500).await;
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

    let gm_frame = next_frame(&mut gm, 400).await;
    assert!(gm_frame.is_none(), "GM must not receive spectator-injected moves, got {:?}", gm_frame);
    let player_frame = next_frame(&mut player, 400).await;
    assert!(
        player_frame.is_none(),
        "players must not receive spectator-injected moves, got {:?}",
        player_frame
    );
}

#[actix_web::test]
async fn private_fog_layers_do_not_reach_other_users_spectators() {
    let (app, table) = start_table().await;
    let session_id = seed_hidden_and_visible_entities(&app).await;

    let mut player =
        connect_ws(&table, session_id, &sign_token_with_role("player-a", "player")).await;
    let mut spectator_b =
        connect_ws(&table, session_id, &sign_token_with_role("watcher-b", "spectator")).await;

    // Player A writes THEIR fog layer.
    let fog = serde_json::json!({
        "type": "FogUpdate",
        "payload": {"layerId": "fog:player-a", "revealedPolygons": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]], "version": 1}
    });
    send_json(&mut player, fog).await;

    let spectator_frame = next_frame(&mut spectator_b, 400).await;
    assert!(
        spectator_frame.is_none(),
        "spectators must not receive other users' private fog layers, got {:?}",
        spectator_frame
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

    let spectator_frame = next_frame(&mut spectator, 1500).await;
    assert!(
        spectator_frame
            .as_deref()
            .map(|f| f.contains("party-explored"))
            .unwrap_or(false),
        "ownerless shared layers must still fan out to spectators, got {:?}",
        spectator_frame
    );
}
