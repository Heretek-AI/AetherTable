# GOALS.md: Comprehensive AI-Native Virtual Tabletop Platform Specification

## Product Vision
Build a collaborative, AI-directed Virtual Tabletop (VTT) that combines the fluid storytelling, improvisational agency, and social dynamics of tabletop roleplaying with the mechanical authority, visual polish, low latency, and accessibility of a modern video game[cite: 2, 3]. 

The architecture establishes the AI as a director, scene-setter, tactical referee, and NPC roleplayer—never an unconstrained overlord[cite: 1, 2, 4]. All game mechanics, resource tallies, dice rolls, spatial rules, and inventory modifications are strictly governed by an authoritative, deterministic engine[cite: 2, 3, 4].

---

## Pillar 1: Multi-User Identity, Session Routing & Real-Time Sync
* **Multi-User Authentication & Authorization:** Implement secure user signups, sessions, and OAuth2 identity management with role-based access control (`Campaign Owner / DM`, `Assigned Player`, `Spectator`)[cite: 1, 2].
* **Isolated Room Routing:** Authenticate and isolate campaign session WebSockets and WebRTC channels to prevent cross-table data leakage[cite: 2, 3].
* **Hybrid Synchronization Model:**
  * *High-Frequency UI State:* Propagate cursor tracks, token dragging, dynamic lighting occluders, and fog-of-war masks via Conflict-free Replicated Data Types (CRDTs) with Last-Write-Wins vector clocks for sub-16 ms client rendering[cite: 2, 3].
  * *Transactional Game Mechanics:* Route hit points, spell slots, inventory transactions, and turn actions through an append-only event sourcing log in PostgreSQL/Redis with strict serializability[cite: 2, 3].
* **Party Roster & Character Binding:** Allow users to bind characters from their account vault or build new ones with full live synchrony across all player views[cite: 1].
* **Autonomous AI Companions:** Provide drop-in AI-controlled player characters and sidekicks configured with tactical roles (e.g., *Frontline Tank*, *Healer*, *Skirmisher*) that take coherent turns and respond to player guidance[cite: 1].

---

## Pillar 2: Campaign Setup, Premade Modules & Onboarding
* **Guided Campaign Setup Wizard:** Provide an onboarding flow to configure campaign names, choose rule versions (SRD 5.1 vs. SRD 5.2), set starting levels, customize party slots, and generate invite codes[cite: 1].
* **Standardized Module Packaging (`.vttbundle`):** Support signed archive packages bundling maps, token configurations, compendium overrides, spatial lighting occluders, audio stems, and Neo4j lore graph seeds[cite: 1, 2].
* **Out-of-the-Box Starter Adventures:** Ship complete, playable campaign packages (e.g., *The Sunken Crypt of Karas*) with pre-seeded encounter trees, maps, and balanced enemy placement[cite: 1, 2].
* **Dynamic Thematic Atmosphere:** Enable hosts to select or generate atmospheric themes (e.g., *Gothic Horror*, *High Fantasy*, *Eldritch Mystery*) that dynamically adjust UI palettes, encounter styling, and ambient audio soundscapes[cite: 1, 2].
* **Seamless Lobby-to-Canvas Transition:** Ensure lobby transitions immediately hydrate the active spatial canvas, loading token positions, map layers, and lighting geometry without demo fallbacks[cite: 1].

---

## Pillar 3: Deterministic Core Rules & Action Economy Engine
* **Decoupled Architecture:** Strip the LLM of direct write access to character statistics, HP, inventory, and dice values; all mutations execute through deterministic tool calls evaluated by a headless rules engine[cite: 2, 3, 4].
* **Topological Modifier Graph:** Resolve layered character modifiers in strict topological sequence: Base Attributes $\rightarrow$ Racial/Class Features $\rightarrow$ Feats $\rightarrow$ Static Equipment Modifiers $\rightarrow$ Dynamic Item Overrides $\rightarrow$ Transient Buffs/Debuffs $\rightarrow$ Situational Conditions[cite: 1, 2].
* **Strict Action Economy FSM:** Enforce turn budgets in combat: 1 Action, 1 Bonus Action, 1 Reaction (refreshed at turn start), 1 Free Object Interaction, and segmented Movement Pools[cite: 2, 4].
* **Reaction Interrupt Stack:** Pause resolution when reaction triggers occur (e.g., *Shield*, *Counterspell*, *Opportunity Attack*), poll eligible entities within range, resolve reaction branches, and resume the stack[cite: 2].
* **Authoritative Spellcasting Validation:** Verify spell slot availability, material/verbal/somatic component constraints, active concentration limits, and saving-throw outcomes before deducting resources[cite: 2, 3, 4].
* **Condition & Duration Lifecycle:** Model status effects with duration clocks (rounds, minutes, end-of-turn saves), where conditions automatically enforce their mechanical penalties (e.g., *Paralyzed*, *Stunned*, *Incapacitated*)[cite: 2, 3].

