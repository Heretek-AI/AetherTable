# GEMINI.md - Google Antigravity & Gemini Agent Guide

This document guides Google Antigravity and Gemini-powered agents navigating and enhancing the **TTRPG Virtual Tabletop** codebase.

---

## ⚡ Slash Commands & Workflows

- **`/plan`**: Run before implementing any new subsystem, major refactor, or complex feature. Generates structured implementation plans with mermaid diagrams and verification checklists.
- **`/goal`**: Run for long-running autonomous development or full test iterations.
- **`/schedule`**: Schedule timers and recurring cron health checks.

---

## 🧠 Codebase Knowledge Graph Integration (`codebase-memory-mcp`)

When discovering or tracing code across this workspace:
1. `search_graph` — Find functions, structs, classes, or routes by regex pattern.
2. `trace_path` — Trace inbound callers or outbound calls of a specific function or handler.
3. `get_code_snippet` — Inspect qualified Rust or Python function implementations.
4. `get_architecture` — High-level summary of workspace modules.

---

## 🏗️ Core Subsystems Summary

| Subsystem | Location | Key Invariants |
| :--- | :--- | :--- |
| **SRD 5.1 Rule Engine** | `crates/vtt-core/` | Zero-allocation floored modifiers, AC derivation, death saves |
| **Spatial Engine & LoS** | `crates/vtt-spatial/` | Bresenham line-of-sight, cover penalties (+2, +5, total) |
| **WFC Map Synthesis** | `crates/vtt-wfc/` | Socket-based procedural dungeon generation |
| **Invariant Auditor** | `python/vtt_orchestrator/auditor/` | Pre-commit state interceptor and 2-pass retry controller |
| **Dynasty Factions** | `python/vtt_orchestrator/simulation/` | Procedural noble lineage and feud matrix generation |
| **Campaign Bundles** | `python/vtt_orchestrator/compendium/` | `.vttbundle` zip packager and Homebrewery markdown parser |
| **3D Audio Radar** | `client/src/render/` & `components/` | Web Audio stereo azimuth panners and interactive radar modal |

---

## 🔄 Reactive Multi-Agent Protocols

- Python FastAPI server runs on port `8000`.
- Rust Actix-Web engine runs on port `8088`.
- React client runs on port `3000`.
- All benchmarks can be executed via `./scripts/run_all_benchmarks.sh`.
