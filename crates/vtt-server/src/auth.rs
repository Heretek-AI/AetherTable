//! HMAC session-token authentication for the authoritative engine.
//!
//! Tokens are minted by the Python gateway (`vtt_orchestrator.server`) as
//! `base64url(json_payload) + "." + hex(hmac_sha256(secret, payload))` and must
//! be verified here with the SAME `AUTH_SECRET` so the gateway can propagate
//! player identity to the engine without a second credential store.

use actix_web::{
    body::EitherBody,
    dev::{forward_ready, Service, ServiceRequest, ServiceResponse, Transform},
    http::header::AUTHORIZATION,
    Error, FromRequest, HttpRequest, HttpResponse, HttpMessage,
};
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use futures_util::future::{ok, LocalBoxFuture, Ready};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::Arc;

type HmacSha256 = Hmac<Sha256>;

/// Routes that unauthenticated callers may reach (liveness/metrics only).
const PUBLIC_PATHS: &[&str] = &["/health", "/metrics"];

#[derive(Clone)]
pub struct AuthVerifier {
    pub secret: Arc<String>,
}

/// A verified identity extracted from a session token.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthIdentity {
    pub user_id: String,
    pub role: Option<String>,
}

impl AuthVerifier {
    /// Fails closed: without a shared secret every HMAC token would be
    /// forgeable, so startup aborts instead of silently accepting tokens
    /// signed with a hardcoded dev fallback.
    pub fn from_env() -> anyhow::Result<Self> {
        let secret = std::env::var("VTT_ENGINE_SECRET")
            .or_else(|_| std::env::var("AUTH_SECRET"))
            .ok()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "refusing to start: set VTT_ENGINE_SECRET (or AUTH_SECRET) to the \
                     gateway-shared HMAC secret"
                )
            })?;
        Ok(Self {
            secret: Arc::new(secret),
        })
    }

    /// Verifies signature + expiry of a gateway-signed token.
    pub fn verify(&self, token: &str) -> Option<AuthIdentity> {
        let (raw_b64, sig_hex) = token.split_once('.')?;
        // Python's urlsafe_b64encode emits padded output; accept both forms.
        let raw = URL_SAFE
            .decode(raw_b64)
            .or_else(|_| URL_SAFE_NO_PAD.decode(raw_b64))
            .ok()?;

        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes()).ok()?;
        mac.update(&raw);
        let expected = mac.finalize().into_bytes();

        let sig_bytes = hex::decode(sig_hex).ok()?;
        if sig_bytes.len() != expected.len() {
            return None;
        }
        // Constant-time comparison.
        let mut diff = 0u8;
        for (a, b) in sig_bytes.iter().zip(expected.iter()) {
            diff |= a ^ b;
        }
        if diff != 0 {
            return None;
        }

        let payload: serde_json::Value = serde_json::from_slice(&raw).ok()?;
        let exp = payload.get("exp").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if exp < now_unix() {
            return None;
        }
        Some(AuthIdentity {
            user_id: payload
                .get("user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            role: payload.get("role").and_then(|v| v.as_str()).map(String::from),
        })
    }
}

fn now_unix() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Extracts a bearer token from the Authorization header, or from `?token=`
/// on WebSocket handshakes only (browsers cannot set custom headers there).
/// Query strings leak into access logs, so plain HTTP callers must use the
/// header.
pub fn extract_token(req: &ServiceRequest) -> Option<String> {
    if let Some(header) = req.headers().get(AUTHORIZATION) {
        if let Ok(value) = header.to_str() {
            if let Some(token) = value.strip_prefix("Bearer ") {
                return Some(token.trim().to_string());
            }
        }
    }
    if !req.path().starts_with("/ws/") {
        return None;
    }
    for pair in req.query_string().split('&') {
        let mut parts = pair.splitn(2, '=');
        if parts.next() == Some("token") {
            if let Some(raw) = parts.next() {
                return percent_decode(raw);
            }
        }
    }
    None
}

