"""Honest SLA latency measurement against LIVE AetherTable services.

Re-introduces measurability for the GOALS.md latency SLAs that the
docs-honesty iteration removed as unverifiable:

    * rules engine  < 10 ms   (POST {engine}/api/v1/actions/check)
    * spatial+cover < 15 ms   (POST {engine}/api/v1/spatial/los, /spatial/path)
    * intent parse  < 150 ms  (POST {gateway}/api/v1/intent/classify)
    * SSE start     500-1200 ms time-to-first-token
                              (POST {gateway}/api/v1/narrative/stream)

Honesty contract (non-negotiable):

1. Every number is a REAL network round-trip against a live service, timed
   client-side around a pooled keep-alive HTTP session. Nothing here is
   simulated, extrapolated or replayed from cache.
2. If a service cannot be reached, that row is WITHHELD ("service
   unreachable") — never filled with synthetic numbers.
3. Client-side timing necessarily includes HTTP transport overhead (socket
   write, kernel queueing, response read). Each declared threshold therefore
   gets a documented +5 ms transport allowance on top of the GOALS.md figure.
4. Non-200 responses are not valid SLA samples. They are excluded and
   reported; if rate limiting or errors exclude so many calls that fewer
   than MIN_VALID_SAMPLES remain, the row is withheld rather than judged on
   a rump sample.
5. The SSE first-token row reports whether the stream ran in live-LLM mode
   or honest-degradation fallback, because the two measure different things
   (remote model latency vs local deterministic narration).

This harness deliberately lives OUTSIDE scripts/run_all_benchmarks.sh so it
is not part of the default benchmark gate yet. Invoke it via
``scripts/measure_slas.sh``.
"""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import httpx

#: Client-side timing includes HTTP transport; thresholds get this allowance.
TRANSPORT_ALLOWANCE_MS = 5.0

#: Below this many valid samples a category is withheld rather than judged.
MIN_VALID_SAMPLES = 30

#: GOALS.md declared SLAs (milliseconds). ``sse_first_token`` encodes only the
#: upper bound of the declared 500-1200 ms window: faster first tokens can
#: never be an SLA violation, so enforcing the lower bound would be dishonest.
SLA_TARGETS_MS: Dict[str, float] = {
    "rules_engine": 10.0,
    "spatial_los": 15.0,
    "spatial_path": 15.0,
    "intent_parsing": 150.0,
    "sse_first_token": 1200.0,
}

ENGINE_URL = os.environ.get("ENGINE_API_URL", "http://localhost:8088")
GATEWAY_URL = os.environ.get("GATEWAY_API_URL", "http://localhost:8000")


# --------------------------------------------------------------------------
# Token minting (same HMAC scheme as routing/engine_client.py)
# --------------------------------------------------------------------------

def service_token(secret: str) -> str:
    """HMAC session token for the engine's zero-trust middleware."""
    import base64
    import hashlib
    import hmac as hmac_mod

    payload = json.dumps(
        {"user_id": "sla-probe", "exp": time.time() + 600},
        separators=(",", ":"),
    ).encode()
    sig = hmac_mod.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(payload).decode() + "." + sig


def _engine_secret() -> str:
    return os.environ.get("VTT_ENGINE_SECRET", os.environ.get("AUTH_SECRET", "")) or \
        "aethertable-dev-secret"


# --------------------------------------------------------------------------
# Measurement primitives
# --------------------------------------------------------------------------

@dataclass
class Measurement:
    """Raw outcome of one measured category."""

    samples_ms: List[float] = field(default_factory=list)
    excluded: List[str] = field(default_factory=list)  # e.g. "HTTP 429 x14"
    unreachable: bool = False
    notes: List[str] = field(default_factory=list)
    extra: Dict[str, Any] = field(default_factory=dict)

    @property
    def n_valid(self) -> int:
        return len(self.samples_ms)

    def percentile(self, pct: float) -> Optional[float]:
        if not self.samples_ms:
            return None
        ordered = sorted(self.samples_ms)
        idx = max(0, math.ceil(pct / 100.0 * len(ordered)) - 1)
        return ordered[min(idx, len(ordered) - 1)]


