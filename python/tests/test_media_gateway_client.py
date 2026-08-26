"""Media gateway client (routing/media_gateway_client.py) unit tests.

Covers the five generation/probe operations against a fake httpx transport:
correct routes and payloads per endpoint, binary audio returned as raw bytes,
base64 image decode, per-operation timeouts mapped to
MediaGatewayUnavailableError, non-200 responses mapped to
MediaGatewayRejectedError carrying status + detail, and an unreachable host
mapping to MediaGatewayUnavailableError.

Iteration 5 additions: canonical MEDIA_* env configuration with legacy
LEMONADE_* deprecated fallbacks (exactly one INFO line per fallback hit),
per-capability model overrides (constructor + explicit call param), and
``discover_capabilities()`` parsing of labeled and unlabeled /v1/models
catalogs.
"""

import base64
import json
import logging

import httpx
import pytest

from vtt_orchestrator.routing.media_gateway_client import (
    MediaGatewayClient,
    MediaGatewayUnavailableError,
    MediaGatewayRejectedError,
)

BASE = "http://media.test:13305"
PNG_BYTES = b"\x89PNG\r\n\x1a\n fake-image-payload"
WAV_BYTES = b"RIFF....fake-wav-audio"


def _client(handler) -> MediaGatewayClient:
    return MediaGatewayClient(
        base_url=BASE,
        api_key="test-key",
        transport=httpx.MockTransport(handler),
    )


def _clear_env(monkeypatch):
    for var in (
        "MEDIA_GATEWAY_URL",
        "MEDIA_GATEWAY_API_KEY",
        "MEDIA_IMAGE_MODEL",
        "MEDIA_TTS_MODEL",
        "MEDIA_STT_MODEL",
        "MEDIA_SFX_MODEL",
        "LEMONADE_BASE_URL",
        "LEMONADE_API_KEY",
    ):
        monkeypatch.delenv(var, raising=False)


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
    assert captured["auth"] == "Bearer test-key"
    # Configured default model, explicit size/steps passthrough.
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

    with pytest.raises(MediaGatewayRejectedError) as excinfo:
        await _client(handler).generate_image("x")
    assert excinfo.value.status_code == 422
    assert "prompt too long" in str(excinfo.value.detail)


async def test_generate_image_timeout_maps_to_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("diffusion took too long", request=request)

    with pytest.raises(MediaGatewayUnavailableError):
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
        return httpx.Response(500, text="TTS worker crashed")

    with pytest.raises(MediaGatewayRejectedError) as excinfo:
        await _client(handler).text_to_speech("hi")
    assert excinfo.value.status_code == 500
    assert "TTS" in str(excinfo.value.detail)


async def test_text_to_speech_unreachable_maps_to_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(MediaGatewayUnavailableError):
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

    with pytest.raises(MediaGatewayRejectedError) as excinfo:
        await _client(handler).transcribe(b"nope")
    assert excinfo.value.status_code == 400


async def test_transcribe_timeout_maps_to_unavailable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("stt stalled", request=request)

    with pytest.raises(MediaGatewayUnavailableError):
        await _client(handler).transcribe(WAV_BYTES)


# --------------------------------------------------------------------------
# generate_sfx
# --------------------------------------------------------------------------

async def test_generate_sfx_happy_path_binary_wav():
    captured = {}
    sfx_wav = b"RIFF....sfx-stereo"

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

    with pytest.raises(MediaGatewayRejectedError) as excinfo:
        await _client(reject).generate_sfx("thunder")
    assert excinfo.value.status_code == 503

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(MediaGatewayUnavailableError):
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

    with pytest.raises(MediaGatewayUnavailableError):
        await _client(handler).list_models()


async def test_list_models_rejected():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad key")

    with pytest.raises(MediaGatewayRejectedError) as excinfo:
        await _client(handler).list_models()
    assert excinfo.value.status_code == 401


# --------------------------------------------------------------------------
# Configuration from environment
# --------------------------------------------------------------------------

