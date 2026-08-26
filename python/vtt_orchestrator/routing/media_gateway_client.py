"""OpenAI-compatible media gateway client (images / TTS / STT / SFX).

Thin async httpx wrapper around a self-hosted OpenAI-compatible multimedia
gateway. The gateway never fabricates media: every failure surfaces as one of
two honest exceptions — ``MediaGatewayUnavailableError`` (host unreachable /
transport timeout) or ``MediaGatewayRejectedError`` (non-2xx carrying status +
detail) — so callers can degrade explicitly instead of shipping placeholder
assets off as real generations.

Environment contract
--------------------
Canonical (new) variables:

- ``MEDIA_GATEWAY_URL``      — base URL of the OpenAI-compatible media gateway.
- ``MEDIA_GATEWAY_API_KEY``  — bearer key presented to the gateway.
- ``MEDIA_IMAGE_MODEL``      — diffusion model  (default ``SD-Turbo``).
- ``MEDIA_TTS_MODEL``        — speech model     (default ``kokoro-v1``).
- ``MEDIA_STT_MODEL``        — transcription    (default ``Whisper-Large-v3-Turbo``).
- ``MEDIA_SFX_MODEL``        — sound effects    (default ``ThinkSound-SFX``).

Deprecated fallbacks: when ``MEDIA_GATEWAY_URL`` / ``MEDIA_GATEWAY_API_KEY``
are unset, the legacy ``LEMONADE_BASE_URL`` / ``LEMONADE_API_KEY`` values are
honored so existing deployments keep working; each construction that falls
back logs ONE INFO line naming the deprecated variable it used so operators
get a migration nudge without log spam.

Endpoints exercised (all verified live against the deployment this targets):
- POST /v1/images/generations  {model, prompt, size, steps} -> {data:[{b64_json}]}
- POST /v1/audio/speech        {model, input, voice, response_format} -> audio bytes
- POST /v1/audio/transcriptions multipart(model, file=wav) -> {"text": ...}
- POST /v1/audio/generations   {model, prompt} -> wav bytes
- GET  /v1/models

Timeouts are per operation because generation cost differs wildly:
SD-Turbo images get 300s, ThinkSound SFX 240s, kokoro TTS and Whisper STT
120s each, and /v1/models only 10s.

Capability discovery
--------------------
``discover_capabilities()`` probes GET /v1/models and maps advertised labels
(embeddings / tts / transcription / image / audio-generation / chat) onto
boolean flags. Some gateways do not label their models properly — the result
is then honestly all-false rather than guessed; callers (routes) still ATTEMPT
the generation call anyway, only the startup log reports what was actually
advertised.
"""

import base64
import logging
import os
from typing import Any, Dict, Optional

import httpx


DEFAULT_MEDIA_GATEWAY_URL = "http://127.0.0.1:13305"
# Retained default key from the original self-hosted deployment so an upgrade
# does not silently start sending "Bearer <wrong>" to gateways that never set
# any key env var at all.
DEFAULT_MEDIA_GATEWAY_API_KEY = "lemonade"

IMAGE_TIMEOUT_SECONDS = 300.0   # SD-Turbo diffusion steps on shared GPU
SFX_TIMEOUT_SECONDS = 240.0     # ThinkSound waveform synthesis
TTS_TIMEOUT_SECONDS = 120.0     # kokoro speech synthesis
STT_TIMEOUT_SECONDS = 120.0     # Whisper-Large-v3-Turbo transcription
MODELS_TIMEOUT_SECONDS = 10.0   # cheap catalog listing

DEFAULT_IMAGE_MODEL = "SD-Turbo"
DEFAULT_TTS_MODEL = "kokoro-v1"
DEFAULT_STT_MODEL = "Whisper-Large-v3-Turbo"
DEFAULT_SFX_MODEL = "ThinkSound-SFX"

_logger = logging.getLogger("aethertable.media")

# Advertised label -> capability flag. Matching is substring-based on the
# lowercased label text so variants like "audio-generation"/"audio_generation"
# both land.
_CAPABILITY_LABELS: Dict[str, tuple] = {
    "embeddings": ("embedding",),
    "tts": ("tts", "speech",),
    "transcription": ("transcription", "whisper", "stt",),
    "image": ("image",),
    "audio_generation": ("audio-generation", "audio_generation"),
    "chat": ("chat", "completions",),
}


class MediaGatewayUnavailableError(Exception):
    """Raised when the media gateway host cannot be reached or times out."""


