from typing import Dict, Any, List, Optional
from ..schemas.models import EncounterDMContextUpdate


class DirectorAgent:
    """
    Macro-level narrative pacing and dramatic tension manager.
    """

    def __init__(self):
        self.tension_level: float = 0.5  # 0.0 to 1.0
        self.pacing_history: List[float] = []

    def calculate_party_threat_ratio(self, total_monster_cr: float, total_party_hp: float) -> float:
        if total_party_hp <= 0:
            return 1.0
        return min(total_monster_cr / (total_party_hp / 10.0), 1.0)

    def update_tension(self, threat_ratio: float, round_number: int) -> float:
        base = 0.3 + (threat_ratio * 0.5) + (min(round_number, 5) * 0.04)
        self.tension_level = min(max(base, 0.1), 1.0)
        self.pacing_history.append(self.tension_level)
        return self.tension_level

    def suggest_spotlight_rebalance(self, sidelined_player_name: str) -> str:
        return f"DIRECTOR HOOK: Introduce an environmental cue or sudden enemy focus aimed directly at {sidelined_player_name} to restore conversational agency."


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