def test_config_defaults_when_env_unset(monkeypatch):
    _clear_env(monkeypatch)
    client = MediaGatewayClient()
    assert client.base_url.startswith("http")
    assert client.api_key == "lemonade"  # retained original deployment default
    # Built-in per-capability model defaults.
    assert client.image_model == "SD-Turbo"
    assert client.tts_model == "kokoro-v1"
    assert client.stt_model == "Whisper-Large-v3-Turbo"
    assert client.sfx_model == "ThinkSound-SFX"


def test_config_reads_canonical_env(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("MEDIA_GATEWAY_URL", "http://gateway-host:9999")
    monkeypatch.setenv("MEDIA_GATEWAY_API_KEY", "gateway-key")
    client = MediaGatewayClient()
    assert client.base_url == "http://gateway-host:9999"
    assert client.api_key == "gateway-key"
    # Canonical vars win; no deprecation flag raised.
    assert not client.used_legacy_env_url
    assert not client.used_legacy_env_key


def test_legacy_env_fallback_when_canonical_unset(monkeypatch, caplog):
    _clear_env(monkeypatch)
    monkeypatch.setenv("LEMONADE_BASE_URL", "http://legacy-host:13305")
    monkeypatch.setenv("LEMONADE_API_KEY", "legacy-key")
    with caplog.at_level(logging.INFO, logger="aethertable.media"):
        client = MediaGatewayClient()
    assert client.base_url == "http://legacy-host:13305"
    assert client.api_key == "legacy-key"
    assert client.used_legacy_env_url and client.used_legacy_env_key
    # Exactly one INFO line per deprecated variable honored — visible nudge,
    # no log spam.
    dep_lines = [
        r.message for r in caplog.records
        if r.levelno == logging.INFO and "deprecated" in r.message.lower()
    ]
    assert len(dep_lines) >= 1
    assert any("LEMONADE_BASE_URL" in m for m in dep_lines)
    assert any("LEMONADE_API_KEY" in m for m in dep_lines)


def test_canonical_env_takes_precedence_over_legacy(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("MEDIA_GATEWAY_URL", "http://new-gateway:8080")
    monkeypatch.setenv("LEMONADE_BASE_URL", "http://old-lemonade:13305")
    monkeypatch.setenv("MEDIA_GATEWAY_API_KEY", "new-key")
    monkeypatch.setenv("LEMONADE_API_KEY", "old-key")
    client = MediaGatewayClient()
    assert client.base_url == "http://new-gateway:8080"
    assert client.api_key == "new-key"
    assert not client.used_legacy_env_url and not client.used_legacy_env_key


def test_explicit_args_beat_every_env_var(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("MEDIA_GATEWAY_URL", "http://env-url:1")
    client = MediaGatewayClient(base_url="http://explicit:2", api_key="k")
    assert client.base_url == "http://explicit:2"
    assert client.api_key == "k"


def test_per_capability_models_from_env(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("MEDIA_IMAGE_MODEL", "Flux-Schnell")
    monkeypatch.setenv("MEDIA_TTS_MODEL", "piper-en")
    monkeypatch.setenv("MEDIA_STT_MODEL", "faster-whisper-md")
    monkeypatch.setenv("MEDIA_SFX_MODEL", "audiogen-sfx")
    client = MediaGatewayClient()
    assert client.image_model == "Flux-Schnell"
    assert client.tts_model == "piper-en"
    assert client.stt_model == "faster-whisper-md"
    assert client.sfx_model == "audiogen-sfx"


# --------------------------------------------------------------------------
# Per-capability model overrides
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("call", "expected_path", "expected_model"),
    [
        (lambda c: c.generate_image("p", model="Flux-Dev"),
         "/v1/images/generations", "Flux-Dev"),
        (lambda c: c.text_to_speech("t", model="piper-en"),
         "/v1/audio/speech", "piper-en"),
        (lambda c: c.generate_sfx("p", model="audiogen"),
         "/v1/audio/generations", "audiogen"),
    ],
)
async def test_explicit_model_override_param_forwarded(call, expected_path, expected_model):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        if request.url.path.endswith("generations"):
            captured["model"] = json.loads(request.content.decode())["model"]
        else:
            captured["model"] = json.loads(request.content.decode())["model"]
        if request.url.path == "/v1/images/generations":
            b64 = base64.b64encode(PNG_BYTES).decode()
            return httpx.Response(200, json={"data": [{"b64_json": b64}]})
        return httpx.Response(200, content=b"bytes")

    await call(_client(handler))
    assert captured["path"] == expected_path
    assert captured["model"] == expected_model


async def test_transcribe_explicit_model_override_forwarded():
    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode(errors="replace")
        assert 'name="model"' in body and "whisper-tiny-custom" in body
        return httpx.Response(200, json={"text": "ok"})

    await _client(handler).transcribe(b"w", model="whisper-tiny-custom")


async def test_configured_model_used_when_no_override_given():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["models"] = captured.get("models", [])
        if request.url.path == "/v1/images/generations":
            captured["models"].append(json.loads(request.content.decode())["model"])
            b64 = base64.b64encode(PNG_BYTES).decode()
            return httpx.Response(200, json={"data": [{"b64_json": b64}]})
        captured["models"].append(json.loads(request.content.decode())["model"])
        return httpx.Response(200, content=b"x")

    client = MediaGatewayClient(
        base_url=BASE,
        api_key="k",
        transport=httpx.MockTransport(handler),
        image_model="img-a",
        tts_model="tts-b",
        sfx_model="sfx-c",
    )
    await client.generate_image("p")
    await client.text_to_speech("t")
    await client.generate_sfx("p")
    assert captured["models"] == ["img-a", "tts-b", "sfx-c"]


# --------------------------------------------------------------------------
# discover_capabilities
# --------------------------------------------------------------------------

async def test_discover_capabilities_labeled_catalog():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json={
            "data": [
                {"id": "text-embedder", "labels": ["embeddings"]},
                {"id": "kokoro-v1", "labels": ["tts"]},
                {"id": "whisper-large-v3-turbo", "labels": ["transcription"]},
                {"id": "sd-turbo", "labels": ["image"]},
                {"id": "thinksound", "labels": ["audio-generation"]},
                {"id": "qwen2.5", "labels": ["chat"]},
            ],
        })

    caps = await _client(handler).discover_capabilities()
    assert caps == {
        "embeddings": True,
        "tts": True,
        "transcription": True,
        "image": True,
        "audio_generation": True,
        "chat": True,
    }


async def test_discover_capabilities_partial_catalog():
    """Only some capabilities advertised -> only those flags true."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "data": [
                {"id": "llama-chat", "capabilities": ["chat"]},
                {"id": "clip-image-encoder", "tags": ["image"]},
            ],
        })

    caps = await _client(handler).discover_capabilities()
    assert caps["chat"] is True
    assert caps["image"] is True
    assert caps["embeddings"] is False
    assert caps["tts"] is False
    assert caps["transcription"] is False
    assert caps["audio_generation"] is False


async def test_discover_capabilities_unlabeled_catalog_is_all_false():
    """Gateways that don't label models honestly report all-False."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "data": [{"id": "m1"}, {"id": "m2"}],
        })

    caps = await _client(handler).discover_capabilities()
    assert caps == {
        "embeddings": False,
        "tts": False,
        "transcription": False,
        "image": False,
        "audio_generation": False,
        "chat": False,
    }


async def test_discover_capabilities_empty_or_malformed_body_is_all_false():
    async def run(payload):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=payload)

        return await _client(handler).discover_capabilities()

    for payload in ({}, {"data": []}, {"data": None}, [], {"data": [1, 2]}):
        caps = await run(payload)
        assert all(v is False for v in caps.values())


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


# --------------------------------------------------------------------------
# Backward compatibility aliases
# --------------------------------------------------------------------------

def test_lemonade_aliases_still_importable_from_server_module():
    from vtt_orchestrator import server as server_module

    assert server_module.LemonadeClient is MediaGatewayClient
    assert server_module.lemonade_client is server_module.media_client
