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
            "target_id": other_id,
            "seed": 3
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
            "target_id": hero_id,
            "seed": 3
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
        "a mechanical no-op short rest must not emit per-entity rest events"
    );
    assert!(
        snap["ledger"]["events"].as_array().unwrap().iter()
            .any(|e| e["event_type"] == "SHORT_REST_APPLIED"),
        "the no-op rest itself stays ledgered for auditability"
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

    // The reaction was CONSUMED by detection: step back in and away again —
    // this second provocation cannot fire, so the field must be omitted.
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
        serde_json::json!({"entity_id": hero_id, "description": "I attack the goblin", "trigger_hint": "when it moves"}),
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
        serde_json::json!({"attacker_id": claimed_hero, "target_id": claimed_orc, "seed": 7}),
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
