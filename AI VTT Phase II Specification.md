# **Technical Architecture and Systems Specification: AI-Native Virtual Tabletop (Phase II)**

## **Executive Architectural Overview**

The Phase II architecture of the AI-Native Virtual Tabletop platform introduces an advanced, enterprise-grade system designed to decouple dynamic narrative generation from authoritative mechanical game state execution. Traditional Tabletop Role-Playing Games (TTRPGs) require both fluid narrative flexibility and strict mechanical adherence to rulesets. Single-prompt Large Language Model (LLM) architectures consistently exhibit failures in this domain, including mechanical hallucinations, cumulative state drift, and severe context degradation over multi-session campaign arcs. To resolve these structural limitations, this platform implements a multi-tier, event-driven framework where an LLM suite operates strictly as an intent interpreter, narrative synthesizer, and agentic actor, while a deterministic, headless rules engine written in Rust retains absolute authority over rules, spatial calculations, and state mutations.

| Architectural Tier | Component Technology | Primary Operational Responsibility | Key Performance / State Boundaries |
| :---- | :---- | :---- | :---- |
| **Client Presentation Layer** | WebGPU / Three.js / Yjs / WebRTC | Dynamic 3D canvas rendering, local spatial audio synthesis, and real-time client input processing. | Render loop bounded at \< 16 \\text{ ms} (60 FPS); audio latency \< 20 \\text{ ms}. |
| **Ingestion & Gateway Tier** | FastAPI / WebRTC Gateway / LiteLLM | Audio stream ingestion, Voice Activity Detection (VAD), ASR, and intent classification routing. | Input classification SLA \< 150 \\text{ ms}. |
| **Multi-Agent Narrative Tier** | LangGraph / Concordia Framework | Cyclic agent control loops managing macro plot pacing, micro scene generation, and dynamic NPC dialogues. | Constrained logit decoding via Outlines/PydanticAI. |
| **Authoritative Engine Tier** | Headless Rust Engine | Deterministic action validation, geometric raycasting, line-of-sight analysis, and dice RNG execution. | Execution validation SLA \< 10 \\text{ ms}. |
| **Hybrid Persistence Tier** | PostgreSQL / Neo4j / Redis / Qdrant | Relational event sourcing logs, interpersonal property graphs, multi-tenant compendium vectors, and atomic state locks. | Serialized transaction isolation; sub-millisecond cache lookups. |

State management across the ecosystem is partitioned into two synchronization streams. High-frequency client updates—such as token transformations, dynamic cursor positions, and lighting occlusions—are propagated using Conflict-free Replicated Data Types (CRDTs) driven by Yjs and HyperToken, ensuring real-time client-side synchronization without backend database overhead. Conversely, transactional game mechanics—including hit point adjustments, inventory item exchanges, spell slot deductions, and persistent condition flags—are governed by an append-only event sourcing architecture executing over Redis Streams and backed by PostgreSQL.  
The multi-agent narrative orchestration tier replaces monolithic prompts with a cyclic control graph built on LangGraph and inspired by Google DeepMind Concordia’s Entity-Component framework. Specialized agents—comprising a macro-level Plot Director, a micro-level Encounter DM, and persistent or ephemeral NPC Sub-Agents—communicate via structured JSON envelopes. These agents propose state mutations to the Rust rules engine, which validates them against rule schemas before committing mutations to the persistence tier and broadcasting rendered narrative streams to connected client WebSockets.

## **Pillar 1: Extended Tabletop Experience & Sensory Immersion**

### **Audio & Atmosphere Orchestration**

The sensory subsystem captures live multi-user voice audio, processes speech to structured intent, and dynamically orchestrates spatial soundscapes. Client microphone inputs are transmitted over low-latency WebRTC data channels directly to an ingestion gateway. Integrated Voice Activity Detection (VAD) isolates speech frames, which are forwarded to a streaming Automatic Speech Recognition (ASR) engine to generate real-time transcriptions for downstream intent routing.

| Audio Layer | Rendering Engine & Mechanics | Synthesis & Transition Formulas | State Event Triggers |
| :---- | :---- | :---- | :---- |
| **Ambient Background** | Multi-layered stereo/binaural loops mapped to dynamic environment tags. | Equal-power cross-fade transitions: f(t) \= \\sin(\\frac{\\pi}{2} t) over 2.0 \\text{ s} windows. | Scene location mutations emitted by Encounter DM. |
| **Adaptive Combat Scoring** | Synchronized multi-stem audio tracks (Exploration, Low Tension, High Boss). | Dynamic stem gain adjustment based on party threat ratio: T\_r \= \\frac{\\sum \\text{CR}\_{\\text{hostile}}}{\\sum \\text{HP}\_{\\text{party}}}. | Combat initiative start, low party health, boss phase triggers. |
| **Directional Spatial Audio** | Web Audio API PannerNo\[span\_18\](start\_span)\[span\_18\](end\_span)de bound to 3D spatial coordinates (x, y, z). | Inverse-distance attenuation: \\text{Gain}(d) \= \\frac{d\_{\\text{ref}}}{d\_{\\text{ref}} \+ f\_{\\text{rolloff}} \\cdot (\\max(d, d\_{\\text{ref}}) \- d\_{\\text{ref}})}. | Token spell casting, monster vocalizations, environmental traps. |
| **Deterministic Sound Triggers** | Local client audio buffer playback triggered via Redis Pub/Sub. | Immediate playback buffer execution with target latency \[span\_20\](start\_span)\[span\_20\](end\_span)\< 20 \\text{ ms}. | Mechanical critical hits, spell impacts, saving throw failures. |

