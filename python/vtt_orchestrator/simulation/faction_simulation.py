"""Off-screen faction simulation with genuine Goal-Oriented Action Planning.

Backlog 4.12: the simulator was a greedy first-fit walk over a fixed action
list despite its GOAP name. Actions are now STRIPS-style operators
(preconditions + effects + cost) and a forward uniform-cost search (A* with a
zero heuristic, i.e. Dijkstra by action cost) finds an ordered plan from the
current world state to a goal state.

Backward compatibility: ``FactionSimulationGOAP.advance_simulation_tick`` with
no goal set still runs the original legacy heuristic over the original three
actions, producing byte-identical log lines and resource accounting. Existing
callers (``server.py`` reads ``faction_sim.faction_name``, ``.resources``,
``.world_state`` and calls ``advance_simulation_tick``) are unaffected unless a
goal is explicitly installed via :meth:`set_goal`.
"""

import heapq
import itertools
from typing import Any, Dict, Iterable, List, Optional

__all__ = [
    "EffectDelta",
    "delta",
    "FactionAction",
    "FactionGoal",
    "FactionSimulationGOAP",
]


class EffectDelta:
    """Marker wrapper meaning "add this amount" instead of "set this value".

    Numeric world facts are modelled STRIPS-style: effects are deltas applied
    to the current fact value. Legacy actions keep bare (absolute) values so
    their historical behaviour is untouched.
    """

    __slots__ = ("amount",)

    def __init__(self, amount: float):
        self.amount = amount

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"EffectDelta({self.amount:+g})"

    def __eq__(self, other: Any) -> bool:
        return isinstance(other, EffectDelta) and other.amount == self.amount


def delta(amount: float) -> EffectDelta:
    """Shorthand factory for :class:`EffectDelta`."""
    return EffectDelta(amount)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


class FactionAction:
    """A STRIPS-style operator: preconditions, effects, cost, and risk.

    ``preconditions`` map fact -> threshold. Numeric thresholds are satisfied
    when the current fact value ``>=`` threshold; boolean thresholds require
    equality (this matches the legacy checker's semantics).

    ``effects`` map fact -> new value, where wrapping the value in
    :func:`delta` marks it as an additive delta instead of an absolute set.

    ``risk`` scales the action's planning cost (``cost * (1 + risk)``) so the
    planner prefers safer routes at equal price, without changing how much is
    deducted when the action executes.
    """

    def __init__(
        self,
        name: str,
        cost: float,
        preconditions: Dict[str, Any],
        effects: Dict[str, Any],
        risk: float = 0.0,
    ):
        self.name = name
        self.cost = cost
        self.preconditions = preconditions
        self.effects = effects
        self.risk = risk

    @property
    def effective_cost(self) -> float:
        """Cost used by the planner; risk makes risky actions less attractive."""
        return self.cost * (1.0 + self.risk)

    def preconditions_met(self, state: Dict[str, Any]) -> bool:
        for key, required in self.preconditions.items():
            current = state.get(key)
            if _is_number(required):
                if current is None or not _is_number(current) or current < required:
                    return False
            elif current != required:
                return False
        return True

    def apply(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """Return a new state dict with this action's effects applied."""
        nxt = dict(state)
        for key, value in self.effects.items():
            if isinstance(value, EffectDelta):
                base = nxt.get(key, 0)
                if not _is_number(base):  # pragma: no cover - guarded by schema
                    base = 0
                nxt[key] = base + value.amount
            else:
                nxt[key] = value
        return nxt

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"FactionAction(name={self.name!r}, cost={self.cost}, "
            f"pre={self.preconditions!r}, effects={self.effects!r}, "
            f"risk={self.risk})"
        )


class FactionGoal:
    """A desired world state: fact -> threshold (numeric ``>=`` / bool equality)."""

    def __init__(self, name: str, priority: float, desired_world_state: Dict[str, Any]):
        self.name = name
        self.priority = priority
        self.desired_world_state = desired_world_state

    def satisfied_by(self, state: Dict[str, Any]) -> bool:
        for key, target in self.desired_world_state.items():
            current = state.get(key)
            if _is_number(target):
                if current is None or not _is_number(current) or current < target:
                    return False
            elif current != target:
                return False
        return True


# Default planning bounds. Plans in practice are 1-5 steps; these caps keep the
# forward search terminating even on unreachable goals (resource-generating
# loops such as EspionageRaid could otherwise expand forever).
MAX_PLAN_LENGTH = 12
MAX_EXPANSIONS = 50_000


