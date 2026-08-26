"""Agent-driven campaign simulation (backlog item 5.1 / 5.2).

N synthetic ``CampaignSimPlayer``s walk the exact same surface a real client
does — auth signup/login (HMAC tokens), lobby create/join/launch, character
create/deploy (RBAC-owned engine entities), then T rounds of turns executed
through the SAME authenticated orchestrator proxy endpoints with ``?token=``
forwarding each player's identity to the engine's RBAC layer.

Turn decisions come from the configured custom LLM endpoint
(``LLM_API``/``LLM_KEY``/``LLM_MODEL``) via the existing
``routing.llm_client.LLMStreamingGateway.complete_json`` so every call lands in
the shared JSONL log. Model output is parsed defensively; anything malformed,
unknown, or unavailable falls back to a deterministic scripted policy FOR THAT
TURN while still counting the attempt. With no key configured the whole run is
tagged ``mode: "scripted"`` and never touches the network.

The report fabricates nothing: every number in it is counted from observed
proxy responses.

Social-state telemetry (integration with ``npc_disposition``): every
ACCEPTED attack a player lands on an NPC/target records an ``"attacked"``
directed interaction on that target's ``NpcDispositionEngine`` state toward
the player; accepted checks and moves record nothing. Each candidate
target's CURRENT stance toward the acting player is injected into both the
LLM decision prompt and the scripted-policy inputs so decisions are socially
grounded, with unknown targets defaulting to a neutral stance. All
timestamps passed to the engine are explicit sim-clock values
(``round * 10.0 + turn index``) — never wall-clock. There is deliberately NO
``"aided"`` hook yet: the sim's action vocabulary (attack/move/check) has no
heal-like action reachable through the proxies, so cooperative interactions
cannot be observed here; when a heal/protection action exists it should call
``_record_social`` with kind ``"aided"``.

Social dialogue phase (integration with ``agents.npc_sub_agent``): between
combat rounds, each player may attempt ONE dialogue interaction with a
designated "social NPC". The player's decision ({approach, utterance}) comes
from the SAME gateway path as combat decisions — strict JSON, validated
defensively, with a deterministic scripted fallback per current stance — and
the reply comes from that NPC's ``ConcordiaNPC.respond_to`` via the injectable
``npc_registry`` constructor parameter. With no registry supplied the phase is
skipped ENTIRELY (empty ``rounds[].social``, zero social totals) rather than
simulated with invented chatter. Every exchange records its approach on the
disposition engine (``"aided"``/``"gifted"`` positive,
``"threatened"``/``"ignored"`` negative) so repeated hostile approaches shift
the NPC's stance across rounds — and the NPC's replies reflect it, because
``respond_to`` reads the stance it is handed. Norms enforcement stays absolute:
an LLM utterance or reply that trips the NPC's social norms degrades the whole
exchange to the template voice with the ``norm_rejected`` reason surfaced in
the round report.

Campaign Director telemetry (integration with ``agents.agent_hierarchy``):
after each round, the sim folds that round's OBSERVED outcomes — HP damage
dealt (from accepted attack verdicts), entity deaths, disposition stance
transitions, rounds elapsed — into an injectable ``DirectorAgent``'s
deterministic tension curve, and records each player's ACCEPTED action count.
The resulting ``director`` block of the report carries the curve and the
director's recommendations verbatim; it is pure accounting over counted
events, never invented.

Reaction-layer play (iteration 81): the tactical players now exercise the NEW
mechanics through the SAME authenticated proxies. When a move response
discloses a pending opportunity attack against the mover (the engine's
``opportunity_attacks_detail`` wire disclosure), the OPPONENT seat takes the
swing on its next available action via ``/api/v1/engine/opportunity-attack``
— ownerless NPC attackers are driven by the host seat, which the engine's own
RBAC authorizes for ownerless entities. Seats also occasionally spend their
Action on a READY (structured trigger ``enemy_attacks`` or
``enemy_enters_reach``) and RELEASE it once the declared trigger observably
fires, via ``/api/v1/engine/ready`` + ``/api/v1/engine/ready/release``. A
``decision_seed`` makes every such choice deterministic per seed (same seed,
identical replay); without one the legacy behavior is preserved exactly.
Every reaction attempt is accounted honestly — an engine refusal counts as an
attempted action with its rejection reason recorded, never dropped from the
totals and never reclassified as a compliance failure.

Importable API only — no HTTP routes are added this iteration. To run live:

    # 1. authoritative engine:      cargo run -p vtt-server
    # 2. orchestrator gateway:     cd python && PYTHONPATH=python uvicorn \
    #                              vtt_orchestrator.server:app --port 8000
    # 3. the sim (reads .env):     PYTHONPATH=python python -m \
    #                              vtt_orchestrator.simulation.campaign_sim \
    #                              --players 3 --rounds 4
"""

import asyncio
import json
import math
import os
import random
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx

from ..agents.agent_hierarchy import DirectorAgent
from ..routing.llm_client import LLMConfig, LLMStreamingGateway
from .npc_disposition import NpcDispositionEngine

ORCHESTRATOR_URL = os.environ.get(
    "ORCHESTRATOR_URL",
    f"http://localhost:{os.environ.get('ORCHESTRATOR_PORT', '8000')}",
)

DEFAULT_PASSWORD = "dice-dice-dice"

VALID_ACTIONS = ("attack", "move", "check")

# Reaction-layer decision knobs (iteration 81). The sim's tactical players now
# exercise the NEW reaction mechanics through the SAME authenticated proxy
# surface as every other action:
#
# - opportunity attacks: when a move response discloses a pending OA against
#   the mover (the engine's ``opportunity_attacks`` wire disclosure), the
#   OPPONENT seat takes it on its next available action via
#   /api/v1/engine/opportunity-attack (iteration 78's proxy);
# - readied actions: occasionally a seat spends its Action to READY one and
#   RELEASES it when the structured trigger fires (enemy_attacks /
#   enemy_enters_reach) via /api/v1/engine/ready + .../ready/release.
REACTION_OPPORTUNITY_ATTACK = "opportunity_attack"
REACTION_READY = "readied_ready"
REACTION_RELEASE = "readied_release"

#: Chance per scripted combat turn that a seat READIES instead of acting.
READY_PROBABILITY = 0.15

#: Structured triggers the sim declares (engine shorthand strings; anything
#: else is kept freeform for GM adjudication).
READY_TRIGGERS = ("enemy_attacks", "enemy_enters_reach")

MELEE_REACH_FEET = 5.0


class CampaignSimError(Exception):
    """Raised when the table cannot even be set up (precondition failure)."""


# ---------------------------------------------------------------------------
# Thin authenticated HTTP surface against the orchestrator
# ---------------------------------------------------------------------------

class _OrchestratorHTTP:
    """httpx wrapper for one simulated player's calls into the gateway.

    ``transport`` is injectable so tests can run the REAL FastAPI app through
    an in-process ASGI transport while only the outbound legs (engine, LLM)
    are faked.
    """

    def __init__(self, base_url: Optional[str] = None, transport=None):
        self.base_url = (base_url or ORCHESTRATOR_URL).rstrip("/")
        self._transport = transport
        self.requests: List[Dict[str, Any]] = []

    async def request(self, method, path, json_body=None, params=None):
        async with httpx.AsyncClient(base_url=self.base_url, transport=self._transport) as client:
            resp = await client.request(method, path, json=json_body, params=params)
            try:
                body = resp.json()
            except ValueError:
                body = {"raw": resp.text[:500]}
        record = {
            "method": method, "path": path,
            "status": resp.status_code, "body": body,
        }
        self.requests.append(record)
        return record