### **GM Fiat & "Rule of Cool" Protocols**

To balance rules authority with creative player agency, the engine incorporates a formal protocol for resolving "Rule of Cool" actions. When a player proposes an unorthodox action that falls outside explicit rules coverage (such as swinging from a tavern chandelier to drop-kick an enemy across a greased floor), the Intent Classification Router identifies the input as INTENT\_CREATIVE\_FIAT.  
The Encounter DM sub-agent evaluates the creative context and generates a structured fiat proposal schema. This schema specifies the underlying base skill check, difficulty class (DC) adjustments, resource costs (such as inspiration burning or bonus action expenditure), and risk-reward outcomes. The deterministic risk-reward modifier calculation is expressed as:  
\\text{DC}\_{\\text{final}} \= \\text{DC}\_{\\text{base}} \+ \\Delta \\text{DC}\_{\\text{complexity}} \- \\delta\_{\\text{inspiration}} \- \\delta\_{\\text{resource}} \\text{Effect}\_{\\text{bonus}} \= \\min \\left( \\text{Dice}\_{\\text{standard}} \+ \\left\\lfloor \\frac{\\text{DC}\_{\\text{final}} \- 10}{5} \\right\\rfloor \\cdot d6, \\text{Cap}\_{\\text{max}} \\right)  
Where \\delta\_{\\text{inspiration}} \= 5 if the player consumes an inspiration point, and \\delta\_{\\text{resource}} reflects spent spell slots or class resources. This proposal payload is submitted to the Rust rules engine, which validates resource availability, rolls cryptographically secure dice seeds, applies mechanical consequences (such as granting advantage or inflicting the prone condition on a failure), and returns the verified execution payload to the narrative generator.

### **Information Asymmetry & Handouts**

Information asymmetry is maintained across private client channels without leaking context to unauthorized players or multi-agent prompts:

> * **Secret Perception Checks:** Executed headlessly by the Rust engine without emitting roll events to the shared event stream. If an individual character succeeds on a check, hidden entity metadata is appended strictly to that player's private state stream over an isolated WebSocket connection (/ws/player/{id}).  
> * **Whisper Channels:** Encrypted client-to-agent and client-to-client text pipelines. The multi-agent router isolates whisper contexts so that unassociated player agent context windows remain untainted by secret information.  
> * **Cursed Item Identification:** Items maintain a dual state representation in PostgreSQL, tracking true\_state and perceived\_state. Client UIs display perceived\_state properties until a REVEAL\_CURSE event is verified by the rules engine, which mutates the player's perception mask.  
> * **Hidden Map Layers & Handouts:** Visual map occlusions and secret door geometries are rendered on client canvases via alpha-channel bitmask operations. Asset distributions, such as secret letters or map handouts, are delivered over private WebSocket frames using pre-signed, short-lived S3 URLs.

### **3D Miniature & Spatial Evolution Strategy**

The platform rendering pipeline uses a phased evolution path, transitioning from 2D WebGL/WebGPU rendering via PixiJS v8 to an interactive 3D spatial canvas utilizing WebGPU through Three.js or Babylon.js.

| Graphics Canvas Phase | Underlying Rendering Architecture | Spatial & Lighting Capabilities | Performance Boundaries |
| :---- | :---- | :---- | :---- |
| **Phase 1: 2D WebGL/WebGPU** | PixiJS v8 rendering engine with dynamic sprite batching. | Top-down 2D sprites, dynamic 2D raytraced light occluders, planar fog-of-war. | Render throughput \> 10,000 active sprites at 60 FPS. |
| **Phase 2: Hybrid 2.5D** | Orthographic projection with height-layered orthostack depth layers. | Z-ordering depth maps, dynamic height parallax, planar elevation stacks. | Multi-layer rendering at sub-16 ms frame boundaries. |
| **Phase 3: WebGPU Native 3D** | Three.js / Babylon.js engine utilizing custom WGSL compute shaders. | Full 3D meshes, vertical elevation paths, dynamic voxel-based line of sight. | Native WebGPU hardware acceleration on client runtimes. |

3D digital miniatures are ingested using glTF 2.0 / GLB containers compressed with Draco mesh compression and Basis Universal textures. Tokens support standard animation state nodes (idle, walk, attack\_melee, cast\_spell, hit, death) triggered by game state events. Spatial positions are represented as 3D vectors \\vec{p} \= (x, y, z) \\in \\mathbb{R}^3, enabling precise 3D Euclidean distance calculations for flight trajectories:  
d \= \\sqrt{(\\Delta x)^2 \+ (\\Delta y)^2 \+ (\\Delta z)^2}  
Vertical cover is computed by casting bounding-volume ray bundles from the attacker to the target. Line of sight (LoS) and lighting occlusions are calculated on the GPU via WGSL compute shaders operating over a 3D Sparse Voxel Octree (SVO). Occupancy values (0.0 \= \\text{empty}, 0.5 \= \\text{soft cover}, 1.0 \= \\text{solid obstacle}) are stored in 3D texture buffers (texture\_storage\_3d\<r8unorm, write\>). Parallel GPU threads trace rays through the voxel grid using 3D Fast Voxel Traversal algorithms (Amanatides-Woo), setting target voxel visibility and dynamically updating client fog-of-war layers.  
\#\# Pillar 2: Relational World Graph, Dynamic Persona, & Nested Inventory Schemas

### **Subjective Interpersonal Relationship Graph & Disposition Scoring**

