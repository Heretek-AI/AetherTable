# Static Analysis — SonarCloud & CI Gates

Status: **registered and wired** as of 2026-08-25 (iteration 51).

---

## 1. SonarCloud registration (verified, not assumed)

The project is already registered on SonarCloud. Verified live against the
public API (`https://sonarcloud.io/api`) on 2026-08-25:

| Field | Value |
|---|---|
| Organization | `heretek-ai` |
| Project key | `Heretek-AI_TTRPG` |
| Display name | **AetherTable** |
| Bound ALM | GitHub — `Heretek-AI/AetherTable` |
| Visibility | Public |
| Analysis mode | Autoscan (org automatic analysis), last run 2026-08-25 |
| Default branch | `main` (LONG) |
| Current state | 26 bugs · 101 vulnerabilities · 925 code smells on `main` |

Note the two renames: this repository was originally `TTRPG` and has been
renamed to `AetherTable` on GitHub; SonarCloud's ALM binding already points at
the new name, so nothing needs to change there.

Dashboard:
`https://sonarcloud.io/summary/new_code?id=Heretek-AI_TTRPG`

## 2. What is configured in-repo

* **`sonar-project.properties`** (repo root) — pins `sonar.projectKey=Heretek-AI_TTRPG`
  and `sonar.organization=heretek-ai`, declares first-party source roots
  (`crates/*/src`, `python/vtt_orchestrator`, `client/src`) plus test roots.
  Imported SRD content (`compendium/`) and design prose (`docs/`, `*.md`) are
  deliberately out of scope so every reported issue is actionable.
* **`.github/workflows/sonar.yml`** — runs `SonarSource/sonarqube-scan-action@v8.2`
  on push to `main` (plus manual dispatch). It fails fast with a clear message if
  the `SONAR_TOKEN` repository secret is missing rather than silently uploading
  nothing.
* **Analyzer capability honesty**: SonarCloud's Rust analyzer is community-grade
  (syntax-level rules only — no taint analysis / security hotspots for Rust).
  Python and TypeScript get the full analyzers. The Rust side therefore still
  leans on clippy (see §3).

## 3. Operator prerequisites (one-time)

Until these are done, pushes to `main` will show the sonar.yml job failing with
an explanatory error:

1. Create an analysis token at <https://sonarcloud.io/account/security>
   (type: *Analysis*, expiry per your policy).
2. Add it to the repo as secret **`SONAR_TOKEN`**
   (*Settings → Secrets and variables → Actions → New repository secret*).
3. Optional: set a quality gate other than the default "Sonar way" at
   <https://sonarcloud.io/organizations/heretek-ai/quality_gates> — currently
   no custom gate is attached (`project_status: NONE`), so nothing blocks on
   Sonar results today even after wiring.

## 4. CI gates that are live now (no operator action needed)

`.github/workflows/ci.yml` runs on push/PR to `main`:

| Gate | Command | Notes |
|---|---|---|
| Rust static analysis | `cargo clippy --workspace --all-targets -- -D warnings` | Hard gate. Verified warning-free locally before being added, so it only fails on regressions. |
| Rust tests | `cargo test --workspace --verbose` | Pure/deterministic suites. |
| Python tests | `PYTHONPATH=python pytest python/tests -v` | Env-dependent suites skip honestly: live-LLM tests require `LLM_KEY` + `RUN_LIVE_LLM=1`; engine-live assertions require a reachable gateway (`ENGINE_API_URL`, default `localhost:8088`) which CI sets to empty so the harness reports `engine_live: False` instead of erroring. |
| Client unit tests | `cd client && npm run test` (Vitest) | Pure in-browser logic; hard gate. |
| Client typecheck + build | `cd client && npm run build` | `tsc && vite build`; hard gate. |
| Benchmarks | `./scripts/run_all_benchmarks.sh` | Requires LLM secrets (`LLM_MODEL` / `LLM_KEY` / `LLM_API`); skips/fails honestly without them. |

Local pre-commit equivalents already exist in `lefthook.yml` (actionlint,
zizmor, cargo-deny, typos, trufflehog).
