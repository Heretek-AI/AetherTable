/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * PixiJS renderer backend preference used by `PixiBoard`.
   *
   * - `'webgl'` (default): WebGL-first, production-stable.
   * - `'webgpu'`: opt-in WebGPU-first; `PixiBoard` falls back to WebGL
   *   automatically when WebGPU init fails, and callers keep their DOM
   *   fallback chain when both fail.
   */
  readonly VITE_PIXI_PREFERENCE?: 'webgl' | 'webgpu';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
