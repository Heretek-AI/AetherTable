//! Per-IP sliding-window rate limiting (backlog 4.10).
//!
//! In-house implementation mirroring the Python gateway's
//! `_RATE_LIMITS` / `_rate_windows` design
//! (`python/vtt_orchestrator/server.py`): a `DashMap` of
//! `(client_ip, bucket) -> VecDeque<Instant>` hit timestamps pruned to the
//! active window. Chosen over the `actix-governor` crate because that crate is
//! GPL-3.0-or-later and this workspace enforces a permissive-license allowlist
//! via cargo-deny; the algorithm is ~150 lines and dependency-free.
//!
//! Buckets (per client IP, constant):
//! - `Script` — STRICT (default 10/min, `VTT_SCRIPT_RATE`): `/scripts/wasm`
//!   and `/scripts/rhai` compile + evaluate attacker-controlled programs, so
//!   compile work must be metered even though every route already sits behind
//!   HMAC auth.
//! - `Action` — MODERATE (default 120/min, `VTT_ACTION_RATE`): game-driving
//!   mutations and computes (`/action/*`, `/damage`, `/heal`, `/move`,
//!   `/actions/*`, `/spatial/*`, `/maps/generate`, session subtree).
//! - `Read`   — GENEROUS (default 600/min, `VTT_READ_RATE`): outer net over
//!   all of `/api/v1` so read-only polling (`/rooms/{id}/presence`, snapshot
//!   GETs) stays frictionless.
//! - `/health`, `/metrics` and the websocket sync alias are UNMETERED — ops
//!   probes and the sync channel must never be throttled.
//!
//! Env knobs are fail-soft: `VTT_SCRIPT_RATE` / `VTT_ACTION_RATE` /
//! `VTT_READ_RATE` accept plain integers ("requests per minute"); unset,
//! non-numeric or non-positive values fall back to the default rather than
//! panicking or producing an impossible quota.

use actix_web::body::EitherBody;
use actix_web::dev::{forward_ready, Service, ServiceRequest, ServiceResponse, Transform};
use actix_web::http::header::{HeaderValue, RETRY_AFTER};
use actix_web::{Error, HttpResponse};
use dashmap::DashMap;
use futures_util::future::{ok, Ready};
use std::collections::VecDeque;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::time::{Duration, Instant};

/// Default strict quota for script-execution routes (requests per minute).
///
/// `VTT_SCRIPT_RATE` overrides; see module docs for the other buckets.
pub const DEFAULT_SCRIPT_PER_MINUTE: u32 = 10;
/// Default moderate quota for action routes (`VTT_ACTION_RATE`).
pub const DEFAULT_ACTION_PER_MINUTE: u32 = 120;
/// Default generous quota wrapping all of `/api/v1` (`VTT_READ_RATE`).
pub const DEFAULT_READ_PER_MINUTE: u32 = 600;

/// Window size shared by every bucket (mirrors the gateway's 60 s windows).
const WINDOW: Duration = Duration::from_secs(60);
const WINDOW_SECS: u64 = WINDOW.as_secs();

/// Hard cap on tracked (ip, bucket) keys so an attacker rotating spoofed IPs
/// cannot grow the table without bound; exceeded → full stale sweep.
const MAX_TRACKED_KEYS: usize = 100_000;

/// Which constant quota a request counts against. Public because
/// [`RateLimit::new`] names its bucket explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Bucket {
    /// Strict: script compilation/evaluation routes.
    Script,
    /// Moderate: game-driving mutations and computes.
    Action,
    /// Generous: everything else under `/api/v1`.
    Read,
}

impl Bucket {
    fn env_var(self) -> &'static str {
        match self {
            Bucket::Script => "VTT_SCRIPT_RATE",
            Bucket::Action => "VTT_ACTION_RATE",
            Bucket::Read => "VTT_READ_RATE",
        }
    }

    fn default_per_minute(self) -> u32 {
        match self {
            Bucket::Script => DEFAULT_SCRIPT_PER_MINUTE,
            Bucket::Action => DEFAULT_ACTION_PER_MINUTE,
            Bucket::Read => DEFAULT_READ_PER_MINUTE,
        }
    }
}

/// Fail-soft "requests per minute" parser: `None`, garbage, zero or negative
/// input yields `default`; only clean positive integers override it.
pub fn parse_per_minute(raw: Option<String>, default: u32) -> u32 {
    match raw {
        None => default,
        Some(s) => match s.trim().parse::<u32>() {
            Ok(n) if n > 0 => n,
            _ => {
                log::warn!(
                    "rate-limit env value {:?} unusable; falling back to {} req/min",
                    s,
                    default
                );
                default
            }
        },
    }
}

fn env_per_minute(var: &str, default: u32) -> u32 {
    parse_per_minute(std::env::var(var).ok(), default)
}

/// Constant per-IP quotas for the three buckets.
#[derive(Debug, Clone, Copy)]
pub struct RateLimits {
    pub script_per_minute: u32,
    pub action_per_minute: u32,
    pub read_per_minute: u32,
}

impl Default for RateLimits {
    fn default() -> Self {
        Self {
            script_per_minute: DEFAULT_SCRIPT_PER_MINUTE,
            action_per_minute: DEFAULT_ACTION_PER_MINUTE,
            read_per_minute: DEFAULT_READ_PER_MINUTE,
        }
    }
}

impl RateLimits {
    /// Explicit quotas — used by tests to pin deterministic, tiny limits.
    pub fn explicit(script_per_minute: u32, action_per_minute: u32, read_per_minute: u32) -> Self {
        Self {
            script_per_minute,
            action_per_minute,
            read_per_minute,
        }
    }

