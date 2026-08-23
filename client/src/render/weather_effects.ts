export type WeatherType = 'none' | 'rain' | 'snow' | 'embers' | 'fog';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
  color: string;
}

export class WeatherEffectsManager {
  private particles: Particle[] = [];
  private currentWeather: WeatherType = 'none';
  private lightningTimer: number = 0;
  private isLightningFlash: boolean = false;

  public setWeather(weather: WeatherType) {
    this.currentWeather = weather;
    this.particles = [];
    this.lightningTimer = 0;
    this.isLightningFlash = false;
  }

  public getWeather(): WeatherType {
    return this.currentWeather;
  }

  public updateAndRender(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (this.currentWeather === 'none') return;

    // Spawn particles based on weather type
    this.spawnParticles(width, height);

    // Render Lightning Flash
    if (this.currentWeather === 'rain') {
      this.handleLightning(ctx, width, height);
    }

    // Update and draw existing particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life++;

      // Wrap around bounds
      if (p.y > height) p.y = 0;
      if (p.y < 0) p.y = height;
      if (p.x > width) p.x = 0;
      if (p.x < 0) p.x = width;

      // Draw particle
      ctx.save();
      ctx.globalAlpha = p.alpha * (1 - p.life / p.maxLife);

      if (this.currentWeather === 'rain') {
        ctx.strokeStyle = '#60a5fa';
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 2, p.y + p.vy * 2);
        ctx.stroke();
      } else if (this.currentWeather === 'snow') {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (this.currentWeather === 'embers') {
        ctx.fillStyle = p.color;
        ctx.shadowColor = '#f97316';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (this.currentWeather === 'fog') {
        ctx.fillStyle = 'rgba(203, 213, 225, 0.08)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 10, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
      }
    }
  }

  private spawnParticles(width: number, height: number) {
    const maxParticles =
      this.currentWeather === 'rain'
        ? 150
        : this.currentWeather === 'snow'
        ? 100
        : this.currentWeather === 'embers'
        ? 60
        : 25; // fog

    if (this.particles.length < maxParticles) {
      if (this.currentWeather === 'rain') {
        this.particles.push({
          x: Math.random() * width,
          y: Math.random() * -20,
          vx: -1 - Math.random() * 2,
          vy: 12 + Math.random() * 8,
          size: 1.5,
          alpha: 0.7 + Math.random() * 0.3,
          life: 0,
          maxLife: 60,
          color: '#60a5fa',
        });
      } else if (this.currentWeather === 'snow') {
        this.particles.push({
          x: Math.random() * width,
          y: Math.random() * -10,
          vx: Math.sin(Math.random() * 6.28) * 0.8,
          vy: 1 + Math.random() * 2,
          size: 2 + Math.random() * 2.5,
          alpha: 0.8,
          life: 0,
          maxLife: 240,
          color: '#ffffff',
        });
      } else if (this.currentWeather === 'embers') {
        const colors = ['#ea580c', '#f97316', '#fbbf24', '#ef4444'];
        this.particles.push({
          x: Math.random() * width,
          y: height + Math.random() * 10,
          vx: (Math.random() - 0.5) * 1.5,
          vy: -1.5 - Math.random() * 2.5,
          size: 1.5 + Math.random() * 2,
          alpha: 0.9,
          life: 0,
          maxLife: 120,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      } else if (this.currentWeather === 'fog') {
        this.particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: 0.2 + Math.random() * 0.3,
          vy: (Math.random() - 0.5) * 0.1,
          size: 8 + Math.random() * 12,
          alpha: 0.12,
          life: 0,
          maxLife: 300,
          color: 'rgba(226, 232, 240, 0.15)',
        });
      }
    }
  }

  private handleLightning(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.lightningTimer++;
    if (this.lightningTimer > 200 && Math.random() < 0.01) {
      this.isLightningFlash = true;
      this.lightningTimer = 0;
      setTimeout(() => {
        this.isLightningFlash = false;
      }, 80);
    }

    if (this.isLightningFlash) {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
  }
}
