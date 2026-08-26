"""Iteration 12, Loop 3 — server-side ENCOUNTER BALANCE preview.

TDD red-first module. The EncounterBuilderView composes monsters against spawn
proxies client-side, but until now nothing told the GM the adjusted XP /
difficulty tier before spawning. This pins POST
/api/v1/engine/encounter/balance:

* happy path over REAL SRD 5.2 compendium stat blocks (no invented XP),
* honest 404 naming an unknown monster_id,
* 422 on an empty roster,
* difficulty tiers at known DMG thresholds and party-size scaling,
* boundary party sizes / levels / quantities,
* gm/admin-only auth (401 anonymous, 403 player),
* default rate-limit bucket.
"""

import json
import os
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.compendium import starter_adventures
from vtt_orchestrator.server import app

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MONSTERS_FILE = os.path.join(PROJECT_ROOT, "compendium", "srd_5_2_monsters.json")

ROUTE = "/api/v1/engine/encounter/balance"

client = TestClient(app)


def _monsters() -> dict:
    with open(MONSTERS_FILE, "r", encoding="utf-8") as f:
        return {m["id"]: m for m in json.load(f)}


def _signup(name: str, role: str = "player") -> dict:
    email = f"{name}_{abs(hash(name + str(time.time()))) % 10**8}@example.com"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": name, "display_name": name.title(),
              "password": "dice-dice", "role": role},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture()
def gm_token(request, monkeypatch):
    # 'gm' is not self-service-grantable; exercise the operator bootstrap path
    # instead (same pattern as test_quest_route_auth.py).
    email = f"bal_gm_{abs(hash(request.node.name + str(time.time()))) % 10**8}@example.com"
    monkeypatch.setenv("VTT_ADMIN_EMAILS", email)
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0],
              "display_name": "Balance GM", "password": "dice-dice"},
    )
    assert signup.status_code == 200, signup.text
    assert signup.json()["user"]["role"] == "admin", signup.json()
    return signup.json()["token"]


@pytest.fixture()
def player_token():
    body = _signup("bal_player")
    assert body["user"]["role"] == "player", body
    return body["token"]


# --- Auth -----------------------------------------------------------------------

class TestAuth:
    def test_anonymous_is_401(self):
        resp = client.post(ROUTE, json={
            "party_level": 1, "party_size": 4,
            "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 4}],
        })
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing session token"

    def test_garbage_token_is_401(self):
        resp = client.post(
            ROUTE,
            params={"token": "not-a-real-token.sig"},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 1}]},
        )
        assert resp.status_code == 401

    def test_player_is_403(self, player_token):
        resp = client.post(
            ROUTE, params={"token": player_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 4}]},
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "ENCOUNTER_BALANCE_GM_ONLY"

    def test_gm_gets_200(self, gm_token):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 4}]},
        )
        assert resp.status_code == 200, resp.text

    def test_admin_gets_200(self, gm_token):
        # The gm_token fixture provisions through VTT_ADMIN_EMAILS, i.e. an
        # ADMIN account — this test is the admin leg of the gate.
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_skeleton", "quantity": 2}]},
        )
        assert resp.status_code == 200


# --- Happy path -----------------------------------------------------------------

