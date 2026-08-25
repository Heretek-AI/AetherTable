/**
 * Unit tests for src/render/audio_elevation.ts — the feet→Web Audio z-axis
 * mapping that lets PannerNode HRTF hear token elevation (Pillar 9, iteration
 * 50).
 *
 * Contract under test:
 *  - board cells are square: the SAME ft-per-cell scale applies to the panner's
 *    x/y plane and its z axis, so a token 30ft up is exactly as "far" in z as a
 *    token 5 cells away is in x;
 *  - negative elevation clamps to the board plane (no subterranean audio);
 *  - extreme heights saturate at a cap consistent with the visual model
 *    (elevation_projection caps lift at 2 cells of pixels);
 *  - every output is pure — no AudioContext, DOM, or randomness.
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_Z_MAX,
  CELL_SIZE_PX,
  FEET_PER_CELL,
  elevationToAudioZ,
} from '../audio_elevation';

describe('constants', () => {
  it('matches the board cell size used by pixi_board / TacticalCanvas', () => {
    expect(CELL_SIZE_PX).toBe(60);
  });

  /**
   * 1 cell = 5ft is the D&D 5e grid convention the engine already uses for
   * movement/ranges. Elevation feet ride the same ruler — a 15ft flyer is
   * 3 cells' worth of height.
   */
  it('uses the 5ft-per-cell grid convention', () => {
    expect(FEET_PER_CELL).toBe(5);
  });

  /**
   * The visual layer (elevation_projection) saturates lift at
   * ELEVATION_OFFSET_CAP_PX = 120px = 2 cells = 10ft-equivalent of screen
   * travel. The audio cap is deliberately WIDER (6 cells = 30ft): HRTF z cues
   * stay useful well past where the sprite stops rising, and the panner's
   * inverse distance model needs headroom so an overhead voice never collapses
   * to the same gain as one standing next to you. But both must agree on the
   * grounded case: 0ft ⇒ 0 offset on screen AND in audio space.
   */
  it('caps audio z beyond the visual lift cap but shares the grounded origin', () => {
    expect(AUDIO_Z_MAX).toBeGreaterThan(elevationOffsetCapCells());
    expect(elevationToAudioZ(0)).toBe(0);
  });

  function elevationOffsetCapCells(): number {
    // 120px cap ÷ 60px/cell = 2 cells.
    return 120 / CELL_SIZE_PX;
  }
});

describe('elevationToAudioZ', () => {
  it('is linear: each foot adds FEET_PER_CELL⁻¹ cells of z', () => {
    expect(elevationToAudioZ(5)).toBeCloseTo(1, 10); // 1 cell up
    expect(elevationToAudioZ(10)).toBeCloseTo(2, 10);
    expect(elevationToAudioZ(15)).toBeCloseTo(3, 10);
  });

  it('scales proportionally with feet', () => {
    expect(elevationToAudioZ(20)).toBeCloseTo(elevationToAudioZ(5) * 4, 10);
    expect(elevationToAudioZ(30)).toBeCloseTo(AUDIO_Z_MAX, 10); // cap boundary
  });

  it('clamps negative elevation to the board plane (z = 0)', () => {
    expect(elevationToAudioZ(-1)).toBe(0);
    expect(elevationToAudioZ(-30)).toBe(0);
  });

  it('saturates above the cap instead of diverging', () => {
    expect(elevationToAudioZ(100)).toBe(AUDIO_Z_MAX);
    expect(elevationToAudioZ(1000)).toBe(AUDIO_Z_MAX);
  });

  it('never returns a value outside [0, AUDIO_Z_MAX]', () => {
    for (let ft = -50; ft <= 120; ft += 7) {
      const z = elevationToAudioZ(ft);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(AUDIO_Z_MAX);
    }
  });

  it('keeps fractional feet monotonic (no non-monotonic steps)', () => {
    let prev = -1;
    for (let ft = 0; ft <= 40; ft += 0.25) {
      const z = elevationToAudioZ(ft);
      expect(z).toBeGreaterThanOrEqual(prev);
      prev = z;
    }
  });
});
