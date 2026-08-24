//! Integration tests for per-IP rate limiting (backlog 4.10).
//!
//! Bucket contract:
//! - `/scripts/*` is STRICT (compile work is un-metered CPU) — quota must 429.
//! - `/health` and `/metrics` are UNLIMITED — never throttled even under load
//!   that has exhausted every other bucket.
//!
//! Determinism: governor counts live in the middleware instance built by one
//! `configure_app_with` call, so each test builds its OWN app with tiny quotas
//! (e.g. 2/min) instead of relying on process-global env vars — the 3rd request
//! deterministically trips the limit, no timing races.

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
use vtt_server::{AuthMiddleware, AuthVerifier, RateLimits};

const TEST_SECRET: &str = "rate-limit-test-secret";

type HmacSha256 = Hmac<Sha256>;

fn bearer(token: &str) -> (actix_web::http::header::HeaderName, String) {
    (
        actix_web::http::header::AUTHORIZATION,
        format!("Bearer {}", token),
    )
}

fn sign_token(user_id: &str) -> String {
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        + 3600.0;
    let payload = serde_json::json!({"user_id": user_id, "exp": exp});
    let raw = serde_json::to_vec(&payload).unwrap();
    let mut mac = HmacSha256::new_from_slice(TEST_SECRET.as_bytes()).unwrap();
    mac.update(&raw);
    let sig = hex::encode(mac.finalize().into_bytes());
    format!(
        "{}.{}",
        base64::engine::general_purpose::URL_SAFE.encode(&raw),
        sig
    )
}

/// Builds the production route configuration with EXPLICIT quotas — no env
/// vars, no cross-test interference.
async fn limited_app(
    limits: RateLimits,
) -> impl Service<
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
            .configure(move |cfg| vtt_server::configure_app_with(cfg, &limits)),
    )
    .await
}

/// Minimal valid Rhai payload so throttling (not deserialization) decides the
/// status code for the first `quota` requests.
fn rhai_payload() -> serde_json::Value {
    serde_json::json!({
        "script": "1 + 1",
        "context": {
            "caster_level": 5,
            "target_ac": 12,
            "spell_dc": 13,
            "environment_tag": "dungeon"
        }
    })
}

async fn post_rhai(
    app: &impl Service<
        actix_http::Request,
        Response = ServiceResponse<EitherBody<BoxBody>>,
        Error = actix_web::Error,
    >,
    token: &str,
) -> StatusCode {
    let req = test::TestRequest::post()
        .uri("/api/v1/scripts/rhai")
        .insert_header(bearer(token))
        .set_json(rhai_payload())
        .to_request();
    test::call_service(app, req).await.status()
}

/// The strict scripts bucket: with a 2/min quota the third POST within the
/// window MUST be rejected with 429 while the first two pass through.
#[actix_web::test]
async fn script_route_429s_after_quota_is_exhausted() {
    // Scripts: 2/min. Everything else effectively unlimited so only the
    // bucket under test can produce a rejection.
    let limits = RateLimits::explicit(2, 1_000_000, 1_000_000);
    let app = limited_app(limits).await;
    let token = sign_token("gm-1");

    assert_eq!(post_rhai(&app, &token).await, StatusCode::OK, "request 1");
    assert_eq!(post_rhai(&app, &token).await, StatusCode::OK, "request 2");
    assert_eq!(
        post_rhai(&app, &token).await,
        StatusCode::TOO_MANY_REQUESTS,
        "3rd script call inside the window must be throttled"
    );
    assert!(
        post_rhai(&app, &token).await == StatusCode::TOO_MANY_REQUESTS,
        "throttling persists for the rest of the window"
    );
}

/// The wasm sibling shares ONE strict scripts bucket with rhai: two calls split
/// across both endpoints still exhaust the same 2/min budget.
#[actix_web::test]
async fn wasm_and_rhai_share_one_strict_bucket() {
    let limits = RateLimits::explicit(2, 1_000_000, 1_000_000);
    let app = limited_app(limits).await;
    let token = sign_token("gm-1");

    let rhai = test::TestRequest::post()
        .uri("/api/v1/scripts/rhai")
        .insert_header(bearer(&token))
        .set_json(rhai_payload())
        .to_request();
    assert_eq!(test::call_service(&app, rhai).await.status(), StatusCode::OK);

    let wasm = test::TestRequest::post()
        .uri("/api/v1/scripts/wasm")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "wat_source": "(module (func (export \"f\") (result i32) i32.const 42))",
            "function_name": "f",
            "params": [],
            "fuel_limit": 1000
        }))
        .to_request();
    assert_eq!(test::call_service(&app, wasm).await.status(), StatusCode::OK);

    // Bucket shared across /scripts/*: next script call is throttled...
    assert_eq!(post_rhai(&app, &token).await, StatusCode::TOO_MANY_REQUESTS);

    // ...while an ACTION route on the same "IP" still flows (its moderate
    // bucket is independent and effectively unlimited here).
    let req = test::TestRequest::post()
        .uri("/api/v1/actions/check")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"modifier": 2, "dc": 10, "cost_margin": 5}))
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::OK,
        "action bucket must not be poisoned by exhausted script bucket"
    );
}

