"""NPC Disposition Scoring (GOALS.md Pillar 8).

Directed, time-decayed relationship scores between an NPC/faction and a
player. The overall disposition toward a player is composed of:

* **trust**      - grows on cooperative acts (aided, gifted), shrinks on
                   betrayal/attack. Slow decay.
* **fear**       - grows on displays of power and threats, decays much
                   faster than trust.
* **alignment**  - a static per-(npc, player) bias applied on top of the
                   dynamic components.
* **stress**     - an NPC-level scalar that rises when the NPC is wounded,
                   loses allies or is threatened; it multiplies the effect
                   of fear on the final score.

All scoring is deterministic: every mutation/query takes an explicit
timestamp (or consults an injected clock callable). No wall-clock reads are
performed inside the engine itself.

Scores are bounded to [-100, +100]; stance bands:

    score >=  60   -> "allied"
    score >=  20   -> "friendly"
    score >  -20   -> "neutral"
    score >  -60   -> "unfriendly"
    otherwise      -> "hostile"
"""

from dataclasses import dataclass
from time import time as _wall_clock
from typing import Callable, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "NpcInteractionRecord",
    "NpcDispositionEngine",
    "KNOWN_INTERACTION_KINDS",
    "KNOWN_STRESS_REASONS",
    "STANCE_BANDS",
]

#: Interaction kinds understood by :meth:`NpcDispositionEngine.record_interaction`.
KNOWN_INTERACTION_KINDS = frozenset(
    {"aided", "attacked", "threatened", "gifted", "betrayed", "ignored"}
)

#: Valid reasons for :meth:`NpcDispositionEngine.report_stress`.
KNOWN_STRESS_REASONS = frozenset({"hp_low", "wounded", "allies_died", "ally_death", "threatened", "outnumbered"})

#: Ordered (threshold, stance) bands evaluated top-down.
STANCE_BANDS: tuple = (
    (60.0, "allied"),
    (20.0, "friendly"),
    (-20.0, "neutral"),
    (-60.0, "unfriendly"),
)

_SCORE_MIN = -100.0
_SCORE_MAX = 100.0


class NpcInteractionRecord(BaseModel):
    """A single directed NPC->player interaction event."""

    model_config = ConfigDict(extra="forbid")

    npc_id: str = Field(..., min_length=1)
    player_id: str = Field(..., min_length=1)
    kind: Literal["aided", "attacked", "threatened", "gifted", "betrayed", "ignored"]
    magnitude: float = Field(1.0, ge=0.0, le=1000.0)
    timestamp: float = Field(..., ge=0.0)


@dataclass
class _PairState:
    """Dynamic relationship state for one directed (npc, player) pair."""

    trust: float = 0.0
    fear: float = 0.0
    alignment_bias: float = 0.0
    last_event_ts: float = 0.0


@dataclass
class _NpcStress:
    """NPC-level stress state (shared across all players of that NPC)."""

    value: float = 0.0
    last_update_ts: float = 0.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _decay(value: float, elapsed: float, half_life: float) -> float:
    """Exponential decay of ``value`` toward zero over ``elapsed`` seconds."""
    if half_life <= 0.0 or elapsed <= 0.0:
        return value
    return value * (0.5 ** (elapsed / half_life))


