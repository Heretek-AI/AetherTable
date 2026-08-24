import re
import time
from typing import Dict, Any, List, Optional, Tuple
from ..schemas.models import (
    AuditorDiagnosticReport,
    ValidationFailure,
    InvariantViolationType,
    FailureSeverity,
    EncounterDMContextUpdate,
)
from ..lore.epistemic_graph import EpistemicLoreGraphManager

# Natural-language predicates mapped to canon-graph relations. Used to derive
# (subject, predicate, object) triples from the narrative itself so lore
# continuity is checked even when no tool supplies them explicitly.
_PREDICATE_PATTERNS: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"\b(?:possess\w*|wield\w*|carri\w*|hold\w*|own\w*)\b", re.IGNORECASE), "POSSESSES"),
    (re.compile(r"\b(?:rules?|ruled|reign\w*|govern\w*)\b", re.IGNORECASE), "RULES"),
    (re.compile(r"\b(?:attacks?|strikes?|slay\w*|fight\w*|murder\w*)\b", re.IGNORECASE), "ATTACKS"),
    (re.compile(r"\bspeaks? with\b|\btalks? to\b|\bconverses? with\b", re.IGNORECASE), "SPEAKS_WITH"),
    (re.compile(r"\bis alive\b|\bstill lives\b|\bwalks the earth\b", re.IGNORECASE), "IS_ALIVE"),
    (re.compile(r"\bis intact\b|\bstill stands\b", re.IGNORECASE), "IS_INTACT"),
    (re.compile(r"\bhouses? (?:a )?garrison\b", re.IGNORECASE), "HOUSES_GARRISON"),
]

# How far on either side of a predicate verb a known entity name may appear.
_LORE_WINDOW_CHARS = 60


def _extract_lore_triples(
    proposed_narrative: str,
    lore_graph: EpistemicLoreGraphManager,
    engine_execution_payload: Dict[str, Any],
) -> List[Tuple[str, str, str]]:
    """Derives candidate (subject, predicate, object) triples from a draft.

    Known canon node names are matched positionally against the narrative;
    each predicate verb pairs its nearest preceding and following known
    entities. Explicitly payload-supplied triples still take precedence.
    """
    explicit = (
        engine_execution_payload.get("lore_subject_id"),
        engine_execution_payload.get("lore_predicate"),
        engine_execution_payload.get("lore_object_id"),
    )
    if all(explicit):
        return [(explicit[0], explicit[1], explicit[2])]

    lowered = proposed_narrative.lower()
    mentions: List[Tuple[int, int, str]] = []  # (start, end, node_id)
    for node in lore_graph.nodes.values():
        name = node.get("name")
        if not name:
            continue
        start = 0
        while True:
            idx = lowered.find(name.lower(), start)
            if idx < 0:
                break
            mentions.append((idx, idx + len(name), node["id"]))
            start = idx + len(name)

    triples: List[Tuple[str, str, str]] = []
    # Relations that can be asserted about one entity alone ("Oakhaven Keep
    # still stands") pair the subject with itself.
    _REFLEXIVE = {"IS_ALIVE", "IS_INTACT"}
    for pattern, relation in _PREDICATE_PATTERNS:
        for match in pattern.finditer(proposed_narrative):
            before = [m for m in mentions if m[1] <= match.start()]
            after = [m for m in mentions if m[0] >= match.end()]
            if not before or (not after and relation not in _REFLEXIVE):
                continue
            subj = max(before, key=lambda m: m[1])
            obj = min(after, key=lambda m: m[0]) if after else subj
            if match.start() - subj[1] > _LORE_WINDOW_CHARS:
                continue
            if after and obj[0] - match.end() > _LORE_WINDOW_CHARS:
                continue
            if subj[2] == obj[2] and relation not in _REFLEXIVE:
                continue
            triples.append((subj[2], relation, obj[2]))
    return triples


class PreCommitAuditorAgent:
    """
    Authoritative Invariant Interceptor ("World Inspector").
    Enforces 5 Invariant Vectors before any state commit or client broadcast.
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
        ingress_verified_count: int = 0,
        egress_verified_count: int = 0,
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
            lethality_patterns = [r"\bdead\b", r"\bdecapitat\w*", r"\bslain\b", r"\blifeless\b", r"\bkill\w*", r"\bcorpse\b"]
            for pat in lethality_patterns:
                match = re.search(pat, proposed_narrative, re.IGNORECASE)
                if match:
                    term = match.group(0)
                    failures.append(ValidationFailure(
                        violation_type=InvariantViolationType.MATH_NARRATIVE_CONTRADICTION,
                        severity=FailureSeverity.FATAL_REJECT,
                        failed_component="hp_lethality_match",
                        offending_narrative_excerpt=term,
                        diagnostic_message=f"Target survived with {target_hp} HP remaining, but narrative described lethal trauma ('{term}').",
                        corrective_constraint=f"Target is conscious with {target_hp} HP. Rewrite narrative to depict a glancing or non-lethal blow."
                    ))
                    break

        # Vector 4: Lore & Temporal Continuity — triples are derived from the
        # narrative itself (known canon entities + predicate verbs), with
        # payload-supplied triples still honored as an override.
        for subject_id, predicate, object_id in _extract_lore_triples(
            proposed_narrative, self.lore_graph, engine_execution_payload
        ):
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
                break

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
        movement_path_distance_feet: Optional[float] = None,
        entity_speed_budget_feet: Optional[float] = None,
    ) -> Dict[str, Any]:
        retry_count = 0
        context_update: Optional[EncounterDMContextUpdate] = None
        audit_history: List[AuditorDiagnosticReport] = []

        while retry_count <= self.max_retries:
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
                movement_path_distance_feet=movement_path_distance_feet,
                entity_speed_budget_feet=entity_speed_budget_feet,
            )
            audit_history.append(report)

            if report.passed:
                return {
                    "status": "COMMITTED",
                    "final_narrative": draft,
                    "retry_count": retry_count,
                    "audit_report": report,
                    "audit_history": audit_history,
                }

            # Retry Pass
            retry_count += 1
            if retry_count <= self.max_retries:
                context_update = EncounterDMContextUpdate(
                    original_user_intent=user_intent,
                    rejected_draft=draft,
                    auditor_report=report,
                    retry_count=retry_count,
                )

        # Fallback to Deterministic Raw Description
        action_name = engine_execution_payload.get("action_name", "Action")
        dmg = engine_execution_payload.get("total_damage", 0)
        target_hp = engine_execution_payload.get("target_hp_remaining", 0)
        is_hit = engine_execution_payload.get("is_hit", True)

        if is_hit:
            fallback_text = f"The {action_name} hits with mechanical precision, dealing {dmg} damage. Target remaining HP: {target_hp}."
        else:
            fallback_text = f"The {action_name} misses the target entirely."

        return {
            "status": "FALLBACK_COMMITTED",
            "final_narrative": fallback_text,
            "retry_count": retry_count,
            "audit_history": audit_history,
            "fallback_applied": True,
        }
