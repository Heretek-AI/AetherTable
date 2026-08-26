"""Lemonade multimedia client (routing/lemonade_client.py) unit tests.

Covers the five operations against a fake httpx transport: correct routes and
payloads per endpoint, binary audio returned as raw bytes, base64 image
decode, per-operation timeouts mapped to LemonadeUnavailableError, non-200
responses mapped to LemonadeRejectedError carrying status + detail, and an
unreachable host mapping to LemonadeUnavailableError.
"""

import base64
import json

import httpx
import pytest

from vtt_orchestrator.routing.lemonade_client import (
    LemonadeClient,
    LemonadeUnavailableError,
    LemonadeRejectedError,
)

BASE = "http://lemonade.test:13305"
PNG_BYTES = b"\x89PNG\r\n\x1a\n fake-image-payload"
WAV_BYTES = b"RIFF....fake-wav-audio"


def _client(handler) -> LemonadeClient:
    return LemonadeClient(
        base_url=BASE,
        api_key="lemonade",
        transport=httpx.MockTransport(handler),
    )


# --------------------------------------------------------------------------
# generate_image
# --------------------------------------------------------------------------

async def test_generate_image_happy_path_route_payload_and_b64_decode():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        captured["payload"] = json.loads(request.content.decode())
        b64 = base64.b64encode(PNG_BYTES).decode()
        return httpx.Response(200, json={"data": [{"b64_json": b64}]})

    result = await _client(handler).generate_image("a torchlit tavern")

    assert captured["url"] == f"{BASE}/v1/images/generations"
    assert captured["auth"] == "Bearer lemonade"
    # SD-Turbo defaults, explicit size/steps passthrough.
    assert captured["payload"] == {
        "model": "SD-Turbo",
        "prompt": "a torchlit tavern",
        "size": "512x512",
        "steps": 4,
    }
    assert result == PNG_BYTES


async def test_generate_image_explicit_size_and_steps_forwarded():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content.decode())
        return httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(PNG_BYTES).decode()}]},
        )

    await _client(handler).generate_image("a map", size="1024x1024", steps=8)
    assert captured["payload"]["size"] == "1024x1024"
    assert captured["payload"]["steps"] == 8


async def test_generate_image_rejected_carries_status_and_detail():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": "prompt too long"})

    with pytest.raises(LemonadeRejectedError) as excinfo:
        await _client(handler).generate_image("x")
    assert excinfo.value.status_code == 422
    assert "prompt too long" in str(excinfo.value.detail)


async def test_generate_image_timeout_maps_to_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("SD-Turbo took too long", request=request)

    with pytest.raises(LemonadeUnavailableError):
        await _client(handler).generate_image("x")


# --------------------------------------------------------------------------
# text_to_speech
# --------------------------------------------------------------------------

async def test_text_to_speech_happy_path_binary_bytes():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["payload"] = json.loads(request.content.decode())
        return httpx.Response(200, content=WAV_BYTES, headers={
            "content-type": "audio/wav"})

    result = await _client(handler).text_to_speech("Roll initiative!", voice="am_echo")

    assert captured["url"] == f"{BASE}/v1/audio/speech"
    assert captured["payload"] == {
        "model": "kokoro-v1",
        "input": "Roll initiative!",
        "voice": "am_echo",
        "response_format": "wav",
    }
    assert isinstance(result, bytes)
    assert result == WAV_BYTES


async def test_text_to_speech_mp3_format_forwarded():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["payload"] = json.loads(request.content.decode())
        return httpx.Response(200, content=b"mp3-bytes")

    await _client(handler).text_to_speech("hello", fmt="mp3")
    assert captured["payload"]["response_format"] == "mp3"


async def test_text_to_speech_server_error_maps_to_rejected():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="OpenMOSS-TTS crashed")

    with pytest.raises(LemonadeRejectedError) as excinfo:
        await _client(handler).text_to_speech("hi")
    assert excinfo.value.status_code == 500
    assert "OpenMOSS" in str(excinfo.value.detail)


async def test_text_to_speech_unreachable_maps_to_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(LemonadeUnavailableError):
        await _client(handler).text_to_speech("hi")


# --------------------------------------------------------------------------
# transcribe
# --------------------------------------------------------------------------

