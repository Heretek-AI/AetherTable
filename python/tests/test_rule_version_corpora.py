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


# ---------------------------------------------------------------------------
# Iteration 44 (audit F-A3#5 / F-A3#6): session-scoped resolution is
# authenticated, cached, and honest about WHY it fell back.
#
# F-A3#5: every compendium route carrying engine_session_id performed an
# unauthenticated synchronous gateway->engine GET per request — a load
# amplifier any anonymous client could pull. Session-scoped branching now
# requires identity: anonymous callers get the default corpus with
# rule_version_source="default_fallback" and the explicit reason below, while
# plain compendium reads stay public. Authenticated resolutions are memoized
# in-process for a short TTL so repeated requests do not round-trip.
#
# F-A3#6: the resolver used to conflate "snapshot has no rule_version",
# "engine says no such session", and "engine unreachable" into statuses that
# did not match its own docstring. Statuses are now distinct and documented.
# ---------------------------------------------------------------------------

import asyncio

from vtt_orchestrator import server as server_module

ANON_REASON = "authentication required for session-scoped corpora"


def _clear_cache() -> None:
    server_module._rule_version_cache.clear()


def _anon_get(path, **params):
    return client.get(path, params=params)


def _counting_stub(rule_version="srd_5_1"):
    """Stub of GET /api/v1/sessions/{id} that counts how often it is hit."""
    calls = {"n": 0}

    async def _fake(method, path, payload=None, *, actor=None):
        calls["n"] += 1
        assert method == "GET" and "/api/v1/sessions/" in path
        return {"entities": {}, "rule_version": rule_version}

    return _fake, calls