def _rejection_reason(body: Any) -> str:
    """Pulls an honest reason string out of an error payload (FastAPI wraps
    engine rejections as {"detail": {...}})."""
    detail = body.get("detail", body) if isinstance(body, dict) else body
    if isinstance(detail, dict):
        for key in ("reason", "error", "code", "message"):
            if detail.get(key):
                return str(detail[key])
        return json.dumps(detail)[:120]
    return str(detail)[:120] if detail else "UNKNOWN"


def _degraded_flag(body: Any) -> bool:
    """True when a response body honestly declares itself degraded."""
    return isinstance(body, dict) and bool(body.get("degraded"))


# ---------------------------------------------------------------------------
# One synthetic player
# ---------------------------------------------------------------------------

class CampaignSimPlayer:
    """A synthetic seat at the table: identity, lobby membership, a persisted
    character deployed as an owned entity, and the ability to take turns."""

    def __init__(
        self,
        name: str,
        index: int,
        *,
        base_url: Optional[str] = None,
        transport=None,
        password: str = DEFAULT_PASSWORD,
        role: str = "player",
        email: Optional[str] = None,
    ):
        self.name = name
        self.index = index
        self.password = password
        # Host (seat 0) is a staff seat so it can spawn the encounter target.
        # It cannot CLAIM 'gm' at signup — see authenticate(): the address is
        # bootstrapped via VTT_ADMIN_EMAILS and the gateway grants admin.
        self.role = role
        # Unique per-run address by default; pass a fixed email to exercise the
        # login-instead-of-signup path.
        self.email = email or f"sim-{name}-{uuid.uuid4().hex[:10]}@campaign-sim.test"
        self.http = _OrchestratorHTTP(base_url=base_url, transport=transport)
        self.token: Optional[str] = None
        self.user_id: Optional[str] = None
        self.display_name = name.title()
        self.lobby_id: Optional[str] = None
        self.invite_code: Optional[str] = None
        self.character_id: Optional[str] = None
        self.entity_id: Optional[str] = None
        self.is_host = False
        # Reaction-layer state (iteration 81): ``readied`` holds this seat's
        # declared Ready (description + structured trigger) between the Ready
        # and its Release. Pending opportunity attacks AGAINST a mover are
        # tracked at the simulation level — they belong to the OPPONENT, who
        # takes them on ITS next available action.
        self.readied: Optional[Dict[str, Any]] = None

    # -- lifecycle ----------------------------------------------------------

    async def authenticate(self) -> None:
        """Signup on a fresh address, login when the email already exists.

        Staff seats (the host) are provisioned through the documented admin
        bootstrap contract (audit F6a): the seat's address is listed in
        VTT_ADMIN_EMAILS for the duration of THIS signup request only, then
        the previous value is restored. In-process harnesses (pytest ASGI
        transport) share the gateway's environment, so this just works there.
        Against a REMOTE gateway the operator must list the seat address in
        the server's own VTT_ADMIN_EMAILS instead — a 422 from signup says
        exactly that rather than silently degrading the seat to a player.
        """
        previous: Optional[str] = None
        touched_env = False
        # Staff seats never CLAIM a staff role (the API rejects that outright);
        # they sign up as a plain player and are granted admin because their
        # address appears in VTT_ADMIN_EMAILS during this signup request.
        requested_role = self.role
        if self.role in ("gm", "admin"):
            requested_role = "player"
            previous = os.environ.get("VTT_ADMIN_EMAILS")
            entries = {e.strip().lower() for e in (previous or "").split(",") if e.strip()}
            if self.email.lower() not in entries:
                touched_env = True
                os.environ["VTT_ADMIN_EMAILS"] = (
                    f"{previous},{self.email}" if previous else self.email
                )
        try:
            signup = await self.http.request(
                "POST", "/api/v1/auth/signup",
                {"email": self.email, "username": self.name,
                 "display_name": self.display_name,
                 "password": self.password, "role": requested_role},
            )
        finally:
            if touched_env:
                if previous is None:
                    os.environ.pop("VTT_ADMIN_EMAILS", None)
                else:
                    os.environ["VTT_ADMIN_EMAILS"] = previous
        if signup["status"] == 200:
            self._adopt_auth(signup["body"])
            return
        if signup["status"] == 409:
            login = await self.http.request("POST", "/api/v1/auth/login",
                                            {"email": self.email, "password": self.password})
            if login["status"] != 200:
                raise CampaignSimError(f"{self.name}: login failed: {login['body']}")
            self._adopt_auth(login["body"])
            return
        if signup["status"] == 422 and self.role in ("gm", "admin"):
            raise CampaignSimError(
                f"{self.name}: staff seat '{self.role}' was refused at signup "
                f"({signup['body']}). When driving a REMOTE gateway, list this "
                f"seat's address ({self.email}) in the server's VTT_ADMIN_EMAILS."
            )
        raise CampaignSimError(f"{self.name}: signup failed ({signup['status']}): {signup['body']}")

    def _adopt_auth(self, body: Dict[str, Any]) -> None:
        self.token = body["token"]
        self.user_id = body["user"]["id"]
        self.role = body["user"].get("role", self.role)

    async def host_table(self, table_name: str) -> None:
        created = await self.authed("POST", "/api/v1/lobbies", {"name": table_name})
        if created["status"] != 200:
            raise CampaignSimError(f"lobby create failed: {created['body']}")
        lobby = created["body"]
        self.lobby_id = lobby["lobby_id"]
        self.invite_code = lobby["invite_code"]
        self.is_host = True

    async def join_table(self, lobby_id: str, invite_code: str) -> None:
        joined = await self.authed("POST", f"/api/v1/lobbies/{lobby_id}/join",
                                   {"invite_code": invite_code})
        if joined["status"] != 200:
            raise CampaignSimError(f"{self.name}: join failed: {joined['body']}")
        self.lobby_id = lobby_id
        self.invite_code = invite_code

    async def mark_ready(self) -> None:
        """Readies this seat so the host's launch passes the readiness gate
        (launch refuses while any member is unready unless forced)."""
        marked = await self.authed(
            "POST", f"/api/v1/lobbies/{self.lobby_id}/ready", {"ready": True})
        if marked["status"] != 200:
            raise CampaignSimError(f"{self.name}: ready failed: {marked['body']}")

    async def launch_table(self) -> str:
        launched = await self.authed("POST", f"/api/v1/lobbies/{self.lobby_id}/launch")
        if launched["status"] != 200:
            raise CampaignSimError(f"lobby launch failed: {launched['body']}")
        return launched["body"]["session_id"]

    async def deploy_character(self, session_id: Optional[str] = None, klass: str = "fighter") -> str:
        session_id = session_id or self._session_id
        created = await self.authed("POST", "/api/v1/characters", {
            "name": self.display_name, "character_class": klass, "level": 3,
            "hp": 28, "ac": 16, "speed": 30,
        })
        if created["status"] != 200:
            raise CampaignSimError(f"{self.name}: character create failed: {created['body']}")
        self.character_id = created["body"]["character_id"]
        deployed = await self.authed(
            "POST", f"/api/v1/characters/{self.character_id}/deploy",
            {"session_id": session_id, "x": 4.0 + self.index, "y": 4.0},
        )
        if deployed["status"] != 200:
            raise CampaignSimError(f"{self.name}: deploy failed: {deployed['body']}")
        self.entity_id = deployed["body"].get("entity_id") or self.character_id
        return self.entity_id

    async def spawn_encounter_target(self, session_id: str) -> str:
        """Host/GM spawns a durable hostile dummy so player actions have a
        legal reference-only target (ids only — no client math)."""
        dummy_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "sim-training-dummy"))
        entity = {
            "id": dummy_id,
            "compendium_id": "monster_training_dummy",
            "name": "Training Dummy",
            "is_player": False,
            "current_hp": 500, "max_hp": 500, "temp_hp": 0,
            "ac": 13,
            "speed_feet": 0.0,
            "position": [8.0, 8.0, 0.0],
            "zone_id": "Zone_Default",
            "abilities": {"strength": 10, "dexterity": 10, "constitution": 10,
                          "intelligence": 10, "wisdom": 10, "charisma": 10},
            "conditions": [],
            "action_budget": {"action": False, "bonus_action": False, "reaction": False,
                              "movement_remaining_feet": 0.0, "free_object_interaction": False},
            "spell_slots_remaining": {},
            "attacks": [],
            "resistances": [], "vulnerabilities": [], "immunities": [],
            "inventory": {"items": {}},
            "is_conscious": True, "is_dead": False, "is_visible": True,
        }
        spawned = await self.authed("POST", "/api/v1/engine/spawn",
                                    {"session_id": session_id, "entity": entity})
        if spawned["status"] != 200:
            raise CampaignSimError(f"dummy spawn failed: {spawned['body']}")
        return spawned["body"].get("entity_id") or dummy_id

    # -- turn-time reads ------------------------------------------------------

    async def observe_session(self) -> Dict[str, Any]:
        """Authoritative snapshot via the read proxy, caller token forwarded."""
        state = await self.authed("POST", "/api/v1/engine/session-state",
                                  {"session_id": self._session_id})
        if state["status"] != 200:
            raise CampaignSimError(f"{self.name}: session-state failed: {state['body']}")
        return parse_snapshot(state["body"])

    # -- action execution -----------------------------------------------------

    async def execute(self, decision: Dict[str, Any]) -> Dict[str, Any]:
        """One action through the SAME proxy endpoints real clients use."""
        action = decision["action"]
        session_id = self._session_id
        if action == "attack":
            record = await self.authed("POST", "/api/v1/engine/attack", {
                "session_id": session_id,
                "attacker_id": self.entity_id,
                "target_id": decision["target_id"],
                "action_index": int(decision.get("action_index", 0)),
            })
        elif action == "move":
            record = await self.authed("POST", "/api/v1/engine/move", {
                "session_id": session_id,
                "entity_id": self.entity_id,
                "x": float(decision["x"]),
                "y": float(decision["y"]),
            })
        elif action == "check":
            record = await self.authed("POST", "/api/v1/engine/check", {
                "modifier": int(decision.get("modifier", 1)),
                "dc": int(decision.get("dc", 12)),
            })
        else:  # defensive: decisions are validated upstream, never trust them twice
            return {"attempted": False, "accepted": False, "rejected": True,
                    "rejection_reason": "INVALID_ACTION", "response_status": None,
                    "degraded": False, "outcome": None}

        accepted = record["status"] < 400
        body = record["body"]
        rejected = not accepted or (isinstance(body, dict) and body.get("ok") is False)
        return {
            "attempted": True,
            "accepted": accepted and not rejected,
            "rejected": rejected,
            "rejection_reason": None if not rejected else _rejection_reason(body),
            "response_status": record["status"],
            "outcome": body if accepted else None,
            "degraded": _degraded_flag(body),
        }

    async def execute_reaction(self, reaction: Dict[str, Any]) -> Dict[str, Any]:
        """One reaction-layer action (OA take / ready / release) through the
        SAME authenticated proxy endpoints. These are EXTRA attempts beyond
        the seat's regular turn action — counted honestly wherever they land."""
        kind = reaction["reaction_kind"]
        session_id = self._session_id
        if kind == REACTION_OPPORTUNITY_ATTACK:
            path, payload = "/api/v1/engine/opportunity-attack", {
                "session_id": session_id,
                "attacker_id": reaction["attacker_id"],
                "target_id": reaction["target_id"],
            }
        elif kind == REACTION_READY:
            payload = {
                "session_id": session_id,
                "entity_id": self.entity_id,
                "description": reaction["description"],
            }
            trigger = reaction.get("trigger")
            if trigger:
                payload["trigger"] = trigger
            path = "/api/v1/engine/ready"
        elif kind == REACTION_RELEASE:
            path, payload = "/api/v1/engine/ready/release", {
                "session_id": session_id,
                "entity_id": self.entity_id,
            }
        else:
            return {"attempted": False, "accepted": False, "rejected": True,
                    "rejection_reason": "INVALID_REACTION",
                    "response_status": None, "outcome": None, "degraded": False}

        record = await self.authed("POST", path, payload)
        accepted = record["status"] < 400
        body = record["body"]
        rejected = not accepted or (isinstance(body, dict) and body.get("ok") is False)
        if kind == REACTION_READY and accepted:
            self.readied = {
                "description": reaction.get("description", ""),
                "trigger": reaction.get("trigger") or "enemy_attacks",
            }
        elif kind == REACTION_RELEASE:
            self.readied = None
        return {
            "attempted": True,
            "accepted": accepted and not rejected,
            "rejected": rejected,
            "rejection_reason": None if not rejected else _rejection_reason(body),
            "response_status": record["status"],
            "outcome": body if accepted else None,
            "degraded": _degraded_flag(body),
        }

    async def authed(self, method: str, path: str, json_body: Optional[Dict[str, Any]] = None):
        """One ?token=-authenticated call, exactly like the browser client."""
        if self.token is None:
            raise CampaignSimError(f"{self.name}: not authenticated")
        return await self.http.request(method, path, json_body, params={"token": self.token})

    @property
    def _session_id(self) -> str:
        if getattr(self, "_sid", None) is None:
            raise CampaignSimError(f"{self.name}: no active session")
        return self._sid

    def bind_session(self, session_id: str) -> None:
        self._sid = session_id


