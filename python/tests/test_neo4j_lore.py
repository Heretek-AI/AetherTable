"""Backlog 4.6 — Neo4j-backed epistemic lore graph.

No real Neo4j runs in CI: the HTTP transactional endpoint layer is mocked
with ``httpx.MockTransport``, and a tiny in-test "database" evaluates the
Cypher the implementation sends so we can assert both well-formedness
(schema property names from database/neo4j/01_lore_graph_schema.cypher)
and semantic parity with the in-memory EpistemicLoreGraphManager.
"""

import json
import logging

import httpx
import pytest
from fastapi import HTTPException

from vtt_orchestrator.lore.epistemic_graph import EpistemicLoreGraphManager
from vtt_orchestrator.lore.neo4j_graph import (
    NEO4J_ENABLED_ENV,
    Neo4jEpistemicGraph,
    build_epistemic_graph,
)
from vtt_orchestrator.schemas.models import EpistemicTier, LoreAssertionPayload


# ---------------------------------------------------------------------------
# A fake Neo4j HTTP transactional endpoint over the canon fixture data.
# ---------------------------------------------------------------------------

CANON_NODES = {
    "NPC_Baron_Vane": {"name": "Baron Aldous Vane", "life_stage": "DECEASED"},
    "Location_Keep": {"name": "Oakhaven Keep", "status": "DESTROYED"},
    "PC_Thorin": {"name": "Thorin Oakenshield", "life_stage": "ALIVE"},
    "Item_Sunblade": {"name": "Sunblade of Pelor"},
    "Faction_Shadow_Cabal": {"name": "Shadow Cabal"},
}
CANON_POSSESSORS = {"Item_Sunblade": "PC_Thorin"}

LIVING_PREDICATES = ["IS_ALIVE", "SPEAKS_WITH", "ATTACKS", "RULES"]
INTACT_PREDICATES = ["IS_INTACT", "HOUSES_GARRISON"]

# Distinctive fragments of the statements the implementation must send.
TEMPORAL_MARK = "s.life_stage = 'DECEASED'"
LOCATION_MARK = "l.status = 'DESTROYED'"
POSSESSION_MARK = "-[:POSSESSES]->"


def _rows(statement, params):
    """Evaluate one canonical schema-shaped Cypher statement against canon."""
    if TEMPORAL_MARK in statement:
        node = CANON_NODES.get(params["subject_id"], {})
        if (
            node.get("life_stage") == "DECEASED"
            and params["predicate"] in LIVING_PREDICATES
        ):
            return [params["subject_id"]]
        return []
    if LOCATION_MARK in statement:
        node = CANON_NODES.get(params["subject_id"], {})
        if (
            node.get("status") == "DESTROYED"
            and params["predicate"] in INTACT_PREDICATES
        ):
            return [params["subject_id"]]
        return []
    if POSSESSION_MARK in statement:
        if params["predicate"] == "POSSESSES":
            owner = CANON_POSSESSORS.get(params["object_id"])
            if owner and owner != params["subject_id"]:
                return [owner]
        return []
    pytest.fail(f"fake Neo4j cannot evaluate unexpected statement:\n{statement}")


class FakeNeo4j:
    """Records traffic; answers /db/neo4j/tx/commit like canon data would."""

    def __init__(self, status_code=200, errors=None, fail_connect=False):
        self.statements = []
        self.writes = []
        self.status_code = status_code
        self.errors = errors or []
        self.fail_connect = fail_connect

    def transport(self):
        fake = self

        def handler(request: httpx.Request) -> httpx.Response:
            if fake.fail_connect:
                raise httpx.ConnectError("connection refused", request=request)
            if request.url.path.endswith("/tx/commit"):
                body = json.loads(request.content.decode())
                results = []
                for stmt in body["statements"]:
                    fake.statements.append(stmt)
                    if "MERGE" in stmt["statement"]:
                        fake.writes.append(stmt)
                        results.append({"columns": ["weight"], "data": []})
                    else:
                        rows = _rows(stmt["statement"], stmt["parameters"])
                        results.append(
                            {
                                "columns": ["hit"],
                                "data": [{"row": [r]} for r in rows],
                            }
                        )
                return httpx.Response(
                    fake.status_code, json={"results": results, "errors": fake.errors}
                )
            return httpx.Response(200, json={"name": "Neo4j"})

        return httpx.MockTransport(handler)

    def client(self):
        return httpx.Client(transport=self.transport(), timeout=2.0)


@pytest.fixture()
def fake():
    return FakeNeo4j()


def make_graph(fake):
    return Neo4jEpistemicGraph(client=fake.client())


def assertion(subject="PC_Thorin", predicate="WIELDS", obj="Item_Sunblade",
              tier=EpistemicTier.PROPOSED_FACT):
    return LoreAssertionPayload(
        proposing_entity_id="Director_Agent",
        subject_node_id=subject,
        predicate_relation=predicate,
        object_node_id=obj,
        epistemic_tier=tier,
        context_sentence="test assertion",
    )


