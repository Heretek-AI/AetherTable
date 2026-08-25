"""Automatic rumor capture from classified LORE_ASSERTION intents (Pillar 7).

Survey finding this iteration closes: the epistemic ladder itself was fully
real — POST /api/v1/lore/assert stages rumors, gates promotion on the caller's
role, and runs paradox review at every hop — but the ONLY thing that ever fed
the graph through that route was a hand-crafted request. A player improvising
lore at the table ("the baron's daughter rules the keep now") classifies as
LORE_ASSERTION at /api/v1/intent/classify and then... evaporates. Nothing
flows into the rumor pipeline unless someone manually re-POSTs a structured
triple to /lore/assert, so improvised assertions never reach paradox review
and never decay as rumors.

New contract:

* POST /api/v1/intent/classify with a LORE_ASSERTION-classified utterance
  AUTOMATICALLY captures the assertion: the response carries a
  ``rumor_capture`` object with ``status`` STAGED | REJECTED_PARADOX and the
  captured subject/predicate/object.
* Captured assertions enter ONLY as SUBJECTIVE_RUMOR regardless of who spoke —
  capture is a staging hook, never a promotion path.
* The captured triple is really projected into the lore graph (queryable via
  current_tier) and participates in later paradox review like any staged edge.
* Non-LORE_ASSERTION utterances carry no rumor_capture key at all.
* Capture failures never break classification: the classification result is
  returned unchanged even if the graph rejects the derived triple.
"""

import json
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.schemas.models import EpistemicTier
from vtt_orchestrator.server import _sign_token, app, lore_graph

client = TestClient(app)


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _capture_of(resp) -> dict | None:
    """Read the rumor-capture verdict from the X-Rumor-Capture response header.

    The classify endpoint declares IntentClassificationResult as its response
    model, so an extra body field would be silently stripped by FastAPI; the
    verdict rides out-of-band instead, exactly like other provenance channels.
    """
    raw = resp.headers.get("X-Rumor-Capture")
    return json.loads(raw) if raw else None


# ---------------------------------------------------------------------------
# Red test: classified lore assertions must flow into the rumor pipeline
# ---------------------------------------------------------------------------


class TestRumorCaptureOnClassifiedLore:
    def test_classified_lore_assertion_is_captured_as_rumor(self):
        resp = client.post(
            "/api/v1/intent/classify",
            params={"token": _token("usr_cap1", "player")},
            json={
                "utterance": "Remember that the Shadow Cabal rules Oakhaven Keep now.",
                "speaker_id": "Thorin",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        # The utterance must actually classify as lore (keyword path).
        assert body["intent_type"] == "LORE_ASSERTION"
        capture = _capture_of(resp)
        assert capture is not None, (
            "classified LORE_ASSERTION must be automatically captured into "
            "the rumor pipeline"
        )
        assert capture["status"] == "STAGED"
        assert capture["epistemic_tier"] == EpistemicTier.SUBJECTIVE_RUMOR.value

    def test_capture_enters_at_rumor_even_for_gm(self):
        """Capture is a staging hook, never a promotion path: even a GM's
        spoken assertion enters the ladder at SUBJECTIVE_RUMOR."""
        resp = client.post(
            "/api/v1/intent/classify",
            params={"token": _token("usr_cap_gm", "gm")},
            json={
                "utterance": "Know that Thorin Oakenshield wields the Sunblade of Pelor.",
                "speaker_id": "Thorin",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["intent_type"] == "LORE_ASSERTION"
        capture = _capture_of(resp)
        assert capture is not None
        assert capture["status"] == "STAGED"
        assert capture["epistemic_tier"] == EpistemicTier.SUBJECTIVE_RUMOR.value

    def test_captured_triple_really_lands_in_the_graph(self):
        utterance = "The legend of Thorin Oakenshield speaks with the Shadow Cabal."
        resp = client.post(
            "/api/v1/intent/classify",
            params={"token": _token("usr_cap2", "player")},
            json={"utterance": utterance, "speaker_id": "Thorin"},
        )
        assert resp.status_code == 200
        capture = _capture_of(resp)
        assert capture is not None
        assert capture["subject"] and capture["predicate"] and capture["object"]
        tier = lore_graph.current_tier(
            capture["subject"], capture["predicate"], capture["object"]
        )
        assert tier is EpistemicTier.SUBJECTIVE_RUMOR

    def test_paradoxical_utterance_is_rejected_not_staged(self):
        """Canon says Baron Vane is DECEASED — an improvised claim that he
        still lives must hit paradox review exactly like a manual POST."""
        resp = client.post(
            "/api/v1/intent/classify",
            params={"token": _token("usr_cap3", "player")},
            json={
                "utterance": (
                    "Lore indicates Baron Aldous Vane still walks the earth."
                ),
                "speaker_id": "Thorin",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["intent_type"] == "LORE_ASSERTION"
        capture = _capture_of(resp)
        assert capture is not None
        assert capture["status"] == "REJECTED_PARADOX"

    def test_non_lore_utterances_are_never_captured(self):
        for utterance in (
            "I attack the orc with my greataxe",          # mechanical
            "brb pizza",                                  # OOC
            '"Yield now, monster!"',                      # IC dialogue
            "X-Card on torture",                          # safety
        ):
            resp = client.post(
                "/api/v1/intent/classify",
                params={"token": _token("usr_cap4", "player")},
                json={"utterance": utterance, "speaker_id": "Thorin"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert body["intent_type"] != "LORE_ASSERTION"
            assert _capture_of(resp) is None, (
                f"utterance {utterance!r} classified "
                f"{body['intent_type']} but produced a rumor capture"
            )

    def test_classification_survives_capture_failure(self):
        """A capture that cannot resolve known entities must not break the
        classification contract — the classifier result stands either way."""
        resp = client.post(
            "/api/v1/intent/classify",
            params={"token": _token("usr_cap5", "player")},
            json={
                "utterance": "My father was a wandering minstrel of no renown.",
                "speaker_id": "Thorin",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["intent_type"] == "LORE_ASSERTION"
        # Whatever the capture verdict, the classification fields are intact.
        assert isinstance(body["confidence"], float)
        capture = _capture_of(resp)
        if capture is not None:
            assert isinstance(capture.get("status"), str)

    def test_unauthenticated_calls_still_rejected(self):
        resp = client.post(
            "/api/v1/intent/classify",
            json={"utterance": "the baron rules the keep", "speaker_id": "T"},
        )
        assert resp.status_code in (401, 403)
