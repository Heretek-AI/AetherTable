"""Pillar 1: drop-in AI-controlled player characters with tactical roles.

An :class:`AiCompanion` wraps an ALREADY-AUTHENTICATED
``campaign_sim.CampaignSimPlayer`` seat (its ``_OrchestratorHTTP`` transport and
``?token=``-forwarded ``authed()`` plumbing — nothing is duplicated) and takes
coherent turns against an observed session snapshot.

Roles and their deterministic scripted policies (the default, and the per-turn
fallback):

``tank``
    Engage the nearest living hostile. Farther than melee reach -> move toward
    it (up to the seat's speed); in reach -> attack it. Equidistant hostiles
    are tie-broken on the LOWEST observable AC (swing at what you can hit).

``skirmisher``
    Hit-and-run alternation driven by its own turn counter: odd turns engage
    (attack when in reach, otherwise close the gap), even turns disengage (move
    directly away from the nearest hostile). Without position data there is
    nothing honest to steer by, so it takes a check instead of inventing a
    heading.

``healer``
    Heal the most-wounded ally whose HP is ACTUALLY OBSERVABLE below half via
    ``POST /api/v1/engine/heal`` (ids + amount only; the engine clamps to
    max_hp server-side). If nobody's deficit is visible, it fights like a tank.
    It never fabricates triage data it cannot see.

Role realizability matrix (exported as :data:`REALIZABILITY`, mirrored here for
reviewers). The session-state read proxy projects other entities to public
board tokens (id/name/position/is_player/is_dead — NO hp/ac) unless the caller
is gm/admin or owns the entity, and engine RBAC authorizes heals by ownership:

=================  ==========================================================
Role               Realizable today
=================  ==========================================================
tank               FULLY (positions + is_player flags are public; own AC is
                   on the owned sheet; attack/move/check proxies all exist).
                   "Prefer high-AC positioning" degrades honestly: enemy AC is
                   invisible from player seats, so the policy tie-breaks on
                   LOWEST *observable* AC, and the bare-x/y move surface has
                   no cover/LOS semantics to "position" with.
skirmisher         MOSTLY (engage/disengage alternation is fully realizable;
                   per-turn movement budget is not projected into the snapshot
                   read, so disengage distance uses the character sheet speed,
                   not an engine-reported budget).
healer             SELF-HEAL: fully realizable (own HP is on the owned sheet).
                   ALLY-HEAL: realizable ONLY from a gm/admin seat (or any seat
                   that owns the target); a player-role seat cannot observe
                   another PC's HP through the proxy and will NOT pretend to —
                   it falls back to tank behavior. Cross-ally heals also depend
                   on engine RBAC accepting a non-owner actor.
rest               Present in the proxy surface but unused by these policies;
                   out-of-combat recovery is the campaign driver's job.
=================  ==========================================================

LLM refinement is optional and never load-bearing: when a key is configured the
role doctrine + snapshot go through
``routing.llm_client.LLMStreamingGateway.complete_json`` (so the call lands in
the shared JSONL log), the reply is validated like campaign_sim validates its
decisions plus a known-entity cross-check, and ANY failure falls back to the
scripted policy FOR THAT TURN while still counting the attempt. Provenance is
reported per turn: ``decision_source`` in {"scripted", "llm", "llm_fallback"},
``llm_called``, ``fallback_reason``.

Importable API only — no HTTP routes are added. To run live, reuse the setup in
``campaign_sim`` (auth -> lobby -> launch -> deploy), then:

    companion = AiCompanion(player, role="tank")
    snapshot  = await player.observe_session()
    report    = await companion.take_turn(snapshot)
"""

import json
import math
import os
from typing import Any, Dict, List, Optional, Tuple

from ..routing.llm_client import LLMConfig, LLMStreamingGateway
from .campaign_sim import (
    CampaignSimError,
    CampaignSimPlayer,
    _degraded_flag,
    _rejection_reason,
    validate_decision as _validate_base_decision,
)

