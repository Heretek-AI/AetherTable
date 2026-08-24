import pytest
from vtt_orchestrator.simulation.npc_disposition import (
    NpcDispositionEngine,
    NpcInteractionRecord,
    KNOWN_INTERACTION_KINDS,
)


def _engine(**overrides):
    defaults = dict(
        trust_half_life=1000.0,
        fear_half_life=200.0,
        stress_half_life=400.0,
        clock=lambda: 0.0,
    )
    defaults.update(overrides)
    return NpcDispositionEngine(**defaults)


def test_unknown_interaction_kind_raises_value_error():
    engine = _engine()
    with pytest.raises(ValueError):
        engine.record_interaction("npc_1", "player_1", "high_fived", timestamp=0.0)

    # All documented kinds are accepted
    for kind in KNOWN_INTERACTION_KINDS:
        e = _engine()
        e.record_interaction("npc_1", "player_1", kind, timestamp=0.0)


def test_initial_disposition_is_neutral():
    engine = _engine()
    assert engine.disposition("goblin_chief", "kira") == 0.0
    assert engine.stance("goblin_chief", "kira") == "neutral"


def test_cooperative_acts_raise_trust_and_hostile_acts_lower_it():
    engine = _engine()

    engine.record_interaction("healer", "kira", "aided", magnitude=1.0, timestamp=0.0)
    after_aid = engine.disposition("healer", "kira")
    assert after_aid > 0.0

    engine.record_interaction("bandit", "thom", "attacked", magnitude=1.0, timestamp=0.0)
    assert engine.disposition("bandit", "thom") < 0.0

    # Betrayal hurts more than being attacked once
    betrayed_engine = _engine()
    betrayed_engine.record_interaction("ally", "kira", "betrayed", magnitude=1.0, timestamp=0.0)
    assert betrayed_engine.disposition("ally", "kira") <= engine.disposition("bandit", "thom")


def test_scores_are_directed_per_pair():
    engine = _engine()
    engine.record_interaction("npc_a", "player_x", "aided", magnitude=3.0, timestamp=0.0)

    # npc_a -> player_x is friendly, reverse direction untouched
    assert engine.disposition("npc_a", "player_x") > 0.0
    assert engine.disposition("player_x", "npc_a") == 0.0
    assert engine.stance("npc_a", "player_x") != engine.stance("player_x", "npc_a")

    # Same NPC tracks players independently
    assert engine.disposition("npc_a", "player_y") == 0.0


def test_magnitude_scales_effect():
    small = _engine()
    large = _engine()
    small.record_interaction("npc", "p", "aided", magnitude=1.0, timestamp=0.0)
    large.record_interaction("npc", "p", "aided", magnitude=3.0, timestamp=0.0)
    assert large.disposition("npc", "p") > small.disposition("npc", "p")


def test_time_decay_toward_zero_with_halving_at_half_life():
    engine = _engine(trust_half_life=100.0, fear_half_life=100.0)
    engine.record_interaction("npc", "p", "gifted", timestamp=0.0)
    initial = engine.disposition("npc", "p", timestamp=0.0)
    assert initial > 0.0

    # One trust half-life later: exactly halved
    assert engine.disposition("npc", "p", timestamp=100.0) == pytest.approx(initial / 2.0)
    # Two half-lives: quarter
    assert engine.disposition("npc", "p", timestamp=200.0) == pytest.approx(initial / 4.0)
    # Long time -> effectively neutral again
    assert abs(engine.disposition("npc", "p", timestamp=5000.0)) < 1.0


def test_fear_decays_faster_than_trust():
    engine = _engine()  # trust_half_life=1000, fear_half_life=200
    engine.record_interaction("npc", "p", "threatened", magnitude=5.0, timestamp=0.0)
    early = engine.components("npc", "p", timestamp=0.0)
    early_score = engine.disposition("npc", "p", timestamp=0.0)

    late = engine.components("npc", "p", timestamp=800.0)
    late_score = engine.disposition("npc", "p", timestamp=800.0)

    # Fraction retained after 800s: fear passed 4 half-lives (~6%), trust under one (~57%)
    assert late["fear"] / early["fear"] == pytest.approx(0.5 ** 4)
    assert late["trust"] / early["trust"] == pytest.approx(0.5 ** 0.8)
    assert late["fear"] / early["fear"] < late["trust"] / early["trust"]

    # Score recovered substantially toward neutral relative to its start
    assert abs(late_score) < abs(early_score)


def test_alignment_bias_shifts_score_as_static_offset():
    engine = _engine()
    engine.set_alignment_bias("paladin", "necromancer_kira", -20.0)
    engine.set_alignment_bias("cleric", "devout_thom", 15.0)

    assert engine.components("paladin", "necromancer_kira")["alignment_bias"] == -20.0
    assert engine.disposition("paladin", "necromancer_kira", timestamp=0.0) == pytest.approx(-20.0)
    assert engine.disposition("cleric", "devout_thom", timestamp=0.0) == pytest.approx(15.0)

    # Bias persists and stacks on top of interaction-driven components
    engine.record_interaction("paladin", "necromancer_kira", "gifted", timestamp=0.0)
    fresh = _engine()
    fresh.record_interaction("paladin", "necromancer_kira", "gifted", timestamp=0.0)
    assert engine.disposition("paladin", "necromancer_kira", timestamp=0.0) == pytest.approx(
        fresh.disposition("paladin", "necromancer_kira") - 20.0
    )


