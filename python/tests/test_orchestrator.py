import pytest
import json
import time
from fastapi.testclient import TestClient

from vtt_orchestrator.routing.intent_router import IntentClassificationRouter
from vtt_orchestrator.routing.llm_client import LLMStreamingGateway, LLMConfig
from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager
from vtt_orchestrator.auditor.inspector import PreCommitAuditorAgent, DiagnosticRetryController
from vtt_orchestrator.agents.agent_hierarchy import EncounterDMAgent, DirectorAgent
from vtt_orchestrator.simulation.spotlight_tracker import VoiceSpotlightTracker
from vtt_orchestrator.simulation.safety_gateway import SafetyGateway
from vtt_orchestrator.playtest.synthetic_playtest import SyntheticPlaytestRunner
from vtt_orchestrator.schemas.models import IntentType, EpistemicTier, LoreAssertionPayload
from vtt_orchestrator.server import _sign_token, app


def _gm_headers() -> dict:
    """Valid gm HMAC token for the now-authenticated gateway routes."""
    return {
        "Authorization": "Bearer "
        + _sign_token(
            {"user_id": "usr_orch_gm", "role": "gm", "exp": time.time() + 600}
        )
    }


def test_intent_router_classification():
    router = IntentClassificationRouter()
    
    # 1. Mechanical action
    res1 = router.classify_utterance("I attack the orc with my greataxe")
    assert res1.intent_type == IntentType.MECHANICAL_INVOCATION
    assert res1.latency_ms < 150.0

    # 2. Lore assertion
    res2 = router.classify_utterance("The ancient keep of Oakhaven was destroyed in the Second Age.")
    assert res2.intent_type == IntentType.LORE_ASSERTION

    # 3. In-character dialogue
    res3 = router.classify_utterance('"Yield now, monster, or face the fury of Moradin!"')
    assert res3.intent_type == IntentType.IN_CHARACTER_DIALOGUE

    # 4. Safety intervention
    res4 = router.classify_utterance("X-Card on torture and blood gore")
    assert res4.intent_type == IntentType.SAFETY_INTERVENTION


def test_epistemic_graph_and_paradox_detection():
    manager = EpistemicLoreGraphManager()
    
    # Submit Valid Proposition (PROPOSED_FACT gets status STAGED)
    assertion1 = LoreAssertionPayload(
        proposing_entity_id="player_01",
        epistemic_tier=EpistemicTier.PROPOSED_FACT,
        subject_node_id="PC_Thorin",
        predicate_relation="ALLIED_WITH",
        object_node_id="Faction_Dwarves",
        confidence_score=0.7,
        context_sentence="Thorin is allied with the mountain clan.",
    )
    res1 = manager.submit_assertion(assertion1)
    assert res1["status"] in ["COMMITTED", "STAGED"]
    assert res1["assigned_weight"] == 0.7

    # Submit Direct Paradox (Trying to assert deceased NPC_Baron_Vane RULES)
    assertion2 = LoreAssertionPayload(
        proposing_entity_id="player_02",
        epistemic_tier=EpistemicTier.PROPOSED_FACT,
        subject_node_id="NPC_Baron_Vane",
        predicate_relation="RULES",
        object_node_id="Location_Keep",
        confidence_score=0.7,
        context_sentence="Baron Aldous Vane currently rules the keep.",
    )
    res2 = manager.submit_assertion(assertion2)
    assert res2["status"] == "REJECTED_PARADOX"


def test_pre_commit_auditor_lethality_contradiction():
    auditor = PreCommitAuditorAgent()
    
    # Engine says enemy has 12 HP left, but DM generates "Thorin decapitates and kills him instantly"
    engine_payload = {
        "action_name": "Greataxe Slash",
        "is_hit": True,
        "total_damage": 8,
        "target_hp_remaining": 12,
        "target_is_conscious": True,
        "target_is_dead": False,
    }
    contradictory_draft = "Thorin swings his greataxe cleanly through the warlord's neck, instantly decapitating and killing him on the spot."
    
    report = auditor.audit_proposal(
        turn_index=1,
        entity_id="actor_thorin",
        proposed_narrative=contradictory_draft,
        engine_execution_payload=engine_payload,
        active_entity_count=4,
        previous_entity_count=4,
        ingress_verified_count=0,
        egress_verified_count=0,
    )
    
    assert report.passed is False
    assert len(report.failures) > 0
    assert any("Lethality contradiction" in f.diagnostic_message or "lethal trauma" in f.diagnostic_message for f in report.failures)


def test_diagnostic_retry_controller():
    auditor = PreCommitAuditorAgent()
    controller = DiagnosticRetryController(auditor=auditor, max_retries=2)
    dm = EncounterDMAgent()
    
    engine_payload = {
        "action_name": "Fireball",
        "is_hit": True,
        "total_damage": 28,
        "target_hp_remaining": 0,
        "target_is_conscious": False,
        "target_is_dead": True,
    }
    
    cycle_result = controller.run_turn_cycle(
        user_intent="I cast Fireball at the goblin cluster",
        turn_index=2,
        entity_id="actor_lyra",
        engine_execution_payload=engine_payload,
        dm_draft_generator=lambda ctx: dm.generate_combat_draft("I cast Fireball at the goblin cluster", engine_payload, ctx),
        active_entity_count=3,
        previous_entity_count=4,
        ingress_count=0,
        egress_count=1,
    )
    
    assert cycle_result["status"] == "COMMITTED"
    assert "final_narrative" in cycle_result


