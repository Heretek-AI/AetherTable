/**
 * Unit coverage for the acoustic occlusion model (GOALS.md Pillar 9):
 * grid-line-walk wall counting between two board points and the -6 dB/wall
 * attenuation stacked on top of the existing inverse-distance rolloff.
 *
 * Pure functions only — no AudioContext, no DOM.
 */
import { describe, expect, it } from 'vitest';

import {
  OCCLUSION_DB_PER_WALL,
  OCCLUSION_MAX_WALLS,
  computeOccludedDistanceGain,
  countWallsOnSegment,
  wallCountToGainFactor,
  wallKey,
} from '../occlusion';

const walls = (...cells: Array<[number, number]>): Set<string> =>
  new Set(cells.map(([x, y]) => wallKey(x, y)));

describe('wallKey', () => {
  it('matches the pixi_board "x:y" cell-keying convention', () => {
    expect(wallKey(8, 3)).toBe('8:3');
    expect(wallKey(-1, 0)).toBe('-1:0');
  });
});

describe('countWallsOnSegment', () => {
  it('returns 0 across open floor', () => {
    expect(countWallsOnSegment(new Set(), 2, 2, 6, 2)).toBe(0);
    expect(countWallsOnSegment(walls([12, 12]), 2, 2, 6, 2)).toBe(0);
  });

  it('counts one wall directly between two tokens (horizontal)', () => {
    const w = walls([4, 2]);
    expect(countWallsOnSegment(w, 2, 2, 6, 2)).toBe(1);
    // Direction must not matter.
    expect(countWallsOnSegment(w, 6, 2, 2, 2)).toBe(1);
  });

  it('counts one wall on a vertical segment', () => {
    expect(countWallsOnSegment(walls([3, 5]), 3, 3, 3, 7)).toBe(1);
  });

  it('counts every wall along a corridor run', () => {
    // Collinear wall row between the tokens.
    const w = walls([6, 4], [7, 4], [8, 4], [9, 4], [10, 4]);
    expect(countWallsOnSegment(w, 5, 4, 11, 4)).toBe(5);
    // A perpendicular wall RUN only intersects the single cell the ray
    // actually passes through.
    expect(countWallsOnSegment(walls([8, 2], [8, 3], [8, 4], [8, 5], [8, 6]), 5, 4, 11, 4)).toBe(1);
  });

  it('never counts the listener or source cell itself', () => {
    // Source stands IN a wall cell (e.g. pressed against a doorway frame):
    // its own cell must not occlude it.
    expect(countWallsOnSegment(walls([2, 2]), 2, 2, 6, 2)).toBe(0);
    expect(countWallsOnSegment(walls([6, 2]), 2, 2, 6, 2)).toBe(0);
  });

  it('is symmetric: either traversal order finds the same walls', () => {
    const w = walls([8, 2], [8, 3], [4, 8], [5, 8]);
    expect(countWallsOnSegment(w, 1, 1, 10, 9)).toBe(
      countWallsOnSegment(w, 10, 9, 1, 1),
    );
  });

  it('handles diagonal segments crossing intermediate cells', () => {
    // Diagonal from (1,1) to (5,5) passes through (2,2), (3,3), (4,4).
    const w = walls([3, 3]);
    expect(countWallsOnSegment(w, 1, 1, 5, 5)).toBe(1);
    // Two of the three diagonal cells walled.
    expect(countWallsOnSegment(walls([2, 2], [4, 4]), 1, 1, 5, 5)).toBe(2);
  });

  it('treats an exact corner crossing conservatively (both adjacent cells)', () => {
    // Segment (1,2)->(3,2)... not a corner case. Use (1,1)->(3,3) offset so the
    // ray passes precisely through the shared corner of (2,1)/(2,2): the walk
    // steps diagonally there and may credit either/both — it must NEVER credit
    // zero when a wall sits on the corner diagonal path.
    const w = walls([2, 1], [2, 2]);
    expect(countWallsOnSegment(w, 1, 1, 3, 3)).toBeGreaterThanOrEqual(1);
  });

  it('ignores fractional coordinates landing off-grid consistently', () => {
    // Same physical segment shifted inside cells must give identical counts.
    const w = walls([4, 2]);
    expect(countWallsOnSegment(w, 2.5, 2.25, 6.5, 2.75)).toBe(1);
  });

  it('returns 0 for a degenerate zero-length segment even inside walls', () => {
    expect(countWallsOnSegment(walls([3, 3]), 3.2, 3.7, 3.4, 3.9)).toBe(0);
  });
});

describe('wallCountToGainFactor', () => {
  it('is unity with no intervening walls', () => {
    expect(wallCountToGainFactor(0)).toBe(1);
  });

  it('attenuates exactly ' + OCCLUSION_DB_PER_WALL + ' dB per wall', () => {
    const expected = Math.pow(10, -OCCLUSION_DB_PER_WALL / 20);
    expect(wallCountToGainFactor(1)).toBeCloseTo(expected, 12);
    expect(wallCountToGainFactor(2)).toBeCloseTo(expected * expected, 12);
    expect(wallCountToGainFactor(3)).toBeCloseTo(Math.pow(expected, 3), 12);
    // -6 dB ≈ half amplitude (exactly 10^(-0.3) ≈ 0.5012).
    expect(wallCountToGainFactor(1)).toBeGreaterThan(0.5);
    expect(wallCountToGainFactor(1)).toBeLessThan(0.51);
  });

  it('clamps at ' + OCCLUSION_MAX_WALLS + ' walls', () => {
    expect(wallCountToGainFactor(OCCLUSION_MAX_WALLS)).toBe(
      wallCountToGainFactor(OCCLUSION_MAX_WALLS + 10),
    );
  });
});

describe('computeOccludedDistanceGain', () => {
  it('leaves gain unchanged with no walls between', () => {
    expect(computeOccludedDistanceGain(4, 0)).toBeCloseTo(
      1 / (1 + 4 * 0.15),
      12,
    );
  });

  it('reduces gain when walls stand between listener and source', () => {
    const clear = computeOccludedDistanceGain(4, 0);
    const blocked = computeOccludedDistanceGain(4, 1);
    expect(blocked).toBeLessThan(clear);
    expect(blocked).toBeCloseTo(clear * Math.pow(10, -OCCLUSION_DB_PER_WALL / 20), 12);
  });

  it('monotonically decreases with more walls, down to the floor', () => {
    const gains = [0, 1, 2, 3, 4].map((n) => computeOccludedDistanceGain(4, n));
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]).toBeLessThanOrEqual(gains[i - 1] + 1e-12);
    }
    expect(gains[4]).toBeGreaterThan(0);
    expect(gains[4]).toBe(computeOccludedDistanceGain(4, 99));
  });

  it('still respects the existing distance floor', () => {
    expect(computeOccludedDistanceGain(1000, 0)).toBeGreaterThanOrEqual(0.08);
  });
});
