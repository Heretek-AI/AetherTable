"""Gateway-route tests for the Pillar 5 NPC persona registry.

Covers the runtime surface of ConcordiaNPC sub-agents:

* ``GET /api/v1/npc/``       - public registry metadata (id/name/role only).
* ``POST /api/v1/npc/{id}/respond``   - token-gated in-character dialogue,
  honest ``generator`` marker, deterministic template fallback per stance,
  and norms-violating LLM output never surfacing as ``reply``.
* ``POST /api/v1/npc/{id}/interactions`` - disposition outcomes so stances
  persist and shift across calls through the shared engine singleton.
"""

import time

import pytest
from fastapi.testclient import TestClient

from vtt_orchestrator import server
from vtt_orchestrator.server import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_npc_registry():
    """Each test starts from pristine personas + a pristine disposition engine."""
    server.reset_npc_registry()
    yield
    server.reset_npc_registry()


def _signup(name: str) -> dict:
    email = f"{name}_{abs(hash(name + str(time.time()))) % 10**8}@example.com"
    resp = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "username": name, "display_name": name.title(),
              "password": "dice-dice", "role": "player"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture()
def player() -> dict:
    return _signup("npcplayer")


# --- Registry listing ----------------------------------------------------------

def test_registry_lists_public_personas():
    resp = client.get("/api/v1/npc/")
    assert resp.status_code == 200
    npcs = resp.json()["npcs"]
    assert isinstance(npcs, list) and len(npcs) >= 2
    by_id = {entry["id"]: entry for entry in npcs}
    # Personas are keyed to the starter adventure's cast.
    assert "karas_drowned_steward" in by_id
    assert by_id["karas_drowned_steward"]["name"] == "The Drowned Steward"


def test_registry_exposes_only_public_metadata():
    entries = client.get("/api/v1/npc/").json()["npcs"]
    for entry in entries:
        assert set(entry.keys()) == {"id", "name", "role"}
        # No internal component state (goals/norms/gateway/memory) leaks.
        assert "norms" not in entry and "gateway" not in entry


def test_registry_listing_is_public():
    resp = client.get("/api/v1/npc/")
    assert resp.status_code == 200


# --- Auth gate ------------------------------------------------------------------

def test_respond_requires_token():
    resp = client.post(
        "/api/v1/npc/karas_drowned_steward/respond",
        json={"utterance": "Who guards this crypt?"},
    )
    assert resp.status_code == 401


def test_respond_rejects_invalid_token():
    resp = client.post(
        "/api/v1/npc/karas_drowned_steward/respond",
        params={"token": "not.a.validtoken"},
        json={"utterance": "Who guards this crypt?"},
    )
    assert resp.status_code == 401


# --- Unknown NPC ------------------------------------------------------------------

def test_unknown_npc_returns_404(player):
    resp = client.post(
        "/api/v1/npc/not_a_real_npc/respond",
        params={"token": player["token"]},
        json={"utterance": "Hello?"},
    )
    assert resp.status_code == 404


def test_unknown_npc_interaction_returns_404(player):
    resp = client.post(
        "/api/v1/npc/not_a_real_npc/interactions",
        params={"token": player["token"]},
        json={"kind": "aided"},
    )
    assert resp.status_code == 404


# --- Template-mode dialogue ---------------------------------------------------------

def test_template_reply_is_deterministic_per_stance(player):
    body = {"utterance": "What lies within the crypt?"}
    first = client.post(
        "/api/v1/npc/karas_drowned_steward/respond",
        params={"token": player["token"]},
        json=body,
    )
    assert first.status_code == 200
    second = client.post(
        "/api/v1/npc/karas_drowned_steward/respond",
        params={"token": player["token"]},
        json=body,
    )
    assert second.status_code == 200
    a, b = first.json(), second.json()
    assert set(a.keys()) <= {"reply", "generator", "stance", "npc_id", "norm_rejected"}
    assert a["npc_id"] == "karas_drowned_steward"
    assert a["generator"] == "template"
    assert a["stance"] == "neutral"
    assert a["reply"] == b["reply"]  # deterministic template path


