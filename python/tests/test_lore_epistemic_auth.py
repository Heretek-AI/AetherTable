"""Epistemic-tier authorization on POST /api/v1/lore/assert (Pillar-7).

The lore graph's three-tier progression (SUBJECTIVE_RUMOR -> PROPOSED_FACT ->
VALIDATED_CANON, with paradox review at each hop) is world-state policy, so it
must be enforced server-side against the CALLER's token role — never taken on
faith from the request body:

  * Every assertion enters at SUBJECTIVE_RUMOR unless the caller promotes.
  * Only gm/admin tokens may promote, ONE step per call.
  * player/spectator tokens can never set or promote beyond rumor; their
    assertions stage into the paradox/verification pipeline like anyone
    else's rumors.
  * A client-supplied tier above the caller's authority is an honest 403,
    never a silent downgrade.
"""

import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import _sign_token, app

client = TestClient(app)


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _assert_payload(triple: tuple[str, str, str], tier: str | None = None) -> dict:
    subject, predicate, obj = triple
    body = {
        "proposing_entity_id": "npc_test_1",
        "subject_node_id": subject,
        "predicate_relation": predicate,
        "object_node_id": obj,
        "context_sentence": f"{subject} {predicate.lower()} {obj}.",
    }
    if tier is not None:
        body["epistemic_tier"] = tier
    return body


# Unique per-test triples keep the shared in-memory graph from cross-talking.
def _fresh_triple(tag: str) -> tuple[str, str, str]:
    return (f"Subject_{tag}", "ALLIES_WITH", f"Object_{tag}")


class TestRumorDefault:
    def test_player_default_enters_as_subjective_rumor(self):
        triple = _fresh_triple("playerdefault")
        resp = client.post(
            "/api/v1/lore/assert", params={"token": _token("usr_p1", "player")},
            json=_assert_payload(triple),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "STAGED"
        assert body["epistemic_tier"] == "SUBJECTIVE_RUMOR"
        assert body["assigned_weight"] == pytest.approx(0.3)

    def test_gm_default_also_enters_as_rumor(self):
        triple = _fresh_triple("gmdefault")
        resp = client.post(
            "/api/v1/lore/assert", params={"token": _token("usr_gm1", "gm")},
            json=_assert_payload(triple),
        )
        assert resp.status_code == 200
        assert resp.json()["epistemic_tier"] == "SUBJECTIVE_RUMOR"

    def test_explicit_rumor_is_allowed_for_any_role(self):
        for role in ("player", "spectator"):
            triple = _fresh_triple(f"explicit_{role}")
            resp = client.post(
                "/api/v1/lore/assert",
                params={"token": _token(f"usr_x_{role}", role)},
                json=_assert_payload(triple, tier="SUBJECTIVE_RUMOR"),
            )
            assert resp.status_code == 200
            assert resp.json()["assigned_weight"] == pytest.approx(0.3)


class TestPlayerCannotPromote:
    @pytest.mark.parametrize("tier", ["PROPOSED_FACT", "VALIDATED_CANON"])
    @pytest.mark.parametrize("role", ["player", "spectator"])
    def test_non_gm_tier_request_is_forbidden(self, role, tier):
        triple = _fresh_triple(f"deny_{role}_{tier}")
        resp = client.post(
            "/api/v1/lore/assert",
            params={"token": _token(f"usr_deny_{role}", role)},
            json=_assert_payload(triple, tier=tier),
        )
        assert resp.status_code == 403, (
            f"{role} requesting {tier} must be refused with 403, got "
            f"{resp.status_code}: {resp.text}"
        )
        # Honest refusal means NOTHING was committed under the requested tier.
        assert tier not in resp.text or "detail" in resp.text

    def test_unknown_role_fails_closed(self):
        triple = _fresh_triple("failclosed")
        resp = client.post(
            "/api/v1/lore/assert",
            params={"token": _token("usr_weird", "wandering_minstrel")},
            json=_assert_payload(triple, tier="PROPOSED_FACT"),
        )
        assert resp.status_code == 403


class TestGmPromotionRules:
    def test_gm_may_promote_one_step_to_proposed_fact(self):
        triple = _fresh_triple("gmone")
        resp = client.post(
            "/api/v1/lore/assert", params={"token": _token("usr_gm2", "gm")},
            json=_assert_payload(triple, tier="PROPOSED_FACT"),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "STAGED"
        assert body["epistemic_tier"] == "PROPOSED_FACT"
        assert body["assigned_weight"] == pytest.approx(0.7)

    def test_gm_cannot_jump_straight_to_validated_canon(self):
        """One step per call: rumor -> canon skips the staged-fact review."""
        triple = _fresh_triple("gmjump")
        resp = client.post(
            "/api/v1/lore/assert", params={"token": _token("usr_gm3", "gm")},
            json=_assert_payload(triple, tier="VALIDATED_CANON"),
        )
        assert resp.status_code == 403, resp.text

    def test_gm_can_promote_a_staged_fact_to_canon(self):
        """The full Pillar-7 walk: rumor entry, one-step promotion to a staged
        fact, then a second call validating that exact triple as canon."""
        from vtt_orchestrator import server as server_module

        triple = _fresh_triple("gmwalk")
        token = _token("usr_gm4", "gm")

        first = client.post(
            "/api/v1/lore/assert", params={"token": token},
            json=_assert_payload(triple, tier="PROPOSED_FACT"),
        )
        assert first.status_code == 200
        assert first.json()["status"] == "STAGED"

        second = client.post(
            "/api/v1/lore/assert", params={"token": token},
            json=_assert_payload(triple, tier="VALIDATED_CANON"),
        )
        assert second.status_code == 200, second.text
        body = second.json()
        assert body["status"] == "COMMITTED"
        assert body["epistemic_tier"] == "VALIDATED_CANON"
        assert body["assigned_weight"] == pytest.approx(1.0)
        # The projection now really holds the canon edge.
        tiers = [
            e["tier"]
            for e in server_module.lore_graph.edges
            if (e["from"], e["rel"], e["to"]) == triple
        ]
        assert "VALIDATED_CANON" in tiers

    def test_admin_shares_gm_promotion_authority(self):
        triple = _fresh_triple("admin")
        resp = client.post(
            "/api/v1/lore/assert", params={"token": _token("usr_adm", "admin")},
            json=_assert_payload(triple, tier="PROPOSED_FACT"),
        )
        assert resp.status_code == 200
        assert resp.json()["assigned_weight"] == pytest.approx(0.7)

    def test_paradox_review_still_applies_to_promoted_assertions(self):
        """Promotion authority never bypasses paradox detection: a GM cannot
        resurrect a DECEASED canon node even at PROPOSED_FACT."""
        triple = ("NPC_Baron_Vane", "IS_ALIVE", "PC_Thorin")
        resp = client.post(
            "/api/v1/lore/assert", params={"token": _token("usr_gm5", "gm")},
            json=_assert_payload(triple, tier="PROPOSED_FACT"),
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "REJECTED_PARADOX"


class TestUnauthenticatedStillRefused:
    def test_missing_token_still_rejected(self):
        resp = client.post(
            "/api/v1/lore/assert", json=_assert_payload(_fresh_triple("anon"))
        )
        assert resp.status_code == 422
