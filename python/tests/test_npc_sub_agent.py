"""Tests for Pillar 5 NPC sub-agents: Concordia entity-component pattern.

Covers MemoryComponent bounds/recall, GoalsComponent priority selection,
SocialNormsComponent violations blocking even LLM output, LinguisticStyle
shaping of the deterministic fallback, disposition integration, and honest
"generator" markers ("llm" vs "template").
"""

import asyncio
from typing import Any, Dict, List, Optional

from vtt_orchestrator.agents.npc_sub_agent import (
    ConcordiaNPC,
    EpisodicMemory,
    Goal,
    GoalsComponent,
    LinguisticStyleComponent,
    MemoryComponent,
    SocialNorm,
    SocialNormsComponent,
)
from vtt_orchestrator.simulation.npc_disposition import NpcDispositionEngine


def _run(coro):
    return asyncio.run(coro)


def _cult_keeper(**overrides) -> ConcordiaNPC:
    """Canonical example persona: a cult keeper with a hard secrecy taboo."""
    kwargs = dict(
        npc_id="cult_keeper",
        name="Marrow",
        role="Keeper of the Sunken Shrine",
        memory=MemoryComponent(capacity=4),
        goals=GoalsComponent(
            [
                Goal(
                    description="Guard the Sunken Shrine",
                    priority=10,
                    satisfied_when=lambda ctx: bool(ctx.get("shrine_secured")),
                    feasible_when=lambda ctx: ctx.get("threat_level", 0) < 8,
                ),
                Goal(
                    description="Recruit worthy converts",
                    priority=5,
                    satisfied_when=lambda ctx: bool(ctx.get("convert_secured")),
                ),
                Goal(
                    description="Escape alive",
                    priority=1,
                ),
            ]
        ),
        norms=SocialNormsComponent(
            [
                SocialNorm.taboo(
                    forbidden_terms=["the drowned sigil", "blood rite"],
                    reason="never reveal cult secrets",
                ),
            ]
        ),
        style=LinguisticStyleComponent(
            formality=0.8,
            verbosity=0.7,
            signature_phrases=("The tide remembers.",),
            tone="sepulchral",
        ),
    )
    kwargs.update(overrides)
    return ConcordiaNPC(**kwargs)


class FakeLLMGateway:
    """Stands in for LLMStreamingGateway.complete_json."""

    def __init__(self, payload: Optional[Dict[str, Any]] = None, calls: Optional[List] = None):
        self.payload = payload
        self.calls = calls if calls is not None else []

    async def complete_json(self, system_prompt, user_prompt, **kwargs):
        self.calls.append({"system": system_prompt, "user": user_prompt})
        return self.payload


# --------------------------------------------------------------------------- #
# MemoryComponent
# --------------------------------------------------------------------------- #

def test_memory_is_bounded_dropping_oldest():
    memory = MemoryComponent(capacity=3)
    for i in range(5):
        memory.record(who=f"p{i}", what=f"event {i}", when=float(i))

    episodes = memory.all()
    assert len(episodes) == 3
    assert [e.what for e in episodes] == ["event 2", "event 3", "event 4"]
    assert all(isinstance(e, EpisodicMemory) for e in episodes)


def test_memory_recall_filters_by_relevance_and_recency():
    memory = MemoryComponent(capacity=10)
    memory.record("kira", "asked about the dragon hoard", when=0.0, stance_at_time="neutral")
    memory.record("thom", "haggled over rope prices", when=1.0, stance_at_time="friendly")
    memory.record("kira", "threatened the dragon again with fire", when=2.0, stance_at_time="unfriendly")

    hits = memory.recall("dragon")
    assert [e.what for e in hits] == [
        "threatened the dragon again with fire",
        "asked about the dragon hoard",
    ]
    assert hits[0].stance_at_time == "unfriendly"


def test_memory_recall_returns_empty_on_no_match():
    memory = MemoryComponent()
    memory.record("kira", "talked about bread", when=0.0)
    assert memory.recall("necromancy") == []


def test_respond_to_records_episodic_memory_of_exchange():
    npc = _cult_keeper()
    before = len(npc.memory.all())
    _run(npc.respond_to("kira", "Where is the shrine entrance?", disposition_stance="wary"))
    episodes = npc.memory.all()
    assert len(episodes) >= before + 2
    assert any("shrine entrance" in e.what for e in episodes)
    assert any(e.who == "cult_keeper" for e in episodes)


# --------------------------------------------------------------------------- #
# GoalsComponent
# --------------------------------------------------------------------------- #

def test_goal_selection_orders_by_priority_and_feasibility():
    goals = GoalsComponent(
        [
            Goal("low", priority=1),
            Goal("high-but-infeasible", priority=10, feasible_when=lambda ctx: False),
            Goal("high-and-feasible", priority=9),
        ]
    )
    current = goals.current_goal({})
    assert current.description == "high-and-feasible"


