"""Phase-2 tests: lore continuity is checked on the NARRATIVE itself.

Vector 4 previously required explicit lore_* payload keys that nothing in
the codebase ever populated, making the paradox check dead code. The auditor
now derives (subject, predicate, object) triples from canon entity names and
predicate verbs appearing in the draft.
"""

import pytest

from vtt_orchestrator.auditor.inspector import (
    PreCommitAuditorAgent,
    _extract_lore_triples,
)
from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager


@pytest.fixture()
def auditor():
    return PreCommitAuditorAgent(lore_graph=EpistemicLoreGraphManager())


def _audit(auditor, narrative):
    return auditor.audit_proposal(
        turn_index=1,
        entity_id="pc_thorin",
        proposed_narrative=narrative,
        engine_execution_payload={"action_name": "Strike", "is_hit": True,
                                  "total_damage": 3, "target_hp_remaining": 20},
        active_entity_count=2,
        previous_entity_count=2,
    )


class TestTripleExtraction:
    def test_deceased_actor_attacking_is_a_paradox(self, auditor):
        """Canon: Baron Vane is DECEASED — narrating him attacking anyone is
        a temporal paradox the auditor must catch."""
        report = _audit(
            auditor,
            "From beyond the grave, Baron Aldous Vane strikes at Thorin Oakenshield!",
        )
        assert not report.passed
        assert any(
            f.violation_type.value == "LORE_CONTINUITY" for f in report.failures
        )

    def test_destroyed_location_still_standing_is_a_paradox(self, auditor):
        """Canon: Oakhaven Keep is DESTROYED — reflexive IS_INTACT assertion."""
        report = _audit(auditor, "Oakhaven Keep still stands against the sky.")
        assert not report.passed
        assert any(
            f.violation_type.value == "LORE_CONTINUITY" for f in report.failures
        )

    def test_canon_consistent_narrative_passes(self, auditor):
        """Thorin genuinely possesses the Sunblade — no false positive."""
        report = _audit(
            auditor,
            "Thorin Oakenshield wields the Sunblade of Pelor against the dark.",
        )
        assert report.passed, [f.diagnostic_message for f in report.failures]

    def test_unknown_entities_produce_no_triples(self, auditor):
        triples = _extract_lore_triples(
            "Grimjaw the bandit king owns a rusty spoon.",
            auditor.lore_graph,
            {},
        )
        assert triples == []

    def test_explicit_payload_triple_takes_precedence(self, auditor):
        triples = _extract_lore_triples(
            "Baron Aldous Vane attacks Thorin Oakenshield.",
            auditor.lore_graph,
            {"lore_subject_id": "PC_Thorin", "lore_predicate": "POSSESSES",
             "lore_object_id": "Item_Sunblade"},
        )
        assert triples == [("PC_Thorin", "POSSESSES", "Item_Sunblade")]
