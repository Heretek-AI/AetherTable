"""Sliding-window rate limiting backends for the gateway (iteration 31).

Defect fixed here: the gateway's limiter was process-local state in
``server.py``, so a deployment running N replicas granted each replica its own
full budget — quota multiplication (auth 30/min became 30*N/min fleet-wide).

Contract:

* ``REDIS_URL`` set AND Redis reachable → ``RedisWindowBackend``: sorted-set
  sliding windows keyed per ``(identity, bucket)`` under one shared namespace,
  so every replica draws from the SAME budget.
* ANY Redis failure — the driver is not installed at all, connect refused at
  startup, or an error mid-flight — fails SOFT to ``MemoryWindowBackend`` with
  exactly ONE honest warning. Availability-first, like the engine tailer: a
  rate-limit cache outage must never take the gateway's endpoints down with
  it; it only costs the deployment its cross-replica accounting.
* Bucket limits and the key identity scheme are unchanged either way.

No new hard dependency: ``redis`` is imported lazily via :func:`_load_redis_module`
and deployments without it keep the in-memory backend forever.
"""

from __future__ import annotations

import logging
import math
import time as _time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

_logger = logging.getLogger("aethertable.ratelimit")

#: Bucket -> (max_events, window_seconds). Mirrored verbatim from the
#: pre-refactor table in server.py — semantics MUST NOT change here.
RATE_LIMITS: Dict[str, Tuple[int, int]] = {
    "auth": (30, 60),
    "agent": (60, 60),
    # LLM-spend routes (classify / orchestrator turns / narrative streams):
    # every hit can cost model tokens, so the cap sits below the agent bucket
    # — a player mashing "narrate" must not mint a model bill.
    "llm": (30, 60),
    # Diffusion images (POST /api/v1/media/image): each accepted call holds
    # the shared GPU through up-to-8 SD-Turbo steps. Tightest of the
    # always-on buckets so one seat cannot starve the table's media budget.
    "media": (10, 60),
    # Spoken narration (POST /api/v1/media/narrate): same TTS spend as speech
    # but with a much longer per-call script allowance, so it meters in its
    # own bucket just below llm — table storytelling must not crowd short UI
    # speech prompts out of the shared llm budget, and vice versa.
    "narration": (20, 60),
    # Empirical benchmark: each accepted call runs 10-1000 encounter
    # simulations in-process. Tightest cap of all.
    "benchmark": (5, 60),
    "default": (600, 60),
}

#: Namespace for the Redis keys so a shared cache never collides with other
#: services' data. Keys look like ``vtt:rl:<bucket>:<identity>``.
KEY_PREFIX = "vtt:rl:"

#: Hard cap on tracked keys (memory backend) so spoofed-source floods cannot
#: grow the table without bound. Mirrors MAX_TRACKED_KEYS in the Rust twin.
DEFAULT_MAX_TRACKED_KEYS = 100_000
STALE_KEY_SWEEP_FACTOR = 2.0

#: Connect/ping timeout for the startup probe; a slow-but-alive Redis must not
#: hang gateway startup.
PROBE_TIMEOUT_SECONDS = 2.0


def _load_redis_module():
    """Import redis lazily; None when the driver is not installed."""
    try:
        import redis  # noqa: PLC0415 — optional dependency by design

        return redis
    except ImportError:
        return None


class MemoryWindowBackend:
    """The original in-process sliding window, unchanged in behavior.

    Kept byte-for-byte compatible with what server.py did before: ``windows``
    maps ``(identity, bucket)`` -> list of hit timestamps and is exposed so the
    test harness (conftest) can reset it between tests.
    """

    def __init__(
        self,
        *,
        max_keys_provider: Optional[Callable[[], int]] = None,
        stale_factor: float = STALE_KEY_SWEEP_FACTOR,
    ):
        self.windows: Dict[Tuple[str, str], List[float]] = {}
        self._max_keys = max_keys_provider or (lambda: DEFAULT_MAX_TRACKED_KEYS)
        self._stale_factor = stale_factor

    def check(
        self, key: Tuple[str, str], limit: int, window: float, now: float
    ) -> Optional[int]:
        """Record one hit unless the window is full.

        Returns None when admitted, otherwise the Retry-After seconds.
        """
        hits = [t for t in self.windows.get(key, []) if now - t < window]
        if len(hits) >= limit:
            return max(1, int(window - (now - hits[0])) + 1)
        hits.append(now)
        self.windows[key] = hits
        if len(self.windows) > self._max_keys():
            self.sweep_stale_keys(now)
        return None

    def sweep_stale_keys(self, now: float) -> None:
        """Drop entries whose hits all predate the staleness bound (they can no
        longer affect any verdict)."""
        stale = [
            key
            for key, hits in self.windows.items()
            if not hits
            or now - max(hits) > self._stale_factor * RATE_LIMITS[key[1]][1]
        ]
        for key in stale:
            self.windows.pop(key, None)


