"""
Authoritative Rules Engine HTTP Client
Thin httpx wrapper around the Rust vtt-server engine (crates/vtt-server).
The browser talks only to this orchestrator; all dice math stays in vtt-core.
"""

import os
import uuid
from typing import Any, Dict, Optional

import httpx

ENGINE_API_URL = os.environ.get("ENGINE_API_URL", "http://localhost:8088")
ENGINE_TIMEOUT_SECONDS = 5.0


class EngineUnavailableError(Exception):
    """Raised when the authoritative engine cannot be reached."""


async def engine_request(method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Perform one request against the engine; raise EngineUnavailableError on failure."""
    url = f"{ENGINE_API_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=ENGINE_TIMEOUT_SECONDS) as client:
            response = await client.request(method, url, json=payload)
            response.raise_for_status()
            return response.json()
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise EngineUnavailableError(f"Engine unreachable at {url}: {exc}") from exc


def _coerce_uuid(value: str) -> str:
    """Pass through valid UUIDs; mint a stable-looking one for demo ids like 'thorin'."""
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return str(uuid.uuid5(uuid.NAMESPACE_URL, value))


async def create_session(campaign_id: str, session_name: str) -> Dict[str, Any]:
    return await engine_request(
        "POST",
        "/api/v1/sessions",
        {"campaign_id": _coerce_uuid(campaign_id), "session_name": session_name},
    )


async def resolve_attack(session_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
    return await engine_request("POST", f"/api/v1/sessions/{session_id}/action/attack", action)


async def resolve_check(action: Dict[str, Any]) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/actions/check", action)


async def resolve_save(action: Dict[str, Any]) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/actions/save", action)


async def resolve_concentration(action: Dict[str, Any]) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/actions/concentration", action)


async def resolve_death_save(action: Dict[str, Any]) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/actions/death-save", action)


async def generate_map(request: Dict[str, Any]) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/maps/generate", request)
