import asyncio
import logging
import math
import os
import re
import io
import json
import base64
import hashlib
import hmac
import secrets
import shutil
import stat
import tempfile
import time
import zipfile
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import PurePosixPath

import uvicorn
from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Annotated, Dict, Any, List, Literal, Optional, Tuple, Union

from .death_audit import build_death_audit, render_death_audit_markdown
from .routing.intent_router import IntentClassificationRouter
from .routing.llm_client import LLMStreamingGateway, LLMConfig
from .routing import engine_client
from .routing.engine_client import EngineRejectedError, EngineUnavailableError
from .routing.media_gateway_client import (
    MediaGatewayClient,
    MediaGatewayRejectedError,
    MediaGatewayUnavailableError,
)
# Pre-rename names stay importable for older callers.
LemonadeClient = MediaGatewayClient
LemonadeRejectedError = MediaGatewayRejectedError
LemonadeUnavailableError = MediaGatewayUnavailableError
from .storage import MemoryStore, PostgresStore, init_storage, public_user
from . import ratelimit
from .lore.epistemic_graph import EpistemicLoreGraphManager
from .auditor.inspector import PreCommitAuditorAgent, DiagnosticRetryController
from .agents.agent_hierarchy import EncounterDMAgent, DirectorAgent
from .agents.tool_agent import EngineToolAgent
from .simulation.faction_simulation import FactionSimulationGOAP
from .simulation.spotlight_tracker import VoiceSpotlightTracker
from .simulation.safety_gateway import SafetyGateway
from .simulation.dynasty_engine import global_dynasty_engine, DynastyEngine
from .simulation.empirical_playtester import EmpiricalPlaytester
from .compendium.bundle_packager import global_bundle_packager
from .compendium.encounter_balance import (
    encounter_balance as compute_encounter_balance,
)
from .compendium.starter_adventures import (
    build_starter_bundle_bytes,
    list_starter_adventures,
)
from .compendium.homebrew_parser import global_homebrew_parser
from .compendium.roll20_importer import global_roll20_importer
from .compendium.foundry_importer import global_foundry_importer
from .pdf.character_sheet_renderer import CharacterSheetPDFRenderer
from .routing.intent_router import LLM_CLASSIFIER_KILL_SWITCH_ENV
from .schemas.models import (
    IntentClassificationResult,
    IntentType,
    LoreAssertionPayload,
    AuditorDiagnosticReport,
    EpistemicTier,
)

app = FastAPI(
    title="AI-Native VTT Multi-Agent Orchestrator",
    version="1.0.0",
    description="Asynchronous Intent Routing, Narrative Graph, and Pre-Commit Invariant Auditing Gateway",
)