Interpersonal relationships, faction networks, and social dynamics are modeled using asymmetric directed property graphs stored in Neo4j, coupled with continuous disposition scoring computed in real time. Because social perspectives are subjective, relationships are explicitly directed; an NPC may trust a player character who secretly despises them.  
The dynamic disposition score D\_{A \\rightarrow B}(t) \\in \[-1.0, 1.0\] governs an NPC’s dialogue tone, trade pricing, and willingness to assist:  
D\_{A \\rightarrow B}(t) \= \\tanh \\left( w\_t \\cdot T\_{A \\rightarrow B}(t) \+ w\_f \\cdot F\_{A \\rightarrow B}(t) \+ w\_a \\cdot A\_{\\text{align}}(A, B) \- w\_s \\cdot S\_A(t) \+ \\sum\_{k} \\gamma^{t \- t\_k} \\Delta I\_k \\right)  
Where T\_{A \\rightarrow B}(t) \\in \[-1.0, 1.0\] represents directed trust, F\_{A \\rightarrow B}(t) \\in \[0.0, 1.0\] represents directed fear, A\_{\\text{align}}(A, B) \\in \[-1.0, 1.0\] measures alignment axis compatibility, S\_A(t) \\in \[0.0, 1.0\] indicates current psychological stress, and \\sum \\gamma^{t \- t\_k} \\Delta I\_k represents the exponentially decayed sum of historical interactions occurring at time t\_k with decay constant \\gamma \\in (0, 1).  
When an action impacts a specific NPC or faction, social changes cascade across the network using Cypher graph edge traversals. If a player character harms a faction member, connected edges propagate distress and hostility adjustments to allied NPCs based on relationship weights:  
MATCH (target:NPC {id: $target\_id})\<-\[r:MEMBER\_OF|ALLIED\_WITH|FRIEND\_OF\]-(connected:NPC)  
WITH connected, r,  
     CASE type(r)   
       WHEN 'FRIEND\_OF' THEN \-0.8   
       WHEN 'ALLIED\_WITH' THEN \-0.5   
       WHEN 'MEMBER\_OF' THEN \-0.3   
     END AS impact\_factor  
SET connected.stress \= apoc.coll.min(\[1.0, connected.stress \+ (0.4 \* abs(impact\_factor))\])  
CREATE (connected)-\[:HOSTILE\_TO {reason: 'Harmed ally ' \+ target.name, created\_at: timestamp()}\]-\>(p:Player {id: $player\_id})

### **Relational Database DDL & Property Graph Schemas**

#### **PostgreSQL Relational DDL Schema**

\-- PostgreSQL Schema for Core Relational Entities, Inventories, and Event Logs

CREATE TABLE campaigns (  
    campaign\_id UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
    title VARCHAR(255) NOT NULL,  
    system\_ruleset VARCHAR(64) NOT NULL DEFAULT 'dnd5e\_srd',  
    created\_at TIMESTAMPTZ NOT NULL DEFAULT NOW()  
);

CREATE TABLE entities (  
    entity\_id UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
    campaign\_id UUID NOT NULL REFERENCES campaigns(campaign\_id) ON DELETE CASCADE,  
    name VARCHAR(255) NOT NULL,  
    entity\_type VARCHAR(32) NOT NULL CHECK (entity\_type IN ('PLAYER', 'NPC', 'MONSTER', 'CONTAINER', 'WORLD\_OBJECT')),  
    is\_alive BOOLEAN NOT NULL DEFAULT TRUE,  
    created\_at TIMESTAMPTZ NOT NULL DEFAULT NOW()  
);

CREATE TABLE entity\_stats (  
    entity\_id UUID PRIMARY KEY REFERENCES entities(entity\_id) ON DELETE CASCADE,  
    hp\_current INT NOT NULL CHECK (hp\_current \>= 0),  
    hp\_max INT NOT NULL CHECK (hp\_max \> 0),  
    armor\_class INT NOT NULL CHECK (armor\_class \>= 0),  
    stats\_json JSONB NOT NULL,  
    position\_xyz DOUBLE PRECISION\[3\] NOT NULL DEFAULT '{0.0, 0.0, 0.0}',  
    updated\_at TIMESTAMPTZ NOT NULL DEFAULT NOW()  
);

CREATE TABLE inventories (  
    inventory\_id UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
    owner\_entity\_id UUID UNIQUE REFERENCES entities(entity\_id) ON DELETE CASCADE,  
    capacity\_weight\_lbs NUMERIC(8, 2\) NOT NULL DEFAULT 150.00,  
    capacity\_volume\_cu\_ft NUMERIC(8, 2\) NOT NULL DEFAULT 30.00  
);

CREATE TABLE items (  
    item\_id UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
    name VARCHAR(255) NOT NULL,  
    weight\_lbs NUMERIC(6, 2\) NOT NULL DEFAULT 0.00,  
    volume\_cu\_ft NUMERIC(6, 2\) NOT NULL DEFAULT 0.00,  
    is\_container BOOLEAN NOT NULL DEFAULT FALSE,  
    max\_charges INT DEFAULT NULL,  
    properties\_json JSONB NOT NULL DEFAULT '{}'::jsonb  
);

