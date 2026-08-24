"""LIVE LLM integration tests (opt-in, never in CI).

Every test here is marked ``@pytest.mark.live`` and hits the REAL configured
endpoint (``LLM_API`` / ``LLM_KEY`` / ``LLM_MODEL`` from the environment /
.env). The suite is gated by ``python/tests/conftest.py``:

* skipped unless ``LLM_KEY`` is set AND ``RUN_LIVE_LLM=1``, and
* degraded to SKIP (never FAIL) when the endpoint is unreachable or
  persistently unparseable -- "live" means "run when you can", not
  "fail when offline".

What IS asserted hard: internal consistency. When the code reports an LLM
provenance marker (``classifier == "llm"``, ``generator == "llm"``, a parsed
JSON object) that marker must match observable reality; when reality is a
deterministic fallback, the test verifies the fallback was genuinely caused by
an unavailable/degraded upstream -- never silently assumed success.

Run:
    set -a; source .env; set +a
    RUN_LIVE_LLM=1 PYTHONPATH=python pytest python/tests/test_live_llm.py -v
"""

import os
import time

import pytest

from vtt_orchestrator.agents.npc_sub_agent import (
    ConcordiaNPC,
    Goal,
    GoalsComponent,
    LinguisticStyleComponent,
)
from vtt_orchestrator.routing.intent_router import IntentClassificationRouter
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway
from vtt_orchestrator.schemas.models import IntentType


LATENCY_BUDGET_S = 60.0  # soft budget: fail only on hung endpoints


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _gateway() -> LLMStreamingGateway:
    """Fresh gateway bound to the current environment (.env must be sourced)."""
    return LLMStreamingGateway(LLMConfig())


def _skip_if_unreachable(parsed_probe) -> None:
    """Degrade to SKIP when the probe shows the upstream cannot serve us."""
    if parsed_probe is None:
        pytest.skip(
            "live endpoint unreachable or persistently unparseable "
            "(complete_json returned None: mock mode, HTTP error, transport "
            "error, or non-JSON reply) -- degrading to SKIP per live-suite "
            "contract"
        )


async def _probe_endpoint(gateway: LLMStreamingGateway):
    """Minimal round-trip used to distinguish 'endpoint down' from 'bad label'."""
    return await gateway.complete_json(
        'You must reply with ONLY this JSON object and nothing else: {"ok": true}',
        "ping",
    )


def _assert_latency(elapsed_s: float, what: str) -> None:
    if elapsed_s > LATENCY_BUDGET_S:
        pytest.fail(
            f"{what} took {elapsed_s:.1f}s, exceeding the {LATENCY_BUDGET_S:.0f}s "
            "soft latency budget -- endpoint appears hung"
        )


# ---------------------------------------------------------------------------
# classify_with_llm against the real endpoint
# ---------------------------------------------------------------------------

@pytest.mark.live
async def test_live_classify_mechanical_utterance_uses_real_llm(monkeypatch):
    monkeypatch.setenv("VTT_LLM_CLASSIFIER", "1")  # ensure kill switch is off
    router = IntentClassificationRouter()

    started = time.perf_counter()
    result = await router.classify_with_llm("I attack the goblin")
    elapsed = time.perf_counter() - started
    _assert_latency(elapsed, "classify_with_llm('I attack the goblin')")

    if result["classifier"] != "llm":
        # Distinguish "LLM answered something unusable" from "endpoint down".
        _skip_if_unreachable(await _probe_endpoint(router.llm_gateway))

    assert result["classifier"] == "llm", (
        f"expected real-LLM provenance for a clearly mechanical utterance, got "
        f"{result['classifier']!r} (fallback_reason={result['fallback_reason']!r})"
    )
    assert result["intent_type"] is IntentType.MECHANICAL_INVOCATION, (
        f"expected MECHANICAL_INVOCATION, got {result['intent_type']}"
    )
    assert 0.0 <= result["confidence"] <= 1.0


@pytest.mark.live
async def test_live_classify_safety_input(monkeypatch):
    monkeypatch.setenv("VTT_LLM_CLASSIFIER", "1")

    router = IntentClassificationRouter()

    # Canonical x-card phrasing: SAFETY_INTERVENTION must win regardless of
    # which classifier produced it (keyword precedence short-circuits before
    # the network; the LLM path also maps it to safety).
    started = time.perf_counter()
    xcard = await router.classify_with_llm("x-card: that description is harmful, pause the scene")
    _assert_latency(time.perf_counter() - started, "classify_with_llm(x-card)")
    assert xcard["intent_type"] is IntentType.SAFETY_INTERVENTION, (
        f"x-card utterance must classify as SAFETY_INTERVENTION, got "
        f"{xcard['intent_type']} via {xcard['classifier']}"
    )

    # Safety-flavored paraphrase with NO keyword trigger, so the REAL endpoint
    # is actually consulted. We assert honest provenance either way: whatever
    # the model returns must be reported truthfully.
    paraphrase = await router.classify_with_llm(
        "hold on everyone, stop the game -- that content really crossed a line for me"
    )
    if paraphrase["classifier"] == "llm":
        assert isinstance(paraphrase["intent_type"], IntentType)
        assert 0.0 <= paraphrase["confidence"] <= 1.0
        print(f"[live] LLM labeled safety paraphrase as {paraphrase['intent_type']} "
              f"(confidence={paraphrase['confidence']})")
    else:
        _skip_if_unreachable(await _probe_endpoint(router.llm_gateway))
        print(f"[live] safety paraphrase fell back honestly: "
              f"{paraphrase['fallback_reason']!r}")


