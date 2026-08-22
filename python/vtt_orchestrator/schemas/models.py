from enum import Enum
from typing import List, Optional, Dict, Any, Tuple
from pydantic import BaseModel, Field


class InvariantViolationType(str, Enum):
    SPATIAL_INVARIANCE = "SPATIAL_INVARIANCE"
    ENTITY_CONSERVATION = "ENTITY_CONSERVATION"
    LORE_CONTINUITY = "LORE_CONTINUITY"
    MECHANICAL_FEASIBILITY = "MECHANICAL_FEASIBILITY"
    MATH_NARRATIVE_CONTRADICTION = "MATH_NARRATIVE_CONTRADICTION"


class FailureSeverity(str, Enum):
    WARNING = "WARNING"
    FATAL_REJECT = "FATAL_REJECT"


class EpistemicTier(str, Enum):
    SUBJECTIVE_RUMOR = "SUBJECTIVE_RUMOR"  # weight < 0.4
    PROPOSED_FACT = "PROPOSED_FACT"        # weight = 0.7
    VALIDATED_CANON = "VALIDATED_CANON"    # weight = 1.0


class IntentType(str, Enum):
    MECHANICAL_INVOCATION = "MECHANICAL_INVOCATION"
    LORE_ASSERTION = "LORE_ASSERTION"
    IN_CHARACTER_DIALOGUE = "IN_CHARACTER_DIALOGUE"
    OUT_OF_CHARACTER = "OUT_OF_CHARACTER"
    SAFETY_INTERVENTION = "SAFETY_INTERVENTION"


class IntentClassificationResult(BaseModel):
    intent_type: IntentType
    confidence: float = Field(..., ge=0.0, le=1.0)
    raw_utterance: str
    extracted_parameters: Dict[str, Any] = Field(default_factory=dict)
    speaker_id: str
    latency_ms: float


class ValidationFailure(BaseModel):
    violation_type: InvariantViolationType
    severity: FailureSeverity
    failed_component: str = Field(..., description="Target property, e.g. 'movement_path', 'hp_delta', 'entity_count'")
    offending_narrative_excerpt: Optional[str] = Field(None, description="Exact draft text causing failure")
    diagnostic_message: str = Field(..., description="Deterministic reason for rejection")
    corrective_constraint: str = Field(..., description="Explicit context bound for re-inference")


class AuditorDiagnosticReport(BaseModel):
    passed: bool
    turn_index: int
    entity_id: str
    failures: List[ValidationFailure] = Field(default_factory=list)
    suggested_state_patch: Optional[Dict[str, Any]] = None
    audit_duration_ms: float = 0.0


class EncounterDMContextUpdate(BaseModel):
    original_user_intent: str
    rejected_draft: str
    auditor_report: AuditorDiagnosticReport
    retry_count: int = 1
    system_reprompt_instruction: str = (
        "Your previous output violated world invariants. Re-evaluate your turn logic using "
        "the provided corrective_constraints. Do NOT repeat the offending draft."
    )


class CastSpellPayload(BaseModel):
    spell_id: str
    caster_id: str
    target_ids: List[str] = Field(default_factory=list)
    target_coordinates: Optional[Tuple[float, float, float]] = None
    cast_level: int = 1
    spent_slot: bool = True


class AttackActionPayload(BaseModel):
    attacker_id: str
    target_id: str
    action_name: str
    advantage: bool = False
    disadvantage: bool = False


class MoveActionPayload(BaseModel):
    entity_id: str
    start_pos: Tuple[float, float, float]
    target_pos: Tuple[float, float, float]
    speed_budget: float


class LoreAssertionPayload(BaseModel):
    proposing_entity_id: str
    subject_node_id: str
    predicate_relation: str
    object_node_id: str
    confidence_score: float = 0.7
    epistemic_tier: EpistemicTier = EpistemicTier.PROPOSED_FACT
    context_sentence: str
