"""LIVE campaign-sim end-to-end test (opt-in, never in CI).

Iteration 98 closes the last live-coverage gap: ``test_live_llm.py`` exercises
the intent classifier and the ConcordiaNPC persona against the real endpoint,
but nothing ran ``CampaignSimulation`` itself end-to-end with REAL model
decisions. This module does exactly that -- one minimal seeded run through the
in-process orchestrator (ASGI transport) while the DECISION legs (combat
prompts via ``build_decision_prompts``, social prompts via
``build_social_prompts``, NPC replies via ``ConcordiaNPC.respond_to``) hit the
real configured endpoint from ``LLM_API`` / ``LLM_KEY`` / ``LLM_MODEL``.

Gated by ``python/tests/conftest.py`` exactly like the rest of the live suite:
skipped unless ``LLM_KEY`` is set AND ``RUN_LIVE_LLM=1``.

What is asserted hard is PROVENANCE HONESTY, never outcome quality:

* ``mode == "llm"`` (the gateway resolved a real endpoint, not mock);
* every turn/exchange carries an honest marker:
    - ``decision_source == "llm"``      -> the model's decision was executed;
    - ``decision_source == "llm_fallback"`` with a non-empty
      ``fallback_reason``               -> the upstream degraded FOR THAT TURN
      and the deterministic scripted policy stepped in;
    - both are acceptable; what is NOT acceptable is a fabricated marker --
      e.g. ``llm_calls_made`` counting turns that never consulted the model,
      or a fallback whose ``fallback_reason`` is empty;
* totals reconcile exactly with the per-turn records (pure accounting);
* the NPC reply markers match observable reality: a ``reply_generator ==
  "llm"`` exchange must carry a non-empty reply body, and a template reply is
  only tolerated when the player utterance that prompted it was itself a
  scripted fallback (the sim deliberately pins ``llm_gateway=None`` there) or
  the upstream was genuinely unreachable.

Run:
    set -a; source .env; set +a
    RUN_LIVE_LLM=1 PYTHONPATH=python pytest python/tests/test_live_campaign_sim.py -v
"""

import copy
import json
import os
import re
import time
import uuid

import httpx
import pytest

from vtt_orchestrator.agents.npc_sub_agent import ConcordiaNPC
from vtt_orchestrator.routing import engine_client, llm_client as llm_client_module
from vtt_orchestrator.routing.engine_client import _coerce_uuid
from vtt_orchestrator.routing.llm_client import LLMConfig, LLMStreamingGateway
from vtt_orchestrator.server import app
from vtt_orchestrator.simulation.campaign_sim import (
    SOCIAL_APPROACHES,
    CampaignSimulation,
)


SOCIAL_NPC_ID = str(_coerce_uuid("sim-training-dummy"))

#: The whole run makes at most players x rounds x 2 decision calls plus the
#: same again for NPC replies (2 x 2 x 2 x 2 = 16 worst case here) at the
#: gateway's own ~8 s timeout apiece. This soft budget only exists to catch a
#: HUNG endpoint, not a merely slow one.
RUN_LATENCY_BUDGET_S = 300.0