class FactionSimulationGOAP:
    """
    Goal-Oriented Action Planning (GOAP) and Utility AI for off-screen faction simulation.

    World state is a plain dict of numeric/boolean facts. Planning runs a
    deterministic uniform-cost forward search (ties broken by action
    declaration order, then insertion sequence) from the current state toward a
    :class:`FactionGoal`, returning the cheapest executable action sequence or
    ``None`` when the goal is unreachable.
    """

    def __init__(
        self,
        faction_name: str,
        resources: int = 100,
        initial_world_state: Optional[Dict[str, Any]] = None,
    ):
        self.faction_name = faction_name
        self.resources = resources
        self.world_state: Dict[str, Any] = {
            # Legacy facts (preserved verbatim for backward compatibility).
            "has_relic": False,
            "influence_level": 20,
            "scouted_keep": False,
            "mobilized_army": False,
            # Numeric faction facts consumed by the GOAP action set.
            "military": 0,
            "defense": 0,
            "influence": 20,
            "reputation": 5,
            "intel": False,
            "trade_route": False,
        }
        if initial_world_state:
            self.world_state.update(initial_world_state)

        self.available_actions: List[FactionAction] = [
            # --- Legacy actions (absolute effects; drive the legacy tick). ---
            FactionAction(
                name="Scout Keep",
                cost=15,
                preconditions={},
                effects={"scouted_keep": True, "influence_level": 25},
            ),
            FactionAction(
                name="Infiltrate Sanctum",
                cost=40,
                preconditions={"scouted_keep": True},
                effects={"has_relic": True, "influence_level": 50},
            ),
            FactionAction(
                name="Mobilize Faction Guard",
                cost=50,
                preconditions={"influence_level": 50},
                effects={"mobilized_army": True},
            ),
            # --- Themed GOAP actions (delta effects). ---
            FactionAction(
                name="GatherIntel",
                cost=5,
                preconditions={"resources": 5},
                effects={"intel": True},
            ),
            FactionAction(
                # One-shot: opens a (boolean) trade route rather than being
                # endlessly repeatable, so resource goals stay bounded.
                name="TradeCaravan",
                cost=4,
                preconditions={"resources": 4, "military": 1, "trade_route": False},
                effects={"trade_route": True, "resources": delta(8)},
            ),
            FactionAction(
                name="RecruitForces",
                cost=10,
                preconditions={"resources": 10},
                effects={"military": delta(3)},
            ),
            FactionAction(
                name="FortifyHoldings",
                cost=12,
                preconditions={"military": 2},
                effects={"defense": delta(4)},
            ),
            FactionAction(
                name="HostFestival",
                cost=15,
                preconditions={"resources": 15},
                effects={"reputation": delta(2)},
            ),
            FactionAction(
                name="ForgeAlliance",
                cost=8,
                preconditions={"reputation": 5},
                effects={"influence": delta(3)},
            ),
            FactionAction(
                name="EspionageRaid",
                cost=5,
                preconditions={"military": 3, "intel": True},
                effects={"resources": delta(8)},
                risk=0.3,
            ),
        ]
        # The legacy heuristic tick only ever considered the original three
        # actions; preserve that exactly so existing callers see identical
        # behaviour when no goal is installed.
        self._legacy_actions: List[FactionAction] = list(self.available_actions[:3])
        self.goal: Optional[FactionGoal] = None

    # ------------------------------------------------------------------
    # Planning
    # ------------------------------------------------------------------

    def set_goal(self, goal: Optional[FactionGoal]) -> None:
        """Install (or clear, with ``None``) the faction's active goal."""
        self.goal = goal

    def clear_goal(self) -> None:
        """Remove the active goal, restoring legacy heuristic behaviour."""
        self.goal = None

    def goal_progress_pending(self) -> bool:
        """True while a goal is installed and not yet satisfied."""
        return self.goal is not None and not self.goal.satisfied_by(self._planning_state())

    def plan(
        self,
        goal: Optional[FactionGoal] = None,
        max_plan_length: int = MAX_PLAN_LENGTH,
        max_expansions: int = MAX_EXPANSIONS,
    ) -> Optional[List[FactionAction]]:
        """Plan the cheapest action sequence reaching ``goal``.

        Forward uniform-cost search (A* with zero heuristic) over the world
        state graph. Deterministic: sibling actions are expanded in declaration
        order and heap ties break on (cost, plan length, insertion sequence).
        Returns ``[]`` if the goal is already satisfied, ``None`` if it is
        unreachable (within the search bounds).
        """
        goal = goal if goal is not None else self.goal
        if goal is None:
            return None

        start = self._planning_state()
        if goal.satisfied_by(start):
            return []

        sequence = itertools.count()
        # Heap entries: (cost_so_far, plan_length, tiebreak, state, plan indices)
        open_heap: List[Any] = [(0.0, 0, next(sequence), start, [])]
        best_cost: Dict[Any, float] = {self._signature(start): 0.0}
        expansions = 0

        while open_heap and expansions < max_expansions:
            cost, length, _, state, plan_indices = heapq.heappop(open_heap)
            signature = self._signature(state)
            if cost > best_cost.get(signature, float("inf")) + 1e-9:
                continue  # stale entry
            if goal.satisfied_by(state):
                return [self.available_actions[i] for i in plan_indices]
            if length >= max_plan_length:
                continue
            expansions += 1
            for index, action in enumerate(self.available_actions):
                if not self._applicable(state, action):
                    continue
                successor = action.apply(state)
                # Spending is part of the world state too: paying an action's
                # cost must deplete the liquid-resources fact so downstream
                # affordability checks match real execution.
                successor["resources"] = successor.get("resources", 0) - action.cost
                successor_cost = cost + action.effective_cost
                successor_signature = self._signature(successor)
                known = best_cost.get(successor_signature)
                if known is None or successor_cost < known - 1e-9:
                    best_cost[successor_signature] = successor_cost
                    heapq.heappush(
                        open_heap,
                        (
                            successor_cost,
                            length + 1,
                            next(sequence),
                            successor,
                            plan_indices + [index],
                        ),
                    )
        return None

    def execute_plan(self, plan: Iterable[FactionAction], goal: Optional[FactionGoal] = None) -> bool:
        """Apply an ordered plan to live simulation state.

        Returns True when the resulting world state satisfies ``goal``
        (defaulting to the active goal).
        """
        goal = goal if goal is not None else self.goal
        for action in plan:
            if not self._applicable(self._planning_state(), action):
                return False
            self._commit(action)
        return goal.satisfied_by(self._planning_state()) if goal is not None else True

    # ------------------------------------------------------------------
    # Ticking
    # ------------------------------------------------------------------

    def advance_simulation_tick(self) -> List[str]:
        """Runs a simulation tick during player downtime.

        With an active goal, replans and executes the first step of the plan.
        Without one, falls back to the legacy greedy first-fit heuristic so
        existing callers observe unchanged behaviour.
        """
        if self.goal is None:
            return self._legacy_tick()

        plan = self.plan()
        if not plan:
            return []
        action = plan[0]
        self._commit(action)
        return [f"{self.faction_name} executed: {action.name}"]

    def _legacy_tick(self) -> List[str]:
        """Original greedy first-fit behaviour over the legacy action list."""
        executed = []
        for action in self._legacy_actions:
            # Check preconditions
            can_execute = True
            for k, v in action.preconditions.items():
                if self.world_state.get(k) != v and self.world_state.get(k, 0) < v:
                    can_execute = False
                    break

            if can_execute and self.resources >= action.cost:
                # Check if effect is already satisfied
                needs_execution = any(self.world_state.get(k) != v for k, v in action.effects.items())
                if needs_execution:
                    self.resources -= int(action.cost)
                    self.world_state.update(action.effects)
                    executed.append(f"{self.faction_name} executed: {action.name}")
                    break

        return executed

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _planning_state(self) -> Dict[str, Any]:
        """World state snapshot used for planning (includes liquid resources)."""
        state = dict(self.world_state)
        state["resources"] = self.resources
        return state

    @staticmethod
    def _applicable(state: Dict[str, Any], action: FactionAction) -> bool:
        return action.preconditions_met(state) and state.get("resources", 0) >= action.cost

    def _commit(self, action: FactionAction) -> None:
        """Execute an action against live simulation state."""
        self.resources -= int(action.cost)
        for key, value in action.effects.items():
            if isinstance(value, EffectDelta):
                if key == "resources":
                    # Liquid resources live on the simulation, not in
                    # ``world_state``; route wallet deltas there.
                    self.resources = int(self.resources + value.amount)
                    continue
                base = self.world_state.get(key, 0)
                if not _is_number(base):
                    base = 0
                self.world_state[key] = base + value.amount
            else:
                self.world_state[key] = value

    @staticmethod
    def _signature(state: Dict[str, Any]) -> Any:
        """Hashable, order-independent state key for visited/dominance checks."""
        return tuple(sorted((k, v) for k, v in state.items()))
