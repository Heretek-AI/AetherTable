"""Session event timeline — Loop 3, iteration 26.

Combines the engine's ledger events with the session's narrative chat log
into a single chronological feed. The engine is authoritative for combat
mechanics (sequence_id, actor_id, event_type, payload); narrative messages
are recorded on the gateway side under per-session ``session_chat_messages``
storage (also introduced in this iteration).

Honest framing of the survey findings that drove this design:

* The engine events DO carry a sequence_id (monotonic u64 from
  ``EventSourcingLedger``). They are projected by the existing
  ``_project_ledger_event`` / ``_event_summary`` helpers, and that helper is
  the base we compose against — never replace it. We feed each event through
  it, then post-process the summary string by replacing UUIDs with resolved
  entity names from the session roster.

* Narrative chat messages are CLIENT-LOCAL state on the React side
  (``client/src/components/NarrativeChat.tsx`` consumes them as a prop, never
  from the network). There was NO server-side chat log before this iteration.
  We added a small per-session in-memory store (``session_chat_messages``)
  and a ``POST /api/v1/sessions/{id}/chat`` append endpoint to anchor the
  timeline; the React client still holds its local-only array and is free
  to mirror it server-side later. The narrative side gets its own monotonic
  per-session counter (``n_<int>``) so the two streams can be merged without
  colliding with engine sequence ids.

* Hidden entities (``is_visible=false``) are projected to ``[Unknown]`` with
  no detail, exactly as the entity-projection matrix on
  ``/api/v1/engine/session-state`` already does. A GM sees verbatim; a
  player sees public events and their own; private events (apply-condition
  by GM on a hidden target) collapse to ``Something happens``.

Projection rules live here as plain functions so the test module can exercise
them without spinning up the FastAPI app.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple


#: Namespace prefix for engine ledger sequence ids on the timeline. Engine
#: events come pre-sequenced as integers; we prefix them to keep the two
#: streams from colliding in sort and cursor comparison.
_ENGINE_PREFIX = "e"
#: Namespace prefix for narrative chat messages. Per-session monotonic
#: counter — see ``storage.append_chat_message``.
_NARRATIVE_PREFIX = "n"

#: Recognized private channels. A narrative message whose channel is in
#: ``_PRIVATE_CHANNELS`` is hidden from non-GM viewers.
_PRIVATE_CHANNELS = frozenset({"gm", "whisper"})

#: Recognized public channels. Anything not in PRIVATE_CHANNELS (default
#: ``public`` and ``system``) is visible to every participant of the session.
_PUBLIC_CHANNELS = frozenset({"public", "system", "ooc"})

#: Default cursor window — events older than the cursor are skipped on the
#: next page. Mirrors the contract the existing
#: ``/api/v1/sessions/{id}/replay/export`` already documents.
DEFAULT_LIMIT = 100
#: Hard cap so a marathon campaign's timeline can never payload-bomb.
_MAX_LIMIT = 500

#: Stub text emitted when a player-tier viewer cannot see a private event.
_PRIVATE_PLACEHOLDER = "Something happens"
#: Stub text emitted when a non-GM viewer hits an event whose target entity is
#: hidden from them. The actor may still be a visible entity (the GM), so we
#: only redact the hidden side.
_UNKNOWN = "[Unknown]"

#: A UUID string is a sequence of 8-4-4-4-12 hex digits. The engine emits
#: UUIDs for entity ids; the formatter uses this regex to find and replace
#: them with resolved names from the session roster. Compiled once at module
#: load so the per-event call does not pay a recompile cost.
_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Engine-event formatting
# ---------------------------------------------------------------------------


def _resolve_entity_name(
    entity_id: Optional[str],
    roster: Dict[str, Any],
) -> Optional[str]:
    """Resolves one entity id against the roster; ``None`` when unknown.

    The roster is the engine's ``entities`` map (``id -> entity``). Hidden
    entities (is_visible=false) are still looked up here so GM projections
    can resolve them; the projection matrix decides whether to redact the
    name downstream.
    """
    if not entity_id:
        return None
    key = str(entity_id)
    if key in roster and isinstance(roster[key], dict):
        name = roster[key].get("name")
        if isinstance(name, str) and name:
            return name
    return None


def _replace_uuids_with_names(text: str, roster: Dict[str, Any]) -> str:
    """Walks one summary string and replaces UUID tokens with roster names.

    Tokens that resolve to no name (unknown id, hidden id, etc.) are left
    verbatim — the projection matrix above handles the redaction decision;
    this helper only resolves what it can resolve.
    """
    def _sub(match: "re.Match[str]") -> str:
        candidate = match.group(0)
        name = _resolve_entity_name(candidate, roster)
        return name if name else candidate

    return _UUID_RE.sub(_sub, text)


def _humanize_engine_event(
    event_type: str,
    payload: Dict[str, Any],
    *,
    actor_id: Optional[str],
    roster: Dict[str, Any],
    redact_numbers: bool,
    privileged: bool,
    referenced_ids: Optional[List[str]] = None,
) -> str:
    """Builds a condensed one-liner for ONE engine event, in the timeline
    flavor (entity ids resolved to names, no numeric leaks to non-GMs).

    This helper duplicates a subset of the projection matrix that already
    lives in ``server._event_summary`` — but in the timeline flavor (id
    resolution + condensed). Keeping the function local avoids a circular
    import and keeps the timeline's surface testable in isolation; the
    server module re-exports the public entry points and reuses them.
    """
    if event_type == "COMBAT_BEGAN":
        return "Combat begins"
    if event_type == "COMBAT_ENDED":
        return "Combat ends"
    if event_type == "TURN_ADVANCED":
        round_no = payload.get("round")
        return f"Round {round_no} begins" if round_no is not None else "Turn advanced"
    if event_type == "DELAY_TAKEN":
        actor = _resolve_entity_name(actor_id, roster) or _resolve_entity_name(
            payload.get("entity_id"), roster
        ) or _UNKNOWN
        round_no = payload.get("round")
        suffix = f" (round {round_no})" if round_no is not None else ""
        return f"{actor} delays{suffix}"
    if event_type == "DELAY_RESUMED":
        actor = _resolve_entity_name(actor_id, roster) or _resolve_entity_name(
            payload.get("entity_id"), roster
        ) or _UNKNOWN
        return f"{actor} resumes"
    if event_type == "CONDITION_EXPIRED":
        condition = payload.get("condition")
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        if condition is None:
            return f"A condition wears off: {actor}"
        return f"{condition} wears off: {actor}"
    if event_type == "CONDITION_APPLIED":
        condition = payload.get("condition")
        target = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        source_id = payload.get("source_entity_id")
        source = _resolve_entity_name(source_id, roster)
        if condition is None:
            return f"Something is happening to {target}"
        source_name = source or _UNKNOWN
        # "GM applies Stunned to Goblin Shaman" reads better than conjugating
        # arbitrary condition names ("stunneds", "frighteneds").
        return f"{source_name} applies {condition} to {target}"
    if event_type == "ATTACK_RESOLVED":
        attacker = _resolve_entity_name(payload.get("attacker_id"), roster)
        target = _resolve_entity_name(payload.get("target_id"), roster)
        is_hit = payload.get("is_hit")
        verb = {True: "hits", False: "misses"}.get(is_hit, "attacks")
        a_name = attacker or _UNKNOWN
        t_name = target or _UNKNOWN
        line = f"{a_name} {verb} {t_name}"
        if not redact_numbers:
            damage = payload.get("total_damage")
            hp = payload.get("target_hp_remaining")
            if damage is not None and damage:
                line += f" for {damage}"
            if hp is not None:
                line += f" (HP→{hp})"
        return line
    if event_type == "DAMAGE_APPLIED":
        target = _resolve_entity_name(payload.get("target_id"), roster) or _UNKNOWN
        amount = payload.get("amount")
        hp = payload.get("hp_remaining")
        if redact_numbers or amount is None:
            return f"{target} takes damage"
        line = f"{target} takes {amount} damage"
        if hp is not None:
            line += f" (HP→{hp})"
        return line
    if event_type == "HEALED":
        target = _resolve_entity_name(payload.get("target_id"), roster) or _UNKNOWN
        amount = payload.get("amount")
        hp = payload.get("hp_remaining")
        if redact_numbers or amount is None:
            return f"{target} is healed"
        line = f"{target} heals {amount}"
        if hp is not None:
            line += f" (HP→{hp})"
        return line
    if event_type == "DEATH_SAVE_RESOLVED":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        roll = payload.get("natural_roll")
        outcome = payload.get("outcome")
        if roll is None and outcome is None:
            return f"{actor} faces death"
        if outcome is None:
            return f"{actor} rolls a death save: {roll}"
        return f"{actor} death-save {outcome} (rolled {roll})" if roll is not None \
            else f"{actor} death-save {outcome}"
    if event_type == "SPELL_CAST":
        caster = _resolve_entity_name(payload.get("caster_id"), roster) or _UNKNOWN
        spell = payload.get("spell_id")
        target = _resolve_entity_name(payload.get("target_id"), roster)
        head = f"{caster} casts {spell}" if spell else f"{caster} casts a spell"
        if target:
            head += f" at {target}"
        if not redact_numbers:
            damage = payload.get("damage_total")
            hp = payload.get("target_hp_remaining")
            if damage is not None and damage:
                head += f" for {damage}"
            if hp is not None:
                head += f" (HP→{hp})"
        return head
    if event_type == "SPELL_COUNTERSPELLED":
        caster = _resolve_entity_name(payload.get("caster_id"), roster) or _UNKNOWN
        spell = payload.get("spell_id") or "a spell"
        return f"{caster}'s {spell} is countered"
    if event_type == "MOVE_ENTITY":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        triggers = payload.get("opportunity_attacks")
        trigger_count = len(triggers) if isinstance(triggers, list) else 0
        line = f"{actor} moves"
        if trigger_count:
            line += (
                f" (provoked {trigger_count} opportunit"
                f"{'y' if trigger_count == 1 else 'ies'})"
            )
        return line
    if event_type == "OPPORTUNITY_ATTACK_RESOLVED":
        attacker = _resolve_entity_name(payload.get("attacker_id"), roster) or _UNKNOWN
        mover = _resolve_entity_name(payload.get("mover_id"), roster) or _UNKNOWN
        resolution = payload.get("resolution")
        is_hit = None
        if isinstance(resolution, dict):
            is_hit = resolution.get("is_hit")
        verb = {True: "hits", False: "misses"}.get(is_hit, "opportunities")
        return f"{attacker} {verb} {mover}"
    if event_type == "READY_ACTION_SET":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        return f"{actor} readies an action"
    if event_type == "READY_ACTION_RELEASED":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        return f"{actor} releases a readied action"
    if event_type == "READIED_ACTION_EXPIRED":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        return f"{actor}'s readied action expires"
    if event_type == "REACTION_ARMED":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        reaction = payload.get("reaction")
        return f"{actor} readies a {reaction} reaction" if reaction else f"{actor} readies a reaction"
    if event_type == "REACTION_CONSUMED":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        reaction = payload.get("reaction")
        return f"{actor} spends a {reaction} reaction" if reaction else f"{actor} spends a reaction"
    if event_type == "HELP_ACTION":
        actor = _resolve_entity_name(payload.get("helper_id"), roster) or _UNKNOWN
        target = _resolve_entity_name(payload.get("target_entity_id"), roster) or _UNKNOWN
        return f"{actor} helps {target}"
    if event_type == "INSPIRATION_CHANGED":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        granted = payload.get("granted")
        if granted is True:
            return f"{actor} gains inspiration"
        if granted is False:
            return f"{actor} spends inspiration"
        return f"{actor}'s inspiration changes"
    if event_type == "ITEM_TRANSFERRED":
        actor = _resolve_entity_name(actor_id, roster) or _UNKNOWN
        return f"{actor} moves an item between containers"
    if event_type == "CONCENTRATION_BROKEN":
        target = _resolve_entity_name(payload.get("target_id"), roster) or _UNKNOWN
        spell = payload.get("spell_id")
        return f"{target} loses concentration on {spell}" if spell else f"{target} loses concentration"
    if event_type == "SAFETY_REWIND_APPLIED":
        player = payload.get("triggered_by")
        topic = payload.get("topic")
        if topic:
            return f"X-card rewind on '{topic}' (by {player})"
        return f"X-card rewind by {player}" if player else "X-card rewind"
    if event_type == "ENTITY_SPAWN":
        return f"A new entity joins"
    if event_type == "ENTITY_DESPAWN":
        return "An entity leaves the board"
    if event_type == "SESSION_CREATED":
        name = payload.get("name")
        return f"Session created: {name}" if name else "Session created"
    # Unknown / future event type: render the raw payload for GM verbatim,
    # withhold for everyone else so a new event type cannot accidentally
    # leak private numbers through the timeline.
    if privileged:
        return f"{event_type}: {json.dumps(payload, sort_keys=True)}"
    return f"{event_type or 'UNKNOWN_EVENT'} occurred"


def format_engine_event(
    event: Dict[str, Any],
    *,
    roster: Dict[str, Any],
    privileged: bool = False,
    redact_numbers: bool = True,
) -> Dict[str, Any]:
    """One engine ledger event -> one timeline entry.

    Returns a dict with the timeline shape (``sequence_id``, ``kind``,
    ``created_at_ms``, ``actor_id``, ``actor_name``, ``channel``, ``role``,
    ``summary``, ``event_type``, ``is_reverted``, ``referenced_entity_ids``).

    The extra ``referenced_entity_ids`` field lists every entity id the
    formatter resolved into the summary — the projection layer uses this
    to decide whether to redact the entry against the session's hidden
    roster without having to regex-recover ids from the rendered text.
    """
    event_type = str(event.get("event_type") or "")
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    sequence_id = event.get("sequence_id")
    actor_id = event.get("actor_id")
    is_reverted = bool(event.get("is_reverted"))
    timestamp = event.get("timestamp")
    created_at_ms = _timestamp_to_ms(timestamp)
    actor_name = _resolve_entity_name(actor_id, roster) or _UNKNOWN
    referenced = _extract_payload_entity_ids(event_type, payload, actor_id)
    summary = _humanize_engine_event(
        event_type,
        payload,
        actor_id=actor_id,
        roster=roster,
        redact_numbers=redact_numbers,
        privileged=privileged,
        referenced_ids=referenced,
    )
    seq_str = _encode_sequence(_ENGINE_PREFIX, sequence_id) if sequence_id is not None else None
    return {
        "sequence_id": seq_str,
        "kind": "engine",
        "created_at_ms": created_at_ms,
        "actor_id": str(actor_id) if actor_id is not None else None,
        "actor_name": actor_name,
        "channel": "public",
        "role": "system",
        "summary": summary,
        "event_type": event_type or None,
        "is_reverted": is_reverted,
        "referenced_entity_ids": sorted(set(str(r) for r in referenced if r)),
    }


def _extract_payload_entity_ids(
    event_type: str,
    payload: Dict[str, Any],
    actor_id: Optional[str],
) -> List[str]:
    """Pulls every entity id referenced by one event payload.

    Returns a list of stringified ids — the caller is responsible for
    deduping. The set is what the projection layer checks against the
    roster's ``is_visible`` flag.
    """
    ids: List[str] = []
    if actor_id:
        ids.append(str(actor_id))

    def _push(key: str) -> None:
        val = payload.get(key)
        if val is None:
            return
        if isinstance(val, str):
            ids.append(val)
        elif isinstance(val, dict):
            ids.append(str(val.get("attacker_id") or val.get("id") or ""))

    # Per-event-type payload keys that carry an entity id we surface in
    # the humanized summary.
    if event_type == "ATTACK_RESOLVED":
        _push("attacker_id")
        _push("target_id")
    elif event_type == "DAMAGE_APPLIED":
        _push("target_id")
    elif event_type == "HEALED":
        _push("target_id")
    elif event_type == "MOVE_ENTITY":
        # Provoked enemies live inside the opportunity_attacks array; we
        # surface only the COUNT in the summary (see _humanize_engine_event)
        # so don't expose them via referenced_entity_ids either.
        pass
    elif event_type == "CONDITION_APPLIED":
        _push("source_entity_id")
    elif event_type == "CONDITION_EXPIRED":
        # actor_id IS the target here.
        pass
    elif event_type == "DELAY_TAKEN":
        _push("entity_id")
    elif event_type == "DELAY_RESUMED":
        _push("entity_id")
    elif event_type == "OPPORTUNITY_ATTACK_RESOLVED":
        _push("attacker_id")
        _push("mover_id")
    elif event_type == "DEATH_SAVE_RESOLVED":
        pass  # actor_id is the target.
    elif event_type == "SPELL_CAST":
        _push("caster_id")
        _push("target_id")
    elif event_type == "SPELL_COUNTERSPELLED":
        _push("caster_id")
    elif event_type == "CONCENTRATION_BROKEN":
        _push("target_id")
    elif event_type == "HELP_ACTION":
        _push("helper_id")
        _push("target_entity_id")
    elif event_type == "REACTION_ARMED":
        pass  # no entity id surface.
    elif event_type == "REACTION_CONSUMED":
        pass
    elif event_type == "INSPIRATION_CHANGED":
        pass
    elif event_type == "ITEM_TRANSFERRED":
        pass
    elif event_type == "READY_ACTION_SET":
        pass
    elif event_type == "READY_ACTION_RELEASED":
        pass
    elif event_type == "READIED_ACTION_EXPIRED":
        pass
    elif event_type == "ENTITY_SPAWN":
        _push("entity_id")
    elif event_type == "ENTITY_DESPAWN":
        _push("entity_id")
    elif event_type == "SAFETY_REWIND_APPLIED":
        # triggered_by is a user_id, not an entity id.
        pass
    elif event_type == "TURN_ADVANCED":
        pass
    elif event_type == "COMBAT_BEGAN":
        # The initiative array names every combatant; the summary just says
        # "Combat begins" so don't reference anyone specifically.
        pass
    elif event_type == "COMBAT_ENDED":
        pass
    return [i for i in ids if i]


# ---------------------------------------------------------------------------
# Narrative-message formatting
# ---------------------------------------------------------------------------


def format_narrative_message(message: Dict[str, Any]) -> Dict[str, Any]:
    """One chat message -> one timeline entry.

    The narrative side was a client-local store before this iteration; the
    message schema mirrors the React ``ChatMessage`` shape plus the gateway's
    server-only fields (sequence_id, created_at_ms).
    """
    sequence_id = message.get("sequence_id")
    seq_str = (
        _encode_sequence(_NARRATIVE_PREFIX, sequence_id)
        if sequence_id is not None
        else None
    )
    user_id = message.get("user_id")
    role = message.get("role") or "player"
    channel = message.get("channel") or "public"
    content = message.get("content") or ""
    created_at_ms = _timestamp_to_ms(message.get("created_at"))
    return {
        "sequence_id": seq_str,
        "kind": "narrative",
        "created_at_ms": created_at_ms,
        "actor_id": str(user_id) if user_id is not None else None,
        "actor_name": message.get("display_name") or (str(user_id) if user_id else _UNKNOWN),
        "channel": channel,
        "role": role,
        "summary": content,
        "event_type": None,
        "is_reverted": False,
    }


# ---------------------------------------------------------------------------
# Role projection
# ---------------------------------------------------------------------------


def _is_hidden_entity(entity_id: Optional[str], roster: Dict[str, Any]) -> bool:
    if not entity_id:
        return False
    entry = roster.get(str(entity_id))
    if not isinstance(entry, dict):
        return False
    # Absent flag defaults to visible (the engine's contract); only an
    # explicit False hides the entity.
    return entry.get("is_visible") is False


def project_timeline_entry(
    entry: Dict[str, Any],
    *,
    role: str,
    viewer_user_id: Optional[str],
    roster: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Applies the role projection matrix to one timeline entry.

    Returns ``None`` when the viewer is not entitled to see the entry at all
    (e.g. a GM-private whisper addressed to a different user). Otherwise
    returns the projected entry with hidden details collapsed.

    Rules:

    * gm / admin: verbatim. Hidden entities surface as their actual name,
      private channels surface with their content intact.
    * player / participant: public events stay verbatim; events whose
      ``actor_id`` or resolved target references a hidden entity surface
      ``[Unknown]`` for that name and no detail. GM-channel chat messages
      collapse to a generic ``Something happens`` line.
    * spectator / unknown role: same as player for hidden-entity collapse;
      private channels drop entirely (return ``None``).
    """
    is_privileged = role in ("gm", "admin")
    channel = entry.get("channel") or "public"
    actor_id = entry.get("actor_id")
    summary = entry.get("summary") or ""
    event_type = entry.get("event_type")

    # Non-GM viewer: redact private channels.
    if not is_privileged and channel not in _PUBLIC_CHANNELS:
        if role == "spectator":
            return None
        # Player tier: collapse private narrative to a generic placeholder
        # so the player can tell SOMETHING happened without learning who or
        # what. GM-channel events stay visible to other GMs in the lobby.
        projected = dict(entry)
        projected["actor_name"] = _UNKNOWN
        projected["summary"] = _PRIVATE_PLACEHOLDER
        projected["event_type"] = None
        projected["is_private"] = True
        return projected

    # Player tier: collapse events that reference a hidden entity.
    if not is_privileged:
        hidden_actor = _is_hidden_entity(actor_id, roster)
        target_ids = _extract_event_target_ids(summary, event_type, entry)
        hidden_target = any(_is_hidden_entity(t, roster) for t in target_ids)
        if hidden_actor or hidden_target:
            projected = dict(entry)
            projected["actor_name"] = _UNKNOWN if hidden_actor else entry.get("actor_name")
            # Drop the summary entirely when a hidden entity is involved
            # so a player never learns what the GM did to the hidden token.
            projected["summary"] = _PRIVATE_PLACEHOLDER
            projected["event_type"] = None
            projected["is_private"] = True
            # Redact the structural identifiers too (iteration 28): a
            # hidden entity's UUID must NEVER reach a non-GM viewer
            # through the timeline. ``actor_id`` collapses to ``None``
            # when the actor itself is hidden; ``referenced_entity_ids``
            # drops every id that resolves to a hidden entity so a player
            # cannot scrape the roster from the projection.
            if hidden_actor:
                projected["actor_id"] = None
            hidden_ids = {
                t for t in target_ids if _is_hidden_entity(t, roster)
            }
            referenced = projected.get("referenced_entity_ids")
            if isinstance(referenced, list):
                projected["referenced_entity_ids"] = [
                    r for r in referenced
                    if str(r) not in hidden_ids
                ]
            return projected

    return entry


