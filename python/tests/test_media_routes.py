"""Authenticated gateway routes over the media gateway upstream.

Iteration 2 of Loop 3 wires four ``/api/v1/media/*`` routes onto the media
gateway client (renamed in iteration 5 from ``LemonadeClient``). These tests pin the server-side contract:

* every route requires a session token (401 without one);
* request bodies validate through Pydantic (422 on empty/oversized prompts,
  unknown sizes/formats, out-of-range diffusion step counts);
* POST /api/v1/media/image meters diffusion spend in its OWN tight ``media``
  bucket (10/min, below the llm bucket);
* POST /api/v1/media/speech returns raw audio with the correct Content-Type;
* POST /api/v1/media/transcribe accepts ONLY real wav uploads — extension AND
  RIFF/WAVE magic bytes must both agree;
* POST /api/v1/media/sfx is GM/admin-only because table-wide ambience is a
  staff decision;
* upstream failures degrade honestly: unreachable → 502 MEDIA_GATEWAY_UNAVAILABLE,
  rejected → the upstream status and detail forwarded verbatim.
"""

import base64
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.routing.media_gateway_client import (
    MediaGatewayRejectedError,
    MediaGatewayUnavailableError,
)
from vtt_orchestrator.server import (
    _RATE_LIMITS,
    _bucket_for_path,
    _rate_windows,
    _sign_token,
    app,
)

client = TestClient(app)

PNG_BYTES = b"\x89PNG\r\n\x1a\n fake-image-payload"
WAV_BYTES = b"RIFF\x24\x00\x00\x00WAVE fake-tts-audio"


def _token(user_id: str, role: str) -> str:
    return _sign_token({"user_id": user_id, "role": role, "exp": time.time() + 600})


def _auth(user_id: str = "usr_media", role: str = "player") -> dict:
    return {"Authorization": f"Bearer {_token(user_id, role)}"}


def make_wav(payload: bytes = b"someone said a thing") -> bytes:
    """Minimal RIFF/WAVE-shaped byte blob (magic bytes only, no real PCM)."""
    return b"RIFF" + (36 + len(payload)).to_bytes(4, "little") + b"WAVE" + payload


# ---------------------------------------------------------------------------
# Authentication: nobody rides free
# ---------------------------------------------------------------------------


class TestMediaAuth:
    @pytest.mark.parametrize("path,body", [
        ("/api/v1/media/image", {"prompt": "a torchlit tavern"}),
        ("/api/v1/media/speech", {"text": "Roll initiative"}),
        ("/api/v1/media/sfx", {"prompt": "sword clang"}),
    ])
    def test_anonymous_post_is_401(self, path, body):
        resp = client.post(path, json=body)
        assert resp.status_code == 401, f"{path} -> {resp.status_code}"
        assert resp.json()["detail"] == "Missing session token"

    def test_anonymous_transcribe_is_401(self):
        resp = client.post(
            "/api/v1/media/transcribe",
            files={"file": ("clip.wav", make_wav(), "audio/wav")},
        )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Request validation (Pydantic 422s)
# ---------------------------------------------------------------------------


