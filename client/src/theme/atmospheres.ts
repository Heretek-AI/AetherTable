/**
 * Dynamic Thematic Atmosphere presets (GOALS.md Pillar 2).
 *
 * Each preset is pure data: a map of CSS custom-property overrides written onto
 * `:root` (the same obsidian/parchment semantic tokens declared in index.css),
 * plus an encounter-styling hint exposed as its own custom properties, plus an
 * OPTIONAL ambience binding.
 *
 * AUDIO HONESTY RULE: `ambienceTrackId` may ONLY reference track ids that
 * actually exist in the soundscape engine (`AudioManager.AMBIENCE_RECIPES` in
 * render/audio_manager.ts, surfaced in SoundscapeJukeboxModal.tsx). The known
 * set today is exactly: 'tavern' | 'storm' | 'crypt' | 'boss'. If a preset has
 * no honest match we OMIT the binding entirely — we never invent a track id,
 * and we never auto-start audio here (the Jukebox owns play/pause).
 *
 * SYNC: the selected atmosphere travels through the SAME Yjs CRDT relay as
 * tokens and fog layers — a top-level `atmosphere` Y.Map entry carrying
 * {id, set_by, ts} (see sync/yjs_doc_client.ts getAtmosphereId/setAtmosphereId/
 * observeAtmosphereId). No protocol change was needed: arbitrary maps already
 * ride ysync. App.tsx holds DUAL-source truth — it adopts whatever the room map
 * says (live, and on join) and falls back to this browser's localStorage when
 * the room has no entry yet (first-ever session / relay unreachable). Policy is
 * enforced purely client-side: the transport accepts writes from any role, but
 * only the GM/admin Navbar UI ever calls the setter. Concurrent GM selections
 * converge via Y.Map's built-in resolution (see yjs_doc_client.ts).
 */

/** Track ids that really exist in AudioManager.AMBIENCE_RECIPES today. */
export const REAL_AMBIENCE_TRACK_IDS = ['tavern', 'storm', 'crypt', 'boss'] as const;

export type AmbienceTrackId = (typeof REAL_AMBIENCE_TRACK_IDS)[number];

export interface EncounterStylingHint {
  /** Selected-token ring color on the tactical canvas. */
  tokenRingColor: string;
  /** Flash color for critical hits / dramatic moments. */
  criticalFlashColor: string;
}

export interface AtmospherePreset {
  id: string;
  name: string;
  description: string;
  /**
   * CSS custom properties applied to :root while this preset is active.
   * Keys MUST be variables already declared in index.css (semantic tokens),
   * so every component consuming them retints with zero component changes.
   */
  cssProperties: Record<string, string>;
  encounter: EncounterStylingHint;
  /** Existing jukebox track id, when one honestly matches. Omitted otherwise. */
  ambienceTrackId?: AmbienceTrackId;
}

/** Sentinel id meaning "no preset" — stock obsidian/parchment palette. */
export const DEFAULT_ATMOSPHERE_ID = 'default';

/** localStorage key for the locally-persisted selection. */
export const ATMOSPHERE_STORAGE_KEY = 'aethertable.atmosphere';

/**
 * Shape of the shared room-wide selection stored in the Yjs doc's top-level
 * `atmosphere` Y.Map (under the fixed key 'current'). `ts` is an informational
 * wall-clock stamp for debugging/UI; it does NOT drive conflict resolution —
 * Yjs merges concurrent writes by its own causal ordering (see the comment on
 * YjsCrdtClient.setAtmosphereId in sync/yjs_doc_client.ts).
 */
export interface AtmosphereSelection {
  /** Preset id or DEFAULT_ATMOSPHERE_ID. */
  id: string;
  /** Auth user id of whoever last published the selection. */
  set_by: string;
  /** Wall-clock ms when that client wrote the entry. */
  ts: number;
}

/**
 * Coerce any raw value (localStorage junk, a Y.Map entry from an older/other
 * build, tampered data) into a known preset id, defaulting to the stock palette.
 */
export function normalizeAtmosphereId(raw: unknown): string {
  return typeof raw === 'string' && getAtmosphere(raw) ? raw : DEFAULT_ATMOSPHERE_ID;
}