def _service_up(client: httpx.Client, url: str) -> bool:
    try:
        resp = client.get(f"{url}/health", timeout=3.0)
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


def measure_calls(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    json_body: Optional[Dict[str, Any]] = None,
    n: int = 200,
) -> Measurement:
    """Drive ``n`` real round-trips, timing each with perf_counter_ns."""
    m = Measurement()
    excluded_counts: Dict[int, int] = {}
    errors = 0
    for _ in range(n):
        try:
            start = time.perf_counter_ns()
            resp = client.request(method, url, headers=headers, json=json_body)
            elapsed_ms = (time.perf_counter_ns() - start) / 1e6
        except httpx.HTTPError:
            errors += 1
            continue
        if resp.status_code == 200:
            m.samples_ms.append(elapsed_ms)
        else:
            excluded_counts[resp.status_code] = excluded_counts.get(resp.status_code, 0) + 1
    m.excluded = [f"HTTP {code} x{count}" for code, count in sorted(excluded_counts.items())]
    if errors:
        m.excluded.append(f"connection errors x{errors}")
    return m


def measure_sse_first_token(
    client: httpx.Client,
    url: str,
    json_body: Dict[str, Any],
) -> Measurement:
    """One real streaming call; times socket-send to FIRST SSE data frame.

    Also records whether the stream opened in live-LLM mode or honest
    degradation (the gateway emits a leading {"degraded": true} frame when it
    falls back to deterministic narration).
    """
    m = Measurement()
    degraded_reason: Optional[str] = None
    ttft_ms: Optional[float] = None
    status_code: Optional[int] = None
    try:
        start = time.perf_counter_ns()
        with client.stream("POST", url, json=json_body, timeout=30.0) as resp:
            status_code = resp.status_code
            if resp.status_code != 200:
                m.notes.append(f"stream returned HTTP {resp.status_code}")
                m.excluded.append(f"HTTP {resp.status_code} x1")
                return m
            for line in resp.iter_lines():
                if not line.startswith("data: "):
                    continue
                if ttft_ms is None:
                    ttft_ms = (time.perf_counter_ns() - start) / 1e6
                frame = json.loads(line[len("data: "):])
                if frame.get("degraded") and degraded_reason is None:
                    degraded_reason = frame.get("reason", "unknown")
                if frame.get("done"):
                    break
    except httpx.HTTPError as exc:
        m.notes.append(f"stream error: {exc.__class__.__name__}")
        m.excluded.append("connection error x1")
        return m

    if ttft_ms is None:
        # Stream completed without ever yielding a data frame — nothing to
        # report, and inventing a number would defeat the point.
        m.notes.append("no data frame received before stream end")
        m.excluded.append("no-first-token x1")
        return m

    m.samples_ms.append(ttft_ms)
    if degraded_reason is not None:
        m.notes.append(f"degraded LLM fallback ({degraded_reason})")
        m.extra["llm_mode"] = "degraded_fallback"
    else:
        m.extra["llm_mode"] = "live_llm"
    return m


# --------------------------------------------------------------------------
# Request payloads (realistic shapes; ids-only where the trust boundary
# demands it — no client-supplied bonuses cross into these calls)
# --------------------------------------------------------------------------

def check_payload() -> Dict[str, Any]:
    return {"modifier": 3, "dc": 15, "cost_margin": 2}


def _grid_cells(size: int) -> Tuple[List[List[int]], List[List[int]]]:
    """A sparse wall pattern plus difficult terrain over a size x size grid."""
    solid = [[x, y] for y in range(4, size - 4, 6) for x in range(2, size - 2, 9)]
    terrain = [[x, y] for y in range(5, size - 5, 7) for x in range(3, size - 3, 11)]
    return solid, terrain


def los_payload(size: int = 32) -> Dict[str, Any]:
    solid, _ = _grid_cells(size)
    return {
        "attacker_pos": {"x": 1.5, "y": 0.0, "z": 1.5},
        "target_pos": {"x": float(size - 1.5), "y": 0.0, "z": float(size - 1.5)},
        "target_radius": 0.5,
        "grid_width": size,
        "grid_height": size,
        "solid_cells": solid,
    }


