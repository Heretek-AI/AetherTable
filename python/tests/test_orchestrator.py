import pytest
from vtt_orchestrator.routing.intent_router import IntentClassificationRouter
from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager
from vtt_orchestrator.auditor.inspector import PreCommitAuditorAgent, DiagnosticRetryController
from vtt_orchestrator.agents.agent_hierarchy import DirectorAgent, EncounterDMAgent, ConcordiaNPCComponent
from vtt_orchestrator.simulation.faction_simulation import FactionSimulationGOAP
from vtt_orchestrator.simulation.spotlight_tracker import VoiceSpotlightTracker
from vtt_orchestrator.simulation.safety_gateway import SafetyGateway
from vtt_orchestrator.ingestion.pdf_parser import AstPdfCompendiumParser
from vtt_orchestrator.ingestion.vtt_bundle_bridge import VttBundleBridge
from vtt_orchestrator.playtest.synthetic_playtest import SyntheticPlaytestRunner
from vtt_orchestrator.schemas.models import LoreAssertionPayload, EpistemicTier


def test_intent_router_classification():
    router = IntentClassificationRouter()

    res_mech = router.classify_utterance("I cast Fireball at the goblins")
    assert res_mech.intent_type.value == "MECHANICAL_INVOCATION"
    assert res_mech.latency_ms < 150.0

    res_safety = router.classify_utterance("X-Card on this scene")
    assert res_safety.intent_type.value == "SAFETY_INTERVENTION"

    res_ooc = router.classify_utterance("Pass the pizza please")
    assert res_ooc.intent_type.value == "OUT_OF_CHARACTER"


def test_epistemic_graph_and_paradox_detection():
    graph = EpistemicLoreGraphManager()

    # Baron Vane is marked DECEASED in graph
    passed, reason, lat = graph.query_paradox("NPC_Baron_Vane", "SPEAKS_WITH", "PC_Thorin")
    assert not passed
    assert "DECEASED" in reason
    assert lat < 40.0

    # Valid assertion
    assertion = LoreAssertionPayload(
        proposing_entity_id="player_1",
        subject_node_id="NPC_Blacksmith_Goran",
        predicate_relation="KNOWS_ABOUT",
        object_node_id="Location_Keep",
        confidence_score=0.7,
        epistemic_tier=EpistemicTier.PROPOSED_FACT,
        context_sentence="I ask the blacksmith about the keep",
    )
    commit_res = graph.submit_assertion(assertion)
    assert commit_res["status"] == "STAGED"


def test_pre_commit_auditor_lethality_contradiction():
    auditor = PreCommitAuditorAgent()

    # Target survived with 12 HP, but DM draft claims decapitated / dead
    report = auditor.audit_proposal(
        turn_index=1,
        entity_id="orc_warlord",
        proposed_narrative="I swing my sword, decapitating the orc and leaving him dead on the floor!",
        engine_execution_payload={
            "target_hp_remaining": 12,
            "target_is_conscious": True,
            "target_is_dead": False,
        },
        active_entity_count=3,
        previous_entity_count=3,
        ingress_verified_count=0,
        egress_verified_count=0,
    )

    assert not report.passed
    assert len(report.failures) == 1
    assert report.failures[0].violation_type.value == "MATH_NARRATIVE_CONTRADICTION"


def test_diagnostic_retry_controller():
    auditor = PreCommitAuditorAgent()
    dm = EncounterDMAgent()
    controller = DiagnosticRetryController(auditor, max_retries=2)

    engine_payload = {
        "action_name": "Greataxe Attack",
        "is_hit": True,
        "total_damage": 8,
        "target_hp_remaining": 14,
        "target_is_conscious": True,
        "target_is_dead": False,
    }

    # Turn draft that complies with rules
    result = controller.run_turn_cycle(
        user_intent="I strike the guard",
        turn_index=1,
        entity_id="pc_fighter",
        engine_execution_payload=engine_payload,
        dm_draft_generator=lambda ctx: dm.generate_combat_draft("I strike the guard", engine_payload, ctx),
        active_entity_count=2,
        previous_entity_count=2,
        ingress_count=0,
        egress_count=0,
    )

    assert result["status"] == "COMMITTED"
    assert not result["fallback_used"]


def test_spotlight_tracker_and_safety_rewind():
    tracker = VoiceSpotlightTracker(["p1", "p2", "p3"])
    tracker.record_utterance("p1", 60.0)
    tracker.record_utterance("p2", 40.0)
    tracker.record_utterance("p3", 2.0)

    sidelined = tracker.get_sidelined_players(threshold_ratio=0.10)
    assert "p3" in sidelined

    gateway = SafetyGateway()
    safety_res = gateway.trigger_x_card("p3", "spiders", current_sequence_id=45)
    assert safety_res["status"] == "SAFETY_INTERVENTION_ACTIVATED"
    assert safety_res["target_sequence_id"] == 44


def test_synthetic_playtest_benchmark():
    runner = SyntheticPlaytestRunner(num_turns=50)
    report = runner.run_simulation()
    assert report["total_turns_simulated"] == 50
    assert report["mechanical_compliance_rate_pct"] >= 90.0
    assert report["hallucination_continuity_index"] >= 0.85
