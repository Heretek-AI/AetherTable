"""
Authoritative Rules Engine HTTP Client
Thin httpx wrapper around the Rust vtt-server engine (crates/vtt-server).
The browser talks only to this orchestrator; all dice math stays in vtt-core.

Every request carries an HMAC session token signed with the shared
AUTH_SECRET so vtt-server's zero-trust middleware accepts gateway traffic.
"""

import base64
import hashlib
import hmac as hmac_mod
import json
import os
import time
import uuid
from typing import Any, Dict, Optional

import httpx

ENGINE_API_URL = os.environ.get("ENGINE_API_URL", "http://localhost:8088")
ENGINE_TIMEOUT_SECONDS = 5.0

_AUTH_SECRET = os.environ.get(
    "VTT_ENGINE_SECRET", os.environ.get("AUTH_SECRET", "aethertable-dev-secret")
)
_SERVICE_TOKEN_TTL_SECONDS = 600


def _sign_token(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = hmac_mod.new(_AUTH_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(raw).decode() + "." + sig


def _service_token() -> str:
    """Gateway service identity token for server-to-server engine calls."""
    return _sign_token(
        {"user_id": "orchestrator-service", "exp": time.time() + _SERVICE_TOKEN_TTL_SECONDS}
    )


def _actor_token(actor: Optional[Dict[str, str]]) -> str:
    """Token carrying the ORIGINAL caller's identity so the engine's RBAC
    layer authorizes the real actor (entity ownership, spectator limits)
    rather than the gateway itself. Falls back to the service principal for
    server-mediated calls (lobby launch, character deploy)."""
    if not actor:
        return _service_token()
    return _sign_token(
        {
            "user_id": actor["user_id"],
            "role": actor.get("role", "player"),
            "exp": time.time() + _SERVICE_TOKEN_TTL_SECONDS,
        }
    )


class EngineUnavailableError(Exception):
    """Raised when the authoritative engine cannot be reached."""

class EngineRejectedError(Exception):
    """Raised when the authoritative engine rejects a proposed action (4xx)."""

    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Engine rejected request ({status_code}): {detail}")


async def engine_request(
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    *,
    actor: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Perform one authenticated request against the engine.

    Pass ``actor`` ({"user_id", "role"}) when the request acts on behalf of a
    browser caller so the engine's RBAC sees the real player identity.
    """
    url = f"{ENGINE_API_URL}{path}"
    headers = {"Authorization": f"Bearer {_actor_token(actor)}"}
    try:
        async with httpx.AsyncClient(timeout=ENGINE_TIMEOUT_SECONDS) as client:
            response = await client.request(method, url, json=payload, headers=headers)
            if response.status_code >= 400:
                raise EngineRejectedError(response.status_code, response.text)
            return response.json()
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise EngineUnavailableError(f"Engine unreachable at {url}: {exc}") from exc


def engine_request_sync(
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    *,
    actor: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Synchronous twin of engine_request for test/tooling call sites."""
    url = f"{ENGINE_API_URL}{path}"
    headers = {"Authorization": f"Bearer {_actor_token(actor)}"}
    try:
        with httpx.Client(timeout=ENGINE_TIMEOUT_SECONDS) as client:
            response = client.request(method, url, json=payload, headers=headers)
            if response.status_code >= 400:
                raise EngineRejectedError(response.status_code, response.text)
            return response.json()
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        raise EngineUnavailableError(f"Engine unreachable at {url}: {exc}") from exc


def _coerce_uuid(value: str) -> str:
    """Pass through valid UUIDs; mint a stable-looking one for demo ids like 'thorin'."""
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        return str(uuid.uuid5(uuid.NAMESPACE_URL, value))


async def create_session(
    campaign_id: str, session_name: str, actor: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    return await engine_request(
        "POST",
        "/api/v1/sessions",
        {"campaign_id": _coerce_uuid(campaign_id), "session_name": session_name},
        actor=actor,
    )


async def resolve_attack(
    session_id: str,
    action: Dict[str, Any],
    *,
    actor: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    return await engine_request(
        "POST", f"/api/v1/sessions/{session_id}/action/attack", action, actor=actor
    )


async def resolve_check(
    action: Dict[str, Any], *, actor: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/actions/check", action, actor=actor)


async def resolve_save(
    action: Dict[str, Any], *, actor: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/actions/save", action, actor=actor)


async def resolve_concentration(
    action: Dict[str, Any], *, actor: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/actions/concentration", action, actor=actor)


async def resolve_death_save(
    session_id: str,
    entity_id: str,
    *,
    actor: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Death saves resolve against the SERVER-side entity state — the client
    may only name the entity, never supply counters."""
    return await engine_request(
        "POST",
        f"/api/v1/sessions/{session_id}/action/death-save",
        {"entity_id": _coerce_uuid(entity_id)},
        actor=actor,
    )


async def generate_map(
    request: Dict[str, Any], *, actor: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    return await engine_request("POST", "/api/v1/maps/generate", request, actor=actor)
