# CLAUDE.md - Developer Cheat Sheet & Instructions

This repository contains the **AI-Native Virtual Tabletop (VTT)** system. Use this file as a rapid reference for build commands, test patterns, coding styles, and architectural guidelines.

---

## 🛠️ Build & Test Commands

### One-Command Workspace Test & Verification
```bash
./scripts/run_all_benchmarks.sh
```

### Rust Engine (`crates/`)
```bash
cargo build --workspace
cargo test --workspace        # ~163 tests across all crates
cargo test -p vtt-core --test srd_rules_tests
```

### Python Orchestrator (`python/`)
```bash
# Run pytest with PYTHONPATH
PYTHONPATH=python pytest python/tests -v   # ~444 collected tests (+ opt-in live-LLM suite)

# Run a specific test module
PYTHONPATH=python pytest python/tests/test_srd_importer.py -k test_srd_spell_parser
```

### Frontend Presentation Client (`client/`)
```bash
cd client
npm install
npm run build      # Typechecks via tsc and runs vite build (typically well under 15s)
npm run dev        # Starts Vite dev server on http://localhost:3000
```

---

## 📐 Architecture & Standards

### Rust (`crates/`)
- **Edition**: 2021
- **Philosophy**: Pure, deterministic, zero-allocation calculations in `vtt-core` and `vtt-spatial`.
- **Error Handling**: Use `Result<T, E>` with custom error enums. Avoid `.unwrap()` or `.expect()` in library crates.
- **Serialization**: Standard `serde` with `#[serde(rename_all = "snake_case")]` for enums and JSON structures.

### Python (`python/vtt_orchestrator/`)
- **Python Version**: 3.11+ / 3.12
- **Validation**: Strict Pydantic v2 schemas (`pydantic.BaseModel`, `Field`).
- **Imports**: Always use absolute imports relative to `vtt_orchestrator` (e.g., `from vtt_orchestrator.schemas.models import ...`).
- **Orchestration**: Decouple intent classification, invariant auditing, and narrative drafting.

### TypeScript / React (`client/`)
- **Framework**: React 18 with TypeScript.
- **Styling**: Tailwind CSS with dark fantasy / obsidian color palette.
- **Icons**: `lucide-react`.
- **Audio**: Web Audio API `AudioContext`, `StereoPannerNode`, `GainNode` for 3D positional sound.

---

## 🛡️ Invariant Checklists

Before finalizing changes:
- [ ] All Rust crates compile cleanly with 0 errors; `cargo test --workspace` passes (~163 tests).
- [ ] `PYTHONPATH=python pytest python/tests` passes (~444 collected tests; the live-LLM suite is opt-in).
- [ ] Synthetic playtest benchmark achieves MCR ≥ 98.5%, HCI ≥ 0.95, AFPR ≤ 1.5%, auditor recall ≥ 95% (`./scripts/run_all_benchmarks.sh`).
- [ ] `cd client && npm run build` completes in under 15s with zero TypeScript diagnostics.
