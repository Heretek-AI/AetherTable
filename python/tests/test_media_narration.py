"""Spoken narration surface (Loop 3, iteration 6).

POST /api/v1/media/narrate is deliberately a SEPARATE route from
/media/speech rather than an overload, because its contract differs in three
ways this module pins:

* any authenticated seat may narrate THEIR OWN text (no staff gate, unlike
  SFX which shapes the whole table);
* narration allows LONGER scripts — ``MEDIA_NARRATION_MAX_CHARS`` (default
  2000) vs speech's fixed 1000 — so it meters in its own ``narration``
  bucket (20/min) instead of sharing the llm bucket;
* every successful synthesis is logged per session
  (storage.narrations: session_id, user_id, voice, text_snippet, created_at)
  and readable back through GET /api/v1/media/narrations?session_id=.

Trust decisions encoded here:

* both routes REQUIRE an authenticated HMAC token (never anonymous);
* naming a session on narrate or reading a session's narration log derives
  legitimacy from lobby membership bound to that engine session — the same
  derivation the x-card gate uses — because that is the membership data the
  gateway actually owns; gm/admin bypasses. Outsiders get 403;
* the stored text is a bounded SNIPPET, never the full script.
"""

import asyncio
import inspect
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.server import (
    _RATE_LIMITS,
    _bucket_for_path,
    _rate_windows,
    _sign_token,
    app,
)

client = TestClient(app)

WAV_BYTES = b"RIFF\x24\x00\x00\x00WAVE narrated-audio"
SESSION_ID = "44444444-4444-4444-4444-444444444444"


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _auth(user_id: str = "usr_narr", role: str = "player") -> dict:
    return {"Authorization": f"Bearer {_token(user_id, role)}"}


def _patch_tts(monkeypatch, captured=None, payload=WAV_BYTES):
    async def fake_tts(text, voice="af_sky", fmt="wav"):
        if captured is not None:
            captured.update(text=text, voice=voice, fmt=fmt)
        return payload

    monkeypatch.setattr(server_module.media_client, "text_to_speech", fake_tts)


def _bind_participant(user_id: str, session_id: str = SESSION_ID) -> None:
    """Creates a lobby, joins it as ``user_id``, and binds it to the engine
    session exactly as lobby launch does — without the live Rust engine."""
    host_token = _token(f"{user_id}_host", "player")
    created = client.post(
        "/api/v1/lobbies",
        params={"token": host_token},
        json={"name": f"Narration Lobby {user_id}"},
    )
    assert created.status_code == 200, created.text
    lobby_id = created.json()["lobby_id"]
    joined = client.post(
        f"/api/v1/lobbies/{lobby_id}/join",
        params={"token": _token(user_id, "player")},
        json={"invite_code": created.json()["invite_code"]},
    )
    assert joined.status_code == 200, joined.text
    asyncio.run(
        server_module.storage_backend.set_lobby_session(lobby_id, session_id)
    )


# ---------------------------------------------------------------------------
# Authentication: nobody narrates anonymously
# ---------------------------------------------------------------------------


