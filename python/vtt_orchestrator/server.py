import os
import re
import json
import base64
import hashlib
import hmac
import secrets
import time
from datetime import datetime, timezone

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Dict, Any, List, Literal, Optional

from .routing.intent_router import IntentClassificationRouter
from .routing.llm_client import LLMStreamingGateway, LLMConfig
from .routing import engine_client
from .routing.engine_client import EngineRejectedError, EngineUnavailableError
from .storage import MemoryStore, PostgresStore, init_storage, public_user
from .lore.epistemic_graph import EpistemicLoreGraphManager
from .auditor.inspector import PreCommitAuditorAgent, DiagnosticRetryController
from .agents.agent_hierarchy import EncounterDMAgent, DirectorAgent, ConcordiaNPCComponent
from .agents.tool_agent import EngineToolAgent
from .simulation.faction_simulation import FactionSimulationGOAP
from .simulation.spotlight_tracker import VoiceSpotlightTracker
from .simulation.safety_gateway import SafetyGateway
from .simulation.dynasty_engine import global_dynasty_engine, DynastyEngine
from .simulation.empirical_playtester import EmpiricalPlaytester
from .compendium.bundle_packager import global_bundle_packager
from .compendium.starter_adventures import (
    build_starter_bundle_bytes,
    list_starter_adventures,
)
from .compendium.homebrew_parser import global_homebrew_parser
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
faction_sim = FactionSimulationGOAP("Shadow Cabal", resources=100)
streaming_gateway = LLMStreamingGateway()
tool_agent = EngineToolAgent(streaming_gateway)
pdf_renderer = CharacterSheetPDFRenderer()
empirical_playtester = EmpiricalPlaytester()

# Load Compendium Data
# Prefer the richer SRD 5.2 fixtures (full stat blocks, untruncated spells,
# magic items, feats, origins, animals, glossary); fall back to the legacy
# 5.1 data files when they are absent.
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
COMPENDIUM_DIR = os.path.join(PROJECT_ROOT, "compendium")
SPELLS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_spells.json")
MONSTERS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_monsters.json")
MAGIC_ITEMS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_magic_items.json")
FEATS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_feats.json")
ANIMALS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_animals.json")
ORIGINS_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_origins.json")
GLOSSARY_FILE = os.path.join(COMPENDIUM_DIR, "srd_5_2_rules_glossary.json")