app.add_middleware(
    CORSMiddleware,
    # Strict origin allowlist (mirrors the engine's strict_cors): wildcard
    # origins combined with credentials is both invalid per the fetch spec
    # and an open credential-forwarding hole.
    allow_origins=[
        o.strip()
        for o in os.environ.get("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
        if o.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global State Container
router = IntentClassificationRouter()

# ---------------------------------------------------------------------------
# Intent-classification wiring (audit remediation)
#
# `IntentClassificationRouter.classify_with_llm()` shipped tested-but-uncalled.
# These helpers are the single choke point the turn endpoint uses so the LLM
# path engages ONLY when the kill switch allows it AND an API key exists; every
# other environment keeps the pure deterministic keyword classifier with zero
# network attempts and zero latency cost (the probe below is env-read-once).
# ---------------------------------------------------------------------------

_LLM_KEY_ENV_VARS = ("LLM_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY")
_llm_classifier_available: Optional[bool] = None


def reset_llm_classifier_cache() -> None:
    """Invalidate the cached availability probe (used by tests)."""
    global _llm_classifier_available
    _llm_classifier_available = None


def _llm_assist_enabled() -> bool:
    """True only when VTT_LLM_CLASSIFIER != "0" AND an API key is configured.

    Cached after the first read: the endpoint must never pay repeated env
    parsing, and an unconfigured deployment short-circuits before the async
    router is even entered.
    """
    global _llm_classifier_available
    if _llm_classifier_available is None:
        kill_switch_on = (
            os.environ.get(LLM_CLASSIFIER_KILL_SWITCH_ENV, "1").strip().lower()
            not in {"0", "false", "off"}
        )
        has_key = any(os.environ.get(var) for var in _LLM_KEY_ENV_VARS)
        _llm_classifier_available = kill_switch_on and has_key
    return _llm_classifier_available


async def classify_turn_intent(
    utterance: str, speaker_id: str = "player"
) -> Dict[str, Any]:
    """Classify a turn utterance via classify_with_llm when available.

    Returns the classify_with_llm decision dict:
    ``{"classification", "intent_type", "confidence", "classifier",
    "fallback_reason"}``. Without LLM assist the same shape is produced from
    the keyword fast path with ``classifier="keyword_fallback"`` and an honest
    fallback_reason — callers see one contract either way.
    """
    if _llm_assist_enabled():
        return await router.classify_with_llm(utterance, speaker_id)

    keyword = router.classify_utterance(utterance, speaker_id)
    switch_off = (
        os.environ.get(LLM_CLASSIFIER_KILL_SWITCH_ENV, "1").strip().lower()
        in {"0", "false", "off"}
    )
    reason = f"{LLM_CLASSIFIER_KILL_SWITCH_ENV}=0" if switch_off else "mock_mode: no LLM key configured"
    return {
        "classification": keyword,
        "intent_type": keyword.intent_type,
        "confidence": keyword.confidence,
        "classifier": "keyword_fallback",
        "fallback_reason": reason,
    }


# Epistemic graph backend selection (backlog 4.6): NEO4J_ENABLED=1 plus a
# reachable Neo4j HTTP endpoint selects the durable Cypher-backed store;
# anything else falls back to the in-memory manager at startup, logged
# honestly. Both expose the identical surface, so routes below never branch.
from .lore.neo4j_graph import build_epistemic_graph
lore_graph = build_epistemic_graph()
auditor = PreCommitAuditorAgent(lore_graph=lore_graph)
dm_agent = EncounterDMAgent()
retry_controller = DiagnosticRetryController(auditor=auditor, max_retries=2)
spotlight_tracker = VoiceSpotlightTracker(["Thorin", "Lyra", "Player3"])
safety_gateway = SafetyGateway()
# PROCESS-MEMORY-ONLY shared campaign state. Iteration 47 made this durable by
# riding it inside campaign autosave snapshots (_faction_slot) and restoring it
# via POST /api/v1/campaign/restore — but between autosaves it still lives only
# here, and ticks executed since the last save are lost on restart.
faction_sim = FactionSimulationGOAP("Shadow Cabal", resources=100)
streaming_gateway = LLMStreamingGateway()
tool_agent = EngineToolAgent(streaming_gateway)
# Self-hosted OpenAI-compatible multimedia upstream (images / TTS / STT /
# SFX). Reads MEDIA_GATEWAY_URL + MEDIA_GATEWAY_API_KEY plus the per-capability
# MEDIA_*_MODEL vars at construction (legacy LEMONADE_BASE_URL/API_KEY still
# honored as deprecated fallbacks) so a deployment can repoint it without a
# code change; every call raises MediaGatewayUnavailableError /
# MediaGatewayRejectedError on failure — routes built on this client must
# degrade honestly, never synthesize placeholder media.
media_client = MediaGatewayClient()
lemonade_client = media_client  # pre-rename alias; do not extend its use
pdf_renderer = CharacterSheetPDFRenderer()
empirical_playtester = EmpiricalPlaytester()

# Load Compendium Data
# Both SRD editions are loaded when their fixtures exist so a session's
# persisted rule_version (iteration 34, exposed on GET /sessions/{id}) can pick
# the right corpus per route. The DEFAULT corpus stays the richer SRD 5.2 set
# (legacy behavior for callers that name no session); when only one edition's
# fixtures exist every session gets that one, logged once and honestly.
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
COMPENDIUM_DIR = os.path.join(PROJECT_ROOT, "compendium")
SPELLS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_spells.json")
MONSTERS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_monsters.json")
SRD_51_SPELLS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_1_spells.json")
SRD_51_MONSTERS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_1_monsters.json")
MAGIC_ITEMS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_magic_items.json")
FEATS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_feats.json")
ANIMALS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_animals.json")
ORIGINS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_origins.json")
GLOSSARY_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_rules_glossary.json")

VALID_RULE_VERSIONS = ("srd_5_1", "srd_5_2")


def _load_json(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


compendium_corpora: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}

_srd_52_spells = _load_json(SPELLS_FILE)
_srd_52_monsters = _load_json(MONSTERS_FILE)
if _srd_52_spells and _srd_52_monsters:
    compendium_corpora["srd_5_2"] = {
        "spells": _srd_52_spells,
        "monsters": _srd_52_monsters,
    }

# The 5.1 edition falls back to the legacy truncated data/ files when the full
# compendium fixtures are absent — same fallback chain the gateway always had.
_srd_51_spells = _load_json(SRD_51_SPELLS_FILE) or _load_json(
    os.path.join(DATA_DIR, "srd_spells.json"))
_srd_51_monsters = _load_json(SRD_51_MONSTERS_FILE) or _load_json(
    os.path.join(DATA_DIR, "srd_monsters.json"))
if _srd_51_spells and _srd_51_monsters:
    compendium_corpora["srd_5_1"] = {
        "spells": _srd_51_spells,
        "monsters": _srd_51_monsters,
    }

# Deployment default: prefer 5.2 (the richer fixture set the gateway has always
# served), degrade to whichever edition actually loaded.
default_rule_version: str = (
    "srd_5_2" if "srd_5_2" in compendium_corpora
    else "srd_5_1" if "srd_5_1" in compendium_corpora
    else "srd_5_2"
)

_default_corpus = compendium_corpora.get(default_rule_version, {})
all_spells: List[Dict[str, Any]] = _default_corpus.get("spells", [])
all_monsters: List[Dict[str, Any]] = _default_corpus.get("monsters", [])

import logging as _corpus_logging

_corpus_log = _corpus_logging.getLogger("aethertable.compendium")
_loaded = ", ".join(
    f"{v} ({len(c['spells'])} spells / {len(c['monsters'])} monsters)"
    for v, c in sorted(compendium_corpora.items())
) or "none"
_missing = [v for v in VALID_RULE_VERSIONS if v not in compendium_corpora]
_corpus_log.info(
    "compendium corpora loaded: %s; default_rule_version=%s%s",
    _loaded,
    default_rule_version,
    (
        f"; sessions stamped {_missing} will be served the default corpus"
        if _missing else ""
    ),
)

all_magic_items: List[Dict[str, Any]] = _load_json(MAGIC_ITEMS_FILE)
all_feats: List[Dict[str, Any]] = _load_json(FEATS_FILE)
all_animals: List[Dict[str, Any]] = _load_json(ANIMALS_FILE)
all_origins: List[Dict[str, Any]] = _load_json(ORIGINS_FILE)
all_glossary_terms: List[Dict[str, Any]] = _load_json(GLOSSARY_FILE)


# Session-scoped rule-version resolutions are memoized per session id so a
# burst of compendium/narrative requests does not turn into a burst of
# gateway->engine GETs (audit F-A3#5). Entries expire after a short TTL — a
# table switching editions mid-session is picked up within seconds, not
# never — and only ENGINE-ANSWERED outcomes are cached: an unreachable or
# not-found session keeps retrying rather than freezing a transient blip.
_RULE_VERSION_CACHE_TTL_SECONDS = 30.0
_RULE_VERSION_CACHE_MAX_ENTRIES = 256
_rule_version_cache: Dict[str, Tuple[float, Tuple[Optional[str], str, str]]] = {}

# Anonymous callers may read any compendium corpus, but per-session edition
# branching needs a verified identity (audit F-A3#5): without one they get the
# default corpus plus this reason instead of a free engine round trip.
_SESSION_CORPUS_AUTH_REASON = (
    "authentication required for session-scoped corpora"
)

# Statuses whose outcome is deterministic per snapshot snapshot-of-engine and
# therefore safe to cache. Connection-level failures stay uncached.
_CACHEABLE_STATUSES = ("session", "missing_version", "unknown_version")


def reset_rule_version_cache() -> None:
    """Drops every cached resolution immediately (tests and admin tooling)."""
    _rule_version_cache.clear()


async def resolve_session_rule_version(
    engine_session_id: str,
    token: Optional[str] = None,
) -> Tuple[Optional[str], str, str]:
    """Resolves one session's rules baseline from the authoritative engine.

    Requires a verified caller token: anonymous (or invalid-token) callers are
    answered from ``default_rule_version`` WITHOUT touching the engine and get
    status ``"unauthenticated"`` with the explicit reason string.

    Returns ``(rule_version_or_None, status, reason)`` where status is exactly
    one of:

    * ``"session"`` — resolved from the live engine snapshot;
    * ``"missing_version"`` — the engine answered but the snapshot carries no
      ``rule_version`` (it predates preference tracking);
    * ``"unknown_version"`` — the snapshot names a version outside
      :data:`VALID_RULE_VERSIONS`;
    * ``"session_not_found"`` — the engine answered 404 for this session id;
    * ``"unreachable"`` — the engine could not be reached at all (connection
      failure, or a non-404 HTTP rejection surfaced with its status code);
    * ``"unauthenticated"`` — no valid caller token was supplied.

    Callers fall back to ``default_rule_version`` for every non-"session"
    status and MUST surface the reason — a table silently running the other
    edition is worse than a loud provenance field.
    """
    if _verify_token(token or "") is None:
        return None, "unauthenticated", _SESSION_CORPUS_AUTH_REASON

    key = str(engine_session_id)
    now = time.monotonic()
    cached = _rule_version_cache.get(key)
    if cached is not None and now - cached[0] < _RULE_VERSION_CACHE_TTL_SECONDS:
        return cached[1]

    resolved = await _resolve_session_rule_version_from_engine(engine_session_id)
    if resolved[1] in _CACHEABLE_STATUSES:
        if len(_rule_version_cache) >= _RULE_VERSION_CACHE_MAX_ENTRIES:
            # Evict expired entries first, then the oldest survivor, so the
            # cache stays bounded under adversarial session-id churn.
            expired = [
                k for k, (stamp, _) in _rule_version_cache.items()
                if now - stamp >= _RULE_VERSION_CACHE_TTL_SECONDS
            ]
            for k in expired:
                del _rule_version_cache[k]
            while len(_rule_version_cache) >= _RULE_VERSION_CACHE_MAX_ENTRIES:
                oldest = min(_rule_version_cache, key=lambda k: _rule_version_cache[k][0])
                del _rule_version_cache[oldest]
        _rule_version_cache[key] = (now, resolved)
    return resolved


async def _resolve_session_rule_version_from_engine(
    engine_session_id: str,
) -> Tuple[Optional[str], str, str]:
    """Uncached engine lookup behind resolve_session_rule_version."""
    try:
        snapshot = await engine_client.engine_request(
            "GET",
            f"/api/v1/sessions/{engine_client._coerce_uuid(str(engine_session_id))}",
        )
    except engine_client.EngineUnavailableError as exc:
        return None, "unreachable", f"engine unreachable ({exc})"
    except engine_client.EngineRejectedError as exc:
        if exc.status_code == 404:
            # A named session that does not exist is a distinct fact from a
            # dead engine (audit F-A3#6): callers should not be told the
            # engine is down when it just said "no such session".
            return None, "session_not_found", (
                f"engine reports no such session ({exc.status_code})"
            )
        return None, "unreachable", f"engine rejected session lookup ({exc.status_code})"
    raw = snapshot.get("rule_version")
    if raw is None:
        return None, "missing_version", (
            "session snapshot predates rule_version tracking"
        )
    if raw not in VALID_RULE_VERSIONS:
        return None, "unknown_version", (
            f"session reported rule_version {raw!r}; expected one of "
            f"{list(VALID_RULE_VERSIONS)}"
        )
    return raw, "session", ""


def _versioned_provenance(
    resolved: Tuple[Optional[str], str, str],
    requested: bool,
) -> Tuple[str, Dict[str, Any]]:
    """Maps a resolve_session_rule_version result onto response provenance.

    Returns (effective_version, provenance_fields). ``rule_version_source`` is
    ``"session"`` when the named session decided (which requires a verified
    caller — see :func:`resolve_session_rule_version`), ``"default"`` when no
    session was named, and ``"default_fallback"`` (plus a
    ``rule_version_reason``) when a named session could not be honored.
    """
    version, status, reason = resolved
    effective = version if version else default_rule_version
    if not requested:
        return effective, {
            "rule_version": effective,
            "rule_version_source": "default",
        }
    fields: Dict[str, Any] = {
        "rule_version": effective,
        "rule_version_source": "session" if status == "session" else "default_fallback",
    }
    if status != "session":
        fields["rule_version_reason"] = reason
    return effective, fields


def _versioned_lists(resolved: Tuple[Optional[str], str, str]) -> Tuple[List, List]:
    """Spell/monster lists for the resolved version (default on any failure).

    Callers resolve session scope through :func:`resolve_session_rule_version`,
    which already enforces the authentication gate (audit F-A3#5): anonymous
    callers receive the default corpus before this function is reached.
    """
    version = resolved[0] if resolved[0] else default_rule_version
    corpus = compendium_corpora.get(version)
    if not corpus:
        corpus = compendium_corpora.get(default_rule_version, {"spells": [], "monsters": []})
    return corpus["spells"], corpus["monsters"]

# Compendium RAG backend selection (backlog 4.7): QDRANT_ENABLED=1 plus a
# healthy Qdrant indexes the loaded compendium lists for semantic lore lookup;
# anything else keeps the deterministic substring scan, logged once at startup.
from .lore.compendium_rag import build_compendium_rag_index
compendium_rag = build_compendium_rag_index(
    all_spells, all_monsters, all_magic_items
)


class ClassifyRequest(BaseModel):
    utterance: str
    speaker_id: str = "Thorin"


class NarrativeGenerateRequest(BaseModel):
    user_intent: str
    turn_index: int = 1
    entity_id: str = "pc_thorin"
    engine_execution_payload: Dict[str, Any]
    active_entity_count: int = 4
    previous_entity_count: int = 4
    ingress_count: int = 0
    egress_count: int = 0
    # When provided, the auditor reconciles the client's claims against LIVE
    # engine state (entity counts, target HP/consciousness) instead of
    # trusting this payload — see _engine_ground_truth.
    engine_session_id: Optional[str] = None
    target_entity_id: Optional[str] = None


def extract_srd_context(
    text: str,
    limit: int = 2,
    *,
    spells: Optional[List[Dict[str, Any]]] = None,
    monsters: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Find SRD monster/spell references in free text and return stat facts.

    Used to ground LLM narration in authoritative compendium data so the DM
    agent cannot contradict the stat blocks (mechanical hallucination guard).
    ``spells``/``monsters`` let session-aware callers inject the corpus
    matching the session's rule_version; they default to the deployment's
    default edition so legacy call sites are unchanged.
    """
    lowered = (text or "").lower()
    facts: List[Dict[str, Any]] = []

    for monster in monsters if monsters is not None else all_monsters:
        name = monster.get("name", "")
        if len(name) >= 4 and name.lower() in lowered:
            facts.append({
                "type": "monster",
                "name": name,
                "ac": monster.get("ac"),
                "hp": monster.get("hp"),
                "challenge_rating": monster.get("challenge_rating"),
                "action_names": [a.get("name", "") for a in monster.get("actions", [])][:3],
            })
            if len(facts) >= limit:
                return facts

    for spell in spells if spells is not None else all_spells:
        name = spell.get("name", "")
        if len(name) >= 4 and name.lower() in lowered:
            level = spell.get("level", 0)
            description = spell.get("description", "")
            facts.append({
                "type": "spell",
                "name": name,
                "level_name": "Cantrip" if level == 0 else f"Level {level}",
                "school": spell.get("school", ""),
                "snippet": description[:140] + ("..." if len(description) > 140 else ""),
            })
            if len(facts) >= limit:
                break

    return facts


class UtteranceRecordRequest(BaseModel):
    speaker_id: str
    duration_sec: float


class XCardRequest(BaseModel):
    player_id: str
    topic: str
    current_sequence_id: int
    engine_session_id: Optional[str] = None


class CharacterExportPDFRequest(BaseModel):
    name: str
    level: int = 1
    race: str = "Human"
    character_class: str = "Fighter"
    subclass: str = "Champion"
    background: str = "Soldier"
    alignment: str = "Neutral Good"
    abilities: Dict[str, int] = Field(default_factory=lambda: {"STR": 16, "DEX": 14, "CON": 14, "INT": 10, "WIS": 12, "CHA": 8})
    hp: int = 12
    max_hp: int = 12
    ac: int = 16
    speed: int = 30
    proficiency_bonus: int = 2
    saving_throws: List[str] = Field(default_factory=lambda: ["STR", "CON"])
    skills: List[str] = Field(default_factory=lambda: ["Athletics (+5)", "Perception (+3)"])
    features: List[str] = Field(default_factory=lambda: ["Second Wind", "Fighting Style (Defense)"])
    spells: List[str] = Field(default_factory=list)


class DynastyInjectRequest(BaseModel):
    house_id: str


class HomebrewParseRequest(BaseModel):
    markdown_text: str
    strict: bool = False


class CampaignExportBundleRequest(BaseModel):
    title: str = "The Fall of Baron Vane"
    author: str = "AI Multi-Agent Director"
    ruleset: str = "D&D 5e SRD + Homebrew"
    grid_dimensions: Dict[str, int] = Field(default_factory=lambda: {"width": 16, "height": 12})
    walls: List[Dict[str, int]] = Field(default_factory=list)
    tokens: List[Dict[str, Any]] = Field(default_factory=list)
    dynasties: Dict[str, Any] = Field(default_factory=dict)
    lore_graph: Dict[str, Any] = Field(default_factory=dict)
    loot_tables: Dict[str, Any] = Field(default_factory=dict)


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "vtt-multi-agent-orchestrator",
        "version": "1.0.0",
        "mcr_compliance": 1.0,
    }


# --- Identity, Sessions & Campaign Persistence (/api/v1/auth, /campaign) ----
# Dual-mode storage: Postgres (asyncpg) when DATABASE_URL is reachable,
# in-memory fallback otherwise. HMAC-signed session tokens (AUTH_SECRET env).

def _resolve_auth_secret() -> str:
    """Returns the HMAC signing secret, or REFUSES to start.

    Session tokens are signed with this secret and carry the caller's RBAC
    role, so a known secret means anyone can mint an admin token. There is no
    safe default: falling back to a hardcoded dev value (the old behavior)
    turned "forgot to set AUTH_SECRET" into silent token forgery. This mirrors
    the Rust engine, which aborts startup for the same reason
    (crates/vtt-server/src/auth.rs). Either AUTH_SECRET or VTT_ENGINE_SECRET
    satisfies the check — they are the same credential contract.
    """
    secret = os.environ.get("AUTH_SECRET") or os.environ.get("VTT_ENGINE_SECRET")
    if not secret:
        raise RuntimeError(
            "Refusing to start: no signing secret configured. Set AUTH_SECRET "
            "(or VTT_ENGINE_SECRET) to a long random value — session tokens "
            "are HMAC-signed with it and carry RBAC roles, so a default or "
            "guessable secret would let anyone forge admin tokens. Generate "
            "one with: python -c 'import secrets; print(secrets.token_hex(32))'"
        )
    return secret


AUTH_SECRET = _resolve_auth_secret()
TOKEN_TTL_SECONDS = 12 * 3600

storage_backend: Any = MemoryStore()

_autosave_log = logging.getLogger("aethertable.autosave")
_media_log = logging.getLogger("aethertable.media")


@app.on_event("startup")
async def _init_storage_backend():
    global storage_backend
    storage_backend = await init_storage()
    # Resolve the rate-limit backend eagerly so a REDIS_URL misconfiguration is
    # reported once, at startup, instead of on the first request.
    _get_rate_backend()
    # Report the media gateway target once, at startup, so an operator sees
    # which host media generation will hit (or that it still points at a
    # default) before the first image/SFX request fails. The advertised-
    # capability probe is best-effort: a gateway that labels its models gives
    # an honest per-capability readout; one that doesn't (or is down) is
    # logged as unknown — routes still ATTEMPT their calls regardless.
    try:
        capabilities = await media_client.discover_capabilities()
        advertised = sorted(
            name for name, ok in capabilities.items() if ok
        )
        capability_note = ",".join(advertised) or "none"
    except Exception:
        _media_log.exception(
            "media gateway capability probe failed at %s", media_client.base_url
        )
        capability_note = "unknown"
    _media_log.info(
        "media gateway configured: base_url=%s models(image=%s tts=%s stt=%s sfx=%s) "
        "advertised_capabilities=%s%s",
        media_client.base_url,
        media_client.image_model,
        media_client.tts_model,
        media_client.stt_model,
        media_client.sfx_model,
        capability_note,
        (
            " [deprecated LEMONADE_* env in use]"
            if media_client.used_legacy_env_url or media_client.used_legacy_env_key
            else ""
        ),
    )


class AuthSignupRequest(BaseModel):
    email: str
    username: str = ""
    display_name: str = ""
    password: str
    # Only self-service-grantable roles are accepted; staff roles are rejected
    # by the handler (see _SELF_SERVICE_ROLES / VTT_ADMIN_EMAILS).
    role: str = "player"


# Roles a person may claim for themselves. 'gm'/'admin' are NOT here on
# purpose: every staff RBAC gate in this gateway and in the Rust engine keys
# off the role inside the signed token, so honoring a client-chosen 'admin'
# at signup was self-service privilege escalation.
_SELF_SERVICE_ROLES = ("player", "spectator")


def _bootstrap_admin_emails() -> frozenset:
    """Operator-provisioned admin allowlist, read at request time so it can be
    rotated without a code change.

    Bootstrap contract (the ONLY way a staff account comes into existence via
    the API): set VTT_ADMIN_EMAILS to a comma-separated list of addresses;
    any signup whose (lowercased, trimmed) email appears in that list is
    created with role='admin'. Everyone else gets exactly what they asked for
    among _SELF_SERVICE_ROLES. GM accounts are provisioned the same way or
    via AETHERTABLE_SEED_GM_EMAIL/AETHERTABLE_SEED_GM_PASSWORD on login.
    """
    raw = os.environ.get("VTT_ADMIN_EMAILS", "")
    return frozenset(addr.strip().lower() for addr in raw.split(",") if addr.strip())


class AuthLoginRequest(BaseModel):
    email: str
    password: str


def _sign_token(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    sig = hmac.new(AUTH_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(raw).decode() + "." + sig


def _verify_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        raw_b64, sig = token.split(".", 1)
        raw = base64.urlsafe_b64decode(raw_b64.encode())
        expected = hmac.new(AUTH_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(raw)
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None


def _require_user_id(token: str) -> str:
    payload = _verify_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return payload["user_id"]


def _caller_actor(token: str) -> Dict[str, str]:
    """Verified caller identity forwarded to the engine so its RBAC layer
    authorizes the real actor (entity ownership, spectator limits) instead
    of the gateway's service principal."""
    payload = _verify_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return {"user_id": payload["user_id"], "role": payload.get("role", "player")}


def _token_from(request: Request) -> str:
    """Extracts the caller's HMAC session token: Authorization header first
    ("Bearer <token>"), then the legacy ?token= query param.

    Tokens in URLs leak into proxy/access logs, so the header is the preferred
    channel; the query param stays as a back-compat fallback (older clients and
    the WebSocket handshake surface, where browsers cannot set headers).
    """
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        candidate = auth[7:].strip()
        if candidate:
            return candidate
    return request.query_params.get("token") or ""


async def _require_auth(token: str = Depends(_token_from)) -> str:
    """FastAPI dependency for protected routes: resolves header-or-query token
    and 401s when neither channel carries one."""
    if not token:
        raise HTTPException(status_code=401, detail="Missing session token")
    return token


async def _engine_ground_truth(session_id: str) -> Dict[str, Any]:
    """Fetches LIVE session state from the authoritative engine.

    The Pre-Commit Auditor must reconcile client claims against this — never
    audit numbers the client asserts alone. Raises EngineUnavailableError on
    an unreachable engine; callers refuse to audit rather than fall back to
    stale client claims.
    """
    raw = await engine_client.engine_request(
        "GET", f"/api/v1/sessions/{engine_client._coerce_uuid(session_id)}"
    )
    entities = raw.get("entities", {})
    return {"entity_count": len(entities), "entities": entities}


def _live_target_state(
    ground: Dict[str, Any], target_entity_id: str
) -> Optional[Dict[str, Any]]:
    """Extracts the auditor's lethality fields for one entity from live state."""
    wanted = engine_client._coerce_uuid(target_entity_id)
    for eid, entity in ground["entities"].items():
        if eid == wanted or str(entity.get("name", "")).lower() == target_entity_id.lower():
            return {
                "target_hp_remaining": entity.get("current_hp", 0),
                "target_is_conscious": entity.get("is_conscious", True),
                "target_is_dead": entity.get("is_dead", False),
            }
    return None


def _auth_response(profile: Dict[str, Any]) -> Dict[str, Any]:
    now = time.time()
    # `role` travels inside the signed payload so the Rust engine's RBAC
    # layer (gm/admin/spectator/player) can authorize without a DB lookup.
    token = _sign_token({
        "user_id": profile["id"],
        "role": profile.get("role", "player"),
        "exp": now + TOKEN_TTL_SECONDS,
    })
    return {"token": token, "expires_in": TOKEN_TTL_SECONDS, "user": profile}


@app.post("/api/v1/auth/signup")
async def auth_signup(req: AuthSignupRequest):
    key = req.email.strip().lower()
    if not key or "@" not in key or len(req.password) < 4:
        raise HTTPException(status_code=400, detail="Valid email and password (4+ chars) required")
    requested_role = (req.role or "").strip().lower()
    if requested_role not in _SELF_SERVICE_ROLES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Invalid role '{req.role}'. Self-service signup grants only "
                "'player' or 'spectator'; staff roles ('gm', 'admin') cannot "
                "be self-assigned. An operator bootstraps admins by listing "
                "their email in the VTT_ADMIN_EMAILS environment variable "
                "(comma-separated); matching addresses are created as admin "
                "when they sign up."
            ),
        )
    if await storage_backend.get_user_by_email(key) is not None:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    assigned_role = "admin" if key in _bootstrap_admin_emails() else requested_role
    record = await storage_backend.create_user(
        email=key,
        username=req.username or key.split("@")[0],
        display_name=req.display_name or req.username or key.split("@")[0],
        role=assigned_role,
        password=req.password,
        assigned_token_ids=["*"] if assigned_role == "admin" else [],
    )
    return _auth_response(public_user(record))


# Seed credentials are environment-gated: no hardcoded backdoor accounts.
SEED_GM_EMAIL = os.environ.get("AETHERTABLE_SEED_GM_EMAIL", "").strip().lower()
SEED_GM_PASSWORD = os.environ.get("AETHERTABLE_SEED_GM_PASSWORD", "")


@app.post("/api/v1/auth/login")
async def auth_login(req: AuthLoginRequest):
    key = req.email.strip().lower()
    record = await storage_backend.get_user_by_email(key)
    # Optionally seed a GM account on first use, ONLY when the operator has
    # provisioned explicit credentials via AETHERTABLE_SEED_GM_* env vars.
    if (
        record is None
        and SEED_GM_EMAIL
        and SEED_GM_PASSWORD
        and key == SEED_GM_EMAIL
        and req.password == SEED_GM_PASSWORD
    ):
        record = await storage_backend.create_user(
            email=key,
            username="gm",
            display_name="Lead GM",
            role="gm",
            password=req.password,
            assigned_token_ids=["*"],
        )
    if record is None or not storage_backend.verify_password(record, req.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return _auth_response(public_user(record))


@app.get("/api/v1/auth/session")
async def auth_session(token: str = Depends(_require_auth)):
    # Header-first auth (Bearer), ?token= back-compat — this route previously
    # declared ``token: str = Query(...)``, which rejected header-only callers
    # at validation and put tokens in URLs.
    user_id = _require_user_id(token)
    record = await storage_backend.get_user_by_id(user_id)
    if record is None:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return {"valid": True, "user": public_user(record)}


class CampaignSaveRequest(BaseModel):
    # Legacy clients carry the session token here; header auth (Authorization:
    # Bearer) is preferred and wins when both are present.
    token: str = ""
    name: str = "Campaign Autosave"
    snapshot: Dict[str, Any]
    round_number: int = 1


def _owner_or_401(token: str) -> str:
    return _require_user_id(token)


# --- Campaign-scoped gateway state durability (iteration 47) -----------------
#
# Several pieces of SHARED campaign state live in gateway process memory as
# module singletons. The audit flagged that they did not survive a restart:
# the active quest graph silently regenerated different canon and faction
# world-state progress evaporated. The durable-worthy pieces now ride inside
# the existing campaign autosave snapshot (same campaign_saves storage path —
# no new persistence infrastructure), and are restored on an authenticated
# reload.
#
# Genuinely SESSION-LOCAL, deliberately NOT persisted:
#   * global_concordia_engine — a pure treaty calculator over request inputs;
#     it holds no accumulated table state worth restoring.
#   * _NPC_REGISTRY / _npc_disposition_engine — rebuilt deterministically at
#     import from the curated persona tables; there is nothing to save.
#   * _rule_version_cache / rate windows — caches and operational plumbing,
#     not canon.
#
def _quest_slot() -> Optional[Dict[str, Any]]:
    """Serialized ``quest`` slot for a save snapshot: None when no quest is
    active, else a versioned envelope around the generated graph."""
    if active_campaign_quest is None:
        return None
    try:
        graph = active_campaign_quest.model_dump(mode="json")
    except Exception:
        # An unserializable in-memory graph is not saved rather than crashing
        # the autosave itself; restore treats the slot as absent.
        return None
    return {"format": "quest_graph_v1", "graph": graph}


def _faction_slot() -> Dict[str, Any]:
    """Serialized faction simulation state. Plain numeric/bool facts by
    contract, so this is always serializable."""
    return {
        "faction_name": faction_sim.faction_name,
        "resources": faction_sim.resources,
        "world_state": dict(faction_sim.world_state),
    }


class QuestSlotCorrupt(Exception):
    """A persisted quest slot exists but does not deserialize to a QuestGraph."""


class FactionSlotCorrupt(Exception):
    """A persisted faction slot exists but its fields are unusable."""


def _parse_quest_slot(payload: Any) -> Optional[QuestGraph]:
    if payload is None:
        return None
    if not isinstance(payload, dict):
        raise QuestSlotCorrupt("QUEST_SLOT_CORRUPT: expected an object")
    fmt = payload.get("format")
    if fmt != "quest_graph_v1":
        raise QuestSlotCorrupt(
            f"QUEST_SLOT_CORRUPT: unknown quest slot format {fmt!r}"
        )
    graph = payload.get("graph")
    if not isinstance(graph, dict):
        raise QuestSlotCorrupt("QUEST_SLOT_CORRUPT: missing graph object")
    try:
        parsed = QuestGraph.model_validate(graph)
    except Exception as exc:
        raise QuestSlotCorrupt(f"QUEST_SLOT_CORRUPT: {exc}") from exc
    if not parsed.nodes or not parsed.initial_node_id:
        raise QuestSlotCorrupt(
            "QUEST_SLOT_CORRUPT: graph has no nodes or no initial node"
        )
    return parsed


def _parse_faction_slot(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise FactionSlotCorrupt("FACTION_SLOT_CORRUPT: expected an object")
    world = payload.get("world_state")
    resources = payload.get("resources")
    if world is None or isinstance(resources, bool) or not isinstance(resources, (int, float)):
        raise FactionSlotCorrupt(
            "FACTION_SLOT_CORRUPT: missing world_state or non-numeric resources"
        )
    if not isinstance(world, dict):
        raise FactionSlotCorrupt("FACTION_SLOT_CORRUPT: world_state must be an object")
    return {
        "faction_name": payload.get("faction_name", faction_sim.faction_name),
        "resources": resources,
        "world_state": dict(world),
    }


def _apply_restored_gateway_state(
    quest: Optional[QuestGraph], faction: Dict[str, Any]
) -> None:
    """Applies parsed slots back onto the module singletons."""
    global active_campaign_quest
    if quest is not None:
        active_campaign_quest = quest
    faction_sim.resources = faction["resources"]
    faction_sim.world_state = dict(faction["world_state"])


async def _load_owned_save_or_error(owner: str, save_id: str) -> Dict[str, Any]:
    record = await storage_backend.get_campaign_save(owner, save_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Save not found")
    snapshot = record.get("snapshot")
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=422, detail="CORRUPT_SAVE: snapshot missing")
    return record


async def _restore_latest_gateway_state(owner: str) -> Optional[QuestGraph]:
    """Restart recovery for the quest read path: when no graph lives in memory
    (fresh process), re-apply the newest persisted quest owned by ``owner``
    instead of silently rolling new canon.

    Returns the restored graph, or None when the owner has NO save carrying a
    quest slot (legacy rows / fresh install). A save that carries a quest slot
    which fails to parse raises QuestSlotCorrupt — surfaced as an honest 422 by
    the caller rather than masked with a fresh generation. Faction state is NOT
    touched here: journal reads must not silently rewind world progress; that
    belongs to the explicit POST /campaign/restore route.
    """
    global active_campaign_quest
    saves = await storage_backend.list_campaign_saves(owner)
    for meta in saves:
        record = await storage_backend.get_campaign_save(owner, meta["save_id"])
        if not isinstance(record, dict):
            continue  # vanished between list and get; try the next one
        snapshot = record.get("snapshot")
        if not isinstance(snapshot, dict) or "quest" not in snapshot:
            continue
        quest = _parse_quest_slot(snapshot["quest"])  # raises on corrupt rows
        if quest is None:
            continue  # autosaved before any quest existed; keep scanning
        active_campaign_quest = quest
        return quest
    return None


@app.post("/api/v1/campaign/save")
async def campaign_save(req: CampaignSaveRequest, token: str = Depends(_token_from)):
    header_or_query_token = req.token or token
    owner = _owner_or_401(header_or_query_token)
    meta = await storage_backend.upsert_campaign_save(
        owner, req.name.strip() or "Campaign Autosave", req.snapshot, req.round_number
    )
    return {"status": "saved", **meta}


@app.get("/api/v1/campaign/saves")
async def campaign_saves(token: str = Depends(_require_auth)):
    owner = _owner_or_401(token)
    saves = await storage_backend.list_campaign_saves(owner)
    return {"total": len(saves), "saves": saves}


@app.get("/api/v1/campaign/save/{save_id}")
async def campaign_load(save_id: str, token: str = Depends(_require_auth)):
    owner = _owner_or_401(token)
    record = await storage_backend.get_campaign_save(owner, save_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Save not found")
    return record


@app.delete("/api/v1/campaign/save/{save_id}")
async def campaign_delete(save_id: str, token: str = Depends(_require_auth)):
    owner = _owner_or_401(token)
    deleted = await storage_backend.delete_campaign_save(owner, save_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Save not found")
    return {"status": "deleted"}


class CampaignAutosaveRequest(BaseModel):
    session_id: str
    # Empty name falls back to a per-session rolling autosave slot so repeated
    # calls UPSERT over the previous checkpoint instead of growing unbounded
    # rows (upsert is keyed on owner_user_id + save_name).
    name: str = ""


@app.post("/api/v1/campaign/autosave")
async def campaign_autosave(
    req: CampaignAutosaveRequest, token: str = Depends(_require_auth)
):
    """Server-side GM autosave: capture LIVE engine state as a campaign save.

    Unlike POST /campaign/save (a manual, client-supplied snapshot), this
    route never trusts client numbers for state: it fetches the authoritative
    session from the engine with the caller's identity forwarded (so the
    engine's RBAC layer authorizes the real actor) and wraps that verbatim
    payload as a snapshot through the existing create-save storage path.

    Fails honestly and atomically: a non-GM caller gets 403 before any engine
    or store touch; an unreachable engine maps to 502 with nothing half-saved.

    Iteration 47: the snapshot additionally carries the gateway-owned campaign
    state (active quest graph, faction simulation) so it survives a restart.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(status_code=403, detail="AUTOSAVE_GM_ONLY")

    raw = await _engine_call(
        engine_client.engine_request(
            "GET",
            f"/api/v1/sessions/{engine_client._coerce_uuid(req.session_id)}",
            actor=actor,
        )
    )
    entities = raw.get("entities", {}) if isinstance(raw, dict) else {}
    ledger = raw.get("ledger") if isinstance(raw, dict) else None
    events = ledger.get("events", []) if isinstance(ledger, dict) else []
    combat = raw.get("combat") if isinstance(raw, dict) else None
    round_number = combat.get("round") if isinstance(combat, dict) else None
    if not isinstance(round_number, int) or round_number < 1:
        round_number = 1

    name = req.name.strip() or f"Autosave · {req.session_id[:8]}"
    snapshot = {
        "round": round_number,
        "entities_count": len(entities),
        "events_count": len(events),
        # Verbatim engine state: the hydrate/restore bridge consumes this shape.
        "snapshot": raw,
        # Gateway-owned campaign state (iteration 47): persisted alongside the
        # engine snapshot so it survives a restart. Session-local singletons
        # (NPC registry, spotlight tracker, rate windows) deliberately stay
        # out — they are rebuilt per process by design.
        "quest": _quest_slot(),
        "faction_simulation": _faction_slot(),
    }
    meta = await storage_backend.upsert_campaign_save(
        _owner_or_401(token), name, snapshot, round_number
    )
    return {
        "save_id": meta["save_id"],
        "round": round_number,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }


# --- Periodic autosave (iteration 77) -----------------------------------------
#
# The audit found that every save path was PULL-based: a human clicking
# POST /campaign/autosave or a client posting /campaign/save. A crashed
# browser or an overnight session lost everything after the last manual click.
# This block adds an opt-IN per-session periodic autosave:
#
#   * The GM enables it per engine session via PUT /campaign/autosave/policy;
#     the policy is persisted in the storage backend, not process memory.
#   * A lightweight asyncio task in the FastAPI lifespan ticks every
#     AUTOSAVE_POLL_SECONDS and calls run_autosave_cycle(), which saves each
#     enabled policy whose interval has elapsed AND whose engine ledger moved
#     since the previous periodic save (idle campaigns are skipped rather than
#     rewritten identically).
#   * One campaign's failure is logged and skipped — it never kills the loop
#     or the other campaigns' saves.
#
# HONEST CONSTRAINT — single worker: this is an in-process asyncio task. Under
# `uvicorn --workers N` every worker runs its own loop; the saves themselves
# converge on the same rolling upsert slot so no rows multiply, but workers
# race on the ledger baseline and duplicate work. Deployments running more
# than one gateway worker should keep this feature off until the loop grows a
# cross-worker lease.
AUTOSAVE_POLL_SECONDS = 30.0
_autosave_task: Optional["asyncio.Task"] = None


class AutosavePolicyRequest(BaseModel):
    session_id: str
    enabled: bool = True
    # Bounded 1..1440 minutes (a day): below 1 the loop would hammer the
    # engine every poll; above a day "periodic" stops meaning anything.
    interval_minutes: int = Field(5, ge=1, le=1440)


def _policy_role_or_403(token: str) -> Dict[str, str]:
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(status_code=403, detail="AUTOSAVE_POLICY_GM_ONLY")
    return actor


async def _has_session_standing(user_id: str, engine_session_id: str) -> bool:
    """Audit A5/F1 (iteration 87): standing over a session is derived from
    gateway-owned data, never from a role claim.

    The gateway's authoritative relationship to an engine session IS its lobby
    binding (storage.set_lobby_session at launch) plus membership of that
    roster — the same derivation ``_caller_is_session_participant`` uses for
    x-card and agentic turns. A periodic autosave grants MORE than either of
    those surfaces (a rolling full-fidelity snapshot including hidden
    entities), so it demands the same evidence rather than more.

    Deliberately fail-closed: there is no admin bypass. Global staff standing
    says nothing about a particular table; an unbound or unknown session UUID
    has no roster to belong to, so nobody — admin included — has standing over
    it and every request is refused with AUTOSAVE_POLICY_NO_STANDING.
    """
    lobbies = await storage_backend.list_lobbies_for_user(user_id)
    return any(
        lobby.get("engine_session_id") == engine_session_id for lobby in lobbies
    )


@app.put("/api/v1/campaign/autosave/policy")
async def set_autosave_policy(
    req: AutosavePolicyRequest, token: str = Depends(_require_auth)
):
    """GM/admin only: opt one engine session into periodic server-side saves.

    Opt-in by design — the gateway silently rewriting a table's canon every N
    minutes must never be a deployment default. Ownership scopes the row, so
    another GM enabling a policy for the same session label cannot touch this
    owner's schedule.

    Audit A5/F1 (iteration 87): the role gate alone was forgeable standing —
    any GM could point a policy at an ARBITRARY session UUID and receive that
    table's complete hidden-entity state within one poll interval. Creating or
    re-pointing a policy therefore additionally requires lobby-derived
    standing over ``req.session_id`` (see ``_has_session_standing``); requests
    without it get 403 AUTOSAVE_POLICY_NO_STANDING before any row is written.
    """
    _policy_role_or_403(token)
    owner = _owner_or_401(token)
    if not await _has_session_standing(owner, req.session_id):
        raise HTTPException(status_code=403, detail="AUTOSAVE_POLICY_NO_STANDING")
    meta = await storage_backend.upsert_autosave_policy(
        owner, req.session_id, req.enabled, req.interval_minutes
    )
    return {"status": "ok", **meta}


@app.get("/api/v1/campaign/autosave/policy")
async def get_autosave_policy(
    session_id: str = Query(...), token: str = Depends(_require_auth)
):
    """Reads one session's policy for the caller. An absent row reads back as
    ``enabled=false`` — the default really is off."""
    _policy_role_or_403(token)
    owner = _owner_or_401(token)
    return await storage_backend.get_autosave_policy(owner, session_id)


def _periodic_save_name(session_id: str) -> str:
    """Rolling slot name for periodic saves: upsert-keyed on
    (owner, save_name), so repeated cycles overwrite the previous checkpoint
    instead of growing unbounded rows — same convention as the manual
    autosave route's default name."""
    return f"Periodic Autosave · {session_id[:8]}"


async def run_autosave_cycle(now: float) -> List[Dict[str, Any]]:
    """One pass over every ENABLED autosave policy.

    Returns what it saved. Per-campaign isolation contract: any failure while
    saving one campaign is caught and logged, and the remaining campaigns
    still get their save. Skipped campaigns (interval not elapsed, idle
    ledger) are absent from the result by design.
    """
    saved: List[Dict[str, Any]] = []
    try:
        policies = await storage_backend.list_enabled_autosave_policies()
    except Exception:
        _autosave_log.exception("autosave cycle could not list policies")
        return saved

    for policy in policies:
        owner = policy["owner_user_id"]
        session_id = policy["engine_session_id"]
        try:
            interval = int(policy.get("interval_minutes") or 5) * 60
            last_saved_at = policy.get("last_saved_at")
            if last_saved_at is not None and (now - float(last_saved_at)) < interval:
                continue  # interval not elapsed

            # Audit A5/F1 (iteration 87): standing is re-derived FRESH each
            # cycle from the gateway-owned lobby roster, never carried forward
            # from enablement time and never inferred from a role claim. The
            # engine call below signs {"role": "gm"} for ``owner`` — a claim
            # this process mints, which is exactly why it must be earned
            # here first: only an owner whose CURRENT lobby membership still
            # binds them to this engine session may borrow the GM projection
            # for their own table's snapshot. Standing lost => the policy is
            # disabled (persisted) with one honest log line and NOTHING is
            # fetched; the loop does not keep resurrecting authority.
            if not await _has_session_standing(owner, str(session_id)):
                await storage_backend.upsert_autosave_policy(
                    owner, str(session_id), False,
                    int(policy.get("interval_minutes") or 5),
                )
                _autosave_log.warning(
                    "periodic autosave policy DISABLED for session %s "
                    "(owner %s): lobby standing no longer holds — skipping "
                    "fetch",
                    session_id, owner,
                )
                continue

            raw = await engine_client.engine_request(
                "GET",
                f"/api/v1/sessions/{engine_client._coerce_uuid(str(session_id))}",
                actor={"user_id": owner, "role": "gm"},
            )
            entities = raw.get("entities", {}) if isinstance(raw, dict) else {}
            ledger = raw.get("ledger") if isinstance(raw, dict) else None
            events = ledger.get("events", []) if isinstance(ledger, dict) and isinstance(ledger.get("events"), list) else []
            events_count = len(events)

            previous_events = policy.get("last_events_count")
            if (
                previous_events is not None
                and int(previous_events) >= 0
                and events_count == int(previous_events)
            ):
                continue  # idle: nothing moved since the last periodic save

            combat = raw.get("combat") if isinstance(raw, dict) else None
            round_number = combat.get("round") if isinstance(combat, dict) else None
            if not isinstance(round_number, int) or round_number < 1:
                round_number = 1

            snapshot = {
                "round": round_number,
                "entities_count": len(entities),
                "events_count": events_count,
                "snapshot": raw,
                "quest": _quest_slot(),
                "faction_simulation": _faction_slot(),
                "periodic": True,
            }
            await storage_backend.upsert_campaign_save(
                owner, _periodic_save_name(str(session_id)),
                snapshot, round_number,
            )
            await storage_backend.record_autosave_run(
                owner, str(session_id), events_count, now
            )
            saved.append({
                "session_id": session_id,
                "events_count": events_count,
                "round": round_number,
            })
        except Exception:
            # Log-and-continue: a single dead engine session or corrupt
            # payload must not starve the other tables' durability.
            _autosave_log.exception(
                "periodic autosave failed for session %s (owner %s); skipping",
                session_id, owner,
            )
    return saved


async def _autosave_loop(poll_seconds: float = AUTOSAVE_POLL_SECONDS) -> None:
    """Background tick. Exceptions from run_autosave_cycle itself (not from
    individual campaigns, which are already contained inside the cycle) are
    swallowed so the loop outlives transient storage outages."""
    while True:
        await asyncio.sleep(poll_seconds)
        try:
            await run_autosave_cycle(now=time.time())
        except asyncio.CancelledError:
            raise
        except Exception:
            _autosave_log.exception("autosave cycle crashed; continuing")


@app.on_event("startup")
async def _start_autosave_loop():
    global _autosave_task
    if _autosave_task is None or _autosave_task.done():
        _autosave_task = asyncio.create_task(_autosave_loop())


class CampaignRestoreRequest(BaseModel):
    save_id: str


def _restore_payload_from_snapshot(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """Parses (and validates) the gateway-state slots out of a saved snapshot.

    Raises QuestSlotCorrupt / FactionSlotCorrupt for a structurally broken
    payload — callers map that to an honest 422 rather than crashing or
    silently regenerating different canon.
    """
    quest = _parse_quest_slot(snapshot.get("quest"))
    faction_raw = snapshot.get("faction_simulation")
    faction = (
        _parse_faction_slot(faction_raw)
        if faction_raw is not None
        else {
            "faction_name": faction_sim.faction_name,
            "resources": faction_sim.resources,
            "world_state": dict(faction_sim.world_state),
        }
    )
    return {"quest": quest, "faction": faction}


@app.post("/api/v1/campaign/restore")
async def campaign_restore(
    req: CampaignRestoreRequest, token: str = Depends(_require_auth)
):
    """Restores gateway-owned campaign state from one of the caller's saves.

    This is the authenticated reload half of autosave: after a gateway
    restart the module singletons are back to import-time defaults, and this
    route puts the persisted quest graph and faction world state back. GM/admin
    only — restoring rewrites shared campaign canon every player reads.
    Ownership follows the save row (same isolation as GET /campaign/save/{id}:
    another owner's save is indistinguishable from a missing one).

    A corrupt slot is an honest 422 naming what broke; nothing is applied.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(status_code=403, detail="RESTORE_GM_ONLY")

    owner = _owner_or_401(token)
    record = await _load_owned_save_or_error(owner, req.save_id)
    try:
        parsed = _restore_payload_from_snapshot(record["snapshot"])
    except (QuestSlotCorrupt, FactionSlotCorrupt) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    _apply_restored_gateway_state(parsed["quest"], parsed["faction"])
    return {
        "status": "restored",
        "save_id": req.save_id,
        "save_name": record.get("save_name"),
        "quest": parsed["quest"].model_dump(mode="json") if parsed["quest"] else None,
        "faction": parsed["faction"],
    }


# --- Automatic rumor capture (Pillar 7) --------------------------------------------

# Verb patterns mapping improvised player phrasing onto canon-graph relations,
# mirroring the auditor's narrative triple extraction so a captured rumor and
# an audited draft speak the same predicate vocabulary.
_RUMOR_PREDICATE_PATTERNS = (
    (re.compile(r"\b(?:possess\w*|wield\w*|carri\w*|hold\w*|own\w*)\b", re.IGNORECASE), "POSSESSES"),
    (re.compile(r"\b(?:rules?|ruled|reign\w*|govern\w*)\b", re.IGNORECASE), "RULES"),
    (re.compile(r"\b(?:attacks?|strikes?|slay\w*|fight\w*|murder\w*)\b", re.IGNORECASE), "ATTACKS"),
    (re.compile(r"\bspeaks? with\b|\btalks? to\b|\bconverses? with\b", re.IGNORECASE), "SPEAKS_WITH"),
)

# Reflexive relations ("the keep still stands") pair the subject with itself.
_RUMOR_REFLEXIVE = frozenset({"IS_ALIVE", "IS_INTACT"})
_RUMOR_ALIVE_PATTERN = re.compile(r"\b(?:is alive|still lives|walks the earth)\b", re.IGNORECASE)
_RUMOR_INTACT_PATTERN = re.compile(r"\b(?:is intact|still stands)\b", re.IGNORECASE)


def derive_rumor_triple(utterance: str) -> Optional[Dict[str, str]]:
    """Derive one (subject, predicate, object) candidate from free speech.

    Known canon node names are matched positionally against the utterance and
    paired across the nearest predicate verb — the same windowed heuristic the
    pre-commit auditor applies to narrative drafts. Returns None when no
    known-entity pair around a predicate exists; callers treat that as "not
    capturable" rather than inventing entities.
    """
    lowered = (utterance or "").lower()
    mentions: List[Tuple[int, int, str]] = []
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

    def _pair(subj: Tuple[int, int, str], obj: Tuple[int, int, str],
              relation: str, match: re.Match) -> Optional[Tuple[str, str, str]]:
        if subj[2] == obj[2] and relation not in _RUMOR_REFLEXIVE:
            return None
        if match.start() - subj[1] > 60:
            return None
        if obj[0] - match.end() > 60:
            return None
        return {"subject": subj[2], "predicate": relation, "object": obj[2]}  # type: ignore[return-value]

    candidates: List[Tuple[str, str, str]] = []
    reflexive_hits = (
        [(m, "IS_ALIVE") for m in _RUMOR_ALIVE_PATTERN.finditer(utterance)]
        + [(m, "IS_INTACT") for m in _RUMOR_INTACT_PATTERN.finditer(utterance)]
    )
    for match, relation in reflexive_hits:
        before = [m for m in mentions if m[1] <= match.start()]
        if not before:
            continue
        subj = max(before, key=lambda m: m[1])
        candidate = _pair(subj, subj, relation, match)
        if candidate:
            candidates.append(candidate)

    for pattern, relation in _RUMOR_PREDICATE_PATTERNS:
        for match in pattern.finditer(utterance):
            before = [m for m in mentions if m[1] <= match.start()]
            after = [m for m in mentions if m[0] >= match.end()]
            if not before or not after:
                continue
            subj = max(before, key=lambda m: m[1])
            obj = min(after, key=lambda m: m[0])
            candidate = _pair(subj, obj, relation, match)
            if candidate:
                candidates.append(candidate)

    return candidates[0] if candidates else None


def capture_rumor_from_utterance(utterance: str, speaker_id: str) -> Dict[str, Any]:
    """Stage an improvised assertion into the rumor pipeline.

    Pillar-7 multi-tier lore mutability only works if improvised claims ever
    REACH it. This hook runs after classification labels an utterance
    LORE_ASSERTION: the derived triple enters at SUBJECTIVE_RUMOR (never above
    — capture stages, promotion stays behind POST /api/v1/lore/assert's role
    gate) through the same paradox-reviewed submit path as a manual POST.
    Every failure mode degrades to an honest non-staged verdict; capture never
    raises into classification.
    """
    triple = derive_rumor_triple(utterance)
    if triple is None:
        return {"status": "NOT_CAPTURABLE"}
    try:
        result = lore_graph.submit_assertion(LoreAssertionPayload(
            proposing_entity_id=speaker_id or "unknown_speaker",
            subject_node_id=triple["subject"],
            predicate_relation=triple["predicate"],
            object_node_id=triple["object"],
            confidence_score=0.5,
            epistemic_tier=EpistemicTier.SUBJECTIVE_RUMOR,
            context_sentence=utterance[:500],
        ))
    except Exception as exc:  # pragma: no cover - defensive, never raise upward
        return {"status": "CAPTURE_FAILED", "detail": str(exc)[:200]}
    return {
        "status": result.get("status"),
        "epistemic_tier": EpistemicTier.SUBJECTIVE_RUMOR.value,
        **triple,
    }


@app.post("/api/v1/intent/classify", response_model=IntentClassificationResult)
def classify_intent(
    req: ClassifyRequest, response: Response, token: str = Depends(_require_auth)
):
    # Any authenticated seat may classify (players narrate too), but the call
    # is metered in the `llm` bucket — see _bucket_for_path.
    actor = _caller_actor(token)
    result = router.classify_utterance(req.utterance, req.speaker_id)

    # Automatic rumor capture (Pillar-7): a classified LORE_ASSERTION flows
    # straight into the rumor pipeline instead of evaporating. The verdict is
    # attached as an out-of-band header because the declared response model is
    # IntentClassificationResult; FastAPI would silently strip any extra body
    # field.
    if result.intent_type is IntentType.LORE_ASSERTION:
        capture = capture_rumor_from_utterance(req.utterance, req.speaker_id or actor["user_id"])
        response.headers["X-Rumor-Capture"] = json.dumps(capture, default=str)
    return result


# --- Handouts ---------------------------------------------------------------------

class HandoutCreateRequest(BaseModel):
    title: str
    content_md: str = ""
    revealed_to: Literal["all", "party", "gm_only"] = "all"
    campaign_id: Optional[str] = None
    lobby_id: Optional[str] = None


class HandoutUpdateRequest(BaseModel):
    title: Optional[str] = None
    content_md: Optional[str] = None
    revealed_to: Optional[Literal["all", "party", "gm_only"]] = None
    campaign_id: Optional[str] = None
    lobby_id: Optional[str] = None


def _handout_can_view(record: Dict[str, Any], role: str) -> bool:
    """Role visibility for handouts: GM/admin sees everything; players and
    spectators (and any unrecognized role — fails closed) see only rows
    revealed to 'all' or 'party'. gm_only content never leaves the GM view,
    including via direct GET."""
    if role in ("gm", "admin"):
        return True
    return record.get("revealed_to", "gm_only") in ("all", "party")


@app.post("/api/v1/handouts")
async def create_handout(
    req: HandoutCreateRequest, token: str = Depends(_require_auth)
):
    actor = _caller_actor(token)
    return await storage_backend.create_handout(
        title=req.title.strip() or "Untitled Handout",
        content_md=req.content_md,
        revealed_to=req.revealed_to,
        created_by=actor["user_id"],
        campaign_id=req.campaign_id or None,
        lobby_id=req.lobby_id or None,
    )


@app.get("/api/v1/handouts")
async def list_handouts(
    campaign_id: Optional[str] = Query(None), token: str = Depends(_require_auth)
):
    actor = _caller_actor(token)
    role = actor["role"]
    rows = await storage_backend.list_handouts(
        campaign_id=campaign_id,
        # Non-GM callers are filtered at the storage layer; the in-process
        # re-check below is defense-in-depth against a backend that ignores
        # the visibility hint.
        visible_only_for_role=role,
    )
    visible = [r for r in rows if _handout_can_view(r, role)]
    return {"total": len(visible), "handouts": visible}


@app.get("/api/v1/handouts/{handout_id}")
async def get_handout(handout_id: str, token: str = Depends(_require_auth)):
    """Reads ONE handout, filtered by the caller's role. A player asking for a
    gm_only row gets the same 404 as a nonexistent id so the route cannot be
    probed as an existence oracle for unrevealed content."""
    actor = _caller_actor(token)
    record = await storage_backend.get_handout(handout_id)
    if record is None or not _handout_can_view(record, actor["role"]):
        raise HTTPException(status_code=404, detail="Handout not found")
    return record


@app.put("/api/v1/handouts/{handout_id}")
async def update_handout(
    handout_id: str, req: HandoutUpdateRequest, token: str = Depends(_require_auth)
):
    """Patches a handout. Authorizable by its creator or any GM/admin; other
    authenticated callers get the same 404 as a nonexistent id."""
    actor = _caller_actor(token)
    record = await storage_backend.get_handout(handout_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Handout not found")
    if record["created_by"] != actor["user_id"] and actor["role"] not in ("gm", "admin"):
        raise HTTPException(status_code=404, detail="Handout not found")
    fields = req.model_dump(exclude_none=True)
    updated = await storage_backend.update_handout(handout_id, fields)
    if updated is None:
        raise HTTPException(status_code=404, detail="Handout not found")
    return updated


@app.delete("/api/v1/handouts/{handout_id}")
async def delete_handout(handout_id: str, token: str = Depends(_require_auth)):
    actor = _caller_actor(token)
    record = await storage_backend.get_handout(handout_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Handout not found")
    if record["created_by"] != actor["user_id"] and actor["role"] not in ("gm", "admin"):
        raise HTTPException(status_code=404, detail="Handout not found")
    deleted = await storage_backend.delete_handout(handout_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Handout not found")
    return {"status": "deleted"}


@app.get("/api/v1/compendium/spells")
async def get_compendium_spells(
    q: Optional[str] = Query(None, description="Search query for spell name"),
    school: Optional[str] = Query(None, description="Filter by magic school"),
    level: Optional[int] = Query(None, description="Filter by spell level"),
    limit: int = Query(50, ge=1, le=400),
    engine_session_id: Optional[str] = Query(
        None,
        description=(
            "Prefer this session's persisted rule_version corpus "
            "(requires an authenticated caller)"
        ),
    ),
    token: Optional[str] = Depends(_token_from),
):
    # Compendium reads stay public; only per-session edition branching needs a
    # verified caller (audit F-A3#5). Anonymous callers silently get the
    # default corpus plus the honest fallback reason.
    resolved = (
        await resolve_session_rule_version(engine_session_id, token)
        if engine_session_id else (None, "", "")
    )
    spells, _ = _versioned_lists(resolved)
    provenance = _versioned_provenance(resolved, bool(engine_session_id))[1]
    results = spells
    if q:
        query = q.lower()
        results = [s for s in results if query in s.get("name", "").lower() or query in s.get("description", "").lower()]
    if school:
        results = [s for s in results if s.get("school", "").lower() == school.lower()]
    if level is not None:
        results = [s for s in results if s.get("level") == level]
    return {
        "total": len(results),
        "spells": results[:limit],
        **provenance,
    }


@app.get("/api/v1/compendium/monsters")
async def get_compendium_monsters(
    q: Optional[str] = Query(None, description="Search query for monster name"),
    challenge_rating: Optional[str] = Query(None, description="Filter by challenge rating"),
    limit: int = Query(50, ge=1, le=400),
    engine_session_id: Optional[str] = Query(
        None,
        description=(
            "Prefer this session's persisted rule_version corpus "
            "(requires an authenticated caller)"
        ),
    ),
    token: Optional[str] = Depends(_token_from),
):
    # Same auth gate as /spells: public read, authenticated session branching.
    resolved = (
        await resolve_session_rule_version(engine_session_id, token)
        if engine_session_id else (None, "", "")
    )
    _, monsters = _versioned_lists(resolved)
    provenance = _versioned_provenance(resolved, bool(engine_session_id))[1]
    results = monsters
    if q:
        query = q.lower()
        results = [m for m in results if query in m.get("name", "").lower() or query in m.get("type", "").lower()]
    if challenge_rating:
        results = [m for m in results if str(m.get("challenge_rating")) == str(challenge_rating)]
    return {
        "total": len(results),
        "monsters": results[:limit],
        **provenance,
    }


@app.get("/api/v1/compendium/animals")
def get_compendium_animals(
    q: Optional[str] = Query(None, description="Search query for animal name"),
    limit: int = Query(50, ge=1, le=400)
):
    results = all_animals
    if q:
        query = q.lower()
        results = [a for a in results if query in a.get("name", "").lower()]
    return {
        "total": len(results),
        "animals": results[:limit]
    }


@app.get("/api/v1/compendium/magic-items")
def get_compendium_magic_items(
    q: Optional[str] = Query(None, description="Search query for magic item name"),
    category: Optional[str] = Query(None, description="Filter by item category"),
    rarity: Optional[str] = Query(None, description="Filter by rarity"),
    limit: int = Query(50, ge=1, le=400)
):
    results = all_magic_items
    if q:
        query = q.lower()
        results = [i for i in results if query in i.get("name", "").lower() or query in i.get("description", "").lower()]
    if category:
        results = [i for i in results if i.get("category", "").lower() == category.lower()]
    if rarity:
        results = [i for i in results if i.get("rarity", "").lower() == rarity.lower()]
    return {
        "total": len(results),
        "magic_items": results[:limit]
    }


@app.get("/api/v1/compendium/feats")
def get_compendium_feats(
    q: Optional[str] = Query(None, description="Search query for feat name"),
    category: Optional[str] = Query(None, description="Filter by feat category"),
    limit: int = Query(50, ge=1, le=100)
):
    results = all_feats
    if q:
        query = q.lower()
        results = [f for f in results if query in f.get("name", "").lower() or query in f.get("description", "").lower()]
    if category:
        results = [f for f in results if f.get("category", "").lower() == category.lower()]
    return {
        "total": len(results),
        "feats": results[:limit]
    }


@app.get("/api/v1/compendium/origins")
def get_compendium_origins(
    q: Optional[str] = Query(None, description="Search query for background/species name"),
    kind: Optional[str] = Query(None, description="Filter by kind (background/species)"),
    limit: int = Query(50, ge=1, le=100)
):
    results = all_origins
    if q:
        query = q.lower()
        results = [o for o in results if query in o.get("name", "").lower() or query in o.get("description", "").lower()]
    if kind:
        results = [o for o in results if o.get("kind") == kind.lower()]
    return {
        "total": len(results),
        "origins": results[:limit]
    }


@app.get("/api/v1/compendium/glossary")
def get_compendium_glossary(
    q: Optional[str] = Query(None, description="Search query for rules term"),
    tag: Optional[str] = Query(None, description="Filter by rule family tag"),
    limit: int = Query(50, ge=1, le=400)
):
    results = all_glossary_terms
    if q:
        query = q.lower()
        results = [t for t in results if query in t.get("term", "").lower() or query in t.get("definition", "").lower()]
    if tag:
        results = [t for t in results if t.get("tag", "").lower() == tag.lower()]
    return {
        "total": len(results),
        "glossary": results[:limit]
    }


# --- Authoritative Rules Engine Proxy (/api/v1/engine/*) -------------------
# The browser talks only to this orchestrator; all dice math resolves in the
# Rust vtt-core engine via vtt-server (see routing/engine_client.py).

class EngineSessionRequest(BaseModel):
    campaign_id: str = "aethertable-default"
    session_name: str = "Live Tabletop Session"


class EngineAttackRequest(BaseModel):
    """Trust-inversion lockdown: clients may ONLY reference entities by id.
    Attack bonuses, ACs and damage dice live in server-side stat blocks and
    are resolved inside vtt-core — any client-supplied math is refused here
    before it can even reach the engine."""
    session_id: str
    attacker_id: str
    target_id: str
    action_index: int = 0
    # SRD inspiration spend (engine iteration 56): burn the attacker's held
    # point for Advantage on THIS roll. Forwarded verbatim — the ENGINE decides
    # atomically whether a point is actually consumed; the gateway adds nothing.
    spend_inspiration: bool = False

    class Config:
        extra = "forbid"


class EngineCheckRequest(BaseModel):
    modifier: int
    dc: int
    cost_margin: int = 3
    # Same iteration-56 flag as attack: session-grounded rolls may burn the
    # checker's held point for Advantage. Omitted -> legacy straight roll.
    spend_inspiration: bool = False


class EngineSaveRequest(BaseModel):
    save_modifier: int
    dc: int
    ability: Optional[str] = None
    advantage: bool = False
    disadvantage: bool = False
    conditions: List[str] = Field(default_factory=list)
    # Saves ground inspiration spend the same way (Help tokens are check-only).
    spend_inspiration: bool = False


class EngineConcentrationRequest(BaseModel):
    con_modifier: int
    damage_taken: int


class EngineDeathSaveRequest(BaseModel):
    """Server-authoritative death saves: only the entity reference travels."""
    session_id: str
    entity_id: str

    class Config:
        extra = "forbid"


class EngineMapGenerateRequest(BaseModel):
    width: int = Field(16, ge=4, le=64)
    height: int = Field(12, ge=4, le=64)
    seed: Optional[int] = None
    theme: str = "dungeon"


async def _engine_call(coro) -> Any:
    try:
        return await coro
    except EngineUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except EngineRejectedError as exc:
        # Surface the engine's authoritative rejection verbatim (404/409/422).
        try:
            detail = json.loads(exc.detail)
        except (TypeError, ValueError):
            detail = exc.detail
        raise HTTPException(status_code=exc.status_code, detail=detail)


# --- Proxy identity contract (audit remediation) -----------------------------
# EVERY browser-facing /api/v1/engine/* proxy route resolves its caller via
# _require_auth (Authorization Bearer header first, legacy ?token= fallback) and
# forwards the VERIFIED identity (_caller_actor) so the engine's RBAC authorizes
# the real participant. There is deliberately NO optional-token back-compat path:
# an anonymous request is a 401 with an honest error body and never reaches the
# engine under the orchestrator-service principal. Service-principal forwarding
# still exists only for orchestrator-INTERNAL calls that bypass these routes and
# speak to the engine directly via routing.engine_client (campaign autosave,
# safety rewind, lobby launch, character deploy).

@app.post("/api/v1/engine/session")
async def engine_create_session(
    req: EngineSessionRequest, token: str = Depends(_require_auth)
):
    return await _engine_call(
        engine_client.create_session(req.campaign_id, req.session_name, _caller_actor(token))
    )


@app.post("/api/v1/engine/attack")
async def engine_resolve_attack(
    req: EngineAttackRequest, token: str = Depends(_require_auth)
):
    # Reference-only payload: ids + optional action index. No math crosses
    # this boundary in either direction — the engine owns every modifier.
    action = {
        "attacker_id": engine_client._coerce_uuid(req.attacker_id),
        "target_id": engine_client._coerce_uuid(req.target_id),
        "action_index": req.action_index,
        "spend_inspiration": req.spend_inspiration,
    }
    return await _engine_call(
        engine_client.resolve_attack(
            req.session_id, action, actor=_caller_actor(token)
        )
    )


@app.post("/api/v1/engine/check")
async def engine_resolve_check(
    req: EngineCheckRequest, token: str = Depends(_require_auth)
):
    return await _engine_call(
        engine_client.resolve_check(req.model_dump(), actor=_caller_actor(token))
    )


@app.post("/api/v1/engine/save")
async def engine_resolve_save(
    req: EngineSaveRequest, token: str = Depends(_require_auth)
):
    payload = req.model_dump()
    if payload["ability"]:
        # Engine Ability enum expects SCREAMING_SNAKE_CASE ("DEXTERITY").
        payload["ability"] = payload["ability"].upper()
    return await _engine_call(
        engine_client.resolve_save(payload, actor=_caller_actor(token))
    )


@app.post("/api/v1/engine/concentration")
async def engine_resolve_concentration(
    req: EngineConcentrationRequest, token: str = Depends(_require_auth)
):
    return await _engine_call(
        engine_client.resolve_concentration(req.model_dump(), actor=_caller_actor(token))
    )


@app.post("/api/v1/engine/death-save")
async def engine_resolve_death_save(
    req: EngineDeathSaveRequest, token: str = Depends(_require_auth)
):
    return await _engine_call(
        engine_client.resolve_death_save(
            req.session_id, req.entity_id, actor=_caller_actor(token)
        )
    )


@app.post("/api/v1/engine/map/generate")
async def engine_generate_map(
    req: EngineMapGenerateRequest, token: str = Depends(_require_auth)
):
    # Translate to the engine's RoomDescriptor contract
    # ({room_id, x, y, width, height, theme}); tiles come back as a
    # Vec<Vec<u8>> grid (0 floor, 1 wall, 2 door, 3 altar, 4 chest).
    room_desc = {
        "room_id": 1,
        "x": 0,
        "y": 0,
        "width": req.width,
        "height": req.height,
        "theme": req.theme,
    }
    return await _engine_call(
        engine_client.generate_map(
            {"room_desc": room_desc, "seed": req.seed}, actor=_caller_actor(token)
        )
    )


@app.get("/api/v1/engine/rooms/{room_id}/presence")
async def engine_room_presence(room_id: str, token: str = Depends(_require_auth)):
    return await _engine_call(
        engine_client.engine_request(
            "GET",
            f"/api/v1/rooms/{room_id}/presence",
            actor=_caller_actor(token),
        )
    )


@app.get("/api/v1/engine/metrics")
async def engine_metrics(token: str = Depends(_require_auth)):
    """Read-only telemetry proxy to the engine's public GET /metrics.

    Audit remediation: this is a BROWSER-FACING gateway route, so the caller
    must present a valid HMAC session token (header or ?token=) — the dashboard
    is attributable like every other proxy. The hop itself stays service-
    mediated: vtt-server exposes /metrics on PUBLIC_PATHS
    (crates/vtt-server/src/auth.rs), so NO actor identity is forwarded and no
    actor token is minted for the read; it never mutates state. Returns the
    engine's honest counters verbatim (MCR, action tallies, auditor rejection
    rate, persistence failures); the gateway adds nothing and fabricates
    nothing. An unreachable engine maps to 502 so clients can render an
    explicit degraded state.
    """
    # Verify the caller's signature/expiry before any engine traffic —
    # presence alone in the dependency is not enough for an attributable read.
    _caller_actor(token)
    raw = await _engine_call(engine_client.engine_request("GET", "/metrics"))
    # Whitelist projection: only counters the dashboard is allowed to show.
    keys = (
        "mechanical_compliance_rate_pct",
        "total_actions",
        "valid_actions",
        "rejected_actions",
        "auditor_total",
        "auditor_rejection_rate_pct",
        "persistence_failures",
        "target_sla_ms",
    )
    return {k: raw[k] for k in keys if k in raw}


# --- Engine session durability bridge ----------------------------------------
# vtt-server holds live sessions in memory; these endpoints snapshot them to
# PostgreSQL (or the memory fallback) and hydrate them back, so an engine
# restart no longer loses the world.

class EnginePersistRequest(BaseModel):
    session_id: str
    # DEPRECATED and ignored: ownership is now taken from the VERIFIED session
    # token, never from a client-supplied body field (any caller could claim
    # any owner). Kept in the schema so old payloads still validate.
    owner_user_id: Optional[str] = None


async def _durability_bridge_gate(actor: Dict[str, Any], session_id: str) -> None:
    """Authorization for the durability bridge (persist/hydrate).

    These routes bind whole-session snapshots to storage and overwrite live
    engine state on restore — not bystander operations. The model mirrors the
    x-card rewind gate exactly:

    * gm/admin tokens may bridge any session.
    * Any other authenticated caller must be a member of a lobby bound to that
      engine session (the gateway's own roster data; see
      ``_caller_is_session_participant``).
    * Sessions with NO lobby binding fail CLOSED to staff only, because there
      is no roster proving a player's standing.
    """
    if actor.get("role", "") in ("gm", "admin"):
        return
    if await _caller_is_session_participant(actor["user_id"], session_id):
        return
    raise HTTPException(
        status_code=403,
        detail=(
            "BRIDGE_FORBIDDEN: only GMs or members of a lobby bound to this "
            f"session may persist or restore it ({session_id})."
        ),
    )


@app.post("/api/v1/engine-session/persist")
async def persist_engine_session(req: EnginePersistRequest, token: str = Depends(_require_auth)):
    # Auth + authz run BEFORE the engine fetch so an unauthorized caller gets
    # an honest 401/403 even when the engine is down.
    actor = _caller_actor(token)
    await _durability_bridge_gate(actor, req.session_id)
    raw = await _engine_call(
        engine_client.engine_request("GET", f"/api/v1/sessions/{req.session_id}")
    )
    # Ownership is recorded from the verified identity, never the request body.
    await storage_backend.save_engine_snapshot(req.session_id, actor["user_id"], raw)
    return {
        "status": "PERSISTED",
        "session_id": req.session_id,
        "entities": len(raw.get("entities", {})),
        "events": len(raw.get("ledger", {}).get("events", [])),
    }


class EngineHydrateRequest(BaseModel):
    session_id: str


@app.post("/api/v1/engine-session/hydrate")
async def hydrate_engine_session(req: EngineHydrateRequest, token: str = Depends(_require_auth)):
    actor = _caller_actor(token)
    await _durability_bridge_gate(actor, req.session_id)
    snapshot = await storage_backend.load_engine_snapshot(req.session_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="No persisted snapshot for this session")
    result = await _engine_call(
        engine_client.engine_request(
            "PUT", f"/api/v1/sessions/{req.session_id}/restore", snapshot
        )
    )
    return {"status": "HYDRATED", "engine_response": result}


# --- Lobbies -------------------------------------------------------------------

class LobbyCreateRequest(BaseModel):
    """Table creation body.

    Iteration 71: GOALS.md P2's wizard picks the table's edition, starting
    level and intended party size; those choices must persist server-side so
    host launch can hand the engine the same session it promised the party.
    ``rule_version`` mirrors the engine's RuleVersion parse (iteration 34) —
    unknown editions are a 422, not a silent fallback — while level/party
    bounds keep obviously-wrong wizard input out of storage.
    """

    name: str = "Untitled Table"
    rule_version: Optional[Literal["srd_5_1", "srd_5_2"]] = None
    starting_level: int = Field(default=1, ge=1, le=20)
    party_size: int = Field(default=4, ge=2, le=8)


class LobbyJoinRequest(BaseModel):
    invite_code: str


class LobbyReadyRequest(BaseModel):
    ready: bool


class LobbyCharacterRequest(BaseModel):
    character_id: str


_INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _invite_code() -> str:
    return "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(6))


async def _profile_of(user_id: str) -> Dict[str, Any]:
    record = await storage_backend.get_user_by_id(user_id)
    return public_user(record) if record else {"id": user_id, "displayName": user_id, "role": "player"}


@app.post("/api/v1/lobbies")
async def create_lobby(req: LobbyCreateRequest, token: str = Depends(_require_auth)):
    user_id = _require_user_id(token)
    profile = await _profile_of(user_id)
    return await storage_backend.create_lobby(
        user_id, profile.get("displayName", user_id), req.name.strip() or "Untitled Table",
        _invite_code(),
        rule_version=req.rule_version,
        starting_level=req.starting_level,
        party_size=req.party_size,
    )


@app.get("/api/v1/lobbies/mine")
async def my_lobbies(token: str = Depends(_require_auth)):
    user_id = _require_user_id(token)
    return {"lobbies": await storage_backend.list_lobbies_for_user(user_id)}


@app.post("/api/v1/lobbies/{lobby_id}/join")
async def join_lobby(lobby_id: str, req: LobbyJoinRequest, token: str = Depends(_require_auth)):
    user_id = _require_user_id(token)
    lobby = await storage_backend.get_lobby(lobby_id)
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    if req.invite_code.strip().upper() != lobby["invite_code"].upper():
        raise HTTPException(status_code=403, detail="Invalid invite code")
    profile = await _profile_of(user_id)
    await storage_backend.join_lobby(
        lobby_id, user_id, profile.get("displayName", user_id), profile.get("role", "player")
    )
    return await storage_backend.get_lobby(lobby_id)


@app.get("/api/v1/lobbies/{lobby_id}")
async def get_lobby(lobby_id: str, token: str = Depends(_require_auth)):
    """Reads ONE lobby — but only for its members or staff.

    The lobby record carries the invite_code, and the invite code is the sole
    gate on join_lobby; lobby membership in turn authorizes x-card rewind,
    durability-bridge access and agent turns. Handing any authenticated user
    any lobby's full record therefore leaked three downstream authorization
    gates at once. Non-members get the same 403 whether the id exists or not,
    so this route cannot be probed as an existence oracle for other tables.
    """
    actor = _caller_actor(token)
    lobby = await storage_backend.get_lobby(lobby_id)
    is_member = lobby is not None and any(
        member["user_id"] == actor["user_id"] for member in lobby["members"]
    )
    if not is_member and actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(status_code=403, detail="Lobby not accessible")
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    return lobby


@app.post("/api/v1/lobbies/{lobby_id}/ready")
async def set_lobby_ready(lobby_id: str, req: LobbyReadyRequest,
                          token: str = Depends(_require_auth)):
    """Toggles the CALLING member's ready flag.

    Membership-gated like GET /lobbies/{id}: a member may only flip their own
    flag, never another seat's. Returns the full refreshed roster so clients
    can render live synchrony from one response.
    """
    user_id = _require_user_id(token)
    lobby = await storage_backend.get_lobby(lobby_id)
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    if not any(m["user_id"] == user_id for m in lobby["members"]):
        raise HTTPException(status_code=403, detail="Lobby not accessible")
    updated = await storage_backend.set_member_ready(lobby_id, user_id, req.ready)
    if updated is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    return updated


@app.post("/api/v1/lobbies/{lobby_id}/character")
async def set_lobby_character(lobby_id: str, req: LobbyCharacterRequest,
                              token: str = Depends(_require_auth)):
    """Binds one of the CALLING member's own characters to their lobby seat.

    Ownership reuses the player_characters checks deploy_character enforces:
    a foreign (but real) sheet is a 403, an unknown id a 404 — so the route
    cannot probe other players' character ids. A successful bind leaves any
    prior binding replaced; a refused bind leaves it untouched.
    """
    user_id = _require_user_id(token)
    lobby = await storage_backend.get_lobby(lobby_id)
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    if not any(m["user_id"] == user_id for m in lobby["members"]):
        raise HTTPException(status_code=403, detail="Lobby not accessible")
    record = await storage_backend.get_character(req.character_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Character not found")
    if record["owner_user_id"] != user_id:
        raise HTTPException(status_code=403, detail="You do not own this character")
    updated = await storage_backend.set_member_character(
        lobby_id, user_id, req.character_id
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    return updated


class LobbyLaunchRequest(BaseModel):
    force: bool = False


def _launch_session_payload(lobby: Dict[str, Any]) -> Dict[str, Any]:
    """Engine session-creation body for a lobby launch.

    The lobby's edition choice rides along so the created session inherits
    it (iteration 34 persists ``rule_version`` per engine session). When the
    host never recorded a preference the key is OMITTED entirely, leaving the
    engine's own VTT_DEFAULT_RULE_VERSION in charge — the exact payload shape
    legacy callers have always produced.
    """
    payload: Dict[str, Any] = {
        "campaign_id": "00000000-0000-0000-0000-00000000000a",
        "session_name": f"Lobby {lobby['name']}",
    }
    rule_version = lobby.get("rule_version")
    if rule_version:
        payload["rule_version"] = rule_version
    return payload


@app.post("/api/v1/lobbies/{lobby_id}/launch")
async def launch_lobby(lobby_id: str,
                       req: Optional[LobbyLaunchRequest] = None,
                       token: str = Depends(_require_auth)):
    """Host-only launch, gated on party readiness.

    While ANY member has not readied up the host gets 409 MEMBERS_NOT_READY
    with the unready seats listed by id AND display name — an honest refusal,
    not a silent partial-party start. The host alone may pass {"force": true}
    to override (the body is optional so existing callers that post without
    one keep working).
    """
    user_id = _require_user_id(token)
    lobby = await storage_backend.get_lobby(lobby_id)
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    if lobby["host_user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the host can launch")
    force = bool(req.force) if req is not None else False
    if not force:
        unready = [
            {"user_id": m["user_id"], "display_name": m["display_name"]}
            for m in lobby["members"] if not m.get("ready", False)
        ]
        if unready:
            names = ", ".join(m["display_name"] or m["user_id"] for m in unready)
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "MEMBERS_NOT_READY",
                    "message": f"Cannot launch: members not ready: {names}",
                    "unready_members": unready,
                },
            )
    created = await _engine_call(
        engine_client.engine_request(
            "POST",
            "/api/v1/sessions",
            _launch_session_payload(lobby),
        )
    )
    session_id = created["session_id"]
    await storage_backend.set_lobby_session(lobby_id, session_id)
    refreshed = await storage_backend.get_lobby(lobby_id)
    return {"status": "LAUNCHED", "session_id": session_id, "lobby": refreshed}


# --- Characters ------------------------------------------------------------------

class CharacterCreateRequest(BaseModel):
    name: str
    character_class: str = "fighter"
    level: int = Field(1, ge=1, le=20)
    race: str = "Human"
    background: str = "Soldier"
    alignment: str = "Neutral Good"
    abilities: Dict[str, int] = Field(
        default_factory=lambda: {"STR": 16, "DEX": 14, "CON": 14, "INT": 10, "WIS": 12, "CHA": 8}
    )
    hp: int = 12
    ac: int = 16
    speed: int = 30
    features: List[str] = Field(default_factory=list)
    spells: List[str] = Field(default_factory=list)


@app.post("/api/v1/characters")
async def create_character(req: CharacterCreateRequest, token: str = Depends(_require_auth)):
    user_id = _require_user_id(token)
    return await storage_backend.create_character(user_id, req.model_dump())


@app.get("/api/v1/characters")
async def list_characters(token: str = Depends(_require_auth)):
    user_id = _require_user_id(token)
    return {"characters": await storage_backend.list_characters(user_id)}


@app.get("/api/v1/characters/{character_id}")
async def get_character(character_id: str, token: str = Depends(_require_auth)):
    """Reads ONE character — but only for its owner.

    Ownership is enforced here (not just token validity): a valid token
    belonging to someone else gets the same 404 as a nonexistent id, so the
    route can't be probed as an existence oracle for other players' sheets.
    """
    user_id = _require_user_id(token)
    record = await storage_backend.get_character(character_id)
    if record is None or record.get("owner_user_id") != user_id:
        raise HTTPException(status_code=404, detail="Character not found")
    return record


@app.delete("/api/v1/characters/{character_id}")
async def delete_character(character_id: str, token: str = Depends(_require_auth)):
    # Migrated off ``token: str = Query(...)`` — header-only clients failed
    # validation, and the query string leaked tokens into logs/history.
    user_id = _require_user_id(token)
    ok = await storage_backend.delete_character(character_id, user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Character not found for this owner")
    return {"status": "DELETED"}


_CLASS_DAMAGE = {
    "fighter": ("1d8", True), "barbarian": ("1d12", True), "ranger": ("1d8", True),
    "paladin": ("1d8", True), "rogue": ("1d6", False), "bard": ("1d6", False),
    "wizard": ("1d10", False), "sorcerer": ("1d10", False), "warlock": ("1d10", False),
    "druid": ("1d8", False), "cleric": ("1d8", True), "monk": ("1d6", True),
}


class CharacterDeployRequest(BaseModel):
    session_id: str
    x: float = 5.0
    y: float = 5.0


def _derive_class_attack(level: int, klass: str, abilities: Dict[str, Any]) -> Dict[str, Any]:
    """Sole surviving Python-side stat derivation on the deploy path — see the
    ARCHITECTURE VIOLATION note in deploy_character for why it cannot live in
    vtt-core yet. Kept as one named helper (not inline math) so the follow-up
    Rust iteration deletes exactly this."""
    proficiency = 2 + (level - 1) // 4
    str_mod = (int(abilities.get("STR", 10)) - 10) // 2
    dex_mod = (int(abilities.get("DEX", 10)) - 10) // 2
    dmg_dice, uses_str = _CLASS_DAMAGE.get(klass, ("1d6", True))
    ability_mod = str_mod if uses_str else dex_mod
    attack_bonus = proficiency + ability_mod
    return {
        "name": f"{klass.title()} Strike",
        "attack_bonus": attack_bonus,
        "damage_expression": f"{dmg_dice}{'+' + str(ability_mod) if ability_mod >= 0 else str(ability_mod)}",
        "damage_type": "slashing" if uses_str else "fire",
    }


@app.post("/api/v1/characters/{character_id}/deploy")
async def deploy_character(character_id: str, req: CharacterDeployRequest, token: str = Depends(_require_auth)):
    """Materializes a stored character as an OWNED engine entity — RBAC binds
    it to the deploying player (owner_player_id), so only they may act with it."""
    user_id = _require_user_id(token)
    record = await storage_backend.get_character(character_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Character not found")
    if record["owner_user_id"] != user_id:
        raise HTTPException(status_code=403, detail="You do not own this character")

    data = record["data"]
    abilities = data.get("abilities", {})

    klass = record.get("character_class", "fighter").lower()

    # ARCHITECTURE VIOLATION (disclosed, minimized): per the engine's own
    # contract ("Attack bonuses and damage dice live HERE — on the
    # server-side authoritative stat block — never in client requests",
    # vtt-core state.rs AttackAction) this derivation belongs in vtt-core.
    # It cannot move there yet: the Rust spawn route accepts a fully-formed
    # EntityState and has no class-based attack-derivation entry point
    # (modifier_graph computes spell DCs/AC only), so the gateway must seed
    # the stat block. This is now the SINGLE place Python math survives on
    # the deploy path; everything else is copied verbatim from the stored
    # record. TODO(crates follow-up): add an EntitySpec-with-class input to
    # AddEntityReq (or a /entities/derive-stats endpoint) so vtt-core derives
    # attack_bonus/damage from level+abilities, then delete this helper.
    attack = _derive_class_attack(level=int(record.get("level", 1)),
                                  klass=klass, abilities=abilities)

    # Roll20 imports persist speed as None when movement text cannot be
    # reduced to feet (the import warns and refuses to fabricate a default).
    # Deploy must tolerate that: fall back to the create-route default of 30
    # rather than raising float(None) -> unhandled 500 on every deploy.
    speed_raw = data.get("speed", 30)
    if isinstance(speed_raw, bool) or not isinstance(speed_raw, (int, float)) \
            or not math.isfinite(float(speed_raw)):
        speed_feet = 30.0
    else:
        speed_feet = float(speed_raw)

    import uuid as _uuid
    entity_id = engine_client._coerce_uuid(f"{record['character_id']}")
    entity = {
        "id": entity_id,
        "compendium_id": f"player_{klass}",
        "name": record["name"],
        "is_player": True,
        "owner_player_id": user_id,
        "current_hp": int(data.get("hp", 12)),
        "max_hp": int(data.get("hp", 12)),
        "temp_hp": 0,
        "ac": int(data.get("ac", 14)),
        "speed_feet": speed_feet,
        "position": [req.x, req.y, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {
            "strength": int(abilities.get("STR", 10)),
            "dexterity": int(abilities.get("DEX", 10)),
            "constitution": int(abilities.get("CON", 10)),
            "intelligence": int(abilities.get("INT", 10)),
            "wisdom": int(abilities.get("WIS", 10)),
            "charisma": int(abilities.get("CHA", 10)),
        },
        "conditions": [],
        "action_budget": {"action": True, "bonus_action": True, "reaction": True,
                          "movement_remaining_feet": speed_feet,
                          "free_object_interaction": True},
        "spell_slots_remaining": {},
        "attacks": [attack],
        "resistances": [],
        "vulnerabilities": [],
        "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": True,
        "is_dead": False,
        "is_visible": True,
        "ingress": {
            "entity_id": entity_id,
            "ingress_type": "SPAWN_EVENT",
            "source_point": [0.0, 0.0, 0.0],
            "target_point": [req.x, req.y, 0.0],
            "verified": False,
        },
    }
    result = await _engine_call(
        engine_client.engine_request(
            "POST", f"/api/v1/sessions/{req.session_id}/entities", entity
        )
    )
    return {"status": "DEPLOYED", "entity_id": result.get("entity_id"),
            "owner_player_id": user_id}


# --- Engine action proxies ---------------------------------------------------------

class SpawnAbilityScores(BaseModel):
    """Mirrors vtt_core::types::AbilityScores — exactly six scores."""

    model_config = ConfigDict(extra="forbid")
    strength: int = Field(ge=1, le=30)
    dexterity: int = Field(ge=1, le=30)
    constitution: int = Field(ge=1, le=30)
    intelligence: int = Field(ge=1, le=30)
    wisdom: int = Field(ge=1, le=30)
    charisma: int = Field(ge=1, le=30)


class SpawnActionBudget(BaseModel):
    """Mirrors vtt_core::types::ActionBudget (all fields required)."""

    model_config = ConfigDict(extra="forbid")
    action: bool
    bonus_action: bool
    reaction: bool
    movement_remaining_feet: float = Field(ge=0)
    free_object_interaction: bool


# F10 damage-expression grammar: terms are dice ("NdS") or integer constants,
# joined by +/-, optional leading sign, whitespace allowed between terms.
# Die sides restricted to the physical/polyhedral set; total dice across all
# terms <= 40 (matches vtt-core's MAX_SPELL_DICE_COUNT homebrew guard).
_DAMAGE_EXPR_RE = re.compile(
    r"^[+-]?\s*(\d*d\d+|\d+)(\s*[+-]\s*(\d*d\d+|\d+))*$"
)
_DIE_SIDES_ALLOWED = {4, 6, 8, 10, 12, 20, 100}
_MAX_TOTAL_DICE = 40
_MAX_CONSTANT_TERM = 100


def _validate_damage_expression(value: str) -> str:
    if not isinstance(value, str) or not _DAMAGE_EXPR_RE.fullmatch(value.strip()):
        raise ValueError(
            "damage_expression must be a dice expression like '2d6+3' "
            f"(die sides in {sorted(_DIE_SIDES_ALLOWED)}, at most "
            f"{_MAX_TOTAL_DICE} dice, constant terms within +-{_MAX_CONSTANT_TERM})"
        )
    total_dice = 0
    for count_str, sides_str in re.findall(r"(\d*)d(\d+)", value):
        sides = int(sides_str)
        if sides not in _DIE_SIDES_ALLOWED:
            raise ValueError(f"d{count_str or ''}{sides}: die side must be one of d4/6/8/10/12/20/100")
        total_dice += int(count_str) if count_str else 1
        if total_dice > _MAX_TOTAL_DICE:
            raise ValueError(
                f"damage_expression exceeds {_MAX_TOTAL_DICE} total dice"
            )
    for term in re.findall(r"(?:^|[+-])\s*(\d+)(?![d\d])", value):
        # Constants only — the negative lookahead above excludes die counts/sides.
        if int(term) > _MAX_CONSTANT_TERM:
            raise ValueError(
                f"constant term {term} exceeds +-{_MAX_CONSTANT_TERM}"
            )
    return value


class SpawnAttackAction(BaseModel):
    """Mirrors vtt_core::state::AttackAction. Attack bonuses and damage dice
    live HERE on the server-side stat block; clients reference them by index.
    The gateway does not compute them (see deploy_character) but it refuses to
    carry anything outside this shape."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    attack_bonus: int = Field(ge=-5, le=30)
    # F10: the engine's attack route rolls this expression UNCLAMPED (rules.rs
    # resolve_attack -> dice::roll_expression; clamp_damage_expression covers
    # only the spell path), and its dice parser allows constant terms up to
    # +-1e9 each — so "9999d9999" or "2000000000+0" minted at spawn would make
    # the entity one-shot anything. The grammar below (see
    # _validate_damage_expression) admits every expression observed in real
    # content (compendium monsters, SRD spells, weapon tables,
    # _derive_class_attack) while refusing absurd constants, unknown die
    # shapes, and non-dice syntax.
    damage_expression: str

    @field_validator("damage_expression")
    @classmethod
    def _check_damage_expression(cls, v: str) -> str:
        return _validate_damage_expression(v)
    damage_type: Literal[
        "slashing", "piercing", "bludgeoning", "fire", "cold", "lightning",
        "thunder", "poison", "acid", "psychic", "radiant", "necrotic", "force",
    ]
    light: bool = False


class EngineSpawnEntity(BaseModel):
    """Strict mirror of vtt_core::EntityState as consumed by the engine's
    flattened AddEntityReq (POST /api/v1/sessions/{id}/entities).

    This closes the last untyped trust-inversion hole in the engine proxies:
    the attack route already enforces ids-only ("clients may ONLY reference
    entities by id"), and deny-extra here makes smuggled client math on SPAWN
    structurally impossible at the gateway too — an unknown field is a 422,
    never silently forwarded to the engine.

    Optional-with-default fields match the Rust serde defaults so legacy
    callers that omit them still deserialize identically on both sides.

    F10 magnitude bounds (iteration 15): the engine accepts these stats
    verbatim and never re-validates magnitudes server-side, so unbounded ints
    here meant a caller could mint AC 2^31-1 / HP 2^31-1 — mechanically
    unhittable and unkillable. The caps are set far above every value in the
    real content corpus (compendium srd_5_1/srd_5_2 monsters top out at AC 25,
    HP ~700) with generous headroom for homebrew.
    """

    model_config = ConfigDict(extra="forbid")

    # Generous headroom over the observed corpus (AC 5..25): the SRD's printed
    # maximum for a creature is 30 (Tarrasque-adjacent homebrew included).
    id: str = Field(min_length=1)
    compendium_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=120)
    is_player: bool
    owner_player_id: Optional[str] = None
    current_hp: int = Field(ge=0, le=1000)
    max_hp: int = Field(ge=0, le=1000)
    temp_hp: int = Field(ge=0, le=100)
    ac: int = Field(ge=0, le=30)
    speed_feet: float = Field(ge=0.0, le=200.0, allow_inf_nan=False)
    position: Tuple[float, float, float] = (2.5, 2.5, 0.0)
    zone_id: str = "Zone_Default"
    abilities: SpawnAbilityScores
    conditions: List[Union[str, Tuple[str, int]]] = []
    action_budget: SpawnActionBudget
    spell_slots_remaining: Dict[Annotated[int, Field(ge=0, le=9)],
                                Annotated[int, Field(ge=0, le=50)]] = {}
    attacks: List[SpawnAttackAction] = []
    resistances: List[str] = []
    vulnerabilities: List[str] = []
    immunities: List[str] = []
    inventory: Dict[str, Any]
    is_conscious: bool
    is_dead: bool
    is_visible: bool


class EngineIngressEvent(BaseModel):
    """Strict mirror of vtt_core::types::IngressEvent (types.rs) — the typed
    replacement for the old untyped ``ingress: Dict[str, Any]`` blob that was
    forwarded verbatim to the engine. extra="forbid" makes smuggled payload
    fields structurally impossible, matching every other engine proxy."""

    model_config = ConfigDict(extra="forbid")

    entity_id: str
    # Mirrors the Rust enum's SCREAMING_SNAKE_CASE serde rename (types.rs
    # IngressType) — the casing the engine's own integration tests use.
    ingress_type: Literal[
        "TELEPORTATION", "PORTAL_DOOR", "STEALTH_REVEAL", "BURROWING", "SPAWN_EVENT",
    ]
    source_point: Tuple[float, float, float]
    target_point: Tuple[float, float, float]
    verified: bool

    @field_validator("source_point", "target_point")
    @classmethod
    def _finite_and_bounded(cls, v: Tuple[float, float, float]) -> Tuple[float, float, float]:
        for coord in v:
            if not math.isfinite(coord) or abs(coord) > 1000.0:
                raise ValueError(
                    "ingress coordinates must be finite and within +-1000.0"
                )
        return v


class EngineSpawnRequest(BaseModel):
    session_id: str
    entity: EngineSpawnEntity
    ingress: Optional[EngineIngressEvent] = None


class EngineCastSpellRequest(BaseModel):
    session_id: str
    caster_id: str
    target_id: Optional[str] = None
    spell: Dict[str, Any]
    # Default 0 means "unspecified": the engine normalizes it to the spell's
    # own level (cantrips included). An EXPLICIT level below the spell's level
    # is rejected by the engine with HTTP 422 INVALID_SLOT_LEVEL — the gateway
    # must not fabricate a slot level that would turn a refused under-level
    # request into an accidental valid one.
    cast_level: int = Field(0, ge=0, le=9)


class EngineMoveRequest(BaseModel):
    session_id: str
    entity_id: str
    x: float
    y: float
    z: float = 0.0


class EngineSessionActionRequest(BaseModel):
    session_id: str


class EngineDamageRequest(BaseModel):
    session_id: str
    target_id: str
    source_event_sequence: int


class EngineArmReactionRequest(BaseModel):
    session_id: str
    entity_id: str
    reaction_type: str


class EngineHealRequest(BaseModel):
    """Ids-only heal request mirroring the engine's HealEntityReq: the client
    names WHO gets how much — the engine clamps to max_hp server-side."""
    session_id: str
    entity_id: str
    amount: int = Field(ge=0)

    class Config:
        extra = "forbid"


class EngineRestRequest(BaseModel):
    session_id: str
    kind: Literal["short", "long"]

    class Config:
        extra = "forbid"


@app.post("/api/v1/engine/spawn")
async def engine_spawn(req: EngineSpawnRequest, token: str = Depends(_require_auth)):
    # JSON mode keeps tuples (position) as arrays on the wire; the engine's
    # Option<String> owner_player_id is omitted rather than nulled.
    payload = req.entity.model_dump(mode="json")
    if payload.get("owner_player_id") is None:
        payload.pop("owner_player_id")
    if req.ingress is not None:
        payload["ingress"] = req.ingress.model_dump(mode="json")
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/entities",
            payload,
            actor=_caller_actor(token),
        )
    )


class EncounterBalanceMonsterLine(BaseModel):
    """One roster line: a REAL compendium stat block and how many of it."""

    monster_id: str
    quantity: int = Field(1, ge=1, le=50)


class EncounterBalanceRequest(BaseModel):
    """Body for POST /api/v1/engine/encounter/balance.

    party_level 1..=20 and party_size 1..=8 are enforced by the schema so an
    out-of-range table never reaches the threshold math; an empty roster is
    rejected here too (422) — there is no such thing as a zero-monster fight.
    """

    party_level: int = Field(1, ge=1, le=20)
    party_size: int = Field(4, ge=1, le=8)
    monsters: List[EncounterBalanceMonsterLine] = Field(min_length=1)


def _balance_compendium():
    """Compendium lookup for name/xp projection (shared cache)."""
    from .compendium.encounter_balance import load_monster_compendium

    return load_monster_compendium()


@app.post("/api/v1/engine/encounter/balance")
async def engine_encounter_balance(
    req: EncounterBalanceRequest, token: str = Depends(_require_auth)
):
    """Server-side ENCOUNTER BALANCE preview for encounter composition.

    The EncounterBuilderView composes stat blocks client-side, but until now
    nothing told the GM the adjusted XP / difficulty tier BEFORE spawning. This
    route computes the verdict with the SAME shared DMG XP-threshold model the
    starter-adventure build audit uses
    (vtt_orchestrator.compendium.encounter_balance) — one source of truth, so
    the pre-spawn number and the shipped-adventure number can never drift.

    Pure math over the compendium: no engine call, no model spend — hence the
    default rate bucket (see _bucket_for_path). GM/admin only: balance data is
    the DM's information; revealing it to players leaks encounter design.

    Honest failures: an unknown monster_id 404s NAMING it (no invented stats,
    matching the compendium's "monsters are references" rule); an empty roster
    or out-of-range party bounds are 422 from the schema itself.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(status_code=403, detail="ENCOUNTER_BALANCE_GM_ONLY")

    try:
        balance = compute_encounter_balance(
            [line.model_dump() for line in req.monsters],
            party_level=req.party_level,
            party_size=req.party_size,
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"UNKNOWN_MONSTER_ID:{exc.args[0]}",
        ) from exc

    compendium = _balance_compendium()
    return {
        "raw_xp": balance["raw_xp"],
        "adjusted_xp": balance["adjusted_xp"],
        "multiplier": balance["multiplier"],
        # Wire contract spells the tiers lowercase; the shared model keeps its
        # historical UPPERCASE labels for shipped adventure payloads.
        "difficulty": balance["difficulty"].lower(),
        "per_monster": [
            {
                "monster_id": line.monster_id,
                "name": compendium[line.monster_id]["name"],
                "xp": int(compendium[line.monster_id]["xp"]),
                "quantity": line.quantity,
            }
            for line in req.monsters
        ],
    }


@app.post("/api/v1/engine/cast-spell")
async def engine_cast_spell(req: EngineCastSpellRequest, token: str = Depends(_require_auth)):
    actor = _caller_actor(token)
    payload: Dict[str, Any] = {
        "caster_id": engine_client._coerce_uuid(req.caster_id),
        "spell": req.spell,
        "cast_level": req.cast_level,
    }
    if req.target_id:
        payload["target_id"] = engine_client._coerce_uuid(req.target_id)
    return await _engine_call(
        engine_client.engine_request(
            "POST", f"/api/v1/sessions/{req.session_id}/action/cast-spell", payload, actor=actor
        )
    )


@app.post("/api/v1/engine/move")
async def engine_move(req: EngineMoveRequest, token: str = Depends(_require_auth)):
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/move",
            {
                "entity_id": engine_client._coerce_uuid(req.entity_id),
                "x": req.x, "y": req.y, "z": req.z,
            },
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/turn-next")
async def engine_turn_next(req: EngineSessionActionRequest, token: str = Depends(_require_auth)):
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/turn/next",
            {},
            actor=_caller_actor(token),
        )
    )


class EngineCombatActionRequest(BaseModel):
    """Body for the combat-lifecycle proxies: ONLY the session reference —
    initiative math is engine-owned and any client-supplied order is refused
    before it can reach the engine."""

    session_id: str

    class Config:
        extra = "forbid"


@app.post("/api/v1/engine/combat/begin")
async def engine_combat_begin(req: EngineCombatActionRequest, token: str = Depends(_require_auth)):
    """GM action: roll initiative and open combat on the authoritative engine.

    All initiative math (d20 + DEX, tie-breaks) is engine-owned; the gateway
    forwards only the session reference plus the caller's real identity so the
    engine's RBAC authorizes the actor. The response carries the full rolled
    order [{entity_id, name, dexterity, initiative_total}] verbatim."""
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{engine_client._coerce_uuid(req.session_id)}/combat/begin",
            {},
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/combat/end")
async def engine_combat_end(req: EngineCombatActionRequest, token: str = Depends(_require_auth)):
    """GM action: clear the initiative tracker. Ids-only payload, real-actor
    forwarding — same contract as every other mutating proxy."""
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{engine_client._coerce_uuid(req.session_id)}/combat/end",
            {},
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/damage")
async def engine_damage(req: EngineDamageRequest, token: str = Depends(_require_auth)):
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/damage",
            {
                "target_id": engine_client._coerce_uuid(req.target_id),
                "source_event_sequence": req.source_event_sequence,
            },
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/reactions/arm")
async def engine_arm_reaction(req: EngineArmReactionRequest, token: str = Depends(_require_auth)):
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/reactions/arm",
            {
                "entity_id": engine_client._coerce_uuid(req.entity_id),
                "reaction_type": req.reaction_type,
            },
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/heal")
async def engine_heal(req: EngineHealRequest, token: str = Depends(_require_auth)):
    # Healing math (deficit clamping, death-save wipe) is engine-owned; the
    # gateway forwards the caller identity so its RBAC checks entity ownership.
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/heal",
            {
                "entity_id": engine_client._coerce_uuid(req.entity_id),
                "amount": req.amount,
            },
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/rest")
async def engine_rest(req: EngineRestRequest, token: str = Depends(_require_auth)):
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/rest",
            {"kind": req.kind},
            actor=_caller_actor(token),
        )
    )


# --- Combat maneuver proxies ---------------------------------------------------
# Grapple / shove / dodge / dash / disengage / stabilize. Same contract as every
# other mutating proxy: ids-only Pydantic bodies with unknown fields refused,
# caller identity forwarded so the engine's RBAC authorizes the real actor, and
# the engine's verdict surfaced verbatim. The optional deterministic `seed` the
# engine accepts is deliberately NOT forwarded — a client-chosen seed would let
# callers pin their own rolls.


class EngineGrappleRequest(BaseModel):
    """Mirrors the engine's GrappleActionReq (deny_unknown_fields). The
    defender picks their contested skill; every modifier resolves server-side."""

    session_id: str
    attacker_id: str
    defender_id: str
    defender_skill: Literal["athletics", "acrobatics"]

    class Config:
        extra = "forbid"


class EngineShoveRequest(BaseModel):
    """Mirrors the engine's ShoveActionReq: attacker, defender, and the chosen
    effect on success ("prone" | "push_5ft"). No math crosses the wire."""

    session_id: str
    attacker_id: str
    defender_id: str
    shove_effect: Literal["prone", "push_5ft"]

    class Config:
        extra = "forbid"


class EngineEntityActionRequest(BaseModel):
    """Body for the self-targeting standard actions (dodge/dash/disengage):
    only WHO acts — the action economy is engine-owned."""

    session_id: str
    entity_id: str

    class Config:
        extra = "forbid"


class EngineStabilizeRequest(BaseModel):
    """Mirrors the engine's StabilizeActionReq: healer + dying target. Whether
    the target is saveable (dying, not dead, not already stabilized) and the
    Medicine DC are decided entirely by the engine."""

    session_id: str
    healer_id: str
    target_id: str

    class Config:
        extra = "forbid"


def _maneuver_proxy(engine_path_suffix: str, payload: Dict[str, Any], actor: Dict[str, str]):
    return _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{engine_client._coerce_uuid(payload.pop('session_id'))}"
            f"/action/{engine_path_suffix}",
            payload,
            actor=actor,
        )
    )


@app.post("/api/v1/engine/grapple")
async def engine_grapple(req: EngineGrappleRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "grapple",
        {
            "session_id": req.session_id,
            "attacker_id": engine_client._coerce_uuid(req.attacker_id),
            "defender_id": engine_client._coerce_uuid(req.defender_id),
            "defender_skill": req.defender_skill,
        },
        _caller_actor(token),
    )


@app.post("/api/v1/engine/shove")
async def engine_shove(req: EngineShoveRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "shove",
        {
            "session_id": req.session_id,
            "attacker_id": engine_client._coerce_uuid(req.attacker_id),
            "defender_id": engine_client._coerce_uuid(req.defender_id),
            "shove_effect": req.shove_effect,
        },
        _caller_actor(token),
    )


@app.post("/api/v1/engine/dodge")
async def engine_dodge(req: EngineEntityActionRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "dodge",
        {
            "session_id": req.session_id,
            "entity_id": engine_client._coerce_uuid(req.entity_id),
        },
        _caller_actor(token),
    )


@app.post("/api/v1/engine/dash")
async def engine_dash(req: EngineEntityActionRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "dash",
        {
            "session_id": req.session_id,
            "entity_id": engine_client._coerce_uuid(req.entity_id),
        },
        _caller_actor(token),
    )


@app.post("/api/v1/engine/disengage")
async def engine_disengage(req: EngineEntityActionRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "disengage",
        {
            "session_id": req.session_id,
            "entity_id": engine_client._coerce_uuid(req.entity_id),
        },
        _caller_actor(token),
    )


@app.post("/api/v1/engine/stabilize")
async def engine_stabilize(req: EngineStabilizeRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "stabilize",
        {
            "session_id": req.session_id,
            "healer_id": engine_client._coerce_uuid(req.healer_id),
            "target_id": engine_client._coerce_uuid(req.target_id),
        },
        _caller_actor(token),
    )


class EngineReadyActionRequest(BaseModel):
    """Mirrors the engine's ReadyActionReq (deny_unknown_fields): WHO readies,
    WHAT they hold, and the optional declared ``trigger``. The trigger uses the
    engine's shorthand strings ("enemy_enters_reach", "enemy_attacks",
    "turn_start"); anything else is forwarded verbatim and kept by the engine
    as a freeform string for GM adjudication. The field is named ``trigger`` —
    NOT ``trigger_hint`` — because the engine refuses unknown fields outright:
    forwarding under any other name 422s the whole request upstream."""

    session_id: str
    entity_id: str
    description: str
    trigger: Optional[str] = None

    class Config:
        extra = "forbid"


class EngineReadyReleaseRequest(BaseModel):
    """Mirrors the engine's ReleaseReadyReq (deny_unknown_fields): resolving a
    readied action spends the actor's Reaction, so only WHO releases is
    client-suppliable — everything mechanical is engine-owned."""

    session_id: str
    entity_id: str

    class Config:
        extra = "forbid"


@app.post("/api/v1/engine/ready")
async def engine_ready_action(req: EngineReadyActionRequest, token: str = Depends(_require_auth)):
    payload: Dict[str, Any] = {
        "session_id": req.session_id,
        "entity_id": engine_client._coerce_uuid(req.entity_id),
        "description": req.description,
    }
    if req.trigger:
        payload["trigger"] = req.trigger
    return await _maneuver_proxy("ready", payload, _caller_actor(token))


@app.post("/api/v1/engine/ready/release")
async def engine_ready_release(
    req: EngineReadyReleaseRequest, token: str = Depends(_require_auth)
):
    return await _maneuver_proxy(
        "ready/release",
        {
            "session_id": req.session_id,
            "entity_id": engine_client._coerce_uuid(req.entity_id),
        },
        _caller_actor(token),
    )


class EngineEscapeGrappleRequest(BaseModel):
    """Mirrors the engine's EscapeGrappleReq (deny_unknown_fields): the
    currently-grappled creature, WHOSE hold it is escaping (its STR sets the
    DC), and the escaper's choice of contested skill. The optional GM ``force``
    override passes through as-is — the engine re-checks privilege itself
    (ESCAPE_OVERRIDE_FORBIDDEN for non-GM callers), so no gateway second-guess.
    The optional deterministic `seed` is deliberately NOT forwardable."""

    session_id: str
    entity_id: str
    grappler_id: str
    skill: Literal["athletics", "acrobatics"]
    force: Optional[bool] = None

    class Config:
        extra = "forbid"


@app.post("/api/v1/engine/escape-grapple")
async def engine_escape_grapple(
    req: EngineEscapeGrappleRequest, token: str = Depends(_require_auth)
):
    payload: Dict[str, Any] = {
        "session_id": req.session_id,
        "entity_id": engine_client._coerce_uuid(req.entity_id),
        "grappler_id": engine_client._coerce_uuid(req.grappler_id),
        "skill": req.skill,
    }
    if req.force is not None:
        payload["force"] = req.force
    return await _maneuver_proxy(
        "escape-grapple", payload, _caller_actor(token)
    )


# --- Inspiration fiat proxies -------------------------------------------------
# The engine's iteration-60 routes: POST /inspiration/grant|revoke. SRD
# inspiration is GM FIAT — players RECEIVE points, they never confer them — so
# these gateway surfaces are gated gm/admin BEFORE any engine traffic, in the
# x-card/simulation-tick gating style. The caller's real identity still rides
# the hop so the engine's own INSPIRATION_GM_ONLY RBAC re-authorizes.

class EngineInspirationRequest(BaseModel):
    """Ids-only body mirroring the engine's InspirationGrantReq
    (deny_unknown_fields); the free-text reason is GM-supplied flavor."""

    session_id: str
    entity_id: str
    reason: Optional[str] = None

    class Config:
        extra = "forbid"


async def _inspiration_fiat_proxy(suffix: str, req: EngineInspirationRequest, token: str):
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(
            status_code=403,
            detail=(
                "INSPIRATION_GM_ONLY: inspiration may only be "
                f"{suffix}ed by GM/admin tokens (SRD fiat); players receive "
                "points through grants."
            ),
        )
    payload: Dict[str, Any] = {
        "entity_id": engine_client._coerce_uuid(req.entity_id)
    }
    if req.reason:
        payload["reason"] = req.reason
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{engine_client._coerce_uuid(req.session_id)}"
            f"/inspiration/{suffix}",
            payload,
            actor=actor,
        )
    )


@app.post("/api/v1/engine/inspiration/grant")
async def engine_grant_inspiration(
    req: EngineInspirationRequest, token: str = Depends(_require_auth)
):
    return await _inspiration_fiat_proxy("grant", req, token)


@app.post("/api/v1/engine/inspiration/revoke")
async def engine_revoke_inspiration(
    req: EngineInspirationRequest, token: str = Depends(_require_auth)
):
    return await _inspiration_fiat_proxy("revoke", req, token)


class EngineOffhandRequest(BaseModel):
    """Mirrors the engine's OffhandActionReq: the SRD Two-Weapon Fighting
    bonus-action off-hand strike. Which weapon is "light" lives in the
    server-side stat block; clients only reference indices."""

    session_id: str
    attacker_id: str
    target_id: str
    offhand_index: int = 0

    class Config:
        extra = "forbid"


class EngineHelpRequest(BaseModel):
    """Mirrors the engine's HelpActionReq: helper + the creature to be helped
    against. Reach, liveness and the Action economy are engine-owned."""

    session_id: str
    helper_id: str
    target_entity_id: str

    class Config:
        extra = "forbid"


@app.post("/api/v1/engine/offhand")
async def engine_offhand_attack(req: EngineOffhandRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "offhand",
        {
            "session_id": req.session_id,
            "attacker_id": engine_client._coerce_uuid(req.attacker_id),
            "target_id": engine_client._coerce_uuid(req.target_id),
            "offhand_index": req.offhand_index,
        },
        _caller_actor(token),
    )


@app.post("/api/v1/engine/help")
async def engine_help_action(req: EngineHelpRequest, token: str = Depends(_require_auth)):
    return await _maneuver_proxy(
        "help",
        {
            "session_id": req.session_id,
            "helper_id": engine_client._coerce_uuid(req.helper_id),
            "target_entity_id": engine_client._coerce_uuid(req.target_entity_id),
        },
        _caller_actor(token),
    )


class EngineOpportunityAttackRequest(BaseModel):
    """Mirrors the engine's OpportunityAttackReq (deny_unknown_fields): the
    provoked attacker and the mover who left its reach. Whether a pending OA
    exists for exactly this pairing, whether the Reaction is available, reach,
    and the roll itself are all engine-owned (`/move` discloses the pending
    offer; this route spends it). The engine's optional deterministic ``seed``
    is deliberately NOT forwardable — same trust-inversion rule as every other
    maneuver proxy."""

    session_id: str
    attacker_id: str
    target_id: str

    class Config:
        extra = "forbid"


@app.post("/api/v1/engine/opportunity-attack")
async def engine_opportunity_attack(
    req: EngineOpportunityAttackRequest, token: str = Depends(_require_auth)
):
    return await _maneuver_proxy(
        "opportunity-attack",
        {
            "session_id": req.session_id,
            "attacker_id": engine_client._coerce_uuid(req.attacker_id),
            "target_id": engine_client._coerce_uuid(req.target_id),
        },
        _caller_actor(token),
    )


class EngineSessionStateRequest(BaseModel):
    """Body of the GET-style read proxy below: only the session reference."""
    session_id: str

    class Config:
        extra = "forbid"


# --- Role-based state projection ------------------------------------------------------
# Gateway-side closure of the iteration-31 finding that this read proxy handed FULL
# engine state to anyone, leaving spectator filtering render-only. The projection is
# deliberately conservative and fails closed: an unrecognized role gets the spectator
# view.

_PRIVILEGED_ROLES = frozenset({"gm", "admin"})
_PLAYER_VISIBLE_ROLES = frozenset({"gm", "admin", "player"})
# Board-token facts every participant may see: identity, placement, shown/
# hidden, whether the token is a PC or an NPC, and whether it still stands.
# Deliberately EXCLUDES current_hp/max_hp/temp_hp/ac/speed/abilities/attacks/
# conditions/spell slots/resistances/owner markers — anything a player could
# use to optimize against the sheet rather than watch the board.
_PUBLIC_ENTITY_FIELDS = (
    "id", "name", "is_visible", "position", "is_player", "is_dead",
)


def _public_entity(entity_id: str, entity: Dict[str, Any]) -> Dict[str, Any]:
    """The board-token view of one entity: who it is and where it stands.
    No HP, AC, abilities, attacks, conditions, or ownership markers."""
    projected = {"id": entity_id}
    for field in _PUBLIC_ENTITY_FIELDS[1:]:
        if field in entity:
            projected[field] = entity.get(field)
    # Prefer the payload's own ``id`` field over the map key when both exist.
    if isinstance(entity.get("id"), str):
        projected["id"] = entity["id"]
    return projected


def _entity_is_visible(entity: Dict[str, Any]) -> bool:
    """An absent flag means visible: the engine defaults entities to shown,
    and partial payloads must not silently blank the whole board."""
    return bool(entity.get("is_visible", True))


def _project_entities(
    entities: Dict[str, Any], user_id: Optional[str], privileged: bool
) -> Dict[str, Any]:
    """Applies the projection matrix below to the ``entities`` map."""
    projected: Dict[str, Any] = {}
    for entity_id, entity in entities.items():
        if not isinstance(entity, dict):
            continue  # never forward a malformed entry verbatim
        if privileged:
            projected[entity_id] = entity  # GM/admin see hidden entities too
            continue
        if not _entity_is_visible(entity):
            continue  # hidden from everyone but GM/admin
        if user_id is not None and entity.get("owner_player_id") == user_id:
            projected[entity_id] = entity  # your own sheet, unredacted
        else:
            projected[entity_id] = _public_entity(str(entity_id), entity)
    return projected


def _project_ledger(
    ledger: Any, *, redact_numbers: bool, privileged: bool = False
) -> Any:
    """Projects a snapshot's ``ledger`` field with the replay-export policy.

    Events travel through :func:`_project_ledger_event` exactly as they do in
    the replay export — never as raw payloads. Under ``redact_numbers``
    (spectators and unrecognized roles) summaries additionally strip exact
    HP/damage amounts ("took damage", never "took 7 damage"); trusted roles
    keep the exact numbers. GM/admin (``privileged``) additionally keep the
    verbatim raw-payload fallback for unmodeled event types.
    """
    if not isinstance(ledger, dict) or not isinstance(ledger.get("events"), list):
        return ledger  # metadata-only ledger: nothing to project
    projected = dict(ledger)
    projected["events"] = [
        _project_ledger_event(
            e, redact_numbers=redact_numbers, privileged=privileged
        )
        for e in ledger["events"]
    ]
    return projected


def _project_session_state(
    state: Any, actor: Dict[str, str]
) -> Any:
    """Projects a live session snapshot for the calling role.

    The caller is ALWAYS an authenticated actor (the route 401s without a
    valid session token); there is no anonymous verbatim read.

    Projection matrix:

    ================  =========================================================
    Caller role       Entities received
    ================  =========================================================
    gm / admin        Full authoritative stat blocks, including hidden entities.
    player            Entities they OWN (``owner_player_id`` == their user_id)
                      in full; every OTHER visible entity reduced to the public
                      board-token projection (id, name, is_visible, position,
                      is_player, is_dead); hidden entities dropped.
    spectator         All visible entities reduced to that same board-token
                      projection; hidden entities dropped; no HP/AC/abilities/
                      attacks anywhere.
    any other role    Spectator view (fails closed).
    ================  =========================================================

    Ledger EVENTS get the same policy as the replay export: spectators and
    unrecognized roles receive redacted summaries only ("took damage", never
    "took 7 damage"); GM/admin/player keep exact numbers.
    """
    if not isinstance(actor, dict) or not actor.get("user_id"):
        raise HTTPException(status_code=401, detail="Missing session token")
    if not isinstance(state, dict):
        return state  # nothing recognizable to project; pass through honestly
    role = actor.get("role", "")
    privileged = role in _PRIVILEGED_ROLES
    user_id = actor["user_id"] if role in _PLAYER_VISIBLE_ROLES else None
    state = dict(state)
    if isinstance(state.get("entities"), dict):
        state["entities"] = _project_entities(
            state["entities"],
            user_id if user_id is not None else "",
            privileged,
        )
    # Fail closed exactly like engine_session_replay: only roles trusted with
    # stat detail see unredacted ledger numbers.
    redact_numbers = role not in _PLAYER_VISIBLE_ROLES
    state["ledger"] = _project_ledger(
        state.get("ledger"), redact_numbers=redact_numbers, privileged=privileged
    )
    return state


@app.post("/api/v1/engine/session-state")
async def engine_session_state(
    req: EngineSessionStateRequest, token: str = Depends(_require_auth)
):
    """GET-style read proxy over the engine's GET /api/v1/sessions/{id}.

    Requires a valid HMAC session token (Authorization header or legacy
    ?token=): this is a browser-facing route and never serves full engine
    state anonymously. Internal callers read the engine directly via
    engine_client instead.

    The browser holds no HMAC engine token, so it has no direct readable path
    to authoritative state (this is what left clients unable to converge local
    tokens after an X-card rewind). This route gives it one round trip through
    the orchestrator, forwarding the caller's identity so the engine's RBAC
    authorizes the real participant.

    Before returning, the gateway PROJECTS the payload by the caller's role
    (see :func:`_project_session_state`): spectators and non-owner players get
    public board tokens only ({id, name, is_visible, position, is_player,
    is_dead}), owners get their own sheets in full, and GM/admin alone receive
    the complete authoritative state including hidden entities. Ledger events
    are redacted with the same policy as the replay export. See the matrix in
    ``_project_session_state``'s docstring.
    """
    actor = _caller_actor(token)
    state = await _engine_call(
        engine_client.engine_request(
            "GET",
            f"/api/v1/sessions/{engine_client._coerce_uuid(req.session_id)}",
            actor=actor,
        )
    )
    return _project_session_state(state, actor)


# --- Session replay export -----------------------------------------------------------
# Turns one engine session's event ledger into a portable, human-auditable
# artifact. The gateway PROJECTS the ledger — it never fabricates: every
# summary segment is derived only from payload fields the engine actually
# sent, missing fields are omitted (never defaulted), and unknown event
# types pass through with their raw payload as the summary.

def _event_summary(
    event_type: str,
    payload: Dict[str, Any],
    *,
    redact_numbers: bool = False,
    privileged: bool = False,
    event_actor: Any = None,
) -> str:
    """Human-readable one-liner for a ledger event, derived ONLY from fields
    genuinely present in ``payload``. Missing fields are omitted rather than
    defaulted, so an auditor never reads a number the engine never produced.
    Unknown event types render their raw payload verbatim.

    With ``redact_numbers`` (spectator exports), numeric HP/damage amounts are
    stripped and narrated qualitatively instead ("took damage", never
    "took 7 damage"); zero-damage events say nothing rather than claiming
    damage was dealt. Unprojectable payloads render a withholding note rather
    than their raw JSON so no number can leak through the fallback path.

    Iteration 88 (audit F2): payload-heavy event types added by iterations
    72-78 (OPPORTUNITY_ATTACK_RESOLVED, MOVE_ENTITY, READY_ACTION_SET/RELEASED,
    INSPIRATION_CHANGED, ITEM_TRANSFERRED) get MODELED fact-line summaries in
    the PLAYER tier — the tier that used to hit the raw-payload fallback with
    redaction off. GM/admin (``privileged=True``) keep the verbatim raw-payload
    fallback; spectators keep the withheld line. ``event_actor`` is the ledger
    row's actor_id, used to name the mover/actor when the payload itself omits
    an entity id (the Rust engine journals MOVE_ENTITY under the mover's own
    actor id).
    """
    parts: List[str] = []

    def opt(key: str) -> Any:
        return payload.get(key)

    if event_type == "ATTACK_RESOLVED":
        attacker, target = opt("attacker_id"), opt("target_id")
        is_hit = opt("is_hit")
        if attacker is not None and target is not None:
            verb = {True: "hit", False: "missed"}.get(is_hit, "attacked")
            parts.append(f"{attacker} {verb} {target}")
        elif attacker is not None or target is not None:
            who = attacker if attacker is not None else target
            parts.append(f"{who} attacked" if attacker is not None else f"{who} targeted")
        damage, hp = opt("total_damage"), opt("target_hp_remaining")
        if redact_numbers:
            if damage:
                parts.append("damage dealt")
        elif damage is not None:
            parts.append(f"for {damage}")
        if hp is not None and not redact_numbers:
            parts.append(f"(HP→{hp})")
    elif event_type == "DAMAGE_APPLIED":
        target = opt("target_id")
        amount, hp = opt("amount"), opt("hp_remaining")
        if target is not None:
            parts.append(str(target))
        if amount is not None:
            parts.append("took damage" if redact_numbers else f"took {amount} damage")
        if hp is not None and not redact_numbers:
            parts.append(f"(HP→{hp})")
    elif event_type in ("HEALED", "LONG_REST_APPLIED"):
        target = opt("target_id")
        amount, hp = opt("amount"), opt("hp_remaining")
        restored_max = opt("hp_restored_to_max")
        if target is not None:
            parts.append(str(target))
        if amount is not None:
            parts.append("healed" if redact_numbers else f"healed for {amount}")
        if restored_max is not None:
            parts.append(
                "restored to max"
                if redact_numbers
                else f"restored to max ({restored_max} HP)"
            )
        if hp is not None and not redact_numbers:
            parts.append(f"(HP→{hp})")
    elif event_type == "DEATH_SAVE_RESOLVED":
        roll, outcome = opt("natural_roll"), opt("outcome")
        if roll is not None:
            parts.append(f"death save rolled {roll}")
        if outcome is not None:
            parts.append(str(outcome))
    elif event_type == "TURN_ADVANCED":
        round_no = opt("round")
        if round_no is not None:
            parts.append(f"round advanced to {round_no}")
    elif event_type == "SPELL_CAST":
        caster, spell = opt("caster_id"), opt("spell_id")
        damage, hp = opt("damage_total"), opt("target_hp_remaining")
        if caster is not None and spell is not None:
            parts.append(f"{caster} cast {spell}")
        elif caster is not None:
            parts.append(f"{caster} cast a spell")
        if redact_numbers:
            if damage:
                parts.append("damage dealt")
        elif damage is not None:
            parts.append(f"for {damage}")
        if hp is not None and not redact_numbers:
            parts.append(f"(HP→{hp})")
    elif event_type == "SPELL_COUNTERSPELLED":
        caster, spell = opt("caster_id"), opt("spell_id")
        if caster is not None:
            who = str(caster)
            parts.append(f"{who}'s {spell} was counterspelled" if spell is not None
                         else f"{who}'s spell was counterspelled")
        elif spell is not None:
            parts.append(f"{spell} was counterspelled")
    elif event_type == "SESSION_CREATED":
        name = opt("name")
        parts.append(f"session created: {name}" if name is not None else "session created")
    elif event_type == "SAFETY_REWIND_APPLIED":
        player, topic = opt("triggered_by"), opt("topic")
        if player is not None:
            parts.append(f"X-card rewind by {player}")
        if topic is not None:
            parts.append(f"on topic '{topic}'")

    # --- Iteration 88 (audit F2): modeled summaries for payload-heavy types ---
    #
    # Players sit inside _PLAYER_VISIBLE_ROLES, so they reach this function with
    # redact_numbers=False — and before iteration 88 every event type below fell
    # through to the raw-payload fallback, leaking hidden-campaign secrets:
    # OPPORTUNITY_ATTACK_RESOLVED's nested resolution carried the target's HP,
    # MOVE_ENTITY named every hidden adjacent enemy that provoked an OA, and
    # READY_ACTION_* / INSPIRATION_CHANGED / ITEM_TRANSFERRED rode verbatim.
    #
    # PLAYER tier only: fact lines derived ONLY from fields genuinely present
    # in the payload (same honesty contract as above); missing fields are
    # omitted, never defaulted. GM/admin keep the VERBATIM raw-payload fallback
    # they have always had for these types, and spectators keep their withheld
    # line.
    modeled_player_tier = not redact_numbers and not privileged
    if modeled_player_tier and event_type == "OPPORTUNITY_ATTACK_RESOLVED":
        attacker, mover = opt("attacker_id"), opt("mover_id")
        resolution = opt("resolution")
        resolution = resolution if isinstance(resolution, dict) else {}
        if attacker is not None and mover is not None:
            verb = {True: "hit", False: "missed"}.get(
                resolution.get("is_hit"), "attacked"
            )
            parts.append(f"{attacker} opportunity-attacked {mover} ({verb})")
        else:
            parts.append("an opportunity attack was resolved")
    elif modeled_player_tier and event_type == "MOVE_ENTITY":
        mover = opt("entity_id") or opt("mover_id") or event_actor
        triggers = opt("opportunity_attacks")
        trigger_count = len(triggers) if isinstance(triggers, list) else 0
        # Mover id only: the opportunity_attacks array names every armed enemy
        # adjacent at departure — including ones a player cannot see. A
        # provocation is reported as a bare COUNT (never attacker ids), because
        # any one of them may be hidden from this caller.
        if mover is not None:
            parts.append(f"{mover} moved")
        if trigger_count:
            parts.append(
                f"(provoked {trigger_count} opportunit"
                f"{'y' if trigger_count == 1 else 'ies'})"
            )
    elif modeled_player_tier and event_type == "READY_ACTION_SET":
        who = opt("entity_id") or event_actor
        parts.append(f"{who} readied an action" if who is not None
                     else "an action was readied")
    elif modeled_player_tier and event_type == "READY_ACTION_RELEASED":
        who = opt("entity_id") or event_actor
        parts.append(f"{who} released a readied action" if who is not None
                     else "a readied action was released")
    elif modeled_player_tier and event_type == "INSPIRATION_CHANGED":
        granted = opt("granted")
        state = {
            True: "gained inspiration",
            False: "spent inspiration",
        }.get(granted, "inspiration changed")
        who = opt("entity_id") or event_actor
        parts.append(f"{who} {state}" if who is not None else state)
    elif modeled_player_tier and event_type == "ITEM_TRANSFERRED":
        who = opt("entity_id") or event_actor
        parts.append(f"{who} moved an item between containers"
                     if who is not None
                     else "an item was moved between containers")

    # Known type whose payload carried nothing we can describe, OR an event
    # type this gateway version does not know: show the raw payload honestly.
    # Under redaction the fallback withholds instead — a raw dump would leak
    # exactly the numbers we just stripped from the known branches.
    if parts:
        return " ".join(parts)
    if redact_numbers:
        return f"{event_type or 'UNKNOWN_EVENT'} occurred (details withheld)"
    return json.dumps(payload, sort_keys=True)

    # Known type whose payload carried nothing we can describe, OR an event
    # type this gateway version does not know: show the raw payload honestly.
    # Under redaction the fallback withholds instead — a raw dump would leak
    # exactly the numbers we just stripped from the known branches.
    if parts:
        return " ".join(parts)
    if redact_numbers:
        return f"{event_type or 'UNKNOWN_EVENT'} occurred (details withheld)"
    return json.dumps(payload, sort_keys=True)


def _project_ledger_event(
    event: Any,
    *,
    redact_numbers: bool = False,
    privileged: bool = False,
) -> Dict[str, Any]:
    """One GameEvent -> the auditable projection. Fields absent from the
    engine's event stay absent/null here; nothing is invented.

    ``privileged`` (GM/admin) keeps the raw-payload fallback for unmodeled
    event types; the player tier gets modeled fact-line summaries instead
    (iteration 88 / audit F2)."""
    event_dict = event if isinstance(event, dict) else {}
    event_type = event_dict.get("event_type") or ""
    payload = event_dict.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    event_dict = event if isinstance(event, dict) else {}
    event_type = event_dict.get("event_type") or ""
    payload = event_dict.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    return {
        "sequence_id": event_dict.get("sequence_id"),
        "actor_id": event_dict.get("actor_id"),
        "event_type": event_dict.get("event_type"),
        "is_reverted": bool(event_dict.get("is_reverted")),
        "summary": _event_summary(
            event_type,
            payload,
            redact_numbers=redact_numbers,
            privileged=privileged,
            event_actor=event_dict.get("actor_id"),
        ),
    }


@app.get("/api/v1/engine/session-replay")
async def engine_session_replay(session_id: str = Query(...), token: str = Depends(_require_auth)):
    """Exports a session's event ledger as a downloadable replay artifact.

    Requires a valid HMAC session token; the caller's real identity is
    forwarded to the engine's GET /sessions/{id} so its RBAC authorizes the
    actual participant. Content-Disposition marks it as an attachment so
    browsers download `replay-<session_id>-<round>.json` instead of rendering.

    Spectator (and unrecognized-role) exports are REDACTED: summaries keep the
    narrative ("X hit Y — damage dealt") but strip exact HP/damage amounts,
    matching the entity projection matrix on /api/v1/engine/session-state.
    GM/admin/player exports carry the full numbers.
    """
    _require_user_id(token)
    actor = _caller_actor(token)
    raw = await _engine_call(
        engine_client.engine_request(
            "GET",
            f"/api/v1/sessions/{engine_client._coerce_uuid(session_id)}",
            actor=actor,
        )
    )

    # Fail closed: only roles trusted with stat detail get unredacted numbers.
    role = actor.get("role", "")
    redact_numbers = role not in _PLAYER_VISIBLE_ROLES
    privileged = role in _PRIVILEGED_ROLES
    events_raw = raw.get("ledger", {}).get("events", []) if isinstance(raw.get("ledger"), dict) else []
    events = [
        _project_ledger_event(
            e, redact_numbers=redact_numbers, privileged=privileged
        )
        for e in events_raw
    ]

    combat = raw.get("combat")
    round_number = combat.get("round") if isinstance(combat, dict) else None

    exported_at = datetime.now(timezone.utc).isoformat()
    body = {
        "session_id": raw.get("session_id", engine_client._coerce_uuid(session_id)),
        "exported_at": exported_at,
        "round": round_number,
        "event_count": len(events),
        "events": events,
    }
    # No fabricated round in the filename either: a session with no combat
    # state exports as "-unknown.json" rather than pretending round 1.
    filename = f"replay-{body['session_id']}-{round_number if round_number is not None else 'unknown'}.json"
    return Response(
        content=json.dumps(body, indent=2, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- Canonical session replay export (PILLAR-2/9) ------------------------------------
#
# GET /api/v1/sessions/{id}/replay/export?format=json|markdown — the portable,
# shareable artifact route. The older /api/v1/engine/session-replay stays as the
# browser-facing JSON download; this route is its stricter superset:
#
# Projection matrix (documented decision, mirrors the live-state policy in
# _project_session_state but with a HARDER spectator line):
#
#   ================  ==========================================================
#   Caller role       Export received
#   ================  ==========================================================
#   gm / admin        FULL: verbatim engine events (raw payloads, state hashes)
#                     plus exact HP/damage numbers everywhere.
#   player            PROJECTED: auditable per-event summaries only ({sequence_id,
#                     actor_id, event_type, is_reverted, summary}); no raw
#                     payloads or hashes, so hidden-entity stat data that the
#                     live projection hides cannot ride along inside an export.
#                     Exact numbers are kept for events the caller witnessed —
#                     same ledger policy as the live state route.
#   spectator         403. A live redacted view is not a portable artifact;
#                     nothing about hidden entities should ever leave in a file.
#   any other role    403 (fails closed).
#   anonymous         401.
#   ================  ==========================================================
#
# Honesty gates: an empty ledger exports honestly empty (round=null, zero rows,
# never a fabricated "round 1"), and a ledger past the size cap exports the
# FIRST chunk WITH an explicit truncation marker and omission counts instead of
# silently clipping.

#: Hard cap on events carried by one export so a marathon campaign's ledger
#: cannot produce an unbounded response body. Module-level so tests can shrink it.
_MAX_REPLAY_EXPORT_EVENTS = 5_000

#: Roles trusted to take ANY replay artifact off the table at all.
_REPLAY_EXPORT_ROLES = frozenset({"gm", "admin", "player"})


def _render_replay_markdown(meta: Dict[str, Any], events: List[Any]) -> str:
    """Renders one projected/full export as a turn-by-turn narrative transcript.

    Every segment derives ONLY from fields genuinely present in the engine
    payload (the same honesty contract as :func:`_event_summary`); rounds come
    from TURN_ADVANCED events actually in the ledger, X-card rewinds are marked
    inline rather than dropped, and truncation is stated in plain text.
    """
    lines: List[str] = [f"# Session Replay: {meta['session_name']}"]
    lines.append("")
    round_label = f"round {meta['round']}" if meta["round"] is not None else "no combat begun"
    lines.append(f"- Session: `{meta['session_id']}`")
    lines.append(f"- Exported at: {meta['exported_at']}")
    lines.append(f"- Combat: {round_label}")
    lines.append(f"- Projection: {meta['projection']} (exported to role `{meta['role']}`)")
    if meta["truncated"]:
        lines.append(
            f"- Events exported: {meta['exported_event_count']} of "
            f"{meta['event_count']} total"
        )
    else:
        lines.append(f"- Events exported: {meta['event_count']}")
    lines.append("")

    if not events:
        # Honest emptiness: say so, never invent an opening round.
        lines.append("_No events have been recorded in this session yet._")
        return "\n".join(lines) + "\n"

    current_round: Any = None
    opened_any_round = False
    for event in events:
        if not isinstance(event, dict):
            continue  # never narrate a malformed entry verbatim
        if event.get("event_type") == "TURN_ADVANCED":
            payload = event.get("payload")
            new_round = payload.get("round") if isinstance(payload, dict) else None
            if new_round is not None and new_round != current_round:
                current_round = new_round
                lines.append(f"## Round {current_round}")
                lines.append("")
                opened_any_round = True
                continue
        if isinstance(event.get("summary"), str):
            narrated = event  # already projected (player export)
        else:
            # Full exports carry VERBATIM engine events; the transcript still
            # narrates them through the same derived-summary path (exact
            # numbers kept) so the artifact reads as prose, not raw JSON.
            narrated = _project_ledger_event(event, redact_numbers=False,
                                             privileged=True)
        summary = (
            narrated.get("summary")
            if isinstance(narrated.get("summary"), str)
            else json.dumps(narrated.get("payload", {}), sort_keys=True)
        )
        marker = ""
        if event.get("is_reverted"):
            marker = "**[X-CARD REWIND]** "
        seq = event.get("sequence_id")
        seq_label = f"[#{seq}] " if seq is not None else ""
        if not opened_any_round and current_round is None:
            lines.append("## Opening")
            lines.append("")
            opened_any_round = True
        lines.append(f"- {marker}{seq_label}{summary}")

    if meta["truncated"]:
        lines.append("")
        lines.append(
            f"**[TRUNCATED]** The session ledger holds {meta['event_count']} events; "
            f"this export carries only the first {meta['exported_event_count']} "
            f"({meta['omitted_event_count']} omitted)."
        )
    return "\n".join(lines) + "\n"


@app.get("/api/v1/sessions/{session_id}/replay/export")
async def session_replay_export(
    session_id: str,
    fmt: Literal["json", "markdown"] = Query("json", alias="format"),
    include: Optional[Literal["death_audit"]] = Query(
        None,
        description=(
            "Optional add-on section. `death_audit` walks the exported "
            "events and reports, per token, what dropped it to 0 HP and "
            "which death saves followed. Omitted from the artifact entirely "
            "when not requested."
        ),
    ),
    token: str = Depends(_require_auth),
):
    """Exports one session's event ledger as json or markdown.

    Requires a valid HMAC session token (401 without one). Only GM/admin
    (full verbatim export), players (projected summary export), and admins'
    staff view pass authorization; spectators and unrecognized roles get 403
    because a downloadable artifact must not become a side channel around the
    live projection. The caller's real identity is forwarded to the engine's
    GET /sessions/{id} so ITS RBAC also authorizes the participant.

    ``format=json`` returns structured metadata + events (verbatim when full,
    projected summaries otherwise); ``format=markdown`` returns a human-readable
    turn-by-turn transcript with actions resolved, outcomes, and X-card rewinds
    marked inline. Both formats size-cap honestly via ``_MAX_REPLAY_EXPORT_EVENTS``.

    ``include=death_audit`` appends a per-token death-save history derived
    from the same exported window (PILLAR-3): what dropped each creature to
    0 HP, the death saves that followed, and whether the episode ended
    stabilized / dead / is still in progress. The audit is best-effort by
    contract — triggers need damage-shaped events with post-event HP, and a
    ledger without them exports an honest empty section rather than an
    invented one.
    """
    actor = _caller_actor(token)
    role = actor.get("role", "")
    if role not in _REPLAY_EXPORT_ROLES:
        raise HTTPException(
            status_code=403,
            detail="Replay exports are limited to GM, admin, and player roles",
        )

    raw = await _engine_call(
        engine_client.engine_request(
            "GET",
            f"/api/v1/sessions/{engine_client._coerce_uuid(session_id)}",
            actor=actor,
        )
    )

    full_export = role in _PRIVILEGED_ROLES
    projection = "full" if full_export else "projected"

    ledger = raw.get("ledger") if isinstance(raw.get("ledger"), dict) else {}
    ledger_events = ledger.get("events") if isinstance(ledger.get("events"), list) else []
    total_events = len(ledger_events)
    capped = ledger_events[:_MAX_REPLAY_EXPORT_EVENTS]
    omitted = total_events - len(capped)

    if full_export:
        exported_events: List[Any] = [e for e in capped if isinstance(e, dict)]
        # Verbatim means verbatim: malformed entries are withheld entirely
        # rather than silently reshaped into something that looks authoritative.
    else:
        exported_events = [
            _project_ledger_event(e, redact_numbers=False, privileged=False)
            for e in capped
        ]

    combat = raw.get("combat")
    round_number = combat.get("round") if isinstance(combat, dict) else None
    truncated = omitted > 0

    # Opt-in PILLAR-3 audit. Derived from the RAW exported window (not the
    # projected summaries) so the same derivation serves both projections;
    # it exposes only ledger facts (token ids, sequences, save rolls and
    # outcome labels) that the caller's role is already trusted to see.
    death_audit_report: Optional[Dict[str, Any]] = None
    if include == "death_audit":
        death_audit_report = build_death_audit(capped)
        death_audit_report["scope"] = (
            "exported_events"
            if truncated
            else "full_ledger"
        )

    meta = {
        "session_id": raw.get("session_id", engine_client._coerce_uuid(session_id)),
        "session_name": raw.get("session_name") or engine_client._coerce_uuid(session_id),
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "round": round_number,
        "role": role,
        "projection": projection,
        "event_count": total_events,
        "exported_event_count": len(exported_events),
        "omitted_event_count": omitted,
        "truncated": truncated,
        "truncation_marker": (
            f"[TRUNCATED] Export capped at {_MAX_REPLAY_EXPORT_EVENTS} of "
            f"{total_events} ledger events."
            if truncated
            else ""
        ),
    }

    filename_round = round_number if round_number is not None else "unknown"
    if fmt == "markdown":
        text = _render_replay_markdown(meta, exported_events)
        if death_audit_report is not None:
            scope_note = (
                "(derived from the exported window only — earlier ledger "
                "events were omitted by the size cap)"
                if truncated
                else ""
            )
            text += "\n" + render_death_audit_markdown(death_audit_report)
            if scope_note:
                text += f"_{scope_note}_\n"
        return Response(
            content=text,
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="replay-{meta["session_id"]}-{filename_round}.md"'
                )
            },
        )

    body = {
        "session_id": meta["session_id"],
        "session_name": meta["session_name"],
        "exported_at": meta["exported_at"],
        "round": round_number,
        "role": role,
        "projection": projection,
        "event_count": total_events,
        "exported_event_count": len(exported_events),
        "omitted_event_count": omitted,
        "truncated": truncated,
        "truncation_marker": meta["truncation_marker"] or None,
        "events": exported_events,
    }
    if death_audit_report is not None:
        body["death_audit"] = death_audit_report
    return Response(
        content=json.dumps(body, indent=2, ensure_ascii=False),
        media_type="application/json",
        headers={
            "Content-Disposition": (
                f'attachment; filename="replay-{meta["session_id"]}-{filename_round}.json"'
            )
        },
    )


# --- Request observability & rate limiting ------------------------------------------

import logging as _logging

_logging.basicConfig(level=_logging.INFO)
http_logger = _logging.getLogger("aethertable.http")

_RATE_LIMITS = ratelimit.RATE_LIMITS

# The limiter is no longer purely process-local: when REDIS_URL points at a
# reachable Redis, every replica draws from ONE shared set of sorted-set
# windows instead of each minting its own full budget (quota multiplication).
# Selection/failure rules live in ratelimit.build_backend: unset URL → memory;
# unreachable Redis → memory + one warning; mid-flight Redis error → permanent
# soft fallback to this same shared memory backend + one warning. The in-memory
# table stays module state (``_rate_windows``, same dict object the backend
# uses) because the test harness resets it between tests.
_memory_limiter = ratelimit.MemoryWindowBackend(
    max_keys_provider=lambda: _MAX_TRACKED_KEYS
)
_rate_windows: Dict[tuple, List[float]] = _memory_limiter.windows
_rate_backend: Any = None

#: Hard cap on tracked ``(client_ip, bucket)`` keys so an attacker rotating
#: spoofed source addresses cannot grow the table without bound. Mirrors
#: ``MAX_TRACKED_KEYS`` in ``crates/vtt-server/src/ratelimit.rs``; exceeded,
#: keys whose windows are fully expired past the staleness factor below are
#: swept. Module-level so tests can inject a tiny cap.
_MAX_TRACKED_KEYS = 100_000


def _sweep_stale_rate_keys(now: float) -> None:
    """Drop ``_rate_windows`` entries whose hits all predate the staleness bound.

    A key is swept when its newest hit is older than twice its bucket's window
    — such a key cannot contribute to any active sliding-window verdict, so
    dropping it never changes admission decisions. Mirrors the ``retain`` guard
    in the Rust twin's ``SlidingWindows::check``
    (``crates/vtt-server/src/ratelimit.rs``).
    """
    _memory_limiter.sweep_stale_keys(now)


def _get_rate_backend() -> Any:
    """Resolve the limiter backend once: Redis when configured and reachable,
    otherwise the in-process window table."""
    global _rate_backend
    if _rate_backend is None:
        _rate_backend = ratelimit.build_backend(
            os.environ.get("REDIS_URL", ""),
            fallback=_memory_limiter,
        )
    return _rate_backend


def _bucket_for_path(path: str) -> str:
    # The middleware runs BEFORE routing, so bucket matching sees the raw
    # request path. A trailing-slash alias ("/api/v1/media/image/") would
    # otherwise miss the exact-match expensive buckets and fall through to the
    # looser llm/default metering even though routing itself tolerates the
    # slash (redirect_slashes). Normalize it away so metering is decided by
    # the route, not by how the client spelled the URL.
    normalized = path[:-1] if len(path) > 1 and path.endswith("/") else path
    if normalized.startswith("/api/v1/auth"):
        return "auth"
    if normalized.startswith("/api/v1/agent"):
        return "agent"
    # Empirical benchmark: 10-1000 in-process simulations per accepted call —
    # matched before the generic simulation prefix so it gets its own tight cap.
    if normalized.startswith("/api/v1/simulation/empirical-benchmark"):
        return "benchmark"
    # Diffusion images: expensive GPU work per call, tighter than the llm
    # bucket. Must be matched before the generic media prefix below.
    if normalized == "/api/v1/media/image":
        return "media"
    # Spoken narration (POST /api/v1/media/narrate): same model spend as
    # speech but with a far longer per-call allowance — its own 20/min bucket,
    # also matched before the generic media prefix below.
    if normalized == "/api/v1/media/narrate":
        return "narration"
    # Other media surfaces (TTS / STT): model spend, llm bucket.
    if normalized.startswith("/api/v1/media/"):
        return "llm"
    # LLM-spend surfaces: intent classification and every orchestrator
    # narrative path (including the legacy /narrative/* aliases).
    if normalized.startswith(
        (
            "/api/v1/intent/",
            "/api/v1/orchestrator/",
            "/api/v1/narrative/",
        )
    ):
        return "llm"
    return "default"


@app.middleware("http")
async def rate_limit_middleware(request, call_next):
    bucket = _bucket_for_path(request.url.path)
    limit, window = _RATE_LIMITS[bucket]
    client_ip = request.client.host if request.client else "unknown"
    key = (client_ip, bucket)
    retry_after = _get_rate_backend().check(key, limit, window, time.time())
    if retry_after is not None:
        return Response(
            content=json.dumps({"error": "RATE_LIMITED", "retry_after_s": retry_after}),
            status_code=429,
            media_type="application/json",
            headers={"Retry-After": str(retry_after)},
        )
    return await call_next(request)


@app.middleware("http")
async def request_log_middleware(request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - started) * 1000.0
    http_logger.info(
        '%s %s -> %s (%.1f ms)',
        request.method, request.url.path, response.status_code, duration_ms,
    )
    return response


# --- Multi-agent tool-calling loop --------------------------------------------

class AgentTurnRequest(BaseModel):
    """One agentic turn: the LLM emits structured tool calls that execute
    exclusively through the authenticated authoritative engine API."""
    user_intent: str
    session_id: str


@app.post("/api/v1/agent/turn")
async def agent_turn(
    req: AgentTurnRequest, token: str = Depends(_require_auth)
):
    """One agentic turn. Authorization mirrors the x-card rewind gate:

    * gm/admin tokens may drive the tool agent against ANY session.
    * Any other authenticated seat must be a member of a lobby bound to the
      named engine session (the gateway's own roster data — invite-code joins
      plus the host's launch binding; see ``_caller_is_session_participant``).
    * Sessions with no lobby binding fail CLOSED to staff only: without a
      roster there is nothing proving a player's standing, and an agentic turn
      executes engine mutations under the caller's forwarded identity.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin") and not (
        await _caller_is_session_participant(actor["user_id"], req.session_id)
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                "AGENT_TURN_FORBIDDEN: only GMs or members of a lobby bound to "
                f"session {req.session_id} may drive the tool agent against it."
            ),
        )
    return await tool_agent.run_turn(req.user_intent, req.session_id)


@app.post("/api/v1/character/export-pdf")
def export_character_pdf(req: CharacterExportPDFRequest):
    try:
        pdf_bytes = pdf_renderer.render_character_sheet(req.dict())
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{req.name.replace(" ", "_")}_5e_Sheet.pdf"'}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {str(e)}")


