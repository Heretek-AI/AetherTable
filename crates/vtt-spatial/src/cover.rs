use crate::geometry::Vector3;
use crate::raycast::GridCollisionMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CoverType {
    None,
    HalfCover,           // +2 AC, +2 DEX saves
    ThreeQuartersCover,  // +5 AC, +5 DEX saves
    TotalCover,          // Cannot be targeted directly
}

impl CoverType {
    pub fn ac_bonus(&self) -> i32 {
        match self {
            CoverType::None => 0,
            CoverType::HalfCover => 2,
            CoverType::ThreeQuartersCover => 5,
            CoverType::TotalCover => 999,
        }
    }

    pub fn dex_save_bonus(&self) -> i32 {
        match self {
            CoverType::None => 0,
            CoverType::HalfCover => 2,
            CoverType::ThreeQuartersCover => 5,
            CoverType::TotalCover => 999,
        }
    }
}

pub struct CoverCalculator;

/// Typical medium creature height (SRD: a medium biped stands ~6 ft). The
/// corner bundle samples the target's vertical bounding span from its base
/// z to base + this height when no explicit span is supplied.
pub const MEDIUM_CREATURE_HEIGHT_FEET: f32 = 6.0;

impl CoverCalculator {
    /// Legacy flat sampling: all four corner rays cast at `target_pos.z` only.
    /// Kept as the explicit backward-compatibility reference for the
    /// elevation-aware bundle (see `calculate_cover`).
    pub fn calculate_cover_flat(
        grid: &GridCollisionMap,
        attacker_pos: &Vector3,
        target_pos: &Vector3,
        target_radius_feet: f32,
    ) -> CoverType {
        let corners = Self::corner_points(target_pos, target_radius_feet, target_pos.z);
        Self::tier_for_blocked(grid, attacker_pos, &corners)
    }

    /// Casts the 4-corner bounding-box ray bundle from attacker to target
    /// across the target's VERTICAL bounding span. Each of the four x/y
    /// corner columns is sampled at BOTH the target's base and head heights
    /// (base z and base z + `MEDIUM_CREATURE_HEIGHT_FEET`), yielding eight
    /// rays; the blocked-sample FRACTION maps onto the cover tiers, so an
    /// obstruction that covers only part of the body's height — an overhead
    /// lintel, a parapet below a flier — is judged against the volume the
    /// creature actually occupies rather than a single floor-plane slice.
    ///
    /// Tier thresholds are the legacy ones DOUBLED (the sample pool doubled):
    /// 0 -> None, 1..=4 -> Half, 5..=7 -> Three-Quarters, 8 -> Total. When
    /// elevation carries no information — flat maps, floor-level combatants,
    /// depth-1 collision grids where head rays degenerate to their base twins
    /// — every head ray mirrors its base ray, the count is exactly twice the
    /// legacy blocked-ray count, and the resulting tier is IDENTICAL to
    /// `calculate_cover_flat`.
    pub fn calculate_cover(
        grid: &GridCollisionMap,
        attacker_pos: &Vector3,
        target_pos: &Vector3,
        target_radius_feet: f32,
    ) -> CoverType {
        let top_z = target_pos.z + MEDIUM_CREATURE_HEIGHT_FEET;
        let base_corners = Self::corner_points(target_pos, target_radius_feet, target_pos.z);
        let head_corners = Self::corner_points(target_pos, target_radius_feet, top_z);

        let mut blocked_samples = 0;
        for i in 0..4 {
            if !grid.has_line_of_sight(attacker_pos, &base_corners[i]) {
                blocked_samples += 1;
            }
            if !grid.has_line_of_sight(attacker_pos, &head_corners[i]) {
                blocked_samples += 1;
            }
        }

        // Legacy thresholds (0/1-2/3/4 rays) doubled for the 8-sample pool.
        match blocked_samples {
            0 => CoverType::None,
            1..=4 => CoverType::HalfCover,
            5..=7 => CoverType::ThreeQuartersCover,
            _ => CoverType::TotalCover,
        }
    }

    /// The four x/y bounding-box corners of the target at one given height.
    fn corner_points(
        target_pos: &Vector3,
        target_radius_feet: f32,
        z: f32,
    ) -> [Vector3; 4] {
        let half_r = (target_radius_feet / 2.0).max(1.0);
        [
            Vector3::new(target_pos.x - half_r, target_pos.y - half_r, z),
            Vector3::new(target_pos.x + half_r, target_pos.y - half_r, z),
            Vector3::new(target_pos.x - half_r, target_pos.y + half_r, z),
            Vector3::new(target_pos.x + half_r, target_pos.y + half_r, z),
        ]
    }