export const ATMOSPHERE_PRESETS: AtmospherePreset[] = [
  {
    id: 'gothic-horror',
    name: 'Gothic Horror',
    description: 'Blood-dark iron, bone parchment, candlelight drowned in shadow.',
    cssProperties: {
      '--tavern-bg': '#171114',
      '--tavern-surface': '#241a1e',
      '--tavern-border': '#4a3138',
      // Blood-crimson replaces gold leaf as the highlight (dark-chrome safe).
      '--tavern-accent': '#c81e45',
      '--tavern-accent-deep': '#8f1230',
      '--parchment-paper': '#e7dfd0',
      '--parchment-paper-aged': '#d8ccb6',
      '--statblock-header': '#7f1d33',
    },
    encounter: {
      tokenRingColor: '#e11d48',
      criticalFlashColor: '#fb7185',
    },
    // Honest match: the storm/downpour loop is the closest existing soundscape
    // to a gothic moor night. No dedicated gothic track exists yet.
    ambienceTrackId: 'storm',
  },
  {
    id: 'high-fantasy',
    name: 'High Fantasy',
    description: 'Warm gilded halls, sunlit vellum, triumphant heraldic gold.',
    cssProperties: {
      '--tavern-bg': '#201a10',
      '--tavern-surface': '#302715',
      '--tavern-border': '#5f4c26',
      // Brighter hero-gold than the stock amber accent.
      '--tavern-accent': '#e6b23c',
      '--tavern-accent-deep': '#b98217',
      '--parchment-paper': '#faf3e2',
      '--parchment-paper-aged': '#efe2c6',
      '--statblock-header': '#8a5a0b',
    },
    encounter: {
      tokenRingColor: '#e6b23c',
      criticalFlashColor: '#fcd34d',
    },
    // NO ambience binding: the jukebox offers hearth/tavern, rain, crypt and
    // boss-drone loops — none of them is a heroic/adventure soundscape, so we
    // omit rather than stretch a mismatched track onto this preset.
  },
  {
    id: 'eldritch-mystery',
    name: 'Eldritch Mystery',
    description: 'Void-blue chrome, sea-green sigils, parchment gone faintly brine-touched.',
    cssProperties: {
      '--tavern-bg': '#0f151d',
      '--tavern-surface': '#182130',
      '--tavern-border': '#2c4058',
      // Sickly arcane teal replaces gold leaf.
      '--tavern-accent': '#2fc9a4',
      '--tavern-accent-deep': '#1c8f74',
      '--parchment-paper': '#e3e9de',
      '--parchment-paper-aged': '#d2dccf',
      '--statblock-header': '#14584a',
    },
    encounter: {
      tokenRingColor: '#22d3ee',
      criticalFlashColor: '#a3e635',
    },
    // Honest match: 'crypt' explicitly layers chilling eldritch whispers.
    ambienceTrackId: 'crypt',
  },
];

/** Look up a preset by id; returns undefined for the default/unknown ids. */
export function getAtmosphere(id: string | null | undefined): AtmospherePreset | undefined {
  return ATMOSPHERE_PRESETS.find((p) => p.id === id);
}

/** True when the id references a track that actually exists in the engine. */
export function isRealAmbienceTrack(id: string): id is AmbienceTrackId {
  return (REAL_AMBIENCE_TRACK_IDS as readonly string[]).includes(id);
}

/**
 * Serialize a preset into a `:root { … }` rule. Encounter-styling hint values
 * are published as first-class custom properties so future consumers (canvas
 * rings, crit flashes) can adopt them without touching this module again.
 */
export function atmosphereCss(preset: AtmospherePreset): string {
  const decls = Object.entries(preset.cssProperties)
    .map(([prop, value]) => `  ${prop}: ${value};`)
    .join('\n');
  return [
    `:root {`,
    decls,
    `  --encounter-token-ring: ${preset.encounter.tokenRingColor};`,
    `  --encounter-crit-flash: ${preset.encounter.criticalFlashColor};`,
    `}`,
  ].join('\n');
}

/**
 * Apply (or clear) an atmosphere on the live document.
 *
 * A preset injects ONE `<style id=…>` element overriding the semantic tokens;
 * the default id removes it so index.css values win again untouched. Safe to
 * call repeatedly — the element is reused, not stacked.
 */
export function applyAtmosphereToDocument(id: string): void {
  if (typeof document === 'undefined') return;
  const STYLE_ID = 'vtt-atmosphere-overrides';
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

  if (id === DEFAULT_ATMOSPHERE_ID) {
    el?.remove();
    return;
  }

  const preset = getAtmosphere(id);
  if (!preset) {
    // Unknown stored id (removed preset, tampered storage): fall back cleanly.
    el?.remove();
    return;
  }

  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = atmosphereCss(preset);
}

/** Read the persisted selection, tolerating missing storage or junk values. */
export function loadStoredAtmosphereId(): string {
  try {
    const raw = localStorage.getItem(ATMOSPHERE_STORAGE_KEY);
    if (!raw || raw === DEFAULT_ATMOSPHERE_ID) return DEFAULT_ATMOSPHERE_ID;
    return getAtmosphere(raw) ? raw : DEFAULT_ATMOSPHERE_ID;
  } catch {
    // Private-mode browsers can throw on localStorage access; stock palette.
    return DEFAULT_ATMOSPHERE_ID;
  }
}

/** Persist the selection; default clears the key instead of storing a sentinel. */
export function storeAtmosphereId(id: string): void {
  try {
    if (id === DEFAULT_ATMOSPHERE_ID) {
      localStorage.removeItem(ATMOSPHERE_STORAGE_KEY);
    } else {
      localStorage.setItem(ATMOSPHERE_STORAGE_KEY, id);
    }
  } catch {
    /* storage unavailable — selection stays session-only */
  }
}
