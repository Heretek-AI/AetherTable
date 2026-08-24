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

async fn test_app() -> impl Service<
    actix_http::Request,
    Response = ServiceResponse<EitherBody<BoxBody>>,
    Error = actix_web::Error,
> {
    let verifier = Arc::new(AuthVerifier {
        secret: Arc::new(TEST_SECRET.to_string()),
    });
    let state = actix_web::web::Data::new(vtt_server::AppState::new());
    test::init_service(
        App::new()
            .wrap(AuthMiddleware { verifier })
            .app_data(state)
            .route("/health", actix_web::web::get().to(|| async {
                actix_web::HttpResponse::Ok().finish()
            }))
            .configure(vtt_server::configure_app),
    )
    .await
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
    let req = test::TestRequest::get().uri("/health").to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
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
    let token = sign_token("gm-1", TEST_SECRET);
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
    let token = sign_token("gm-1", TEST_SECRET);
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
    for seed in 1..=50u64 {
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
                // A miss still spends the Action, so stop scanning seeds.
                break;
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
    let token = sign_token("gm-1", TEST_SECRET);
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
    let token = sign_token("gm-1", TEST_SECRET);
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
    let gm = sign_token("gm-1", TEST_SECRET);
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
    let gm = sign_token("gm-1", TEST_SECRET);
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
    let gm = sign_token("gm-1", TEST_SECRET);
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

#[actix_web::test]
async fn heal_happy_path_restores_hp_consciousness_and_death_saves() {
    let app = test_app().await;
    let gm = sign_token("gm-1", TEST_SECRET);
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
    let gm = sign_token("gm-1", TEST_SECRET);
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
    let gm = sign_token("gm-1", TEST_SECRET);
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
    let gm = sign_token("gm-1", TEST_SECRET);
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
            break;
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
    let gm = sign_token("gm-1", TEST_SECRET);
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
