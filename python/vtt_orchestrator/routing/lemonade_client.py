"""Lemonade multimedia client.

Thin async httpx wrapper around a self-hosted Lemonade server's
OpenAI-compatible multimedia endpoints (images, TTS, STT, SFX). The gateway
never fabricates media: every failure surfaces as one of two honest
exceptions — ``LemonadeUnavailableError`` (host unreachable / transport
timeout) or ``LemonadeRejectedError`` (non-2xx carrying status + detail) —
so callers can degrade explicitly instead of shipping placeholder assets
off as real generations.

Endpoints exercised (all verified live against the deployment this targets):
- POST /v1/images/generations  {model, prompt, size, steps} -> {data:[{b64_json}]}
- POST /v1/audio/speech        {model, input, voice, response_format} -> audio bytes
- POST /v1/audio/transcriptions multipart(model, file=wav) -> {"text": ...}
- POST /v1/audio/generations   {model, prompt} -> wav bytes
- GET  /v1/models

Timeouts are per operation because generation cost differs wildly:
SD-Turbo images get 300s, ThinkSound SFX 240s, kokoro TTS and Whisper STT
120s each, and /v1/models only 10s.
"""

import base64
import os
from typing import Any, Dict, Optional

import httpx


LEMONADE_BASE_URL = os.environ.get("LEMONADE_BASE_URL", "http://127.0.0.1:13305")
LEMONADE_API_KEY = os.environ.get("LEMONADE_API_KEY", "lemonade")

IMAGE_TIMEOUT_SECONDS = 300.0   # SD-Turbo diffusion steps on shared GPU
SFX_TIMEOUT_SECONDS = 240.0     # ThinkSound waveform synthesis
TTS_TIMEOUT_SECONDS = 120.0     # kokoro speech synthesis
STT_TIMEOUT_SECONDS = 120.0     # Whisper-Large-v3-Turbo transcription
MODELS_TIMEOUT_SECONDS = 10.0   # cheap catalog listing

IMAGE_MODEL = "SD-Turbo"
TTS_MODEL = "kokoro-v1"
STT_MODEL = "Whisper-Large-v3-Turbo"
SFX_MODEL = "ThinkSound-SFX"


class LemonadeUnavailableError(Exception):
    """Raised when the Lemonade host cannot be reached or times out."""


class LemonadeRejectedError(Exception):
    """Raised when Lemonade answers with a non-2xx status."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Lemonade rejected request ({status_code}): {detail}")


class LemonadeClient:
    """Async client for the Lemonade multimedia endpoints.

    ``transport`` is injectable so tests can drive everything through an
    ``httpx.MockTransport`` without any network; production uses the default
    transport built from ``LEMONADE_BASE_URL`` / ``LEMONADE_API_KEY``.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        transport: Optional[httpx.BaseTransport] = None,
    ):
        self.base_url = (
            base_url
            or os.environ.get("LEMONADE_BASE_URL")
            or LEMONADE_BASE_URL
        ).rstrip("/")
        self.api_key = (
            api_key or os.environ.get("LEMONADE_API_KEY") or LEMONADE_API_KEY
        )
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
                    raise LemonadeRejectedError(resp.status_code, resp.text)
                return resp.json()
        except httpx.TimeoutException as exc:
            raise LemonadeUnavailableError(
                f"Lemonade timed out after {timeout_s}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise LemonadeUnavailableError(f"Lemonade unreachable at {url}: {exc}") from exc

    async def _post_bytes(self, path: str, payload: Dict[str, Any], timeout_s: float) -> bytes:
        """POST a JSON body and return the raw binary response body."""
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=timeout_s, transport=self._transport) as client:
                resp = await client.post(url, headers=self._headers(), json=payload)
                if resp.status_code >= 400:
                    raise LemonadeRejectedError(resp.status_code, resp.text)
                return resp.content
        except httpx.TimeoutException as exc:
            raise LemonadeUnavailableError(
                f"Lemonade timed out after {timeout_s}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise LemonadeUnavailableError(f"Lemonade unreachable at {url}: {exc}") from exc

    async def generate_image(
        self,
        prompt: str,
        size: str = "512x512",
        steps: int = 4,
    ) -> bytes:
        """Generate one image; returns decoded PNG bytes."""
        data = await self._post_json(
            "/v1/images/generations",
            {"model": IMAGE_MODEL, "prompt": prompt, "size": size, "steps": steps},
            IMAGE_TIMEOUT_SECONDS,
        )
        try:
            b64 = data["data"][0]["b64_json"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LemonadeRejectedError(
                200, f"malformed image response: {exc}"
            ) from exc
        return base64.b64decode(b64)

    async def text_to_speech(
        self,
        text: str,
        voice: str = "af_sky",
        fmt: str = "wav",
    ) -> bytes:
        """Synthesize speech; returns raw audio bytes in the requested format."""
        return await self._post_bytes(
            "/v1/audio/speech",
            {
                "model": TTS_MODEL,
                "input": text,
                "voice": voice,
                "response_format": fmt,
            },
            TTS_TIMEOUT_SECONDS,
        )

    async def transcribe(self, wav_bytes: bytes, filename: str = "input.wav") -> str:
        """Transcribe a wav recording; returns the recognized text."""
        url = f"{self.base_url}/v1/audio/transcriptions"
        files = {"file": (filename, wav_bytes, "audio/wav")}
        data = {"model": STT_MODEL}
        headers = {"Authorization": f"Bearer {self.api_key}"}
        try:
            async with httpx.AsyncClient(timeout=STT_TIMEOUT_SECONDS, transport=self._transport) as client:
                resp = await client.post(url, headers=headers, files=files, data=data)
                if resp.status_code >= 400:
                    raise LemonadeRejectedError(resp.status_code, resp.text)
                return resp.json().get("text", "")
        except httpx.TimeoutException as exc:
            raise LemonadeUnavailableError(
                f"Lemonade timed out after {STT_TIMEOUT_SECONDS}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise LemonadeUnavailableError(f"Lemonade unreachable at {url}: {exc}") from exc

    async def generate_sfx(self, prompt: str) -> bytes:
        """Generate a sound effect; returns raw 44.1kHz stereo wav bytes."""
        return await self._post_bytes(
            "/v1/audio/generations",
            {"model": SFX_MODEL, "prompt": prompt},
            SFX_TIMEOUT_SECONDS,
        )

    async def list_models(self) -> Dict[str, Any]:
        """List served models (cheap liveness/catalog probe)."""
        url = f"{self.base_url}/v1/models"
        try:
            async with httpx.AsyncClient(timeout=MODELS_TIMEOUT_SECONDS, transport=self._transport) as client:
                resp = await client.get(url, headers={"Authorization": f"Bearer {self.api_key}"})
                if resp.status_code >= 400:
                    raise LemonadeRejectedError(resp.status_code, resp.text)
                return resp.json()
        except httpx.TimeoutException as exc:
            raise LemonadeUnavailableError(
                f"Lemonade timed out after {MODELS_TIMEOUT_SECONDS}s at {url}: {exc}"
            ) from exc
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise LemonadeUnavailableError(f"Lemonade unreachable at {url}: {exc}") from exc
