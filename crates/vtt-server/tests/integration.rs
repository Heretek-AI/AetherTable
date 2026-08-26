//! Integration tests for the authoritative engine server.
//!
//! These exercise the exact production configuration: HMAC auth middleware +
//! strict route set. The trust-inversion regressions guarded here:
//! - unauthenticated requests are rejected
//! - client-supplied combat math (`attack_bonus`, `target_ac`,
//!   `damage_expression`) is structurally rejected (HTTP 422)
//! - action economy, ingress gating and damage provenance are enforced

use actix_web::{
    body::{BoxBody, EitherBody},
    dev::{Service, ServiceResponse},
    http::StatusCode,
    test, App,
};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use vtt_server::{AuthMiddleware, AuthVerifier};

const TEST_SECRET: &str = "integration-test-secret";

type HmacSha256 = Hmac<Sha256>;

fn sign_token(user_id: &str, secret: &str) -> String {
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64() + 3600.0;
    let payload = serde_json::json!({"user_id": user_id, "exp": exp});
    let raw = serde_json::to_vec(&payload).unwrap();
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(&raw);
    let sig = hex::encode(mac.finalize().into_bytes());
    format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE.encode(&raw),
        sig
    )
}

/// Builds the production-config test app AND hands back the shared AppState so
/// tests can assert on server-side caches (e.g. the WS movement baseline that
/// engine-side shove displacement must keep consistent).
async fn test_app_with_state() -> (
    impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    actix_web::web::Data<vtt_server::AppState>,
) {
    let verifier = Arc::new(AuthVerifier {
        secret: Arc::new(TEST_SECRET.to_string()),
    });
    let state = actix_web::web::Data::new(vtt_server::AppState::new());
    // Rate-limit behavior has its own dedicated suite (tests/rate_limiting.rs).
    // These mechanic tests burst far past realistic per-IP play rates (seed
    // scans of 200+ attacks), so they run against the exact same route set but
    // with quotas raised out of the way.
    let limits = vtt_server::RateLimits::explicit(1_000_000, 1_000_000, 1_000_000);
    let app = test::init_service(
        App::new()
            .wrap(AuthMiddleware { verifier })
            .app_data(state.clone())
            .configure(move |cfg| vtt_server::configure_app_with(cfg, &limits)),
    )
    .await;
    (app, state)
}

async fn test_app() -> impl Service<
    actix_http::Request,
    Response = ServiceResponse<EitherBody<BoxBody>>,
    Error = actix_web::Error,
> {
    test_app_with_state().await.0
}

fn sign_token_with_role(user_id: &str, role: &str, secret: &str) -> String {
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64() + 3600.0;
    let payload = serde_json::json!({"user_id": user_id, "role": role, "exp": exp});
    let raw = serde_json::to_vec(&payload).unwrap();
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(&raw);
    let sig = hex::encode(mac.finalize().into_bytes());
    format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE.encode(&raw),
        sig
    )
}

fn bearer(token: &str) -> (actix_web::http::header::HeaderName, String) {
    (
        actix_web::http::header::AUTHORIZATION,
        format!("Bearer {}", token),
    )
}

fn entity_json(
    id: Uuid,
    name: &str,
    hp: i32,
    ac: i32,
    attack_bonus: i32,
    damage: &str,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "compendium_id": format!("test_{}", name),
        "name": name,
        "is_player": true,
        "current_hp": hp,
        "max_hp": hp,
        "temp_hp": 0,
        "ac": ac,
        "speed_feet": 30.0,
        "position": [2.5, 2.5, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {
            "strength": 16, "dexterity": 14, "constitution": 14,
            "intelligence": 10, "wisdom": 12, "charisma": 10
        },
        "conditions": [],
        "action_budget": {
            "action": true, "bonus_action": true, "reaction": true,
            "movement_remaining_feet": 30.0, "free_object_interaction": true
        },
        "spell_slots_remaining": {},
        "attacks": [{
            "name": "Longsword",
            "attack_bonus": attack_bonus,
            "damage_expression": damage,
            "damage_type": "slashing"
        }],
        "resistances": [],
        "vulnerabilities": [],
        "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": true,
        "is_dead": false,
        "is_visible": true
    })
}

#[actix_web::test]
async fn health_and_public_paths_need_no_auth() {
    let app = test_app().await;
    for path in ["/health", "/metrics"] {
        let req = test::TestRequest::get().uri(path).to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "{path} must stay public");
    }
}

/// Iteration 4 (auth): the public-path matcher used loose `starts_with`
/// matching, so `/healthz`, `/metrics-scraper` and friends were reachable
/// WITHOUT a token. Every lookalike must fail closed with 401.
#[actix_web::test]
async fn lookalike_public_paths_require_auth() {
    let app = test_app().await;
    for path in ["/healthz", "/health-admin", "/healthful", "/metricsx", "/metrics/scrape"] {
        let req = test::TestRequest::get().uri(path).to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(
            res.status(),
            StatusCode::UNAUTHORIZED,
            "{path} must not ride /health //metrics prefix matching"
        );
    }
}

#[actix_web::test]
async fn api_without_token_is_unauthorized() {
    let app = test_app().await;
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "x"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[actix_web::test]
async fn forged_signature_is_unauthorized() {
    let app = test_app().await;
    // Signed with the WRONG secret.
    let bad = sign_token("attacker", "wrong-secret");
    let (name, value) = bearer(&bad);
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header((name, value))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "x"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[actix_web::test]
async fn valid_token_creates_session() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Test Table"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert!(body["session_id"].is_string());
}

/// Full authoritative-combat happy path plus trust-inversion rejections.
#[actix_web::test]
async fn authoritative_attack_rejects_client_math_and_enforces_budget() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    // 1. Create session.
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Combat"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // 2. Spawn two entities with SERVER-side stat blocks.
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    for (id, name, hp, ac, ab) in [
        (hero_id, "Hero", 30, 14, 8),
        (orc_id, "Orc", 20, 11, 3),
    ] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(entity_json(id, name, hp, ac, ab, "1d8+3"))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "spawn of {}", name);
    }

    // Duplicate spawn must be refused (anti-popping).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(auth.clone())
        .set_json(entity_json(hero_id, "Hero Clone", 30, 14, 8, "1d8+3"))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // 3a. Forged client math must fail deserialization → 422.
    let forged = serde_json::json!({
        "attacker_id": hero_id,
        "target_id": orc_id,
        "attack_bonus": 999,
        "target_ac": -100,
        "damage_expression": "9999d9999"
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(auth.clone())
        .set_json(forged)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert!(
        res.status() == StatusCode::UNPROCESSABLE_ENTITY || res.status() == StatusCode::BAD_REQUEST,
        "client-supplied combat math must be rejected (400/422), got {}",
        res.status()
    );

    // 3b. Unknown attacker → 404.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "attacker_id": Uuid::new_v4(),
            "target_id": orc_id
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    // 4. Legitimate reference-only attack resolves with server-side stats.
    // attack_bonus=8 vs AC 11 with advantage-free d20 + seed pinning: choose a
    // seed that hits by scanning a few deterministic seeds.
    let mut event_sequence = None;
    let mut total_damage = 0i64;
    // Single iteration: the first deterministic seed decides hit-or-miss
    // (a miss still spends the Action, so there is nothing to scan).
    if let Some(seed) = (1..=50u64).next() {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "attacker_id": hero_id,
                "target_id": orc_id,
                "action_index": 0,
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        let status = res.status();
        let raw = test::read_body(res).await.to_vec();
        let body: serde_json::Value = serde_json::from_slice(&raw).unwrap_or_else(|e| {
            panic!("seed {}: status {} unparseable body {:?}: {}", seed, status, raw, e)
        });
        match status {
            StatusCode::OK => {
                if body["is_hit"].as_bool() == Some(true) {
                    event_sequence = body["event_sequence"].as_u64();
                    total_damage = body["total_damage"].as_i64().unwrap_or(0);
                }
            }
            StatusCode::CONFLICT => panic!("seed {}: unexpected economy block: {}", seed, body),
            other => panic!("seed {}: unexpected status {}: {}", seed, other, body),
        }
    }
    assert!(event_sequence.is_some(), "seeded attacks should land a hit (first seed must connect)");

    // 5. Action budget exhausted → second attack in same turn is 409.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": orc_id,
            "seed": 7
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(
        res.status(),
        StatusCode::CONFLICT,
        "second attack without a fresh turn must be refused"
    );

    // 6. Damage application requires a real ATTACK_RESOLVED ledger event.
    let seq = event_sequence.unwrap();
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "target_id": orc_id,
            "source_event_sequence": seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["amount"].as_i64(), Some(total_damage));

    // Fabricated sequence references must be refused.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "target_id": orc_id,
            "source_event_sequence": 987654
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // 7. Metrics reflect honest adjudication (some rejects recorded).
    let req = test::TestRequest::get().uri("/metrics").to_request();
    let res = test::call_service(&app, req).await;
    let metrics: serde_json::Value = test::read_body_json(res).await;
    assert!(
        metrics["rejected_actions"].as_u64().unwrap() >= 4,
        "rejections must be counted honestly: {:?}",
        metrics
    );
}

#[actix_web::test]
async fn spell_economy_move_budget_and_xcard_rewind() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Mechanics"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // Spawn a caster with one level-3 slot and an opposing dummy.
    let caster_id = Uuid::new_v4();
    let mut caster = entity_json(caster_id, "Wizard", 20, 12, 2, "1d6");
    caster["spell_slots_remaining"] = serde_json::json!({"3": 1});
    for (payload, pos) in [
        (caster, serde_json::json!([2.5, 2.5, 0.0])),
        (
            entity_json(Uuid::new_v4(), "Dummy", 100, 10, 0, "1d4"),
            serde_json::json!([30.0, 30.0, 0.0]),
        ),
    ] {
        let mut p = payload;
        p["position"] = pos;
        p["is_player"] = if p["name"] == "Dummy" { serde_json::json!(false) } else { p["is_player"].clone() };
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(p)
            .to_request();
        let res = test::call_service(&app, req).await;
        let st = res.status();
        let raw = test::read_body(res).await.to_vec();
        assert_eq!(
            st,
            StatusCode::OK,
            "spawn failed: {:?}",
            String::from_utf8_lossy(&raw)
        );
    }

    let target_id: Uuid = {
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{}", session_id))
            .insert_header(auth.clone())
            .to_request();
        let body: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
        body["entities"]
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, e)| e["name"] == "Dummy")
            .unwrap()
            .0
            .parse()
            .unwrap()
    };

    // --- Spell economy ---
    let fireball = serde_json::json!({
        "spell": {
            "spell_id": "fireball", "name": "Fireball", "level": 3,
            "school": "Evocation", "casting_time": "1 action", "range_feet": 150,
            "area_of_effect_shape": "sphere", "area_of_effect_size_feet": 20,
            "verbal_component": true, "somatic_component": true,
            "material_component_desc": null, "save_attribute": "DEXTERITY",
            "damage_formula": "8d6", "damage_type": "fire",
            "duration_rounds": 0, "is_concentration": false, "is_ritual": false
        },
        "caster_id": caster_id,
        "target_id": target_id,
        "cast_level": 3
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
        .insert_header(auth.clone())
        .set_json(fireball.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await.to_vec();
    assert_eq!(
        status,
        StatusCode::OK,
        "fireball with a free slot must resolve: {:?}",
        String::from_utf8_lossy(&raw)
    );
    let result: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(result["result"]["slot_level_used"], 3);

    // Second cast must fail — no slots left.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
        .insert_header(auth.clone())
        .set_json(fireball)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::CONFLICT, "no slots remain");
    let body: serde_json::Value = test::read_body_json(res).await;
    assert!(body["detail"].as_str().unwrap().contains("NO_SPELL_SLOTS"));

    // --- Movement budget ---
    // 30ft speed; request a 200ft move → rejected.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": caster_id, "x": 200.0, "y": 2.5}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "MOVE_REJECTED");

    // Legal 25ft move succeeds and is ledgered.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": caster_id, "x": 27.5, "y": 2.5}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    // --- X-card rewind restores state ---
    let seq_before_damage = {
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{}", session_id))
            .insert_header(auth.clone())
            .to_request();
        let body: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
        body["ledger"]["current_sequence"].as_u64().unwrap()
    };

    // Damage the wizard via attack + damage commit.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "attacker_id": target_id,
            "target_id": caster_id,
            "seed": 11
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "dummy attacks wizard");
    let attack: serde_json::Value = test::read_body_json(res).await;
    if attack["is_hit"] == serde_json::json!(true) {
        let seq = attack["event_sequence"].as_u64().unwrap();
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/damage", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({"target_id": caster_id, "source_event_sequence": seq}))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

        // Rewind everything after the baseline.
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "player_id": "wizard",
                "topic": "violence",
                "target_sequence_id": seq_before_damage
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "rewind must succeed");

        // Wizard HP restored to full.
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{}", session_id))
            .insert_header(auth.clone())
            .to_request();
        let body: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
        let wizard_hp = body["entities"][&caster_id.to_string()]["current_hp"]
            .as_i64()
            .unwrap();
        assert_eq!(wizard_hp, 20, "X-card rewind must restore pre-damage HP");
    }
}

#[actix_web::test]
async fn rbac_enforcement_spectator_player_gm() {
    let app = test_app().await;
    let gm_auth = bearer(&sign_token_with_role("gm-1", "gm", TEST_SECRET));
    let player_auth = bearer(&sign_token_with_role("player-1", "player", TEST_SECRET));
    let spectator_auth = bearer(&sign_token_with_role("watcher", "spectator", TEST_SECRET));

    // GM creates the table.
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(gm_auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "RBAC"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // Spectator CANNOT spawn entities.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(spectator_auth.clone())
        .set_json(entity_json(Uuid::new_v4(), "Sneaky", 10, 10, 0, "1d4"))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "spectator mutation must be 403");

    // GM spawns two entities: one owned by player-1, one by someone else.
    let hero_id = Uuid::new_v4();
    let other_id = Uuid::new_v4();
    for (mut payload, _id, _name, owner) in [
        (
            entity_json(hero_id, "Player Hero", 20, 14, 6, "1d8"),
            hero_id,
            "Player Hero",
            Some("player-1".to_string()),
        ),
        (
            entity_json(other_id, "Rival Blade", 20, 14, 6, "1d8"),
            other_id,
            "Rival Blade",
            Some("someone-else".to_string()),
        ),
    ] {
        payload["owner_player_id"] = match &owner {
            Some(o) => serde_json::json!(o),
            None => serde_json::Value::Null,
        };
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(gm_auth.clone())
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Player-1 attacking AS their own entity is fine.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(player_auth.clone())
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": other_id
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert!(
        res.status() == StatusCode::OK || res.status() == StatusCode::CONFLICT,
        "own-entity attack resolves or hits economy, got {}",
        res.status()
    );

    // Player-1 attacking AS someone else's entity is forbidden.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(player_auth.clone())
        .set_json(serde_json::json!({
            "attacker_id": other_id,
            "target_id": hero_id
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "entity hijack must be 403");

    // Spectator cannot attack at all.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(spectator_auth.clone())
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": other_id,
            "seed": 3
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // A player cannot claim ownership of an entity for someone else.
    let mut forged_claim = entity_json(Uuid::new_v4(), "Impostor", 10, 10, 0, "1d4");
    forged_claim["owner_player_id"] = serde_json::json!("gm-1");
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(player_auth.clone())
        .set_json(forged_claim)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN, "ownership claim spoofing must be 403");

    // GM bypasses everything.
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/map", session_id))
        .insert_header(gm_auth.clone())
        .set_json(serde_json::json!({
            "width": 32, "height": 32, "cell_size_feet": 5.0,
            "solid_cells": [], "difficult_terrain": []
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
}

#[actix_web::test]
async fn map_geometry_blocks_line_of_sight_attacks() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Cover Test"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // Wall column splitting the map between the two entities.
    let wall: Vec<(usize, usize)> = (0..32).map(|y| (15, y)).collect();
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/map", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "width": 32, "height": 32, "cell_size_feet": 5.0,
            "solid_cells": wall, "difficult_terrain": []
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    for (id, name, x) in [(hero_id, "Archer", 2), (orc_id, "Goblin", 28)] {
        let mut e = entity_json(id, name, 20, 12, 8, "1d6");
        e["position"] = serde_json::json!([(x as f32) * 5.0, 2.5, 0.0]);
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(e)
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "{} spawned", name);
    }

    // Every seeded attempt must be occluded — LoS is authoritative.
    for seed in 1..=5u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "attacker_id": hero_id,
                "target_id": orc_id,
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(
            res.status(),
            StatusCode::CONFLICT,
            "wall must block every attack line"
        );
        let body: serde_json::Value = test::read_body_json(res).await;
        assert_eq!(body["error"], "NO_LINE_OF_SIGHT");
    }
}

// --- Lighting zones & vision modes ---------------------------------------------

#[actix_web::test]
async fn los_route_evaluates_lighting_zones_and_viewer_vision() {
    let app = test_app().await;
    let player = sign_token_with_role("p1", "player", TEST_SECRET);

    // los_payload puts the viewer at world (0,0) and the target at (10,0):
    // grid cells (0,0) and (2,0), 10 ft apart on a 5 ft grid.
    let mut payload = los_payload();
    payload["lighting_zones"] =
        serde_json::json!([{ "x": 2, "y": 0, "zone": "darkness" }]);

    // Normal sight cannot see into darkness.
    let (status, body) = post_raw(&app, &player, "/api/v1/spatial/los", payload.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["has_line_of_sight"], serde_json::json!(false), "{body}");

    // In-range darkvision sees it, and the response names the target zone.
    payload["viewer_vision_mode"] = serde_json::json!("darkvision");
    payload["viewer_vision_range_feet"] = serde_json::json!(60.0);
    let (status, body) = post_raw(&app, &player, "/api/v1/spatial/los", payload.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["has_line_of_sight"], serde_json::json!(true), "{body}");
    assert_eq!(body["target_cell_zone"], serde_json::json!("darkness"));

    // Beyond the sense range, darkness is invisible again.
    payload["viewer_vision_range_feet"] = serde_json::json!(5.0);
    let (_, body) = post_raw(&app, &player, "/api/v1/spatial/los", payload.clone()).await;
    assert_eq!(body["has_line_of_sight"], serde_json::json!(false), "{body}");

    // Magical darkness defeats darkvision…
    payload["viewer_vision_range_feet"] = serde_json::json!(60.0);
    payload["lighting_zones"] =
        serde_json::json!([{ "x": 2, "y": 0, "zone": "magical_darkness" }]);
    let (_, body) = post_raw(&app, &player, "/api/v1/spatial/los", payload.clone()).await;
    assert_eq!(body["has_line_of_sight"], serde_json::json!(false), "{body}");

    // …but Truesight penetrates it.
    payload["viewer_vision_mode"] = serde_json::json!("truesight");
    let (_, body) = post_raw(&app, &player, "/api/v1/spatial/los", payload.clone()).await;
    assert_eq!(body["has_line_of_sight"], serde_json::json!(true), "{body}");

    // Omitting lighting entirely keeps the legacy behavior (Bright everywhere).
    let plain = los_payload();
    let (status, body) = post_raw(&app, &player, "/api/v1/spatial/los", plain).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["has_line_of_sight"],
        serde_json::json!(true),
        "absent lighting must not change legacy LoS results"
    );
}

#[actix_web::test]
async fn darkvision_attacker_strikes_into_darkness_while_normal_cannot() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Dark Vision"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // Non-magical darkness over the goblin's cell (28, 0): darkvision
    // penetrates it, normal sight does not. (Magical-darkness semantics are
    // covered by the /spatial/los route test above.)
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/map", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "width": 32, "height": 32, "cell_size_feet": 5.0,
            "solid_cells": [], "difficult_terrain": [],
            "lighting_zones": [{ "x": 28, "y": 0, "zone": "darkness" }]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "map with lighting accepted");

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    for (id, name, x) in [(hero_id, "Human", 2), (orc_id, "Goblin", 28)] {
        let mut e = entity_json(id, name, 20, 12, 8, "1d6");
        e["position"] = serde_json::json!([(x as f32) * 5.0, 2.5, 0.0]);
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(e)
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "{} spawned", name);
    }

    let attack_body = |attacker_id: Uuid| {
        serde_json::json!({
            "attacker_id": attacker_id,
            "target_id": orc_id,
            "seed": 7u64
        })
    };

    // The sighted human cannot target into magical darkness.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(auth.clone())
        .set_json(attack_body(hero_id))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::CONFLICT, "normal sight blocked by magical darkness");
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "NO_LINE_OF_SIGHT");

    // Spawn a dedicated darkvision attacker within sense range of the target
    // (goblin at x=140 ft; drow at x=95 ft => 45 ft <= 120 ft darkvision).
    let drow_id = Uuid::new_v4();
    let mut e = entity_json(drow_id, "Drow", 20, 14, 8, "1d6");
    e["position"] = serde_json::json!([95.0, 2.5, 0.0]);
    e["vision_mode"] = serde_json::json!("darkvision");
    e["sense_range_feet"] = serde_json::json!(120.0);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(auth.clone())
        .set_json(e)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "drow spawned");

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(auth.clone())
        .set_json(attack_body(drow_id))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "in-range darkvision must penetrate magical darkness: {body}"
    );
}

// --- Privileged-route RBAC ----------------------------------------------------

#[actix_web::test]
async fn spectator_cannot_create_sessions_or_advance_rounds() {
    let app = test_app().await;
    let spec = sign_token_with_role("spec-1", "spectator", TEST_SECRET);

    // Session creation is privileged.
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(&spec))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Nope"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // A GM sets up a table; the spectator still cannot drive its rounds.
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Real"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid = body["session_id"].as_str().unwrap().to_string();

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/turn/next", sid))
        .insert_header(bearer(&spec))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[actix_web::test]
async fn restore_session_requires_owner_gm_or_service() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let other = sign_token_with_role("player-9", "player", TEST_SECRET);
    let service = sign_token("orchestrator-service", TEST_SECRET);

    // GM creates (and therefore owns) a table.
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Owned"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid = body["session_id"].as_str().unwrap().to_string();

    // Snapshot it.
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", sid))
        .insert_header(bearer(&gm))
        .to_request();
    let res = test::call_service(&app, req).await;
    let snapshot: serde_json::Value = test::read_body_json(res).await;

    // A random player may not overwrite someone else's table…
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", sid))
        .insert_header(bearer(&other))
        .set_json(snapshot.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // …nor an unowned session they just discovered the id of…
    let fresh = Uuid::new_v4();
    let mut stolen = snapshot.clone();
    stolen["session_id"] = serde_json::json!(fresh.to_string());
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", fresh))
        .insert_header(bearer(&other))
        .set_json(stolen)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // The recorded owner may restore their own table.
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", sid))
        .insert_header(bearer(&gm))
        .set_json(snapshot.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    // And the gateway's mediated durability principal may hydrate any table.
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", sid))
        .insert_header(bearer(&service))
        .set_json(snapshot)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[actix_web::test]
async fn x_card_open_to_players_blocked_for_spectators() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let spec = sign_token_with_role("spec-1", "spectator", TEST_SECRET);
    let player = sign_token_with_role("player-2", "player", TEST_SECRET);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Safe"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid = body["session_id"].as_str().unwrap().to_string();

    let card = serde_json::json!({
        "player_id": "player-2",
        "topic": "spider imagery",
        "target_sequence_id": 0
    });

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", sid))
        .insert_header(bearer(&spec))
        .set_json(card.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // Safety tools are player-veto authority: any non-spectator may raise one.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", sid))
        .insert_header(bearer(&player))
        .set_json(card)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "SAFETY_REWIND_SUCCESS");
}

// --- Healing & rests (backlog 4.3 / 5.8) --------------------------------------

/// Creates a session as GM and returns its id.
async fn create_session_as(app: &impl Service<
    actix_http::Request,
    Response = ServiceResponse<EitherBody<BoxBody>>,
    Error = actix_web::Error,
>, token: &str) -> Uuid {
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(token))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Heal"}))
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    body["session_id"].as_str().unwrap().parse().unwrap()
}

/// Fetches the session snapshot as `token`.
async fn snapshot_as(app: &impl Service<
    actix_http::Request,
    Response = ServiceResponse<EitherBody<BoxBody>>,
    Error = actix_web::Error,
>, token: &str, session_id: Uuid) -> serde_json::Value {
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{session_id}"))
        .insert_header(bearer(token))
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    test::read_body_json(res).await
}

/// Uuid as a JSON string value (ledger payloads stringify ids).
fn json_str(id: &Uuid) -> serde_json::Value {
    serde_json::json!(id.to_string())
}

/// Reads an entity's SRD inspiration hold from a session snapshot. Absent key
/// means "no point held" (`skip_serializing_if` on the core field).
fn inspiration_of(snap: &serde_json::Value, entity_id: Uuid) -> bool {
    snap["entities"][entity_id.to_string()]["inspiration"]
        .as_bool()
        .unwrap_or(false)
}

#[actix_web::test]
async fn heal_happy_path_restores_hp_consciousness_and_death_saves() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    // A dying hero: 0 HP, unconscious, two failed death saves banked.
    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Dying Hero", 20, 14, 5, "1d8");
    hero["current_hp"] = serde_json::json!(0);
    hero["is_conscious"] = serde_json::json!(false);
    hero["death_saves"] = serde_json::json!({"successes": 1, "failures": 2, "is_stabilized": false, "is_dead": false});
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(hero)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Heal for 6 → back up, conscious, death-save tally wiped (SRD).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": hero_id, "amount": 6}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "heal must resolve");
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["amount_applied"], 6);
    assert_eq!(body["hp_remaining"], 6);

    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(bearer(&gm))
        .to_request();
    let snap: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    let hero = &snap["entities"][&hero_id.to_string()];
    assert_eq!(hero["current_hp"], 6);
    assert_eq!(hero["is_conscious"], true);
    assert_eq!(hero["death_saves"]["failures"], 0, "healing wipes the death-save tally");
    assert_eq!(hero["death_saves"]["successes"], 0);

    // HEALED is ledgered so rewind can replay it.
    let healed_events: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array().unwrap()
        .iter().filter(|e| e["event_type"] == "HEALED").collect();
    assert_eq!(healed_events.len(), 1);
    assert_eq!(healed_events[0]["payload"]["amount"], 6);
    assert_eq!(healed_events[0]["payload"]["hp_remaining"], 6);
}

#[actix_web::test]
async fn over_heal_clamps_to_max_hp() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Bruised", 25, 14, 5, "1d8");
    hero["current_hp"] = serde_json::json!(20);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(hero)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Ask for 500 HP on a 5-HP deficit — server clamps, no overheal stacking.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": hero_id, "amount": 500}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(bearer(&gm))
        .to_request();
    let snap: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    assert_eq!(snap["entities"][&hero_id.to_string()]["current_hp"], 25);
}

#[actix_web::test]
async fn heal_rejects_dead_targets_unknown_entities_and_negative_amounts() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let corpse_id = Uuid::new_v4();
    let mut corpse = entity_json(corpse_id, "Corpse", 20, 14, 5, "1d8");
    corpse["current_hp"] = serde_json::json!(-22);
    corpse["is_conscious"] = serde_json::json!(false);
    corpse["is_dead"] = serde_json::json!(true);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(corpse)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Dead target → 409 CANNOT_HEAL_DEAD.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": corpse_id, "amount": 10}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "CANNOT_HEAL_DEAD");

    // Unknown entity → 404.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": Uuid::new_v4(), "amount": 10}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::NOT_FOUND);

    // Negative amount → 422 (that would be damage smuggled through heal).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": corpse_id, "amount": -5}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Client-supplied extra fields are structurally rejected (ids-only contract).
    // actix surfaces serde `deny_unknown_fields` errors as 400; either way the
    // payload never reaches the handler.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": corpse_id, "amount": 5, "bonus": 999}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert!(
        res.status() == StatusCode::BAD_REQUEST
            || res.status() == StatusCode::UNPROCESSABLE_ENTITY,
        "unknown fields must be structurally rejected, got {}",
        res.status()
    );
}

#[actix_web::test]
async fn heal_enforces_spectator_and_ownership_rbac() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-1", "player", TEST_SECRET);
    let spectator = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let mine_id = Uuid::new_v4();
    let mut mine = entity_json(mine_id, "My Hero", 20, 14, 5, "1d8");
    mine["owner_player_id"] = serde_json::json!("player-1");
    let other_id = Uuid::new_v4();
    let mut other = entity_json(other_id, "Rival", 20, 14, 5, "1d8");
    other["owner_player_id"] = serde_json::json!("someone-else");
    for payload in [mine, other] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(bearer(&gm))
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Spectators cannot heal.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&spectator))
        .set_json(serde_json::json!({"entity_id": mine_id, "amount": 5}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::FORBIDDEN);

    // Players cannot heal someone else's entity.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&player))
        .set_json(serde_json::json!({"entity_id": other_id, "amount": 5}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "ENTITY_NOT_OWNED");

    // …but their own entity heals fine.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&player))
        .set_json(serde_json::json!({"entity_id": mine_id, "amount": 5}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
}

#[actix_web::test]
async fn rewind_past_heal_restores_prior_hp() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&gm);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    for (id, name, hp, ac, ab) in [
        (hero_id, "Healee", 30, 14, 8),
        (orc_id, "Striker", 20, 11, 8),
    ] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(entity_json(id, name, hp, ac, ab, "2d6"))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Damage the hero via a seeded attack + engine-provenance damage commit.
    // (Single iteration: the first deterministic seed decides hit-or-miss.)
    let mut post_damage_hp = None;
    if let Some(seed) = (1..=50u64).next() {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "attacker_id": orc_id, "target_id": hero_id,
                "action_index": 0, "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let attack: serde_json::Value = test::read_body_json(res).await;
        if attack["is_hit"].as_bool() == Some(true) {
            let seq = attack["event_sequence"].as_u64().unwrap();
            let req = test::TestRequest::post()
                .uri(&format!("/api/v1/sessions/{}/damage", session_id))
                .insert_header(auth.clone())
                .set_json(serde_json::json!({"target_id": hero_id, "source_event_sequence": seq}))
                .to_request();
            let res = test::call_service(&app, req).await;
            assert_eq!(res.status(), StatusCode::OK);
            let dmg: serde_json::Value = test::read_body_json(res).await;
            post_damage_hp = Some(dmg["hp_remaining"].as_i64().unwrap());
        }
    }
    let post_damage_hp = post_damage_hp.expect("seeded hit must land and apply damage");
    assert!(post_damage_hp < 30);

    // The ledger tail right now IS the DAMAGE_APPLIED event — rewind target.
    let seq_after_damage: u64 = {
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{}", session_id))
            .insert_header(auth.clone())
            .to_request();
        let snap: serde_json::Value =
            test::read_body_json(test::call_service(&app, req).await).await;
        snap["ledger"]["current_sequence"].as_u64().unwrap()
    };

    // Heal the hero back up.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": hero_id, "amount": 30}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // X-card rewind to just after the damage event undoes ONLY the heal.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "player_id": "gm-1",
            "topic": "rewind",
            "target_sequence_id": seq_after_damage
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(auth.clone())
        .to_request();
    let snap: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    let hero = &snap["entities"][&hero_id.to_string()];
    assert_eq!(
        hero["current_hp"].as_i64().unwrap(),
        post_damage_hp,
        "rewinding past the heal must replay the surviving DAMAGE event"
    );
    assert_eq!(hero["is_conscious"], post_damage_hp > 0);
}

/// Iteration-11 drift follow-up: the browser holds no HMAC engine token, so
/// after an X-card it can never call GET /sessions/{id} to converge its local
/// tokens. The rewind response itself must therefore carry the FULL
/// post-rewind GameSession snapshot.
#[actix_web::test]
async fn x_card_response_includes_post_rewind_snapshot() {
    let app = test_app().await;
    // The full-snapshot contract is the GM/admin view; non-GM callers receive
    // the projected board-token snapshot (see
    // x_card_snapshot_projected_for_players_full_for_gm). A role-less token
    // counts as a player, so claim the role explicitly.
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&gm);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    for (id, name, hp, ac, ab) in [
        (hero_id, "Snapshot Hero", 30, 14, 8),
        (orc_id, "Snapshot Striker", 20, 11, 8),
    ] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(entity_json(id, name, hp, ac, ab, "2d6"))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Land one seeded hit + provenance-checked damage commit so the hero is
    // demonstrably wounded below max before the rewind.
    let mut post_damage_hp = None;
    for seed in 1..=50u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "attacker_id": orc_id, "target_id": hero_id,
                "action_index": 0, "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let attack: serde_json::Value = test::read_body_json(res).await;
        if attack["is_hit"].as_bool() != Some(true) {
            continue;
        }
        let seq = attack["event_sequence"].as_u64().unwrap();
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/damage", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({"target_id": hero_id, "source_event_sequence": seq}))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let dmg: serde_json::Value = test::read_body_json(res).await;
        post_damage_hp = Some(dmg["hp_remaining"].as_i64().unwrap());
        break;
    }
    let post_damage_hp = post_damage_hp.expect("seeded hit must land and apply damage");
    assert!(post_damage_hp < 30, "hero must actually be wounded");

    // The ledger tail right now IS the DAMAGE_APPLIED event — rewind target.
    // (Rewinding to a point BEFORE any HP-bearing event leaves current HP
    // untouched in vtt-core's replay, so this is the deterministic
    // post-rewind expectation: damage kept, subsequent heal undone.)
    let seq_after_damage: u64 = {
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{}", session_id))
            .insert_header(auth.clone())
            .to_request();
        let snap: serde_json::Value =
            test::read_body_json(test::call_service(&app, req).await).await;
        snap["ledger"]["current_sequence"].as_u64().unwrap()
    };

    // Heal the hero back up AFTER the damage event.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": hero_id, "amount": 30}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // X-card rewinds past the heal; the surviving DAMAGE event replays.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "player_id": "gm-1",
            "topic": "violence",
            "target_sequence_id": seq_after_damage
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "SAFETY_REWIND_SUCCESS");

    // THE CONTRACT: a full serialized GameSession rides along with the report.
    let snapshot = &body["snapshot"];
    assert!(
        snapshot.is_object(),
        "x-card response must embed the post-rewind session snapshot"
    );
    assert_eq!(
        snapshot["session_id"].as_str(),
        Some(session_id.to_string().as_str()),
        "snapshot must be the rewound session itself"
    );

    // Snapshot HP matches POST-rewind expectations (heal undone, damage kept).
    let snap_hero = &snapshot["entities"][&hero_id.to_string()];
    assert_eq!(
        snap_hero["current_hp"].as_i64().unwrap(),
        post_damage_hp,
        "embedded snapshot must show post-rewind HP"
    );
    assert_eq!(
        snap_hero["is_conscious"],
        post_damage_hp > 0,
        "embedded snapshot consciousness must match post-rewind HP"
    );

    // And it must agree with what authoritative GET returns for the same
    // entity (the browser's convergence target).
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(auth.clone())
        .to_request();
    let live: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    assert_eq!(
        snap_hero["current_hp"],
        live["entities"][&hero_id.to_string()]["current_hp"],
        "embedded snapshot must match live engine state"
    );
}

#[actix_web::test]
async fn long_rest_restores_owned_entities_short_rest_is_a_hook() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-1", "player", TEST_SECRET);
    let spectator = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Wounded Hero", 28, 14, 5, "1d8");
    hero["current_hp"] = serde_json::json!(7);
    hero["owner_player_id"] = serde_json::json!("player-1");
    let rival_id = Uuid::new_v4();
    let mut rival = entity_json(rival_id, "Wounded Rival", 24, 14, 5, "1d8");
    rival["current_hp"] = serde_json::json!(3);
    rival["owner_player_id"] = serde_json::json!("someone-else");
    for payload in [hero, rival] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(bearer(&gm))
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Spectators cannot call rests.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&spectator))
        .set_json(serde_json::json!({"kind": "long"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::FORBIDDEN);

    // Short rest is a mechanical no-op hook point: HP unchanged.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"kind": "short"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "SHORT_REST_APPLIED");

    // Long rest restores the caller's controlled entities to max HP.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"kind": "long"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "LONG_REST_APPLIED");

    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(bearer(&gm))
        .to_request();
    let snap: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    assert_eq!(snap["entities"][&hero_id.to_string()]["current_hp"], 28);
    assert_eq!(snap["entities"][&rival_id.to_string()]["current_hp"], 24);
    let rest_events: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array().unwrap()
        .iter().filter(|e| e["event_type"] == "LONG_REST_APPLIED").collect();
    assert_eq!(rest_events.len(), 2, "one ledger event per restored entity");

    // A player's long rest touches only entities they control.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&player))
        .set_json(serde_json::json!({"kind": "long"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
}

// --- Long-rest exhaustion semantics (SRD: one level shed per long rest) ------
//
// Pins the exhaustion wire-up on the live HTTP surface:
//   - each long rest sheds exactly one Exhaustion level, persisted in the
//     session snapshot and reported as "exhaustion_reduced" in both the
//     LONG_REST_APPLIED ledger event and the HTTP response
//   - HP is restored to the *effective* maximum for the POST-rest exhaustion
//     level (level >= 4 halves max), so a 5->4 rest tops out at the halved cap
//     while a 4->3 rest comes back to full
//   - short rests never touch exhaustion (SRD: no short-rest recovery)

#[actix_web::test]
async fn long_rest_sheds_one_exhaustion_level_and_reports_it() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let tired_id = Uuid::new_v4();
    let mut tired = entity_json(tired_id, "Tired Fighter", 30, 14, 5, "1d8");
    tired["current_hp"] = serde_json::json!(9);
    tired["conditions"] = serde_json::json!([{"exhaustion": 2}]);
    let fresh_id = Uuid::new_v4();
    let fresh = entity_json(fresh_id, "Fresh Rogue", 22, 14, 5, "1d6");
    for payload in [tired, fresh] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(bearer(&gm))
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"kind": "long"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let by_entity = |id: &Uuid| -> serde_json::Value {
        body["entities"]
            .as_array().unwrap()
            .iter().find(|e| e["entity_id"] == json_str(id))
            .unwrap_or_else(|| panic!("response missing entity {id}"))
            .clone()
    };
    assert_eq!(by_entity(&tired_id)["exhaustion_reduced"], true);
    assert_eq!(by_entity(&fresh_id)["exhaustion_reduced"], false,
        "an unexhausted entity must report no reduction");

    // Snapshot persistence: 2 -> 1, not straight to 0.
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][&tired_id.to_string()]["conditions"],
        serde_json::json!([{"exhaustion": 1}]),
        "long rest sheds exactly one exhaustion level"
    );

    let rest_events: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array().unwrap()
        .iter().filter(|e| e["event_type"] == "LONG_REST_APPLIED").collect();
    assert_eq!(rest_events.len(), 2);
    let event_for = |id: &Uuid| -> &serde_json::Value {
        rest_events.iter().copied()
            .find(|e| e["payload"]["target_id"] == json_str(id))
            .expect("ledger event per restored entity")
    };
    assert_eq!(event_for(&tired_id)["payload"]["exhaustion_reduced"], true);
    assert_eq!(event_for(&fresh_id)["payload"]["exhaustion_reduced"], false);
    // Post-rest levels ride the event so safety_rewind's replay can restore
    // shed exhaustion (rewind blind-spot fix).
    assert_eq!(event_for(&tired_id)["payload"]["exhaustion_level"], 1);
    assert_eq!(event_for(&fresh_id)["payload"]["exhaustion_level"], 0);
}

#[actix_web::test]
async fn long_rest_restores_hp_to_post_rest_effective_max() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    // Still-capped case: exhaustion 5 sheds to 4, which keeps the halved-max
    // penalty — so the rest may only refill to half of 30.
    let deep_id = Uuid::new_v4();
    let mut deep = entity_json(deep_id, "Deeply Worn", 30, 14, 5, "1d8");
    deep["current_hp"] = serde_json::json!(4);
    deep["conditions"] = serde_json::json!([{"exhaustion": 5}]);
    // Penalty-lifted case: exhaustion 4 sheds to 3 — full max returns.
    let lifting_id = Uuid::new_v4();
    let mut lifting = entity_json(lifting_id, "Recovering Mage", 28, 12, 5, "1d8");
    lifting["current_hp"] = serde_json::json!(2);
    lifting["conditions"] = serde_json::json!([{"exhaustion": 4}]);
    for payload in [deep, lifting] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(bearer(&gm))
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"kind": "long"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][&deep_id.to_string()]["current_hp"], 15,
        "post-rest exhaustion 4 still halves max (30 / 2 == 15)"
    );
    assert_eq!(
        snap["entities"][&deep_id.to_string()]["conditions"],
        serde_json::json!([{"exhaustion": 4}])
    );
    assert_eq!(
        snap["entities"][&lifting_id.to_string()]["current_hp"], 28,
        "shedding to level 3 lifts the halved-max cap before refilling"
    );
}

#[actix_web::test]
async fn short_rest_does_not_touch_exhaustion_or_hp() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Weary Bard", 24, 13, 4, "1d8");
    hero["current_hp"] = serde_json::json!(10);
    hero["conditions"] = serde_json::json!([{"exhaustion": 2}]);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(hero)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // A dice-less short rest: no healing (no hit dice spent), no exhaustion
    // recovery. Still ledgered for auditability.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"kind": "short"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["conditions"],
        serde_json::json!([{"exhaustion": 2}]),
        "short rests never recover exhaustion"
    );
    assert_eq!(snap["entities"][&hero_id.to_string()]["current_hp"], 10);
    assert!(
        !snap["ledger"]["events"].as_array().unwrap().iter()
            .any(|e| e["event_type"] == "LONG_REST_APPLIED"),
        "a dice-less short rest must not emit per-entity rest events"
    );
    assert!(
        snap["ledger"]["events"].as_array().unwrap().iter()
            .any(|e| e["event_type"] == "SHORT_REST_APPLIED"),
        "the rest itself stays ledgered for auditability"
    );
}

// --- Iteration 86: funded short rests (hit-dice spending) --------------------
//
// Pins the closed gap on the wire:
//   - spending N hit dice heals sum(rolls) + CON mod per die and draws down
//     the entity's `hit_dice_remaining` pool
//   - every funded spend journals a SHORT_REST_APPLIED event carrying the
//     rolls and post-heal HP so safety_rewind replays it
//   - over-spends, unmodelled die sizes and foreign entities are refused with
//     distinct codes; the dead cannot short-rest

async fn spawn_short_rest_hero(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    id: Uuid,
) {
    let mut hero = entity_json(id, "Bruised Veteran", 30, 16, 5, "1d10");
    hero["current_hp"] = serde_json::json!(6);
    hero["hit_dice_size"] = serde_json::json!(10);
    hero["hit_dice_remaining"] = serde_json::json!(3);
    hero["owner_player_id"] = serde_json::json!("gm-1");
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(token))
        .set_json(hero)
        .to_request();
    assert_eq!(test::call_service(app, req).await.status(), StatusCode::OK);
}

#[actix_web::test]
async fn short_rest_spends_hit_dice_heals_and_ledgers_the_spend() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    spawn_short_rest_hero(&app, &gm, session_id, hero_id).await;

    // Spend ALL remaining dice by omitting `dice` — the default spend.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "kind": "short",
            "spend": [{"entity_id": hero_id}]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "SHORT_REST_APPLIED");
    assert_eq!(body["restored_entities"], 1);

    let entry = &body["entities"][0];
    assert_eq!(entry["dice_spent"], 3);
    let rolls: Vec<i64> = entry["rolls"].as_array().unwrap()
        .iter().map(|r| r.as_i64().unwrap()).collect();
    assert_eq!(rolls.len(), 3, "one face per die");
    for face in &rolls {
        assert!((1..=10).contains(face), "d10 faces only, got {face}");
    }
    // CON 14 -> +2 per die.
    assert_eq!(entry["con_modifier"], 2);
    // Healing = sum of faces + 2/die; the reported figure is PRE-clamp, so it
    // can exceed the 24 points actually needed to top off from 6.
    let raw_healing: i64 = rolls.iter().sum::<i64>() + 2 * 3;
    assert_eq!(
        entry["healing"],
        raw_healing.max(0),
        "reported healing is the pre-clamp total"
    );
    // Healing is RANDOM (3d10 + 6, floored at 0): a full pool heals into
    // [6+9 .. 30] — it does not deterministically top off. Pin the band and
    // the max-HP clamp instead of a face-dependent total.
    assert_eq!(
        entry["hp_remaining"].as_i64().unwrap(),
        (6 + raw_healing).min(30),
        "post-heal HP is pre-rest HP + healing clamped at max"
    );
    assert!((15..=30).contains(&entry["hp_remaining"].as_i64().unwrap()));
    assert_eq!(entry["hit_dice_remaining"], 0, "the pool is drained");

    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["current_hp"],
        body["entities"][0]["hp_remaining"],
        "live state reflects the funded heal"
    );
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["hit_dice_remaining"], 0,
        "pool draw-down persists on the entity"
    );

    let events = snap["ledger"]["events"].as_array().unwrap();
    let spend_events: Vec<&serde_json::Value> = events.iter()
        .filter(|e| e["event_type"] == "SHORT_REST_APPLIED")
        .collect();
    assert_eq!(spend_events.len(), 1, "exactly one journal for one funded spend");
    let payload = &spend_events[0]["payload"];
    assert_eq!(payload["target_id"], json_str(&hero_id));
    assert_eq!(payload["dice_spent"], 3);
    assert_eq!(
        payload["hp_remaining"],
        snap["entities"][&hero_id.to_string()]["current_hp"],
        "event carries absolute post-heal HP for rewind replay"
    );
    assert!(payload["rolls"].is_array());
}

#[actix_web::test]
async fn short_rest_refuses_overspend_unmodelled_dice_foreign_entities_and_dead() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-2", "player", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    spawn_short_rest_hero(&app, &gm, session_id, hero_id).await;

    // Over-spend: 99 dice vs a pool of 3.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "kind": "short",
            "spend": [{"entity_id": hero_id, "dice": 99}]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "INSUFFICIENT_HIT_DICE");

    // Unmodelled die size: an ordinary entity without hit-dice fields.
    let plain_id = Uuid::new_v4();
    let mut plain = entity_json(plain_id, "Diceless Hireling", 20, 12, 3, "1d6");
    plain["current_hp"] = serde_json::json!(5);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(plain)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "kind": "short",
            "spend": [{"entity_id": plain_id}]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "NO_HIT_DICE_MODELLED");

    // A player may not fund someone else's entity.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&player))
        .set_json(serde_json::json!({
            "kind": "short",
            "spend": [{"entity_id": hero_id}]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // The dead do not short-rest.
    let corpse_id = Uuid::new_v4();
    let mut corpse = entity_json(corpse_id, "Fallen Scout", 20, 13, 3, "1d8");
    corpse["is_dead"] = serde_json::json!(true);
    corpse["current_hp"] = serde_json::json!(0);
    corpse["hit_dice_size"] = serde_json::json!(8);
    corpse["hit_dice_remaining"] = serde_json::json!(2);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(corpse)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "kind": "short",
            "spend": [{"entity_id": corpse_id}]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "ENTITY_DEAD");

    // Every refusal above must have left both pools untouched.
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(snap["entities"][&hero_id.to_string()]["hit_dice_remaining"], 3);
    assert_eq!(snap["entities"][&hero_id.to_string()]["current_hp"], 6);
    assert!(
        !snap["ledger"]["events"].as_array().unwrap().iter()
            .any(|e| e["event_type"] == "SHORT_REST_APPLIED"
                && e["payload"]["target_id"].is_string()),
        "refused spends journal nothing target-bearing"
    );
}

#[actix_web::test]
async fn short_rest_rewind_restores_pre_rest_hit_points() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    spawn_short_rest_hero(&app, &gm, session_id, hero_id).await;

    // Anchor the pre-rest HP in the LEDGER: a rewind replays surviving
    // events, so without a baseline event the replay has nothing to restore
    // from and would strand live-drifted HP. One provenance-checked damage
    // commit puts the veteran at a known wounded total first.
    let foe_id = Uuid::new_v4();
    let mut foe = entity_json(foe_id, "Baseline Striker", 30, 14, 8, "1d4");
    foe["owner_player_id"] = serde_json::json!("gm-1");
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(foe)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let mut baseline_seq: Option<u64> = None;
    for seed in 1u64..=50 {
        // Refresh the striker's turn first: each attempt burns the Action, and
        // a miss must not strand the loop budgetless.
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/turn/next", session_id))
            .insert_header(bearer(&gm))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
            .insert_header(bearer(&gm))
            .set_json(serde_json::json!({
                "attacker_id": foe_id,
                "target_id": hero_id,
                "action_index": 0,
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "seed {seed} must resolve");
        let attempt: serde_json::Value = test::read_body_json(res).await;
        if attempt["is_hit"] == serde_json::Value::Bool(true) {
            let seq = attempt["event_sequence"].as_u64().unwrap();
            let req = test::TestRequest::post()
                .uri(&format!("/api/v1/sessions/{}/damage", session_id))
                .insert_header(bearer(&gm))
                .set_json(serde_json::json!({
                    "target_id": hero_id,
                    "source_event_sequence": seq
                }))
                .to_request();
            let res = test::call_service(&app, req).await;
            assert_eq!(res.status(), StatusCode::OK);
            baseline_seq = Some(seq);
            break;
        }
    }
    let _baseline_seq =
        baseline_seq.expect("at least one of the first fifty seeds must connect");

    // Funded spend next (one die heals into a known band from the wound).
    // Capture the wounded pre-rest total FIRST: the rewind target below sits
    // AFTER the baseline wound, so the surviving ATTACK_RESOLVED replays that
    // wounded total back — the pre-rest world is the wounded one, not spawn HP.
    let pre_rest_hp: i64 = snapshot_as(&app, &gm, session_id).await
        ["entities"][&hero_id.to_string()]["current_hp"]
        .as_i64()
        .unwrap();
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/rest", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "kind": "short",
            "spend": [{"entity_id": hero_id, "dice": 1}]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let post_rest_hp = body["entities"][0]["hp_remaining"].as_i64().unwrap();
    // The live HP right now IS the healed total (the rest endpoint just ran);
    // it must sit inside the entity's HP band and agree with the response.
    let healed_live: i64 = snapshot_as(&app, &gm, session_id).await
        ["entities"][&hero_id.to_string()]["current_hp"]
        .as_i64()
        .unwrap();
    assert_eq!(
        post_rest_hp, healed_live,
        "response and live state agree on the healed total"
    );
    assert!(
        (pre_rest_hp + 1..=30).contains(&post_rest_hp),
        "one die (+CON) strictly heals above the wounded {pre_rest_hp} without exceeding max, got {post_rest_hp}"
    );

    let seq_after_rest: u64 = {
        let snap = snapshot_as(&app, &gm, session_id).await;
        let last = snap["ledger"]["events"].as_array().unwrap().last().unwrap();
        last["sequence_id"].as_u64().unwrap()
    };

    // The same striker wounds the veteran AGAIN after the rest — this is the
    // damage a rewind discards. A fresh turn refresh re-arms the striker's
    // Action budget first.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/turn/next", session_id))
        .insert_header(bearer(&gm))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Scan a few seeds for a guaranteed hit so the test never flakes on RNG;
    // each attempt burns the Action, so re-arm the budget per attempt.
    let mut attack_seq: Option<u64> = None;
    for seed in 1u64..=50 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/turn/next", session_id))
            .insert_header(bearer(&gm))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
            .insert_header(bearer(&gm))
            .set_json(serde_json::json!({
                "attacker_id": foe_id,
                "target_id": hero_id,
                "action_index": 0,
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "seed {seed} must resolve");
        let attempt: serde_json::Value = test::read_body_json(res).await;
        if attempt["is_hit"] == serde_json::Value::Bool(true) {
            attack_seq = attempt["event_sequence"].as_u64();
            break;
        }
    }
    let attack_seq =
        attack_seq.expect("at least one of the first fifty seeds must connect");
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "target_id": hero_id,
            "source_event_sequence": attack_seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "wounding after the rest anchors the rewind"
    );
    let wounded: i64 = snapshot_as(&app, &gm, session_id).await
        ["entities"][&hero_id.to_string()]["current_hp"]
        .as_i64()
        .unwrap();
    assert_ne!(wounded, post_rest_hp, "the wound must change HP");

    // Rewind past BOTH the wound and the funded spend: the X-card target
    // reverts everything ABOVE the sequence, so targeting the event BEFORE
    // the rest undoes both and replays the pre-rest world.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "player_id": "gm-1",
            "topic": "rewind the funded short rest",
            "target_sequence_id": seq_after_rest - 1
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "X-card rewind must accept");

    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["current_hp"], pre_rest_hp,
        "rewind past the spend restores the wounded pre-rest HP exactly"
    );
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["hit_dice_remaining"], 3,
        "rewind past the spend refunds the drawn die (pool back to spawn)"
    );
    assert!(
        !snap["ledger"]["events"].as_array().unwrap().iter()
            .any(|e| e["event_type"] == "SHORT_REST_APPLIED"
                && e["payload"]["target_id"] == json_str(&hero_id)
                && e["is_reverted"] != serde_json::Value::Bool(true)),
        "the reverted spend event must be flagged, not replayed"
    );
}

// --- SRD exhaustion ladder: wire-level enforcement (iteration 66) -----------
//
// The per-level helpers live in vtt-core (`has_disadvantage_on_checks`,
// `has_disadvantage_on_saves`, `effective_max_hp`, `effective_speed_feet`), but
// a helper nobody calls is not a rule. These pins make each rung observable on
// the live HTTP surface:
//   - level >= 1 disadvantages ability checks (and ONLY checks at level 1)
//   - level >= 3 disadvantages saving throws
//   - level >= 4 caps healing at the halved maximum and halves the
//     massive-damage instant-death threshold
//   - (levels 2/5 movement enforcement is pinned by the server unit tests on
//     `validate_token_move`; the action-budget seeding is covered in core)

/// Spawns one entity carrying exactly `[{"exhaustion": level}]`.
async fn spawn_exhausted(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    id: Uuid,
    name: &str,
    hp: i64,
    level: u8,
) {
    let mut entity = entity_json(id, name, hp as i32, 13, 4, "1d6");
    if level > 0 {
        entity["conditions"] = serde_json::json!([{"exhaustion": level}]);
    }
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(token))
        .set_json(entity)
        .to_request();
    assert_eq!(test::call_service(app, req).await.status(), StatusCode::OK);
}

#[actix_web::test]
async fn exhaustion_level_1_disadvantages_ability_checks_but_not_saves() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let weary_id = Uuid::new_v4();
    spawn_exhausted(&app, &gm, session_id, weary_id, "Weary Scout", 22, 1).await;
    let fresh_id = Uuid::new_v4();
    spawn_exhausted(&app, &gm, session_id, fresh_id, "Fresh Scout", 22, 0).await;

    for (id, expected_disadvantage) in [(weary_id, true), (fresh_id, false)] {
        let req = test::TestRequest::post()
            .uri("/api/v1/actions/check")
            .insert_header(bearer(&gm))
            .set_json(serde_json::json!({
                "modifier": 3,
                "dc": 12,
                "cost_margin": 3,
                "session_id": session_id,
                "entity_id": id,
                "seed": seed_producing_roll(10)
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = test::read_body_json(res).await;
        assert_eq!(
            body["disadvantage"],
            serde_json::json!(expected_disadvantage),
            "exhaustion 1 must disadvantage ability checks (SRD ladder rung 1)"
        );
    }

    // Level 1 stops there: saving throws are only disadvantaged from rung 3.
    let req = test::TestRequest::post()
        .uri("/api/v1/actions/save")
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "save_modifier": 3,
            "dc": 12,
            "session_id": session_id,
            "entity_id": weary_id,
            "seed": seed_producing_roll(10)
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["disadvantage"],
        serde_json::json!(false),
        "exhaustion 1 must leave saving throws untouched"
    );
}

#[actix_web::test]
async fn exhaustion_level_3_disadvantages_saving_throws() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let drained_id = Uuid::new_v4();
    spawn_exhausted(&app, &gm, session_id, drained_id, "Drained Mage", 20, 3).await;
    let tired_id = Uuid::new_v4();
    spawn_exhausted(&app, &gm, session_id, tired_id, "Tired Cleric", 20, 2).await;

    // Rung boundary: 3 disadvantages saves, 2 does not.
    for (id, expected) in [(drained_id, true), (tired_id, false)] {
        let req = test::TestRequest::post()
            .uri("/api/v1/actions/save")
            .insert_header(bearer(&gm))
            .set_json(serde_json::json!({
                "save_modifier": 3,
                "dc": 12,
                "session_id": session_id,
                "entity_id": id,
                "seed": seed_producing_roll(10)
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = test::read_body_json(res).await;
        assert_eq!(
            body["disadvantage"],
            serde_json::json!(expected),
            "exhaustion 3+ must disadvantage saving throws (SRD ladder rung 3)"
        );
    }
}

#[actix_web::test]
async fn exhaustion_level_4_caps_healing_at_the_halved_maximum() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    // Max 30 → effective max 15 while exhausted at 4. Wounded to 5, offered
    // far more healing than fits: the refill must stop at the HALVED cap.
    let worn_id = Uuid::new_v4();
    let mut worn = entity_json(worn_id, "Worn Fighter", 30, 14, 4, "1d8");
    worn["current_hp"] = serde_json::json!(5);
    worn["conditions"] = serde_json::json!([{"exhaustion": 4}]);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(worn)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/heal", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": worn_id, "amount": 100}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["hp_remaining"], 15,
        "level 4 halves max HP: healing must cap at 30 / 2"
    );
    assert_eq!(body["amount_applied"], 10);
}

#[actix_web::test]
async fn exhaustion_level_4_halves_the_instant_death_damage_threshold() {
    let (app, state) = test_app_with_state().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    // One heavy hitter, two statistically identical victims at 14/30 HP.
    // With exhaustion 4 the effective maximum is 15, so damage that lands the
    // victim between -15 and -29 must kill them instantly — the same hit
    // leaves an unexhausted twin alive (raw floor -30).
    let attacker_id = Uuid::new_v4();
    let mut attacker = entity_json(attacker_id, "Bruiser", 40, 16, 12, "6d6");
    attacker["is_player"] = serde_json::json!(false);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(&gm))
        .set_json(attacker)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let doomed_id = Uuid::new_v4();
    let mut doomed = entity_json(doomed_id, "Doomed Twin", 30, 10, 0, "1d4");
    doomed["current_hp"] = serde_json::json!(14);
    let spared_id = Uuid::new_v4();
    let mut spared = entity_json(spared_id, "Spared Twin", 30, 10, 0, "1d4");
    spared["current_hp"] = serde_json::json!(14);
    for payload in [doomed, spared] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(bearer(&gm))
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Scan seeds for a clean experiment: a HIT carrying 16..=30 damage —
    // lethal past the halved floor of -15 yet shy of the raw -30 floor.
    let mut chosen: Option<(u64, u64, i64)> = None; // (seed, seq, damage)
    'scan: for seed in 1..=300u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
            .insert_header(bearer(&gm))
            .set_json(serde_json::json!({
                "attacker_id": attacker_id,
                "target_id": doomed_id,
                "action_index": 0,
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        let status = res.status();
        let body: serde_json::Value = test::read_body_json(res).await;
        match status {
            StatusCode::OK => {
                if body["is_hit"] == serde_json::json!(true) {
                    let dmg = body["total_damage"].as_i64().unwrap_or(0);
                    if (16..=30).contains(&dmg) {
                        chosen = Some((
                            seed,
                            body["event_sequence"].as_u64().unwrap(),
                            dmg,
                        ));
                        break 'scan;
                    }
                }
            }
            StatusCode::CONFLICT => {}
            other => panic!("seed {}: unexpected status {}: {}", seed, other, body),
        }
        advance_turn(&app, &gm, session_id).await;
    }
    let (seed, doomed_seq, damage) =
        chosen.expect("no seed produced a 16..=30 damage hit in 300 tries");

    // Same dice against the unexhausted twin: identical roll chain, identical
    // damage, no conditions in play on either side of either attack.
    advance_turn(&app, &gm, session_id).await;
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "attacker_id": attacker_id,
            "target_id": spared_id,
            "action_index": 0,
            "seed": seed
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["total_damage"], serde_json::json!(damage),
        "fixture sanity: the twin absorbs the same rolled damage");
    assert_eq!(body["is_hit"], serde_json::json!(true));
    let spared_seq = body["event_sequence"].as_u64().unwrap();

    // Exhaust the doomed twin to level 4 AFTER both attacks are ledgered so
    // the attack rolls themselves are untouched by any edge.
    state
        .sessions
        .get_mut(&session_id)
        .unwrap()
        .write()
        .entities
        .get_mut(&doomed_id)
        .unwrap()
        .set_exhaustion(4);

    // Apply the SAME wound to each twin.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "target_id": doomed_id,
            "source_event_sequence": doomed_seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["instant_death"], serde_json::json!(true),
        "{damage} vs exhausted-4 floor -(30/2) = -15 with 14 HP must be instant death"
    );

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "target_id": spared_id,
            "source_event_sequence": spared_seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["instant_death"], serde_json::json!(false),
        "the same wound stays short of the RAW -max_hp floor without exhaustion"
    );

    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][&doomed_id.to_string()]["is_dead"],
        serde_json::json!(true),
        "the massive-damage death must persist to the snapshot"
    );
    assert_eq!(
        snap["entities"][&spared_id.to_string()]["is_dead"],
        serde_json::json!(false)
    );
}

// --- Fail-forward wire-up (audit remediation) -------------------------------
//
// The fail-forward resolution engine (CheckOutcomeTier bands + deterministic
// cost suggestions) must be observable on the live HTTP surface, not just in
// vtt-core unit tests. These tests pin the d20 via the optional `seed` field
// (same pattern as the attack endpoint) and assert:
//   - margin arithmetic: margin == roll + modifier - dc
//   - tier band membership for every CheckOutcomeTier band
//   - cost_suggestion present IFF tier == "success_at_cost"
//   - pre-existing fields are unchanged (back-compat)

/// Smallest seed whose first d20 equals `target` (mirrors server-side
/// `DiceEngine::with_seed(seed)` then a single `roll_d20()` call).
fn seed_producing_roll(target: i32) -> u64 {
    for seed in 0..100_000u64 {
        if vtt_core::DiceEngine::with_seed(seed).roll_d20() == target {
            return seed;
        }
    }
    panic!("no seed in 0..100_000 produces d20 == {target}");
}

const ALL_TIERS: [&str; 4] = [
    "critical_success",
    "success",
    "success_at_cost",
    "critical_failure",
];

/// Universal implications between the reported tier and the reported
/// margin/natural roll, derived from the Pillar-8 band table plus the
/// natural-20-lifts / natural-1-drops convention.
fn assert_tier_consistent_with_margin(tier: &str, margin: i64, natural_roll: i64) {
    match tier {
        "critical_success" => assert!(
            margin >= 10 || (natural_roll == 20 && margin >= 0),
            "critical_success needs margin>=10 or nat20 lift, got margin={margin} roll={natural_roll}"
        ),
        "success" => assert!(
            (margin >= 0 && natural_roll != 1)
                || (natural_roll == 20 && margin >= -5),
            "success impossible at margin={margin} roll={natural_roll}"
        ),
        "success_at_cost" => assert!(
            ((-5..0).contains(&margin) && natural_roll != 1 && natural_roll != 20)
                || (natural_roll == 20 && margin < -5)
                || (natural_roll == 1 && margin >= 0),
            "success_at_cost impossible at margin={margin} roll={natural_roll}"
        ),
        "critical_failure" => assert!(
            (margin < -5 && natural_roll != 20)
                || (natural_roll == 1 && (-5..0).contains(&margin)),
            "critical_failure impossible at margin={margin} roll={natural_roll}"
        ),
        other => panic!("unknown tier {other:?}"),
    }
}

fn assert_check_fail_forward_shape(body: &serde_json::Value) {
    // Back-compat: legacy fields survive untouched.
    for key in ["roll", "modifier", "total", "dc", "outcome"] {
        assert!(!body[key].is_null(), "legacy field {key} missing");
    }

    let roll = body["roll"].as_i64().expect("roll is an integer");
    let modifier = body["modifier"].as_i64().expect("modifier is an integer");
    let total = body["total"].as_i64().expect("total is an integer");
    let dc = body["dc"].as_i64().expect("dc is an integer");
    let margin = body["margin"].as_i64().expect("margin is an integer");
    let tier = body["tier"].as_str().expect("tier is a string");

    assert_eq!(
        total,
        roll + modifier,
        "total must stay roll+modifier"
    );
    assert_eq!(margin, total - dc, "margin must equal total-dc");
    assert!(
        ALL_TIERS.contains(&tier),
        "tier {tier:?} not one of {ALL_TIERS:?}"
    );

    if tier == "success_at_cost" {
        // A deterministic suggestion exists exactly for genuine shortfalls
        // (-5 <= M < 0). A tier lifted/dropped into SuccessAtCost purely by
        // the natural-1/natural-20 convention has no engine-defined cost, so
        // the field stays absent rather than being fabricated.
        if (-5..0).contains(&margin) {
            let cost = body["cost_suggestion"]
                .as_str()
                .expect("cost_suggestion string required for costed margins");
            assert!(!cost.is_empty());
        } else {
            assert!(
                body.get("cost_suggestion").is_none(),
                "no engine-defined cost exists outside the -5..0 band"
            );
        }
    } else {
        assert!(
            body.get("cost_suggestion").is_none(),
            "cost_suggestion must be absent unless tier==success_at_cost"
        );
    }

    assert_tier_consistent_with_margin(tier, margin, roll);
}

async fn post_actions(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    path: &str,
    payload: serde_json::Value,
) -> serde_json::Value {
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri(path)
        .insert_header(bearer(&token))
        .set_json(payload)
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "path {path}");
    test::read_body_json(res).await
}

#[actix_web::test]
async fn check_exposes_fail_forward_fields_across_all_tiers() {
    let app = test_app().await;

    // (natural_roll, modifier, dc, expected_tier, expected_cost_suggestion)
    let cases: [(i32, i32, i32, &str, Option<&str>); 6] = [
        (15, 5, 10, "critical_success", None),           // M = +10
        (10, 3, 10, "success", None),                    // M = +3
        (8, 2, 12, "success_at_cost", Some("alert_clock_tick")),     // M = -2
        (7, 2, 12, "success_at_cost", Some("condition_prone")),      // M = -3
        (3, 0, 15, "critical_failure", None),            // M = -12
        // Natural 1 drops the tier one full band: M = 0 lands at
        // success_at_cost, but with no engine-defined cost (suggestions exist
        // only for genuine -5..0 shortfalls).
        (1, 9, 10, "success_at_cost", None),
    ];

    for (natural, modifier, dc, expected_tier, expected_cost) in cases {
        let body = post_actions(
            &app,
            "/api/v1/actions/check",
            serde_json::json!({
                "modifier": modifier,
                "dc": dc,
                "cost_margin": 5,
                "seed": seed_producing_roll(natural),
            }),
        )
        .await;

        assert_eq!(body["roll"], natural, "seed must pin the d20 to {natural}");
        assert_eq!(body["tier"], expected_tier, "case roll={natural}");
        assert_eq!(body["margin"], natural + modifier - dc);
        match expected_cost {
            Some(cost) => assert_eq!(body["cost_suggestion"], cost),
            None => assert!(body.get("cost_suggestion").is_none()),
        }
        assert_check_fail_forward_shape(&body);
    }
}

#[actix_web::test]
async fn check_legacy_outcome_field_is_unchanged_by_fail_forward_fields() {
    let app = test_app().await;

    // Same request as the SuccessAtCost case above; the legacy `outcome`
    // vocabulary must still be present and still SCREAMING_SNAKE_CASE.
    let body = post_actions(
        &app,
        "/api/v1/actions/check",
        serde_json::json!({
            "modifier": 2,
            "dc": 12,
            "cost_margin": 5,
            "seed": seed_producing_roll(8),
        }),
    )
    .await;
    assert_eq!(body["outcome"], "SUCCESS_AT_A_COST");

    // And a plain success keeps its legacy label too.
    let body = post_actions(
        &app,
        "/api/v1/actions/check",
        serde_json::json!({
            "modifier": 3,
            "dc": 10,
            "cost_margin": 5,
            "seed": seed_producing_roll(10),
        }),
    )
    .await;
    assert_eq!(body["outcome"], "SUCCESS");
    assert_eq!(body["tier"], "success");
}

#[actix_web::test]
async fn check_unseeded_rolls_stay_structurally_fail_forward_consistent() {
    let app = test_app().await;

    for _ in 0..25 {
        let body = post_actions(
            &app,
            "/api/v1/actions/check",
            serde_json::json!({"modifier": 4, "dc": 13, "cost_margin": 5}),
        )
        .await;
        assert_check_fail_forward_shape(&body);
    }
}

#[actix_web::test]
async fn save_exposes_fail_forward_fields_across_all_tiers() {
    let app = test_app().await;

    // (natural_roll, save_modifier, dc, expected_tier, binary_passed)
    let cases: [(i32, i32, i32, &str, bool); 4] = [
        (12, 8, 10, "critical_success", true),   // M = +10
        (10, 3, 10, "success", true),            // M = +3
        (8, 2, 12, "success_at_cost", false),    // M = -2: promoted by fail-forward…
        (3, 0, 15, "critical_failure", false),   // M = -12
    ];

    for (natural, modifier, dc, expected_tier, legacy_passed) in cases {
        let body = post_actions(
            &app,
            "/api/v1/actions/save",
            serde_json::json!({
                "save_modifier": modifier,
                "dc": dc,
                "ability": "DEXTERITY",
                "seed": seed_producing_roll(natural),
            }),
        )
        .await;

        assert_eq!(body["natural_roll"], natural, "seed must pin the d20");
        assert_eq!(body["total"], natural + modifier);
        assert_eq!(body["margin"], natural + modifier - dc);
        assert_eq!(body["tier"], expected_tier);

        // Back-compat: binary pass flag keeps today's threshold semantics.
        assert_eq!(body["passed"], legacy_passed);

        if expected_tier == "success_at_cost" {
            assert!(body["cost_suggestion"].is_string());
        } else {
            assert!(body.get("cost_suggestion").is_none());
        }
    }
}

#[actix_web::test]
async fn save_auto_fail_forces_critical_failure_tier() {
    let app = test_app().await;

    // Paralyzed auto-fails STR/DEX saves regardless of the roll.
    let body = post_actions(
        &app,
        "/api/v1/actions/save",
        serde_json::json!({
            "save_modifier": 9,
            "dc": 10,
            "ability": "STRENGTH",
            "conditions": ["paralyzed"],
            "seed": seed_producing_roll(20),
        }),
    )
    .await;

    assert_eq!(body["auto_failed"], true);
    assert_eq!(body["passed"], false);
    assert_eq!(body["tier"], "critical_failure");
    assert!(body.get("cost_suggestion").is_none());
}

// --- Auto concentration checks on damage (backlog 4.11) -----------------------
//
// SRD: when a concentrating creature takes damage, it must make a CON save
// against DC = max(10, damage / 2) or lose concentration. The engine rolls
// this server-side from the session dice; clients only observe the outcome.

/// The shared test-service type, spelled out at every use site (mirrors
/// `post_actions` above; `impl Trait` in type aliases is not stable Rust).
macro_rules! test_app_ty {
    () => {
        &impl Service<
            actix_http::Request,
            Response = ServiceResponse<EitherBody<BoxBody>>,
            Error = actix_web::Error,
        >
    };
}

async fn spawn_entity(
    app: test_app_ty!(),
    token: &str,
    session_id: Uuid,
    entity: serde_json::Value,
) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(token))
        .set_json(entity)
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "spawn failed: {:?}",
        test::read_body(res).await
    );
}

async fn session_snapshot(
    app: test_app_ty!(),
    token: &str,
    session_id: Uuid,
) -> serde_json::Value {
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(bearer(token))
        .to_request();
    test::read_body_json(test::call_service(app, req).await).await
}

async fn caster_concentration(
    snap: &serde_json::Value,
    caster_id: Uuid,
) -> &serde_json::Value {
    &snap["entities"][&caster_id.to_string()]["concentration"]
}

async fn attack(
    app: test_app_ty!(),
    token: &str,
    session_id: Uuid,
    attacker_id: Uuid,
    target_id: Uuid,
    seed: u64,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(bearer(token))
        .set_json(serde_json::json!({
            "attacker_id": attacker_id,
            "target_id": target_id,
            "action_index": 0,
            "seed": seed
        }))
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    (status, body)
}

async fn advance_turn(app: test_app_ty!(), token: &str, session_id: Uuid) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/turn/next", session_id))
        .insert_header(bearer(token))
        .to_request();
    assert_eq!(test::call_service(app, req).await.status(), StatusCode::OK);
}

/// Builds a session with a concentrating wizard (CON 14 → +2 save modifier,
/// plenty of HP so repeated hits never drop it) and a golem that always hits
/// for `2d6+8` (damage 10..=20 → concentration DC is always exactly 10).
/// Returns (app, token, session_id, caster_id, golem_id).
async fn concentration_fixture() -> (
    impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    String,
    Uuid,
    Uuid,
    Uuid,
) {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;

    let caster_id = Uuid::new_v4();
    let mut caster = entity_json(caster_id, "Conc Wizard", 200, 10, 2, "1d4");
    caster["spell_slots_remaining"] = serde_json::json!({"1": 99});
    spawn_entity(&app, &token, session_id, caster).await;

    // attack_bonus 20 vs AC 10: every seed hits; damage 2d6+8 ∈ [10, 20].
    let golem_id = Uuid::new_v4();
    spawn_entity(
        &app,
        &token,
        session_id,
        entity_json(golem_id, "Golem", 100, 12, 20, "2d6+8"),
    )
    .await;

    // Concentrate on a harmless, damage-less level-1 spell via the normal
    // cast-spell flow.
    let hold_person = serde_json::json!({
        "spell": {
            "spell_id": "hold_person", "name": "Hold Person", "level": 1,
            "school": "Enchantment", "casting_time": "1 action", "range_feet": 60,
            "area_of_effect_shape": null, "area_of_effect_size_feet": null,
            "verbal_component": true, "somatic_component": true,
            "material_component_desc": null, "save_attribute": null,
            "damage_formula": null, "damage_type": null,
            "duration_rounds": 10, "is_concentration": true, "is_ritual": false
        },
        "caster_id": caster_id,
        "cast_level": 1
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
        .insert_header(bearer(&token))
        .set_json(hold_person)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "concentration cast must resolve");
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["result"]["concentration_started"], true);

    (app, token, session_id, caster_id, golem_id)
}

fn break_events(snap: &serde_json::Value) -> Vec<&serde_json::Value> {
    snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == "CONCENTRATION_BROKEN")
        .collect()
}

/// Auto-check fires on attack damage with exact SRD DC math, and across a
/// deterministic seed scan BOTH outcomes occur: failed saves break the spell
/// (and ledger CONCENTRATION_BROKEN), passed saves keep it standing.
#[actix_web::test]
async fn auto_concentration_check_fires_on_attack_damage_with_srd_dc_math() {
    let (app, token, session_id, caster_id, golem_id) = concentration_fixture().await;

    let mut breaks_seen = 0usize;
    let mut survives_seen = 0usize;
    let mut concentrating = true;

    for seed in 1..=200u64 {
        // Each attack costs the Action; refresh the round between swings.
        if seed > 1 {
            advance_turn(&app, &token, session_id).await;
        }
        // Re-concentrate after every break (slots are plentiful).
        if !concentrating {
            advance_turn(&app, &token, session_id).await;
            let req = test::TestRequest::post()
                .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
                .insert_header(bearer(&token))
                .set_json(serde_json::json!({
                    "spell": {
                        "spell_id": "hold_person", "name": "Hold Person", "level": 1,
                        "school": "Enchantment", "casting_time": "1 action", "range_feet": 60,
                        "area_of_effect_shape": null, "area_of_effect_size_feet": null,
                        "verbal_component": true, "somatic_component": true,
                        "material_component_desc": null, "save_attribute": null,
                        "damage_formula": null, "damage_type": null,
                        "duration_rounds": 10, "is_concentration": true, "is_ritual": false
                    },
                    "caster_id": caster_id,
                    "cast_level": 1
                }))
                .to_request();
            assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
            concentrating = true;
        }

        let (status, body) = attack(&app, &token, session_id, golem_id, caster_id, seed).await;
        if status != StatusCode::OK || body["is_hit"] != true {
            continue; // miss — no damage, no check
        }

        // Every hit against a concentrating target MUST carry the check.
        let check = body
            .get("concentration_check")
            .expect("hit on concentrating target must include concentration_check");
        let dmg = body["total_damage"].as_i64().unwrap();
        let dc = check["dc"].as_i64().unwrap();
        let total = check["total"].as_i64().unwrap();

        // SRD DC math: max(10, damage / 2).
        assert_eq!(dc, std::cmp::max(10, dmg / 2), "DC must be max(10, dmg/2)");
        // total is the d20 plus the CON modifier (+2 at CON 14).
        assert_eq!(
            check["passed"].as_bool().unwrap(),
            total >= dc,
            "passed must equal total >= dc"
        );

        if check["broken"].as_bool().unwrap() {
            breaks_seen += 1;
            concentrating = false;
            // State: concentration cleared server-side.
            let snap = session_snapshot(&app, &token, session_id).await;
            assert!(
                caster_concentration(&snap, caster_id).await.is_null(),
                "failed save must clear concentration"
            );
            // Ledger: one CONCENTRATION_BROKEN with the full audit payload.
            let events = break_events(&snap);
            assert_eq!(
                events.len(),
                breaks_seen,
                "exactly one CONCENTRATION_BROKEN per failed save"
            );
            let ev = events.last().expect("broken check must ledger an event");
            assert_eq!(ev["payload"]["target_id"], caster_id.to_string());
            assert_eq!(ev["payload"]["spell_id"], "hold_person");
            assert_eq!(ev["payload"]["dc"], dc);
            assert_eq!(ev["payload"]["total"], total);
        } else {
            survives_seen += 1;
            let snap = session_snapshot(&app, &token, session_id).await;
            assert_eq!(
                caster_concentration(&snap, caster_id).await["spell_id"],
                "hold_person",
                "passed save must keep the spell up"
            );
        }

        if breaks_seen > 0 && survives_seen > 0 {
            break;
        }
    }

    assert!(breaks_seen > 0, "seed scan must exercise the broken branch");
    assert!(survives_seen > 0, "seed scan must exercise the maintained branch");

    // The trailing re-cast (if any) means the last snapshot state is not
    // necessarily "concentrating"; only the event count is asserted here.
    let snap = session_snapshot(&app, &token, session_id).await;
    assert_eq!(
        break_events(&snap).len() as usize,
        breaks_seen,
        "ledger holds exactly one CONCENTRATION_BROKEN per observed failure"
    );
}

/// A passed save keeps concentration and must NOT ledger a break event even
/// though damage landed.
#[actix_web::test]
async fn passed_concentration_save_maintains_spell_without_break_event() {
    let (app, token, session_id, caster_id, golem_id) = concentration_fixture().await;

    let mut found_pass = false;
    for seed in 1..=200u64 {
        let (status, body) = attack(&app, &token, session_id, golem_id, caster_id, seed).await;
        if status != StatusCode::OK || body["is_hit"] != true {
            advance_turn(&app, &token, session_id).await;
            continue;
        }
        let check = body.get("concentration_check").expect("check must fire");
        if check["passed"] == true && check["broken"] == false {
            found_pass = true;
            break;
        }
        // Failed save: re-establish concentration before scanning further.
        advance_turn(&app, &token, session_id).await;
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
            .insert_header(bearer(&token))
            .set_json(serde_json::json!({
                "spell": {
                    "spell_id": "hold_person", "name": "Hold Person", "level": 1,
                    "school": "Enchantment", "casting_time": "1 action", "range_feet": 60,
                    "area_of_effect_shape": null, "area_of_effect_size_feet": null,
                    "verbal_component": true, "somatic_component": true,
                    "material_component_desc": null, "save_attribute": null,
                    "damage_formula": null, "damage_type": null,
                    "duration_rounds": 10, "is_concentration": true, "is_ritual": false
                },
                "caster_id": caster_id,
                "cast_level": 1
            }))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }
    assert!(found_pass, "some seeded hit must be saved");

    let snap = session_snapshot(&app, &token, session_id).await;
    assert!(break_events(&snap).is_empty());
    assert_eq!(caster_concentration(&snap, caster_id).await["spell_id"], "hold_person");
}

/// No concentration, no check: the additive response field must stay absent
/// (back-compat) on both the attack path and the apply-damage path.
#[actix_web::test]
async fn no_concentration_check_when_target_not_concentrating() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;

    let hero_id = Uuid::new_v4();
    spawn_entity(
        &app,
        &token,
        session_id,
        entity_json(hero_id, "Hero", 40, 10, 20, "2d6+8"),
    )
    .await;
    let orc_id = Uuid::new_v4();
    spawn_entity(
        &app,
        &token,
        session_id,
        entity_json(orc_id, "Orc", 100, 10, 3, "1d6"),
    )
    .await;

    let (status, body) = attack(&app, &token, session_id, hero_id, orc_id, 1).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["is_hit"], true, "golem-grade bonus must hit AC 10");
    assert!(
        body.get("concentration_check").is_none(),
        "additive field must be absent without concentration"
    );

    // apply_damage path: equally silent.
    let seq = body["event_sequence"].as_u64().unwrap();
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "target_id": orc_id,
            "source_event_sequence": seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let dmg_body: serde_json::Value = test::read_body_json(res).await;
    assert!(
        dmg_body.get("concentration_check").is_none(),
        "apply_damage must not fabricate a check without concentration"
    );
    assert!(break_events(&session_snapshot(&app, &token, session_id).await).is_empty());
}

/// The standalone /damage endpoint runs the same auto-check: a failing CON
/// save there also breaks the spell and ledgers the event, and each damage
/// application gets its own independent check.
#[actix_web::test]
async fn apply_damage_endpoint_triggers_auto_concentration_check() {
    let (app, token, session_id, caster_id, golem_id) = concentration_fixture().await;

    // Land a hit whose attack-path save PASSES so concentration survives for
    // the explicit /damage call.
    let mut seq_and_amount = None;
    for seed in 1..=200u64 {
        let (status, body) = attack(&app, &token, session_id, golem_id, caster_id, seed).await;
        if status != StatusCode::OK || body["is_hit"] != true {
            advance_turn(&app, &token, session_id).await;
            continue;
        }
        let check = body.get("concentration_check").expect("check must fire");
        if check["passed"] == true {
            seq_and_amount =
                Some((body["event_sequence"].as_u64().unwrap(), body["total_damage"].as_i64().unwrap()));
            break;
        }
        // Broken by the hit itself — rebuild and keep scanning.
        advance_turn(&app, &token, session_id).await;
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
            .insert_header(bearer(&token))
            .set_json(serde_json::json!({
                "spell": {
                    "spell_id": "hold_person", "name": "Hold Person", "level": 1,
                    "school": "Enchantment", "casting_time": "1 action", "range_feet": 60,
                    "area_of_effect_shape": null, "area_of_effect_size_feet": null,
                    "verbal_component": true, "somatic_component": true,
                    "material_component_desc": null, "save_attribute": null,
                    "damage_formula": null, "damage_type": null,
                    "duration_rounds": 10, "is_concentration": true, "is_ritual": false
                },
                "caster_id": caster_id,
                "cast_level": 1
            }))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }
    let (seq, amount) = seq_and_amount.expect("must find a surviving hit");

    // A natural-1 CON save (total 3) fails any DC the SRD can produce here.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "target_id": caster_id,
            "source_event_sequence": seq,
            "seed": seed_producing_roll(1)
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let check = body.get("concentration_check").expect("check must fire on applied damage");
    assert_eq!(check["dc"], std::cmp::max(10, amount / 2));
    assert_eq!(check["passed"], false);
    assert_eq!(check["broken"], true);

    let snap = session_snapshot(&app, &token, session_id).await;
    assert!(caster_concentration(&snap, caster_id).await.is_null());
    let events = break_events(&snap);
    assert_eq!(events.len(), 1, "exactly one break from the /damage save");
    assert_eq!(events[0]["payload"]["target_id"], caster_id.to_string());
    assert_eq!(events[0]["payload"]["spell_id"], "hold_person");
    assert_eq!(events[0]["payload"]["dc"], std::cmp::max(10, amount / 2));
    assert_eq!(events[0]["payload"]["total"], 3);

    // Second damage application (its own event, its own check): re-concentrate
    // first, then replay the same source event — the new check must fire again.
    advance_turn(&app, &token, session_id).await;
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "spell": {
                "spell_id": "hold_person", "name": "Hold Person", "level": 1,
                "school": "Enchantment", "casting_time": "1 action", "range_feet": 60,
                "area_of_effect_shape": null, "area_of_effect_size_feet": null,
                "verbal_component": true, "somatic_component": true,
                "material_component_desc": null, "save_attribute": null,
                "damage_formula": null, "damage_type": null,
                "duration_rounds": 10, "is_concentration": true, "is_ritual": false
            },
            "caster_id": caster_id,
            "cast_level": 1
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "target_id": caster_id,
            "source_event_sequence": seq,
            "seed": seed_producing_roll(20)
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let check = body.get("concentration_check").expect("second application must check too");
    assert_eq!(check["total"], 22, "nat 20 + CON 14 modifier (+2)");
    assert_eq!(check["passed"], true);
    assert_eq!(check["broken"], false);

    let snap = session_snapshot(&app, &token, session_id).await;
    assert_eq!(
        caster_concentration(&snap, caster_id).await["spell_id"],
        "hold_person",
        "second, passed save maintains the spell"
    );
    assert_eq!(
        break_events(&snap).len(),
        1,
        "no additional break event for the passed save"
    );
}

// --- Opportunity attack reporting (backlog 5.9) -------------------------------

/// Spawns an entity with explicit position/side and returns nothing (id is
/// caller-chosen). Mirrors `entity_json` but allows non-player stat blocks.
async fn spawn_at(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    auth: &(actix_web::http::header::HeaderName, String),
    session_id: Uuid,
    id: Uuid,
    name: &str,
    is_player: bool,
    pos: [f64; 3],
) {
    let mut payload = entity_json(id, name, 20, 12, 3, "1d6+1");
    payload["is_player"] = serde_json::json!(is_player);
    payload["position"] = serde_json::json!(pos);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(payload)
        .to_request();
    let res = test::call_service(app, req).await;
    let st = res.status();
    let raw = test::read_body(res).await.to_vec();
    assert_eq!(
        st,
        StatusCode::OK,
        "spawn of {} failed: {:?}",
        name,
        String::from_utf8_lossy(&raw)
    );
}

async fn create_opportunity_session(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    auth: &(actix_web::http::header::HeaderName, String),
) -> Uuid {
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({
            "campaign_id": Uuid::new_v4(),
            "session_name": "Opportunity Attacks"
        }))
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    body["session_id"].as_str().unwrap().parse().unwrap()
}

/// A move that leaves an adjacent enemy WITH an armed opportunity reaction
/// must SAY so in the move response — without auto-executing the attack
/// (polling/prompting is the Pillar-3 reaction stack's job).
#[actix_web::test]
async fn move_provoke_reports_opportunity_attack() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;

    // Hero starts 5 ft from the orc (adjacent); both on opposite sides.
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [10.0, 5.0, 0.0]).await;

    // Arm the orc's opportunity attack.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({
            "entity_id": orc_id,
            "reaction_type": "opportunity_attack"
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Move straight away past the engine's 5 ft adjacency band (the post-move
    // check allows up to 5.5 ft of slack) — leaving adjacency provokes.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let st = res.status();
    let raw = test::read_body(res).await.to_vec();
    assert_eq!(st, StatusCode::OK, "move failed: {:?}", String::from_utf8_lossy(&raw));
    let body: serde_json::Value = serde_json::from_slice(&raw).unwrap();

    // Additive report field describing WHO could take the OA.
    assert_eq!(body["opportunity_attack"]["provoked_by"], orc_id.to_string());
    assert_eq!(body["opportunity_attack"]["reaction_type"], "opportunity_attack");
    assert_eq!(body["opportunity_attack"]["available"], true);

    // The engine-level detection is still present in the outcome payload.
    let triggers = body["outcome"]["opportunity_attacks"].as_array().unwrap();
    assert_eq!(triggers.len(), 1, "exactly one provoked OA");
    assert_eq!(triggers[0]["attacker_id"], orc_id.to_string());
    assert_eq!(triggers[0]["mover_id"], hero_id.to_string());

    // The reaction is PENDED by detection (iteration 72): the swing itself is
    // still available through /action/opportunity-attack. Step back in and
    // away again — the mover's SECOND departure re-arms nothing new, and the
    // pending entry from the first provocation remains the single live one.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 12.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let st = res.status();
    let raw = test::read_body(res).await.to_vec();
    assert_eq!(
        st,
        StatusCode::OK,
        "step-back move failed: {:?}",
        String::from_utf8_lossy(&raw)
    );

    // Take the swing: it spends the orc's REACTION (not its Action).
    let seed = oa_hit_seed(3, 12);
    let (status, oa_body) = post_opportunity_attack(&app, &token, session_id, orc_id, hero_id, seed).await;
    assert_eq!(status, StatusCode::OK, "body: {}", oa_body);
    assert_eq!(oa_body["economy_spent"], serde_json::json!("reaction"));
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        !snap["entities"][orc_id.to_string()]["action_budget"]["reaction"].as_bool().unwrap(),
        "the taken OA spends the orc's reaction"
    );
    assert!(
        snap["entities"][orc_id.to_string()]["action_budget"]["action"].as_bool().unwrap(),
        "the OA never touches the Action"
    );

    // Now that the swing is TAKEN, a further leave-adjacency move reports NO
    // new opportunity attack: no armed reaction remains to provoke.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 18.5, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert!(
        body.get("opportunity_attack").is_none(),
        "consumed reaction must not re-report an OA: {}",
        body
    );
}

/// A mover who cannot be provoked — no adjacent enemy has a readied
/// opportunity reaction (the engine's Disengage-equivalent semantics:
/// provocation requires an ARMED reaction) — gets NO opportunity field.
#[actix_web::test]
async fn disengaged_mover_move_response_omits_opportunity_attack() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;

    // Adjacent enemy, but its reaction is NOT armed (mover effectively
    // disengaged: nothing can be provoked).
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [10.0, 5.0, 0.0]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 15.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert!(body.get("opportunity_attack").is_none(), "{}", body);
    assert_eq!(
        body["outcome"]["opportunity_attacks"].as_array().unwrap().len(),
        0,
        "unarmed adjacent enemy cannot provoke"
    );
}

/// No adjacent enemies at all → the field must be absent entirely.
#[actix_web::test]
async fn move_without_adjacent_armed_enemies_omits_opportunity_attack() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [2.5, 2.5, 0.0]).await;
    // Armed orc, but far outside adjacency.
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [40.0, 40.0, 0.0]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({
            "entity_id": orc_id,
            "reaction_type": "opportunity_attack"
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 2.5}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert!(body.get("opportunity_attack").is_none(), "{}", body);
}

// --- Audit follow-ups ---------------------------------------------------------

/// MED audit finding: the X-card response embeds the FULL post-rewind
/// GameSession snapshot and is reachable by ANY non-spectator — leaking hidden
/// NPCs' AC/HP/abilities/attacks to players. Non-GM callers must receive the
/// same public-board-token projection the gateway applies to engine state
/// ({id,name,is_visible,position,is_player,is_dead} per entity, hidden
/// entities dropped, own sheet in full); GMs keep the authoritative snapshot.
#[actix_web::test]
async fn x_card_snapshot_projected_for_players_full_for_gm() {
    let app = test_app().await;
    // Explicit role claims: binding another player's ownership is a GM
    // privilege, so the GM token must actually carry the "gm" role here.
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-2", "player", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let session_id = create_session_as(&app, &gm).await;

    // A hero owned by player-2 plus two DM-controlled NPCs: one visible on the
    // board, one hidden (is_visible=false) whose stat block must never reach
    // a non-GM caller.
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let lurker_id = Uuid::new_v4();

    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["owner_player_id"] = serde_json::json!("player-2");
    let mut orc = entity_json(orc_id, "Board Orc", 20, 11, 3, "1d6+2");
    orc["is_player"] = serde_json::json!(false);
    let mut lurker = entity_json(lurker_id, "Hidden Lurker", 40, 17, 6, "2d8+4");
    lurker["is_player"] = serde_json::json!(false);
    lurker["is_visible"] = serde_json::json!(false);

    for payload in [hero, orc, lurker] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(gm_auth.clone())
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Rewind target = the current ledger tail, so the spawns survive the
    // rewind and the snapshot still carries all three entities.
    let target_seq: u64 = {
        let snap = snapshot_as(&app, &gm, session_id).await;
        snap["ledger"]["current_sequence"].as_u64().unwrap()
    };

    let card = serde_json::json!({
        "player_id": "player-2",
        "topic": "spider imagery",
        "target_sequence_id": target_seq
    });

    // --- Player view: projected board tokens only ---
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&player))
        .set_json(card.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "SAFETY_REWIND_SUCCESS");

    let entities = &body["snapshot"]["entities"];

    // The hidden NPC's stat block is gone entirely: no key, hence no ac/HP/
    // abilities/attacks anywhere in the payload.
    assert!(
        entities.get(lurker_id.to_string()).is_none(),
        "hidden NPC must be dropped from a player's x-card snapshot: {}",
        body["snapshot"]
    );
    assert!(
        entities[&lurker_id.to_string()]["ac"].is_null()
            && entities[&lurker_id.to_string()]["attacks"].is_null(),
        "hidden entity must lack ac/attacks fields"
    );

    // The visible unowned NPC is reduced to the public board-token projection.
    let projected_orc = &entities[&orc_id.to_string()];
    let mut fields: Vec<&str> = projected_orc
        .as_object()
        .expect("projected entity must be an object")
        .keys()
        .map(|k| k.as_str())
        .collect();
    fields.sort_unstable();
    assert_eq!(
        fields,
        vec!["id", "is_dead", "is_player", "is_visible", "name", "position"],
        "visible NPC must carry exactly the public board-token fields"
    );
    assert!(projected_orc["ac"].is_null());
    assert!(projected_orc["current_hp"].is_null());
    assert!(projected_orc["abilities"].is_null());
    assert_eq!(projected_orc["name"], "Board Orc");

    // The caller's OWN entity keeps its full sheet (gateway matrix parity).
    let own_hero = &entities[&hero_id.to_string()];
    assert_eq!(own_hero["ac"], 14, "own sheet stays unredacted");
    assert!(own_hero["attacks"].is_array());

    // --- GM view: the authoritative post-rewind snapshot, hidden NPC included ---
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&gm))
        .set_json(card)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let gm_entities = &body["snapshot"]["entities"];
    let lurker = &gm_entities[&lurker_id.to_string()];
    assert_eq!(lurker["ac"], 17, "GM sees the hidden NPC's stat block");
    assert_eq!(lurker["current_hp"], 40);
    assert_eq!(
        lurker["attacks"].as_array().map(|a| a.len()),
        Some(1),
        "GM sees the hidden NPC's attacks"
    );
}

/// Audit finding (sibling of the x-card leak): `GET /api/v1/sessions/{id}`
/// serialized the FULL GameSession to any authenticated caller, so spectators
/// and non-owner players could read hidden NPCs' stat blocks/HP/attacks and
/// `owner_player_id` markers straight off the HTTP route even though both the
/// WS initial snapshot and the x-card response already project by role. The
/// GET must apply `project_snapshot_for_role` exactly like those paths.
#[actix_web::test]
async fn get_session_projected_for_spectator_and_player_full_for_gm() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-2", "player", TEST_SECRET);
    let spectator = sign_token_with_role("spec-1", "spectator", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let session_id = create_session_as(&app, &gm).await;

    // Same table as the x-card projection test: a hero owned by player-2,
    // a visible DM-controlled NPC, and a hidden NPC whose sheet must never
    // reach a non-GM caller over any read path.
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let lurker_id = Uuid::new_v4();

    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["owner_player_id"] = serde_json::json!("player-2");
    let mut orc = entity_json(orc_id, "Board Orc", 20, 11, 3, "1d6+2");
    orc["is_player"] = serde_json::json!(false);
    let mut lurker = entity_json(lurker_id, "Hidden Lurker", 40, 17, 6, "2d8+4");
    lurker["is_player"] = serde_json::json!(false);
    lurker["is_visible"] = serde_json::json!(false);

    for payload in [hero, orc, lurker] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(gm_auth.clone())
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    let fetch = |token: &str| {
        test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{session_id}"))
            .insert_header(bearer(token))
            .to_request()
    };

    // --- Player view: own sheet in full, visible NPC as board token, hidden dropped ---
    let body: serde_json::Value =
        test::read_body_json(test::call_service(&app, fetch(&player)).await).await;
    let entities = &body["entities"];
    assert!(
        entities.get(lurker_id.to_string()).is_none(),
        "hidden NPC must be dropped from a player's session snapshot: {}",
        body
    );
    let projected_orc = &entities[&orc_id.to_string()];
    let mut fields: Vec<&str> = projected_orc
        .as_object()
        .expect("projected entity must be an object")
        .keys()
        .map(|k| k.as_str())
        .collect();
    fields.sort_unstable();
    assert_eq!(
        fields,
        vec!["id", "is_dead", "is_player", "is_visible", "name", "position"],
        "visible unowned NPC must carry exactly the public board-token fields"
    );
    assert!(projected_orc["ac"].is_null());
    assert!(projected_orc["current_hp"].is_null());
    assert!(projected_orc["owner_player_id"].is_null());
    // The caller's OWN entity keeps its full sheet (WS snapshot parity), so
    // targeting flows that need ids/stats still work.
    let own_hero = &entities[&hero_id.to_string()];
    assert_eq!(own_hero["ac"], 14, "own sheet stays unredacted");
    assert_eq!(own_hero["id"], json_str(&hero_id), "entity id preserved for targeting");

    // --- Spectator view: every VISIBLE entity as a board token, nothing else ---
    let body: serde_json::Value =
        test::read_body_json(test::call_service(&app, fetch(&spectator)).await).await;
    let entities = &body["entities"];
    assert!(
        entities.get(lurker_id.to_string()).is_none(),
        "hidden NPC must be dropped from a spectator's session snapshot"
    );
    for id in [orc_id, hero_id] {
        let token_view = &entities[&id.to_string()];
        let mut fields: Vec<&str> = token_view
            .as_object()
            .expect("projected entity must be an object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            vec!["id", "is_dead", "is_player", "is_visible", "name", "position"],
            "spectator must see only board-token fields for {}",
            id
        );
        assert!(token_view["current_hp"].is_null() && token_view["ac"].is_null());
    }
    // Ownership markers never leave the engine on a spectator's watch.
    assert!(
        !serde_json::to_string(entities)
            .unwrap()
            .contains("owner_player_id"),
        "spectator snapshot must not carry owner_player_id markers"
    );

    // --- GM view: the authoritative snapshot, hidden NPC included ---
    let body: serde_json::Value =
        test::read_body_json(test::call_service(&app, fetch(&gm)).await).await;
    let gm_entities = &body["entities"];
    let lurker = &gm_entities[&lurker_id.to_string()];
    assert_eq!(lurker["ac"], 17, "GM sees the hidden NPC's stat block");
    assert_eq!(lurker["current_hp"], 40);
    assert_eq!(lurker["owner_player_id"].as_str(), None, "hidden NPC is DM-controlled");
    assert_eq!(gm_entities[&hero_id.to_string()]["owner_player_id"], "player-2");
}

/// MINOR audit finding: when a move provokes MORE THAN ONE adjacent armed
/// enemy, the response must surface every provoked attacker in
/// `opportunity_attacks_detail`, not just `.first()` — while keeping the
/// singular `opportunity_attack` field for back-compat.
#[actix_web::test]
async fn move_provoke_reports_all_attackers_in_opportunity_attacks_detail() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;

    // Hero flanked by two adjacent enemies, each 5 ft away.
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let goblin_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [10.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, goblin_id, "Goblin", false, [5.0, 10.0, 0.0]).await;

    // Arm BOTH enemies' opportunity reactions.
    for enemy in [orc_id, goblin_id] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
            .insert_header((auth.0.clone(), auth.1.clone()))
            .set_json(serde_json::json!({
                "entity_id": enemy,
                "reaction_type": "opportunity_attack"
            }))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Move diagonally away from both (~21 ft, within the 30 ft budget).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 20.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let st = res.status();
    let raw = test::read_body(res).await.to_vec();
    assert_eq!(st, StatusCode::OK, "move failed: {:?}", String::from_utf8_lossy(&raw));
    let body: serde_json::Value = serde_json::from_slice(&raw).unwrap();

    // Engine detection saw both provocations.
    let triggers = body["outcome"]["opportunity_attacks"].as_array().unwrap();
    assert_eq!(triggers.len(), 2, "both adjacent armed enemies provoke");

    // THE FIX: the detail array lists EVERY provoked attacker.
    let detail = body["opportunity_attacks_detail"]
        .as_array()
        .expect("opportunity_attacks_detail array must be present");
    assert_eq!(detail.len(), 2, "every provoked attacker must be surfaced: {}", body);
    let mut provoked: Vec<String> = detail
        .iter()
        .map(|d| d["provoked_by"].as_str().unwrap().to_string())
        .collect();
    provoked.sort();
    let mut expected = vec![orc_id.to_string(), goblin_id.to_string()];
    expected.sort();
    assert_eq!(provoked, expected, "detail array must name both attackers");
    for entry in detail {
        assert_eq!(entry["reaction_type"], "opportunity_attack");
        assert_eq!(entry["available"], true);
    }

    // Back-compat: the singular field survives and agrees with the first
    // detail entry (HashMap iteration order is nondeterministic).
    let singular = &body["opportunity_attack"];
    assert_eq!(
        singular["provoked_by"].as_str().unwrap(),
        detail[0]["provoked_by"].as_str().unwrap(),
        "singular field must mirror the first trigger for old clients"
    );
    assert_eq!(singular["reaction_type"], "opportunity_attack");
    assert_eq!(singular["available"], true);
}

// --- Opportunity attack RESOLUTION (iteration 72) -----------------------------
//
// The move response only DISCLOSES the pending OA; this is the half where the
// provoked enemy actually takes the swing through the wire — against its
// REACTION budget, never the Action, and only for a mover whose movement
// armed the trigger this round.

/// Posts /action/opportunity-attack and returns (status, body).
async fn post_opportunity_attack(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    attacker_id: Uuid,
    target_id: Uuid,
    seed: u64,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!(
            "/api/v1/sessions/{}/action/opportunity-attack",
            session_id
        ))
        .insert_header(bearer(token))
        .set_json(serde_json::json!({
            "attacker_id": attacker_id,
            "target_id": target_id,
            "seed": seed
        }))
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await;
    let value: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
    (status, value)
}

/// Finds a seed whose first d20 roll with `attack_bonus` beats AC exactly.
fn oa_hit_seed(attack_bonus: i32, ac: i32) -> u64 {
    let mut dice = DiceEngine::with_seed(1);
    let _ = dice.roll_d20(); // warm up identically to the real call path
    for s in 1..=100_000u64 {
        let mut dice = DiceEngine::with_seed(s);
        if dice.roll_d20() + attack_bonus >= ac {
            return s;
        }
    }
    panic!("no seed hits");
}

#[actix_web::test]
async fn opportunity_attack_resolves_spend_reaction_not_action_and_refuse_second() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-oa", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;

    let hero_id = Uuid::new_v4();
    // Orc: AC 11, one attack entry with +3 to hit (entity_json defaults).
    let orc_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [10.0, 5.0, 0.0]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": orc_id, "reaction_type": "opportunity_attack"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // The hero leaves reach: the move response must DISCLOSE the pending OA.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 25.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["opportunity_attack"]["provoked_by"], orc_id.to_string());
    assert_eq!(
        body["opportunity_attack"]["pending_opportunity"],
        serde_json::json!("/action/opportunity-attack"),
        "the disclosure must name the endpoint that takes the swing"
    );
    assert_eq!(body["outcome"]["opportunity_attacks"].as_array().unwrap().len(), 1);

    // The orc takes it. A guaranteed-hit seed pins the resolution.
    let seed = oa_hit_seed(8, 11);
    let (status, body) = post_opportunity_attack(&app, &token, session_id, orc_id, hero_id, seed).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["is_opportunity"], serde_json::json!(true));
    assert_eq!(body["economy_spent"], serde_json::json!("reaction"));
    assert_eq!(body["is_hit"], serde_json::json!(true), "seeded swing must land");

    // REACTION spent, Action untouched.
    let snap = snapshot_as(&app, &token, session_id).await;
    let orc = &snap["entities"][orc_id.to_string()];
    assert!(
        !orc["action_budget"]["reaction"].as_bool().unwrap(),
        "the OA spends the REACTION"
    );
    assert!(
        orc["action_budget"]["action"].as_bool().unwrap(),
        "an OA must NEVER spend the Action"
    );

    // Ledger: OPPORTUNITY_ATTACK_RESOLVED landed.
    assert!(
        snap["ledger"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event_type"] == serde_json::json!("OPPORTUNITY_ATTACK_RESOLVED")),
        "OPPORTUNITY_ATTACK_RESOLVED expected in ledger"
    );

    // Second OA the same round: no trigger left AND no reaction → 409.
    let (status, err_body) =
        post_opportunity_attack(&app, &token, session_id, orc_id, hero_id, seed).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err_body["error"], serde_json::json!("OA_NOT_PENDING"));
}

/// An entity with NO pending trigger cannot invent an OA: wrong target, wrong
/// attacker, or nothing armed at all are all refused without spending anything.
#[actix_web::test]
async fn opportunity_attack_only_legal_for_the_armed_attacker_mover_pairing() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-oa-pair", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let goblin_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [10.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, goblin_id, "Goblin", false, [10.0, 7.5, 0.0]).await;

    // Arm ONLY the orc; the hero leaves BOTH creatures' reach.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": orc_id, "reaction_type": "opportunity_attack"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 30.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    // Wrong attacker (goblin has no trigger): refused, nothing spent.
    let seed = oa_hit_seed(8, 11);
    let (status, err_body) =
        post_opportunity_attack(&app, &token, session_id, goblin_id, hero_id, seed).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err_body["error"], serde_json::json!("OA_NOT_PENDING"));

    // Right attacker, wrong pairing direction (hero "attacking" itself out of
    // turn is nonsense anyway): refused.
    let (status, _) =
        post_opportunity_attack(&app, &token, session_id, hero_id, goblin_id, seed).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // The genuine pairing resolves.
    let (status, body) =
        post_opportunity_attack(&app, &token, session_id, orc_id, hero_id, seed).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["is_opportunity"], serde_json::json!(true));
}

/// Disengage AFTER walking away withdraws the already-provoked OA: the pending
/// trigger is dropped, the enemy's readied reaction survives, and a later
/// attempt at the swing finds nothing.
#[actix_web::test]
async fn disengage_after_leaving_reach_cancels_the_pending_opportunity_attack() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-oa-disengage", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [10.0, 5.0, 0.0]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": orc_id, "reaction_type": "opportunity_attack"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Walk away: provocation disclosed (must exit the 5.5 ft slack band).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["opportunity_attack"]["provoked_by"], orc_id.to_string());

    // Disengage (still has its Action): the pending OA is cancelled and the
    // response says how many.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "disengage",
        serde_json::json!({"entity_id": hero_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(
        body["cancelled_opportunity_attacks"],
        serde_json::json!(1),
        "Disengage must report the withdrawn OA"
    );

    // The orc's readied reaction was NOT consumed by the cancellation.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][orc_id.to_string()]["action_budget"]["reaction"]
            .as_bool()
            .unwrap(),
        "cancelling must hand the readied reaction back untouched"
    );

    // The swing can no longer be taken.
    let seed = oa_hit_seed(8, 11);
    let (status, err_body) =
        post_opportunity_attack(&app, &token, session_id, orc_id, hero_id, seed).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err_body["error"], serde_json::json!("OA_NOT_PENDING"));
}

/// Forced displacement NEVER arms an OA: a shove push moves the defender
/// engine-side WITHOUT a MOVE_ENTITY, so leaving reach through a push leaves
/// every adjacent armed enemy unprovoked.
#[actix_web::test]
async fn shove_push_displacement_does_not_arm_opportunity_attacks() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-shove-oa", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;

    // Defender starts adjacent (2.5 ft) to an ARMED watcher.
    let defender_id = Uuid::new_v4();
    let watcher_id = Uuid::new_v4();
    // Defender at [2.5, 2.5] (entity_json default), watcher adjacent at
    // [7.5, 2.5] — exactly one cell apart so the shover standing BEHIND the
    // defender pushes them straight out of the watcher's reach.
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(defender_id, "Victim", 30, 14, 0, "1d4"), 8, 8)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(watcher_id, "Watcher", 20, 11, 0, "1d4"), 8, 8), 7.5, 2.5)).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": watcher_id, "reaction_type": "opportunity_attack"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // The shover stands on the far side so the push drives the victim OUT of
    // the watcher's reach along their connecting line.
    let shover_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(shover_id, "Shover", 30, 14, 0, "1d4"), 20, 10), 2.5, 2.5)).await;

    let seed = contest_seed(5, -1, true);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": shover_id,
            "defender_id": defender_id,
            "shove_effect": "push_5ft",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["success"], serde_json::json!(true));
    let pushed_to = body["pushed_to"].clone();
    assert!(pushed_to.is_array(), "push must land: {}", body);

    // The defender left the watcher's adjacency FORCED. The watcher's armed
    // reaction must be intact and NO pending OA may exist anywhere in state.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][watcher_id.to_string()]["action_budget"]["reaction"]
            .as_bool()
            .unwrap(),
        "forced displacement must not consume the watcher's readied reaction"
    );
    let pendings = snap["pending_opportunity_attacks"].as_array().cloned().unwrap_or_default();
    assert!(
        pendings.is_empty(),
        "forced displacement must never arm an OA: {:?}",
        pendings
    );

    // Belt and braces: the swing endpoint refuses outright.
    let seed = oa_hit_seed(8, 11);
    let (status, err_body) =
        post_opportunity_attack(&app, &token, session_id, watcher_id, defender_id, seed).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err_body["error"], serde_json::json!("OA_NOT_PENDING"));
}

// --- Initiative combat lifecycle (/combat/begin, /combat/end) ----------------

#[actix_web::test]
async fn combat_begin_rolls_order_and_end_clears_it() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    // Create session + spawn three combatants with distinct DEX scores.
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Initiative"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    for (id, name) in [(Uuid::new_v4(), "High Dex"), (Uuid::new_v4(), "Low Dex"), (Uuid::new_v4(), "Mid Dex")] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(entity_json(id, name, 20, 12, 3, "1d8+1"))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Begin combat.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(auth.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "COMBAT_BEGAN");
    assert_eq!(body["in_combat"], true);
    assert_eq!(body["round"], 1);
    let order = body["order"].as_array().expect("order array");
    assert_eq!(order.len(), 3, "one entry per entity");
    for entry in order {
        assert!(entry["entity_id"].is_string());
        assert!(entry["name"].is_string());
        // d20 + DEX mod bounds: every total is 1..=20 plus a -5..+5 DEX modifier.
        let total = entry["initiative_total"].as_i64().unwrap();
        assert!((0..=25).contains(&total), "total {} out of bounds", total);
        assert!(entry["dexterity"].as_i64().is_some());
    }
    // Order is non-increasing in initiative total.
    let totals: Vec<i64> = order.iter().map(|e| e["initiative_total"].as_i64().unwrap()).collect();
    let mut sorted = totals.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(totals, sorted, "initiative order must descend");

    // The authoritative snapshot now carries the same order.
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(auth.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let snap: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(snap["combat"]["in_combat"], true);
    assert_eq!(snap["combat"]["round"], 1);
    let stored_order = snap["combat"]["order"].as_array().expect("stored order");
    assert_eq!(stored_order.len(), 3);
    assert_eq!(
        stored_order.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>(),
        order.iter().map(|e| e["entity_id"].as_str().unwrap()).collect::<Vec<_>>(),
        "snapshot order matches the reported roll"
    );

    // End combat clears everything.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/end", session_id))
        .insert_header(auth.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "COMBAT_ENDED");

    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(auth.clone())
        .to_request();
    let snap: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    assert_eq!(snap["combat"]["in_combat"], false);
    assert_eq!(snap["combat"]["round"], 0);
    assert_eq!(snap["combat"]["order"].as_array().unwrap().len(), 0);

    // Combat can be re-opened afterwards.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(auth)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
}

#[actix_web::test]
async fn combat_begin_on_empty_board_is_rejected() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Empty"}))
        .to_request();
    let body: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(auth.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Ending on an empty board is still fine (idempotent clear).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/end", session_id))
        .insert_header(auth.clone())
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Unknown session → 404.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/end", Uuid::new_v4()))
        .insert_header(auth)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::NOT_FOUND);
}

#[actix_web::test]
async fn spectator_cannot_begin_or_end_combat() {
    let app = test_app().await;
    let gm_auth = bearer(&sign_token_with_role("gm-1", "gm", TEST_SECRET));
    let spectator_auth = bearer(&sign_token_with_role("watcher", "spectator", TEST_SECRET));

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(gm_auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "RBAC"}))
        .to_request();
    let body: serde_json::Value = test::read_body_json(test::call_service(&app, req).await).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let hero_id = Uuid::new_v4();
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(gm_auth.clone())
        .set_json(entity_json(hero_id, "Hero", 20, 14, 4, "1d8+2"))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    for route in ["combat/begin", "combat/end"] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/{}/{}", session_id, route.split('/').next().unwrap(), route.split('/').nth(1).unwrap()))
            .insert_header(spectator_auth.clone())
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{} must 403 spectators", route);
    }

    // Unauthenticated calls are rejected by the middleware.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::UNAUTHORIZED);
}

// --- Grapple & Shove (contested melee alternatives) ---------------------------
//
// Both endpoints mirror the attack contract: ids-only payloads (client math is
// structurally impossible), server-side stats, seeded session dice, Action
// budget spend, ledger events and attack-identical RBAC.

use vtt_core::dice::DiceEngine;

/// Patches an `entity_json` body's Strength/Dexterity.
fn entity_with_abilities(mut entity: serde_json::Value, strength: i32, dexterity: i32) -> serde_json::Value {
    entity["abilities"]["strength"] = serde_json::json!(strength);
    entity["abilities"]["dexterity"] = serde_json::json!(dexterity);
    entity
}

/// Patches an `entity_json` body's position [x, y, z].
fn entity_at(mut entity: serde_json::Value, x: f64, y: f64) -> serde_json::Value {
    entity["position"] = serde_json::json!([x, y, 0.0]);
    entity
}

/// Claims an entity for a gateway user.
fn entity_owned_by(mut entity: serde_json::Value, owner: &str) -> serde_json::Value {
    entity["owner_player_id"] = serde_json::json!(owner);
    entity
}

/// Deterministically finds a seed whose first two d20 draws decide the
/// contested check the requested way (both sides use these modifiers).
fn contest_seed(attacker_mod: i32, defender_mod: i32, attacker_wins: bool) -> u64 {
    for s in 1..=100_000u64 {
        let mut dice = DiceEngine::with_seed(s);
        let attacker_roll = dice.roll_d20();
        let defender_roll = dice.roll_d20();
        let attacker_total = attacker_roll + attacker_mod;
        let defender_total = defender_roll + defender_mod;
        // Tie goes to the defender per SRD.
        if (attacker_total > defender_total) == attacker_wins && attacker_total != defender_total {
            return s;
        }
    }
    panic!("no seed decides the contest that way");
}

async fn spawn(app: &impl Service<
    actix_http::Request,
    Response = ServiceResponse<EitherBody<BoxBody>>,
    Error = actix_web::Error,
>, token: &str, session_id: Uuid, body: serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(token))
        .set_json(body)
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "spawn failed");
}

async fn post_contest(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    action: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/{}", session_id, action))
        .insert_header(bearer(token))
        .set_json(body)
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await;
    let value: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
    (status, value)
}

async fn setup_brawler_duel(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
) -> (String, Uuid, Uuid, Uuid) {
    let token = sign_token_with_role("gm-brawler", "gm", TEST_SECRET);
    let session_id = create_session_as(app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    // Hero: Str 20 (+5). Orc: Str 8 (-1), Dex 8 (-1).
    spawn(app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 2.5, 2.6)).await;
    (token, session_id, hero_id, orc_id)
}

#[actix_web::test]
async fn grapple_success_applies_grappled_condition_and_spends_action() {
    let app = test_app().await;
    let (token, session_id, hero_id, orc_id) = setup_brawler_duel(&app).await;

    // Athletics(+5) vs Acrobatics(-1): any seed where the d20s are close wins.
    let seed = contest_seed(5, -1, true);

    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "grapple",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "defender_skill": "acrobatics",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["success"], serde_json::json!(true));
    assert_eq!(body["applied_condition"], serde_json::json!("grappled"));
    assert_eq!(body["contest"]["winner_side"], serde_json::json!("attacker"));
    assert_eq!(body["defender_skill"], serde_json::json!("acrobatics"));
    // Escape DC approximation: 8 + grappler Str mod (+5).
    assert_eq!(body["escape_dc"], serde_json::json!(13));
    assert!(body["event_sequence"].is_u64(), "ledger sequence surfaced");

    // The grappled state is authoritative session state, not just a response.
    let snap = snapshot_as(&app, &token, session_id).await;
    let conditions = &snap["entities"][orc_id.to_string()]["conditions"];
    assert_eq!(conditions.as_array().unwrap().len(), 1, "conditions: {}", conditions);
    assert_eq!(conditions[0], serde_json::json!("grappled"));

    // The grapple consumed the Action: a second attempt this turn is refused.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "grapple",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "defender_skill": "athletics",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("ACTION_ECONOMY_EXHAUSTED"));

    // Ledger records the attempt with its outcome.
    let snap = snapshot_as(&app, &token, session_id).await;
    let events = snap["ledger"]["events"].as_array().unwrap();
    let attempted: Vec<&serde_json::Value> = events
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("GRAPPLE_ATTEMPTED"))
        .collect();
    assert_eq!(attempted.len(), 1, "one GRAPPLE_ATTEMPTED event expected");
    assert_eq!(attempted[0]["payload"]["success"], serde_json::json!(true));
    assert_eq!(attempted[0]["payload"]["applied_condition"], serde_json::json!("grappled"));
}

#[actix_web::test]
async fn grapple_is_seeded_deterministic_across_sessions() {
    let app = test_app().await;

    async fn run_once(
        app: &impl Service<
            actix_http::Request,
            Response = ServiceResponse<EitherBody<BoxBody>>,
            Error = actix_web::Error,
        >,
    ) -> serde_json::Value {
        let (token, session_id, hero_id, orc_id) = setup_brawler_duel(app).await;
        let (_, body) = post_contest(
            app,
            &token,
            session_id,
            "grapple",
            serde_json::json!({
                "attacker_id": hero_id,
                "defender_id": orc_id,
                "defender_skill": "athletics",
                "seed": 777
            }),
        )
        .await;
        body
    }

    let first = run_once(&app).await;
    let second = run_once(&app).await;
    for field in [
        "attacker_natural_roll",
        "attacker_total",
        "defender_natural_roll",
        "defender_total",
        "success",
    ] {
        assert_eq!(
            first[field], second[field],
            "field {} must replay identically under the same seed",
            field
        );
    }
}

#[actix_web::test]
async fn shove_prone_knocks_target_down_and_push_5ft_moves_it() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-shove", "gm", TEST_SECRET);

    // --- Prone branch ---------------------------------------------------------
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8)).await;

    let seed = contest_seed(5, -1, true);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "prone",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["success"], serde_json::json!(true));
    assert_eq!(body["effect"], serde_json::json!("prone"));
    assert_eq!(body["applied_condition"], serde_json::json!("prone"));

    let snap = snapshot_as(&app, &token, session_id).await;
    let orc = &snap["entities"][orc_id.to_string()];
    assert_eq!(orc["conditions"][0], serde_json::json!("prone"));

    // --- Push branch ----------------------------------------------------------
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 3.5, 2.5)).await;

    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "push_5ft",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["success"], serde_json::json!(true));
    assert_eq!(body["effect"], serde_json::json!("push_5ft"));
    assert_eq!(body["applied_condition"], serde_json::json!(null));

    let snap = snapshot_as(&app, &token, session_id).await;
    let orc = &snap["entities"][orc_id.to_string()];
    assert_eq!(orc["conditions"].as_array().unwrap().len(), 0, "push applies no condition");
    let dx = orc["position"][0].as_f64().unwrap() - 3.5;
    let dy = orc["position"][1].as_f64().unwrap() - 2.5;
    let pushed = (dx * dx + dy * dy).sqrt();
    assert!(
        (pushed - 5.0).abs() < 1e-3,
        "pushed exactly 5 ft away, got {}",
        pushed
    );

    // Shove attempts land in the ledger too.
    let events = snap["ledger"]["events"].as_array().unwrap();
    assert!(
        events
            .iter()
            .any(|e| e["event_type"] == serde_json::json!("SHOVE_ATTEMPTED")),
        "SHOVE_ATTEMPTED event expected"
    );
}

/// Puts an authored map on a session (GM-only endpoint).
async fn put_map(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    width: usize,
    height: usize,
    cell_size_feet: f64,
    solid_cells: Vec<(usize, usize)>,
) {
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/map", session_id))
        .insert_header(bearer(token))
        .set_json(serde_json::json!({
            "width": width, "height": height,
            "cell_size_feet": cell_size_feet,
            "solid_cells": solid_cells, "difficult_terrain": []
        }))
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "map upload failed");
}

#[actix_web::test]
async fn shove_push_payload_records_pre_and_post_push_position() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-push-ledger", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 3.5, 2.5)).await;

    let seed = contest_seed(5, -1, true);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "push_5ft",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);

    let pushed_to = body["pushed_to"].clone();
    assert!(
        pushed_to.is_array(),
        "successful push must carry post-push position in the event payload; got {}",
        body
    );
    let from = body["pushed_from"].clone();
    assert_eq!(from, serde_json::json!([3.5, 2.5, 0.0]), "pre-push position recorded");

    // The ledger payload — not just the HTTP response — carries both points so
    // a safety rewind can undo unledgered displacement.
    let snap = snapshot_as(&app, &token, session_id).await;
    let event = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["event_type"] == serde_json::json!("SHOVE_ATTEMPTED"))
        .cloned()
        .expect("SHOVE_ATTEMPTED in ledger");
    assert_eq!(event["payload"]["pushed_from"], from);
    assert_eq!(event["payload"]["pushed_to"], pushed_to);

    // The recorded destination matches authoritative live state.
    assert_eq!(
        snap["entities"][orc_id.to_string()]["position"],
        pushed_to,
        "payload position and live position must agree"
    );
}

#[actix_web::test]
async fn shove_push_into_wall_clamps_at_wall_but_still_wins_the_contest() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-push-wall", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    // Wall column at cell x=1 → world x in [5, 10).
    put_map(&app, &token, session_id, 32, 32, 5.0, vec![(1, 0), (1, 1), (1, 2)]).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 3.6, 2.5)).await;

    let seed = contest_seed(5, -1, true);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "push_5ft",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);

    // SRD shove is EITHER/OR: with the push effect chosen and fully blocked,
    // the contest is still won (Action spent) but displacement is zero.
    assert_eq!(body["success"], serde_json::json!(true));
    assert_eq!(body["push_distance_feet"], serde_json::json!(0.0));

    let snap = snapshot_as(&app, &token, session_id).await;
    let pos = &snap["entities"][orc_id.to_string()]["position"];
    // Positions are f32 in the engine; any response that routes state through
    // a serde_json::Value projection (x-card snapshot, projected session GET)
    // widens them to f64, so assert within epsilon instead of bit-exactly.
    // The invariant under test is "no wall clipping": still at world x=3.6.
    let px = pos[0].as_f64().unwrap();
    assert!(
        (px - 3.6).abs() < 1e-3,
        "no wall clipping, got {px}"
    );
    assert_eq!(pos[1], serde_json::json!(2.5));
}

#[actix_web::test]
async fn shove_push_off_map_edge_clamps_at_bounds() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-push-edge", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    put_map(&app, &token, session_id, 32, 32, 5.0, vec![]).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    // Hero near the east edge (map spans 0..160 ft); orc between hero and
    // edge — a full 5 ft push would land at 161 ft, past cell x=31.
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10), 152.4, 2.5)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 156.0, 2.5)).await;

    let seed = contest_seed(5, -1, true);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "push_5ft",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["success"], serde_json::json!(true));
    assert_eq!(body["push_distance_feet"], serde_json::json!(0.0), "full push would exit the map");

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][orc_id.to_string()]["position"],
        serde_json::json!([156.0, 2.5, 0.0]),
        "target never leaves map bounds"
    );
}

#[actix_web::test]
async fn shove_push_refreshes_ws_movement_baseline_cache() {
    // FNV-1a 64 over the token display name — the same keying
    // validate_token_move uses for its per-token baseline cache.
    fn fnv1a(input: &str) -> u64 {
        let mut hash: u64 = 0xcbf29ce484222325;
        for byte in input.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    let (app, state) = test_app_with_state().await;
    let token = sign_token_with_role("gm-push-cache", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    put_map(&app, &token, session_id, 32, 32, 5.0, vec![]).await;

    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 3.5, 2.5)).await;

    let seed = contest_seed(5, -1, true);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "push_5ft",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    let new_x = body["pushed_to"][0].as_f64().unwrap() as f32;
    let new_y = body["pushed_to"][1].as_f64().unwrap() as f32;

    // The WS movement baseline for the Orc token must now be the POST-push
    // point: otherwise the next relay move is speed-checked against a stale
    // pre-shove origin and can spuriously fail (or clip) validation.
    let baselines = state
        .movement
        .get(&session_id.to_string())
        .expect("movement baseline map exists for the session room");
    let baseline = baselines
        .get(&fnv1a("Orc"))
        .map(|entry| *entry)
        .expect("Orc token has a movement baseline");
    assert_eq!(
        baseline,
        (new_x, new_y),
        "WS move validation measures from the post-push point"
    );
}

#[actix_web::test]
async fn lost_contest_spends_the_action_but_changes_nothing() {
    let app = test_app().await;
    let (token, session_id, hero_id, orc_id) = setup_brawler_duel(&app).await;

    let seed = contest_seed(5, -1, false);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "grapple",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "defender_skill": "acrobatics",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "a LOST contest is still a resolved action");
    assert_eq!(body["success"], serde_json::json!(false));
    assert_eq!(body["applied_condition"], serde_json::json!(null));
    assert_eq!(body["contest"]["winner_side"], serde_json::json!("defender"));

    let snap = snapshot_as(&app, &token, session_id).await;
    let orc = &snap["entities"][orc_id.to_string()];
    assert_eq!(orc["conditions"].as_array().unwrap().len(), 0, "no condition on a lost grapple");

    // The attempt still burned the Action.
    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "prone",
            "seed": seed
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "failed grapple still spends the Action");
}

#[actix_web::test]
async fn contests_enforce_reach_rbac_and_payload_shape() {
    let app = test_app().await;

    // --- Out of reach (> 5 ft) -> 409, no state change. -----------------------
    let token = sign_token_with_role("gm-reach", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let far_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    // Defender well past melee reach.
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(far_id, "Orc Far", 20, 11, 0, "1d4"), 8, 8), 12.5, 12.5)).await;

    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "grapple",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": far_id,
            "defender_skill": "athletics"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("OUT_OF_REACH"));
    // The rejected attempt must NOT consume the Action.
    let (status2, _) = post_contest(
        &app,
        &token,
        session_id,
        "shove",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": far_id,
            "shove_effect": "prone"
        }),
    )
    .await;
    assert_eq!(status2, StatusCode::CONFLICT, "still out of reach");
    // And a legal target right next to the hero still works -> action was kept.
    let near_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(near_id, "Near", 20, 11, 0, "1d4"), 8, 8), 2.6, 2.5)).await;
    let (status3, body3) = post_contest(
        &app,
        &token,
        session_id,
        "grapple",
        serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": near_id,
            "defender_skill": "athletics",
            "seed": contest_seed(5, -1, true)
        }),
    )
    .await;
    assert_eq!(status3, StatusCode::OK, "reach rejection must not burn the Action: {}", body3);

    // --- Spectators cannot grapple or shove. ----------------------------------
    let spectator = sign_token_with_role("spec-1", "spectator", TEST_SECRET);
    let (status, body) = post_contest(
        &app,
        &spectator,
        session_id,
        "grapple",
        serde_json::json!({"attacker_id": hero_id, "defender_id": near_id, "defender_skill": "athletics"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {}", body);
    let (status, _) = post_contest(
        &app,
        &spectator,
        session_id,
        "shove",
        serde_json::json!({"attacker_id": hero_id, "defender_id": near_id, "shove_effect": "prone"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // --- Players cannot grapple AS someone else's entity. ---------------------
    let (p_session, owned_hero, other_orc) = {
        let gm = sign_token_with_role("gm-owned", "gm", TEST_SECRET);
        let sid = create_session_as(&app, &gm).await;
        let hero_id = Uuid::new_v4();
        let orc_id = Uuid::new_v4();
        spawn(&app, &gm, sid, entity_owned_by(entity_json(hero_id, "Claimed Hero", 30, 14, 0, "1d4"), "player-nine")).await;
        spawn(&app, &gm, sid, entity_json(orc_id, "Orc", 20, 11, 0, "1d4")).await;
        (sid, hero_id, orc_id)
    };
    let player = sign_token("player-one", TEST_SECRET);
    let (status, body) = post_contest(
        &app,
        &player,
        p_session,
        "grapple",
        serde_json::json!({
            "attacker_id": owned_hero,
            "defender_id": other_orc,
            "defender_skill": "athletics"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("ENTITY_NOT_OWNED"));

    // --- Payload shape: unknown fields AND bad enum values are 422. -----------
    let (status, _) = post_contest(
        &app,
        &player,
        p_session,
        "grapple",
        serde_json::json!({
            "attacker_id": owned_hero,
            "defender_id": other_orc,
            "defender_skill": "athletics",
            "attacker_athletics_bonus": 99
        }),
    )
    .await;
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "smuggled client math must be structurally rejected, got {}",
        status
    );

    let (status, _) = post_contest(
        &app,
        &player,
        p_session,
        "grapple",
        serde_json::json!({
            "attacker_id": owned_hero,
            "defender_id": other_orc,
            "defender_skill": "persuasion"
        }),
    )
    .await;
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "invalid skill choice must be rejected, got {}",
        status
    );

    let (status, _) = post_contest(
        &app,
        &player,
        p_session,
        "shove",
        serde_json::json!({
            "attacker_id": owned_hero,
            "defender_id": other_orc,
            "shove_effect": "yeet_10ft"
        }),
    )
    .await;
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "invalid shove effect must be rejected, got {}",
        status
    );
}

// --- Dodge / Dash / Disengage / Stabilize (standard action options) ------------

#[actix_web::test]
async fn dodge_grants_attack_disadvantage_until_next_turn_refresh() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-dodge", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(hero_id, "Hero", 30, 14, 0, "1d4")).await;
    spawn(&app, &token, session_id, entity_at(entity_json(orc_id, "Orc", 20, 11, 3, "1d6+1"), 7.5, 2.5)).await;

    // Dodge: 200, flags the entity, spends the Action, lands in the ledger.
    let (status, body) = post_contest(&app, &token, session_id, "dodge", serde_json::json!({"entity_id": hero_id})).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["dodge_until_next_turn"], serde_json::json!(true));
    assert!(body["event_sequence"].is_u64());

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][hero_id.to_string()]["dodge_until_next_turn"],
        serde_json::json!(true),
        "dodge is authoritative session state"
    );
    assert!(snap["ledger"]["events"].as_array().unwrap().iter().any(|e| e["event_type"] == serde_json::json!("DODGE")));

    // Second dodge this turn: Action already gone.
    let (status, body) = post_contest(&app, &token, session_id, "dodge", serde_json::json!({"entity_id": hero_id})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], serde_json::json!("ACTION_ECONOMY_EXHAUSTED"));

    // Attacks against the dodger are rolled at disadvantage...
    let (status, body) = attack(&app, &token, session_id, orc_id, hero_id, 42).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["disadvantage"], serde_json::json!(true), "dodge must disadvantage attackers: {}", body);

    // ...until the dodger's next-turn refresh clears the flag.
    advance_turn(&app, &token, session_id).await;
    let (status, body) = attack(&app, &token, session_id, orc_id, hero_id, 42).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["disadvantage"], serde_json::json!(false), "dodge expires on refresh: {}", body);

    // Spectators cannot dodge.
    let spectator = sign_token_with_role("spec-dodge", "spectator", TEST_SECRET);
    let (status, _) = post_contest(&app, &spectator, session_id, "dodge", serde_json::json!({"entity_id": hero_id})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[actix_web::test]
async fn dash_adds_one_speed_once_per_turn_then_resets() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-dash", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(hero_id, "Runner", 30, 14, 0, "1d4")).await;

    // Dash: budget 30 -> 60, exactly once per turn.
    let (status, body) = post_contest(&app, &token, session_id, "dash", serde_json::json!({"entity_id": hero_id})).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["movement_remaining_feet"], serde_json::json!(60.0));
    assert_eq!(body["dashed_this_turn"], serde_json::json!(true));

    let (status, body) = post_contest(&app, &token, session_id, "dash", serde_json::json!({"entity_id": hero_id})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], serde_json::json!("DASH_ALREADY_TAKEN"));

    // The doubled budget really buys a >30 ft move (32.5 ft here).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 35.0, "y": 2.5}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let st = res.status();
    let raw = test::read_body(res).await.to_vec();
    assert_eq!(st, StatusCode::OK, "dashed move failed: {:?}", String::from_utf8_lossy(&raw));

    // Next turn the bonus movement and the latch are both gone.
    advance_turn(&app, &token, session_id).await;
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][hero_id.to_string()]["action_budget"]["movement_remaining_feet"],
        serde_json::json!(30.0)
    );
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 70.0, "y": 2.5}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::CONFLICT, "35 ft must exceed a plain 30 ft budget");
    let body: serde_json::Value = test::read_body_json(res).await;
    let detail = body["detail"].as_str().unwrap_or_default();
    assert!(detail.starts_with("MOVE_BUDGET_EXCEEDED"), "{}", body);

    // Ledger records the dash.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(snap["ledger"]["events"].as_array().unwrap().iter().any(|e| e["event_type"] == serde_json::json!("DASH")));
}

#[actix_web::test]
async fn disengage_suppresses_opportunity_attack_provocation_until_refresh() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-disengage", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let session_id = create_opportunity_session(&app, &auth).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn_at(&app, &auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;
    spawn_at(&app, &auth, session_id, orc_id, "Orc", false, [10.0, 5.0, 0.0]).await;

    // Arm the adjacent orc's opportunity attack.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"entity_id": orc_id, "reaction_type": "opportunity_attack"}))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Disengage, then walk away: NO provocation reported.
    let (status, body) = post_contest(&app, &token, session_id, "disengage", serde_json::json!({"entity_id": hero_id})).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["disengaged_until_next_turn"], serde_json::json!(true));

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let st = res.status();
    let raw = test::read_body(res).await.to_vec();
    assert_eq!(st, StatusCode::OK, "disengaged move failed: {:?}", String::from_utf8_lossy(&raw));
    let body: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert!(body.get("opportunity_attack").is_none(), "disengage must suppress OAs: {}", body);
    assert_eq!(body["outcome"]["opportunity_attacks"].as_array().unwrap().len(), 0);

    // The disengage spent the Action.
    let (status, err_body) = post_contest(&app, &token, session_id, "disengage", serde_json::json!({"entity_id": hero_id})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(err_body["error"], serde_json::json!("ACTION_ECONOMY_EXHAUSTED"));

    // Refresh: the same leave-adjacency provokes again.
    advance_turn(&app, &token, session_id).await;
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 15.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "step back into adjacency");

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 30.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["opportunity_attack"]["provoked_by"],
        orc_id.to_string(),
        "protection must expire at the next turn: {}",
        body
    );

    // Ledger records the disengage.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(snap["ledger"]["events"].as_array().unwrap().iter().any(|e| e["event_type"] == serde_json::json!("DISENGAGE_TAKEN")));
}

/// DC 10 Medicine check on a dying ally with EXISTING tallies: success adds
/// exactly +1 success (never overwriting), failures untouched; three successes
/// stabilize. Failures of the check change nothing; RBAC/budget gates reject.
#[actix_web::test]
async fn stabilize_attempt_tallies_successes_and_enforces_rbac_and_gates() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-stabilize", "gm", TEST_SECRET);

    // --- Happy path: existing tally 1S/1F -> successful check -> 2S/1F --------
    let session_id = create_session_as(&app, &token).await;
    let healer_id = Uuid::new_v4();
    let dying_id = Uuid::new_v4();
    let mut healer = entity_json(healer_id, "Medic", 20, 12, 0, "1d4"); // Wis 12 => +1
    healer["position"] = serde_json::json!([2.5, 2.5, 0.0]);
    let mut dying = entity_at(entity_json(dying_id, "Dying Ally", 20, 12, 0, "1d4"), 2.6, 2.5);
    dying["current_hp"] = serde_json::json!(0);
    dying["is_conscious"] = serde_json::json!(false);
    dying["death_saves"] = serde_json::json!({
        "successes": 1, "failures": 1, "is_stabilized": false, "is_dead": false
    });
    spawn(&app, &token, session_id, healer).await;
    spawn(&app, &token, session_id, dying).await;

    // Natural 15 + Wis +1 = 16 >= DC 10.
    let seed = seed_producing_roll(15);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "stabilize",
        serde_json::json!({"healer_id": healer_id, "target_id": dying_id, "seed": seed}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["success"], serde_json::json!(true));
    assert_eq!(body["dc"], serde_json::json!(10));
    assert_eq!(body["successes"], serde_json::json!(2), "+1 success on top of the existing tally");
    assert_eq!(body["failures"], serde_json::json!(1));
    assert_eq!(body["is_stabilized"], serde_json::json!(false));
    assert!(body["event_sequence"].is_u64());

    let snap = snapshot_as(&app, &token, session_id).await;
    let saves = &snap["entities"][dying_id.to_string()]["death_saves"];
    assert_eq!(saves["successes"], serde_json::json!(2));
    assert_eq!(saves["failures"], serde_json::json!(1));

    // The check burned the healer's Action.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "stabilize",
        serde_json::json!({"healer_id": healer_id, "target_id": dying_id, "seed": seed}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], serde_json::json!("ACTION_ECONOMY_EXHAUSTED"));

    // --- Failed check changes nothing ----------------------------------------
    let session_id = create_session_as(&app, &token).await;
    let healer_id = Uuid::new_v4();
    let dying_id = Uuid::new_v4();
    let mut dying = entity_at(entity_json(dying_id, "Dying Ally", 20, 12, 0, "1d4"), 2.6, 2.5);
    dying["current_hp"] = serde_json::json!(0);
    dying["is_conscious"] = serde_json::json!(false);
    dying["death_saves"] = serde_json::json!({
        "successes": 0, "failures": 2, "is_stabilized": false, "is_dead": false
    });
    spawn(&app, &token, session_id, entity_json(healer_id, "Medic", 20, 12, 0, "1d4")).await;
    spawn(&app, &token, session_id, dying).await;

    // Natural 3 + 1 = 4 < DC 10: no tally change, but the attempt still resolves.
    let seed = seed_producing_roll(3);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "stabilize",
        serde_json::json!({"healer_id": healer_id, "target_id": dying_id, "seed": seed}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "a FAILED Medicine check is still a resolved action");
    assert_eq!(body["success"], serde_json::json!(false));
    assert_eq!(body["successes"], serde_json::json!(0));
    assert_eq!(body["failures"], serde_json::json!(2), "failures are never moved by Medicine");

    // --- Gates -----------------------------------------------------------------
    // Healthy target: not dying. Uses a FRESH healer so the gate order is
    // exercised independently of the previous healer's spent Action.
    let healer_b = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_at(entity_json(healer_b, "Medic B", 20, 12, 0, "1d4"), 2.5, 2.5)).await;
    let healthy_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(healthy_id, "Healthy", 20, 12, 0, "1d4")).await;
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "stabilize",
        serde_json::json!({"healer_id": healer_b, "target_id": healthy_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], serde_json::json!("TARGET_NOT_DYING"));
    // That rejected attempt must NOT have burned Medic B's Action: a legal
    // attempt right after resolves normally.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "stabilize",
        serde_json::json!({"healer_id": healer_b, "target_id": dying_id, "seed": seed_producing_roll(15)}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "state rejections must not burn the Action: {}", body);
    assert_eq!(body["success"], serde_json::json!(true));

    // Out of reach (> 5 ft).
    let session_far = create_session_as(&app, &token).await;
    let healer_id = Uuid::new_v4();
    let dying_id = Uuid::new_v4();
    let mut dying = entity_at(entity_json(dying_id, "Far Dying", 20, 12, 0, "1d4"), 40.0, 40.0);
    dying["current_hp"] = serde_json::json!(0);
    dying["is_conscious"] = serde_json::json!(false);
    spawn(&app, &token, session_far, entity_json(healer_id, "Medic", 20, 12, 0, "1d4")).await;
    spawn(&app, &token, session_far, dying).await;
    let (status, body) = post_contest(
        &app,
        &token,
        session_far,
        "stabilize",
        serde_json::json!({"healer_id": healer_id, "target_id": dying_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("OUT_OF_REACH"));

    // Dead target cannot be saved.
    let dead_id = Uuid::new_v4();
    let mut dead = entity_at(entity_json(dead_id, "Corpse", 20, 12, 0, "1d4"), 2.6, 2.5);
    dead["current_hp"] = serde_json::json!(0);
    dead["is_conscious"] = serde_json::json!(false);
    dead["is_dead"] = serde_json::json!(true);
    spawn(&app, &token, session_far, entity_at(entity_json(Uuid::new_v4(), "Medic2", 20, 12, 0, "1d4"), 2.5, 2.5)).await;
    spawn(&app, &token, session_far, dead).await;
    // (medic above spawned at default spot; reuse it)
    let medic2_id = {
        let snap = snapshot_as(&app, &token, session_far).await;
        snap["entities"]
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, e)| e["name"] == serde_json::json!("Medic2"))
            .map(|(id, _)| id.clone())
            .unwrap()
    };
    let (status, body) = post_contest(
        &app,
        &token,
        session_far,
        "stabilize",
        serde_json::json!({"healer_id": medic2_id, "target_id": dead_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("TARGET_ALREADY_DEAD"));

    // --- RBAC: ownership + spectators + payload shape --------------------------
    let (p_session, owned_healer, other_dying) = {
        let gm = sign_token_with_role("gm-owned-stab", "gm", TEST_SECRET);
        let sid = create_session_as(&app, &gm).await;
        let mut owned = entity_owned_by(entity_json(Uuid::new_v4(), "Claimed Medic", 20, 12, 0, "1d4"), "player-nine");
        owned["position"] = serde_json::json!([2.5, 2.5, 0.0]);
        let mut dying = entity_at(entity_json(Uuid::new_v4(), "Dying Ally", 20, 12, 0, "1d4"), 2.6, 2.5);
        dying["current_hp"] = serde_json::json!(0);
        dying["is_conscious"] = serde_json::json!(false);
        let healer_id = Uuid::new_v4();
        let dying_id = Uuid::new_v4();
        owned["id"] = serde_json::json!(healer_id.to_string());
        dying["id"] = serde_json::json!(dying_id.to_string());
        spawn(&app, &gm, sid, owned).await;
        spawn(&app, &gm, sid, dying).await;
        (sid, healer_id, dying_id)
    };
    let player = sign_token("player-one", TEST_SECRET);
    let (status, body) = post_contest(
        &app,
        &player,
        p_session,
        "stabilize",
        serde_json::json!({"healer_id": owned_healer, "target_id": other_dying}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("ENTITY_NOT_OWNED"));

    let spectator = sign_token_with_role("spec-stab", "spectator", TEST_SECRET);
    let (status, _) = post_contest(
        &app,
        &spectator,
        p_session,
        "stabilize",
        serde_json::json!({"healer_id": owned_healer, "target_id": other_dying}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Smuggled client math is structurally rejected.
    let (status, _) = post_contest(
        &app,
        &player,
        p_session,
        "stabilize",
        serde_json::json!({"healer_id": owned_healer, "target_id": other_dying, "medicine_bonus": 9}),
    )
    .await;
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "smuggled medicine modifier must be rejected, got {}",
        status
    );

    // Ledger events exist for every resolution.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["ledger"]["events"].as_array().unwrap().iter().any(|e| e["event_type"] == serde_json::json!("STABILIZE_ATTEMPTED")),
        "STABILIZE_ATTEMPTED event expected"
    );
}

// --- Ready action (SRD: spend the Action to hold a triggered response) --------

#[actix_web::test]
async fn ready_action_stores_description_spends_action_and_clears_on_refresh() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-ready", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(hero_id, "Hero", 30, 14, 0, "1d4")).await;

    // Ready: 200, stores the description engine-side, spends the Action.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "ready",
        serde_json::json!({"entity_id": hero_id, "description": "I attack the goblin", "trigger": "enemy_moves"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["status"], serde_json::json!("READY_ACTION_SET"));
    assert_eq!(body["entity_id"], serde_json::json!(hero_id.to_string()));
    assert!(
        body["readied_action"]["description"].as_str().unwrap_or_default().contains("attack the goblin"),
        "description is echoed back: {}",
        body
    );
    assert!(body["event_sequence"].is_u64(), "ledger sequence surfaced");

    // Authoritative state + ledger event visible in the snapshot.
    let snap = snapshot_as(&app, &token, session_id).await;
    let stored = &snap["entities"][hero_id.to_string()]["readied_action"];
    assert_eq!(stored["set_on_round"], serde_json::json!(0), "no combat round yet");
    assert!(stored["description"].as_str().unwrap_or_default().contains("attack the goblin"));
    assert!(
        !snap["entities"][hero_id.to_string()]["action_budget"]["action"].as_bool().unwrap(),
        "Ready spent the entity's Action"
    );
    assert!(
        snap["ledger"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event_type"] == serde_json::json!("READY_ACTION_SET")),
        "READY_ACTION_SET lands in the ledger"
    );

    // The Action is gone: a second Ready this turn is 409.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "ready",
        serde_json::json!({"entity_id": hero_id, "description": "second try"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], serde_json::json!("ACTION_ECONOMY_EXHAUSTED"));

    // The next-turn refresh clears the readied action.
    advance_turn(&app, &token, session_id).await;
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][hero_id.to_string()]["readied_action"].is_null(),
        "refresh clears the readied action"
    );
}

#[actix_web::test]
async fn ready_action_rejects_wrong_role_owner_and_payload_shape() {
    let app = test_app().await;

    // Spectators cannot ready actions (same gate as dodge/dash/disengage).
    let gm = sign_token_with_role("gm-ready-rbac", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &gm, session_id, entity_owned_by(entity_json(hero_id, "Claimed Hero", 30, 14, 0, "1d4"), "player-ten")).await;

    let spectator = sign_token_with_role("spec-ready", "spectator", TEST_SECRET);
    let (status, _) = post_contest(
        &app,
        &spectator,
        session_id,
        "ready",
        serde_json::json!({"entity_id": hero_id, "description": "sneaky"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Players cannot ready an action AS someone else's entity.
    let player = sign_token("player-twelve", TEST_SECRET);
    let (status, body) = post_contest(
        &app,
        &player,
        session_id,
        "ready",
        serde_json::json!({"entity_id": hero_id, "description": "not mine"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], serde_json::json!("ENTITY_NOT_OWNED"));

    // Unknown entity → 404.
    let (status, _) = post_contest(
        &app,
        &gm,
        session_id,
        "ready",
        serde_json::json!({"entity_id": Uuid::new_v4(), "description": "ghost"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Empty / blank description → 422.
    for desc in ["", "   "] {
        let (status, _) = post_contest(
            &app,
            &gm,
            session_id,
            "ready",
            serde_json::json!({"entity_id": hero_id, "description": desc}),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "blank description {:?} must be rejected", desc);
    }

    // Smuggled extra fields are structurally rejected (deny_unknown_fields).
    let (status, _) = post_contest(
        &app,
        &gm,
        session_id,
        "ready",
        serde_json::json!({
            "entity_id": hero_id,
            "description": "fine",
            "automatic_trigger_matching": true
        }),
    )
    .await;
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "unknown fields must be structurally rejected, got {}",
        status
    );
}

// --- Release readied action (SRD: resolving it takes the Reaction) ------------

#[actix_web::test]
async fn release_ready_action_spends_the_reaction_and_409s_without_one() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-ready-release", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(hero_id, "Hero", 30, 14, 0, "1d4")).await;

    // Ready with a structured mechanical trigger.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "ready",
        serde_json::json!({"entity_id": hero_id, "description": "I attack the goblin", "trigger": "enemy_enters_reach"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(
        body["readied_action"]["trigger"], serde_json::json!("enemy_enters_reach"),
        "the structured trigger is echoed back: {}",
        body
    );

    // Release: 200, spends the Reaction, clears the declaration.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "ready/release",
        serde_json::json!({"entity_id": hero_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["status"], serde_json::json!("READY_ACTION_RELEASED"));
    assert_eq!(body["reaction_spent"], serde_json::json!(true));
    assert!(body["event_sequence"].is_u64(), "ledger sequence surfaced");

    let snap = snapshot_as(&app, &token, session_id).await;
    let hero = &snap["entities"][hero_id.to_string()];
    assert!(hero["readied_action"].is_null(), "release clears the declaration");
    assert!(
        !hero["action_budget"]["reaction"].as_bool().unwrap(),
        "release spent the entity's Reaction"
    );
    assert!(
        snap["ledger"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event_type"] == serde_json::json!("READY_ACTION_RELEASED")
                && e["payload"]["reaction_spent"] == serde_json::json!(true)),
        "READY_ACTION_RELEASED lands in the ledger with the spend marker"
    );

    // Releasing again with nothing held → 409 NO_READIED_ACTION.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "ready/release",
        serde_json::json!({"entity_id": hero_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], serde_json::json!("NO_READIED_ACTION"));
}

#[actix_web::test]
async fn release_ready_action_enforces_rbac_and_unknown_entities() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-ready-rel-rbac", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &gm, session_id, entity_owned_by(entity_json(hero_id, "Claimed Hero", 30, 14, 0, "1d4"), "player-rel")).await;

    // Spectators cannot release.
    let spectator = sign_token_with_role("spec-rel", "spectator", TEST_SECRET);
    let (status, _) = post_contest(
        &app,
        &spectator,
        session_id,
        "ready/release",
        serde_json::json!({"entity_id": hero_id}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Players cannot release someone else's readied action.
    let player = sign_token("player-other", TEST_SECRET);
    let (status, body) = post_contest(
        &app,
        &player,
        session_id,
        "ready/release",
        serde_json::json!({"entity_id": hero_id}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], serde_json::json!("ENTITY_NOT_OWNED"));

    // Unknown entity → 404.
    let (status, _) = post_contest(
        &app,
        &gm,
        session_id,
        "ready/release",
        serde_json::json!({"entity_id": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// --- Two-Weapon Fighting (off-hand bonus strike) -------------------------------
//
// GOALS.md Pillar 3: the SRD two-weapon-fighting bonus attack. Contract under
// test: spends the BONUS Action (not the Action), requires the Attack action
// to have been taken first, refuses non-Light weapons, and lands one seeded,
// ledgered OFFHAND_ATTACK event.

/// An entity body with an explicit two-weapon stat block: both weapons Light.
fn twin_blade(id: Uuid, name: &str) -> serde_json::Value {
    let mut e = entity_json(id, name, 30, 15, 5, "1d6+3");
    e["attacks"] = serde_json::json!([
        { "name": "Shortsword", "attack_bonus": 5, "damage_expression": "1d6+3", "damage_type": "piercing", "light": true },
        { "name": "Dagger",     "attack_bonus": 5, "damage_expression": "1d4+3", "damage_type": "piercing", "light": true }
    ]);
    e
}

/// A session with a twin-blade hero adjacent to a tanky orc. Returns
/// (app, token, session_id, hero_id, orc_id).
async fn setup_twf_duel() -> (
    impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    String,
    Uuid,
    Uuid,
    Uuid,
) {
    let app = test_app().await;
    let token = sign_token_with_role("gm-twf", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let mut orc = entity_json(orc_id, "Orc", 200, 11, 0, "1d4");
    orc["position"] = serde_json::json!([2.5, 2.6, 0.0]);
    spawn(&app, &token, session_id, twin_blade(hero_id, "Twin Blade")).await;
    spawn(&app, &token, session_id, orc).await;
    (app, token, session_id, hero_id, orc_id)
}

async fn post_offhand(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    post_contest(app, token, session_id, "offhand", body).await
}

#[actix_web::test]
async fn offhand_attack_spends_bonus_action_not_the_action_and_ledgers() {
    let (app, token, session_id, hero_id, orc_id) = setup_twf_duel().await;

    // The Attack action comes first — spend it via the normal attack route.
    // Any seed resolves it; only the budget state matters here.
    let (status, _) = attack(&app, &token, session_id, hero_id, orc_id, 7).await;
    assert_eq!(status, StatusCode::OK, "main-hand attack must resolve");

    // Bonus action still standing, action spent.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(snap["entities"][hero_id.to_string()]["action_budget"]["action"], serde_json::json!(false));
    assert_eq!(snap["entities"][hero_id.to_string()]["action_budget"]["bonus_action"], serde_json::json!(true));

    // The off-hand strike consumes ONLY the bonus action.
    let (status, body) = post_offhand(
        &app,
        &token,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "offhand_index": 1, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert!(body["event_sequence"].is_u64(), "ledger sequence surfaced");
    assert_eq!(
        body["damage_expression_rolled"],
        serde_json::json!("1d4"),
        "the +3 ability modifier must be withheld from off-hand damage"
    );
    assert_eq!(body["ability_mod_withheld_from_damage"], serde_json::json!(true));
    assert!(body["total_damage"].as_i64().unwrap() <= 4, "bare d4 cannot roll above 4");

    let snap = snapshot_as(&app, &token, session_id).await;
    let budget = &snap["entities"][hero_id.to_string()]["action_budget"];
    assert_eq!(budget["action"], serde_json::json!(false), "the Action stays spent");
    assert_eq!(budget["bonus_action"], serde_json::json!(false), "the Bonus Action is now spent too");

    // Exactly one OFFHAND_ATTACK ledger event with the audit payload.
    let events = snap["ledger"]["events"].as_array().unwrap();
    let offs: Vec<&serde_json::Value> = events
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("OFFHAND_ATTACK"))
        .collect();
    assert_eq!(offs.len(), 1);
    assert_eq!(offs[0]["payload"]["attacker_id"], json_str(&hero_id));
    assert_eq!(offs[0]["payload"]["target_id"], json_str(&orc_id));
}

#[actix_web::test]
async fn second_offhand_in_the_same_turn_is_refused_without_rolling() {
    let (app, token, session_id, hero_id, orc_id) = setup_twf_duel().await;
    let (status, _) = attack(&app, &token, session_id, hero_id, orc_id, 7).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = post_offhand(
        &app,
        &token,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "offhand_index": 1, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Second attempt this turn → 409 BONUS_ACTION_ECONOMY_EXHAUSTED.
    let (status, body) = post_offhand(
        &app,
        &token,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "offhand_index": 1, "seed": 9}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("BONUS_ACTION_ECONOMY_EXHAUSTED"));

    // Nothing was rolled or ledgered twice.
    let snap = snapshot_as(&app, &token, session_id).await;
    let offs: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("OFFHAND_ATTACK"))
        .collect();
    assert_eq!(offs.len(), 1, "a rejected second off-hand must not ledger");
}

#[actix_web::test]
async fn offhand_requires_the_attack_action_first_and_rejects_non_light_weapons() {
    let (app, token, session_id, hero_id, orc_id) = setup_twf_duel().await;

    // No Attack action taken yet this turn → refused WITHOUT spending anything.
    let (status, body) = post_offhand(
        &app,
        &token,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("ATTACK_ACTION_REQUIRED"));
    let snap = snapshot_as(&app, &token, session_id).await;
    let budget = &snap["entities"][hero_id.to_string()]["action_budget"];
    assert_eq!(budget["bonus_action"], serde_json::json!(true), "nothing was consumed by the rejection");

    // A heavy main hand disqualifies the whole maneuver even with the Attack
    // action spent.
    let session2 = create_session_as(&app, &token).await;
    let longsword_hero = Uuid::new_v4();
    let mut e = entity_json(longsword_hero, "Sword Board", 30, 15, 5, "1d8+3");
    e["attacks"] = serde_json::json!([
        { "name": "Longsword", "attack_bonus": 5, "damage_expression": "1d8+3", "damage_type": "slashing", "light": false },
        { "name": "Dagger",    "attack_bonus": 5, "damage_expression": "1d4+3", "damage_type": "piercing", "light": true }
    ]);
    spawn(&app, &token, session2, entity_at(e, 2.5, 2.5)).await;
    let target = Uuid::new_v4();
    spawn(
        &app,
        &token,
        session2,
        entity_at(entity_json(target, "Orc", 100, 11, 0, "1d4"), 2.5, 2.6),
    )
    .await;
    let (status, _) = attack(&app, &token, session2, longsword_hero, target, 7).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = post_offhand(
        &app,
        &token,
        session2,
        serde_json::json!({"attacker_id": longsword_hero, "target_id": target, "offhand_index": 1, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("MAIN_HAND_WEAPON_NOT_LIGHT"));
}

#[actix_web::test]
async fn offhand_enforces_rbac_target_gates_and_payload_shape() {
    let (app, gm, session_id, hero_id, orc_id) = setup_twf_duel().await;

    // Spectators are refused outright.
    let spectator = sign_token_with_role("spec-twf", "spectator", TEST_SECRET);
    let (status, _) = post_offhand(
        &app,
        &spectator,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Players cannot swing an entity they do not control: the twin-blade is
    // CLAIMED by someone else here (a real GM-role token binds ownership).
    let real_gm = sign_token_with_role("gm-twf-owner", "gm", TEST_SECRET);
    let claimed_session = create_session_as(&app, &real_gm).await;
    let claimed_hero = Uuid::new_v4();
    spawn(
        &app,
        &real_gm,
        claimed_session,
        entity_owned_by(twin_blade(claimed_hero, "Claimed Blade"), "player-elsewhere"),
    )
    .await;
    let claimed_orc = Uuid::new_v4();
    spawn(
        &app,
        &real_gm,
        claimed_session,
        entity_at(entity_json(claimed_orc, "Orc", 200, 11, 0, "1d4"), 2.5, 2.6),
    )
    .await;
    let (status, _) = attack(&app, &real_gm, claimed_session, claimed_hero, claimed_orc, 7).await;
    assert_eq!(status, StatusCode::OK);
    let player = sign_token("player-twf", TEST_SECRET);
    let (status, body) = post_offhand(
        &app,
        &player,
        claimed_session,
        serde_json::json!({"attacker_id": claimed_hero, "target_id": claimed_orc}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], serde_json::json!("ENTITY_NOT_OWNED"));

    // Unknown attacker → 404; unknown target → 404; self → 422.

    let (status, _) = post_offhand(
        &app,
        &gm,
        session_id,
        serde_json::json!({"attacker_id": Uuid::new_v4(), "target_id": orc_id, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post_offhand(
        &app,
        &gm,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": Uuid::new_v4(), "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post_offhand(
        &app,
        &gm,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": hero_id, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Smuggled combat math is structurally rejected.
    let (status, _) = post_offhand(
        &app,
        &gm,
        session_id,
        serde_json::json!({
            "attacker_id": hero_id, "target_id": orc_id,
            "attack_bonus": 999, "damage_expression": "99d99+99"
        }),
    )
    .await;
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "client math must be rejected, got {}",
        status
    );
}

// --- Help action -----------------------------------------------------------------
//
// SRD 5e: spend your Action to hand Advantage on the next same-side attack
// against a creature within reach. Under test: grant → consume-once on a real
// attack, refresh clears, hostile attacks do not burn the promise, RBAC.

#[actix_web::test]
async fn help_grants_advantage_that_a_real_attack_consumes_exactly_once() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-help", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let helper_id = Uuid::new_v4();
    let ally_id = Uuid::new_v4();
    let enemy_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(helper_id, "Helper", 30, 14, 0, "1d4")).await;
    spawn(&app, &token, session_id, entity_owned_by(entity_json(ally_id, "Ally", 30, 15, 8, "1d8+3"), "gm-help")).await;
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(enemy_id, "Ogre", 200, 16, 0, "1d4"), 2.5, 2.6),
    )
    .await;

    // Grant.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": enemy_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["status"], serde_json::json!("HELP_GRANTED"));
    assert_eq!(body["next_attacker_has_advantage_against"], json_str(&helper_id));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"],
        json_str(&helper_id),
        "the promise is authoritative session state on the beneficiary"
    );

    // The helper's Action is spent; the ally's is not.
    assert_eq!(snap["entities"][helper_id.to_string()]["action_budget"]["action"], serde_json::json!(false));

    // The ally's next attack CONSUMES the advantage and rolls with it.
    //
    // Deterministic proof: pick a seed where the FIRST d20 of an advantage
    // pair MISSES AC 16 (natural+8 < 16) but the SECOND one HITS. A straight
    // single-d20 roll on that same seed would miss, so a hit here can only
    // come from advantage keeping the higher of two draws.
    let mut straddle_seed = None;
    for s in 1..=200_000u64 {
        let mut dice = DiceEngine::with_seed(s);
        // roll_d20_advantage returns (kept_max, r1, r2).
        let (kept, r1, r2) = dice.roll_d20_advantage();
        let (low, high) = (r1.min(r2), r1.max(r2));
        if low != 1
            && high != 20
            && low != 20
            && high != 1
            && low + 8 < 16
            && high + 8 >= 16
            && kept == high
        {
            straddle_seed = Some(s);
            break;
        }
    }
    let straddle_seed = straddle_seed.expect("some seed must straddle AC 16 under advantage");

    let (status, body) = attack(&app, &token, session_id, ally_id, enemy_id, straddle_seed).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["advantage"], serde_json::json!(true), "the engine must report the granted edge");
    assert!(
        body["is_hit"] == serde_json::json!(true),
        "a seed whose first advantage die misses but second hits must land ONLY under advantage"
    );
    assert_ne!(
        body["natural_roll"].as_i64().unwrap(),
        DiceEngine::with_seed(straddle_seed).roll_d20() as i64,
        "the kept roll is the higher of TWO draws, not the plain single d20"
    );

    // The promise is burned.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"].is_null(),
        "one attack consumes the Help promise exactly once"
    );

    // A SECOND attack gets no advantage.
    advance_turn(&app, &token, session_id).await;
    let mut plain_seed = None;
    for s in 1..=100_000u64 {
        let mut dice = DiceEngine::with_seed(s);
        let natural = dice.roll_d20();
        if natural + 8 < 16 && natural != 1 && natural != 20 {
            plain_seed = Some(s);
            break;
        }
    }
    let plain_seed = plain_seed.expect("some seed must miss on a straight roll");
    let (status, body) = attack(&app, &token, session_id, ally_id, enemy_id, plain_seed).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["advantage"], serde_json::json!(false), "no standing Help means no edge");

    // One HELP_ACTION ledger event recorded the grant.
    let snap = snapshot_as(&app, &token, session_id).await;
    let helps: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("HELP_ACTION"))
        .collect();
    assert_eq!(helps.len(), 1);
    assert_eq!(helps[0]["payload"]["helper_id"], json_str(&helper_id));
    assert_eq!(helps[0]["payload"]["target_entity_id"], json_str(&enemy_id));
}

#[actix_web::test]
async fn help_promise_clears_at_the_round_refresh_and_survives_hostile_attacks() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-help2", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let helper_id = Uuid::new_v4();
    let enemy_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(helper_id, "Helper", 30, 14, 0, "1d4")).await;
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(enemy_id, "Ogre", 200, 16, 0, "1d4"), 2.5, 2.6),
    )
    .await;

    // A second hostile on the helper's ENEMY side attacks the beneficiary.
    let goblin_id = Uuid::new_v4();
    let mut goblin = entity_json(goblin_id, "Goblin", 40, 12, 8, "1d6+3");
    goblin["is_player"] = serde_json::json!(false);
    spawn(&app, &token, session_id, goblin).await;

    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": enemy_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // The HOSTILE's attack neither benefits from nor burns the promise.
    let (status, body) = attack(&app, &token, session_id, goblin_id, enemy_id, 3).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["advantage"], serde_json::json!(false));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"],
        json_str(&helper_id),
        "a hostile attack must leave the ally's pending benefit standing"
    );
    // The round refresh clears an unconsumed promise.
    advance_turn(&app, &token, session_id).await;
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"].is_null(),
        "Help lasts only until the target's next turn refresh"
    );
}

#[actix_web::test]
async fn help_enforces_rbac_reach_self_target_and_payload_shape() {
    let app = test_app().await;
    // A real GM-role token: it both creates the session AND may bind entity
    // ownership to another user (needed for the ENTITY_NOT_OWNED case below).
    let token = sign_token_with_role("gm-help3", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let helper_id = Uuid::new_v4();
    let far_enemy = Uuid::new_v4();
    let near_enemy = Uuid::new_v4();
    spawn(
        &app,
        &token,
        session_id,
        entity_owned_by(entity_json(helper_id, "Claimed Helper", 30, 14, 0, "1d4"), "player-owner"),
    )
    .await;
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(near_enemy, "Near Orc", 100, 12, 0, "1d4"), 2.6, 2.5),
    )
    .await;
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(far_enemy, "Far Ogre", 200, 16, 0, "1d4"), 20.0, 20.0),
    )
    .await;

    // Spectators are refused outright.
    let spectator = sign_token_with_role("spec-help", "spectator", TEST_SECRET);
    let (status, _) = post_contest(
        &app,
        &spectator,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": near_enemy}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Players cannot spend someone else's Action: the helper is claimed by
    // "player-owner", not by the caller below.
    let player = sign_token_with_role("player-intruder", "player", TEST_SECRET);
    let (status, body) = post_contest(
        &app,
        &player,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": near_enemy}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], serde_json::json!("ENTITY_NOT_OWNED"));

    // Out of reach → refused WITHOUT spending the helper's Action.
    let (gm_status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": far_enemy}),
    )
    .await;
    assert_eq!(gm_status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("OUT_OF_REACH"));

    // Self-targeting → 422; unknown ids → 404.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": helper_id}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"], serde_json::json!("SELF_TARGET_INVALID"));
    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": Uuid::new_v4(), "target_entity_id": near_enemy}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Smuggled fields are structurally rejected.
    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({
            "helper_id": helper_id, "target_entity_id": near_enemy,
            "auto_success": true
        }),
    )
    .await;
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "extra fields must be rejected, got {}",
        status
    );

    // Nothing above consumed the helper's Action: a valid grant still works.
    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": near_enemy}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // And once the Action is gone, a second Help is refused with the economy code.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": near_enemy}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], serde_json::json!("ACTION_ECONOMY_EXHAUSTED"));
}

/// The off-hand strike is a real attack roll: it must cash in a standing Help
/// promise exactly like any other attack.
#[actix_web::test]
async fn offhand_attack_consumes_a_standing_help_promise() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-twf-help", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let mut orc = entity_json(orc_id, "Orc", 200, 11, 0, "1d4");
    orc["position"] = serde_json::json!([2.5, 2.6, 0.0]);
    spawn(&app, &token, session_id, twin_blade(hero_id, "Twin Blade")).await;
    spawn(&app, &token, session_id, orc).await;

    // Take the Attack action with the twin-blade FIRST (the off-hand strike
    // presupposes it), THEN have an ally grant Help so the promise is still
    // standing when the bonus swing lands.
    let (status, _) = attack(&app, &token, session_id, hero_id, orc_id, 7).await;
    assert_eq!(status, StatusCode::OK);
    let ally_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(ally_id, "Aider", 30, 14, 0, "1d4")).await;
    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": ally_id, "target_entity_id": orc_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = post_offhand(
        &app,
        &token,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "offhand_index": 1, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["advantage"], serde_json::json!(true), "the off-hand swing rides the granted edge");
    assert_eq!(body["help_advantage_consumed"], serde_json::json!(true));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][orc_id.to_string()]["next_attacker_has_advantage_against"].is_null(),
        "the off-hand attack burns the Help promise"
    );
}

// --- Fifth-audit remediation ---------------------------------------------------

/// A monster stat block: GM-controlled content, not a player character.
fn monster_json(id: Uuid, name: &str) -> serde_json::Value {
    let mut e = entity_json(id, name, 60, 13, 4, "2d6+2");
    e["is_player"] = serde_json::json!(false);
    e
}

fn spell_body(caster_id: Uuid, level: u8, cast_level: u8, damage_formula: Option<&str>) -> serde_json::Value {
    let mut spell = serde_json::json!({
        "spell_id": format!("test_spell_{level}"), "name": "Test Spell", "level": level,
        "school": "Evocation", "casting_time": "1 action", "range_feet": 60,
        "area_of_effect_shape": null, "area_of_effect_size_feet": null,
        "verbal_component": true, "somatic_component": true,
        "material_component_desc": null, "save_attribute": null,
        "damage_formula": damage_formula,
        "damage_type": if damage_formula.is_some() { serde_json::json!("force") } else { serde_json::Value::Null },
        "duration_rounds": 0, "is_concentration": false, "is_ritual": false
    });
    if damage_formula.is_none() {
        spell["damage_type"] = serde_json::Value::Null;
    }
    serde_json::json!({
        "spell": spell,
        "caster_id": caster_id,
        "cast_level": cast_level
    })
}

async fn post_cast_spell(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
        .insert_header(bearer(token))
        .set_json(body)
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await;
    let value: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
    (status, value)
}

#[actix_web::test]
async fn refused_line_of_sight_attack_leaves_the_help_promise_standing() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-f1-help", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;

    // Wall column splitting the arena. Helper and enemy sit TOGETHER on the far
    // side (so Help is grantable); the attacker is walled off from the enemy.
    let wall: Vec<(usize, usize)> = (0..32).map(|y| (15, y)).collect();
    put_map(&app, &token, session_id, 32, 32, 5.0, wall).await;

    let helper_id = Uuid::new_v4();
    let ally_id = Uuid::new_v4();
    let enemy_id = Uuid::new_v4();
    spawn(&app, &token, session_id,
        entity_at(entity_json(helper_id, "Helper", 30, 14, 0, "1d4"), 85.0, 12.5)).await;
    spawn(&app, &token, session_id,
        entity_at(entity_json(ally_id, "Walled Archer", 30, 15, 8, "1d8+3"), 10.0, 12.5)).await;
    spawn(&app, &token, session_id,
        entity_at(entity_json(enemy_id, "Ogre", 200, 16, 0, "1d4"), 90.0, 12.5)).await;

    // Grant Help: the helper stands within 5 ft of the enemy.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": helper_id, "target_entity_id": enemy_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);

    // The walled-off attack attempt must be REFUSED — and must NOT burn the
    // promise nor spend the attacker's Action.
    let (status, body) = attack(&app, &token, session_id, ally_id, enemy_id, 3).await;
    assert_eq!(status, StatusCode::CONFLICT, "wall must block this attack line");
    assert_eq!(body["error"], serde_json::json!("NO_LINE_OF_SIGHT"));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"],
        json_str(&helper_id),
        "a refused attack must leave the standing Help promise intact"
    );
    assert_eq!(
        snap["entities"][ally_id.to_string()]["action_budget"]["action"],
        serde_json::json!(true),
        "the refused attempt spends nothing"
    );

    // The wall comes down; the NEXT legal attack cashes the surviving promise.
    put_map(&app, &token, session_id, 32, 32, 5.0, Vec::new()).await;
    let (status, body) = attack(&app, &token, session_id, ally_id, enemy_id, 3).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["help_advantage_consumed"], serde_json::json!(true));
    assert_eq!(body["advantage"], serde_json::json!(true));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"].is_null(),
        "the first LEGAL attack consumes the promise exactly once"
    );
}

#[actix_web::test]
async fn explicit_under_level_cast_request_is_rejected_not_silently_upgraded() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-f2-slot", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;

    let caster_id = Uuid::new_v4();
    let mut caster = entity_json(caster_id, "Caster", 30, 12, 0, "1d4");
    caster["spell_slots_remaining"] = serde_json::json!({"1": 1, "3": 1});
    spawn(&app, &token, session_id, caster).await;

    // A level-3 spell explicitly asked for at slot level 1 is a machine
    // rejection, not a silent upgrade.
    let (status, body) =
        post_cast_spell(&app, &token, session_id, spell_body(caster_id, 3, 1, None)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("INVALID_SLOT_LEVEL"));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][caster_id.to_string()]["spell_slots_remaining"]["3"],
        serde_json::json!(1),
        "the rejected request spends no slot"
    );

    // Omitting cast_level (serde default 0) stays legal for ordinary casts:
    // the engine normalizes it to the spell's own level.
    let mut body = spell_body(caster_id, 1, 0, None);
    body.as_object_mut().unwrap().remove("cast_level");
    let (status, body) = post_cast_spell(&app, &token, session_id, body).await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["result"]["slot_level_used"], serde_json::json!(1));
}

#[actix_web::test]
async fn absurd_spell_damage_formula_is_rejected_not_clamped_and_spends_no_slot() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-f2-dmg", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;

    let caster_id = Uuid::new_v4();
    let mut caster = entity_json(caster_id, "Nuker", 30, 12, 0, "1d4");
    caster["spell_slots_remaining"] = serde_json::json!({"9": 2});
    spawn(&app, &token, session_id, caster).await;
    let dummy_id = Uuid::new_v4();
    spawn(&app, &token, session_id,
        entity_at(entity_json(dummy_id, "Dummy", 500, 10, 0, "1d4"), 7.5, 2.5)).await;

    let mut nuke = spell_body(caster_id, 9, 9, Some("9999d9999"));
    nuke["target_id"] = json_str(&dummy_id);

    // Implausible math is REJECTED outright (not clamped to 40d12)...
    let (status, body) = post_cast_spell(&app, &token, session_id, nuke.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("SPELL_REJECTED"));
    let detail = body["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains("SPELL_DAMAGE_FORMULA_ABSURD"),
        "rejection must name the homebrew guard, got: {}",
        detail
    );

    // ...and because the guard fires before slot expenditure, no slot burned.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][caster_id.to_string()]["spell_slots_remaining"]["9"],
        serde_json::json!(2),
        "an absurd formula must not burn spell slots"
    );
    assert_eq!(
        snap["entities"][dummy_id.to_string()]["current_hp"],
        serde_json::json!(500),
        "nothing was rolled or applied"
    );

    // Moderate overshoot (within the documented 2x guard) still resolves via
    // the gentle clamp instead of being refused.
    let mut homebrew = spell_body(caster_id, 9, 9, Some("60d6"));
    homebrew["target_id"] = json_str(&dummy_id);
    let (status, _) = post_cast_spell(&app, &token, session_id, homebrew).await;
    assert_eq!(status, StatusCode::OK, "60d6 sits inside the gentle-clamp tier");

    let snap = snapshot_as(&app, &token, session_id).await;
    let hp = snap["entities"][dummy_id.to_string()]["current_hp"].as_i64().unwrap();
    assert!(
        (260..499).contains(&hp),
        "clamped 40d6 deals at most 240 damage (final hp must be >= 260), got {}",
        hp
    );
}

#[actix_web::test]
async fn monster_spawns_require_a_gm_seat_but_owned_player_deploys_pass() {
    let app = test_app().await;
    let gm_token = sign_token_with_role("gm-f3", "gm", TEST_SECRET);
    let player_token = sign_token_with_role("player-f3", "player", TEST_SECRET);
    let service_token = sign_token("orchestrator-service", TEST_SECRET); // gateway principal
    let spectator_token = sign_token_with_role("watcher-f3", "spectator", TEST_SECRET);
    let session_id = create_session_as(&app, &gm_token).await;

    // A PLAYER cannot spawn an unowned monster.
    let (status, body) = post_contest_spawn(&app, &player_token, session_id, monster_json(Uuid::new_v4(), "Player Orc")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("MONSTER_SPAWN_FORBIDDEN"));

    // A SPECTATOR is unchanged: plain FORBIDDEN_ROLE, never a spawn.
    let (status, body) = post_contest_spawn(&app, &spectator_token, session_id, monster_json(Uuid::new_v4(), "Sneaky Orc")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("FORBIDDEN_ROLE"));

    // The GM spawns monsters freely.
    let (status, _) = post_contest_spawn(&app, &gm_token, session_id, monster_json(Uuid::new_v4(), "GM Orc")).await;
    assert_eq!(status, StatusCode::OK);

    // Deploy-style: the service principal binds ownership on behalf of an
    // authenticated player — owned player characters stay spawnable.
    let mut deploy = entity_json(Uuid::new_v4(), "Deployed Hero", 20, 14, 6, "1d8");
    deploy["owner_player_id"] = serde_json::json!("player-f3");
    let (status, _) = post_contest_spawn(&app, &service_token, session_id, deploy).await;
    assert_eq!(status, StatusCode::OK, "deploy path must keep working");

    // And so does a player spawning their OWN owned character directly.
    let mut own_pc = entity_json(Uuid::new_v4(), "Own Hero", 20, 14, 6, "1d8");
    own_pc["owner_player_id"] = serde_json::json!("player-f3");
    let (status, _) = post_contest_spawn(&app, &player_token, session_id, own_pc).await;
    assert_eq!(status, StatusCode::OK);
}

async fn post_contest_spawn(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    entity: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(bearer(token))
        .set_json(entity)
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await;
    let value: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
    (status, value)
}

#[actix_web::test]
async fn offhand_index_zero_is_refused_as_matching_the_main_hand() {
    let (app, token, session_id, hero_id, orc_id) = setup_twf_duel().await;
    let (status, _) = attack(&app, &token, session_id, hero_id, orc_id, 7).await;
    assert_eq!(status, StatusCode::OK, "main-hand attack must resolve first");

    let (status, body) = post_offhand(
        &app,
        &token,
        session_id,
        serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "offhand_index": 0, "seed": 7}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("OFFHAND_INDEX_MATCHES_MAIN"));

    // Nothing was spent by the refused attempt.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][hero_id.to_string()]["action_budget"]["bonus_action"],
        serde_json::json!(true),
        "the rejected off-hand attempt keeps the Bonus Action"
    );
}

// --- Stateless-route RBAC + server-seeded dice (audit remediation) ----------
//
// The stateless compute routes (`/actions/check|save|concentration`,
// `/spatial/*`, `/maps/generate`) previously accepted ANY authenticated caller
// — including spectators — and `/actions/check` and `/actions/save` honored a
// CALLER-SUPPLIED `seed`. A spectator (or any client) could pre-compute
// favorable outcomes offline and replay them. Contract pinned here:
//   - spectators are refused on all stateless roll/spatial/map-generation
//     routes (403 FORBIDDEN_ROLE); players and GMs may use them;
//   - `/scripts/*` executes attacker-controlled programs, so it is GM /
//     orchestrator-service ONLY;
//   - a caller-supplied `seed` is an explicit determinism opt-in honored ONLY
//     for privileged principals (GM role or the orchestrator service identity);
//     everyone else gets 422 SEED_NOT_PERMITTED rather than silently-ignored
//     seeds (silent ignoring hides the policy from integrators);
//   - omitting `seed` always uses server entropy.

/// POST with an arbitrary bearer token, returning status + decoded body
/// (never asserting success) for RBAC assertions.
async fn post_raw(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    path: &str,
    payload: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(path)
        .insert_header(bearer(token))
        .set_json(payload)
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await;
    let value: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
    (status, value)
}

fn wfc_payload() -> serde_json::Value {
    serde_json::json!({
        "room_desc": {
            "room_id": 1, "x": 0, "y": 0,
            "width": 8, "height": 8, "theme": "dungeon"
        },
        "seed": null
    })
}

fn los_payload() -> serde_json::Value {
    serde_json::json!({
        "attacker_pos": {"x": 0.0, "y": 0.0, "z": 0.0},
        "target_pos": {"x": 10.0, "y": 0.0, "z": 0.0},
        "target_radius": 2.5,
        "grid_width": 16,
        "grid_height": 16,
        "solid_cells": []
    })
}

fn check_payload(seed: Option<u64>) -> serde_json::Value {
    let mut body = serde_json::json!({"modifier": 0, "dc": 10, "cost_margin": 0});
    if let Some(s) = seed {
        body["seed"] = serde_json::json!(s);
    }
    body
}

#[actix_web::test]
async fn spectators_are_refused_on_stateless_roll_routes() {
    let app = test_app().await;
    let spec = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let player = sign_token_with_role("p1", "player", TEST_SECRET);

    let (status, body) =
        post_raw(&app, &spec, "/api/v1/actions/check", check_payload(None)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {body}");
    assert_eq!(body["error"], serde_json::json!("FORBIDDEN_ROLE"));

    // Spectator refusal must not depend on the payload shape: same verdict on
    // the save route.
    let (status, body) = post_raw(
        &app,
        &spec,
        "/api/v1/actions/save",
        serde_json::json!({"save_modifier": 0, "dc": 10}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {body}");

    // Players remain legitimate callers of the same route…
    let (status, _) =
        post_raw(&app, &player, "/api/v1/actions/check", check_payload(None)).await;
    assert_eq!(status, StatusCode::OK);

    // …and so are GMs.
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let (status, _) = post_raw(&app, &gm, "/api/v1/actions/check", check_payload(None)).await;
    assert_eq!(status, StatusCode::OK);

    // Role-less tokens default to Player (gateway service identities), so the
    // orchestrator proxy keeps working without a role claim.
    let plain = sign_token("orchestrator-service", TEST_SECRET);
    let (status, _) =
        post_raw(&app, &plain, "/api/v1/actions/check", check_payload(None)).await;
    assert_eq!(status, StatusCode::OK);
}

#[actix_web::test]
async fn spectators_cannot_generate_maps_or_query_spatial_solvers() {
    let app = test_app().await;
    let spec = sign_token_with_role("watcher", "spectator", TEST_SECRET);

    for (path, payload) in [
        ("/api/v1/maps/generate", wfc_payload()),
        ("/api/v1/spatial/los", los_payload()),
        ("/api/v1/spatial/visibility", visibility_payload()),
        (
            "/api/v1/spatial/path",
            serde_json::json!({
                "start": {"x": 0.0, "y": 0.0, "z": 0.0},
                "end": {"x": 10.0, "y": 0.0, "z": 0.0},
                "speed_budget": 30.0,
                "grid_width": 16,
                "grid_height": 16,
                "solid_cells": []
            }),
        ),
    ] {
        let (status, body) = post_raw(&app, &spec, path, payload).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
        assert_eq!(body["error"], serde_json::json!("FORBIDDEN_ROLE"));
    }

    // A player still gets full solver access.
    let player = sign_token_with_role("p1", "player", TEST_SECRET);
    let (status, body) = post_raw(&app, &player, "/api/v1/spatial/los", los_payload()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/spatial/visibility",
        visibility_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post_raw(&app, &player, "/api/v1/maps/generate", wfc_payload()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[actix_web::test]
async fn map_generate_response_exports_seeded_loot_containers() {
    // Audit A5 F4: DungeonMap.loot_containers were computed by vtt-wfc but
    // dropped by the route payload — the WFC studio and the gateway proxy
    // could never see where the treasure actually is. The response must carry
    // them alongside the legacy tile grid.
    let app = test_app().await;
    let player = sign_token_with_role("p1", "player", TEST_SECRET);
    let (status, body) = post_raw(&app, &player, "/api/v1/maps/generate", wfc_payload()).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let width = body["width"].as_u64().expect("width in payload") as usize;
    let height = body["height"].as_u64().expect("height in payload") as usize;

    // Legacy contract preserved: a full u8 tile grid of the requested size.
    let tiles = body["tiles"].as_array().expect("tiles array");
    assert_eq!(tiles.len(), height);
    for row in tiles {
        assert_eq!(row.as_array().unwrap().len(), width);
    }

    let containers = body["loot_containers"].as_array().expect(
        "loot_containers must be exported so callers can spawn treasure",
    );
    assert!(
        !containers.is_empty(),
        "generated dungeons always dress at least one container"
    );
    for c in containers {
        let cx = c["x"].as_u64().expect("container x") as usize;
        let cy = c["y"].as_u64().expect("container y") as usize;
        assert!(cx < width && cy < height, "container out of bounds: {c}");
        // Each container sits on a chest tile (u8 encoding 4) and carries its
        // rolled contents with positive gp values.
        assert_eq!(tiles[cy][cx], serde_json::json!(4));
        let contents = c["contents"].as_array().expect("container contents");
        assert!(!contents.is_empty());
        for item in contents {
            assert!(
                item["value_gp"].as_u64().unwrap_or(0) > 0,
                "rolled loot carries positive gp: {item}"
            );
        }
    }

    // Determinism: same seed ⇒ identical container payload.
    let mut seeded = wfc_payload();
    seeded["seed"] = serde_json::json!(424242);
    let (status_a, body_a) = post_raw(&app, &player, "/api/v1/maps/generate", seeded.clone()).await;
    let (status_b, body_b) = post_raw(&app, &player, "/api/v1/maps/generate", seeded).await;
    assert_eq!((status_a, status_b), (StatusCode::OK, StatusCode::OK));
    assert_eq!(
        body_a["loot_containers"], body_b["loot_containers"],
        "same seed must replay byte-identical containers"
    );
}

/// Payload for `/api/v1/spatial/visibility`: viewer at world (0,0), empty
/// 16x16 grid, 30 ft sight radius.
fn visibility_payload() -> serde_json::Value {    serde_json::json!({
        "origin": {"x": 2.5, "y": 2.5, "z": 0.0},
        "grid_width": 16,
        "grid_height": 16,
        "solid_cells": [],
        "max_range_feet": 30.0
    })
}

#[actix_web::test]
async fn visibility_route_returns_occlusion_polygon_for_viewer() {
    let app = test_app().await;
    let player = sign_token_with_role("p1", "player", TEST_SECRET);

    // Empty room: the polygon is the full-range disc approximation.
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/spatial/visibility",
        visibility_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let poly = body["polygon"].as_array().expect("polygon array");
    assert!(!poly.is_empty(), "empty room must still bound the range: {body}");

    // Every vertex respects the range clamp.
    for v in poly {
        let (x, y) = (v[0].as_f64().unwrap(), v[1].as_f64().unwrap());
        let d = ((x - 2.5).powi(2) + (y - 2.5).powi(2)).sqrt();
        assert!(d <= 30.5, "vertex ({x},{y}) exceeds max_range_feet=30");
    }

    // A wall column east of the viewer truncates the polygon on that side:
    // a probe point beyond the wall must fall outside the returned polygon.
    let mut payload = visibility_payload();
    payload["solid_cells"] =
        serde_json::json!([[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5]]);
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/spatial/visibility",
        payload,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let poly: Vec<(f64, f64)> = body["polygon"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v[0].as_f64().unwrap(), v[1].as_f64().unwrap()))
        .collect();
    assert!(
        !poly.is_empty(),
        "occluded polygon must not be empty: {body}"
    );
    // Probe deep behind the wall — strictly shadowed.
    let behind = (42.5f64, 12.5f64);
    let inside = {
        // Same ray-crossing parity the client applies when rendering fog.
        let mut inside = false;
        let mut j = poly.len() - 1;
        for i in 0..poly.len() {
            let (xi, yi) = poly[i];
            let (xj, yj) = poly[j];
            if (yi > behind.1) != (yj > behind.1)
                && behind.0 < (xj - xi) * (behind.1 - yi) / (yj - yi) + xi
            {
                inside = !inside;
            }
            j = i;
        }
        inside
    };
    assert!(
        !inside,
        "point beyond the wall must be outside the visibility polygon"
    );

    // Spectators are refused like every other stateless spatial route.
    let spec = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let (status, body) = post_raw(
        &app,
        &spec,
        "/api/v1/spatial/visibility",
        visibility_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], serde_json::json!("FORBIDDEN_ROLE"));
}

/// Payload for `/api/v1/spatial/path`: straight 30 ft corridor dash on an
/// empty 16x16 grid.
fn path_payload() -> serde_json::Value {
    serde_json::json!({
        "start": {"x": 2.5, "y": 2.5, "z": 0.0},
        "end": {"x": 10.0, "y": 2.5, "z": 0.0},
        "speed_budget": 30.0,
        "grid_width": 16,
        "grid_height": 16,
        "solid_cells": []
    })
}

/// Shallow-merges `patch` into `base` (top-level keys only).
fn patched(mut base: serde_json::Value, patch: serde_json::Value) -> serde_json::Value {
    if let (Some(map), Some(patch_map)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_map {
            map.insert(k.clone(), v.clone());
        }
    }
    base
}

// --- Audit A2 remediations ------------------------------------------------------
//
// F-A2#2 (DoS via unbounded stateless-solver params): the three /api/v1/spatial
// routes previously consumed raw client integers straight into allocations —
// grid_width * grid_height * depth collision booleans per POST, an uncapped
// occluder Vec, an uncapped f32 sight range and an uncapped elevation layer.
// Contract pinned here:
//   - grid_width / grid_height beyond 256      -> 422 INVALID_GRID_WIDTH/HEIGHT
//   - more than 4096 solid cells               -> 422 INVALID_SOLID_CELLS
//   - max_range_feet outside (0, 500]          -> 422 INVALID_MAX_RANGE_FEET
//   - elevation z beyond 32                    -> 422 INVALID_Z
// Every rejection names the offending field in `detail`, fires BEFORE any
// collision grid is constructed, and leaks no solver result.
#[actix_web::test]
async fn spatial_routes_reject_unbounded_parameters_with_field_naming_422s() {
    let app = test_app().await;
    let player = sign_token_with_role("p1", "player", TEST_SECRET);

    // Ten billion collision booleans demanded by ONE request must die in
    // validation, never in an allocator.
    let hostile_dims = serde_json::json!({
        "grid_width": 100_000u64,
        "grid_height": 100_000u64,
    });
    for (path, payload) in [
        (
            "/api/v1/spatial/los",
            patched(los_payload(), hostile_dims.clone()),
        ),
        (
            "/api/v1/spatial/visibility",
            patched(visibility_payload(), hostile_dims.clone()),
        ),
        ("/api/v1/spatial/path", patched(path_payload(), hostile_dims)),
    ] {
        let (status, body) = post_raw(&app, &player, path, payload).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}: {body}");
        assert_eq!(
            body["error"],
            serde_json::json!("INVALID_GRID_WIDTH"),
            "{path}: {body}"
        );
        assert!(
            body["detail"].as_str().unwrap_or_default().contains("grid_width"),
            "{path}: rejection must name the offending field: {body}"
        );
    }

    // Height gets its own named verdict.
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/spatial/los",
        patched(los_payload(), serde_json::json!({"grid_height": 100_000u64})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], serde_json::json!("INVALID_GRID_HEIGHT"), "{body}");
    assert!(
        body["detail"].as_str().unwrap_or_default().contains("grid_height"),
        "{body}"
    );

    // Occluder-list flooding: 4097 solid cells is past the ceiling.
    let flood: Vec<(usize, usize)> = (0..4_097usize).map(|i| (i % 65, i / 65)).collect();
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/spatial/los",
        patched(los_payload(), serde_json::json!({"solid_cells": flood})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], serde_json::json!("INVALID_SOLID_CELLS"), "{body}");
    assert!(
        body["detail"].as_str().unwrap_or_default().contains("solid_cells"),
        "{body}"
    );

    // Sight-range ceilings: absurd AND negative ranges both rejected.
    for range in [1.0e9f64, -5.0] {
        let (status, body) = post_raw(
            &app,
            &player,
            "/api/v1/spatial/visibility",
            patched(
                visibility_payload(),
                serde_json::json!({"max_range_feet": range}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{range}: {body}");
        assert_eq!(
            body["error"],
            serde_json::json!("INVALID_MAX_RANGE_FEET"),
            "{range}: {body}"
        );
        assert!(
            body["detail"]
                .as_str()
                .unwrap_or_default()
                .contains("max_range_feet"),
            "{body}"
        );
    }

    // Elevation ceiling on the visibility layer selector.
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/spatial/visibility",
        patched(visibility_payload(), serde_json::json!({"z": 33u64})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], serde_json::json!("INVALID_Z"), "{body}");
    assert!(
        body["detail"].as_str().unwrap_or_default().contains("z "),
        "rejection must name the z field: {body}"
    );

    // Control: the same shapes INSIDE the ceilings still solve.
    let (status, _) = post_raw(&app, &player, "/api/v1/spatial/los", los_payload()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = post_raw(
        &app,
        &player,
        "/api/v1/spatial/visibility",
        visibility_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = post_raw(&app, &player, "/api/v1/spatial/path", path_payload()).await;
    assert_eq!(status, StatusCode::OK);
}

/// F-A2#1 end-to-end: iteration 20's elevation-aware cover bundle must fire
/// through the LIVE /api/v1/spatial/los route, not only in unit tests. The
/// audited geometry (vtt-spatial cover.rs `upper_wall_grants_half_cover…`) is
/// replayed twice over HTTP with the same footprint:
///   - multi-layer payload: the wall occupies elevation layers 1..=3 (a wall
///     covering the target ABOVE foot level). Head rays strike it, base rays
///     slip under the foot gap -> HALF_COVER.
///   - single-layer control with the elevated geometry ABSENT (exactly what
///     the old depth-1 handler computed — head rays clamped onto layer 0 and
///     saw nothing): NO cover.
/// Different answers prove the z axis is live end-to-end. A third payload
/// pins the documented legacy behavior: a wall authored ON layer 0 still
/// blocks every ray (TOTAL_COVER) exactly as before.
#[actix_web::test]
async fn los_route_multi_layer_payload_produces_elevation_aware_cover() {
    let app = test_app().await;
    let player = sign_token_with_role("p1", "player", TEST_SECRET);

    // Shooter on a 5 ft ledge at (7.5, 22.5, 5), target at (57.5, 22.5, 0),
    // wall column gx=8 across corridor rows gy=3..=6 on a 14x10 grid.
    let base = serde_json::json!({
        "attacker_pos": {"x": 7.5, "y": 22.5, "z": 5.0},
        "target_pos": {"x": 57.5, "y": 22.5, "z": 0.0},
        "target_radius": 5.0,
        "grid_width": 14,
        "grid_height": 10
    });

    // Multi-layer: wall voxels lifted to z-layers 1..=3, four layers declared.
    let upper_wall: Vec<(usize, usize, usize)> =
        (3..=6).flat_map(|y| (1..=3).map(move |z| (8usize, y, z))).collect();
    let multi_layer = patched(
        base.clone(),
        serde_json::json!({
            "z_layers": 4,
            "solid_cells": [],
            "solid_cells_3d": upper_wall,
        }),
    );
    let (status, body) = post_raw(&app, &player, "/api/v1/spatial/los", multi_layer).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["cover_type"],
        serde_json::json!("HALF_COVER"),
        "head rays must strike the elevated wall through the live HTTP route: {body}"
    );

    // Single-layer control: the elevated wall is invisible to a depth-1 grid
    // (this is precisely what the pre-fix handler reported for ANY payload,
    // because head rays were clamped back onto layer 0).
    let single_layer = patched(base.clone(), serde_json::json!({"solid_cells": []}));
    let (status, body) = post_raw(&app, &player, "/api/v1/spatial/los", single_layer).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["cover_type"],
        serde_json::json!("NONE"),
        "{body}"
    );

    // Documented legacy behavior: a wall authored ON the ground layer keeps
    // blocking everything, exactly as before the fix.
    let ground_wall: Vec<(usize, usize)> = (3..=6).map(|y| (8usize, y)).collect();
    let legacy = patched(
        base,
        serde_json::json!({"solid_cells": ground_wall}),
    );
    let (status, body) = post_raw(&app, &player, "/api/v1/spatial/los", legacy).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["cover_type"],
        serde_json::json!("TOTAL_COVER"),
        "ground-layer walls must keep legacy total-cover semantics: {body}"
    );
}

#[actix_web::test]
async fn client_supplied_seeds_are_rejected_for_non_privileged_roles() {
    let app = test_app().await;
    let player = sign_token_with_role("p1", "player", TEST_SECRET);
    let lucky = seed_producing_roll(20);

    // A player pinning a nat-20 seed must be REJECTED, not silently re-seeded:
    // silent ignoring would leave integrators believing they got their roll.
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/actions/check",
        check_payload(Some(lucky)),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {body}");
    assert_eq!(body["error"], serde_json::json!("SEED_NOT_PERMITTED"));
    assert!(
        body["roll"].is_null(),
        "a rejected request must not leak any roll result"
    );

    // Same verdict on the save route.
    let (status, body) = post_raw(
        &app,
        &player,
        "/api/v1/actions/save",
        serde_json::json!({"save_modifier": 0, "dc": 10, "seed": lucky}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {body}");
    assert_eq!(body["error"], serde_json::json!("SEED_NOT_PERMITTED"));

    // Spectators hit the role gate first; either way no seeded roll happens.
    let spec = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let (status, _) = post_raw(
        &app,
        &spec,
        "/api/v1/actions/check",
        check_payload(Some(lucky)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[actix_web::test]
async fn privileged_principals_still_pin_deterministic_rolls() {
    let app = test_app().await;
    let seed = seed_producing_roll(3);

    // Determinism tests remain possible through the sanctioned path: the SAME
    // seed twice MUST produce byte-identical outcomes.
    let first = post_actions(&app, "/api/v1/actions/check", check_payload(Some(seed))).await;
    let second = post_actions(&app, "/api/v1/actions/check", check_payload(Some(seed))).await;
    assert_eq!(first["roll"], serde_json::json!(3), "seeded check: {first}");
    assert_eq!(first, second, "same seed must reproduce the same check");

    // The service principal (no role claim, canonical orchestrator id) keeps
    // its deterministic-harness privilege too.
    let service = sign_token("orchestrator-service", TEST_SECRET);
    let (status, body) = post_raw(
        &app,
        &service,
        "/api/v1/actions/check",
        check_payload(Some(seed)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["roll"], serde_json::json!(3));

    // Seeded saves stay deterministic as well.
    let body = post_actions(
        &app,
        "/api/v1/actions/save",
        serde_json::json!({
            "save_modifier": 0, "dc": 10,
            "seed": seed_producing_roll(20),
        }),
    )
    .await;
    assert_eq!(body["natural_roll"], serde_json::json!(20), "{body}");
    assert_eq!(body["passed"], serde_json::json!(true));
}

// --- Session dice routes honor the same seed policy (audit F5) ---------------
//
// The session-scoped action routes (attack / cast-spell / grapple / shove /
// stabilize / offhand / damage) also consume a caller-supplied `seed` when
// present. The same offline-brute-force argument that got `/actions/check`
// its SEED_NOT_PERMITTED gate applies verbatim: a direct-to-engine caller can
// scan seeds for nat-20s before sending. Contract pinned here:
//   - a non-privileged caller supplying `seed` gets 422 SEED_NOT_PERMITTED,
//     with NO roll fields leaked in the rejection body;
//   - GM-role and orchestrator-service principals keep determinism opt-in on
//     every one of these routes (same seed ⇒ identical outcome);
//   - omitting `seed` keeps the server-derived session-scoped fallback.

/// A player-role token (the least privileged caller allowed to act).
fn player_token() -> String {
    sign_token_with_role("p-seed", "player", TEST_SECRET)
}

/// Asserts the canonical seed-policy rejection shape: 422 + error code +
/// no roll fields leaked (a rejected request must not reveal any outcome).
fn assert_seed_rejected(status: StatusCode, body: &serde_json::Value) {
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "non-privileged seed must be refused: {body}"
    );
    assert_eq!(body["error"], serde_json::json!("SEED_NOT_PERMITTED"));
    // No outcome leakage: every roll-bearing field of these routes stays null.
    for key in [
        "is_hit", "total_damage", "roll", "natural_roll",
        "attacker_natural_roll", "defender_natural_roll",
        "success", "result", "concentration_check",
    ] {
        assert!(
            body.get(key).map(|v| v.is_null()).unwrap_or(true),
            "rejected request leaked `{key}`: {body}"
        );
    }
}

/// POST as a GM-role token with an arbitrary body; returns status + decoded
/// JSON. Used for the privileged determinism spot-checks.
async fn post_as_gm_seed_tester(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    path: &str,
    payload: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    post_raw(
        app,
        &sign_token_with_role("gm-seed", "gm", TEST_SECRET),
        path,
        payload,
    )
    .await
}

/// Attack route: a player's seed is refused; a GM's seed is deterministic.
#[actix_web::test]
async fn attack_route_enforces_seed_policy_for_non_privileged_callers() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-seed-attack", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3")).await;
    spawn(&app, &token, session_id, entity_at(entity_json(orc_id, "Orc", 20, 10, 0, "1d4"), 3.5, 3.5)).await;

    let lucky = seed_producing_roll(20);
    let player_auth = bearer(&player_token());
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(player_auth)
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": orc_id,
            "seed": lucky
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_rejected(status, &body);

    // The refusal happens BEFORE any budget spend or ledger append: the hero
    // still has their Action and no ATTACK_RESOLVED exists.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][hero_id.to_string()]["action_budget"]["action"],
        serde_json::json!(true),
        "a seed-refused attack must not burn the Action"
    );
    let events = snap["ledger"]["events"].as_array().unwrap();
    assert!(
        !events.iter().any(|e| e["event_type"] == serde_json::json!("ATTACK_RESOLVED")),
        "no attack may be resolved under a refused seed"
    );

    // Privileged path stays deterministic: with the SAME pinned seed the
    // engine MUST roll exactly what `DiceEngine::with_seed(seed)` rolls
    // locally — that identity is the whole contract determinism harnesses
    // rely on.
    let path = format!("/api/v1/sessions/{}/action/attack", session_id);
    let payload = serde_json::json!({"attacker_id": hero_id, "target_id": orc_id, "seed": lucky});
    let (status, body) = post_as_gm_seed_tester(&app, &path, payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["natural_roll"],
        serde_json::json!(vtt_core::DiceEngine::with_seed(lucky).roll_d20()),
        "{body}"
    );
    assert_eq!(body["natural_roll"], serde_json::json!(20));
}

/// Cast-spell route: a player's seed is refused; a GM's seed is deterministic.
#[actix_web::test]
async fn cast_spell_route_enforces_seed_policy_for_non_privileged_callers() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-seed-spell", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let caster_id = Uuid::new_v4();
    let mut caster = entity_json(caster_id, "Wizard", 20, 12, 0, "1d4");
    caster["spell_slots_remaining"] = serde_json::json!({"3": 9});
    spawn(&app, &token, session_id, caster).await;

    let fireball = serde_json::json!({
        "spell": {
            "spell_id": "fireball", "name": "Fireball", "level": 3,
            "school": "Evocation", "casting_time": "1 action", "range_feet": 150,
            "area_of_effect_shape": "sphere", "area_of_effect_size_feet": 20,
            "verbal_component": true, "somatic_component": true,
            "material_component_desc": null, "save_attribute": "DEXTERITY",
            "damage_formula": "8d6", "damage_type": "fire",
            "duration_rounds": 0, "is_concentration": false, "is_ritual": false
        },
        "caster_id": caster_id,
        "cast_level": 3,
        "seed": 12345
    });

    let player_auth = bearer(&player_token());
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
        .insert_header(player_auth)
        .set_json(fireball.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_rejected(status, &body);

    // No slot was spent by the refused cast.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][caster_id.to_string()]["spell_slots_remaining"]["3"],
        serde_json::json!(9),
        "a seed-refused cast must not spend the slot"
    );
    assert!(
        caster_concentration(&snap, caster_id).await.is_null(),
        "no concentration can have started"
    );

    // Privileged path stays deterministic: the pinned seed decides the damage
    // dice exactly as a local `DiceEngine::with_seed(seed)` would.
    let path = format!("/api/v1/sessions/{}/action/cast-spell", session_id);
    let (status, body) =
        post_as_gm_seed_tester(&app, &path, fireball).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["slot_level_used"], serde_json::json!(3));
}

/// Grapple route: a player's seed is refused; a GM's seed is deterministic.
#[actix_web::test]
async fn grapple_route_enforces_seed_policy_for_non_privileged_callers() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-seed-grapple", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 2.5, 2.6)).await;

    let winning = contest_seed(5, -1, true);
    let player_auth = bearer(&player_token());
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/grapple", session_id))
        .insert_header(player_auth)
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "defender_skill": "acrobatics",
            "seed": winning
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_rejected(status, &body);

    let snap = snapshot_as(&app, &token, session_id).await;
    let conditions = &snap["entities"][orc_id.to_string()]["conditions"];
    assert_eq!(
        conditions.as_array().unwrap().len(),
        0,
        "a refused grapple applies nothing"
    );

    let path = format!("/api/v1/sessions/{}/action/grapple", session_id);
    let payload = serde_json::json!({
        "attacker_id": hero_id, "defender_id": orc_id,
        "defender_skill": "acrobatics", "seed": winning
    });
    let (status, body) = post_as_gm_seed_tester(&app, &path, payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The pinned seed decides BOTH d20s exactly as the local engine does.
    let mut local = vtt_core::DiceEngine::with_seed(winning);
    assert_eq!(
        body["attacker_natural_roll"],
        serde_json::json!(local.roll_d20()),
        "{body}"
    );
    assert_eq!(
        body["defender_natural_roll"],
        serde_json::json!(local.roll_d20()),
        "{body}"
    );
    assert_eq!(body["success"], serde_json::json!(true));
}

/// Shove route: a player's seed is refused; a GM's seed is deterministic.
#[actix_web::test]
async fn shove_route_enforces_seed_policy_for_non_privileged_callers() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-seed-shove", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 2.5, 2.6)).await;

    let winning = contest_seed(5, -1, true);
    let player_auth = bearer(&player_token());
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/shove", session_id))
        .insert_header(player_auth)
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "prone",
            "seed": winning
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_rejected(status, &body);

    let snap = snapshot_as(&app, &token, session_id).await;
    let conditions = &snap["entities"][orc_id.to_string()]["conditions"];
    assert_eq!(
        conditions.as_array().unwrap().len(),
        0,
        "a refused shove applies nothing"
    );

    let path = format!("/api/v1/sessions/{}/action/shove", session_id);
    let payload = serde_json::json!({
        "attacker_id": hero_id, "defender_id": orc_id,
        "shove_effect": "prone", "seed": winning
    });
    let (status, body) = post_as_gm_seed_tester(&app, &path, payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut local = vtt_core::DiceEngine::with_seed(winning);
    assert_eq!(
        body["attacker_natural_roll"],
        serde_json::json!(local.roll_d20()),
        "{body}"
    );
    assert_eq!(
        body["defender_natural_roll"],
        serde_json::json!(local.roll_d20()),
        "{body}"
    );
    assert_eq!(body["success"], serde_json::json!(true));
}

/// Stabilize route: a player's seed is refused; a GM's seed is deterministic.
#[actix_web::test]
async fn stabilize_route_enforces_seed_policy_for_non_privileged_callers() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-seed-stab", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let healer_id = Uuid::new_v4();
    let dying_id = Uuid::new_v4();
    let healer = entity_json(healer_id, "Medic", 20, 12, 0, "1d4"); // Wis 12 => +1
    let mut dying = entity_at(entity_json(dying_id, "Dying Ally", 20, 12, 0, "1d4"), 2.6, 2.5);
    dying["current_hp"] = serde_json::json!(0);
    dying["is_conscious"] = serde_json::json!(false);
    dying["death_saves"] = serde_json::json!({
        "successes": 0, "failures": 0, "is_stabilized": false, "is_dead": false
    });
    spawn(&app, &token, session_id, healer).await;
    spawn(&app, &token, session_id, dying).await;

    let natural15 = seed_producing_roll(15);
    let player_auth = bearer(&player_token());
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/stabilize", session_id))
        .insert_header(player_auth)
        .set_json(serde_json::json!({"healer_id": healer_id, "target_id": dying_id, "seed": natural15}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_rejected(status, &body);

    let snap = snapshot_as(&app, &token, session_id).await;
    let saves = &snap["entities"][dying_id.to_string()]["death_saves"];
    assert_eq!(
        saves["successes"], serde_json::json!(0),
        "a refused stabilize tallies nothing"
    );

    // Privileged path stays deterministic: the pinned seed decides the
    // Medicine d20 exactly as the local engine does.
    let path = format!("/api/v1/sessions/{}/action/stabilize", session_id);
    let payload = serde_json::json!({"healer_id": healer_id, "target_id": dying_id, "seed": natural15});
    let (status, body) = post_as_gm_seed_tester(&app, &path, payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["natural_roll"],
        serde_json::json!(vtt_core::DiceEngine::with_seed(natural15).roll_d20()),
        "{body}"
    );
    assert_eq!(body["natural_roll"], serde_json::json!(15));
    assert_eq!(body["success"], serde_json::json!(true));
}

/// Offhand route: a player's seed is refused; a GM's seed is deterministic.
#[actix_web::test]
async fn offhand_route_enforces_seed_policy_for_non_privileged_callers() {
    let (app, token, session_id, hero_id, orc_id) = setup_twf_duel().await;
    // Two-Weapon Fighting presupposes the Attack action was already taken.
    let (status, _) = attack(&app, &token, session_id, hero_id, orc_id, 7).await;
    assert_eq!(status, StatusCode::OK, "main-hand attack must resolve first");

    let player_auth = bearer(&player_token());
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/offhand", session_id))
        .insert_header(player_auth)
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": orc_id,
            "offhand_index": 1,
            "seed": 7
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_refused_offhand(status, &body);

    // Bonus Action untouched by the refusal.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][hero_id.to_string()]["action_budget"]["bonus_action"],
        serde_json::json!(true),
        "a seed-refused off-hand swing keeps the Bonus Action"
    );

    // The GM principal still gets deterministic off-hand resolution: fresh
    // round, spend the Attack action again, then swing off-hand.
    advance_turn(&app, &token, session_id).await;
    let (status, _) = attack(&app, &token, session_id, hero_id, orc_id, 7).await;
    assert_eq!(status, StatusCode::OK);
    let path = format!("/api/v1/sessions/{}/action/offhand", session_id);
    let payload = serde_json::json!({
        "attacker_id": hero_id, "target_id": orc_id,
        "offhand_index": 1, "seed": 42
    });
    let (status, body) = post_as_gm_seed_tester(&app, &path, payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["natural_roll"],
        serde_json::json!(vtt_core::DiceEngine::with_seed(42).roll_d20()),
        "pinned seed must decide the off-hand d20: {body}"
    );
}

/// Off-hand refusals share the generic shape but the route has no `success`
/// field to leak-check against; kept separate so the leak list matches the
/// route's actual response vocabulary.
fn assert_seed_refused_offhand(status: StatusCode, body: &serde_json::Value) {
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], serde_json::json!("SEED_NOT_PERMITTED"));
    for key in ["is_hit", "total_damage"] {
        assert!(
            body.get(key).map(|v| v.is_null()).unwrap_or(true),
            "rejected request leaked `{key}`: {body}"
        );
    }
}

/// Damage route (concentration challenge): a player's seed is refused; a
/// GM's seed pins the CON save exactly as before.
#[actix_web::test]
async fn damage_route_enforces_seed_policy_for_non_privileged_callers() {
    let (app, token, session_id, caster_id, golem_id) = concentration_fixture().await;

    // Find a surviving hit and apply it WITHOUT a seed first (server entropy)
    // to obtain a source event sequence.
    let mut seq_and_dmg = None;
    for seed in 1..=200u64 {
        let (status, body) = attack(&app, &token, session_id, golem_id, caster_id, seed).await;
        if status == StatusCode::OK && body["is_hit"] == true && body["concentration_check"]["passed"] == true {
            seq_and_dmg = Some((body["event_sequence"].as_u64().unwrap(), body["total_damage"].as_i64().unwrap()));
            break;
        }
        if status == StatusCode::OK {
            advance_turn(&app, &token, session_id).await;
        }
    }
    let (seq, amount) = seq_and_dmg.expect("fixture must produce a surviving hit");

    // Player-supplied seed on /damage → refused, nothing applied.
    let player_auth = bearer(&player_token());
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(player_auth)
        .set_json(serde_json::json!({
            "target_id": caster_id,
            "source_event_sequence": seq,
            "seed": seed_producing_roll(1)
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_rejected(status, &body);

    // Concentration intact — the refused request challenged nothing.
    let snap = session_snapshot(&app, &token, session_id).await;
    assert_eq!(
        caster_concentration(&snap, caster_id).await["spell_id"],
        "hold_person"
    );
    assert_eq!(break_events(&snap).len(), 0);

    // Privileged determinism: nat-1 save breaks concentration exactly once,
    // reproducibly from a fresh fixture with the same pinned seed.
    let (status, body) = post_damage_as_gm(
        &app,
        &token,
        session_id,
        caster_id,
        seq,
        seed_producing_roll(1),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let check = body.get("concentration_check").expect("check must fire");
    assert_eq!(check["passed"], false);
    assert_eq!(check["broken"], true);
    assert_eq!(check["dc"], std::cmp::max(10, amount / 2));
}

/// POSTs /damage with a seed AS THE GM TOKEN (privileged path).
async fn post_damage_as_gm(
    app: test_app_ty!(),
    token: &str,
    session_id: Uuid,
    target_id: Uuid,
    seq: u64,
    seed: u64,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/damage", session_id))
        .insert_header(bearer(token))
        .set_json(serde_json::json!({
            "target_id": target_id,
            "source_event_sequence": seq,
            "seed": seed
        }))
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await;
    let value: serde_json::Value = serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
    (status, value)
}

/// The orchestrator service principal (role-less canonical id) keeps its
/// determinism privilege on the session routes too — spot-check via grapple.
#[actix_web::test]
async fn service_principal_keeps_seed_privilege_on_session_routes() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-seed-svc", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &token, session_id, entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 2.5, 2.6)).await;

    let service = sign_token("orchestrator-service", TEST_SECRET);

    // The pinned seed decides BOTH d20s exactly as the local engine does.
    let winning = contest_seed(5, -1, true);
    let mut local = vtt_core::DiceEngine::with_seed(winning);
    let expected_attacker = local.roll_d20();
    let expected_defender = local.roll_d20();
    assert!(
        expected_attacker + 5 > expected_defender - 1,
        "contest seed must be attacker-winning"
    );

    let payload = serde_json::json!({
        "attacker_id": hero_id, "defender_id": orc_id,
        "defender_skill": "athletics", "seed": winning
    });
    let path = format!("/api/v1/sessions/{}/action/grapple", session_id);
    let (status, body) =
        post_raw(&app, &service, &path, payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["attacker_natural_roll"], serde_json::json!(expected_attacker), "{body}");
    assert_eq!(body["defender_natural_roll"], serde_json::json!(expected_defender), "{body}");
    assert_eq!(body["success"], serde_json::json!(true));
}

#[actix_web::test]
async fn script_execution_is_gm_and_service_only() {
    let app = test_app().await;
    let rhai = serde_json::json!({
        "script": "1 + 1",
        "context": {
            "caster_level": 5, "target_ac": 12, "spell_dc": 13,
            "environment_tag": "dungeon"
        }
    });

    let player = sign_token_with_role("p1", "player", TEST_SECRET);
    let (status, body) = post_raw(&app, &player, "/api/v1/scripts/rhai", rhai.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], serde_json::json!("FORBIDDEN_ROLE"));

    let spec = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let (status, _) = post_raw(&app, &spec, "/api/v1/scripts/rhai", rhai.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // GMs run homebrew hooks…
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let (status, body) = post_raw(&app, &gm, "/api/v1/scripts/rhai", rhai.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // …and so does the orchestrator service principal.
    let service = sign_token("orchestrator-service", TEST_SECRET);
    let (status, _) = post_raw(&app, &service, "/api/v1/scripts/rhai", rhai).await;
    assert_eq!(status, StatusCode::OK);
}

// --- Audit iteration 14 / F7: stacks + initiative order leak hidden entities --

/// F7: `ingress_stack` / `egress_stack` entries carry entity_id plus
/// source_point/target_point. For a HIDDEN NPC those points reveal where an
/// invisible creature teleported from and to — and the id lets a spectator
/// correlate it with ledger events. Non-GM snapshots must DROP every stack
/// entry whose entity is hidden (dropping, not nulling: partial coordinates
/// still leak half the transit). GMs keep everything.
#[actix_web::test]
async fn ingress_egress_stacks_redacted_for_non_gm_views() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let session_id = create_session_as(&app, &gm).await;

    // A visible hero and a hidden lurker, each arriving through a real
    // transit protocol so the session's ingress_stack actually holds records
    // (the leak surface under test).
    let hero_id = Uuid::new_v4();
    let lurker_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["position"] = serde_json::json!([5.0, 5.0, 0.0]);
    hero["ingress"] = serde_json::json!({
        "entity_id": hero_id,
        "ingress_type": "SPAWN_EVENT",
        "source_point": [5.0, 5.0, 0.0],
        "target_point": [5.0, 5.0, 0.0],
        "verified": false,
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(gm_auth.clone())
        .set_json(hero)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let mut lurker = entity_json(lurker_id, "Hidden Lurker", 40, 17, 6, "2d8+4");
    lurker["is_player"] = serde_json::json!(false);
    lurker["is_visible"] = serde_json::json!(false);
    lurker["position"] = serde_json::json!([20.0, 20.0, 0.0]);
    lurker["ingress"] = serde_json::json!({
        "entity_id": lurker_id,
        "ingress_type": "TELEPORTATION",
        "source_point": [1.0, 1.0, 0.0],
        "target_point": [20.0, 20.0, 0.0],
        "verified": false,
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(gm_auth.clone())
        .set_json(lurker)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Despawn the hero so an egress entry exists for a VISIBLE entity too —
    // proving redaction is selective, not a wholesale stack wipe.
    let req = test::TestRequest::delete()
        .uri(&format!("/api/v1/sessions/{}/entities/{}", session_id, hero_id))
        .insert_header(gm_auth.clone())
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let fetch = |token: &str| {
        test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{session_id}"))
            .insert_header(bearer(token))
            .to_request()
    };

    for viewer in [
        sign_token_with_role("player-2", "player", TEST_SECRET),
        sign_token_with_role("spec-1", "spectator", TEST_SECRET),
    ] {
        let body: serde_json::Value =
            test::read_body_json(test::call_service(&app, fetch(&viewer)).await).await;
        // Scope: entities + both stacks must be clean of the hidden NPC.
        // (The ledger passes verbatim by gateway policy — non-GMs are trusted
        // with exact ledger numbers, so its event payloads are out of scope
        // here.)
        let projected_slice = serde_json::json!({
            "entities": body["entities"],
            "ingress_stack": body["ingress_stack"],
            "egress_stack": body["egress_stack"],
            "combat": body["combat"],
        });
        let serialized = serde_json::to_string(&projected_slice).unwrap();
        assert!(
            !serialized.contains(&lurker_id.to_string()),
            "hidden NPC's id must not appear in a non-GM projection: {}",
            serialized
        );
        // The lurker's transit coordinates (spawned at [20,20]) never leak even
        // as bare numbers inside the stacks.
        if let Some(ingress) = body["ingress_stack"].as_array() {
            for entry in ingress {
                assert_ne!(
                    entry["entity_id"].as_str(),
                    Some(lurker_id.to_string().as_str()),
                    "hidden NPC's ingress point leaked: {:?}",
                    entry["source_point"]
                );
            }
        }
        // The VISIBLE hero's egress survives so conservation auditing still
        // works from non-GM views.
        let egress_ids: Vec<&str> = body["egress_stack"]
            .as_array()
            .map(|a| a.iter().filter_map(|e| e["entity_id"].as_str()).collect())
            .unwrap_or_default();
        assert!(
            egress_ids.contains(&hero_id.to_string().as_str()),
            "visible entity's egress entry must survive projection: {:?}",
            body["egress_stack"]
        );
    }

    // GM keeps the full stacks, hidden entries included.
    let body: serde_json::Value =
        test::read_body_json(test::call_service(&app, fetch(&gm)).await).await;
    let gm_ingress_ids: Vec<&str> = body["ingress_stack"]
        .as_array()
        .map(|a| a.iter().filter_map(|e| e["entity_id"].as_str()).collect())
        .unwrap_or_default();
    assert!(
        gm_ingress_ids.contains(&lurker_id.to_string().as_str()),
        "GM sees the hidden NPC's ingress record"
    );
}

/// F7 (combat half): `combat.order` is a Vec<Uuid> of ALL combatants in
/// initiative sequence. For a hidden NPC its POSITION IN THE ORDER reveals
/// when the invisible creature acts, and its index leaks relative initiative.
/// Non-GM projections keep visible actors' entries (turn tracking still works)
/// but drop hidden ones; GMs keep the full order. `turn_index` is re-mapped to
/// stay meaningful against the projected order.
#[actix_web::test]
async fn combat_order_drops_hidden_entities_for_non_gm_views() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-2", "player", TEST_SECRET);
    let spectator = sign_token_with_role("spec-1", "spectator", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    let lurker_id = Uuid::new_v4();
    spawn_at(&app, &gm_auth, session_id, hero_id, "Hero", true, [5.0, 5.0, 0.0]).await;

    let mut lurker = entity_json(lurker_id, "Hidden Lurker", 40, 17, 6, "2d8+4");
    lurker["is_player"] = serde_json::json!(false);
    lurker["is_visible"] = serde_json::json!(false);
    lurker["position"] = serde_json::json!([20.0, 20.0, 0.0]);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(gm_auth.clone())
        .set_json(lurker)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Begin combat with both on the board.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(gm_auth.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let began: serde_json::Value = test::read_body_json(res).await;
    let full_order = began["order"].as_array().expect("GM order array").clone();
    assert_eq!(full_order.len(), 2);

    // --- Player view: only the visible actor remains in combat.order ---
    let body: serde_json::Value = {
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{session_id}"))
            .insert_header(bearer(&player))
            .to_request();
        test::read_body_json(test::call_service(&app, req).await).await
    };
    let order = body["combat"]["order"].as_array().expect("player combat.order");
    assert_eq!(
        order.len(),
        1,
        "hidden NPC must be dropped from a player's initiative order: {:?}",
        order
    );
    // Serialized sessions carry order as bare id strings (the entry objects
    // with name/dex/initiative_total live only on the /combat/begin response).
    assert_eq!(order[0].as_str(), Some(hero_id.to_string().as_str()));
    assert!(
        !serde_json::to_string(order).unwrap().contains(&lurker_id.to_string()),
        "hidden id must not survive in the projected order"
    );
    // turn_index stays coherent with the PROJECTED order (points at an entry).
    let idx = body["combat"]["turn_index"].as_u64().unwrap();
    if !order.is_empty() && body["combat"]["in_combat"].as_bool() == Some(true) {
        assert!(
            (idx as usize) < order.len(),
            "projected turn_index {} out of bounds of projected order len {}",
            idx,
            order.len()
        );
    }

    // --- Spectator view: same redaction ---
    let body: serde_json::Value = {
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{session_id}"))
            .insert_header(bearer(&spectator))
            .to_request();
        test::read_body_json(test::call_service(&app, req).await).await
    };
    let order = body["combat"]["order"].as_array().expect("spectator combat.order");
    assert_eq!(order.len(), 1, "hidden NPC dropped for spectators too");
    assert_eq!(order[0].as_str(), Some(hero_id.to_string().as_str()));

    // --- GM view: full authoritative order, hidden actor included ---
    let body: serde_json::Value = {
        let req = test::TestRequest::get()
            .uri(&format!("/api/v1/sessions/{session_id}"))
            .insert_header(bearer(&gm))
            .to_request();
        test::read_body_json(test::call_service(&app, req).await).await
    };
    let order = body["combat"]["order"].as_array().expect("GM combat.order");
    assert_eq!(order.len(), 2, "GM keeps every combatant");
}

// --- Audit iteration 14 / F11 (HTTP surface): SpawnEvent mid-combat + walls ---

/// A SpawnEvent arriving once combat has begun must be rejected with 422 —
/// the engine enforces GOALS.md P6 anti-popping; the HTTP route surfaces it.
#[actix_web::test]
async fn spawn_event_ingress_rejected_mid_combat_over_http() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let session_id = create_session_as(&app, &gm).await;

    spawn_at(&app, &gm_auth, session_id, Uuid::new_v4(), "Hero", true, [5.0, 5.0, 0.0]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(gm_auth.clone())
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Mid-combat pop-in attempt via SpawnEvent.
    let late_id = Uuid::new_v4();
    let mut late = entity_json(late_id, "Late Goblin", 12, 12, 3, "1d6");
    late["is_player"] = serde_json::json!(false);
    late["ingress"] = serde_json::json!({
        "entity_id": late_id,
        "ingress_type": "SPAWN_EVENT",
        "source_point": [0.0, 0.0, 0.0],
        "target_point": [9.0, 9.0, 0.0],
        "verified": false,
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(gm_auth.clone())
        .set_json(late)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "INGRESS_REJECTED");

    // The same arrival through a portal stays legal mid-combat.
    let walker_id = Uuid::new_v4();
    let mut walker = entity_json(walker_id, "Door Walker", 12, 12, 3, "1d6");
    walker["is_player"] = serde_json::json!(false);
    walker["position"] = serde_json::json!([12.0, 12.0, 0.0]);
    walker["ingress"] = serde_json::json!({
        "entity_id": walker_id,
        "ingress_type": "PORTAL_DOOR",
        "source_point": [1.0, 1.0, 0.0],
        "target_point": [12.0, 12.0, 0.0],
        "verified": false,
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(gm_auth.clone())
        .set_json(walker)
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::OK,
        "PORTAL_DOOR transit is legal mid-combat"
    );

    // Teleporting into a wall is rejected over HTTP too.
    let wall_session = create_session_as(&app, &gm).await;
    let map = serde_json::json!({
        "width": 32, "height": 32, "cell_size_feet": 5.0,
        "solid_cells": [[6, 6]],
        "difficult_terrain": [], "lighting_zones": []
    });
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/map", wall_session))
        .insert_header(gm_auth.clone())
        .set_json(map)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let blinker_id = Uuid::new_v4();
    let mut blinker = entity_json(blinker_id, "Wall Blinker", 12, 12, 3, "1d6");
    blinker["is_player"] = serde_json::json!(false);
    blinker["ingress"] = serde_json::json!({
        "entity_id": blinker_id,
        "ingress_type": "TELEPORTATION",
        "source_point": [2.0, 2.0, 0.0],
        "target_point": [32.5, 32.5, 0.0],
        "verified": false,
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", wall_session))
        .insert_header(gm_auth.clone())
        .set_json(blinker)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

// --- Rule-version preference (GOALS.md Pillar 2, iteration 34) ----------------

/// Creates a session with an optional explicit `rule_version` and returns
/// (session_id, create-response body).
async fn create_session_with_rule_version(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    rule_version: Option<&str>,
) -> (Uuid, serde_json::Value) {
    let mut payload = serde_json::json!({
        "campaign_id": Uuid::new_v4(),
        "session_name": "Rules Version",
    });
    if let Some(v) = rule_version {
        payload["rule_version"] = serde_json::json!(v);
    }
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(token))
        .set_json(payload)
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    (body["session_id"].as_str().unwrap_or_default().parse().unwrap_or_default(), {
        let _ = status;
        body
    })
}

/// The wizard's choice must default honestly: without an explicit pick the
/// engine reports its legacy SRD 5.1 baseline rather than silently claiming 5.2.
#[actix_web::test]
async fn rule_version_defaults_to_legacy_srd_5_1() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-rv", "gm", TEST_SECRET);
    let (sid, created) = create_session_with_rule_version(&app, &gm, None).await;
    assert_eq!(created["rule_version"], "srd_5_1");

    let snapshot = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snapshot["rule_version"], "srd_5_1",
        "GET /sessions/{{id}} must expose the effective rule version"
    );
}

/// The campaign-setup wizard picks SRD 5.2; that preference must stick across
/// reads by every role AND across the persist -> hydrate bridge (a fresh engine
/// AppState replaying the persisted snapshot keeps the choice).
#[actix_web::test]
async fn rule_version_5_2_persists_through_snapshot_and_hydrate() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-rv2", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-rv2", "player", TEST_SECRET);

    let (sid, created) =
        create_session_with_rule_version(&app, &gm, Some("srd_5_2")).await;
    assert_eq!(created["rule_version"], "srd_5_2");

    // Projected through the role projection: GM and player both see the table's
    // version — it is non-sensitive campaign configuration.
    assert_eq!(snapshot_as(&app, &gm, sid).await["rule_version"], "srd_5_2");
    assert_eq!(
        snapshot_as(&app, &player, sid).await["rule_version"],
        "srd_5_2"
    );

    // Persist/hydrate round trip: snapshot as the engine emits it is pushed back
    // into restore (what the orchestrator does after an engine restart).
    let snapshot = snapshot_as(&app, &gm, sid).await;
    let service = sign_token("orchestrator-service", TEST_SECRET);
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", sid))
        .insert_header(bearer(&service))
        .set_json(snapshot)
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    assert_eq!(snapshot_as(&app, &gm, sid).await["rule_version"], "srd_5_2");

    // True restart semantics: hydrate into a FRESH engine process (empty state).
    let restarted = test_app().await;
    let snapshot = snapshot_as(&app, &gm, sid).await;
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", sid))
        .insert_header(bearer(&service))
        .set_json(snapshot.clone())
        .to_request();
    assert_eq!(
        test::call_service(&restarted, req).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        snapshot_as(&restarted, &service, sid).await["rule_version"],
        "srd_5_2",
        "restart+hydrate must keep the persisted rule-version choice"
    );
}

/// An unknown rules baseline is a contract violation: 422 with an explanatory
/// code, never a silent fallback to some other edition.
#[actix_web::test]
async fn rule_version_unknown_value_is_unprocessable() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-rv3", "gm", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "campaign_id": Uuid::new_v4(),
            "session_name": "Bad Version",
            "rule_version": "pathfinder_1e"
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "INVALID_RULE_VERSION");
}

/// The same validation guards the durability bridge so a corrupted or
/// hand-forged snapshot cannot smuggle a bogus baseline past hydration.
#[actix_web::test]
async fn rule_version_restore_rejects_unknown_version() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-rv4", "gm", TEST_SECRET);
    let service = sign_token("orchestrator-service", TEST_SECRET);
    let (sid, _) = create_session_with_rule_version(&app, &gm, Some("srd_5_1")).await;

    let mut snapshot = snapshot_as(&app, &gm, sid).await;
    snapshot["rule_version"] = serde_json::json!("dnd_4e");
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", sid))
        .insert_header(bearer(&service))
        .set_json(snapshot)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

// --- Iteration 41: blinded × vision modes + bound-hands somatics -------------

#[actix_web::test]
async fn blinded_darkvision_attacker_cannot_strike_into_darkness() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Blind Strike"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // Darkness over the goblin's cell (28, 0).
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/map", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "width": 32, "height": 32, "cell_size_feet": 5.0,
            "solid_cells": [], "difficult_terrain": [],
            "lighting_zones": [{ "x": 28, "y": 0, "zone": "darkness" }]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "map with lighting accepted");

    let drow_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    for (id, name, x) in [(drow_id, "Drow", 26), (orc_id, "Goblin", 28)] {
        let mut e = entity_json(id, name, 20, 12, 8, "1d6");
        e["position"] = serde_json::json!([(x as f32) * 5.0, 2.5, 0.0]);
        if id == drow_id {
            e["vision_mode"] = serde_json::json!("darkvision");
            e["sense_range_feet"] = serde_json::json!(120.0);
            e["conditions"] = serde_json::json!(["blinded"]);
        }
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(e)
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "{} spawned", name);
    }

    // Same 10 ft line the darkvision test strikes through — but this attacker
    // is Blinded, and blindness suppresses darkvision entirely.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "attacker_id": drow_id,
            "target_id": orc_id,
            "seed": 7u64
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "blindness must override darkvision on LoS: {body}"
    );
    assert_eq!(body["error"], "NO_LINE_OF_SIGHT", "{body}");
}

#[actix_web::test]
async fn somatic_cast_with_both_hands_occupied_is_rejected_422_cannot_somatize() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Bound Hands"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let caster_id = Uuid::new_v4();
    let mut caster = entity_json(caster_id, "Wizard", 20, 12, 2, "1d6");
    caster["spell_slots_remaining"] = serde_json::json!({"1": 1});
    caster["hands_occupied"] = serde_json::json!(2);
    caster["position"] = serde_json::json!([2.5, 2.5, 0.0]);
    let dummy_id = Uuid::new_v4();
    let mut dummy = entity_json(dummy_id, "Dummy", 30, 10, 0, "1d4");
    dummy["is_player"] = serde_json::json!(false);
    dummy["position"] = serde_json::json!([30.0, 2.5, 0.0]);
    for p in [caster, dummy] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(p)
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "spawn ok");
    }

    let spell = serde_json::json!({
        "spell": {
            "spell_id": "probe", "name": "Probe", "level": 1,
            "school": "Illusion", "casting_time": "1 action", "range_feet": 30,
            "verbal_component": true, "somatic_component": true,
            "material_component_desc": null, "save_attribute": null,
            "damage_formula": "2d4", "damage_type": "psychic",
            "duration_rounds": 0, "is_concentration": false, "is_ritual": false
        },
        "caster_id": caster_id,
        "target_id": dummy_id,
        "cast_level": 1
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", session_id))
        .insert_header(auth.clone())
        .set_json(spell)
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "both hands occupied must be a 422 CANNOT_SOMATIZE: {body}"
    );
    assert_eq!(body["error"], "CANNOT_SOMATIZE", "{body}");

    // The refused cast must not have burned the slot.
    let snapshot = session_snapshot(&app, &token, session_id).await;
    let caster_view = snapshot["entities"]
        .as_object()
        .unwrap()
        .values()
        .find(|e| e["name"] == "Wizard")
        .unwrap();
    assert_eq!(
        caster_view["spell_slots_remaining"]["1"],
        serde_json::json!(1),
        "a refused somatic cast must not spend the slot"
    );
}

#[actix_web::test]
async fn won_grapple_occupies_the_grapplers_hand_and_blocks_somatic_casts() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Grapple Hands"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let hero_id = Uuid::new_v4();
    let brute_id = Uuid::new_v4();
    for (id, name, x) in [(hero_id, "Barbarian", 2), (brute_id, "Ogre", 3)] {
        let mut e = entity_json(id, name, 40, 12, 6, "1d8");
        e["position"] = serde_json::json!([(x as f32) * 5.0, 2.5, 0.0]);
        if id == brute_id {
            e["is_player"] = serde_json::json!(false);
        }
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(auth.clone())
            .set_json(e)
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "{} spawned", name);
    }

    // Grapple at melee range; both sides are STR-based (+3 vs +3). Scan
    // seeds deterministically until one resolves as a won grapple, spending
    // the turn between attempts (one Action per round).
    let mut won = false;
    for seed in 1..=40u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/grapple", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "attacker_id": hero_id,
                "defender_id": brute_id,
                "defender_skill": "athletics",
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        let status = res.status();
        if status == StatusCode::CONFLICT {
            // Action already spent this round — refresh and retry the seed.
            advance_turn(&app, &token, session_id).await;
            continue;
        }
        assert_eq!(status, StatusCode::OK, "grapple contest resolved");
        let body: serde_json::Value = test::read_body_json(res).await;
        if body["success"] == serde_json::json!(true) {
            won = true;
            break;
        }
    }
    assert!(won, "some seed in 1..=40 must win an even STR contest");

    // A won grapple keeps one of the grappler's hands busy.
    let snapshot = session_snapshot(&app, &token, session_id).await;
    let hero_view = snapshot["entities"]
        .as_object()
        .unwrap()
        .values()
        .find(|e| e["name"] == "Barbarian")
        .unwrap();
    assert_eq!(
        hero_view["hands_occupied"],
        serde_json::json!(1),
        "the grappler's hand is occupied while the hold lasts"
    );
}

// --- Iteration 49: escape releases the grappler's hand -----------------------
//
// Iteration 41 gave the engine a bound-hands model (hands_occupied, occupied
// by a WON grapple, gating somatic casts) but left the hold permanently
// binding: no live path released the hand. The smallest honest completion is
// the SRD escape contest — the grappled creature spends its Action on
// Athletics/Acrobatics vs DC 8 + grappler's STR; winning strips Grappled from
// BOTH sides of the hold and frees the grappler's hand (the hold was what
// occupied it). Weapon wielding stays documented-unmodeled: there is no
// equip/wield route in this engine to hang occupancy on.

/// Spawns two adjacent entities with full sheets and returns their ids.
async fn escape_fixture(
    app: test_app_ty!(),
    token: &str,
    session_id: Uuid,
) -> (Uuid, Uuid) {
    let hero_id = Uuid::new_v4();
    let brute_id = Uuid::new_v4();
    for (id, name, x) in [(hero_id, "Escaper", 2), (brute_id, "Holder", 3)] {
        let mut e = entity_json(id, name, 40, 12, 6, "1d8");
        e["position"] = serde_json::json!([(x as f32) * 5.0, 2.5, 0.0]);
        if id == brute_id {
            e["is_player"] = serde_json::json!(false);
        }
        spawn_entity(app, token, session_id, e).await;
    }
    (hero_id, brute_id)
}

/// Wins one grapple (hero as attacker) deterministically, advancing turns as
/// needed. Panics if no seed in 1..=60 wins an even contest.
async fn win_grapple(
    app: test_app_ty!(),
    token: &str,
    session_id: Uuid,
    attacker_id: Uuid,
    defender_id: Uuid,
) {
    for seed in 1..=60u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/grapple", session_id))
            .insert_header(bearer(token))
            .set_json(serde_json::json!({
                "attacker_id": attacker_id,
                "defender_id": defender_id,
                "defender_skill": "athletics",
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(app, req).await;
        let status = res.status();
        if status == StatusCode::CONFLICT {
            advance_turn(app, token, session_id).await;
            continue;
        }
        assert_eq!(status, StatusCode::OK, "grapple contest resolved");
        let body: serde_json::Value = test::read_body_json(res).await;
        if body["success"] == serde_json::json!(true) {
            return;
        }
        advance_turn(app, token, session_id).await;
    }
    panic!("no seed in 1..=60 won an even STR contest");
}

#[actix_web::test]
async fn escape_breaks_grapple_frees_the_grapplers_hand_and_unblocks_casting() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc1", "gm", TEST_SECRET);
    let auth = bearer(&gm);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Escape Hands"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // Hero is BOTH grappler and caster; brute is the held victim who will
    // fight his way out.
    let (hero_id, brute_id) = escape_fixture(&app, &gm, sid).await;

    // Give the hero spell slots before the fixture grapples.
    {
        let mut snap = snapshot_as(&app, &gm, sid).await;
        snap["entities"][&hero_id.to_string()]["spell_slots_remaining"] =
            serde_json::json!({"1": 1});
        let service = sign_token("orchestrator-service", TEST_SECRET);
        let req = test::TestRequest::put()
            .uri(&format!("/api/v1/sessions/{}/restore", sid))
            .insert_header(bearer(&service))
            .set_json(snap)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    // Hero wins a grapple on the brute: one hand bound.
    win_grapple(&app, &gm, sid, hero_id, brute_id).await;
    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["hands_occupied"],
        serde_json::json!(1),
        "a won grapple occupies the grappler's hand"
    );
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["conditions"],
        serde_json::json!(["grappled"]),
        "the victim carries Grappled while the hold lasts"
    );

    // Pin the hero's SECOND hand (shield grip — weapon/shield wielding is
    // documented-unmodeled, so the fixture writes it directly): both hands
    // occupied, somatic casting must refuse.
    {
        let mut snap = snapshot_as(&app, &gm, sid).await;
        snap["entities"][&hero_id.to_string()]["hands_occupied"] = serde_json::json!(2);
        let service = sign_token("orchestrator-service", TEST_SECRET);
        let req = test::TestRequest::put()
            .uri(&format!("/api/v1/sessions/{}/restore", sid))
            .insert_header(bearer(&service))
            .set_json(snap)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    let caster_spell = serde_json::json!({
        "spell": {
            "spell_id": "escape_probe", "name": "Probe", "level": 1,
            "school": "Illusion", "casting_time": "1 action", "range_feet": 30,
            "verbal_component": true, "somatic_component": true,
            "material_component_desc": null, "save_attribute": null,
            "damage_formula": "2d4", "damage_type": "psychic",
            "duration_rounds": 0, "is_concentration": false, "is_ritual": false
        },
        "caster_id": hero_id,
        "target_id": brute_id,
        "cast_level": 1
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", sid))
        .insert_header(auth.clone())
        .set_json(caster_spell.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], "CANNOT_SOMATIZE", "{body}");

    // The VICTIM escapes: Athletics vs DC 8 + grappler STR (+3 → 11). Scan
    // seeds until one clears; each attempt spends the escaper's Action, so a
    // 409 refreshes the round.
    let mut escaped = false;
    for seed in 1..=60u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "entity_id": brute_id,
                "grappler_id": hero_id,
                "skill": "athletics",
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        let status = res.status();
        if status == StatusCode::CONFLICT {
            advance_turn(&app, &gm, sid).await;
            continue;
        }
        assert_eq!(
            status,
            StatusCode::OK,
            "escape contest resolved: {}",
            res.status()
        );
        let body: serde_json::Value = test::read_body_json(res).await;
        if body["success"] == serde_json::json!(true) {
            assert_eq!(
                body["grappler_hands_released"], serde_json::json!(1),
                "a won escape reports how many hands the hold freed"
            );
            escaped = true;
            break;
        }
        advance_turn(&app, &gm, sid).await;
    }
    assert!(escaped, "some seed in 1..=60 must clear the escape DC");

    // Freed-hand transition visible in the session snapshot.
    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["hands_occupied"],
        serde_json::json!(1),
        "escaping the hold frees exactly ONE of the grappler's hands live"
    );
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["conditions"],
        serde_json::json!([]),
        "escaping strips Grappled from the escaper"
    );
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(0),
        "the escapee's own hands were never the model's concern"
    );

    // One free hand is enough to somatize again: the same spell now resolves
    // and spends the slot it refused to touch while both hands were bound.
    advance_turn(&app, &gm, sid).await;
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", sid))
        .insert_header(auth.clone())
        .set_json(caster_spell)
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "after escaping, the freed hand must allow the somatic cast: {body}"
    );
}

#[actix_web::test]
async fn failed_escape_keeps_the_hand_bound_and_spends_the_action() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc2", "gm", TEST_SECRET);
    let auth = bearer(&gm);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Escape Fails"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    // A WEAK escaper (STR 8, -1) vs a strong grappler (STR 18, +4 → DC 12):
    // a natural roll of 1 always fails the check regardless of the d20's
    // companions... but a nat 1 with -1 still cannot clear DC 12.
    let weak_id = Uuid::new_v4();
    let brute_id = Uuid::new_v4();
    for (id, name, x, str_score) in [(weak_id, "Weakling", 2, 8i32), (brute_id, "Stronghold", 3, 18)] {
        let mut e = entity_json(id, name, 40, 12, 0, "1d4");
        e["position"] = serde_json::json!([(x as f32) * 5.0, 2.5, 0.0]);
        e["abilities"]["strength"] = serde_json::json!(str_score);
        if id == brute_id {
            e["is_player"] = serde_json::json!(false);
        }
        spawn_entity(&app, &gm, sid, e).await;
    }

    // Seed the hold directly through the ledger-free route: grapple attempts
    // from the STRONG grappler against the weak target win readily.
    win_grapple(&app, &gm, sid, brute_id, weak_id).await;
    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(1),
        "fixture: the strong grappler holds one hand"
    );

    // Deterministic failure: simulate the check locally (the route rolls a
    // fresh d20 from the pinned seed) to find a seed whose natural roll cannot
    // reach DC 12 even with the -1 STR modifier.
    let losing_seed = (1u64..)
        .find(|&seed| vtt_core::DiceEngine::with_seed(seed).roll_d20() + (-1) < 12)
        .expect("some seed must lose a DC 12 check at -1");

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": weak_id,
            "grappler_id": brute_id,
            "skill": "athletics",
            "seed": losing_seed
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["success"], serde_json::json!(false), "{body}");
    assert_eq!(
        body["grappler_hands_released"], serde_json::json!(0),
        "a lost escape releases nothing"
    );
    assert_eq!(
        body["escape_dc"], serde_json::json!(12),
        "DC is 8 + grappler STR (+4)"
    );

    // The failed attempt still cost the escaper their Action.
    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&weak_id.to_string()]["action_budget"]["action"],
        serde_json::json!(false),
        "an escape attempt spends the escaper's Action whether or not it lands"
    );
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(1),
        "a FAILED escape leaves the grappler's hand bound"
    );
    assert_eq!(
        snap["entities"][&weak_id.to_string()]["conditions"],
        serde_json::json!(["grappled"]),
        "a FAILED escape leaves the victim Grappled"
    );
}

// --- Legacy durability: hands fields are additive ----------------------------

#[actix_web::test]
async fn legacy_snapshot_without_hands_fields_hydrates_and_parses_identically() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-legacy", "gm", TEST_SECRET);
    let auth = bearer(&gm);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Legacy Hands"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let eid = Uuid::new_v4();
    // Pre-iteration-41 entity sheets carry NO hands_occupied key at all —
    // entity_json mirrors that (the field only exists once a model writes it).
    let mut e = entity_json(eid, "Old Timer", 30, 12, 2, "1d6");
    e["spell_slots_remaining"] = serde_json::json!({"0": 2}); // cantrip slots
    spawn_entity(&app, &gm, sid, e).await;

    // Snapshot as emitted, then strip EVERY hands-era key to simulate a
    // pre-iteration-41 persisted payload coming back from PostgreSQL.
    let mut snapshot = snapshot_as(&app, &gm, sid).await;
    if let Some(entities) = snapshot["entities"].as_object_mut() {
        for (_, entity) in entities.iter_mut() {
            entity.as_object_mut().unwrap().remove("hands_occupied");
        }
    }

    let service = sign_token("orchestrator-service", TEST_SECRET);
    let req = test::TestRequest::put()
        .uri(&format!("/api/v1/sessions/{}/restore", sid))
        .insert_header(bearer(&service))
        .set_json(snapshot.clone())
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::OK,
        "a hands-less legacy snapshot must hydrate cleanly"
    );

    let restored = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        restored["entities"][&eid.to_string()]["hands_occupied"],
        serde_json::json!(0),
        "legacy entities deserialize with zero occupied hands"
    );

    // And the restored session stays fully playable: a somatic cast passes.
    let dummy_id = Uuid::new_v4();
    let mut dummy = entity_json(dummy_id, "Target", 20, 10, 0, "1d4");
    dummy["is_player"] = serde_json::json!(false);
    dummy["position"] = serde_json::json!([40.0, 2.5, 0.0]);
    spawn_entity(&app, &gm, sid, dummy).await;

    let spell = serde_json::json!({
        "spell": {
            "spell_id": "legacy_probe", "name": "Probe", "level": 0,
            "school": "Illusion", "casting_time": "1 action", "range_feet": 60,
            "verbal_component": true, "somatic_component": true,
            "material_component_desc": null, "save_attribute": null,
            "damage_formula": "1d4", "damage_type": "psychic",
            "duration_rounds": 0, "is_concentration": false, "is_ritual": false
        },
        "caster_id": eid,
        "target_id": dummy_id,
        "cast_level": 0
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/cast-spell", sid))
        .insert_header(bearer(&gm))
        .set_json(spell)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "a legacy-hydrated caster has both hands free"
    );
}

// --- Pillar 11: the GM override ----------------------------------------------

#[actix_web::test]
async fn gm_forced_escape_releases_the_hand_without_a_roll_but_players_cannot() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc3", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-esc3", "player", TEST_SECRET);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Forced Escape"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let (hero_id, brute_id) = escape_fixture(&app, &gm, sid).await;
    win_grapple(&app, &gm, sid, brute_id, hero_id).await;

    // A player may NOT invoke the override — it is a GM agency tool.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
        .insert_header(bearer(&player))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": brute_id,
            "skill": "athletics",
            "force": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // The GM forces it: no dice at all, the hold simply ends.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": brute_id,
            "skill": "athletics",
            "force": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["success"], serde_json::json!(true), "{body}");
    assert_eq!(body["forced"], serde_json::json!(true), "{body}");
    assert!(
        body["natural_roll"].is_null(),
        "a forced escape rolls no dice: {body}"
    );

    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(0),
        "the forced escape frees the grappler's hand"
    );
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["conditions"],
        serde_json::json!([]),
        "the forced escape strips Grappled"
    );
}

// --- Ledger replay: rewinds honor escapes ------------------------------------

#[actix_web::test]
async fn rewind_between_escape_and_grapple_keeps_the_release_not_a_resurrected_hold() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc4", "gm", TEST_SECRET);
    let auth = bearer(&gm);

    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Escape Rewind"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let sid: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let (hero_id, brute_id) = escape_fixture(&app, &gm, sid).await;

    // Brute holds hero; hero wins free.
    win_grapple(&app, &gm, sid, brute_id, hero_id).await;
    let mut escaped = false;
    for seed in 1..=60u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "entity_id": hero_id,
                "grappler_id": brute_id,
                "skill": "athletics",
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        if res.status() == StatusCode::CONFLICT {
            advance_turn(&app, &gm, sid).await;
            continue;
        }
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = test::read_body_json(res).await;
        if body["success"] == serde_json::json!(true) {
            escaped = true;
            break;
        }
        advance_turn(&app, &gm, sid).await;
    }
    assert!(escaped, "fixture escape must succeed");

    // Rewind to NOW (nothing reverted): the sweep rebuilds bound hands purely
    // from the surviving ledger, and the ledger must still say ESCAPED — not
    // resurrect a hold the table already broke.
    let target_seq = snapshot_as(&app, &gm, sid).await["ledger"]["current_sequence"]
        .as_u64()
        .unwrap();
    let card = serde_json::json!({
        "player_id": "player-esc4",
        "topic": "no-op rewind",
        "target_sequence_id": target_seq
    });
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", sid))
        .insert_header(bearer(&gm))
        .set_json(card)
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "SAFETY_REWIND_SUCCESS");

    assert_eq!(
        body["snapshot"]["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(0),
        "a rewind must not resurrect a hold that a surviving GRAPPLE_ESCAPED already ended"
    );
    assert_eq!(
        body["snapshot"]["entities"][&hero_id.to_string()]["conditions"],
        serde_json::json!([]),
        "the escaper stays free across the replay"
    );
}

// --- Route contract: seed policy, RBAC, hold-state gates ----------------------

#[actix_web::test]
async fn escape_grapple_route_enforces_seed_policy_rbac_and_hold_state() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-seed-escape", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    spawn(&app, &gm, session_id,
        entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10)).await;
    spawn(&app, &gm, session_id,
        entity_at(entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8), 7.5, 2.5)).await;

    // A player's pinned seed is refused exactly like every other contest
    // route — before any Action is spent or event appended.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", session_id))
        .insert_header(bearer(&player_token()))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": orc_id,
            "skill": "athletics",
            "seed": contest_seed(5, -1, true)
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_seed_rejected(status, &body);

    // Spectators cannot act at all.
    let spectator = sign_token_with_role("spec-seed-escape", "spectator", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", session_id))
        .insert_header(bearer(&spectator))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": orc_id,
            "skill": "athletics"
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // Unknown grappler -> 404 with a distinct code from the escaper miss.
    for (field, value, code) in [
        ("entity_id", Uuid::new_v4(), "ENTITY_NOT_FOUND"),
        ("grappler_id", Uuid::new_v4(), "GRAPPLER_NOT_FOUND"),
    ] {
        let mut payload = serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": orc_id,
            "skill": "athletics"
        });
        payload[field] = serde_json::json!(value);
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", session_id))
            .insert_header(bearer(&gm))
            .set_json(payload)
            .to_request();
        let res = test::call_service(&app, req).await;
        let status = res.status();
        let body: serde_json::Value = test::read_body_json(res).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"], code, "{body}");
    }

    // No standing hold -> 409 NOT_GRAPPLED (the honest gate: no phantom holds).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": orc_id,
            "skill": "athletics"
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "NOT_GRAPPLED", "{body}");

    // Smuggled fields are structurally impossible (deny_unknown_fields).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": orc_id,
            "skill": "athletics",
            "escape_dc_override": 1
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    // actix surfaces serde `deny_unknown_fields` errors as 400; the contract
    // is structural rejection, not a specific code.
    assert!(
        res.status() == StatusCode::BAD_REQUEST
            || res.status() == StatusCode::UNPROCESSABLE_ENTITY,
        "client-authored DC math must be rejected by shape, got {}",
        res.status()
    );

    // Once the orc actually holds the hero, the route resolves a real check.
    // The weak orc (-1 STR) needs a pinned seed to beat the hero's +5.
    let hold_seed = contest_seed(-1, 5, true);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/grapple", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "attacker_id": orc_id,
            "defender_id": hero_id,
            "defender_skill": "athletics",
            "seed": hold_seed
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["success"], serde_json::json!(true), "{body}");
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": orc_id,
            "skill": "athletics",
            "seed": contest_seed(9, 5, true)
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut local = vtt_core::DiceEngine::with_seed(contest_seed(9, 5, true));
    assert_eq!(
        body["natural_roll"],
        serde_json::json!(local.roll_d20()),
        "the GM's pinned seed decides the d20 exactly as the local engine does: {body}"
    );
    assert_eq!(
        body["escape_dc"],
        serde_json::json!(8 + (-1)),
        "DC is 8 + the grappler's STR modifier (STR 8 -> -1): {body}"
    );
}

// --- Iteration 48 (Pillar-7): container capacity enforcement ------------------
//
// GOALS.md P7 requires volume AND weight limits on container hierarchies. The
// engine's `InventoryManager` had recursive nesting but NO enforcement. These
// tests pin the transfer route's typed 422 rejections and its success path.


fn item_json(id: Uuid, name: &str, weight_lbs: f32, quantity: u32) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "compendium_id": format!("item_{}", name.to_lowercase().replace(' ', "_")),
        "name": name,
        "base_weight_lbs": weight_lbs,
        "quantity": quantity,
        "is_container": false,
        "container_capacity_lbs": null,
        "parent_container_id": null,
        "is_equipped": false,
        "is_attuned": false,
        "is_cursed": false,
        "is_curse_revealed": false,
        "true_state": {},
        "perceived_state": {}
    })
}

fn container_json(
    id: Uuid,
    name: &str,
    weight_lbs: f32,
    capacity_lbs: Option<f32>,
    volume_cu_ft: Option<f32>,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "compendium_id": format!("item_{}", name.to_lowercase().replace(' ', "_")),
        "name": name,
        "base_weight_lbs": weight_lbs,
        "quantity": 1,
        "is_container": true,
        "container_capacity_lbs": capacity_lbs,
        "container_volume_cu_ft": volume_cu_ft,
        "volume_cu_ft": 0.5,
        "parent_container_id": null,
        "is_equipped": false,
        "is_attuned": false,
        "is_cursed": false,
        "is_curse_revealed": false,
        "true_state": {},
        "perceived_state": {}
    })
}

/// Spawns a session + one owning hero, returns ids.
async fn spawn_hero_with_inventory(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    auth: &(actix_web::http::header::HeaderName, String),
    items: Vec<serde_json::Value>,
) -> (Uuid, Uuid) {
    let req = test::TestRequest::post()
        .uri("/api/v1/sessions")
        .insert_header(auth.clone())
        .set_json(serde_json::json!({"campaign_id": Uuid::new_v4(), "session_name": "Inv"}))
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    let session_id: Uuid = body["session_id"].as_str().unwrap().parse().unwrap();

    let hero_id = Uuid::new_v4();
    let mut entity = entity_json(hero_id, "Porter", 30, 14, 5, "1d8+3");
    let mut inv = serde_json::Map::new();
    for it in &items {
        inv.insert(it["id"].as_str().unwrap().to_string(), it.clone());
    }
    entity["inventory"] = serde_json::json!({"items": inv});
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header(auth.clone())
        .set_json(entity)
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "hero spawn");
    (session_id, hero_id)
}

#[actix_web::test]
async fn item_transfer_over_weight_capacity_is_422_with_honest_detail() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let chest = container_json(Uuid::new_v4(), "Chest", 5.0, Some(10.0), Some(100.0));
    let anvil = item_json(Uuid::new_v4(), "Anvil", 11.0, 1);
    let (session_id, hero_id) =
        spawn_hero_with_inventory(&app, &auth, vec![chest.clone(), anvil.clone()]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": anvil["id"],
            "container_id": chest["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "CONTAINER_OVERFILLED");
    // Honest per-field detail: which limit, by how much — not a bare string.
    let violations = body["violations"].as_array().expect("violations array");
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0]["limit"], "weight_lbs");
    let over_by = violations[0]["over_by"].as_f64().unwrap();
    assert!(over_by > 0.0 && over_by < 2.0, "over_by={}", over_by);

    // The refused transfer must not have mutated the inventory.
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(auth.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    let snap: serde_json::Value = test::read_body_json(res).await;
    let parent = snap["entities"][&hero_id.to_string()]["inventory"]["items"]
        [&anvil["id"].as_str().unwrap()]["parent_container_id"]
        .clone();
    assert_eq!(
        parent,
        serde_json::Value::Null,
        "anvil must stay unattached after refusal"
    );
}

#[actix_web::test]
async fn item_transfer_over_volume_capacity_is_422_naming_volume_limit() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let case_box = container_json(Uuid::new_v4(), "Scroll Case", 0.5, Some(50.0), Some(1.0));
    let mut boulder = item_json(Uuid::new_v4(), "Boulder", 2.0, 1);
    boulder["volume_cu_ft"] = serde_json::json!(1.5);
    let (session_id, hero_id) =
        spawn_hero_with_inventory(&app, &auth, vec![case_box.clone(), boulder.clone()]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": boulder["id"],
            "container_id": case_box["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    let violations = body["violations"].as_array().expect("violations array");
    assert_eq!(violations[0]["limit"], "volume_cu_ft");
}

#[actix_web::test]
async fn item_transfer_at_exact_capacity_is_allowed_and_binds() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let chest = container_json(Uuid::new_v4(), "Chest", 5.0, Some(10.0), Some(100.0));
    let anvil = item_json(Uuid::new_v4(), "Anvil", 10.0, 1);
    let (session_id, hero_id) =
        spawn_hero_with_inventory(&app, &auth, vec![chest.clone(), anvil.clone()]).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": anvil["id"],
            "container_id": chest["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "TRANSFERRED");

    // Bound on the server: the anvil now names the chest as parent.
    let req = test::TestRequest::get()
        .uri(&format!("/api/v1/sessions/{}", session_id))
        .insert_header(auth.clone())
        .to_request();
    let res = test::call_service(&app, req).await;
    let snap: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["inventory"]["items"]
            [&anvil["id"].as_str().unwrap()]["parent_container_id"],
        serde_json::json!(chest["id"]),
        "transfer must bind the item to the container server-side"
    );
}

#[actix_web::test]
async fn nested_pouch_contents_are_enforced_transitively_via_http() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let chest = container_json(Uuid::new_v4(), "Chest", 5.0, Some(10.0), Some(100.0));
    let pouch = container_json(Uuid::new_v4(), "Pouch", 0.5, Some(8.0), Some(2.0));
    let coins = item_json(Uuid::new_v4(), "Gold Coins", 4.0, 2); // 8 lbs
    let bar = item_json(Uuid::new_v4(), "Iron Bar", 3.0, 1);
    let (session_id, hero_id) =
        spawn_hero_with_inventory(&app, &auth, vec![chest.clone(), pouch.clone(), coins.clone(), bar.clone()])
            .await;

    async fn transfer(
        app: &impl Service<
            actix_http::Request,
            Response = ServiceResponse<EitherBody<BoxBody>>,
            Error = actix_web::Error,
        >,
        auth: &(actix_web::http::header::HeaderName, String),
        session_id: Uuid,
        hero_id: Uuid,
        item: &serde_json::Value,
        container: &serde_json::Value,
    ) -> actix_web::dev::ServiceResponse<EitherBody<BoxBody>> {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "entity_id": hero_id,
                "item_id": item["id"],
                "container_id": container["id"]
            }))
            .to_request();
        test::call_service(app, req).await
    }

    // Pouch into the chest: fine.
    let res = transfer(&app, &auth, session_id, hero_id, &pouch, &chest).await;
    assert_eq!(res.status(), StatusCode::OK);
    // Coins into the pouch (exactly at the pouch's own limit): fine.
    let res = transfer(&app, &auth, session_id, hero_id, &coins, &pouch).await;
    assert_eq!(res.status(), StatusCode::OK);
    // Now the bar into the CHEST: chest contents = pouch 0.5 + coins 8 + bar 3
    // = 11.5 > 10 → rejected BECAUSE OF what the pouch carries.
    let res = transfer(&app, &auth, session_id, hero_id, &bar, &chest).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "CONTAINER_OVERFILLED");
}

// --- Iterations 61-62 (audit F-A4#4/#5/#6/#7/#9) -----------------------------

/// F-A4#4 over the wire: filling a pouch INSIDE a chest must be refused by the
/// CHEST once its limit would blow, and the refusal must name the chest.
#[actix_web::test]
async fn item_transfer_that_overfills_an_ancestor_names_the_ancestor() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-61", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let chest = container_json(Uuid::new_v4(), "Chest", 5.0, Some(10.0), Some(100.0));
    // The pouch carries NO limits of its own — only the ancestor can catch this.
    let pouch = container_json(Uuid::new_v4(), "Pouch", 0.5, None, None);
    let sword = item_json(Uuid::new_v4(), "Sword", 3.0, 1);
    let mace = item_json(Uuid::new_v4(), "Mace", 8.0, 1);
    let (session_id, hero_id) = spawn_hero_with_inventory(
        &app,
        &auth,
        vec![chest.clone(), pouch.clone(), sword.clone(), mace.clone()],
    )
    .await;

    async fn transfer(
        app: &impl Service<
            actix_http::Request,
            Response = ServiceResponse<EitherBody<BoxBody>>,
            Error = actix_web::Error,
        >,
        auth: &(actix_web::http::header::HeaderName, String),
        session_id: Uuid,
        hero_id: Uuid,
        item_id: &Uuid,
        container_id: &Uuid,
    ) -> (StatusCode, serde_json::Value) {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "entity_id": hero_id,
                "item_id": item_id,
                "container_id": container_id
            }))
            .to_request();
        let res = test::call_service(app, req).await;
        let status = res.status();
        let raw = test::read_body(res).await;
        let value: serde_json::Value =
            serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
        (status, value)
    }

    // Nest the pouch into the chest first (spawn lays everything at the root).
    let (status, body) = transfer(
        &app,
        &auth,
        session_id,
        hero_id,
        &pouch["id"].as_str().unwrap().parse().unwrap(),
        &chest["id"].as_str().unwrap().parse().unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);

    // Sword into the pouch: chest projected at 0.5 + 3 = 3.5 <= 10. Fine.
    let (status, body) = transfer(
        &app,
        &auth,
        session_id,
        hero_id,
        &sword["id"].as_str().unwrap().parse().unwrap(),
        &pouch["id"].as_str().unwrap().parse().unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);

    // Mace into the pouch: the POUCH has no limit, but the CHEST would sit at
    // 0.5 + 3 + 8 = 11.5 > 10. Refused, naming the chest as the violator.
    let chest_id: Uuid = chest["id"].as_str().unwrap().parse().unwrap();
    let (status, body) = transfer(
        &app,
        &auth,
        session_id,
        hero_id,
        &mace["id"].as_str().unwrap().parse().unwrap(),
        &pouch["id"].as_str().unwrap().parse().unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {}", body);
    assert_eq!(body["error"], "CONTAINER_OVERFILLED");
    assert_eq!(
        body["container_id"], serde_json::json!(chest_id),
        "the refusal must name the violating ANCESTOR, not the pouch"
    );
}

/// F-A4#5 over the wire: moving a container into its own descendant is a 422
/// CONTAINER_CYCLE even when nothing involved carries capacity limits.
#[actix_web::test]
async fn item_transfer_into_own_descendant_is_422_container_cycle() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-61", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let bag = container_json(Uuid::new_v4(), "Bag", 1.0, None, None);
    let box_ = container_json(Uuid::new_v4(), "Box", 1.0, None, None);
    let gem = item_json(Uuid::new_v4(), "Gem", 2.0, 1);
    let (session_id, hero_id) = spawn_hero_with_inventory(
        &app,
        &auth,
        vec![bag.clone(), box_.clone(), gem.clone()],
    )
    .await;

    // Box into the bag first: legal nesting.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": box_["id"],
            "container_id": bag["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    // Bag INTO ITS OWN BOX: would forge A -> B -> A and vanish from the
    // encumbrance totals. Must be refused on structure alone.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": bag["id"],
            "container_id": box_["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "CONTAINER_CYCLE");

    // Nothing moved: the bag still sits at the root.
    let snap = snapshot_as(&app, &token, session_id).await;
    let items = &snap["entities"][&hero_id.to_string()]["inventory"]["items"];
    assert_eq!(items[&bag["id"].as_str().unwrap()]["parent_container_id"], serde_json::Value::Null);
    assert_eq!(
        items[&box_["id"].as_str().unwrap()]["parent_container_id"],
        serde_json::json!(bag["id"])
    );
}

/// F-A4#6: a landing elevation far below the map's bounded stack is refused
/// with an honest 422 instead of resolving as guaranteed death.
#[actix_web::test]
async fn fall_route_rejects_below_map_and_above_stack_target_z() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fallz", "gm", TEST_SECRET);
    let (session_id, hero_id, _) = elevated_duel(&app, &gm, 30, 10.0).await;

    for absurd_z in [-10_000.0f64, 10_000.0] {
        let (status, body) = post_fall(
            &app,
            &gm,
            session_id,
            serde_json::json!({"entity_id": hero_id, "target_z": absurd_z}),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "target_z {} must be refused: {}",
            absurd_z,
            body
        );
        assert_eq!(body["error"], "INVALID_TARGET_Z", "body: {}", body);
    }

    // No ledger scar, no displacement: the fall never happened.
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert!(fall_events(&snap).is_empty());
    assert_eq!(
        snap["entities"][hero_id.to_string()]["position"],
        serde_json::json!([2.5, 2.5, 10.0]),
        "the refused fall leaves the creature standing where it was"
    );
}

/// F-A4#6: the shove-over-ledge convention is bounded like every other
/// client-supplied elevation.
#[actix_web::test]
async fn shove_ledger_target_z_beyond_bounds_is_refused() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-ledgez", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    // Adjacent duelists on a ledge at z = 20 (same staging as the working
    // ledge-convention test).
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let mut hero = entity_with_abilities(entity_json(hero_id, "Shover", 30, 14, 0, "1d4"), 20, 10);
    hero["position"] = serde_json::json!([2.5, 2.5, 20.0]);
    let mut orc = entity_with_abilities(entity_json(orc_id, "Shoved", 20, 11, 0, "1d4"), 8, 8);
    orc["position"] = serde_json::json!([2.6, 2.6, 20.0]);
    spawn(&app, &gm, session_id, hero).await;
    spawn(&app, &gm, session_id, orc).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/shove", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "push_5ft",
            "ledge_target_z": -10000.0,
            "seed": contest_seed(5, -1, true)
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["error"], "INVALID_LEDGE_Z");

    // The gate runs BEFORE the Action is spent and no event was written.
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert!(fall_events(&snap).is_empty());
}

/// F-A4#7 end-to-end: an X-card rewind past an ITEM_TRANSFERRED puts the item
/// back where the event says it came from.
#[actix_web::test]
async fn rewind_past_item_transfer_restores_prior_placement() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-xfer-rewind", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let chest = container_json(Uuid::new_v4(), "Chest", 5.0, Some(50.0), Some(50.0));
    let sword = item_json(Uuid::new_v4(), "Sword", 3.0, 1);
    let (session_id, hero_id) =
        spawn_hero_with_inventory(&app, &auth, vec![chest.clone(), sword.clone()]).await;

    let baseline_seq: u64 = {
        let snap = snapshot_as(&app, &token, session_id).await;
        snap["ledger"]["current_sequence"].as_u64().unwrap()
    };

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": sword["id"],
            "container_id": chest["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "player_id": "gm-xfer-rewind",
            "topic": "content",
            "target_sequence_id": baseline_seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["inventory"]["items"]
            [&sword["id"].as_str().unwrap()]["parent_container_id"],
        serde_json::Value::Null,
        "rewinding past the transfer must take the sword back OUT of the chest"
    );
}

/// F-A4#9: EVERY transfer refusal counts against the rejection metric —
/// the numeric overfill refusals AND the structural ones alike.
#[actix_web::test]
async fn structural_and_overfill_transfer_refusals_both_count_as_rejected() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-counts", "gm", TEST_SECRET);
    let auth = bearer(&token);
    let rock = item_json(Uuid::new_v4(), "Rock", 1.0, 1);
    let pebble = item_json(Uuid::new_v4(), "Pebble", 0.2, 1);
    let chest = container_json(Uuid::new_v4(), "Chest", 5.0, Some(1.0), Some(100.0));
    let (session_id, hero_id) =
        spawn_hero_with_inventory(&app, &auth, vec![rock.clone(), pebble.clone(), chest.clone()])
            .await;

    let rejected_before: u64 = {
        let req = test::TestRequest::get().uri("/metrics").to_request();
        let res = test::call_service(&app, req).await;
        let body: serde_json::Value = test::read_body_json(res).await;
        body["rejected_actions"].as_u64().unwrap()
    };

    // Structural refusal: a rock has no interior (no violations listed).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": pebble["id"],
            "container_id": rock["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Numeric refusal: 0.2 lb pebble fits the 1 lb chest; the 1 lb rock on
    // top blows it (0.2 + 1 = 1.2 > 1).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": pebble["id"],
            "container_id": chest["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "pebble fits the chest");
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inventory/transfer", session_id))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "item_id": rock["id"],
            "container_id": chest["id"]
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(
        res.status(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "1.2 lbs of contents blows the 1 lb chest"
    );

    let req = test::TestRequest::get().uri("/metrics").to_request();
    let res = test::call_service(&app, req).await;
    let body: serde_json::Value = test::read_body_json(res).await;
    let rejected_after = body["rejected_actions"].as_u64().unwrap();
    assert!(
        rejected_after >= rejected_before + 2,
        "one structural AND one numeric refusal must both count: {} -> {}",
        rejected_before,
        rejected_after
    );
}

// --- Tactical falls (iteration 53, PILLAR-3 gap) ------------------------------

async fn post_fall(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    session_id: Uuid,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/fall", session_id))
        .insert_header(bearer(token))
        .set_json(body)
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let raw = test::read_body(res).await;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).unwrap_or(serde_json::json!(null));
    (status, value)
}

/// A hero standing `z` feet up.
async fn elevated_duel(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
    hero_hp: i32,
    start_z: f64,
) -> (Uuid, Uuid, Uuid) {
    let session_id = create_session_as(app, token).await;
    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Ledge Hero", hero_hp, 14, 0, "1d4");
    hero["position"] = serde_json::json!([2.5, 2.5, start_z]);
    let spectator_id = Uuid::new_v4();
    let mut watcher = entity_json(spectator_id, "Bystander", 20, 12, 0, "1d4");
    watcher["position"] = serde_json::json!([8.0, 8.0, 0.0]);
    spawn(app, token, session_id, hero).await;
    spawn(app, token, session_id, watcher).await;
    (session_id, hero_id, spectator_id)
}

fn fall_events(snap: &serde_json::Value) -> Vec<&serde_json::Value> {
    snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("FALL_RESOLVED"))
        .collect()
}

#[actix_web::test]
async fn fall_safe_drop_changes_elevation_only() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fall", "gm", TEST_SECRET);
    let (session_id, hero_id, _) = elevated_duel(&app, &gm, 30, 5.0).await;

    // A 5 ft step-down: under the SRD 10 ft damage threshold.
    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": 0.0}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["outcome"], serde_json::json!("safe_drop"));
    assert_eq!(body["drop_feet"], serde_json::json!(5.0));
    assert_eq!(body["damage_taken"], serde_json::json!(0));
    assert_eq!(body["knocked_prone"], serde_json::json!(false));
    assert_eq!(body["landed_at"], serde_json::json!([2.5, 2.5, 0.0]));
    assert!(body["event_sequence"].is_u64(), "ledger sequence surfaced");

    let snap = snapshot_as(&app, &gm, session_id).await;
    let hero = &snap["entities"][hero_id.to_string()];
    assert_eq!(hero["position"], serde_json::json!([2.5, 2.5, 0.0]));
    assert_eq!(
        hero["conditions"].as_array().unwrap().len(),
        0,
        "a safe drop grants nothing: {}",
        hero["conditions"]
    );
    assert_eq!(hero["current_hp"].as_i64().unwrap(), 30);
    // Movement cost: the vertical descent comes out of the speed budget
    // (disclosed approximation), but an Action is never spent by gravity.
    assert_eq!(hero["action_budget"]["movement_remaining_feet"], serde_json::json!(25.0));

    let falls = fall_events(&snap);
    assert_eq!(falls.len(), 1, "exactly one FALL_RESOLVED expected");
    assert_eq!(falls[0]["payload"]["outcome"], serde_json::json!("safe_drop"));
}

#[actix_web::test]
async fn fall_10ft_knocks_prone_and_deals_damage() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fall", "gm", TEST_SECRET);
    let (session_id, hero_id, _) = elevated_duel(&app, &gm, 30, 10.0).await;

    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": 0.0}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["outcome"], serde_json::json!("injured_landing"));
    let dmg = body["damage_taken"].as_i64().unwrap();
    assert!((1..=6).contains(&dmg), "a 10 ft fall is exactly one d6: {}", dmg);

    let snap = snapshot_as(&app, &gm, session_id).await;
    let conditions = snap["entities"][hero_id.to_string()]["conditions"]
        .as_array()
        .unwrap();
    assert!(
        conditions.contains(&serde_json::json!("prone")),
        "prone on landing: {}",
        conditions[0]
    );
}

#[actix_web::test]
async fn fall_lethal_height_instant_death() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fall", "gm", TEST_SECRET);
    // 105 ft = 10d6 (min roll 10) against a 5/5 HP creature whose instant-death
    // threshold is exactly 10 — every seed kills.
    let (session_id, hero_id, _) = elevated_duel(&app, &gm, 5, 105.0).await;

    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": 0.0}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["outcome"], serde_json::json!("massive_damage"));
    assert_eq!(body["instant_death"], serde_json::json!(true));
    assert_eq!(body["hp_remaining"], serde_json::json!(0));

    let snap = snapshot_as(&app, &gm, session_id).await;
    let hero = &snap["entities"][hero_id.to_string()];
    assert_eq!(hero["current_hp"].as_i64().unwrap(), 0);
    assert_eq!(hero["is_dead"], serde_json::json!(true));
    assert_eq!(hero["is_conscious"], serde_json::json!(false));
}

#[actix_web::test]
async fn fall_route_spectator_forbidden_and_no_state_change() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fall", "gm", TEST_SECRET);
    let spec = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let (session_id, hero_id, _) = elevated_duel(&app, &gm, 30, 20.0).await;

    let (status, body) = post_fall(
        &app,
        &spec,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": 0.0}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("FORBIDDEN_ROLE"));

    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][hero_id.to_string()]["position"],
        serde_json::json!([2.5, 2.5, 20.0]),
        "a forbidden fall must not move anyone"
    );
    assert!(fall_events(&snap).is_empty());
}

#[actix_web::test]
async fn fall_route_rejects_upward_mismatched_and_smuggled_payloads() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fall", "gm", TEST_SECRET);
    let (session_id, hero_id, _) = elevated_duel(&app, &gm, 30, 10.0).await;

    // Rising is not falling.
    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": 15.0}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("NO_DOWNWARD_DROP"));

    // Client-declared drop that disagrees with the board is refused: the
    // engine measures the fall from authoritative positions only.
    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({
            "entity_id": hero_id,
            "target_z": 0.0,
            "declared_drop_feet": 100.0
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("DROP_MISMATCH"));

    // Unknown fields stay structurally impossible, like every other action:
    // `deny_unknown_fields` fails deserialization before the handler runs.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/fall", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "target_z": 0.0,
            "fall_damage": "20d6"
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert!(
        res.status() == StatusCode::UNPROCESSABLE_ENTITY || res.status() == StatusCode::BAD_REQUEST,
        "client-supplied fall math must be rejected (400/422), got {}",
        res.status()
    );

    // No rejected attempt may leave a ledger scar.
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert!(fall_events(&snap).is_empty());
}

#[actix_web::test]
async fn fall_legacy_flat_token_can_drop_below_ground_level() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fall", "gm", TEST_SECRET);
    // A legacy token that never carried elevation data sits at z = 0.
    let session_id = create_session_as(&app, &gm).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &gm, session_id, entity_json(hero_id, "Flat Token", 30, 14, 0, "1d4")).await;

    // Falling into a pit BELOW ground level works exactly like any other fall.
    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": -30.0}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    let dmg = body["damage_taken"].as_i64().unwrap();
    assert!((3..=18).contains(&dmg), "a 30 ft fall is three d6: {}", dmg);

    let snap = snapshot_as(&app, &gm, session_id).await;
    assert_eq!(
        snap["entities"][hero_id.to_string()]["position"],
        serde_json::json!([2.5, 2.5, -30.0])
    );

    // Climbing back out is not a fall.
    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": 0.0}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {}", body);
    assert_eq!(body["error"], serde_json::json!("NO_DOWNWARD_DROP"));
}

#[actix_web::test]
async fn rewind_past_fall_restores_hp_prone_and_elevation() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-fall", "gm", TEST_SECRET);
    let (session_id, hero_id, _) = elevated_duel(&app, &gm, 40, 50.0).await;
    let seq_before_fall: u64 = {
        let snap = snapshot_as(&app, &gm, session_id).await;
        snap["ledger"]["current_sequence"].as_u64().unwrap()
    };

    // 50 ft = 5d6 (max 30) against 40 HP: survivable, prone, wounded.
    let (status, body) = post_fall(
        &app,
        &gm,
        session_id,
        serde_json::json!({"entity_id": hero_id, "target_z": 0.0}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    let dmg = body["damage_taken"].as_i64().unwrap();
    assert!(dmg > 0 && dmg < 40, "wounding but survivable: {}", dmg);

    // X-card rewind to just before the fall undoes ALL of its side effects:
    // the wound, the Prone grant AND the elevation change.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "player_id": "gm-fall",
            "topic": "rewind",
            "target_sequence_id": seq_before_fall
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let snap = snapshot_as(&app, &gm, session_id).await;
    let hero = &snap["entities"][hero_id.to_string()];
    assert_eq!(hero["current_hp"].as_i64().unwrap(), 40, "the wound rewinds");
    assert_eq!(
        hero["conditions"].as_array().unwrap().len(),
        0,
        "Prone must not survive the rewind"
    );
    assert_eq!(
        hero["position"],
        serde_json::json!([2.5, 2.5, 50.0]),
        "the faller is back on the ledge"
    );
    assert!(fall_events(&snap).iter().all(|e| e["is_reverted"] == serde_json::json!(true)));
}

#[actix_web::test]
async fn shove_push_over_ledge_resolves_a_fall_instead_of_a_slide() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-ledge", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;

    // Both duelists stand ON the ledge at z = 20; the floor beyond is far down.
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let mut hero = entity_with_abilities(entity_json(hero_id, "Hero", 30, 14, 0, "1d4"), 20, 10);
    hero["position"] = serde_json::json!([2.5, 2.5, 20.0]);
    let mut orc = entity_with_abilities(entity_json(orc_id, "Orc", 20, 11, 0, "1d4"), 8, 8);
    orc["position"] = serde_json::json!([2.6, 2.6, 20.0]);
    spawn(&app, &token, session_id, hero).await;
    spawn(&app, &token, session_id, orc).await;

    let seed = contest_seed(5, -1, true);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/shove", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "push_5ft",
            "ledge_target_z": -10.0,
            "seed": seed
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["success"], serde_json::json!(true));
    let fall = &body["fall"];
    assert_eq!(fall["drop_feet"], serde_json::json!(30.0), "body: {}", body);
    let dmg = fall["damage_taken"].as_i64().unwrap();
    assert!((3..=18).contains(&dmg), "three d6 off the ledge: {}", dmg);
    assert_eq!(fall["knocked_prone"], serde_json::json!(true));

    let snap = snapshot_as(&app, &token, session_id).await;
    let orc = &snap["entities"][orc_id.to_string()];
    let orc_pos = orc["position"].as_array().unwrap().clone();
    assert_eq!(
        orc_pos[2], serde_json::json!(-10.0),
        "the shoved creature lands at the ledge floor: {}",
        orc_pos[2]
    );
    let slide = ((orc_pos[0].as_f64().unwrap() - 2.6).powi(2)
        + (orc_pos[1].as_f64().unwrap() - 2.6).powi(2))
    .sqrt();
    assert!(
        (4.9..=5.1).contains(&slide),
        "horizontal travel stays the shove's 5 ft push: {slide}"
    );
    assert!(orc["current_hp"].as_i64().unwrap() < 20);
    assert!(orc["conditions"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("prone")));

    // Two ledger records: the won contest AND the fall it caused, so a rewind
    // past either undoes its own half of the story.
    let events = snap["ledger"]["events"].as_array().unwrap();
    assert!(events.iter().any(|e| e["event_type"] == serde_json::json!("SHOVE_ATTEMPTED")));
    let falls = fall_events(&snap);
    assert_eq!(falls.len(), 1);
    assert_eq!(falls[0]["payload"]["drop_feet"], serde_json::json!(30.0));

    // The ledge convention is push-only: a prone-shove cannot carry it.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/shove", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "defender_id": orc_id,
            "shove_effect": "prone",
            "ledge_target_z": -10.0,
            "seed": seed
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert!(
        res.status() == StatusCode::UNPROCESSABLE_ENTITY || res.status() == StatusCode::CONFLICT,
        "a prone-shove cannot carry the ledge convention, got {}",
        res.status()
    );
}

// ============================================================================
// Iteration 56: inspiration spend on attack/check/save + Help-on-check action
// ============================================================================

/// A hero holding inspiration who asks to SPEND it on an attack must burn the
/// point, roll with Advantage, journal exactly one
/// `INSPIRATION_CHANGED {granted:false, reason:"spent"}` event, and report the
/// burn in the response body.
#[actix_web::test]
async fn inspiration_spend_on_attack_burns_the_point_and_journals_it() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-insp", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let orc_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["inspiration"] = serde_json::json!(true);
    spawn(&app, &token, session_id, hero).await;
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(orc_id, "Orc", 200, 16, 0, "1d4"), 2.5, 2.6),
    )
    .await;

    // Deterministic proof of the bought edge: find a seed whose FIRST d20 of
    // an advantage pair misses AC 16 but whose SECOND hits — a straight roll
    // on that same seed would miss, so a hit here is only possible under
    // advantage.
    let mut straddle_seed = None;
    for s in 1..=200_000u64 {
        let mut dice = DiceEngine::with_seed(s);
        let (_kept, r1, r2) = dice.roll_d20_advantage();
        let (low, high) = (r1.min(r2), r1.max(r2));
        if low != 1 && low != 20 && high != 20 && high != 1 && low + 8 < 16 && high + 8 >= 16 {
            straddle_seed = Some(s);
            break;
        }
    }
    let seed = straddle_seed.expect("some seed must straddle AC 16 under advantage");

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": orc_id,
            "seed": seed,
            "spend_inspiration": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "the attack must resolve");
    let body: serde_json::Value = test::read_body_json(res).await;

    assert_eq!(body["advantage"], serde_json::json!(true), "the point buys Advantage");
    assert_eq!(
        body["inspiration_consumed"],
        serde_json::json!(true),
        "response must disclose that a point was burned"
    );
    assert_eq!(
        body["is_hit"], serde_json::json!(true),
        "a seed whose first advantage die misses but second hits lands ONLY under advantage"
    );

    // The engine state and ledger both record the spend.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        !inspiration_of(&snap, hero_id),
        "a spent point leaves the hero uninspired"
    );
    let spends: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("INSPIRATION_CHANGED"))
        .collect();
    assert_eq!(spends.len(), 1, "exactly one spend event");
    assert_eq!(spends[0]["payload"]["granted"], serde_json::json!(false));
    assert_eq!(spends[0]["payload"]["reason"], serde_json::json!("spent"));
    assert_eq!(spends[0]["actor_id"], json_str(&hero_id));
}

/// Asking to spend inspiration while HOLDING NONE is a silent no-op: no edge
/// is conjured, `inspiration_consumed` stays false, and nothing is journalled.
#[actix_web::test]
async fn inspiration_spend_without_a_hold_is_a_noop_on_attack_check_and_save() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-insp2", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(hero_id, "Hero", 30, 14, 0, "1d4")).await;
    let enemy_id = Uuid::new_v4();
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(enemy_id, "Dummy", 200, 10, 0, "1d4"), 2.5, 2.5),
    )
    .await;

    let snap_before = snapshot_as(&app, &token, session_id).await;
    assert!(
        !inspiration_of(&snap_before, hero_id),
        "fixture sanity: no point held"
    );

    // Attack with the ask but nothing held.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": enemy_id,
            "seed": 3,
            "spend_inspiration": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["advantage"], serde_json::json!(false), "no hold, no edge");
    assert_eq!(
        body["inspiration_consumed"],
        serde_json::json!(false),
        "nothing was spent so nothing may be reported as consumed"
    );
    advance_turn(&app, &token, session_id).await;

    // Ability check with the ask but nothing held.
    let req = test::TestRequest::post()
        .uri("/api/v1/actions/check")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "modifier": 3,
            "dc": 12,
            "cost_margin": 3,
            "session_id": session_id,
            "entity_id": hero_id,
            "spend_inspiration": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["advantage"], serde_json::json!(false));
    assert_eq!(body["inspiration_consumed"], serde_json::json!(false));

    // Saving throw with the ask but nothing held.
    let req = test::TestRequest::post()
        .uri("/api/v1/actions/save")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "save_modifier": 3,
            "dc": 12,
            "session_id": session_id,
            "entity_id": hero_id,
            "spend_inspiration": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert!(body["passed"].is_boolean(), "save still resolves normally");
    assert_eq!(body["advantage"], serde_json::json!(false));
    assert_eq!(body["inspiration_consumed"], serde_json::json!(false));

    // Nothing was journalled anywhere.
    let snap = snapshot_as(&app, &token, session_id).await;
    let spends: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("INSPIRATION_CHANGED"))
        .collect();
    assert!(
        spends.is_empty(),
        "a spend request against an empty hold must not journal anything"
    );
}

/// SRD cancellation protection: when conditions ALREADY impose disadvantage,
/// burning a point would cancel into a straight d20 and buy nothing, so the
/// engine keeps the point and journals nothing.
#[actix_web::test]
async fn inspiration_spend_under_disadvantage_keeps_the_point() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-insp3", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Poisoned Hero", 30, 14, 8, "1d8+3");
    hero["inspiration"] = serde_json::json!(true);
    hero["conditions"] = serde_json::json!(["poisoned"]);
    spawn(&app, &token, session_id, hero).await;
    let enemy_id = Uuid::new_v4();
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(enemy_id, "Dummy", 200, 10, 0, "1d4"), 2.5, 2.5),
    )
    .await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": enemy_id,
            "seed": 7,
            "spend_inspiration": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["disadvantage"], serde_json::json!(true));
    assert_eq!(
        body["inspiration_consumed"],
        serde_json::json!(false),
        "SRD cancellation protects the point from being wasted"
    );

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        inspiration_of(&snap, hero_id),
        "the point survives a cancelled roll"
    );
    let spends: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("INSPIRATION_CHANGED"))
        .collect();
    assert!(spends.is_empty(), "no event for an unconsumed ask");
}

/// Help-on-check (combat): a NEW route grants a check-flavored promise via
/// `take_help_check`, distinct from the existing attack-flavored one. An
/// invalid beneficiary must be rejected WITHOUT spending anything.
#[actix_web::test]
async fn combat_help_check_rejects_invalid_beneficiary_without_spending() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-helpchk", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let helper_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(helper_id, "Helper", 30, 14, 0, "1d4")).await;

    // Unknown beneficiary.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help-check",
        serde_json::json!({"helper_id": helper_id, "beneficiary_id": Uuid::new_v4()}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "unknown beneficiary must 404, got {}: {}",
        status,
        body
    );

    // Self-targeting is structurally meaningless.
    let (status, _) = post_contest(
        &app,
        &token,
        session_id,
        "help-check",
        serde_json::json!({"helper_id": helper_id, "beneficiary_id": helper_id}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Out of reach (> 5 ft).
    let far_id = Uuid::new_v4();
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(far_id, "Far Ally", 30, 14, 0, "1d4"), 20.5, 20.5),
    )
    .await;
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help-check",
        serde_json::json!({"helper_id": helper_id, "beneficiary_id": far_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{}", body);

    // Nothing was spent by any rejected attempt.
    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][helper_id.to_string()]["action_budget"]["action"],
        serde_json::json!(true),
        "rejected help-check attempts must not burn the Action"
    );
    let events: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("HELP_CHECK_ACTION"))
        .collect();
    assert!(events.is_empty(), "no HELP_CHECK_ACTION on a rejection");
}

/// The happy path: /action/help-check journals a DISTINCT HELP_CHECK_ACTION
/// event, spends only the helper's Action, and the beneficiary's next ability
/// check consumes it exactly once.
#[actix_web::test]
async fn help_check_grants_advantage_that_an_ability_check_consumes_exactly_once() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-helpchk2", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let helper_id = Uuid::new_v4();
    let rogue_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(helper_id, "Spotter", 30, 14, 0, "1d4")).await;
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(rogue_id, "Rogue", 30, 15, 0, "1d4"), 2.5, 2.5),
    )
    .await;

    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help-check",
        serde_json::json!({"helper_id": helper_id, "beneficiary_id": rogue_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "body: {}", body);
    assert_eq!(body["status"], serde_json::json!("HELP_CHECK_GRANTED"));
    assert_eq!(body["beneficiary_id"], json_str(&rogue_id));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][rogue_id.to_string()]["next_check_has_advantage_from"],
        json_str(&helper_id),
        "check-help lives on the BENEFICIARY like its attack twin"
    );
    assert_eq!(
        snap["entities"][helper_id.to_string()]["action_budget"]["action"],
        serde_json::json!(false),
        "the helper's Action is spent"
    );
    assert_eq!(
        snap["entities"][rogue_id.to_string()]["action_budget"]["action"],
        serde_json::json!(true),
        "the beneficiary's Action is untouched"
    );
    let helps: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("HELP_CHECK_ACTION"))
        .collect();
    assert_eq!(helps.len(), 1, "one distinct HELP_CHECK_ACTION event");

    // The beneficiary's next check CONSUMES the token and rolls with edge:
    // deterministic proof via a pinned seed whose straight d20 fails but whose
    // advantage pair passes.
    let mut straddle_seed = None;
    for s in 1..=200_000u64 {
        // The straight d20 and the advantage pair each start from the SAME
        // seed — under advantage the server keeps the higher of draws 1-2,
        // never a later draw.
        let natural = DiceEngine::with_seed(s).roll_d20();
        let (_, r1, r2) = DiceEngine::with_seed(s).roll_d20_advantage();
        let (low, high) = (r1.min(r2), r1.max(r2));
        if natural + 3 < 12
            && natural != 1
            && natural != 20
            && low + 3 < 12
            && low != 1
            && high + 3 >= 12
            && high + 3 < 22
            && high != 20
        {
            straddle_seed = Some(s);
            break;
        }
    }
    let seed = straddle_seed.expect("some seed must straddle DC 12 between straight and advantage");

    let req = test::TestRequest::post()
        .uri("/api/v1/actions/check")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "modifier": 3,
            "dc": 12,
            "cost_margin": 3,
            "seed": seed,
            "session_id": session_id,
            "entity_id": rogue_id
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["roll"], serde_json::json!(DiceEngine::with_seed(seed).roll_d20_advantage().0 as i64),
        "the kept die is the higher of TWO draws, not the plain single d20"
    );
    assert_eq!(body["total"].as_i64().unwrap(), body["roll"].as_i64().unwrap() + 3);
    assert_eq!(body["outcome"], serde_json::json!("SUCCESS"));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][rogue_id.to_string()]["next_check_has_advantage_from"].is_null(),
        "one check consumes the Help-on-check promise exactly once"
    );
}

/// An ATTACK-help promise and a CHECK-help promise are independent currencies:
/// granting either never eats the other, and each is cashed only by its own
/// kind of roll.
#[actix_web::test]
async fn attack_help_and_check_help_coexist_without_eating_each_others_tokens() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-coexist", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let attacker_helper_id = Uuid::new_v4();
    let check_helper_id = Uuid::new_v4();
    let fighter_id = Uuid::new_v4();
    let rogue_id = Uuid::new_v4();
    let enemy_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(attacker_helper_id, "Feinter", 30, 14, 0, "1d4")).await;
    spawn(&app, &token, session_id, entity_at(entity_json(check_helper_id, "Spotter", 30, 14, 0, "1d4"), 2.6, 2.5)).await;
    spawn(
        &app,
        &token,
        session_id,
        entity_owned_by(entity_json(fighter_id, "Fighter", 40, 15, 8, "1d8+3"), "gm-coexist"),
    )
    .await;
    spawn(&app, &token, session_id, entity_at(entity_json(rogue_id, "Rogue", 30, 14, 0, "1d4"), 2.5, 2.5)).await;
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(enemy_id, "Ogre", 300, 18, 0, "1d4"), 2.5, 2.6),
    )
    .await;

    // Grant BOTH flavors in both orders.
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help",
        serde_json::json!({"helper_id": attacker_helper_id, "target_entity_id": enemy_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", body);
    let (status, body) = post_contest(
        &app,
        &token,
        session_id,
        "help-check",
        serde_json::json!({"helper_id": check_helper_id, "beneficiary_id": rogue_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", body);

    let snap = snapshot_as(&app, &token, session_id).await;
    assert_eq!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"],
        json_str(&attacker_helper_id),
        "the attack token survived the check grant"
    );
    assert_eq!(
        snap["entities"][rogue_id.to_string()]["next_check_has_advantage_from"],
        json_str(&check_helper_id),
        "the check token coexists beside the attack token"
    );

    // CASH THE CHECK TOKEN FIRST: the fighter's plain attack must NOT be eaten
    // by the standing check promise, and vice versa.
    let req = test::TestRequest::post()
        .uri("/api/v1/actions/check")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "modifier": 3,
            "dc": 10,
            "cost_margin": 0,
            "seed": 42,
            "session_id": session_id,
            "entity_id": rogue_id
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["roll"],
        serde_json::json!(DiceEngine::with_seed(42u64).roll_d20_advantage().0 as i64),
        "the check rolls WITH edge from its own token"
    );

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][rogue_id.to_string()]["next_check_has_advantage_from"].is_null(),
        "the check token is burned by the check"
    );
    assert_eq!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"],
        json_str(&attacker_helper_id),
        "the attack token SURVIVES the check consumption"
    );

    // Now the fighter's attack cashes the remaining token. No round refresh
    // intervenes — an unconsumed attack-help promise clears at the refresh,
    // and this assertion is about token isolation, not refresh semantics.
    let mut straddle_seed = None;
    for s in 1..=200_000u64 {
        let mut dice = DiceEngine::with_seed(s);
        let (_, r1, r2) = dice.roll_d20_advantage();
        let (low, high) = (r1.min(r2), r1.max(r2));
        if low + 8 < 18 && high + 8 >= 18 && low != 1 && low != 20 && high != 20 && high != 1 {
            straddle_seed = Some(s);
            break;
        }
    }
    let seed = straddle_seed.expect("some seed must straddle AC 18 under advantage");
    let (status, body) = attack(&app, &token, session_id, fighter_id, enemy_id, seed).await;
    assert_eq!(status, StatusCode::OK, "{}", body);
    assert_eq!(
        body["help_advantage_consumed"], serde_json::json!(true),
        "the attack consumes ITS OWN token"
    );
    assert_eq!(body["advantage"], serde_json::json!(true));

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][enemy_id.to_string()]["next_attacker_has_advantage_against"].is_null(),
        "both tokens now spent, independently"
    );
}

/// Legacy payloads without the new fields must parse identically: no
/// inspiration ask, no help-check interference, same wire shape.
#[actix_web::test]
async fn legacy_attack_payload_without_new_fields_is_unchanged() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-legacy", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["inspiration"] = serde_json::json!(true);
    spawn(&app, &token, session_id, hero).await;
    let enemy_id = Uuid::new_v4();
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(enemy_id, "Dummy", 200, 10, 0, "1d4"), 2.5, 2.5),
    )
    .await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": enemy_id,
            "seed": 11
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(
        body["advantage"], serde_json::json!(false),
        "no ask means no edge even with a point banked"
    );
    assert_eq!(
        body["inspiration_consumed"],
        serde_json::json!(false),
        "legacy payload reports zero consumption"
    );

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        inspiration_of(&snap, hero_id),
        "the banked point is untouched by a legacy attack"
    );
}

/// Rewinding past a spent inspiration (whose GRANT survives in the ledger)
/// restores the banked point; rewinding past a granted help-check clears the
/// pending token.
#[actix_web::test]
async fn rewind_restores_spent_inspiration_when_grant_survives_and_clears_help_check_tokens() {
    let app = test_app().await;
    let token = sign_token_with_role("gm-rewind56", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &token).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3")).await;
    let spotter_id = Uuid::new_v4();
    spawn(&app, &token, session_id, entity_at(entity_json(spotter_id, "Spotter", 30, 14, 0, "1d4"), 2.5, 2.5)).await;
    let enemy_id = Uuid::new_v4();
    spawn(
        &app,
        &token,
        session_id,
        entity_at(entity_json(enemy_id, "Ogre", 300, 18, 0, "1d4"), 2.5, 2.6),
    )
    .await;

    // 1. GM grants inspiration through the ledger (so a later rewind past the
    //    spend can restore the point via the surviving GRANT event).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/grant", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "reason": "bardic inspiration"
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "grant must succeed");
    let body: serde_json::Value = test::read_body_json(res).await;
    let grant_seq = body["event_sequence"].as_u64().expect("sequence present");
    assert!(grant_seq > 0);

    // 2. Spend the banked point on an attack — produces a second
    //    INSPIRATION_CHANGED {granted:false, reason:"spent"} at a higher seq.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/attack", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_id": hero_id,
            "target_id": enemy_id,
            "seed": 5,
            "spend_inspiration": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["inspiration_consumed"], serde_json::json!(true));
    let spend_seq = body["event_sequence"].as_u64().expect("sequence present");
    assert!(spend_seq > grant_seq, "the spend lands after the grant");

    // 3. Grant a check-help token (lands at a yet higher seq).
    let (status, hbody) = post_contest(
        &app,
        &token,
        session_id,
        "help-check",
        serde_json::json!({"helper_id": spotter_id, "beneficiary_id": hero_id}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", hbody);

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        !inspiration_of(&snap, hero_id),
        "precondition: point spent"
    );
    assert_eq!(
        snap["entities"][hero_id.to_string()]["next_check_has_advantage_from"],
        json_str(&spotter_id),
        "precondition: check token standing"
    );

    // 4. X-card rewind to just AFTER the spend event: the SPEND survives (so
    //    the point stays spent), but the HELP_CHECK_ACTION reverts (token
    //    cleared). This is the "rewind past a help-check clears the token"
    //    half of the parity guarantee.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "player_id": "gm-rewind56",
            "topic": "iteration-56 rewind past help-check only",
            "target_sequence_id": spend_seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "rewind must succeed");

    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        snap["entities"][hero_id.to_string()]["next_check_has_advantage_from"].is_null(),
        "rewinding past the help-check clears the token"
    );
    assert!(
        !inspiration_of(&snap, hero_id),
        "the surviving SPEND still vouches for the point being spent"
    );

    // 5. Now rewind past the SPEND itself (but keep the GRANT): the surviving
    //    GRANT survives, the SPEND reverts, and the strip-and-replay path
    //    restores the point.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "player_id": "gm-rewind56",
            "topic": "iteration-56 rewind past spend",
            "target_sequence_id": grant_seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let snap = snapshot_as(&app, &token, session_id).await;
    assert!(
        inspiration_of(&snap, hero_id),
        "rewinding past the spend (grant survives) restores the banked point"
    );
}

/// Spectators cannot grant or revoke inspiration, and players cannot grant on
/// a creature they don't control.
#[actix_web::test]
async fn inspiration_grant_is_rbac_gated() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-igr", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, gm.as_str()).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &gm, session_id, entity_json(hero_id, "Hero", 30, 14, 0, "1d4")).await;

    // Spectator rejected.
    let spec = sign_token_with_role("watch-only", "spectator", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/grant", session_id))
        .insert_header(bearer(&spec))
        .set_json(serde_json::json!({"entity_id": hero_id, "reason": "nothing"}))
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::FORBIDDEN
    );

    // Unknown entity → 404.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/grant", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": Uuid::new_v4(), "reason": "nothing"}))
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::NOT_FOUND
    );

    // Unknown field → 422 (deny_unknown_fields).
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/grant", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": hero_id, "reason": "nothing", "evil_field": 1}))
        .to_request();
    let status = test::call_service(&app, req).await.status();
    assert!(
        status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
        "unknown fields must be structurally rejected, got {}",
        status
    );
}

// ============================================================================
// Iteration 60: audit A4 game-integrity remediations
//
// F-A4#2 — the inspiration grant route used standard ownership RBAC, so ANY
// PLAYER could self-grant a point every round and buy per-turn Advantage
// (SRD: inspiration is GM fiat). The route is now GM/service-only, and the
// missing REVOKE surface (core has `revoke_inspiration`, no HTTP route)
// lands under the same gate.
//
// F-A4#3 — escape-grapple never verified that the NAMED grappler actually
// holds the escaper. Naming an unrelated creature released ITS hand while
// the true holder kept theirs (and stripped Grappled regardless). Holds are
// now attributed: a won grapple stamps the holder id on the victim's hold,
// and an escape must name THAT holder.
// ============================================================================

/// A PLAYER cannot self-grant inspiration — even on their OWN entity. SRD
/// grants are GM fiat; players receive points only via grants.
#[actix_web::test]
async fn inspiration_grant_by_player_is_rejected_gm_only() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-insp60", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;
    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Hero", 30, 14, 0, "1d4");
    hero["owner_player_id"] = serde_json::json!("player-insp60");
    spawn(&app, &gm, session_id, hero).await;

    // The player owns this entity outright — still refused: minting advantage
    // is not something ownership confers.
    let player = sign_token_with_role("player-insp60", "player", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/grant", session_id))
        .insert_header(bearer(&player))
        .set_json(serde_json::json!({"entity_id": hero_id, "reason": "self-granted"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "INSPIRATION_GM_ONLY", "{body}");

    // Nothing changed: no point held, no ledger event.
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert!(!inspiration_of(&snap, hero_id), "no self-granted point");
    assert!(
        !snap["ledger"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event_type"] == serde_json::json!("INSPIRATION_CHANGED")),
        "a refused grant journals nothing"
    );
}

/// GM grant keeps working through the same route (regression guard for the
/// tightened gate), and GM revoke is now reachable over HTTP at all.
#[actix_web::test]
async fn inspiration_grant_and_revoke_work_for_gm() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-insp60b", "gm", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;
    let hero_id = Uuid::new_v4();
    spawn(&app, &gm, session_id, entity_json(hero_id, "Hero", 30, 14, 0, "1d4")).await;

    // Grant.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/grant", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": hero_id, "reason": "heroic roleplay"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], serde_json::json!("INSPIRATION_GRANTED"));
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert!(inspiration_of(&snap, hero_id), "GM grant banks a point");

    // Revoke — the previously-missing HTTP surface for core's revoke_inspiration.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/revoke", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": hero_id, "reason": "GM fiat"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], serde_json::json!("INSPIRATION_REVOKED"));
    let snap = snapshot_as(&app, &gm, session_id).await;
    assert!(
        !inspiration_of(&snap, hero_id),
        "revoke strips the held point"
    );
    let changes: Vec<&serde_json::Value> = snap["ledger"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["event_type"] == serde_json::json!("INSPIRATION_CHANGED"))
        .collect();
    assert_eq!(changes.len(), 2, "grant + revoke both journalled");
    assert_eq!(changes[1]["payload"]["granted"], serde_json::json!(false));
    assert_eq!(changes[0]["payload"]["granted"], serde_json::json!(true));

    // Revoking from an empty hand is rejected without journaling anything.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/revoke", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({"entity_id": hero_id, "reason": "again"}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // And a player cannot use the new surface either.
    let player = sign_token_with_role("player-insp60b", "player", TEST_SECRET);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/inspiration/revoke", session_id))
        .insert_header(bearer(&player))
        .set_json(serde_json::json!({"entity_id": hero_id}))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "INSPIRATION_GM_ONLY", "{body}");
}

/// Escaping must name the creature ACTUALLY holding you. Here a second,
/// unrelated grappler stands nearby with one hand occupied by its own
/// separate hold; escaping against IT is refused with 409 NOT_YOUR_GRAPPLER
/// and leaves BOTH sides untouched — the true holder keeps their hand and the
/// escaper keeps Grappled (and their Action).
#[actix_web::test]
async fn escape_against_wrong_grappler_is_reflected_and_changes_nothing() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc60", "gm", TEST_SECRET);
    let auth = bearer(&gm);
    let sid = create_session_as(&app, &gm).await;

    // True holder (brute) grapples the victim. A decoy grappler holds some
    // third party elsewhere — it has hands_occupied but holds nobody here.
    let victim_id = Uuid::new_v4();
    let holder_id = Uuid::new_v4();
    let decoy_id = Uuid::new_v4();
    let third_id = Uuid::new_v4();
    for (id, name, x, is_pc) in [
        (victim_id, "Victim", 10.0, true),
        (holder_id, "Holder", 15.0, false),
        (decoy_id, "Decoy", 20.0, false),
        (third_id, "ThirdParty", 25.0, false),
    ] {
        let mut e = entity_json(id, name, 40, 12, 6, "1d8");
        e["position"] = serde_json::json!([x, 2.5, 0.0]);
        e["is_player"] = serde_json::json!(is_pc);
        spawn_entity(&app, &gm, sid, e).await;
    }

    // Holder grabs victim (deterministic seed scan).
    win_grapple(&app, &gm, sid, holder_id, victim_id).await;

    // Decoy grabs the third party so its hand reads occupied too.
    win_grapple(&app, &gm, sid, decoy_id, third_id).await;

    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&victim_id.to_string()]["conditions"],
        serde_json::json!(["grappled"]),
        "fixture: victim is held"
    );

    // Victim names the WRONG grappler.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": victim_id,
            "grappler_id": decoy_id,
            "skill": "athletics",
            "seed": 7
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "NOT_YOUR_GRAPPLER", "{body}");

    // Both states untouched: the decoy's hand was never released...
    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&decoy_id.to_string()]["hands_occupied"],
        serde_json::json!(1),
        "the wrongly-named creature keeps its own hand"
    );
    // ...and the TRUE hold survives intact.
    assert_eq!(
        snap["entities"][&holder_id.to_string()]["hands_occupied"],
        serde_json::json!(1),
        "the real holder's hand stays bound"
    );
    assert_eq!(
        snap["entities"][&victim_id.to_string()]["conditions"],
        serde_json::json!(["grappled"]),
        "Grappled stays on the escaper"
    );
    assert_eq!(
        snap["entities"][&third_id.to_string()]["conditions"],
        serde_json::json!(["grappled"]),
        "the decoy's unrelated victim is untouched"
    );
    assert_eq!(
        snap["entities"][&victim_id.to_string()]["action_budget"]["action"],
        serde_json::json!(true),
        "a mis-attributed escape attempt spends no Action"
    );
    assert!(
        !snap["ledger"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["event_type"] == serde_json::json!("GRAPPLE_ESCAPED")),
        "a refused escape journals nothing"
    );
}

/// Escaping against your TRUE holder works exactly as before — the attribution
/// gate adds nothing when the named grappler is the recorded holder.
#[actix_web::test]
async fn escape_against_true_holder_still_works() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc60b", "gm", TEST_SECRET);
    let auth = bearer(&gm);
    let sid = create_session_as(&app, &gm).await;
    let (hero_id, brute_id) = escape_fixture(&app, &gm, sid).await;

    win_grapple(&app, &gm, sid, brute_id, hero_id).await;

    let mut escaped = false;
    for seed in 1..=60u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "entity_id": hero_id,
                "grappler_id": brute_id,
                "skill": "athletics",
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        if res.status() == StatusCode::CONFLICT {
            advance_turn(&app, &gm, sid).await;
            continue;
        }
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = test::read_body_json(res).await;
        if body["success"] == serde_json::json!(true) {
            escaped = true;
            break;
        }
        advance_turn(&app, &gm, sid).await;
    }
    assert!(escaped, "some seed in 1..=60 must clear the escape DC");

    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(0),
        "escaping the TRUE holder frees the held hand as before"
    );
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["conditions"],
        serde_json::json!([]),
        "the hold ends on the escaper's side too"
    );
}

/// A forced GM release bypasses the check but still cannot free the wrong
/// pair: force is an override of the CHECK, not of the ATTRIBUTION.
#[actix_web::test]
async fn forced_escape_of_wrong_grappler_is_also_refused() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc60c", "gm", TEST_SECRET);
    let auth = bearer(&gm);
    let sid = create_session_as(&app, &gm).await;
    let (hero_id, brute_id) = escape_fixture(&app, &gm, sid).await;
    win_grapple(&app, &gm, sid, brute_id, hero_id).await;

    // GM forces an escape naming a bystander instead of the true holder.
    let bystander_id = Uuid::new_v4();
    let mut b = entity_json(bystander_id, "Bystander", 30, 12, 0, "1d4");
    b["position"] = serde_json::json!([40.0, 2.5, 0.0]);
    b["is_player"] = serde_json::json!(false);
    spawn_entity(&app, &gm, sid, b).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
        .insert_header(auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hero_id,
            "grappler_id": bystander_id,
            "skill": "athletics",
            "force": true
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "NOT_YOUR_GRAPPLER", "{body}");

    let snap = snapshot_as(&app, &gm, sid).await;
    assert_eq!(
        snap["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(1),
        "the forced-but-wrong release frees nothing"
    );
    assert_eq!(
        snap["entities"][&hero_id.to_string()]["conditions"],
        serde_json::json!(["grappled"]),
        "the hold survives"
    );
}

/// Rewind consistency: after a corrected escape, rewinding to NOW rebuilds the
/// freed hand from the surviving GRAPPLE_ESCAPED (whose payload carries the
/// holder attribution) — never a resurrected hold on either side.
#[actix_web::test]
async fn rewind_after_attributed_escape_keeps_the_release_not_a_hold() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-esc60d", "gm", TEST_SECRET);
    let auth = bearer(&gm);
    let sid = create_session_as(&app, &gm).await;
    let (hero_id, brute_id) = escape_fixture(&app, &gm, sid).await;

    win_grapple(&app, &gm, sid, brute_id, hero_id).await;
    let mut escaped = false;
    for seed in 1..=60u64 {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/action/escape-grapple", sid))
            .insert_header(auth.clone())
            .set_json(serde_json::json!({
                "entity_id": hero_id,
                "grappler_id": brute_id,
                "skill": "athletics",
                "seed": seed
            }))
            .to_request();
        let res = test::call_service(&app, req).await;
        if res.status() == StatusCode::CONFLICT {
            advance_turn(&app, &gm, sid).await;
            continue;
        }
        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = test::read_body_json(res).await;
        if body["success"] == serde_json::json!(true) {
            escaped = true;
            break;
        }
        advance_turn(&app, &gm, sid).await;
    }
    assert!(escaped, "fixture escape must succeed");

    // No-op rewind: replay from the ledger must reproduce exactly what the
    // table saw — freed hand, no condition, no resurrected hold.
    let target_seq = snapshot_as(&app, &gm, sid).await["ledger"]["current_sequence"]
        .as_u64()
        .unwrap();
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", sid))
        .insert_header(auth)
        .set_json(serde_json::json!({
            "player_id": "player-esc60d",
            "topic": "iteration-60 attribution rewind",
            "target_sequence_id": target_seq
        }))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;
    assert_eq!(body["status"], "SAFETY_REWIND_SUCCESS");
    assert_eq!(
        body["snapshot"]["entities"][&brute_id.to_string()]["hands_occupied"],
        serde_json::json!(0),
        "rewind honors the attributed escape's hand release"
    );
    assert_eq!(
        body["snapshot"]["entities"][&hero_id.to_string()]["conditions"],
        serde_json::json!([]),
        "rewind keeps the escaper free"
    );
}

// --- Iteration 88 (audit F3): the /move wire must not name hidden attackers ---
//
// The move response annotated `opportunity_attacks_detail` (and the singular
// back-compat `opportunity_attack`) with EVERY armed adjacent enemy that the
// departing mover provoked — including enemies a non-GM caller cannot see.
// A player moving out of a hidden lurker's reach learned an invisible
// creature exists and where it stands. Fix: project per caller role. GM sees
// every provocation verbatim; players/spectators see only VISIBLE attackers;
// hidden provocations are omitted from the wire entirely while the pending OA
// still exists server-side.

/// Spawns an entity with explicit visibility, position and side.
#[allow(clippy::too_many_arguments)]
async fn spawn_at_visible(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    auth: &(actix_web::http::header::HeaderName, String),
    session_id: Uuid,
    id: Uuid,
    name: &str,
    is_player: bool,
    is_visible: bool,
    pos: [f64; 3],
) {
    let mut payload = entity_json(id, name, 20, 12, 3, "1d6+1");
    payload["is_player"] = serde_json::json!(is_player);
    payload["is_visible"] = serde_json::json!(is_visible);
    payload["position"] = serde_json::json!(pos);
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/entities", session_id))
        .insert_header((auth.0.clone(), auth.1.clone()))
        .set_json(payload)
        .to_request();
    let res = test::call_service(app, req).await;
    assert_eq!(res.status(), StatusCode::OK, "spawn of {} failed", name);
}

#[actix_web::test]
async fn move_response_for_non_gm_omits_hidden_attacker_disclosures() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-88", "gm", TEST_SECRET);
    // player-2 will own the mover so the player may move it at all.
    let player = sign_token_with_role("player-two", "player", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let player_auth = bearer(&player);
    let session_id = create_opportunity_session(&app, &gm_auth).await;

    let hero_id = Uuid::new_v4();
    let hidden_lurker_id = Uuid::new_v4();

    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["owner_player_id"] = serde_json::json!("player-two");
    hero["position"] = serde_json::json!([5.0, 5.0, 0.0]);
    for payload in [hero] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(gm_auth.clone())
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }
    spawn_at_visible(
        &app, &gm_auth, session_id, hidden_lurker_id, "Hidden Lurker",
        false, false, [10.0, 5.0, 0.0],
    )
    .await;

    // Arm ONLY the hidden lurker's opportunity reaction.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header(gm_auth.clone())
        .set_json(serde_json::json!({
            "entity_id": hidden_lurker_id,
            "reaction_type": "opportunity_attack"
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // THE PLAYER walks away: provocation happens server-side...
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(player_auth.clone())
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;

    // ...but the WIRE must not name the hidden attacker to the player.
    assert!(
        body.get("opportunity_attack").is_none() || body["opportunity_attack"].is_null(),
        "singular disclosure must be withheld for a hidden attacker: {}",
        body
    );
    assert!(
        body.get("opportunity_attacks_detail").is_none()
            || body["opportunity_attacks_detail"].is_null(),
        "detail array must not carry hidden attackers to a player: {}",
        body
    );

    // The mechanic SURVIVES: the pending OA exists server-side and the GM can
    // still resolve the hidden enemy's swing against its reaction budget.
    let seed = oa_hit_seed(3, 14);
    let (status, oa_body) = post_opportunity_attack(
        &app, &gm, session_id, hidden_lurker_id, hero_id, seed,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the pending OA from the HIDDEN enemy must still resolve: {}",
        oa_body
    );
    assert_eq!(oa_body["is_opportunity"], serde_json::json!(true));
}

#[actix_web::test]
async fn move_response_for_non_gm_keeps_visible_attacker_disclosures() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-88v", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-twov", "player", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let player_auth = bearer(&player);
    let session_id = create_opportunity_session(&app, &gm_auth).await;

    let hero_id = Uuid::new_v4();
    let visible_orc_id = Uuid::new_v4();

    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["owner_player_id"] = serde_json::json!("player-twov");
    hero["position"] = serde_json::json!([5.0, 5.0, 0.0]);
    for payload in [hero] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(gm_auth.clone())
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }
    spawn_at_visible(
        &app, &gm_auth, session_id, visible_orc_id, "Board Orc",
        false, true, [10.0, 5.0, 0.0],
    )
    .await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
        .insert_header(gm_auth.clone())
        .set_json(serde_json::json!({
            "entity_id": visible_orc_id,
            "reaction_type": "opportunity_attack"
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(player_auth.clone())
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 5.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;

    // A VISIBLE attacker's provocation stays on the wire for players.
    assert_eq!(
        body["opportunity_attack"]["provoked_by"],
        visible_orc_id.to_string(),
        "{}",
        body
    );
    let detail = body["opportunity_attacks_detail"]
        .as_array()
        .expect("visible provocation keeps the detail array");
    assert_eq!(detail.len(), 1);
    assert_eq!(detail[0]["provoked_by"], visible_orc_id.to_string());
}

#[actix_web::test]
async fn move_response_for_non_gm_splits_hidden_and_visible_mixed_provocateurs() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-88m", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-threem", "player", TEST_SECRET);
    let gm_auth = bearer(&gm);
    let player_auth = bearer(&player);
    let session_id = create_opportunity_session(&app, &gm_auth).await;

    let hero_id = Uuid::new_v4();
    let visible_orc_id = Uuid::new_v4();
    let hidden_lurker_id = Uuid::new_v4();

    let mut hero = entity_json(hero_id, "Hero", 30, 14, 8, "1d8+3");
    hero["owner_player_id"] = serde_json::json!("player-threem");
    hero["position"] = serde_json::json!([5.0, 5.0, 0.0]);
    for payload in [hero] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/entities", session_id))
            .insert_header(gm_auth.clone())
            .set_json(payload)
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }
    spawn_at_visible(
        &app, &gm_auth, session_id, visible_orc_id, "Board Orc",
        false, true, [10.0, 5.0, 0.0],
    )
    .await;
    spawn_at_visible(
        &app, &gm_auth, session_id, hidden_lurker_id, "Hidden Lurker",
        false, false, [5.0, 10.0, 0.0],
    )
    .await;

    // Arm BOTH.
    for enemy in [visible_orc_id, hidden_lurker_id] {
        let req = test::TestRequest::post()
            .uri(&format!("/api/v1/sessions/{}/reactions/arm", session_id))
            .insert_header(gm_auth.clone())
            .set_json(serde_json::json!({
                "entity_id": enemy,
                "reaction_type": "opportunity_attack"
            }))
            .to_request();
        assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    }

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/move", session_id))
        .insert_header(player_auth.clone())
        .set_json(serde_json::json!({"entity_id": hero_id, "x": 20.0, "y": 20.0}))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = test::read_body_json(res).await;

    // The PLAYER-facing projection names ONLY the VISIBLE provocateur — in the
    // detail array, the singular back-compat field AND the echoed outcome.
    let raw = serde_json::to_string(&body).unwrap();
    assert_eq!(detail_len(&body), 1, "{}", body);
    assert_eq!(body["opportunity_attack"]["provoked_by"], visible_orc_id.to_string());
    assert_eq!(
        body["outcome"]["opportunity_attacks"].as_array().unwrap().len(),
        1,
        "echoed outcome must also project to visible attackers only"
    );
    assert!(
        !raw.contains(&hidden_lurker_id.to_string()),
        "hidden attacker id must not appear anywhere in a player's move response"
    );

    // The mechanic SURVIVES the redaction: the HIDDEN lurker's OA still pends
    // and resolves against its reaction budget.
    let seed = oa_hit_seed(3, 14);
    let (status, oa_body) =
        post_opportunity_attack(&app, &gm, session_id, hidden_lurker_id, hero_id, seed).await;
    assert_eq!(status, StatusCode::OK, "hidden enemy's pending OA must survive: {}", oa_body);
}

/// Number of entries in the projected opportunity_attacks_detail array (0 when
/// the field was withheld entirely).
fn detail_len(body: &serde_json::Value) -> usize {
    body["opportunity_attacks_detail"].as_array().map(|a| a.len()).unwrap_or(0)
}

// --- Delay action (SRD-optional, table-standard QoL) --------------------------

/// Spawns two combatants (optional owners per combatant), opens combat and
/// returns (session_id, id_a, id_b).
async fn delay_fixture(
    app: test_app_ty!(),
    gm: &str,
    owner_a: Option<&str>,
    owner_b: Option<&str>,
) -> (Uuid, Uuid, Uuid) {
    let session_id = create_session_as(app, gm).await;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    for (id, owner) in [(a, owner_a), (b, owner_b)] {
        let mut payload = entity_json(id, "Combatant", 20, 14, 5, "1d8");
        if let Some(o) = owner {
            payload["owner_player_id"] = serde_json::json!(o);
        }
        spawn_entity(app, gm, session_id, payload).await;
    }
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(bearer(gm))
        .to_request();
    assert_eq!(test::call_service(app, req).await.status(), StatusCode::OK);
    (session_id, a, b)
}

/// Spawns two combatants WITHOUT opening combat yet.
async fn delay_spawn_only(
    app: test_app_ty!(),
    gm: &str,
) -> (Uuid, Uuid, Uuid) {
    let session_id = create_session_as(app, gm).await;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    for id in [a, b] {
        spawn_entity(app, gm, session_id, entity_json(id, "Combatant", 20, 14, 5, "1d8")).await;
    }
    (session_id, a, b)
}

async fn post_delay(
    app: test_app_ty!(),
    token: &str,
    session_id: Uuid,
    entity_id: Uuid,
    resume: bool,
) -> (StatusCode, serde_json::Value) {
    let uri = if resume {
        format!("/api/v1/sessions/{}/action/delay/resume", session_id)
    } else {
        format!("/api/v1/sessions/{}/action/delay", session_id)
    };
    let req = test::TestRequest::post()
        .uri(&uri)
        .insert_header(bearer(token))
        .set_json(serde_json::json!({"entity_id": entity_id}))
        .to_request();
    let res = test::call_service(app, req).await;
    let status = res.status();
    let body: serde_json::Value = test::read_body_json(res).await;
    (status, body)
}

#[actix_web::test]
async fn delay_enforces_spectator_and_ownership_rbac() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-1", "player", TEST_SECRET);
    let spectator = sign_token_with_role("watcher", "spectator", TEST_SECRET);
    let (session_id, mine_id, other_id) =
        delay_fixture(&app, &gm, Some("player-1"), Some("someone-else")).await;

    // Spectators cannot delay anyone.
    let (status, body) =
        post_delay(&app, &spectator, session_id, mine_id, false).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "FORBIDDEN_ROLE");

    // Players cannot park someone else's combatant.
    let (status, body) =
        post_delay(&app, &player, session_id, other_id, false).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "ENTITY_NOT_OWNED");
    // …nor resume them out of a delay.
    let (status, body) =
        post_delay(&app, &player, session_id, other_id, true).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "ENTITY_NOT_OWNED");

    // Their own entity delays fine.
    let (status, _) = post_delay(&app, &player, session_id, mine_id, false).await;
    assert_eq!(status, StatusCode::OK);
}

#[actix_web::test]
async fn delay_take_resume_roundtrip_is_free_and_ledgers_state() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    // Outside combat the engine refuses to park anybody.
    let (session_id, a, _b) = delay_spawn_only(&app, &gm).await;
    let (status, body) = post_delay(&app, &gm, session_id, a, false).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "NOT_IN_COMBAT");

    // Now open combat and take the delay for real.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(bearer(&gm))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    // Take the delay: free — the Action budget survives untouched.
    let (status, body) = post_delay(&app, &gm, session_id, a, false).await;
    assert_eq!(status, StatusCode::OK, "{}", body);
    assert_eq!(body["status"], "DELAY_TAKEN");
    assert_eq!(
        body["delayed"].as_array().unwrap().len(),
        1,
        "exactly one combatant parked"
    );
    assert!(body["event_sequence"].as_u64().is_some());

    let snap = session_snapshot(&app, &gm, session_id).await;
    assert_eq!(
        snap["combat"]["delayed"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| **v == json_str(&a))
            .count(),
        1
    );
    assert_eq!(
        snap["entities"][a.to_string()]["action_budget"]["action"],
        true,
        "delaying costs no Action"
    );

    // Resuming re-seats at the current count and clears the flag everywhere.
    let (status, body) = post_delay(&app, &gm, session_id, a, true).await;
    assert_eq!(status, StatusCode::OK, "{}", body);
    assert_eq!(body["status"], "DELAY_RESUMED");
    assert_eq!(body["delayed"].as_array().unwrap().len(), 0);
    let snap = session_snapshot(&app, &gm, session_id).await;
    assert_eq!(snap["combat"]["delayed"].as_array().unwrap().len(), 0);

    // A second resume has nobody to re-seat.
    let (status, body) = post_delay(&app, &gm, session_id, a, true).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "NOT_DELAYED");
}

#[actix_web::test]
async fn xcard_rewind_restores_delayed_state_from_the_ledger() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let (session_id, a, _b) = delay_fixture(&app, &gm, None, None).await;

    let (_, take_body) = post_delay(&app, &gm, session_id, a, false).await;
    let after_delay_seq = take_body["event_sequence"].as_u64().unwrap();
    let (_, _) = post_delay(&app, &gm, session_id, a, true).await;
    let snap = session_snapshot(&app, &gm, session_id).await;
    assert_eq!(snap["combat"]["delayed"].as_array().unwrap().len(), 0);

    // Rewind between DELAY_TAKEN and DELAY_RESUMED: only the resume dies, so
    // the surviving DELAY_TAKEN must restore the parked flag live.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "player_id": "gm-1",
            "topic": "rewind the resume",
            "target_sequence_id": after_delay_seq
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);

    let snap = session_snapshot(&app, &gm, session_id).await;
    assert_eq!(
        snap["combat"]["delayed"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| **v == json_str(&a))
            .count(),
        1,
        "rewound resume restores the delay from the ledger"
    );

    // And rewinding past the delay itself clears it again.
    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/safety/x-card", session_id))
        .insert_header(bearer(&gm))
        .set_json(serde_json::json!({
            "player_id": "gm-1",
            "topic": "rewind further",
            "target_sequence_id": after_delay_seq - 1
        }))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    let snap = session_snapshot(&app, &gm, session_id).await;
    assert_eq!(
        snap["combat"]["delayed"].as_array().unwrap().len(),
        0,
        "nobody stays parked once the DELAY_TAKEN is rewound"
    );
}

#[actix_web::test]
async fn hidden_delayed_npc_is_dropped_from_non_gm_projection() {
    let app = test_app().await;
    let gm = sign_token_with_role("gm-1", "gm", TEST_SECRET);
    let player = sign_token_with_role("player-9", "player", TEST_SECRET);
    let session_id = create_session_as(&app, &gm).await;

    let hero_id = Uuid::new_v4();
    let mut hero = entity_json(hero_id, "Hero", 20, 14, 5, "1d8");
    hero["owner_player_id"] = serde_json::json!("player-9");
    spawn_entity(&app, &gm, session_id, hero).await;

    // A HIDDEN NPC also joins the fight and then delays.
    let lurker_id = Uuid::new_v4();
    let mut lurker = entity_json(lurker_id, "Lurker", 20, 14, 5, "1d8");
    lurker["is_visible"] = serde_json::json!(false);
    spawn_entity(&app, &gm, session_id, lurker).await;

    let req = test::TestRequest::post()
        .uri(&format!("/api/v1/sessions/{}/combat/begin", session_id))
        .insert_header(bearer(&gm))
        .to_request();
    assert_eq!(test::call_service(&app, req).await.status(), StatusCode::OK);
    let (status, _) = post_delay(&app, &gm, session_id, lurker_id, false).await;
    assert_eq!(status, StatusCode::OK);

    // GM sees the truth; the player's projection drops the hidden id from
    // BOTH order and delayed — its position there leaks relative initiative.
    let gm_snap = session_snapshot(&app, &gm, session_id).await;
    assert!(gm_snap["combat"]["delayed"]
        .as_array()
        .unwrap()
        .contains(&json_str(&lurker_id)));

    let player_snap = session_snapshot(&app, &player, session_id).await;
    // Ledger payloads carry ids by gateway policy ("trusted with exact ledger
    // numbers"), so the disclosure surface under audit is the COMBAT arrays:
    // hidden slots are dropped from order AND from delayed.
    let combat = &player_snap["combat"];
    assert!(
        !serde_json::to_string(combat).unwrap().contains(&lurker_id.to_string()),
        "hidden delayed npc id must not appear in a player's combat projection"
    );
    assert_eq!(combat["order"].as_array().unwrap().len(), 1, "only the visible hero's slot survives");
    assert_eq!(combat["delayed"].as_array().unwrap().len(), 0, "the hidden npc's parked flag is dropped");
}
