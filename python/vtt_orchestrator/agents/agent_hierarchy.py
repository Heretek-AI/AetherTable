"""Agent hierarchy: deterministic campaign pacing + schema-bound drafting.

``DirectorAgent`` is the macro-level Campaign Director (GOALS.md Pillar 5).
It is a DETERMINISTIC tension tracker: it consumes only observable signals
(HP damage dealt, entity deaths, NPC-disposition stance transitions,
quest-stage advances, rounds elapsed), maintains a bounded [0, 1] tension
curve over time, and derives pacing recommendations from that curve with pure
threshold rules. No RNG, no wall clock, no model calls anywhere in the math —
identical signal sequences always produce identical curves.

The LLM's ONLY role here is drafting hook TEXT for an already-decided
recommendation (:meth:`DirectorAgent.draft_hook_text`); every result carries
an explicit ``generator`` provenance label and unparseable/unavailable output
yields ``None`` rather than invented prose.
"""

import asyncio
from typing import Any, Dict, List, Optional, Sequence

from ..schemas.models import EncounterDMContextUpdate


# ---------------------------------------------------------------------------
# Deterministic tension model (all constants are part of the tested contract)
# ---------------------------------------------------------------------------

#: Contribution weights of one round's raw tension signal. They sum to 1.0 so
#: a fully-saturated round maps to raw == 1.0 before smoothing.
WEIGHT_HP_SWING = 0.35
WEIGHT_DEATHS = 0.25
WEIGHT_DISPOSITION_SHIFT = 0.20
WEIGHT_ROUND_PRESSURE = 0.15
WEIGHT_QUEST_STAGE = 0.05

#: Rounds elapsed at which the round-pressure component saturates.
ROUND_PRESSURE_HORIZON = 10.0

#: Stance transitions observed in one round that saturate the social component.
DISPOSITION_SHIFT_SATURATION = 2.0

#: Exponential smoothing: new_tension = SMOOTHING * raw + (1 - SMOOTHING) * prev.
SMOOTHING = 0.5

TENSION_FLOOR = 0.0
TENSION_CEILING = 1.0

#: Recommendation thresholds over the smoothed curve.
LOW_TENSION_THRESHOLD = 0.35
HIGH_TENSION_THRESHOLD = 0.80
PLATEAU_BAND = 0.02

#: A single round whose RAW signal reaches this is already dramatic enough
#: (someone probably died) that the director suggests a complication now,
#: without waiting for the smoothed level to climb.
SATURATION_COMPLICATION_THRESHOLD = 0.60


def _clamp01(value: float) -> float:
    return max(TENSION_FLOOR, min(TENSION_CEILING, value))