class MediaGatewayRejectedError(Exception):
    """Raised when the media gateway answers with a non-2xx status."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(
            f"media gateway rejected request ({status_code}): {detail}"
        )


# Backward-compatible aliases for code written against the original
# Lemonade-specific names (kept importable; not used internally anymore).
LemonadeUnavailableError = MediaGatewayUnavailableError
LemonadeRejectedError = MediaGatewayRejectedError


def _resolve_env(new_var: str, legacy_var: str, default: str) -> str:
    """Reads one config value with a documented deprecated fallback.

    Returns ``(value, used_legacy)``. The caller owns logging exactly one
    line per deprecated hit so migrations are visible but not spammy.
    """
    value = os.environ.get(new_var)
    if value:
        return value, False
    legacy = os.environ.get(legacy_var)
    if legacy:
        _logger.info(
            "deprecated env var in use: %s -> treating as %s; "
            "set the canonical variable to silence this notice",
            legacy_var,
            new_var,
        )
        return legacy, True
    return default, False


class MediaGatewayClient:
    """Async client for an OpenAI-compatible media gateway.

    ``transport`` is injectable so tests can drive everything through an
    ``httpx.MockTransport`` without any network; production uses the default
    transport built from ``MEDIA_GATEWAY_URL`` / ``MEDIA_GATEWAY_API_KEY``
    (with legacy LEMONADE_* fallbacks, see the module docstring).
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
        image_model: Optional[str] = None,
        tts_model: Optional[str] = None,
        stt_model: Optional[str] = None,
        sfx_model: Optional[str] = None,
    ):
        if base_url is not None:
            self.base_url = base_url.rstrip("/")
            self.used_legacy_env_url = False
        else:
            resolved, legacy_used = _resolve_env(
                "MEDIA_GATEWAY_URL", "LEMONADE_BASE_URL",
                DEFAULT_MEDIA_GATEWAY_URL,
            )
            self.base_url = resolved.rstrip("/")
            self.used_legacy_env_url = legacy_used
        if api_key is not None:
            self.api_key = api_key
            self.used_legacy_env_key = False
        else:
            resolved, legacy_used = _resolve_env(
                "MEDIA_GATEWAY_API_KEY", "LEMONADE_API_KEY",
                DEFAULT_MEDIA_GATEWAY_API_KEY,
            )
            self.api_key = resolved
            self.used_legacy_env_key = legacy_used

        # Per-capability models: explicit constructor arg > env > built-in
        # default, mirroring how base_url/api_key resolve.
        def _model(env_var: str, default: str, override: Optional[str]) -> str:
            return override or os.environ.get(env_var) or default

        self.image_model = _model("MEDIA_IMAGE_MODEL", DEFAULT_IMAGE_MODEL, image_model)
        self.tts_model = _model("MEDIA_TTS_MODEL", DEFAULT_TTS_MODEL, tts_model)
        self.stt_model = _model("MEDIA_STT_MODEL", DEFAULT_STT_MODEL, stt_model)
        self.sfx_model = _model("MEDIA_SFX_MODEL", DEFAULT_SFX_MODEL, sfx_model)

        self._transport = transport

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def _post_json(
        self, path: str, payload: Dict[str, Any], timeout_s: float
    ) -> Any:
        """POST a JSON body and return the parsed JSON response."""
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=timeout_s, transport=self._transport) as client:
                resp = await client.post(url, headers=self._headers(), json=payload)
                if resp.status_code >= 400:
                    raise MediaGatewayRejectedError(resp.status_code, resp.text)
                return resp.json()
        except httpx.TimeoutException as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway timed out after {timeout_s}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway unreachable at {url}: {exc}"
            ) from exc

    async def _post_bytes(self, path: str, payload: Dict[str, Any], timeout_s: float) -> bytes:
        """POST a JSON body and return the raw binary response body."""
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=timeout_s, transport=self._transport) as client:
                resp = await client.post(url, headers=self._headers(), json=payload)
                if resp.status_code >= 400:
                    raise MediaGatewayRejectedError(resp.status_code, resp.text)
                return resp.content
        except httpx.TimeoutException as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway timed out after {timeout_s}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway unreachable at {url}: {exc}"
            ) from exc

    async def generate_image(
        self,
        prompt: str,
        size: str = "512x512",
        steps: int = 4,
        model: Optional[str] = None,
    ) -> bytes:
        """Generate one image; returns decoded PNG bytes.

        ``model`` overrides the configured ``MEDIA_IMAGE_MODEL`` for this call.
        """
        data = await self._post_json(
            "/v1/images/generations",
            {
                "model": model or self.image_model,
                "prompt": prompt,
                "size": size,
                "steps": steps,
            },
            IMAGE_TIMEOUT_SECONDS,
        )
        try:
            b64 = data["data"][0]["b64_json"]
        except (KeyError, IndexError, TypeError) as exc:
            raise MediaGatewayRejectedError(
                200, f"malformed image response: {exc}"
            ) from exc
        return base64.b64decode(b64)

    async def text_to_speech(
        self,
        text: str,
        voice: str = "af_sky",
        fmt: str = "wav",
        model: Optional[str] = None,
    ) -> bytes:
        """Synthesize speech; returns raw audio bytes in the requested format.

        ``model`` overrides the configured ``MEDIA_TTS_MODEL`` for this call.
        """
        return await self._post_bytes(
            "/v1/audio/speech",
            {
                "model": model or self.tts_model,
                "input": text,
                "voice": voice,
                "response_format": fmt,
            },
            TTS_TIMEOUT_SECONDS,
        )

    async def transcribe(
        self,
        wav_bytes: bytes,
        filename: str = "input.wav",
        model: Optional[str] = None,
    ) -> str:
        """Transcribe a wav recording; returns the recognized text.

        ``model`` overrides the configured ``MEDIA_STT_MODEL`` for this call.
        """
        url = f"{self.base_url}/v1/audio/transcriptions"
        files = {"file": (filename, wav_bytes, "audio/wav")}
        data = {"model": model or self.stt_model}
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            async with httpx.AsyncClient(timeout=STT_TIMEOUT_SECONDS, transport=self._transport) as client:
                resp = await client.post(url, headers=headers, files=files, data=data)
                if resp.status_code >= 400:
                    raise MediaGatewayRejectedError(resp.status_code, resp.text)
                return resp.json().get("text", "")
        except httpx.TimeoutException as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway timed out after {STT_TIMEOUT_SECONDS}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway unreachable at {url}: {exc}"
            ) from exc

    async def generate_sfx(
        self, prompt: str, model: Optional[str] = None
    ) -> bytes:
        """Generate a sound effect; returns raw 44.1kHz stereo wav bytes.

        ``model`` overrides the configured ``MEDIA_SFX_MODEL`` for this call.
        """
        return await self._post_bytes(
            "/v1/audio/generations",
            {"model": model or self.sfx_model, "prompt": prompt},
            SFX_TIMEOUT_SECONDS,
        )

    async def list_models(self) -> Dict[str, Any]:
        """List served models (cheap liveness/catalog probe)."""
        url = f"{self.base_url}/v1/models"
        try:
            async with httpx.AsyncClient(timeout=MODELS_TIMEOUT_SECONDS, transport=self._transport) as client:
                resp = await client.get(url, headers={"Authorization": f"Bearer {self.api_key}"})
                if resp.status_code >= 400:
                    raise MediaGatewayRejectedError(resp.status_code, resp.text)
                return resp.json()
        except httpx.TimeoutException as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway timed out after {MODELS_TIMEOUT_SECONDS}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise MediaGatewayUnavailableError(
                f"media gateway unreachable at {url}: {exc}"
            ) from exc

    async def discover_capabilities(self) -> Dict[str, bool]:
        """Probe /v1/models and map advertised labels to capability flags.

        Returned keys: embeddings, tts, transcription, image,
        audio_generation, chat. A gateway whose model list carries no usable
        labels yields all-False — that is reported honestly rather than
        inferred; callers still attempt their calls regardless.
        """
        catalog = await self.list_models()
        entries = catalog.get("data") if isinstance(catalog, dict) else None
        entries = entries if isinstance(entries, list) else []
        texts = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for field in ("id", "name"):
                value = entry.get(field)
                if isinstance(value, str):
                    texts.append(value.lower())
                for label_field in ("labels", "capabilities", "tags"):
                    labeled = entry.get(label_field)
                    if isinstance(labeled, list):
                        texts.extend(
                            str(item).lower() for item in labeled
                            if isinstance(item, (str, type(None)))
                        )
                    elif isinstance(labeled, str):
                        texts.append(labeled.lower())
        joined = "\n".join(texts)
        return {
            capability: any(token in joined for token in tokens)
            for capability, tokens in _CAPABILITY_LABELS.items()
        }


# Backward-compatible class alias for pre-rename importers/tests.
LemonadeClient = MediaGatewayClient