CREATE TABLE inventory\_items (  
    inventory\_item\_id UUID PRIMARY KEY DEFAULT gen\_random\_uuid(),  
    inventory\_id UUID NOT NULL REFERENCES inventories(inventory\_id) ON DELETE CASCADE,  
    item\_id UUID NOT NULL REFERENCES items(item\_id) ON DELETE RESTRICT,  
    parent\_inventory\_item\_id UUID REFERENCES inventory\_items(inventory\_item\_id) ON DELETE CASCADE,  
    quantity INT NOT NULL DEFAULT 1 CHECK (quantity \> 0),  
    current\_charges INT DEFAULT NULL,  
    durability\_pct NUMERIC(5,2) NOT NULL DEFAULT 100.00 CHECK (durability\_pct BETWEEN 0.00 AND 100.00),  
    is\_identified BOOLEAN NOT NULL DEFAULT TRUE,  
    custom\_properties JSONB NOT NULL DEFAULT '{}'::jsonb,  
    CONSTRAINT chk\_no\_self\_parent CHECK (inventory\_item\_id \<\> parent\_inventory\_item\_id)  
);

CREATE TABLE event\_sourcing\_log (  
    sequence\_id BIGSERIAL PRIMARY KEY,  
    campaign\_id UUID NOT NULL REFERENCES campaigns(campaign\_id) ON DELETE CASCADE,  
    actor\_entity\_id UUID REFERENCES entities(entity\_id),  
    event\_type VARCHAR(64) NOT NULL,  
    payload JSONB NOT NULL,  
    state\_hash VARCHAR(64) NOT NULL,  
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()  
);

CREATE INDEX idx\_inventory\_items\_nesting ON inventory\_items(parent\_inventory\_item\_id);  
CREATE INDEX idx\_inventory\_items\_lookup ON inventory\_items(inventory\_id);  
CREATE INDEX idx\_event\_sourcing\_campaign ON event\_sourcing\_log(campaign\_id, sequence\_id);

#### **Neo4j Cypher Property Graph Schema Definitions**

// Neo4j Graph Schema Definitions for Entities, Factions, and Interpersonal Metrics

CREATE CONSTRAINT unique\_entity\_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE;  
CREATE CONSTRAINT unique\_faction\_id IF NOT EXISTS FOR (f:Faction) REQUIRE f.id IS UNIQUE;

CREATE INDEX entity\_name\_index IF NOT EXISTS FOR (e:Entity) ON (e.name);  
CREATE INDEX faction\_name\_index IF NOT EXISTS FOR (f:Faction) ON (f.name);

MERGE (npcA:Entity:NPC {id: "npc-101", name: "Elion the Merchant", stress: 0.15})  
MERGE (npcB:Entity:NPC {id: "npc-102", name: "Captain Vance", stress: 0.40})  
MERGE (pc1:Entity:Player {id: "pc-201", name: "Valerius", class: "Rogue"})  
MERGE (facMerchant:Faction {id: "fac-301", name: "Merchant Guild", influence: 0.85})

MERGE (npcA)-\[:MEMBER\_OF {rank: "Guildmaster"}\]-\>(facMerchant)  
MERGE (npcB)-\[:ALLIED\_WITH {agreement: "Port Protection"}\]-\>(facMerchant)

MERGE (npcA)-\[:INTERACTS\_WITH {  
    trust: 0.75,  
    fear: 0.05,  
    dynamic\_bias: 0.35,  
    last\_updated: timestamp()  
}\]-\>(pc1)

MERGE (npcB)-\[:INTERACTS\_WITH {  
    trust: \-0.60,  
    fear: 0.50,  
    dynamic\_bias: \-0.45,  
    last\_updated: timestamp()  
}\]-\>(pc1);

### **Physical & Nested Inventory Tracking**

Nested inventories—such as a *Bag of Holding* containing a *Locked Wooden Chest*, inside of which is a *Pouch* containing *Gold Coins*—are resolved recursively through the self-referential parent\_inventory\_item\_id relationship in PostgreSQL. Accumulated weight and volume constraints are calculated using recursive Common Table Expressions (CTEs):  
WITH RECURSIVE ContainerHierarchy AS (  
    SELECT inventory\_item\_id, item\_id, parent\_inventory\_item\_id, quantity, 1 AS depth  
    FROM inventory\_items  
    WHERE inventory\_item\_id \= $target\_container\_item\_id

    UNION ALL

    SELECT child.inventory\_item\_id, child.item\_id, child.parent\_inventory\_item\_id, child.quantity, parent.depth \+ 1  
    FROM inventory\_items child  
    INNER JOIN ContainerHierarchy parent ON child.parent\_inventory\_item\_id \= parent.inventory\_item\_id  
)  
SELECT   
    SUM(i.weight\_lbs \* ch.quantity) AS total\_nested\_weight\_lbs,  
    SUM(i.volume\_cu\_ft \* ch.quantity) AS total\_nested\_volume\_cu\_ft  
FROM ContainerHierarchy ch  
JOIN items i ON ch.item\_id \= i.item\_id;

Item transfers, looting, and trading require atomic state changes to prevent duplication or race conditions across concurrent multi-agent executions. Transactions use explicit pessimistic row locking (FOR UPDATE) within PostgreSQL, coordinated via Redis distributed locks (Redlock algorithm) during multi-item swaps:  
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;

SELECT inventory\_id FROM inventories   
WHERE inventory\_id IN ($source\_inv\_id, $target\_inv\_id)   
FOR U\[span\_35\](start\_span)\[span\_35\](end\_span)PDATE;

UPDATE inventory\_items  
SET inventory\_id \= $target\_inv\_id,  
    parent\_inventory\_item\_id \= NULL  
WHERE inventory\_item\_id \= $transfer\_item\_id   
  AND inventory\_id \= $source\_inv\_id;