@app.get("/api/v1/dynasty/factions")
def get_dynasties():
    return global_dynasty_engine.get_dynasty_payload()


@app.post("/api/v1/dynasty/generate")
def generate_new_dynasties(seed: Optional[int] = Query(None)):
    engine = DynastyEngine(seed=seed)
    return engine.get_dynasty_payload()


@app.post("/api/v1/dynasty/inject-lore")
def inject_dynasty_lore(
    req: DynastyInjectRequest, token: str = Depends(_require_auth)
):
    """GM/admin only: this mutates the SHARED global lore graph every table
    reads from — a player injecting house lore would write canon for everyone."""
    if _caller_actor(token).get("role", "") not in ("gm", "admin"):
        raise HTTPException(
            status_code=403,
            detail=(
                "LORE_INJECTION_FORBIDDEN: only GM tokens may inject dynasty "
                "lore into the shared canon graph."
            ),
        )
    injected = global_dynasty_engine.inject_lore_into_graph(req.house_id, lore_graph)
    if injected == 0:
        raise HTTPException(status_code=404, detail="House not found")
    return {
        "status": "success",
        "house_id": req.house_id,
        "propositions_injected": injected,
        "total_graph_edges": len(lore_graph.edges),
    }


@app.post("/api/v1/simulation/empirical-benchmark")
def run_empirical_benchmark(
    simulations: int = Query(200, ge=10, le=1000),
    token: str = Depends(_require_auth),
):
    """GM/admin only. Each accepted call runs 10-1000 full encounter
    simulations in-process — anonymous access would make this a one-request
    CPU exhaustion vector; the `benchmark` rate bucket additionally caps how
    often even a GM may trigger it."""
    if _caller_actor(token).get("role", "") not in ("gm", "admin"):
        raise HTTPException(
            status_code=403,
            detail=(
                "BENCHMARK_FORBIDDEN: the empirical benchmark runs hundreds of "
                "simulations per call and is restricted to GM tokens."
            ),
        )
    return empirical_playtester.run_benchmark(simulations)


