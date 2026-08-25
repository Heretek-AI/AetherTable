"""HTTP surface for external platform imports (GOALS.md Pillar 10 interop).

Wires compendium/roll20_importer.py (previously library-only) onto the
existing character-storage API via POST /api/v1/import/roll20, and drives
Foundry module zips through POST /api/v1/import/foundry/upload — the multipart
transport that extracts the archive safely (zip-slip / absolute-path /
symlink rejection) inside a temp dir before delegating to the tested
compendium/foundry_importer.py library. POST /api/v1/import/foundry/preview
stays a deliberate 501 whose reasons list names only the limitations that are
STILL true (unsupported compendium pack types, LevelDB-format pack dirs,
projection-only import) — no longer a missing transport.

Storage is exercised for real against the in-memory backend that is the
test-suite default (DATABASE_URL unset -> init_storage() falls back to
MemoryStore), mirroring how test_lobbies_characters exercises persistence.
"""

import io
import json
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server
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


def test_foundry_preview_501_names_only_still_true_limitations(player):
    """Pins the updated 501 contract: the multipart TRANSPORT now exists
    (POST /api/v1/import/foundry/upload), so the stub must no longer claim a
    missing transport. What remains true — unsupported compendium pack types,
    LevelDB-format pack directories, projection-only import — is named
    instead, and callers are pointed at the working upload route."""
    resp = client.post(
        "/api/v1/import/foundry/preview",
        params={"token": player["token"]},
        json={"manifest": {"id": "some-module", "version": "1.0.0"}},
    )
    assert resp.status_code == 501, resp.text
    detail = resp.json()["detail"].lower()
    # The old excuse is gone; the transport exists.
    assert "require multipart" not in detail
    assert "deferred to a future iteration" not in detail
    # Still-true limitations are named honestly.
    assert "unsupported pack type" in detail or "pack types" in detail
    # And there is an honest pointer at the route that DOES work.
    assert "/api/v1/import/foundry/upload" in resp.json()["detail"].lower() or \
        "foundry/upload" in detail


# --- Foundry module upload (multipart zip) ---------------------------------------------


def _gm_token(name="gm_foundry"):
    from vtt_orchestrator.server import _sign_token

    user_id = f"{name}_{abs(hash(name + str(time.time()))) % 10**8}"
    return _sign_token({"user_id": user_id, "role": "gm", "exp": time.time() + 600})


def _goblin_actor():
    """Minimal dnd5e NPC actor document (one NDJSON line of an Export Pack)."""
    return {
        "_id": "act_goblin",
        "name": "Goblin Snapper",
        "type": "npc",
        "system": {
            "abilities": {"str": {"value": 15}, "dex": {"value": 14}},
            "attributes": {"ac": {"value": 13}, "hp": {"value": 7, "max": 7},
                           "speed": {"value": "30 ft."}},
        },
        "items": [{
            "_id": "itm_scimitar",
            "name": "Scimitar",
            "type": "weapon",
            "system": {"attack": {"bonus": "+4"},
                       "damage": {"parts": [["1d6+2", "slashing"]]}},
        }],
    }


def _potion_item():
    return {
        "_id": "itm_potion",
        "name": "Potion of Healing",
        "type": "consumable",
        "system": {"description": {"value": "<p>Heals 2d4+2.</p>"},
                   "rarity": "common", "price": {"value": 50, "denomination": "gp"},
                   "quantity": 1, "weight": {"value": 0.5}},
    }


def _module_manifest(packs=None):
    return {
        "id": "demo-module",
        "title": "Demo Module",
        "version": "1.0.0",
        "packs": packs if packs is not None else [
            {"name": "bestiary", "label": "Bestiary", "path": "packs/bestiary.db",
             "type": "Actor"},
            {"name": "gear", "label": "Gear", "path": "packs/gear.db", "type": "Item"},
        ],
    }


def _ndjson(docs):
    return "\n".join(json.dumps(d) for d in docs) + "\n"


def _module_zip_bytes(manifest=None, pack_bodies=None):
    """A minimal but REAL Foundry module layout zipped in memory."""
    manifest = manifest if manifest is not None else _module_manifest()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("demo-module/module.json", json.dumps(manifest))
        bodies = pack_bodies if pack_bodies is not None else {
            "packs/bestiary.db": _ndjson([_goblin_actor()]),
            "packs/gear.db": _ndjson([_potion_item()]),
        }
        for path, body in bodies.items():
            zf.writestr(f"demo-module/{path}", body)
    return buf.getvalue()


def _upload_foundry(payload: bytes, token: str, filename="demo-module.zip"):
    return client.post(
        "/api/v1/import/foundry/upload",
        params={"token": token},
        files={"file": (filename, payload, "application/zip")},
    )