INSERT INTO event\_sourcing\_log (campaign\_id, actor\_entity\_id, event\_type, payload, state\_hash)  
VALUES ($campaign\_id, $actor\_id, 'ITEM\_TRANSFER',   
        jsonb\_build\_object('item\_id', $transfer\_item\_id, 'from', $source\_inv\_id, 'to', $target\_inv\_id),  
        sha256(($campaign\_id || NOW())::bytea));

COMMIT;

## **Pillar 3: Character Sheet, Token, & Compendium Ingestion Engine**

### **Format Interoperability Pipeline**

The ingestion subsystem translates third-party schema formats into unified canonical state representations:

| Ecosystem / Source Format | Extraction Mechanism | Mapping & Normalization Strategy |
| :---- | :---- | :---- |
| **Foundry VTT (JSON/Modules)** | Manifest parsing (system.json) & DataModel document inspection. | Extracts Actor documents, strips legacy JavaScript macros, maps embedded item arrays to nested PostgreSQL tables. |
| **Roll20 Export** | Attribute array (attribs) parsing & macro extraction. | Converts inline roll strings (/r 1d20+@{dex\_mod}) into standard mathematical formulas (D20 \+ @dex\_mod). |
| **D\&D Beyond / 5e.tools** | Structured JSON schema mapping. | Normalizes spell lists, feature trees, and equipment arrays directly into canonical Pydantic models. |
| **Open5e / PF2e Schemas** | Namespace-tagged API ingestion. | Segregates Pathfinder 2e multiple attack penalties and action point systems into isolated system models. |

### **Unstructured Data Ingestion (PDF / OCR)**

Unstructured homebrew PDF character sheets and monster stat blocks pass through an Abstract Syntax Tree (AST)-driven extractor pipeline:

> 1. **Vision/OCR Extraction:** Layout-aware vision models process PDF pages, generating structured markdown with explicit bounding boxes and bounding tables.  
> 2. **AST Structural Chunking:** The document is split into hierarchical AST nodes (Headers, Stat Block Blocks, Ability Descriptions, Spell Lists) to preserve structural context.  
> 3. **Constrained Schema Repair:** Text chunks pass to a fast LLM constrained by Outlines/PydanticAI JSON schemas. If a field fails validation (such as an out-of-range armor class data type), an automated schema repair loop re-analyzes the field:

from pydantic import BaseModel, Field, \[span\_40\](start\_span)\[span\_40\](end\_span)ValidationError  
from typing import List, Optional

class ActionSchema(BaseModel):  
    name: str  
    attack\_bonus: Optional\[int\] \= Field(description="Bonus to hit, e.g. \+5 \-\> 5")  
    damage\_dice: str \= Field(description="Dice formula, e.g., 2d6+3")  
    damage\_type: str

class MonsterStatBlockSchema(BaseModel):  
    name: str  
    armor\_class: int \= Field(ge=0, le=40)  
    hit\_points: int \= Field(ge=1, le=2000)  
    speed\_feet: int \= Field(default=30)  
    actions: List\[ActionSchema\]

def validate\_and\_repair(raw\_json\_str: str, llm\_repair\_client) \-\> MonsterStatBlockSchema:  
    try:  
        return MonsterStatBlockSchema.model\_validate\_json(raw\_json\_str)  
    except ValidationError as err:  
        repaired\_json \= llm\_repair\_client.repair\_schema(  
            invalid\_json=raw\_json\_str,   
            errors=err.json(),   
            schema=MonsterStatBlockSchema.model\_json\_schema()  
        )  
        return MonsterStatBlockSchema.model\_validate\_json(repaired\_json)

### **Automated Token & Asset Binding**

Once imported, stat blocks are bound to dynamic visual and physical canvas representations:

> * **Hitbox Mapping:** Creature size categories automatically allocate grid footprints (1 \\times 1 grid unit for Medium, 2 \\times 2 for Large, 3 \\times 3 for Huge, 4 \\times 4+ for Gargantuan).  
> * **Sprite Generation/Binding:** Stat block metadata tags are queried against a vector-indexed sprite repository (Qdrant) to match top-down visual assets.  
> * **Audio & Collision Initialization:** Audio signatures (such as heavy footstep samples for Large creatures) and spatial collision masks are registered directly within the Rust rules engine's spatial grid.

## **Pillar 4: Hierarchical Multi-Agent Narrative Architecture**

### **Role Hierarchy & Responsibilities**

The architecture replaces single-prompt DMs with a multi-agent delegation control graph managed via LangGraph and inspired by Google DeepMind Concordia.  
| Agent Role | Lifecycle & Context Scope | Primary System Responsibilities | Output Schema Constraints | | :--- | :--- | :--- | :--- | | **Director / Plot Architect** | Asynchronous / Campaign-wide | Tracks three-act campaign milestones, manages narrative tension curves, injects plot hooks, and controls pacing. | Macro directive instructions injected into Encounter DM context window. | | **Encounter DM / Narrator** | Synchronous / Scene-bound | Parses player intent, triggers tool calls on the Rust engine, describes environment reactions, manages initiative. | Constrained logit decoding generating structured scene updates and tool calls. | | **Dedicated NPC Sub-Agent** | Ephemeral or Persistent / Scene-bound | Represents individual NPCs using Concordia's Entity-Component pattern (Memory, Goal, Social Norms, Linguistic Persona). | Typed dialogue envelopes containing emotional updates and action proposals. |  
NPC sub-agents are built using Concordia’s Entity-Component pattern. The *Memory Component* handles localized recent interactions combined with long-term vector retrievals from Qdrant. The *Goal Component* maintains short-term and long-term objectives. The *Social Norms Component* restricts dialogue outputs based on faction culture and societal constraints. The *Linguistic Persona Component* enforces specific stylistic rules, accent markers, and vocabulary complexity bounds.

