/**
 * Unit tests for src/theme/atmospheres.ts — the pure data + normalization half
 * of the dynamic-atmosphere system. DOM-writing helpers
 * (applyAtmosphereToDocument, loadStoredAtmosphereId, storeAtmosphereId) are
 * host-environment code and are NOT exercised here; normalizeAtmosphereId,
 * atmosphereCss and the preset invariants are.
 */
import { describe, expect, it } from 'vitest';
import { AudioManager } from '../../render/audio_manager';
import {
  applyAtmosphereToDocument,
  ATMOSPHERE_PRESETS,
  atmosphereCss,
  DEFAULT_ATMOSPHERE_ID,
  getAtmosphere,
  isRealAmbienceTrack,
  normalizeAtmosphereId,
  REAL_AMBIENCE_TRACK_IDS,
} from '../atmospheres';

/**
 * Source of truth: the track ids the soundscape engine can actually
 * synthesize. AMBIENCE_RECIPES is private (an implementation detail of the
 * engine), so the test reads it through a structural cast — the point is that
 * the KNOWN-TRACKS list shipped by atmospheres.ts is validated against the
 * engine here instead of being trusted as an independent copy.
 */
const ENGINE_AMBIENCE_TRACK_IDS = Object.keys(
  (
    AudioManager as unknown as {
      AMBIENCE_RECIPES: Record<string, unknown>;
    }
  ).AMBIENCE_RECIPES,
).sort();

describe('normalizeAtmosphereId — junk handling', () => {
  it('passes through every shipped preset id', () => {
    for (const preset of ATMOSPHERE_PRESETS) {
      expect(normalizeAtmosphereId(preset.id)).toBe(preset.id);
    }
  });

  it('collapses unknown ids to the default sentinel', () => {
    expect(normalizeAtmosphereId('gothic-horror-typo')).toBe(DEFAULT_ATMOSPHERE_ID);
    expect(normalizeAtmosphereId('Gothic Horror')).toBe(DEFAULT_ATMOSPHERE_ID); // display name, not id
    expect(normalizeAtmosphereId('')).toBe(DEFAULT_ATMOSPHERE_ID);
  });

  it('treats non-string junk (numbers, objects, null, undefined) as default', () => {
    expect(normalizeAtmosphereId(42)).toBe(DEFAULT_ATMOSPHERE_ID);
    expect(normalizeAtmosphereId(null)).toBe(DEFAULT_ATMOSPHERE_ID);
    expect(normalizeAtmosphereId(undefined)).toBe(DEFAULT_ATMOSPHERE_ID);
    expect(normalizeAtmosphereId({ id: 'gothic-horror' })).toBe(DEFAULT_ATMOSPHERE_ID);
    expect(normalizeAtmosphereId(['gothic-horror'])).toBe(DEFAULT_ATMOSPHERE_ID);
    expect(normalizeAtmosphereId(true)).toBe(DEFAULT_ATMOSPHERE_ID);
  });

  it('is case-sensitive: tampered storage cannot alias onto a real preset', () => {
    expect(normalizeAtmosphereId('ELDRITCH-MYSTERY')).toBe(DEFAULT_ATMOSPHERE_ID);
  });
});