def test_foundry_upload_happy_path_imports_module_end_to_end():
    """A real module zip flows through safe extraction into the tested
    importer library and returns its full projection envelope."""
    resp = _upload_foundry(_module_zip_bytes(), _gm_token())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["module"]["id"] == "demo-module"
    assert body["module"]["version"] == "1.0.0"
    assert body["imported"] == 2
    assert body["skipped"] == 0
    monster_names = {m["name"] for m in body["monsters"]}
    item_names = {i["name"] for i in body["items"]}
    assert monster_names == {"Goblin Snapper"}
    assert item_names == {"Potion of Healing"}
    goblin = next(m for m in body["monsters"])
    assert goblin["ac"] == 13
    assert goblin["hp"] == 7
    assert goblin["actions"][0]["damage_formula"] == "1d6+2"


def test_foundry_upload_requires_staff_role():
    """Import is a GM/admin operation: a plain player seat gets 403 and the
    archive is never extracted."""
    email = f"pl_fnd_{abs(hash(str(time.time()))) % 10**8}@example.com"
    signup = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": email.split("@")[0],
              "display_name": "Player One", "password": "dice-dice",
              "role": "player"},
    )
    assert signup.status_code == 200, signup.text
    resp = _upload_foundry(_module_zip_bytes(), signup.json()["token"])
    assert resp.status_code == 403, resp.text


def test_foundry_upload_requires_token():
    resp = client.post(
        "/api/v1/import/foundry/upload",
        files={"file": ("demo-module.zip", _module_zip_bytes(), "application/zip")},
    )
    assert resp.status_code == 401, resp.text


def test_foundry_upload_oversized_zip_rejected_413(monkeypatch):
    """Beyond the sanity bound the upload is refused with an honest 413
    BEFORE any extraction work."""
    monkeypatch.setattr(server, "_MAX_FOUNDRY_UPLOAD_BYTES", 512)
    bloated_zip = _module_zip_bytes(
        pack_bodies={"packs/bestiary.db": _ndjson([_goblin_actor()])
                     + ("x" * 4096)}
    )
    assert len(bloated_zip) > 512
    resp = _upload_foundry(bloated_zip, _gm_token())
    assert resp.status_code == 413, resp.text
    assert "byte" in resp.json()["detail"].lower()


def _zip_with_entries(entries):
    """entries: list of (ZipInfo-or-name, bytes)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            if isinstance(name, zipfile.ZipInfo):
                zf.writestr(name, data)
            else:
                zf.writestr(name, data)
    return buf.getvalue()


def test_foundry_upload_rejects_zip_slip_traversal_entry():
    """An entry escaping the extraction dir ('../evil.txt') must be rejected
    with a 4xx — never written outside the temp dir."""
    payload = _zip_with_entries([
        ("demo-module/module.json", json.dumps(_module_manifest())),
        ("../evil.txt", b"escaped"),
    ])
    resp = _upload_foundry(payload, _gm_token())
    assert resp.status_code == 422, resp.text
    assert "escap" in resp.json()["detail"].lower()


def test_foundry_upload_rejects_absolute_path_entry():
    payload = _zip_with_entries([
        ("demo-module/module.json", json.dumps(_module_manifest())),
        ("/tmp/absolute_evil.txt", b"absolute"),
    ])
    resp = _upload_foundry(payload, _gm_token())
    assert resp.status_code == 422, resp.text


def test_foundry_upload_rejects_symlink_entry():
    info = zipfile.ZipInfo("demo-modules-link")
    import stat as _stat
    info.external_attr = (_stat.S_IFLNK | 0o777) << 16
    info.create_system = 3  # unix
    payload = _zip_with_entries([
        (info, "/etc/passwd"),
        ("demo-module/module.json", json.dumps(_module_manifest())),
    ])
    resp = _upload_foundry(payload, _gm_token())
    assert resp.status_code == 422, resp.text
    assert "symlink" in resp.json()["detail"].lower()


def test_foundry_upload_malformed_archive_honest_422():
    """Bytes that are not a zip at all fail loud with 422, not a 500."""
    resp = _upload_foundry(b"this is definitely not a zip archive", _gm_token(),
                           filename="broken.zip")
    assert resp.status_code == 422, resp.text


def test_foundry_upload_archive_without_manifest_honest_422():
    """A valid zip that contains no module.json anywhere fails with the
    importer's own fail-loud ValueError surfaced as 422."""
    payload = _zip_with_entries([("readme.txt", b"not a foundry module")])
    resp = _upload_foundry(payload, _gm_token(), filename="empty.zip")
    assert resp.status_code == 422, resp.text
    assert "module.json" in resp.json()["detail"]


# --- F-A3#1: cumulative zip-bomb defense ----------------------------------------------
#
# The expansion bound is a WHOLE-ARCHIVE budget, not a per-entry allowance:
# (a) the declared uncompressed sizes are summed before anything is extracted,
# (b) the streamed copy enforces one running total across every entry, so a
# header that understates its real size is caught the moment the cumulative
# bytes cross the line, not N entries later.


def test_foundry_upload_many_honest_entries_cumulative_rejection(monkeypatch):
    """An archive of several HONEST entries, each well under the bound, still
    cannot expand past it in aggregate."""
    monkeypatch.setattr(server, "_MAX_FOUNDRY_EXTRACTED_BYTES", 100 * 1024)
    payload = _zip_with_entries([
        ("demo-module/module.json", json.dumps(_module_manifest())),
        ("demo-module/packs/a.db", b"A" * (40 * 1024)),
        ("demo-module/packs/b.db", b"B" * (40 * 1024)),
        ("demo-module/packs/c.db", b"C" * (40 * 1024)),
    ])
    resp = _upload_foundry(payload, _gm_token())
    assert resp.status_code == 422, resp.text


