/**
 * Unit tests for theme/board_atmosphere.ts — the per-atmosphere backdrop
 * parameters behind the iteration-9 board visual pass. The CSS itself
 * (.vtt-board-backdrop in index.css) is presentation and is covered by the
 * build + existing suites; what is testable here is the pure mapping:
 * stock fallbacks, preset reuse of encounter.tokenRingColor, clamping, and
 * the serialized custom-property shape.
 */
import { describe, expect, it } from 'vitest';
import {
  boardBackdropStyle,
  boardBackdropTheme,
} from '../board_atmosphere';
import { ATMOSPHERE_PRESETS, DEFAULT_ATMOSPHERE_ID } from '../atmospheres';

describe('boardBackdropTheme — stock fallback', () => {
  it('uses token references (not raw hex) for the default atmosphere', () => {
    const t = boardBackdropTheme(DEFAULT_ATMOSPHERE_ID);
    expect(t.glowColor).toBe('var(--tavern-accent)');
  });

  it('falls back to stock for undefined, null, empty and junk ids', () => {
    const stock = boardBackdropTheme(DEFAULT_ATMOSPHERE_ID);
    for (const id of [undefined, null, '', 'not-a-preset', 'Gothic Horror', 42 as unknown as string]) {
      expect(boardBackdropTheme(id)).toEqual(stock);
    }
  });
});

describe('boardBackdropTheme — preset resolution', () => {
  it('reuses each preset\'s own encounter.tokenRingColor as the glow color', () => {
    // Single source of truth: no palette is duplicated here. If atmospheres.ts
    // retints a preset, the board wash follows by construction.
    for (const preset of ATMOSPHERE_PRESETS) {
      expect(boardBackdropTheme(preset.id).glowColor).toBe(preset.encounter.tokenRingColor);
    }
  });

  it('every shipped preset resolves to a distinct intensity profile', () => {
    const profiles = ATMOSPHERE_PRESETS.map((p) => {
      const t = boardBackdropTheme(p.id);
      return `${t.vignetteStrength}:${t.glowStrength}:${t.grainOpacity}`;
    });
    expect(new Set(profiles).size).toBe(ATMOSPHERE_PRESETS.length);
  });

  it('all resolved strengths are within [0,1]', () => {
    const all = [DEFAULT_ATMOSPHERE_ID, ...ATMOSPHERE_PRESETS.map((p) => p.id)];
    for (const id of all) {
      const t = boardBackdropTheme(id);
      expect(t.glowStrength).toBeGreaterThanOrEqual(0);
      expect(t.glowStrength).toBeLessThanOrEqual(1);
      expect(t.vignetteStrength).toBeGreaterThanOrEqual(0);
      expect(t.vignetteStrength).toBeLessThanOrEqual(1);
      expect(t.grainOpacity).toBeGreaterThanOrEqual(0);
      expect(t.grainOpacity).toBeLessThanOrEqual(1);
    }
  });

  it('gothic-horror is darker and grainier than high-fantasy', () => {
    const gothic = boardBackdropTheme('gothic-horror');
    const fantasy = boardBackdropTheme('high-fantasy');
    expect(gothic.vignetteStrength).toBeGreaterThan(fantasy.vignetteStrength);
    expect(gothic.grainOpacity).toBeGreaterThan(fantasy.grainOpacity);
    expect(fantasy.glowStrength).toBeGreaterThan(gothic.glowStrength);
  });
});

describe('boardBackdropStyle — custom-property serialization', () => {
  it('emits exactly the five --board-* variables the CSS class consumes', () => {
    const style = boardBackdropStyle('eldritch-mystery') as Record<string, string>;
    const keys = Object.keys(style).sort();
    expect(keys).toEqual([
      '--board-glow',
      '--board-glow-strength',
      '--board-grain-opacity',
      '--board-vignette',
      '--board-vignette-strength',
    ]);
    // Strengths serialize as plain numbers (color-mix percentage math).
    for (const key of keys.filter((k) => k.endsWith('-strength') || k === '--board-grain-opacity')) {
      expect(Number.isFinite(Number(style[key]))).toBe(true);
    }
  });

  it('stock style carries the semantic accent reference through', () => {
    const style = boardBackdropStyle() as Record<string, string>;
    expect(style['--board-glow']).toBe('var(--tavern-accent)');
    expect(style['--board-vignette']).toBe('#000000');
  });

  it('junk ids produce the same style object as the default', () => {
    expect(boardBackdropStyle('bogus')).toEqual(boardBackdropStyle(DEFAULT_ATMOSPHERE_ID));
  });
});
