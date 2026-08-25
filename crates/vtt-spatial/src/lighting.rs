//! Lighting zones and vision-mode-aware line of sight.
//!
//! GOALS.md Pillar 4: grid-cell visibility semantics against wall/door
//! occluders, evaluating vision modes (Normal, Darkvision, Blindsight,
//! Truesight) across lighting zones (Bright, Dim, Darkness, Magical
//! Darkness). Ray-cast visibility POLYGONS are out of scope — this module is
//! strictly per-cell semantics.
//!
//! PHB-style rules modeled here (PHB ch. 9, "Vision and Light" / "Vision
//! and Light effects"):
//! - **Bright / Dim light**: visible to every mode within line of sight. Dim
//!   light is light obscurement only — no mechanical penalty is applied yet.
//! - **Darkness** (non-magical): heavily obscured; a creature with normal
//!   sight suffers blindness (cannot see). Darkvision sees within its range
//!   as if in dim light. Blindsight perceives within range without relying
//!   on sight. Truesight sees normally within range.
//! - **Magical darkness**: created by spells (e.g. *Darkness* with a higher
//!   slot or similar effects); darkvision does NOT penetrate it. Only
//!   Truesight — and Blindsight, which does not rely on sight — see through.
//! - **Beyond a sense's range**: the sense stops working and the viewer is
//!   treated as having normal sight there, so darkness/magical darkness is
//!   invisible again.

use crate::geometry::Vector3;
use crate::raycast::GridCollisionMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use vtt_core::types::{LightingZone, LightingZoneCell, VisionMode};

// LightingZone/LightingZoneCell are defined in vtt-core (session maps and
// spatial overlays share one definition) and re-exported at this crate's root.

/// Per-cell lighting overlay for a battle map — the lighting analogue of
/// [`crate::pathfinding::TerrainOverlay`]. Cells absent from the map are
/// Bright by convention (`zone_at`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct LightingOverlay {
    pub zones: HashMap<(usize, usize, usize), LightingZone>,
}

impl LightingOverlay {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_zone(&mut self, x: usize, y: usize, z: usize, zone: LightingZone) {
        self.zones.insert((x, y, z), zone);
    }

    /// The lighting zone at a cell; absent cells are Bright.
    pub fn zone_at(&self, x: usize, y: usize, z: usize) -> LightingZone {
        self.zones
            .get(&(x, y, z))
            .copied()
            .unwrap_or(LightingZone::Bright)
    }

    /// Builds an overlay from a session map's declared lighting cells
    /// (2D maps are stored at z = 0).
    pub fn from_cells(cells: &[LightingZoneCell]) -> Self {
        let mut overlay = Self::new();
        for cell in cells {
            overlay.set_zone(cell.x, cell.y, 0, cell.zone);
        }
        overlay
    }
}

/// Pure visibility predicate for ONE cell: can `mode` see into `zone` at
/// `distance_feet` given a sense range of `sense_range_feet`?
///
/// Pass `f32::INFINITY` as `sense_range_feet` for unlimited (normal) sight.
/// This is the single source of truth for the mode × zone × range matrix —
/// the grid-level raycast below composes it over the Bresenham path.
pub fn cell_visible(
    zone: LightingZone,
    mode: VisionMode,
    sense_range_feet: f32,
    distance_feet: f32,
) -> bool {
    // Beyond its range a special sense reverts to ordinary sight (so
    // darkness becomes invisible again). Normal sight ignores the range gate.
    let within_range = distance_feet <= sense_range_feet;
    match zone {
        // Bright and dim light are visible to all modes at any distance;
        // dim light is obscurement without a mechanical penalty (yet).
        LightingZone::Bright | LightingZone::Dim => true,
        LightingZone::Darkness => match mode {
            VisionMode::Normal => false,
            VisionMode::Darkvision | VisionMode::Blindsight | VisionMode::Truesight => within_range,
        },
        LightingZone::MagicalDarkness => match mode {
            // Darkvision explicitly fails against magical darkness.
            VisionMode::Normal | VisionMode::Darkvision => false,
            VisionMode::Truesight | VisionMode::Blindsight => within_range,
        },
    }
}