def _lying_entry_reader(declared, actual_bytes):
    """A duck-typed stand-in for ``ZipFile.open(info)`` whose header claims
    ``declared`` bytes but whose stream yields ``len(actual_bytes)``. CPython's
    zipfile caps reads at the DECLARED size, so a real archive cannot express
    this lie through ZipExtFile — but hand-rolled or patched writers can, and
    the copier must not trust that gap. Returns a zero-arg opener."""

    class _LyingStream:
        def __init__(self):
            self._buf = io.BytesIO(actual_bytes)

        def read(self, n=-1):
            return self._buf.read(n)

    return lambda: _LyingStream()


def test_copy_bounded_running_total_trips_mid_copy_on_lying_stream(tmp_path, monkeypatch):
    """F-A3#1 core: one entry whose stream is far larger than its declared
    header must be cut off MID-COPY by the cumulative budget — not granted a
    fresh per-entry allowance."""
    monkeypatch.setattr(server, "_MAX_FOUNDRY_EXTRACTED_BYTES", 64 * 1024)
    src = server._lying_entry_reader(declared=8, actual_bytes=b"Z" * (512 * 1024))()
    dst = tmp_path / "bomb.bin"
    with open(dst, "wb") as fh, pytest.raises(ValueError) as exc:
        server._copy_bounded(src, fh)
    assert "cumulative" in str(exc.value).lower()
    # Cut off mid-copy: at most the budget was ever written to disk.
    assert dst.stat().st_size <= 64 * 1024


def test_copy_bounded_budget_is_cumulative_across_entries(tmp_path, monkeypatch):
    """Two entries, each individually tiny against the budget: the SECOND must
    still be refused because together they cross the line. The extraction loop
    shares one draw-down budget across every entry, exactly as the upload
    route wires it."""
    monkeypatch.setattr(server, "_MAX_FOUNDRY_EXTRACTED_BYTES", 64 * 1024)
    first_src = server._lying_entry_reader(declared=48 * 1024,
                                           actual_bytes=b"A" * (48 * 1024))()
    second_src = server._lying_entry_reader(declared=48 * 1024,
                                            actual_bytes=b"B" * (48 * 1024))()

    class _Dst:
        def __init__(self):
            self.written = 0

        def write(self, chunk):
            self.written += len(chunk)

    dst = _Dst()
    shared_budget = [64 * 1024]
    copied = server._copy_bounded(first_src, dst, shared_budget)
    assert copied == 48 * 1024
    assert shared_budget[0] == 16 * 1024
    with pytest.raises(ValueError) as exc:
        server._copy_bounded(second_src, dst, shared_budget)
    assert "cumulative" in str(exc.value).lower()
    # The second entry wrote nothing beyond what fit in the remaining budget.
    assert dst.written <= 64 * 1024


def test_foundry_upload_declared_sizes_over_budget_refused_before_extraction(monkeypatch):
    """Headers that OVERSTATE their size get caught up front: once the sum of
    declared uncompressed sizes crosses the bound the upload is refused before
    any entry is extracted (the distinct 'declared' refusal)."""
    monkeypatch.setattr(server, "_MAX_FOUNDRY_EXTRACTED_BYTES", 200 * 1024)
    payload = _zip_with_entries([
        ("demo-module/module.json",
         json.dumps(_module_manifest()) + "\n" + " " * (120 * 1024)),
        ("demo-module/packs/a.db", "a" * (120 * 1024)),
    ])
    resp = _upload_foundry(payload, _gm_token())
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"].lower()
    assert "declares" in detail and "bound" in detail


def test_foundry_upload_normal_module_within_budget_still_imports(monkeypatch):
    """Guard against over-blocking: a real module whose declared and actual
    sizes sit comfortably inside the bound flows through untouched."""
    monkeypatch.setattr(server, "_MAX_FOUNDRY_EXTRACTED_BYTES", 100 * 1024)
    payload = _zip_with_entries([
        ("demo-module/module.json", json.dumps(_module_manifest())),
        ("demo-module/packs/bestiary.db", _ndjson([_goblin_actor()])),
        ("demo-module/packs/gear.db", _ndjson([_potion_item()])),
    ])
    resp = _upload_foundry(payload, _gm_token())
    assert resp.status_code == 200, resp.text
    assert resp.json()["imported"] == 2


def test_foundry_upload_accepts_module_at_zip_root():
    """Zips whose module.json sits at the archive root (no wrapper directory)
    are equally valid."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("module.json", json.dumps(_module_manifest()))
        zf.writestr("packs/bestiary.db", _ndjson([_goblin_actor()]))
    resp = _upload_foundry(buf.getvalue(), _gm_token())
    assert resp.status_code == 200, resp.text
    assert resp.json()["monsters"][0]["name"] == "Goblin Snapper"