/// Health and metrics are un-metered: they stay 200 under the SAME load that
/// exhausts the strict script bucket (ops probes must never be throttled).
#[actix_web::test]
async fn health_and_metrics_stay_unlimited_under_throttling_load() {
    let limits = RateLimits::explicit(2, 1_000_000, 1_000_000);
    let app = limited_app(limits).await;
    let token = sign_token("gm-1");

    // Exhaust the script bucket first.
    assert_eq!(post_rhai(&app, &token).await, StatusCode::OK);
    assert_eq!(post_rhai(&app, &token).await, StatusCode::OK);

    // Now hammer health/metrics far beyond any small quota.
    for i in 0..25u32 {
        let health = test::TestRequest::get().uri("/health").to_request();
        assert_eq!(
            test::call_service(&app, health).await.status(),
            StatusCode::OK,
            "/health call {} must never be rate-limited",
            i
        );
        let metrics = test::TestRequest::get().uri("/metrics").to_request();
        assert_eq!(
            test::call_service(&app, metrics).await.status(),
            StatusCode::OK,
            "/metrics call {} must never be rate-limited",
            i
        );
    }

    // And the scripts bucket is STILL exhausted by all that traffic.
    assert_eq!(post_rhai(&app, &token).await, StatusCode::TOO_MANY_REQUESTS);
}

/// Moderate action bucket: with actions pinned to 3/min, the 4th action POST
/// 429s while reads (generous tier) keep flowing.
#[actix_web::test]
async fn action_bucket_throttles_while_reads_stay_open() {
    let limits = RateLimits::explicit(1_000_000, 3, 1_000_000);
    let app = limited_app(limits).await;
    let token = sign_token("gm-1");

    for i in 0..3u32 {
        let req = test::TestRequest::post()
            .uri("/api/v1/actions/check")
            .insert_header(bearer(&token))
            .set_json(serde_json::json!({"modifier": 1, "dc": 10, "cost_margin": 5}))
            .to_request();
        assert_eq!(
            test::call_service(&app, req).await.status(),
            StatusCode::OK,
            "check {} of 3 within quota",
            i + 1
        );
    }
    let req = test::TestRequest::post()
        .uri("/api/v1/actions/check")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({"modifier": 1, "dc": 10, "cost_margin": 5}))
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "4th action inside the window must be throttled"
    );

    // Generous read tier untouched by the action throttle.
    let req = test::TestRequest::get()
        .uri("/api/v1/rooms/00000000-0000-0000-0000-000000000000/presence")
        .insert_header(bearer(&token))
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::OK,
        "read routes ride the generous bucket, not the action bucket"
    );
}

/// The moderate ACTION budget is SHARED across every action scope: requests
/// alternating between `/actions/*` and `/spatial/*` drain ONE combined
/// quota, so with actions pinned to 3/min the 4th total request 429s even
/// though each individual route has seen at most 2.
#[actix_web::test]
async fn action_scopes_share_one_budget_across_routes() {
    let limits = RateLimits::explicit(1_000_000, 3, 1_000_000);
    let app = limited_app(limits).await;
    let token = sign_token("gm-1");

    // Alternate scopes: /actions/check and /spatial/los.
    let mut statuses = Vec::new();
    for i in 0..3u32 {
        let uri = if i % 2 == 0 {
            "/api/v1/actions/check"
        } else {
            "/api/v1/spatial/los"
        };
        let body = if i % 2 == 0 {
            serde_json::json!({"modifier": 1, "dc": 10, "cost_margin": 5})
        } else {
            serde_json::json!({
                "attacker_pos": {"x": 0.0, "y": 0.0, "z": 0.0},
                "target_pos": {"x": 5.0, "y": 5.0, "z": 0.0},
                "target_radius": 1.0,
                "grid_width": 32,
                "grid_height": 32,
                "solid_cells": []
            })
        };
        let req = test::TestRequest::post()
            .uri(uri)
            .insert_header(bearer(&token))
            .set_json(body)
            .to_request();
        statuses.push((i + 1, test::call_service(&app, req).await.status()));
    }

    for (n, status) in statuses {
        assert_eq!(
            status,
            StatusCode::OK,
            "request {} of the shared 3/min action budget must pass",
            n
        );
    }

    // 4th TOTAL request across the two scopes — throttled, because both
    // scopes count against the same sliding window.
    let req = test::TestRequest::post()
        .uri("/api/v1/spatial/los")
        .insert_header(bearer(&token))
        .set_json(serde_json::json!({
            "attacker_pos": {"x": 0.0, "y": 0.0, "z": 0.0},
            "target_pos": {"x": 5.0, "y": 5.0, "z": 0.0},
            "target_radius": 1.0,
            "grid_width": 32,
            "grid_height": 32,
            "solid_cells": []
        }))
        .to_request();
    assert_eq!(
        test::call_service(&app, req).await.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "the action budget must be shared across /actions and /spatial, not per-scope"
    );
}

/// Fail-soft env parsing: garbage values fall back to defaults instead of
/// panicking or zeroing out a bucket.
#[actix_web::test]
async fn env_misparse_falls_back_to_defaults() {
    assert_eq!(
        vtt_server::ratelimit::parse_per_minute(Some("not-a-number".into()), 10),
        10,
        "garbage string → default"
    );
    assert_eq!(
        vtt_server::ratelimit::parse_per_minute(Some("-5".into()), 10),
        10,
        "negative → default (no zero/negative quotas)"
    );
    assert_eq!(
        vtt_server::ratelimit::parse_per_minute(Some("0".into()), 10),
        10,
        "zero would make an impossible quota → default"
    );
    assert_eq!(
        vtt_server::ratelimit::parse_per_minute(Some("42".into()), 10),
        42,
        "valid value honored"
    );
    assert_eq!(
        vtt_server::ratelimit::parse_per_minute(None, 10),
        10,
        "unset → default"
    );
}