# ---------------------------------------------------------------------------
# Snapshot parsing + decision policies
# ---------------------------------------------------------------------------

def parse_snapshot(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Defensive projection of the raw engine GET-session payload into just
    what a decision needs. Never invents values it cannot see."""
    entities = []
    for entity_id, entity in (raw.get("entities") or {}).items():
        if not isinstance(entity, dict):
            continue
        entities.append({
            "id": entity.get("id", entity_id),
            "name": entity.get("name", "Unknown"),
            "hp": _as_int(entity.get("current_hp")),
            "max_hp": _as_int(entity.get("max_hp")),
            "ac": _as_int(entity.get("ac")),
            "position": entity.get("position") if isinstance(entity.get("position"), list) else None,
            "is_player": bool(entity.get("is_player", False)),
            "owner_player_id": entity.get("owner_player_id"),
            "is_dead": bool(entity.get("is_dead", False)),
            "is_visible": bool(entity.get("is_visible", True)),
        })
    return {"entities": entities}


def _as_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def scripted_decision(
    player: CampaignSimPlayer,
    snapshot: Dict[str, Any],
    round_no: int,
    stances: Optional[Dict[str, str]] = None,
    *,
    seed: Optional[int] = None,
) -> Dict[str, Any]:
    """Deterministic fallback policy — no RNG anywhere UNLESS a decision seed
    is supplied, and even then a per-(seed, player-index, round) draw so any
    two runs sharing a seed replay identically (iteration 81's determinism
    contract):

    round % 3 == 0 -> Perception-style check; badly hurt -> retreat move;
    even rounds -> reposition move; otherwise attack the lowest-id living
    hostile; with no legal target left, fall back to a check.

    Reaction layer: with a seed, each combat turn has a small fixed chance of
    being spent on READY instead ("I attack when an enemy attacks" /
    "...enters my reach"); without one the legacy behavior is preserved
    exactly (``ready_this_turn`` False). The same seeded draw also picks the
    even-round reposition DIRECTION (toward or away from the nearest hostile)
    — stepping away from an armed adjacent enemy is exactly what provokes an
    opportunity attack, so the sim genuinely exercises the reaction path.

    ``stances`` maps target display name/id -> current disposition stance of
    that target toward this player (socially grounded input). The current
    rules do not branch on it, but it is part of the contract so future
    policies (and the LLM fallback path) see the same social state the LLM
    sees.
    """
    del stances  # documented input for socially-aware policy variants
    own = next((e for e in snapshot["entities"] if e["id"] == player.entity_id), None)
    ready_this_turn = _seeded_ready_roll(
        seed, getattr(player, "index", 0), round_no)
    step_away = _seeded_step_away_roll(seed, getattr(player, "index", 0), round_no)
    if round_no % 3 == 0 or own is None:
        decision = {"action": "check"}
    else:
        hostiles = sorted(
            (
                e for e in snapshot["entities"]
                if e["id"] != player.entity_id and not e["is_dead"] and not e["is_player"]
            ),
            key=lambda e: str(e["id"]),
        )
        if not hostiles:
            decision = {"action": "check"}
        elif own["hp"] is not None and own["max_hp"] and \
                own["hp"] <= own["max_hp"] * 0.25:
            pos = own["position"] or [5.0, 5.0]
            decision = {"action": "move", "x": float(pos[0]) - 5.0,
                        "y": float(pos[1]) - 5.0}
        elif round_no % 2 == 0:
            target_pos = hostiles[0]["position"] or [8.0, 8.0]
            own_pos = own["position"] or [4.0, 4.0]
            direction = -1.0 if step_away else 1.0
            step_x = direction * (2.0 if float(target_pos[0]) >= float(own_pos[0])
                                  else -2.0)
            decision = {"action": "move",
                        "x": float(own_pos[0]) + step_x,
                        "y": float(own_pos[1])}
        else:
            decision = {"action": "attack", "target_id": hostiles[0]["id"]}
    decision["ready_this_turn"] = bool(ready_this_turn)
    return decision


def _seeded_ready_roll(seed: Optional[int], player_index: int, round_no: int) -> bool:
    """One deterministic pseudo-random draw per (seed, seat, round). Returns
    True with READY_PROBABILITY. A None seed always reads False — callers
    that never pass a seed see byte-identical legacy behavior."""
    if seed is None:
        return False
    rng = random.Random(f"{int(seed)}:{int(player_index)}:{int(round_no)}")
    return rng.random() < READY_PROBABILITY


def _seeded_step_away_roll(seed: Optional[int], player_index: int,
                           round_no: int) -> bool:
    """Second deterministic draw: True steers the even-round reposition AWAY
    from the nearest hostile (with ~50% chance under a seed; always toward
    without one, preserving legacy behavior exactly)."""
    if seed is None:
        return False
    rng = random.Random(f"away:{int(seed)}:{int(player_index)}:{int(round_no)}")
    return rng.random() < 0.5


def _closed_to_reach(turn: Dict[str, Any], anchor: Optional[List[float]]) -> bool:
    """True when a move turn's requested destination sits within melee reach
    of ``anchor`` — the readying seat's own position when it readied. The sim
    judges only from coordinates it actually sent and observed, never from
    engine-internal state it cannot see."""
    if not anchor:
        return False
    x, y = turn.get("requested", {}).get("x"), turn.get("requested", {}).get("y")
    if x is None or y is None:
        return False
    try:
        return math.hypot(float(x) - float(anchor[0]),
                          float(y) - float(anchor[1])) <= MELEE_REACH_FEET
    except (TypeError, ValueError):
        return False


SYSTEM_PROMPT = (
    "You are one player at a D&D-style virtual tabletop, taking exactly one "
    "turn. Reply ONLY with a single JSON object, no prose, of the form: "
    '{"action": "attack" | "move" | "check", '
    '"target_id": "<enemy entity id, required for attack>", '
    '"x": <number>, "y": <number>, '
    '"reason": "<one short sentence>"}'
)


def build_decision_prompts(
    snapshot: Dict[str, Any],
    player: CampaignSimPlayer,
    stances: Optional[Dict[str, str]] = None,
) -> tuple:
    """Build the (system, user) decision prompts.

    ``stances`` carries each visible NPC/target's CURRENT disposition stance
    toward this player (neutral for anything unknown) so the model reasons
    over social state, not just HP bars.
    """
    own = next((e for e in snapshot["entities"] if e["id"] == player.entity_id), {})
    view = [
        {k: e[k] for k in ("id", "name", "hp", "ac", "is_player", "is_dead")}
        for e in snapshot["entities"]
    ]
    user_prompt = (
        "Battlefield state:\n"
        + json.dumps(
            {"you": own, "entities": view,
             "stances_toward_you": dict(stances or {})},
            default=str,
        )
        + "\n'stances_toward_you' is each target's current attitude toward you "
        "(hostile/unfriendly/neutral/friendly/allied). "
        "Choose your single action as JSON per the schema."
    )
    return SYSTEM_PROMPT, user_prompt


def validate_decision(parsed: Any) -> tuple:
    """Returns (decision_dict_or_None, fallback_reason_or_None).

    Defensive by design: model output is untrusted input.
    """
    if not isinstance(parsed, dict):
        return None, "malformed_llm_output"
    action = parsed.get("action")
    if not isinstance(action, str) or action.lower() not in VALID_ACTIONS:
        return None, f"unknown_action:{action!r}"
    action = action.lower()
    decision: Dict[str, Any] = {"action": action}
    if action == "attack":
        target = parsed.get("target_id")
        if not isinstance(target, str) or not target.strip():
            return None, "missing_attack_target"
        decision["target_id"] = target.strip()
    elif action == "move":
        x, y = _coerce_coord(parsed.get("x")), _coerce_coord(parsed.get("y"))
        if x is None or y is None:
            return None, "malformed_move_coordinates"
        decision.update(x=x, y=y)
    decision["reason"] = str(parsed.get("reason", ""))[:200]
    return decision, None


def _coerce_coord(value: Any) -> Optional[float]:
    try:
        coord = float(value)
    except (TypeError, ValueError):
        return None
    if coord != coord or coord in (float("inf"), float("-inf")):  # NaN/inf guard
        return None
    return coord


# ---------------------------------------------------------------------------
# Social dialogue phase (player decision + ConcordiaNPC reply)
# ---------------------------------------------------------------------------

#: Social approaches a player may take toward the designated social NPC. Each
#: maps 1:1 onto a disposition-engine interaction kind, so approaches carry
#: their own valence ("aided"/"gifted" positive, "threatened"/"ignored"
#: negative).
SOCIAL_APPROACHES = ("aided", "gifted", "threatened", "ignored")
SOCIAL_APPROACH_KINDS = {approach: approach for approach in SOCIAL_APPROACHES}

SOCIAL_SYSTEM_PROMPT = (
    "You are one player at a D&D-style virtual tabletop, speaking to an NPC "
    "between combat rounds. Reply ONLY with a single JSON object, no prose, "
    'of the form: {"approach": "aided" | "gifted" | "threatened" | "ignored", '
    '"utterance": "<one short spoken line>", '
    '"reason": "<one short sentence>"}'
)


def build_social_prompts(npc_name: str, stance: str) -> tuple:
    """(system, user) prompts for the player's social decision. The NPC's
    CURRENT stance toward the player is injected so the model reasons over live
    social state, exactly like combat decisions."""
    user_prompt = (
        f"You are addressing the NPC {npc_name!r}, whose current attitude "
        f"toward you is {stance!r}. Choose ONE social approach and write the "
        "exact line you say aloud, as JSON per the schema."
    )
    return SOCIAL_SYSTEM_PROMPT, user_prompt


def validate_social_decision(parsed: Any) -> tuple:
    """Returns (decision_dict_or_None, fallback_reason_or_None). Defensive:
    model output is untrusted input."""
    if not isinstance(parsed, dict):
        return None, "malformed_llm_output"
    approach = parsed.get("approach")
    if not isinstance(approach, str) or approach.lower() not in SOCIAL_APPROACHES:
        return None, f"unknown_approach:{approach!r}"
    utterance = parsed.get("utterance")
    if not isinstance(utterance, str) or not utterance.strip():
        return None, "missing_utterance"
    return {
        "approach": approach.lower(),
        "utterance": utterance.strip()[:500],
        "reason": str(parsed.get("reason", ""))[:200],
    }, None


#: Deterministic scripted fallback per CURRENT stance of the social NPC toward
#: the acting player — no RNG anywhere.
_SCRIPTED_SOCIAL_APPROACH = {
    "allied": "aided",
    "friendly": "aided",
    "neutral": "gifted",
    "unfriendly": "threatened",
    "hostile": "threatened",
}

_SOCIAL_UTTERANCES = {
    "aided": "Hold still — let me dress that wound.",
    "gifted": "Take this coin pouch; a token of goodwill.",
    "threatened": "Answer plainly, or answer to my blade.",
    "ignored": "...",
}


def scripted_social_decision(stance: Optional[str]) -> Dict[str, Any]:
    """Deterministic dialogue fallback for one stance reading."""
    approach = _SCRIPTED_SOCIAL_APPROACH.get(stance or "neutral", "gifted")
    return {
        "approach": approach,
        "utterance": _SOCIAL_UTTERANCES[approach],
        "reason": f"scripted social approach ({approach}) for stance {stance}",
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class CampaignSimulation:
    """Drives N players through setup, then T rounds of LLM- or policy-driven
    turns, accounting every attempt honestly."""

    def __init__(
        self,
        players: int = 2,
        rounds: int = 3,
        *,
        llm_gateway: Optional[LLMStreamingGateway] = None,
        mode: Optional[str] = None,
        base_url: Optional[str] = None,
        transport=None,
        table_name: str = "Campaign Sim Table",
        disposition_engine: Optional[NpcDispositionEngine] = None,
        npc_registry: Optional[Dict[str, Any]] = None,
        social_npc_id: Optional[str] = None,
        director: Optional[DirectorAgent] = None,
        decision_seed: Optional[int] = None,
    ):
        if players < 1:
            raise ValueError("players must be >= 1")
        if rounds < 1:
            raise ValueError("rounds must be >= 1")
        # Social dialogue layer. ``npc_registry`` maps entity id -> an object
        # exposing ``ConcordiaNPC.respond_to``. Default (None) means the social
        # phase is skipped entirely — the sim never invents dialogue it cannot
        # actually produce.
        self.npc_registry = dict(npc_registry) if npc_registry else None
        self.social_npc_id = social_npc_id
        if self.npc_registry is not None:
            if not self.social_npc_id:
                raise ValueError(
                    "npc_registry supplied but no social_npc_id designated")
            if self.social_npc_id not in self.npc_registry:
                raise ValueError(
                    f"social_npc_id {self.social_npc_id!r} is not in npc_registry")
        self.players_n = players
        self.rounds_n = rounds
        self.table_name = table_name
        self.gateway = llm_gateway or LLMStreamingGateway(LLMConfig())
        # Explicit mode wins; otherwise auto-detect from gateway config.
        self.mode = mode or ("llm" if not self.gateway.config.is_mock else "scripted")
        self._base_url = base_url
        self._transport = transport
        # Social-state telemetry. The engine's own clock is pinned to a
        # constant: every call this sim makes passes an EXPLICIT deterministic
        # timestamp (sim clock), so the fallback clock is never consulted.
        self.disposition = disposition_engine or NpcDispositionEngine(clock=lambda: 0.0)
        # npc_id -> best-known display name (from snapshots), for report keys.
        self._npc_names: Dict[str, str] = {}
        # Campaign Director (GOALS.md Pillar 5): deterministic tension tracking
        # over the sim's own counted outcomes. Injectable for determinism.
        self.director = director or DirectorAgent()
        # Per-round HP damage + deaths, observed from accepted attack verdicts.
        self._round_damage: Dict[int, float] = {}
        self._round_deaths: Dict[int, int] = {}
        # Stance at the end of round N, per (npc_id, player_id), to diff
        # against round N+1 -> stance TRANSITIONS observed.
        self._stance_cache: Dict[tuple, str] = {}
        # Reaction-layer state (iteration 81). ``decision_seed`` drives the
        # occasional Ready choice deterministically (None = legacy behavior,
        # never ready). ``pending_opportunity_attacks`` holds offers exactly
        # as the engine's /move responses disclosed them: each entry names the
        # REACTING attacker, the mover who provoked it, and which seat
        # controls that attacker (so the OPPONENT takes the swing on its own
        # authenticated identity).
        self.decision_seed = decision_seed
        self.pending_opportunity_attacks: List[Dict[str, Any]] = []
        # Per-round count of reaction-kind attempts, for honest totals.
        self._reaction_actions: Dict[str, int] = {}
        # Chronological record of every turn this run produced (regular AND
        # reaction), so trigger evaluation reads only what was observed.
        self._observed_turns: List[Dict[str, Any]] = []
        # player name -> (round, seq) when its Ready was accepted.
        self._readied_since: Dict[str, tuple] = {}
        # player name -> the seat's own position when it readied, so an
        # ``enemy_enters_reach`` release can be judged against where the
        # readying entity actually stood.
        self._readied_position: Dict[str, Optional[List[float]]] = {}
        # Set by run() so disclosure handling can map attacker entity ids
        # back to the seat that controls them.
        self._players_ref: List[CampaignSimPlayer] = []

    @property
    def _end_ts(self) -> float:
        """Deterministic end-of-run sim-clock reading for stance snapshots."""
        return self.rounds_n * 10.0 + self.players_n

    def _stance_toward(self, npc_id: str, player_id: Optional[str],
                       timestamp: Optional[float] = None) -> str:
        """Current stance of ``npc_id`` toward ``player_id`` — defensive:
        unknown targets (or missing ids) read as neutral. Defaults to the
        end-of-run sim clock; social exchanges read at their own timestamp."""
        if not player_id or not npc_id:
            return "neutral"
        ts = self._end_ts if timestamp is None else timestamp
        try:
            return self.disposition.stance(npc_id, player_id, timestamp=ts)
        except Exception:  # never let telemetry break the run
            return "neutral"

    def _stance_view(self, player, snapshot: Dict[str, Any]) -> Dict[str, str]:
        """Map every visible NPC/target (name preferred over id) to its CURRENT
        stance toward the acting player. Unknown/untracked targets come back
        neutral from the disposition engine itself."""
        stances: Dict[str, str] = {}
        for entity in snapshot.get("entities", []):
            if entity["id"] == player.entity_id or entity.get("is_player"):
                continue
            key = entity.get("name") or str(entity["id"])
            stances[key] = self._stance_toward(entity["id"], player.entity_id)
            self._npc_names.setdefault(str(entity["id"]), key)
        return stances

    def _record_social(self, player, decision, result, round_no: int) -> None:
        """Disposition hook: accepted attacks record ``"attacked"`` on the
        target's state toward the attacker. Checks/moves record nothing, and
        there is no heal-like action in the sim vocabulary yet so ``"aided"``
        is unreachable (see module docstring)."""
        if decision.get("action") != "attack" or not result.get("accepted"):
            return
        npc_id = str(decision.get("target_id") or "")
        actor_id = player.entity_id or player.name
        if not npc_id or npc_id == actor_id:
            return
        # Director signals: HP swing + deaths are counted ONLY from the proxy's
        # own attack verdict — never extrapolated.
        outcome = result.get("outcome")
        if isinstance(outcome, dict):
            try:
                self._round_damage[round_no] = (
                    self._round_damage.get(round_no, 0.0)
                    + float(outcome.get("total_damage") or 0.0)
                )
            except (TypeError, ValueError):
                pass
            if bool(outcome.get("target_is_dead")):
                self._round_deaths[round_no] = self._round_deaths.get(round_no, 0) + 1
            # Accepted attacks by players also feed conversational agency.
            self.director.record_player_action(actor_id)
        ts = round_no * 10.0 + player.index  # deterministic sim clock
        try:
            self.disposition.record_interaction(
                npc_id=npc_id, player_id=actor_id, kind="attacked",
                magnitude=1.0, timestamp=ts,
            )
        except ValueError:  # defensive: never fabricate telemetry
            return
        self._npc_names.setdefault(npc_id, npc_id)

    def _stances_snapshot(self, player) -> Dict[str, str]:
        """End-of-run {target name_or_id: stance} per player, from recorded
        history only (never invents a relationship that was never touched)."""
        pid = player.entity_id or player.name
        out: Dict[str, str] = {}
        for npc_id in sorted({r.npc_id for r in self.disposition.history()
                              if r.player_id == pid}):
            out[self._npc_names.get(npc_id, npc_id)] = self._stance_toward(npc_id, pid)
        return out

    def _interactions_count(self, player) -> int:
        pid = player.entity_id or player.name
        return sum(1 for r in self.disposition.history() if r.player_id == pid)

    async def run(self) -> Dict[str, Any]:
        started_wall = time.time()
        started = time.perf_counter()
        report: Dict[str, Any] = {
            "mode": self.mode,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_wall)),
            "players_configured": self.players_n,
            "rounds_requested": self.rounds_n,
            "lobby_id": None,
            "engine_session_id": None,
            "totals": {
                "turns": 0,
                "actions_attempted": 0,
                "accepted": 0,
                "rejected": 0,
                "rejection_reasons": {},
                "reaction_actions": {},
                "llm_calls_made": 0,
                "llm_decisions_accepted": 0,
                "llm_fallbacks": 0,
                "degraded_flags_seen": 0,
                "disposition_interactions": 0,
                "disposition_interactions_by_kind": {},
                "social_interactions": 0,
            },
            "per_player": [],
            "rounds": [],
            "errors": [],
        }

        players = [
            CampaignSimPlayer(
                f"sim-player-{i}", i,
                base_url=self._base_url, transport=self._transport,
                role="gm" if i == 0 else "player",
            )
            for i in range(self.players_n)
        ]
        self._players_ref = players

        try:
            await self._setup(players, report)
        except CampaignSimError as exc:
            report["errors"].append(str(exc))
            report["elapsed_seconds"] = round(time.perf_counter() - started, 3)
            return report  # honest partial report instead of invented progress

        try:
            for round_no in range(1, self.rounds_n + 1):
                round_entry = {"round": round_no, "turns": [], "social": []}
                for player in players:
                    turn = await self._take_turn(player, round_no)
                    round_entry["turns"].append(turn)
                    self._account(turn, report)
                # Social phase: BETWEEN combat rounds, each player may attempt
                # ONE dialogue interaction with the designated social NPC.
                # No registry -> the phase does not exist (empty, not faked).
                if self.npc_registry is not None:
                    for player in players:
                        entry = await self._social_exchange(player, round_no, report)
                        if entry is not None:
                            round_entry["social"].append(entry)
                            report["totals"]["social_interactions"] += 1
                # Campaign Director: fold THIS round's counted outcomes into
                # the tension curve, then attach the curve + recommendations.
                round_entry["director"] = self._director_tick(
                    round_no,
                    stance_shifts=self._count_stance_shifts(round_no),
                )
                report["rounds"].append(round_entry)
        except CampaignSimError as exc:
            report["errors"].append(f"aborted mid-run: {exc}")
        finally:
            # Reaction-layer accounting (iteration 81): every reaction-kind
            # attempt is counted under its kind — accepted OR honestly
            # rejected, never dropped and never reclassified.
            for turn in self._observed_turns:
                kind = turn.get("reaction_kind")
                if kind:
                    self._reaction_actions[kind] = \
                        self._reaction_actions.get(kind, 0) + 1
            report["totals"]["reaction_actions"] = dict(self._reaction_actions)

        report["per_player"] = [self._player_summary(p, report) for p in players]
        # Campaign Director summary: the full curve + final recommendations,
        # verbatim from the deterministic tracker (pure accounting, no
        # invention).
        report["director"] = {
            "curve": self.director.curve(),
            "recommendations": self.director.recommendations(),
            "tension": self.director.tension(),
            "player_action_counts": dict(self.director._action_counts),
        }
        # Social-state telemetry: counted from the disposition engine's own
        # history — nothing here is extrapolated.
        by_kind: Dict[str, int] = {}
        for record in self.disposition.history():
            by_kind[record.kind] = by_kind.get(record.kind, 0) + 1
        report["totals"]["disposition_interactions"] = len(self.disposition.history())
        report["totals"]["disposition_interactions_by_kind"] = by_kind
        report["elapsed_seconds"] = round(time.perf_counter() - started, 3)
        return report

    # -- phases -------------------------------------------------------------

    def _count_stance_shifts(self, round_no: int) -> int:
        """Count disposition stance TRANSITIONS observed through the end of
        ``round_no`` vs the previous round's cached readings. A stance that
        appears for the first time is NOT a shift (nothing moved — it was
        simply never read before)."""
        ts = round_no * 10.0
        current: Dict[tuple, str] = {}
        for record in self.disposition.history():
            if record.timestamp > ts:
                continue
            try:
                stance = self.disposition.stance(
                    record.npc_id, record.player_id, timestamp=ts)
            except Exception:  # never let telemetry break the run
                continue
            current[(record.npc_id, record.player_id)] = stance

        shifts = 0
        for key, stance in current.items():
            previous = self._stance_cache.get(key)
            if previous is not None and previous != stance:
                shifts += 1
            self._stance_cache[key] = stance
        return shifts

    def _director_tick(self, round_no: int, *, stance_shifts: int) -> Dict[str, Any]:
        """One deterministic director step over this round's counted outcomes."""
        sample = self.director.observe_round(
            round_no,
            hp_damage=self._round_damage.pop(round_no, 0.0),
            deaths=self._round_deaths.pop(round_no, 0),
            disposition_shifts=stance_shifts,
        )
        sample["recommendations"] = self.director.recommendations()
        return sample

    async def _setup(self, players: List[CampaignSimPlayer], report: Dict[str, Any]) -> None:
        for player in players:
            await player.authenticate()

        host = players[0]
        await host.host_table(self.table_name)
        report["lobby_id"] = host.lobby_id
        for guest in players[1:]:
            await guest.join_table(host.lobby_id, host.invite_code)

        # Every seat readies before the host launches — the launch route
        # refuses a partial party (409 MEMBERS_NOT_READY) unless forced.
        for player in players:
            await player.mark_ready()

        session_id = await host.launch_table()
        report["engine_session_id"] = session_id
        for player in players:
            player.bind_session(session_id)
            await player.deploy_character()
        await host.spawn_encounter_target(session_id)

    async def _take_turn(self, player: CampaignSimPlayer, round_no: int) -> Dict[str, Any]:
        # 1) Reaction layer FIRST: an opportunity attack this seat's entity
        #    provoked earlier (disclosed by the engine's /move response) is
        #    taken NOW — the opponent's next available action. A held Ready
        #    whose structured trigger has fired releases instead.
        reaction = self._next_reaction_for(player)
        if reaction is not None:
            return await self._execute_reaction_turn(player, round_no, reaction)

        snapshot = await player.observe_session()
        stances = self._stance_view(player, snapshot)
        decision, source, fallback_reason, llm_used = await self._decide(
            player, snapshot, round_no, stances)

        # Occasionally spend the Action on a Ready (seeded, deterministic).
        if decision.pop("ready_this_turn", False) and \
                decision["action"] != "check":
            trigger = READY_TRIGGERS[0] if decision.get("action") == "attack" \
                else READY_TRIGGERS[1]
            return await self._ready_instead(player, round_no, decision, trigger)

        result = await player.execute(decision)
        # Social-state telemetry AFTER the proxy verdict: only ACCEPTED
        # attacks touch disposition state (checks/moves record nothing).
        self._record_social(player, decision, result, round_no)
        turn = self._turn_record(
            player, round_no, decision, result, source, fallback_reason, llm_used)
        turn["reaction_kind"] = None
        return turn

    def _next_reaction_for(self, player: CampaignSimPlayer) -> Optional[Dict[str, Any]]:
        """The next reaction action THIS seat can take right now.

        Priority: take a pending opportunity attack whose attacker this seat's
        entity controls; otherwise release its own readied declaration when
        the structured trigger has fired since it was set.
        """
        for offer in self.pending_opportunity_attacks:
            if offer.get("taken"):
                continue
            if offer.get("controller_entity_id") == player.entity_id and \
                    offer["attacker_id"] != offer["mover_id"]:
                offer["taken"] = True   # claimed; one attempt per disclosure
                return {
                    "reaction_kind": REACTION_OPPORTUNITY_ATTACK,
                    "attacker_id": offer["attacker_id"],
                    "target_id": offer["mover_id"],
                    "round_provenance": offer.get("round"),
                }
        if player.readied is not None and self._readied_trigger_fired(player):
            return {"reaction_kind": REACTION_RELEASE}
        return None

    def _readied_trigger_fired(self, player: CampaignSimPlayer) -> bool:
        """Whether the seat's declared structured trigger has observably fired
        since the Ready was made. ``enemy_attacks`` fires when ANY attack was
        accepted after the ready; ``enemy_enters_reach`` fires when an
        ACCEPTED move by another entity ended within melee reach of this
        seat's own position as of the ready. The sim judges only from the
        coordinates it actually sent and observed — never guesses."""
        readied_at = (self._readied_since.get(player.name))
        if readied_at is None:
            return False
        anchor = self._readied_position.get(player.name)

        def _later(t) -> bool:
            return (t["round"], t.get("_seq", 0)) > readied_at

        for turn in self._observed_turns:
            if not _later(turn):
                continue
            trigger = player.readied.get("trigger")
            if trigger == "enemy_attacks" and \
                    turn.get("action") == "attack" and turn.get("accepted"):
                return True
            if trigger == "enemy_enters_reach" and \
                    turn.get("action") == "move" and turn.get("accepted") and \
                    _closed_to_reach(turn, anchor):
                return True
        return False

    async def _execute_reaction_turn(self, player, round_no, reaction) -> Dict[str, Any]:
        """Run one reaction action as the seat's whole observable activity."""
        kind = reaction["reaction_kind"]
        result = await player.execute_reaction(reaction)
        record = {
            "round": round_no,
            "player": player.name,
            "entity_id": player.entity_id,
            "decision_source": "scripted",
            "fallback_reason": None,
            "reason": f"reaction: {kind}",
            "action": kind,
            "requested": {k: v for k, v in reaction.items()},
            "attempted": result["attempted"],
            "accepted": result["accepted"],
            "rejected": result["rejected"],
            "rejection_reason": result["rejection_reason"],
            "response_status": result["response_status"],
            "degraded": result["degraded"],
            "llm_called": False,
            "reaction_kind": kind,
        }
        if kind == REACTION_OPPORTUNITY_ATTACK:
            # Disposition: the OA swing hit a PLAYER mover — social telemetry
            # tracks NPC targets only, so nothing records here by design.
            pass
        self._observed_turns.append(record)
        return record

    async def _ready_instead(self, player, round_no, base_decision, trigger) -> Dict[str, Any]:
        """Spend this turn's Action declaring a Ready through the proxy."""
        description = {
            "attack": "I strike when my trigger fires",
            "move": "I shift when my trigger fires",
        }.get(base_decision["action"], "I hold my action")
        reaction = {
            "reaction_kind": REACTION_READY,
            "description": description,
            "trigger": trigger,
        }
        result = await player.execute_reaction(reaction)
        record = {
            "round": round_no,
            "player": player.name,
            "entity_id": player.entity_id,
            "decision_source": "scripted",
            "fallback_reason": None,
            "reason": f"ready ({trigger})",
            "action": "ready",
            "requested": dict(reaction),
            "attempted": result["attempted"],
            "accepted": result["accepted"],
            "rejected": result["rejected"],
            "rejection_reason": result["rejection_reason"],
            "response_status": result["response_status"],
            "degraded": result["degraded"],
            "llm_called": False,
            "reaction_kind": REACTION_READY,
        }
        if result["accepted"]:
            self._readied_since[player.name] = (round_no, len(self._observed_turns))
            try:
                snapshot = await player.observe_session()
                own = next(
                    (e for e in snapshot.get("entities", [])
                     if e["id"] == player.entity_id), None)
                pos = own.get("position") if isinstance(own, dict) else None
                self._readied_position[player.name] = \
                    [float(pos[0]), float(pos[1])] if pos else None
            except CampaignSimError:
                self._readied_position[player.name] = None
        self._observed_turns.append(record)
        return record

    def _note_disclosed_opportunity_attacks(self, player, decision, result) -> None:
        """After a move, fold the engine's OWN pending-OA disclosure into the
        sim-level queue so the OPPONENT seat takes each offer later. Only what
        the response actually disclosed is recorded.

        The reacting attacker is usually an NPC nobody owns; the engine's RBAC
        lets any non-spectator control ownerless entities, so the HOST seat
        (players[0]) drives those swings on its own authenticated identity.
        """
        if decision.get("action") != "move" or not result.get("accepted"):
            return
        outcome = result.get("outcome") or {}
        detail = outcome.get("opportunity_attacks_detail")
        if not isinstance(detail, list):
            return
        for entry in detail:
            if not isinstance(entry, dict):
                continue
            attacker = entry.get("provoked_by")
            if not attacker or entry.get("available") is False:
                continue
            attacker_id = str(attacker)
            controller = next(
                (p for p in self._players_ref or [] if p.entity_id == attacker_id),
                None,
            ) or (self._players_ref[0] if self._players_ref else None)
            self.pending_opportunity_attacks.append({
                "attacker_id": attacker_id,
                "mover_id": str(player.entity_id),
                "controller_entity_id": (
                    controller.entity_id if controller is not None else None),
                "controller_player_name": (
                    controller.name if controller is not None else None),
                "available": True,
                "taken": False,
                "round": None,
            })

    def _turn_record(self, player, round_no, decision, result, source,
                     fallback_reason, llm_used) -> Dict[str, Any]:
        record = {
            "round": round_no,
            "player": player.name,
            "entity_id": player.entity_id,
            "decision_source": source,
            "fallback_reason": fallback_reason,
            "reason": decision.get("reason"),
            "action": decision["action"],
            "requested": {k: v for k, v in decision.items() if k != "reason"},
            "attempted": result["attempted"],
            "accepted": result["accepted"],
            "rejected": result["rejected"],
            "rejection_reason": result["rejection_reason"],
            "response_status": result["response_status"],
            "degraded": result["degraded"],
            "llm_called": llm_used,
        }
        self._observed_turns.append(record)
        self._note_disclosed_opportunity_attacks(player, decision, result)
        return record

    async def _decide(self, player, snapshot, round_no, stances=None):
        """LLM decision with per-turn deterministic fallback, or scripted mode.

        Both paths receive the same socially-grounded ``stances`` input (each
        candidate target's CURRENT stance toward the acting player).

        Returns (decision, source, fallback_reason|None, llm_was_called).
        """
        if self.mode != "llm":
            return scripted_decision(player, snapshot, round_no, stances,
                                     seed=self.decision_seed), \
                "scripted", None, False

        system_prompt, user_prompt = build_decision_prompts(snapshot, player, stances)
        parsed = await self.gateway.complete_json(system_prompt, user_prompt)
        decision, problem = validate_decision(parsed)
        if decision is None:
            reason = problem if parsed is not None else "llm_unavailable_or_unparseable"
            fallback = scripted_decision(player, snapshot, round_no, stances,
                                         seed=self.decision_seed)
            fallback["reason"] = f"scripted fallback ({reason})"
            return fallback, "llm_fallback", reason, True
        return decision, "llm", None, True

    # -- social dialogue phase ------------------------------------------------

    async def _decide_social(self, npc_name: str, stance: str) -> tuple:
        """Player dialogue decision ({approach, utterance}) via the SAME
        gateway path as combat decisions, with a deterministic per-stance
        scripted fallback. Returns (decision, source, fallback_reason|None,
        llm_was_called)."""
        if self.mode != "llm":
            return scripted_social_decision(stance), "scripted", None, False
        system_prompt, user_prompt = build_social_prompts(npc_name, stance)
        parsed = await self.gateway.complete_json(system_prompt, user_prompt)
        decision, problem = validate_social_decision(parsed)
        if decision is None:
            reason = problem if parsed is not None else "llm_unavailable_or_unparseable"
            fallback = scripted_social_decision(stance)
            fallback["reason"] = f"scripted fallback ({reason})"
            return fallback, "llm_fallback", reason, True
        return decision, "llm", None, True

    async def _social_exchange(self, player: CampaignSimPlayer, round_no: int,
                               report: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """One player's single dialogue attempt against the designated social
        NPC this round. Returns a report entry, or None when the interaction
        genuinely could not happen (NPC absent/dead/hidden, or the exchange
        failed) — nothing is fabricated."""
        npc = self.npc_registry[self.social_npc_id]
        snapshot = await player.observe_session()
        entity = next(
            (e for e in snapshot.get("entities", [])
             if str(e["id"]) == str(self.social_npc_id)),
            None,
        )
        if entity is None or entity.get("is_dead") or not entity.get("is_visible", True):
            return None

        actor_id = player.entity_id or player.name
        ts = round_no * 10.0 + player.index + 0.5  # deterministic sim clock
        stance_before = self._stance_toward(self.social_npc_id, actor_id, timestamp=ts)
        npc_name = entity.get("name") or str(self.social_npc_id)

        decision, source, fallback_reason, _called = await self._decide_social(
            npc_name, stance_before)
        approach = decision["approach"]
        utterance = decision["utterance"]

        # Absolute norms enforcement on BOTH halves of the LLM pair: a tainted
        # utterance never reaches the NPC's LLM at all, and ConcordiaNPC itself
        # norm-checks its own LLM reply before using it.
        norm_rejected: Optional[str] = None
        force_template = False
        if source == "llm":
            try:
                norm_rejected = npc.norms.violates(utterance, {"player_id": actor_id})
            except Exception:  # a broken norms component must not abort the run
                norm_rejected = None
            if norm_rejected is not None:
                utterance = scripted_social_decision(stance_before)["utterance"]
                force_template = True

        try:
            self.disposition.record_interaction(
                npc_id=self.social_npc_id, player_id=actor_id,
                kind=SOCIAL_APPROACH_KINDS[approach], magnitude=1.0, timestamp=ts)
        except ValueError:  # defensive: never fabricate telemetry
            return None
        self._npc_names.setdefault(str(self.social_npc_id), npc_name)
        # Post-exchange stance at this interaction's own sim-clock instant; the
        # NPC replies through THIS stance so a hostile approach is answered
        # coldly in the same breath it lands.
        stance_after = self._stance_toward(self.social_npc_id, actor_id, timestamp=ts)

        # Network scope: ``respond_to`` falls back to the persona's OWN
        # ctor-supplied gateway unless one is forced here, so a scripted run
        # must always pin ``None`` — an LLM-gatewayed NPC injected via
        # npc_registry would otherwise silently make upstream calls the sim
        # reports as never happening. In LLM mode the persona's gateway is
        # honored EXCEPT when this exchange's player utterance was norm-tainted
        # and replaced by a scripted line: a tainted prompt reaches no model.
        suppress_npc_llm = force_template or self.mode != "llm"
        try:
            result = await npc.respond_to(
                actor_id, utterance, disposition_stance=stance_after, timestamp=ts,
                **({"llm_gateway": None} if suppress_npc_llm else {}))
        except Exception as exc:  # dialogue failure must never abort the run
            report["errors"].append(f"{player.name}: social exchange failed: {exc}")
            return None

        if norm_rejected is None and isinstance(result.get("norm_rejected"), str):
            norm_rejected = result["norm_rejected"]

        entry: Dict[str, Any] = {
            "round": round_no,
            "player": player.name,
            "npc_id": str(self.social_npc_id),
            "approach": approach,
            "decision_source": source,
            "fallback_reason": fallback_reason,
            "utterance": utterance[:300],
            "reply_generator": result.get("generator"),
            "reply": result.get("reply"),
            "stance_before": stance_before,
            # Read at THIS interaction's sim-clock instant: the post-exchange
            # stance, before any later round's events decay or overwrite it.
            "stance_after": stance_after,
        }
        if norm_rejected is not None:
            entry["norm_rejected"] = norm_rejected
        return entry

    # -- accounting -----------------------------------------------------------

    def _account(self, turn: Dict[str, Any], report: Dict[str, Any]) -> None:
        totals = report["totals"]
        totals["turns"] += 1
        if turn["attempted"]:
            totals["actions_attempted"] += 1
        if turn["accepted"]:
            totals["accepted"] += 1
        if turn["rejected"]:
            totals["rejected"] += 1
            reason = turn["rejection_reason"] or "UNKNOWN"
            totals["rejection_reasons"][reason] = totals["rejection_reasons"].get(reason, 0) + 1
        if turn["llm_called"]:
            totals["llm_calls_made"] += 1
            if turn["decision_source"] == "llm":
                totals["llm_decisions_accepted"] += 1
            else:
                totals["llm_fallbacks"] += 1
        if turn["degraded"]:
            totals["degraded_flags_seen"] += 1

    def _player_summary(self, player: CampaignSimPlayer, report: Dict[str, Any]) -> Dict[str, Any]:
        turns = [t for r in report["rounds"] for t in r["turns"] if t["player"] == player.name]
        return {
            "name": player.name,
            "user_id": player.user_id,
            "character_id": player.character_id,
            "entity_id": player.entity_id,
            "role": player.role,
            "actions_attempted": sum(1 for t in turns if t["attempted"]),
            "accepted": sum(1 for t in turns if t["accepted"]),
            "rejected": sum(1 for t in turns if t["rejected"]),
            "turns_taken": len(turns),
            # Snapshot at run end: {target_name_or_id: stance} plus how many
            # directed interactions this player's actions recorded.
            "stances": self._stances_snapshot(player),
            "interactions_recorded": self._interactions_count(player),
        }


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run_simulation(players: int = 2, rounds: int = 3, **kwargs) -> Dict[str, Any]:
    """Synchronous entry point. Returns the counted report — no invented numbers."""
    return asyncio.run(CampaignSimulation(players=players, rounds=rounds, **kwargs).run())


def load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader so the __main__ runner sees LLM_API/LLM_KEY/LLM_MODEL
    without requiring python-dotenv."""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip().strip("'\""))
    except OSError:
        pass


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run the agent-driven campaign simulation")
    parser.add_argument("--players", type=int, default=2)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--env", default=".env")
    args = parser.parse_args()

    load_dotenv(args.env)
    gateway = LLMStreamingGateway(LLMConfig())
    print(
        f"[campaign-sim] endpoint={gateway.config.base_url} "
        f"model={gateway.config.model} "
        f"mode={'llm' if not gateway.config.is_mock else 'scripted'}",
    )
    report = run_simulation(
        players=args.players,
        rounds=args.rounds,
        llm_gateway=gateway,
    )
    print(json.dumps(report, indent=2, default=str))
