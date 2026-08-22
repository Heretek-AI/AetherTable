from typing import Dict, Any, List


class FactionAction:
    def __init__(self, name: str, cost: float, preconditions: Dict[str, Any], effects: Dict[str, Any]):
        self.name = name
        self.cost = cost
        self.preconditions = preconditions
        self.effects = effects


class FactionGoal:
    def __init__(self, name: str, priority: float, desired_world_state: Dict[str, Any]):
        self.name = name
        self.priority = priority
        self.desired_world_state = desired_world_state


class FactionSimulationGOAP:
    """
    Goal-Oriented Action Planning (GOAP) and Utility AI for off-screen faction simulation.
    """

    def __init__(self, faction_name: str, resources: int = 100):
        self.faction_name = faction_name
        self.resources = resources
        self.world_state: Dict[str, Any] = {
            "has_relic": False,
            "influence_level": 20,
            "scouted_keep": False,
            "mobilized_army": False,
        }
        self.available_actions: List[FactionAction] = [
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
        ]

    def advance_simulation_tick(self) -> List[str]:
        """Runs a simulation tick during player downtime."""
        executed = []
        for action in self.available_actions:
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
