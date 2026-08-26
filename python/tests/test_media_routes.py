"""Authenticated gateway routes over the Lemonade multimedia upstream.

Iteration 2 of Loop 3 wires four ``/api/v1/media/*`` routes onto the
iteration-1 ``LemonadeClient``. These tests pin the server-side contract:

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
* upstream failures degrade honestly: unreachable → 502 LEMONADE_UNAVAILABLE,
  rejected → the upstream status and detail forwarded verbatim.
"""

import base64
import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server as server_module
from vtt_orchestrator.routing.lemonade_client import (
    LemonadeRejectedError,
    LemonadeUnavailableError,
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

        monkeypatch.setattr(server_module.lemonade_client, "generate_sfx", fake_sfx)
        resp = client.post(
            "/api/v1/media/sfx",
            headers=_auth("usr_gm", "gm"),
            json={"prompt": "distant thunder"},
        )
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Happy paths against a monkeypatched Lemonade client
# ---------------------------------------------------------------------------


class TestMediaHappyPaths:
    def test_image_returns_base64_json(self, monkeypatch):
        captured = {}

        async def fake_image(prompt, size="512x512", steps=4):
            captured.update(prompt=prompt, size=size, steps=steps)
            return PNG_BYTES

        monkeypatch.setattr(server_module.lemonade_client, "generate_image", fake_image)
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

        monkeypatch.setattr(server_module.lemonade_client, "text_to_speech", fake_tts)
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

        monkeypatch.setattr(server_module.lemonade_client, "text_to_speech", fake_tts)
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

        monkeypatch.setattr(server_module.lemonade_client, "transcribe", fake_transcribe)
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

        monkeypatch.setattr(server_module.lemonade_client, "generate_sfx", fake_sfx)
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

        monkeypatch.setattr(server_module.lemonade_client, "text_to_speech", fake_tts)
        resp = client.post(
            "/api/v1/media/speech", headers=_auth(), json={"text": "loop forever"}
        )
        assert resp.status_code == 413, resp.text


# ---------------------------------------------------------------------------
# Upstream error mapping: degrade honestly, never fabricate
# ---------------------------------------------------------------------------


class TestLemonadeErrorMapping:
    def test_unavailable_maps_to_502_lemonade_unavailable(self, monkeypatch):
        async def boom(prompt, size="512x512", steps=4):
            raise LemonadeUnavailableError("Lemonade timed out after 300s")

        monkeypatch.setattr(server_module.lemonade_client, "generate_image", boom)
        resp = client.post(
            "/api/v1/media/image", headers=_auth(), json={"prompt": "a keep"}
        )
        assert resp.status_code == 502
        assert "LEMONADE_UNAVAILABLE" in resp.json()["detail"]

    def test_rejected_status_and_detail_forwarded_verbatim(self, monkeypatch):
        async def boom(text, voice="af_sky", fmt="wav"):
            raise LemonadeRejectedError(422, "voice 'nope' is not served")

        monkeypatch.setattr(server_module.lemonade_client, "text_to_speech", boom)
        resp = client.post(
            "/api/v1/media/speech", headers=_auth(), json={"text": "hi"}
        )
        assert resp.status_code == 422
        assert resp.json()["detail"] == "voice 'nope' is not served"

    def test_sfx_unavailable_maps_to_502(self, monkeypatch):
        async def boom(prompt):
            raise LemonadeUnavailableError("connection refused")

        monkeypatch.setattr(server_module.lemonade_client, "generate_sfx", boom)
        resp = client.post(
            "/api/v1/media/sfx", headers=_auth("usr_gm3", "gm"), json={"prompt": "rain"}
        )
        assert resp.status_code == 502
        assert "LEMONADE_UNAVAILABLE" in resp.json()["detail"]

    def test_transcribe_rejected_status_forwarded(self, monkeypatch):
        async def boom(wav_bytes, filename="input.wav"):
            raise LemonadeRejectedError(400, "wav decode failed")

        monkeypatch.setattr(server_module.lemonade_client, "transcribe", boom)
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

        monkeypatch.setattr(server_module.lemonade_client, "transcribe", fake_transcribe)
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

        monkeypatch.setattr(server_module.lemonade_client, "transcribe", fake_transcribe)
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