class RedisWindowBackend:
    """Cross-replica sliding window backed by Redis sorted sets.

    Each window is one ZSET per ``(identity, bucket)``: members are unique hit
    tokens, scores are hit timestamps. Admission prunes expired members, counts
    the survivors, and only then records the hit — mirroring the memory
    backend's "rejected attempts do not consume budget" semantics.

    Any Redis error degrades permanently to the injected fallback (the
    gateway's shared :class:`MemoryWindowBackend`) after ONE warning.
    """

    def __init__(self, client: Any, fallback: MemoryWindowBackend):
        self._client = client
        self._fallback = fallback
        self._degraded = False

    def check(
        self, key: Tuple[str, str], limit: int, window: float, now: float
    ) -> Optional[int]:
        if self._degraded:
            return self._fallback.check(key, limit, window, now)
        identity, bucket = key
        redis_key = f"{KEY_PREFIX}{bucket}:{identity}"
        try:
            return self._check_redis(redis_key, limit, window, now)
        except Exception as exc:
            self._degraded = True
            _logger.warning(
                "Rate limiter: Redis unavailable (%s); failing soft to the "
                "in-process limiter. Limits stay enforced per-replica until "
                "Redis returns.",
                exc,
            )
            return self._fallback.check(key, limit, window, now)

    def _check_redis(self, redis_key: str, limit: int, window: float, now: float):
        cutoff = now - window
        pipe = self._client.pipeline(transaction=True)
        pipe.zremrangebyscore(redis_key, "-inf", cutoff)
        pipe.zcard(redis_key)
        pipe.zrange(redis_key, 0, 0, withscores=True)
        _, live_count, oldest = pipe.execute()
        if live_count >= limit:
            retry_after = (
                max(1, int(window - (now - float(oldest[0][1]))) + 1)
                if oldest
                else int(window)
            )
            return retry_after
        member = f"{now:.6f}:{uuid.uuid4().hex}"
        write = self._client.pipeline(transaction=True)
        write.zadd(redis_key, {member: now})
        write.expire(redis_key, max(1, math.ceil(window)))
        write.execute()
        return None


def build_backend(
    redis_url: Optional[str] = None,
    *,
    client_factory: Optional[Callable[..., Any]] = None,
    fallback: Optional[MemoryWindowBackend] = None,
    probe_timeout: float = PROBE_TIMEOUT_SECONDS,
) -> Any:
    """Choose the limiter backend.

    Selection order:
      1. ``redis_url`` empty → memory backend, silently (the default path;
         CI and single-node dev never touch Redis).
      2. Driver missing OR connect/ping fails → memory backend + ONE warning.
      3. Otherwise → RedisWindowBackend over the live connection, degrading to
         ``fallback`` (or a fresh memory backend) on later errors.
    """
    fallback = fallback or MemoryWindowBackend()
    if not redis_url:
        return fallback

    if client_factory is None:
        redis_module = _load_redis_module()
        if redis_module is None:
            _logger.warning(
                "Rate limiter: REDIS_URL is set but the redis package is not "
                "installed; using the in-process limiter (per-replica budgets)."
            )
            return fallback
        factory = redis_module.Redis.from_url
    else:
        # Injected connection source (tests, embedders): no driver needed.
        factory = client_factory
    try:
        client = factory(redis_url, socket_connect_timeout=probe_timeout)
        client.ping()
    except Exception as exc:
        _logger.warning(
            "Rate limiter: REDIS_URL unreachable (%s); using the in-process "
            "limiter (per-replica budgets).",
            exc,
        )
        return fallback
    return RedisWindowBackend(client, fallback)


def monotonic_now() -> float:
    """Wall-clock timestamp used for window bookkeeping (kept behind a shim so
    tests can freeze time uniformly)."""
    return _time.time()
