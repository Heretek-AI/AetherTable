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


def _signed_token(user_id: str = "player-7", role: str = "player") -> str:
    """A valid gateway session token for proxy-auth tests."""
    import time as _time

    from vtt_orchestrator.server import _sign_token

    return _sign_token({"user_id": user_id, "role": role, "exp": _time.time() + 600})


class TestEngineDown:
    def test_unreachable_engine_returns_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        response = client.post(
            "/api/v1/engine/check",
            params={"token": _signed_token()},
            json={"modifier": 3, "dc": 12},
        )
        assert response.status_code == 502
        assert "unreachable" in response.json()["detail"].lower()

    def test_unreachable_engine_is_401_before_dialing_when_anonymous(self, monkeypatch):
        """No credential never reaches the engine-dial stage at all."""
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        response = client.post("/api/v1/engine/check", json={"modifier": 3, "dc": 12})
        assert response.status_code == 401


class TestProxyAuthRequired:
    """Audit remediation: EVERY narrative-facing /api/v1/engine/* proxy route
    requires an attributable identity. A missing or expired token is a 401 with
    an honest error body — the optional-token back-compat paths that forwarded
    actor=None (orchestrator-service principal) are gone, so no combat can be
    resolved anonymously anymore."""

    # (path, body-or-None-for-GET) for every narrative-facing proxy route.
    ANONYMOUS_CASES = {
        "create-session": ("/api/v1/engine/session", {"session_name": "anon"}),
        "attack": (
            "/api/v1/engine/attack",
            {"session_id": "s", "attacker_id": "a", "target_id": "b"},
        ),
        "check": ("/api/v1/engine/check", {"modifier": 3, "dc": 12}),
        "save": ("/api/v1/engine/save", {"save_modifier": 2, "dc": 10}),
        "concentration": ("/api/v1/engine/concentration", {"con_modifier": 0, "damage_taken": 8}),
        "death-save": ("/api/v1/engine/death-save", {"session_id": "s", "entity_id": "e"}),
        "map-generate": ("/api/v1/engine/map/generate", {"width": 16, "height": 12}),
        "room-presence": ("GET", "/api/v1/engine/rooms/aethertable-live/presence"),
        "metrics": ("GET", "/api/v1/engine/metrics"),
        "spawn": (
            "/api/v1/engine/spawn",
            {"session_id": "s", "entity": {"name": "goblin"}},
        ),
        "move": ("/api/v1/engine/move", {"session_id": "s", "entity_id": "e", "x": 0, "y": 0, "z": 0}),
        "turn-next": ("/api/v1/engine/turn-next", {"session_id": "s"}),
        "combat-begin": ("/api/v1/engine/combat/begin", {"session_id": "s"}),
        "combat-end": ("/api/v1/engine/combat/end", {"session_id": "s"}),
        "damage": (
            "/api/v1/engine/damage",
            {"session_id": "s", "target_id": "t", "source_event_sequence": 1},
        ),
        "arm-reaction": (
            "/api/v1/engine/reactions/arm",
            {"session_id": "s", "entity_id": "e", "reaction_type": "opportunity"},
        ),
        "heal": ("/api/v1/engine/heal", {"session_id": "s", "entity_id": "e", "amount": 5}),
        "rest": ("/api/v1/engine/rest", {"session_id": "s", "kind": "short"}),
        "cast-spell": (
            "/api/v1/engine/cast-spell",
            {"session_id": "s", "caster_id": "c", "spell": {}, "cast_level": 1},
        ),
        "grapple": (
            "/api/v1/engine/grapple",
            {"session_id": "s", "attacker_id": "a", "defender_id": "d", "defender_skill": "athletics"},
        ),
        "shove": (
            "/api/v1/engine/shove",
            {"session_id": "s", "attacker_id": "a", "defender_id": "d", "shove_effect": "prone"},
        ),
        "dodge": ("/api/v1/engine/dodge", {"session_id": "s", "entity_id": "e"}),
        "dash": ("/api/v1/engine/dash", {"session_id": "s", "entity_id": "e"}),
        "disengage": ("/api/v1/engine/disengage", {"session_id": "s", "entity_id": "e"}),
        "stabilize": (
            "/api/v1/engine/stabilize",
            {"session_id": "s", "healer_id": "h", "target_id": "t"},
        ),
        "ready": (
            "/api/v1/engine/ready",
            {"session_id": "s", "entity_id": "e", "description": "hold"},
        ),
        "offhand": (
            "/api/v1/engine/offhand",
            {"session_id": "s", "attacker_id": "a", "target_id": "t", "offhand_index": 0},
        ),
        "help": (
            "/api/v1/engine/help",
            {"session_id": "s", "helper_id": "h", "target_entity_id": "t"},
        ),
        "opportunity-attack": (
            "/api/v1/engine/opportunity-attack",
            {"session_id": "s", "attacker_id": "a", "target_id": "t"},
        ),
    }

    def test_missing_token_is_401_on_every_narrative_route(self):
        for name, case in self.ANONYMOUS_CASES.items():
            if isinstance(case, tuple) and case[0] == "GET":
                _, path = case
                resp = client.get(path)
            else:
                path, body = case
                resp = client.post(path, json=body)
            assert resp.status_code == 401, f"{name}: anonymous access must be refused"
            detail = resp.json().get("detail")
            assert detail, f"{name}: 401 must carry an honest error body"

    def test_expired_token_is_401(self):
        import time as _time

        from vtt_orchestrator.server import _sign_token

        expired = _sign_token(
            {"user_id": "player-7", "role": "player", "exp": _time.time() - 10}
        )
        resp = client.post(
            "/api/v1/engine/attack",
            params={"token": expired},
            json={"session_id": "s", "attacker_id": "a", "target_id": "b"},
        )
        assert resp.status_code == 401

    def test_garbage_bearer_header_is_401(self):
        resp = client.post(
            "/api/v1/engine/attack",
            headers={"Authorization": "Bearer not.a.valid.token"},
            json={"session_id": "s", "attacker_id": "a", "target_id": "b"},
        )
        assert resp.status_code == 401

    def test_valid_bearer_header_is_accepted_and_forwarded(self, monkeypatch):
        """The preferred Authorization-header channel works on these routes too."""
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["path"], captured["actor"] = path, actor
            return {"roll": 11}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = client.post(
            "/api/v1/engine/check",
            headers={"Authorization": f"Bearer {_signed_token('player-7', 'player')}"},
            json={"modifier": 3, "dc": 12},
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}

    def test_valid_token_forwards_real_identity_on_dice_proxies(self, monkeypatch):
        """attack / check / save / concentration / death-save / map-generate /
        create-session each act as the VERIFIED caller, never the service
        principal."""
        cases = [
            ("/api/v1/engine/session", {"session_name": "authd"}, "create_session"),
            (
                "/api/v1/engine/attack",
                {"session_id": "s", "attacker_id": "a", "target_id": "b"},
                None,
            ),
            ("/api/v1/engine/check", {"modifier": 3, "dc": 12}, None),
            ("/api/v1/engine/save", {"save_modifier": 2, "dc": 10}, None),
            ("/api/v1/engine/concentration", {"con_modifier": 0, "damage_taken": 8}, None),
            (
                "/api/v1/engine/death-save",
                {"session_id": "s", "entity_id": "e"},
                None,
            ),
            ("/api/v1/engine/map/generate", {"width": 16, "height": 12}, None),
        ]
        for path, body, _ in cases:
            captured: dict = {}

            async def fake_engine_request(method, p, payload=None, *, actor=None):
                captured["actor"] = actor
                return {}

            monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
            resp = client.post(
                path,
                params={"token": _signed_token("gm-2", "gm")},
                json=body,
            )
            assert resp.status_code == 200, f"{path}: {resp.text}"
            assert captured["actor"] == {"user_id": "gm-2", "role": "gm"}, path
            monkeypatch.undo()


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
        resp = client.post(
            "/api/v1/engine/session",
            params={"token": _signed_token()},
            json={"session_name": "pytest"},
        )
        assert resp.status_code == 200
        assert resp.json()["session_id"]

    def test_attack_rejects_client_supplied_math(self, live_engine):
        """Trust inversion regression: extra combat-math fields are refused."""
        resp = client.post(
            "/api/v1/engine/attack",
            params={"token": _signed_token()},
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
        created = client.post(
            "/api/v1/engine/session", params={"token": _signed_token()}, json={}
        ).json()
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
            params={"token": _signed_token()},
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
            "/api/v1/engine/check",
            params={"token": _signed_token()},
            json={"modifier": 5, "dc": 13, "advantage": True},
        )
        assert resp.status_code == 200
        assert 1 <= resp.json()["roll"] <= 20

    def test_save_normalizes_ability_casing(self, live_engine):
        resp = client.post(
            "/api/v1/engine/save",
            params={"token": _signed_token()},
            json={"save_modifier": 2, "dc": 10, "ability": "wisdom"},
        )
        assert resp.status_code == 200
        assert resp.json()["ability"] == "WISDOM"

    def test_concentration_dc_is_max_of_half_damage_or_ten(self, live_engine):
        resp = client.post(
            "/api/v1/engine/concentration",
            params={"token": _signed_token()},
            json={"con_modifier": 0, "damage_taken": 30},
        )
        assert resp.status_code == 200
        assert resp.json()["dc"] == 15

    def test_death_save_resolves_from_server_state(self, live_engine):
        """Death saves now run against the server-side entity; the client may
        only reference it (no client-supplied counters accepted)."""
        created = client.post(
            "/api/v1/engine/session", params={"token": _signed_token()}, json={}
        ).json()
        session_id = created["session_id"]
        spawn = engine_client.engine_request_sync(
            "POST",
            f"/api/v1/sessions/{session_id}/entities",
            _entity_payload("dying-hero", "Dying Hero", 0, 12),
        )
        assert spawn["status"] == "SPAWNED"

        resp = client.post(
            "/api/v1/engine/death-save",
            params={"token": _signed_token()},
            json={"session_id": session_id, "entity_id": "dying-hero"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body["is_dead"], bool)
        assert 1 <= body["natural_roll"] <= 20

    def test_map_generation_returns_wall_grid(self, live_engine):
        resp = client.post(
            "/api/v1/engine/map/generate",
            params={"token": _signed_token()},
            json={"width": 16, "height": 12, "seed": 42},
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

    def test_turn_next_without_a_token_is_unauthorized(self):
        """Audit remediation: a missing credential is an honest 401, not the
        old 422 validation error and never an anonymous forward."""
        resp = client.post("/api/v1/engine/turn-next", json={"session_id": "s"})
        assert resp.status_code == 401

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

    def test_turn_next_with_invalid_token_is_unauthorized(self):
        resp = client.post(
            "/api/v1/engine/turn-next",
            params={"token": "not.a.valid.token"},
            json={"session_id": "s"},
        )
        assert resp.status_code == 401

    def test_valid_player_token_forwards_real_identity_on_attack(self, monkeypatch):
        """The attack proxy acts as the verified caller — the optional-token
        service-principal path (actor=None) that used to sit here is gone."""
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["actor"] = actor
            return {"natural_roll": 15, "is_hit": True}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = client.post(
            "/api/v1/engine/attack",
            params={"token": self._token("player-7", "player")},
            json={"session_id": "s", "attacker_id": "a", "target_id": "b"},
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}

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

    def test_heal_without_a_token_is_unauthorized(self):
        """Audit remediation: missing credential -> 401, never anonymous."""
        resp = client.post(
            "/api/v1/engine/heal",
            json={"session_id": "s", "entity_id": "e", "amount": 5},
        )
        assert resp.status_code == 401

    def test_rest_without_a_token_is_unauthorized(self):
        resp = client.post("/api/v1/engine/rest", json={"session_id": "s", "kind": "short"})
        assert resp.status_code == 401

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
        "offhand": {
            "session_id": SESSION_ID,
            "attacker_id": "thorin",
            "target_id": "orc-warlord",
            "offhand_index": 1,
        },
        "help": {
            "session_id": SESSION_ID,
            "helper_id": "bard",
            "target_entity_id": "orc-warlord",
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
            for key in (
                "attacker_id",
                "defender_id",
                "entity_id",
                "healer_id",
                "helper_id",
                "target_id",
                "target_entity_id",
            ):
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

    def test_missing_token_is_401_on_every_route(self):
        """Audit remediation: a missing credential is a 401 with an honest
        error body — never an anonymous service-principal forward."""
        for name, body in self.ROUTES.items():
            resp = client.post(f"/api/v1/engine/{name}", json=body)
            assert resp.status_code == 401, f"{name}: anonymous access must be refused"

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
            "offhand": {
                **self.ROUTES["offhand"],
                "damage_expression": "999d999+99",
            },
            "offhand-seed": {**self.ROUTES["offhand"], "seed": 7},
            "help": {**self.ROUTES["help"], "auto_grant": True},
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


class TestOffhandAndHelpProxies:
    """Identity forwarding + payload contract for the Two-Weapon Fighting and
    Help proxies (POST /api/v1/engine/offhand -> /action/offhand,
    POST /api/v1/engine/help -> /action/help).

    The engine decides everything mechanical (light-weapon legality, bonus
    action economy, reach, the granted advantage); the gateway forwards ids
    plus the caller's verified identity only — never a seed."""

    @staticmethod
    def _token(user_id: str, role: str) -> str:
        from vtt_orchestrator.server import _sign_token

        import time as _time

        return _sign_token({"user_id": user_id, "role": role, "exp": _time.time() + 600})

    SESSION_ID = "8a2b4c6d-1e3f-4a5b-9c0d-e1f2a3b4c5d6"

    OFFHAND = {
        "session_id": SESSION_ID,
        "attacker_id": "twin-blade",
        "target_id": "goblin",
        "offhand_index": 1,
    }

    HELP = {
        "session_id": SESSION_ID,
        "helper_id": "cleric",
        "target_entity_id": "ogre",
    }

    @staticmethod
    def _capture(monkeypatch, response):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return response

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        return captured

    def test_offhand_forwards_identity_path_and_ids_only_payload(self, monkeypatch):
        captured = self._capture(monkeypatch, {"is_hit": True})
        resp = client.post(
            "/api/v1/engine/offhand",
            params={"token": self._token("player-7", "player")},
            json=self.OFFHAND,
        )
        assert resp.status_code == 200
        assert resp.json() == {"is_hit": True}
        assert captured["method"] == "POST"
        assert captured["path"] == (
            f"/api/v1/sessions/{self.SESSION_ID}/action/offhand"
        )
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}
        assert captured["payload"] == {
            "attacker_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "twin-blade")),
            "target_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "goblin")),
            "offhand_index": 1,
        }
        assert "seed" not in captured["payload"]
        assert "session_id" not in captured["payload"]

    def test_help_forwards_identity_path_and_ids_only_payload(self, monkeypatch):
        captured = self._capture(monkeypatch, {"status": "HELP_GRANTED"})
        resp = client.post(
            "/api/v1/engine/help",
            params={"token": self._token("player-7", "player")},
            json=self.HELP,
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "HELP_GRANTED"}
        assert captured["path"] == f"/api/v1/sessions/{self.SESSION_ID}/action/help"
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}
        assert captured["payload"] == {
            "helper_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "cleric")),
            "target_entity_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "ogre")),
        }
        assert "seed" not in captured["payload"]

    def test_gm_identity_is_forwarded_on_both(self, monkeypatch):
        for path, body in (("offhand", self.OFFHAND), ("help", self.HELP)):
            captured = self._capture(monkeypatch, {})
            resp = client.post(
                f"/api/v1/engine/{path}",
                params={"token": self._token("gm-1", "gm")},
                json=body,
            )
            assert resp.status_code == 200, path
            assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}, path
            monkeypatch.undo()

    def test_missing_token_is_401_and_invalid_token_is_401(self):
        for path, body in (("offhand", self.OFFHAND), ("help", self.HELP)):
            assert (
                client.post(f"/api/v1/engine/{path}", json=body).status_code == 401
            ), path
            assert (
                client.post(
                    f"/api/v1/engine/{path}",
                    params={"token": "garbage.token.value"},
                    json=body,
                ).status_code
                == 401
            ), path

    def test_engine_rejections_surface_verbatim(self, monkeypatch):
        cases = [
            ("offhand", self.OFFHAND, "BONUS_ACTION_ECONOMY_EXHAUSTED"),
            ("help", self.HELP, "OUT_OF_REACH"),
        ]
        for path, body, code in cases:
            async def rejected(method, path_, payload=None, *, actor=None, code=code):
                raise engine_client.EngineRejectedError(409, f'{{"error": "{code}"}}')

            monkeypatch.setattr(engine_client, "engine_request", rejected)
            resp = client.post(
                f"/api/v1/engine/{path}",
                params={"token": self._token("player-7", "player")},
                json=body,
            )
            assert resp.status_code == 409, path
            assert resp.json()["detail"]["error"] == code, path
            monkeypatch.undo()

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        for path, body in (("offhand", self.OFFHAND), ("help", self.HELP)):
            resp = client.post(
                f"/api/v1/engine/{path}",
                params={"token": self._token("gm-1", "gm")},
                json=body,
            )
            assert resp.status_code == 502, path
            assert "unreachable" in resp.json()["detail"].lower(), path