### **Inter-Agent Communication Protocol & State Synchronization**

Agents communicate via typed JSON event envelopes over Redis Pub/Sub channels. The communication protocol enforces strict schema boundaries:  
{  
  "sender\_agent\_id": "agent-npc-merchant-101",  
  "recipient\_agent\_id": "agent-encounter-dm",  
  "timestamp": 1711974400,  
  "message\_type": "PROPOSE\_DIALOGUE\_AND\_ACTION",  
  "payload": {  
    "dialo\[span\_47\](start\_span)\[span\_47\](end\_span)gue\_text": "Keep your hands where I can see them, rogue\!",  
    "proposed\_action": {  
      "action\_type": "DRAW\_WEAPON",  
      "item\_id": "item-dagger-01",  
      "target\_entity\_id": "pc-201"  
    },  
    "internal\_monologue": "Valerius is too close to my coin pouch. I must intimidate him.",  
    "emotional\_state\_update": {"stress": 0.65, "fear": 0.40}  
  },  
  "context\_token\_cost": 248  
}

Context window budgets are managed through a tiered strategy:

> 1. **LiteLLM Routing Gateway:** Serves as a central proxy for model load balancing, rate limiting, and seamless failover between local open-weight models (such as Llama-3-70B) and cloud endpoints.  
> 2. **Context Summarization:** Raw dialogue logs are automatically summarized into structured memory nodes after exceeding 2,000 context tokens.  
> 3. **CRDT State Synchronization:** Non-narrative state shifts generated by agents are merged into the shared CRDT state tree via Yjs, guaranteeing eventual consistency across all connected player clients without consuming LLM context tokens.

### **Execution Sequence Workflow Trace**

The operational execution trace for a multi-agent dialogue and action resolution cycle is detailed below:

| Step Sequence | Processing Node | Action / Computation Executed | Injected Payload / Payload Schema | SLA / Target Latency |
| :---- | :---- | :---- | :---- | :---- |
| **1\. Player Action** | Client Web App | Player submits voice or text input: *"I jump off the balcony and strike the warlord."* | Transmitted over WebRTC / WebSocket to FastAPI gateway. | \< 100 \\text{ ms} |
| **2\. Intent Routing** | Intent Router | Classifies input as INTENT\_MECHANICAL\_COMBAT \+ INTENT\_CREATIVE\_FIAT. | Parses target coordinates and requested action parameters. | \< 150 \\text{ ms} |
| **3\. Sub-Agent Evaluation** | Encounter DM Agent | Synthesizes physical action proposal schema for rules validation. | Generates tool invocation payload containing spatial vector jump target. | \< 300 \\text{ ms} |
| **4\. Rules Validation** | Rust Rules Engine | Validates spatial clearance, rolls Athletics check, calculates falling damage, rolls attack roll vs AC. | Emits verified execution payload with roll results and hit state. | \< 10 \\text{ ms} |
| **5\. Graph Propagation** | Dynamic Persona System | Updates target NPC and nearby enemy stress and fear metrics (S\_{npc} \+= 0.25) in Neo4j. | Graph edge mutation adjusting immediate dynamic disposition score. | \< 20 \\text{ ms} |
| **6\. NPC Response** | Ephemeral NPC Agent | Generates reaction dialogue based on updated stress and damage state. | Outlines JSON output: *"Gah\! You'll pay for that jump, assassin\!"* | \< 400 \\text{ ms} |
| **7\. Narrative Generation** | Encounter DM Agent | Merges mechanical success and NPC dialogue into narrative text stream. | Continuous SSE / WebSocket stream dispatch to connected clients. | 500\\text{--}1200 \\text{ ms} |
| **8\. Render & Audio Sync** | WebGPU Client Engine | Renders 3D token jump animation, applies health bar state mutation, triggers impact SFX. | Yjs CRDT state merge; Web Audio API spatial playback trigger. | \< 16 \\text{ ms} (60 FPS) |

## **Pillar 5: Modularity, Content Repositories, & Campaign Templates**

### **Campaign Bundle Packaging Specification**

Campaign modules are packaged as cryptographically signed compressed archives (.vttbundle) containing structured asset directories:

| Bundle Directory / Asset | File Format | Operational Contents & Functional Purpose |
| :---- | :---- | :---- |
| manifest.json | JSON Schema | Module identification, dependency DAG, system compatibility flags, cryptographic checksums. |
| license.txt | Plain Text | Legal licensing parameters (ORC, Creative Commons CC-BY 4.0, SRD 5.1). |
| map\_voxels/ | Binary (.bin) / JSON | Binary compressed 3D voxel terrain grids and Wave Function Collapse (WFC) generation rules. |
| database\_seeds/ | SQL / Cypher | PostgreSQL entity pre-seeds and Neo4j Cypher scripts for pre-seeded interpersonal graphs. |
| vector\_index/ | JSON / Parquet | Pre-indexed Qdrant vector embeddings for compendium rules and AST chunks. |
| assets/ | GLB / WAV / OGG | Draco-compressed 3D GLTF models, Basis Universal textures, spatial audio stems. |

#### **Manifest JSON Schema Specification**