@pytest.fixture()
def fake_engine(monkeypatch, tmp_path):
    """In-memory stand-in for the authoritative Rust engine.

    The live gate here is the LLM ENDPOINT only. The engine is a deterministic
    local dependency (cargo run -p vtt-server) that is NOT part of what this
    test verifies, and requiring the operator to have it running would make
    the live run fail for an unrelated infrastructure reason -- so it is faked
    exactly like ``test_campaign_sim.py``'s harness (a minimal subset of the
    engine routes the sim actually drives: sessions, entities, session-state,
    attack/move/check). The LLM decision legs stay 100% real.
    """

    class _FakeEngine:
        def __init__(self):
            self.entities = {}

        async def engine_request(self, method, path, payload=None, *, actor=None):
            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/entities", path)
            if method == "POST" and path == "/api/v1/sessions":
                session_id = str(uuid.uuid4())
                self.entities[session_id] = {}
                return {"session_id": session_id, "status": "CREATED"}
            if m:
                entity = dict(payload)
                self.entities.setdefault(m.group(1), {})[entity["id"]] = entity
                return {"status": "SPAWNED", "entity_id": entity["id"]}
            m = re.fullmatch(r"/api/v1/sessions/([^/]+)", path)
            if method == "GET" and m:
                return {
                    "session_id": m.group(1),
                    "entities": copy.deepcopy(self.entities.get(m.group(1), {})),
                }
            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/action/attack", path)
            if m:
                bucket = self.entities[m.group(1)]
                target = bucket.get(payload["target_id"])
                if target is None or target.get("is_dead"):
                    raise engine_client.EngineRejectedError(
                        409, json.dumps({"reason": "TARGET_ALREADY_DEAD"}))
                target["current_hp"] = int(target.get("current_hp", 0)) - 3
                dead = target["current_hp"] <= 0
                target["is_dead"] = dead
                return {
                    "status": "RESOLVED", "action_name": "Strike", "is_hit": True,
                    "total_damage": 3, "target_hp_remaining": max(target["current_hp"], 0),
                    "target_is_dead": dead, "event_sequence": 42,
                }
            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/move", path)
            if m:
                entity = self.entities[m.group(1)].get(payload["entity_id"])
                if entity is None:
                    raise engine_client.EngineRejectedError(
                        409, json.dumps({"reason": "MOVE_REJECTED"}))
                entity["position"] = [payload["x"], payload["y"], 0.0]
                return {"status": "MOVED",
                        "outcome": {"to": {"x": payload["x"], "y": payload["y"]}}}
            if path == "/api/v1/actions/check":
                return {"total": 15, "d20": 13, "modifier": 2,
                        "dc": payload.get("dc"), "success": True}
            raise AssertionError(f"fake engine has no route for {method} {path}")

    fake = _FakeEngine()
    monkeypatch.setattr(engine_client, "engine_request", fake.engine_request)
    return fake