class TestOpportunityAttackProxy:
    """Identity forwarding + payload contract for the opportunity-attack
    proxy (POST /api/v1/engine/opportunity-attack -> engine POST
    /api/v1/sessions/{id}/action/opportunity-attack), iteration 78.

    The engine's OpportunityAttackReq is ids-only ({attacker_id, target_id};
    optional engine-side action_index defaults to 0). Everything mechanical —
    pending-trigger liveness, Reaction spend, the roll itself — is engine-owned;
    the gateway forwards ids plus the caller's verified identity only. The
    engine's optional deterministic `seed` is deliberately NOT forwardable."""

    @staticmethod
    def _token(user_id: str = "player-7", role: str = "player") -> str:
        import time as _time

        from vtt_orchestrator.server import _sign_token

        return _sign_token({"user_id": user_id, "role": role, "exp": _time.time() + 600})

    SESSION_ID = "7b3d5f9a-2c4e-4d6f-8a1b-3e5c7d9f0a2b"

    BODY = {
        "session_id": SESSION_ID,
        "attacker_id": "orc-warlord",
        "target_id": "fleeing-mage",
    }

    @staticmethod
    def _capture(monkeypatch, response):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return response

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        return captured

    def test_forwards_identity_path_and_ids_only_payload(self, monkeypatch):
        captured = self._capture(monkeypatch, {"is_hit": True, "total_damage": 7})
        resp = client.post(
            "/api/v1/engine/opportunity-attack",
            params={"token": self._token("player-7", "player")},
            json=self.BODY,
        )
        assert resp.status_code == 200
        assert resp.json() == {"is_hit": True, "total_damage": 7}
        assert captured["method"] == "POST"
        assert captured["path"] == (
            f"/api/v1/sessions/{self.SESSION_ID}/action/opportunity-attack"
        )
        # Real caller identity reaches the engine RBAC — the REACTION being
        # spent belongs to the provoked attacker's controller, not to a
        # service principal.
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}
        # Ids-only payload coerced to UUIDs like every other proxy. The
        # session reference rides the PATH, not the body.
        assert captured["payload"] == {
            "attacker_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "orc-warlord")),
            "target_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "fleeing-mage")),
        }
        assert "seed" not in captured["payload"]
        assert "session_id" not in captured["payload"]

    def test_gm_identity_is_forwarded(self, monkeypatch):
        captured = self._capture(monkeypatch, {"is_hit": False})
        resp = client.post(
            "/api/v1/engine/opportunity-attack",
            params={"token": self._token("gm-1", "gm")},
            json=self.BODY,
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}

    def test_missing_token_is_401_and_invalid_token_is_401(self):
        assert (
            client.post("/api/v1/engine/opportunity-attack", json=self.BODY).status_code
            == 401
        ), "anonymous access must be refused"
        assert (
            client.post(
                "/api/v1/engine/opportunity-attack",
                params={"token": "garbage.token.value"},
                json=self.BODY,
            ).status_code
            == 401
        )

    def test_smuggled_seed_and_extra_fields_are_rejected_422(self):
        """Trust-inversion regression: no roll pins or math smuggled past the
        OA proxy."""
        token = self._token("gm-1", "gm")
        smuggles = {
            "seed": {**self.BODY, "seed": 42},
            "attack_bonus": {**self.BODY, "attack_bonus": 999},
            "damage_expression": {**self.BODY, "damage_expression": "99d99+99"},
            "advantage": {**self.BODY, "advantage": True},
            "action_index": {**self.BODY, "action_index": 3},
        }
        for case, body in smuggles.items():
            resp = client.post(
                "/api/v1/engine/opportunity-attack", params={"token": token}, json=body
            )
            assert resp.status_code == 422, case

    def test_engine_rejection_surfaces_verbatim(self, monkeypatch):
        async def rejected(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(
                409,
                '{"error": "NO_PENDING_OPPORTUNITY", '
                '"message": "no pending opportunity attack against this mover"}',
            )

        monkeypatch.setattr(engine_client, "engine_request", rejected)
        resp = client.post(
            "/api/v1/engine/opportunity-attack",
            params={"token": self._token("player-7", "player")},
            json=self.BODY,
        )
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "error": "NO_PENDING_OPPORTUNITY",
            "message": "no pending opportunity attack against this mover",
        }

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        resp = client.post(
            "/api/v1/engine/opportunity-attack",
            params={"token": self._token("gm-1", "gm")},
            json=self.BODY,
        )
        assert resp.status_code == 502
        assert "unreachable" in resp.json()["detail"].lower()