# ---------------------------------------------------------------------------
# ConcordiaNPC.respond_to with the real gateway
# ---------------------------------------------------------------------------

@pytest.mark.live
async def test_live_concordia_npc_generator_marker_matches_reality():
    gateway = _gateway()
    npc = ConcordiaNPC(
        npc_id="innkeeper_marta",
        name="Marta",
        role="Innkeeper of the Gilded Griffin",
        goals=GoalsComponent([Goal("Keep travelers warm, fed and safe", priority=10)]),
        style=LinguisticStyleComponent(formality=0.6, verbosity=0.6),
        llm_gateway=gateway,
    )

    started = time.perf_counter()
    result = await npc.respond_to(
        "kira", "Marta, is there a room free tonight?", disposition_stance="friendly"
    )
    _assert_latency(time.perf_counter() - started, "ConcordiaNPC.respond_to")

    generator = result["generator"]
    assert generator in {"llm", "template"}, f"unknown generator marker {generator!r}"

    if generator == "llm":
        assert result["reply"].strip(), "generator='llm' but the reply body is empty"
        return

    # generator == "template": verify this is HONEST degradation, not a lie.
    probe = await _probe_endpoint(gateway)
    if probe is None:
        pytest.skip(
            "endpoint unreachable/degraded -- template fallback is honest; "
            "skipping rather than failing per live-suite contract"
        )

    # Endpoint is alive: re-run the exact persona prompts to see whether the
    # upstream genuinely failed to yield a usable, norm-clean reply.
    recalled = npc.memory.recall(
        "Marta, is there a room free tonight?", limit=3
    )
    system_prompt, user_prompt = npc.persona_prompts(
        "kira", "Marta, is there a room free tonight?", "friendly", recalled,
        npc.goals.current_goal({}), {"player_id": "kira"},
    )
    parsed = await gateway.complete_json(system_prompt, user_prompt)
    candidate = parsed.get("reply") if isinstance(parsed, dict) else None
    usable_reply = isinstance(candidate, str) and bool(candidate.strip())
    norm_reason = npc.norms.violates(candidate.strip(), {"player_id": "kira"}) if usable_reply else None

    assert not usable_reply or norm_reason is not None, (
        "generator='template' but the endpoint produced a usable, norm-clean "
        f"reply on re-prompt ({candidate!r}) -- the template marker does NOT "
        "match reality"
    )
    print(f"[live] NPC template fallback verified honest "
          f"(norm_rejected={result.get('norm_rejected')!r})")


# ---------------------------------------------------------------------------
# complete_json strict-JSON contract against the real endpoint
# ---------------------------------------------------------------------------

@pytest.mark.live
async def test_live_complete_json_parses_strict_json_reply():
    gateway = _gateway()
    started = time.perf_counter()
    parsed = await gateway.complete_json(
        "You are a calculator API. Respond ONLY with a single minified JSON "
        "object. No prose, no markdown, no code fences.",
        'Compute 7*6 and respond exactly as {"answer": <integer>}.',
    )
    _assert_latency(time.perf_counter() - started, "complete_json(calculator)")
    _skip_if_unreachable(parsed)

    assert isinstance(parsed, dict), f"expected dict, got {type(parsed).__name__}"
    assert int(parsed.get("answer")) == 42, f"wrong answer parsed: {parsed!r}"
    print(f"[live] complete_json returned {parsed!r}")


# ---------------------------------------------------------------------------
# Soft latency budget (hung-endpoint detector)
# ---------------------------------------------------------------------------

@pytest.mark.live
async def test_live_latency_budget_under_60s():
    gateway = _gateway()
    started = time.perf_counter()
    parsed = await gateway.complete_json(
        'Reply ONLY with {"ok": true}', "latency probe"
    )
    elapsed = time.perf_counter() - started
    _assert_latency(elapsed, "latency probe")
    _skip_if_unreachable(parsed)
    print(f"[live] latency probe completed in {elapsed:.2f}s")


# ---------------------------------------------------------------------------
# Suite self-check: the marker gate itself
# ---------------------------------------------------------------------------

@pytest.mark.live
async def test_live_gate_confirms_real_configuration():
    """Sanity check for operators: proves the run is genuinely live, not mock."""
    config = LLMConfig()
    assert os.environ.get("LLM_KEY"), (
        "RUN_LIVE_LLM=1 without LLM_KEY: conftest gate should have skipped"
    )
    assert not config.is_mock, "LLMConfig resolved to mock mode despite LLM_KEY"
    print(f"[live] endpoint={config.base_url} model={config.model}")
