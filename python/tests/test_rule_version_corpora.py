"""Iteration 37: per-session SRD rule-version corpus selection in the gateway.

Iteration 34 (0f76cea) made the engine persist and expose a per-session
``rule_version`` ("srd_5_1" | "srd_5_2") on GET /api/v1/sessions/{id}, but the
gateway still hardcoded the SRD 5.2 compendium fixtures at startup with no
version concept at all: a 5.1 table got 5.2 spell/statblock data from every
compendium route and every narrative-grounding call.

Contract under test:

* Startup loads BOTH corpora when both fixture sets exist, logged once; the
  default corpus (served to callers who name no session) stays the richer 5.2
  set so existing clients see no behavior change.
* Routes where version actually matters — spell/statblock lookup
  (/api/v1/compendium/spells, /monsters), lore lookup, and narrative
  grounding — prefer the named session's rule_version from the live engine.
* A missing/unreachable/unknown-version session degrades honestly to the
  default corpus, and every response carries provenance: ``rule_version``,
  ``rule_version_source`` ("session" | "default" | "default_fallback") and,
  only on fallback, a human-readable ``rule_version_reason``.
"""

import json
import time

import pytest
from fastapi.testclient import TestClient

import vtt_orchestrator.routing.engine_client as engine_client
from vtt_orchestrator.server import (
    _sign_token,
    app,
    compendium_corpora,
    default_rule_version,
)

client = TestClient(app)


def _auth(uid: str = "usr_rv", role: str = "player") -> str:
    return _sign_token({"user_id": uid, "role": role, "exp": time.time() + 600})


def _engine_snapshot(rule_version):
    """Stub of GET /api/v1/sessions/{id}: only rule_version matters here."""

    async def _fake(method, path, payload=None, *, actor=None):
        assert method == "GET" and "/api/v1/sessions/" in path
        body = {"entities": {}}
        if rule_version is not None:
            body["rule_version"] = rule_version
        return body

    return _fake


def _get(path, **params):
    return client.get(
        path,
        params=params,
        headers={"Authorization": "Bearer " + _auth()},
    )


class TestStartupCorpusLoading:
    def test_both_corpora_loaded_when_fixtures_present(self):
        # Both fixture sets ship in compendium/, so both corpora must be live.
        assert set(compendium_corpora) == {"srd_5_1", "srd_5_2"}
        for version, corpus in compendium_corpora.items():
            assert corpus["spells"], f"{version} spells must be non-empty"
            assert corpus["monsters"], f"{version} monsters must be non-empty"

    def test_corpora_are_actually_different_editions(self):
        # Guard against accidentally loading the same file twice and "passing".
        s51 = {s["name"] for s in compendium_corpora["srd_5_1"]["spells"]}
        s52 = {s["name"] for s in compendium_corpora["srd_5_2"]["spells"]}
        assert "Feeblemind" in s51 and "Feeblemind" not in s52
        m51 = {m["name"] for m in compendium_corpora["srd_5_1"]["monsters"]}
        m52 = {m["name"] for m in compendium_corpora["srd_5_2"]["monsters"]}
        assert "Acolyte" in m51 and "Acolyte" not in m52

    def test_default_corpus_is_the_richer_52_set(self):
        # Legacy behavior preserved for callers that name no session.
        assert default_rule_version == "srd_5_2"


