"""Tests for the authoritative rules engine proxy (/api/v1/engine/*).

Engine-up cases run against a live vtt-server (crates/vtt-server) when one is
reachable on ENGINE_API_URL; they skip otherwise so CI without the Rust binary
still passes. The engine-down case always runs and asserts the 502 contract.
"""

import os
import uuid

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


class TestProxyIdentity:
    """Regression tests for caller-identity forwarding through the proxies:

    The engine's RBAC authorizes the REAL actor (entity ownership, spectator
    limits), so the gateway must mint forwarded-identity tokens instead of
    always speaking as 'orchestrator-service' (which 403s on owned entities).
    """

    @staticmethod
    def _token(user_id: str, role: str) -> str:
        from vtt_orchestrator.server import _sign_token

        import time as _time

        return _sign_token(
            {"user_id": user_id, "role": role, "exp": _time.time() + 600}
        )

    def test_move_with_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/move",
            params={"token": "not.a.valid.token"},
            json={"session_id": "s", "entity_id": "e", "x": 0, "y": 0, "z": 0},
        )
        assert resp.status_code == 401

    def test_turn_next_requires_a_token(self):
        resp = client.post(
            "/api/v1/engine/turn-next", json={"session_id": "s"}
        )
        assert resp.status_code == 422, "missing required token query param"

    def test_valid_player_token_forwards_real_identity(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["actor"] = actor
            return {"status": "MOVED"}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        token = self._token("player-7", "player")
        resp = client.post(
            "/api/v1/engine/move",
            params={"token": token},
            json={"session_id": "s", "entity_id": "e", "x": 1, "y": 2, "z": 0},
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}

    def test_gm_token_forwards_gm_role(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["actor"] = actor
            return {"status": "OK"}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/cast-spell",
            params={"token": token},
            json={"session_id": "s", "caster_id": "c", "spell": {"name": "Magic Missile"}, "cast_level": 1},
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}

    def test_attack_without_token_stays_service_mediated(self, monkeypatch):
        """Legacy callers that omit the token keep working via the service
        principal instead of breaking."""
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["actor"] = actor
            return {"natural_roll": 15, "is_hit": True}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = client.post(
            "/api/v1/engine/attack",
            json={"session_id": "s", "attacker_id": "a", "target_id": "b"},
        )
        assert resp.status_code == 200
        assert captured["actor"] is None

class TestHealRestProxyIdentity:
    """Identity forwarding + payload contract for the heal/rest proxies
    (POST /api/v1/engine/heal, POST /api/v1/engine/rest).

    The engine owns ALL healing/rest math (clamping to max_hp deficit, long-rest
    restoration); the gateway only forwards ids plus the caller's real identity
    so the engine's RBAC authorizes the actual actor."""

    @staticmethod
    def _token(user_id: str, role: str) -> str:
        from vtt_orchestrator.server import _sign_token

        import time as _time

        return _sign_token(
            {"user_id": user_id, "role": role, "exp": _time.time() + 600}
        )

    def test_heal_with_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/heal",
            params={"token": "not.a.valid.token"},
            json={"session_id": "s", "entity_id": "e", "amount": 5},
        )
        assert resp.status_code == 401

    def test_rest_with_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/rest",
            params={"token": "not.a.valid.token"},
            json={"session_id": "s", "kind": "long"},
        )
        assert resp.status_code == 401

    def test_heal_requires_a_token(self):
        resp = client.post(
            "/api/v1/engine/heal",
            json={"session_id": "s", "entity_id": "e", "amount": 5},
        )
        assert resp.status_code == 422, "missing required token query param"

    def test_rest_requires_a_token(self):
        resp = client.post("/api/v1/engine/rest", json={"session_id": "s", "kind": "short"})
        assert resp.status_code == 422, "missing required token query param"

    def test_valid_player_token_forwards_identity_and_payload_shape(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return {"status": "HEALED", "amount_applied": 5}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        session_id = "11111111-2222-3333-4444-555555555555"
        token = self._token("player-7", "player")
        resp = client.post(
            "/api/v1/engine/heal",
            params={"token": token},
            json={"session_id": session_id, "entity_id": "thorin", "amount": 5},
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "HEALED", "amount_applied": 5}
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}
        assert captured["method"] == "POST"
        assert captured["path"] == f"/api/v1/sessions/{session_id}/heal"
        # Ids-only payload, coerced to UUIDs like every other proxy.
        assert captured["payload"] == {
            "entity_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "thorin")),
            "amount": 5,
        }

    def test_gm_token_forwards_gm_role_on_long_rest(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return {"status": "RESTED", "restored_entities": 2}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        session_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/rest",
            params={"token": token},
            json={"session_id": session_id, "kind": "long"},
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}
        assert captured["path"] == f"/api/v1/sessions/{session_id}/rest"
        assert captured["payload"] == {"kind": "long"}

    def test_rest_rejects_unknown_kind(self, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            raise AssertionError("engine must not be called for an invalid kind")

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/rest",
            params={"token": token},
            json={"session_id": "s", "kind": "lunch"},
        )
        assert resp.status_code == 422

    def test_heal_rejects_extra_fields(self):
        """Trust-inversion regression: no HP overrides smuggled past the proxy."""
        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/heal",
            params={"token": token},
            json={
                "session_id": "s",
                "entity_id": "e",
                "amount": 5,
                "hp_override": 9999,
            },
        )
        assert resp.status_code == 422

    def test_actor_token_carries_role_claim_for_engine_rbac(self):
        """The forwarded token must be verifiable by the engine and carry the
        role claim its Role::from_identity mapping expects."""
        from vtt_orchestrator.routing.engine_client import _actor_token

        raw, sig = _actor_token({"user_id": "player-7", "role": "player"}).split(".", 1)
        import base64 as _b64
        import hashlib as _hashlib
        import hmac as _hmac
        import json as _json
        import os as _os

        secret = _os.environ.get("VTT_ENGINE_SECRET", _os.environ.get("AUTH_SECRET", ""))
        if not secret:
            pytest.skip("no shared secret configured")
        expected = _hmac.new(
            secret.encode(), _b64.urlsafe_b64decode(raw.encode()), _hashlib.sha256
        ).hexdigest()
        assert sig == expected
        payload = _json.loads(_b64.urlsafe_b64decode(raw.encode()))
        assert payload["user_id"] == "player-7"
        assert payload["role"] == "player"


