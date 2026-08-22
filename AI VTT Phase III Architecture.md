# **Phase III Architectural Specification: AI-Native Virtual Tabletop Engine**

## **The Orchestration Paradigm & Static Asset Repository Architecture**

### **GDevelop-Inspired Orchestrator Pattern**

Early-stage AI tabletop engines often treat Large Language Models (LLMs) as unconstrained creators capable of generating story text, rule outcomes, dynamic stats, and spatial updates simultaneously. This architecture leads to severe game state drift, mathematical hallucination, and mechanical invalidity. Phase III shifts the AI Dungeon Master (DM) from an unconstrained creator to an authoritative director and orchestrator.  
Drawing inspiration from game engine AI integrations such as GDevelop, the system separates high-level narrative intent from game logic and state mutation. In this model, AI agents do not write game logic or invent entity statistics dynamically during runtime. Instead, they function as orchestrators over a pre-defined, immutable domain. The LLM DM selects entity handles, spatial primitives, and mechanical action structures from a static compendium repository, issuing parameterised intent payloads that are resolved by a deterministic game engine.  
The orchestration workflow proceeds sequentially through distinct system boundaries. Client natural language or voice inputs are ingested by the Encounter DM agent, which acts as a semantic parser. The DM extracts mechanical intent and maps requested entities to immutable asset keys within the static compendium. The resulting tool invocation payload is submitted to the Authoritative Rust Rules Engine.  
The engine validates mechanical feasibility, draws deterministic random numbers for dice rolls, calculates state mutations, and passes the proposed state delta to a second-tier Auditor Agent. Only after the Auditor Agent verifies spatial, temporal, and entity invariants is the state mutation committed to the PostgreSQL persistence layer and broadcast across the network to WebGPU clients via Conflict-Free Replicated Data Types (CRDTs).  
The system enforces this paradigm using constrained logit-decoding layers (such as Outlines and PydanticAI) at the inference boundary. By restricting token generation paths to valid JavaScript Object Notation (JSON) schemas that map directly to static compendium primary keys, the DM agent cannot invent non-existent spells, illegal monster stats, or invalid rulesets. The agent translates natural language player actions into structured tool parameterizations anchored in the immutable asset library.

### **Static Asset Compendium Architecture**

The static compendium serves as the authoritative repository for all immutable game definitions. It is decoupled from runtime state and optimized for zero-trust runtime access. The compendium organizes static definitions across three sub-systems:

#### **Map Tiles, Blueprints, and Wave Function Collapse Constraints**

Maps are constructed using modular 2D/3D tile matrices governed by Wave Function Collapse (WFC) generation constraints. Every tile definition contains explicit edge-socket compatibility vectors, rotational symmetry properties, terrain movement cost multipliers, and occlusion flags. Blueprint structures store pre-validated tile configurations with fixed constraint rules, ensuring procedurally generated dungeons preserve spatial topology, door connectivity, and pathability.

#### **NPC and Monster Archetypes with Fixed Challenge Rating Scaling**

Monster entities are declared as immutable archetypes referencing system rulesets such as the D\&D SRD 5.1. Challenge Rating (CR) scaling curves are governed by deterministic formulas. For any given CR r, core stat derivations adhere to standard mechanical equations:  
\\text{Proficiency Bonus (PB)} \= \\left\\lfloor \\frac{r \- 1}{4} \\right\\rfloor \+ 2 \\text{Armor Class (AC)} \= f\_{\\text{CR\\\_AC}}(r) \\text{Hit Points (HP)} \= \\left\\lfloor N\_{\\text{dice}} \\times \\frac{d\_{\\text{sides}} \+ 1}{2} \+ N\_{\\text{dice}} \\times \\text{Mod}\_{\\text{CON}} \\right\\rfloor \\text{Saving Throw DC} \= 8 \+ \\text{PB} \+ \\text{Mod}\_{\\text{Primary}}  
Runtime instances of monsters link directly to these static IDs, mutating only dynamic state vectors (such as current HP, current coordinates, and active conditions) while keeping intrinsic stat blocks immutable.

#### **Spells, Equipment, and Action Tables**

Spells and items possess hard-coded parameters detailing resource costs, spell slot tiers, casting times, component requirements (V/S/M), targeting shapes (e.g., sphere, cone, cylinder, line), range radii, saving throw attributes, and damage die formulas. Spells cannot be re-interpreted dynamically at runtime; casting *Fireball* deterministically triggers a 20-foot radius Dexterity saving throw inflicting 8d6 fire damage on a failure, with halve-on-save logic evaluated entirely by the engine.

### **Schema & DDL Specifications**

\-- PostgreSQL DDL for Immutable Compendium & Static Assets  
CREATE SCHEMA IF NOT EXISTS compendium;

