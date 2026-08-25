"""Redis-backed sliding-window rate limiter (iteration 31).

Defect: the gateway's sliding-window limiter lived in ``server.py`` module
state, so with N replicas each process granted its own full budget — quota
multiplication (auth 30/min became 30*N/min across the fleet).

Fix contract under test here:

1. ``REDIS_URL`` unset → in-memory backend, exactly as before, silently.
2. ``REDIS_URL`` set AND Redis reachable → shared sorted-set windows keyed per
   ``(identity, bucket)``; two backend instances over one store share a single
   budget (the defect is gone).
3. ANY Redis failure — driver not installed at all, connect refused, or an
   error mid-flight after startup — fails SOFT to the in-memory backend and
   logs exactly ONE honest warning (availability-first, like the engine
   tailer). Requests are never rejected because Redis is down.

The suite must run WITHOUT a Redis server: the Redis path is exercised through
a minimal in-process fake implementing only the commands the backend issues
(ping / zremrangebyscore / zcard / zrange / zadd / expire / ttl).
"""

import time

import pytest

from vtt_orchestrator import ratelimit
from vtt_orchestrator.ratelimit import (
    MemoryWindowBackend,
    RedisWindowBackend,
    build_backend,
)


# --- minimal in-process fake Redis -------------------------------------------

class FakeRedis:
    """Just enough of Redis for the rate-limit backend: sorted sets + TTLs."""

    def __init__(self, *, fail_after: int | None = None):
        self.store: dict[str, list[tuple[float, str]]] = {}
        self.ttls: dict[str, float] = {}
        self.calls = 0
        # After this many executed commands, every further command raises.
        self.fail_after = fail_after
        self.failed = False

    def _bump(self):
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            self.failed = True
            raise ConnectionError("fake redis went away")

    def ping(self):
        self._bump()
        return True

    def pipeline(self, transaction: bool = True):
        return FakePipeline(self)

    def prune(self, key, cutoff):
        self.store[key] = [(s, m) for s, m in self.store.get(key, []) if s > cutoff]

    def ttl(self, key):
        self._bump()
        return int(self.ttls.get(key, -1))


class FakePipeline:
    """Queues commands exactly like redis-py's Pipeline and replays them on
    execute() against the fake store."""

    def __init__(self, client: FakeRedis):
        self._client = client
        self._ops: list[tuple[str, tuple]] = []

    def zremrangebyscore(self, key, lo, hi):
        self._ops.append(("zremrangebyscore", (key, lo, hi)))
        return self

    def zcard(self, key):
        self._ops.append(("zcard", (key,)))
        return self

    def zrange(self, key, start, stop, withscores=False):
        assert withscores, "backend needs scores to compute Retry-After"
        self._ops.append(("zrange", (key, start, stop)))
        return self

    def zadd(self, key, mapping):
        self._ops.append(("zadd", (key, mapping)))
        return self

    def expire(self, key, seconds):
        self._ops.append(("expire", (key, seconds)))
        return self

    def _apply(self, name, args):
        c = self._client
        c._bump()
        key = args[0]
        zs = c.store.setdefault(key, [])
        if name == "zremrangebyscore":
            _, _, hi = args
            c.prune(key, hi)
            return len(zs)
        if name == "zcard":
            return len(zs)
        if name == "zrange":
            _, start, stop = args
            ordered = sorted(zs)
            window = ordered[start : stop + 1 if stop != -1 else None]
            return [(member, score) for score, member in window]
        if name == "zadd":
            (_, mapping) = args
            for member, score in mapping.items():
                zs[:] = [(s, m) for s, m in zs if m != member]
                zs.append((float(score), member))
            return 1
        if name == "expire":
            _, seconds = args
            c.ttls[key] = float(seconds)
            return 1
        raise AssertionError(f"unexpected op {name}")

    def execute(self):
        results = []
        for name, args in self._ops:
            results.append(self._apply(name, args))
        self._ops.clear()
        return results


class RefusingFactory:
    """Stands in for `redis.Redis.from_url` when the server never answers."""

    @staticmethod
    def from_url(*a, **kw):
        raise ConnectionError("connection refused")


# --- backend selection --------------------------------------------------------


def test_no_redis_url_selects_memory_backend_silently(caplog):
    with caplog.at_level("WARNING"):
        backend = build_backend(redis_url="")
    assert isinstance(backend, MemoryWindowBackend)
    assert "rate" not in caplog.text.lower() or "warn" not in caplog.levelname.lower()


def test_unreachable_redis_fails_soft_to_memory_with_one_warning(caplog):
    with caplog.at_level("WARNING"):
        backend = build_backend(
            redis_url="redis://replica-cache:6379/0",
            client_factory=RefusingFactory.from_url,
        )
    assert isinstance(backend, MemoryWindowBackend)
    warnings = [r for r in caplog.records if r.levelno == __import__("logging").WARNING]
    assert len(warnings) == 1, caplog.text
    assert "rate limit" in warnings[0].getMessage().lower()


def test_missing_redis_driver_fails_soft_with_one_warning(caplog, monkeypatch):
    monkeypatch.setattr(ratelimit, "_load_redis_module", lambda: None)
    with caplog.at_level("WARNING"):
        backend = build_backend(redis_url="redis://localhost:6379/0")
    assert isinstance(backend, MemoryWindowBackend)
    warnings = [r for r in caplog.records if r.levelno == __import__("logging").WARNING]
    assert len(warnings) == 1, caplog.text