class TestInspirationSpendForwarding:
    """Iteration 64: the engine accepts an optional ``spend_inspiration`` flag
    on attack/check/save (iteration 56). The gateway schemas lagged and stripped
    it, so a client asking to burn its held point silently rolled straight.
    Regression: the flag must travel VERBATIM to the engine, and legacy payloads
    without it must be byte-for-byte unchanged (default False)."""

    @staticmethod
    def _token(user_id: str = "player-7", role: str = "player") -> str:
        import time as _time

        from vtt_orchestrator.server import _sign_token

        return _sign_token({"user_id": user_id, "role": role, "exp": _time.time() + 600})

    def _capture(self, monkeypatch, response):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return response

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        return captured

    def test_attack_forwards_spend_inspiration_true(self, monkeypatch):
        captured = self._capture(monkeypatch, {"natural_roll": 15, "is_hit": True})
        resp = client.post(
            "/api/v1/engine/attack",
            params={"token": self._token()},
            json={
                "session_id": "s",
                "attacker_id": "thorin",
                "target_id": "orc-warlord",
                "spend_inspiration": True,
            },
        )
        assert resp.status_code == 200
        assert captured["payload"]["spend_inspiration"] is True

    def test_check_forwards_spend_inspiration_true(self, monkeypatch):
        captured = self._capture(monkeypatch, {"roll": 18})
        resp = client.post(
            "/api/v1/engine/check",
            params={"token": self._token()},
            json={"modifier": 3, "dc": 12, "spend_inspiration": True},
        )
        assert resp.status_code == 200
        assert captured["payload"]["spend_inspiration"] is True
        # The rest of the legacy shape is untouched.
        assert captured["payload"]["modifier"] == 3
        assert captured["payload"]["dc"] == 12

    def test_save_forwards_spend_inspiration_true(self, monkeypatch):
        captured = self._capture(monkeypatch, {"roll": 14})
        resp = client.post(
            "/api/v1/engine/save",
            params={"token": self._token()},
            json={"save_modifier": 2, "dc": 10, "spend_inspiration": True},
        )
        assert resp.status_code == 200
        assert captured["payload"]["spend_inspiration"] is True

    def test_attack_false_is_forwarded_explicitly(self, monkeypatch):
        captured = self._capture(monkeypatch, {})
        resp = client.post(
            "/api/v1/engine/attack",
            params={"token": self._token()},
            json={
                "session_id": "s",
                "attacker_id": "a",
                "target_id": "b",
                "spend_inspiration": False,
            },
        )
        assert resp.status_code == 200
        assert captured["payload"]["spend_inspiration"] is False

    def test_legacy_payloads_without_the_field_are_unchanged(self, monkeypatch):
        """Back-compat: omitting the flag defaults to False everywhere and no
        other legacy field drifts."""
        cases = [
            (
                "/api/v1/engine/attack",
                {"session_id": "s", "attacker_id": "a", "target_id": "b"},
                {
                    "attacker_id": engine_client._coerce_uuid("a"),
                    "target_id": engine_client._coerce_uuid("b"),
                    "action_index": 0,
                },
                None,
            ),
            (
                "/api/v1/engine/check",
                {"modifier": 3, "dc": 12},
                {"modifier": 3, "dc": 12, "cost_margin": 3},
                None,
            ),
            (
                "/api/v1/engine/save",
                {"save_modifier": 2, "dc": 10, "ability": "wisdom"},
                {
                    "save_modifier": 2,
                    "dc": 10,
                    "ability": "WISDOM",
                    "advantage": False,
                    "disadvantage": False,
                    "conditions": [],
                },
                None,
            ),
        ]
        for path, body, expected_payload, _ in cases:
            captured = self._capture(monkeypatch, {"roll": 7})
            resp = client.post(path, params={"token": self._token()}, json=body)
            assert resp.status_code == 200, path
            expected = dict(expected_payload)
            expected.setdefault("spend_inspiration", False)
            assert captured["payload"] == expected, path
            monkeypatch.undo()


