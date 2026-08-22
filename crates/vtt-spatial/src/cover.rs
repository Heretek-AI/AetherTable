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

impl CoverCalculator {
    /// Casts ray bundle (4 corner samples) from attacker to target
    pub fn calculate_cover(
        grid: &GridCollisionMap,
        attacker_pos: &Vector3,
        target_pos: &Vector3,
        target_radius_feet: f32,
    ) -> CoverType {
        let half_r = (target_radius_feet / 2.0).max(1.0);

        let target_corners = [
            Vector3::new(target_pos.x - half_r, target_pos.y - half_r, target_pos.z),
            Vector3::new(target_pos.x + half_r, target_pos.y - half_r, target_pos.z),
            Vector3::new(target_pos.x - half_r, target_pos.y + half_r, target_pos.z),
            Vector3::new(target_pos.x + half_r, target_pos.y + half_r, target_pos.z),
        ];

        let mut blocked_rays = 0;
        for corner in &target_corners {
            if !grid.has_line_of_sight(attacker_pos, corner) {
                blocked_rays += 1;
            }
        }

        match blocked_rays {
            0 => CoverType::None,
            1..=2 => CoverType::HalfCover,
            3 => CoverType::ThreeQuartersCover,
            _ => CoverType::TotalCover,
        }
    }
}
