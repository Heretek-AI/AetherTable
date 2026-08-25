/**
 * Unit tests for src/render/elevation_projection.ts — the pure 2D-projected
 * elevation model used by the TacticalCanvas token layer.
 *
 * Contract under test:
 *  - vertical screen offset grows linearly with elevation feet (1ft ≈ 4px),
 *    never negative, capped so airborne tokens stay on the board;
 *  - the ground shadow shrinks and fades monotonically as elevation rises,
 *    saturating at SHADOW_REFERENCE_FEET, so high flyers read as airborne;
 *  - every output is a pure function of (elevationFeet, tokenDiameterPx) —
 *    deterministic from state, no timers, no randomness, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  ELEVATION_OFFSET_CAP_PX,
  ELEVATION_PX_PER_FOOT,
  SHADOW_REFERENCE_FEET,
  elevationOffsetPx,
  groundShadowFor,
} from '../elevation_projection';

describe('elevationOffsetPx', () => {
  it('projects 1ft to exactly ELEVATION_PX_PER_FOOT pixels', () => {
    expect(elevationOffsetPx(1)).toBe(ELEVATION_PX_PER_FOOT);
    expect(ELEVATION_PX_PER_FOOT).toBe(4);
  });

  it('is linear between 0 and the cap', () => {
    expect(elevationOffsetPx(5)).toBe(20);
    expect(elevationOffsetPx(15)).toBe(60);
    expect(elevationOffsetPx(15)).toBe(elevationOffsetPx(5) * 3);
  });

  it('maps zero elevation to zero offset (grounded tokens do not float)', () => {
    expect(elevationOffsetPx(0)).toBe(0);
  });

  it('clamps negative elevation to zero rather than sinking tokens', () => {
    expect(elevationOffsetPx(-10)).toBe(0);
  });

  it('caps extreme elevations so tokens remain on the board', () => {
    expect(elevationOffsetPx(1000)).toBe(ELEVATION_OFFSET_CAP_PX);
    expect(elevationOffsetPx(SHADOW_REFERENCE_FEET)).toBeLessThanOrEqual(
      ELEVATION_OFFSET_CAP_PX
    );
  });
});

describe('groundShadowFor', () => {
  const DIAMETER = 60;

  it('draws a grounded shadow slightly larger than the token', () => {
    const s = groundShadowFor(0, DIAMETER);
    expect(s.widthPx).toBeGreaterThan(DIAMETER);
    expect(s.opacity).toBeGreaterThan(0.3);
  });

  it('shrinks monotonically with elevation', () => {
    const grounded = groundShadowFor(0, DIAMETER).widthPx;
    const mid = groundShadowFor(15, DIAMETER).widthPx;
    const high = groundShadowFor(30, DIAMETER).widthPx;
    expect(mid).toBeLessThan(grounded);
    expect(high).toBeLessThan(mid);
    expect(high).toBeGreaterThan(0);
  });

  it('fades monotonically toward (but never reaches) full transparency', () => {
    const opacities = [0, 5, 10, 15].map((ft) => groundShadowFor(ft, DIAMETER).opacity);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeLessThan(opacities[i - 1]);
    }
    expect(opacities[0]).toBeGreaterThan(0);
  });

  it('saturates past SHADOW_REFERENCE_FEET (no runaway shrink/fade)', () => {
    const atRef = groundShadowFor(SHADOW_REFERENCE_FEET, DIAMETER);
    const farBeyond = groundShadowFor(SHADOW_REFERENCE_FEET * 4, DIAMETER);
    expect(farBeyond.widthPx).toBeCloseTo(atRef.widthPx, 10);
    expect(farBeyond.opacity).toBeCloseTo(atRef.opacity, 10);
    expect(atRef.opacity).toBeGreaterThan(0);
  });

  it('scales proportionally with the token diameter (zoom-independent shape)', () => {
    const small = groundShadowFor(10, 40);
    const large = groundShadowFor(10, 80);
    expect(large.widthPx).toBeCloseTo(small.widthPx * 2, 10);
    expect(large.heightPx).toBeCloseTo(small.heightPx * 2, 10);
    expect(large.opacity).toBeCloseTo(small.opacity, 10);
  });

  it('keeps the ellipse flatter than it is wide (ground-plane foreshortening)', () => {
    const s = groundShadowFor(12, DIAMETER);
    expect(s.heightPx).toBeLessThan(s.widthPx);
  });

  it('is deterministic across repeated calls', () => {
    expect(groundShadowFor(7, DIAMETER)).toEqual(groundShadowFor(7, DIAMETER));
  });
});