    /// Env-driven construction; every knob fails soft to its documented
    /// default (see [`parse_per_minute`]).
    pub fn from_env() -> Self {
        Self {
            script_per_minute: env_per_minute(
                Bucket::Script.env_var(),
                Bucket::Script.default_per_minute(),
            ),
            action_per_minute: env_per_minute(
                Bucket::Action.env_var(),
                Bucket::Action.default_per_minute(),
            ),
            read_per_minute: env_per_minute(
                Bucket::Read.env_var(),
                Bucket::Read.default_per_minute(),
            ),
        }
    }

    fn limit_for(&self, bucket: Bucket) -> u32 {
        match bucket {
            Bucket::Script => self.script_per_minute,
            Bucket::Action => self.action_per_minute,
            Bucket::Read => self.read_per_minute,
        }
    }
}

/// Shared sliding-window store: `(client_ip, bucket) -> recent hit instants`.
/// Mirrors the Python gateway's `_rate_windows`.
struct SlidingWindows {
    hits: DashMap<(IpAddr, Bucket), VecDeque<Instant>>,
}

impl SlidingWindows {
    fn new() -> Self {
        Self {
            hits: DashMap::new(),
        }
    }

    /// Records one hit unless the caller's window is full. `Ok(())` admits the
    /// request; `Err(retry_after)` rejects it and reports when the oldest hit
    /// leaves the window.
    fn check(&self, ip: IpAddr, bucket: Bucket, limit: u32) -> Result<(), u64> {
        let now = Instant::now();

        // Verdict computed while holding this key's shard guard; the guard is
        // dropped before any whole-map operation below (DashMap is not
        // re-entrant: calling `len()`/`retain()` under `entry()` would
        // self-deadlock on the same shard).
        let admitted = {
            let mut entry = self.hits.entry((ip, bucket)).or_default();

            // Evict hits older than the window, then decide.
            while let Some(front) = entry.front() {
                if now.duration_since(*front) >= WINDOW {
                    entry.pop_front();
                } else {
                    break;
                }
            }
            if entry.len() >= limit as usize {
                let retry_after = entry
                    .front()
                    .map(|oldest| {
                        WINDOW_SECS.saturating_sub(now.duration_since(*oldest).as_secs())
                            + 1
                    })
                    .unwrap_or(WINDOW_SECS);
                Err(retry_after)
            } else {
                entry.push_back(now);
                Ok(())
            }
        };

        // Bound memory against spoofed-IP floods (same shape as the gateway).
        if admitted.is_ok() && self.hits.len() > MAX_TRACKED_KEYS {
            self.hits.retain(|_, q| {
                q.back()
                    .map(|last| now.duration_since(*last) < WINDOW)
                    .unwrap_or(false)
            });
        }
        admitted
    }
}

type SharedWindows = std::sync::Arc<SlidingWindows>;

/// Cloneable per-bucket limiter configuration handed to `Scope::wrap`.
#[derive(Clone)]
pub struct RateLimit {
    windows: SharedWindows,
    bucket: Bucket,
    limit: u32,
}

impl RateLimit {
    /// A limiter counting `limits.<bucket>_per_minute` hits per client IP over
    /// a 60-second sliding window.
    pub fn new(limits: &RateLimits, bucket: Bucket) -> Self {
        Self {
            windows: std::sync::Arc::new(SlidingWindows::new()),
            bucket,
            limit: limits.limit_for(bucket),
        }
    }

    fn admit(&self, ip: IpAddr) -> Result<(), u64> {
        self.windows.check(ip, self.bucket, self.limit)
    }
}

/// Actix transform applying one bucket's sliding window to a route scope.
/// Requests without a peer address (the `test::init_service` harness) share a
/// single `"unattributed"` bucket instead of erroring — extraction can never
/// fail open OR 500.
#[derive(Clone)]
pub struct RateLimitFilter {
    inner: RateLimit,
}

impl RateLimitFilter {
    pub fn new(inner: RateLimit) -> Self {
        Self { inner }
    }
}

impl<S, B> Transform<S, ServiceRequest> for RateLimitFilter
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type InitError = ();
    type Transform = RateLimitMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ok(RateLimitMiddleware {
            service,
            filter: self.clone(),
        })
    }
}

pub struct RateLimitMiddleware<S> {
    service: S,
    filter: RateLimitFilter,
}

impl<S, B> Service<ServiceRequest> for RateLimitMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<EitherBody<B>>;
    type Error = Error;
    type Future =
        Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

    forward_ready!(service);

    fn call(&self, req: ServiceRequest) -> Self::Future {
        // Same keying as the gateway: client IP when known; when no peer
        // address exists (the `test::init_service` harness / exotic sockets)
        // all such traffic shares ONE sentinel bucket rather than bypassing.
        let ip = req
            .peer_addr()
            .map(|a| a.ip())
            .unwrap_or_else(|| IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, 9)));
        match self.filter.inner.admit(ip) {
            Ok(()) => {
                let fut = self.service.call(req);
                Box::pin(async move {
                    fut.await.map(|res| res.map_into_left_body())
                })
            }
            Err(retry_after_s) => {
                log::info!("rate limit exceeded for {ip} (429, retry in {retry_after_s}s)");
                let body = serde_json::json!({
                    "error": "RATE_LIMITED",
                    "retry_after_s": retry_after_s,
                });
                let res = HttpResponse::TooManyRequests()
                    .insert_header((RETRY_AFTER, HeaderValue::from(retry_after_s)))
                    .json(body);
                let res = req.into_response(res).map_into_right_body();
                Box::pin(async move { Ok(res) })
            }
        }
    }
}
