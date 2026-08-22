# AGENTS.md - Multi-Agent Operational & Development Playbook

Welcome to the **Autonomous AI-Native Virtual Tabletop (VTT)** codebase. This document outlines architectural invariants, development workflows, testing commands, and operational boundaries for all autonomous agents (Antigravity, Cursor, Claude Code, Copilot, Codex, etc.) collaborating on this repository.

---

## 1. System Philosophy & Non-Negotiable Invariants

1. **Strict Authority Decoupling**:
   * Large Language Models (LLMs) are **probabilistic narrative generators**, NEVER the mechanical source of truth.
   * All game rules, attack resolutions, modifier derivations, LoS calculations, and state mutations MUST execute deterministically in **`crates/vtt-core`** and **`crates/vtt-spatial`**.
2. **Pre-Commit Invariant Interception**:
   * Narrative text emitted by the DM Agent MUST be audited by the **`PreCommitAuditorAgent`** before committing state.
   * Under no circumstance should an agent bypass the auditor or diagnostic retry controller.
3. **Zero-Allocation Hot Path**:
   * Rust rule calculations (`calculate_ability_modifier`, `calculate_proficiency_bonus`, `calculate_armor_class`, `resolve_attack`) MUST remain pure functions with zero runtime memory allocations on the hot path.
4. **Strong Schema Typing**:
   * All compendium entries and API payloads MUST validate against typed Pydantic models in `python/vtt_orchestrator/schemas/models.py`.

---

## 2. Port Bindings & Service Map

| Service | Technology | Port | Purpose |
| :--- | :--- | :---: | :--- |
| **Vite Client** | React 18, Tailwind CSS, Web Audio | `3000` | UI, Tabletop Canvas, 3D Audio Radar |
| **Python Orchestrator** | FastAPI, Pydantic, NetworkX | `8000` | Multi-Agent DM, Auditor, Dynasty, Compendium |
| **Authoritative Rust Engine** | Actix-Web, WFC, Wasmtime | `8088` | Authoritative Rules, LoS, CRDT Relay |
| **PostgreSQL Database** | PostgreSQL 16 + JSONB | `5432` | Relational Compendium & Full-Text Search |

---

## 3. Development Commands Cheat Sheet

### Run Full Benchmark Suite
Always run the unified benchmark script before committing code:
```bash
./scripts/run_all_benchmarks.sh
```

### Rust Engine Tests
```bash
cargo test --workspace
cargo test -p vtt-core -- --nocapture
```

### Python Orchestrator Tests
```bash
PYTHONPATH=python pytest python/tests -v
```

### Client Build & Typecheck
```bash
cd client && npm run build
```

### Generate SRD Compendiums from Markdown
```bash
PYTHONPATH=python python3 -m vtt_orchestrator.compendium.srd_importer
```

---

## 4. Codebase Navigation Map

* **`crates/vtt-core/`**: D&D 5e SRD 5.1 rules, 15 conditions, attack & saving throw resolvers, concentration checks, death save state machine, 4-tier task resolution.
* **`crates/vtt-spatial/`**: Bresenham LoS raycasting, half/three-quarters/total cover, A* pathfinding.
* **`crates/vtt-wfc/`**: Wave Function Collapse procedural map & dungeon synthesis.
* **`crates/vtt-crdt-sync/`**: Real-time Yjs CRDT relay server.
* **`crates/vtt-scripting/`**: Sandboxed Rhai and Wasmtime (50k fuel cap) execution engines.
* **`python/vtt_orchestrator/auditor/`**: `PreCommitAuditorAgent` and `DiagnosticRetryController`.
* **`python/vtt_orchestrator/simulation/`**: `DynastyEngine` (noble houses) & `EmpiricalPlaytester`.
* **`python/vtt_orchestrator/compendium/`**: `SRDImporter`, `BundlePackager` (`.vttbundle`), `HomebrewParser`.
* **`client/src/render/`**: `spatial_audio.ts` (3D stereo panners, distance gain), `webrtc_mesh.ts`.
* **`client/src/components/`**: `AudioMixerModal.tsx` (2D radar), `BundleManagerView.tsx`, `DynastyView.tsx`.

---

## 5. Guidelines for Adding Features

1. **When Modifying Rules**: Add unit tests to `crates/vtt-core/tests/srd_rules_tests.rs`.
2. **When Modifying Compendiums**: Update Pydantic models in `models.py` and run `test_srd_importer.py`.
3. **When Modifying Frontend**: Ensure React components support responsive layouts, dark theme styling, and invoke spatial audio triggers where appropriate.
