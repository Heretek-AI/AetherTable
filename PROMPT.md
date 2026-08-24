# MISSION: Systematic Onboarding, Gap Audit & Execution Roadmap for AetherTable

You are an expert full-stack systems engineer, distributed systems architect, and TTRPG mechanics authority onboarding to the **AetherTable** repository. 

Your goal is to fully ingest the project context, audit the current implementation against `GOALS.md`, systematically research open-source tools and D&D 5e SRD standards using connected MCPs, and output a concrete implementation gap analysis and execution backlog.

---

### Step 1: Ingest Context & Map Existing Codebase
1. **Explore the Workspace Architecture:**
   * Review `GOALS.md`, `README.md`, `AGENTS.md`, and the Phase II/III architectural specifications.
   * Inspect all subdirectories to map active layers:
     * **Rust Engine (`crates/`):** `vtt-core`, `vtt-spatial`, `vtt-wfc`, `vtt-crdt-sync`, `vtt-scripting`, `vtt-server`.
     * **AI DM Orchestrator (`python/vtt_orchestrator/`):** `agents/`, `auditor/`, `compendium/`, `ingestion/`, `lore/`, `routing/`, `simulation/`.
     * **Client Frontend (`client/`):** React + Vite + PixiJS/WebGPU canvas, components, hooks, and render layers.
     * **Persistence & Infra (`database/`, `docker-compose.yml`):** PostgreSQL schemas, Neo4j lore graph Cypher scripts, and Qdrant collection configurations.
2. **Catalog Implemented vs. Stubbed Modules:** Identify which functions, endpoints, schemas, and UI components are fully implemented, mock stubs, or missing entirely.

---

### Step 2: Audit Against `GOALS.md`
Evaluate the codebase against each of the 11 Core Pillars in `GOALS.md`:
* **Pillar 1:** Multi-User Identity, Session Routing & Real-Time Sync (Auth, CRDT room streams, role-based access).
* **Pillar 2:** Campaign Setup, Premade Modules & Onboarding (`.vttbundle` ingestion, lobby-to-canvas flow).
* **Pillar 3:** Deterministic Core Rules & Action Economy Engine (Modifier graph, action budgets, spellcasting checks).
* **Pillar 4:** Spatial Geometry, Tactical Raycasting & NavMesh (LoS polygons, 4-corner cover calculations, $A^*$ pathfinding).
* **Pillar 5:** Hierarchical Multi-Agent AI Orchestrator (Intent routing, Concordia Entity-Component sub-agents).
* **Pillar 6:** Pre-Commit Invariant Interception & Anti-Hallucination Gate (Auditor agent, anti-popping laws, semantic contradiction checks).
* **Pillar 7:** Relational Knowledge, Nested Inventories & Epistemic State (Postgres CTE inventories, Neo4j private fact masks).
* **Pillar 8:** Procedural Worldbuilding, Faction Simulation & Fail-Forward Mechanics (WFC dungeons, GOAP faction clocks).
* **Pillar 9:** Presentation Layer, 3D Physics & Immersive Audio (WebGPU/WebGL canvas, 3D rigid-body dice, spatial audio panner).
* **Pillar 10:** Sandboxed Scripting, Content Ingestion & Packaging (WASM/Rhai execution, PDF AST extraction).
* **Pillar 11:** Table Dynamics, Spotlight Balancing & Safety Controls (VAD engagement metrics, X-Card safety gateway).

---

### Step 3: Recursive Research & OSS Discovery Loop (Use MCP Tools)
Do **not** reinvent the wheel. Use your connected tools to ground technical decisions in battle-tested open-source software and canonical D&D 5.1/5.2 SRD rules:
* **Deep Architectural Reasoning (`sequential-thinking`):** Break down complex trade-offs (e.g., CRDT delta syncing vs. append-only event sourcing, Wasmtime vs. Rhai fuel-metered execution).
* **Open-Source Discovery & Web Scraping (`searxng`, `firecrawl-mcp`, `github`):**
  * Search for reference implementations of 5e SRD rules engines, modifier trees, and topological sorting algorithms.
  * Search for existing open-source packages for 3D dice physics, WebGPU lighting shaders, and audio VAD pipelines before writing custom code.
  * Research standards for `.vttbundle` / Foundry VTT / Roll20 interoperability formats.
* **Persistent Knowledge & Code Health (`memory`, `context7`, `sonarcloud`):**
  * Store discovered architectural patterns, canonical schema mappings, and component relationships in `memory`.
  * Run static analysis and code health checks using `sonarcloud` on existing Python and Rust crates.
* **Skills & UI Diagnostics (`find-skills`, `design-system`, `chrome-devtools-mcp`):**
  * Activate `design-system` and UI/UX skills to audit canvas performance, accessible component layouts, and design tokens.

---

### Step 4: Deliverables & Output Format
Provide a comprehensive report containing:

1. **System Health & Implementation Status Matrix:**
   A Markdown table comparing all 11 Pillars against the current codebase:
   `| Pillar | Status (Implemented / Partial / Stub / Missing) | Key Files / Crates | Primary Gaps |`
2. **Technical Debt & Architectural Risks:**
   Highlight any places where the LLM currently has unauthorized write access to game state, missing invariants, or unhandled concurrency races.
3. **Open-Source Reuse Recommendations:**
   A categorized list of existing open-source libraries/crates to integrate for missing components (rules parsers, dice physics, spatial indexing, audio pipelines).
4. **Prioritized Execution Roadmap (Phase-by-Phase):**
   An actionable, dependency-ordered plan (Phases 1 through 5) detailing the exact files to create or modify next.

Begin by running the workspace exploration and querying MCP tools to establish the initial audit state.