---

## Pillar 4: Spatial Geometry, Tactical Raycasting & NavMesh
* **Dual-Mode Spatial Architecture:**
  * *Tactical Coordinate Grid:* Cartesian 2D/3D matrices and hex coordinates supporting variable grid metrics (Euclidean, Chebyshev, Manhattan)[cite: 3, 5].
  * *Topological Zone Graph (Theater of the Mind):* Relational zone nodes connected by distance hops for fast, low-overhead narrative combat[cite: 5].
* **Dynamic Line-of-Sight (LoS) & Senses:** Compute real-time raycasted visual polygons against wall/door occluders, evaluating vision modes (Normal, Darkvision, Blindsight, Truesight) and lighting zones (Bright, Dim, Darkness, Magical Darkness)[cite: 2, 3].
* **Raycast Cover Calculation:** Cast 4-corner bounding-box ray bundles between attacker and target to automatically determine None, Half ($+2\text{ AC}$), Three-Quarters ($+5\text{ AC}$), or Full Cover[cite: 3].
* **Spatial Pathfinding & Hazards:** Execute $A^*$ pathfinding over grid meshes to compute movement budgets, apply difficult terrain multipliers, avoid recognized hazard zones, and identify opportunity attack boundaries[cite: 3, 4].

---

## Pillar 5: Hierarchical Multi-Agent AI Orchestrator
* **Multi-Agent Separation of Concerns:**
  * *Campaign Director Agent:* Tracks 3-act narrative pacing, faction power shifts, long-term quest milestones, and tension curves[cite: 2].
  * *Encounter DM / Narrator Agent:* Ingests player inputs, invokes compendium tools, describes scene transitions, and manages tactical encounters[cite: 2].
  * *Dedicated NPC Sub-Agents:* Operates individual NPCs using the Concordia Entity-Component pattern (Memory, Goals, Social Norms, Linguistic Style)[cite: 2].
* **Voice & Text Intent Classification:**
  * Automatically categorize inputs into *Out-of-Character (OOC)*, *In-Character (IC) Dialogue*, *Mechanical Action Declarations*, *Rule-of-Cool Fiat*, or *Safety Triggers*[cite: 3, 5].
  * Speculatively pre-fetch relevant entity stat blocks during streaming speech-to-text to maintain low turn latencies[cite: 3].
* **GM Fiat & Rule-of-Cool Protocol:** Dynamically formulate structured skill checks and DC adjustments for creative player actions, factoring in resource expenditures and inspiration points before engine validation[cite: 2].

---

## Pillar 6: Pre-Commit Invariant Interception & Anti-Hallucination Gate
* **The Auditor / World Inspector:** Intercept all narrative drafts, tool calls, and state changes proposed by the AI DM prior to database commit or client streaming[cite: 4].
* **Conservation Law of Entities (Anti-Popping):** Assert that tokens cannot appear or vanish without a verified ingress/egress protocol (*Planar Teleportation*, *Door/Portal Ingress*, *Stealth Reveal*, or *Burrowing*)[cite: 4].
* **Spatial & Mechanical Invariance:** Halt transactions if proposed actions violate spatial budgets, pass through impassable occluders, or ignore action economy limits[cite: 4].
* **Math-Narrative Reconciliation:** Enforce semantic consistency between mechanical outcomes and narrative descriptions (e.g., reject narrative descriptions of death/decapitation if a target retains positive HP)[cite: 4].
* **Automated Diagnostic Retry Loop:** Intercept failed invariants and supply structured diagnostic feedback directly into a reprompt loop to correct narrative output[cite: 4].

---

## Pillar 7: Relational Knowledge, Nested Inventories & Epistemic State
* **Authoritative Relational Schemas:** Maintain complete relational schemas in PostgreSQL for entities, stat blocks, equipment, action decks, and event sourcing logs[cite: 2, 4].
* **Recursive Nested Inventory Hierarchy:** Model complex container hierarchies (pouches inside chests inside bags of holding) using recursive parent-child CTEs with volume and weight limit enforcement[cite: 2].
* **Epistemic Knowledge Graph (Neo4j):** Track subjective information, unverified rumors, and secrets independently per character:
  * Maintain information asymmetry for secret perception checks, hidden traps, cursed item states, and private handouts[cite: 2].
* **Multi-Tier Lore Mutability:** Classify improvised player assertions into *Subjective Rumors*, *Proposed Facts*, or *Validated World Canon*, checking for paradoxes before updating canon[cite: 5].
* **Multi-Tenant Hybrid RAG (Qdrant):** Index rules compendiums and episodic session memories using hybrid dense/sparse embeddings with strict namespace filtering[cite: 2, 3].

---

