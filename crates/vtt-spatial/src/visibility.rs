//! Real-time raycasted **visibility polygons** against wall/door occluders.
//!
//! GOALS.md Pillar 4: "real-time raycasted visual polygons against wall/door
//! occluders". The per-cell Bresenham LoS in [`crate::raycast`] answers "can A
//! see B"; this module answers "what can a viewer see" — the ordered boundary
//! polygon of the visible region, suitable for fog-of-war rendering on the
//! presentation client.
//!
//! Algorithm (corner-casting, the standard grid-visibility approach):
//! 1. Only SILHOUETTE corners of the solid region cast rays: lattice corners
//!    where exactly one surrounding cell is solid (convex corner), or two
//!    diagonal cells are solid (checkerboard corner). Straight wall runs and
//!    concave notches contribute no rays — their shadows are already bounded
//!    by the runs' end caps, and casting mid-edge corners would wrongly leak
//!    sight through the empty cells beyond the wall face.
//! 2. For every unique silhouette corner, cast a ray from the origin through
//!    the corner PLUS two small angular offsets around it
//!    (± [`ANGLE_EPSILON_RADIANS`]). The offsets are what make the polygon hug
//!    the occluder silhouette on both sides instead of collapsing onto the
//!    shared-corner line.
//! 3. March each ray cell by cell (Amanatides–Woo traversal) until it reaches
//!    a solid cell, leaves the map, or exhausts `max_range_feet`.
//! 4. Sort hit points by angle around the origin normalized into `[0, τ)`
//!    (stable sort over a fixed iteration order) and return them as an
//!    ordered `Vec<(f32, f32)>`.
//!
//! Determinism: corners live in a `BTreeSet` keyed on their exact bit patterns
//! (no hash-map iteration), the base fan and each corner fan are emitted in a
//! fixed order, and the final ordering is a stable sort keyed only on the
//! angle — identical inputs produce byte-identical output.
//!
//! Complexity is O(corners · log corners): one bounded ray march (≤ map
//! diagonal in cells) per ray plus an angular sort. A 32x32 map holds ≤ 1024
//! unique corners ⇒ ~3k short marches, far under the 15 ms SLA.
//!
//! Lighting integration (deliberate scope decision): the polygon models
//! GEOMETRIC occlusion only — walls, doors and pillars truncate it. Per-cell
//! lighting zones (darkness/magical darkness vs vision mode) change WHAT IS
//! SEEN rather than WHERE sight reaches geometrically, so they stay with the
//! per-cell semantics already shipped in [`crate::lighting`] and the
//! `/spatial/los` route; folding them in here would require clipping the
//! polygon against arbitrary dark-cell unions for little rendering benefit.
//! Callers bound what is rendered inside the polygon with `max_range_feet`
//! (the sense range) instead.

use crate::geometry::Vector3;
use crate::raycast::GridCollisionMap;
use std::cmp::Ordering;
use std::collections::BTreeSet;

/// Half-width of the angular probe fan cast around each occluder corner, in
/// radians (~0.0057°). Small enough not to leak past adjacent geometry, large
/// enough to separate coincident corner rays under f32 math.
pub const ANGLE_EPSILON_RADIANS: f32 = 1e-4;

/// Number of evenly spaced base-fan rays cast regardless of geometry. These
/// guarantee a closed full-range polygon for obstacle-free maps (where there
/// are no corners to cast) and keep the silhouette honest across large open
/// spans between occluders.
const BASE_FAN_RAYS: usize = 16;

/// Computes the visibility polygon for a viewer at `origin` on the top layer
/// (z = 0) of `map`, truncated at `max_range_feet`.
///
/// Returns polygon vertices in ascending-angle order; the last vertex connects
/// back to the first. With no solid cells this is a regular [`BASE_FAN_RAYS`]-
/// gon inscribed in the range circle — an empty room yields a full-range
/// polygon.
pub fn visibility_polygon(
    map: &GridCollisionMap,
    origin: &Vector3,
    max_range_feet: f32,
) -> Vec<(f32, f32)> {
    visibility_polygon_z(map, origin, 0, max_range_feet)
}

