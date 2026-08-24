import time
from typing import Dict, Any, List, Optional
from ..schemas.models import EpistemicTier, LoreAssertionPayload


# Core canon nodes/edges mirroring the MERGE seeds in
# database/neo4j/01_lore_graph_schema.cypher. Shared by the in-memory
# manager and the Neo4j-backed projection so both start from identical canon.
LIVING_PREDICATES = ("IS_ALIVE", "SPEAKS_WITH", "ATTACKS", "RULES")
INTACT_PREDICATES = ("IS_INTACT", "HOUSES_GARRISON")


def canon_seed_nodes() -> Dict[str, Dict[str, Any]]:
    return {
        "NPC_Baron_Vane": {"id": "NPC_Baron_Vane", "name": "Baron Aldous Vane", "life_stage": "DECEASED", "type": "Entity"},
        "Location_Keep": {"id": "Location_Keep", "name": "Oakhaven Keep", "status": "DESTROYED", "type": "Location"},
        "PC_Thorin": {"id": "PC_Thorin", "name": "Thorin Oakenshield", "life_stage": "ALIVE", "type": "Entity"},
        "Item_Sunblade": {"id": "Item_Sunblade", "name": "Sunblade of Pelor", "rarity": "rare", "type": "Entity"},
        "Faction_Shadow_Cabal": {"id": "Faction_Shadow_Cabal", "name": "Shadow Cabal", "hostility": 0.85, "type": "Faction"},
    }


def canon_seed_edges() -> List[Dict[str, Any]]:
    return [
        {"from": "PC_Thorin", "rel": "POSSESSES", "to": "Item_Sunblade", "weight": 1.0},
        {"from": "NPC_Baron_Vane", "rel": "PREVIOUSLY_RULED", "to": "Location_Keep", "weight": 1.0},
        {"from": "Faction_Shadow_Cabal", "rel": "ENEMY_OF", "to": "PC_Thorin", "weight": 0.9},
    ]


def epistemic_tier_weight(epistemic_tier) -> float:
    return 0.3 if epistemic_tier == EpistemicTier.SUBJECTIVE_RUMOR else (
        0.7 if epistemic_tier == EpistemicTier.PROPOSED_FACT else 1.0
    )


class EpistemicLoreGraphManager:
    """
    Manages the 3-Tier Sanctioned Retcon Lore Graph and Paradox Detection Queries (<40ms SLA).
    """

    def __init__(self):
        # In-memory graph representation (compatible with Neo4j Property Graph schema)
        self.nodes: Dict[str, Dict[str, Any]] = canon_seed_nodes()
        self.edges: List[Dict[str, Any]] = canon_seed_edges()
        self.assertions: Dict[str, LoreAssertionPayload] = {}

    def query_paradox(self, subject_id: str, predicate: str, object_id: str) -> Tuple_Result:
        """
        Executes sub-graph checks to detect logical contradictions.
        Target SLA: < 40 ms.
        """
        start = time.perf_counter()

        subj = self.nodes.get(subject_id)
        obj = self.nodes.get(object_id)

        # Check 1: Deceased entity attempting living action
        if subj and subj.get("life_stage") == "DECEASED" and predicate in ["IS_ALIVE", "SPEAKS_WITH", "ATTACKS", "RULES"]:
            return False, f"Temporal Paradox: Entity '{subject_id}' is DECEASED.", (time.perf_counter() - start) * 1000.0

        # Check 2: Destroyed location referenced as intact
        if subj and subj.get("status") == "DESTROYED" and predicate in ["IS_INTACT", "HOUSES_GARRISON"]:
            return False, f"Lore Paradox: Location '{subject_id}' is DESTROYED.", (time.perf_counter() - start) * 1000.0

        # Check 3: Possession contradiction (e.g. claiming someone else's unique item)
        if predicate == "POSSESSES":
            for edge in self.edges:
                if edge["rel"] == "POSSESSES" and edge["to"] == object_id and edge["from"] != subject_id:
                    return False, f"Possession Paradox: Item '{object_id}' is possessed by '{edge['from']}'.", (time.perf_counter() - start) * 1000.0

        return True, "Assertion compatible with canon graph.", (time.perf_counter() - start) * 1000.0

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

        # Apply Epistemic Tiering
        weight = epistemic_tier_weight(assertion.epistemic_tier)

        # Auto-create soft node/edge if proposed fact
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

        return {
            "status": "COMMITTED" if weight == 1.0 else "STAGED",
            "epistemic_tier": assertion.epistemic_tier,
            "assigned_weight": weight,
            "latency_ms": latency,
        }

    def apply_edge_weight_decay(self, decay_factor: float = 0.95):
        """Dynamic edge weight decay for background aging in working memory."""
        for edge in self.edges:
            if edge["weight"] < 1.0: # Validated canon does not decay
                edge["weight"] *= decay_factor


Tuple_Result = Any
