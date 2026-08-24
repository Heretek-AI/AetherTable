# Autonomous Improvement Loop — Iteration Tracker

Recursive loop: pick item → TDD (failing test first where applicable) → implement →
gates green (`cargo test --workspace`, `pytest`, `npm run build` when client touched;
full benchmark at milestones) → commit → push. GOALS.md re-reviewed every 10 iterations.

## Backlog

### Phase 3 — Client truth sweep
- [ ] 3.1 Yjs awareness protocol → real remote cursors (replace hardcoded props)
- [ ] 3.2 Render fog-of-war layers from the CRDT fog API (currently zero callers)
- [ ] 3.3 CharacterSheet derives modifiers from scores + wires listCharacters API
- [ ] 3.4 Honor Silero VAD speech events; delete canned fake utterances
- [ ] 3.5 X-card rewinds local client scene state (not just server call)
- [ ] 3.6 Dead code removal: App.tsx duplicate sync block, audio_vad_pipeline.ts,
      ui/safety_xcard.ts, LiteLLMCircuitBreakerGateway
- [ ] 3.7 Remove unused y-indexeddb dep or wire it; drop committed dist artifacts
- [ ] 3.8 AnalyticsView/AdminDashboard fetch real endpoints or are labeled DEMO
- [ ] 3.9 LobbyView seats come from lobby member API (no hardcoded roster)
- [ ] 3.10 Client sends auth tokens on all API calls (headers, not query strings)
- [ ] 3.11 WebGPU preference option for Pixi init (env-gated)
- [ ] 3.12 manualChunks splitting; kill >500 kB chunk warnings

### Phase 4 — Missing pillars & engine depth
- [ ] 4.1 Fail-forward margin bands (M = roll − DC) in vtt-core + tests
- [ ] 4.2 NPC disposition scoring (trust/fear/decay) in python simulation + tests
- [ ] 4.3 Heal/rest endpoint in vtt-server; wire death-save tally reset
- [ ] 4.4 Multi-term dice expressions ("2d6+1d4+3") in vtt-core DiceEngine
- [ ] 4.5 Real loot tables replacing seed % 100 arithmetic
- [ ] 4.6 Neo4j-backed epistemic graph (driver optional; in-memory fallback)
- [ ] 4.7 Qdrant-backed lore/compendium RAG lookup (optional; fallback offline)
- [ ] 4.8 LLM-assisted intent classification with keyword fallback (.env LLM)
- [ ] 4.9 Degraded marker on SSE narrative fallback frames
- [ ] 4.10 Engine-tier rate limiting (actix-governor)
- [ ] 4.11 Concentration auto-check hooks on damage events
- [ ] 4.12 Faction GOAP planner upgrade (plan search over action preconditions)

### Phase 5 — Productization & gameplay
- [ ] 5.1 Agent-driven campaign simulation: synthetic players register → lobby →
      deploy → play via /api/v1/agent/turn against .env LLM endpoint
- [ ] 5.2 LLM traffic observability for 5.1 (JSONL log assertions in tests)
- [ ] 5.3 Campaign setup wizard flow (rule version, levels, invite codes)
- [ ] 5.4 Starter adventure bundle (Sunken Crypt of Karas) as .vttbundle
- [ ] 5.5 Thematic atmosphere presets (UI palette + ambience mapping)
- [ ] 5.6 Initiative order tracker (engine state + HUD)
- [ ] 5.7 Spectator/broadcast view filters secret DM data
- [ ] 5.8 Short-rest / long-rest resource recovery endpoint + UI hook
- [ ] 5.9 Opportunity attack auto-prompt on movement provocation
- [ ] 5.10 Session replay export (event log → portable JSON)

### Continuous
- [ ] R1 Research iterations: OSS scan (github/firecrawl/context7) → adopt a
      technique or dependency; document in iteration notes
- [ ] A1 Independent audit sweeps via subagent after every ~10 iterations

## Log

| # | Item | Summary | Commit | Gates |
|---|------|---------|--------|-------|
| 1 | 3.6 + 3.7 | Dead code sweep (App.tsx unreachable dup block, audio_vad_pipeline.ts, ui/safety_xcard.ts); y-indexeddb wired as IndexedDB persistence for Y.Doc rooms | tbd | tsc+vite ✓ |