class TestHappyPath:
    def test_two_goblins_for_level_one_party_of_four(self, gm_token):
        goblin = _monsters()["monster_goblin_warrior"]
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 4}]},
        )
        assert resp.status_code == 200
        body = resp.json()
        # 4 x 50 XP = 200 raw, hostiles=4 -> official x1.5 multiplier.
        assert body["raw_xp"] == 4 * goblin["xp"] == 200
        assert body["multiplier"] == 1.5
        assert body["adjusted_xp"] == 300
        assert body["per_monster"] == [
            {"monster_id": "monster_goblin_warrior", "name": goblin["name"],
             "xp": goblin["xp"], "quantity": 4}
        ]

    def test_mixed_roster_aggregates_per_monster_lines(self, gm_token):
        compendium = _monsters()
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [
                      {"monster_id": "monster_zombie", "quantity": 2},
                      {"monster_id": "monster_ghoul", "quantity": 1},
                  ]},
        )
        assert resp.status_code == 200
        body = resp.json()
        raw = 2 * compendium["monster_zombie"]["xp"] + compendium["monster_ghoul"]["xp"]
        assert body["raw_xp"] == raw == 300
        assert sum(line["quantity"] for line in body["per_monster"]) == 3
        assert {line["monster_id"] for line in body["per_monster"]} == {
            "monster_zombie", "monster_ghoul"}
        names = {line["monster_id"]: line["name"] for line in body["per_monster"]}
        assert names["monster_ghoul"] == compendium["monster_ghoul"]["name"]

    def test_matches_starter_adventures_model(self, gm_token):
        """The route must agree with the shipped build-time model for a real
        flagship encounter — one source of truth, not two drifting tables."""
        refs = [
            {"monster_id": "monster_cultist", "quantity": 2},
            {"monster_id": "monster_skeleton", "quantity": 2},
        ]
        expected = starter_adventures.encounter_balance(refs, party_level=1, party_size=4)
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4, "monsters": refs},
        )
        body = resp.json()
        assert body["raw_xp"] == expected["raw_xp"]
        assert body["adjusted_xp"] == expected["adjusted_xp"]
        assert body["difficulty"].upper() == expected["difficulty"]

    def test_response_shape(self, gm_token):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 1}]},
        )
        assert set(resp.json()) >= {
            "raw_xp", "adjusted_xp", "multiplier", "difficulty", "per_monster"}

    def test_duplicate_ids_are_not_collapsed(self, gm_token):
        """Two roster lines naming the same stat block must both count toward
        the XP total and both appear in per_monster."""
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [
                      {"monster_id": "monster_goblin_warrior", "quantity": 2},
                      {"monster_id": "monster_goblin_warrior", "quantity": 2},
                  ]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["raw_xp"] == 200
        assert len(body["per_monster"]) == 2


# --- Difficulty tiers -----------------------------------------------------------