/// Layer-aware variant of [`visibility_polygon`]: computes the visibility
/// polygon against solid cells on elevation layer `z` only.
pub fn visibility_polygon_z(
    map: &GridCollisionMap,
    origin: &Vector3,
    z: usize,
    max_range_feet: f32,
) -> Vec<(f32, f32)> {
    let mut hits: Vec<(f32, f32, f32)> = Vec::new();

    // Base fan: fixed, evenly spaced directions bound the open space even
    // where no occluder corner ever directs a ray.
    for k in 0..BASE_FAN_RAYS {
        let angle = k as f32 * (std::f32::consts::TAU / BASE_FAN_RAYS as f32);
        hits.push(march_ray(map, z, origin, angle, max_range_feet));
    }

    // Corner fans: hug both faces of every occluder silhouette corner.
    for &(cx, cy) in unique_occluder_corners(map, z).iter() {
        let angle = normalize_angle((cy - origin.y).atan2(cx - origin.x));
        for offset in [-ANGLE_EPSILON_RADIANS, 0.0, ANGLE_EPSILON_RADIANS] {
            hits.push(march_ray(
                map,
                z,
                origin,
                normalize_angle(angle + offset),
                max_range_feet,
            ));
        }
    }

    // Stable sort on the normalized angle only: ties keep emission order, so
    // the result is a pure function of (map, origin, range).
    hits.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal))
    });

    hits.into_iter().map(|(_, x, y)| (x, y)).collect()
}

/// Point-in-polygon test (ray-crossing parity) against a visibility polygon.
///
/// The `(yi > py) != (yj > py)` guard implies `yi != yj`, so the crossing
/// slope can never divide by zero; horizontal edges therefore never decide a
/// result. The tests probe strictly away from boundaries.
pub fn point_in_polygon(polygon: &[(f32, f32)], point: (f32, f32)) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let (px, py) = point;
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = polygon[i];
        let (xj, yj) = polygon[j];
        if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Normalizes an angle in radians into `[0, 2π)` so the polygon sort is a
/// single linear pass with no ±π wrap seam.
fn normalize_angle(a: f32) -> f32 {
    let tau = std::f32::consts::TAU;
    a.rem_euclid(tau)
}

/// Collects the deduplicated world-space SILHOUETTE corners of the solid
/// region on layer `z`: lattice points where exactly one surrounding cell is
/// solid (convex corner) or two diagonal cells are solid (checkerboard
/// corner). Straight wall runs and concave notches contribute nothing — their
/// shadows are already bounded by the runs' end caps.
///
/// The `BTreeSet` keyed on bit patterns makes both membership and iteration
/// order deterministic for a given map regardless of insertion path.
fn unique_occluder_corners(map: &GridCollisionMap, z: usize) -> Vec<(f32, f32)> {
    let cs = map.cell_size_feet;
    let mut corners: BTreeSet<(u32, u32)> = BTreeSet::new();
    // Out-of-bounds reads via is_solid are "solid", which conveniently models
    // the map border as walls and keeps border cells' outer edges non-corner.
    for gy in 0..=map.height {
        for gx in 0..=map.width {
            let nw = map.is_solid(gx.wrapping_sub(1), gy, z);
            let ne = map.is_solid(gx, gy, z);
            let sw = map.is_solid(gx.wrapping_sub(1), gy.wrapping_sub(1), z);
            let se = map.is_solid(gx, gy.wrapping_sub(1), z);
            let count = nw as u8 + ne as u8 + sw as u8 + se as u8;
            let convex = count == 1;
            let checkerboard = count == 2
                && ((nw && se) || (ne && sw));
            if !(convex || checkerboard) {
                continue;
            }
            let wx = gx as f32 * cs;
            let wy = gy as f32 * cs;
            corners.insert((wx.to_bits(), wy.to_bits()));
        }
    }
    corners
        .into_iter()
        .map(|(bx, by)| (f32::from_bits(bx), f32::from_bits(by)))
        .collect()
}

