use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vector3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vector3 {
    pub fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    pub fn distance_to(&self, other: &Vector3) -> f32 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        let dz = self.z - other.z;
        (dx * dx + dy * dy + dz * dz).sqrt()
    }

    pub fn distance_2d(&self, other: &Vector3) -> f32 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        (dx * dx + dy * dy).sqrt()
    }

    }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AreaOfEffect {
    Sphere { center: Vector3, radius_feet: f32 },
    Cube { origin: Vector3, size_feet: f32 },
    Cone { origin: Vector3, direction: Vector3, length_feet: f32, angle_degrees: f32 },
    Line { start: Vector3, end: Vector3, width_feet: f32 },
    Cylinder { center: Vector3, radius_feet: f32, height_feet: f32 },
}

impl Vector3 {
    }