class NpcDispositionEngine:
    """Tracks per-(npc_id, player_id) directed disposition scores in [-100, +100]."""

    def __init__(
        self,
        trust_half_life: float = 7 * 24 * 3600.0,
        fear_half_life: float = 2 * 24 * 3600.0,
        stress_half_life: float = 12 * 3600.0,
        clock: Optional[Callable[[], float]] = None,
    ):
        if trust_half_life <= 0.0 or fear_half_life <= 0.0 or stress_half_life <= 0.0:
            raise ValueError("half_life values must be positive")
        self.trust_half_life = float(trust_half_life)
        self.fear_half_life = float(fear_half_life)
        self.stress_half_life = float(stress_half_life)
        # Injectable clock keeps the engine deterministic in tests/simulations;
        # wall-clock is only consulted when callers omit timestamps.
        self._clock: Callable[[], float] = clock if clock is not None else _wall_clock
        self._pairs: Dict[tuple, _PairState] = {}
        self._stress: Dict[str, _NpcStress] = {}
        self._records: List[NpcInteractionRecord] = []

    # ------------------------------------------------------------------ #
    # Event API
    # ------------------------------------------------------------------ #

    def record_interaction(
        self,
        npc_id: str,
        player_id: str,
        kind: str,
        magnitude: float = 1.0,
        timestamp: Optional[float] = None,
    ) -> NpcInteractionRecord:
        """Record a directed interaction and update the pair's components.

        Raises:
            ValueError: if ``kind`` is not a known interaction kind or
                magnitude is negative.
        """
        if kind not in KNOWN_INTERACTION_KINDS:
            raise ValueError(f"unknown interaction kind {kind!r}; expected one of {sorted(KNOWN_INTERACTION_KINDS)}")
        if magnitude < 0.0:
            raise ValueError("magnitude must be >= 0")

        ts = float(timestamp) if timestamp is not None else float(self._clock())
        record = NpcInteractionRecord(
            npc_id=npc_id, player_id=player_id, kind=kind, magnitude=magnitude, timestamp=ts
        )
        self._records.append(record)

        state = self._pairs.setdefault((npc_id, player_id), _PairState())
        state.last_event_ts = max(state.last_event_ts, ts)

        trust_delta, fear_delta = self._effect(kind, magnitude)
        state.trust = _clamp(state.trust + trust_delta, _SCORE_MIN, _SCORE_MAX)
        state.fear = _clamp(state.fear + fear_delta, 0.0, _SCORE_MAX)

        if kind == "threatened":
            self.report_stress(npc_id, 10.0 * magnitude, timestamp=ts, reason="threatened")

        return record

    def report_stress(
        self,
        npc_id: str,
        amount: float,
        timestamp: Optional[float] = None,
        reason: str = "",
    ) -> float:
        """Raise (or lower with negative amounts) the NPC's stress level.

        Stress sources include low HP, ally deaths, being outnumbered or
        threatened. Returns the updated stress value clamped to [0, 100].
        """
        if reason and reason not in KNOWN_STRESS_REASONS:
            raise ValueError(f"unknown stress reason {reason!r}; expected one of {sorted(KNOWN_STRESS_REASONS)}")

        ts = float(timestamp) if timestamp is not None else float(self._clock())
        current = self._stress.get(npc_id, _NpcStress())
        decayed = _decay(current.value, ts - current.last_update_ts, self.stress_half_life)
        new_value = _clamp(decayed + amount, 0.0, 100.0)

        self._stress[npc_id] = _NpcStress(value=new_value, last_update_ts=max(current.last_update_ts, ts))
        return new_value

    def set_alignment_bias(self, npc_id: str, player_id: str, bias: float) -> None:
        """Set the static alignment-compatibility bias for this pair ([-50, +50])."""
        state = self._pairs.setdefault((npc_id, player_id), _PairState())
        state.alignment_bias = _clamp(float(bias), -50.0, 50.0)

    # ------------------------------------------------------------------ #
    # Query API
    # ------------------------------------------------------------------ #

    def disposition(self, npc_id: str, player_id: str, timestamp: Optional[float] = None) -> float:
        """Overall directed score of ``npc_id`` toward ``player_id`` in [-100, +100]."""
        return round(self.snapshot(npc_id, player_id, timestamp=timestamp)["score"], 6)

    def stance(self, npc_id: str, player_id: str, timestamp: Optional[float] = None) -> str:
        """Map the overall score to hostile/unfriendly/neutral/friendly/allied."""
        score = self.disposition(npc_id, player_id, timestamp=timestamp)
        for threshold, name in STANCE_BANDS:
            if score >= threshold:
                return name
        return "hostile"

    def stress(self, npc_id: str, timestamp: Optional[float] = None) -> float:
        """Current (decayed) NPC-level stress in [0, 100]."""
        ts = float(timestamp) if timestamp is not None else float(self._clock())
        current = self._stress.get(npc_id)
        if current is None:
            return 0.0
        return round(_decay(current.value, ts - current.last_update_ts, self.stress_half_life), 6)

    def components(self, npc_id: str, player_id: str, timestamp: Optional[float] = None) -> Dict[str, float]:
        """Decayed component breakdown (trust, fear, alignment_bias, stress)."""
        snap = self.snapshot(npc_id, player_id, timestamp=timestamp)
        return {k: snap[k] for k in ("trust", "fear", "stress", "alignment_bias")}

    def snapshot(self, npc_id: str, player_id: str, timestamp: Optional[float] = None) -> Dict[str, object]:
        """Full deterministic breakdown for one directed pair."""
        ts = float(timestamp) if timestamp is not None else float(self._clock())
        state = self._pairs.get((npc_id, player_id))

        if state is None:
            return {
                "npc_id": npc_id,
                "player_id": player_id,
                "trust": 0.0,
                "fear": 0.0,
                "stress": 0.0,
                "alignment_bias": 0.0,
                "score": 0.0,
                "stance": "neutral",
            }

        trust = _decay(state.trust, ts - state.last_event_ts, self.trust_half_life)
        fear = _decay(state.fear, ts - state.last_event_ts, self.fear_half_life)
        stress_value = self.stress(npc_id, timestamp=ts)
        fear_multiplier = 1.0 + stress_value / 100.0

        score = _clamp(trust - fear * fear_multiplier + state.alignment_bias, _SCORE_MIN, _SCORE_MAX)
        stance = "hostile"
        for threshold, name in STANCE_BANDS:
            if score >= threshold:
                stance = name
                break

        return {
            "npc_id": npc_id,
            "player_id": player_id,
            "trust": round(trust, 6),
            "fear": round(fear, 6),
            "stress": stress_value,
            "alignment_bias": state.alignment_bias,
            "score": round(score, 6),
            "stance": stance,
        }

    def history(self) -> List[NpcInteractionRecord]:
        """All recorded interaction events, in order."""
        return list(self._records)

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    @staticmethod
    def _effect(kind: str, magnitude: float) -> tuple:
        """(trust_delta, fear_delta) for an interaction kind."""
        table = {
            # cooperative acts build trust, slightly soothe fear
            "aided": (8.0 * magnitude, -2.0 * magnitude),
            "gifted": (4.0 * magnitude, -1.0 * magnitude),
            # hostility erodes trust and breeds fear
            "attacked": (-12.0 * magnitude, 10.0 * magnitude),
            "betrayed": (-30.0 * magnitude, 5.0 * magnitude),
            "threatened": (-6.0 * magnitude, 14.0 * magnitude),
            # neglect slowly wears trust down without fear
            "ignored": (-2.0 * magnitude, 0.0),
        }
        return table[kind]