# ---------------------------------------------------------------------------
# Selection / fallback
# ---------------------------------------------------------------------------

class TestBackendSelection:
    def test_env_unset_falls_back_to_in_memory(self, monkeypatch, caplog):
        monkeypatch.delenv(NEO4J_ENABLED_ENV, raising=False)
        with caplog.at_level(logging.INFO, logger="vtt_orchestrator.lore"):
            graph = build_epistemic_graph()
        assert isinstance(graph, EpistemicLoreGraphManager)
        assert any(
            "epistemic graph: in-memory fallback (Neo4j disabled/unreachable)" in r.message
            and "disabled" in r.message.lower()
            for r in caplog.records
        )

    @pytest.mark.parametrize("value", ["0", "false", "", "off"])
    def test_env_disabled_values_fall_back(self, monkeypatch, value):
        monkeypatch.setenv(NEO4J_ENABLED_ENV, value)
        assert isinstance(build_epistemic_graph(), EpistemicLoreGraphManager)

    def test_unreachable_probe_falls_back_with_honest_log(self, monkeypatch, caplog):
        monkeypatch.setenv(NEO4J_ENABLED_ENV, "1")
        dead = FakeNeo4j(fail_connect=True)
        with caplog.at_level(logging.WARNING, logger="vtt_orchestrator.lore"):
            graph = build_epistemic_graph(host="http://localhost:1", client=dead.client())
        assert isinstance(graph, EpistemicLoreGraphManager)
        assert any(
            "in-memory fallback (Neo4j disabled/unreachable)" in r.message
            for r in caplog.records
        )

    def test_enabled_and_reachable_selects_neo4j_backend(self, monkeypatch, fake):
        monkeypatch.setenv(NEO4J_ENABLED_ENV, "1")
        graph = build_epistemic_graph(host="http://neo4j:7474", client=fake.client())
        assert isinstance(graph, Neo4jEpistemicGraph)


# ---------------------------------------------------------------------------
# Paradox Cypher shape (schema property names)
# ---------------------------------------------------------------------------

class TestParadoxCypherShape:
    def test_statements_use_schema_property_names(self, fake):
        graph = make_graph(fake)
        passed, reason, latency = graph.query_paradox(
            "NPC_Baron_Vane", "ATTACKS", "PC_Thorin"
        )
        assert passed is False
        texts = [s["statement"] for s in fake.statements]
        assert len(texts) == 3
        assert any(TEMPORAL_MARK in t for t in texts)
        assert any(LOCATION_MARK in t for t in texts)
        assert any("-[:POSSESSES]" in t for t in texts)
        # Cypher references node identity via bound parameters only.
        assert "$subject_id" in texts[0]
        params = [s["parameters"] for s in fake.statements]
        assert any(
            p.get("subject_id") == "NPC_Baron_Vane"
            and p.get("predicate") == "ATTACKS"
            for p in params
        )
        for p in params:
            assert isinstance(p, dict)
        assert latency >= 0.0

    def test_write_statement_carries_epistemic_weight_and_session_fields(
        self, fake
    ):
        graph = make_graph(fake)
        result = graph.submit_assertion(assertion(tier=EpistemicTier.PROPOSED_FACT))
        assert result["status"] == "STAGED"
        assert len(fake.writes) == 1
        text = fake.writes[0]["statement"]
        params = fake.writes[0]["parameters"]
        # Schema-indexed edge properties: r.epistemic_weight, r.source_session_id
        assert "epistemic_weight" in text
        assert "source_session_id" in text
        assert params["epistemic_weight"] == 0.7
        assert params["epistemic_tier"] == "PROPOSED_FACT"
        # Node identity keyed on the schema's unique id constraint.
        assert "MERGE" in text and "{id: $subject_id}" in text

    def test_canon_weight_for_validated_tier_is_one(self, fake):
        graph = make_graph(fake)
        result = graph.submit_assertion(
            assertion(predicate="ALLIES_WITH", tier=EpistemicTier.VALIDATED_CANON)
        )
        assert result["status"] == "COMMITTED"
        assert fake.writes[-1]["parameters"]["epistemic_weight"] == 1.0


# ---------------------------------------------------------------------------
# Parity with the in-memory manager on the same canon fixtures
# ---------------------------------------------------------------------------

PARADOX_CASES = [
    # (subject, predicate, object, expected_passed)
    ("NPC_Baron_Vane", "ATTACKS", "PC_Thorin", False),      # deceased acts
    ("NPC_Baron_Vane", "IS_ALIVE", "NPC_Baron_Vane", False),
    ("Location_Keep", "IS_INTACT", "Location_Keep", False),  # destroyed stands
    ("NPC_Baron_Vane", "POSSESSES", "Item_Sunblade", False),  # possession theft
    ("PC_Thorin", "POSSESSES", "Item_Sunblade", True),       # genuine owner
    ("Faction_Shadow_Cabal", "ENEMY_OF", "PC_Thorin", True),  # clean relation
]


