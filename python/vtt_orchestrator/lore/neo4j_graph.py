"""Neo4j-backed epistemic lore graph (backlog 4.6).

The ``neo4j`` Python driver is NOT installed in this environment, so all
database access goes through Neo4j's HTTP transactional endpoint
(``POST {host}/db/neo4j/tx/commit``) using ``httpx`` only — zero new
dependencies. Statements target the property names defined in
``database/neo4j/01_lore_graph_schema.cypher`` (``life_stage``, ``status``,
the unique ``id`` constraints, and the edge properties ``epistemic_weight``
/ ``epistemic_tier`` / ``source_session_id`` covered by the
``assertion_verification_index``).

Backend selection happens ONCE at startup via :func:`build_epistemic_graph`:

* ``NEO4J_ENABLED=1`` **and** the host answers the startup probe → the
  Neo4j-backed implementation.
* anything else (env unset, probe unreachable) → the in-memory
  :class:`EpistemicLoreGraphManager`, logged honestly as a fallback.

Both expose the identical public surface, so server routes do not care which
one is wired in.

FAILURE POLICY (deliberate, not accidental): if Neo4j is selected but a
request-time transaction fails (non-2xx status, an ``errors`` payload, or a
connection drop), we raise ``fastapi.HTTPException(502)`` instead of silently
degrading to the in-memory graph. A mid-request silent fallback would split
canon across two stores: paradox verdicts would be computed against stale
in-memory data while durable writes land nowhere, producing exactly the kind
of unnoticed lore corruption this subsystem exists to prevent. Falling back
is therefore a startup-only decision; request failures are surfaced to the
caller with 502 Bad Gateway semantics.
"""

import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from ..schemas.models import EpistemicTier, LoreAssertionPayload
from .epistemic_graph import (
    INTACT_PREDICATES,
    LIVING_PREDICATES,
    EpistemicLoreGraphManager,
    canon_seed_edges,
    canon_seed_nodes,
    epistemic_tier_weight,
)

logger = logging.getLogger("vtt_orchestrator.lore")

NEO4J_ENABLED_ENV = "NEO4J_ENABLED"
NEO4J_HOST_ENV = "NEO4J_HOST"
DEFAULT_NEO4J_HOST = "http://localhost:7474"

# Relationship types are structural Cypher (not bind parameters), so the
# predicate must be a plain upper-snake identifier before it can be
# interpolated into a MERGE statement.
_REL_TYPE_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

_TX_COMMIT_PATH = "/db/neo4j/tx/commit"

# One round trip: all three in-memory check semantics evaluated together.
_PARADOX_STATEMENTS = (
    # Check 1: deceased entity attempting a living action (temporal paradox).
    (
        "MATCH (s {id: $subject_id}) "
        "WHERE s.life_stage = 'DECEASED' "
        "AND $predicate IN $living_predicates "
        "RETURN s.id AS entity_id LIMIT 1",
        ("entity_id", "Temporal Paradox: Entity '{detail}' is DECEASED."),
    ),
    # Check 2: destroyed location referenced as intact (lore paradox).
    (
        "MATCH (l {id: $subject_id}) "
        "WHERE l.status = 'DESTROYED' "
        "AND $predicate IN $intact_predicates "
        "RETURN l.id AS location_id LIMIT 1",
        ("location_id", "Lore Paradox: Location '{detail}' is DESTROYED."),
    ),
    # Check 3: possession contradiction — item already held by someone else.
    (
        "MATCH (owner)-[:POSSESSES]->(item {id: $object_id}) "
        "WHERE owner.id <> $subject_id "
        "RETURN owner.id AS owner_id LIMIT 1",
        ("owner_id", "Possession Paradox: Item '{object}' is possessed by '{detail}'."),
    ),
)


