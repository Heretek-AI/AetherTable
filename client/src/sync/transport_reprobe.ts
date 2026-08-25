/**
 * Transport re-probe policy (iteration-19 audit follow-up).
 *
 * App.tsx's bootstrap races a 3.5s fallback timer: if the Yjs relay
 * (VITE_YSYNC_WS_URL) has not connected by then, the session downgrades to the
 * engine's legacy LWW relay. Historically that downgrade was ONE-WAY — nothing
 * ever retried the CRDT relay, so a relay that blipped during app mount left
 * every client on LWW until a manual reload.
 *
 * This module holds the PURE decision for the periodic re-probe that closes
 * that gap. Keeping it pure lets vitest cover the policy without standing up a
 * relay; App.tsx supplies the volatile inputs each tick.
 *
 * Migration semantics (documented choice): when a probe succeeds, App re-binds
 * syncClientRef/yjsClientRef/transportKind through the SAME bootstrap path used
 * on mount — fog layers, cursors, atmosphere and the speech ledger are all read
 * back out of the Y.Doc via the existing observe* subscriptions (which fire
 * immediately with current state for late subscribers), so state hands off per
 * the conventions already in yjs_doc_client.ts rather than being copied.
 */

import type { BoundTransport } from './transport_gate';

/** How often a LEGACY_LWW-bound session retries the Yjs relay (45s, mid-band). */
export const REPROBE_INTERVAL_MS = 45_000;

export interface ReprobeInputs {
  /** Transport currently bound to syncClientRef ('null' = bootstrap race). */
  transportKind: BoundTransport;
  /** True when a Yjs relay URL is configured (VITE_YSYNC_WS_URL or default). */
  hasYsyncUrl: boolean;
  /** True after the bootstrap effect's cleanup ran (component unmounted). */
  stopped: boolean;
}

/**
 * Decide whether this tick should attempt to reach the Yjs relay again.
 *
 * Only a session actually stuck on the LEGACY_LWW fallback probes: probing
 * while already on YJS would churn the healthy transport, and probing without
 * a configured relay URL can never succeed.
 */
export function shouldAttemptReprobe(inputs: ReprobeInputs): boolean {
  return inputs.transportKind === 'LEGACY_LWW' && inputs.hasYsyncUrl && !inputs.stopped;
}
