/**
 * Fog-of-war overlay: per-cell darkening for cells the LOCAL player has not
 * yet explored, drawn on its own canvas layer in TacticalCanvas (stacked just
 * above the raycast lighting mask, below the FX canvas).
 *
 * ── MASK CONVENTION (authoritative for this repo) ───────────────────────────
 *
 * Storage lives in the Yjs Y.Doc's `fog` Y.Map, one entry per owner, written
 * through `YjsCrdtClient.setFogLayer(layerId, mask)`:
 *
 *   - Layer id:   `user:<userId>`  (see `fogLayerIdForUser`). The GM does not
 *                 keep a layer — GMs are omniscient and render no fog.
 *   - Shape:      one flat Uint8Array bitmask over the grid, row-major:
 *                 cellIndex = y * gridWidth + x,
 *                 bit       = (mask[cellIndex >> 3] >> (cellIndex & 7)) & 1.
 *   - Semantics:  bit SET = cell REVEALED (explored). Bits are never cleared;
 *                 reveal is monotonic so concurrent CRDT merges of two
 *                 players' layers are order-independent (OR-join).
 *   - Missing / short mask: every cell counts as UNREVEALED (never the
 *                 opposite) — a client that has not written anything must not
 *                 fabricate explored terrain.
 *
 * Visibility rules implemented by TacticalCanvas on top of this module:
 *   1. GM / admin (or no signed-in user): no fog at all.
 *   2. Own layer exists (`user:<my id>`): fog = complement of own mask.
 *   3. No own layer yet (e.g. before our first LoS seed lands): fully fogged
 *      EXCEPT the union of every other player-shared `user:*` mask — party
 *      shared exploration memory.
 */

import type { Point } from './raycast_lighting';

/** Key prefix under which per-player reveal masks live in the `fog` Y.Map. */
export const FOG_LAYER_PREFIX = 'user:';

export function fogLayerIdForUser(userId: string): string {
  return `${FOG_LAYER_PREFIX}${userId}`;
}

/** Bytes needed to hold one bit per cell of a gridWidth x gridHeight board. */
export function fogMaskByteLength(gridWidth: number, gridHeight: number): number {
  return Math.ceil((gridWidth * gridHeight) / 8);
}

/**
 * Return a mask that is guaranteed large enough for the current grid,
 * preserving every previously-revealed bit. Returns the input untouched when
 * it already fits; grows (zero-filled) otherwise. Null → fresh empty mask.
 */
export function ensureFogMask(
  mask: Uint8Array | null | undefined,
  gridWidth: number,
  gridHeight: number
): Uint8Array {
  const needed = fogMaskByteLength(gridWidth, gridHeight);
  if (mask && mask.length >= needed) return mask;
  const grown = new Uint8Array(needed);
  if (mask) grown.set(mask.subarray(0, Math.min(mask.length, needed)));
  return grown;
}

export function isCellRevealed(
  mask: Uint8Array | null | undefined,
  gridWidth: number,
  x: number,
  y: number
): boolean {
  if (!mask) return false;
  const cellIndex = y * gridWidth + x;
  const byte = cellIndex >> 3;
  // Out-of-range or truncated masks read as unrevealed (see header contract).
  if (byte < 0 || byte >= mask.length || x < 0 || x >= gridWidth || y < 0) return false;
  return ((mask[byte] >> (cellIndex & 7)) & 1) === 1;
}

/** Set a cell's revealed bit in place. Returns true when the bit was new. */
export function revealCellInPlace(
  mask: Uint8Array,
  gridWidth: number,
  x: number,
  y: number
): boolean {
  const cellIndex = y * gridWidth + x;
  const byte = cellIndex >> 3;
  if (byte < 0 || byte >= mask.length) return false;
  const bit = 1 << (cellIndex & 7);
  if ((mask[byte] & bit) !== 0) return false;
  mask[byte] |= bit;
  return true;
}

/**
 * OR-join several owner layers into one union mask sized to the widest input
 * (at least `minLength` when given). Null entries are skipped.
 */
export function unionFogMasks(
  masks: (Uint8Array | null | undefined)[],
  minLength: number = 0
): Uint8Array {
  let size = minLength;
  for (const m of masks) if (m && m.length > size) size = m.length;
  const out = new Uint8Array(size);
  for (const m of masks) {
    if (!m) continue;
    for (let i = 0; i < m.length; i++) out[i] |= m[i];
  }
  return out;
}

/** Standard even-odd point-in-polygon test (polygon from raycast_lighting). */
export function pointInPolygon(px: number, py: number, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const crosses = yi > py !== yj > py;
    if (crosses && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Reveal every grid cell whose CENTER lies inside the visibility polygon.
 * Mutates `mask` in place; returns true when at least one new bit was set
 * (so callers only hit the CRDT when exploration actually progressed).
 */
export function revealCellsInsidePolygon(
  mask: Uint8Array,
  gridWidth: number,
  gridHeight: number,
  cellSize: number,
  polygon: Point[]
): boolean {
  if (polygon.length < 3) return false;
  let changed = false;
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const cx = (x + 0.5) * cellSize;
      const cy = (y + 0.5) * cellSize;
      if (pointInPolygon(cx, cy, polygon)) {
        changed = revealCellInPlace(mask, gridWidth, x, y) || changed;
      }
    }
  }
  return changed;
}

export interface FogRenderOptions {
  /** Effective revealed-bit mask for the local perspective (see header). */
  mask: Uint8Array | null;
  gridWidth: number;
  gridHeight: number;
  cellSize: number;
  /** Hidden-cell fill; defaults to near-opaque obsidian. */
  hiddenColor?: string;
}

/**
 * Draw the fog layer: one dark rect per unrevealed cell. Revealed cells stay
 * fully transparent so the lighting overlay's dimming remains visible there.
 * Cells are batched into horizontal runs so a mostly-fogged board costs a
 * handful of fillRect calls instead of width*height.
 */
export function renderFogOverlay(ctx: CanvasRenderingContext2D, opts: FogRenderOptions): void {
  const { mask, gridWidth, gridHeight, cellSize } = opts;
  ctx.clearRect(0, 0, gridWidth * cellSize, gridHeight * cellSize);
  if (!mask) return; // No fog state → render nothing (honest absence).

  ctx.fillStyle = opts.hiddenColor ?? 'rgba(2, 6, 23, 0.94)';
  for (let y = 0; y < gridHeight; y++) {
    let runStart = -1;
    for (let x = 0; x <= gridWidth; x++) {
      const hidden = x < gridWidth && !isCellRevealed(mask, gridWidth, x, y);
      if (hidden && runStart < 0) {
        runStart = x;
      } else if (!hidden && runStart >= 0) {
        ctx.fillRect(runStart * cellSize, y * cellSize, (x - runStart) * cellSize, cellSize);
        runStart = -1;
      }
    }
  }
}