class TestManeuverProxyIdentity:
    """Identity forwarding + payload contract for the six combat-maneuver
    proxies (POST /api/v1/engine/{grapple,shove,dodge,dash,disengage,stabilize}
    -> engine POST /api/v1/sessions/{id}/action/{...}).

    Contest math (rolls, modifiers, reach, action economy) is engine-owned; the
    gateway forwards ids plus the caller's verified identity only. The engine's
    optional deterministic `seed` is deliberately NOT forwardable — a client
    could otherwise pin its own rolls."""

    @staticmethod
    def _token(user_id: str, role: str) -> str:
        from vtt_orchestrator.server import _sign_token

        import time as _time

        return _sign_token(
            {"user_id": user_id, "role": role, "exp": _time.time() + 600}
        )

    SESSION_ID = "9f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"

    ROUTES = {
        "grapple": {
            "session_id": SESSION_ID,
            "attacker_id": "thorin",
            "defender_id": "orc-warlord",
            "defender_skill": "athletics",
        },
        "shove": {
            "session_id": SESSION_ID,
            "attacker_id": "thorin",
            "defender_id": "orc-warlord",
            "shove_effect": "prone",
        },
        "dodge": {"session_id": SESSION_ID, "entity_id": "thorin"},
        "dash": {"session_id": SESSION_ID, "entity_id": "thorin"},
        "disengage": {"session_id": SESSION_ID, "entity_id": "thorin"},
        "stabilize": {
            "session_id": SESSION_ID,
            "healer_id": "cleric",
            "target_id": "dying-hero",
        },
    }

    def _capture(self, monkeypatch, response):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return response

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        return captured

    def test_each_route_forwards_identity_path_and_payload_shape(self, monkeypatch):
        for name, body in self.ROUTES.items():
            captured = self._capture(monkeypatch, {"status": f"{name.upper()}_OK"})
            resp = client.post(
                f"/api/v1/engine/{name}",
                params={"token": self._token("player-7", "player")},
                json=body,
            )
            assert resp.status_code == 200, name
            assert resp.json() == {"status": f"{name.upper()}_OK"}
            assert captured["method"] == "POST", name
            assert captured["path"] == (
                f"/api/v1/sessions/{self.SESSION_ID}/action/{name}"
            ), name
            # Real caller identity reaches the engine RBAC, never the service
            # principal.
            assert captured["actor"] == {"user_id": "player-7", "role": "player"}, name
            # Ids-only payload coerced to UUIDs like every other proxy. The
            # session reference rides the PATH, not the body.
            expected = {k: v for k, v in body.items() if k != "session_id"}
            for key in ("attacker_id", "defender_id", "entity_id", "healer_id", "target_id"):
                if key in expected:
                    expected[key] = str(uuid.uuid5(uuid.NAMESPACE_URL, expected[key]))
            assert captured["payload"] == expected, name
            assert "seed" not in captured["payload"], name
            monkeypatch.undo()

    def test_gm_token_forwards_gm_role_on_grapple(self, monkeypatch):
        captured = self._capture(monkeypatch, {"success": True})
        resp = client.post(
            "/api/v1/engine/grapple",
            params={"token": self._token("gm-1", "gm")},
            json=self.ROUTES["grapple"],
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}

    def test_missing_token_is_422_on_every_route(self):
        for name, body in self.ROUTES.items():
            resp = client.post(f"/api/v1/engine/{name}", json=body)
            assert resp.status_code == 422, f"{name}: missing required token query param"

    def test_invalid_token_is_401_on_every_route(self):
        for name, body in self.ROUTES.items():
            resp = client.post(
                f"/api/v1/engine/{name}",
                params={"token": "not.a.valid.token"},
                json=body,
            )
            assert resp.status_code == 401, name

    def test_extra_body_fields_are_rejected(self):
        """Trust-inversion regression: no roll pins or seeds smuggled past the
        maneuver proxies."""
        token = self._token("gm-1", "gm")
        smuggles = {
            "grapple": {**self.ROUTES["grapple"], "attack_bonus": 999},
            "grapple-seed": {**self.ROUTES["grapple"], "seed": 42},
            "shove": {**self.ROUTES["shove"], "target_ac": -5},
            "dodge": {**self.ROUTES["dodge"], "ac_override": 30},
            "stabilize": {**self.ROUTES["stabilize"], "auto_success": True},
        }
        for case, body in smuggles.items():
            name = "grapple" if case.startswith("grapple") else case.split("-")[0]
            resp = client.post(
                f"/api/v1/engine/{name}", params={"token": token}, json=body
            )
            assert resp.status_code == 422, case

    def test_unknown_defender_skill_and_shove_effect_are_rejected(self, monkeypatch):
        async def refuse(method, path, payload=None, *, actor=None):
            raise AssertionError("engine must not be called for an invalid literal")

        monkeypatch.setattr(engine_client, "engine_request", refuse)
        token = self._token("gm-1", "gm")

        bad_skill = {**self.ROUTES["grapple"], "defender_skill": "basket-weaving"}
        assert client.post(
            "/api/v1/engine/grapple", params={"token": token}, json=bad_skill
        ).status_code == 422

        bad_effect = {**self.ROUTES["shove"], "shove_effect": "yeet"}
        assert client.post(
            "/api/v1/engine/shove", params={"token": token}, json=bad_effect
        ).status_code == 422

    def test_engine_rejection_is_surfaced_verbatim(self, monkeypatch):
        async def rejected(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(
                409, '{"error": "OUT_OF_REACH", "message": "target beyond 5 ft"}'
            )

        monkeypatch.setattr(engine_client, "engine_request", rejected)
        resp = client.post(
            "/api/v1/engine/stabilize",
            params={"token": self._token("player-7", "player")},
            json=self.ROUTES["stabilize"],
        )
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "error": "OUT_OF_REACH",
            "message": "target beyond 5 ft",
        }

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        for name, body in self.ROUTES.items():
            resp = client.post(
                f"/api/v1/engine/{name}",
                params={"token": self._token("gm-1", "gm")},
                json=body,
            )
            assert resp.status_code == 502, name
            assert "unreachable" in resp.json()["detail"].lower()


