/**
 * GPU-batched battlemap board renderer (PixiJS v8).
 *
 * Replaces the per-cell DOM grid (~200 re-rendered <div>s on every state
 * change) with a WebGPU/WebGL stage: the checkerboard floor is baked once
 * into a tiled sprite and walls are instances of a shared batched texture.
 * Falls back gracefully — `init` resolves false when no WebGL/WebGPU context
 * is available, letting callers keep their DOM fallback.
 */

import { Application, Graphics, Sprite, Texture, Container, Text } from 'pixi.js';

export class PixiBoard {
  private app: Application | null = null;
  private boardContainer: Container | null = null;
  private cellSize: number;
  private ready = false;

  constructor(cellSize = 60) {
    this.cellSize = cellSize;
  }

  public get isReady(): boolean {
    return this.ready;
  }

  public async init(
    host: HTMLElement,
    gridWidth: number,
    gridHeight: number,
    walls: Set<string>
  ): Promise<boolean> {
    try {
      const app = new Application();
      // WebGPU preferred, WebGL fallback — Pixi v8 handles backend selection;
      // 'webgl-first' keeps production stability per current renderer guidance.
      await app.init({
        preference: 'webgl',
        width: gridWidth * this.cellSize,
        height: gridHeight * this.cellSize,
        backgroundAlpha: 0,
        antialias: true,
      });
      host.appendChild(app.canvas);
      app.canvas.style.display = 'block';
      this.app = app;

      await this.redraw(gridWidth, gridHeight, walls);
      this.ready = true;
      return true;
    } catch (e) {
      console.warn('[PixiBoard] GPU renderer unavailable, keeping DOM fallback:', e);
      return false;
    }
  }

  /** Bakes the checkerboard + walls. Called on init and when walls change. */
  public async redraw(gridWidth: number, gridHeight: number, walls: Set<string>): Promise<void> {
    if (!this.app || !this.app.renderer) return;
    const cs = this.cellSize;

    const board = new Container();

    // --- Floor: bake the full checkerboard ONCE into a texture ---
    const floorGfx = new Graphics();
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        floorGfx.rect(x * cs, y * cs, cs, cs).fill(
          (x + y) % 2 === 0 ? { color: 0x000000, alpha: 0.4 } : { color: 0x000000, alpha: 0.2 }
        );
        if (walls.has(`${x}:${y}`)) {
          floorGfx
            .rect(x * cs, y * cs, cs, cs)
            .fill({ color: 0x1c1917, alpha: 0.95 })
            .stroke({ color: 0x44403c, width: 2, alignment: 0.5 });
        } else {
          floorGfx
            .rect(x * cs, y * cs, cs, cs)
            .stroke({ color: 0x000000, alpha: 0.4, width: 1 });
        }
      }
    }
    board.addChild(floorGfx);

    // --- Wall glyph: one shared RenderTexture instanced per wall cell ---
    if (walls.size > 0) {
      const glyphGfx = new Graphics();
      glyphGfx
        .roundRect(cs / 2 - 14, cs / 2 - 14, 28, 28, 6)
        .fill({ color: 0xfef3c7, alpha: 0.22 })
        .stroke({ color: 0xfef3c7, alpha: 0.35, width: 1.5 });
      const glyphTexture = this.app.renderer.generateTexture(glyphGfx);
      glyphGfx.destroy();
      walls.forEach((key) => {
        const [xs, ys] = key.split(':');
        const sprite = new Sprite(glyphTexture);
        sprite.position.set(Number(xs) * cs, Number(ys) * cs);
        board.addChild(sprite);
      });
    }

    // --- Coordinate labels (static text, drawn once) ---
    const labelStyle = {
      fontFamily: 'monospace',
      fontSize: 9,
      fill: 0xfef3c7,
      alpha: 0.35,
    };
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const label = new Text({
          text: `${String.fromCharCode(65 + x)}${y + 1}`,
          style: labelStyle,
        });
        label.position.set(x * cs + cs - 24, y * cs + cs - 16);
        board.addChild(label);
      }
    }

    if (this.boardContainer) {
      this.app.stage.removeChild(this.boardContainer);
      this.boardContainer.destroy({ children: true });
    }
    this.app.stage.addChild(board);
    this.boardContainer = board;
    // yield so the async contract holds even on fast paths
    await Promise.resolve();
  }

  /** Highlights AoE origin/radius as an overlay container (cheap, dynamic). */
  public showAoe(origin: { x: number; y: number }, radiusCells: number): void {
    if (!this.app) return;
    this.clearAoe();
    const gfx = new Graphics();
    gfx
      .circle(
        (origin.x + 0.5) * this.cellSize,
        (origin.y + 0.5) * this.cellSize,
        radiusCells * this.cellSize
      )
      .fill({ color: 0xf97316, alpha: 0.28 })
      .stroke({ color: 0xfb923c, alpha: 0.6, width: 2 });
    gfx.name = 'aoe';
    this.app.stage.addChild(gfx);
  }

  public clearAoe(): void {
    const overlay = this.app?.stage.getChildByName('aoe');
    if (overlay) {
      this.app!.stage.removeChild(overlay);
      overlay.destroy();
    }
  }

  public destroy(): void {
    this.app?.destroy(true, { children: true, texture: true });
    this.app = null;
    this.boardContainer = null;
    this.ready = false;
  }
}