{  
  "bundl\[span\_66\](start\_span)\[span\_66\](end\_span)e\_id": "org.vtt.modules.phandelver\_expanded",  
  "version": "2.1.0",  
  "title": "Lost Mine of Phandelver Expanded"\[span\_67\](start\_span)\[span\_67\](end\_span),  
  "system\_compatibility": "dnd5e\_srd\_v1.2",  
  "engine\_version\_min": "0.14.0",  
  "license\_type": "ORC",  
  "dependencies": \[  
    {"bundle\_id": "org.vtt.core.base\_srd", "version": "\>=1.0.0"}  
  \],  
  "preseeded\_graph\_nodes\_count": 142,  
  "spatial\_maps": \[  
    {  
      "map\_id": "map\_cragmaw\_hideout",  
      "voxel\_file": "map\_voxels/cragmaw.bin",  
      "dimensions": \[100, 100, 10\]  
    }  
  \],  
  "checksum\_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"  
}

### **Licensing & Community Ecosystem Architecture**

The packaging engine isolates open-gaming rulesets from proprietary assets using strict modular database namespaces:

> * **Open Gaming License Isolation:** Rulesets (such as D\&D 5e SRD or Pathfinder 2e Remaster) are maintained in segregated database schemas within Qdrant and PostgreSQL to prevent rule contamination.  
> * **Version Control & Dependency DAGs:** Campaign packages enforce Semantic Versioning (SemVer 2.0.0). Module installers construct Directed Acyclic Graphs (DAGs) to verify dependencies and resolve entity ID collisions prior to executing database seeding migrations.

## **Pillar 6: Synthetic Playtesting & Automated Evaluation Harness**

### **Agent-vs-Agent Headless Simulation Framework**

System stability, combat balance, and rule compliance are continuously validated using a headless simulation framework. Synthetic player agents operating distinct playstyle personas execute complete campaigns against the AI DM without visual rendering overhead:

> * **Tactician Agent:** Optimizes action economy, computes maximum damage-per-round (DPR), utilizes geometric flanking advantages, and targets high-threat hostiles.  
> * **Roleplayer Agent:** Acts strictly according to persona goals and emotional parameters, choosing options that reflect high disposition alignment even if mechanically sub-optimal.  
> * **Chaos Agent:** Deliberately submits malformed requests, boundary-pushing inputs, out-of-bounds spatial movements, and rule-breaking actions to stress-test system safety mechanisms.

### **Quantitative Benchmarking Metrics & Formulas**

#### **Mechanical Compliance Rate (MCR)**

Measures the percentage of actions generated by LLM DM agents that pass execution validation by the Rust rules engine without triggering fallback re-inference cycles:  
MCR \= \\left( \\frac{A\_{\\text{valid}}}{A\_{\\text{pro\[span\_71\](start\_span)\[span\_71\](end\_span)posed}}} \\right) \\times 100\\%  
*Target Threshold: MCR \\ge 98.5\\%.*

#### **Hallucination & Continuity Index (HCI)**

Quantifies plot flag preservation and factual consistency throughout long-running campaign sessions:  
HCI \= 1.0 \- \\left( \\frac{\\sum\_{i=1}^\[span\_72\](start\_span)\[span\_72\](end\_span){N} w\_i \\cdot \\mathbb{I}(\\text{FactContradiction}\_i)}{N\_{\\text{total\\\_facts\\\_queried}}} \\right)  
Where \\mathbb{I}(\\cdot) is an indicator function returning 1 if an event contradicts an established world state stored in Neo4j/PostgreSQL, and w\_i \\in \[1.0, 3.0\] scales by the narrative importance of the fact. *Target Threshold: HCI \\ge 0.95.*

#### **Platform Latency SLA Targets**

Target processing latencies across the pipeline are strictly enforced:

| Pipeline Stage | Operational Scope | SLA Target Latency |
| :---- | :---- | :---- |
| **Ingestion Tier** | Audio stream capture, VAD frame isolation, ASR streaming. | \< 100 \\text{ ms} |
| **Parsing & Intent** | Intent classification and tool argument extraction. | \< 150 \\text{ ms} |
| **Mechanical Validation** | Deterministic Rust rules engine execution and dice RNG. | \< 10 \\text{ ms} |
| **Spatial Calculation** | 3D voxel line-of-sight raycasting and cover evaluation. | \< 15 \\text{ ms\[span\_75\](start\_span)\[span\_75\](end\_span)} |
| **State Mutation** | Transactional database writes and event sourcing log appends. | \< 20 \\t\[span\_77\](start\_span)\[span\_77\](end\_span)ext{ ms} |
| **Inference Orchestration** | Multi-agent control loop execution and initial SSE stream generation. | 500\\text{--}1200 \\text{ ms} |
| **UI Synchronization** | Client canvas CRDT merge and 3D WebGPU frame render. | \< 16 \\text{ ms} (60 FPS) |

### **Evaluator Agent System Prompt Specification**

SYS\[span\_81\](start\_span)\[span\_81\](end\_span)TEM PROMPT: Automated\[span\_82\](start\_span)\[span\_82\](end\_span) Narrative Evaluation Agent (ANEA)  
Role: Independent Compliance Inspector for Virtual Tabletop Orchestr\[span\_83\](start\_span)\[span\_83\](end\_span)ation

Task: Evaluate the provide\[span\_84\](start\_span)\[span\_84\](end\_span)d simulation segment containing:  
1\. RAW\_PLAYER\_INPUT  
2.\[span\_93\](start\_span)\[span\_93\](end\_span)\[span\_96\](start\_span)\[span\_96\](end\_span) EXECUTED\_RULES\_PAYLOAD (from authoritative engine)  
3\. GENERATED\_DM\_N\[span\_85\](start\_span)\[span\_85\](end\_span)ARRATIVE

