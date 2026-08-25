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

  /**
   * WebSocket URL of the Yjs CRDT relay (`scripts/ysync-server.mjs` /
   * docker-compose `vtt-ysync`). The DEFAULT transport for token/fog/cursor/
   * speech sync; when unreachable, App.tsx falls back to the engine LWW relay
   * and keeps re-probing (see sync/transport_reprobe.ts).
   */
  readonly VITE_YSYNC_WS_URL?: string;

  /**
   * WebSocket base URL of the Rust engine's LWW session relay
   * (/ws/sessions/{id}/sync). Only used when the CRDT relay is unreachable.
   */
  readonly VITE_ENGINE_WS_URL?: string;

  /**
   * TURN server URL for the WebRTC mesh ICE configuration, e.g.
   * `turn:turn.example.com:3478?transport=udp`. Empty/unset ⇒ the mesh ships
   * public STUN only and peers behind symmetric NAT keep failing honestly
   * (see webrtc_mesh.ts — no fake-success path exists). Baked at build time
   * by Vite; pair with VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL.
   */
  readonly VITE_TURN_URL?: string;

  /**
   * TURN username. For a static-auth-secret coturn deploy this must be the
   * REST-API-shaped `"<unix-expiry-timestamp>:<userid>"` combo, NOT a fixed
   * account name. Never hardcode credentials here or in code.
   */
  readonly VITE_TURN_USERNAME?: string;

  /**
   * TURN credential: for static-auth-secret coturn this is
   * base64(hmac_sha1(secret, username)) minted out-of-band from AUTH_SECRET
   * / COTURN_TURN_SECRET. Time-limited by construction; regenerate per
   * deployment rather than baking a long-lived value.
   */
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
