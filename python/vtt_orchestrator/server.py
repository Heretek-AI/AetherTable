import os
import json
import base64
import hashlib
import hmac
import secrets
import time
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Dict, Any, List, Optional

from .routing.intent_router import IntentClassificationRouter
from .routing.llm_client import LLMStreamingGateway, LLMConfig
from .routing import engine_client
from .routing.engine_client import EngineUnavailableError
from .storage import MemoryStore, PostgresStore, init_storage, public_user
from .lore.epistemic_graph import EpistemicLoreGraphManager
from .auditor.inspector import PreCommitAuditorAgent, DiagnosticRetryController
from .agents.agent_hierarchy import EncounterDMAgent, DirectorAgent, ConcordiaNPCComponent
from .simulation.faction_simulation import FactionSimulationGOAP
from .simulation.spotlight_tracker import VoiceSpotlightTracker
from .simulation.safety_gateway import SafetyGateway
from .simulation.dynasty_engine import global_dynasty_engine, DynastyEngine
from .simulation.empirical_playtester import EmpiricalPlaytester
from .compendium.bundle_packager import global_bundle_packager
from .compendium.homebrew_parser import global_homebrew_parser
from .pdf.character_sheet_renderer import CharacterSheetPDFRenderer
from .schemas.models import (
    IntentClassificationResult,
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
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global State Container
router = IntentClassificationRouter()
lore_graph = EpistemicLoreGraphManager()
auditor = PreCommitAuditorAgent(lore_graph=lore_graph)
dm_agent = EncounterDMAgent()
retry_controller = DiagnosticRetryController(auditor=auditor, max_retries=2)
spotlight_tracker = VoiceSpotlightTracker(["Thorin", "Lyra", "Player3"])
safety_gateway = SafetyGateway()
faction_sim = FactionSimulationGOAP("Shadow Cabal", resources=100)
streaming_gateway = LLMStreamingGateway()
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


def _auth_response(profile: Dict[str, Any]) -> Dict[str, Any]:
    now = time.time()
    token = _sign_token({"user_id": profile["id"], "exp": now + TOKEN_TTL_SECONDS})
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


@app.post("/api/v1/auth/login")
async def auth_login(req: AuthLoginRequest):
    key = req.email.strip().lower()
    record = await storage_backend.get_user_by_email(key)
    # Seed default GM account on first use so the demo flow works out of the box.
    if record is None and key == "gm@aethertable.io" and req.password == "dragonlance":
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
    token: str
    name: str = "Campaign Autosave"
    snapshot: Dict[str, Any]
    round_number: int = 1


def _owner_or_401(token: str) -> str:
    return _require_user_id(token)


@app.post("/api/v1/campaign/save")
async def campaign_save(req: CampaignSaveRequest):
    owner = _owner_or_401(req.token)
    meta = await storage_backend.upsert_campaign_save(
        owner, req.name.strip() or "Campaign Autosave", req.snapshot, req.round_number
    )
    return {"status": "saved", **meta}


@app.get("/api/v1/campaign/saves")
async def campaign_saves(token: str = Query(...)):
    owner = _owner_or_401(token)
    saves = await storage_backend.list_campaign_saves(owner)
    return {"total": len(saves), "saves": saves}


@app.get("/api/v1/campaign/save/{save_id}")
async def campaign_load(save_id: str, token: str = Query(...)):
    owner = _owner_or_401(token)
    record = await storage_backend.get_campaign_save(owner, save_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Save not found")
    return record


@app.delete("/api/v1/campaign/save/{save_id}")
async def campaign_delete(save_id: str, token: str = Query(...)):
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
    session_id: str
    attacker_id: str
    target_id: str
    attack_bonus: int
    target_ac: int
    damage_expression: str = "1d8+3"
    damage_type: str = "slashing"
    advantage: bool = False
    disadvantage: bool = False


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
    successes: int = 0
    failures: int = 0
    is_stabilized: bool = False
    is_dead: bool = False
    natural_roll: Optional[int] = None


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


@app.post("/api/v1/engine/session")
async def engine_create_session(req: EngineSessionRequest):
    return await _engine_call(engine_client.create_session(req.campaign_id, req.session_name))


@app.post("/api/v1/engine/attack")
async def engine_resolve_attack(req: EngineAttackRequest):
    action = req.model_dump(exclude={"session_id"})
    # The engine's AttackActionReq types attacker/target as UUIDs and
    # DamageType deserializes snake_case ("fire", "piercing", ...).
    action["attacker_id"] = engine_client._coerce_uuid(action["attacker_id"])
    action["target_id"] = engine_client._coerce_uuid(action["target_id"])
    action["damage_type"] = action["damage_type"].lower()
    return await _engine_call(engine_client.resolve_attack(req.session_id, action))


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
async def engine_resolve_death_save(req: EngineDeathSaveRequest):
    return await _engine_call(engine_client.resolve_death_save(req.model_dump()))


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


@app.post("/api/v1/homebrew/parse-markdown")
def parse_homebrew_markdown(req: HomebrewParseRequest):
    return global_homebrew_parser.parse_statblock(req.markdown_text)


@app.post("/api/v1/narrative/generate")
@app.post("/api/v1/orchestrator/turn")
def execute_orchestrator_turn(req: NarrativeGenerateRequest):
    def dm_draft(ctx=None):
        return dm_agent.generate_combat_draft(req.user_intent, req.engine_execution_payload, ctx)

    return retry_controller.run_turn_cycle(
        user_intent=req.user_intent,
        turn_index=req.turn_index,
        entity_id=req.entity_id,
        engine_execution_payload=req.engine_execution_payload,
        dm_draft_generator=dm_draft,
        active_entity_count=req.active_entity_count,
        previous_entity_count=req.previous_entity_count,
        ingress_count=req.ingress_count,
        egress_count=req.egress_count,
    )


@app.post("/api/v1/narrative/stream")
@app.post("/api/v1/orchestrator/narrative/stream")
async def stream_narrative_endpoint(req: NarrativeGenerateRequest):
    # Ground the narration in SRD 5.2 stat blocks whenever the player's
    # action names a known monster or spell.
    srd_facts = extract_srd_context(req.user_intent)
    generator = streaming_gateway.stream_narrative(
        user_intent=req.user_intent,
        engine_payload=req.engine_execution_payload,
        context={"srd": srd_facts},
    )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
    )


@app.get("/api/v1/compendium/lore-lookup")
def compendium_lore_lookup(
    q: str = Query(..., description="Text to scan for SRD monster/spell references"),
):
    return {"query": q, "facts": extract_srd_context(q)}


@app.post("/api/v1/lore/assert")
def assert_lore(assertion: LoreAssertionPayload):
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
