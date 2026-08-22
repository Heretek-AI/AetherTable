// ============================================================================
// Neo4j Property Graph Constraints and Schema Initializers (Phase 1, Phase 5)
// ============================================================================

// Unique Entity IDs
CREATE CONSTRAINT unique_entity_id IF NOT EXISTS
FOR (e:Entity) REQUIRE e.id IS UNIQUE;

CREATE CONSTRAINT unique_location_id IF NOT EXISTS
FOR (l:Location) REQUIRE l.id IS UNIQUE;

CREATE CONSTRAINT unique_faction_id IF NOT EXISTS
FOR (f:Faction) REQUIRE f.id IS UNIQUE;

CREATE CONSTRAINT unique_fact_id IF NOT EXISTS
FOR (k:Fact) REQUIRE k.id IS UNIQUE;

// Indexes for low-latency sub-graph queries (<40ms SLA)
CREATE INDEX entity_state_lookup IF NOT EXISTS
FOR (e:Entity) ON (e.life_stage, e.faction_id);

CREATE INDEX location_state_lookup IF NOT EXISTS
FOR (l:Location) ON (l.status, l.region);

CREATE INDEX assertion_verification_index IF NOT EXISTS
FOR ()-[r:RELATION]-() ON (r.epistemic_weight, r.source_session_id);

// Initial Core Canon Nodes (Sample)
MERGE (baron:Entity {id: "NPC_Baron_Vane", name: "Baron Aldous Vane", life_stage: "DECEASED", title: "Lord of Oakhaven"})
MERGE (keep:Location {id: "Location_Keep", name: "Oakhaven Keep", status: "DESTROYED", region: "Verdant Reach"})
MERGE (cult:Faction {id: "Faction_Shadow_Cabal", name: "Shadow Cabal", alignment: "Neutral Evil", hostility_rating: 0.85})
MERGE (thorin:Entity {id: "PC_Thorin", name: "Thorin Oakenshield", life_stage: "ALIVE", class: "Fighter"})
MERGE (sunblade:Entity {id: "Item_Sunblade", name: "Sunblade of Pelor", rarity: "rare"})

MERGE (thorin)-[:POSSESSES {epistemic_weight: 1.0, verified_at: datetime()}]->(sunblade)
MERGE (baron)-[:PREVIOUSLY_RULED]->(keep)
MERGE (cult)-[:ENEMY_OF {hostility: 0.9}]->(thorin);