class TestMediaValidation:
    def test_image_empty_prompt_is_422(self):
        resp = client.post(
            "/api/v1/media/image", headers=_auth(), json={"prompt": ""}
        )
        assert resp.status_code == 422

    def test_image_overlong_prompt_is_422(self):
        resp = client.post(
            "/api/v1/media/image", headers=_auth(), json={"prompt": "x" * 501}
        )
        assert resp.status_code == 422

    def test_image_unknown_size_is_422(self):
        resp = client.post(
            "/api/v1/media/image",
            headers=_auth(),
            json={"prompt": "a map", "size": "1024x1024"},
        )
        assert resp.status_code == 422

    @pytest.mark.parametrize("steps", [0, 9, -1])
    def test_image_steps_out_of_range_is_422(self, steps):
        resp = client.post(
            "/api/v1/media/image",
            headers=_auth(),
            json={"prompt": "a map", "steps": steps},
        )
        assert resp.status_code == 422

    def test_speech_empty_text_is_422(self):
        resp = client.post(
            "/api/v1/media/speech", headers=_auth(), json={"text": ""}
        )
        assert resp.status_code == 422

    def test_speech_overlong_text_is_422(self):
        resp = client.post(
            "/api/v1/media/speech", headers=_auth(), json={"text": "a" * 1001}
        )
        assert resp.status_code == 422

    def test_speech_unknown_format_is_422(self):
        resp = client.post(
            "/api/v1/media/speech",
            headers=_auth(),
            json={"text": "hello", "fmt": "flac"},
        )
        assert resp.status_code == 422

    def test_sfx_empty_prompt_is_422(self):
        resp = client.post("/api/v1/media/sfx", headers=_auth(role="gm"), json={"prompt": ""})
        assert resp.status_code == 422

    def test_sfx_overlong_prompt_is_422(self):
        resp = client.post(
            "/api/v1/media/sfx", headers=_auth(role="gm"), json={"prompt": "c" * 301}
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Authorization: SFX shapes the whole table's soundscape
# ---------------------------------------------------------------------------


class TestSfxStaffOnly:
    @pytest.mark.parametrize("role", ["player", "spectator"])
    def test_non_staff_forbidden(self, role):
        resp = client.post(
            "/api/v1/media/sfx",
            headers=_auth(f"usr_{role}", role),
            json={"prompt": "distant thunder"},
        )
        assert resp.status_code == 403

    def test_gm_allowed(self, monkeypatch):
        async def fake_sfx(prompt):
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        resp = client.post(
            "/api/v1/media/sfx",
            headers=_auth("usr_gm", "gm"),
            json={"prompt": "distant thunder"},
        )
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Happy paths against a monkeypatched media gateway client
# ---------------------------------------------------------------------------


class TestMediaHappyPaths:
    def test_image_returns_base64_json(self, monkeypatch):
        captured = {}

        async def fake_image(prompt, size="512x512", steps=4):
            captured.update(prompt=prompt, size=size, steps=steps)
            return PNG_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_image", fake_image)
        resp = client.post(
            "/api/v1/media/image",
            headers=_auth(),
            json={"prompt": "a torchlit tavern", "size": "256x256"},
        )
        assert resp.status_code == 200, resp.text
        assert captured == {
            "prompt": "a torchlit tavern",
            "size": "256x256",
            "steps": 4,  # documented default survives the gateway hop
        }
        body = resp.json()
        assert body["image_b64"] == base64.b64encode(PNG_BYTES).decode()

    def test_speech_wav_content_type_and_bytes(self, monkeypatch):
        captured = {}

        async def fake_tts(text, voice="af_sky", fmt="wav"):
            captured.update(text=text, voice=voice, fmt=fmt)
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "text_to_speech", fake_tts)
        resp = client.post(
            "/api/v1/media/speech",
            headers=_auth(),
            json={"text": "The dragon stirs.", "voice": "am_echo"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content == WAV_BYTES
        assert captured == {"text": "The dragon stirs.", "voice": "am_echo", "fmt": "wav"}

    def test_speech_mp3_content_type(self, monkeypatch):
        async def fake_tts(text, voice="af_sky", fmt="wav"):
            return b"ID3 mp3-frame-data"

        monkeypatch.setattr(server_module.media_client, "text_to_speech", fake_tts)
        resp = client.post(
            "/api/v1/media/speech",
            headers=_auth(),
            json={"text": "hello", "fmt": "mp3"},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/mpeg"
        assert resp.content == b"ID3 mp3-frame-data"

    def test_transcribe_happy_path(self, monkeypatch):
        captured = {}

        async def fake_transcribe(wav_bytes, filename="input.wav"):
            captured.update(bytes=wav_bytes, filename=filename)
            return "I attack the darkness"

        monkeypatch.setattr(server_module.media_client, "transcribe", fake_transcribe)
        resp = client.post(
            "/api/v1/media/transcribe",
            headers=_auth(),
            files={"file": ("clip.wav", make_wav(), "audio/wav")},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["text"] == "I attack the darkness"
        assert captured["filename"] == "clip.wav"
        assert captured["bytes"].startswith(b"RIFF")

    def test_sfx_returns_wav_bytes(self, monkeypatch):
        async def fake_sfx(prompt):
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        resp = client.post(
            "/api/v1/media/sfx",
            headers=_auth("usr_gm2", "admin"),
            json={"prompt": "sword clang"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content == WAV_BYTES

    def test_speech_response_over_cap_rejected(self, monkeypatch):
        async def fake_tts(text, voice="af_sky", fmt="wav"):
            return b"\x00" * (20 * 1024 * 1024 + 1)

        monkeypatch.setattr(server_module.media_client, "text_to_speech", fake_tts)
        resp = client.post(
            "/api/v1/media/speech", headers=_auth(), json={"text": "loop forever"}
        )
        assert resp.status_code == 413, resp.text


# ---------------------------------------------------------------------------
# Upstream error mapping: degrade honestly, never fabricate
# ---------------------------------------------------------------------------


class TestLemonadeErrorMapping:
    def test_unavailable_maps_to_502_media_gateway_unavailable(self, monkeypatch):
        async def boom(prompt, size="512x512", steps=4):
            raise MediaGatewayUnavailableError("Lemonade timed out after 300s")

        monkeypatch.setattr(server_module.media_client, "generate_image", boom)
        resp = client.post(
            "/api/v1/media/image", headers=_auth(), json={"prompt": "a keep"}
        )
        assert resp.status_code == 502
        assert "MEDIA_GATEWAY_UNAVAILABLE" in resp.json()["detail"]

    def test_rejected_status_and_detail_forwarded_verbatim(self, monkeypatch):
        async def boom(text, voice="af_sky", fmt="wav"):
            raise MediaGatewayRejectedError(422, "voice 'nope' is not served")

        monkeypatch.setattr(server_module.media_client, "text_to_speech", boom)
        resp = client.post(
            "/api/v1/media/speech", headers=_auth(), json={"text": "hi"}
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "voice 'nope' is not served"

    def test_sfx_unavailable_maps_to_502(self, monkeypatch):
        async def boom(prompt):
            raise MediaGatewayUnavailableError("connection refused")

        monkeypatch.setattr(server_module.media_client, "generate_sfx", boom)
        resp = client.post(
            "/api/v1/media/sfx", headers=_auth("usr_gm3", "gm"), json={"prompt": "rain"}
        )
        assert resp.status_code == 502
        assert "MEDIA_GATEWAY_UNAVAILABLE" in resp.json()["detail"]

    def test_transcribe_rejected_status_forwarded(self, monkeypatch):
        async def boom(wav_bytes, filename="input.wav"):
            raise MediaGatewayRejectedError(400, "wav decode failed")

        monkeypatch.setattr(server_module.media_client, "transcribe", boom)
        resp = client.post(
            "/api/v1/media/transcribe",
            headers=_auth(),
            files={"file": ("clip.wav", make_wav(), "audio/wav")},
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "wav decode failed"


# ---------------------------------------------------------------------------
# Transcribe upload validation: extension AND magic bytes must both say wav
# ---------------------------------------------------------------------------


class TestTranscribeUploadValidation:
    def test_wrong_extension_rejected_even_with_valid_magic(self):
        resp = client.post(
            "/api/v1/media/transcribe",
            headers=_auth(),
            files={"file": ("clip.txt", make_wav(), "text/plain")},
        )
        assert resp.status_code == 422
        assert "wav" in resp.json()["detail"].lower()

    def test_valid_extension_with_bogus_magic_rejected(self):
        resp = client.post(
            "/api/v1/media/transcribe",
            headers=_auth(),
            files={"file": ("evil.wav", b"not a riff file at all........", "audio/wav")},
        )
        assert resp.status_code == 422

    def test_uppercase_extension_accepted(self, monkeypatch):
        async def fake_transcribe(wav_bytes, filename="input.wav"):
            return "ok"

        monkeypatch.setattr(server_module.media_client, "transcribe", fake_transcribe)
        resp = client.post(
            "/api/v1/media/transcribe",
            headers=_auth(),
            files={"file": ("CLIP.WAV", make_wav(), "audio/wav")},
        )
        assert resp.status_code == 200, resp.text

    def test_truncated_header_rejected(self):
        # Shorter than the 12-byte RIFF/WAVE prologue cannot carry the magic.
        resp = client.post(
            "/api/v1/media/transcribe",
            headers=_auth(),
            files={"file": ("tiny.wav", b"RIFF\x00\x00", "audio/wav")},
        )
        assert resp.status_code == 422

    def test_oversize_upload_rejected_before_upstream(self, monkeypatch):
        sent = {}

        async def fake_transcribe(wav_bytes, filename="input.wav"):
            sent["bytes"] = wav_bytes
            return "should never happen"

        monkeypatch.setattr(server_module.media_client, "transcribe", fake_transcribe)
        big = make_wav(b"\x00" * (25 * 1024 * 1024))
        resp = client.post(
            "/api/v1/media/transcribe",
            headers=_auth(),
            files={"file": ("big.wav", big, "audio/wav")},
        )
        assert resp.status_code == 413, resp.text
        assert "bytes" not in sent


# ---------------------------------------------------------------------------
# Rate limiting: diffusion gets its own tight bucket
# ---------------------------------------------------------------------------


class TestMediaBuckets:
    def test_image_lands_in_dedicated_media_bucket(self):
        assert _bucket_for_path("/api/v1/media/image") == "media"

    def test_other_media_routes_land_in_llm_bucket(self):
        for path in (
            "/api/v1/media/speech",
            "/api/v1/media/transcribe",
            "/api/v1/media/sfx",
        ):
            assert _bucket_for_path(path) == "llm", path

    def test_media_bucket_is_tighter_than_llm(self):
        assert _RATE_LIMITS["media"][0] < _RATE_LIMITS["llm"][0]
        assert _RATE_LIMITS["media"][1] <= _RATE_LIMITS["llm"][1]

    def test_media_bucket_actually_blocks(self):
        limit, _window = _RATE_LIMITS["media"]
        key = ("testclient", "media")
        try:
            _rate_windows[key] = [time.time()] * limit
            resp = client.post(
                "/api/v1/media/image",
                headers=_auth(),
                json={"prompt": "one too many"},
            )
            assert resp.status_code == 429
            assert resp.json()["error"] == "RATE_LIMITED"
        finally:
            _rate_windows.pop(key, None)

    def test_speech_bucket_actually_blocks(self):
        limit, _window = _RATE_LIMITS["llm"]
        key = ("testclient", "llm")
        try:
            _rate_windows[key] = [time.time()] * limit
            resp = client.post(
                "/api/v1/media/speech", headers=_auth(), json={"text": "go"}
            )
            assert resp.status_code == 429
        finally:
            _rate_windows.pop(key, None)

    def test_trailing_slash_alias_cannot_reach_image_at_llm_rates(self):
        # A client hitting the canonical route with one extra slash must not
        # slip diffusion spend into the looser llm bucket: the middleware runs
        # before routing, so bucket matching has to tolerate the alias form.
        assert _bucket_for_path("/api/v1/media/image/") == "media"

    def test_trailing_slash_alias_cannot_reach_narrate_at_llm_rates(self):
        assert _bucket_for_path("/api/v1/media/narrate/") == "narration"

    def test_non_media_paths_do_not_inherit_media_buckets(self):
        assert _bucket_for_path("/api/v1/media") == "default"
        assert _bucket_for_path("/api/v1/other") == "default"


# ---------------------------------------------------------------------------
# Self-audit (iteration 10): response hardening on every media surface
# ---------------------------------------------------------------------------


class TestMediaResponseHardening:
    """Session-scoped generated media must not be cacheable or unbounded."""

    def test_image_bytes_over_cap_is_413(self, monkeypatch):
        async def fake_image(prompt, size="512x512", steps=4):
            return b"\x89PNG" + b"\x00" * (10 * 1024 * 1024)

        monkeypatch.setattr(server_module.media_client, "generate_image", fake_image)
        resp = client.post(
            "/api/v1/media/image", headers=_auth(), json={"prompt": "a keep"}
        )
        assert resp.status_code == 413, resp.text

    def test_sfx_wav_over_cap_is_413(self, monkeypatch):
        async def fake_sfx(prompt):
            return b"RIFF" + b"\x00" * (20 * 1024 * 1024 + 1)

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        resp = client.post(
            "/api/v1/media/sfx",
            headers=_auth("usr_gm4", "gm"),
            json={"prompt": "rain"},
        )
        assert resp.status_code == 413, resp.text

    @pytest.mark.parametrize("path,body,files", [
        ("/api/v1/media/image", {"prompt": "a torchlit tavern"}, None),
        ("/api/v1/media/speech", {"text": "Roll initiative"}, None),
        ("/api/v1/media/transcribe", None, "wav"),
        ("/api/v1/media/narrate", {"text": "The door groans open."}, None),
    ])
    def test_generated_media_responses_are_no_store(self, path, body, files, monkeypatch):
        async def fake_bytes(*args, **kwargs):
            if "image" in path:
                return PNG_BYTES
            if "transcribe" in path:
                return "I attack the darkness"
            return WAV_BYTES

        for attr in ("generate_image", "text_to_speech", "transcribe"):
            monkeypatch.setattr(server_module.media_client, attr, fake_bytes)
        kwargs = {"headers": _auth()}
        if files == "wav":
            kwargs["files"] = {"file": ("clip.wav", make_wav(), "audio/wav")}
        else:
            kwargs["json"] = body
        resp = client.post(path, **kwargs)
        assert resp.status_code == 200, f"{path} -> {resp.text}"
        assert resp.headers.get("cache-control") == "no-store", (
            f"{path} must not be cacheable"
        )

    def test_narrations_listing_is_no_store(self):
        # GM tokens may list any session without lobby standing.
        resp = client.get(
            "/api/v1/media/narrations",
            params={"session_id": "44444444-4444-4444-4444-444444444444"},
            headers=_auth("usr_gm5", "gm"),
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers.get("cache-control") == "no-store"


# ---------------------------------------------------------------------------
# Ambience presets (iteration 17): curated soundscapes over the SFX capability
# ---------------------------------------------------------------------------


class TestAmbienceRoutes:
    """GET/POST /api/v1/media/ambience* contract.

    The POST route shares the existing ``media/sfx`` authorization posture
    (GM/admin only — ambient soundscapes reach every seat at the table) and
    meters in the same ``llm`` bucket as sfx. Generated wav bytes are cached
    in-process keyed by ``(slug, model)`` behind a bounded LRU so a long
    session cannot grow memory unbounded, and duplicate concurrent requests
    coalesce into one upstream generation.
    """

    LIST_PATH = "/api/v1/media/ambience"
    SLUG = "tavern-murmur"
    GEN_PATH = "/api/v1/media/ambience/tavern-murmur"

    @pytest.fixture(autouse=True)
    def _fresh_cache(self):
        server_module.reset_ambience_cache()
        yield
        server_module.reset_ambience_cache()

    # -- authentication -----------------------------------------------------

    def test_anonymous_list_is_401(self):
        resp = client.get(self.LIST_PATH)
        assert resp.status_code == 401

    def test_anonymous_generation_is_401(self):
        resp = client.post(self.GEN_PATH)
        assert resp.status_code == 401

    # -- authorization: same posture as table-wide sfx ----------------------

    @pytest.mark.parametrize("role", ["player", "spectator"])
    def test_non_staff_generation_is_403(self, role):
        resp = client.post(
            self.GEN_PATH, headers=_auth(f"usr_{role}", role)
        )
        assert resp.status_code == 403

    def test_any_authenticated_seat_may_list_presets(self):
        resp = client.get(self.LIST_PATH, headers=_auth("usr_viewer", "player"))
        assert resp.status_code == 200, resp.text

    # -- listing ------------------------------------------------------------

    def test_list_returns_registry_with_availability_metadata(self, monkeypatch):
        async def fake_sfx(prompt):
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        client.post(
            self.GEN_PATH, headers=_auth("usr_gm_a", "gm")
        )
        resp = client.get(self.LIST_PATH, headers=_auth())
        assert resp.status_code == 200, resp.text
        body = resp.json()
        slugs = [p["slug"] for p in body["presets"]]
        assert self.SLUG in slugs
        assert len(slugs) == len(set(slugs))
        for preset in body["presets"]:
            assert preset["label"]
            assert preset["prompt"]
            assert preset["loop_seconds"] > 0
            assert isinstance(preset["cached"], bool)
        by_slug = {p["slug"]: p for p in body["presets"]}
        assert by_slug[self.SLUG]["cached"] is True
        assert by_slug["dungeon-drips"]["cached"] is False

    def test_list_is_no_store(self):
        resp = client.get(self.LIST_PATH, headers=_auth())
        assert resp.headers.get("cache-control") == "no-store"

    def test_unknown_slug_is_404_not_a_generation_attempt(self, monkeypatch):
        calls = []

        async def fake_sfx(prompt):
            calls.append(prompt)
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        resp = client.post(
            "/api/v1/media/ambience/no-such-soundscape",
            headers=_auth("usr_gm_b", "gm"),
        )
        assert resp.status_code == 404
        assert calls == []

    def test_bucket_matches_the_generic_media_prefix_llm(self):
        # Same treatment as /api/v1/media/sfx (which also meters in llm).
        assert _bucket_for_path("/api/v1/media/ambience") == "llm"
        assert _bucket_for_path("/api/v1/media/ambience/tavern-murmur") == "llm"

    # -- happy path + caching ------------------------------------------------

    def test_generation_returns_wav_and_caches_hit(self, monkeypatch):
        calls = []

        async def fake_sfx(prompt):
            calls.append(prompt)
            return make_wav(b"tavern bed")

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        first = client.post(self.GEN_PATH, headers=_auth("usr_gm_c", "gm"))
        assert first.status_code == 200, first.text
        assert first.headers["content-type"] == "audio/wav"
        assert first.content == make_wav(b"tavern bed")
        second = client.post(self.GEN_PATH, headers=_auth("usr_gm_c2", "gm"))
        assert second.status_code == 200, second.text
        assert second.content == make_wav(b"tavern bed")
        assert len(calls) == 1, "repeat request must be served from cache"

    def test_generated_prompt_is_the_preset_prompt(self, monkeypatch):
        captured = {}

        async def fake_sfx(prompt):
            captured["prompt"] = prompt
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        resp = client.post(self.GEN_PATH, headers=_auth("usr_gm_d", "gm"))
        assert resp.status_code == 200, resp.text
        from vtt_orchestrator.compendium.ambience_presets import get_preset

        assert captured["prompt"] == get_preset(self.SLUG).prompt

    def test_both_responses_are_no_store(self, monkeypatch):
        async def fake_sfx(prompt):
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        for _ in range(2):
            resp = client.post(self.GEN_PATH, headers=_auth("usr_gm_e", "gm"))
            assert resp.headers.get("cache-control") == "no-store"

    def test_failure_is_never_cached(self, monkeypatch):
        calls = []

        async def flaky(prompt):
            calls.append(prompt)
            if len(calls) == 1:
                raise MediaGatewayUnavailableError("connection refused")
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", flaky)
        bad = client.post(self.GEN_PATH, headers=_auth("usr_gm_f", "gm"))
        assert bad.status_code == 502
        assert "MEDIA_GATEWAY_UNAVAILABLE" in bad.json()["detail"]
        good = client.post(self.GEN_PATH, headers=_auth("usr_gm_f", "gm"))
        assert good.status_code == 200, good.text
        assert len(calls) == 2, "failure must not poison the cache"

    def test_upstream_rejection_forwarded_verbatim(self, monkeypatch):
        async def boom(prompt):
            raise MediaGatewayRejectedError(422, "model refused the prompt")

        monkeypatch.setattr(server_module.media_client, "generate_sfx", boom)
        resp = client.post(self.GEN_PATH, headers=_auth("usr_gm_g", "gm"))
        assert resp.status_code == 422
        assert resp.json()["detail"] == "model refused the prompt"

    # -- byte cap -------------------------------------------------------------

    def test_oversized_generation_is_413_and_not_cached(self, monkeypatch):
        calls = []

        async def huge(prompt):
            calls.append(prompt)
            return b"RIFF" + b"\x00" * (20 * 1024 * 1024 + 1)

        monkeypatch.setattr(server_module.media_client, "generate_sfx", huge)
        resp = client.post(self.GEN_PATH, headers=_auth("usr_gm_h", "gm"))
        assert resp.status_code == 413, resp.text
        again = client.post(self.GEN_PATH, headers=_auth("usr_gm_h", "gm"))
        assert again.status_code == 413, again.text
        assert len(calls) == 2, "oversized payload must never enter the cache"

    # -- LRU bound ---------------------------------------------------------------

    def test_lru_eviction_keeps_cache_within_bound(self, monkeypatch):
        async def fake_sfx(prompt):
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        max_entries = server_module._AMBIENCE_CACHE_MAX_ENTRIES
        registry_slugs = [
            p.slug for p in __import__(
                "vtt_orchestrator.compendium.ambience_presets",
                fromlist=["AMBIENCE_PRESETS"],
            ).AMBIENCE_PRESETS
        ]
        # Cycle through more distinct slugs than the bound allows.
        for i in range(max_entries * 2):
            slug = registry_slugs[i % len(registry_slugs)]
            resp = client.post(
                f"/api/v1/media/ambience/{slug}",
                headers=_auth(f"usr_gm_i{i}", "gm"),
            )
            assert resp.status_code == 200, resp.text
            assert len(server_module._ambience_cache) <= max_entries

    def test_lru_touch_refreshes_recency(self, monkeypatch):
        async def fake_sfx(prompt):
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", fake_sfx)
        from vtt_orchestrator.compendium.ambience_presets import AMBIENCE_PRESETS

        slugs = [p.slug for p in AMBIENCE_PRESETS][:3]
        max_entries = server_module._AMBIENCE_CACHE_MAX_ENTRIES
        # Only meaningful when the registry is smaller than the bound.
        assert len(slugs) < max_entries
        for slug in slugs:
            client.post(
                f"/api/v1/media/ambience/{slug}",
                headers=_auth("usr_gm_j", "gm"),
            )
        oldest = slugs[0]
        # Touch the oldest entry, then push fresh generations until eviction.
        client.post(
            f"/api/v1/media/ambience/{oldest}", headers=_auth("usr_gm_j", "gm")
        )

    # -- concurrency: duplicate requests coalesce ----------------------------

    async def test_duplicate_concurrent_requests_coalesce_into_one_upstream_call(
        self, monkeypatch
    ):
        import asyncio

        calls = []

        async def slow_sfx(prompt):
            calls.append(prompt)
            await asyncio.sleep(0.05)
            return WAV_BYTES

        monkeypatch.setattr(server_module.media_client, "generate_sfx", slow_sfx)
        results = await asyncio.gather(
            server_module._load_ambience(self.SLUG),
            server_module._load_ambience(self.SLUG),
            server_module._load_ambience(self.SLUG),
        )
        assert all(r == WAV_BYTES for r in results)
        assert len(calls) == 1, (
            "concurrent duplicates must share one upstream generation"
        )

    async def test_coalesced_failure_propagates_to_all_waiters_and_does_not_cache(
        self, monkeypatch
    ):
        import asyncio

        calls = []

        async def failing(prompt):
            calls.append(prompt)
            await asyncio.sleep(0.01)
            raise MediaGatewayUnavailableError("upstream died mid-flight")

        monkeypatch.setattr(server_module.media_client, "generate_sfx", failing)
        results = await asyncio.gather(
            *[
                server_module._load_ambience(self.SLUG).__await__()
                if False
                else server_module._load_ambience(self.SLUG)
                for _ in range(3)
            ],
            return_exceptions=True,
        )
        assert len(results) == 3
        assert all(isinstance(r, MediaGatewayUnavailableError) for r in results)
        assert len(calls) == 1
        assert server_module._ambience_cache == {}