class TestMetricsProxy:
    """GET /api/v1/engine/metrics — read-only telemetry proxy.

    The engine's GET /metrics sits on PUBLIC_PATHS (crates/vtt-server/src/
    auth.rs), so the gateway must NOT mint an actor token for it and must
    surface the engine's honest counters verbatim (no fabrication) with a 502
    when the engine is unreachable so clients can render a degraded state.
    """

    ENGINE_METRICS = {
        "mechanical_compliance_rate_pct": 98.7,
        "total_actions": 1042,
        "valid_actions": 1028,
        "rejected_actions": 14,
        "auditor_total": 1042,
        "auditor_rejection_rate_pct": 1.3,
        "persistence_failures": 0,
        "target_sla_ms": 10,
    }

    def test_metrics_needs_no_actor_public_path(self, monkeypatch):
        """/metrics is unauthenticated on the engine, so no actor is forwarded."""
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["method"] = method
            captured["path"] = path
            captured["actor"] = actor
            return dict(self.ENGINE_METRICS)

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = client.get("/api/v1/engine/metrics")
        assert resp.status_code == 200
        assert captured == {
            "method": "GET",
            "path": "/metrics",
            "actor": None,
        }
        body = resp.json()
        assert body["mechanical_compliance_rate_pct"] == 98.7
        assert body["total_actions"] == 1042
        assert body["valid_actions"] == 1028
        assert body["rejected_actions"] == 14
        assert body["auditor_rejection_rate_pct"] == 1.3
        assert body["persistence_failures"] == 0

    def test_metrics_is_read_only_get(self):
        """Mutating verbs must not reach the engine through this route."""
        assert client.post("/api/v1/engine/metrics").status_code == 405

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        resp = client.get("/api/v1/engine/metrics")
        assert resp.status_code == 502
        assert "unreachable" in resp.json()["detail"].lower()

    def test_engine_error_status_is_surfaced_verbatim(self, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(404, '{"error": "not_found"}')

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = client.get("/api/v1/engine/metrics")
        assert resp.status_code == 404
        assert resp.json()["detail"] == {"error": "not_found"}

    def test_unknown_counter_keys_are_dropped(self, monkeypatch):
        """The proxy whitelists counters; future engine fields do not leak."""

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            payload = dict(self.ENGINE_METRICS)
            payload["internal_debug_secret"] = "do-not-expose"
            return payload

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = client.get("/api/v1/engine/metrics")
        assert resp.status_code == 200
        assert "internal_debug_secret" not in resp.json()


class TestSessionStateProxy:
    """POST /api/v1/engine/session-state — GET-style read proxy over the
    engine's GET /api/v1/sessions/{id}.

    Iteration-11 drift follow-up: after an X-card rewind the browser cannot
    converge its local tokens because RewindReport carries only counts and
    GET /sessions/{id} needs an HMAC token the browser never holds. This
    proxy gives it one authoritative read through the orchestrator, with the
    caller's real identity forwarded so the engine's RBAC applies."""

    @staticmethod
    def _token(user_id: str, role: str) -> str:
        from vtt_orchestrator.server import _sign_token

        import time as _time

        return _sign_token(
            {"user_id": user_id, "role": role, "exp": _time.time() + 600}
        )

    SESSION_ID = "12345678-90ab-cdef-1234-567890abcdef"

    def test_player_token_forwards_identity_and_uses_engine_get(self, monkeypatch):
        """Since iteration-32 this proxy PROJECTS entities by role; a player
        still receives their OWN entity in full (owner_player_id matches),
        which is what post-rewind client convergence needs. The full
        projection matrix is pinned in test_session_state_filtering.py."""
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return {
                "session_id": self.SESSION_ID,
                "entities": {"hero": {"current_hp": 30, "owner_player_id": "player-7"}},
                "ledger": {"current_sequence": 7},
            }

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        token = self._token("player-7", "player")
        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": token},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 200
        assert resp.json()["session_id"] == self.SESSION_ID
        assert resp.json()["entities"]["hero"]["current_hp"] == 30
        # It is a proxied GET against the canonical session resource...
        assert captured["method"] == "GET"
        assert captured["path"] == f"/api/v1/sessions/{self.SESSION_ID}"
        assert captured["payload"] is None
        # ...acting as the real caller, not orchestrator-service.
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}

    def test_gm_token_forwards_gm_role(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["actor"] = actor
            return {"session_id": self.SESSION_ID}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": token},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}

    def test_missing_token_is_unauthorized_never_anonymous_read(self, monkeypatch):
        """Audit remediation: the tokenless 'legacy service-principal verbatim
        read' is gone — this browser-facing route requires a valid token and
        never contacts the engine anonymously."""
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["actor"] = actor
            return {"session_id": self.SESSION_ID}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = client.post(
            "/api/v1/engine/session-state",
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 401
        assert captured == {}

    def test_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": "not.a.valid.token"},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 401

    def test_unknown_session_maps_engine_error_verbatim(self, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(404, '{"error": "Session not found"}')

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": self._token("gm-1", "gm")},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == {"error": "Session not found"}

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": self._token("gm-1", "gm")},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 502
        assert "unreachable" in resp.json()["detail"].lower()

    def test_extra_body_fields_are_rejected(self):
        """Trust-inversion regression: no query overrides smuggled past the
        read-only proxy."""
        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": token},
            json={
                "session_id": self.SESSION_ID,
                "include_hidden_entities": True,
            },
        )
        assert resp.status_code == 422

    def test_only_a_get_reaches_the_engine(self, monkeypatch):
        """Whatever the caller sends, this proxy must stay read-only."""

        async def reject_non_get(method, path, payload=None, *, actor=None):
            if method != "GET":
                raise AssertionError(f"engine must only see GET, saw {method}")
            return {"session_id": self.SESSION_ID}

        monkeypatch.setattr(engine_client, "engine_request", reject_non_get)
        resp = client.post(
            "/api/v1/engine/session-state",
            params={"token": self._token("gm-1", "gm")},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 200


class TestCombatProxy:
    """GM combat lifecycle proxies (POST /api/v1/engine/combat/begin,
    POST /api/v1/engine/combat/end).

    Initiative math is engine-owned; the gateway forwards only the session
    reference plus the caller's verified identity so the engine's RBAC
    authorizes the real actor (spectators are refused by the engine)."""

    @staticmethod
    def _token(user_id: str, role: str) -> str:
        from vtt_orchestrator.server import _sign_token

        import time as _time

        return _sign_token(
            {"user_id": user_id, "role": role, "exp": _time.time() + 600}
        )

    SESSION_ID = "abcdefab-cdef-abcd-efab-cdefabcdefab"

    def test_begin_with_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/combat/begin",
            params={"token": "not.a.valid.token"},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 401

    def test_end_with_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/combat/end",
            params={"token": "not.a.valid.token"},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 401

    def test_begin_requires_a_token(self):
        resp = client.post("/api/v1/engine/combat/begin", json={"session_id": "s"})
        assert resp.status_code == 422, "missing required token query param"

    def test_end_requires_a_token(self):
        resp = client.post("/api/v1/engine/combat/end", json={"session_id": "s"})
        assert resp.status_code == 422, "missing required token query param"

    def test_begin_forwards_identity_and_engine_path(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return {
                "status": "COMBAT_BEGAN",
                "in_combat": True,
                "round": 1,
                "turn_index": 0,
                "order": [
                    {
                        "entity_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "hero")),
                        "name": "Hero",
                        "dexterity": 14,
                        "initiative_total": 16,
                    }
                ],
            }

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/combat/begin",
            params={"token": token},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 200
        # Full rolled order travels back verbatim — no projection.
        body = resp.json()
        assert body["status"] == "COMBAT_BEGAN"
        assert body["order"][0]["name"] == "Hero"
        assert body["order"][0]["initiative_total"] == 16
        # It is a POST against the canonical session resource...
        assert captured["method"] == "POST"
        assert captured["path"] == (
            f"/api/v1/sessions/{self.SESSION_ID}/combat/begin"
        )
        # ...with an empty ids-only payload acting as the REAL caller.
        assert captured["payload"] == {}
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}

    def test_end_forwards_gm_role_and_engine_path(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return {"status": "COMBAT_ENDED", "rounds_fought": 3}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/combat/end",
            params={"token": token},
            json={"session_id": self.SESSION_ID},
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "COMBAT_ENDED", "rounds_fought": 3}
        assert captured["method"] == "POST"
        assert captured["path"] == f"/api/v1/sessions/{self.SESSION_ID}/combat/end"
        assert captured["payload"] == {}
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}

    def test_begin_rejects_extra_body_fields(self):
        """Trust-inversion regression: no initiative overrides smuggled past
        the proxy — clients reference the session, never supply combat math."""
        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/combat/begin",
            params={"token": token},
            json={
                "session_id": self.SESSION_ID,
                "order": [{"entity_id": "x", "initiative_total": 999}],
            },
        )
        assert resp.status_code == 422

    def test_combat_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        for route in ("combat/begin", "combat/end"):
            resp = client.post(
                f"/api/v1/engine/{route}",
                params={"token": self._token("gm-1", "gm")},
                json={"session_id": self.SESSION_ID},
            )
            assert resp.status_code == 502, route
            assert "unreachable" in resp.json()["detail"].lower()

    def test_combat_session_ids_are_coerced_to_uuids(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["path"] = path
            return {"status": "COMBAT_BEGAN"}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        token = self._token("gm-1", "gm")
        resp = client.post(
            "/api/v1/engine/combat/begin",
            params={"token": token},
            json={"session_id": "thorins-table"},
        )
        assert resp.status_code == 200
        assert captured["path"].startswith("/api/v1/sessions/")
        coerced = captured["path"].split("/")[4]
        assert coerced == str(uuid.uuid5(uuid.NAMESPACE_URL, "thorins-table"))


class TestReadyActionProxy:
    """The Ready action's gateway proxy: identity-forwarded, strict body,
    description required — same trust contract as the other maneuvers."""

    @staticmethod
    def _token(user_id: str = "gm-9", role: str = "gm") -> str:
        import time as _time

        from vtt_orchestrator.server import _sign_token

        return _sign_token({"user_id": user_id, "role": role, "exp": _time.time() + 600})

    def test_ready_forwards_identity_path_and_payload(self, monkeypatch):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["method"], captured["path"] = method, path
            captured["payload"], captured["actor"] = payload, actor
            return {"status": "READY_ACTION_SET"}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = client.post(
            "/api/v1/engine/ready",
            params={"token": self._token()},
            json={"session_id": "s", "entity_id": "e",
                  "description": "I attack it", "trigger_hint": "when it moves"},
        )
        assert resp.status_code == 200
        assert captured["path"].endswith("/action/ready")
        assert captured["payload"]["description"] == "I attack it"
        assert captured["payload"]["trigger_hint"] == "when it moves"
        assert captured["actor"]["role"] == "gm"

    def test_missing_description_is_422(self):
        resp = client.post(
            "/api/v1/engine/ready",
            params={"token": self._token()},
            json={"session_id": "s", "entity_id": "e"},
        )
        assert resp.status_code == 422

    def test_invalid_token_is_401(self):
        resp = client.post(
            "/api/v1/engine/ready",
            params={"token": "garbage.token"},
            json={"session_id": "s", "entity_id": "e", "description": "x"},
        )
        assert resp.status_code == 401