impl GridCollisionMap {
    /// Lighting-aware line of sight for a VIEWER WITH A CONDITION STATE.
    ///
    /// The Blinded condition (SRD 5e PHB appendix A) suppresses every
    /// special sense: darkvision, blindsight, and truesight all stop helping
    /// because the creature cannot see, so the viewer is evaluated as
    /// ordinary normal sight (unlimited range, no darkness penetration).
    /// Obscured cells anywhere on the ray therefore fail the check no matter
    /// which vision mode the entity nominally has — "blinded overrides
    /// darkvision benefits". In fully lit cells ordinary sight still works,
    /// which is deliberate: SRD blindness penalizes the blind ATTACKER'S
    /// roll (disadvantage, see
    /// `vtt_core::rules::RulesEvaluator::edge_from_conditions`) rather than
    /// making them unable to swing at a lit target at all.
    ///
    /// Documented simplification: RAW arguably lets blindsight (which does
    /// not rely on sight) keep functioning while blinded; this engine models
    /// the condition as suppressing ALL senses for one uniform rule.
    ///
    /// `viewer_is_blinded = false` reproduces
    /// [`Self::has_line_of_sight_with_lighting`] exactly, so legacy callers
    /// without condition data keep their behavior unchanged.
    pub fn has_line_of_sight_for_viewer(
        &self,
        lighting: &LightingOverlay,
        mode: VisionMode,
        sense_range_feet: f32,
        viewer_is_blinded: bool,
        start: &Vector3,
        end: &Vector3,
    ) -> bool {
        if viewer_is_blinded {
            return self.has_line_of_sight_with_lighting(
                lighting,
                VisionMode::Normal,
                f32::INFINITY,
                start,
                end,
            );
        }
        self.has_line_of_sight_with_lighting(lighting, mode, sense_range_feet, start, end)
    }

    /// Lighting-aware line of sight: the same wall/occluder Bresenham test as
    /// [`GridCollisionMap::has_line_of_sight`], PLUS a walk over every cell on
    /// the ray — any cell the viewer's sense cannot see into at that distance
    /// (including the target cell) blocks sight. A belt of darkness between
    /// viewer and target therefore blocks normal sight even when the target
    /// itself stands in bright light.
    ///
    /// Additive API: calling this with an empty [`LightingOverlay`] and
    /// unlimited range reproduces plain `has_line_of_sight` exactly, so
    /// existing callers without lighting data keep working unchanged.
    pub fn has_line_of_sight_with_lighting(
        &self,
        lighting: &LightingOverlay,
        mode: VisionMode,
        sense_range_feet: f32,
        start: &Vector3,
        end: &Vector3,
    ) -> bool {
        if !self.has_line_of_sight(start, end) {
            return false;
        }

        let half = self.cell_size_feet / 2.0;
        for &(x, y, z) in &self.line_cells(start, end).as_slice()[1..] {
            // Skip lit cells cheaply; they never block.
            if lighting.zone_at(x, y, z) == LightingZone::Bright {
                continue;
            }
            let center = Vector3::new(
                x as f32 * self.cell_size_feet + half,
                y as f32 * self.cell_size_feet + half,
                z as f32 * self.cell_size_feet + half,
            );
            let distance = start.distance_to(&center);
            if !cell_visible(lighting.zone_at(x, y, z), mode, sense_range_feet, distance) {
                return false;
            }
        }
        true
    }

    /// Ordered grid cells along the Bresenham ray from `start` to `end`,
    /// inclusive of both endpoints. Shared by the occlusion test and the
    /// lighting walk so the two can never disagree about which cells a ray
    /// crosses.
    pub fn line_cells(&self, start: &Vector3, end: &Vector3) -> Vec<(usize, usize, usize)> {
        let (x0, y0, z0) = self.world_to_grid(start);
        let (x1, y1, z1) = self.world_to_grid(end);

        let mut x = x0 as i32;
        let mut y = y0 as i32;
        let mut z = z0 as i32;

        let dx = (x1 as i32 - x0 as i32).abs();
        let dy = (y1 as i32 - y0 as i32).abs();
        let dz = (z1 as i32 - z0 as i32).abs();

        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let sz = if z0 < z1 { 1 } else { -1 };

        let dm = dx.max(dy).max(dz);
        let mut i = dm;

        let mut x_err = dm / 2;
        let mut y_err = dm / 2;
        let mut z_err = dm / 2;

        let mut cells = Vec::with_capacity(dm as usize + 1);
        cells.push((x0, y0, z0));

        while i > 0 {
            x_err -= dx;
            if x_err < 0 {
                x_err += dm;
                x += sx;
            }

            y_err -= dy;
            if y_err < 0 {
                y_err += dm;
                y += sy;
            }

            z_err -= dz;
            if z_err < 0 {
                z_err += dm;
                z += sz;
            }

            i -= 1;
            cells.push((x as usize, y as usize, z as usize));
        }

        cells
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_overlay_from_session_map_cells_lands_at_z_zero() {
        let overlay = LightingOverlay::from_cells(&[LightingZoneCell {
            x: 1,
            y: 2,
            zone: LightingZone::Dim,
        }]);
        assert_eq!(overlay.zone_at(1, 2, 0), LightingZone::Dim);
        assert_eq!(overlay.zone_at(0, 0, 0), LightingZone::Bright);
    }
}
