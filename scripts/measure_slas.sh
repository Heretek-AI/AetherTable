#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# measure_slas.sh — honest SLA latency measurement for AetherTable
#
# Makes the GOALS.md latency SLAs measurable again (they were removed from
# docs as unverifiable because nothing measured them):
#
#   rules engine   < 10 ms    POST :8088/api/v1/actions/check
#   spatial+cover  < 15 ms    POST :8088/api/v1/spatial/los + /spatial/path
#   intent parsing < 150 ms   POST :8000/api/v1/intent/classify
#   SSE start      <= 1200 ms time-to-first-token on :8000/api/v1/narrative/stream
#                  (GOALS declares a 500-1200 ms window; only the upper bound
#                   is enforced — faster can never be a violation)
#
# Honesty contract:
#   * Every number is a REAL network round-trip against live services.
#     Nothing is simulated. If a service is unreachable its row is printed
#     as "WITHHELD (service unreachable)".
#   * Client-side timing includes HTTP transport overhead, so every target
#     gets a documented +5ms allowance on top of the GOALS.md figure.
#   * Non-200 responses (e.g. HTTP 429 rate limits) are excluded and shown;
#     a category with too few valid samples is withheld, not judged.
#
# NOT part of the default benchmark gate (scripts/run_all_benchmarks.sh).
# Run it explicitly:
#
#   ./scripts/measure_slas.sh                 # 200 calls/category, 1 SSE stream
#   N_CALLS=50 SSE_STREAMS=10 ./scripts/measure_slas.sh
#
# Environment:
#   ENGINE_API_URL   (default http://localhost:8088) — reuses a running engine
#   GATEWAY_API_URL  (default http://localhost:8000) — reuses a running gateway
#   AUTH_SECRET      shared HMAC secret (dev default pinned below)
#   VTT_ACTION_RATE  engine action-scope requests/min. The DEFAULT engine
#                    limit is 120/min which a 200-call measurement exceeds,
#                    so when THIS SCRIPT starts the engine it raises the
#                    limit to 10000/min (measurement-only; never touches a
#                    reused engine). If you reuse an externally-started
#                    engine with default limits, expect 429 exclusions.
# ---------------------------------------------------------------------------
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_URL="${ENGINE_API_URL:-http://localhost:8088}"
GATEWAY_URL="${GATEWAY_API_URL:-http://localhost:8000}"
N_CALLS="${N_CALLS:-200}"
SSE_STREAMS="${SSE_STREAMS:-1}"
export ENGINE_API_URL="$ENGINE_URL"
export GATEWAY_API_URL="$GATEWAY_URL"

# The engine fails closed without a shared HMAC secret. Pin one for local
# runs so the engine and this probe's signer agree.
export AUTH_SECRET="${AUTH_SECRET:-aethertable-dev-secret}"

ENGINE_PID=""
GATEWAY_PID=""
cleanup() {
  [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null || true
  [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

engine_up() { curl -sf -m 2 "$ENGINE_URL/health" > /dev/null 2>&1; }
gateway_up() { curl -sf -m 2 "$GATEWAY_URL/health" > /dev/null 2>&1; }

echo "================================================================="
echo "  AETHERTABLE SLA MEASUREMENT (real network round-trips only)"
echo "================================================================="
echo "Engine target : $ENGINE_URL"
echo "Gateway target: $GATEWAY_URL"
echo ""

echo "[1/3] Ensuring live services..."
if engine_up; then
  echo "      Engine already running at $ENGINE_URL (reusing as-is)."
else
  echo "      Building and starting vtt-server on :8088 ..."
  cargo build -p vtt-server --quiet
  # Measurement-only rate-limit raise: default 120 action req/min cannot
  # sustain N=200 measured calls within one window.
  RUST_LOG=warn VTT_ACTION_RATE="${VTT_ACTION_RATE:-10000}" \
    "$REPO_ROOT/target/debug/vtt-server" > /tmp/vtt-sla-engine.log 2>&1 &
  ENGINE_PID=$!
  for _ in $(seq 1 40); do engine_up && break; sleep 0.25; done
  if ! engine_up; then
    echo "      ERROR: engine failed to start — see /tmp/vtt-sla-engine.log"
    exit 1
  fi
  echo "      Engine live (pid $ENGINE_PID)."
fi

if gateway_up; then
  echo "      Gateway already running at $GATEWAY_URL (reusing as-is)."
else
  echo "      Starting Python orchestrator gateway on :8000 ..."
  (cd "$REPO_ROOT/python" && PYTHONPATH="$REPO_ROOT/python" python3 -m vtt_orchestrator.server \
    > /tmp/vtt-sla-gateway.log 2>&1) &
  GATEWAY_PID=$!
  for _ in $(seq 1 60); do gateway_up && break; sleep 0.5; done
  if ! gateway_up; then
    echo "      ERROR: gateway failed to start — see /tmp/vtt-sla-gateway.log"
    exit 1
  fi
  echo "      Gateway live (pid $GATEWAY_PID)."
fi

echo ""
echo "[2/3] Driving $N_CALLS measured calls per category (+$SSE_STREAMS SSE stream(s))..."
echo ""
echo "[3/3] SLA report"
echo ""
set +e
N_CALLS="$N_CALLS" SSE_STREAMS="$SSE_STREAMS" \
PYTHONPATH="$REPO_ROOT/python" python3 -m vtt_orchestrator.playtest.sla_measurement
STATUS=$?
set -e

echo ""
if [ "$STATUS" -ne 0 ]; then
  echo "================================================================="
  echo "  SLA MEASUREMENT FAILED (see FAIL rows above; WITHHELD rows do"
  echo "  not fail the run but mean that SLA is currently unverifiable)"
  echo "================================================================="
else
  echo "================================================================="
  echo "  ALL MEASURED SLAS PASSED (withheld rows = unverifiable now)"
  echo "================================================================="
fi
exit "$STATUS"
