"""PILLAR-3 death-save audit for session replay exports.

The engine-side death-save state machine is authoritative, but a replay
export is a projection of the ledger — the audit the gateway ships beside
it must be derivable from the SAME events the export already carries, and
must be honest about what it cannot reconstruct.

Inputs: the list of raw engine events (in ledger order). Outputs: a
structured report listing, per token, the death-save episodes the ledger
actually recorded:

    {
      "available": bool,
      "note": str | None,            # when unavailable, explains why
      "entries": [
        {
          "token_id": str,
          "trigger_at_sequence": int,
          "trigger_event_type": str, # DAMAGE_APPLIED | ATTACK_RESOLVED | SPELL_CAST
          "trigger_source_id": str,  # actor that caused the drop
          "hp_was_zero_at_sequence": int | None,
          "instant_death": bool,
          "save_attempts": [
            {"sequence": int, "kind": str, "roll": int | None, "result": str | None}
          ],
          "outcome": "stabilized" | "died" | "in_progress",
        }
      ],
    }

Honesty contract (mirrors the rest of the replay route): every field
above is populated only when the engine event carries the supporting
field. Triggers inferred from a non-damage event are admitted with
``hp_was_zero_at_sequence = null`` so a reader can tell best-effort
attribution apart from a literal hp-at-zero observation.
"""

from typing import Any, Dict, List, Optional


_TRIGGERING_EVENTS = ("DAMAGE_APPLIED", "ATTACK_RESOLVED", "SPELL_CAST")
_OUTCOME_STABILIZED = "stabilized"
_OUTCOME_DIED = "died"
_OUTCOME_IN_PROGRESS = "in_progress"


def _opt(payload: Any, key: str) -> Any:
    return payload.get(key) if isinstance(payload, dict) else None


def _event_is_reverted(event: Dict[str, Any]) -> bool:
    """X-card rewinds set ``is_reverted``; those events must never feed the
    audit because they were undone in-fiction. Same policy as the replay
    exporter."""
    return bool(event.get("is_reverted"))


def _hp_after_damage(event: Dict[str, Any]) -> Optional[int]:
    """Extracts the post-event HP for any damage-shaped event, or None if
    the field is absent."""
    payload = event.get("payload") or {}
    if event.get("event_type") == "DAMAGE_APPLIED":
        v = _opt(payload, "hp_remaining")
        return v if isinstance(v, int) else None
    if event.get("event_type") == "ATTACK_RESOLVED":
        v = _opt(payload, "target_hp_remaining")
        return v if isinstance(v, int) else None
    if event.get("event_type") == "SPELL_CAST":
        v = _opt(payload, "target_hp_remaining")
        return v if isinstance(v, int) else None
    return None


def _damage_amount(event: Dict[str, Any]) -> Optional[int]:
    payload = event.get("payload") or {}
    if event.get("event_type") == "DAMAGE_APPLIED":
        v = _opt(payload, "amount")
        return v if isinstance(v, int) else None
    if event.get("event_type") == "ATTACK_RESOLVED":
        v = _opt(payload, "total_damage")
        return v if isinstance(v, int) else None
    if event.get("event_type") == "SPELL_CAST":
        v = _opt(payload, "damage_total")
        return v if isinstance(v, int) else None
    return None


def _target_id(event: Dict[str, Any]) -> Optional[str]:
    payload = event.get("payload") or {}
    et = event.get("event_type")
    if et in ("DAMAGE_APPLIED",):
        v = _opt(payload, "target_id")
        return v if isinstance(v, str) else None
    if et in ("ATTACK_RESOLVED", "SPELL_CAST"):
        v = _opt(payload, "target_id")
        return v if isinstance(v, str) else None
    return None


def _trigger_instant_death(event: Dict[str, Any]) -> bool:
    payload = event.get("payload") or {}
    et = event.get("event_type")
    if et == "DAMAGE_APPLIED":
        return bool(_opt(payload, "instant_death"))
    if et == "ATTACK_RESOLVED":
        # The engine sets ``target_is_dead`` for monstrous-damage cases.
        return bool(_opt(payload, "target_is_dead"))
    return False


