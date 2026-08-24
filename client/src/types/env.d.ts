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

  /**
   * Base URL of the self-hosted PeerJS signaling server (`vtt-peerjs` in
   * docker-compose.yml, exposed on :9000 with key `aethertable`, path
   * `/peerjs`). Baked into the bundle at build time by Vite.
   */
  readonly VITE_PEERJS_URL?: string;

  /**
   * Lobby namespace for the WebRTC mesh peer-id prefix. Must match across
   * every client that should see each other's video tiles.
   */
  readonly VITE_PEERJS_ROOM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