class TestSessionScopedCompendiumRoutes:
    def test_session_stamped_5_2_gets_5_2_spells(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_snapshot("srd_5_2")
        )
        resp = _get(
            "/api/v1/compendium/spells",
            q="Branding Smite",
            engine_session_id="sess-52",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 0, "Branding Smite does not exist in SRD 5.2"
        assert body["rule_version"] == "srd_5_2"
        assert body["rule_version_source"] == "session"

    def test_session_stamped_5_1_gets_5_1_spells(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_snapshot("srd_5_1")
        )
        resp = _get(
            "/api/v1/compendium/spells",
            q="Feeblemind",
            engine_session_id="sess-51",
        )
        assert resp.status_code == 200
        body = resp.json()
        names = [s["name"] for s in body["spells"]]
        assert "Feeblemind" in names
        assert body["rule_version"] == "srd_5_1"
        assert body["rule_version_source"] == "session"

    def test_session_stamped_5_1_gets_5_1_monsters(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_snapshot("srd_5_1")
        )
        resp = _get(
            "/api/v1/compendium/monsters",
            q="Acolyte",
            engine_session_id="sess-51",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert any(m["name"] == "Acolyte" for m in body["monsters"])
        assert body["rule_version"] == "srd_5_1"

    def test_session_stamped_5_2_monsters_exclude_51_entry(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_snapshot("srd_5_2")
        )
        resp = _get(
            "/api/v1/compendium/monsters",
            q="Acolyte",
            engine_session_id="sess-52",
        )
        body = resp.json()
        assert not [m for m in body["monsters"] if m["name"].startswith("Acolyte")]

    def test_no_session_gets_default_corpus_and_default_provenance(self):
        resp = _get("/api/v1/compendium/spells", q="Fireball")
        assert resp.status_code == 200
        body = resp.json()
        assert body["rule_version"] == default_rule_version
        assert body["rule_version_source"] == "default"
        assert "rule_version_reason" not in body


class TestHonestFallback:
    def test_unreachable_engine_falls_back_to_default(self, monkeypatch):
        async def _down(method, path, payload=None, *, actor=None):
            raise engine_client.EngineUnavailableError("connection refused")

        monkeypatch.setattr(engine_client, "engine_request", _down)
        resp = _get(
            "/api/v1/compendium/spells",
            q="Feeblemind",
            engine_session_id="ghost",
        )
        assert resp.status_code == 200, "fallback must serve, not 500"
        body = resp.json()
        assert body["rule_version"] == default_rule_version
        assert body["rule_version_source"] == "default_fallback"
        reason = body.get("rule_version_reason", "")
        assert "unreachable" in reason.lower() or "unavailable" in reason.lower()
        # Feeblemind lives only in 5.1; the default corpus is 5.2, so it is gone.
        assert body["total"] == 0

    def test_missing_rule_version_in_snapshot_falls_back(self, monkeypatch):
        monkeypatch.setattr(engine_client, "engine_request", _engine_snapshot(None))
        resp = _get(
            "/api/v1/compendium/spells", q="Fireball", engine_session_id="old-sess"
        )
        body = resp.json()
        assert body["rule_version_source"] == "default_fallback"
        assert "reason" in "".join(body.keys()) or body.get("rule_version_reason")

    def test_unknown_version_value_falls_back(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_snapshot("srd_6_preview")
        )
        resp = _get(
            "/api/v1/compendium/monsters", q="Acolyte", engine_session_id="weird"
        )
        body = resp.json()
        assert body["rule_version_source"] == "default_fallback"
        assert body["rule_version"] == default_rule_version


class TestLoreLookupAndNarrativeGrounding:
    def test_lore_lookup_honors_session_version(self, monkeypatch):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_snapshot("srd_5_1")
        )
        resp = _get(
            "/api/v1/compendium/lore-lookup",
            q="I cast Feeblemind on the troll",
            engine_session_id="sess-51",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert any(f.get("name") == "Feeblemind" for f in body["facts"])
        assert body["rule_version"] == "srd_5_1"
        assert body["rule_version_source"] == "session"
        assert body["retrieval"] == "substring"

    def test_lore_lookup_default_excludes_51_only_spell(self):
        resp = _get("/api/v1/compendium/lore-lookup", q="I cast Feeblemind now")
        body = resp.json()
        assert not [f for f in body["facts"] if f.get("name") == "Feeblemind"]
        assert body["rule_version"] == default_rule_version

    @pytest.mark.parametrize("version,expected_level", [("srd_5_1", "Level 8")])
    def test_stream_grounding_uses_session_corpus(self, monkeypatch, version, expected_level):
        monkeypatch.setattr(
            engine_client, "engine_request", _engine_snapshot(version)
        )
        with client.stream(
            "POST",
            "/api/v1/orchestrator/narrative/stream",
            headers={"Authorization": "Bearer " + _auth("usr_rv_gm", "gm")},
            json={
                "user_intent": "I cast Feeblemind at the troll",
                "engine_execution_payload": {
                    "action_name": "Feeblemind",
                    "is_hit": True,
                    "total_damage": 20,
                },
                "engine_session_id": "sess-51-live",
            },
        ) as resp:
            assert resp.status_code == 200
            raw = "".join(chunk for chunk in resp.iter_text())
        text = "".join(
            frame["token"]
            for frame in (
                json.loads(m[6:]) for m in raw.split("\n\n") if m.startswith("data: ")
            )
            if frame.get("token")
        )
        # Feeblemind exists ONLY in the 5.1 corpus; grounding the narration with
        # its stat line proves the session-scoped corpus was used end to end.
        assert expected_level in text