/// Casts a single ray from the viewer along `angle` (2D, on elevation layer
/// `z`) using an Amanatides–Woo grid traversal and returns
/// `(angle, hit_x, hit_y)`: the entry point of the first solid cell, or the
/// range-limited end of the ray when nothing solid blocks it.
///
/// The viewer's OWN cell never blocks (standing in a doorway must not blind
/// you), and a corner-offset probe that grazes a wall face is allowed to slip
/// through the shared lattice line into the cell beyond — that is exactly how
/// sight reaches around an occluder's edge without passing through it.
fn march_ray(
    map: &GridCollisionMap,
    z: usize,
    origin: &Vector3,
    angle: f32,
    max_range_feet: f32,
) -> (f32, f32, f32) {
    const GRAZE_EPSILON: f32 = 1e-4;

    let cs = map.cell_size_feet.max(f32::EPSILON);
    let dir_x = angle.cos();
    let dir_y = angle.sin();

    let range_end = |t: f32| (origin.x + dir_x * t, origin.y + dir_y * t);

    // Current cell in grid coordinates.
    let mut gx = (origin.x / cs).floor() as i64;
    let mut gy = (origin.y / cs).floor() as i64;

    // Parametric distances to the next vertical/horizontal grid line.
    let step_x = i64::from(dir_x > 0.0) - i64::from(dir_x < 0.0);
    let step_y = i64::from(dir_y > 0.0) - i64::from(dir_y < 0.0);
    let t_delta_x = if dir_x.abs() > f32::EPSILON { cs / dir_x.abs() } else { f32::INFINITY };
    let t_delta_y = if dir_y.abs() > f32::EPSILON { cs / dir_y.abs() } else { f32::INFINITY };
    let mut t_max_x = if dir_x.abs() > f32::EPSILON {
        ((gx + i64::from(dir_x > 0.0)) as f32 * cs - origin.x) / dir_x
    } else {
        f32::INFINITY
    };
    let mut t_max_y = if dir_y.abs() > f32::EPSILON {
        ((gy + i64::from(dir_y > 0.0)) as f32 * cs - origin.y) / dir_y
    } else {
        f32::INFINITY
    };

    let own_cell = (gx, gy);

    // Bound the walk by the map diagonal in steps; the range clamp fires
    // first for any realistic range.
    let max_steps = (map.width.max(map.height) as i64 + 2) * 2;
    for _ in 0..max_steps {
        let x_cross_first = t_max_x <= t_max_y;
        let (next_t, nx, ny) = if x_cross_first {
            (t_max_x, gx + step_x, gy)
        } else {
            (t_max_y, gx, gy + step_y)
        };

        if next_t >= max_range_feet {
            let (ex, ey) = range_end(max_range_feet);
            return (angle, ex, ey);
        }

        // How far past the crossing line does the ray travel before the NEXT
        // grid line in the other axis (or the same one again)? If the ray
        // exits this crossing within epsilon, it is grazing along the shared
        // lattice line rather than entering the neighbor's interior.
        let grazing = if x_cross_first {
            dir_y.abs() > f32::EPSILON && (t_max_y - next_t) <= GRAZE_EPSILON
                || step_y == 0
        } else {
            dir_x.abs() > f32::EPSILON && (t_max_x - next_t) <= GRAZE_EPSILON
                || step_x == 0
        };

        gx = nx;
        gy = ny;
        if x_cross_first {
            t_max_x += t_delta_x;
        } else {
            t_max_y += t_delta_y;
        }

        // Left the map: the ray ends at whichever comes first, the boundary
        // crossing or the range clamp.
        if gx < 0 || gy < 0 || gx >= map.width as i64 || gy >= map.height as i64 {
            let t = next_t.min(max_range_feet);
            let (ex, ey) = range_end(t);
            return (angle, ex, ey);
        }

        if (gx, gy) != own_cell && map.is_solid(gx as usize, gy as usize, z) && !grazing {
            let (hx, hy) = range_end(next_t);
            return (angle, hx, hy);
        }
    }

    // Exhausted the step budget without a hit or range clamp (degenerate
    // geometry): terminate at the range.
    let (ex, ey) = range_end(max_range_feet);
    (angle, ex, ey)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 10x10 empty room with 5 ft cells.
    fn empty_room() -> GridCollisionMap {
        GridCollisionMap::new(10, 10, 1, 5.0)
    }

    /// Room center: world (25, 25).
    fn center() -> Vector3 {
        Vector3::new(25.0, 25.0, 0.0)
    }

    #[test]
    fn empty_room_yields_full_range_polygon() {
        let map = empty_room();
        let poly = visibility_polygon(&map, &center(), 20.0);

        assert!(poly.len() >= 8, "empty room needs manygon vertices, got {}", poly.len());
        for (x, y) in &poly {
            let d = ((x - center().x).powi(2) + (y - center().y).powi(2)).sqrt();
            assert!(
                (d - 20.0).abs() < 0.5,
                "vertex ({x},{y}) is {d} ft from origin, expected ~20"
            );
        }
        // The polygon surrounds the origin.
        assert!(point_in_polygon(&poly, (center().x, center().y)));
    }

    #[test]
    fn single_pillar_casts_four_corner_shadow_wedge() {
        let mut map = empty_room();
        map.set_solid(5, 5, 0, true); // one pillar left of the viewer

        let origin = Vector3::new(37.5, 27.5, 0.0);
        let poly = visibility_polygon(&map, &origin, 200.0);

        // The pillar's near face (east side, x=30) must appear as polygon
        // vertices where the sight lines terminate on it.
        assert!(
            poly.iter()
                .any(|&(x, _)| (x - 30.0).abs() < 1e-3),
            "pillar near face x=30 must be a polygon vertex: {poly:?}"
        );

        // Directly behind the pillar (west of it) is shadowed…
        assert!(
            !point_in_polygon(&poly, (12.5, 27.5)),
            "point directly behind the pillar must be shadowed: {poly:?}"
        );
        // …while points off the pillar axis stay lit.
        assert!(point_in_polygon(&poly, (12.5, 7.5)));
        assert!(point_in_polygon(&poly, (12.5, 47.5)));
    }

    #[test]
    fn wall_with_doorway_occludes_beyond_solid_and_opens_through_gap() {
        let mut map = empty_room();
        // Vertical wall at column x=5 spanning rows 0..=4; rows 5..=9 are an
        // open doorway band. Viewer stands west of the doorway.
        for y in 0..=4 {
            map.set_solid(5, y, 0, true);
        }

        let origin = Vector3::new(12.5, 22.5, 0.0); // west side, level with the doorway
        let poly = visibility_polygon(&map, &origin, 500.0);

        // Everything due-east beyond the solid segment is shadowed.
        assert!(!point_in_polygon(&poly, (37.5, 2.5)), "behind solid: {poly:?}");
        assert!(!point_in_polygon(&poly, (47.5, 12.5)), "behind solid: {poly:?}");

        // Through the doorway and across the open south half: visible.
        assert!(point_in_polygon(&poly, (37.5, 42.5)), "through gap: {poly:?}");
        assert!(point_in_polygon(&poly, (12.5, 47.5)));
        assert!(point_in_polygon(&poly, (12.5, 47.5)));
    }

    #[test]
    fn range_clamps_the_polygon() {
        let mut map = GridCollisionMap::new(40, 40, 1, 5.0);
        // Far wall 100 ft east — well past a 30 ft sight radius.
        for y in 0..40 {
            map.set_solid(20, y, 0, true);
        }
        let origin = Vector3::new(2.5, 2.5, 0.0);

        let poly = visibility_polygon(&map, &origin, 30.0);
        for &(x, y) in &poly {
            let d = origin.distance_2d(&Vector3::new(x, y, 0.0));
            assert!(d <= 30.0 + 1e-3, "vertex ({x},{y}) exceeds 30 ft range: {d}");
        }
    }

    #[test]
    fn same_input_produces_byte_identical_output() {
        let build = || {
            let mut map = empty_room();
            map.set_solid(5, 5, 0, true);
            map.set_solid(2, 7, 0, true);
            visibility_polygon(&map, &center(), 60.0)
        };
        let a: Vec<(f32, f32)> = build();
        let b = build();
        let sa = format!("{a:?}");
        let sb = format!("{b:?}");
        assert_eq!(sa, sb, "visibility must be deterministic byte-for-byte");
    }

    #[test]
    fn polygon_vertices_are_sorted_by_angle() {
        let mut map = empty_room();
        map.set_solid(5, 5, 0, true);
        let poly = visibility_polygon(&map, &center(), 45.0);

        let angle = |p: (f32, f32)| (p.1 - center().y).atan2(p.0 - center().x).rem_euclid(std::f32::consts::TAU);
        for w in poly.windows(2) {
            assert!(
                angle(w[0]) <= angle(w[1]) + 1e-3,
                "angles must ascend: {w:?}"
            );
        }
    }

    #[test]
    fn point_in_polygon_classifies_lit_and_shadowed_probes() {
        // Square polygon, CCW.
        let square = vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(point_in_polygon(&square, (5.0, 5.0)));
        assert!(point_in_polygon(&square, (0.5, 0.5)));
        assert!(!point_in_polygon(&square, (-1.0, 5.0)));
        assert!(!point_in_polygon(&square, (15.0, 5.0)));
        assert!(!point_in_polygon(&square, (11.0, 11.0)));
        // Degenerate input is never "inside".
        assert!(!point_in_polygon(&[], (0.0, 0.0)));
        assert!(!point_in_polygon(&[(0.0, 0.0)], (0.0, 0.0)));
    }

    #[test]
    fn visibility_on_elevated_layer_uses_that_layer_only() {
        let mut map = GridCollisionMap::new(10, 10, 2, 5.0);
        // Wall on z=0 east of the viewer (viewer sits at grid (5,5), so the
        // wall column stops one row short to leave their own cell open).
        for y in 0..4 {
            map.set_solid(5, y, 0, true);
        }
        for y in 6..10 {
            map.set_solid(5, y, 0, true);
        }

        // Ground floor: the wall band shadows the region beyond it (probe
        // level with the wall), while the gate slit stays open.
        let ground = visibility_polygon_z(&map, &center(), 0, 500.0);
        assert!(!point_in_polygon(&ground, (30.5, 7.5)), "beyond wall: {ground:?}");
        assert!(point_in_polygon(&ground, (37.5, 27.5)), "through gate: {ground:?}");

        // Upper floor has no geometry: clear everywhere.
        let upper = visibility_polygon_z(&map, &center(), 1, 500.0);
        assert!(point_in_polygon(&upper, (37.5, 27.5)));
        assert!(point_in_polygon(&upper, (37.5, 2.5)));
    }

    #[test]
    fn computation_stays_well_under_sla_on_32x32() {
        let mut map = GridCollisionMap::new(32, 32, 1, 5.0);
        // Scattered pillars: worst realistic corner count.
        for i in 0..32 {
            map.set_solid(i, (i * 7) % 32, 0, true);
            map.set_solid((i * 13) % 32, i, 0, true);
        }
        let start = std::time::Instant::now();
        let poly = visibility_polygon(&map, &center(), 160.0);
        let elapsed = start.elapsed();
        assert!(!poly.is_empty());
        assert!(
            elapsed.as_millis() < 15,
            "32x32 visibility took {} ms, SLA is <15 ms",
            elapsed.as_millis()
        );
    }
}
