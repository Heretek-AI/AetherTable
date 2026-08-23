# Improvement Log — Recursive Optimization Cycles

A running record of self-directed improvement passes over the VTT platform.
Each cycle: **assess → research → implement → verify → document**.

---

## Cycle 1 — 2026-08-23

### Baseline assessment
| Suite | Result |
|---|---|
| `cargo test --workspace` | ✅ all green |
| `pytest python/tests` | ❌ 6 modules failing to collect (missing `reportlab`; `pytest-asyncio` absent for py3.15) |
| `npm run build` | ⚠️ builds in ~1.0 s but ships a single ~1.9 MB JS chunk (all 33 views + 12 modals eagerly imported) |
| Lighthouse (landing) | A11y 97 · Best Practices 100 · SEO 82 |

### Fixes & improvements

1. **Python dependency declarations** (`python/pyproject.toml`)
   - `reportlab` was imported by `vtt_orchestrator/pdf/character_sheet_renderer.py` but
     never declared — 6 test modules failed collection on a fresh env. Added
     `reportlab>=4.0.0`. (Also installed `pytest-asyncio` locally; it was already declared.)

2. **Route-level code splitting** (`client/src/App.tsx`)
   - Converted 30 components (11 secondary views + tabletop cluster + 12 modals) to
     `React.lazy` with two `Suspense` boundaries: a themed `ChunkFallback` for views and
     `fallback={null}` for modals so an open-modal chunk load never blanks the page.
   - Modals are now gated with `{isOpen && …}` so their chunks download only on first open.
   - **Result:** entry chunk 1.9 MB → **241 kB** (72 kB gzip); largest view chunk 30 kB.
     Removed the Vite >500 kB chunk warning.

3. **Dice Roll History panel** (new: `client/src/components/DiceHistoryPanel.tsx`)
   - Session audit log of every resolved roll (attack / spell / check / macro) with
     formula, natural d20, total, timestamp. Natural 20/1 get crit/fumble highlighting
     that overrides outcome colouring.
   - Wired into all four roll handlers in `App.tsx`; capped at 50 entries and persisted
     to `localStorage` (`vtt_roll_history_v1`) so a refresh keeps the table's history.
   - Rendered as `role="log"` live region floating in the canvas's free corner.

4. **Accessibility foundation** (`client/src/index.css`, `NarrativeChat`, `TacticalCanvas`)
   - Global `:focus-visible` amber outline (most custom controls previously had no
     visible keyboard focus indicator).
   - `prefers-reduced-motion: reduce` kills decorative animation for vestibular safety.
   - `.selectable-text` utility to opt prose out of the global `user-select: none`
     (players can now copy narrative/chat text); applied to chat messages.
   - `aria-label`s on all icon-only canvas controls (zoom, AoE templates); zoom readout
     is `aria-live="polite"`.

5. **SEO / crawler surface** (`client/index.html`, `client/public/`)
   - Added meta description; new `robots.txt` (public landing, disallow `/api`+`/ws`)
     and `llms.txt` agent-facing summary.
   - Landing page root is now a `<main>` landmark.

### Verification
- `cargo test --workspace` ✅ · `pytest` **57 passed / 1 skipped** ✅ · `npm run build` ✅ (~1.0 s)
- Chrome DevTools smoke test: entered tabletop, rolled Initiative macro → history panel
  updated 0→1, entry rendered, zero console errors.
- Lighthouse after fixes: **A11y 100 · Best Practices 100 · SEO 100**.

### Ideas parked for future cycles
- Fog-of-war reveal state synced through the CRDT layer (walls/LoS already exist client-side).
- Undo/redo stack for token moves (CRDT LWW makes inverse ops straightforward).
- ~~Keyboard shortcut cheat-sheet overlay~~ → done in Cycle 2.
- Sitemap.xml generation for the marketing pages.

---

## Cycle 2 — 2026-08-23

### Keyboard shortcuts + discoverability
- **New `ShortcutsModal`** (`client/src/components/ShortcutsModal.tsx`, lazy chunk):
  grouped cheat-sheet with `kbd` chips, `role="dialog"` + `aria-modal`, backdrop-click
  to dismiss.