\-- Entity Category Enumeration  
CREATE TYPE compendium.entity\_type AS ENUM (  
    'tile', 'blueprint', 'monster', 'spell', 'equipment'  
);

\-- Master Compendium Registry  
CREATE TABLE compendium.entities (  
    entity\_id VARCHAR(64) PRIMARY KEY,  
    entity\_type compendium.entity\_type NOT NULL,  
    system\_identifier VARCHAR(32) NOT NULL DEFAULT 'dnd\_5e\_srd',  
    name VARCHAR(128) NOT NULL,  
    version VARCHAR(16) NOT NULL DEFAULT '1.0.0',  
    properties JSONB NOT NULL,  
    created\_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT\_TIMESTAMP  
);

\-- WFC Tile Definitions  
CREATE TABLE compendium.wfc\_tiles (  
    tile\_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity\_id),  
    socket\_north VARCHAR(32) NOT NULL,  
    socket\_east VARCHAR(32) NOT NULL,  
    socket\_south VARCHAR(32) NOT NULL,  
    socket\_west VARCHAR(32) NOT NULL,  
    socket\_top VARCHAR(32) DEFAULT 'solid',  
    socket\_bottom VARCHAR(32) DEFAULT 'solid',  
    symmetry\_type VARCHAR(16) NOT NULL CHECK (symmetry\_type IN ('X', 'I', 'L', 'T', '\\\\')),  
    weight FLOAT NOT NULL DEFAULT 1.0,  
    movement\_cost\_modifier NUMERIC(3,2) NOT NULL DEFAULT 1.00,  
    blocks\_line\_of\_sight BOOLEAN NOT NULL DEFAULT FALSE  
);

\-- Monster Archetypes  
CREATE TABLE compendium.monsters (  
    monster\_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity\_id),  
    challenge\_rating NUMERIC(4,2) NOT NULL,  
    size\_category VARCHAR(16) NOT NULL,  
    creature\_type VARCHAR(32) NOT NULL,  
    base\_ac INT NOT NULL,  
    hit\_dice\_count INT NOT NULL,  
    hit\_dice\_sides INT NOT NULL,  
    base\_speed INT NOT NULL,  
    str\_score INT NOT NULL,  
    dex\_score INT NOT NULL,  
    con\_score INT NOT NULL,  
    int\_score INT NOT NULL,  
    wis\_score INT NOT NULL,  
    cha\_score INT NOT NULL,  
    action\_deck JSONB NOT NULL  
);

\-- Spells Repository  
CREATE TABLE compendium.spells (  
    spell\_id VARCHAR(64) PRIMARY KEY REFERENCES compendium.entities(entity\_id),  
    level INT NOT NULL CHECK (level BETWEEN 0 AND 9),  
    school VARCHAR(32) NOT NULL,  
    casting\_time VARCHAR(32) NOT NULL,  
    range\_feet INT NOT NULL,  
    area\_of\_effect\_shape VARCHAR(16),  
    area\_of\_effect\_size\_feet INT,  
    verbal\_component BOOLEAN NOT NULL,  
    somatic\_component BOOLEAN NOT NULL,  
    material\_component\_desc TEXT,  
    save\_attribute VARCHAR(3),  
    damage\_formula VARCHAR(32)  
);

\-- Indexes for Zero-Trust Query Latency Optimization  
CREATE INDEX idx\_compendium\_system ON compendium.entities(system\_identifier, entity\_type);  
CREATE INDEX idx\_wfc\_sockets ON compendium.wfc\_tiles(socket\_north, socket\_east, socket\_south, socket\_west);  
CREATE INDEX idx\_monsters\_cr ON compendium.monsters(challenge\_rating);

\-- Security Hardening: Read-Only Application Role  
CREATE ROLE vtt\_runtime\_reader WITH LOGIN PASSWORD 'zero\_trust\_runtime\_pass';  
GRANT USAGE ON SCHEMA compendium TO vtt\_runtime\_reader;  
GRANT SELECT ON ALL TABLES IN SCHEMA compendium TO vtt\_runtime\_reader;  
ALTER DEFAULT PRIVILEGES IN SCHEMA compendium GRANT SELECT ON TABLES TO vtt\_runtime\_reader;

// Rust Struct Definitions for Zero-Copy Static Asset Deserialization  
use serde::{Deserialize, Serialize};

\#\[derive(Debug, Clone, Serialize, Deserialize, PartialEq)\]  
\#\[serde(rename\_all \= "snake\_case")\]  
pub enum EntityType {  
    Tile,  
    Blueprint,  
    Monster,  
    Spell,  
    Equipment,  
}