## Pillar 8: Procedural Worldbuilding, Faction Simulation & Fail-Forward Mechanics
* **Seeded Wave Function Collapse (WFC):** Procedurally assemble dungeon layouts and battlemaps from pre-validated tile libraries with explicit socket matching, door connectivity, and loot distribution[cite: 1, 3, 4].
* **Asynchronous Faction Clocks:** Simulate active factions in the background during party rests and downtime using Goal-Oriented Action Planning (GOAP) and progress clocks to evolve territorial control and world events[cite: 5].
* **Continuous NPC Disposition Scoring:** Calculate real-time, directed relationship scores between NPCs, factions, and players based on trust, fear, alignment compatibility, stress, and time-decayed interactions[cite: 2, 5].
* **Fail-Forward Resolution Engine:** Support non-binary success margins ($M = \text{Roll} - \text{DC}$):
  * $M \ge +10$: Critical Success[cite: 5].
  * $0 \le M < +10$: Standard Success[cite: 5].
  * $-5 \le M < 0$: **Success at a Cost** (Action succeeds, but engine deterministically deducts resources, applies conditions, or ticks an alert clock)[cite: 5].
  * $M < -5$: Critical Failure[cite: 5].

---

## Pillar 9: Presentation Layer, 3D Physics & Immersive Audio
* **Hybrid 2D/3D Rendering Engine:** High-performance WebGPU/WebGL canvas utilizing dynamic sprite batching, 3D glTF miniatures, animated state meshes, particle weather shaders, and elevation layers[cite: 1, 2].
* **Deterministic 3D Dice Physics:** Render client-side rigid-body 3D dice rolls whose final results match the server's cryptographically secure PRNG seeds[cite: 1, 2].
* **Interactive Character Sheet HUD:** Provide responsive 5e sheet components with dynamic modifier recalculations, spell management, equipment toggles, and roll macros[cite: 1].
* **Positional Spatial Audio:** Ingest and render WebRTC voice streams and ambient soundscapes via Web Audio API 3D panner nodes, attenuating sound based on Euclidean token distance and intervening occluders[cite: 2].
* **Streamer & Spectator Modes:** Support dedicated broadcast views that automatically filter out secret DM notes, hidden tokens, and private player channels[cite: 1, 2].

---

## Pillar 10: Sandboxed Scripting, Content Ingestion & Packaging
* **Dual Scripting Sandbox:**
  * *Wasmtime (WASM):* Execute complex homebrew mechanics, custom classes, and calculation loops with strict instruction fuel metering and memory sandboxing[cite: 5].
  * *Rhai Scripting:* Provide a lightweight, embedded script layer for narrative hooks, environmental triggers, and basic spell reactions[cite: 1, 5].
* **Format Ingestion Pipeline:** Ingest third-party assets from Foundry VTT modules, Roll20 exports, and D&D Beyond JSON schemas into canonical formats[cite: 2].
* **Homebrew Document Parsing:** Process unstructured homebrew PDFs and stat blocks through vision OCR and AST structural chunkers with schema-constrained repair loops[cite: 2].

---

## Pillar 11: Table Dynamics, Spotlight Balancing & Safety Controls
* **Player Agency & Veto Authority:** Maintain human player sovereignty over all character actions, dice overrides, and creative interpretations, positioning the AI purely as a facilitator and director[cite: 1, 2, 4].
* **Intelligent Action Assistance:** Automatically translate natural language intentions (e.g., *"I jump from the table and tackle the goblin"*) into standard 5e mechanics (Athletics Check + Grapple)[cite: 2].
* **Conversational Spotlight Balancing:** Track speaker activity via Voice Activity Detection (VAD) across sessions, prompting the Director Agent to direct narrative hooks toward quieter players[cite: 5].
* **Built-in Safety Gateway:** Provide instant digital safety tools (X-Card, Lines & Veils, Scene Pause) that bypass narrative generation queues to trigger immediate scene pivots and rollbacks[cite: 1, 5].

---

## Target Service Level Agreements (SLAs) & Performance Thresholds
* **Rules Engine Execution:** $< 10\text{ ms}$ for mechanical validations and state mutations[cite: 2, 3].
* **Spatial & Cover Calculations:** $< 15\text{ ms}$ for raycasted line of sight and cover evaluation[cite: 2, 3].
* **Input Intent Parsing:** $< 150\text{ ms}$ classification latency from speech-to-text / text entry[cite: 2, 3].
* **Client Render Loop:** Native 60 FPS ($< 16\text{ ms}$ frame execution) on WebGPU/WebGL canvases[cite: 2, 3].
* **End-to-End Turn Narrative Stream:** Initial Server-Sent Events (SSE) narrative stream start within $500\text{--}1200\text{ ms}$[cite: 2, 3, 4].
* **Mechanical Compliance Rate (MCR):** $\ge 98.5\%$ of generated actions execute without triggering deterministic engine rejections[cite: 2, 4].
* **Hallucination & Continuity Index (HCI):** $\ge 0.95$ adherence to physical, spatial, and established lore invariants over continuous multi-session play[cite: 2, 4].