ROLES = ("tank", "skirmisher", "healer")

# Actions reachable through the orchestrator proxy surface today. ``heal`` is
# included because /api/v1/engine/heal exists; see REALIZABILITY for who can
# actually use it observably.
ACTIONS = ("attack", "move", "check", "heal")

MELEE_REACH_FEET = 5.0
DEFAULT_SPEED_FEET = 30.0
WOUNDED_THRESHOLD = 0.5

REALIZABILITY: Dict[str, Dict[str, List[str]]] = {
    "tank": {
        "realizable": [
            "move toward nearest living hostile",
            "attack in-reach hostile",
            "tie-break equal-distance targets on lowest observable AC",
        ],
        "aspirational": [
            "cover/high-AC positioning (move surface is bare x/y, no LOS/cover)",
            "enemy AC visibility from player seats",
        ],
    },
    "skirmisher": {
        "realizable": [
            "engage turn: attack in reach / otherwise close the gap",
            "disengage turn: move away from nearest hostile",
        ],
        "aspirational": [
            "engine-reported per-turn movement budget (not in the snapshot projection)",
            "opportunity-attack avoidance",
        ],
    },
    "healer": {
        "realizable": [
            "self-heal when own observable HP < half (/api/v1/engine/heal)",
            "ally-heal from a gm/admin seat (or owner of the target entity)",
            "fallback to tank behavior when no deficit is observable",
        ],
        "aspirational": [
            "ally-heal from a plain player seat (ally HP is redacted by the "
            "read-proxy projection; RBAC may also refuse non-owner heals)",
            "spell-slot-aware heal sizing",
        ],
    },
}

ROLE_DOCTRINE: Dict[str, str] = {
    "tank": (
        "Frontline Tank. You hold the line: close with the nearest living "
        "hostile and strike it. Prefer engaging what you can actually hit."
    ),
    "skirmisher": (
        "Skirmisher. Hit-and-run: on engage turns strike or close to striking "
        "range; on disengage turns break contact and move away."
    ),
    "healer": (
        "Healer. Triage first: if any ally you can genuinely observe is below "
        "half health, restore them. Otherwise fight like a tank. Never guess "
        "at wounds you cannot see."
    ),
}


class AiCompanionError(ValueError):
    """Raised on contract misuse (unknown role, unbound session)."""


def _as_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _pos(entity: Dict[str, Any]) -> Optional[List[float]]:
    pos = entity.get("position")
    if isinstance(pos, (list, tuple)) and len(pos) >= 2:
        try:
            return [float(pos[0]), float(pos[1])]
        except (TypeError, ValueError):
            return None
    return None


def _distance(a: List[float], b: List[float]) -> float:
    return math.dist(a, b)


