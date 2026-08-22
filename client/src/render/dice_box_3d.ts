export interface ActiveDiceRoll {
  id: string;
  dieType: 'd20' | 'd12' | 'd8' | 'd6' | 'd4';
  targetValue: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  progress: number; // 0 to 1
  rotation: number;
  scale: number;
  settled: boolean;
}

export class DiceBox3D {
  private activeRolls: ActiveDiceRoll[] = [];

  public rollDice(
    dieType: 'd20' | 'd12' | 'd8' | 'd6' | 'd4',
    targetValue: number,
    targetX: number,
    targetY: number
  ) {
    const roll: ActiveDiceRoll = {
      id: `dice_${Date.now()}_${Math.random()}`,
      dieType,
      targetValue,
      startX: targetX + (Math.random() - 0.5) * 180,
      startY: targetY - 220,
      currentX: targetX + (Math.random() - 0.5) * 180,
      currentY: targetY - 220,
      targetX,
      targetY,
      progress: 0,
      rotation: 0,
      scale: 1.6,
      settled: false,
    };
    this.activeRolls.push(roll);
  }

  public updateAndRender(
    ctx: CanvasRenderingContext2D,
    onSettle?: (roll: ActiveDiceRoll) => void
  ) {
    for (let i = this.activeRolls.length - 1; i >= 0; i--) {
      const roll = this.activeRolls[i];

      if (!roll.settled) {
        roll.progress += 0.035;
        if (roll.progress >= 1.0) {
          roll.progress = 1.0;
          roll.settled = true;
          roll.currentX = roll.targetX;
          roll.currentY = roll.targetY;
          roll.scale = 1.0;
          if (onSettle) onSettle(roll);
        } else {
          // Parabolic bounce curve
          const t = roll.progress;
          const bounce = Math.sin(t * Math.PI) * 40;
          roll.currentX = roll.startX + (roll.targetX - roll.startX) * t;
          roll.currentY = roll.startY + (roll.targetY - roll.startY) * t - bounce;
          roll.rotation += 0.35 * (1 - t);
          roll.scale = 1.6 - 0.6 * t;
        }
      }

      this.renderDie(ctx, roll);

      // Remove settled dice after 3.5 seconds
      if (roll.settled && roll.progress >= 1.0) {
        roll.progress += 0.01;
        if (roll.progress > 2.5) {
          this.activeRolls.splice(i, 1);
        }
      }
    }
  }

  private renderDie(ctx: CanvasRenderingContext2D, roll: ActiveDiceRoll) {
    ctx.save();
    ctx.translate(roll.currentX, roll.currentY);
    ctx.rotate(roll.rotation);
    ctx.scale(roll.scale, roll.scale);

    const isCrit20 = roll.dieType === 'd20' && roll.targetValue === 20;
    const isCritFail = roll.dieType === 'd20' && roll.targetValue === 1;

    // Polyhedral Icosahedron Shadow
    ctx.beginPath();
    ctx.arc(0, 5, 24, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.filter = 'blur(4px)';
    ctx.fill();
    ctx.filter = 'none';

    // Die Body (Hexagonal Icosahedron projection)
    ctx.beginPath();
    const sides = 6;
    const radius = 22;
    for (let s = 0; s < sides; s++) {
      const angle = (s * 2 * Math.PI) / sides - Math.PI / 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Die Material Colors
    ctx.fillStyle = isCrit20
      ? '#7C3AED'
      : isCritFail
      ? '#DC2626'
      : '#1E293B';
    ctx.strokeStyle = isCrit20
      ? '#F59E0B'
      : isCritFail
      ? '#F87171'
      : '#64748B';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = isCrit20 ? '#F59E0B' : '#7C3AED';
    ctx.shadowBlur = roll.settled ? 12 : 6;
    ctx.fill();
    ctx.stroke();

    // Inner facets (3D triangular facets)
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let s = 0; s < sides; s++) {
      const angle = (s * 2 * Math.PI) / sides - Math.PI / 2;
      ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
      ctx.moveTo(0, 0);
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Die Face Number
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 13px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 4;
    ctx.fillText(String(roll.targetValue), 0, 1);

    ctx.restore();
  }

  public hasActiveRolls(): boolean {
    return this.activeRolls.length > 0;
  }
}
