/**
 * Pure feet→Web-Audio-z mapping for the spatial engine (Pillar 9, iteration 50).
 *
 * DEFECT FIXED: `token.elevationFeet` reached pixi_board's token layer
 * (elevation_projection, iteration 38) but spatial_audio placed every source
 * and the listener on a single horizontal plane — positionY was pinned at the
 * constant ear height 1.5 for everyone, so an archer on a cliff and a goblin in
 * a pit sounded identical. This module derives the panner's z coordinate from
 * feet using the SAME board ruler the x/y plane already uses:
 *
 *   - The spatial engine positions sources in BOARD CELL units (panner.positionX
 *     = token.x, positionZ = token.y; see SpatialAudioEngine.writePannerPosition).
 *   - TacticalCanvas/pixi_board render CELL_SIZE_PX px per cell; the engine's
 *     movement grid is FEET_PER_CELL ft per cell (D&D 5e).
 *   - Therefore 1ft of height = 1/FEET_PER_CELL cells of z, i.e. a token 15ft
 *     up is exactly as "far" along z as a token 3 cells away is along x/y.
 *     Feeding that z into an HRTF PannerNode yields vertical interaural cues
 *     AND inverse-distance attenuation over the full 3D separation for free.
 *
 * Consistency contract with elevation_projection.ts: that module produces
 * PRESENTATION pixel offsets (4px/ft screen lift, capped at 120px ≈ 2 cells)
 * and explicitly forbids lighting/audio from consuming them — applying a
 * screen-space convention twice would displace sound away from the token's
 * actual cell. Here we use the geometric scale instead. The grounded origin IS
 * shared (0ft ⇒ 0 offset both places); only the saturation point differs, and
 * deliberately so: AUDIO_Z_MAX gives HRTF headroom past where the sprite stops
 * rising so an overhead voice keeps reading as overhead rather than collapsing
 * onto the listener's plane.
 *
 * Negative elevation clamps to 0: the elevation stepper floors at ground level,
 * and PannerNode has no subterranean model — sinking a source below the plane
 * would just mirror its cue upward.
 */

/** Board cell size in px, matching TacticalCanvas/pixi_board (`new PixiBoard(60)`). */
export const CELL_SIZE_PX = 60;

/**
 * Grid feet per board cell (D&D 5e movement convention). This is the ruler
 * shared by the panner's planar axes and its z axis.
 */
export const FEET_PER_CELL = 5;

/**
 * Maximum modeled height in cells of z (6 cells = 30ft). Beyond this a source
 * holds steady: extreme flyer heights stop getting "higher" acoustically, the
 * same way elevation_projection stops lifting the sprite past its cap.
 */
export const AUDIO_Z_MAX = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Elevation in feet → panner z offset in board-cell units, relative to the
 * board plane (add to any base height such as the 1.5-unit ear height the
 * engine already uses). Pure and deterministic.
 */
export function elevationToAudioZ(elevationFeet: number): number {
  if (!Number.isFinite(elevationFeet)) return 0;
  const cells = elevationFeet / FEET_PER_CELL;
  return clamp(cells, 0, AUDIO_Z_MAX);
}
