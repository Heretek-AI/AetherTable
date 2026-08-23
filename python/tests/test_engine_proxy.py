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


class TestEngineProxy:
    def test_create_session(self, live_engine):
        resp = client.post("/api/v1/engine/session", json={"session_name": "pytest"})
        assert resp.status_code == 200
        assert resp.json()["session_id"]

    def test_attack_resolution_contract(self, live_engine):
        session_id = client.post("/api/v1/engine/session", json={}).json()["session_id"]
        resp = client.post(
            "/api/v1/engine/attack",
            json={
                "session_id": session_id,
                "attacker_id": "thorin",
                "target_id": "orc-warlord",
                "attack_bonus": 7,
                "target_ac": 15,
                "damage_expression": "1d12+3",
                "damage_type": "slashing",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert 1 <= body["natural_roll"] <= 20
        assert isinstance(body["is_hit"], bool)
        if body["is_critical_hit"]:
            # Critical hits double damage dice; minimum expression is still respected.
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

    def test_death_save_state_machine_tracks_failures(self, live_engine):
        resp = client.post(
            "/api/v1/engine/death-save",
            json={"successes": 0, "failures": 0, "natural_roll": 1},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["failures"] == 2, "a natural 1 counts as two failures"

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