@app.post("/api/v1/campaign/export-bundle")
def export_campaign_bundle(req: CampaignExportBundleRequest):
    try:
        zip_bytes = global_bundle_packager.export_bundle(req.dict())
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{req.title.replace(" ", "_")}.vttbundle"'}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Bundle packaging failed: {str(e)}")


class BundleImportRequest(BaseModel):
    """Base64-encoded .vttbundle archive."""
    bundle_b64: str
    session_name: str = "Imported Bundle"


# --- Starter adventures (GOALS.md Pillar 2) --------------------------------------

@app.get("/api/v1/adventures/starter")
def list_starter_bundles():
    """Catalog of out-of-the-box starter adventures shippable as .vttbundle."""
    return {"adventures": list_starter_adventures()}


@app.post("/api/v1/adventures/starter/{key}/export")
def export_starter_adventure(key: str, token: str = Depends(_require_auth)):
    """Build a starter adventure on demand and return its .vttbundle archive.

    Auth matches the rest of the migrated gateway: the HMAC session token is
    taken from the Authorization header first ("Bearer <token>"), with the
    legacy ?token= query param as back-compat fallback. (This route previously
    declared ``token: str = Query(...)``, so the wizard's header-only request
    could never pass validation.)

    Layouts come from the engine's WFC when reachable, else the documented
    seeded fallback (provenance recorded inside adventure.json)."""
    # Minting a shareable campaign archive — authenticated users only.
    _require_user_id(token)
    try:
        zip_bytes = build_starter_bundle_bytes(key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown starter adventure: {key}")
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{key}.vttbundle"'},
    )