\#\[derive(Debug, Clone, Serialize, Deserialize)\]  
pub struct CompendiumEntity {  
    pub entity\_id: String,  
    pub entity\_type: EntityType,  
    pub system\_identifier: String,  
    pub name: String,  
    pub version: String,  
    pub properties: serde\_json::Value,  
}

\#\[derive(Debug, Clone, Serialize, Deserialize)\]  
pub struct WfcTileConstraint {  
    pub tile\_id: String,  
    pub socket\_north: String,  
    pub socket\_east: String,  
    pub socket\_south: String,  
    pub socket\_west: String,  
    pub socket\_top: String,  
    pub socket\_bottom: String,  
    pub symmetry\_type: String,  
    pub weight: f64,  
    pub movement\_cost\_modifier: f32,  
    pub blocks\_line\_of\_sight: bool,  
}

\#\[derive(Debug, Clone, Serialize, Deserialize)\]  
pub struct MonsterArchetype {  
    pub monster\_id: String,  
    pub challenge\_rating: f32,  
    pub size\_category: String,  
    pub creature\_type: String,  
    pub base\_ac: i32,  
    pub hit\_dice\_count: i32,  
    pub hit\_dice\_sides: i32,  
    pub base\_speed: u32,  
    pub str\_score: i32,  
    pub dex\_score: i32,  
    pub con\_score: i32,  
    pub int\_score: i32,  
    pub wis\_score: i32,  
    pub cha\_score: i32,  
    pub action\_deck: serde\_json::Value,  
}

impl MonsterArchetype {  
    pub fn proficiency\_bonus(\&self) \-\> i32 {  
        ((self.challenge\_rating \- 1.0) / 4.0).floor() as i32 \+ 2  
    }

    pub fn ability\_modifier(score: i32) \-\> i32 {  
        (score \- 10).div\_euclid(2)  
    }

    pub fn average\_hp(\&self) \-\> i32 {  
        let avg\_die \= (self.hit\_dice\_sides as f32 \+ 1.0) / 2.0;  
        let con\_mod \= Self::ability\_modifier(self.con\_score);  
        ((self.hit\_dice\_count as f32 \* avg\_die) \+ (self.hit\_dice\_count \* con\_mod) as f32).floor() as i32  
    }  
}

\#\[derive(Debug, Clone, Serialize, Deserialize)\]  
pub struct SpellDefinition {  
    pub spell\_id: String,  
    pub level: u8,  
    pub school: String,  
    pub casting\_time: String,  
    pub range\_feet: u32,  
    pub area\_of\_effect\_shape: Option\<String\>,  
    pub area\_of\_effect\_size\_feet: Option\<u32\>,  
    pub verbal\_component: bool,  
    pub somatic\_component: bool,  
    pub material\_component\_desc: Option\<String\>,  
    pub save\_attribute: Option\<String\>,  
    pub damage\_formula: Option\<String\>,  
}

## **Two-Tier Verification & The Second-Tier Auditor Agent**

### **Pre-Commit Event Interception**

The engine architecture enforces a strict multi-agent separation of concerns. Tier 1 consists of the Encounter DM agent, responsible for interpreting player commands, invoking compendium tools, and generating initial narrative responses and state mutation proposals. Tier 2 is an asynchronous, pre-commit validation agent named the "Auditor / World Inspector".  
No state mutation generated by the Encounter DM commits to the authoritative database or streams via CRDTs to WebGPU clients without explicit validation from the Auditor. The pre-commit interceptor isolates:

> 1. Proposed narrative text drafts.  
> 2. Formatted tool call parameters (e.g., entity movements, attack rolls, spell applications).  
> 3. Proposed memory log additions destined for vector or temporal stores.

The verification pipeline processes proposals through deterministic Rust rule checks combined with targeted graph queries. If a proposal passes all verification vectors, the state mutation is committed to PostgreSQL, written to memory logs, and broadcast to clients. If any verification vector fails, the Auditor halts the commit transaction, constructs a structured diagnostic error payload, and triggers a corrective re-inference loop back to the Encounter DM.

### **Invariant Validation Vectors**

#### **Spatial Invariance**

The Auditor asserts physical plausibility across the spatial domain. Path traversal is re-calculated using A^\* search over the grid collision matrix to verify that proposed movement paths do not exceed an entity's available movement budget (d \\le \\text{Speed}) and do not cross impassable geometry or occupied cells. Line of sight (LoS) and line of effect (LoE) are evaluated using hardware-accelerated raycasting and Bresenham line algorithms, blocking spells or ranged attacks from targeting entities behind full cover.

#### **Entity Conservation**

The total count of active entities, items, and dynamic resources obeys conservation laws. The Auditor verifies that entities cannot appear or disappear without a logged, mechanically valid ingress or egress event. Dynamic resource pools (such as Hit Points, Spell Slots, Superiority Dice, and Action Economy slots) are validated using exact delta arithmetic:

\\text{Resou\[span\_37\](start\_span)\[span\_37\](end\_span)rce}\_{\\text{current}}(t+1) \= \\text{Resource}\_{\\text{current}}(t) \- \\Delta \\text{Resource}\_{\\text{consumed}} \+ \\Delta \\text{Resource}\_{\\text{restored}}

#### **Lore & Temporal Continuity**

To prevent narrative contradictions (such as describing a dead NPC as speaking, or referencing a burned keep as intact), the Auditor performs sub-graph checks against a Neo4j knowledge graph. The Auditor extracts subject-predicate-object triples from the DM’s narrative draft and queries active graph topology.

| Subject | Predicate | Object | Graph State Constraint | Verification Action |
| :---- | :---- | :---- | :---- | :---- |
| NPC\_Baron\_Vane | IS\_STATE | ALIVE | (NPC\_Baron\_Vane)-\[:HAS\_STATUS\]-\>(DECEASED) | **REJECT** (Temporal Violation) |
| Location\_Keep | IS\_STATE | INTACT | (Location\_Keep)-\[:HAS\_STATUS\]-\>(DESTROYED) | **REJECT** (Lore Contradiction) |
| PC\_Thorin | POSSESSES | Item\_Sunblade | (PC\_Thorin)-\[:HAS\_ITEM\]-\>(Item\_Sunblade) | **PASS** (Fact Validated) |

#### **Mechanical Feasibility**

The Auditor checks proposed turn actions against the SRD 5.1 Action Economy framework. Every entity in combat manages a discrete turn budget:  
\\text{Turn Budget} \= \\{1 \\text{ Action}, 1 \\text{ Bonus Action}, 1 \\text{ Reaction}, \\text{Speed}\_{\\text{remaining}}, 1 \\text{ Free Object Interaction}\\}  
Attempting to perform two actions without *Action Surge*, casting two level 1+ spells in a single turn, or taking a reaction without a valid trigger causes an immediate mechanical feasibility rejection.

### **Diagnostic Retry & Feedback Loops**

When an invariant vector fails, the Auditor generates a typed diagnostic payload detailing the specific failure, offending narrative tokens, and required corrective constraints.  
\# P\[span\_42\](start\_span)\[span\_42\](end\_span)ydantic Schemas for Auditor Pre-Commit Verification & Diagnostic Loop  
from enum import Enum  
from typing import List, Optional, Dict, Any  
from pydantic import BaseModel, Field

class InvariantViolationType(str, Enum):  
    SPATIAL\_INVARIANCE \= "SPATIAL\_INVARIANCE"  
    ENTITY\_CONSERVATION \= "ENTITY\_CONSERVATION"  
    LORE\_CONTINUITY \= "LORE\_CONTINUITY"  
    MECHANICAL\_FEASIBILITY \= "MECHANICAL\_FEASIBILITY"  
    MATH\_NARRATIVE\_CONTRADICTION \= "MATH\_NARRATIVE\_CONTRADICTION"

class FailureSeverity(str, Enum):  
    WARNING \= "WARNING"  
    FATAL\_REJECT \= "FATAL\_REJECT"

class ValidationFailure(BaseModel):  
    violation\_type: InvariantViolationType  
    severity: FailureSeverity  
    failed\_component: str \= Field(..., description="Target property, e.g., 'movement\_path', 'hp\_delta'")  
    offending\_narrative\_excerpt: Optional\[str\] \= Field(None, description="Exact draft text causing failure")  
    diagnostic\_message: str \= Field(..., description="Deterministic reason for rejection")  
    corrective\_constraint: str \= Field(..., description="Explicit context bound for re-inference")

class AuditorDiagnosticReport(BaseModel):  
    passed: bool  
    turn\_index: int  
    entity\_id: str  
    failures: List\[ValidationFailure\] \= Field(default\_factory=list)  
    suggested\_state\_patch: Optional\[Dict\[str, Any\]\] \= None

class EncounterDMContextUpdate(BaseModel):  
    original\_user\_intent: str  
    rejected\_draft: str  
    auditor\_report: AuditorDiagnosticReport  
    system\_reprompt\_instruction: str \= (  
        "Your previous output violated world invariants. Re-evaluate your turn logic using "  
        "the provided corrective\_constraints. Do NOT repeat the offending draft."  
    )

This typed payload flows into a LangGraph cyclic control loop. The state graph transitions from the Auditor node to a Corrective\_ReInference node, passing the EncounterDMContextUpdate model into the DM prompt context window. The DM executes a second inference pass, constraining its generation output to comply with the specified corrective bounds.

## **Spatial Invariance, Entity Conservation, & Ingress Protocols**

