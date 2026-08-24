"""Tool-calling agent loop bound to the AUTHORITATIVE engine API.

The LLM never touches game state. It may only emit structured tool calls;
every tool executes through ``routing.engine_client``, which authenticates
against vtt-server and whose endpoints resolve all math server-side.
Rejected calls are fed back as observations so the agent can correct itself
(the diagnostic-retry philosophy, generalized to tool use).
"""

import json
from typing import Any, Dict, List, Optional

from ..routing import engine_client
from ..routing.engine_client import EngineRejectedError, EngineUnavailableError

MAX_TOOL_ROUNDS = 6

AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "attack_target",
            "description": "Resolve one attack from an attacker entity against a target entity. All bonuses, AC and damage dice resolve inside the authoritative engine — supply ids only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "attacker_id": {"type": "string"},
                    "target_id": {"type": "string"},
                    "action_index": {
                        "type": "integer",
                        "description": "Index into the attacker's stat-block attack list (default 0).",
                    },
                },
                "required": ["attacker_id", "target_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cast_spell",
            "description": "Cast a spell by compendium id at a given slot level against an optional target. Slot availability, components and concentration are validated engine-side.",
            "parameters": {
                "type": "object",
                "properties": {
                    "caster_id": {"type": "string"},
                    "target_id": {"type": "string"},
                    "spell_id": {"type": "string"},
                    "spell_name": {"type": "string"},
                    "level": {"type": "integer"},
                    "damage_formula": {"type": "string"},
                    "damage_type": {"type": "string"},
                },
                "required": ["caster_id", "spell_id", "spell_name", "level"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "move_entity",
            "description": "Move an entity to world coordinates (feet). The engine validates walls and the speed budget.",
            "parameters": {
                "type": "object",
                "properties": {
                    "entity_id": {"type": "string"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                },
                "required": ["entity_id", "x", "y"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "advance_turn",
            "description": "Advance one combat round: refresh action budgets and tick condition durations.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


class EngineToolAgent:
    """Executes LLM tool calls strictly through the authenticated engine API."""

    def __init__(self, gateway):
        # gateway: routing.llm_client.LLMStreamingGateway (shares LLMConfig)
        self.gateway = gateway

    # ------------------------------------------------------------- execution

    def _execute_tool(self, session_id: str, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            if name == "attack_target":
                return engine_client.engine_request_sync(
                    "POST",
                    f"/api/v1/sessions/{session_id}/action/attack",
                    {
                        "attacker_id": engine_client._coerce_uuid(args["attacker_id"]),
                        "target_id": engine_client._coerce_uuid(args["target_id"]),
                        "action_index": int(args.get("action_index", 0)),
                    },
                )
            if name == "move_entity":
                return engine_client.engine_request_sync(
                    "POST",
                    f"/api/v1/sessions/{session_id}/move",
                    {
                        "entity_id": engine_client._coerce_uuid(args["entity_id"]),
                        "x": float(args["x"]),
                        "y": float(args["y"]),
                    },
                )
            if name == "advance_turn":
                return engine_client.engine_request_sync(
                    "POST", f"/api/v1/sessions/{session_id}/turn/next", {}
                )
            if name == "cast_spell":
                spell = {
                    "spell_id": str(args["spell_id"]),
                    "name": str(args.get("spell_name", args["spell_id"])),
                    "level": int(args["level"]),
                    "school": "",
                    "casting_time": "1 action",
                    "range_feet": 60,
                    "area_of_effect_shape": None,
                    "area_of_effect_size_feet": None,
                    "verbal_component": True,
                    "somatic_component": True,
                    "material_component_desc": None,
                    "save_attribute": None,
                    "damage_formula": args.get("damage_formula"),
                    "damage_type": args.get("damage_type"),
                    "duration_rounds": 0,
                    "is_concentration": False,
                    "is_ritual": False,
                }
                payload: Dict[str, Any] = {
                    "caster_id": engine_client._coerce_uuid(args["caster_id"]),
                    "spell": spell,
                    "cast_level": int(args["level"]),
                }
                if args.get("target_id"):
                    payload["target_id"] = engine_client._coerce_uuid(args["target_id"])
                return engine_client.engine_request_sync(
                    "POST",
                    f"/api/v1/sessions/{session_id}/action/cast-spell",
                    payload,
                )
            return {"error": f"UNKNOWN_TOOL {name}"}
        except EngineRejectedError as exc:
            # The engine's rejection IS the observation — feed it back verbatim.
            try:
                detail = json.loads(exc.detail)
            except (TypeError, ValueError):
                detail = exc.detail
            return {"engine_rejected": True, "status": exc.status_code, "detail": detail}
        except EngineUnavailableError as exc:
            return {"error": "ENGINE_UNAVAILABLE", "detail": str(exc)}

    # ------------------------------------------------------------------ loop

    async def run_turn(self, user_intent: str, session_id: str) -> Dict[str, Any]:
        """Full perceive→decide→act loop. Returns narration + a complete
        audit trace of every executed engine call."""
        system_prompt = (
            "You are the Encounter DM for an authoritative virtual tabletop. "
            "Translate the player's intent into tool calls against the rules "
            "engine. NEVER invent mechanical outcomes — query tools and report "
            "their real results. When the action is fully resolved, write 2-3 "
            "sentences of narration grounded strictly in the tool outputs."
        )
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_intent},
        ]
        trace: List[Dict[str, Any]] = []

        try:
            for _ in range(MAX_TOOL_ROUNDS):
                message = await self.gateway.complete_with_tools(messages, AGENT_TOOLS)

                tool_calls = message.get("tool_calls") or []
                if not tool_calls:
                    return {
                        "status": "COMPLETED",
                        "narration": message.get("content", ""),
                        "tool_trace": trace,
                    }

                messages.append(message)
                for call in tool_calls:
                    fn = call.get("function", {})
                    name = fn.get("name", "")
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except ValueError:
                        args = {}
                    result = self._execute_tool(session_id, name, args)
                    trace.append({"tool": name, "args": args, "result": result})
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call.get("id", ""),
                        "content": json.dumps(result)[:2000],
                    })

            return {
                "status": "MAX_ROUNDS_EXCEEDED",
                "narration": "",
                "tool_trace": trace,
            }
        except RuntimeError as exc:
            # Honest failure — never a COMPLETED turn with empty narration.
            # Distinguish "no key configured" from "upstream answered with an
            # empty stream/body": both are failures, but they mean different
            # things to whoever is debugging the gateway.
            detail = str(exc)
            status = (
                "LLM_UPSTREAM_EMPTY"
                if detail.startswith("LLM_UPSTREAM_EMPTY")
                else "UNAVAILABLE"
            )
            return {"status": status, "detail": detail, "tool_trace": trace}