def path_payload(size: int = 32) -> Dict[str, Any]:
    solid, terrain = _grid_cells(size)
    return {
        "start": {"x": 1.5, "y": 0.0, "z": 1.5},
        "end": {"x": float(size - 1.5), "y": 0.0, "z": float(size - 1.5)},
        "speed_budget": 120.0,
        "grid_width": size,
        "grid_height": size,
        "solid_cells": solid,
        "difficult_terrain": terrain,
    }


CLASSIFY_UTTERANCE = "I attack the goblin with my longsword"


# --------------------------------------------------------------------------
# Verdicts & reporting
# --------------------------------------------------------------------------

@dataclass
class RowVerdict:
    category: str
    endpoint: str
    target_label: str
    p50: Optional[float]
    p95: Optional[float]
    max_ms: Optional[float]
    n_valid: int
    verdict: str          # PASS | FAIL | WITHHELD
    detail: str = ""


def judge(category: str, endpoint: str, m: Measurement) -> RowVerdict:
    target = SLA_TARGETS_MS[category]
    effective = target + TRANSPORT_ALLOWANCE_MS
    target_label = f"<={target:g}ms(+{TRANSPORT_ALLOWANCE_MS:g}ms)"

    if m.unreachable:
        return RowVerdict(category, endpoint, target_label, None, None, None, 0,
                          "WITHHELD", "service unreachable")

    excluded_note = "; ".join(m.excluded) if m.excluded else ""
    if m.n_valid == 0:
        reason = excluded_note or "no successful responses"
        return RowVerdict(category, endpoint, target_label, None, None, None, 0,
                          "WITHHELD", reason)

    if m.n_valid < MIN_VALID_SAMPLES and category != "sse_first_token":
        # SSE intentionally runs few streams; every other category needs a
        # meaningful sample before a percentile verdict means anything.
        return RowVerdict(category, endpoint, target_label,
                          m.percentile(50), m.percentile(95), max(m.samples_ms),
                          m.n_valid, "WITHHELD",
                          f"only {m.n_valid} valid samples"
                          + (f" ({excluded_note})" if excluded_note else ""))

    p95 = m.percentile(95)
    assert p95 is not None
    verdict = "PASS" if p95 <= effective else "FAIL"
    detail_parts = []
    if excluded_note:
        detail_parts.append(f"excluded: {excluded_note}")
    for note in m.notes:
        detail_parts.append(note)
    return RowVerdict(category, endpoint, target_label,
                      m.percentile(50), p95, max(m.samples_ms),
                      m.n_valid, verdict, "; ".join(detail_parts))