@app.post("/api/v1/campaign/import-bundle")
async def import_campaign_bundle(req: BundleImportRequest, token: str = Depends(_require_auth)):
    # Importing a world mutates shared state — authenticated users only.
    # Migrated off ``token: str = Query(...)`` (header-only callers failed
    # validation; anonymous callers now get an honest 401 instead of a
    # misleading 422 "missing query param").
    _require_user_id(token)
    import base64 as _b64

    try:
        campaign = global_bundle_packager.import_bundle(_b64.b64decode(req.bundle_b64))
    except Exception as exc:
        # BadZipFile / missing manifest / malformed members all reject cleanly.
        raise HTTPException(status_code=422, detail=f"Invalid .vttbundle: {exc}")

    manifest = campaign.get("manifest", {})
    map_layout = campaign.get("map_layout", {})
    tokens = campaign.get("tokens", [])

    # Hydrate a live engine session from the bundle (lobby-to-canvas flow).
    created = await _engine_call(
        engine_client.engine_request(
            "POST",
            "/api/v1/sessions",
            {
                "campaign_id": "00000000-0000-0000-0000-000000000002",
                "session_name": req.session_name or manifest.get("title", "Imported"),
            },
        )
    )
    session_id = created["session_id"]

    width = int(map_layout.get("grid_width", 16))
    height = int(map_layout.get("grid_height", 12))
    walls = [(int(w["x"]), int(w["y"])) for w in map_layout.get("walls", [])
             if isinstance(w, dict) and "x" in w and "y" in w]
    if walls:
        await _engine_call(
            engine_client.engine_request(
                "PUT",
                f"/api/v1/sessions/{session_id}/map",
                {
                    "width": width,
                    "height": height,
                    "solid_cells": walls,
                    "difficult_terrain": [],
                    "cell_size_feet": 5.0,
                },
            )
        )

    spawned = 0
    for tok in tokens[:64]:
        try:
            entity = _bundle_token_to_entity(tok)
            await _engine_call(
                engine_client.engine_request(
                    "POST",
                    f"/api/v1/sessions/{session_id}/entities",
                    entity,
                )
            )
            spawned += 1
        except Exception:
            continue  # malformed token — skip rather than poison the import

    return {
        "status": "IMPORTED",
        "session_id": session_id,
        "title": manifest.get("title"),
        "map_walls_applied": len(walls),
        "tokens_spawned": spawned,
    }