Score the system response across three metrics using a \[0.0 to 1.0\] continuous float scale:

1\. MECHANICAL\_FIDELITY: Does the narrative accurately reflect the numeric outcome (e.g. hits vs misses, damage dealt, spell slot consumption) present in EXECUTED\_RULES\_PAYLOAD without inventing unvalidated state changes?  
2\. CONTINUITY\_PRESERVATION: Does the narrative remain consistent with pre-established facts in the dynamic graph state?  
3\. NARRATIVE\_PACING: Is the response free of unnecessary conversational filler, directly advancing the scene state?

OUTPUT FORMAT STRICT REQUIREMENT:  
{  
  "mechanical\_fidelity": float,  
  "continuity\_preservation": float,  
  "narrative\_pacing": float,  
  "detected\_hallucinations": \[string\],  
  "rule\_violations": \[string\],  
  "reasoning\_summary": string  
}

## **Pillar 7: Prior Art, Repositories, & Framework Analysis**

| Framework / Engine | Core Architectural Pattern | Identified Strengths | Architectural Limitations | System Integration Strategy |
| :---- | :---- | :---- | :---- | :---- |
| **Foundry VTT** | Node.js client-server; Document hierarchy (DataModel). | Industry standard data structures, extensible module ecosystem. | Monolithic client execution; lacks multi-agent state isolation. | Adopt system.json manifest formats and document models for data ingestion. |
| **Owlbear Rodeo** | Lightweight browser canvas; WebSockets. | Low friction onboarding, rapid canvas rendering. | Lacks rules engine authority, state persistence, or AI automation. | Model real-time canvas sync using lightweight Yjs CRDT primitives. |
| **DeepMind Concordia** | GABM framework; Entity-Component pattern. | Exceptional social dynamic and agent behavioral modeling. | High computational overhead; lacks real-time 3D spatial grids. | Adapt Entity-Component architecture for constructing persistent NPC agents. |
| **Stanford Generative Agents** | Sandbox simulation; Memory & Reflection trees. | Believable social behaviors and long-term memory retrieval. | High latency, context bloat, severe state drift over time. | Implement sliding-window memory decay and background summarization loops. |
| **TextWorld / AgentBench** | Text-based RL environment. | Strict deterministic action validation. | Text-only interfaces lacking visual canvas or sensory immersion. | Adapt benchmark execution traces for the headless synthetic playtesting suite. |

## **Implementation Roadmap & Milestone Targets**

| Development Phase | Key Technical Deliverables | Critical Target SLAs |
| :---- | :---- | :---- |
| **Phase A: Core State Foundation** | Deploy headless Rust rules engine, PostgreSQL relational schema, Neo4j graph database, and Yjs CRDT sync gateway. | Engine rule validation \< 10 \\text{ ms}; transactional DB writes \< 20 \\text{ ms}. |
| **Phase B: Narrative Agent Graph** | Construct LangGraph delegation framework, Concordia-inspired NPC components, and Outlines logit-constrained schemas. | Intent classification \< 150 \\text{ ms}; inference stream start \< 1200 \\text{ ms}. |
| **Phase C: Sensory & Spatial Engine** | Implement WebRTC audio gateway, dynamic audio stems, and WebGPU 3D canvas with WGSL voxel compute shaders. | WebGPU frame render \< 16 \\text{ ms} (60 FPS); audio playback latency \< 20 \\text{ ms}. |
| **Phase D: Ingestion & Playtesting** | Launch AST layout-aware PDF OCR pipeline, Foundry VTT importer, and automated synthetic playtesting harness. | Mechanical Compliance Rate MCR \\ge 98.5\\%; Continuity Index HCI \\ge 0.95. |

#### **Works cited**

1\. , https://drive.google.com/open?id=1\_1rtXSliJaf82dctnT\_n9Yg-P69FEj9iT1TTgpgTN98 2\. GitHub \- google-deepmind/concordia: A library for generative social simulation, https://github.com/google-deepmind/concordia 3\. Multi-Actor Generative Artificial Intelligence as a Game Engine \- arXiv, https://arxiv.org/html/2507.08892v1 4\. Google DeepMind Releases Concordia Library v2.0 \- Cooperative AI, https://www.cooperativeai.com/post/google-deepmind-releases-concordia-library-v2-0 5\. Voxel Engine Made With Babylon.js \- Alpha 1.0 Out Now \- Page 7 \- Demos and projects, https://forum.babylonjs.com/t/divine-voxel-engine-voxel-engine-made-with-babylon-js-alpha-1-0-out-now/30591?page=7 6\. Particles, Progress, and Perseverance: A Journey into WebGPU Fluids | Codrops, https://tympanus.net/codrops/2025/01/29/particles-progress-and-perseverance-a-journey-into-webgpu-fluids/ 7\. A Survey on Non-Photorealistic Rendering Approaches for Point cloud Visualization, https://www.computer.org/csdl/journal/tg/2025/09/10541081/1Xlt57WokwM 8\. A Generative Model of Conspicuous Consumption and Status Signaling \- arXiv, https://arxiv.org/html/2603.13220 9\. Help with Module "Manifest Module.json" instalation : r/FoundryVTT \- Reddit, https://www.reddit.com/r/FoundryVTT/comments/1hsvh5q/help\_with\_module\_manifest\_modulejson\_instalation/