def test_spotlight_tracker_and_safety_rewind():
    tracker = VoiceSpotlightTracker(player_ids=["Thorin", "Lyra", "Gimli"])
    
    tracker.record_utterance("Thorin", 45.0)
    tracker.record_utterance("Lyra", 40.0)
    tracker.record_utterance("Gimli", 5.0)
    
    weights = tracker.calculate_agency_weights()
    assert weights["Thorin"] > 0.4
    assert weights["Gimli"] < 0.15
    
    sidelined = tracker.get_sidelined_players()
    assert "Gimli" in sidelined

    gateway = SafetyGateway()
    xcard_res = gateway.trigger_x_card("Gimli", "Claustrophobia", current_sequence_id=14)
    assert xcard_res["status"] == "SAFETY_INTERVENTION_ACTIVATED"
    assert xcard_res["target_sequence_id"] == 13


def test_synthetic_playtest_benchmark():
    """The harness must never fabricate a passing score.

    - With no engine reachable: metrics are None and targets fail honestly.
    - With a live engine: metrics derive from REAL accept/reject decisions,
      the trust-boundary probes must be fully rejected, and SLA targets hold.
    """
    runner = SyntheticPlaytestRunner(num_turns=50)
    report = runner.run_simulation()

    if not report.get("engine_live"):
        assert report["mechanical_compliance_rate_pct"] is None
        for target in report["targets_met"].values():
            assert target is False
        return

    # Live path: numbers come from adjudicated outcomes only.
    assert report["standard_mechanical_requests"] > 0
    assert (
        report["standard_accepted_by_engine"]
        <= report["standard_mechanical_requests"]
    )
    assert (
        report["trust_probes_rejected_by_engine"]
        == report["trust_boundary_probes"]
    ), "every forged/chaos probe must be rejected by the trust boundary"
    assert report["audited_narrative_proposals"] > 0

    assert report["mechanical_compliance_rate_pct"] >= 98.5
    assert report["hallucination_continuity_index"] >= 0.95
    assert report["auditor_false_positive_rate_pct"] <= 1.5


def test_fastapi_server_endpoints():
    client = TestClient(app)

    health_resp = client.get("/health")
    assert health_resp.status_code == 200
    assert health_resp.json()["status"] == "healthy"

    classify_resp = client.post("/api/v1/intent/classify", headers=_gm_headers(), json={"utterance": "I attack with greatsword", "speaker_id": "Thorin"})
    assert classify_resp.status_code == 200
    assert classify_resp.json()["intent_type"] == "MECHANICAL_INVOCATION"

    narrative_resp = client.post("/api/v1/narrative/generate", headers=_gm_headers(), json={
        "user_intent": "I strike with greataxe",
        "turn_index": 1,
        "entity_id": "pc_thorin",
        "engine_execution_payload": {
            "action_name": "Greataxe Strike",
            "is_hit": True,
            "total_damage": 11,
            "target_hp_remaining": 15,
            "target_is_conscious": True,
            "target_is_dead": False
        },
        "active_entity_count": 4,
        "previous_entity_count": 4,
        "ingress_count": 0,
        "egress_count": 0
    })
    assert narrative_resp.status_code == 200
    assert narrative_resp.json()["status"] == "COMMITTED"

    sim_resp = client.post("/api/v1/simulation/tick", headers=_gm_headers())
    assert sim_resp.status_code == 200
    assert "actions_executed" in sim_resp.json()


@pytest.mark.asyncio
async def test_llm_streaming_gateway():
    gateway = LLMStreamingGateway(LLMConfig())
    collected_tokens = []
    async for chunk in gateway.stream_narrative("I cast Fireball", {"action_name": "Fireball", "is_hit": True, "total_damage": 28}):
        if isinstance(chunk, tuple):
            # Honest-degradation sentinel ("__DEGRADED__", reason) — mock mode
            # has no upstream key, so the fallback marker leads the stream.
            continue
        if chunk.startswith("data: "):
            parsed = json.loads(chunk[6:].strip())
            if not parsed.get("done"):
                collected_tokens.append(parsed.get("token"))

    full_narrative = "".join(collected_tokens)
    assert len(full_narrative) > 0
    assert "Fireball" in full_narrative or "damage" in full_narrative


def test_fastapi_sse_stream_endpoint():
    client = TestClient(app)
    response = client.post("/api/v1/narrative/stream", headers=_gm_headers(), json={
        "user_intent": "I strike with greataxe",
        "engine_execution_payload": {
            "action_name": "Greataxe Slash",
            "is_hit": True,
            "total_damage": 12
        }
    })
    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]
    assert "data:" in response.text