def print_report(rows: Sequence[RowVerdict]) -> bool:
    header = (
        f"{'Category':<18} {'Endpoint':<42} {'N':>5} "
        f"{'p50':>10} {'p95':>10} {'max':>10} {'Target':<16} Verdict"
    )
    print(header)
    print("-" * len(header))
    all_pass = True
    any_judged = False
    for r in rows:
        def fmt(v: Optional[float]) -> str:
            return f"{v:.2f}ms" if v is not None else "-"
        print(
            f"{r.category:<18} {r.endpoint:<42} {r.n_valid:>5} "
            f"{fmt(r.p50):>10} {fmt(r.p95):>10} {fmt(r.max_ms):>10} "
            f"{r.target_label:<16} {r.verdict}"
            + (f" ({r.detail})" if r.detail else "")
        )
        if r.verdict == "FAIL":
            all_pass = False
        if r.verdict in ("PASS", "FAIL"):
            any_judged = True
    print()
    print(f"Honesty notes:")
    print(f"  * timings are real network round-trips (keep-alive pooled session),")
    print(f"    so thresholds carry a documented +{TRANSPORT_ALLOWANCE_MS:g}ms client-side")
    print(f"    HTTP transport allowance on top of each GOALS.md figure.")
    print(f"  * rows marked WITHHELD were not measurable (unreachable service or")
    print(f"    too few valid samples); they are never filled with simulated data.")
    if not any_judged:
        print()
        print("NO CATEGORY COULD BE MEASURED — nothing passed or failed.")
        return False
    return all_pass


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def run_measurement(n_calls: int = 200, sse_streams: int = 1) -> List[RowVerdict]:
    engine_auth = {"Authorization": f"Bearer {service_token(_engine_secret())}"}
    limits = httpx.Limits(max_connections=4, max_keepalive_connections=4)

    rows: List[RowVerdict] = []

    # ---- Rules engine SLA -------------------------------------------------
    with httpx.Client(base_url=ENGINE_URL, limits=limits) as engine:
        if _service_up(engine, ""):
            m = measure_calls(engine, "POST", "/api/v1/actions/check",
                              headers=engine_auth, json_body=check_payload(), n=n_calls)
            rows.append(judge("rules_engine", "POST :8088/api/v1/actions/check", m))

            # ---- Spatial SLA ----------------------------------------------
            m_los = measure_calls(engine, "POST", "/api/v1/spatial/los",
                                  headers=engine_auth, json_body=los_payload(), n=n_calls)
            rows.append(judge("spatial_los", "POST :8088/api/v1/spatial/los", m_los))

            m_path = measure_calls(engine, "POST", "/api/v1/spatial/path",
                                   headers=engine_auth, json_body=path_payload(), n=n_calls)
            rows.append(judge("spatial_path", "POST :8088/api/v1/spatial/path", m_path))
        else:
            for cat, ep in (("rules_engine", "POST :8088/api/v1/actions/check"),
                            ("spatial_los", "POST :8088/api/v1/spatial/los"),
                            ("spatial_path", "POST :8088/api/v1/spatial/path")):
                rows.append(RowVerdict(cat, ep, "", None, None, None, 0,
                                       "WITHHELD", "service unreachable"))

    # ---- Intent parsing SLA ----------------------------------------------
    with httpx.Client(base_url=GATEWAY_URL, limits=limits) as gateway:
        gateway_up = _service_up(gateway, "")
        if gateway_up:
            m_intent = measure_calls(
                gateway, "POST", "/api/v1/intent/classify",
                json_body={"utterance": CLASSIFY_UTTERANCE, "speaker_id": "player"},
                n=n_calls,
            )
            rows.append(judge("intent_parsing", "POST :8000/api/v1/intent/classify", m_intent))
        else:
            rows.append(RowVerdict("intent_parsing", "POST :8000/api/v1/intent/classify",
                                   "", None, None, None, 0, "WITHHELD", "service unreachable"))

        # ---- SSE time-to-first-token ------------------------------------
        stream_body: Dict[str, Any] = {
            "user_intent": CLASSIFY_UTTERANCE,
            "turn_index": 1,
            "entity_id": "pc_thorin",
            "engine_execution_payload": {"action_name": "Longsword", "is_hit": True,
                                         "total_damage": 7},
        }
        if gateway_up:
            m_sse = Measurement()
            for _ in range(sse_streams):
                one = measure_sse_first_token(
                    gateway, "/api/v1/narrative/stream", stream_body
                )
                m_sse.samples_ms.extend(one.samples_ms)
                m_sse.excluded.extend(one.excluded)
                m_sse.notes.extend(one.notes)
                m_sse.extra.update(one.extra)
            rows.append(judge("sse_first_token",
                              f"POST :8000/api/v1/narrative/stream (x{sse_streams})", m_sse))
        else:
            rows.append(RowVerdict("sse_first_token",
                                   f"POST :8000/api/v1/narrative/stream (x{sse_streams})",
                                   "", None, None, None, 0, "WITHHELD", "service unreachable"))

    return rows


def main(argv: Optional[Sequence[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Measure GOALS.md SLA latencies against live services.")
    parser.add_argument("--calls", type=int,
                        default=int(os.environ.get("N_CALLS", "200")),
                        help="measured calls per category (default 200)")
    parser.add_argument("--sse-streams", type=int,
                        default=int(os.environ.get("SSE_STREAMS", "1")),
                        help="number of SSE streams for time-to-first-token (default 1)")
    args = parser.parse_args(argv)

    rows = run_measurement(n_calls=args.calls, sse_streams=args.sse_streams)
    return 0 if print_report(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