def test_distinct_personas_have_distinct_voices(player):
    utterance = "Speak your purpose."
    steward = client.post(
        "/api/v1/npc/karas_drowned_steward/respond",
        params={"token": player["token"]},
        json={"utterance": utterance},
    ).json()
    baron = client.post(
        "/api/v1/npc/baron_aldous_vane/respond",
        params={"token": player["token"]},
        json={"utterance": utterance},
    ).json()
    assert steward["reply"] != baron["reply"]
    assert steward["generator"] == baron["generator"] == "template"


# --- Norms gate ------------------------------------------------------------------

class _TabooGateway:
    """Stub LLM gateway whose reply violates the Steward's secrecy taboo."""

    def __init__(self, reply: str):
        self._reply = reply

    async def complete_json(self, system_prompt, user_prompt, *args, **kwargs):
        return {"reply": self._reply}


def test_taboo_llm_reply_degrades_to_template_with_norm_rejected(player):
    npc = server._NPC_REGISTRY["karas_drowned_steward"]
    forbidden_reply = "The sunblade of Pelor is buried beneath the altar."
    npc.llm_gateway = _TabooGateway(forbidden_reply)

    resp = client.post(
        "/api/v1/npc/karas_drowned_steward/respond",
        params={"token": player["token"]},
        json={"utterance": "Tell me what treasure you guard."},
    )
    assert resp.status_code == 200
    payload = resp.json()
    # Safety over flavor: the violating candidate never reaches the caller...
    assert forbidden_reply not in payload["reply"]
    assert "sunblade" not in payload["reply"].lower()
    # ...and the degradation is honestly marked.
    assert payload["generator"] == "template"
    assert "norm_rejected" in payload
    assert payload["norm_rejected"]
    assert payload["stance"] == "neutral"


def test_clean_llm_reply_passes_norms_gate(player):
    npc = server._NPC_REGISTRY["karas_drowned_steward"]
    npc.llm_gateway = _TabooGateway("Nothing here but silt and silence.")

    payload = client.post(
        "/api/v1/npc/karas_drowned_steward/respond",
        params={"token": player["token"]},
        json={"utterance": "Anything worth looting?"},
    ).json()
    assert payload["reply"] == "Nothing here but silt and silence."
    assert payload["generator"] == "llm"
    assert "norm_rejected" not in payload


# --- Disposition persistence ------------------------------------------------------

def test_outcome_shifts_stance_and_persists_across_calls(player):
    url = "/api/v1/npc/karas_drowned_steward"
    token = {"token": player["token"]}

    before = client.post(f"{url}/respond", params=token,
                         json={"utterance": "I mean no harm."}).json()
    assert before["stance"] == "neutral"

    betrayal = client.post(f"{url}/interactions", params=token,
                           json={"kind": "betrayed", "magnitude": 3.0})
    assert betrayal.status_code == 200
    assert betrayal.json()["stance"] == "hostile"

    hostile = client.post(f"{url}/respond", params=token,
                          json={"utterance": "Wait, let me explain!"}).json()
    assert hostile["stance"] == "hostile"
    assert hostile["reply"] != before["reply"]

    redemption = client.post(f"{url}/interactions", params=token,
                             json={"kind": "aided", "magnitude": 20.0})
    assert redemption.status_code == 200
    assert redemption.json()["stance"] == "allied"

    allied = client.post(f"{url}/respond", params=token,
                         json={"utterance": "Shall we try again?"}).json()
    assert allied["stance"] == "allied"
    assert allied["reply"] != hostile["reply"]


def test_interaction_rejects_unknown_kind(player):
    resp = client.post(
        "/api/v1/npc/karas_drowned_steward/interactions",
        params={"token": player["token"]},
        json={"kind": "hugged"},
    )
    assert resp.status_code == 400