class TestNarrationAuth:
    def test_anonymous_narrate_is_401(self):
        resp = client.post(
            "/api/v1/media/narrate", json={"text": "The dragon stirs."}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing session token"

    def test_anonymous_listing_is_401(self):
        resp = client.get(
            "/api/v1/media/narrations", params={"session_id": SESSION_ID}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing session token"

    def test_invalid_token_is_401(self):
        resp = client.post(
            "/api/v1/media/narrate",
            params={"token": "forged"},
            json={"text": "hi"},
        )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Request validation (Pydantic 422s)
# ---------------------------------------------------------------------------


class TestNarrationValidation:
    def test_empty_text_is_422(self):
        resp = client.post(
            "/api/v1/media/narrate", headers=_auth(), json={"text": ""}
        )
        assert resp.status_code == 422

    def test_over_default_cap_is_422(self, monkeypatch):
        _patch_tts(monkeypatch)
        resp = client.post(
            "/api/v1/media/narrate", headers=_auth(), json={"text": "a" * 2001}
        )
        assert resp.status_code == 422, resp.text

    def test_exactly_default_cap_accepted(self, monkeypatch):
        _patch_tts(monkeypatch)
        resp = client.post(
            "/api/v1/media/narrate", headers=_auth(), json={"text": "a" * 2000}
        )
        assert resp.status_code == 200, resp.text

    def test_env_can_tighten_the_cap(self, monkeypatch):
        monkeypatch.setenv("MEDIA_NARRATION_MAX_CHARS", "10")
        _patch_tts(monkeypatch)
        too_long = client.post(
            "/api/v1/media/narrate", headers=_auth(), json={"text": "b" * 11}
        )
        assert too_long.status_code == 422, too_long.text
        at_cap = client.post(
            "/api/v1/media/narrate", headers=_auth(), json={"text": "b" * 10}
        )
        assert at_cap.status_code == 200, at_cap.text


# ---------------------------------------------------------------------------
# Metering: narration gets its OWN bucket, matched before the generic media
# prefix so it never silently lands in llm
# ---------------------------------------------------------------------------


class TestNarrationBucket:
    def test_narrate_lands_in_dedicated_narration_bucket(self):
        assert _bucket_for_path("/api/v1/media/narrate") == "narration"

    def test_narration_bucket_is_20_per_minute(self):
        limit, window = _RATE_LIMITS["narration"]
        assert limit == 20
        assert window <= 60

    def test_narration_bucket_is_tighter_than_llm(self):
        assert _RATE_LIMITS["narration"][0] < _RATE_LIMITS["llm"][0]

    def test_speech_stays_in_llm_bucket(self):
        # Narrating must NOT have quietly re-bucketed the short-form route.
        assert _bucket_for_path("/api/v1/media/speech") == "llm"

    def test_narration_bucket_actually_blocks(self, monkeypatch):
        _patch_tts(monkeypatch)
        limit, _window = _RATE_LIMITS["narration"]
        key = ("testclient", "narration")
        try:
            _rate_windows[key] = [time.time()] * limit
            resp = client.post(
                "/api/v1/media/narrate",
                headers=_auth(),
                json={"text": "one too many"},
            )
            assert resp.status_code == 429
            assert resp.json()["error"] == "RATE_LIMITED"
        finally:
            _rate_windows.pop(key, None)


# ---------------------------------------------------------------------------
# Happy paths against a monkeypatched media gateway client
# ---------------------------------------------------------------------------


class TestNarrateHappyPath:
    def test_returns_wav_bytes_and_default_voice(self, monkeypatch):
        captured = {}
        _patch_tts(monkeypatch, captured)
        resp = client.post(
            "/api/v1/media/narrate",
            headers=_auth(),
            json={"text": "The dragon stirs."},
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content == WAV_BYTES
        assert captured == {
            "text": "The dragon stirs.",
            "voice": "af_sky",  # documented default survives the gateway hop
            "fmt": "wav",
        }

    def test_media_tts_voice_env_becomes_the_default(self, monkeypatch):
        captured = {}
        _patch_tts(monkeypatch, captured)
        monkeypatch.setenv("MEDIA_TTS_VOICE", "bf_emma")
        resp = client.post(
            "/api/v1/media/narrate", headers=_auth(), json={"text": "hello"}
        )
        assert resp.status_code == 200, resp.text
        assert captured["voice"] == "bf_emma"

    def test_explicit_voice_beats_the_env_default(self, monkeypatch):
        captured = {}
        _patch_tts(monkeypatch, captured)
        monkeypatch.setenv("MEDIA_TTS_VOICE", "bf_emma")
        resp = client.post(
            "/api/v1/media/narrate",
            headers=_auth(),
            json={"text": "hello", "voice": "am_echo"},
        )
        assert resp.status_code == 200, resp.text
        assert captured["voice"] == "am_echo"

    def test_oversized_synthesis_rejected_before_logging(self, monkeypatch):
        seen = {}

        async def fake_tts(text, voice="af_sky", fmt="wav"):
            seen["called"] = True
            return b"\x00" * (20 * 1024 * 1024 + 1)

        monkeypatch.setattr(server_module.media_client, "text_to_speech", fake_tts)
        resp = client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_logcheck", "player"),
            json={"text": "loop forever"},
        )
        assert resp.status_code == 413, resp.text
        assert seen.get("called") is True
        logged = asyncio.run(
            server_module.storage_backend.list_narrations(None, limit=50)
        )
        assert all(n["user_id"] != "usr_logcheck" for n in logged), (
            "a rejected synthesis must not enter the narration log"
        )

    def test_upstream_unavailable_maps_to_502(self, monkeypatch):
        from vtt_orchestrator.routing.media_gateway_client import (
            MediaGatewayUnavailableError,
        )

        async def boom(text, voice="af_sky", fmt="wav"):
            raise MediaGatewayUnavailableError("kokoro timed out")

        monkeypatch.setattr(server_module.media_client, "text_to_speech", boom)
        resp = client.post(
            "/api/v1/media/narrate", headers=_auth(), json={"text": "hi"}
        )
        assert resp.status_code == 502
        assert "MEDIA_GATEWAY_UNAVAILABLE" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Session attribution: naming a session requires standing in it
# ---------------------------------------------------------------------------


class TestNarrateSessionStanding:
    def test_participant_may_narrate_into_their_session(self, monkeypatch):
        _patch_tts(monkeypatch)
        _bind_participant("usr_seat_ok")
        resp = client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_seat_ok"),
            json={"text": "Roll for perception.", "session_id": SESSION_ID},
        )
        assert resp.status_code == 200, resp.text

    def test_outsider_cannot_narrate_into_a_foreign_session(self, monkeypatch):
        _patch_tts(monkeypatch)
        resp = client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_seat_out"),
            json={"text": "hi", "session_id": SESSION_ID},
        )
        assert resp.status_code == 403, resp.text

    def test_gm_may_narrate_into_any_session(self, monkeypatch):
        _patch_tts(monkeypatch)
        resp = client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_seat_gm", "gm"),
            json={"text": "The doors slam shut.", "session_id": SESSION_ID},
        )
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Narration log: recorded on success, listable per session
# ---------------------------------------------------------------------------


