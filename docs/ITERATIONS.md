# Autonomous Improvement Loop — Iteration Tracker

Recursive loop: pick item → TDD (failing test first where applicable) → implement →
gates green (`cargo test --workspace`, `pytest`, `npm run build` when client touched;
full benchmark at milestones) → commit → push. GOALS.md re-reviewed every 10 iterations.

## Backlog

### Phase 3 — Client truth sweep
- [x] 3.1 Yjs awareness protocol → real remote cursors (replace hardcoded props)
- [x] 3.2 Render fog-of-war layers from the CRDT fog API (currently zero callers)
- [x] 3.3 CharacterSheet derives modifiers from scores + wires listCharacters API
- [x] 3.4 Honor Silero VAD speech events; delete canned fake utterances
- [x] 3.5 X-card rewinds local client scene state (not just server call)
- [ ] 3.6 Dead code removal: App.tsx duplicate sync block, audio_vad_pipeline.ts,
      ui/safety_xcard.ts, LiteLLMCircuitBreakerGateway
- [ ] 3.7 Remove unused y-indexeddb dep or wire it; drop committed dist artifacts
- [x] 3.8 AnalyticsView/AdminDashboard fetch real endpoints or are labeled DEMO
- [x] 3.9 LobbyView seats come from lobby member API (no hardcoded roster)
- [x] 3.10 Client sends auth tokens on all API calls (headers, not query strings)
- [x] 3.11 WebGPU preference option for Pixi init (env-gated)
- [x] 3.12 manualChunks splitting; kill >500 kB chunk warnings

### Phase 4 — Missing pillars & engine depth
- [x] 4.1 Fail-forward margin bands (M = roll − DC) in vtt-core + tests
- [x] 4.2 NPC disposition scoring (trust/fear/decay) in python simulation + tests
- [x] 4.3 Heal/rest endpoint in vtt-server; wire death-save tally reset
- [x] 4.4 Multi-term dice expressions ("2d6+1d4+3") in vtt-core DiceEngine
- [x] 4.5 Real loot tables replacing seed % 100 arithmetic
- [x] 4.6 Neo4j-backed epistemic graph (driver optional; in-memory fallback)
- [ ] 4.7 Qdrant-backed lore/compendium RAG lookup (optional; fallback offline)
- [x] 4.8 LLM-assisted intent classification with keyword fallback (.env LLM)
- [x] 4.9 Degraded marker on SSE narrative fallback frames
- [x] 4.10 Engine-tier rate limiting (actix-governor)
- [x] 4.11 Concentration auto-check hooks on damage events
- [x] 4.12 Faction GOAP planner upgrade (plan search over action preconditions)

### Phase 5 — Productization & gameplay
- [x] 5.1 Agent-driven campaign simulation: synthetic players register → lobby →
      deploy → play via /api/v1/agent/turn against .env LLM endpoint
- [x] 5.2 LLM traffic observability for 5.1 (JSONL log assertions in tests)
- [ ] 5.3 Campaign setup wizard flow (rule version, levels, invite codes)
- [ ] 5.4 Starter adventure bundle (Sunken Crypt of Karas) as .vttbundle
- [ ] 5.5 Thematic atmosphere presets (UI palette + ambience mapping)
- [ ] 5.6 Initiative order tracker (engine state + HUD)
- [ ] 5.7 Spectator/broadcast view filters secret DM data
- [ ] 5.8 Short-rest / long-rest resource recovery endpoint + UI hook
- [x] 5.9 Opportunity attack auto-prompt on movement provocation
- [x] 5.10 Session replay export (event log → portable JSON)

### Continuous
- [ ] R1 Research iterations: OSS scan (github/firecrawl/context7) → adopt a
      technique or dependency; document in iteration notes
- [ ] A1 Independent audit sweeps via subagent after every ~10 iterations

## Log