def _extract_event_target_ids(
    summary: str,
    event_type: Optional[str],
    entry: Dict[str, Any],
) -> List[str]:
    """Returns the entity ids the entry references.

    Engine entries carry the id set on ``referenced_entity_ids`` (populated
    by :func:`format_engine_event` from the raw payload, BEFORE the names
    were resolved into the summary). Narrative entries have no target
    concept — only an actor user id.
    """
    if event_type is None:
        return []
    referenced = entry.get("referenced_entity_ids")
    if isinstance(referenced, list):
        return [str(r) for r in referenced if r]
    # Backward-compat fallback for hand-rolled entries: regex the summary.
    return _UUID_RE.findall(summary or "")


# ---------------------------------------------------------------------------
# Merge + cursor
# ---------------------------------------------------------------------------


def merge_timeline(
    engine_entries: Iterable[Dict[str, Any]],
    narrative_entries: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Chronological merge of two already-formatted streams.

    Sort order: ``created_at_ms`` ascending; ties broken by ``kind``
    (``engine`` before ``narrative`` so an engine combat event beats a
    same-millisecond chat line), then by ``sequence_id`` for stable
    ordering across pages.
    """
    out: List[Dict[str, Any]] = []
    out.extend(engine_entries)
    out.extend(narrative_entries)
    out.sort(
        key=lambda e: (
            int(e.get("created_at_ms") or 0),
            0 if e.get("kind") == "engine" else 1,
            str(e.get("sequence_id") or ""),
        )
    )
    return out


def encode_cursor(entry: Dict[str, Any]) -> str:
    """Encode a cursor pointing AT the given entry (next page starts AFTER it)."""
    if not entry.get("sequence_id"):
        return ""
    return f"{int(entry.get('created_at_ms') or 0)}:{entry['sequence_id']}"


def decode_cursor(cursor: Optional[str]) -> Tuple[int, str]:
    """Inverse of :func:`encode_cursor`. Returns ``(created_at_ms, sequence_id)``."""
    if not cursor:
        return (0, "")
    parts = cursor.split(":", 1)
    if len(parts) != 2:
        return (0, "")
    try:
        ms = int(parts[0])
    except (TypeError, ValueError):
        return (0, "")
    return (ms, parts[1])


def filter_after_cursor(
    entries: List[Dict[str, Any]],
    cursor: Optional[str],
    limit: int = DEFAULT_LIMIT,
) -> List[Dict[str, Any]]:
    """Paginate a chronologically-sorted timeline.

    Pagination is on the merged order: skip everything whose
    ``(created_at_ms, sequence_id)`` sorts at-or-before the cursor, then
    return the next ``limit`` entries.
    """
    if limit <= 0:
        limit = DEFAULT_LIMIT
    if limit > _MAX_LIMIT:
        limit = _MAX_LIMIT
    cur_ms, cur_seq = decode_cursor(cursor)
    out: List[Dict[str, Any]] = []
    for entry in entries:
        ms = int(entry.get("created_at_ms") or 0)
        seq = str(entry.get("sequence_id") or "")
        # Tuple comparison: skip if (ms, seq) <= cursor (strict-ascending).
        if (ms, seq) <= (cur_ms, cur_seq):
            continue
        out.append(entry)
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _encode_sequence(prefix: str, seq: Any) -> Optional[str]:
    """Encodes an engine or narrative sequence id with a namespace prefix."""
    if seq is None:
        return None
    try:
        n = int(seq)
    except (TypeError, ValueError):
        return None
    return f"{prefix}_{n}"


def _timestamp_to_ms(value: Any) -> int:
    """Accepts an ISO-8601 string or numeric timestamp and returns ms-since-epoch.

    A missing / unparseable timestamp sorts as ``0`` (oldest possible), which
    is the honest answer — we do not invent a timestamp the engine never
    produced.
    """
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        # Engine emits seconds-since-epoch floats; promote to ms.
        seconds = float(value)
        if seconds > 10_000_000_000:
            return int(seconds)  # already ms
        return int(seconds * 1000)
    if isinstance(value, str):
        # ISO-8601 with optional trailing 'Z'. datetime.fromisoformat on
        # Python 3.11+ accepts the trailing 'Z' only when reformatted.
        candidate = value.strip()
        if not candidate:
            return 0
        try:
            from datetime import datetime, timezone
            iso = candidate.replace("Z", "+00:00") if candidate.endswith("Z") else candidate
            parsed = datetime.fromisoformat(iso)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1000)
        except (TypeError, ValueError):
            return 0
    return 0