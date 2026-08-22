import os
import json
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Dict, Any, List, Optional

from .routing.intent_router import IntentClassificationRouter
from .routing.llm_client import LLMStreamingGateway, LLMConfig
from .lore.epistemic_graph import EpistemicLoreGraphManager
from .auditor.inspector import PreCommitAuditorAgent, DiagnosticRetryController
from .agents.agent_hierarchy import EncounterDMAgent, DirectorAgent, ConcordiaNPCComponent
from .simulation.faction_simulation import FactionSimulationGOAP
from .simulation.spotlight_tracker import VoiceSpotlightTracker
from .simulation.safety_gateway import SafetyGateway
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

# Load Compendium Data
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
SPELLS_FILE = os.path.join(DATA_DIR, "srd_spells.json")
MONSTERS_FILE = os.path.join(DATA_DIR, "srd_monsters.json")

all_spells: List[Dict[str, Any]] = []
if os.path.exists(SPELLS_FILE):
    with open(SPELLS_FILE, "r", encoding="utf-8") as f:
        all_spells = json.load(f)

all_monsters: List[Dict[str, Any]] = []
if os.path.exists(MONSTERS_FILE):
    with open(MONSTERS_FILE, "r", encoding="utf-8") as f:
        all_monsters = json.load(f)


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


class NarrativeStreamRequest(BaseModel):
    user_intent: str
    engine_execution_payload: Dict[str, Any]
    context: Optional[Dict[str, Any]] = None


class UtteranceRecordRequest(BaseModel):
    speaker_id: str
    duration_sec: float


class XCardRequest(BaseModel):
    player_id: str
    topic: str
    current_sequence_id: int = 10


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "service": "vtt-multi-agent-orchestrator",
        "version": "1.0.0",
        "llm_provider": "live" if not streaming_gateway.config.is_mock else "mock_fallback",
        "llm_model": streaming_gateway.config.model,
        "compendium_spells_count": len(all_spells),
        "compendium_monsters_count": len(all_monsters),
    }


@app.get("/api/v1/compendium/spells")
def get_compendium_spells(
    query: Optional[str] = None,
    level: Optional[int] = None,
    school: Optional[str] = None,
    limit: int = 50,
):
    results = all_spells
    if query:
        q = query.lower()
        results = [s for s in results if q in s["name"].lower() or q in s.get("description", "").lower()]
    if level is not None:
        results = [s for s in results if s.get("level") == level]
    if school:
        s_low = school.lower()
        results = [s for s in results if s.get("school", "").lower() == s_low]

    return {
        "total_matches": len(results),
        "spells": results[:limit],
    }


@app.get("/api/v1/compendium/monsters")
def get_compendium_monsters(
    query: Optional[str] = None,
    cr: Optional[str] = None,
    limit: int = 50,
):
    results = all_monsters
    if query:
        q = query.lower()
        results = [m for m in results if q in m["name"].lower() or q in m.get("type", "").lower()]
    if cr:
        results = [m for m in results if m.get("cr", "").lower() == cr.lower()]

    return {
        "total_matches": len(results),
        "monsters": results[:limit],
    }


@app.post("/api/v1/intent/classify", response_model=IntentClassificationResult)
def classify_intent(req: ClassifyRequest):
    return router.classify_utterance(req.utterance, speaker_id=req.speaker_id)


@app.post("/api/v1/narrative/generate")
def generate_narrative(req: NarrativeGenerateRequest):
    cycle_result = retry_controller.run_turn_cycle(
        user_intent=req.user_intent,
        turn_index=req.turn_index,
        entity_id=req.entity_id,
        engine_execution_payload=req.engine_execution_payload,
        dm_draft_generator=lambda ctx: dm_agent.generate_combat_draft(
            req.user_intent, req.engine_execution_payload, ctx
        ),
        active_entity_count=req.active_entity_count,
        previous_entity_count=req.previous_entity_count,
        ingress_count=req.ingress_count,
        egress_count=req.egress_count,
    )
    return cycle_result


@app.post("/api/v1/narrative/stream")
async def stream_narrative(req: NarrativeStreamRequest):
    return StreamingResponse(
        streaming_gateway.stream_narrative(
            user_intent=req.user_intent,
            engine_payload=req.engine_execution_payload,
            context=req.context,
        ),
        media_type="text/event-stream",
    )


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
def trigger_x_card(req: XCardRequest):
    return safety_gateway.trigger_x_card(
        player_id=req.player_id,
        topic=req.topic,
        current_sequence_id=req.current_sequence_id,
    )


@app.post("/api/v1/simulation/tick")
def advance_faction_simulation():
    actions = faction_sim.advance_simulation_tick()
    return {
        "faction_name": faction_sim.faction_name,
        "remaining_resources": faction_sim.resources,
        "world_state": faction_sim.world_state,
        "actions_executed": actions,
    }


def start_server():
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    start_server()
