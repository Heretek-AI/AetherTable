"""HTTP surface for external platform imports (GOALS.md Pillar 10 interop).

Wires compendium/roll20_importer.py (previously library-only) onto the
existing character-storage API via POST /api/v1/import/roll20, and pins the
DELIBERATE 501 contract of POST /api/v1/import/foundry/preview (Foundry
modules are directory trees — module.json plus NDJSON pack files — which
cannot arrive as one JSON body; receiving them needs multipart upload
support, deferred to a future iteration).

Storage is exercised for real against the in-memory backend that is the
test-suite default (DATABASE_URL unset -> init_storage() falls back to
MemoryStore), mirroring how test_lobbies_characters exercises persistence.
"""

import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator.server import app

client = TestClient(app)

_MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024  # mirrors server._MAX_IMPORT_BODY_BYTES


def _signup(name: str) -> dict:
    email = f"{name}_{abs(hash(name + str(time.time()))) % 10**8}@example.com"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": name, "display_name": name.title(),
              "password": "dice-dice", "role": "player"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture()
def player():
    return _signup("importbot")


@pytest.fixture()
def outsider():
    return _signup("outsiderbot")


def _attr(name, current, max_=None):
    attr = {"name": name, "current": current}
    if max_ is not None:
        attr["max"] = max_
    return attr


def _thorin(doc_id="chr_thorin"):
    """Realistic 5e OGL-sheet single-character Roll20 export."""
    return {
        "schema_version": 1,
        "id": doc_id,
        "name": "Thorin",
        "attribs": [
            _attr("strength", "15"), _attr("strength_mod", "+2"),
            _attr("dexterity", "14"), _attr("dexterity_mod", "+2"),
            _attr("constitution", "13"), _attr("constitution_mod", "+1"),
            _attr("intelligence", "10"), _attr("intelligence_mod", "0"),
            _attr("wisdom", "8"), _attr("wisdom_mod", "-1"),
            _attr("charisma", "7"), _attr("charisma_mod", "-2"),
            _attr("hp", "22", max_="26"),
            _attr("ac", "16"),
            _attr("speed", "30 ft."),
            _attr("race", "Hill Dwarf"),
            _attr("background", "Soldier"),
            _attr("alignment", "Neutral Good"),
            _attr("class", "Fighter"),
            _attr("level", "5"),
        ],
    }


def _brann(doc_id="chr_brann"):
    doc = _thorin(doc_id)
    doc["name"] = "Brann"
    doc["attribs"] = [
        _attr("strength", "16"), _attr("dexterity", "12"),
        _attr("constitution", "14"), _attr("intelligence", "8"),
        _attr("wisdom", "10"), _attr("charisma", "12"),
        _attr("hp", "30", max_="30"),
        _attr("ac", "18"), _attr("speed", "25 ft."),
        _attr("class", "Barbarian"), _attr("level", "4"),
    ]
    return doc


# --- Roll20 import -------------------------------------------------------------------

def test_roll20_campaign_import_persists_owned_characters(player, outsider):
    """A campaign export persists N characters owned by the CALLER, visible
    through the ordinary GET /api/v1/characters owner-scoped listing."""
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": [_thorin(), _brann()]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 2
    assert body["skipped"] == 0
    assert set(body) >= {"imported", "skipped", "warnings", "characters"}
    names = {c["name"] for c in body["characters"]}
    assert names == {"Thorin", "Brann"}
    assert all(c["character_id"] for c in body["characters"])

    # Persisted under the caller's ownership and retrievable via the normal
    # character-storage API.
    mine = client.get("/api/v1/characters", params={"token": player["token"]})
    assert mine.status_code == 200
    listed = {c["character_id"]: c for c in mine.json()["characters"]}
    for imported in body["characters"]:
        assert imported["character_id"] in listed
        assert listed[imported["character_id"]]["owner_user_id"] == player["user"]["id"]
        assert listed[imported["character_id"]]["name"] == imported["name"]

    # Not visible to another account (ownership sticks to the importer).
    foreign = client.get("/api/v1/characters", params={"token": outsider["token"]})
    assert not any(
        c["character_id"] in {c["character_id"] for c in body["characters"]}
        for c in foreign.json()["characters"]
    )