describe('preset data integrity', () => {
  it('ships unique ids and never uses the default sentinel as a preset id', () => {
    const ids = ATMOSPHERE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(DEFAULT_ATMOSPHERE_ID);
  });

  it('every cssProperties key is a CSS custom property (starts with --)', () => {
    for (const preset of ATMOSPHERE_PRESETS) {
      for (const key of Object.keys(preset.cssProperties)) {
        expect(key.startsWith('--')).toBe(true);
      }
    }
  });

  it('REAL_AMBIENCE_TRACK_IDS stays in lockstep with AudioManager.AMBIENCE_RECIPES', () => {
    // Drift guard: atmospheres.ts carries a COPY of the engine's track ids.
    // If the engine gains or loses a recipe without this list following, the
    // honesty rule silently degrades — so the copy is checked against the
    // engine's own (private) recipe table, not against itself.
    expect([...REAL_AMBIENCE_TRACK_IDS].sort()).toEqual(ENGINE_AMBIENCE_TRACK_IDS);
  });

  it('ambience bindings reference only track ids that exist in the engine', () => {
    // The audio-honesty rule: no invented track ids, ever. The membership
    // check runs against the ENGINE's recipe keys; isRealAmbienceTrack is the
    // runtime guard production code relies on and is asserted to agree.
    for (const preset of ATMOSPHERE_PRESETS) {
      if (preset.ambienceTrackId !== undefined) {
        expect(ENGINE_AMBIENCE_TRACK_IDS).toContain(preset.ambienceTrackId);
        expect(isRealAmbienceTrack(preset.ambienceTrackId)).toBe(true);
        expect(REAL_AMBIENCE_TRACK_IDS).toContain(preset.ambienceTrackId);
      }
    }
  });

  it('omits the ambience binding rather than stretching a mismatched track', () => {
    const highFantasy = getAtmosphere('high-fantasy');
    expect(highFantasy).toBeDefined();
    expect(highFantasy!.ambienceTrackId).toBeUndefined();
  });

  it('getAtmosphere is a plain id lookup that misses on unknown/default ids', () => {
    expect(getAtmosphere('eldritch-mystery')?.name).toBe('Eldritch Mystery');
    expect(getAtmosphere('nope')).toBeUndefined();
    expect(getAtmosphere(null)).toBeUndefined();
    expect(getAtmosphere(undefined)).toBeUndefined();
    // The sentinel itself has no preset — it means "stock palette".
    expect(getAtmosphere(DEFAULT_ATMOSPHERE_ID)).toBeUndefined();
  });
});

describe('atmosphereCss serialization', () => {
  it('emits one :root rule with every custom property plus the encounter hints', () => {
    const css = atmosphereCss(ATMOSPHERE_PRESETS[0]);
    expect(css).toContain(':root {');
    for (const [prop, value] of Object.entries(ATMOSPHERE_PRESETS[0].cssProperties)) {
      expect(css).toContain(`  ${prop}: ${value};`);
    }
    expect(css).toContain(`  --encounter-token-ring: ${ATMOSPHERE_PRESETS[0].encounter.tokenRingColor};`);
    expect(css).toContain(
      `  --encounter-crit-flash: ${ATMOSPHERE_PRESETS[0].encounter.criticalFlashColor};`
    );
    expect(css.endsWith('}')).toBe(true);
  });

  it('is deterministic for repeated calls (safe to re-apply to the style element)', () => {
    const a = atmosphereCss(ATMOSPHERE_PRESETS[1]);
    const b = atmosphereCss(ATMOSPHERE_PRESETS[1]);
    expect(a).toBe(b);
  });

  it('never leaks one preset values into another', () => {
    const gothic = atmosphereCss(getAtmosphere('gothic-horror')!);
    const eldritch = atmosphereCss(getAtmosphere('eldritch-mystery')!);
    expect(gothic).not.toContain(getAtmosphere('eldritch-mystery')!.cssProperties['--tavern-accent']);
    expect(eldritch).not.toContain(getAtmosphere('gothic-horror')!.cssProperties['--tavern-accent']);
  });
});

describe('DOM helpers stay safe outside a browser', () => {
  it('applyAtmosphereToDocument is a no-op without a document (node env)', () => {
    // In the node test environment `document` is undefined; the guard must
    // return silently instead of throwing into callers.
    expect(() => applyAtmosphereToDocument('gothic-horror')).not.toThrow();
    expect(() => applyAtmosphereToDocument(DEFAULT_ATMOSPHERE_ID)).not.toThrow();
    expect(() => applyAtmosphereToDocument('junk-id')).not.toThrow();
  });
});