### **Anti-Popping / Conservation Law**

To prevent entity "popping" (unexplained creation or disappearance of tokens), game state is modeled as a closed conservation system.  
Let \\mathcal\[span\_46\](start\_span)\[span\_46\](end\_span){E}(t) denote the set of active entity tokens present on the canvas at tick t. The active entity count N(t) \= \\vert{}\\mathcal{E}(t)\\vert{} evolves according to the Conservation Law of Entities:  
\[span\_47\](start\_span)\[span\_47\](end\_span)\\Delta N\_{\\text{entities}} \= N(t+1) \- N(t) \= N\_{\\text{spawned}}(t) \- N\_{\\text{despawned}}(t)$$  
N(t+1) \= N(t) \+ \\sum\_{i=1}^{k} I\_i(t) \- \\sum\_{j=1}^{m} E\_j(t)  
Where I\_i(t) \\in \\{0, 1\\} represents a verified legal ingress event and E\_j(t) \\in \\{0, 1\\} represents a verified legal egress event (e.g., entity death, planar removal). An invariant violation occurs if:  
\\exists \\, \\text{token } e \\text{ such that } e \\in \\mathcal{E}(t+1) \\setminus \\mathcal{E}(t) \\quad \\text{AND} \\quad \\forall i, \\, e \\notin \\text{Domain}(I\_i(t))  
If an unmapped delta (\\Delta N\_{\\text{spontaneous}} \\neq 0\) occurs without a corresponding, mechanically validated ingress tool execution, the state commit is locked and the transaction aborts.  
\#\#\# Legal Ingress Protocols New tokens are introduced onto an active encounter map exclusively through four validated ingress protocols:  
\* **Planar Teleportation Protocol:** Spells such as *Misty Step*, *Dimension Door*, or *Teleport* require validation of spell slot availability, destination coordinates within range bounds, line of sight (if mandated by the spell), and cell non-occupancy.

> * **Physical Door / Portal Ingress Protocol:** Entities entering from adjacent non-rendered rooms must cross a designated portal node. The portal state must be OPEN or BROKEN, and movement costs are deducted from the entering token's speed budget starting at the portal coordinate.  
> * **Stealth / Concealment Reveal Protocol:** Tokens present in hidden memory layers transition to an active rendered state when an explicit mechanical check resolves (Stealth Roll \< Passive Perception or action Attack initiated). The token does not spawn; its visibility flag toggles from false to true.  
> * **Burrowing / Subterranean Ingress Protocol:** Requires entity stats containing burrow\_speed \> 0 and spatial grid cell attributes marked burrowable \= true (e.g., earth, sand; excluding solid worked stone or iron plates).

\#\#\# Hallucination Interception When an LLM DM attempts to alter unit counts without mechanical justification—such as narrating "seven goblin warriors charging from the shadows" when only five exist in the engine state—the Auditor executes immediate hallucination interception.  
In this scenario, the Encounter DM submits a draft payload stating: *"The remaining 5 goblins regroup, and suddenly 7 goblin warriors charge from the shadows\!"*. The Auditor parses the text draft, identifying a proposed target count of seven warriors. It checks the authoritative Rust engine state, which confirms exactly five active warriors. The calculated delta reveals two unsanctioned entities, while the logged ingress stack remains empty.  
The Auditor immediately blocks the state commit and prevents client CRDT synchronization. It emits a structured diagnostic payload back to the DM context window: *"FATAL\_REJECT: Spatial/Entity Conservation Violation. Attempted to introduce 2 unauthorized 'Goblin\_Warrior' tokens. Active count is 5\. No ingress protocol (Teleport, Door, Stealth) was invoked. REWRITE narrative to reference exactly 5 goblins."*.  
\---

## **Deterministic Arithmetic & Math-Narrative Reconciliation**

### **Separation of Mechanics and Flavor**

To eliminate mathematical hallucinations, Phase III enforces a strict sequence separating mechanical resolution from narrative text synthesis. Mechanics are calculated authoritatively before text generation begins.  
The execution sequence processes through three continuous phases:

> 1. **Intent Extraction:** The player's natural language input (e.g., *"I leap across the chasm and swing my greatsword at the Warlord's neck\!"*) is parsed by an intent model into a parameterised JSON tool payload detailing action type, target entity ID, weapon type, and target movement coordinates. 2\. **Authoritative Engine Execution:** The Rust rules engine evaluates movement distance budgets, verifies Target AC, generates seeded dice rolls, and calculates stat mutations. It outputs an execution payload: { attack\_roll: 19, target\_ac: 16, hit: true, damage: 11, target\_hp\_remaining: 14 }. 3\. **Narrative Synthesis:** The context prompt receives the exact Rust execution payload. The instruction sets dictate that the LLM DM generate flavor text matching the resolved mechanical outcome without altering numerical metrics or entity survival states.