# --- Media gateway routes (Loop 3, iteration 2) ------------------------------
#
# Four authenticated surfaces over the self-hosted upstream wired in iteration
# 1. Shared contract:
#   * every route requires a session token (header Bearer first, ?token=
#     fallback) — media generation is never anonymous;
#   * failures degrade HONESTLY: an unreachable host maps to 502
#     MEDIA_GATEWAY_UNAVAILABLE and an upstream rejection forwards its status +
#     detail verbatim; no route ever fabricates placeholder media or masks a
#     generation failure with canned content;
#   * rate limiting is bucket-assigned by _bucket_for_path (trailing-slash
#     aliases normalize to the canonical metering): diffusion images meter in
#     their own tight `media` bucket (10/min), spoken narration in its own
#     `narration` bucket (20/min), TTS/STT/SFX share the `llm` bucket because
#     they all spend model time per call;
#   * every response carries Cache-Control: no-store — session-scoped media
#     and narration logs must never land in a shared cache or browser store;
#   * every binary-returning route caps what it relays from upstream
#     (_MEDIA_MAX_{IMAGE,TTS,SFX}_BYTES) so a runaway generation cannot stream
#     unbounded bytes through the gateway.
_MEDIA_MAX_TTS_BYTES = 20 * 1024 * 1024          # 20 MB speech response cap
_MEDIA_MAX_UPLOAD_BYTES = 25 * 1024 * 1024       # 25 MB transcription upload cap
# Self-audit (iteration 10): every binary-returning media route caps what it
# will relay. A misbehaving or compromised upstream must not be able to stream
# gigabytes through the gateway (image bytes are base64-inflated ~4/3 again in
# the JSON envelope, so its cap is tighter than the audio ones).
_MEDIA_MAX_IMAGE_BYTES = 10 * 1024 * 1024        # 10 MB decoded PNG cap
_MEDIA_MAX_SFX_BYTES = 20 * 1024 * 1024          # 20 MB generated-SFX wav cap

#: Session-scoped generated media and per-session narration logs are never
#: cacheable: no shared cache, no browser back-button replay of another seat's
#: audio. Applied to EVERY /api/v1/media/* response.
_MEDIA_NO_STORE_HEADERS = {"Cache-Control": "no-store"}

#: Default narration voice; operators retune the table's storyteller voice via
#: ``MEDIA_TTS_VOICE`` without a redeploy. Read per-request (not at import) so
#: tests and long-lived processes see env changes.
DEFAULT_NARRATION_VOICE = "af_sky"


def _default_tts_voice() -> str:
    return os.environ.get("MEDIA_TTS_VOICE") or DEFAULT_NARRATION_VOICE


def _narration_max_chars() -> int:
    """Per-call narration script bound from ``MEDIA_NARRATION_MAX_CHARS``.

    Read at VALIDATION time on purpose: an operator (or test) can tighten the
    cap live. Unparseable or non-positive values fall back to the documented
    default of 2000 rather than disabling the cap entirely — fail closed.
    """
    raw = os.environ.get("MEDIA_NARRATION_MAX_CHARS", "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 0
        if value >= 1:
            return value
    return 2000


class MediaImageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    size: Literal["512x512", "256x256"] = "512x512"
    steps: int = Field(default=4, ge=1, le=8)


class MediaSpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    voice: str = Field(default="af_sky", min_length=1, max_length=64)
    fmt: Literal["wav", "mp3"] = "wav"


class MediaNarrateRequest(BaseModel):
    """One spoken narration. Deliberately NOT an overload of /media/speech:
    narration allows a much longer script (MEDIA_NARRATION_MAX_CHARS, default
    2000 vs speech's fixed 1000), meters in its own bucket, and records a
    narration event per session."""

    text: str = Field(min_length=1)
    # None → MEDIA_TTS_VOICE env, else the documented af_sky default.
    voice: Optional[str] = Field(default=None, min_length=1, max_length=64)
    # Optional session attribution; when set, the caller must hold standing in
    # that session (lobby membership or staff) — see media_narrate.
    session_id: Optional[str] = None

    @field_validator("text")
    @classmethod
    def _text_within_env_cap(cls, value: str) -> str:
        cap = _narration_max_chars()
        if len(value) > cap:
            raise ValueError(
                f"text exceeds MEDIA_NARRATION_MAX_CHARS ({cap} characters)"
            )
        return value


class MediaSfxRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=300)


class MediaImageResponse(BaseModel):
    image_b64: str


def _media_error_to_http(exc: Exception) -> HTTPException:
    """Maps one media-gateway client exception onto the honest HTTP surface."""
    if isinstance(exc, MediaGatewayUnavailableError):
        return HTTPException(
            status_code=502, detail=f"MEDIA_GATEWAY_UNAVAILABLE: {exc}"
        )
    # MediaGatewayRejectedError: forward the upstream status + detail verbatim
    # so the client sees exactly what the model host refused (and why).
    status = getattr(exc, "status_code", 502)
    if not isinstance(status, int) or not (400 <= status <= 599):
        status = 502
    return HTTPException(status_code=status, detail=exc.detail)


async def _read_capped_upload(file: UploadFile, cap: int) -> bytes:
    """Streams one multipart part with a hard byte bound.

    Declared Content-Length cannot be trusted for the real bound (a lying
    client would otherwise buffer unbounded bytes before rejection), so reads
    are chunked with a running total that trips 413 mid-stream.
    """
    chunks: List[bytes] = []
    received = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        received += len(chunk)
        if received > cap:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Upload exceeds the {cap} byte limit "
                    f"(received at least {received})."
                ),
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _validate_wav_upload(filename: str, payload: bytes) -> None:
    """Transcription accepts wav ONLY: extension AND magic must both agree.

    The extension check alone is spoofable (rename anything .wav); the RIFF
    prologue check alone rejects legitimately-named-but-misencoded files too
    late for a helpful error. Requiring both gives clients a precise refusal.
    """
    if not filename.lower().endswith(".wav"):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Only .wav uploads are supported for transcription "
                f"(got filename {filename!r})."
            ),
        )
    if (
        len(payload) < 12
        or payload[0:4] != b"RIFF"
        or payload[8:12] != b"WAVE"
    ):
        raise HTTPException(
            status_code=422,
            detail="Not a valid wav file: missing RIFF....WAVE magic bytes.",
        )


@app.post("/api/v1/media/image")
async def media_image(req: MediaImageRequest, token: str = Depends(_require_auth)):
    """Generate one diffusion image; any authenticated seat.

    Metered in the dedicated tight `media` bucket (10/min): each accepted
    call occupies the shared GPU through up-to-8 SD-Turbo steps, which is far
    more expensive than any llm-bucket call. Returns base64 JSON — raw binary
    has no place in this route's contract.
    """
    _require_user_id(token)
    try:
        png_bytes = await media_client.generate_image(
            req.prompt, size=req.size, steps=req.steps
        )
    except (MediaGatewayUnavailableError, MediaGatewayRejectedError) as exc:
        raise _media_error_to_http(exc)
    if len(png_bytes) > _MEDIA_MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Generated image exceeds the {_MEDIA_MAX_IMAGE_BYTES} byte "
                f"response cap ({len(png_bytes)} bytes returned upstream)."
            ),
        )
    return JSONResponse(
        content=MediaImageResponse(
            image_b64=base64.b64encode(png_bytes).decode()
        ).model_dump(),
        headers=_MEDIA_NO_STORE_HEADERS,
    )


@app.post("/api/v1/media/speech")
async def media_speech(req: MediaSpeechRequest, token: str = Depends(_require_auth)):
    """Synthesize speech from text; any authenticated seat, llm bucket.

    Responds with RAW audio bytes (audio/wav or audio/mpeg to match the
    requested format) capped at 20 MB so a runaway synthesis cannot stream
    unbounded memory through the JSON-first gateway.
    """
    _require_user_id(token)
    try:
        audio = await media_client.text_to_speech(
            req.text, voice=req.voice, fmt=req.fmt
        )
    except (MediaGatewayUnavailableError, MediaGatewayRejectedError) as exc:
        raise _media_error_to_http(exc)
    if len(audio) > _MEDIA_MAX_TTS_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Synthesized audio exceeds the {_MEDIA_MAX_TTS_BYTES} byte "
                f"response cap ({len(audio)} bytes returned upstream)."
            ),
        )
    content_type = "audio/mpeg" if req.fmt == "mp3" else "audio/wav"
    return Response(
        content=audio, media_type=content_type, headers=_MEDIA_NO_STORE_HEADERS
    )


@app.post("/api/v1/media/transcribe")
async def media_transcribe(
    file: UploadFile = File(...), token: str = Depends(_require_auth)
):
    """Transcribe one uploaded wav recording; any authenticated seat.

    Multipart only, 25 MB cap enforced while streaming (never trusting
    declared sizes), and BOTH the .wav extension AND the RIFF....WAVE magic
    bytes must agree before anything reaches the upstream model.
    """
    _require_user_id(token)
    payload = await _read_capped_upload(file, _MEDIA_MAX_UPLOAD_BYTES)
    _validate_wav_upload(file.filename or "", payload)
    try:
        text = await media_client.transcribe(payload, filename=file.filename or "input.wav")
    except (MediaGatewayUnavailableError, MediaGatewayRejectedError) as exc:
        raise _media_error_to_http(exc)
    return JSONResponse(
        content={"text": text}, headers=_MEDIA_NO_STORE_HEADERS
    )