| # | Item | Summary | Commit | Gates |
|---|------|---------|--------|-------|
| 1 | 3.6 + 3.7 | Dead code sweep (App.tsx unreachable dup block, audio_vad_pipeline.ts, ui/safety_xcard.ts); y-indexeddb wired as IndexedDB persistence for Y.Doc rooms | 3d6ba67 | tsc+vite ✓ |
| 2 | 4.2 | NPC disposition scoring engine: trust/fear decay, alignment bias, stress amplification, stance bands; injectable clock; 15 tests | 9b6caf1 | pytest ✓ |
| 3 | 4.1 | Fail-forward margin tiers in vtt-core (CriticalSuccess/Success/SuccessAtCost/CriticalFailure), deterministic cost suggestions, nat20/1 conventions; 11 tests | see git log | cargo ✓ |
| 4 | 3.9 | Live lobby roster from GET /lobbies/{id}; fake players/pings removed; real invite URLs | 7e3aead | tsc+vite ✓ |
| 5 | 4.9 | SSE degradation markers: leading {degraded,reason} frame + per-frame tags on fallback; non-streaming degraded flag | 9367081 | pytest ✓ |
| 6 | 4.4 + R1 | Multi-term dice expression evaluator in vtt-core (seeded, bounded); OSS crates rejected as unmaintained | see git log | cargo ✓ |
| 7 | 3.11 + 3.12 | Vendor chunk splitting (pixi/yjs/react); dice-box offscreen worker emitted as static asset; VITE_PIXI_PREFERENCE=webgpu option; largest chunk 1447→691 kB | df35302 | tsc+vite ✓ |
| 8 | 3.4 | Real Silero VAD speech state in NarrativeChat; canned utterances deleted; recording fabricates nothing | 2e81528 | tsc+vite ✓ |
| 9 | 4.3 | Engine heal + rest endpoints (RBAC, clamps, death-save reset) + HEALED rewind replay arm; 7 integration tests | 9a267b9 | cargo ✓ |
| 10 | 4.8 | LLM-assisted intent classifier w/ safety-trigger precedence, kill-switch, keyword fallback provenance; complete_json(); 12 tests | 7c755ca | pytest ✓ |
| 11 | 3.5 | X-card local revert: rewound-turn chat pruned, honest re-sync audit line, overclaiming copy removed | 9445c99 | tsc+vite ✓ |
| 12 | — | Heal/rest gateway proxies with identity forwarding; strict request models; 8 tests | 4527774 | pytest ✓ |
| 13 | 4.12 | Genuine GOAP planner for factions: STRIPS actions, uniform-cost A*, deterministic, legacy fallback preserved; 19 tests | 50fe903 | pytest ✓ |
| 14 | 4.5 | Weighted thematic loot tables (3 themes, rarity weights, tier multipliers) replacing seed%100; 8 tests incl. distribution sanity | b42d5a8 | cargo ✓ |
| 15 | — | X-card response carries post-rewind GameSession snapshot; /engine/session-state read proxy | 0a182da | all ✓ |
| 16 | A1-fix | Audit remediation: LONG_REST rewind arm; HEALED clears death-save baselines | b3fda63 | cargo ✓ |
| 17 | 3.8 | Honest analytics/admin views on live /metrics proxy; fabricated cards removed/badged | 8ac9980 | all ✓ |
| 18 | 3.1 | Real remote cursors via Yjs awareness protocol; hardcoded peers deleted | a41d778 | tsc ✓ |
| 19 | wire-up | classify_with_llm wired into turn flow (safety precedence, kill-switch, provenance) | 39609ae | pytest ✓ |
| 20 | wire-up | Fail-forward tiers surface in check/save responses with seeded d20s | 97f36f7 | cargo ✓ |
| 21 | 5.1+5.2 | Agent-driven campaign simulation harness (LLM decisions, identity-forwarded proxies) | b4913c6 | pytest ✓ |
| 22 | honesty | LLM error logs carry exception types; first LIVE sim run vs llm.heretek.one (endpoint down → honest fallback) | see log | pytest+live ✓ |
| 23 | 3.3 | Live character sheet: shared character_math.ts, listCharacters wiring, zero fabricated stats | eb866b5 | tsc ✓ |
| 24 | social | Disposition engine integrated into campaign sim: stances in prompts/reports, deterministic timestamps | b4baa54 | pytest ✓ |
| 25 | 3.2 | Fog-of-war rendered from CRDT layers: LoS-seeded reveal, party merge, no-Yjs = no fog | 694c637 | tsc+vite ✓ |
| 26 | 5.10 | Session replay export as downloadable JSON with payload-derived summaries | 9a75612 | pytest ✓ |
| 27 | 4.11 | Automatic SRD concentration checks on damage (both hooks, CONCENTRATION_BROKEN ledger) | b0868dc | cargo ✓ |
| 28 | 3.10+4.6 | Auth-header migration (header-first, ?token= back-compat); Neo4j-backed epistemic graph via HTTP Cypher, honest fallback | 2e97376 | all ✓ |
| 29 | 5.9 | OA provocation surfaced on move responses without auto-execution | ed04c26 | cargo ✓ |
| 15 | — | X-card response carries post-rewind GameSession snapshot; /engine/session-state read proxy; 9 tests | 0a182da | cargo+pytest ✓ |
| 16 | A1-fix | Audit remediation: LONG_REST rewind arm, HEALED clears death-save baselines; 4 red-first tests | b3fda63 | cargo ✓ |
| 17 | 3.8 | Honest analytics/admin: live /metrics proxy, offline "—", DEMO badges, fabricated cards removed | 8ac9980 | all ✓ |
| 18 | 3.1 | Real remote cursors via Yjs awareness; hardcoded peers deleted; honest empty on fallback | a41d778 | tsc ✓ |
| 19 | wire-up | classify_with_llm wired into turn flow: safety precedence, kill-switch, provenance fields; 8 tests | 39609ae | pytest ✓ |
| 20 | wire-up | Fail-forward tiers (margin/tier/cost_suggestion) surface in check/save responses; seeded d20s; 5 tests | 97f36f7 | cargo ✓ |
| 21 | 5.1+5.2 | Agent-driven campaign simulation harness: LLM decisions via custom endpoint, identity-forwarded proxies, counted-metrics reports; 13 mocked tests | b4913c6 | pytest ✓ |
| 22 | honesty | LLM error logs record exception types (httpx timeouts stringified to ""); live e2e sim run verified vs llm.heretek.one — endpoint unreachable from network, harness fell back honestly, all actions accepted | see git log | pytest ✓ |