    /// Counts occluded rays to the given corner samples and maps the count to
    /// the legacy cover tiers.
    fn tier_for_blocked(
        grid: &GridCollisionMap,
        attacker_pos: &Vector3,
        corners: &[Vector3; 4],
    ) -> CoverType {
        let blocked_rays = corners
            .iter()
            .filter(|c| !grid.has_line_of_sight(attacker_pos, c))
            .count();
        match blocked_rays {
            0 => CoverType::None,
            1..=2 => CoverType::HalfCover,
            3 => CoverType::ThreeQuartersCover,
            _ => CoverType::TotalCover,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CELL: f32 = 5.0;

    /// 14 x 10 x 4 grid (70 x 50 ft footprint, 20 ft tall). A straight
    /// corridor runs along gy=4 (world y in [20, 25)).
    fn corridor_grid() -> GridCollisionMap {
        GridCollisionMap::new(14, 10, 4, CELL)
    }

    /// Attacker in cell (1, 4), ground level.
    fn attacker() -> Vector3 {
        Vector3::new(7.5, 22.5, 0.0)
    }

    /// The corridor's blocking wall column.
    const WALL_X: usize = 8;

    /// Target centered in cell (11, 4), 45 ft down-corridor, radius 5 ft
    /// (half-extent 2.5 ft -> corner columns at grid x 11/12, y 4/5).
    fn target() -> Vector3 {
        Vector3::new(57.5, 22.5, 0.0)
    }

    #[test]
    fn flat_positions_reproduce_legacy_single_plane_bundle() {
        // Full-height wall across the corridor: every corner ray blocked.
        let mut grid = corridor_grid();
        for gy in 3..=6 {
            for gz in 0..4 {
                grid.set_solid(WALL_X, gy, gz, true);
            }
        }

        assert_eq!(
            CoverCalculator::calculate_cover(&grid, &attacker(), &target(), 5.0),
            CoverType::TotalCover
        );
        assert_eq!(
            CoverCalculator::calculate_cover_flat(&grid, &attacker(), &target(), 5.0),
            CoverType::TotalCover
        );
    }

    /// DEFECT: a wall with an open gap at foot level (solid from 5 ft up)
    /// intersects the target's bounding volume above its base. The flat
    /// bundle samples only the floor plane — its rays slip under the wall and
    /// report No cover. The elevation-aware bundle samples the same corners
    /// at head height too; those rays strike the wall, so a tall target gets
    /// Half cover.
    #[test]
    fn upper_wall_grants_half_cover_against_tall_target() {
        let mut grid = corridor_grid();
        for gy in 3..=6 {
            for gz in 1..4 {
                grid.set_solid(WALL_X, gy, gz, true);
            }
        }
        // The attacker stands on a low ledge so rays RISE toward the target,
        // crossing the wall column above the foot-level gap.
        let shooter = Vector3::new(attacker().x, attacker().y, 5.0);

        let legacy = CoverCalculator::calculate_cover_flat(&grid, &shooter, &target(), 5.0);
        assert_eq!(
            legacy,
            CoverType::None,
            "flat floor-plane sampling is blind to a wall covering the body above foot level — this is the audited defect"
        );

        let cover = CoverCalculator::calculate_cover(&grid, &shooter, &target(), 5.0);
        assert_eq!(
            cover,
            CoverType::HalfCover,
            "elevation-aware corner bundle must credit a wall covering everything above the target's feet"
        );
    }

    /// DEFECT (inverse): a shooter standing on a 5 ft ledge fires over a
    /// floor-level berm at a grounded target. The legacy bundle samples only
    /// the target's base plane, so every ray dives onto the berm's own layer
    /// and it reports Total cover even though the shot arcs clean over the
    /// obstacle. Sampling the head-height corners as well shows those rays
    /// clear it by a wide margin: Half cover.
    #[test]
    fn low_wall_gives_less_cover_against_elevated_attacker() {
        let mut grid = corridor_grid();
        for gy in 3..=6 {
            grid.set_solid(WALL_X, gy, 0, true);
        }

        // Ground-level attacker vs ground-level target: the flat bundle
        // over-claims Total (its rays are dragged onto the berm's own layer),
        // while the aware bundle sees the body above it: Half.
        let ground_flat = CoverCalculator::calculate_cover_flat(&grid, &attacker(), &target(), 5.0);
        let ground = CoverCalculator::calculate_cover(&grid, &attacker(), &target(), 5.0);
        assert_eq!(ground_flat, CoverType::TotalCover);
        assert_eq!(
            ground,
            CoverType::HalfCover,
            "a single floor voxel cannot fully cover a 6 ft creature"
        );

        let ledge = Vector3::new(attacker().x, attacker().y, 5.0);
        let aware = CoverCalculator::calculate_cover(&grid, &ledge, &target(), 5.0);
        assert_eq!(
            aware,
            CoverType::HalfCover,
            "shooting over a 5 ft berm from a ledge must grant less cover than the flat bundle claims"
        );
        assert!(
            aware != CoverCalculator::calculate_cover_flat(&grid, &ledge, &target(), 5.0),
            "aware result must differ from the blind flat bundle for the elevated shooter"
        );
    }

    /// Backward compatibility: with NO meaningful z-delta anywhere (flat map,
    /// flat positions), elevation-aware results are identical tier-for-tier
    /// to the legacy single-plane bundle.
    #[test]
    fn zero_z_delta_matches_legacy_behavior_exactly() {
        // Scenario A: full-height wall -> Total.
        let mut total_grid = GridCollisionMap::new(14, 10, 4, CELL);
        for gy in 3..=6 {
            for gz in 0..4 {
                total_grid.set_solid(WALL_X, gy, gz, true);
            }
        }
        assert_eq!(
            CoverCalculator::calculate_cover(&total_grid, &attacker(), &target(), 5.0),
            CoverCalculator::calculate_cover_flat(&total_grid, &attacker(), &target(), 5.0),
            "full wall: tiers must agree"
        );
        assert_eq!(
            CoverCalculator::calculate_cover(&total_grid, &attacker(), &target(), 5.0),
            CoverType::TotalCover
        );

        // Scenario B: wall covering only the near-side corner row (y = 5)
        // -> exactly two corners occluded -> Half.
        let mut half_grid = GridCollisionMap::new(14, 10, 4, CELL);
        for gz in 0..4 {
            half_grid.set_solid(WALL_X, 5, gz, true);
        }
        assert_eq!(
            CoverCalculator::calculate_cover(&half_grid, &attacker(), &target(), 5.0),
            CoverCalculator::calculate_cover_flat(&half_grid, &attacker(), &target(), 5.0),
            "partial wall: tiers must agree"
        );
        assert_eq!(
            CoverCalculator::calculate_cover(&half_grid, &attacker(), &target(), 5.0),
            CoverType::HalfCover
        );

        // Scenario C: wall row y=4 with the attacker hugging its upper edge
        // (y=19.5) fans the corner rays so exactly three are occluded
        // -> Three-Quarters.
        let mut tq_grid = GridCollisionMap::new(14, 10, 4, CELL);
        for gz in 0..4 {
            tq_grid.set_solid(WALL_X, 4, gz, true);
        }
        let edge_hugger = Vector3::new(attacker().x, 19.5, 0.0);
        let near_target = Vector3::new(target().x - CELL, target().y, 0.0);
        assert_eq!(
            CoverCalculator::calculate_cover(&tq_grid, &edge_hugger, &near_target, 5.0),
            CoverType::ThreeQuartersCover
        );
        assert_eq!(
            CoverCalculator::calculate_cover(&tq_grid, &edge_hugger, &near_target, 5.0),
            CoverCalculator::calculate_cover_flat(&tq_grid, &edge_hugger, &near_target, 5.0)
        );

        // Scenario D: empty corridor -> None, agreeing.
        let clear = corridor_grid();
        assert_eq!(
            CoverCalculator::calculate_cover(&clear, &attacker(), &target(), 5.0),
            CoverType::None
        );
        assert_eq!(
            CoverCalculator::calculate_cover(&clear, &attacker(), &target(), 5.0),
            CoverCalculator::calculate_cover_flat(&clear, &attacker(), &target(), 5.0)
        );
    }

    /// A wall spanning the target's LOWER half only (solid below 10 ft,
    /// open above) gives a ground-level target cover but none once the
    /// attacker AND target are both lifted above it — the span follows the
    /// entity's base z, not the world origin.
    #[test]
    fn vertical_span_anchors_to_target_base_not_world_floor() {
        let mut grid = corridor_grid();
        // Wall voxels gz=0..2 (z in [0, 10)) only.
        for gy in 3..=6 {
            for gz in 0..2 {
                grid.set_solid(WALL_X, gy, gz, true);
            }
        }

        // Flying combat: base z = 12 ft puts the whole 6 ft body above the wall.
        let flyer_attacker = Vector3::new(7.5, 22.5, 12.0);
        let flyer_target = Vector3::new(57.5, 22.5, 12.0);
        let cover = CoverCalculator::calculate_cover(&grid, &flyer_attacker, &flyer_target, 5.0);
        assert_eq!(
            cover,
            CoverType::None,
            "a sub-10-ft wall must not cover a flying target whose body starts at 12 ft"
        );
    }
}
