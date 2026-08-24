"""Dedicated NPC Sub-Agents (GOALS.md Pillar 5).

Implements the Concordia Entity-Component pattern for individual NPCs: an
:class:`ConcordiaNPC` is *composed* of four explicit components rather than
inheriting behaviour:

* :class:`MemoryComponent`      - bounded episodic memory (who/what/when/stance)
                                  with recency+relevance recall.
* :class:`GoalsComponent`       - prioritized goals with satisfaction
                                  predicates; feasibility-aware selection.
* :class:`SocialNormsComponent` - declarative taboos/obligations that vet any
                                  proposed reply (including LLM output).
* :class:`LinguisticStyleComponent` - voice parameters shaping both prompt
                                  construction and the template fallback.

Dialogue generation goes through ``LLMStreamingGateway.complete_json`` when a
gateway is supplied and reachable; otherwise a deterministic, stance- and
style-shaped template reply is produced. Every response carries an honest
``"generator"`` marker of ``"llm"`` or ``"template"`` — a rejected LLM reply
(norms violation) degrades to ``"template"`` with a ``norm_rejected`` reason.
Safety over flavor: no norm-violating text is ever emitted.

Determinism: the fallback path uses no randomness or wall-clock reads; all
temporal state comes from explicit timestamps or the injected disposition
engine clock.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ..simulation.npc_disposition import NpcDispositionEngine

__all__ = [
    "ConcordiaNPC",
    "EpisodicMemory",
    "MemoryComponent",
    "Goal",
    "GoalsComponent",
    "SocialNorm",
    "SocialNormsComponent",
    "LinguisticStyleComponent",
]

#: Context predicate signature shared by goals and norms.
Predicate = Callable[[Dict[str, Any]], bool]

#: Sentinel distinguishing "gateway not passed" (use the ctor gateway, if any)
#: from an explicit ``llm_gateway=None`` (force the deterministic path).
_UNSET_GATEWAY = object()

_TRUE = lambda ctx: True  # noqa: E731
_FALSE = lambda ctx: False  # noqa: E731

_STOPWORDS = frozenset(
    {"the", "and", "for", "you", "your", "was", "were", "are", "with", "that", "this", "what", "who"}
)


def _tokens(text: str) -> set:
    return {w for w in "".join(c if c.isalnum() else " " for c in text.lower()).split() if len(w) > 2 and w not in _STOPWORDS}


# --------------------------------------------------------------------------- #
# Component 1: Memory
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class EpisodicMemory:
    """One bounded episodic record of an interaction."""

    who: str          # counterparty ("player:kira") or self ("npc:marrow")
    what: str         # free-text content of the episode
    when: float       # explicit timestamp (no wall-clock reads here)
    stance_at_time: str = "neutral"


class MemoryComponent:
    """FIFO-bounded episodic memory with keyword+recency recall."""

    def __init__(self, capacity: int = 20):
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self.capacity = int(capacity)
        self._episodes: List[EpisodicMemory] = []

    def record(self, who: str, what: str, when: float = 0.0, stance_at_time: str = "neutral") -> EpisodicMemory:
        """Append an episode, evicting the oldest when over capacity."""
        episode = EpisodicMemory(who=who, what=what, when=float(when), stance_at_time=stance_at_time)
        self._episodes.append(episode)
        if len(self._episodes) > self.capacity:
            del self._episodes[0 : len(self._episodes) - self.capacity]
        return episode

    def all(self) -> List[EpisodicMemory]:
        """Chronological view (oldest first)."""
        return list(self._episodes)

    def recall(self, query: str, limit: int = 5) -> List[EpisodicMemory]:
        """Most relevant episodes for ``query``, newest-weighted.

        Score = keyword-overlap count * 2 + normalized recency rank, so a
        recent on-topic memory beats an older equally-relevant one, but any
        topical match beats pure recency.
        """
        if limit < 1:
            raise ValueError("limit must be >= 1")
        query_tokens = _tokens(query)
        total = max(len(self._episodes), 1)
        scored: List[Tuple[float, int, EpisodicMemory]] = []
        for index, episode in enumerate(self._episodes):
            overlap = sum(
                1 for token in query_tokens if token in _tokens(f"{episode.what} {episode.who}")
            )
            recency = (index + 1) / total
            score = overlap * 2.0 + recency
            if overlap > 0:
                scored.append((score, index, episode))
        scored.sort(key=lambda item: (-item[0], -item[1]))
        return [episode for _, _, episode in scored[:limit]]


# --------------------------------------------------------------------------- #
# Component 2: Goals
# --------------------------------------------------------------------------- #


@dataclass
class Goal:
    """A prioritized goal with optional satisfaction/feasibility predicates."""

    description: str
    priority: float                       # higher wins
    satisfied_when: Predicate = _FALSE    # True -> goal considered achieved
    feasible_when: Predicate = _TRUE      # False -> goal skipped in this context


class GoalsComponent:
    """Prioritized goal list; selection skips satisfied then infeasible goals."""

    #: Used only when every declared goal is satisfied/infeasible.
    FALLBACK_GOAL = Goal("Survive and stay true to my nature", priority=0.0)

    def __init__(self, goals: Optional[Sequence[Goal]] = None):
        self._goals: List[Goal] = list(goals or [])

    def add_goal(self, goal: Goal) -> None:
        self._goals.append(goal)

    def by_priority(self) -> List[Goal]:
        """Goals sorted highest-priority first (stable for ties)."""
        return sorted(self._goals, key=lambda g: -g.priority)

    def current_goal(self, context: Optional[Dict[str, Any]] = None) -> Goal:
        """Highest-priority unsatisfied, feasible goal for this context."""
        ctx = context or {}
        for goal in self.by_priority():
            if goal.satisfied_when(ctx):
                continue
            if not goal.feasible_when(ctx):
                continue
            return goal
        return Goal(
            description=self.FALLBACK_GOAL.description,
            priority=self.FALLBACK_GOAL.priority,
            satisfied_when=self.FALLBACK_GOAL.satisfied_when,
            feasible_when=self.FALLBACK_GOAL.feasible_when,
        )


# --------------------------------------------------------------------------- #
# Component 3: Social Norms
# --------------------------------------------------------------------------- #


@dataclass
class SocialNorm:
    """A declarative behavioural rule checked against proposed replies."""

    description: str
    check: Callable[[str, Dict[str, Any]], Optional[str]]  # reason | None

    @staticmethod
    def taboo(
        forbidden_terms: Sequence[str],
        reason: str,
    ) -> "SocialNorm":
        """Norm: never utter any of the forbidden terms, whatever the audience."""

        def check(proposed_reply: str, context: Dict[str, Any]) -> Optional[str]:
            lowered = proposed_reply.lower()
            for term in forbidden_terms:
                if term.lower() in lowered:
                    return reason
            return None

        return SocialNorm(description=f"Forbidden topics: {', '.join(forbidden_terms)} [{reason}]", check=check)

    @staticmethod
    def obligation(description: str, rule: Callable[[str, Dict[str, Any]], Optional[str]]) -> "SocialNorm":
        """Custom norm from a raw (reply, context) -> reason|None callable."""
        return SocialNorm(description=description, check=rule)


class SocialNormsComponent:
    """Taboos/obligations as declarative rules; violations yield a reason."""

    def __init__(self, norms: Optional[Sequence[SocialNorm]] = None):
        self._norms: List[SocialNorm] = list(norms or [])

    def add_norm(self, norm: SocialNorm) -> None:
        self._norms.append(norm)

    def violates(self, proposed_reply: str, context: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """Reason string for the first violated norm, else None."""
        ctx = context or {}
        for norm in self._norms:
            reason = norm.check(proposed_reply, ctx)
            if reason is not None:
                return reason
        return None

    @property
    def descriptions(self) -> List[str]:
        return [norm.description for norm in self._norms]


# --------------------------------------------------------------------------- #
# Component 4: Linguistic Style
# --------------------------------------------------------------------------- #

_STANCE_OPENERS: Dict[str, str] = {
    "hostile": "Keep your distance.",
    "unfriendly": "Speak plainly or move along.",
    "neutral": "You have my attention, for now.",
    "friendly": "Well met, friend.",
    "allied": "Ah — good to see a trusted face again.",
}
_FORMAL_OPENER = "I bid you greetings."
_CASUAL_OPENER = "Hey."


class LinguisticStyleComponent:
    """Voice parameters: formality, verbosity, tone, signature phrases."""

    def __init__(
        self,
        formality: float = 0.5,
        verbosity: float = 0.5,
        signature_phrases: Sequence[str] = (),
        tone: str = "",
    ):
        if not 0.0 <= formality <= 1.0 or not 0.0 <= verbosity <= 1.0:
            raise ValueError("formality and verbosity must be within [0, 1]")
        self.formality = float(formality)
        self.verbosity = float(verbosity)
        self.signature_phrases = tuple(signature_phrases)
        self.tone = tone

    def render(self) -> str:
        """Human-readable voice block for prompt construction."""
        register = (
            "highly formal"
            if self.formality >= 0.7
            else "casual"
            if self.formality <= 0.3
            else "conversational"
        )
        length = "laconic" if self.verbosity <= 0.3 else "expansive" if self.verbosity >= 0.7 else "measured"
        parts = [f"register: {register}", f"verbosity: {length}"]
        if self.tone:
            parts.append(f"tone: {self.tone}")
        if self.signature_phrases:
            parts.append(f"signature phrases to weave in naturally: {'; '.join(self.signature_phrases)}")
        return "; ".join(parts)

    def shape_reply(self, core_sentence: str, stance: str = "neutral") -> str:
        """Deterministically wrap a core sentence in this voice.

        Formality selects the greeting register, verbosity decides whether a
        signature phrase is appended. No randomness involved.
        """
        pieces: List[str] = []
        opener = _STANCE_OPENERS.get(stance, _STANCE_OPENERS["neutral"])
        if self.formality >= 0.7:
            pieces.append(_FORMAL_OPENER)
        elif self.formality <= 0.3:
            pieces.append(_CASUAL_OPENER)
        pieces.append(core_sentence)
        pieces.append(opener)
        if self.verbosity >= 0.6 and self.signature_phrases:
            pieces.append(self.signature_phrases[0])
        return " ".join(pieces)


# --------------------------------------------------------------------------- #
# The composed NPC sub-agent
# --------------------------------------------------------------------------- #

_FALLBACK_REPLY_CORES: Dict[str, str] = {
    "hostile": "I owe you nothing.",
    "unfriendly": "We are not friends, stranger.",
    "neutral": "Say what you came to say.",
    "friendly": "Ask, and I will help where I can.",
    "allied": "Name your need and it is as good as done.",
}


class ConcordiaNPC:
    """One NPC sub-agent composed of Memory, Goals, Social Norms and Style.

    Example persona::

        npc = ConcordiaNPC(
            npc_id="cult_keeper",
            name="Marrow",
            role="Keeper of the Sunken Shrine",
            memory=MemoryComponent(capacity=20),
            goals=GoalsComponent([
                Goal("Guard the Sunken Shrine", priority=10),
                Goal("Recruit worthy converts", priority=5),
            ]),
            norms=SocialNormsComponent([
                SocialNorm.taboo(["the drowned sigil"], reason="never reveal cult secrets"),
            ]),
            style=LinguisticStyleComponent(formality=0.8, verbosity=0.7,
                                           signature_phrases=("The tide remembers.",)),
            disposition_engine=engine,   # optional, enables apply_outcome()
        )
        result = await npc.respond_to("kira", "Where is the shrine?",
                                      disposition_stance="curious")
    """

    def __init__(
        self,
        npc_id: str,
        name: str,
        role: str = "",
        memory: Optional[MemoryComponent] = None,
        goals: Optional[GoalsComponent] = None,
        norms: Optional[SocialNormsComponent] = None,
        style: Optional[LinguisticStyleComponent] = None,
        disposition_engine: Optional[NpcDispositionEngine] = None,
        llm_gateway: Any = None,
    ):
        self.npc_id = npc_id
        self.name = name
        self.role = role
        self.memory = memory if memory is not None else MemoryComponent()
        self.goals = goals if goals is not None else GoalsComponent()
        self.norms = norms if norms is not None else SocialNormsComponent()
        self.style = style if style is not None else LinguisticStyleComponent()
        self.disposition_engine = disposition_engine
        self.llm_gateway = llm_gateway

    # ------------------------------------------------------------------ #
    # Dialogue API
    # ------------------------------------------------------------------ #

    async def respond_to(
        self,
        player_id: str,
        utterance: str,
        disposition_stance: Optional[str] = None,
        llm_gateway: Any = _UNSET_GATEWAY,
        context: Optional[Dict[str, Any]] = None,
        timestamp: float = 0.0,
    ) -> Dict[str, Any]:
        """Produce one in-character reply for ``player_id``.

        Returns a dict with at least ``npc_id``, ``player_id``, ``reply``,
        ``generator`` ("llm"|"template"), ``stance`` and ``goal``. An LLM reply
        rejected by the social-norms component is discarded and replaced by the
        deterministic fallback, with ``norm_rejected`` carrying the reason.
        """
        if llm_gateway is _UNSET_GATEWAY:
            llm_gateway = self.llm_gateway  # ctor-supplied gateway, may be None
        ctx = dict(context or {})
        ctx["player_id"] = player_id
        stance = disposition_stance or self._engine_stance(player_id)
        recalled = self.memory.recall(utterance, limit=3)
        goal = self.goals.current_goal(ctx)

        llm_reply: Optional[str] = None
        rejection_reason: Optional[str] = None
        if llm_gateway is not None:
            system_prompt, user_prompt = self.persona_prompts(
                player_id, utterance, stance, recalled, goal, ctx
            )
            parsed: Any = None
            try:
                parsed = await llm_gateway.complete_json(system_prompt, user_prompt)
            except Exception:  # gateway contract says it never raises; be defensive anyway
                parsed = None
            if isinstance(parsed, dict):
                candidate = parsed.get("reply")
                if isinstance(candidate, str) and candidate.strip():
                    candidate = candidate.strip()
                    rejection_reason = self.norms.violates(candidate, ctx)
                    if rejection_reason is None:
                        llm_reply = candidate

        if llm_reply is not None:
            reply, generator = llm_reply, "llm"
        else:
            reply = self.style.shape_reply(
                _FALLBACK_REPLY_CORES.get(stance, _FALLBACK_REPLY_CORES["neutral"])
                + f" My purpose remains clear: {goal.description}.",
                stance=stance,
            )
            generator = "template"

        # Episodic record of the full exchange (bounded by MemoryComponent).
        self.memory.record(player_id, utterance, when=timestamp, stance_at_time=stance)
        self.memory.record(
            self.npc_id, f"replied ({generator}): {reply}", when=timestamp, stance_at_time=stance
        )

        result: Dict[str, Any] = {
            "npc_id": self.npc_id,
            "player_id": player_id,
            "reply": reply,
            "generator": generator,
            "stance": stance,
            "goal": goal.description,
        }
        if rejection_reason is not None:
            result["norm_rejected"] = rejection_reason
        return result

    # ------------------------------------------------------------------ #
    # Prompt construction
    # ------------------------------------------------------------------ #

    def persona_prompts(
        self,
        player_id: str,
        utterance: str,
        stance: str,
        recalled: Sequence[EpisodicMemory],
        goal: Goal,
        context: Dict[str, Any],
    ) -> Tuple[str, str]:
        """Structured (system, user) persona prompts built from all components."""
        memory_lines = (
            "\n".join(
                f"- [{episode.stance_at_time}] {episode.who}: {episode.what}" for episode in recalled
            )
            or "- (nothing relevant recalled)"
        )
        system_prompt = (
            f"You role-play {self.name}"
            + (f", {self.role}," if self.role else "")
            + " an NPC in a tabletop campaign.\n"
            f"Identity: npc_id={self.npc_id}\n"
            "Memory (relevant episodes):\n"
            f"{memory_lines}\n"
            "Goals (pursue the current one):\n"
            + "\n".join(f"- {g.description}" for g in self.goals.by_priority())
            + f"\nCurrent goal: {goal.description}\n"
            "Social norms (hard constraints — violating these is forbidden):\n"
            + ("\n".join(f"- {d}" for d in self.norms.descriptions) or "- (none)\n")
            + f"\nVoice: {self.style.render()}\n"
            'Reply ONLY with JSON: {"reply": "<in-character line>"}'
        )
        user_prompt = (
            f"Player: {player_id}\n"
            f"Your current stance toward them: {stance}\n"
            f"Context: {context!r}\n"
            f'Player says: "{utterance}"'
        )
        return system_prompt, user_prompt

    # ------------------------------------------------------------------ #
    # Disposition integration
    # ------------------------------------------------------------------ #

    def apply_outcome(
        self,
        kind: str,
        player_id: str,
        magnitude: float = 1.0,
        timestamp: Optional[float] = None,
    ):
        """Record an interaction outcome on the ctor-supplied engine.

        Convenience wrapper so callers do not need to re-state the npc_id;
        deciding *which* outcome occurred stays the caller's job.
        """
        if self.disposition_engine is None:
            raise RuntimeError(
                f"NPC {self.npc_id!r} has no disposition_engine; construct ConcordiaNPC "
                "with disposition_engine=NpcDispositionEngine(...) to use apply_outcome()"
            )
        return self.disposition_engine.record_interaction(
            self.npc_id, player_id, kind, magnitude=magnitude, timestamp=timestamp
        )

    def _engine_stance(self, player_id: str) -> str:
        if self.disposition_engine is None:
            return "neutral"
        return self.disposition_engine.stance(self.npc_id, player_id)
