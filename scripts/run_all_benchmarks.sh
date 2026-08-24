#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_URL="${ENGINE_API_URL:-http://localhost:8088}"
ENGINE_PID=""

cleanup() {
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then
    kill "$ENGINE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

engine_up() {
  curl -sf -m 2 "$ENGINE_URL/health" > /dev/null 2>&1
}

echo "================================================================="
echo "  AI-NATIVE VIRTUAL TABLETOP (VTT) PLATFORM BENCHMARK SUITE"
echo "================================================================="

echo ""
echo "[1/4] Running Rust Authoritative Engine & Subsystem Unit Tests..."
cargo test --workspace --quiet

echo ""
echo "[2/4] Ensuring a live authoritative engine for the playtest..."
if engine_up; then
  echo "      Engine already running at $ENGINE_URL."
else
  echo "      Building and starting vtt-server on :8088 ..."
  cargo build -p vtt-server --quiet
  RUST_LOG=warn "$REPO_ROOT/target/debug/vtt-server" > /tmp/vtt-benchmark-engine.log 2>&1 &
  ENGINE_PID=$!
  for _ in $(seq 1 40); do
    engine_up && break
    sleep 0.25
  done
  if ! engine_up; then
    echo "      ERROR: engine failed to start — see /tmp/vtt-benchmark-engine.log"
    exit 1
  fi
  echo "      Engine live (pid $ENGINE_PID)."
fi

echo ""
echo "[3/4] Running Python Multi-Agent & Invariant Auditor Test Suites..."
PYTHONPATH=python python3 -m pytest python/tests -q

echo ""
echo "[4/4] Running Headless Synthetic Multi-Agent Playtest Benchmark (LIVE)..."
set +e
PYTHONPATH=python python3 -c '
from vtt_orchestrator.playtest.synthetic_playtest import SyntheticPlaytestRunner

runner = SyntheticPlaytestRunner(num_turns=200)
report = runner.run_simulation()

turns = report["total_turns_simulated"]
elapsed = report["elapsed_seconds"]
mcr = report["mechanical_compliance_rate_pct"]
hci = report["hallucination_continuity_index"]
afpr = report["auditor_false_positive_rate_pct"]

print("\n--- SYNTHETIC PLAYTEST BENCHMARK RESULTS (live engine) ---")
print(f"Total Turns Simulated: {turns}")
print(f"Execution Elapsed Time: {elapsed:.3f}s")

if not report.get("engine_live"):
    print("Engine unreachable — metrics WITHHELD, never simulated.")
    raise SystemExit(1)

print(f"Standard Actions Adjudicated: {report[\"standard_mechanical_requests\"]}")
print(f"Accepted by Engine:           {report[\"standard_accepted_by_engine\"]}")
print(f"Trust-Boundary Probes:        {report[\"trust_probes_rejected_by_engine\"]}/{report[\"trust_boundary_probes\"]} rejected")
print(f"Audited Narrative Proposals:  {report[\"audited_narrative_proposals\"]}")
print(f"Genuine Invariant Violations: {report[\"genuine_invariant_violations\"]}")
print(f"Mechanical Compliance Rate (MCR): {mcr}% (Target >= 98.5%)")
print(f"Hallucination & Continuity Index (HCI): {hci} (Target >= 0.95)")
print(f"Auditor False-Positive Rate (AFPR): {afpr}% (Target <= 1.5%)")

if all(report["targets_met"].values()):
    print("Benchmark Status: PASSED ALL TARGETS")
else:
    print("Benchmark Status: TARGETS NOT MET")
    raise SystemExit(1)
'
BENCH_STATUS=$?
set -e

if [ "$BENCH_STATUS" -ne 0 ]; then
  echo ""
  echo "================================================================="
  echo "  BENCHMARK SUITE FAILED — see output above"
  echo "================================================================="
  exit 1
fi

echo ""
echo "================================================================="
echo "  ALL BENCHMARKS PASSED (cargo tests, pytest, live synthetic playtest)"
echo "================================================================="