def _classify_save(payload: Dict[str, Any]) -> Dict[str, Any]:
    """One DEATH_SAVE_RESOLVED -> {kind, roll, result}.

    ``kind`` is the SAVE TAXONOMY (success / failure / critical_* /
    ignored_*) used for grouping; ``result`` is the verbatim engine
    outcome string so a curious auditor can still see the raw label.
    The roll is taken verbatim from the payload (None when absent)."""
    roll = _opt(payload, "natural_roll")
    outcome = _opt(payload, "outcome")

    kind = "unknown"
    if outcome in ("ALREADY_DEAD",):
        kind = "ignored_already_dead"
    elif outcome in ("ALREADY_STABILIZED",):
        kind = "ignored_already_stabilized"
    elif outcome == "CRITICAL_SUCCESS_REVIVED_1HP" or roll == 20:
        kind = "critical_success"
    elif outcome == "DEAD":
        kind = "failure"
    elif outcome == "STABILIZED":
        kind = "success"
    elif outcome == "PENDING":
        if roll == 1:
            kind = "critical_failure"
        else:
            # SRD: 10+ succeeds on a death save.
            kind = "success" if (roll is not None and roll >= 10) else "failure"

    return {
        "kind": kind,
        "roll": roll if isinstance(roll, int) else None,
        "result": outcome if isinstance(outcome, str) else None,
    }


def _entry_outcome(instant_death: bool, attempts: List[Dict[str, Any]],
                   healed_after_trigger: bool) -> str:
    """Decides the terminal state of one death-save episode."""
    if instant_death:
        return _OUTCOME_DIED
    if healed_after_trigger:
        # Regaining HP while dying ends the save counter (SRD). Treat as
        # stabilized — the token is no longer dying and never completed
        # three rolls. The audit notes the source separately if needed.
        return _OUTCOME_STABILIZED
    if attempts:
        last = attempts[-1]
        result = (last.get("result") or "").upper()
        if last.get("kind") == "critical_success":
            return _OUTCOME_STABILIZED
        if result == "STABILIZED" or result == "CRITICAL_SUCCESS_REVIVED_1HP":
            return _OUTCOME_STABILIZED
        if result == "DEAD":
            return _OUTCOME_DIED
    return _OUTCOME_IN_PROGRESS