- **Global key handling** (`App.tsx` effect):
  - `?` (when not typing in an input/textarea/contenteditable) toggles the cheat-sheet.
  - `Escape` closes the top-most open modal via a fixed stacking-priority list
    (previously only the command palette handled its own Escape).
  - Typing guard so chat/search/form fields are never hijacked.
- **Command palette integration**: new "Help → Keyboard Shortcuts" entry via an
  optional `onOpenShortcuts` prop.

### A11y / DevTools issue cleanup
- The two unlabeled form fields flagged by Chrome DevTools (macro custom-formula
  input, narrative chat input) now have `id`/`name`/`aria-label`. Verified 0
  unlabeled fields remain in the live DOM.
- `llms.txt` restructured to the recommendation format (H1 + blockquote + link
  sections) — Lighthouse had flagged "contains no links".

### Verification
- `npm run build` ✅ (~1–2 s) · browser: `?` opens cheat-sheet, `Esc` closes,
  DevTools form-field issue count → 0, zero console errors.
- Full gate re-run: cargo ✅, pytest 57/1 skipped ✅, benchmark MCR 100% / HCI 1.0 ✅.

---

## Cycle 3 — 2026-08-23 · UI edge-case audit (clutter / overlaps / sounds / zoom)

Method: Chrome DevTools sweep at 1920/1600/1440/1366/1280/1024/900/768/390 px,
DOM-level overflow detection (excluding intentionally-clipped pan surfaces),
screenshot review of landing + tabletop, and an audio call-site audit.

### Findings & fixes

1. **Navbar clipped the X-CARD safety button** — at 1366×768 the header ran
   32 px past the viewport (`right: 1382 > 1366`), cutting off the emergency
   X-Card. Worst possible element to lose.
   - Secondary nav labels (Compendium/Characters/Marketplace/GM Studio) are
     icon-only below `xl`; Sync telemetry chip and "Table Tools" label show
     only at `2xl`. Header now fits 900 px → 1920 px with zero overflow
     (verified per-width in the live DOM).

2. **Canvas tool rail ran under the character-sheet dock** — the elevation
   stepper was silently clipped on ≤1440 px screens. Tool rail now
   `flex-wrap` + `max-w-[calc(100%-2rem)]`, so tools wrap to a second row
   inside the canvas instead of disappearing.

3. **Macro quickbar occluded ~80 % of the chat console** — the quickbar
   (133 px, absolutely centred) floats entirely inside the fixed `h-60` chat,
   hiding the newest messages. First attempt (scroll padding) backfired:
   auto-scroll-to-bottom landed in the padding and showed nothing. Final fix:
   quickbar defaults to **collapsed** (slim labelled header, one click to
   expand); padding hack reverted.

4. **Annoying-sound pass** — the combat "turn advance" chime was wired to pure
   UI actions, training users to ignore the cue that matters:
   - Compendium pagination: chime removed (silent browsing).
   - Video mesh peer mic toggle: chime removed.
   - Lobby seat selection: chime removed.
   Gameplay sounds (rolls, impacts, turn advance, campaign launch) unchanged.

### Verification
- Overflow sweep: **0 visible overflows** at 1920/1440/1366/1280/1024 (tabletop)
  and 768/390 (landing); the only flagged elements are the intentionally
  clipped pannable map grid.
- Screenshots before/after confirm: X-CARD visible, elevation stepper visible,
  chat messages readable at 1366×768.
- Full gate: cargo ✅ · pytest 57/1 ✅ · benchmark MCR 100 % / HCI 1.0 ✅ ·
  `npm run build` ✅.

---

## Cycle 4 — 2026-08-23 · Modal audit (short viewports) + focus management + honest audio

### Findings & fixes

1. **Jukebox claimed "PLAYING NOW" but played nothing** — `isPlaying` was pure
   UI state; the volume sliders were decorative. Same dishonesty class the
   wave11 pass fixed for voice activity.
   - **New ambient engine** in `audio_manager.ts`: `startAmbience` /
     `stopAmbience` / `setAmbienceVolume` synthesize per-preset loops from one
     shared pink-noise buffer (per-track biquad filter + optional drone
     oscillator): tavern hearth-crackle, storm rain-hiss, crypt whisper+drone,
     boss rumble+drone. CPU cost negligible, respects the global mute.
   - Modal now starts **paused** (opening it no longer claims playback), play/
     pause drives the engine, preset switching re-seeds the loop, and the
     master slider is a live `setTargetAtTime` update (no zipper noise).