def test_roll20_single_character_import_maps_canon_fields(player):
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": _thorin()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1
    assert body["skipped"] == 0

    record = client.get(
        f"/api/v1/characters/{body['characters'][0]['character_id']}",
        params={"token": player["token"]},
    )
    assert record.status_code == 200, record.text
    stored = record.json()
    assert stored["name"] == "Thorin"
    assert stored["character_class"] == "fighter"  # normalized from "Fighter"
    assert stored["level"] == 5
    data = stored["data"]
    assert data["abilities"]["STR"] == 15
    assert data["abilities"]["CHA"] == 7
    assert data["hp"] == 22
    assert data["ac"] == 16
    assert data["speed"] == 30  # '30 ft.' normalized to feet
    assert data["race"] == "Hill Dwarf"
    assert data["alignment"] == "Neutral Good"


def test_roll20_import_garbage_maps_valueerror_to_422(player):
    """Fail-loud importer ValueErrors surface as 422s carrying the reason."""
    for garbage in (
        {"not_a_roll20_export": True},          # object with neither attribs nor characters
        ["a", "list", "of", "strings"],         # malformed campaign entries
        "just a string",                        # not a mapping at all
        [],                                     # empty campaign
    ):
        resp = client.post(
            "/api/v1/import/roll20",
            params={"token": player["token"]},
            json={"character_json": garbage},
        )
        assert resp.status_code == 422, (garbage, resp.status_code, resp.text)
        # Either the fail-loud ValueError from the importer itself, or — for
        # campaigns whose every member is malformed — the gateway's
        # nothing-persisted refusal carrying the per-member skip reasons.
        assert "Roll20CharacterImporter" in resp.json()["detail"] or \
            "persisted no characters" in resp.json()["detail"]


def test_roll20_import_oversized_body_rejected(player):
    """A body beyond the 2MB sanity bound is refused with 413 (or 422 where
    the framework rejects the oversized document first)."""
    bloated = {
        "schema_version": 1,
        "name": "Bloat",
        "attribs": [_attr("padding", "x" * (_MAX_IMPORT_BODY_BYTES))],
    }
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": bloated},
    )
    assert resp.status_code in (413, 422)


def test_roll20_import_requires_token(player):
    """No token anywhere -> 401 from _require_auth, never a partial import."""
    resp = client.post("/api/v1/import/roll20", json={"character_json": _thorin()})
    assert resp.status_code == 401
    # ...and nothing was persisted for anyone.
    mine = client.get("/api/v1/characters", params={"token": player["token"]})
    assert all(c["name"] != "Thorin" for c in mine.json()["characters"])


def test_roll20_import_skips_unnamed_and_reports_warnings(player):
    """Malformed campaign members land in skipped+warnings, not in storage."""
    campaign = [_thorin(), {"id": "chr_ghost", "attribs": []}]  # second unnamed
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": campaign},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1
    assert body["skipped"] == 1
    assert any("unnamed" in w for w in body["warnings"])
    assert [c["name"] for c in body["characters"]] == ["Thorin"]


# --- Honest identity handling: no fabricated defaults ----------------------------------

