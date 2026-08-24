/**
 * Physics-based 3D dice renderer (@3d-dice/dice-box: three.js + ammo.wasm).
 *
 * Replaces the scripted 2D "3D" dice animation with real rigid-body tumbling
 * whose FINAL FACES ARE PREDETERMINED by the authoritative server roll — the
 * animation is cosmetic, the outcome is never generated client-side.
 */

// @3d-dice/dice-box ships no TypeScript declarations.
type DiceBoxCtor = new (config: Record<string, unknown>) => DiceBoxInstance;

type DiceBoxInstance = {
  init: () => Promise<unknown>;
  roll: (rolls: Array<{ type: string; value?: number; themeColor?: string }>) => Promise<unknown> | unknown;
  add: (rolls: Array<{ type: string; value?: number }>) => unknown;
  clear: () => void;
  destroy: () => void;
};

export class ServerDiceBox {
  private box: DiceBoxInstance | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private parentElementId: string,
    private defaultTheme = 'default'
  ) {}

  /** Lazily loads the WASM physics world on first use. */
  public async ensureInit(): Promise<void> {
    if (this.box) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const mod = (await import('@3d-dice/dice-box')) as unknown as { default: DiceBoxCtor };
        this.box = new mod.default({
          id: this.parentElementId,
          assetPath: '/dice-box/assets/',
          theme: this.defaultTheme,
          gravity: 1.2,
          scale: 100,
          lightIntensity: 0.9,
        });
        await this.box.init();
      } catch (e) {
        console.warn('[ServerDiceBox] physics dice unavailable, falling back to canvas dice:', e);
        this.box = null;
        this.initPromise = null; // allow retry after transient failure
      }
    })();

    return this.initPromise;
  }

  /**
   * Rolls dice with a SERVER-DETERMINED outcome.
   * @param type die shape ('d4'|'d6'|'d8'|'d10'|'d12'|'d20'|'d100')
   * @param value the authoritative result to land on
   */
  public async rollPredetermined(type: string, value: number): Promise<boolean> {
    await this.ensureInit();
    if (!this.box) return false;
    try {
      this.box.clear();
      // `value` pins the final face — physics only animates the journey.
      this.box.roll([{ type, value }]);
      return true;
    } catch (e) {
      console.warn('[ServerDiceBox] roll failed:', e);
      return false;
    }
  }

  public destroy(): void {
    try {
      this.box?.destroy();
    } catch {
      /* noop */
    }
    this.box = null;
    this.initPromise = null;
  }
}