class DirectorAgent:
    """Deterministic Campaign Director: tension curve + pacing advice.

    Signals are pushed in per round via :meth:`observe_round`; per-player
    accepted-action counts (a conversational-agency proxy computed from real
    proxy verdicts) via :meth:`record_player_action`.
    """

    def __init__(
        self,
        *,
        player_ids: Optional[Sequence[str]] = None,
        party_hp_pool: float = 100.0,
    ):
        party_hp_pool = float(party_hp_pool)
        if party_hp_pool <= 0:
            raise ValueError("party_hp_pool must be > 0")
        self.party_hp_pool = party_hp_pool
        self._tension = TENSION_FLOOR
        self._curve: List[Dict[str, Any]] = []
        ids = list(player_ids or [])
        if len(set(ids)) != len(ids):
            raise ValueError("player_ids must be unique")
        self._action_counts: Dict[str, int] = {pid: 0 for pid in ids}

    # -- signal ingestion ---------------------------------------------------

    def observe_round(
        self,
        round_number: int,
        *,
        hp_damage: float = 0.0,
        deaths: int = 0,
        disposition_shifts: int = 0,
        quest_stage_advanced: bool = False,
    ) -> Dict[str, Any]:
        """Fold one round of OBSERVED signals into the tension curve.

        Raises ValueError on negative signals — callers must never paper over
        a mis-count; coerce upstream instead.
        """
        hp_damage = float(hp_damage)
        deaths = int(deaths)
        disposition_shifts = int(disposition_shifts)
        if hp_damage < 0 or deaths < 0 or disposition_shifts < 0:
            raise ValueError("director signals must be non-negative")
        round_number = int(round_number)

        components = {
            "hp_swing": _clamp01(hp_damage / self.party_hp_pool),
            "deaths": _clamp01(deaths),
            "disposition_shifts": _clamp01(
                disposition_shifts / DISPOSITION_SHIFT_SATURATION),
            "round_pressure": min(max(round_number, 0) / ROUND_PRESSURE_HORIZON, 1.0),
            "quest_stage": 1.0 if quest_stage_advanced else 0.0,
        }
        raw = (
            WEIGHT_HP_SWING * components["hp_swing"]
            + WEIGHT_DEATHS * components["deaths"]
            + WEIGHT_DISPOSITION_SHIFT * components["disposition_shifts"]
            + WEIGHT_ROUND_PRESSURE * components["round_pressure"]
            + WEIGHT_QUEST_STAGE * components["quest_stage"]
        )
        self._tension = round(_clamp01(SMOOTHING * raw + (1.0 - SMOOTHING) * self._tension), 6)
        sample = {"round": round_number, "tension": self._tension,
                  "raw_signal": round(raw, 6),
                  "components": dict(components)}
        self._curve.append(sample)
        return dict(sample)

    def record_player_action(self, player_id: str) -> None:
        """Count one ACCEPTED action by ``player_id`` (conversational-agency
        proxy). Unknown ids are tracked too — the table roster may grow."""
        if not player_id:
            return
        self._action_counts[player_id] = self._action_counts.get(player_id, 0) + 1

    # -- reads --------------------------------------------------------------

    def tension(self) -> float:
        """Current (last-sample) smoothed tension in [0, 1]."""
        return self._tension

    def curve(self) -> List[Dict[str, Any]]:
        """Copy of the full tension curve, oldest first."""
        return [
            {"round": s["round"], "tension": s["tension"],
             "raw_signal": s.get("raw_signal", 0.0),
             "components": dict(s["components"])}
            for s in self._curve
        ]

    # -- recommendations ------------------------------------------------------

    def recommendations(self, min_samples: int = 2) -> List[str]:
        """Deterministic pacing advice from the curve and action counts.

        Rules, evaluated in this order and deduplicated:

        * ``raise_stakes``              - the last ``min_samples`` tensions are
          all below LOW_TENSION_THRESHOLD (the table has gone flat).
        * ``introduce_complication``    - current tension >= HIGH_TENSION_THRESHOLD
          (pressure needs an outlet that is not more of the same), OR the last
          three samples sit inside PLATEAU_BAND of each other (nothing moving).
        * ``spotlight_player:<id>``     - with >= 2 tracked players and at least
          one recorded action, the least-active player's share of accepted
          actions is under half of an even split.
        """
        recs: List[str] = []
        if len(self._curve) >= max(min_samples, 1):
            tail = [s["tension"] for s in self._curve[-min_samples:]]
            if all(t < LOW_TENSION_THRESHOLD for t in tail):
                recs.append("raise_stakes")

            plateau = (
                len(self._curve) >= 3
                and max(s["tension"] for s in self._curve[-3:])
                    - min(s["tension"] for s in self._curve[-3:]) <= PLATEAU_BAND
            )
            saturated = (
                self._curve[-1].get("raw_signal", 0.0)
                >= SATURATION_COMPLICATION_THRESHOLD
            )
            if self._tension >= HIGH_TENSION_THRESHOLD or plateau or saturated:
                recs.append("introduce_complication")

        # Spotlight is an AGENCY rule, independent of the tension curve: it
        # needs only accepted-action counts.
        counts = self._action_counts
        total = sum(counts.values())
        if len(counts) >= 2 and total > 0:
            quietest = min(counts, key=lambda pid: (counts[pid], pid))
            if counts[quietest] / total < 1.0 / (2.0 * len(counts)):
                recs.append(f"spotlight_player:{quietest}")
        return recs

    # -- optional LLM hook TEXT (provenance-labeled, never fabricated) ---------

    HOOK_SYSTEM_PROMPT = (
        "You are the campaign director at a D&D-style virtual tabletop. Reply "
        "ONLY with a single JSON object, no prose, of the form: "
        '{"hook": "<one or two sentences of GM-facing dramatic hook text>"}'
    )

    async def draft_hook_text(
        self,
        gateway: Any,
        *,
        recommendation: Optional[str] = None,
    ) -> Optional[Dict[str, str]]:
        """Draft GM-facing hook TEXT for the CURRENT pacing state.

        The decision (tension level, recommendation) is already made
        deterministically; the gateway may only phrase it. Returns
        ``{"text": ..., "generator": "llm"}`` when the gateway produced
        parseable JSON with a non-empty ``hook`` string, otherwise ``None`` —
        a failed/unparseable call NEVER yields invented prose, and the tension
        math never consults the gateway at all.
        """
        if recommendation is None:
            recs = self.recommendations()
            recommendation = recs[0] if recs else "maintain_pace"
        user_prompt = (
            f'Current table tension is {self.tension():.3f} on [0, 1] and the '
            f'director recommendation is "{recommendation}". Write the hook '
            "text as JSON per the schema."
        )
        try:
            parsed = await asyncio.wait_for(
                gateway.complete_json(self.HOOK_SYSTEM_PROMPT, user_prompt),
                timeout=8.0,
            )
        except Exception:  # unavailable/broken gateway: honestly nothing to show
            return None
        if not isinstance(parsed, dict):
            return None
        text = parsed.get("hook")
        if not isinstance(text, str) or not text.strip():
            return None
        return {"text": text.strip(), "generator": "llm"}


class EncounterDMAgent:
    """
    Micro-level turn management and schema-bound narrative synthesis.
    """

    def __init__(self, director: Optional[DirectorAgent] = None):
        self.director = director or DirectorAgent()

    def generate_combat_draft(
        self,
        user_intent: str,
        engine_result: Dict[str, Any],
        context_update: Optional[EncounterDMContextUpdate] = None,
    ) -> str:
        if context_update:
            # Corrective re-inference pass
            constraint = context_update.auditor_report.failures[0].corrective_constraint
            return (
                f"Following the command, the attack lands firmly. {constraint} "
                f"The target grimaces in pain as {engine_result.get('total_damage', 0)} damage is dealt."
            )

        # Standard initial draft pass
        hit = engine_result.get("is_hit", True)
        dmg = engine_result.get("total_damage", 0)
        hp_rem = engine_result.get("target_hp_remaining", 0)

        if not hit:
            return "The swing cuts through empty air as the target narrowly dodges out of reach."

        if hp_rem <= 0:
            return f"With decisive force, the blow strikes for {dmg} damage, defeating the foe!"
        else:
            return f"A clean strike connects for {dmg} damage! The enemy staggers backward, holding their ground with {hp_rem} HP remaining."