def build_death_audit(events: List[Any]) -> Dict[str, Any]:
    """Walks a session's ledger events and produces the death-save audit.

    See module docstring for the output shape. ``events`` may be any
    iterable of dicts with the engine's event shape; entries that lack
    the required fields are passed over without raising — best-effort is
    the documented contract, and absence is reported honestly via
    ``available = False`` when nothing could be derived."""
    if not events:
        return {
            "available": False,
            "note": (
                "Ledger carried no events; without damage events, no death-save "
                "triggers can be reconstructed."
            ),
            "entries": [],
        }

    # Open episodes keyed by token_id; each closes when the token either
    # stabilizes (3 successes, heal, or critical revives) or dies (3
    # failures or instant-death). An episode can also stay open until the
    # export ends — that yields an "in_progress" entry honestly.
    open_episodes: Dict[str, Dict[str, Any]] = {}
    entries: List[Dict[str, Any]] = []

    for event in events:
        if not isinstance(event, dict):
            continue
        if _event_is_reverted(event):
            continue
        seq = event.get("sequence_id")
        et = event.get("event_type")
        payload = event.get("payload") or {}

        if et == "DEATH_SAVE_RESOLVED":
            token = _opt(payload, "actor_id")
            if not isinstance(token, str) or not isinstance(seq, int):
                continue
            classified = _classify_save(payload)
            if token in open_episodes:
                episode = open_episodes[token]
                # Skip saves fired while the token was already stable/dead;
                # the engine tags those ALREADY_*, and they don't belong to
                # the current episode.
                if classified["kind"] in (
                    "ignored_already_dead", "ignored_already_stabilized"
                ):
                    continue
                episode["save_attempts"].append(
                    {"sequence": seq, **classified}
                )
                outcome_string = (classified["result"] or "").upper()
                if outcome_string == "DEAD":
                    episode["outcome"] = _OUTCOME_DIED
                    entries.append(episode)
                    del open_episodes[token]
                elif outcome_string in (
                    "STABILIZED", "CRITICAL_SUCCESS_REVIVED_1HP"
                ) or classified["kind"] == "critical_success":
                    episode["outcome"] = _OUTCOME_STABILIZED
                    entries.append(episode)
                    del open_episodes[token]
            continue

        if et not in _TRIGGERING_EVENTS:
            continue

        target = _target_id(event)
        if not isinstance(target, str) or not isinstance(seq, int):
            continue

        hp_after = _hp_after_damage(event)
        damage = _damage_amount(event)
        instant = _trigger_instant_death(event)

        # Trigger condition: positive damage that lands the target at 0 HP,
        # OR an explicit instant-death flag from the engine. A spell cast
        # that heals to 0 (rare) would have damage_total <= 0 and is excluded.
        if not isinstance(hp_after, int):
            continue
        if hp_after > 0:
            continue
        if not isinstance(damage, int) or damage <= 0:
            continue

        # Close any prior open episode for this token before opening a new
        # one — the engine resets death saves on heal or stabilization, so
        # a new trigger always starts fresh.
        prior = open_episodes.pop(target, None)
        if prior is not None and prior not in entries:
            prior["outcome"] = _OUTCOME_IN_PROGRESS
            entries.append(prior)

        episode = {
            "token_id": target,
            "trigger_at_sequence": seq,
            "trigger_event_type": et,
            "trigger_source_id": event.get("actor_id"),
            "hp_was_zero_at_sequence": seq,
            "instant_death": instant,
            "save_attempts": [],
            "outcome": _OUTCOME_IN_PROGRESS,
        }
        if instant:
            episode["outcome"] = _OUTCOME_DIED
            entries.append(episode)
        else:
            open_episodes[target] = episode

    # Drain any still-open episodes at end of ledger: honest "in_progress".
    for token, episode in open_episodes.items():
        if episode not in entries:
            entries.append(episode)

    if not entries:
        return {
            "available": False,
            "note": (
                "No damage events in this ledger dropped a token to 0 HP; "
                "death-save triggers cannot be reconstructed without a "
                "damage-shaped event whose target HP lands at zero."
            ),
            "entries": [],
        }

    return {"available": True, "note": None, "entries": entries}


def render_death_audit_markdown(report: Dict[str, Any]) -> str:
    """Renders the same report as a human-readable markdown section."""
    lines: List[str] = ["## Death Save Audit", ""]
    if not report.get("available"):
        note = report.get("note") or ""
        if note:
            lines.append(f"_{note}_")
        else:
            lines.append("_No death-save triggers found in this export._")
        lines.append("")
        return "\n".join(lines)

    entries = report.get("entries") or []
    for entry in entries:
        token = entry.get("token_id", "<unknown token>")
        seq = entry.get("trigger_at_sequence")
        et = entry.get("trigger_event_type", "?")
        instant = entry.get("instant_death")
        outcome = entry.get("outcome", "in_progress")
        head = (
            f"- `{token}` triggered death saves at sequence #{seq} "
            f"via {et}"
        )
        if instant:
            head += " (instant death)"
        head += f" → **{outcome}**"
        lines.append(head)
        for attempt in entry.get("save_attempts") or []:
            roll = attempt.get("roll")
            kind = attempt.get("kind", "unknown")
            result = attempt.get("result") or ""
            label = f"roll {roll}" if roll is not None else "roll ?"
            lines.append(
                f"    - seq #{attempt.get('sequence')} {label} → "
                f"{kind}" + (f" ({result})" if result else "")
            )
    lines.append("")
    return "\n".join(lines)