def _load_json(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


all_spells: List[Dict[str, Any]] = _load_json(SPELLS_FILE) or _load_json(
    os.path.join(DATA_DIR, "srd_spells.json"))
all_monsters: List[Dict[str, Any]] = _load_json(MONSTERS_FILE) or _load_json(
    os.path.join(DATA_DIR, "srd_monsters.json"))
all_magic_items: List[Dict[str, Any]] = _load_json(MAGIC_ITEMS_FILE)
all_feats: List[Dict[str, Any]] = _load_json(FEATS_FILE)
all_animals: List[Dict[str, Any]] = _load_json(ANIMALS_FILE)
all_origins: List[Dict[str, Any]] = _load_json(ORIGINS_FILE)
all_glossary_terms: List[Dict[str, Any]] = _load_json(GLOSSARY_FILE)

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


def extract_srd_context(text: str, limit: int = 2) -> List[Dict[str, Any]]:
    """Find SRD monster/spell references in free text and return stat facts.

    Used to ground LLM narration in authoritative compendium data so the DM
    agent cannot contradict the stat blocks (mechanical hallucination guard).
    """
    lowered = (text or "").lower()
    facts: List[Dict[str, Any]] = []

    for monster in all_monsters:
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

    for spell in all_spells:
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

AUTH_SECRET = os.environ.get("AUTH_SECRET", "aethertable-dev-secret")
TOKEN_TTL_SECONDS = 12 * 3600

storage_backend: Any = MemoryStore()


@app.on_event("startup")
async def _init_storage_backend():
    global storage_backend
    storage_backend = await init_storage()


class AuthSignupRequest(BaseModel):
    email: str
    username: str = ""
    display_name: str = ""
    password: str
    role: str = "player"


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
    if await storage_backend.get_user_by_email(key) is not None:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    record = await storage_backend.create_user(
        email=key,
        username=req.username or key.split("@")[0],
        display_name=req.display_name or req.username or key.split("@")[0],
        role=req.role if req.role in ("gm", "player", "spectator", "admin") else "player",
        password=req.password,
        assigned_token_ids=[],
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
async def auth_session(token: str = Query(...)):
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


@app.post("/api/v1/intent/classify", response_model=IntentClassificationResult)
def classify_intent(req: ClassifyRequest):
    return router.classify_utterance(req.utterance, req.speaker_id)


@app.get("/api/v1/compendium/spells")
def get_compendium_spells(
    q: Optional[str] = Query(None, description="Search query for spell name"),
    school: Optional[str] = Query(None, description="Filter by magic school"),
    level: Optional[int] = Query(None, description="Filter by spell level"),
    limit: int = Query(50, ge=1, le=400)
):
    results = all_spells
    if q:
        query = q.lower()
        results = [s for s in results if query in s.get("name", "").lower() or query in s.get("description", "").lower()]
    if school:
        results = [s for s in results if s.get("school", "").lower() == school.lower()]
    if level is not None:
        results = [s for s in results if s.get("level") == level]
    return {
        "total": len(results),
        "spells": results[:limit]
    }


@app.get("/api/v1/compendium/monsters")
def get_compendium_monsters(
    q: Optional[str] = Query(None, description="Search query for monster name"),
    challenge_rating: Optional[str] = Query(None, description="Filter by challenge rating"),
    limit: int = Query(50, ge=1, le=400)
):
    results = all_monsters
    if q:
        query = q.lower()
        results = [m for m in results if query in m.get("name", "").lower() or query in m.get("type", "").lower()]
    if challenge_rating:
        results = [m for m in results if str(m.get("challenge_rating")) == str(challenge_rating)]
    return {
        "total": len(results),
        "monsters": results[:limit]
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

    class Config:
        extra = "forbid"


class EngineCheckRequest(BaseModel):
    modifier: int
    dc: int
    cost_margin: int = 3


class EngineSaveRequest(BaseModel):
    save_modifier: int
    dc: int
    ability: Optional[str] = None
    advantage: bool = False
    disadvantage: bool = False
    conditions: List[str] = Field(default_factory=list)


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


@app.post("/api/v1/engine/session")
async def engine_create_session(req: EngineSessionRequest):
    return await _engine_call(engine_client.create_session(req.campaign_id, req.session_name))


@app.post("/api/v1/engine/attack")
async def engine_resolve_attack(req: EngineAttackRequest, token: Optional[str] = Query(None)):
    # Reference-only payload: ids + optional action index. No math crosses
    # this boundary in either direction — the engine owns every modifier.
    action = {
        "attacker_id": engine_client._coerce_uuid(req.attacker_id),
        "target_id": engine_client._coerce_uuid(req.target_id),
        "action_index": req.action_index,
    }
    actor = _caller_actor(token) if token else None
    return await _engine_call(
        engine_client.resolve_attack(req.session_id, action, actor=actor)
    )


@app.post("/api/v1/engine/check")
async def engine_resolve_check(req: EngineCheckRequest):
    return await _engine_call(engine_client.resolve_check(req.model_dump()))


@app.post("/api/v1/engine/save")
async def engine_resolve_save(req: EngineSaveRequest):
    payload = req.model_dump()
    if payload["ability"]:
        # Engine Ability enum expects SCREAMING_SNAKE_CASE ("DEXTERITY").
        payload["ability"] = payload["ability"].upper()
    return await _engine_call(engine_client.resolve_save(payload))


@app.post("/api/v1/engine/concentration")
async def engine_resolve_concentration(req: EngineConcentrationRequest):
    return await _engine_call(engine_client.resolve_concentration(req.model_dump()))


@app.post("/api/v1/engine/death-save")
async def engine_resolve_death_save(req: EngineDeathSaveRequest, token: Optional[str] = Query(None)):
    actor = _caller_actor(token) if token else None
    return await _engine_call(
        engine_client.resolve_death_save(req.session_id, req.entity_id, actor=actor)
    )


@app.post("/api/v1/engine/map/generate")
async def engine_generate_map(req: EngineMapGenerateRequest):
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
    return await _engine_call(engine_client.generate_map({"room_desc": room_desc, "seed": req.seed}))


@app.get("/api/v1/engine/rooms/{room_id}/presence")
async def engine_room_presence(room_id: str):
    return await _engine_call(
        engine_client.engine_request("GET", f"/api/v1/rooms/{room_id}/presence")
    )


@app.get("/api/v1/engine/metrics")
async def engine_metrics():
    """Read-only telemetry proxy to the engine's public GET /metrics.

    vtt-server exposes /metrics on PUBLIC_PATHS (crates/vtt-server/src/auth.rs),
    so this call needs NO forwarded actor identity — it is service-mediated by
    design and never mutates state. Returns the engine's honest counters
    verbatim (MCR, action tallies, auditor rejection rate, persistence
    failures); the gateway adds nothing and fabricates nothing. An unreachable
    engine maps to 502 so clients can render an explicit degraded state.
    """
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
    owner_user_id: Optional[str] = None


@app.post("/api/v1/engine-session/persist")
async def persist_engine_session(req: EnginePersistRequest):
    raw = await _engine_call(
        engine_client.engine_request("GET", f"/api/v1/sessions/{req.session_id}")
    )
    await storage_backend.save_engine_snapshot(req.session_id, req.owner_user_id, raw)
    return {
        "status": "PERSISTED",
        "session_id": req.session_id,
        "entities": len(raw.get("entities", {})),
        "events": len(raw.get("ledger", {}).get("events", [])),
    }


class EngineHydrateRequest(BaseModel):
    session_id: str


@app.post("/api/v1/engine-session/hydrate")
async def hydrate_engine_session(req: EngineHydrateRequest):
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
    name: str = "Untitled Table"


class LobbyJoinRequest(BaseModel):
    invite_code: str


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
    _require_user_id(token)
    lobby = await storage_backend.get_lobby(lobby_id)
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    return lobby


@app.post("/api/v1/lobbies/{lobby_id}/launch")
async def launch_lobby(lobby_id: str, token: str = Depends(_require_auth)):
    user_id = _require_user_id(token)
    lobby = await storage_backend.get_lobby(lobby_id)
    if lobby is None:
        raise HTTPException(status_code=404, detail="Lobby not found")
    if lobby["host_user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the host can launch")
    created = await _engine_call(
        engine_client.engine_request(
            "POST",
            "/api/v1/sessions",
            {"campaign_id": "00000000-0000-0000-0000-00000000000a",
             "session_name": f"Lobby {lobby['name']}"},
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
    _require_user_id(token)
    record = await storage_backend.get_character(character_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return record


@app.delete("/api/v1/characters/{character_id}")
async def delete_character(character_id: str, token: str = Query(...)):
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
    level = int(record.get("level", 1))
    proficiency = 2 + (level - 1) // 4
    str_mod = (int(abilities.get("STR", 10)) - 10) // 2
    dex_mod = (int(abilities.get("DEX", 10)) - 10) // 2

    klass = record.get("character_class", "fighter").lower()
    dmg_dice, uses_str = _CLASS_DAMAGE.get(klass, ("1d6", True))
    attack_bonus = proficiency + (str_mod if uses_str else dex_mod)
    damage_expression = f"{dmg_dice}{'+' + str(attack_bonus - proficiency) if (attack_bonus - proficiency) >= 0 else str(attack_bonus - proficiency)}"

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
        "speed_feet": float(data.get("speed", 30)),
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
                          "movement_remaining_feet": float(data.get("speed", 30)),
                          "free_object_interaction": True},
        "spell_slots_remaining": {},
        "attacks": [{
            "name": f"{klass.title()} Strike",
            "attack_bonus": attack_bonus,
            "damage_expression": damage_expression,
            "damage_type": "slashing" if uses_str else "fire",
        }],
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

class EngineSpawnRequest(BaseModel):
    session_id: str
    entity: Dict[str, Any]
    ingress: Optional[Dict[str, Any]] = None


class EngineCastSpellRequest(BaseModel):
    session_id: str
    caster_id: str
    target_id: Optional[str] = None
    spell: Dict[str, Any]
    cast_level: int = Field(1, ge=0, le=9)


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
async def engine_spawn(req: EngineSpawnRequest, token: str = Query(...)):
    payload = dict(req.entity)
    if req.ingress is not None:
        payload["ingress"] = req.ingress
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/entities",
            payload,
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/cast-spell")
async def engine_cast_spell(req: EngineCastSpellRequest, token: str = Query(...)):
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
async def engine_move(req: EngineMoveRequest, token: str = Query(...)):
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
async def engine_turn_next(req: EngineSessionActionRequest, token: str = Query(...)):
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/turn/next",
            {},
            actor=_caller_actor(token),
        )
    )


@app.post("/api/v1/engine/damage")
async def engine_damage(req: EngineDamageRequest, token: str = Query(...)):
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
async def engine_arm_reaction(req: EngineArmReactionRequest, token: str = Query(...)):
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
async def engine_heal(req: EngineHealRequest, token: str = Query(...)):
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
async def engine_rest(req: EngineRestRequest, token: str = Query(...)):
    return await _engine_call(
        engine_client.engine_request(
            "POST",
            f"/api/v1/sessions/{req.session_id}/rest",
            {"kind": req.kind},
            actor=_caller_actor(token),
        )
    )


class EngineSessionStateRequest(BaseModel):
    """Body of the GET-style read proxy below: only the session reference."""
    session_id: str

    class Config:
        extra = "forbid"


@app.post("/api/v1/engine/session-state")
async def engine_session_state(
    req: EngineSessionStateRequest, token: Optional[str] = Query(None)
):
    """GET-style read proxy over the engine's GET /api/v1/sessions/{id}.

    The browser holds no HMAC engine token, so it has no direct readable path
    to authoritative state (this is what left clients unable to converge local
    tokens after an X-card rewind). This route gives it one round trip through
    the orchestrator, forwarding the caller's identity so the engine's RBAC
    authorizes the real participant; callers without a token stay
    service-mediated like the other proxies.

    NOTE: this exposes exactly what the caller could already see as a session
    participant. If per-role visibility filtering (spectators vs players vs
    GM) is ever needed on this payload, that is a separate iteration.
    """
    actor = _caller_actor(token) if token else None
    return await _engine_call(
        engine_client.engine_request(
            "GET",
            f"/api/v1/sessions/{engine_client._coerce_uuid(req.session_id)}",
            actor=actor,
        )
    )


# --- Session replay export -----------------------------------------------------------
# Turns one engine session's event ledger into a portable, human-auditable
# artifact. The gateway PROJECTS the ledger — it never fabricates: every
# summary segment is derived only from payload fields the engine actually
# sent, missing fields are omitted (never defaulted), and unknown event
# types pass through with their raw payload as the summary.

def _event_summary(event_type: str, payload: Dict[str, Any]) -> str:
    """Human-readable one-liner for a ledger event, derived ONLY from fields
    genuinely present in ``payload``. Missing fields are omitted rather than
    defaulted, so an auditor never reads a number the engine never produced.
    Unknown event types render their raw payload verbatim."""
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
        if damage is not None:
            parts.append(f"for {damage}")
        if hp is not None:
            parts.append(f"(HP→{hp})")
    elif event_type == "DAMAGE_APPLIED":
        target = opt("target_id")
        amount, hp = opt("amount"), opt("hp_remaining")
        if target is not None:
            parts.append(str(target))
        if amount is not None:
            parts.append(f"took {amount} damage")
        if hp is not None:
            parts.append(f"(HP→{hp})")
    elif event_type in ("HEALED", "LONG_REST_APPLIED"):
        target = opt("target_id")
        amount, hp = opt("amount"), opt("hp_remaining")
        restored_max = opt("hp_restored_to_max")
        if target is not None:
            parts.append(str(target))
        if amount is not None:
            parts.append(f"healed for {amount}")
        if restored_max is not None:
            parts.append(f"restored to max ({restored_max} HP)")
        if hp is not None:
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
        if damage is not None:
            parts.append(f"for {damage}")
        if hp is not None:
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

    # Known type whose payload carried nothing we can describe, OR an event
    # type this gateway version does not know: show the raw payload honestly.
    if parts:
        return " ".join(parts)
    return json.dumps(payload, sort_keys=True)


def _project_ledger_event(event: Any) -> Dict[str, Any]:
    """One GameEvent -> the auditable projection. Fields absent from the
    engine's event stay absent/null here; nothing is invented."""
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
        "summary": _event_summary(event_type, payload),
    }


@app.get("/api/v1/engine/session-replay")
async def engine_session_replay(session_id: str = Query(...), token: str = Query(...)):
    """Exports a session's event ledger as a downloadable replay artifact.

    Requires a valid HMAC session token; the caller's real identity is
    forwarded to the engine's GET /sessions/{id} so its RBAC authorizes the
    actual participant. Content-Disposition marks it as an attachment so
    browsers download `replay-<session_id>-<round>.json` instead of rendering.
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

    events_raw = raw.get("ledger", {}).get("events", []) if isinstance(raw.get("ledger"), dict) else []
    events = [_project_ledger_event(e) for e in events_raw]

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


# --- Request observability & rate limiting ------------------------------------------

import logging as _logging

_logging.basicConfig(level=_logging.INFO)
http_logger = _logging.getLogger("aethertable.http")

_RATE_LIMITS = {  # bucket -> (max_events, window_seconds)
    "auth": (30, 60),
    "agent": (60, 60),
    "default": (600, 60),
}
_rate_windows: Dict[tuple, List[float]] = {}


def _bucket_for_path(path: str) -> str:
    if path.startswith("/api/v1/auth"):
        return "auth"
    if path.startswith("/api/v1/agent"):
        return "agent"
    return "default"


@app.middleware("http")
async def rate_limit_middleware(request, call_next):
    bucket = _bucket_for_path(request.url.path)
    limit, window = _RATE_LIMITS[bucket]
    client_ip = request.client.host if request.client else "unknown"
    key = (client_ip, bucket)
    now = time.time()
    hits = [t for t in _rate_windows.get(key, []) if now - t < window]
    if len(hits) >= limit:
        retry_after = max(1, int(window - (now - hits[0])) + 1)
        return Response(
            content=json.dumps({"error": "RATE_LIMITED", "retry_after_s": retry_after}),
            status_code=429,
            media_type="application/json",
            headers={"Retry-After": str(retry_after)},
        )
    hits.append(now)
    _rate_windows[key] = hits
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
async def agent_turn(req: AgentTurnRequest):
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
def inject_dynasty_lore(req: DynastyInjectRequest):
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
def run_empirical_benchmark(simulations: int = Query(200, ge=10, le=1000)):
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
def export_starter_adventure(key: str, token: str = Query(...)):
    """Build a starter adventure on demand and return its .vttbundle archive.

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
async def import_campaign_bundle(req: BundleImportRequest, token: str = Query(...)):
    # Importing a world mutates shared state — authenticated users only.
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


def _bundle_token_to_entity(tok: Dict[str, Any]) -> Dict[str, Any]:
    """Converts a bundle token into an engine AddEntity payload. The engine's
    request flattens the EntityState with an optional `ingress` sibling;
    ingress gating is validated server-side (the verified flag is advisory)."""
    entity_id = engine_client._coerce_uuid(str(tok.get("id") or tok.get("name", "token")))
    hp = int(tok.get("hp", tok.get("max_hp", 10)) or 10)
    x = float(tok.get("x", 2.5) or 2.5)
    y = float(tok.get("y", 2.5) or 2.5)
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
async def execute_orchestrator_turn(req: NarrativeGenerateRequest):
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
async def stream_narrative_endpoint(req: NarrativeGenerateRequest):
    # Ground-truth reconciliation happens BEFORE any token is emitted: when a
    # session is named, the stream must be reachable and audited against live
    # engine state, never the client's claims.
    audited_payload, active_count, previous_count = await _resolve_audit_inputs(req)

    # Ground the narration in SRD 5.2 stat blocks whenever the player's
    # action names a known monster or spell.
    srd_facts = extract_srd_context(req.user_intent)
    raw_generator = streaming_gateway.stream_narrative(
        user_intent=req.user_intent,
        engine_payload=audited_payload,
        context={"srd": srd_facts},
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
def compendium_lore_lookup(
    q: str = Query(..., description="Text to scan for SRD monster/spell references"),
    semantic: bool = Query(
        False,
        description="Rank via the Qdrant compendium RAG index when enabled",
    ),
    k: int = Query(5, ge=1, le=25, description="Top-K entries (semantic mode)"),
):
    # Response shape is identical across retrieval modes; the "retrieval"
    # provenance field tells callers which path served the facts:
    # "qdrant" | "substring" | "substring_fallback".
    if semantic:
        results = compendium_rag.search(q, k=k)
        if results is not None:
            return {"query": q, "facts": results, "retrieval": "qdrant"}
        marker = (
            "substring_fallback"
            if compendium_rag.available  # healthy at startup, failed NOW
            else "substring"             # never enabled/reachable
        )
        return {
            "query": q,
            "facts": extract_srd_context(q, limit=k),
            "retrieval": marker,
        }
    return {"query": q, "facts": extract_srd_context(q), "retrieval": "substring"}


@app.post("/api/v1/lore/assert")
def assert_lore(
    assertion: LoreAssertionPayload,
    token: str = Query(..., description="HMAC session token"),
):
    # Lore canon is shared world state — writes require an authenticated user.
    _require_user_id(token)
    return lore_graph.submit_assertion(assertion)


@app.post("/api/v1/spotlight/record")
def record_spotlight(req: UtteranceRecordRequest):
    spotlight_tracker.record_utterance(req.speaker_id, req.duration_sec)
    return {
        "status": "recorded",
        "agency_weights": spotlight_tracker.calculate_agency_weights(),
        "sidelined_players": spotlight_tracker.get_sidelined_players(),
    }


@app.get("/api/v1/spotlight/agency")
def get_spotlight_agency():
    return {
        "agency_weights": spotlight_tracker.calculate_agency_weights(),
        "sidelined_players": spotlight_tracker.get_sidelined_players(),
    }


@app.post("/api/v1/safety/x-card")
async def trigger_x_card(req: XCardRequest):
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
    return result


@app.post("/api/v1/simulation/tick")
def advance_faction_simulation():
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
global_concordia_engine = ConcordiaPactEngine()
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
def generate_quest(req: QuestGenerateRequest):
    global active_campaign_quest
    quest = global_quest_generator.generate_campaign_quest(
        campaign_theme=req.campaign_theme,
        primary_house=req.primary_house,
        rival_house=req.rival_house,
    )
    active_campaign_quest = quest
    return quest


@app.get("/api/v1/quest/active")
def get_active_quest():
    global active_campaign_quest
    if not active_campaign_quest:
        active_campaign_quest = global_quest_generator.generate_campaign_quest()
    return active_campaign_quest


@app.post("/api/v1/quest/concordia-negotiate")
def negotiate_concordia_pact(req: ConcordiaNegotiateRequest):
    result = global_concordia_engine.negotiate_treaty(
        house_a_name=req.house_a,
        house_b_name=req.house_b,
        player_diplomacy_roll=req.diplomacy_roll,
        concessions_offered=req.concessions_offered,
    )
    return result


def start_server():
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    start_server()