@pytest.mark.live
async def test_live_campaign_sim_two_round_seeded_run_honest_provenance(
    monkeypatch, tmp_path, fake_engine
):
    # Keep run artifacts out of the shared logs/ directory during the test.
    monkeypatch.setattr(
        llm_client_module, "LLM_LOG_PATH", str(tmp_path / "llm_calls.jsonl"))

    config = LLMConfig()
    assert not config.is_mock, (
        "live gate passed (LLM_KEY + RUN_LIVE_LLM=1) yet LLMConfig resolved to "
        "mock mode"
    )
    gateway = LLMStreamingGateway(config)

    npc = ConcordiaNPC(
        npc_id=SOCIAL_NPC_ID,
        name="Marrow",
        role="Keeper of the Sunken Shrine",
        llm_gateway=gateway,
    )

    sim = CampaignSimulation(
        players=2,
        rounds=2,
        llm_gateway=gateway,
        mode="llm",
        transport=httpx.ASGITransport(app=app),
        table_name="Live LLM Sim Table",
        npc_registry={SOCIAL_NPC_ID: npc},
        social_npc_id=SOCIAL_NPC_ID,
        decision_seed=98,
    )

    started = time.perf_counter()
    report = await sim.run()
    elapsed = time.perf_counter() - started
    if elapsed > RUN_LATENCY_BUDGET_S:
        pytest.fail(
            f"live campaign sim took {elapsed:.1f}s, exceeding the "
            f"{RUN_LATENCY_BUDGET_S:.0f}s soft latency budget -- endpoint "
            "appears hung"
        )

    # -- setup really happened --------------------------------------------
    assert report["errors"] == [], (
        f"run aborted mid-flight: {report['errors']}"
    )
    assert report["lobby_id"], "no lobby id -- setup failed silently"
    assert report["engine_session_id"], "no engine session id -- setup failed"

    # -- mode provenance ---------------------------------------------------
    assert report["mode"] == "llm", (
        f"CampaignSimulation reported mode={report['mode']!r}; this suite is "
        "for real-endpoint runs"
    )

    turns = [t for r in report["rounds"] for t in r["turns"]]
    socials = [e for r in report["rounds"] for e in r["social"]]
    assert len(turns) == 4, f"expected 2 players x 2 rounds = 4 turns, got {len(turns)}"
    assert len(socials) == 4, (
        f"expected 2 players x 2 rounds = 4 social exchanges, got {len(socials)}"
    )

    # -- per-turn provenance honesty ----------------------------------------
    llm_turns = [t for t in turns if t["decision_source"] == "llm"]
    fallback_turns = [t for t in turns if t["decision_source"] == "llm_fallback"]
    other_turns = [t for t in turns
                   if t["decision_source"] not in ("llm", "llm_fallback")]
    assert not other_turns, (
        f"unexpected decision sources: {sorted({t['decision_source'] for t in other_turns})}"
    )
    for t in fallback_turns:
        assert t["fallback_reason"], (
            f"{t['player']} round {t['round']}: marked llm_fallback but "
            "fallback_reason is empty -- fabricated provenance"
        )
        assert t["reason"] and "scripted fallback" in str(t["reason"]), (
            f"{t['player']} round {t['round']}: llm_fallback turn's reason does "
            f"not disclose the fallback: {t['reason']!r}"
        )
    print(f"[live] combat turns: {len(llm_turns)} from the model, "
          f"{len(fallback_turns)} honest scripted fallbacks")

    # -- totals reconcile exactly with the observed turns --------------------
    totals = report["totals"]
    expected_calls = len(llm_turns) + len(fallback_turns)
    assert totals["llm_calls_made"] == expected_calls, (
        f"totals.llm_calls_made={totals['llm_calls_made']} but "
        f"{expected_calls} turns actually consulted the model"
    )
    assert totals["llm_decisions_accepted"] == len(llm_turns)
    assert totals["llm_fallbacks"] == len(fallback_turns)
    assert totals["accepted"] + totals["rejected"] <= totals["actions_attempted"]
    assert len(report["rounds"]) == 2

    # -- social exchanges: both halves must be honestly marked ---------------
    for e in socials:
        assert e["decision_source"] in ("llm", "llm_fallback"), (
            f"unexpected social decision_source {e['decision_source']!r}"
        )
        if e["decision_source"] == "llm":
            assert e["approach"] in SOCIAL_APPROACHES
            assert e["utterance"].strip(), (
                "decision_source='llm' but the utterance body is empty"
            )
        else:
            assert e["fallback_reason"], (
                "social exchange marked llm_fallback without a reason -- "
                "fabricated provenance"
            )
        assert e["reply_generator"] in ("llm", "template"), (
            f"unknown reply_generator {e['reply_generator']!r}"
        )
        assert isinstance(e["reply"], str) and e["reply"].strip(), (
            f"{e['player']}: empty reply body from generator="
            f"{e['reply_generator']!r}"
        )
    template_replies = [e for e in socials if e["reply_generator"] == "template"]
    llm_replies = [e for e in socials if e["reply_generator"] == "llm"]

    # A template reply is only honest when the upstream could NOT have served
    # it: either the whole exchange degraded (player utterance was a scripted
    # fallback, so the sim pinned llm_gateway=None), or the endpoint is
    # genuinely down right now. Probe before believing it.
    if template_replies:
        suspect = [e for e in template_replies if e["decision_source"] == "llm"]
        if suspect:
            probe = None
            try:
                probe = await gateway.complete_json(
                    'Reply ONLY with {"ok": true}', "reachability probe")
            except Exception:  # pragma: no cover - complete_json swallows anyway
                probe = None
            if probe is None:
                pytest.skip(
                    "endpoint unreachable/degraded mid-run -- template NPC "
                    "replies are honest degradation; skipping rather than "
                    "failing per live-suite contract"
                )
            pytest.fail(
                f"{len(suspect)} social exchange(s) report reply_generator="
                "'template' while the player utterance came from the model AND "
                "the endpoint answers a fresh probe -- the template marker "
                "does NOT match reality"
            )
        print(f"[live] {len(template_replies)} template replies, all paired "
              "with degraded player halves")

    print(f"[live] social exchanges: {len(llm_replies)} model replies, "
          f"{len(template_replies)} template/honest-degraded replies")
    print(f"[live] disposition interactions: "
          f"{totals['disposition_interactions']} "
          f"({totals['disposition_interactions_by_kind']}), director tension="
          f"{report['director']['tension']}")
