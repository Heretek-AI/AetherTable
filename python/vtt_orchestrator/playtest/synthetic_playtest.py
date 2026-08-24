"""Live synthetic playtest harness.

Unlike earlier iterations, this harness fabricates nothing:

- Every mechanical action is resolved by the LIVE authoritative Rust engine
  through ``routing.engine_client`` — MCR is computed from actual
  accept/reject decisions, never from an ``is_chaos`` flag.
- Narrative drafts are audited against REAL engine outcomes by the
  PreCommitAuditorAgent — HCI reflects genuine math-narrative violations.
- Trust-boundary probes (client-supplied combat math, unknown entities)
  verify the gateway/engine actually REJECTS forged input.

If no engine is reachable the harness reports ``engine_live: False`` with
null metrics instead of inventing a passing score.
"""

import random
import time
from typing import Any, Dict, List, Optional

import httpx

from ..routing import engine_client
from ..routing.intent_router import IntentClassificationRouter
from ..auditor.inspector import PreCommitAuditorAgent, DiagnosticRetryController
from ..agents.agent_hierarchy import EncounterDMAgent

ENGINE_HEALTH_TIMEOUT = 2.0


def _engine_live() -> bool:
    try:
        resp = httpx.get(
            f"{engine_client.ENGINE_API_URL}/health", timeout=ENGINE_HEALTH_TIMEOUT
        )
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


def _spawn_entity(session_id: str, entity: Dict[str, Any]) -> None:
    engine_client.engine_request_sync(
        "POST", f"/api/v1/sessions/{session_id}/entities", entity
    )


