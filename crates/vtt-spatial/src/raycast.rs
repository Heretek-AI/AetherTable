use crate::geometry::Vector3;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GridCollisionMap {
    pub width: usize,
    pub height: usize,
    pub depth: usize,
    pub cell_size_feet: f32,
    pub solid_cells: Vec<bool>,
}

impl GridCollisionMap {
    pub fn new(width: usize, height: usize, depth: usize, cell_size_feet: f32) -> Self {
        Self {
            width,
            height,
            depth,
            cell_size_feet,
            solid_cells: vec![false; width * height * depth],
        }
    }

    pub fn get_index(&self, x: usize, y: usize, z: usize) -> Option<usize> {
        if x < self.width && y < self.height && z < self.depth {
            Some(z * self.width * self.height + y * self.width + x)
        } else {
            None
        }
    }

    pub fn is_solid(&self, x: usize, y: usize, z: usize) -> bool {
        if let Some(idx) = self.get_index(x, y, z) {
            self.solid_cells[idx]
        } else {
            true // out of bounds treated as solid
        }
    }

    pub fn set_solid(&mut self, x: usize, y: usize, z: usize, solid: bool) {
        if let Some(idx) = self.get_index(x, y, z) {
            self.solid_cells[idx] = solid;
        }
    }

    pub fn world_to_grid(&self, pos: &Vector3) -> (usize, usize, usize) {
        let gx = (pos.x / self.cell_size_feet).floor().max(0.0) as usize;
        let gy = (pos.y / self.cell_size_feet).floor().max(0.0) as usize;
        let gz = (pos.z / self.cell_size_feet).floor().max(0.0) as usize;
        (gx.min(self.width.saturating_sub(1)), gy.min(self.height.saturating_sub(1)), gz.min(self.depth.saturating_sub(1)))
    }

    /// 3D Bresenham Raycast for Line-of-Sight (LoS)
    pub fn has_line_of_sight(&self, start: &Vector3, end: &Vector3) -> bool {
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

        while i > 0 {
            if (x as usize, y as usize, z as usize) != (x0, y0, z0) &&
               (x as usize, y as usize, z as usize) != (x1, y1, z1) &&
               self.is_solid(x as usize, y as usize, z as usize) {
                return false;
            }

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
        }

        true
    }
}