\#\#\# Contradiction Resolution A primary failure mode in AI tabletop tools occurs when an LLM generates text declaring a target dead or decapitated, despite the target retaining remaining Hit Points. The engine blocks narrative state mismatches through semantic assertion checks.  
The Auditor compares semantic tokens from the narrative draft against state deltas calculated by the Rust engine. If the Rust engine reports that a target took 5 damage, reducing its HP from 16 to 11 (Is\_Conscious: true, Is\_Dead: false), but the DM draft describes the attack as severing the target's head and dropping it dead to the ground, a semantic mismatch is flagged.  
The Auditor identifies lethality tokens (*"severing his head"*, *"dead"*) that conflict with the engine state (Is\_Dead \== false). It interrupts the pipeline, blocks the commit, and issues a corrective reprompt: *"Contradiction Error: Target 'orc\_warlord\_01' survived with 11 HP. Narrative cannot describe decapitation, death, or unconsciousness. REWRITE draft to describe a non-lethal blow."*.  
\#\#\# Worked Trace & State Pipeline The complete lifecycle of a player action moves through a six-step pipeline spanning natural language processing, mechanical evaluation, pre-commit audit, and client synchronization.  
\[span\_75\](start\_span)\[span\_75\](end\_span)\`\` \+--------------------------------------------------------------------------------------------------+ | STEP 1: Natural Language / Voice Input | | Player Voice Input: "I cast Magic Missile at the fleeing Cultist Leader\!" | \+--------------------------------------------------------------------------------------------------+ | v \+--------------------------------------------------------------------------------------------------+ | STEP 2: Intent & Tool Parameter Extraction | | LLM Intent Parser emits tool call: | | Tool: cast\_spell\`, Parameters: { spell\_id: 'magic\_missile', level: 1, targets: \['cultist\_01'\] }| \+--------------------------------------------------------------------------------------------------+ | v \+--------------------------------------------------------------------------------------------------+ | STEP 3: Authoritative Rust Engine Execution | | Engine validates slot level 1 available. Evaluates damage: 3d4 \+ 3\. | | Dice Rolls: \[3, 4, 1\] \+ 3 \= 11 Force Damage. | | Mutation: cultist\_01 HP changes from 8 to \-3. Target Status \-\> DEFEATED. | | Memory Log Commit: Pending commit event \#1042. | \+--------------------------------------------------------------------------------------------------+ | v \+--------------------------------------------------------------------------------------------------+ | STEP 4: DM Narrative Generation Attempt | | DM generates draft: | | "Three darts of glowing energy strike the Cultist Leader, killing him instantly." | \+--------------------------------------------------------------------------------------------------+ | v \+--------------------------------------------------------------------------------------------------+ | STEP 5: Auditor Pre-Commit Inspection & Contradiction Detection | | Auditor checks: Spell logic (Pass), Range/LoS (Pass), Lethality Match (Pass: Engine HP \<= 0 and | | narrative indicates death). Graph verify: cultist\_01 set to DEFEATED (Pass). | \+--------------------------------------------------------------------------------------------------+ | v \+--------------------------------------------------------------------------------------------------+ | STEP 6: Corrective Re-Inference & Client State Broadcast | | Auditor clears payload. PostgreSQL commits transaction \#1042. | | Yjs CRDT delta merges state change. WebGPU canvas renders three missile projectiles and token | | defeat animation across all connected player clients. Latency: 840 ms. | \+--------------------------------------------------------------------------------------------------+  
\---

\#\# Quantitative Benchmarks, Latencies, & Failure Modes

\#\#\# Latency Budgets (SLAs)  
To maintain real-time interactive responsiveness during gameplay, the entire two-tier validation and execution loop is strictly bounded by a target Service Level Agreement (SLA) of \*\*$\< 1200\\text{ ms}$\*\* end-to-end.

|\[span\_76\](start\_span)\[span\_76\](end\_span) Pipeline Phase | Target SLA | Execution Layer | Latency Optimization Technique |  
| :--- | :--- | :--- | :--- |  
| \*\*1. Intent Parsing & Tool Extraction\*\* | 150 ms | Local/Cloud LLM | Speculative decoding, constrained logit masking |  
|\[span\_77\](start\_span)\[span\_77\](end\_span) \*\*2. Rust Engine Mechanical Execution\*\* | \< 10 ms | Headless Rust Engine | Zero-allocation struct mutations, in-memory state |  
|\[span\_78\](start\_span)\[span\_78\](end\_span) \*\*3. Spatial Grid & Raycasting Compute\*\* | \< 15 ms | Rust / SIMD / WebGPU | Spatial hash indexing, Bounding Volume Hierarchies |  
|\[span\_79\](start\_span)\[span\_79\](end\_span) \*\*4. Neo4j Lore Graph Invariant Queries\*\* | 40 ms | Neo4j Cypher Database | Read-replicas, indexed node-relationship lookup |  
|\[span\_80\](start\_span)\[span\_80\](end\_span) \*\*5. DM Narrative Draft Generation\*\* | 450 ms | LLM Stream Inference | Parallelized key-value token caching, speculative sampling |  
| \*\*6. Auditor Pre-Commit Inspection\*\* | 200 ms | Rust \+ Small SLM | Specialized small language model for fast verification |  
| \*\*7. CRDT Delta Merge & WebGPU Broadcast\*\* | \< 20 ms | Yjs / WebSockets / Native Rust | Atomic binary vector syncing over WebSockets |  
|\[span\_81\](start\_span)\[span\_81\](end\_span) \*\*8. Buffer / Contingency Retry Budget\*\* | 315 ms | Pipeline Controller | Reserved margin for single corrective re-inference pass |  
| \*\*Total Bounded SLA Budget\*\* | \*\*1200 ms\*\* | \*\*End-to-End Pipeline\*\* | \*\*Circuit breakers trigger local failover if threshold breached\*\* |

\[span\_82\](start\_span)\[span\_82\](end\_span)\#\#\# Benchmarking Metrics

\#\#\#\# Mechanical Compliance Rate (MCR)  
Measures the ratio of mechanical tool invocations that execute without triggering a deterministic engine rejection:

$\[span\_83\](start\_span)\[span\_83\](end\_span)$\\text{MCR} \= \\left( 1 \- \\frac{E\_{\\text{mechanical\\\_rejections}}}{T\_{\\text{proposed\\\_actions}}} \\right) \\times 100\\%$$

Production deployment requires a target threshold of $\\text{MCR} \\ge 98.5\\%$.

\#\#\#\# Hallucination & Continuity Index (HCI)  
Quantifies world-state preservation across spatial, lore, and entity domains over a continuous turn sequence:

$\[span\_84\](start\_span)\[span\_84\](end\_span)$\\text{HCI} \= 1.0 \- \\left( w\_1 \\cdot \\frac{V\_{\\text{spatial}}}{T\_{\\text{turns}}} \+ w\_2 \\cdot \\frac{V\_{\\text{lore}}}{T\_{\\text{turns}}} \+ w\_3 \\cdot \\frac{V\_{\\text{entity}}}{T\_{\\text{turns}}} \\right)$$

Where domain weight vectors are defined as $w\_1 \= 0.4$, $w\_2 \= 0.35$, $w\_3 \= 0.25$, and $V\_x$ represents verified invariant violations in domain $x$. Production deployment requires $\\text{HCI} \\ge 0.96$.

\#\#\#\# Auditor False-Positive Rate (AFPR)  
Measures the frequency with which mechanically valid narrative proposals are improperly rejected by the Auditor agent:

$$\\text{AFPR} \= \\frac{\\text{FP}\_{\\text{rejected\\\_valid}}}{\\text{FP}\_{\\text{rejected\\\_valid}} \+ \\text{TN}\_{\\text{accepted\\\_valid}}} \\times 100\\%$$

AFPR must remain strictly $\\le 1.5\\%$ to prevent unnecessary re-inference latency loops.

\#\#\# Comparative Framework Analysis

| Architectural Feature | Foundry VTT | Owlbear Rodeo | DeepMind Concordia | Phase III AI-Native VTT Engine |  
| :--- | :--- | :--- | :--- | :--- |  
| \*\*Core State Engine\*\* | Asynchronous \[span\_102\](start\_span)\[span\_102\](end\_span)JS / Node.js | Lightweigh\[span\_103\](start\_span)\[span\_103\](end\_span)t Browser JS | Pytho\[span\_113\](start\_span)\[span\_113\](end\_span)\[span\_114\](start\_span)\[span\_114\](end\_span)n Event Loop | Authoritative Headless Rust Engine |  
| \*\*AI Integration Pattern\*\* | Com\[span\_85\](start\_span)\[span\_85\](end\_span)munity Macro Plugins | Unintegrated / Third-party | Native LLM\[span\_115\](start\_span)\[span\_115\](end\_span)\[span\_121\](start\_span)\[span\_121\](end\_span) Game Master | GDevelop-Inspired Orchestrator Pattern |  
| \*\*Invariant Enforcement\*\* | C\[span\_94\](start\_span)\[span\_94\](end\_span)\[span\_97\](start\_span)\[span\_97\](end\_span)\[span\_100\](start\_span)\[span\_100\](end\_span)lient/Human DM manual | Human DM ma\[span\_104\](start\_span)\[span\_104\](end\_span)nual | LLM Self\[span\_116\](start\_span)\[span\_116\](end\_span)\[span\_122\](start\_span)\[span\_122\](end\_span)-co\[span\_105\](start\_span)\[span\_105\](end\_span)nsistency | Pre-Commit Auditor Interception |  
| \*\*Spatial Modeling\*\* | 2D Polygon Lighting | 2D Flat Image Canvas | T\[span\_106\](start\_span)\[span\_106\](end\_span)extual / Sym\[span\_117\](start\_span)\[span\_117\](end\_span)\[span\_123\](start\_span)\[span\_123\](end\_span)bolic Memor\[span\_107\](start\_span)\[span\_107\](end\_span)y \[span\_86\](start\_span)\[span\_86\](end\_span)| 2D/3D WFC Grid \+ WebGPU Raycasting |  
| \*\*Client State Sync\*\* | WebSockets (JSON State) | CRDT / Realtime DB | Centralized \[span\_127\](start\_span)\[span\_127\](end\_span)Python State | Yjs Binary CRDT Deltas over W\[span\_87\](start\_span)\[span\_87\](end\_span)ebSockets |  
| \*\*Math-Narrative Handling\*\* | Manual Dice vs Text | Manual Dice vs Text | Generative Tex\[span\_128\](start\_span)\[span\_128\](end\_span)t Arithmetic | Decoupled Arithmetic-First Pipelin\[span\_88\](start\_span)\[span\_88\](end\_span)e |

\#\#\#\# Comparative Architectural Synthesis  
Traditional Virtual Tabletops, such as Foundry VTT and Owlbear Rodeo, focus primarily on visual rendering a\[span\_89\](start\_span)\[span\_89\](end\_span)nd client state presentation. Foundry VTT provides rich spatial automation (line of sigh\[span\_108\](start\_span)\[span\_108\](end\_span)t, dynamic lighting) executed via JavaScript on a centralized Node.js server model. However, it lacks native AI architectural integrations, re\[span\_109\](start\_span)\[span\_109\](end\_span)lying on user-created community macros that introduce unconstrained API calls. This design leaves state consistency reliant on human DM o\[span\_110\](start\_span)\[span\_110\](end\_span)versight. Owlbear Rodeo offers minimal operational overhead, renderi\[span\_111\](start\_span)\[span\_111\](end\_span)ng basic 2D token positions without enforcing underlying game rules, action economy, or mechanical constraints.

Academic multi-agent social simulators like DeepMind's Co\[span\_112\](start\_span)\[span\_112\](end\_span)ncordia pioneer generative agent architectures, using an LLM-based Game Master to coordinate interactions between autonomous entities. While \[span\_118\](start\_span)\[span\_118\](end\_span)\[span\_124\](start\_span)\[span\_124\](end\_span)Concordia excels at qualitative social simulation and emergent narrative modeling, its reliance on natural language state representations introduces challenges for deterministic rules execution. State \[span\_119\](start\_span)\[span\_119\](end\_span)\[span\_125\](start\_span)\[span\_125\](end\_span)changes in Concordia are mediated through generative LLM text interpretation, making the environment vulnerable to arithmetic drift, spatial invalidities, and high processing latencies.

The P\[span\_120\](start\_span)\[span\_120\](end\_span)\[span\_126\](start\_span)\[span\_126\](end\_span)hase III AI-Native VTT Engine addresses these limitations by uniting deterministic game engine execution with generative multi-agent systems. Placing an authoritative Rust rules engine below the agent layer offloads combat arithmetic, spatial pathing, line of sight, and action economy validation to a high-speed runtime ($\< 10\\text{ ms}$). Inspired by asset orchestration patterns\[span\_90\](start\_span)\[span\_90\](end\_span) in game engines like GDevelop, the system constrains the AI DM to operating over static, immutable asset compendiums. Furthermore, placing a pre-commit Auditor agent in front of state mutations elim\[span\_91\](start\_span)\[span\_91\](end\_span)inates mechanical hallucinations and narrative contradictions prior to client rendering, establishing the reliability required \[span\_95\](start\_span)\[span\_95\](end\_span)\[span\_98\](start\_span)\[span\_98\](end\_span)\[span\_101\](start\_span)\[span\_101\](end\_span)for production-grade TTRPG engine performance.\[span\_92\](start\_span)\[span\_92\](end\_span)

#### **Works cited**

1\. , https://drive.google.com/open?id=1\_1rtXSliJaf82dctnT\_n9Yg-P69FEj9iT1TTgpgTN98 2\. Everywhere Ventures, https://www.everywhere.vc/?1e6e22b2\_page=3 3\. Changelog \- Summer Engine, https://www.summerengine.com/changelog