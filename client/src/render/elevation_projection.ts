/**
 * Pure 2D-projected elevation model for the tactical token layer.
 *
 * GOALS.md Pillar 9 / audit defect: `token.elevationFeet` previously drove
 * nothing visual beyond a numeric badge — pixi_board bakes floor + walls at
 * z=0 and spatial_audio.ts documents a planar (same-height) listener model.
 * This module makes elevation READ as elevation without pretending the board
 * is 3D:
 *
 *   - Vertical offset: each foot of elevation lifts the token's sprite stack
 *     straight up on screen (1ft = ELEVATION_PX_PER_FOOT px), capped so very
 *     high flyers never leave the board. This is an oblique/2.5D projection —
 *     there is no perspective foreshortening and no camera math; the number is
 *     a deliberate, documented convention, not a simulation.
 *   - Ground shadow: a soft ellipse pinned to the token's BOARD cell (it does
 *     NOT translate with the sprite) that shrinks and fades as elevation
 *     rises, saturating at SHADOW_REFERENCE_FEET. The combination of "sprite
 *     lifted, shadow left behind, shadow shrinking" is what makes a token read
 *     as airborne rather than merely offset.
 *
 * Consistency contract with the rest of the render/audio stack: this module
 * produces PRESENTATION offsets only. Lighting sources (RaycastLighting),
 * fog seeding, occlusion wall-walks, and spatial audio panning all consume the
 * raw grid coordinates and must NEVER see these pixel offsets — applying them
 * twice would displace light/sound away from the token's actual cell.
 */

/** Screen pixels of lift per foot of elevation (1ft ≈ 4px at cellSize=60). */
export const ELEVATION_PX_PER_FOOT = 4;

/**
 * Maximum vertical lift in px. 120px ≈ 2 cells: enough headroom to read as
 * clearly airborne while keeping the sprite stack inside its own board region
 * at any supported zoom level.
 */
export const ELEVATION_OFFSET_CAP_PX = 120;

/**
 * Elevation (feet) at which the ground shadow reaches its minimum size and
 * opacity and then holds steady — beyond this, "very high up" stops getting
 * visually smaller so extreme flyer heights stay legible.
 */
export const SHADOW_REFERENCE_FEET = 30;

/** Shadow width multiplier for a grounded token (slightly larger than base). */
const SHADOW_GROUNDED_SCALE = 1.15;

/** Shadow width multiplier once the reference height is reached. */
const SHADOW_AIRBORNE_SCALE = 0.55;

/** Opacity of a grounded shadow. */
const SHADOW_GROUNDED_OPACITY = 0.45;

/** Opacity once the reference height is reached. */
const SHADOW_AIRBORNE_OPACITY = 0.12;

/** Ellipse aspect ratio: ground-plane circles project flatter than wide. */
const SHADOW_FLATTEN_RATIO = 0.32;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Vertical screen offset (px) for a token's elevation. Pure and deterministic;
 * negative elevations clamp to 0 (the stepper floors at 0) and results cap at
 * ELEVATION_OFFSET_CAP_PX.
 */
export function elevationOffsetPx(elevationFeet: number): number {
  const feet = Math.max(0, elevationFeet);
  return Math.min(feet * ELEVATION_PX_PER_FOOT, ELEVATION_OFFSET_CAP_PX);
}

export interface GroundShadowSpec {
  /** Ellipse major axis in px (horizontal). */
  widthPx: number;
  /** Ellipse minor axis in px (vertical, flattened ground projection). */
  heightPx: number;
  /** Fill opacity, fading with altitude but never reaching 0. */
  opacity: number;
}

/**
 * Ground-shadow geometry for a token of the given rendered diameter at the
 * given elevation. Scales linearly with diameter (so it tracks zoom/cell size)
 * and interpolates monotonically from grounded to airborne over
 * [0, SHADOW_REFERENCE_FEET], holding steady beyond it.
 */
export function groundShadowFor(elevationFeet: number, tokenDiameterPx: number): GroundShadowSpec {
  const t = clamp01(Math.max(0, elevationFeet) / SHADOW_REFERENCE_FEET);
  const scale =
    SHADOW_GROUNDED_SCALE + (SHADOW_AIRBORNE_SCALE - SHADOW_GROUNDED_SCALE) * t;
  const opacity =
    SHADOW_GROUNDED_OPACITY +
    (SHADOW_AIRBORNE_OPACITY - SHADOW_GROUNDED_OPACITY) * t;
  const widthPx = tokenDiameterPx * scale;
  return {
    widthPx,
    heightPx: widthPx * SHADOW_FLATTEN_RATIO,
    opacity,
  };
}