class TestSessionScopedAuthGate:
    def setup_method(self):
        _clear_cache()

    def test_anonymous_spells_request_never_calls_engine(self, monkeypatch):
        stub, calls = _counting_stub()
        monkeypatch.setattr(engine_client, "engine_request", stub)
        resp = _anon_get(
            "/api/v1/compendium/spells",
            q="Feeblemind",
            engine_session_id="anon-sess",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert calls["n"] == 0, "anonymous caller must not trigger an engine round trip"
        assert body["rule_version"] == default_rule_version
        assert body["rule_version_source"] == "default_fallback"
        assert body["rule_version_reason"] == ANON_REASON

    def test_anonymous_monsters_request_same_gate(self, monkeypatch):
        stub, calls = _counting_stub()
        monkeypatch.setattr(engine_client, "engine_request", stub)
        resp = _anon_get(
            "/api/v1/compendium/monsters",
            q="Acolyte",
            engine_session_id="anon-sess-m",
        )
        body = resp.json()
        assert resp.status_code == 200
        assert calls["n"] == 0
        assert body["rule_version_source"] == "default_fallback"
        assert body["rule_version_reason"] == ANON_REASON

    def test_anonymous_lore_lookup_same_gate(self, monkeypatch):
        stub, calls = _counting_stub()
        monkeypatch.setattr(engine_client, "engine_request", stub)
        resp = _anon_get(
            "/api/v1/compendium/lore-lookup",
            q="I cast Feeblemind on the troll",
            engine_session_id="anon-sess-l",
        )
        body = resp.json()
        assert resp.status_code == 200
        assert calls["n"] == 0
        assert body["rule_version_source"] == "default_fallback"
        assert body["rule_version_reason"] == ANON_REASON

    def test_garbage_token_is_treated_as_anonymous(self, monkeypatch):
        stub, calls = _counting_stub()
        monkeypatch.setattr(engine_client, "engine_request", stub)
        resp = client.get(
            "/api/v1/compendium/spells",
            params={"q": "Fireball", "engine_session_id": "junk-sess"},
            headers={"Authorization": "Bearer not-a-real-token"},
        )
        body = resp.json()
        assert resp.status_code == 200, "compendium reads stay public"
        assert calls["n"] == 0
        assert body["rule_version_source"] == "default_fallback"
        assert body["rule_version_reason"] == ANON_REASON

    def test_authenticated_caller_still_resolves_session_corpus(self, monkeypatch):
        stub, calls = _counting_stub("srd_5_1")
        monkeypatch.setattr(engine_client, "engine_request", stub)
        resp = _get(
            "/api/v1/compendium/spells",
            q="Feeblemind",
            engine_session_id="auth-sess",
        )
        body = resp.json()
        assert resp.status_code == 200
        assert calls["n"] == 1
        assert body["rule_version"] == "srd_5_1"
        assert body["rule_version_source"] == "session"


class TestResolutionCache:
    def setup_method(self):
        _clear_cache()

    def test_repeated_authenticated_calls_hit_engine_once_within_ttl(
        self, monkeypatch
    ):
        stub, calls = _counting_stub("srd_5_1")
        monkeypatch.setattr(engine_client, "engine_request", stub)
        for _ in range(3):
            spells = _get(
                "/api/v1/compendium/spells", q="Feeblemind",
                engine_session_id="cache-sess",
            )
            assert spells.json()["rule_version_source"] == "session"
            monsters = _get(
                "/api/v1/compendium/monsters", q="Acolyte",
                engine_session_id="cache-sess",
            )
            assert monsters.json()["rule_version_source"] == "session"
        assert calls["n"] == 1, "TTL cache must absorb repeat requests"

    def test_cache_expires_after_ttl(self, monkeypatch):
        stub, calls = _counting_stub("srd_5_1")
        monkeypatch.setattr(engine_client, "engine_request", stub)
        first = _get(
            "/api/v1/compendium/spells", q="Feeblemind",
            engine_session_id="ttl-sess",
        ).json()
        assert first["rule_version_source"] == "session"
        # Age the single cached entry past the TTL without sleeping.
        stale_before = time.monotonic() - (
            server_module._RULE_VERSION_CACHE_TTL_SECONDS + 1.0
        )
        key = next(iter(server_module._rule_version_cache))
        server_module._rule_version_cache[key] = (
            stale_before, server_module._rule_version_cache[key][1],
        )
        second = _get(
            "/api/v1/compendium/spells", q="Feeblemind",
            engine_session_id="ttl-sess",
        ).json()
        assert second["rule_version_source"] == "session"
        assert calls["n"] == 2, "expired entries must be refetched"

    def test_unreachable_results_are_not_cached(self, monkeypatch):
        async def _down(method, path, payload=None, *, actor=None):
            raise engine_client.EngineUnavailableError("connection refused")

        attempts = {"n": 0}

        async def _counting_down(method, path, payload=None, *, actor=None):
            attempts["n"] += 1
            await _down(method, path, payload, actor=actor)

        monkeypatch.setattr(engine_client, "engine_request", _counting_down)
        for _ in range(2):
            resp = _get(
                "/api/v1/compendium/spells", q="Fireball",
                engine_session_id="down-sess",
            )
            assert resp.status_code == 200
            assert resp.json()["rule_version_source"] == "default_fallback"
        assert attempts["n"] == 2, "a downed engine must be retried, not frozen"

    def test_distinct_sessions_do_not_share_entries(self, monkeypatch):
        stubs = {
            engine_client._coerce_uuid("sess-a"): _counting_stub("srd_5_1"),
            engine_client._coerce_uuid("sess-b"): _counting_stub("srd_5_2"),
        }

        async def _router(method, path, payload=None, *, actor=None):
            # The resolver coerces the caller-supplied id before lookup.
            for coerced, (stub, _) in stubs.items():
                if coerced in path:
                    return await stub(method, path, payload, actor=actor)
            raise AssertionError(f"unexpected path {path}")

        monkeypatch.setattr(engine_client, "engine_request", _router)
        a = _get(
            "/api/v1/compendium/spells", q="", engine_session_id="sess-a"
        ).json()
        b = _get(
            "/api/v1/compendium/spells", q="", engine_session_id="sess-b"
        ).json()
        assert a["rule_version"] == "srd_5_1"
        assert b["rule_version"] == "srd_5_2"
        assert all(calls["n"] == 1 for _, calls in stubs.values())


class TestHonestFallbackStatuses:
    """F-A3#6: distinct statuses instead of one conflated 'unreachable'."""

    def _resolve(self, monkeypatch, stub):
        monkeypatch.setattr(engine_client, "engine_request", stub)

        async def _call():
            return await server_module.resolve_session_rule_version(
                "status-sess",
                token=_auth("usr_status"),
            )

        return asyncio.run(_call())

    def setup_method(self):
        _clear_cache()

    def test_missing_version_for_none_valued_snapshot(self, monkeypatch):
        async def _stub(method, path, payload=None, *, actor=None):
            return {"entities": {}}

        version, status, reason = self._resolve(monkeypatch, _stub)
        assert version is None
        assert status == "missing_version"
        assert reason

    def test_session_not_found_for_engine_404(self, monkeypatch):
        async def _stub(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(404, "session not found")

        version, status, reason = self._resolve(monkeypatch, _stub)
        assert version is None
        assert status == "session_not_found"
        assert "404" in reason

    def test_non_404_rejection_is_not_claimed_as_connection_failure(self, monkeypatch):
        async def _stub(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(500, "boom")

        version, status, reason = self._resolve(monkeypatch, _stub)
        assert version is None
        assert status != "session_not_found"
        assert reason

    def test_unreachable_only_for_connection_failures(self, monkeypatch):
        async def _stub(method, path, payload=None, *, actor=None):
            raise engine_client.EngineUnavailableError("connection refused")

        version, status, reason = self._resolve(monkeypatch, _stub)
        assert version is None
        assert status == "unreachable"
        assert "unreachable" in reason.lower()

    def test_docstring_statuses_match_emitted_set(self):
        import inspect

        doc = inspect.getdoc(server_module.resolve_session_rule_version) or ""
        for expected in (
            "session",
            "missing_version",
            "session_not_found",
            "unreachable",
            "unknown_version",
            "unauthenticated",
        ):
            assert f'"{expected}"' in doc or f"'{expected}'" in doc, (
                f"docstring must document status '{expected}'"
            )

    def test_anonymous_direct_call_is_rejected_without_engine_round_trip(
        self, monkeypatch
    ):
        stub, calls = _counting_stub()

        async def _stub(method, path, payload=None, *, actor=None):
            return await stub(method, path, payload, actor=actor)

        monkeypatch.setattr(engine_client, "engine_request", _stub)
        version, status, reason = asyncio.run(
            server_module.resolve_session_rule_version("direct-sess")
        )
        assert version is None
        assert reason == ANON_REASON
        assert calls["n"] == 0

    def test_route_level_404_falls_back_with_distinct_reason(self, monkeypatch):
        async def _stub(method, path, payload=None, *, actor=None):
            raise engine_client.EngineRejectedError(404, "no such session")

        monkeypatch.setattr(engine_client, "engine_request", _stub)
        resp = _get(
            "/api/v1/compendium/spells", q="Fireball",
            engine_session_id="gone-sess",
        )
        body = resp.json()
        assert resp.status_code == 200
        assert body["rule_version"] == default_rule_version
        assert body["rule_version_source"] == "default_fallback"
        assert "404" in body["rule_version_reason"]