2. **Modals never moved focus on open** — keyboard users tabbed from the
   trigger straight into the page behind the dialog.
   - All 12 modal close buttons now `aria-label="Close modal"` +
     `autoFocus`, so focus enters the dialog on open and Enter/Escape work
     immediately. X icons marked `aria-hidden`.

3. **Short-viewport fit check (1366×640)** — jukebox modal fits (52→588 of
   640 px) with internal `overflow-y-auto`; no clipping found. Escape closes;
   verified 0 overlays remain after close.

### Verification
- Browser: jukebox opens "PAUSED" → play → "PLAYING NOW" backed by a running
  WebAudio loop (zero console errors); focus lands on the dialog's close
  button; Escape dismisses.
- Full gate: cargo ✅ · pytest 57/1 ✅ · benchmarks MCR 100 % / HCI 1.0 ✅ ·
  build ✅.

---

## Cycle 5 — 2026-08-23 · Rustic Tavern & Parchment identity + audio engineering

Skill routing: installed the `ui-ux-pro-max` design-system skill (21K installs)
and adopted its **three-layer token architecture** (primitive → semantic →
component, CSS variables, no raw hex in components).

### Design tokens (`client/src/index.css`)
- **Primitives**: full rustic palette — parchment 100/200/300, iron 800/900,
  leather 600/700, amber 500/600, crimson/forest state colors, ink 900.
- **Semantics**: `--tavern-*` (dark chrome), `--parchment-*` (in-world paper),
  `--state-*`; a future light "parchment day mode" is a token swap.
- **Components**: `.vtt-engraved` (Cinzel + gold-leaf gradient clip),
  `.vtt-parchment` (aged paper gradients, iron frame, double bevel, candlelight
  edge burn, EB Garamond prose), vintage bronze scrollbars (replacing slate).
- **Design interpretation**: the app keeps its dark-tavern chrome (iron/leather/
  amber); parchment is the *paper* of in-world documents — the classic D&D-book
  pairing of dark binding + warm pages.

### Typography
- **Cinzel** (display) + **EB Garamond** (prose) via Google Fonts — both SIL
  OFL 1.1, recorded in `compendium/ATTRIBUTION.md` alongside the existing SRD
  CC-BY-4.0 attribution and the lucide-react ISC license.
- Applied: navbar brand (engraved gold wordmark), handout document frame
  (full parchment treatment, tokenized ink color).

### Audio engineering (`client/src/render/audio_manager.ts`)
- **SFX debouncing**: per-cue 60 ms throttle (`shouldPlay`) on dice/impact/
  spell/turn cues — rapid-fire triggers (area attacks, macro bursts) no longer
  stack into a harsh click wall; extras are dropped, not queued.

### Verification
- Browser: brand renders in Cinzel w/ background-clip (verified computed
  style); handout parchment shows aged paper + bevel + serif prose (screenshot).
- Full gate: cargo ✅ · pytest 57/1 ✅ · benchmarks MCR 100 % / HCI 1.0 ✅ ·
  `npm run build` ✅.

### Rolled forward
- `.vtt-engraved` rollout to all 12+ modal headers; parchment treatment for
  quest journal entries; 320 px–4K + 50–200 % zoom sweep; WCAG AA contrast
  audit of token pairs; CC0 token/tile asset ingestion.





---

## Cycle 6 — 2026-08-23 · Modal resilience, z-index ladder & first-class concentration

### Shared dialog infrastructure (`client/src/components/ui/`)
- **`ModalShell.tsx`** — single ARIA-dialog implementation: `role="dialog"` +
  `aria-modal` + labelled title, ESC dismiss, focus trap with restore-to-trigger,
  scroll lock, backdrop mousedown-close (drag-out safe), tavern/parchment tones,
  size presets, `nested` rung for sheets-over-sheets, optional footer slot.
