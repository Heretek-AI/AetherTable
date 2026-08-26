/**
 * Atmospheric BOARD BACKDROP theming (Loop 3 iteration 9 — visuals pass).
 *
 * The tactical board's floor was flat black-alpha checkerboard over
 * `--tavern-bg`: technically clean, visually austere. This module supplies the
 * per-atmosphere parameters for one decorative CSS layer (see
 * `.vtt-board-backdrop` in index.css — vignette + film grain + candle-glow)
 * painted BEHIND the PixiJS grid. It is presentation-only: nothing here feeds
 * lighting, fog masks, occlusion or audio.
 *
 * SINGLE SOURCE OF TRUTH: the glow color is NOT a second copy of palette data.
 * For a known preset we reuse that preset's `encounter.tokenRingColor`
 * (theme/atmospheres.ts) so the board wash and selected-token ring always
 * agree by construction. Only the intensity knobs live here, because they are
 * genuinely backdrop-specific tuning, not palette duplication.
 *
 * Unknown / tampered / default ids fall back to the STOCK obsidian+amber
 * theme — an unrecognized id can never inject an arbitrary color into the
 * board (it would have had to get past normalizeAtmosphereId upstream anyway).
 */

import type { CSSProperties } from 'react';
import { DEFAULT_ATMOSPHERE_ID, getAtmosphere } from './atmospheres';

export interface BoardBackdropTheme {
  /**
   * Focal glow wash color. For shipped presets this IS the preset's
   * token-ring color; the stock table uses the semantic accent token so a
   * future re-palette of index.css retints the board without touching code.
   */
  glowColor: string;
  /** Peak glow alpha at its focal point (0..1). */
  glowStrength: number;
  /** Edge-darkening vignette tint. */
  vignetteColor: string;
  /** Vignette strength at the frame edges (0..1). */
  vignetteStrength: number;
  /** Film-grain layer opacity (0..1). */
  grainOpacity: number;
}

/** Stock obsidian/parchment table (DEFAULT_ATMOSPHERE_ID and any junk id). */
const STOCK_BACKDROP: BoardBackdropTheme = {
  glowColor: 'var(--tavern-accent)',
  glowStrength: 0.1,
  vignetteColor: '#000000',
  vignetteStrength: 0.55,
  grainOpacity: 0.5,
};

/**
 * Intensity-only tuning per shipped preset. Colors intentionally absent —
 * those come from the preset itself (see module header).
 */
const PRESET_INTENSITY: Record<string, Partial<Omit<BoardBackdropTheme, 'glowColor'>>> = {
  // Blood-dark iron: deepest shadow, dimmest candle, heaviest grain.
  'gothic-horror': { vignetteStrength: 0.72, glowStrength: 0.09, grainOpacity: 0.62 },
  // Sunlit gilded halls: brightest wash, shallowest vignette, least grain.
  'high-fantasy': { vignetteStrength: 0.4, glowStrength: 0.15, grainOpacity: 0.36 },
  // Void-blue brine: cold deep vignette, faint sickly sigil-glow.
  'eldritch-mystery': {
    vignetteColor: '#010409',
    vignetteStrength: 0.66,
    glowStrength: 0.12,
    grainOpacity: 0.56,
  },
};

/** Clamp to the closed [0,1] interval — defensive against bad future data. */
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Resolve the backdrop theme for an atmosphere id. Never throws, never returns
 * out-of-range numbers: unknown ids and junk fields degrade to stock values.
 */
export function boardBackdropTheme(atmosphereId?: string | null): BoardBackdropTheme {
  const base =
    atmosphereId && atmosphereId !== DEFAULT_ATMOSPHERE_ID ? getAtmosphere(atmosphereId) : undefined;
  if (!base) return STOCK_BACKDROP;

  const intensity = PRESET_INTENSITY[base.id] ?? {};
  return {
    // Reuse the preset's own ring color: board wash === selection ring hue.
    glowColor: base.encounter.tokenRingColor,
    glowStrength: clamp01(intensity.glowStrength ?? STOCK_BACKDROP.glowStrength),
    vignetteColor: intensity.vignetteColor ?? STOCK_BACKDROP.vignetteColor,
    vignetteStrength: clamp01(intensity.vignetteStrength ?? STOCK_BACKDROP.vignetteStrength),
    grainOpacity: clamp01(intensity.grainOpacity ?? STOCK_BACKDROP.grainOpacity),
  };
}

/**
 * Serialize a theme into CSS custom properties suitable for spreading onto the
 * `.vtt-board-backdrop` element's inline style. The class in index.css owns
 * every gradient/texture decision; this only carries the tuned values down.
 */
export function boardBackdropStyle(atmosphereId?: string | null): CSSProperties {
  const t = boardBackdropTheme(atmosphereId);
  return {
    '--board-glow': t.glowColor,
    '--board-glow-strength': String(t.glowStrength),
    '--board-vignette': t.vignetteColor,
    '--board-vignette-strength': String(t.vignetteStrength),
    '--board-grain-opacity': String(t.grainOpacity),
  } as CSSProperties;
}
