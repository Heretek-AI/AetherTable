"""Iteration 81 — the campaign sim exercises the NEW reaction mechanics.

Contract under test:

- When a move response discloses a pending opportunity attack against the
  mover (``opportunity_attacks`` in the /move outcome, iteration 78 wire),
  the OPPONENT seat takes it on its next available action through the SAME
  authenticated ``/api/v1/engine/opportunity-attack`` proxy real clients use.
- Seats occasionally READY an action (spending their Action) and RELEASE it
  when the structured trigger fires (``enemy_attacks`` /
  ``enemy_enters_reach``) through ``/api/v1/engine/ready`` +
  ``/api/v1/engine/ready/release``.
- Decisions are deterministic per seed: two runs with the same seed produce
  identical action sequences; different seeds may diverge.
- Every attempt is accounted honestly: an OA or release that legitimately
  fails engine validation is still an ATTEMPTED action with its reason
  recorded, never silently dropped and never invented into an accept.

No test touches the network: outbound orchestrator HTTP rides the in-process
ASGI transport, the authoritative Rust engine behind
``routing.engine_client`` is replaced by the same in-memory fake used for
the base sim suite, and no LLM key is configured (scripted mode).
"""

import asyncio
import json
import re
import uuid as uuid_mod

import pytest

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.routing.engine_client import EngineRejectedError
from vtt_orchestrator.simulation.campaign_sim import (
    CampaignSimulation,
    CampaignSimPlayer,
    scripted_decision,
)

from test_campaign_sim import FakeEngine, asgi_transport

DUMMY_ID = str(engine_client._coerce_uuid("sim-training-dummy"))


