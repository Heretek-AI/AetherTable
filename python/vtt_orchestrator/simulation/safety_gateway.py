from typing import Dict, Any, List


class SafetyGateway:
    """
    Zero-delay Hardware Safety Tools (X-Card, Lines & Veils) with instant state rewinds.
    """

    def __init__(self):
        self.lines_and_veils: List[str] = ["explicit_torture", "arachnophobia"]
        self.safety_triggers: List[Dict[str, Any]] = []

    def trigger_x_card(self, player_id: str, topic: str, current_sequence_id: int) -> Dict[str, Any]:
        target_seq = max(1, current_sequence_id - 1)
        record = {
            "player_id": player_id,
            "topic": topic,
            "trigger": "X_CARD",
            "rewind_to_sequence": target_seq,
        }
        self.safety_triggers.append(record)
        return {
            "status": "SAFETY_INTERVENTION_ACTIVATED",
            "action": "REWIND_STATE",
            "target_sequence_id": target_seq,
            "message": f"Safety card invoked on '{topic}'. Rewinding scene state immediately.",
        }