class Neo4jEpistemicGraph:
    """Same public surface as :class:`EpistemicLoreGraphManager`, persisted to Neo4j.

    Paradox checks execute as Cypher against the authoritative store. The
    ``nodes``/``edges`` attributes are a synchronous projection of the graph
    (seeded from the schema's core-canon MERGE statements, updated on every
    committed assertion) because consumers such as the pre-commit auditor
    iterate them synchronously during narrative drafting; keeping that
    projection local also keeps triple extraction off the network hot path.
    """

    def __init__(
        self,
        host: Optional[str] = None,
        client: Optional[httpx.Client] = None,
        timeout_seconds: float = 2.0,
    ):
        self.host = (
            host or os.environ.get(NEO4J_HOST_ENV) or DEFAULT_NEO4J_HOST
        ).rstrip("/")
        self._client = client or httpx.Client(timeout=timeout_seconds)
        self.nodes: Dict[str, Dict[str, Any]] = canon_seed_nodes()
        self.edges: List[Dict[str, Any]] = [dict(e) for e in canon_seed_edges()]

    # ------------------------------------------------------------------
    # Public surface (mirrors EpistemicLoreGraphManager)
    # ------------------------------------------------------------------

    def query_paradox(
        self, subject_id: str, predicate: str, object_id: str
    ) -> Tuple[bool, str, float]:
        start = time.perf_counter()
        results = self._tx_commit(self._paradox_requests(subject_id, predicate, object_id))
        latency_ms = (time.perf_counter() - start) * 1000.0

        for index, result in enumerate(results):
            rows = [row["row"] for row in result.get("data", [])]
            if not rows:
                continue
            detail = str(rows[0][0])
            key, template = _PARADOX_STATEMENTS[index][1]
            reason = template.format(detail=detail, object=object_id)
            return False, reason, latency_ms

        return True, "Assertion compatible with canon graph.", latency_ms

    def submit_assertion(self, assertion: LoreAssertionPayload) -> Dict[str, Any]:
        passed, reason, latency = self.query_paradox(
            assertion.subject_node_id,
            assertion.predicate_relation,
            assertion.object_node_id,
        )
        if not passed:
            return {
                "status": "REJECTED_PARADOX",
                "reason": reason,
                "latency_ms": latency,
            }

        weight = epistemic_tier_weight(assertion.epistemic_tier)
        rel_type = self._validated_rel_type(assertion.predicate_relation)
        self._tx_commit([self._write_request(assertion, weight, rel_type)])
        self._project_committed_edge(assertion, weight)

        return {
            "status": "COMMITTED" if weight == 1.0 else "STAGED",
            "epistemic_tier": assertion.epistemic_tier,
            "assigned_weight": weight,
            "latency_ms": latency,
        }

    def current_tier(
        self, subject_id: str, predicate: str, object_id: str
    ) -> Optional[EpistemicTier]:
        """Highest epistemic tier held by this exact triple (promotion gate).

        Reads the synchronous projection that every commit through this
        process mirrors (see :meth:`_project_committed_edge`), mirroring the
        in-memory manager's contract so the server-side promotion rule is
        backend-independent.
        """
        from .epistemic_graph import _tier_rank

        best: Optional[EpistemicTier] = None
        for edge in self.edges:
            if (
                edge["from"] == subject_id
                and edge["rel"] == predicate
                and edge["to"] == object_id
            ):
                tier = edge.get("tier")
                if isinstance(tier, str):
                    tier = EpistemicTier(tier)
                if tier is None:
                    continue
                if best is None or _tier_rank(tier) > _tier_rank(best):
                    best = tier
        return best

    def apply_edge_weight_decay(self, decay_factor: float = 0.95) -> None:
        """Age staged edges down; validated canon (weight == 1.0) never decays."""
        statement = (
            "MATCH ()-[r:RELATION]->() "
            "WHERE r.epistemic_weight < 1.0 "
            "SET r.epistemic_weight = r.epistemic_weight * $decay_factor"
        )
        self._tx_commit(
            [{"statement": statement, "parameters": {"decay_factor": decay_factor}}]
        )
        for edge in self.edges:
            if edge["weight"] < 1.0:
                edge["weight"] *= decay_factor

    # ------------------------------------------------------------------
    # Startup probe / selection helpers
    # ------------------------------------------------------------------

    def probe(self, timeout_seconds: float = 1.5) -> bool:
        """True when the Neo4j HTTP endpoint answers at startup."""
        try:
            response = self._client.get(self.host + "/", timeout=timeout_seconds)
        except httpx.HTTPError as exc:
            logger.warning("epistemic graph: Neo4j probe failed (%s)", exc)
            return False
        return response.status_code < 500

    # ------------------------------------------------------------------
    # Cypher construction
    # ------------------------------------------------------------------

    @staticmethod
    def _paradox_requests(
        subject_id: str, predicate: str, object_id: str
    ) -> List[Dict[str, Any]]:
        shared = {
            "subject_id": subject_id,
            "predicate": predicate,
            "object_id": object_id,
            "living_predicates": list(LIVING_PREDICATES),
            "intact_predicates": list(INTACT_PREDICATES),
        }
        return [
            {"statement": statement, "parameters": dict(shared)}
            for statement, _ in _PARADOX_STATEMENTS
        ]

    @staticmethod
    def _validated_rel_type(predicate_relation: str) -> str:
        candidate = predicate_relation.strip().upper()
        if not _REL_TYPE_RE.match(candidate):
            raise _upstream_http_exception(
                422,
                "Invalid predicate_relation "
                f"{predicate_relation!r}: must be UPPER_SNAKE_CASE.",
            )
        return candidate

    @staticmethod
    def _write_request(
        assertion: LoreAssertionPayload, weight: float, rel_type: str
    ) -> Dict[str, Any]:
        # The relationship carries both its semantic type and :RELATION so the
        # schema's assertion_verification_index (r.epistemic_weight,
        # r.source_session_id) applies to it.
        statement = (
            "MERGE (s {id: $subject_id}) "
            "ON CREATE SET s.name = $subject_name "
            "MERGE (o {id: $object_id}) "
            f"MERGE (s)-[r:{rel_type}|RELATION]->(o) "
            "SET r.epistemic_weight = $epistemic_weight, "
            "r.epistemic_tier = $epistemic_tier, "
            "r.source_session_id = $source_session_id "
            "RETURN r.epistemic_weight AS epistemic_weight"
        )
        return {
            "statement": statement,
            "parameters": {
                "subject_id": assertion.subject_node_id,
                "subject_name": assertion.subject_node_id,
                "object_id": assertion.object_node_id,
                "epistemic_weight": weight,
                "epistemic_tier": assertion.epistemic_tier.value,
                "source_session_id": assertion.proposing_entity_id,
            },
        }

    def _project_committed_edge(
        self, assertion: LoreAssertionPayload, weight: float
    ) -> None:
        """Mirror the commit into the synchronous projection (auditor reads)."""
        if assertion.subject_node_id not in self.nodes:
            self.nodes[assertion.subject_node_id] = {
                "id": assertion.subject_node_id,
                "name": assertion.subject_node_id,
                "type": "Entity",
                "epistemic_tier": assertion.epistemic_tier,
            }
        self.edges.append({
            "from": assertion.subject_node_id,
            "rel": assertion.predicate_relation,
            "to": assertion.object_node_id,
            "weight": weight,
            "tier": assertion.epistemic_tier,
        })

    # ------------------------------------------------------------------
    # HTTP transport (no `neo4j` driver dependency)
    # ------------------------------------------------------------------

    def _tx_commit(self, statements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        url = self.host + _TX_COMMIT_PATH
        try:
            response = self._client.post(url, json={"statements": statements})
        except httpx.HTTPError as exc:
            raise _upstream_http_exception(
                502, f"Epistemic graph backend (Neo4j) unreachable at {url}: {exc}"
            )

        if response.status_code // 100 != 2:
            raise _upstream_http_exception(
                502,
                "Epistemic graph backend (Neo4j) returned HTTP "
                f"{response.status_code} for a lore transaction.",
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise _upstream_http_exception(
                502, f"Epistemic graph backend (Neo4j) returned malformed JSON: {exc}"
            )

        errors = payload.get("errors") or []
        if errors:
            raise _upstream_http_exception(
                502, f"Epistemic graph backend (Neo4j) reported errors: {errors}"
            )
        return payload.get("results", [])


def _upstream_http_exception(status_code: int, detail: str):
    # Imported lazily so the lore package stays importable without FastAPI in
    # non-server contexts; the orchestrator always has it installed.
    from fastapi import HTTPException

    return HTTPException(status_code=status_code, detail=detail)


def build_epistemic_graph(
    env: Optional[Dict[str, str]] = None,
    host: Optional[str] = None,
    client: Optional[httpx.Client] = None,
):
    """Select the epistemic-graph backend once at startup.

    NEO4J_ENABLED=1 plus a reachable endpoint → :class:`Neo4jEpistemicGraph`;
    otherwise the in-memory manager with an honest fallback log. Both share
    the same interface, so routes never branch on backend type.
    """
    environment = os.environ if env is None else env
    enabled = str(environment.get(NEO4J_ENABLED_ENV, "")).strip().lower() in {
        "1", "true", "yes", "on"
    }
    if not enabled:
        logger.info(
            "epistemic graph: in-memory fallback (Neo4j disabled/unreachable); "
            "%s unset/false — lore assertions will not be persisted",
            NEO4J_ENABLED_ENV,
        )
        return EpistemicLoreGraphManager()

    graph = Neo4jEpistemicGraph(host=host, client=client)
    if graph.probe():
        logger.info("epistemic graph: neo4j-backed at %s", graph.host)
        return graph

    logger.warning(
        "epistemic graph: in-memory fallback (Neo4j disabled/unreachable); "
        "%s=1 but %s did not answer the startup probe",
        NEO4J_ENABLED_ENV,
        graph.host,
    )
    return EpistemicLoreGraphManager()