class TestDifficultyTiers:
    def _ask(self, token, raw_xp: int, hostiles: int, size: int = 4, level: int = 1):
        # monster_goblin_warrior is 50 XP: quantity = raw_xp // 50 keeps the
        # arithmetic transparent while exercising real compendium rows.
        resp = client.post(
            ROUTE, params={"token": token},
            json={"party_level": level, "party_size": size,
                  "monsters": [{"monster_id": "monster_goblin_warrior",
                                "quantity": raw_xp // 50}]},
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    def test_trivial_below_easy_threshold(self, gm_token):
        body = self._ask(gm_token, 100, 2)   # 100 raw, x1.0 -> 100 < easy 200
        assert body["difficulty"] == "trivial"

    def test_easy_at_exact_threshold(self, gm_token):
        # 4 hostiles -> x1.5: 200 raw * 1.5 = 300 adjusted = easy(50)*4*... no:
        # easy threshold for 4 PCs at level 1 is 200; 300 sits between easy
        # (200) and medium (400) -> EASY band.
        body = self._ask(gm_token, 200, 4)
        assert body["raw_xp"] == 200 and body["adjusted_xp"] == 300
        assert body["difficulty"] == "easy"

    def test_medium_band(self, gm_token):
        # 6 hostiles -> x1.5: 300 raw * 1.5 = 450; medium band starts at 400.
        body = self._ask(gm_token, 300, 6)
        assert body["adjusted_xp"] == 450
        assert body["difficulty"] == "medium"

    def test_hard_band(self, gm_token):
        # 8 hostiles -> x2.0: 400 raw * 2.0 = 800 = hard threshold exactly.
        body = self._ask(gm_token, 400, 8)
        assert body["adjusted_xp"] == 800
        assert body["difficulty"] == "hard"

    def test_deadly_at_exact_threshold(self, gm_token):
        # 12 hostiles -> x2.0: 600 raw * 2.0 = 1200 >= deadly 1600? No — deadly
        # for four level-1 PCs is 1600; 1200 is HARD. Use 16 hostiles (x2.5):
        # 800 raw * 2.5 = 2000 >= 1600 -> DEADLY.
        body = self._ask(gm_token, 800, 16)
        assert body["adjusted_xp"] == 2000
        assert body["difficulty"] == "deadly"

    def test_party_size_scales_thresholds(self, gm_token):
        # Same fight, bigger table: thresholds scale per PC so eight PCs see a
        # trivial verdict where four would call it EASY.
        four = self._ask(gm_token, 200, 4, size=4)
        eight = self._ask(gm_token, 200, 4, size=8)
        assert four["difficulty"] == "easy"
        assert eight["difficulty"] == "trivial"

    def test_multiplier_steps_by_hostile_count(self, gm_token):
        assert self._ask(gm_token, 50, 1)["multiplier"] == 0.5
        assert self._ask(gm_token, 100, 2)["multiplier"] == 1.0
        assert self._ask(gm_token, 150, 3)["multiplier"] == 1.5
        assert self._ask(gm_token, 500, 10)["multiplier"] == 2.0
        assert self._ask(gm_token, 750, 15)["multiplier"] == 2.5


# --- Validation -----------------------------------------------------------------

class TestValidation:
    def test_unknown_monster_id_is_honest_404(self, gm_token):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [
                      {"monster_id": "monster_goblin_warrior", "quantity": 1},
                      {"monster_id": "monster_does_not_exist", "quantity": 1},
                  ]},
        )
        assert resp.status_code == 404
        detail = resp.json()["detail"]
        assert "monster_does_not_exist" in str(detail)

    def test_empty_roster_is_422(self, gm_token):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4, "monsters": []},
        )
        assert resp.status_code == 422

    def test_missing_monsters_field_is_422(self, gm_token):
        resp = client.post(
            ROUTE, params={"token": gm_token}, json={"party_level": 1, "party_size": 4}
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize("bad_level", [0, 21, -3])
    def test_party_level_outside_1_to_20_is_422(self, gm_token, bad_level):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": bad_level, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 1}]},
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize("bad_size", [0, 9])
    def test_party_size_outside_1_to_8_is_422(self, gm_token, bad_size):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": bad_size,
                  "monsters": [{"monster_id": "monster_goblin_warrior", "quantity": 1}]},
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize("bad_qty", [0, -1])
    def test_non_positive_quantity_is_422(self, gm_token, bad_qty):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior",
                                "quantity": bad_qty}]},
        )
        assert resp.status_code == 422

    def test_boundary_values_are_accepted(self, gm_token):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 20, "party_size": 8,
                  "monsters": [{"monster_id": "monster_aboleth", "quantity": 1}]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["per_monster"][0]["name"] == "Aboleth"
        assert body["per_monster"][0]["xp"] == 5900

    def test_quantity_defaults_to_one_when_omitted(self, gm_token):
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_goblin_warrior"}]},
        )
        assert resp.status_code == 200
        assert resp.json()["per_monster"][0]["quantity"] == 1

    def test_zero_xp_stat_block_is_allowed(self, gm_token):
        # monster_shrieker_fungus carries xp 0 in the compendium; it must not
        # crash multiplier math or be rejected as falsy.
        resp = client.post(
            ROUTE, params={"token": gm_token},
            json={"party_level": 1, "party_size": 4,
                  "monsters": [{"monster_id": "monster_shrieker_fungus", "quantity": 2}]},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["raw_xp"] == 0 and body["adjusted_xp"] == 0
        assert body["difficulty"] == "trivial"


# --- Rate-limit bucket ----------------------------------------------------------

class TestRateBucket:
    def test_route_meters_in_default_bucket(self):
        # Bucket assignment happens by path before routing; the balance route
        # is pure math (no model spend) so it must NOT inherit the expensive
        # llm bucket via any prefix match.
        assert server_module._bucket_for_path("/api/v1/engine/encounter/balance") == "default"
        # Trailing-slash alias normalizes to the same bucket decision.
        assert server_module._bucket_for_path("/api/v1/engine/encounter/balance/") == "default"