@app.post("/api/v1/media/sfx")
async def media_sfx(req: MediaSfxRequest, token: str = Depends(_require_auth)):
    """Generate a table-wide sound effect; GM/admin ONLY.

    SFX plays to everyone at the table, so triggering it is a staff decision
    the same way lore injection and campaign autosave are — a player firing
    it could spam the shared soundscape.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(
            status_code=403,
            detail=(
                "MEDIA_SFX_FORBIDDEN: sound effects play to the whole table; "
                "only GM or admin seats may trigger them."
            ),
        )
    try:
        wav_bytes = await media_client.generate_sfx(req.prompt)
    except (MediaGatewayUnavailableError, MediaGatewayRejectedError) as exc:
        raise _media_error_to_http(exc)
    if len(wav_bytes) > _MEDIA_MAX_SFX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Generated sound effect exceeds the {_MEDIA_MAX_SFX_BYTES} "
                f"byte response cap ({len(wav_bytes)} bytes returned upstream)."
            ),
        )
    return Response(
        content=wav_bytes, media_type="audio/wav", headers=_MEDIA_NO_STORE_HEADERS
    )


@app.post("/api/v1/media/narrate")
async def media_narrate(
    req: MediaNarrateRequest, token: str = Depends(_require_auth)
):
    """Speak one narration aloud; any authenticated seat, OWN text only.

    Separate from POST /media/speech because the contract differs: longer
    scripts are allowed (MEDIA_NARRATION_MAX_CHARS, default 2000), metering
    lands in the dedicated `narration` bucket (20/min), and every successful
    synthesis is recorded into the per-session narration log.

    Trust decisions:

    * An authenticated HMAC token is REQUIRED. A seat may narrate only text
      attributed to itself — the log row always carries the CALLER's user id,
      never one from the request body.
    * ``session_id`` is optional attribution. When set by a non-staff caller,
      standing derives from lobby membership bound to that engine session —
      the same derivation as the x-card gate; otherwise 403. GM/admin may
      narrate into any session.
    * The narration event is logged ONLY on a successful synthesis: a failed
      or oversized response leaves no log row.
    """
    actor = _caller_actor(token)
    if req.session_id and actor.get("role", "") not in ("gm", "admin"):
        participant = await _caller_is_session_participant(
            actor["user_id"], req.session_id
        )
        if not participant:
            raise HTTPException(
                status_code=403,
                detail=(
                    "NARRATION_NOT_A_PARTICIPANT: only session participants "
                    "(via a lobby bound to that session) or GMs may narrate "
                    f"into session {req.session_id}."
                ),
            )
    voice = req.voice or _default_tts_voice()
    try:
        audio = await media_client.text_to_speech(req.text, voice=voice, fmt="wav")
    except (MediaGatewayUnavailableError, MediaGatewayRejectedError) as exc:
        raise _media_error_to_http(exc)
    if len(audio) > _MEDIA_MAX_TTS_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Synthesized narration exceeds the {_MEDIA_MAX_TTS_BYTES} "
                f"byte response cap ({len(audio)} bytes returned upstream)."
            ),
        )
    await storage_backend.record_narration(
        session_id=req.session_id,
        user_id=actor["user_id"],
        voice=voice,
        text=req.text,
    )
    return Response(
        content=audio, media_type="audio/wav", headers=_MEDIA_NO_STORE_HEADERS
    )


# --- Ambience presets (iteration 17) ----------------------------------------
#
# Curated D&D soundscapes (see compendium/ambience_presets.py) generated on
# demand through the SFX capability and cached in-process. Contract notes:
#
#   * GET  /api/v1/media/ambience          — list presets + cache metadata;
#     any authenticated seat (a picker is read-only, no generation spend).
#   * POST /api/v1/media/ambience/{slug}   — generate (or serve cached) wav.
#     GM/admin ONLY, exactly like POST /media/sfx: ambient beds reach every
#     seat at the table, so triggering one is a staff decision. Meters in the
#     generic `llm` bucket via _bucket_for_path, same as /media/sfx — the LRU
#     cache absorbs repeat spends that bucket metering alone cannot.
#   * Cache is keyed by (slug, model), bounded by _AMBIENCE_CACHE_MAX_ENTRIES
#     (LRU), and coalesces concurrent duplicate generations onto one upstream
#     call. Failures and over-cap payloads are NEVER cached; upstream errors
#     surface verbatim through _media_error_to_http like every other route.

_AMBIENCE_CACHE_MAX_ENTRIES = 12

_ambience_cache: "OrderedDict[tuple[str, str], bytes]" = OrderedDict()
#: In-flight generation futures keyed like the cache; concurrent duplicate
#: requests for one slug await a single upstream call instead of racing it.
_ambience_inflight: Dict[tuple[str, str], "asyncio.Future[bytes]"] = {}


def reset_ambience_cache() -> None:
    """Drops cached ambience audio and in-flight state (tests/admin tooling)."""
    _ambience_cache.clear()
    _ambience_inflight.clear()


async def _load_ambience(slug: str, model: Optional[str] = None) -> bytes:
    """Returns preset ``slug``'s wav bytes, generating through SFX at most once.

    Cache lookup → in-flight join → upstream generation → cap check → insert,
    with LRU eviction of the least-recently-used entry past
    ``_AMBIENCE_CACHE_MAX_ENTRIES``. Failures propagate to every waiter and
    leave no cache trace; oversized payloads raise before touching the cache.
    """
    from .compendium.ambience_presets import get_preset

    preset = get_preset(slug)
    if preset is None:
        raise HTTPException(
            status_code=404,
            detail=f"UNKNOWN_AMBIENCE_PRESET: no soundscape named {slug!r}",
        )
    key = (slug, model or media_client.sfx_model)

    cached = _ambience_cache.get(key)
    if cached is not None:
        _ambience_cache.move_to_end(key)  # LRU touch on hit
        return cached

    existing = _ambience_inflight.get(key)
    if existing is not None:
        # Join an identical in-flight generation rather than doubling the
        # spend on the self-hosted box.
        return await asyncio.shield(existing)

    loop = asyncio.get_running_loop()
    future: "asyncio.Future[bytes]" = loop.create_future()
    _ambience_inflight[key] = future
    try:
        # No ``model=`` passthrough: the gateway's configured MEDIA_SFX_MODEL
        # is the single source of truth for ambience generation.
        wav_bytes = await media_client.generate_sfx(preset.prompt)
        if len(wav_bytes) > _MEDIA_MAX_SFX_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Generated ambience exceeds the {_MEDIA_MAX_SFX_BYTES} "
                    f"byte response cap ({len(wav_bytes)} bytes returned "
                    f"upstream)."
                ),
            )
        future.set_result(wav_bytes)
    except BaseException as exc:
        # Never cache failures: wake every coalesced waiter with the error
        # and drop the in-flight slot so a retry actually retries.
        if not future.done():
            future.set_exception(exc)
        raise
    finally:
        _ambience_inflight.pop(key, None)

    _ambience_cache[key] = wav_bytes
    _ambience_cache.move_to_end(key)
    while len(_ambience_cache) > _AMBIENCE_CACHE_MAX_ENTRIES:
        _ambience_cache.popitem(last=False)
    return wav_bytes


class AmbiencePresetOut(BaseModel):
    slug: str
    label: str
    description: str
    prompt: str
    loop_seconds: float
    cached: bool


class AmbienceListResponse(BaseModel):
    presets: List[AmbiencePresetOut]


@app.get("/api/v1/media/ambience")
async def list_ambience_presets(token: str = Depends(_require_auth)):
    """List curated soundscapes with availability metadata; any seat.

    Read-only catalog access costs nothing upstream, so listing stays open to
    every authenticated seat while generation remains staff-only. ``cached``
    reflects THIS gateway process's in-memory LRU only — another replica may
    still need a cold generation.
    """
    from .compendium.ambience_presets import AMBIENCE_PRESETS

    sfx_model = media_client.sfx_model
    presets = [
        AmbiencePresetOut(
            slug=p.slug,
            label=p.label,
            description=p.description,
            prompt=p.prompt,
            loop_seconds=p.loop_seconds,
            cached=(p.slug, sfx_model) in _ambience_cache,
        )
        for p in AMBIENCE_PRESETS
    ]
    return JSONResponse(
        content=AmbienceListResponse(presets=presets).model_dump(),
        headers=_MEDIA_NO_STORE_HEADERS,
    )


@app.post("/api/v1/media/ambience/{slug}")
async def generate_ambience(slug: str, token: str = Depends(_require_auth)):
    """Generate (or serve cached) one curated soundscape; GM/admin ONLY.

    Same authorization posture as POST /media/sfx: ambient beds play to the
    whole table, so triggering them is a staff decision. Repeat requests for
    an already-generated (slug, model) pair are answered from the bounded LRU
    without touching the upstream box.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(
            status_code=403,
            detail=(
                "MEDIA_AMBIENCE_FORBIDDEN: ambient soundscapes play to the "
                "whole table; only GM or admin seats may trigger them."
            ),
        )
    try:
        wav_bytes = await _load_ambience(slug)
    except (MediaGatewayUnavailableError, MediaGatewayRejectedError) as exc:
        raise _media_error_to_http(exc)
    return Response(
        content=wav_bytes, media_type="audio/wav", headers=_MEDIA_NO_STORE_HEADERS
    )


@app.get("/api/v1/media/narrations")
async def list_media_narrations(
    session_id: str = Query(...),
    token: str = Depends(_require_auth),
):
    """Recent narrations (newest first, max 50) for one session.

    Authenticated reads with standing in that session: any lobby member bound
    to it or gm/admin — the same derivation the x-card gate uses. Everyone
    else, including valid tokens naming sessions they never joined, gets 403;
    sessions with no roster fail closed to staff for the same reason x-card
    does.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        participant = await _caller_is_session_participant(
            actor["user_id"], session_id
        )
        if not participant:
            raise HTTPException(
                status_code=403,
                detail=(
                    "NARRATION_LIST_FORBIDDEN: only session participants (via "
                    "a lobby bound to that session) or GMs may read the "
                    f"narration log of session {session_id}."
                ),
            )
    rows = await storage_backend.list_narrations(session_id, limit=50)
    return JSONResponse(
        content={
            "session_id": session_id,
            "count": len(rows),
            "narrations": rows,
        },
        headers=_MEDIA_NO_STORE_HEADERS,
    )


def _bundle_token_to_entity(tok: Dict[str, Any]) -> Dict[str, Any]:
    """Converts a bundle token into an engine AddEntity payload. The engine's
    request flattens the EntityState with an optional `ingress` sibling;
    ingress gating is validated server-side (the verified flag is advisory).

    UNITS: bundle tokens carry GRID-CELL coordinates (the board convention),
    but EntityState.position is WORLD FEET ("world units == feet",
    vtt-core/src/state.rs distance_to_feet). Cell centers convert as
    (cell + 0.5) * 5.0 ft — the same center-offset the client board uses
    when converting back for rendering."""
    entity_id = engine_client._coerce_uuid(str(tok.get("id") or tok.get("name", "token")))
    hp = int(tok.get("hp", tok.get("max_hp", 10)) or 10)
    _BUNDLE_CELL_SIZE_FEET = 5.0  # matches import route's cell_size_feet
    x = (float(tok.get("x", 0.0) or 0.0) + 0.5) * _BUNDLE_CELL_SIZE_FEET
    y = (float(tok.get("y", 0.0) or 0.0) + 0.5) * _BUNDLE_CELL_SIZE_FEET
    return {
        "id": entity_id,
        "compendium_id": str(tok.get("compendium_id", "bundle_token")),
        "name": str(tok.get("name", "Token")),
        "is_player": bool(tok.get("is_player", False)),
        "current_hp": hp,
        "max_hp": hp,
        "temp_hp": 0,
        "ac": int(tok.get("ac", 10) or 10),
        "speed_feet": float(tok.get("speed", 30) or 30),
        "position": [x, y, 0.0],
        "zone_id": "Zone_Default",
        "abilities": {"strength": 10, "dexterity": 10, "constitution": 10,
                      "intelligence": 10, "wisdom": 10, "charisma": 10},
        "conditions": [],
        "action_budget": {"action": True, "bonus_action": True, "reaction": True,
                          "movement_remaining_feet": 30.0,
                          "free_object_interaction": True},
        "spell_slots_remaining": {},
        "attacks": [],
        "resistances": [],
        "vulnerabilities": [],
        "immunities": [],
        "inventory": {"items": {}},
        "is_conscious": True,
        "is_dead": False,
        "is_visible": True,
        "ingress": {
            "entity_id": entity_id,
            "ingress_type": "SPAWN_EVENT",
            "source_point": [0.0, 0.0, 0.0],
            "target_point": [x, y, 0.0],
            "verified": False,
        },
    }


@app.post("/api/v1/homebrew/parse-markdown")
def parse_homebrew_markdown(req: HomebrewParseRequest):
    parsed = global_homebrew_parser.parse_statblock(req.markdown_text)
    if req.strict and not parsed["parse_ok"]:
        raise HTTPException(
            status_code=422,
            detail=f"unparseable statblock, missing core fields: {parsed['warnings']}",
        )
    return parsed


async def _resolve_audit_inputs(req: NarrativeGenerateRequest) -> tuple[Dict[str, Any], int, int]:
    """Reconciles the request against LIVE engine state when a session is named.

    Returns (audited_payload, active_entity_count, previous_entity_count).
    Without engine_session_id the client-supplied values pass through
    unchanged (legacy/demo behavior). With one, the world inspector trusts
    the engine: lethality fields come from the live entity, entity counts
    come from the live snapshot, and a named-but-missing target is rejected
    as a ghost entity.
    """
    if not req.engine_session_id:
        return req.engine_execution_payload, req.active_entity_count, req.previous_entity_count

    try:
        ground = await _engine_ground_truth(req.engine_session_id)
    except engine_client.EngineUnavailableError as exc:
        raise HTTPException(
            status_code=502,
            detail=(
                "WORLD_INSPECTOR_UNAVAILABLE: engine unreachable — refusing to "
                f"audit client-supplied claims ({exc})"
            ),
        )

    audited_payload = dict(req.engine_execution_payload)
    if req.target_entity_id:
        target_state = _live_target_state(ground, req.target_entity_id)
        if target_state is None:
            raise HTTPException(
                status_code=409,
                detail="GHOST_ENTITY: named target does not exist in the live session",
            )
        audited_payload.update(target_state)

    # Conservation is evaluated against the authoritative snapshot: the live
    # entity count is the truth for both sides of the ledger equation.
    return audited_payload, ground["entity_count"], ground["entity_count"]


@app.post("/api/v1/narrative/generate")
@app.post("/api/v1/orchestrator/turn")
async def execute_orchestrator_turn(
    req: NarrativeGenerateRequest, token: str = Depends(_require_auth)
):
    # Any authenticated seat may run a narrated turn (players narrate too);
    # the identity check is the spend gate — every hit can reach the model and
    # is metered in the `llm` bucket.
    _caller_actor(token)
    # Classify FIRST (audit remediation): the LLM-assisted classifier runs when
    # configured; a keyword safety hit short-circuits before any network call
    # and before any engine grounding. Provenance ("classifier") is surfaced to
    # the client as a top-level non-breaking field on every response shape.
    decision = await classify_turn_intent(req.user_intent)

    # Gate mirrors the synthetic playtest harness: only mechanically-classified
    # intents reach the engine/audit turn cycle — pure lore, table talk, and
    # safety interventions carry no compliance semantics.
    if decision["intent_type"] is not IntentType.MECHANICAL_INVOCATION:
        is_safety = decision["intent_type"] is IntentType.SAFETY_INTERVENTION
        return {
            "status": "SAFETY_INTERVENTION" if is_safety else "SKIPPED_NON_MECHANICAL",
            "classified_intent": decision["intent_type"].value,
            "confidence": decision["confidence"],
            "classifier": decision["classifier"],
            "fallback_reason": decision["fallback_reason"],
        }

    audited_payload, active_count, previous_count = await _resolve_audit_inputs(req)

    def dm_draft(ctx=None):
        return dm_agent.generate_combat_draft(req.user_intent, audited_payload, ctx)

    cycle_result = retry_controller.run_turn_cycle(
        user_intent=req.user_intent,
        turn_index=req.turn_index,
        entity_id=req.entity_id,
        engine_execution_payload=audited_payload,
        dm_draft_generator=dm_draft,
        active_entity_count=active_count,
        previous_entity_count=previous_count,
        ingress_count=req.ingress_count,
        egress_count=req.egress_count,
    )
    # Honest provenance additions (non-breaking): which classifier produced the
    # intent that gated this turn.
    cycle_result["classifier"] = decision["classifier"]
    cycle_result["classified_intent"] = decision["intent_type"].value
    cycle_result["fallback_reason"] = decision["fallback_reason"]
    return cycle_result


@app.post("/api/v1/narrative/stream")
@app.post("/api/v1/orchestrator/narrative/stream")
async def stream_narrative_endpoint(
    req: NarrativeGenerateRequest, token: str = Depends(_require_auth)
):
    # Any authenticated seat may stream narration; the token check is the spend
    # gate (each accepted call can reach the model) and the `llm` bucket caps
    # how often.
    _caller_actor(token)
    # Ground-truth reconciliation happens BEFORE any token is emitted: when a
    # session is named, the stream must be reachable and audited against live
    # engine state, never the client's claims.
    audited_payload, active_count, previous_count = await _resolve_audit_inputs(req)

    # Ground the narration in SRD stat blocks whenever the player's action
    # names a known monster or spell — drawn from the NAMED SESSION's edition
    # corpus when one is bound (its persisted rule_version decides), the
    # default edition otherwise. This route already required a token above,
    # so the resolver's auth gate is satisfied by construction; provenance
    # rides along in the grounding context so degraded/offline narration
    # stays attributable.
    resolved = (
        await resolve_session_rule_version(req.engine_session_id, token)
        if req.engine_session_id else (None, "", "")
    )
    spells, monsters = _versioned_lists(resolved)
    _, grounding_provenance = _versioned_provenance(resolved, bool(req.engine_session_id))
    srd_facts = extract_srd_context(
        req.user_intent, spells=spells, monsters=monsters
    )
    raw_generator = streaming_gateway.stream_narrative(
        user_intent=req.user_intent,
        engine_payload=audited_payload,
        context={"srd": srd_facts, **grounding_provenance},
    )

    async def audited_stream():
        """Pre-commit invariant interception ON the streaming path.

        Tokens are HELD until the sentence they belong to has passed the
        auditor — nothing reaches the client unaudited. A genuine invariant
        violation (e.g. narrated death of a still-breathing target) emits a
        corrective system event and CUTS the stream; unaudited continuation
        is never forwarded.

        Honest degradation: when the LLM gateway signals its deterministic
        fallback (a (DEGRADED_MARKER, reason) sentinel item), a leading
        {"degraded": true, "reason": ...} frame is emitted and every
        subsequent frame — including the final done frame — carries
        {"degraded": true} so clients can distinguish canned narration from
        real model output.
        """
        import json as _json

        from .routing.llm_client import DEGRADED_MARKER

        pending = ""
        degraded = False
        degradation_reason: str | None = None

        def audit(sentence: str) -> list:
            verdict = auditor.audit_proposal(
                turn_index=req.turn_index,
                entity_id=req.entity_id,
                proposed_narrative=sentence,
                engine_execution_payload=audited_payload,
                active_entity_count=active_count,
                previous_entity_count=previous_count,
                ingress_verified_count=req.ingress_count,
                egress_verified_count=req.egress_count,
            )
            return list(verdict.failures)

        def halt_frames(corrective: str):
            yield "data: " + _json.dumps({
                "token": f" [SYSTEM: narrative halted by Pre-Commit Auditor — {corrective}]",
                "done": False,
                **({"degraded": True, "reason": degradation_reason} if degraded else {}),
            }) + "\n\n"
            yield "data: " + _json.dumps({
                "token": "",
                "done": True,
                **({"degraded": True} if degraded else {}),
            }) + "\n\n"

        async for chunk in raw_generator:
            if isinstance(chunk, tuple):
                # Degradation sentinel from the deterministic fallback path.
                if chunk and chunk[0] == DEGRADED_MARKER:
                    degraded = True
                    degradation_reason = str(chunk[1]) if len(chunk) > 1 else "unknown"
                    yield "data: " + _json.dumps({
                        "degraded": True,
                        "reason": degradation_reason,
                    }) + "\n\n"
                continue
            if not chunk.startswith("data: "):
                continue
            try:
                frame = _json.loads(chunk[len("data: "):])
            except (ValueError, TypeError):
                continue
            if frame.get("done"):
                break
            pending += frame.get("token", "")

            # Audit each completed sentence BEFORE releasing it.
            while True:
                match = _SENTENCE_END_RE.search(pending)
                if match is None:
                    break
                sentence = pending[:match.end()]
                failures = audit(sentence)
                if failures:
                    corrective = "; ".join(f.corrective_constraint for f in failures)
                    for out in halt_frames(corrective):
                        yield out
                    return
                yield "data: " + _json.dumps({
                    "token": sentence,
                    "done": False,
                    **({"degraded": True} if degraded else {}),
                }) + "\n\n"
                pending = pending[match.end():]

        # Final audit on the trailing (unterminated) fragment.
        if pending.strip():
            failures = audit(pending)
            if failures:
                corrective = "; ".join(f.corrective_constraint for f in failures)
                for out in halt_frames(corrective):
                    yield out
                return
            yield "data: " + _json.dumps({
                "token": pending,
                "done": False,
                **({"degraded": True} if degraded else {}),
            }) + "\n\n"

        yield "data: " + _json.dumps({
            "token": "",
            "done": True,
            **({"degraded": True} if degraded else {}),
        }) + "\n\n"

    return StreamingResponse(
        audited_stream(),
        media_type="text/event-stream",
    )


_SENTENCE_END_RE = re.compile(r"[.!?…](\s|$)")


@app.get("/api/v1/compendium/lore-lookup")
async def compendium_lore_lookup(
    q: str = Query(..., description="Text to scan for SRD monster/spell references"),
    semantic: bool = Query(
        False,
        description="Rank via the Qdrant compendium RAG index when enabled",
    ),
    k: int = Query(5, ge=1, le=25, description="Top-K entries (semantic mode)"),
    engine_session_id: Optional[str] = Query(
        None,
        description=(
            "Prefer this session's persisted rule_version corpus "
            "(requires an authenticated caller)"
        ),
    ),
    token: Optional[str] = Depends(_token_from),
):
    # Response shape is identical across retrieval modes; the "retrieval"
    # provenance field tells callers which path served the facts:
    # "qdrant-dense-sparse" | "qdrant-dense" | "qdrant-hash-fallback"
    # (vector search — the last one is NOT semantic, just lexical hashing)
    # | "substring" | "substring_fallback".
    # Same auth gate as /spells and /monsters (audit F-A3#5).
    resolved = (
        await resolve_session_rule_version(engine_session_id, token)
        if engine_session_id else (None, "", "")
    )
    spells, monsters = _versioned_lists(resolved)
    effective_version, provenance = _versioned_provenance(resolved, bool(engine_session_id))
    # The Qdrant index is built once at startup from the DEFAULT corpus, so its
    # hits cannot be re-labeled with another session's edition. When the
    # session's version differs we degrade to the versioned substring scan
    # instead of serving 5.2-indexed facts under a 5.1 banner.
    rag_edition_mismatch = (
        bool(engine_session_id)
        and effective_version != default_rule_version
    )
    if semantic:
        results = compendium_rag.search(q, k=k)
        if results is not None and not rag_edition_mismatch:
            return {
                "query": q,
                "facts": results,
                "retrieval": getattr(
                    compendium_rag, "retrieval_provenance", "qdrant"
                ),
                **provenance,
            }
        marker = (
            "substring_fallback"
            if compendium_rag.available or rag_edition_mismatch
            else "substring"             # never enabled/reachable
        )
        if rag_edition_mismatch and resolved[1] == "session":
            provenance["rule_version_reason"] = (
                f"semantic index serves the {default_rule_version} corpus; "
                f"fell back to the {effective_version} substring scan"
            )
        return {
            "query": q,
            "facts": extract_srd_context(q, limit=k, spells=spells, monsters=monsters),
            "retrieval": marker,
            **provenance,
        }
    return {
        "query": q,
        "facts": extract_srd_context(q, spells=spells, monsters=monsters),
        "retrieval": "substring",
        **provenance,
    }


async def _caller_is_session_participant(user_id: str, engine_session_id: str) -> bool:
    """True when the caller's lobby membership is bound to this engine session.

    The gateway's authoritative session-membership data IS the lobby roster:
    members join via invite code and the host's launch binds
    ``engine_session_id`` onto the lobby (storage.set_lobby_session). That
    binding is what legitimizes a participant for session-affecting actions.
    """
    lobbies = await storage_backend.list_lobbies_for_user(user_id)
    return any(
        lobby.get("engine_session_id") == engine_session_id for lobby in lobbies
    )


@app.post("/api/v1/lore/assert")
def assert_lore(
    assertion: LoreAssertionPayload,
    token: str = Depends(_require_auth),
):
    """Commit or stage a lore assertion under the Pillar-7 epistemic ladder.

    Authorization model (enforced here, never taken from the request body):

    * Every assertion ENTERS at SUBJECTIVE_RUMOR — that is the schema default.
    * player/spectator tokens (and any unrecognized role — fails closed) can
      never set a tier above rumor; their assertions stage into the paradox /
      verification pipeline like everyone else's rumors. A request body that
      claims more gets an honest 403, not a silent downgrade.
    * gm/admin tokens may promote ONE step per call:
      rumor -> PROPOSED_FACT directly, and an existing staged PROPOSED_FACT
      triple on to VALIDATED_CANON (weight 1.0). Jumping two steps in one call
      is refused so canon always passes through the staged-fact review.

    Response shape (unchanged across all outcomes):
      ``{status, epistemic_tier, assigned_weight, latency_ms}`` where status is
      COMMITTED | STAGED | REJECTED_PARADOX; 403 refusals carry a
      ``LORE_TIER_FORBIDDEN`` detail string.
    """
    actor = _caller_actor(token)  # 401 on invalid/expired tokens

    requested = assertion.epistemic_tier
    if requested != EpistemicTier.SUBJECTIVE_RUMOR:
        if actor.get("role", "") not in ("gm", "admin"):
            raise HTTPException(
                status_code=403,
                detail=(
                    "LORE_TIER_FORBIDDEN: only GM tokens may promote lore above "
                    f"SUBJECTIVE_RUMOR; requested {requested.value}. Your "
                    f"assertion was NOT committed — resubmit without an "
                    f"epistemic_tier to enter it as a rumor."
                ),
            )
        if requested == EpistemicTier.VALIDATED_CANON:
            current = lore_graph.current_tier(
                assertion.subject_node_id,
                assertion.predicate_relation,
                assertion.object_node_id,
            )
            if current != EpistemicTier.PROPOSED_FACT:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        "LORE_TIER_FORBIDDEN: promotion is one step per call — "
                        "VALIDATED_CANON requires this exact triple to already be "
                        f"staged at PROPOSED_FACT (found {current.value if current else 'nothing'})."
                    ),
                )

    return lore_graph.submit_assertion(assertion)


@app.post("/api/v1/spotlight/record")
async def record_spotlight(
    req: UtteranceRecordRequest, token: str = Depends(_require_auth)
):
    """Records one spoken utterance for agency tracking.

    speaker_id must BE the authenticated caller (user id, username, or display
    name — case-insensitive) unless the caller holds a gm/admin token: letting
    a client attribute utterances to other voices would let one player skew
    spotlight/agency scoring for the whole table. 403 with a
    ``SPOTLIGHT_SPOOFED_SPEAKER`` detail otherwise.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        profile = await storage_backend.get_user_by_id(actor["user_id"])
        identities = {actor["user_id"]}
        if profile:
            identities.update(
                str(profile.get(field, "")).strip().lower()
                for field in ("username", "display_name", "displayName")
            )
        if req.speaker_id.strip().lower() not in {i for i in identities if i}:
            raise HTTPException(
                status_code=403,
                detail=(
                    "SPOTLIGHT_SPOOFED_SPEAKER: you may only record your own "
                    "voice; ask the GM to attribute other speakers."
                ),
            )
    spotlight_tracker.record_utterance(req.speaker_id, req.duration_sec)
    return {
        "status": "recorded",
        "agency_weights": spotlight_tracker.calculate_agency_weights(),
        "sidelined_players": spotlight_tracker.get_sidelined_players(),
    }


@app.get("/api/v1/spotlight/agency")
def get_spotlight_agency(token: str = Depends(_require_auth)):
    _caller_actor(token)  # authenticated read; any role
    return {
        "agency_weights": spotlight_tracker.calculate_agency_weights(),
        "sidelined_players": spotlight_tracker.get_sidelined_players(),
    }


@app.post("/api/v1/safety/x-card")
async def trigger_x_card(req: XCardRequest, token: str = Depends(_require_auth)):
    """Player-veto safety intervention (Pillar-11).

    Trust decisions:

    * An authenticated HMAC token is REQUIRED. An x-card rewinds scene state,
      which makes it state-affecting even though its purpose is protective.
    * The intervention must be filed under the CALLER's own user id unless the
      caller is gm/admin — no filing interventions attributed to someone else.
    * When ``engine_session_id`` names a live session, legitimacy comes from
      the membership data the gateway actually owns: gm/admin globally, or any
      member of a lobby bound to that engine session (host launch creates the
      binding; invite-code joins create the roster). Everyone else — including
      otherwise-valid tokens naming sessions they never joined — gets 403.
    * Sessions with NO lobby binding (created out-of-band through the engine
      proxy) are rewindable by gm/admin tokens ONLY, because there is no
      roster proving a player's standing: fail closed.
    * When no session is named, nothing is rewound; any authenticated caller
      may still record the intervention against their own id.

    Response shape unchanged: ``{status, target_sequence_id, ...,
    engine_rewind?}`` where ``engine_rewind`` appears only when a session was
    named.
    """
    actor = _caller_actor(token)
    is_staff = actor.get("role", "") in ("gm", "admin")

    if req.player_id != actor["user_id"] and not is_staff:
        raise HTTPException(
            status_code=403,
            detail=(
                "X_CARD_IDENTITY_MISMATCH: file the intervention under your own "
                "player id."
            ),
        )

    if req.engine_session_id and not is_staff:
        participant = await _caller_is_session_participant(
            actor["user_id"], req.engine_session_id
        )
        if not participant:
            raise HTTPException(
                status_code=403,
                detail=(
                    "X_CARD_NOT_A_PARTICIPANT: only session participants (via a "
                    "lobby bound to that session) or GMs may trigger a rewind of "
                    f"session {req.engine_session_id}."
                ),
            )

    result = safety_gateway.trigger_x_card(
        player_id=req.player_id,
        topic=req.topic,
        current_sequence_id=req.current_sequence_id,
    )
    # Apply the rewind against the authoritative engine ledger when a live
    # session is bound; the intervention still records orchestrator-side.
    if req.engine_session_id:
        try:
            engine_result = await engine_client.engine_request(
                "POST",
                f"/api/v1/sessions/{req.engine_session_id}/safety/x-card",
                {
                    "player_id": req.player_id,
                    "topic": req.topic,
                    "target_sequence_id": result["target_sequence_id"],
                },
            )
            result["engine_rewind"] = engine_result
        except EngineUnavailableError as exc:
            result["engine_rewind"] = {"status": "ENGINE_UNAVAILABLE", "detail": str(exc)}
        except EngineRejectedError as exc:
            # The orchestrator-side intervention still records; the engine
            # rewind is best-effort. A live engine may reject an unknown
            # session (404) or refuse for its own reasons — surface it
            # honestly instead of failing the whole X-card request.
            result["engine_rewind"] = {
                "status": "ENGINE_REJECTED",
                "detail": f"engine {exc.status_code}: {exc.detail}",
            }
    return result