class TestEscapeGrappleProxy:
    """Iteration 64: gateway proxy for the engine's /action/escape-grapple
    route (iteration 49). Mirrors the grapple/shove maneuver contract exactly:
    ids-only Pydantic body with unknown fields refused, verified caller identity
    forwarded for engine RBAC, engine verdict surfaced verbatim, client seed
    never forwardable. The GM ``force`` override passes through as-is — the
    ENGINE re-checks privilege, the gateway does not second-guess it."""

    SESSION_ID = "7c6d5e4f-3a2b-4918-a7b6-c5d4e3f2a1b0"

    BODY = {
        "session_id": SESSION_ID,
        "entity_id": "grappled-hero",
        "grappler_id": "ogre",
        "skill": "acrobatics",
    }

    @staticmethod
    def _token(user_id: str = "player-7", role: str = "player") -> str:
        import time as _time

        from vtt_orchestrator.server import _sign_token

        return _sign_token({"user_id": user_id, "role": role, "exp": _time.time() + 600})

    def _capture(self, monkeypatch, response):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return response

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        return captured

    def test_forwards_identity_path_and_ids_only_payload(self, monkeypatch):
        captured = self._capture(monkeypatch, {"success": True, "escaped": True})
        resp = client.post(
            "/api/v1/engine/escape-grapple",
            params={"token": self._token("player-7", "player")},
            json=self.BODY,
        )
        assert resp.status_code == 200
        assert resp.json() == {"success": True, "escaped": True}
        assert captured["method"] == "POST"
        assert captured["path"] == (
            f"/api/v1/sessions/{self.SESSION_ID}/action/escape-grapple"
        )
        assert captured["actor"] == {"user_id": "player-7", "role": "player"}
        assert captured["payload"] == {
            "entity_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "grappled-hero")),
            "grappler_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "ogre")),
            "skill": "acrobatics",
        }
        assert "seed" not in captured["payload"]

    def test_gm_force_override_is_forwarded(self, monkeypatch):
        captured = self._capture(monkeypatch, {"escaped": True, "forced": True})
        resp = client.post(
            "/api/v1/engine/escape-grapple",
            params={"token": self._token("gm-1", "gm")},
            json={**self.BODY, "force": True},
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}
        assert captured["payload"]["force"] is True

    def test_athletics_skill_is_accepted(self, monkeypatch):
        captured = self._capture(monkeypatch, {"escaped": False})
        resp = client.post(
            "/api/v1/engine/escape-grapple",
            params={"token": self._token()},
            json={**self.BODY, "skill": "athletics"},
        )
        assert resp.status_code == 200
        assert captured["payload"]["skill"] == "athletics"

    def test_missing_token_is_401_and_invalid_token_is_401(self):
        assert (
            client.post("/api/v1/engine/escape-grapple", json=self.BODY).status_code
            == 401
        )
        assert (
            client.post(
                "/api/v1/engine/escape-grapple",
                params={"token": "not.a.valid.token"},
                json=self.BODY,
            ).status_code
            == 401
        )

    def test_unknown_skill_is_rejected_locally(self, monkeypatch):
        async def refuse(method, path, payload=None, *, actor=None):
            raise AssertionError("engine must not be called for an invalid skill")

        monkeypatch.setattr(engine_client, "engine_request", refuse)
        resp = client.post(
            "/api/v1/engine/escape-grapple",
            params={"token": self._token()},
            json={**self.BODY, "skill": "basket-weaving"},
        )
        assert resp.status_code == 422

    def test_extra_body_fields_are_rejected(self):
        """Trust-inversion regression: no seeds, no math, no auto-success."""
        token = self._token()
        for smuggle in ({"seed": 42}, {"auto_success": True}, {"dc_override": 1}):
            resp = client.post(
                "/api/v1/engine/escape-grapple",
                params={"token": token},
                json={**self.BODY, **smuggle},
            )
            assert resp.status_code == 422, smuggle

    def test_engine_rejection_is_surfaced_verbatim(self, monkeypatch):
        async def rejected(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(
                409, '{"error": "NOT_GRAPPLED", "message": "no active hold"}'
            )

        monkeypatch.setattr(engine_client, "engine_request", rejected)
        resp = client.post(
            "/api/v1/engine/escape-grapple",
            params={"token": self._token()},
            json=self.BODY,
        )
        assert resp.status_code == 409
        assert resp.json()["detail"] == {
            "error": "NOT_GRAPPLED",
            "message": "no active hold",
        }

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        resp = client.post(
            "/api/v1/engine/escape-grapple",
            params={"token": self._token()},
            json=self.BODY,
        )
        assert resp.status_code == 502
        assert "unreachable" in resp.json()["detail"].lower()

    def test_anonymous_case_registered_in_the_route_matrix(self):
        """The route joins the audit 401 matrix like every other proxy."""
        resp = client.post("/api/v1/engine/escape-grapple", json=self.BODY)
        assert resp.status_code == 401
        assert resp.json().get("detail")


class TestInspirationFiatProxies:
    """Iteration 64: GM-only gateway surfaces for the engine's iteration-60
    /inspiration/grant | /inspiration/revoke routes (SRD inspiration is GM
    fiat — players RECEIVE points, they never confer them). Gating mirrors the
    x-card/simulation-tick style at BOTH layers: the gateway refuses non-staff
    tokens 403 before dialing the engine, and the caller's real identity still
    rides the hop so the engine re-authorizes."""

    SESSION_ID = "5e4d3c2b-1a09-48f7-b6c5-d4e3f2a1b0c9"
    GRANT = {"session_id": SESSION_ID, "entity_id": "bard", "reason": "great plan"}
    REVOKE = {"session_id": SESSION_ID, "entity_id": "bard"}

    @staticmethod
    def _token(user_id: str = "gm-1", role: str = "gm") -> str:
        import time as _time

        from vtt_orchestrator.server import _sign_token

        return _sign_token({"user_id": user_id, "role": role, "exp": _time.time() + 600})

    def _capture(self, monkeypatch, response):
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured.update({"method": method, "path": path, "payload": payload})
            captured["actor"] = actor
            return response

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        return captured

    def test_player_token_is_403_and_never_dials_the_engine(self, monkeypatch):
        for suffix, body in (("grant", self.GRANT), ("revoke", self.REVOKE)):
            captured = self._capture(monkeypatch, {"status": "SHOULD_NOT_HAPPEN"})
            resp = client.post(
                f"/api/v1/engine/inspiration/{suffix}",
                params={"token": self._token("player-7", "player")},
                json=body,
            )
            assert resp.status_code == 403, suffix
            assert resp.json()["detail"], suffix
            assert captured == {}, f"{suffix}: player must not reach the engine"
            monkeypatch.undo()

    def test_gm_grant_forwards_identity_path_and_payload(self, monkeypatch):
        captured = self._capture(monkeypatch, {"status": "INSPIRATION_GRANTED"})
        resp = client.post(
            "/api/v1/engine/inspiration/grant",
            params={"token": self._token("gm-1", "gm")},
            json=self.GRANT,
        )
        assert resp.status_code == 200
        assert resp.json() == {"status": "INSPIRATION_GRANTED"}
        assert captured["method"] == "POST"
        assert captured["path"] == (
            f"/api/v1/sessions/{self.SESSION_ID}/inspiration/grant"
        )
        assert captured["actor"] == {"user_id": "gm-1", "role": "gm"}
        assert captured["payload"] == {
            "entity_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "bard")),
            "reason": "great plan",
        }

    def test_gm_revoke_forwards_identity_path_and_payload(self, monkeypatch):
        captured = self._capture(monkeypatch, {"status": "INSPIRATION_REVOKED"})
        resp = client.post(
            "/api/v1/engine/inspiration/revoke",
            params={"token": self._token("gm-2", "gm")},
            json=self.REVOKE,
        )
        assert resp.status_code == 200
        assert captured["path"] == (
            f"/api/v1/sessions/{self.SESSION_ID}/inspiration/revoke"
        )
        assert captured["actor"] == {"user_id": "gm-2", "role": "gm"}
        assert captured["payload"] == {
            "entity_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "bard"))
        }
        assert "reason" not in captured["payload"]

    def test_admin_token_is_accepted(self, monkeypatch):
        captured = self._capture(monkeypatch, {"status": "INSPIRATION_GRANTED"})
        resp = client.post(
            "/api/v1/engine/inspiration/grant",
            params={"token": self._token("admin-1", "admin")},
            json=self.REVOKE,
        )
        assert resp.status_code == 200
        assert captured["actor"] == {"user_id": "admin-1", "role": "admin"}

    def test_reason_is_optional_on_grant(self, monkeypatch):
        captured = self._capture(monkeypatch, {"status": "INSPIRATION_GRANTED"})
        resp = client.post(
            "/api/v1/engine/inspiration/grant",
            params={"token": self._token()},
            json={"session_id": self.SESSION_ID, "entity_id": "bard"},
        )
        assert resp.status_code == 200
        assert captured["payload"] == {
            "entity_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "bard"))
        }

    def test_missing_token_is_401_and_invalid_token_is_401(self):
        for suffix in ("grant", "revoke"):
            assert (
                client.post(
                    f"/api/v1/engine/inspiration/{suffix}", json=self.GRANT
                ).status_code
                == 401
            ), suffix
            assert (
                client.post(
                    f"/api/v1/engine/inspiration/{suffix}",
                    params={"token": "garbage.token"},
                    json=self.GRANT,
                ).status_code
                == 401
            ), suffix

    def test_extra_body_fields_are_rejected(self):
        token = self._token()
        resp = client.post(
            "/api/v1/engine/inspiration/grant",
            params={"token": token},
            json={**self.GRANT, "amount": 99},
        )
        assert resp.status_code == 422

    def test_unknown_session_or_entity_surfaces_verbatim(self, monkeypatch):
        async def rejected(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(
                404, '{"error": "ENTITY_NOT_FOUND"}'
            )

        monkeypatch.setattr(engine_client, "engine_request", rejected)
        resp = client.post(
            "/api/v1/engine/inspiration/revoke",
            params={"token": self._token()},
            json=self.REVOKE,
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == {"error": "ENTITY_NOT_FOUND"}

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        for suffix, body in (("grant", self.GRANT), ("revoke", self.REVOKE)):
            resp = client.post(
                f"/api/v1/engine/inspiration/{suffix}",
                params={"token": self._token()},
                json=body,
            )
            assert resp.status_code == 502, suffix
            assert "unreachable" in resp.json()["detail"].lower(), suffix


class TestMetricsProxy:
    """GET /api/v1/engine/metrics — read-only telemetry proxy.

    Audit remediation: this browser-facing proxy requires an attributable
    caller identity like every other /api/v1/engine/* route (a missing or
    expired token is a 401). The engine's GET /metrics itself sits on
    PUBLIC_PATHS (crates/vtt-server/src/auth.rs), so once the gateway has
    authenticated the caller it must NOT mint an actor token for the hop and
    must surface the engine's honest counters verbatim (no fabrication) with a
    502 when the engine is unreachable so clients can render a degraded state.
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

    def _get(self, **kwargs):
        return client.get(
            "/api/v1/engine/metrics", params={"token": _signed_token("admin-1", "admin")}, **kwargs
        )

    def test_metrics_without_a_token_is_unauthorized(self):
        """Audit remediation: anonymous dashboard reads are refused."""
        resp = client.get("/api/v1/engine/metrics")
        assert resp.status_code == 401
        assert resp.json()["detail"]

    def test_metrics_with_invalid_token_is_unauthorized(self):
        resp = client.get("/api/v1/engine/metrics", params={"token": "junk.token"})
        assert resp.status_code == 401

    def test_metrics_needs_no_actor_public_path(self, monkeypatch):
        """/metrics is unauthenticated on the engine, so no actor is forwarded."""
        captured: dict = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            captured["method"] = method
            captured["path"] = path
            captured["actor"] = actor
            return dict(self.ENGINE_METRICS)

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)

        resp = self._get()
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
        assert (
            client.post(
                "/api/v1/engine/metrics",
                params={"token": _signed_token("admin-1", "admin")},
            ).status_code
            == 405
        )

    def test_unreachable_engine_maps_to_502(self, monkeypatch):
        monkeypatch.setattr(engine_client, "ENGINE_API_URL", "http://localhost:59999")
        resp = self._get()
        assert resp.status_code == 502
        assert "unreachable" in resp.json()["detail"].lower()

    def test_engine_error_status_is_surfaced_verbatim(self, monkeypatch):
        async def fake_engine_request(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(404, '{"error": "not_found"}')

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = self._get()
        assert resp.status_code == 404
        assert resp.json()["detail"] == {"error": "not_found"}

    def test_unknown_counter_keys_are_dropped(self, monkeypatch):
        """The proxy whitelists counters; future engine fields do not leak."""

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            payload = dict(self.ENGINE_METRICS)
            payload["internal_debug_secret"] = "do-not-expose"
            return payload

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = self._get()
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

    def test_begin_without_a_token_is_unauthorized(self):
        resp = client.post("/api/v1/engine/combat/begin", json={"session_id": "s"})
        assert resp.status_code == 401, "missing credential is an honest 401"

    def test_end_without_a_token_is_unauthorized(self):
        resp = client.post("/api/v1/engine/combat/end", json={"session_id": "s"})
        assert resp.status_code == 401, "missing credential is an honest 401"

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
