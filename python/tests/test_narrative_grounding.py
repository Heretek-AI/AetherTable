"""Tests for SRD-grounded narration and the X-card safety rewind flow."""

import json

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import app, extract_srd_context

client = TestClient(app)


def _stream_text(intent: str, action: str) -> str:
    with client.stream(
        "POST",
        "/api/v1/orchestrator/narrative/stream",
        json={
            "user_intent": intent,
            "engine_execution_payload": {"action_name": action, "is_hit": True, "total_damage": 20},
        },
    ) as resp:
        assert resp.status_code == 200
        raw = "".join(chunk for chunk in resp.iter_text())
    return "".join(
        json.loads(msg[6:])["token"]
        for msg in raw.split("\n\n")
        if msg.startswith("data: ") and json.loads(msg[6:]).get("token")
    )


class TestSrdGrounding:
    def test_extract_finds_monster_statblock(self):
        facts = extract_srd_context("I charge the Adult Red Dragon")
        assert any(f["type"] == "monster" and f["name"] == "Adult Red Dragon" for f in facts)
        dragon = next(f for f in facts if f["name"] == "Adult Red Dragon")
        assert dragon["ac"] == 19
        assert "Multiattack" in dragon["action_names"]

    def test_extract_finds_spell(self):
        facts = extract_srd_context("I cast Fireball into the room")
        fireball = next((f for f in facts if f.get("name") == "Fireball"), None)
        assert fireball is not None
        assert fireball["level_name"] == "Level 3"
        assert fireball["school"].lower() == "evocation"

    def test_no_reference_returns_empty(self):
        assert extract_srd_context("I check the door for traps") == []

    def test_lore_lookup_endpoint(self):
        resp = client.get("/api/v1/compendium/lore-lookup", params={"q": "the Lich"})
        assert resp.status_code == 200
        assert resp.json()["facts"], "Lich must resolve from the bestiary"

    def test_narration_contains_srd_fact(self):
        text = _stream_text("I cast Fireball at the goblins", "Fireball")
        assert "Level 3" in text
        assert "Evocation" in text


class TestXCard:
    def test_x_card_records_intervention_without_engine(self):
        resp = client.post(
            "/api/v1/safety/x-card",
            json={
                "player_id": "usr_test",
                "topic": "spiders",
                "current_sequence_id": 7,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "SAFETY_INTERVENTION_ACTIVATED"
        assert body["target_sequence_id"] == 6
        assert "engine_rewind" not in body, "no rewind attempted without a bound session"

    def test_x_card_rewinds_engine_session_when_online(self):
        # Create a session through the proxy; if the engine is down, skip.
        create = client.post("/api/v1/engine/session", json={"session_name": "safety-test"})
        if create.status_code != 200:
            pytest.skip("vtt-server engine not running")

        session_id = create.json()["session_id"]
        resp = client.post(
            "/api/v1/safety/x-card",
            json={
                "player_id": "usr_test",
                "topic": "torture",
                "current_sequence_id": 5,
                "engine_session_id": session_id,
            },
        )
        assert resp.status_code == 200
        engine_result = resp.json()["engine_rewind"]
        # Either applied on the live ledger or explicitly unavailable offline.
        assert engine_result["status"] in ("SAFETY_REWIND_SUCCESS", "ENGINE_UNAVAILABLE")