class TestNarrationLog:
    def test_successful_narration_is_logged_and_listable(self, monkeypatch):
        _patch_tts(monkeypatch)
        _bind_participant("usr_logger")
        posted = client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_logger"),
            json={
                "text": "A cold wind howls through the pass.",
                "voice": "af_sky",
                "session_id": SESSION_ID,
            },
        )
        assert posted.status_code == 200, posted.text

        listed = client.get(
            "/api/v1/media/narrations",
            headers=_auth("usr_logger"),
            params={"session_id": SESSION_ID},
        )
        assert listed.status_code == 200, listed.text
        body = listed.json()
        entries = body["narrations"]
        assert body["count"] == len(entries) <= 50
        mine = [e for e in entries if e["user_id"] == "usr_logger"]
        assert mine, "the narration just posted must appear in the log"
        newest = mine[0]
        assert newest["voice"] == "af_sky"
        assert newest["text_snippet"].startswith("A cold wind howls")
        assert newest["session_id"] == SESSION_ID
        assert newest["created_at"]

    def test_logged_text_is_a_bounded_snippet(self, monkeypatch):
        _patch_tts(monkeypatch)
        _bind_participant("usr_snip")
        long_text = "a" * 1999 + "."
        posted = client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_snip"),
            json={"text": long_text, "session_id": SESSION_ID},
        )
        assert posted.status_code == 200, posted.text
        listed = client.get(
            "/api/v1/media/narrations",
            headers=_auth("usr_snip"),
            params={"session_id": SESSION_ID},
        )
        mine = [
            e for e in listed.json()["narrations"] if e["user_id"] == "usr_snip"
        ]
        assert mine
        assert len(mine[0]["text_snippet"]) < len(long_text)
        assert len(mine[0]["text_snippet"]) <= 200

    def test_sessions_do_not_see_each_others_narrations(self, monkeypatch):
        _patch_tts(monkeypatch)
        other_session = "55555555-5555-5555-5555-555555555555"
        _bind_participant("usr_split_a", SESSION_ID)
        _bind_participant("usr_split_b", other_session)
        client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_split_a"),
            json={"text": "alpha side", "session_id": SESSION_ID},
        )
        client.post(
            "/api/v1/media/narrate",
            headers=_auth("usr_split_b"),
            json={"text": "beta side", "session_id": other_session},
        )
        listed_a = client.get(
            "/api/v1/media/narrations",
            headers=_auth("usr_split_a"),
            params={"session_id": SESSION_ID},
        )
        texts = {e["text_snippet"] for e in listed_a.json()["narrations"]}
        assert any(t.startswith("alpha") for t in texts)
        assert not any(t.startswith("beta") for t in texts)

    def test_listing_requires_session_id(self):
        resp = client.get("/api/v1/media/narrations", headers=_auth())
        assert resp.status_code == 422

    def test_outsider_cannot_list_a_foreign_session(self):
        resp = client.get(
            "/api/v1/media/narrations",
            headers=_auth("usr_list_out"),
            params={"session_id": SESSION_ID},
        )
        assert resp.status_code == 403

    def test_gm_may_list_any_session(self):
        resp = client.get(
            "/api/v1/media/narrations",
            headers=_auth("usr_list_gm", "gm"),
            params={"session_id": SESSION_ID},
        )
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Storage parity: MemoryStore and PostgresStore expose the SAME interface
# ---------------------------------------------------------------------------