@app.post("/api/v1/simulation/tick")
def advance_faction_simulation(token: str = Depends(_require_auth)):
    """GM/admin only: a tick advances the SHARED faction simulation every table
    observes — letting any caller drive world state would let one player
    rewrite it for everyone."""
    if _caller_actor(token).get("role", "") not in ("gm", "admin"):
        raise HTTPException(
            status_code=403,
            detail=(
                "SIMULATION_TICK_FORBIDDEN: only GM tokens may advance the "
                "shared faction simulation."
            ),
        )
    actions = faction_sim.advance_simulation_tick()
    return {
        "faction_name": faction_sim.faction_name,
        "remaining_resources": faction_sim.resources,
        "world_state": faction_sim.world_state,
        "actions_executed": actions,
    }


from .simulation.quest_engine import (
    QuestGraphGenerator,
    ConcordiaPactEngine,
    QuestGraph,
)

global_quest_generator = QuestGraphGenerator()
# Session-local by design: a stateless treaty calculator over request inputs.
# Nothing accumulates here worth persisting.
global_concordia_engine = ConcordiaPactEngine()
# PROCESS-MEMORY-ONLY shared campaign state (audit finding: quest graphs lived
# only in gateway process memory). Iteration 47 made it durable: the graph is
# serialized into campaign autosave snapshots (_quest_slot) and restored on an
# authenticated reload — via GET /api/v1/quest/active after a restart, or
# explicitly through POST /api/v1/campaign/restore. Between saves it still
# lives only here.
active_campaign_quest: Optional[QuestGraph] = None


class QuestGenerateRequest(BaseModel):
    campaign_theme: str = "The Iron Succession"
    primary_house: str = "house_vane"
    rival_house: str = "house_silverpeak"


class ConcordiaNegotiateRequest(BaseModel):
    house_a: str = "House Vane"
    house_b: str = "House Silverpeak"
    diplomacy_roll: int = 16
    concessions_offered: str = "Equal trade tariff exemptions and shared mining rights"


@app.post("/api/v1/quest/generate")
def generate_quest(req: QuestGenerateRequest, token: str = Depends(_require_auth)):
    """GM-only quest generation (mirrors the autosave role gate).

    Generation mutates shared gateway state — it replaces the module-level
    ``active_campaign_quest`` graph every player's journal reads — so a player
    caller is rejected 403 before any engine-side generation runs.
    """
    global active_campaign_quest
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(status_code=403, detail="QUEST_GENERATION_GM_ONLY")

    quest = global_quest_generator.generate_campaign_quest(
        campaign_theme=req.campaign_theme,
        primary_house=req.primary_house,
        rival_house=req.rival_house,
    )
    active_campaign_quest = quest
    return quest


@app.get("/api/v1/quest/active")
async def get_active_quest(token: str = Depends(_require_auth)):
    # Authenticated read, any role: the active graph is shared campaign state
    # players must be able to see (mirrors handout reads).

    global active_campaign_quest
    if not active_campaign_quest:
        try:
            restored = await _restore_latest_gateway_state(_owner_or_401(token))
        except QuestSlotCorrupt as exc:
            # A saved graph that no longer parses must not be silently replaced
            # by a fresh roll behind the table's back.
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if restored is not None:
            return restored
        # No durable campaign state anywhere (fresh install / legacy saves
        # only): generate as before. This is the one place regeneration is
        # honest — there is nothing saved to be faithful to.
        active_campaign_quest = global_quest_generator.generate_campaign_quest()
    return active_campaign_quest


@app.post("/api/v1/quest/concordia-negotiate")
def negotiate_concordia_pact(
    req: ConcordiaNegotiateRequest, token: str = Depends(_require_auth)
):
    # Token-required pact computation over supplied inputs; open to any
    # authenticated role (players drive negotiation from the dialogue view).

    result = global_concordia_engine.negotiate_treaty(
        house_a_name=req.house_a,
        house_b_name=req.house_b,
        player_diplomacy_roll=req.diplomacy_roll,
        concessions_offered=req.concessions_offered,
    )
    return result


# ---------------------------------------------------------------------------
# NPC persona registry routes (GOALS.md Pillar 5 runtime surface)
#
# ConcordiaNPC sub-agents (agents/npc_sub_agent.py) become reachable at
# runtime: a module-level registry of personas keyed to the starter
# adventure's cast, all sharing ONE NpcDispositionEngine singleton so
# stances persist across calls for the lifetime of the process.
# ---------------------------------------------------------------------------

from .agents.npc_sub_agent import (
    ConcordiaNPC,
    Goal,
    GoalsComponent,
    LinguisticStyleComponent,
    MemoryComponent,
    SocialNorm,
    SocialNormsComponent,
)
from .simulation.npc_disposition import KNOWN_INTERACTION_KINDS, NpcDispositionEngine


def _build_persona_registry(disposition_engine: NpcDispositionEngine) -> Dict[str, ConcordiaNPC]:
    """Personas composed from the four components, keyed to the starter cast.

    Every persona gets ``llm_gateway=streaming_gateway`` so the norms-gated
    LLM path engages whenever an API key is configured; the gateway contract
    returns None in mock mode and ConcordiaNPC falls back to its
    deterministic template reply, so unconfigured deployments stay pure.
    """
    return {
        # starter_adventures.py: NPC_Karas_Drowned_Steward — GUARDS the crypt.
        "karas_drowned_steward": ConcordiaNPC(
            npc_id="karas_drowned_steward",
            name="The Drowned Steward",
            role="Undead Warden of the Sunken Crypt of Karas",
            memory=MemoryComponent(capacity=20),
            goals=GoalsComponent([
                Goal("Keep intruders out of the Sunken Crypt of Karas", priority=10),
                Goal("Serve the will of Baron Vane without question", priority=6),
                Goal("Find peace from the tide that binds him", priority=2),
            ]),
            norms=SocialNormsComponent([
                SocialNorm.taboo(
                    ["sunblade"],
                    reason="never speak of the blade that burned him into service",
                ),
            ]),
            style=LinguisticStyleComponent(
                formality=0.9,
                verbosity=0.4,
                tone="drowned, reverent, mournful",
                signature_phrases=("The tide keeps its own counsel.",),
            ),
            disposition_engine=disposition_engine,
            llm_gateway=streaming_gateway,
        ),
        # starter_adventures.py: NPC_Baron_Vane — ENTOMBED_IN the crypt.
        "baron_aldous_vane": ConcordiaNPC(
            npc_id="baron_aldous_vane",
            name="Baron Aldous Vane",
            role="Entombed Lord of Oakhaven Keep",
            memory=MemoryComponent(capacity=20),
            goals=GoalsComponent([
                Goal("Restore the honour of House Vane", priority=9),
                Goal("Learn who dares disturb his tomb", priority=7),
                Goal("Avenge his murder by the Shadow Cabal", priority=5),
            ]),
            norms=SocialNormsComponent([
                SocialNorm.taboo(
                    ["shadow cabal"],
                    reason="the Baron refuses to name the cabal that betrayed him",
                ),
                SocialNorm.obligation(
                    "never beg any mortal for mercy",
                    lambda reply, ctx: "mercy" in reply.lower() if "please" in reply.lower() else None,
                ),
            ]),
            style=LinguisticStyleComponent(
                formality=0.95,
                verbosity=0.8,
                tone="imperious, sepulchral",
                signature_phrases=("Oakhaven endures.",),
            ),
            disposition_engine=disposition_engine,
            llm_gateway=streaming_gateway,
        ),
        # starter_adventures.py: Faction_Shadow_Cabal — SEEKS Item_Sunblade.
        "shadow_cabal_emissary": ConcordiaNPC(
            npc_id="shadow_cabal_emissary",
            name="The Cabal Emissary",
            role="Envoy of the Shadow Cabal",
            memory=MemoryComponent(capacity=20),
            goals=GoalsComponent([
                Goal("Acquire the relic entombed beneath Karas", priority=10),
                Goal("Recruit the speaker as an unwitting agent", priority=6),
                Goal("Leave no witness who heard the offer", priority=3),
            ]),
            norms=SocialNormsComponent([
                SocialNorm.taboo(
                    ["pelor"],
                    reason="the Cabal never utters the dawn god's name",
                ),
            ]),
            style=LinguisticStyleComponent(
                formality=0.2,
                verbosity=0.6,
                tone="silky, transactional",
                signature_phrases=("Everyone has a price.",),
            ),
            disposition_engine=disposition_engine,
            llm_gateway=streaming_gateway,
        ),
    }


#: Shared disposition singleton: one engine, many personas, persistent stances.
#: The zero-clock keeps decay deterministic (same convention as campaign_sim).
#: SESSION-LOCAL by design (iteration 47 audit): personas are rebuilt
#: deterministically from the curated tables at import / reset_npc_registry(),
#: so there is nothing durable-worthy to save — accumulated stance drift is
#: accepted as per-session state.
_npc_disposition_engine = NpcDispositionEngine(clock=lambda: 0.0)
_NPC_REGISTRY: Dict[str, ConcordiaNPC] = _build_persona_registry(_npc_disposition_engine)


def reset_npc_registry() -> None:
    """Rebuild pristine personas + disposition state (test isolation hook)."""
    global _npc_disposition_engine, _NPC_REGISTRY
    _npc_disposition_engine = NpcDispositionEngine(clock=lambda: 0.0)
    _NPC_REGISTRY = _build_persona_registry(_npc_disposition_engine)


class NpcRespondRequest(BaseModel):
    utterance: str = Field(min_length=1, max_length=2000)


class NpcInteractionRequest(BaseModel):
    kind: str
    # Capped at the disposition engine's per-event scale (a magnitude-10 event
    # already saturates a stance band); larger values would let one call pin a
    # stance to an extreme. Beyond-cap requests are rejected with 422.
    magnitude: float = Field(default=1.0, gt=0.0, le=10.0)


@app.get("/api/v1/npc/")
async def list_npc_personas():
    """Public metadata only: id/name/role. No goals, norms or internals."""
    return {
        "npcs": [
            {"id": npc.npc_id, "name": npc.name, "role": npc.role}
            for npc in _NPC_REGISTRY.values()
        ]
    }


@app.post("/api/v1/npc/{npc_id}/respond")
async def npc_respond(npc_id: str, req: NpcRespondRequest, token: str = Depends(_require_auth)):
    """One in-character reply. Norms-violating candidates are replaced by the
    deterministic fallback inside ConcordiaNPC and reported via norm_rejected."""
    npc = _NPC_REGISTRY.get(npc_id)
    if npc is None:
        raise HTTPException(status_code=404, detail=f"Unknown NPC: {npc_id}")
    player_id = _require_user_id(token)
    result = await npc.respond_to(player_id, req.utterance)
    payload: Dict[str, Any] = {
        "reply": result["reply"],
        "generator": result["generator"],
        "stance": result["stance"],
        "npc_id": result["npc_id"],
    }
    if "norm_rejected" in result:
        payload["norm_rejected"] = result["norm_rejected"]
    return payload


@app.post("/api/v1/npc/{npc_id}/interactions")
async def npc_record_interaction(
    npc_id: str, req: NpcInteractionRequest, token: str = Depends(_require_auth)
):
    """Record one disposition outcome (aided/attacked/gifted/...) so the
    stance used by /respond shifts and persists across calls."""
    npc = _NPC_REGISTRY.get(npc_id)
    if npc is None:
        raise HTTPException(status_code=404, detail=f"Unknown NPC: {npc_id}")
    if req.kind not in KNOWN_INTERACTION_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown interaction kind {req.kind!r}; expected one of {sorted(KNOWN_INTERACTION_KINDS)}",
        )
    player_id = _require_user_id(token)
    npc.apply_outcome(req.kind, player_id, magnitude=req.magnitude)
    return {
        "npc_id": npc_id,
        "player_id": player_id,
        "kind": req.kind,
        "stance": _npc_disposition_engine.stance(npc_id, player_id),
        "disposition": _npc_disposition_engine.disposition(npc_id, player_id),
    }


# --- External platform import (Pillar 10 interop) -----------------------------------
# Wire-up of the tested importers in compendium/ onto the HTTP surface. Roll20
# exports are single JSON documents, so they arrive as one request body;
# Foundry modules are directory trees delivered as a zip through the multipart
# upload route below (import_foundry_upload), which extracts safely inside a
# temp dir before delegating to compendium/foundry_importer.py.

# Sanity bound on an import body. Real Roll20 character/campaign exports are
# kilobytes; anything near this limit is an accidental dump or abuse.
_MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024

# Sanity bound on a Foundry module upload. Real community modules range from
# tens of KB (pure data packs) to tens of MB (embedded art); 64 MiB admits
# every data-bearing module while refusing accidental dumps and abuse.
_MAX_FOUNDRY_UPLOAD_BYTES = 64 * 1024 * 1024

# Cumulative uncompressed size the WHOLE archive may expand to inside the
# temp dir (zip-bomb defense, enforced two ways):
#   1. up front: the sum of every entry's DECLARED uncompressed size must fit
#      this budget before a single byte is extracted;
#   2. during extraction: ONE running total spans all entries, so each entry
#      gets whatever is left of the same budget — never its own fresh
#      allowance (a header that understates its real size trips the running
#      total mid-copy).
_MAX_FOUNDRY_EXTRACTED_BYTES = 256 * 1024 * 1024

_ABILITY_ORDER = ("STR", "DEX", "CON", "INT", "WIS", "CHA")


class Roll20ImportRequest(BaseModel):
    # Untyped on purpose: the importer itself validates the export's shape and
    # raises ValueError for anything unrecognized (mapped to 422 below), so the
    # gateway must not pre-empt it with a stricter schema.
    character_json: Any


def _import_int(value: Any, default: int) -> int:
    """Int coercion for imported stats; non-numeric -> the create-character
    default (the importer already warned about the unmappable raw value)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return int(value)


def _import_text(value: Any, default: str) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else default


def _projected_to_character_payload(
    projected: Dict[str, Any],
) -> Tuple[Dict[str, Any], List[str]]:
    """Map one importer projection onto the EXISTING storage payload shape
    served by POST /api/v1/characters (CharacterCreateRequest).

    Identity fields are NEVER invented here: an absent class/race/background/
    alignment persists as an empty string (not a plausible-sounding
    "fighter"/"Human") and is reported in the returned substitution warnings,
    which the route merges into its response envelope. A missing level falls
    back to the storage floor of 1 — allowed because level must be a positive
    int — but only WITH a warning naming it, and a level outside 1..20 is
    clamped into range with its own "level out of range" warning.

    Numeric combat stats keep that route's defaults when the importer found
    nothing (the importer already emits a per-field "missing core stat"
    warning for each of them). Speed is the exception where a default would
    fabricate gameplay data: when the importer could not reduce movement text
    to feet, speed is persisted as None rather than silently becoming 30.

    Returns ``(payload, substitution_warnings)``; the caller prefixes them
    with the character name and surfaces them in the import response.

    max_hp/temp_hp have no slot in the current storage shape and are dropped
    here (documented lossiness of this iteration, not a silent guess).
    """
    warnings: List[str] = []

    klass = (projected.get("character_class") or "").strip()
    if not klass:
        warnings.append("class not present in export; left empty")
    race = (projected.get("race") or "").strip()
    if not race:
        warnings.append("race not present in export; left empty")
    background = (projected.get("background") or "").strip()
    if not background:
        warnings.append("background not present in export; left empty")
    alignment = (projected.get("alignment") or "").strip()
    if not alignment:
        warnings.append("alignment not present in export; left empty")

    level_raw = projected.get("level")
    if isinstance(level_raw, bool) or not isinstance(level_raw, (int, float)):
        warnings.append(f"level not present in export; defaulted to 1 (got {level_raw!r})")
    elif not 1 <= int(level_raw) <= 20:
        # Storage caps level at 20; clamping is unavoidable, but it must be
        # disclosed like every other substitution this projection makes.
        warnings.append(
            f"level out of range; clamped {int(level_raw)} into 1..20"
        )
    level = min(20, max(1, _import_int(level_raw, 1)))

    abilities_raw = projected.get("abilities") or {}
    speed_raw = projected.get("speed")
    if isinstance(speed_raw, bool) or not isinstance(speed_raw, (int, float)):
        # The importer passed unparsable movement text through verbatim and
        # warned; persisting 30 would turn that guess into authoritative data.
        warnings.append(
            f"speed not determinable from export ({speed_raw!r}); stored as null "
            "instead of inventing a default"
        )
        speed: Any = None
    else:
        speed = int(speed_raw)

    payload = {
        "name": projected["name"],
        "character_class": klass.lower(),
        "level": level,
        "race": race,
        "background": background,
        "alignment": alignment,
        "abilities": {
            key: _import_int(abilities_raw.get(key), 10) for key in _ABILITY_ORDER
        },
        "hp": _import_int(projected.get("hp"), 12),
        "ac": _import_int(projected.get("ac"), 16),
        "speed": speed,
        "features": [],
        "spells": [],
    }
    return payload, warnings


@app.post("/api/v1/import/roll20")
async def import_roll20(
    req: Roll20ImportRequest,
    request: Request,
    token: str = Depends(_require_auth),
):
    """Persist characters from a Roll20 JSON export under the caller's account.

    Accepts either a single-character export ({name, attribs[]}) or a campaign
    export (a list, or {"characters": [...]}). Each recognized character is
    persisted through the same storage path as POST /api/v1/characters and
    owned by the authenticated caller; malformed members of a campaign are
    skipped with warnings instead of aborting the batch, while an entirely
    unrecognizable document fails with 422.
    """
    user_id = _require_user_id(token)

    # Size sanity before touching the parser: declared Content-Length when the
    # transport provides it, otherwise the size of what we actually parsed.
    declared = request.headers.get("content-length", "")
    body_size = int(declared) if declared.isdigit() else len(
        json.dumps(req.character_json, default=str)
    )
    if body_size > _MAX_IMPORT_BODY_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Import body exceeds {_MAX_IMPORT_BODY_BYTES} byte sanity bound "
                f"(got {body_size}); Roll20 character exports are far smaller — "
                "is this the wrong file?"
            ),
        )

    try:
        result = global_roll20_importer.import_character(req.character_json)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if isinstance(result.get("characters"), list):
        projected_list = result["characters"]
        skipped = result.get("skipped", 0)
        warnings = [str(w) for w in result.get("warnings", [])]
    else:
        projected_list = [result]
        skipped = 0
        warnings = []

    # A batch in which NOTHING was recognizable persisted zero rows; answering
    # 200 would hide the failure, so it fails loud with the skip reasons.
    if not projected_list:
        raise HTTPException(
            status_code=422,
            detail=(
                "Roll20 import persisted no characters: "
                + ("; ".join(warnings) if warnings else "no recognizable characters in export")
            ),
        )

    persisted: List[Dict[str, Any]] = []
    for projected in projected_list:
        payload, substitution_warnings = _projected_to_character_payload(projected)
        record = await storage_backend.create_character(user_id, payload)
        warnings.extend(f"{projected['name']}: {w}" for w in projected.get("warnings", []))
        warnings.extend(
            f"{projected['name']}: {w}" for w in substitution_warnings
        )
        persisted.append({
            "character_id": record["character_id"],
            "name": record["name"],
            "character_class": record["character_class"],
            "level": record["level"],
        })

    return {
        "imported": len(persisted),
        "skipped": skipped,
        "warnings": warnings,
        "characters": persisted,
    }


def _reject_unsafe_zip_entry(name: str) -> Optional[str]:
    """Return a rejection reason when an archive entry name is unsafe to
    extract (zip-slip traversal, absolute path, drive letter, NUL byte), else
    None when the entry may proceed."""
    if not name or "\x00" in name:
        return "empty or NUL-bearing archive entry name"
    normalized = name.replace("\\", "/")
    if re.match(r"^[A-Za-z]:", normalized):
        return f"absolute Windows-style archive entry: {name!r}"
    pure = PurePosixPath(normalized)
    if pure.is_absolute():
        return f"absolute archive entry path: {name!r}"
    if ".." in pure.parts:
        return f"archive entry escapes the extraction directory: {name!r}"
    return None


def _copy_bounded(src, dst, budget_remaining: Optional[List[int]] = None) -> int:
    """Stream ``src`` into ``dst`` refusing to let this entry's bytes push the
    ARCHIVE's running total past ``_MAX_FOUNDRY_EXTRACTED_BYTES``.

    The bound is cumulative across every entry of one extraction, not a
    per-entry allowance: each entry draws down whatever is left of the same
    budget via ``budget_remaining`` (a 1-element list acting as shared state,
    so the caller's loop carries the total forward). Zip headers can
    understate real sizes, so the streamed copy — not just declared metadata —
    enforces the line; an entry that lies is cut off MID-COPY.
    """
    if budget_remaining is None:
        budget_remaining = [_MAX_FOUNDRY_EXTRACTED_BYTES]
    copied = 0
    while True:
        chunk = src.read(1024 * 1024)
        if not chunk:
            break
        if len(chunk) > budget_remaining[0]:
            # Write only what remains, then stop: never exceed the total.
            if budget_remaining[0] > 0:
                dst.write(chunk[: budget_remaining[0]])
                budget_remaining[0] = 0
            raise ValueError(
                f"archive exceeds its cumulative {_MAX_FOUNDRY_EXTRACTED_BYTES} "
                "byte extraction bound mid-entry (zip-bomb protection); "
                "extraction stopped"
            )
        dst.write(chunk)
        copied += len(chunk)
        budget_remaining[0] -= len(chunk)
    return copied


def _lying_entry_reader(declared: int, actual_bytes: bytes):
    """Test seam: a duck-typed ``ZipFile.open(info)`` replacement whose header
    claims ``declared`` uncompressed bytes but whose stream yields all of
    ``actual_bytes``. CPython's zipfile caps reads at the declared size, so no
    real archive can express that gap through ``ZipExtFile`` — which is why
    this helper exists for tests instead of being reachable from a crafted
    upload."""
    class _LyingStream:
        def __init__(self):
            self._buf = io.BytesIO(actual_bytes)

        def read(self, n=-1):
            return self._buf.read(n)

    return lambda: _LyingStream()


def _reject_declared_size_overrun(archive) -> None:
    """Sum every entry's DECLARED uncompressed size and refuse the archive up
    front when the sum alone would blow the extraction budget. This is the
    cheap first gate; the streamed copy still re-checks honestly because
    headers can also UNDERSTATE their real size."""
    declared_total = 0
    for info in archive.infolist():
        if info.is_dir():
            continue
        declared_total += info.file_size
        if declared_total > _MAX_FOUNDRY_EXTRACTED_BYTES:
            raise ValueError(
                f"archive declares {declared_total} cumulative uncompressed "
                f"bytes, over the {_MAX_FOUNDRY_EXTRACTED_BYTES} byte "
                f"extraction bound (zip-bomb protection)"
            )


@app.post("/api/v1/import/foundry/upload")
async def import_foundry_upload(
    request: Request,
    file: UploadFile = File(...),
    token: str = Depends(_require_auth),
):
    """Import a zipped Foundry VTT module via multipart upload.

    The archive is extracted INSIDE a per-request temp dir with zip-slip
    protection (traversal entries, absolute paths and symlinks are rejected
    with 422 before anything is written), then the existing fail-loud
    FoundryModuleImporter library runs against the extracted module tree.
    GM/admin seats only: module import reshapes shared table content, which
    mirrors the staff-role gate on campaign autosave rather than Roll20's
    self-owned-character import.
    """
    actor = _caller_actor(token)
    if actor.get("role", "") not in ("gm", "admin"):
        raise HTTPException(
            status_code=403,
            detail="Foundry module import requires a GM or admin seat",
        )

    # Size sanity before any work: declared Content-Length first (cheap), then
    # the bytes actually received (honest).
    cap = _MAX_FOUNDRY_UPLOAD_BYTES
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > cap:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Foundry module upload exceeds the {cap} byte sanity bound "
                f"(declared {declared}); is this the right file?"
            ),
        )
    # Stream the multipart body in chunks with a running size check, so a
    # client that lies about Content-Length cannot buffer an unbounded body
    # in memory before the bound is applied.
    chunks: List[bytes] = []
    received = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        received += len(chunk)
        if received > cap:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Foundry module upload exceeds the {cap} byte sanity "
                    f"bound (received {received}); is this the right file?"
                ),
            )
        chunks.append(chunk)
    payload = b"".join(chunks)

    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Upload is not a readable zip archive: {exc}",
        )

    with archive, tempfile.TemporaryDirectory(prefix="foundry-import-") as workdir:
        extract_dir = os.path.join(workdir, "module")
        os.makedirs(extract_dir, exist_ok=True)
        try:
            # Cheap first gate: refuse before extracting anything if the
            # DECLARED sizes alone already exceed the budget. The streamed
            # copy below re-checks honestly because headers can understate.
            _reject_declared_size_overrun(archive)
            budget_remaining = [_MAX_FOUNDRY_EXTRACTED_BYTES]
            for info in archive.infolist():
                reason = _reject_unsafe_zip_entry(info.filename)
                if reason:
                    raise ValueError(f"unsafe archive entry rejected: {reason}")
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise ValueError(
                        f"unsafe archive entry rejected: symlink entries are "
                        f"never extracted ({info.filename!r})"
                    )
                target = os.path.normpath(
                    os.path.join(extract_dir, *PurePosixPath(info.filename.replace("\\", "/")).parts)
                )
                if target != extract_dir and not target.startswith(extract_dir + os.sep):
                    raise ValueError(
                        "unsafe archive entry rejected: "
                        f"{info.filename!r} escapes the extraction directory"
                    )
                if info.filename.endswith("/"):
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with archive.open(info) as src, open(target, "wb") as dst:
                    _copy_bounded(src, dst, budget_remaining)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

        # Locate the module root: module.json either at the archive root or in
        # exactly one wrapper directory (the common 'Export Module' shape).
        candidates: List[Tuple[int, str]] = []
        for dirpath, _dirnames, filenames in os.walk(extract_dir):
            if "module.json" in filenames:
                candidates.append((dirpath.count(os.sep), dirpath))
        if not candidates:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Archive contains no module.json anywhere; it is not a "
                    "recognizable Foundry VTT module"
                ),
            )
        candidates.sort()
        module_root = candidates[0][1]

        try:
            result = global_foundry_importer.import_module(module_root)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    result["upload"] = {
        "filename": file.filename,
        "bytes": len(payload),
    }
    return result


@app.post("/api/v1/import/foundry/preview")
async def foundry_import_preview(token: str = Depends(_require_auth)):
    """Deliberate stub for the PREVIEW surface, not the transport.

    The multipart transport now EXISTS: POST /api/v1/import/foundry/upload
    receives a zipped module over multipart, extracts it safely and runs the
    full importer. What this endpoint would add on top of that is still
    unimplemented, so it keeps answering 501 rather than pretending. Still-
    true limitations, named honestly instead of blaming the transport:
    - unsupported compendium pack types (JournalEntry, RollTable, Macro,
      Playlist, Cards, Adventure) are skipped with a warning, never projected;
    - LevelDB-format pack directories are unsupported;
    - imported documents are returned as projections only — nothing is
      persisted to character/compendium storage yet.
    """
    raise HTTPException(
        status_code=501,
        detail=(
            "NOT_IMPLEMENTED: POST /api/v1/import/foundry/upload now accepts "
            "zipped modules over multipart; this preview surface remains "
            "unimplemented. Still-true limitations: unsupported pack types "
            "(JournalEntry, RollTable, Macro, Playlist, Cards, Adventure) are "
            "skipped rather than projected; LevelDB-format pack directories "
            "are unsupported; imported documents are projections only and are "
            "not persisted to storage yet."
        ),
    )


def start_server():
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    start_server()