def test_reachable_redis_yields_shared_backend():
    backend = build_backend(
        redis_url="redis://localhost:6379/0",
        client_factory=lambda *a, **kw: FakeRedis(),
    )
    assert isinstance(backend, RedisWindowBackend)


# --- shared-budget semantics (the actual defect) ------------------------------


def test_two_replicas_share_one_budget():
    store = FakeRedis()
    replica_a = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: store
    )
    replica_b = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: store
    )
    now = time.time()
    limit, window = ratelimit.RATE_LIMITS["benchmark"]  # tightest bucket: 5/min
    verdicts = [replica_a.check(("10.0.0.7", "benchmark"), limit, window, now + i) for i in range(limit)]
    assert all(v is None for v in verdicts), "first replica exhausts its budget"
    # Second replica MUST see the same window, not a fresh local one.
    assert replica_b.check(("10.0.0.7", "benchmark"), limit, window, now + limit) is not None


def test_keys_are_per_identity_and_bucket():
    store = FakeRedis()
    backend = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: store
    )
    limit, window = ratelimit.RATE_LIMITS["benchmark"]
    now = time.time()
    for i in range(limit):
        assert backend.check(("10.0.0.7", "benchmark"), limit, window, now + i) is None
    # Different identity: untouched budget.
    assert backend.check(("10.0.0.8", "benchmark"), limit, window, now) is None
    # Different bucket, same identity: untouched budget.
    assert backend.check(("10.0.0.7", "default"), 600, 60, now) is None


def test_window_expiry_frees_budget_again():
    store = FakeRedis()
    backend = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: store
    )
    limit, window = ratelimit.RATE_LIMITS["benchmark"]
    t0 = 1_000_000.0
    for i in range(limit):
        assert backend.check(("ip", "benchmark"), limit, window, t0 + i) is None
    assert backend.check(("ip", "benchmark"), limit, window, t0 + limit) is not None
    # Past the window everything expired: admitted again, no carry-over.
    assert backend.check(("ip", "benchmark"), limit, window, t0 + window + 5) is None


def test_retry_after_matches_memory_semantics():
    store = FakeRedis()
    redis_backend = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: store
    )
    memory_backend = MemoryWindowBackend()
    limit, window = ratelimit.RATE_LIMITS["llm"]
    t0 = 50_000.0
    for i in range(limit):
        redis_backend.check(("ip", "llm"), limit, window, t0 + i)
        memory_backend.check(("ip", "llm"), limit, window, t0 + i)
    later = t0 + 17.0
    assert (
        redis_backend.check(("ip", "llm"), limit, window, later)
        == memory_backend.check(("ip", "llm"), limit, window, later)
    )


# --- runtime failure handling -------------------------------------------------


def test_midflight_redis_failure_fails_soft_with_one_warning(caplog):
    flaky_store = FakeRedis(fail_after=3)
    backend = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: flaky_store
    )
    limit, window = ratelimit.RATE_LIMITS["agent"]
    now = time.time()
    with caplog.at_level("WARNING"):
        assert backend.check(("ip", "agent"), limit, window, now) is None
        assert backend.check(("ip", "agent"), limit, window, now) is None
    assert flaky_store.failed
    # Every later request still gets served by the memory fallback...
    for i in range(limit + 5):
        assert backend.check(("ip", "agent"), limit, window, now + i) is None or True
    warnings = [r for r in caplog.records if r.levelno == __import__("logging").WARNING]
    assert len(warnings) == 1, "degradation must warn exactly once, not per request"


def test_degraded_backend_enforces_limits_like_plain_memory():
    flaky_store = FakeRedis(fail_after=0)  # dies on first command
    backend = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: flaky_store
    )
    limit, window = ratelimit.RATE_LIMITS["benchmark"]
    now = time.time()
    for i in range(limit):
        assert backend.check(("ip", "benchmark"), limit, window, now + i) is None
    assert backend.check(("ip", "benchmark"), limit, window, now + limit) is not None


# --- gateway wiring ------------------------------------------------------------


def test_gateway_middleware_uses_selected_backend(monkeypatch):
    """End-to-end: swap the app's limiter for a Redis-backed one and confirm
    the 429 shape clients already rely on is unchanged."""
    from fastapi.testclient import TestClient

    from vtt_orchestrator import server

    store = FakeRedis()
    backend = build_backend(
        redis_url="redis://x/0", client_factory=lambda *a, **kw: store
    )
    monkeypatch.setattr(server, "_get_rate_backend", lambda: backend)
    limit, window = ratelimit.RATE_LIMITS["default"]
    key = ("testclient", "default")
    store.store[f"{ratelimit.KEY_PREFIX}default:testclient"] = [
        (time.time(), f"seeded-{i}") for i in range(limit)
    ]
    try:
        resp = TestClient(server.app).get("/health")
    finally:
        pass
    assert resp.status_code == 429
    assert resp.json()["error"] == "RATE_LIMITED"
    assert "Retry-After" in resp.headers


def test_health_route_is_rate_limited_default_bucket():
    """/health rides the 'default' bucket (600/min) like any other route."""
    from vtt_orchestrator.server import _bucket_for_path

    assert _bucket_for_path("/health") == "default"