class AiCompanion:
    """One tactical role driving one authenticated seat."""

    def __init__(
        self,
        player: CampaignSimPlayer,
        *,
        role: str = "tank",
        llm_gateway: Optional[LLMStreamingGateway] = None,
        mode: Optional[str] = None,
        heal_amount: int = 8,
        reach_feet: float = MELEE_REACH_FEET,
        speed_feet: float = DEFAULT_SPEED_FEET,
    ):
        if role not in ROLES:
            raise AiCompanionError(
                f"unknown role {role!r}; expected one of {ROLES}")
        self.player = player
        self.role = role
        self.heal_amount = max(0, int(heal_amount))
        self.reach_feet = float(reach_feet)
        self.speed_feet = float(speed_feet)
        self.gateway = llm_gateway or LLMStreamingGateway(LLMConfig())
        # Explicit mode wins; otherwise auto-detect from gateway config so a
        # keyless environment is ALWAYS scripted and never touches the network.
        self.mode = mode or ("llm" if not self.gateway.config.is_mock else "scripted")
        self.turns_taken = 0
        self.history: List[Dict[str, Any]] = []

    # -- observation ---------------------------------------------------------

    @property
    def entity_id(self) -> Optional[str]:
        return self.player.entity_id

    async def observe(self) -> Dict[str, Any]:
        return await self.player.observe_session()

    # -- the turn ------------------------------------------------------------

    async def take_turn(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        """Decide one action for this role and execute it through the SAME
        authenticated proxy path campaign_sim uses. Returns honest provenance;
        nothing is extrapolated."""
        self.turns_taken += 1
        decision, source, fallback_reason, llm_called = await self._decide(snapshot)
        result = await self.execute(decision)
        turn = {
            "turn": self.turns_taken,
            "role": self.role,
            "companion": self.player.name,
            "entity_id": self.entity_id,
            "decision_source": source,       # "scripted" | "llm" | "llm_fallback"
            "fallback_reason": fallback_reason,
            "llm_called": llm_called,
            "reason": decision.get("reason"),
            "action": decision["action"],
            "requested": {k: v for k, v in decision.items() if k != "reason"},
            "attempted": result["attempted"],
            "accepted": result["accepted"],
            "rejected": result["rejected"],
            "rejection_reason": result["rejection_reason"],
            "response_status": result["response_status"],
            "degraded": result["degraded"],
        }
        self.history.append(turn)
        return turn

    # -- decision making -----------------------------------------------------

    async def _decide(self, snapshot):
        """Scripted policy by default; validated LLM refinement when configured.

        Returns (decision, source, fallback_reason|None, llm_was_called).
        """
        if self.mode != "llm":
            return self.scripted_decision(snapshot), "scripted", None, False

        parsed = await self.gateway.complete_json(*self.build_prompts(snapshot))
        decision, problem = validate_decision(parsed)
        if decision is not None:
            problem = self._cross_check_targets(decision, snapshot)
        if problem is not None:
            reason = problem if parsed is not None else "llm_unavailable_or_unparseable"
            fallback = self.scripted_decision(snapshot)
            fallback["reason"] = f"scripted fallback ({reason})"
            return fallback, "llm_fallback", reason, True
        return decision, "llm", None, True

    def _cross_check_targets(self, decision, snapshot) -> Optional[str]:
        """The LLM may refine targeting only among entities the snapshot
        actually shows; anything else falls back rather than firing blind."""
        known_ids = {str(e.get("id")) for e in snapshot.get("entities", [])}
        target = decision.get("target_id")
        if decision["action"] in ("attack", "heal"):
            if not isinstance(target, str) or target not in known_ids:
                return f"unknown_target:{target!r}"
            if target == self.entity_id and decision["action"] == "attack":
                return "unknown_target:self_attack"
        return None

    def build_prompts(self, snapshot: Dict[str, Any]) -> Tuple[str, str]:
        """(system, user) prompts: role doctrine + exactly what the seat can
        legitimately observe."""
        doctrine = ROLE_DOCTRINE[self.role]
        allowed = ("attack/move/check/heal" if self.role == "healer"
                   else "attack/move/check")
        system_prompt = (
            f"You are {self.player.display_name}, an AI-controlled player "
            f"character. Tactical role: {doctrine} Reply ONLY with a single "
            "JSON object, no prose, of the form: "
            '{"action": "' + allowed + '", '
            '"target_id": "<entity id, required for attack/heal>", '
            '"amount": <number, optional for heal>, '
            '"x": <number>, "y": <number>, '
            '"reason": "<one short sentence>"}'
        )
        view = [
            {k: e[k] for k in ("id", "name", "hp", "max_hp", "ac", "is_player",
                               "is_dead") if e.get(k) is not None}
            for e in snapshot.get("entities", [])
        ]
        user_prompt = (
            "Battlefield state (fields absent from your view are hidden by the "
            "server's state projection — do not invent them):\n"
            + json.dumps({"you": self.entity_id, "role": self.role,
                          "doctrine": doctrine, "entities": view},
                         default=str)
            + "\nChoose your single action as JSON per the schema."
        )
        return system_prompt, user_prompt

    # -- deterministic role policies ------------------------------------------

    def scripted_decision(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        """Role policy, deterministic, no RNG: same inputs -> same decision."""
        if self.role == "healer":
            healed = self._heal_decision(snapshot)
            if healed is not None:
                return healed
        return self._engage_decision(snapshot)

    def _hostiles(self, snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
        me = self.entity_id
        hostiles = [
            e for e in snapshot.get("entities", [])
            if e.get("id") != me and not e.get("is_dead") and not e.get("is_player")
        ]

        def sort_key(e):
            own_pos = self._own_position(snapshot)
            e_pos = _pos(e)
            dist = (_distance(own_pos, e_pos)
                    if own_pos and e_pos else float("inf"))
            ac = e.get("ac")
            # Lowest observable AC first (None sorts last — unknown, not assumed).
            return (dist, ac if isinstance(ac, (int, float)) else float("inf"),
                    str(e.get("id")))

        return sorted(hostiles, key=sort_key)

    def _own_position(self, snapshot: Dict[str, Any]) -> Optional[List[float]]:
        me = next((e for e in snapshot.get("entities", [])
                   if e.get("id") == self.entity_id), None)
        return _pos(me) if me else None

    def _own_hp(self, snapshot: Dict[str, Any]) -> Tuple[Optional[int], Optional[int]]:
        me = next((e for e in snapshot.get("entities", [])
                   if e.get("id") == self.entity_id), None)
        return (me.get("hp"), me.get("max_hp")) if me else (None, None)

    def _heal_decision(self, snapshot: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Most-wounded OBSERVABLY-wounded ally (self included) below half.

        Entities whose HP the projection hid come back hp=None and are skipped:
        the companion never guesses at wounds it cannot see.
        """
        candidates = []
        for e in snapshot.get("entities", []):
            if e.get("is_dead"):
                continue
            if not (e.get("is_player") or e.get("id") == self.entity_id):
                continue
            hp, max_hp = e.get("hp"), e.get("max_hp")
            if hp is None or not max_hp:
                continue
            if hp < max_hp * WOUNDED_THRESHOLD:
                candidates.append((hp / max_hp, str(e.get("id")), e))
        if not candidates:
            return None
        candidates.sort(key=lambda c: (c[0], c[1]))
        return {"action": "heal", "target_id": candidates[0][1],
                "amount": self.heal_amount,
                "reason": f"{ROLE_DOCTRINE['healer'].split('.')[0]}: ally below half"}

    def _engage_decision(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        """Shared tank/skirmisher engagement core."""
        if self.role == "skirmisher" and self.turns_taken % 2 == 0:
            return self._disengage_decision(snapshot)

        hostiles = self._hostiles(snapshot)
        own_pos = self._own_position(snapshot)
        if not hostiles or own_pos is None:
            # Nothing honest to steer by: take a check instead of inventing a
            # target or a heading.
            return {"action": "check"}
        target = hostiles[0]
        target_pos = _pos(target)
        if target_pos is not None:
            gap = _distance(own_pos, target_pos)
            if gap > self.reach_feet:
                return self._move_toward(own_pos, target_pos, gap)
        return {"action": "attack", "target_id": target["id"]}

    def _disengage_decision(self, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        hostiles = self._hostiles(snapshot)
        own_pos = self._own_position(snapshot)
        if not hostiles or own_pos is None or _pos(hostiles[0]) is None:
            return {"action": "check"}
        threat_pos = _pos(hostiles[0])
        dx, dy = own_pos[0] - threat_pos[0], own_pos[1] - threat_pos[1]
        norm = math.hypot(dx, dy) or 1.0
        step = min(self.speed_feet, norm)
        return {"action": "move",
                "x": round(own_pos[0] + dx / norm * step, 3),
                "y": round(own_pos[1] + dy / norm * step, 3)}

    def _move_toward(self, own_pos, target_pos, gap: float) -> Dict[str, Any]:
        # Never step past the target: close to exactly reach, not through it.
        step = min(self.speed_feet, max(gap - self.reach_feet, 0.0))
        dx, dy = target_pos[0] - own_pos[0], target_pos[1] - own_pos[1]
        norm = math.hypot(dx, dy) or 1.0
        return {"action": "move",
                "x": round(own_pos[0] + dx / norm * step, 3),
                "y": round(own_pos[1] + dy / norm * step, 3),
                "reason": "closing to engage"}

    # -- execution (same authenticated plumbing as campaign_sim) ---------------

    async def execute(self, decision: Dict[str, Any]) -> Dict[str, Any]:
        """One action through the SAME ``?token=``-forwarded proxy endpoints a
        browser client uses — via the wrapped player's own ``authed()`` path."""
        action = decision.get("action")
        try:
            session_id = self.player._session_id
        except CampaignSimError:
            return {"attempted": False, "accepted": False, "rejected": True,
                    "rejection_reason": "NO_ACTIVE_SESSION",
                    "response_status": None, "outcome": None, "degraded": False}

        if action == "attack":
            record = await self.player.authed("POST", "/api/v1/engine/attack", {
                "session_id": session_id,
                "attacker_id": self.entity_id,
                "target_id": decision["target_id"],
                "action_index": int(decision.get("action_index", 0)),
            })
        elif action == "move":
            record = await self.player.authed("POST", "/api/v1/engine/move", {
                "session_id": session_id,
                "entity_id": self.entity_id,
                "x": float(decision["x"]),
                "y": float(decision["y"]),
            })
        elif action == "heal":
            record = await self.player.authed("POST", "/api/v1/engine/heal", {
                "session_id": session_id,
                "entity_id": decision["target_id"],
                "amount": int(decision.get("amount", self.heal_amount)),
            })
        elif action == "check":
            record = await self.player.authed("POST", "/api/v1/engine/check", {
                "modifier": int(decision.get("modifier", 1)),
                "dc": int(decision.get("dc", 12)),
            })
        else:  # defensive: decisions are validated upstream; never trust twice
            return {"attempted": False, "accepted": False, "rejected": True,
                    "rejection_reason": "INVALID_ACTION",
                    "response_status": None, "outcome": None, "degraded": False}

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


def validate_decision(parsed: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate an LLM decision: campaign_sim's rules for attack/move/check,
    extended with the heal vocabulary (target required; amount coerced >= 0).
    Model output is untrusted input."""
    if isinstance(parsed, dict) and \
            isinstance(parsed.get("action"), str) and \
            parsed["action"].lower() == "heal":
        target = parsed.get("target_id")
        if not isinstance(target, str) or not target.strip():
            return None, "missing_heal_target"
        amount = parsed.get("amount", None)
        amount_i = _as_int(amount) if amount is not None else None
        if amount is not None and (amount_i is None or amount_i < 0):
            return None, "malformed_heal_amount"
        decision: Dict[str, Any] = {"action": "heal", "target_id": target.strip()}
        if amount_i is not None:
            decision["amount"] = amount_i
        decision["reason"] = str(parsed.get("reason", ""))[:200]
        return decision, None
    return _validate_base_decision(parsed)


# ---------------------------------------------------------------------------
# Entry point helper
# ---------------------------------------------------------------------------

async def take_companion_turn(player: CampaignSimPlayer, role: str = "tank",
                              **kwargs) -> Dict[str, Any]:
    """One-shot convenience: observe through the seat, then take one turn."""
    companion = AiCompanion(player, role=role, **kwargs)
    return await companion.take_turn(await companion.observe())


if __name__ == "__main__":  # pragma: no cover - manual smoke run
    from .campaign_sim import load_dotenv, run_simulation

    load_dotenv(os.environ.get("ENV_FILE", ".env"))
    print(json.dumps(run_simulation(players=2, rounds=2), indent=2, default=str))