def test_stress_amplifies_fear_effects():
    calm = _engine()
    calm.record_interaction("npc", "p", "threatened", magnitude=2.0, timestamp=0.0)
    calm_score = calm.disposition("npc", "p", timestamp=0.0)

    stressed = _engine()
    stressed.report_stress("npc", 80.0, timestamp=0.0)
    stressed.record_interaction("npc", "p", "threatened", magnitude=2.0, timestamp=0.0)
    stressed_score = stressed.disposition("npc", "p", timestamp=0.0)

    assert stressed_score < calm_score


def test_stress_rises_from_low_hp_and_dead_allies_then_decays():
    engine = _engine(stress_half_life=100.0)
    engine.report_stress("npc", 40.0, timestamp=0.0, reason="hp_low")
    engine.report_stress("npc", 40.0, timestamp=0.0, reason="allies_died")
    assert engine.stress("npc", timestamp=0.0) == pytest.approx(80.0)

    # Stress itself decays with its own half-life
    assert engine.stress("npc", timestamp=100.0) == pytest.approx(40.0)
    assert engine.stress("npc", timestamp=300.0) == pytest.approx(10.0)

    # Threats also generate stress as a side effect
    threat_engine = _engine()
    threat_engine.record_interaction("npc", "p", "threatened", timestamp=0.0)
    assert threat_engine.stress("npc", timestamp=0.0) > 0.0

    with pytest.raises(ValueError):
        _engine().report_stress("npc", 10.0, timestamp=0.0, reason="not_a_reason")


def test_stance_bands_map_scores_correctly():
    engine = _engine()
    cases = {
        "hostile": ("villain", "p1"),
        "unfriendly": ("grump", "p2"),
        "neutral": ("stranger", "p3"),
        "friendly": ("mentor", "p4"),
        "allied": ("sworn_brother", "p5"),
    }

    # Drive scores into each band via repeated interactions
    for _ in range(3):
        engine.record_interaction("villain", "p1", "betrayed", magnitude=5.0, timestamp=0.0)
        engine.record_interaction("grump", "p2", "ignored", magnitude=5.0, timestamp=0.0)
        engine.record_interaction("mentor", "p4", "aided", magnitude=2.0, timestamp=0.0)
        engine.record_interaction("sworn_brother", "p5", "aided", magnitude=5.0, timestamp=0.0)

    scores = {npc: engine.disposition(npc, p) for npc, p in cases.values()}
    assert scores["villain"] < scores["grump"] < scores["stranger"] < scores["mentor"] < scores["sworn_brother"]
    assert scores["villain"] <= -60.0
    assert -60.0 < scores["grump"] <= -20.0
    assert scores["stranger"] == 0.0
    assert 20.0 < scores["mentor"] < 60.0
    assert scores["sworn_brother"] >= 60.0

    for expected_stance, (npc, pid) in cases.items():
        assert engine.stance(npc, pid) == expected_stance


def test_scores_clamped_to_minus_hundred_plus_hundred():
    engine = _engine()
    for _ in range(50):
        engine.record_interaction("saint", "p", "aided", magnitude=10.0, timestamp=0.0)
        engine.record_interaction("demon", "p", "betrayed", magnitude=10.0, timestamp=0.0)

    assert engine.disposition("saint", "p", timestamp=0.0) == 100.0
    assert engine.disposition("demon", "p", timestamp=0.0) == -100.0
    assert engine.components("saint", "p")["trust"] <= 100.0
    assert engine.components("demon", "p")["fear"] <= 100.0


def test_deterministic_given_same_events_and_clock_injected():
    def replay():
        a = _engine(clock=lambda: 9999.0)  # clock never consulted when timestamps given
        b = _engine(clock=lambda: 123456.0)
        for eng in (a, b):
            eng.record_interaction("npc", "p", "aided", 1.0, 10.0)
            eng.record_interaction("npc", "p", "threatened", 2.0, 20.0)
            eng.record_interaction("npc", "p", "gifted", 1.5, 30.0)
            eng.report_stress("npc", 25.0, timestamp=15.0, reason="threatened")
        return a, b

    a, b = replay()
    assert a.disposition("npc", "p", timestamp=50.0) == b.disposition("npc", "p", timestamp=50.0)
    assert a.stance("npc", "p") == b.stance("npc", "p")
    assert a.history() == b.history()


def test_interaction_records_are_pydantic_models_with_validation():
    record = NpcInteractionRecord(
        npc_id="npc", player_id="p", kind="aided", magnitude=2.0, timestamp=42.0
    )
    assert record.kind == "aided"
    assert record.magnitude == 2.0

    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        NpcInteractionRecord(npc_id="npc", player_id="p", kind="aided", magnitude=-1.0, timestamp=0.0)
    with pytest.raises(ValidationError):
        NpcInteractionRecord(npc_id="npc", player_id="p", kind="aided")  # missing required timestamp
    with pytest.raises(ValidationError):
        NpcInteractionRecord(npc_id="npc", player_id="p", kind="smite", timestamp=0.0)  # unknown kind


def test_snapshot_reports_full_component_breakdown():
    engine = _engine()
    engine.set_alignment_bias("npc", "p", -5.0)
    engine.record_interaction("npc", "p", "aided", magnitude=2.0, timestamp=0.0)
    engine.record_interaction("npc", "p", "threatened", magnitude=1.0, timestamp=0.0)
    engine.report_stress("npc", 50.0, timestamp=0.0, reason="hp_low")

    snap = engine.snapshot("npc", "p", timestamp=100.0)
    assert snap["score"] == pytest.approx(engine.disposition("npc", "p", timestamp=100.0))
    assert snap["stance"] == engine.stance("npc", "p")
    for key in ("trust", "fear", "stress", "alignment_bias"):
        assert key in snap

    # Unknown pair snapshot is neutral-safe
    empty = engine.snapshot("nobody", "nobody", timestamp=0.0)
    assert empty["score"] == 0.0 and empty["stance"] == "neutral"
