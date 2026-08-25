/**
 * Acoustic occlusion model (GOALS.md Pillar 9).
 *
 * Positional audio must attenuate by BOTH the Euclidean token distance AND the
 * intervening occluders between a listener token and a source token. This
 * module owns the pure, DOM-free half of that contract:
 *
 *   1. `countWallsOnSegment` — an Amanatides & Woo grid traversal (DDA) that
 *      walks the exact cells a straight listener→source ray passes through and
 *      counts how many are wall cells.
 *   2. `wallCountToGainFactor` — converts that count into a linear gain factor
 *      at -6 dB per wall, clamped at `OCCLUSION_MAX_WALLS` walls so a long
 *      dungeon wall can never mute a peer to literal zero.
 *   3. `computeOccludedDistanceGain` — the full legacy-compatible model:
 *
 *        gain = clamp( 1 / (1 + 0.15 · d), 0.08, 1 )          (distance rolloff)
 *             × 10^( −6 dB · min(walls, MAX) / 20 )           (occlusion)
 *
 * Wall data shape: the client already holds session walls as `{x, y}` grid
 * cells (App.tsx `customWalls`, rendered by pixi_board under `"x:y"` string
 * keys and consumed by RaycastLighting as segment obstacles). We reuse that
 * exact representation — no new sync surface is invented here.
 *
 * Endpoint semantics: the cell CONTAINING the listener and the cell containing
 * the source are never counted. A token pressed against or standing inside a
 * wall cell (doorway frames, corner hugs) does not occlude itself.
 *
 * Corner crossings: when the ray passes exactly through a shared cell corner,
 * the walk steps diagonally in one iteration. Crediting both adjacent cells
 * would over-count; crediting exactly one risks missing a real wall. The walk
 * credits whichever cells it ENTERS after such a step (both when both are
 * walled), i.e. the conservative reading: more walls ⇒ quieter, never louder.
 */

/** Board cell keying identical to pixi_board (`walls.has(`${x}:${y}`)`). */
export function wallKey(x: number, y: number): string {
  return `${x}:${y}`;
}

export interface GridCell {
  x: number;
  y: number;
}

/** Linear gain per intervening wall: −6 dB = ×10^(−6/20) ≈ 0.5 amplitude. */
export const OCCLUSION_DB_PER_WALL = 6;

/**
 * Hard clamp on counted walls. Beyond this the extra attenuation is discarded
 * so a voice behind a fortress wall stays faintly audible instead of dropping
 * into numeric silence.
 */
export const OCCLUSION_MAX_WALLS = 4;

/** Final output floor, below the existing 0.08 distance floor but > 0. */
export const OCCLUSION_GAIN_FLOOR = 0.02;

/** Existing inverse-distance rolloff constant from spatial_audio.ts. */
const DISTANCE_ROLLOFF_FACTOR = 0.15;
/** Existing distance-rolloff floor from spatial_audio.ts. */
const DISTANCE_GAIN_FLOOR = 0.08;

/**
 * Counts the wall cells intersected by the straight segment from (x0,y0) to
 * (x1,y1) on the board grid, EXCLUDING the endpoint cells themselves.
 *
 * `walls` holds `wallKey` strings. Fractional coordinates (mid-drag tokens)
 * are supported; each point belongs to `floor(coord)`'s cell.
 */
export function countWallsOnSegment(
  walls: ReadonlySet<string>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0 && dy === 0) return 0;

  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const endX = Math.floor(x1);
  const endY = Math.floor(y1);
  if (cx === endX && cy === endY) return 0;

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;

  // t ∈ [0,1] parameterizes the segment; tMax* is where we next cross a grid
  // line on that axis, tDelta* how much t one full cell consumes.
  let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? cx + 1 : cx) - x0) / dx;
  let tMaxY = dy === 0 ? Infinity : ((dy > 0 ? cy + 1 : cy) - y0) / dy;
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);

  // Bounded loop: a correct DDA crosses at most |ΔcellX| + |ΔcellY| + 2 lines.
  // The bound also guarantees termination against floating-point drift.
  const maxSteps = Math.abs(endX - cx) + Math.abs(endY - cy) + 2;

  let count = 0;
  for (let step = 0; step < maxSteps; step++) {
    if (cx === endX && cy === endY) break;
    if (tMaxX < tMaxY) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      cy += stepY;
      tMaxY += tDeltaY;
    } else {
      // Exact corner crossing: advance both axes in one step.
      cx += stepX;
      cy += stepY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }
    if (cx !== endX || cy !== endY) {
      // Interior cell only — endpoint cells are excluded by design.
      if (walls.has(wallKey(cx, cy))) count++;
    }
  }
  return count;
}

/**
 * Linear amplitude factor for `wallCount` intervening walls:
 * −6 dB per wall, clamped at `OCCLUSION_MAX_WALLS`.
 */
export function wallCountToGainFactor(wallCount: number): number {
  const clamped = Math.max(0, Math.min(OCCLUSION_MAX_WALLS, wallCount));
  return Math.pow(10, (-OCCLUSION_DB_PER_WALL * clamped) / 20);
}

/**
 * Full Pillar-9 gain model: existing inverse-distance rolloff multiplied by
 * the occlusion factor, floored at `OCCLUSION_GAIN_FLOOR`. With zero walls
 * this reduces bit-for-bit to the pre-existing spatial_audio rolloff.
 */
export function computeOccludedDistanceGain(
  distance: number,
  wallCount: number,
): number {
  const distanceGain = Math.max(
    DISTANCE_GAIN_FLOOR,
    Math.min(1.0, 1.0 / (1.0 + distance * DISTANCE_ROLLOFF_FACTOR)),
  );
  return Math.max(OCCLUSION_GAIN_FLOOR, distanceGain * wallCountToGainFactor(wallCount));
}