/// Minimal percent-decoding for query-string tokens (base64url chars are
/// mostly safe; '+' and '%2B' variants handled here).
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16)?;
                let lo = (bytes[i + 2] as char).to_digit(16)?;
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

pub struct AuthMiddleware {
    pub verifier: Arc<AuthVerifier>,
}

/// Extractor: lets handlers declare `identity: AuthIdentity` to receive the
/// verified identity inserted by `AuthMiddlewareService`. Absent identity
/// (public path) yields a synthetic anonymous principal — handlers that need
/// a real caller must reject those themselves via `role`/`user_id`.
impl FromRequest for AuthIdentity {
    type Error = Error;
    type Future = Ready<Result<Self, Self::Error>>;

    fn from_request(req: &HttpRequest, _payload: &mut actix_web::dev::Payload) -> Self::Future {
        let identity = req
            .extensions()
            .get::<AuthIdentity>()
            .cloned()
            .unwrap_or(AuthIdentity {
                user_id: "anonymous".to_string(),
                role: None,
            });
        ok(identity)
    }
}

impl<S, B> Transform<S, ServiceRequest> for AuthMiddleware
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type InitError = ();
    type Transform = AuthMiddlewareService<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ok(AuthMiddlewareService {
            service,
            verifier: Arc::clone(&self.verifier),
        })
    }
}

pub struct AuthMiddlewareService<S> {
    service: S,
    verifier: Arc<AuthVerifier>,
}

impl<S, B> Service<ServiceRequest> for AuthMiddlewareService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Error>>;

    forward_ready!(service);

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let path = req.path();
        if PUBLIC_PATHS.iter().any(|p| path.starts_with(p)) {
            let fut = self.service.call(req);
            return Box::pin(async move {
                Ok(fut.await?.map_into_left_body())
            });
        }

        match extract_token(&req).and_then(|t| self.verifier.verify(&t)) {
            Some(identity) => {
                // Propagate the verified identity so handlers (and the WS
                // handshake path) can enforce role/ownership rules.
                req.extensions_mut().insert(identity);
                let fut = self.service.call(req);
                Box::pin(async move { Ok(fut.await?.map_into_left_body()) })
            }
            None => Box::pin(async move {
                let (http_req, _payload) = req.into_parts();
                let response = HttpResponse::Unauthorized().json(
                    serde_json::json!({"error": "UNAUTHORIZED", "detail": "Valid session token required"}),
                );
                Ok(ServiceResponse::new(
                    http_req,
                    response.map_into_right_body(),
                ))
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(payload: &serde_json::Value, secret: &str) -> String {
        let raw = serde_json::to_vec(payload).unwrap();
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(&raw);
        let sig = hex::encode(mac.finalize().into_bytes());
        format!("{}.{}", URL_SAFE.encode(&raw), sig)
    }

    #[test]
    fn valid_token_verifies() {
        let verifier = AuthVerifier {
            secret: Arc::new("test-secret".to_string()),
        };
        let exp = now_unix() + 3600.0;
        let token = sign(
            &serde_json::json!({"user_id": "gm-1", "exp": exp}),
            "test-secret",
        );
        let id = verifier.verify(&token).expect("must verify");
        assert_eq!(id.user_id, "gm-1");
    }

    #[test]
    fn expired_token_rejected() {
        let verifier = AuthVerifier {
            secret: Arc::new("test-secret".to_string()),
        };
        let token = sign(
            &serde_json::json!({"user_id": "gm-1", "exp": now_unix() - 10.0}),
            "test-secret",
        );
        assert!(verifier.verify(&token).is_none());
    }

    #[test]
    fn forged_signature_rejected() {
        let verifier = AuthVerifier {
            secret: Arc::new("test-secret".to_string()),
        };
        let token = sign(
            &serde_json::json!({"user_id": "attacker", "exp": now_unix() + 3600.0}),
            "wrong-secret",
        );
        assert!(verifier.verify(&token).is_none(), "forged tokens must fail");
    }
}
