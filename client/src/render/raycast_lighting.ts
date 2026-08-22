export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  a: Point;
  b: Point;
}

export class RaycastLighting {
  private segments: Segment[] = [];

  public updateWalls(walls: { x: number; y: number }[], cellSize: number, gridWidth: number, gridHeight: number) {
    this.segments = [];

    // Outer boundary walls
    const w = gridWidth * cellSize;
    const h = gridHeight * cellSize;
    this.segments.push({ a: { x: 0, y: 0 }, b: { x: w, y: 0 } });
    this.segments.push({ a: { x: w, y: 0 }, b: { x: w, y: h } });
    this.segments.push({ a: { x: w, y: h }, b: { x: 0, y: h } });
    this.segments.push({ a: { x: 0, y: h }, b: { x: 0, y: 0 } });

    // Wall obstacles as 4 bounding segments per cell
    walls.forEach((wall) => {
      const x1 = wall.x * cellSize;
      const y1 = wall.y * cellSize;
      const x2 = x1 + cellSize;
      const y2 = y1 + cellSize;

      this.segments.push({ a: { x: x1, y: y1 }, b: { x: x2, y: y1 } });
      this.segments.push({ a: { x: x2, y: y1 }, b: { x: x2, y: y2 } });
      this.segments.push({ a: { x: x2, y: y2 }, b: { x: x1, y: y2 } });
      this.segments.push({ a: { x: x1, y: y2 }, b: { x: x1, y: y1 } });
    });
  }

  public computeVisibilityPolygon(source: Point, maxRadius: number = 600): Point[] {
    const uniqueAngles: number[] = [];

    // Collect all vertex angles + / - tiny epsilon for raycasting
    this.segments.forEach((seg) => {
      [seg.a, seg.b].forEach((pt) => {
        const angle = Math.atan2(pt.y - source.y, pt.x - source.x);
        uniqueAngles.push(angle - 0.0001, angle, angle + 0.0001);
      });
    });

    // Add cardinal rays
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      uniqueAngles.push(a);
    }

    const intersections: { angle: number; pt: Point; dist: number }[] = [];

    uniqueAngles.forEach((angle) => {
      const rayDir = { x: Math.cos(angle), y: Math.sin(angle) };
      const rayEnd = { x: source.x + rayDir.x * maxRadius, y: source.y + rayDir.y * maxRadius };

      let closestIntersect: Point | null = null;
      let closestDist = maxRadius;

      this.segments.forEach((seg) => {
        const hit = this.getRaySegmentIntersection(source, rayEnd, seg.a, seg.b);
        if (hit) {
          const dx = hit.x - source.x;
          const dy = hit.y - source.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < closestDist) {
            closestDist = dist;
            closestIntersect = hit;
          }
        }
      });

      if (closestIntersect) {
        intersections.push({ angle, pt: closestIntersect, dist: closestDist });
      } else {
        intersections.push({ angle, pt: rayEnd, dist: maxRadius });
      }
    });

    // Sort polygon vertices clockwise
    intersections.sort((a, b) => a.angle - b.angle);

    return intersections.map((i) => i.pt);
  }

  private getRaySegmentIntersection(rA: Point, rB: Point, sA: Point, sB: Point): Point | null {
    const r_px = rA.x;
    const r_py = rA.y;
    const r_dx = rB.x - rA.x;
    const r_dy = rB.y - rA.y;

    const s_px = sA.x;
    const s_py = sA.y;
    const s_dx = sB.x - sA.x;
    const s_dy = sB.y - sA.y;

    const r_mag = Math.sqrt(r_dx * r_dx + r_dy * r_dy);
    const s_mag = Math.sqrt(s_dx * s_dx + s_dy * s_dy);

    if (r_dx / r_mag === s_dx / s_mag && r_dy / r_mag === s_dy / s_mag) {
      return null;
    }

    const denominator = s_dx * r_dy - s_dy * r_dx;
    if (Math.abs(denominator) < 0.000001) return null;

    const t2 = (r_dx * (s_py - r_py) + r_dy * (r_px - s_px)) / denominator;
    const t1 = (s_px + s_dx * t2 - r_px) / r_dx;

    if (t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1) {
      return {
        x: r_px + r_dx * t1,
        y: r_py + r_dy * t1,
      };
    }

    return null;
  }

  public renderLightingMask(
    ctx: CanvasRenderingContext2D,
    source: Point,
    width: number,
    height: number,
    radius: number = 380
  ) {
    this.renderMultiSourceLightingMask(ctx, [source], width, height, radius);
  }

  public renderMultiSourceLightingMask(
    ctx: CanvasRenderingContext2D,
    sources: Point[],
    width: number,
    height: number,
    radius: number = 380
  ) {
    if (sources.length === 0) return;

    ctx.save();
    // Ambient darkness layer
    ctx.fillStyle = 'rgba(3, 7, 18, 0.70)';
    ctx.fillRect(0, 0, width, height);

    // Punch out illuminated vision polygons for each light source
    ctx.globalCompositeOperation = 'destination-out';

    sources.forEach((source) => {
      const poly = this.computeVisibilityPolygon(source, radius);
      if (poly.length < 3) return;

      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(poly[i].x, poly[i].y);
      }
      ctx.closePath();

      // Radial gradient feather
      const grad = ctx.createRadialGradient(source.x, source.y, 40, source.x, source.y, radius);
      grad.addColorStop(0, 'rgba(0, 0, 0, 1.0)');
      grad.addColorStop(0.85, 'rgba(0, 0, 0, 0.9)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
      ctx.fillStyle = grad;
      ctx.fill();
    });

    ctx.restore();
  }
}