class TestParadoxParityWithInMemory:
    @pytest.mark.parametrize("subject,predicate,obj,_", PARADOX_CASES,
                             ids=[c[1] + ":" + c[0] for c in PARADOX_CASES])
    def test_same_verdict_and_reason_as_in_memory(self, fake, subject, predicate, obj, _):
        mem = EpistemicLoreGraphManager().query_paradox(subject, predicate, obj)
        neo = make_graph(fake).query_paradox(subject, predicate, obj)
        assert neo[0] == mem[0]
        assert neo[1] == mem[1]          # identical human-readable reason
        assert isinstance(neo[2], float)  # latency present

    def test_submit_parity_identical_result_dicts(self, fake):
        mem_graph = EpistemicLoreGraphManager()
        neo_graph = make_graph(fake)
        for tier in (EpistemicTier.SUBJECTIVE_RUMOR, EpistemicTier.PROPOSED_FACT,
                     EpistemicTier.VALIDATED_CANON):
            mem = mem_graph.submit_assertion(
                assertion(predicate="GUARDS", obj="Location_Keep", tier=tier))
            neo = neo_graph.submit_assertion(
                assertion(predicate="GUARDS", obj="Location_Keep", tier=tier))
            assert set(mem) == set(neo)
            assert {k: v for k, v in mem.items() if k != "latency_ms"} == \
                   {k: v for k, v in neo.items() if k != "latency_ms"}
            assert neo["latency_ms"] >= 0

    def test_rejected_assertion_writes_nothing_to_neo4j(self, fake):
        graph = make_graph(fake)
        result = graph.submit_assertion(
            assertion(subject="NPC_Baron_Vane", predicate="ATTACKS"))
        assert result["status"] == "REJECTED_PARADOX"
        assert fake.writes == []

    def test_accessor_surface_matches_in_memory_after_writes(self, fake):
        """server.py routes read ``len(lore_graph.edges)`` and the auditor
        iterates ``lore_graph.nodes.values()`` — the Neo4j backend must
        expose the same projection shapes."""
        mem = EpistemicLoreGraphManager()
        neo = make_graph(fake)
        for g in (mem, neo):
            g.submit_assertion(
                assertion(subject="New_Knight", predicate="SERVES",
                          obj="Faction_Shadow_Cabal"))
        assert len(neo.edges) == len(mem.edges)
        assert [(e["from"], e["rel"], e["to"]) for e in neo.edges] == \
               [(e["from"], e["rel"], e["to"]) for e in mem.edges]
        assert set(n["id"] for n in neo.nodes.values()) == \
               set(n["id"] for n in mem.nodes.values())
        new_mem = mem.nodes["New_Knight"]
        new_neo = neo.nodes["New_Knight"]
        assert new_neo["name"] == new_mem["name"]
        assert new_neo["type"] == new_mem["type"]
        # Auditor triple extraction relies on node names being searchable.
        assert all(node.get("name") for node in neo.nodes.values())


# ---------------------------------------------------------------------------
# Failure policy: fail loudly (502-style), never silently degrade
# ---------------------------------------------------------------------------

class TestUpstreamFailurePolicy:
    def test_http_500_raises_502_not_silent_fallback(self, fake):
        fake.status_code = 500
        graph = make_graph(fake)
        with pytest.raises(HTTPException) as excinfo:
            graph.query_paradox("PC_Thorin", "ATTACKS", "NPC_Baron_Vane")
        assert excinfo.value.status_code == 502

    def test_neo4j_error_payload_raises_502(self, fake):
        fake.errors = [{"code": "Neo.DatabaseError.Statement.ExecutionFailed"}]
        graph = make_graph(fake)
        with pytest.raises(HTTPException) as excinfo:
            graph.query_paradox("PC_Thorin", "ATTACKS", "NPC_Baron_Vane")
        assert excinfo.value.status_code == 502

    def test_connection_failure_on_request_raises_5xx(self, fake):
        fake.fail_connect = True
        graph = make_graph(fake)
        with pytest.raises(HTTPException) as excinfo:
            graph.submit_assertion(assertion())
        assert excinfo.value.status_code == 502

    def test_submit_assertion_surfaces_upstream_failure(self, fake):
        fake.status_code = 503
        graph = make_graph(fake)
        with pytest.raises(HTTPException):
            graph.submit_assertion(assertion())

    def test_invalid_predicate_rejected_before_cypher_injection(self, fake):
        graph = make_graph(fake)
        with pytest.raises(HTTPException) as excinfo:
            graph.submit_assertion(
                assertion(predicate="KNOWS_MERGE (x) DETACH DELETE x"))
        assert excinfo.value.status_code == 422
        assert fake.writes == []
