import time
import re
from typing import Dict, Any, List, Optional
from ..schemas.models import (
    InvariantViolationType,
    FailureSeverity,
    ValidationFailure,
    AuditorDiagnosticReport,
    EncounterDMContextUpdate,
)
from ..lore.epistemic_graph import EpistemicLoreGraphManager


class PreCommitAuditorAgent:
    """
    Second-Tier Pre-Commit Invariant Interceptor / World Inspector (<200ms SLA).
    """

    def __init__(self, lore_graph: Optional[EpistemicLoreGraphManager] = None):
        self.lore_graph = lore_graph or EpistemicLoreGraphManager()

    def audit_proposal(
        self,
        turn_index: int,
        entity_id: str,
        proposed_narrative: str,
        engine_execution_payload: Dict[str, Any],
        active_entity_count: int,
        previous_entity_count: int,
        ingress_verified_count: int,
        egress_verified_count: int,
        movement_path_distance_feet: Optional[float] = None,
        entity_speed_budget_feet: Optional[float] = None,
    ) -> AuditorDiagnosticReport:
        start_time = time.perf_counter()
        failures: List[ValidationFailure] = []

        # Vector 1: Spatial Invariance (Movement Budget & Collision)
        if movement_path_distance_feet is not None and entity_speed_budget_feet is not None:
            if movement_path_distance_feet > entity_speed_budget_feet:
                failures.append(ValidationFailure(
                    violation_type=InvariantViolationType.SPATIAL_INVARIANCE,
                    severity=FailureSeverity.FATAL_REJECT,
                    failed_component="movement_path",
                    offending_narrative_excerpt=None,
                    diagnostic_message=f"Movement distance {movement_path_distance_feet:.1f} ft exceeds available speed budget {entity_speed_budget_feet:.1f} ft.",
                    corrective_constraint=f"Limit movement path to <= {entity_speed_budget_feet:.1f} ft."
                ))

        # Vector 2: Entity Conservation Law
        expected_count = previous_entity_count + ingress_verified_count - egress_verified_count
        if active_entity_count != expected_count:
            delta = active_entity_count - expected_count
            failures.append(ValidationFailure(
                violation_type=InvariantViolationType.ENTITY_CONSERVATION,
                severity=FailureSeverity.FATAL_REJECT,
                failed_component="entity_count",
                offending_narrative_excerpt=None,
                diagnostic_message=f"Entity Conservation Violation: Delta of {delta} unmapped tokens detected without verified ingress/egress.",
                corrective_constraint="Do not spawn or despawn tokens without an explicit ingress tool protocol (Teleport, Door, Stealth Reveal)."
            ))

        # Vector 3: Math-Narrative Lethality Contradiction
        target_hp = engine_execution_payload.get("target_hp_remaining", None)
        target_dead = engine_execution_payload.get("target_is_dead", False)
        target_conscious = engine_execution_payload.get("target_is_conscious", True)

        if target_hp is not None and target_hp > 0 and target_conscious and not target_dead:
            lethality_terms = ["dead", "decapitated", "slain", "lifeless", "killed instantly", "severed head", "corpse"]
            for term in lethality_terms:
                if re.search(r"\b" + re.escape(term) + r"\b", proposed_narrative, re.IGNORECASE):
                    failures.append(ValidationFailure(
                        violation_type=InvariantViolationType.MATH_NARRATIVE_CONTRADICTION,
                        severity=FailureSeverity.FATAL_REJECT,
                        failed_component="hp_lethality_match",
                        offending_narrative_excerpt=term,
                        diagnostic_message=f"Target survived with {target_hp} HP remaining, but narrative described lethal trauma ('{term}').",
                        corrective_constraint=f"Target is conscious with {target_hp} HP. Rewrite narrative to depict a glancing or non-lethal blow."
                    ))
                    break

        # Vector 4: Lore & Temporal Continuity
        subject_id = engine_execution_payload.get("lore_subject_id")
        predicate = engine_execution_payload.get("lore_predicate")
        object_id = engine_execution_payload.get("lore_object_id")

        if subject_id and predicate and object_id:
            passed, reason, _ = self.lore_graph.query_paradox(subject_id, predicate, object_id)
            if not passed:
                failures.append(ValidationFailure(
                    violation_type=InvariantViolationType.LORE_CONTINUITY,
                    severity=FailureSeverity.FATAL_REJECT,
                    failed_component="lore_graph",
                    offending_narrative_excerpt=proposed_narrative[:60],
                    diagnostic_message=reason,
                    corrective_constraint="Revise lore assertions to avoid contradicting existing canonical timeline."
                ))

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0

        return AuditorDiagnosticReport(
            passed=len(failures) == 0,
            turn_index=turn_index,
            entity_id=entity_id,
            failures=failures,
            suggested_state_patch=None,
            audit_duration_ms=elapsed_ms,
        )


class DiagnosticRetryController:
    """
    Cyclic LangGraph Diagnostic Control Loop (max 2 retry passes).
    """

    def __init__(self, auditor: PreCommitAuditorAgent, max_retries: int = 2):
        self.auditor = auditor
        self.max_retries = max_retries

    def run_turn_cycle(
        self,
        user_intent: str,
        turn_index: int,
        entity_id: str,
        engine_execution_payload: Dict[str, Any],
        dm_draft_generator,  # Callable[[Optional[EncounterDMContextUpdate]], str]
        active_entity_count: int,
        previous_entity_count: int,
        ingress_count: int,
        egress_count: int,
    ) -> Dict[str, Any]:
        context_update = None

        for retry in range(self.max_retries + 1):
            draft = dm_draft_generator(context_update)
            report = self.auditor.audit_proposal(
                turn_index=turn_index,
                entity_id=entity_id,
                proposed_narrative=draft,
                engine_execution_payload=engine_execution_payload,
                active_entity_count=active_entity_count,
                previous_entity_count=previous_entity_count,
                ingress_verified_count=ingress_count,
                egress_verified_count=egress_count,
            )

            if report.passed:
                return {
                    "status": "COMMITTED",
                    "final_narrative": draft,
                    "retry_count": retry,
                    "auditor_report": report,
                    "fallback_used": False,
                }

            if retry < self.max_retries:
                context_update = EncounterDMContextUpdate(
                    original_user_intent=user_intent,
                    rejected_draft=draft,
                    auditor_report=report,
                    retry_count=retry + 1,
                )

        # Retries exhausted -> Fallback to Raw Deterministic Template
        fallback_text = (
            f"Action resolved: {engine_execution_payload.get('action_name', 'Action')} "
            f"dealt {engine_execution_payload.get('total_damage', 0)} damage. "
            f"Target HP remaining: {engine_execution_payload.get('target_hp_remaining', 'N/A')}."
        )

        return {
            "status": "FALLBACK_COMMITTED",
            "final_narrative": fallback_text,
            "retry_count": self.max_retries,
            "auditor_report": report,
            "fallback_used": True,
        }