class TestNarrationStoreParity:
    def test_both_backends_expose_the_same_narration_contract(self):
        from vtt_orchestrator.storage import MemoryStore, PostgresStore

        for method in ("record_narration", "list_narrations"):
            memory_sig = inspect.signature(getattr(MemoryStore, method))
            postgres_sig = inspect.signature(getattr(PostgresStore, method))
            assert memory_sig.parameters.keys() == postgres_sig.parameters.keys(), (
                f"{method}: backend signatures drifted"
            )
            assert memory_sig.return_annotation == postgres_sig.return_annotation

    def test_memory_store_records_and_lists_newest_first(self):
        from vtt_orchestrator.storage import MemoryStore

        store = MemoryStore()

        async def scenario():
            first = await store.record_narration(
                session_id=SESSION_ID, user_id="usr_u1", voice="af_sky",
                text="first line",
            )
            second = await store.record_narration(
                session_id=SESSION_ID, user_id="usr_u2", voice="am_echo",
                text="second line",
            )
            await store.record_narration(
                session_id="99999999-9999-9999-9999-999999999999",
                user_id="usr_u3", voice="af_sky", text="other session",
            )
            rows = await store.list_narrations(SESSION_ID)
            return first, second, rows

        first, second, rows = asyncio.run(scenario())
        assert first["text_snippet"] == "first line"
        assert [r["user_id"] for r in rows] == ["usr_u2", "usr_u1"], (
            "newest narration must come first"
        )
        assert all(r["session_id"] == SESSION_ID for r in rows)
        assert second["voice"] == "am_echo"

    @pytest.mark.skipif(
        not __import__("os").environ.get("DATABASE_URL"),
        reason="DATABASE_URL not set; Postgres mode not exercised",
    )
    def test_postgres_store_round_trips_narrations(self):
        from vtt_orchestrator.storage import init_storage

        async def scenario():
            store = await init_storage()
            try:
                assert store.backend == "postgres"
                marker = f"pg narration probe {time.time()}"
                await store.record_narration(
                    session_id=SESSION_ID, user_id="usr_pg_probe",
                    voice="af_sky", text=marker,
                )
                rows = await store.list_narrations(SESSION_ID)
                return rows
            finally:
                await store.pool.close()

        rows = asyncio.run(scenario())
        assert any(
            r["user_id"] == "usr_pg_probe" for r in rows
        ), "durable narration row must survive the pool round trip"