- **`useFocusTrap.ts`** — save/restore `document.activeElement`, initial-focus
  resolution, Tab cycling scoped to the container subtree (safe under nesting:
  per-instance capture listeners, topmost trap wins), Escape with
  `stopPropagation` so one keypress can't dismiss two layers.
- Migrated **13 sheets** onto ModalShell (Spellbook, UserSettings, HandoutManager
  tone="parchment", MapLayerEditor, CampaignSave, Subscription, Auth, AudioMixer,
  SoundscapeJukebox, QuestJournal, Safety, Shortcuts(nested)) + wired the trap
  hook into the two bespoke overlays that resisted restructuring (StreamerHUD,
  CompendiumView statblock → extracted as `StatblockOverlay`, nested rung).
- CommandPalette keeps its custom keyboard shell but moved to the command rung.

### Z-index ladder (`--z-*` tokens in index.css)
Single stacking truth: `tokens(10) < fx(20) < chrome(30) < popover(40) <
toast(50) < modal(60) < modal-nested(70) < command(80)` — no raw `z-50`
anywhere. Fixed collisions: canvas error banner (was z-50 = modal plane), navbar
dropdowns (were z-50 over modal backdrops; now popover above chrome header),
FX canvas (was z-40 = popover plane), MacroQuickbar/tool rail/DiceHistoryPanel
(chrome rung).

### Rustic rollout
- Navbar fully converted off slate/violet → tavern tokens (also fixes dead
  `hover:bg-slate-850` classes — not a real Tailwind color, silently no-op).
- InitiativeTracker & MacroQuickbar: purple accents → amber/leather; engraved
  headers; HP bar track tokenized. `.vtt-glass-panel` / `.vtt-card-elevated` /
  `.vtt-glow-border` restyled slate→iron+leather+amber (app-wide effect).
- Fonts moved from render-blocking CSS `@import` to preconnect+stylesheet in
  `index.html`; duplicate `--font-display` block removed.

### Audio engineering (`client/src/render/`)
- `spatial_audio.ts`: pan `clamp(dx/8)` → `tanh(dx/6)` smooth saturation (no
  hard L/R snap at 8 ft); 4–10 ms linear attack ramps on all four cues kill the
  full-amplitude onset click; invariant comment added in `audio_manager.ts`
  requiring every new one-shot SFX to gate on `shouldPlay()`.

### Rules engine (`crates/vtt-core`)
- **Concentration** now first-class: `ConcentrationState` on `EntityState`
  (`#[serde(default)]` — legacy persisted sessions still deserialize);
  `begin_concentration` (SRD replacement rule), `end_concentration`,
  `apply_damage_to_concentration` delegating DC math to the existing
  `ActionResolver::resolve_concentration_check` (single source of truth).
- **Edge aggregation**: `RulesEvaluator::edge_from_conditions` derives
  (advantage, disadvantage) from condition flags + high ground; cancellation
  stays in `resolve_attack` (both flags ⇒ straight d20, per SRD).
- Tests: concentration state machine (replacement/floor/break/maintain/voluntary),
  edge cancellation matrix incl. seeded-dice straight-roll proof, serde
  round-trip with legacy payloads. vtt-core integration tests 8 → 11.

### Housekeeping
- Removed unused `pixi.js`, `three`, `@types/three` deps and dead
  `pixijs_canvas.ts` / `webgpu_spatial_canvas.ts` (zero imports).
- Preserved root scratch transcript as `docs/traces-antigravity-roadmap.txt`.

### Verification
- Full gate: cargo test --workspace ✅ · pytest 57/1 ✅ · benchmarks MCR 100 % /
  HCI 1.0 / AFPR 0 % ✅ · `npm run build` zero TS diagnostics ✅.
- Grep-audited: zero raw `fixed inset-0` outside ModalShell/CommandPalette;
  zero raw z-classes on migrated surfaces.

### Rolled forward
- CompendiumView / CharacterSheet / EncounterBuilderView rustic conversion;
  StreamerHUDModal full ModalShell migration; parchment quest-journal entries;
  320 px–4K + 50–200 % zoom sweep; WCAG AA audit of remaining token pairs;
  CC0 token/tile asset ingestion; vtt-server test coverage.