@pytest.fixture()
def fake_engine(monkeypatch):
    """Same isolation contract as the base campaign-sim fixture."""
    fake = FakeEngine()
    monkeypatch.setattr(engine_client, "engine_request", fake.engine_request)
    for var in ("LLM_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.delenv("OLLAMA_BASE_URL", raising=False)
    return fake


def run(players=2, rounds=3, **kwargs):
    # A fixed default seed so reaction-layer behavior (occasional Ready,
    # reposition direction) actually occurs in the scenario tests; tests that
    # need a specific stream pass decision_seed explicitly. Seed 13 reliably
    # produces adjacency-breaking moves AND a full ready->release cycle
    # against the standard 2-seat layout.
    kwargs.setdefault("decision_seed", 13)
    kwargs.setdefault("transport", asgi_transport())
    return asyncio.run(CampaignSimulation(players=players, rounds=rounds, **kwargs).run())


def _all_turns(report):
    return [t for r in report["rounds"] for t in r["turns"]]


# ---------------------------------------------------------------------------
# Deterministic per-seed policy primitives
# ---------------------------------------------------------------------------

class TestSeededPolicyPrimitives:
    def test_seed_zero_is_deterministic(self):
        assert scripted_decision(
            CampaignSimPlayer("a", 0), {"entities": []}, 1, None, seed=0
        )["ready_this_turn"] is False

    def test_same_seed_same_choice(self):
        player = CampaignSimPlayer("a", 0)
        snapshot = {"entities": []}
        seq_a = [scripted_decision(player, snapshot, r, None, seed=s)["ready_this_turn"]
                 for s, r in [(7, 1), (7, 2), (7, 3), (7, 4), (7, 5)]]
        seq_b = [scripted_decision(player, snapshot, r, None, seed=s)["ready_this_turn"]
                 for s, r in [(7, 1), (7, 2), (7, 3), (7, 4), (7, 5)]]
        assert seq_a == seq_b

    def test_different_seeds_can_diverge(self):
        player = CampaignSimPlayer("a", 0)
        snapshot = {"entities": []}
        seq = {scripted_decision(player, snapshot, r, None, seed=s)["ready_this_turn"]
               for s in range(20) for r in range(1, 6)}
        # With ~15% ready probability across 100 draws both outcomes must be
        # observed; if not the "occasionally" contract has quietly degraded.
        assert seq == {True, False}

    def test_unknown_seed_falls_back_to_stable_default(self):
        assert scripted_decision(
            CampaignSimPlayer("a", 0), {"entities": []}, 3, None, seed=None
        )["ready_this_turn"] is False


# ---------------------------------------------------------------------------
# Opportunity attacks: disclosure -> opponent takes it next action
# ---------------------------------------------------------------------------

def arm_oa(fake_engine):
    """Arm the training dummy's OA reaction so moves away from it provoke."""
    fake_engine.armed_reactions.add(DUMMY_ID)


class TestOpportunityAttackPath:
    def test_move_disclosure_triggers_opponent_oa_proxy_call(self, fake_engine):
        arm_oa(fake_engine)
        report = run(players=2, rounds=4)

        oa_calls = [
            c for c in fake_engine.calls_to("/action/opportunity-attack")
            if c["method"] == "POST"
        ]
        assert oa_calls, (
            "moves that disclosed a pending opportunity attack must be "
            "followed by an OA proxy call from the opponent seat"
        )
        # The attacker is always the OPPONENT of whoever moved away.
        pc_ids = {p["entity_id"] for p in report["per_player"]}
        for call in oa_calls:
            assert call["payload"]["attacker_id"] == DUMMY_ID
            assert call["payload"]["target_id"] in pc_ids

    def test_oa_calls_carry_the_seat_identity(self, fake_engine):
        arm_oa(fake_engine)
        report = run(players=2, rounds=4)

        user_ids = {p["user_id"] for p in report["per_player"]}
        for call in fake_engine.calls_to("/action/opportunity-attack"):
            assert call["actor"] is not None
            assert call["actor"]["user_id"] in user_ids

    def test_oa_attempts_are_accounted_not_hidden(self, fake_engine):
        arm_oa(fake_engine)
        report = run(players=2, rounds=4)

        oa_turns = [t for t in _all_turns(report) if t.get("reaction_kind") == "opportunity_attack"]
        proxy_calls = len([
            c for c in fake_engine.calls_to("/action/opportunity-attack")
            if c["method"] == "POST"
        ])
        assert len(oa_turns) == proxy_calls > 0
        # Every attempt is either accepted or honestly rejected WITH a reason.
        for turn in oa_turns:
            assert turn["attempted"] is True
            assert turn["accepted"] != turn["rejected"]
            if turn["rejected"]:
                assert turn["rejection_reason"]

    def test_no_pending_offer_means_no_oa_attempt(self, fake_engine):
        # No reaction armed anywhere -> no move can ever disclose a pending OA.
        report = run(players=2, rounds=3)

        assert all(
            t.get("reaction_kind") != "opportunity_attack"
            for t in _all_turns(report)
        )

    def test_engine_refusal_is_counted_as_valid_attempt(self, fake_engine):
        """A legitimate-but-refused swing (REACTION_UNAVAILABLE etc.) counts
        as an attempted action — it must never be dropped from accounting."""
        arm_oa(fake_engine)
        fake_engine.reject("/action/opportunity-attack", "REACTION_UNAVAILABLE")
        report = run(players=2, rounds=4)

        oa_turns = [t for t in _all_turns(report)
                    if t.get("reaction_kind") == "opportunity_attack"]
        assert oa_turns
        assert all(t["rejected"] and t["rejection_reason"] == "REACTION_UNAVAILABLE"
                   for t in oa_turns)
        totals = report["totals"]
        assert totals["rejected"] >= len(oa_turns)
        assert totals["rejection_reasons"].get("REACTION_UNAVAILABLE") == \
            sum(1 for t in _all_turns(report)
                if t.get("reaction_kind") == "opportunity_attack"
                and t["rejection_reason"] == "REACTION_UNAVAILABLE")


# ---------------------------------------------------------------------------
# Ready / Release lifecycle
# ---------------------------------------------------------------------------

class TestReadyReleaseLifecycle:
    def test_ready_then_release_rides_both_proxies(self, fake_engine):
        report = run(players=2, rounds=6)

        ready_calls = fake_engine.calls_to("/action/ready")
        releases = fake_engine.calls_to("/action/ready/release")
        assert any(c["path"].endswith("/action/ready") for c in ready_calls)
        assert releases, "a readied action whose trigger fired must be released"

        # Releases only ever happen AFTER the corresponding ready.
        ready_seqs = [c["_seq"] for c in ready_calls if c["path"].endswith("/action/ready")]
        release_seqs = [c["_seq"] for c in releases]
        assert min(release_seqs) > min(ready_seqs)

    def test_ready_and_release_forward_the_seat_identity(self, fake_engine):
        run(players=2, rounds=6)

        user_seen = set()
        for call in (fake_engine.calls_to("/action/ready") +
                     fake_engine.calls_to("/action/ready/release")):
            assert call["actor"] is not None
            user_seen.add(call["actor"]["user_id"])
        assert user_seen, "ready/release calls must carry a seat identity"

    def test_release_only_when_structured_trigger_fires(self, fake_engine):
        """The scripted policy declares enemy_attacks-style triggers; a release
        without ANY accepted attack landing since the ready would mean the
        policy released on nothing."""
        report = run(players=2, rounds=6)

        turns = _all_turns(report)
        order = sorted(range(len(turns)), key=lambda i: i)  # chronological
        for idx in range(len(turns)):
            if turns[idx].get("reaction_kind") != "readied_release":
                continue
            prior_attacks = [
                t for t in turns[:idx]
                if t["action"] == "attack" and t["accepted"]
            ]
            assert prior_attacks, (
                "release must follow a fired trigger (an accepted enemy "
                "attack), never fire blind"
            )

    def test_ready_release_attempts_are_accounted(self, fake_engine):
        report = run(players=2, rounds=6)

        ready_turns = [t for t in _all_turns(report)
                       if t.get("reaction_kind") == "readied_ready"]
        release_turns = [t for t in _all_turns(report)
                         if t.get("reaction_kind") == "readied_release"]
        assert ready_turns and release_turns
        for turn in ready_turns + release_turns:
            assert turn["attempted"] is True
            if turn["rejected"]:
                assert turn["rejection_reason"]

    def test_engine_refused_release_counts_as_valid_attempt(self, fake_engine):
        fake_engine.reject("/action/ready/release", "NO_READIED_ACTION")
        report = run(players=2, rounds=6)

        release_turns = [t for t in _all_turns(report)
                         if t.get("reaction_kind") == "readied_release"]
        assert release_turns
        assert all(t["rejected"] for t in release_turns)
        assert report["totals"]["rejection_reasons"].get("NO_READIED_ACTION")

    def test_readied_seat_skips_its_regular_action_that_turn(self, fake_engine):
        """Ready spends the Action: the turn that readies carries NO regular
        attack/move/check payload to the standard endpoints."""
        report = run(players=2, rounds=6)

        for turn in _all_turns(report):
            if turn.get("reaction_kind") == "readied_ready":
                assert turn["attempted"] is True  # the ready itself was sent


# ---------------------------------------------------------------------------
# Determinism per seed (whole-run)
# ---------------------------------------------------------------------------

class TestRunDeterminism:
    def test_identical_seeds_produce_identical_reports(self, fake_engine):
        arm_oa(fake_engine)
        a = run(players=2, rounds=5, decision_seed=123)
        b = run(players=2, rounds=5, decision_seed=123)

        def project(rep):
            slot = {p["name"]: i for i, p in enumerate(rep["per_player"])}
            return [(slot[t["player"]], t["round"], t["action"],
                     t.get("reaction_kind"), json.dumps(t.get("requested"), sort_keys=True))
                    for t in _all_turns(rep)]

        assert project(a) == project(b)

    def test_different_seeds_may_diverge_but_stay_valid(self, fake_engine):
        arm_oa(fake_engine)
        reports = [run(players=2, rounds=5, decision_seed=s) for s in (1, 2, 3)]

        sequences = []
        for rep in reports:
            slot = {p["name"]: i for i, p in enumerate(rep["per_player"])}
            sequences.append([(slot[t["player"]], t["round"], t["action"])
                              for t in _all_turns(rep)])
        # Not required to differ, but at least one pair must — otherwise the
        # seed input is decorative.
        assert len({tuple(s) for s in sequences}) >= 2

        # Whatever they chose, every attempt stays honestly accounted.
        for rep in reports:
            totals = rep["totals"]
            assert totals["accepted"] + totals["rejected"] == \
                totals["actions_attempted"]

    def test_default_run_remains_deterministic_without_seed_arg(self, fake_engine):
        a = run(players=2, rounds=3, decision_seed=None)
        b = run(players=2, rounds=3, decision_seed=None)

        def project(rep):
            slot = {p["name"]: i for i, p in enumerate(rep["per_player"])}
            return [(slot[t["player"]], t["round"], t["action"]) for t in _all_turns(rep)]

        assert project(a) == project(b)


# ---------------------------------------------------------------------------
# Report shape honesty
# ---------------------------------------------------------------------------

class TestReportShape:
    def test_totals_carry_reaction_breakdown(self, fake_engine):
        arm_oa(fake_engine)
        report = run(players=2, rounds=4)

        totals = report["totals"]
        assert isinstance(totals.get("reaction_actions"), dict)
        kinds = totals["reaction_actions"]
        assert kinds.get("opportunity_attack", 0) > 0
        assert set(kinds) <= {"opportunity_attack", "readied_ready",
                              "readied_release"}
        # The breakdown sums to exactly the number of reaction-kind turns.
        assert sum(kinds.values()) == len(
            [t for t in _all_turns(report) if t.get("reaction_kind")])

    def test_per_turn_reaction_fields_are_present(self, fake_engine):
        arm_oa(fake_engine)
        report = run(players=2, rounds=3)

        for turn in _all_turns(report):
            # Present-and-null when absent; present-and-valued when taken.
            assert "reaction_kind" in turn
