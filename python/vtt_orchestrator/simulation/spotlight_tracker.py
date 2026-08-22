from typing import Dict, List


class VoiceSpotlightTracker:
    """
    Tracks real-time conversational agency and speaking time across players.
    """

    def __init__(self, player_ids: List[str]):
        self.speaking_durations_sec: Dict[str, float] = {pid: 0.0 for pid in player_ids}
        self.turn_counts: Dict[str, int] = {pid: 0 for pid in player_ids}

    def record_utterance(self, player_id: str, duration_sec: float):
        if player_id in self.speaking_durations_sec:
            self.speaking_durations_sec[player_id] += duration_sec
            self.turn_counts[player_id] += 1

    def calculate_agency_weights(self) -> Dict[str, float]:
        total_time = sum(self.speaking_durations_sec.values())
        if total_time <= 0:
            count = len(self.speaking_durations_sec)
            return {pid: 1.0 / count for pid in self.speaking_durations_sec}

        return {pid: duration / total_time for pid, duration in self.speaking_durations_sec.items()}

    def get_sidelined_players(self, threshold_ratio: float = 0.15) -> List[str]:
        weights = self.calculate_agency_weights()
        return [pid for pid, weight in weights.items() if weight < threshold_ratio]