async def test_transcribe_happy_path_multipart_and_text():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["content_type"] = request.headers.get("content-type", "")
        body = request.content.decode(errors="replace")
        captured["body_has_model"] = 'name="model"' in body and \
            "Whisper-Large-v3-Turbo" in body
        captured["body_has_filename"] = 'filename="clip.wav"' in body
        return httpx.Response(200, json={"text": "I attack the goblin"})

    result = await _client(handler).transcribe(WAV_BYTES, filename="clip.wav")

    assert captured["url"] == f"{BASE}/v1/audio/transcriptions"
    assert "multipart/form-data" in captured["content_type"]
    assert captured["body_has_model"]
    assert captured["body_has_filename"]
    assert result == "I attack the goblin"


async def test_transcribe_default_filename():
    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode(errors="replace")
        assert 'filename="input.wav"' in body
        return httpx.Response(200, json={"text": "ok"})

    await _client(handler).transcribe(WAV_BYTES)


async def test_transcribe_rejected():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"detail": "not a wav"})

    with pytest.raises(LemonadeRejectedError) as excinfo:
        await _client(handler).transcribe(b"nope")
    assert excinfo.value.status_code == 400


async def test_transcribe_timeout_maps_to_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("whisper stalled", request=request)

    with pytest.raises(LemonadeUnavailableError):
        await _client(handler).transcribe(WAV_BYTES)


# --------------------------------------------------------------------------
# generate_sfx
# --------------------------------------------------------------------------

async def test_generate_sfx_happy_path_binary_wav():
    captured = {}
    sfx_wav = b"RIFF....thinksound-stereo"

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["payload"] = json.loads(request.content.decode())
        return httpx.Response(200, content=sfx_wav)

    result = await _client(handler).generate_sfx("sword clash on stone")

    assert captured["url"] == f"{BASE}/v1/audio/generations"
    assert captured["payload"] == {
        "model": "ThinkSound-SFX",
        "prompt": "sword clash on stone",
    }
    assert result == sfx_wav


async def test_generate_sfx_rejected_and_unreachable():
    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="GPU busy")

    with pytest.raises(LemonadeRejectedError) as excinfo:
        await _client(reject).generate_sfx("thunder")
    assert excinfo.value.status_code == 503

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(LemonadeUnavailableError):
        await _client(unreachable).generate_sfx("thunder")


# --------------------------------------------------------------------------
# list_models
# --------------------------------------------------------------------------

async def test_list_models_happy_path_get_json():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        return httpx.Response(
            200,
            json={"data": [{"id": "SD-Turbo"}, {"id": "kokoro-v1"}]},
        )

    result = await _client(handler).list_models()

    assert captured["method"] == "GET"
    assert captured["url"] == f"{BASE}/v1/models"
    assert [m["id"] for m in result["data"]] == ["SD-Turbo", "kokoro-v1"]


async def test_list_models_short_timeout_maps_to_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("host down", request=request)

    with pytest.raises(LemonadeUnavailableError):
        await _client(handler).list_models()


async def test_list_models_rejected():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad key")

    with pytest.raises(LemonadeRejectedError) as excinfo:
        await _client(handler).list_models()
    assert excinfo.value.status_code == 401


# --------------------------------------------------------------------------
# Configuration from environment
# --------------------------------------------------------------------------

def test_config_defaults_from_env(monkeypatch):
    monkeypatch.delenv("LEMONADE_BASE_URL", raising=False)
    monkeypatch.delenv("LEMONADE_API_KEY", raising=False)
    client = LemonadeClient()
    assert client.base_url.startswith("http")
    assert client.api_key == "lemonade"


def test_config_reads_env(monkeypatch):
    monkeypatch.setenv("LEMONADE_BASE_URL", "http://env-host:9999")
    monkeypatch.setenv("LEMONADE_API_KEY", "env-key")
    client = LemonadeClient()
    assert client.base_url == "http://env-host:9999"
    assert client.api_key == "env-key"


# --------------------------------------------------------------------------
# Per-operation timeouts
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("coro_factory", "expected_timeout"),
    [
        (lambda c: c.generate_image("p"), 300.0),
        (lambda c: c.generate_sfx("p"), 240.0),
        (lambda c: c.text_to_speech("t"), 120.0),
        (lambda c: c.transcribe(b"w"), 120.0),
        (lambda c: c.list_models(), 10.0),
    ],
)
async def test_per_operation_timeouts(coro_factory, expected_timeout):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["timeout"] = request.extensions.get("timeout")
        return httpx.Response(200, json={})

    client = _client(handler)
    try:
        await coro_factory(client)
    except Exception:
        pass  # shape of the response doesn't matter here, only the timeout sent
    assert seen["timeout"] is not None
    # httpx puts a {connect, read, write, pool} mapping in request extensions.
    assert seen["timeout"]["read"] == expected_timeout
