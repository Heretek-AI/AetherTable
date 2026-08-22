export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  decay: number;
  rotation: number;
  vRot: number;
}

export interface Shockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  alpha: number;
  lineWidth: number;
}

export class ParticleFXManager {
  private particles: Particle[] = [];
  private shockwaves: Shockwave[] = [];

  public spawnGoldCritBurst(x: number, y: number, count = 40) {
    const goldTones = ['#F59E0B', '#FBBF24', '#FCD34D', '#FFFBEB', '#D97706'];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 6 + 2;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: Math.random() * 4 + 2,
        color: goldTones[Math.floor(Math.random() * goldTones.length)],
        alpha: 1.0,
        decay: Math.random() * 0.02 + 0.015,
        rotation: Math.random() * Math.PI,
        vRot: (Math.random() - 0.5) * 0.2,
      });
    }

    this.shockwaves.push({
      x,
      y,
      radius: 5,
      maxRadius: 100,
      color: '#F59E0B',
      alpha: 1.0,
      lineWidth: 4,
    });
  }

  public spawnFireballShockwave(x: number, y: number, radiusPx = 180) {
    const flameColors = ['#EA580C', '#F97316', '#FBBF24', '#DC2626'];
    for (let i = 0; i < 60; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 8 + 3;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: Math.random() * 6 + 3,
        color: flameColors[Math.floor(Math.random() * flameColors.length)],
        alpha: 1.0,
        decay: Math.random() * 0.025 + 0.02,
        rotation: Math.random() * Math.PI,
        vRot: (Math.random() - 0.5) * 0.3,
      });
    }

    this.shockwaves.push({
      x,
      y,
      radius: 10,
      maxRadius: radiusPx,
      color: '#EA580C',
      alpha: 1.0,
      lineWidth: 6,
    });
  }

  public spawnMeleeImpact(x: number, y: number) {
    const colors = ['#E11D48', '#FB7185', '#FFFFFF'];
    for (let i = 0; i < 25; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 5 + 1.5;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: Math.random() * 3 + 1.5,
        color: colors[Math.floor(Math.random() * colors.length)],
        alpha: 1.0,
        decay: Math.random() * 0.03 + 0.02,
        rotation: Math.random() * Math.PI,
        vRot: (Math.random() - 0.5) * 0.2,
      });
    }

    this.shockwaves.push({
      x,
      y,
      radius: 4,
      maxRadius: 60,
      color: '#E11D48',
      alpha: 0.9,
      lineWidth: 3,
    });
  }

  public updateAndRender(ctx: CanvasRenderingContext2D) {
    // 1. Update and Render Shockwaves
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.radius += (sw.maxRadius - sw.radius) * 0.12 + 1.5;
      sw.alpha -= 0.025;

      if (sw.alpha <= 0 || sw.radius >= sw.maxRadius) {
        this.shockwaves.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
      ctx.strokeStyle = sw.color;
      ctx.globalAlpha = Math.max(0, sw.alpha);
      ctx.lineWidth = sw.lineWidth;
      ctx.shadowColor = sw.color;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.restore();
    }

    // 2. Update and Render Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.94;
      p.vy *= 0.94;
      p.rotation += p.vRot;
      p.alpha -= p.decay;

      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.beginPath();
      ctx.arc(0, 0, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.restore();
    }
  }

  public hasActiveEffects(): boolean {
    return this.particles.length > 0 || this.shockwaves.length > 0;
  }
}