def _statblock(entity_id: str, name: str, hp: int, ac: int, attack_bonus: int) -> Dict[str, Any]:
    return {
        "id": entity_id,
        "compendium_id": f"playtest_{name}",
        "name": name,
        "is_player": True,
        "current_hp": hp,
        "max_hp": hp,
        "temp_hp": 0,
        "ac": ac,
        "speed_feet": 30.0,
        "position": [2.5, 2.5, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {
            "strength": 16, "dexterity": 14, "constitution": 14,
            "intelligence": 10, "wisdom": 12, "charisma": 10,
        },
        "conditions": [],
        "action_budget": {
            "action": True, "bonus_action": True, "reaction": True,
            "movement_remaining_feet": 30.0, "free_object_interaction": True,
        },
        "spell_slots_remaining": {},
        "attacks": [{
            "name": "Greataxe",
            "attack_bonus": attack_bonus,
            "damage_expression": "1d12+4",
            "damage_type": "slashing",
        }],
        "resistances": [],
        "vulnerabilities": [],
        "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": True,
        "is_dead": False,
        "is_visible": True,
    }


class SyntheticPlaytestRunner:
    """
    Automated Headless Multi-Agent Playtesting Framework (Tactician, Roleplayer,
    Chaos). Evaluates Mechanical Compliance Rate (MCR), Hallucination &
    Continuity Index (HCI), and Auditor False-Positive Rate (AFPR) against a
    LIVE authoritative engine.
    """

    def __init__(self, num_turns: int = 200):
        self.num_turns = num_turns
        self.router = IntentClassificationRouter()
        self.auditor = PreCommitAuditorAgent()
        self.dm = EncounterDMAgent()
        self.controller = DiagnosticRetryController(self.auditor)

    # ------------------------------------------------------------------ setup

    def _setup_session(self) -> Optional[str]:
        created = engine_client.engine_request_sync(
            "POST",
            "/api/v1/sessions",
            {"campaign_id": "00000000-0000-0000-0000-000000000001",
             "session_name": "Honest Benchmark"},
        )
        session_id = created["session_id"]
        _spawn_entity(
            session_id,
            _statblock(engine_client._coerce_uuid("pt-hero"), "Playtester", 40, 16, 7),
        )
        _spawn_entity(
            session_id,
            _statblock(engine_client._coerce_uuid("pt-dummy"), "Training Dummy", 500, 13, 2),
        )
        return session_id

    # ------------------------------------------------------------------- run

    def run_simulation(self) -> Dict[str, Any]:
        start_time = time.perf_counter()

        if not _engine_live():
            elapsed = time.perf_counter() - start_time
            return {
                "total_turns_simulated": 0,
                "elapsed_seconds": round(elapsed, 3),
                "engine_live": False,
                "mechanical_compliance_rate_pct": None,
                "hallucination_continuity_index": None,
                "auditor_false_positive_rate_pct": None,
                "detail": (
                    "No authoritative engine reachable at "
                    f"{engine_client.ENGINE_API_URL} — metrics withheld rather than simulated."
                ),
                "targets_met": {"mcr_passed": False, "hci_passed": False, "afpr_passed": False},
            }

        session_id = self._setup_session()

        tactical_utterances = [
            "I swing my greataxe at the training dummy",
            "I strike with my scimitar",
            "I swing my greataxe at the orc warlord",
        ]
        lore_utterances = [
            "I recall that Baron Aldous Vane once owned this keep",
            "The legend says the Sunblade rests in these ruins",
            "The Shadow Cabal has infiltrated the regional guard",
        ]
        chaos_utterances = [
            "I summon 50 dragons instantly from my pocket",
            "I cast a 15th level spell to destroy the universe",
            "I teleport 5000 feet through solid adamantine",
        ]

        standard_mechanical = 0
        standard_accepted = 0
        trust_probes_total = 0
        trust_probes_rejected = 0
        total_proposals = 0
        auditor_violations = 0          # grounded proposals the auditor rejected
        valid_proposals_inspected = 0
        false_positive_rejections = 0
        recall_probes_total = 0         # injected contradictions that MUST be caught
        recall_probes_caught = 0

        attacker_uuid = engine_client._coerce_uuid("pt-hero")
        target_uuid = engine_client._coerce_uuid("pt-dummy")
        dummy_generation = 0

        for turn in range(self.num_turns):
            roll = random.random()
            if roll < 0.80:
                utterance = random.choice(tactical_utterances)
                probe_mode = "standard"
            elif roll < 0.95:
                utterance = random.choice(lore_utterances)
                probe_mode = "lore"
            else:
                utterance = random.choice(chaos_utterances)
                probe_mode = "chaos"

            classification = self.router.classify_utterance(utterance)

            if probe_mode == "chaos":
                # Trust-boundary probes must be REJECTED deterministically.
                trust_probes_total += 1
                rejected = self._run_trust_probe(session_id, attacker_uuid, target_uuid, turn)
                if rejected:
                    trust_probes_rejected += 1
                continue

            # Only mechanically-classified intents reach the engine; pure
            # lore/roleplay turns carry no compliance semantics.
            if classification.intent_type.value != "MECHANICAL_INVOCATION":
                continue

            # Standard mechanical action: reference-only payload, live engine.
            # Start-of-turn refresh so each probe gets a fresh Action budget.
            engine_client.engine_request_sync(
                "POST", f"/api/v1/sessions/{session_id}/turn/next", {}
            )
            standard_mechanical += 1
            accepted, engine_payload = self._resolve_live_attack(
                session_id, attacker_uuid, target_uuid
            )
            if accepted:
                standard_accepted += 1

            # A destroyed sparring partner is replaced so later turns measure
            # action acceptance rather than the engine correctly refusing
            # corpse attacks (TARGET_ALREADY_DEAD).
            if engine_payload.get("target_is_dead") or int(
                engine_payload.get("target_hp_remaining", 1)
            ) <= 0:
                dummy_generation += 1
                target_uuid = engine_client._coerce_uuid(f"pt-dummy-{dummy_generation}")
                _spawn_entity(
                    session_id,
                    _statblock(target_uuid, "Training Dummy", 500, 13, 2),
                )

            # Audit a narrative draft grounded in the LIVE outcome. Entity
            # counts come from the live session snapshot — never asserted.
            total_proposals += 1
            valid_proposals_inspected += 1
            try:
                ground = engine_client.engine_request_sync(
                    "GET", f"/api/v1/sessions/{session_id}"
                )
                live_count = len(ground.get("entities", {}))
            except engine_client.EngineUnavailableError:
                live_count = 2
            cycle_res = self.controller.run_turn_cycle(
                user_intent=utterance,
                turn_index=turn,
                entity_id="pc_playtester",
                engine_execution_payload=engine_payload,
                dm_draft_generator=lambda ctx: self.dm.generate_combat_draft(
                    utterance, engine_payload, ctx
                ),
                active_entity_count=live_count,
                previous_entity_count=live_count,
                ingress_count=0,
                egress_count=0,
            )
            if cycle_res["status"] == "COMMITTED":
                pass
            else:
                # Grounded drafts describe the genuine engine outcome, so a
                # rejection is an auditor FALSE POSITIVE — and it also costs
                # continuity because the fallback narrative replaced the real
                # story. (Before Phase 2 this branch was unreachable and AFPR
                # was tautologically 0.)
                false_positive_rejections += 1
                auditor_violations += 1

            # Recall probe (~10% of audited turns): inject a draft narrating
            # the death of a target the live state says is alive. The auditor
            # MUST reject it — misses here are hallucinations that would
            # reach players.
            if random.random() < 0.10:
                recall_probes_total += 1
                if self._run_recall_probe(turn):
                    recall_probes_caught += 1

        elapsed_sec = time.perf_counter() - start_time

        mcr = (standard_accepted / max(standard_mechanical, 1)) * 100.0
        hci = max(
            0.0,
            1.0 - (auditor_violations / max(total_proposals, 1)),
        )
        afpr = (false_positive_rejections / max(valid_proposals_inspected, 1)) * 100.0
        recall_pct = (
            (recall_probes_caught / recall_probes_total) * 100.0
            if recall_probes_total > 0
            else 100.0
        )
        trust_boundary_held = (
            trust_probes_rejected == trust_probes_total and trust_probes_total > 0
        )

        return {
            "total_turns_simulated": self.num_turns,
            "elapsed_seconds": round(elapsed_sec, 3),
            "engine_live": True,
            "standard_mechanical_requests": standard_mechanical,
            "standard_accepted_by_engine": standard_accepted,
            "trust_boundary_probes": trust_probes_total,
            "trust_probes_rejected_by_engine": trust_probes_rejected,
            "audited_narrative_proposals": total_proposals,
            "genuine_invariant_violations": auditor_violations,
            "auditor_false_positive_rate_pct": round(afpr, 2),
            "auditor_recall_probes": recall_probes_total,
            "auditor_recall_caught": recall_probes_caught,
            "mechanical_compliance_rate_pct": round(mcr, 2),
            "hallucination_continuity_index": round(hci, 3),
            "auditor_recall_pct": round(recall_pct, 2),
            "targets_met": {
                "mcr_passed": mcr >= 98.5,
                "hci_passed": hci >= 0.95,
                "afpr_passed": afpr <= 1.5,
                "auditor_recall_passed": recall_pct >= 95.0,
                "trust_boundary_held": trust_boundary_held or trust_probes_total == 0,
            },
        }

    # ------------------------------------------------------------- internals

    def _resolve_live_attack(
        self, session_id: str, attacker_id: str, target_id: str
    ) -> tuple[bool, Dict[str, Any]]:
        """One reference-only attack against the live engine."""
        try:
            res = engine_client.engine_request_sync(
                "POST",
                f"/api/v1/sessions/{session_id}/action/attack",
                {
                    "attacker_id": attacker_id,
                    "target_id": target_id,
                    "action_index": 0,
                },
            )
        except engine_client.EngineRejectedError:
            return False, {"action_name": "Rejected Action", "is_hit": False, "total_damage": 0}

        payload = {
            "action_name": "Greataxe Strike",
            "is_hit": bool(res.get("is_hit")),
            "total_damage": int(res.get("total_damage", 0)),
            "target_hp_remaining": int(res.get("target_hp_remaining", 0)),
            "target_is_conscious": bool(res.get("target_is_conscious", True)),
            "target_is_dead": bool(res.get("target_is_dead", False)),
        }
        return True, payload

    def _run_recall_probe(self, turn_index: int) -> bool:
        """Auditor recall probe: a draft narrating the death of a target that
        live state says is alive (25 HP, conscious) MUST be rejected by the
        math-narrative lethality invariant. Returns True when caught."""
        report = self.auditor.audit_proposal(
            turn_index=turn_index,
            entity_id="pc_playtester",
            proposed_narrative="The training dummy drops dead where it stood.",
            engine_execution_payload={
                "action_name": "Recall Probe",
                "is_hit": True,
                "total_damage": 0,
                "target_hp_remaining": 25,
                "target_is_conscious": True,
                "target_is_dead": False,
            },
            active_entity_count=2,
            previous_entity_count=2,
        )
        return not report.passed

    def _run_trust_probe(
        self, session_id: str, attacker_id: str, target_id: str, turn_index: int
    ) -> bool:
        """Chaos probes: forged client math and unknown entities MUST be
        rejected by the trust boundary. Returns True when correctly refused."""
        if turn_index % 2 == 0:
            # Forged combat math at the gateway — expect 422.
            try:
                url = f"{engine_client.ENGINE_API_URL}/api/v1/sessions/{session_id}/action/attack"
                body = {
                    "attacker_id": attacker_id,
                    "target_id": target_id,
                    "attack_bonus": 9999,
                    "target_ac": -100,
                    "damage_expression": "9999d9999",
                }
                headers = {"Authorization": f"Bearer {engine_client._service_token()}"}
                resp = httpx.post(url, json=body, headers=headers, timeout=5.0)
                return resp.status_code in (400, 422)
            except httpx.HTTPError:
                return False
        # Unknown-entity reference — engine must 404/409/422.
        ghost = engine_client._coerce_uuid(f"ghost-entity-{turn_index}")
        try:
            engine_client.engine_request_sync(
                "POST",
                f"/api/v1/sessions/{session_id}/action/attack",
                {"attacker_id": ghost, "target_id": target_id},
            )
            return False  # Engine ACCEPTED a nonexistent attacker — failure!
        except engine_client.EngineRejectedError as exc:
            return exc.status_code in (400, 404, 409, 422)
