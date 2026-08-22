use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RangeBand {
    Engaged, // 0 - 5 ft (melee)
    Near,    // 5 - 30 ft (close range spells, 1 move action)
    Far,     // 30 - 60 ft (standard ranged attacks)
    Distant, // 60+ ft (longbow, extreme distance)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneNode {
    pub zone_id: String,
    pub name: String,
    pub description: String,
    pub environmental_tags: Vec<String>,
    pub max_capacity: Option<usize>,
    pub is_hazardous: bool,
    pub hazard_damage_formula: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneEdge {
    pub from_zone: String,
    pub to_zone: String,
    pub base_range_band: RangeBand,
    pub movement_cost_actions: u32,
    pub is_blocked: bool,
    pub requires_climb_or_fly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TopologicalZoneGraph {
    pub zones: HashMap<String, ZoneNode>,
    pub edges: Vec<ZoneEdge>,
}

impl TopologicalZoneGraph {
    pub fn new() -> Self {
        Self {
            zones: HashMap::new(),
            edges: Vec::new(),
        }
    }

    pub fn add_zone(&mut self, zone: ZoneNode) {
        self.zones.insert(zone.zone_id.clone(), zone);
    }

    pub fn add_edge(&mut self, edge: ZoneEdge) {
        self.edges.push(edge);
    }

    pub fn get_range_between_zones(&self, from: &str, to: &str) -> Option<RangeBand> {
        if from == to {
            return Some(RangeBand::Engaged);
        }

        for edge in &self.edges {
            if (edge.from_zone == from && edge.to_zone == to) ||
               (edge.from_zone == to && edge.to_zone == from) {
                return Some(edge.base_range_band);
            }
        }
        None
    }
}