def test_roll20_export_lacking_identity_fields_warns_and_persists_neutral(player):
    """An export with no class/level/race/background/alignment attribs must
    NOT be persisted as an invented fighter/Human/Soldier — the response
    warnings name every missing field, and storage holds neutral values."""
    doc = _thorin()
    doc["name"] = "Blank Slate"
    doc["attribs"] = [
        a for a in doc["attribs"]
        if a["name"] not in {"class", "level", "race", "background", "alignment"}
    ]
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": doc},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    warnings = " || ".join(body["warnings"]).lower()
    for field in ("class", "level", "race", "background", "alignment"):
        assert field in warnings, f"no warning naming {field!r}: {body['warnings']}"

    record = client.get(
        f"/api/v1/characters/{body['characters'][0]['character_id']}",
        params={"token": player["token"]},
    ).json()
    # Neutral values, never invented identities.
    assert record["character_class"] == ""
    data = record["data"]
    assert data["character_class"] == ""
    assert data["race"] == ""
    assert data["background"] == ""
    assert data["alignment"] == ""
    assert record["level"] == 1  # allowed default, but warned about above


def test_roll20_export_with_class_does_not_invent_or_warn_identity(player):
    """Present identity fields flow through unchanged with no substitution
    warning — the honesty warnings only fire for genuinely absent fields."""
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": _thorin()},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1
    joined = " ".join(body["warnings"]).lower()
    for field in ("class", "race", "background", "alignment"):
        assert f"{field} not present" not in joined


def test_roll20_unparsable_speed_warns_without_fabricating_30(player):
    """A movement string the importer cannot reduce to feet ('walk 30 ft.')
    must surface as a warning and never be silently replaced by the
    create-route default of 30 as if the sheet had said so."""
    doc = _thorin()
    doc["name"] = "Slow Walker"
    doc["attribs"] = [
        _attr("speed", "walk 30 ft.") if a["name"] == "speed" else a
        for a in doc["attribs"]
    ]
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": doc},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    warnings = " || ".join(body["warnings"]).lower()
    assert "unparsable" in warnings and "speed" in warnings

    record = client.get(
        f"/api/v1/characters/{body['characters'][0]['character_id']}",
        params={"token": player["token"]},
    ).json()
    assert record["data"]["speed"] != 30  # nothing fabricated as authoritative


@pytest.mark.parametrize("raw_level,clamped", [("25", 20), ("0", 1), ("-3", 1)])
def test_roll20_out_of_range_level_clamps_with_warning(player, raw_level, clamped):
    """A level outside 1..20 is clamped into range — but never silently.
    The response warnings must name the clamp (disclosure contract), the way
    missing identity fields and unparsable speed already do."""
    doc = _thorin()
    doc["name"] = f"Clamped {raw_level}"
    doc["attribs"] = [
        _attr("level", raw_level) if a["name"] == "level" else a
        for a in doc["attribs"]
    ]
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": doc},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 1
    assert any(
        "level out of range" in w.lower() and "clamp" in w.lower()
        for w in body["warnings"]
    ), body["warnings"]

    record = client.get(
        f"/api/v1/characters/{body['characters'][0]['character_id']}",
        params={"token": player["token"]},
    ).json()
    assert record["level"] == clamped


def test_roll20_in_range_level_emits_no_clamp_warning(player):
    """The clamp warning only fires for genuinely out-of-range levels."""
    resp = client.post(
        "/api/v1/import/roll20",
        params={"token": player["token"]},
        json={"character_json": _thorin()},  # level 5
    )
    assert resp.status_code == 200, resp.text
    assert not any("level out of range" in w.lower() for w in resp.json()["warnings"])


# --- Foundry preview: deliberate 501 stub ---------------------------------------------

def test_foundry_preview_is_deliberate_501_contract(player):
    """Pins the deliberate stub: Foundry modules are DIRECTORY trees
    (module.json + NDJSON pack files), so they cannot arrive as one JSON
    body. Until multipart upload exists the route answers 501 NOT_IMPLEMENTED
    with an explanation naming what's missing — never a fake success."""
    resp = client.post(
        "/api/v1/import/foundry/preview",
        params={"token": player["token"]},
        json={"manifest": {"id": "some-module", "version": "1.0.0"}},
    )
    assert resp.status_code == 501, resp.text
    detail = resp.json()["detail"].lower()
    assert "multipart" in detail
    assert "directory" in detail or "module" in detail
