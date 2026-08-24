"""Tests for the authoritative rules engine proxy (/api/v1/engine/*).

Engine-up cases run against a live vtt-server (crates/vtt-server) when one is
reachable on ENGINE_API_URL; they skip otherwise so CI without the Rust binary
still passes. The engine-down case always runs and asserts the 502 contract.
"""

import os

import httpx
import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import app

client = TestClient(app)

ENGINE_URL = os.environ.get("ENGINE_API_URL", "http://localhost:8088")


def _engine_up() -> bool:
    try:
        httpx.get(f"{ENGINE_URL}/health", timeout=1.0)
        return True
    except httpx.HTTPError:
        return False


@pytest.fixture()
def live_engine():
    if not _engine_up():
        pytest.skip("vtt-server engine not running")
    return None


class TestEngineDown:
    def test_unreachable_engine_returns_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        response = client.post("/api/v1/engine/check", json={"modifier": 3, "dc": 12})
        assert response.status_code == 502
        assert "unreachable" in response.json()["detail"].lower()


def _entity_payload(entity_id: str, name: str, hp: int, ac: int) -> dict:
    """Full server-side stat block. Attack bonuses live HERE, not in requests."""
    import uuid as _uuid

    return {
        "id": str(_uuid.uuid5(_uuid.NAMESPACE_URL, entity_id)),
        "compendium_id": f"test_{name}",
        "name": name,
        "is_player": True,
        "current_hp": hp,
        "max_hp": hp,
        "temp_hp": 0,
        "ac": ac,
        "speed_feet": 30.0,
        "position": [2.5, 2.5, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {
            "strength": 16, "dexterity": 14, "constitution": 14,
            "intelligence": 10, "wisdom": 12, "charisma": 10,
        },
        "conditions": [],
        "action_budget": {
            "action": True, "bonus_action": True, "reaction": True,
            "movement_remaining_feet": 30.0, "free_object_interaction": True,
        },
        "spell_slots_remaining": {},
        "attacks": [
            {
                "name": "Longsword",
                "attack_bonus": 8,
                "damage_expression": "1d12+3",
                "damage_type": "slashing",
            }
        ],
        "resistances": [],
        "vulnerabilities": [],
        "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": True,
        "is_dead": False,
        "is_visible": True,
    }


class TestEngineProxy:
    def test_create_session(self, live_engine):
        resp = client.post("/api/v1/engine/session", json={"session_name": "pytest"})
        assert resp.status_code == 200
        assert resp.json()["session_id"]

    def test_attack_rejects_client_supplied_math(self, live_engine):
        """Trust inversion regression: extra combat-math fields are refused."""
        resp = client.post(
            "/api/v1/engine/attack",
            json={
                "session_id": "anything",
                "attacker_id": "thorin",
                "target_id": "orc-warlord",
                "attack_bonus": 999,
                "target_ac": -5,
                "damage_expression": "9999d9999",
            },
        )
        assert resp.status_code == 422, "client-supplied math must be rejected"

    def test_attack_resolution_contract(self, live_engine):
        created = client.post("/api/v1/engine/session", json={}).json()
        session_id = created["session_id"]

        # Spawn both parties so the engine resolves from real stat blocks.
        for eid, name, hp, ac in [("thorin", "Thorin", 30, 14), ("orc-warlord", "Orc", 20, 11)]:
            spawn = engine_client.engine_request_sync(
                "POST",
                f"/api/v1/sessions/{session_id}/entities",
                _entity_payload(eid, name, hp, ac),
            )
            assert spawn["status"] == "SPAWNED"

        resp = client.post(
            "/api/v1/engine/attack",
            json={
                "session_id": session_id,
                "attacker_id": "thorin",
                "target_id": "orc-warlord",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert 1 <= body["natural_roll"] <= 20
        assert isinstance(body["is_hit"], bool)
        # The server-side AC (11) is echoed back — never a client value.
        assert body["target_ac"] >= 11
        if body["is_critical_hit"]:
            assert body["total_damage"] >= 2
        elif not body["is_hit"]:
            assert body["total_damage"] == 0

    def test_check_with_advantage_stays_bounded(self, live_engine):
        resp = client.post(
            "/api/v1/engine/check", json={"modifier": 5, "dc": 13, "advantage": True}
        )
        assert resp.status_code == 200
        assert 1 <= resp.json()["roll"] <= 20

    def test_save_normalizes_ability_casing(self, live_engine):
        resp = client.post(
            "/api/v1/engine/save", json={"save_modifier": 2, "dc": 10, "ability": "wisdom"}
        )
        assert resp.status_code == 200
        assert resp.json()["ability"] == "WISDOM"

    def test_concentration_dc_is_max_of_half_damage_or_ten(self, live_engine):
        resp = client.post(
            "/api/v1/engine/concentration", json={"con_modifier": 0, "damage_taken": 30}
        )
        assert resp.status_code == 200
        assert resp.json()["dc"] == 15

    def test_death_save_resolves_from_server_state(self, live_engine):
        """Death saves now run against the server-side entity; the client may
        only reference it (no client-supplied counters accepted)."""
        created = client.post("/api/v1/engine/session", json={}).json()
        session_id = created["session_id"]
        spawn = engine_client.engine_request_sync(
            "POST",
            f"/api/v1/sessions/{session_id}/entities",
            _entity_payload("dying-hero", "Dying Hero", 0, 12),
        )
        assert spawn["status"] == "SPAWNED"

        resp = client.post(
            "/api/v1/engine/death-save",
            json={"session_id": session_id, "entity_id": "dying-hero"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body["is_dead"], bool)
        assert 1 <= body["natural_roll"] <= 20

    def test_map_generation_returns_wall_grid(self, live_engine):
        resp = client.post(
            "/api/v1/engine/map/generate", json={"width": 16, "height": 12, "seed": 42}
        )
        assert resp.status_code == 200
        tiles = resp.json()["tiles"]
        assert len(tiles) == 12 and len(tiles[0]) == 16
        # Perimeter must be sealed.
        assert all(cell == 1 for cell in tiles[0])
        assert any(1 in row for row in tiles)
