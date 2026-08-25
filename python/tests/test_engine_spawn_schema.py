"""Strict-schema gate on POST /api/v1/engine/spawn.

The gateway is a trust boundary: the engine's own AddEntityReq accepts an
explicit stat block (attack bonuses, AC, HP live on the server-side
EntityState), so the ONLY thing standing between an authenticated caller and
arbitrary client-minted stats was the gateway's untyped
``entity: Dict[str, Any]``. These tests pin the gateway to the canonical
EntityState field set (mirrored from crates/vtt-core/src/state.rs) with
deny-extra semantics: smuggled math fields are structurally impossible here,
the same way they already are on the ids-only attack route.

The malformed-body cases need no engine; the forwarding cases stub
engine_client.engine_request so they run in CI without the Rust binary.
"""

import time
import uuid

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.routing import engine_client
from vtt_orchestrator.server import _sign_token, app

client = TestClient(app)

GM_TOKEN = _sign_token({"user_id": "spawn-gm", "role": "gm", "exp": time.time() + 600})
AUTH = {"params": {"token": GM_TOKEN}}


def _valid_entity(entity_id=None) -> dict:
    """Canonical EntityState spawn payload (mirrors vtt_core::EntityState)."""
    return {
        "id": str(entity_id or uuid.uuid4()),
        "compendium_id": "monster_training_dummy",
        "name": "Training Dummy",
        "is_player": False,
        "current_hp": 500,
        "max_hp": 500,
        "temp_hp": 0,
        "ac": 13,
        "speed_feet": 0.0,
        "position": [8.0, 8.0, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {"strength": 10, "dexterity": 10, "constitution": 10,
                      "intelligence": 10, "wisdom": 10, "charisma": 10},
        "conditions": [],
        "action_budget": {"action": False, "bonus_action": False, "reaction": False,
                          "movement_remaining_feet": 0.0,
                          "free_object_interaction": False},
        "spell_slots_remaining": {},
        "attacks": [],
        "resistances": [],
        "vulnerabilities": [],
        "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": True,
        "is_dead": False,
        "is_visible": True,
    }


def _spawn(entity) -> object:
    return client.post(
        "/api/v1/engine/spawn",
        json={"session_id": "11111111-1111-1111-1111-111111111111", "entity": entity},
        **AUTH,
    )


@pytest.fixture()
def forwarded(monkeypatch):
    """Stub the engine call; returns the dict of captured call arguments."""
    seen = {}

    async def fake_engine_request(method, path, payload=None, *, actor=None):
        seen["method"], seen["path"], seen["payload"], seen["actor"] = (
            method, path, payload, actor,
        )
        return {"status": "SPAWNED", "entity_id": (payload or {}).get("id")}

    monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
    return seen


# --- Red-phase contract: malformed bodies are structurally rejected ----------


class TestStrictSpawnSchema:
    def test_valid_statblock_is_forwarded(self, forwarded):
        entity = _valid_entity()
        resp = _spawn(entity)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "SPAWNED"
        assert forwarded["method"] == "POST"
        assert "/api/v1/sessions/11111111-1111-1111-1111-111111111111/entities" \
            in forwarded["path"]
        assert forwarded["payload"] == entity

    def test_unknown_top_level_field_rejected(self):
        entity = _valid_entity()
        entity["homebrew_shield_bonus"] = 9  # not part of EntityState
        assert _spawn(entity).status_code == 422

    def test_smuggled_math_field_rejected(self):
        # The trust-inversion this schema exists to close: a caller minting a
        # top-level attack bonus outside the stat block.
        entity = _valid_entity()
        entity["attack_bonus"] = 99
        assert _spawn(entity).status_code == 422

    def test_smuggled_ac_override_field_rejected(self):
        entity = _valid_entity()
        entity["natural_armor"] = 25
        assert _spawn(entity).status_code == 422

    def test_nested_unknown_ability_field_rejected(self):
        entity = _valid_entity()
        entity["abilities"]["luck"] = 30
        assert _spawn(entity).status_code == 422

    def test_attack_damage_type_is_constrained(self):
        entity = _valid_entity()
        entity["attacks"] = [{
            "name": "Doom Blast", "attack_bonus": 12,
            "damage_expression": "20d20+90", "damage_type": "explosive",
        }]
        assert _spawn(entity).status_code == 422

    def test_missing_required_field_rejected(self):
        entity = _valid_entity()
        del entity["ac"]
        assert _spawn(entity).status_code == 422

    def test_non_conforming_field_type_rejected(self):
        entity = _valid_entity()
        entity["ac"] = "very high"
        assert _spawn(entity).status_code == 422

    def test_ingress_still_optional_and_forwarded(self, forwarded):
        ingress = {
            "entity_id": forwarded.get("x") or str(uuid.uuid4()),
            "ingress_type": "SPAWN_EVENT",
            "source_point": [0.0, 0.0, 0.0],
            "target_point": [3.0, 4.0, 0.0],
            "verified": False,
        }
        resp = client.post(
            "/api/v1/engine/spawn",
            json={"session_id": "11111111-1111-1111-1111-111111111111",
                  "entity": _valid_entity(), "ingress": ingress},
            **AUTH,
        )
        assert resp.status_code == 200, resp.text
        assert forwarded["payload"]["ingress"]["ingress_type"] == "SPAWN_EVENT"

    def test_owner_player_id_accepted_and_forwarded(self, forwarded):
        entity = _valid_entity()
        entity["owner_player_id"] = "spawn-gm"
        assert _spawn(entity).status_code == 200
        assert forwarded["payload"]["owner_player_id"] == "spawn-gm"

    def test_deploy_payload_conforms_to_strict_schema(self, monkeypatch):
        """deploy_character materializes the same EntityState shape — it must
        satisfy the same strict schema it enforces on clients."""
        import asyncio

        from vtt_orchestrator import server as server_mod
        from vtt_orchestrator.server import EngineSpawnEntity

        record = asyncio.run(server_mod.storage_backend.create_character(
            "spawn-gm",
            {
                "name": "Schema Kara", "character_class": "fighter", "level": 5,
                "race": "", "background": "", "alignment": "",
                "abilities": {"STR": 16, "DEX": 14, "CON": 14,
                              "INT": 10, "WIS": 12, "CHA": 8},
                "hp": 44, "ac": 18, "speed": 30,
                "features": [], "spells": [],
            },
        ))

        seen = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            seen["payload"] = payload
            return {"entity_id": payload["id"]}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = client.post(
            f"/api/v1/characters/{record['character_id']}/deploy",
            params={"token": GM_TOKEN},
            json={"session_id": "sess-schema", "x": 1.0, "y": 2.0},
        )
        assert resp.status_code == 200, resp.text
        payload = dict(seen["payload"])
        ingress = payload.pop("ingress")
        # Validates against the canonical strict model — no extra keys, all
        # required fields present, nested shapes conforming.
        EngineSpawnEntity.model_validate(payload)
        assert set(ingress) == {
            "entity_id", "ingress_type", "source_point", "target_point", "verified",
        }


# --- F10 red-phase: magnitude bounds on spawnable stats ----------------------
#
# The engine's AddEntityReq accepts an explicit stat block verbatim and its
# dice parser (crates/vtt-core/src/dice.rs) allows constant terms up to
# +-1e9 each, so a caller who could mint AC 2^31-1 / HP 2^31-1 through the
# gateway would create a mechanically unhittable, unkillable entity. These
# tests pin the gateway to generous-but-sane 5e statblock magnitudes.


class TestSpawnMagnitudeBounds:
    """Out-of-bounds stat magnitudes are structurally impossible at the gateway."""

    @pytest.mark.parametrize("field,value", [
        ("ac", -1),
        ("ac", 31),
        ("ac", 2**31 - 1),
        ("current_hp", -1),
        ("current_hp", 1001),
        ("max_hp", -1),
        ("max_hp", 1001),
        ("temp_hp", -1),
        ("temp_hp", 101),
    ])
    def test_int_stat_outside_bounds_rejected(self, field, value):
        entity = _valid_entity()
        entity[field] = value
        resp = _spawn(entity)
        assert resp.status_code == 422, f"{field}={value} must be refused"
        assert field in resp.text, "422 must name the offending field"

    def test_speed_feet_must_be_finite_bounded_non_negative(self):
        # 0 ft is legitimate (stationary training dummies / campaign_sim
        # hostile dummy); negative, oversized, and non-finite speeds are not.
        for bad in (-0.5, 200.5, float("inf"), float("nan")):
            entity = _valid_entity()
            entity["speed_feet"] = bad
            resp = _spawn(entity)
            assert resp.status_code == 422, f"speed_feet={bad} must be refused"

    def test_spell_slots_keys_and_values_bounded(self):
        bad_key = _valid_entity()
        bad_key["spell_slots_remaining"] = {10: 2}
        assert _spawn(bad_key).status_code == 422

        bad_value = _valid_entity()
        bad_value["spell_slots_remaining"] = {3: 51}
        assert _spawn(bad_value).status_code == 422

    def test_action_budget_movement_remaining_bounded(self):
        entity = _valid_entity()
        entity["action_budget"]["movement_remaining_feet"] = -1.0
        # already ge=0 — pin that this stays true while magnitude work lands
        assert _spawn(entity).status_code == 422

    def test_speed_feet_must_be_finite_bounded_non_negative(self):
        # 0 ft is legitimate (stationary training dummies / campaign_sim
        # hostile dummy); negative, oversized, and non-finite speeds are not.
        # Non-finite floats cannot be JSON-encoded by the test client, so the
        # finite check is asserted directly against the model.
        from vtt_orchestrator.server import EngineSpawnEntity
        for bad in (-0.5, 200.5):
            entity = _valid_entity()
            entity["speed_feet"] = bad
            resp = _spawn(entity)
            assert resp.status_code == 422, f"speed_feet={bad} must be refused"
        for bad in (float("inf"), float("nan")):
            entity = _valid_entity()
            entity["speed_feet"] = bad
            with pytest.raises(Exception):
                EngineSpawnEntity.model_validate(entity)

    def test_ingress_non_finite_coordinates_rejected_at_model(self):
        """inf/nan can't ride through the JSON client; assert at the model."""
        from vtt_orchestrator.server import EngineIngressEvent
        base = {
            "entity_id": str(uuid.uuid4()),
            "ingress_type": "PORTAL_DOOR",
            "source_point": [0.0, 0.0, 0.0],
            "target_point": [float("inf"), 0.0, 0.0],
            "verified": False,
        }
        with pytest.raises(Exception):
            EngineIngressEvent.model_validate(base)

    def test_attack_damage_expression_accepts_legitimate_math(self, forwarded):
        legit = ["1d12+3", "2d6", "1d4 + 1", "10d6 + 40", "7d8 + 30",
                 "-1d4", "+2", "40d12", "3d6-2", "1d20"]
        for expr in legit:
            entity = _valid_entity()
            entity["attacks"] = [{
                "name": "Steel Strike", "attack_bonus": 5,
                "damage_expression": expr, "damage_type": "slashing",
            }]
            resp = _spawn(entity)
            assert resp.status_code == 200, \
                f"legitimate compendium-grade {expr!r} must not be broken: {resp.text}"

    def test_attack_damage_grammar_rejects_absurd_math_without_engine(self):
        absurd = ["9999d9999", "1d1000000", "1000000d6",
                  f"{2**31}+0", "1d8*2", "1d8d8", "(1d8)+3",
                  "1d8 + 999999999"]
        for expr in absurd:
            from vtt_orchestrator.server import SpawnAttackAction
            with pytest.raises(Exception):
                SpawnAttackAction.model_validate({
                    "name": "Doom Blast", "attack_bonus": 12,
                    "damage_expression": expr, "damage_type": "fire",
                })

    def test_ingress_unknown_field_rejected(self):
        """The ingress blob is typed now: smuggled fields are a 422."""
        ingress = {
            "entity_id": str(uuid.uuid4()),
            "ingress_type": "TELEPORTATION",
            "source_point": [0.0, 0.0, 0.0],
            "target_point": [3.0, 4.0, 0.0],
            "verified": False,
            "gm_note": "smuggled payload",
        }
        resp = client.post(
            "/api/v1/engine/spawn",
            json={"session_id": "11111111-1111-1111-1111-111111111111",
                  "entity": _valid_entity(), "ingress": ingress},
            **AUTH,
        )
        assert resp.status_code == 422

    def test_ingress_out_of_bounds_coordinates_rejected(self):
        base = {
            "entity_id": str(uuid.uuid4()),
            "ingress_type": "PORTAL_DOOR",
            "source_point": [0.0, 0.0, 0.0],
            "target_point": [3.0, 4.0, 0.0],
            "verified": False,
        }
        off_board = {**base, "target_point": [99999.0, 0.0, 0.0]}
        resp = client.post(
            "/api/v1/engine/spawn",
            json={"session_id": "11111111-1111-1111-1111-111111111111",
                  "entity": _valid_entity(), "ingress": off_board},
            **AUTH,
        )
        assert resp.status_code == 422

        bad_type = {**base, "ingress_type": "wormhole"}
        resp = client.post(
            "/api/v1/engine/spawn",
            json={"session_id": "11111111-1111-1111-1111-111111111111",
                  "entity": _valid_entity(), "ingress": bad_type},
            **AUTH,
        )
        assert resp.status_code == 422

    def test_deploy_payload_still_conforms_with_bounds(self, monkeypatch):
        """deploy_character materializes the same EntityState shape — it must
        satisfy the bounded schema too (regression guard for iteration 15)."""
        import asyncio

        from vtt_orchestrator import server as server_mod
        from vtt_orchestrator.server import EngineIngressEvent, EngineSpawnEntity

        record = asyncio.run(server_mod.storage_backend.create_character(
            "spawn-gm",
            {
                "name": "Bounded Kara", "character_class": "fighter", "level": 5,
                "race": "", "background": "", "alignment": "",
                "abilities": {"STR": 16, "DEX": 14, "CON": 14,
                              "INT": 10, "WIS": 12, "CHA": 8},
                "hp": 44, "ac": 18, "speed": 30,
                "features": [], "spells": [],
            },
        ))
        seen = {}

        async def fake_engine_request(method, path, payload=None, *, actor=None):
            seen["payload"] = payload
            return {"entity_id": payload["id"]}

        monkeypatch.setattr(engine_client, "engine_request", fake_engine_request)
        resp = client.post(
            f"/api/v1/characters/{record['character_id']}/deploy",
            params={"token": GM_TOKEN},
            json={"session_id": "sess-schema", "x": 1.0, "y": 2.0},
        )
        assert resp.status_code == 200, resp.text
        payload = dict(seen["payload"])
        ingress = payload.pop("ingress")
        EngineSpawnEntity.model_validate(payload)
        EngineIngressEvent.model_validate(ingress)