def test_goal_selection_skips_satisfied_goals_via_predicate():
    goals = GoalsComponent(
        [
            Goal("done already", priority=10, satisfied_when=lambda ctx: True),
            Goal("still open", priority=5),
        ]
    )
    assert goals.current_goal({}).description == "still open"


def test_goal_selection_falls_back_when_all_infeasible():
    goals = GoalsComponent([Goal("impossible", priority=9, feasible_when=lambda ctx: False)])
    fallback = goals.current_goal({})
    assert fallback.satisfied_when({}) is False  # synthetic survival goal never pre-satisfied


# --------------------------------------------------------------------------- #
# SocialNormsComponent
# --------------------------------------------------------------------------- #

def test_norm_violation_returns_reason():
    npc = _cult_keeper()
    reason = npc.norms.violates(
        "The drowned sigil is carved beneath the altar.", {}
    )
    assert reason == "never reveal cult secrets"


def test_norms_allow_compliant_reply():
    npc = _cult_keeper()
    assert npc.norms.violates("Nothing of interest lies beneath this ruin.", {}) is None


def test_norm_violation_blocks_even_llm_reply():
    leaking = FakeLLMGateway({"reply": "Whisper it thrice: the blood rite opens the gate."})
    npc = _cult_keeper(llm_gateway=leaking)

    result = _run(npc.respond_to("kira", "Tell me the ritual.", disposition_stance="curious"))

    assert result["generator"] != "llm"
    assert result["generator"] == "template"
    assert "blood rite" not in result["reply"]
    assert "never reveal cult secrets" in result["norm_rejected"]


# --------------------------------------------------------------------------- #
# Deterministic template fallback
# --------------------------------------------------------------------------- #

def test_template_fallback_shape_and_generator_marker():
    npc = _cult_keeper()  # no gateway passed at all
    result = _run(npc.respond_to("kira", "Hello there.", disposition_stance="neutral"))

    assert set(result) >= {"npc_id", "player_id", "reply", "generator", "stance", "goal"}
    assert result["npc_id"] == "cult_keeper"
    assert result["player_id"] == "kira"
    assert result["generator"] == "template"
    assert result["stance"] == "neutral"
    assert isinstance(result["reply"], str) and result["reply"].strip()


def test_template_fallback_reflects_stance():
    npc = _cult_keeper()
    hostile = _run(npc.respond_to("kira", "Speak!", disposition_stance="hostile"))
    allied = _run(npc.respond_to("kira", "Speak!", disposition_stance="allied"))

    assert hostile["reply"] != allied["reply"]
    assert hostile["stance"] == "hostile"
    assert allied["stance"] == "allied"


def test_template_fallback_carries_style_signature():
    npc = _cult_keeper()
    result = _run(npc.respond_to("kira", "Who are you?", disposition_stance="neutral"))
    assert "The tide remembers." in result["reply"]


def test_template_fallback_is_deterministic_across_runs():
    npc_a = _cult_keeper()
    npc_b = _cult_keeper()
    one = _run(npc_a.respond_to("kira", "What do you guard?", disposition_stance="friendly"))
    two = _run(npc_b.respond_to("kira", "What do you guard?", disposition_stance="friendly"))
    assert one["reply"] == two["reply"]
    assert one["generator"] == "template"


# --------------------------------------------------------------------------- #
# LLM path
# --------------------------------------------------------------------------- #

def test_mocked_llm_path_returns_parsed_reply_with_generator_llm():
    gateway = FakeLLMGateway({"reply": "The shrine sleeps beneath black water, traveler."})
    npc = _cult_keeper(llm_gateway=gateway)

    result = _run(
        npc.respond_to("kira", "Where does the shrine lie?", disposition_stance="curious")
    )

    assert result["generator"] == "llm"
    assert result["reply"] == "The shrine sleeps beneath black water, traveler."
    assert "norm_rejected" not in result

    # Persona prompt was structured from all four components + stance
    system = gateway.calls[0]["system"]
    assert "Guard the Sunken Shrine" in system          # goals component
    assert "never reveal cult secrets" in system        # social norms component
    assert "formality" in system or "register:" in system   # linguistic style component
    assert "Memory" in system                           # memory section header
    assert "curious" in gateway.calls[0]["user"]        # stance reaches the model


def test_llm_failure_falls_back_to_template():
    npc = _cult_keeper(llm_gateway=FakeLLMGateway(None))  # complete_json -> None
    result = _run(npc.respond_to("kira", "Well?", disposition_stance="hostile"))
    assert result["generator"] == "template"


# --------------------------------------------------------------------------- #
# Disposition integration
# --------------------------------------------------------------------------- #

def test_apply_outcome_records_on_disposition_engine():
    engine = NpcDispositionEngine(clock=lambda: 0.0)
    npc = _cult_keeper(disposition_engine=engine)

    npc.apply_outcome("aided", player_id="kira")
    assert engine.disposition("cult_keeper", "kira") > 0.0
    assert engine.history()[0].kind == "aided"

    npc.apply_outcome("betrayed", player_id="kira")
    assert engine.disposition("cult_keeper", "kira") < 0.0
