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
    retry_count: int
    constraints: List[str] = Field(default_factory=list)
    mandatory_tokens: List[str] = Field(default_factory=list)
    forbidden_tokens: List[str] = Field(default_factory=list)
    mechanical_facts: Dict[str, Any] = Field(default_factory=dict)


class LoreAssertionPayload(BaseModel):
    proposing_entity_id: str
    subject_node_id: str
    predicate_relation: str
    object_node_id: str
    confidence_score: float = Field(0.7, ge=0.0, le=1.0)
    epistemic_tier: EpistemicTier = EpistemicTier.PROPOSED_FACT
    context_sentence: str


# ============================================================================
# SRD 5.1 Compendium Schemas
# ============================================================================

class SRDSpellDefinition(BaseModel):
    id: str
    name: str
    level: int = Field(..., ge=0, le=9)
    school: str
    casting_time: str
    range: str
    components: str
    material_components_costly: bool = False
    duration: str
    concentration: bool = False
    ritual: bool = False
    description: str
    higher_levels: Optional[str] = None
    full_text: Optional[str] = None


class SRDMonsterAction(BaseModel):
    name: str
    description: str
    to_hit: Optional[str] = None
    damage_formula: Optional[str] = None
    damage_type: Optional[str] = None


class SRDMonsterDefinition(BaseModel):
    id: str
    name: str
    challenge_rating: str
    size: str
    creature_type: str
    alignment: str
    ac: int
    hp: int
    hit_dice: str
    speed: str
    abilities: Dict[str, int]
    saving_throws: List[str] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    damage_vulnerabilities: List[str] = Field(default_factory=list)
    damage_resistances: List[str] = Field(default_factory=list)
    damage_immunities: List[str] = Field(default_factory=list)
    condition_immunities: List[str] = Field(default_factory=list)
    senses: str
    languages: str
    category: str = "monster"
    bonus_actions: List[Dict[str, str]] = Field(default_factory=list)
    xp: Optional[int] = None
    proficiency_bonus: Optional[int] = None
    traits: List[Dict[str, str]] = Field(default_factory=list)
    actions: List[SRDMonsterAction] = Field(default_factory=list)
    legendary_actions: List[Dict[str, str]] = Field(default_factory=list)
    reactions: List[Dict[str, str]] = Field(default_factory=list)


class SRDMagicItemDefinition(BaseModel):
    id: str
    name: str
    category: str
    item_type: str = ""
    rarity: str = ""
    requires_attunement: bool = False
    description: str = ""


class SRDFeatDefinition(BaseModel):
    id: str
    name: str
    category: str
    prerequisite: str = ""
    description: str = ""


class SRDGlossaryTerm(BaseModel):
    id: str
    term: str
    tag: str = ""
    definition: str = ""


class SRDClassFeature(BaseModel):
    name: str
    level: int
    description: str


class SRDClassDefinition(BaseModel):
    id: str
    name: str
    hit_die: str
    primary_ability: str
    saving_throw_proficiencies: List[str]
    armor_proficiencies: List[str]
    weapon_proficiencies: List[str]
    spellcasting_ability: Optional[str] = None
    spell_slots_progression: Optional[Dict[int, List[int]]] = None
    features: List[SRDClassFeature] = Field(default_factory=list)


class SRDEquipmentItem(BaseModel):
    id: str
    name: str
    category: str # "Weapon", "Armor", "Adventuring Gear", "Magic Item"
    cost_cp: int = 0
    weight_lbs: float = 0.0
    damage_formula: Optional[str] = None
    damage_type: Optional[str] = None
    properties: List[str] = Field(default_factory=list)
    ac_base: Optional[int] = None
    armor_category: Optional[str] = None # "Light", "Medium", "Heavy", "Shield"
    stealth_disadvantage: bool = False
    strength_requirement: Optional[int] = None
    rarity: Optional[str] = None
    requires_attunement: bool = False
    description: str = ""


class SRDConditionDefinition(BaseModel):
    id: str
    name: str
    description: str
    mechanical_effects: List[str] = Field(default_factory=list)

class CastSpellPayload(BaseModel):
    caster_entity_id: str
    spell_id: str
    target_entity_ids: List[str] = Field(default_factory=list)
    slot_level_used: int = 1
    material_component_consumed: bool = False


class AttackActionPayload(BaseModel):
    attacker_entity_id: str
    target_entity_id: str
    weapon_name: str
    is_ranged: bool = False
    attack_roll: int
    attack_modifier: int
    target_armor_class: int
    damage_dice: str
    damage_type: str


class MoveActionPayload(BaseModel):
    entity_id: str
    source_position: Tuple[float, float, float]
    target_position: Tuple[float, float, float]
    movement_cost_feet: float
    remaining_speed_feet: float
