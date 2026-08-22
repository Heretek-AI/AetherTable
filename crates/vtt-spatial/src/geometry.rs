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

    pub fn manhattan_distance(&self, other: &Vector3) -> f32 {
        (self.x - other.x).abs() + (self.y - other.y).abs() + (self.z - other.z).abs()
    }

    pub fn chebyshev_distance(&self, other: &Vector3) -> f32 {
        (self.x - other.x).abs().max((self.y - other.y).abs()).max((self.z - other.z).abs())
    }

    pub fn normalize(&self) -> Vector3 {
        let len = (self.x * self.x + self.y * self.y + self.z * self.z).sqrt();
        if len > 0.0 {
            Vector3::new(self.x / len, self.y / len, self.z / len)
        } else {
            *self
        }
    }

    pub fn dot(&self, other: &Vector3) -> f32 {
        self.x * other.x + self.y * other.y + self.z * other.z
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

impl AreaOfEffect {
    pub fn contains_point(&self, point: &Vector3) -> bool {
        match self {
            AreaOfEffect::Sphere { center, radius_feet } => {
                center.distance_to(point) <= *radius_feet
            }
            AreaOfEffect::Cube { origin, size_feet } => {
                point.x >= origin.x && point.x <= origin.x + size_feet &&
                point.y >= origin.y && point.y <= origin.y + size_feet &&
                point.z >= origin.z && point.z <= origin.z + size_feet
            }
            AreaOfEffect::Cone { origin, direction, length_feet, angle_degrees } => {
                let dist = origin.distance_to(point);
                if dist > *length_feet || dist == 0.0 {
                    return dist == 0.0;
                }
                let to_point = Vector3::new(
                    (point.x - origin.x) / dist,
                    (point.y - origin.y) / dist,
                    (point.z - origin.z) / dist,
                );
                let dir_norm = direction.normalize();
                let dot_prod = dir_norm.dot(&to_point);
                let cos_half_angle = (angle_degrees / 2.0).to_radians().cos();
                dot_prod >= cos_half_angle
            }
            AreaOfEffect::Line { start, end, width_feet } => {
                let seg_len = start.distance_to(end);
                if seg_len == 0.0 {
                    return start.distance_to(point) <= *width_feet / 2.0;
                }
                let u = (((point.x - start.x) * (end.x - start.x)
                    + (point.y - start.y) * (end.y - start.y)
                    + (point.z - start.z) * (end.z - start.z))
                    / (seg_len * seg_len)).clamp(0.0, 1.0);
                let proj = Vector3::new(
                    start.x + u * (end.x - start.x),
                    start.y + u * (end.y - start.y),
                    start.z + u * (end.z - start.z),
                );
                proj.distance_to(point) <= *width_feet / 2.0
            }
            AreaOfEffect::Cylinder { center, radius_feet, height_feet } => {
                let dist_2d = center.distance_2d(point);
                let dz = point.z - center.z;
                dist_2d <= *radius_feet && dz >= 0.0 && dz <= *height_feet
            }
        }
    }
}
