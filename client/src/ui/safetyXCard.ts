/**
 * Safety X-card local rewind planning.
 *
 * When a player raises an X-card the orchestrator forwards the request to the
 * Rust engine, whose `safety_rewind` replays its event ledger back to
 * `target_sequence_id` and answers with a count-only RewindReport
 * (reverted_event_count / restored_entities / removed_entities — no entity
 * ids, see crates/vtt-core/src/state.rs). The client keeps its own mirror of
 * the scene in React state, and that mirror carries NO engine sequence ids:
 * chat timestamps are minute-granular display strings, not ledger positions.
 *
 * What CAN be converged locally, honestly:
 *   - Chat: the app emits a real turn-boundary marker ("Turn passed to …")
 *     every time the table advances initiative (App.tsx handleNextTurn).
 *     Every message after the latest such marker at trigger time belongs to
 *     the turn the engine just reverted, so those lines are dropped. Lines
 *     before the marker stay — they predate the rewind point as far as local
 *     bookkeeping can prove.
 *
 * What CANNOT be converged with current data flows (documented drift):
 *   - Token HP / positions / existence: the RewindReport exposes counts only
 *     (which entities were restored/removed is not returned), the orchestrator
 *     exposes no read-only engine-session proxy the browser could call (the
 *     engine's own HTTP surface requires HMAC auth), and DB campaign saves are
 *     point-in-time GM snapshots, not post-rewind authority. Local tokens may
 *     therefore still show pre-rewind HP/positions until the next snapshot
 *     load (lobby hydration / Campaign Save modal) or CRDT position updates.
 */

/** Minimal view of ChatMessage needed here (structural, avoids import cycle). */
export interface RewindableMessage {
  id: string;
  role: string;
  content: string;
}

/** Count-only rewind report returned by the engine on success. */
export interface EngineRewindReport {
  reverted_event_count?: number;
  restored_entities?: number;
  removed_entities?: number;
}

export type EngineRewindStatus =
  | 'SAFETY_REWIND_SUCCESS'
  | 'ENGINE_UNAVAILABLE'
  | (string & {});

/**
 * Extract the engine rewind outcome from the orchestrator x-card response.
 * Shape: { ..., target_sequence_id, engine_rewind?: { status, rewind_report } }.
 * Returns null when the body is unusable (offline / non-JSON).
 */
export function parseEngineRewind(data: unknown): {
  status: EngineRewindStatus;
  report: EngineRewindReport;
} | null {
  if (typeof data !== 'object' || data === null) return null;
  const engineRewind = (data as { engine_rewind?: unknown }).engine_rewind;
  if (typeof engineRewind !== 'object' || engineRewind === null) return null;
  const status = (engineRewind as { status?: unknown }).status;
  if (typeof status !== 'string') return null;
  const rawReport = (engineRewind as { rewind_report?: unknown }).rewind_report;
  const report: EngineRewindReport =
    typeof rawReport === 'object' && rawReport !== null
      ? {
          reverted_event_count: asCount(
            (rawReport as EngineRewindReport).reverted_event_count
          ),
          restored_entities: asCount(
            (rawReport as EngineRewindReport).restored_entities
          ),
          removed_entities: asCount(
            (rawReport as EngineRewindReport).removed_entities
          ),
        }
      : {};
  return { status, report };
}

const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Prefix of the system message emitted by App.handleNextTurn on each pass. */
const TURN_MARKER_PREFIX = 'Turn passed to ';

/**
 * Index of the latest local turn-boundary marker, or -1 when the table never
 * advanced initiative (in which case nothing can be provably attributed to
 * "the reverted turn" and no pruning should happen).
 */
export function findLastTurnBoundary(messages: RewindableMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'system' && m.content.startsWith(TURN_MARKER_PREFIX)) {
      return i;
    }
  }
  return -1;
}

/**
 * Compute which pre-trigger chat lines belong to the turn the engine rewound.
 * Returns the ids to drop plus how many there are; empty when there is no
 * turn boundary to anchor on.
 */
export function computeLocalRewindPlan(
  preTriggerMessages: RewindableMessage[]
): { doomedIds: Set<string>; droppedCount: number } {
  const boundary = findLastTurnBoundary(preTriggerMessages);
  if (boundary === -1) return { doomedIds: new Set(), droppedCount: 0 };
  const doomed = preTriggerMessages.slice(boundary + 1);
  return { doomedIds: new Set(doomed.map((m) => m.id)), droppedCount: doomed.length };
}
