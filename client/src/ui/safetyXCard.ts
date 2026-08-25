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
 * What CAN now be converged beyond chat (iteration 28): the engine answers
 * its x-card route WITH a full role-projected GameSession snapshot taken
 * AFTER the rewind ("Post-rewind authority travels WITH the response" — see
 * trigger_safety_rewind in crates/vtt-server/src/server.rs), and the gateway
 * forwards that block verbatim inside `engine_rewind.snapshot`. When the
 * snapshot is missing (older engine build) an immediate authenticated refetch
 * through POST /api/v1/engine/session-state yields the same projection.
 * Either way the board tokens can be reconciled against authoritative state
 * instead of drifting until the next hydration (see
 * computeTokenReconciliation below).
 *
 * What STILL cannot be converged locally (documented drift, by surface):
 *   - Death-save tallies: CharacterSheet keeps successes/failures as
 *     component-local React state that subscribes to nothing — the rewind
 *     cannot reset them from here (the ENGINE's own ledger replay does reset
 *     them server-side).
 *   - Spell slots / concentration / readied actions shown in SpellbookModal
 *     and CharacterSheet come from their OWN one-shot session-state reads;
 *     they pick up the rewound values on their next open/refresh, not on
 *     rewind confirmation.
 *   - BossHealthBar polls the session-state proxy every 15 s independently,
 *     so its bar converges on the next tick, not instantly.
 *   - Entities REMOVED by the rewind (removed_entities > 0) whose ids never
 *     existed locally stay untouched here; conversely a token the snapshot
 *     no longer lists keeps rendering until a snapshot load removes it —
 *     deletion is deliberately NOT applied blindly because a player-role
 *     projection drops hidden NPCs, which would erase legitimately hidden
 *     GM-side tokens from everyone's view.
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
 * Shape: { ..., target_sequence_id, engine_rewind?: { status, rewind_report,
 * snapshot? } } — `snapshot` is the post-rewind GameSession projection the
 * engine embeds (present since iteration 15; absent on older engines).
 * Returns null when the body is unusable (offline / non-JSON).
 */
export function parseEngineRewind(data: unknown): {
  status: EngineRewindStatus;
  report: EngineRewindReport;
  snapshot: RewoundSessionSnapshot | null;
} | null {
  if (typeof data !== 'object' || data === null) return null;
  const engineRewind = (data as { engine_rewind?: unknown }).engine_rewind;
  if (typeof engineRewind !== 'object' || engineRewind === null) return null;
  const status = (engineRewind as { status?: unknown }).status;
  if (typeof status !== 'string') return null;
  const snapshot = parseRewoundSnapshot(
    (engineRewind as { snapshot?: unknown }).snapshot
  );
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
  return { status, report, snapshot };
}

const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * One entity from the post-rewind snapshot, exactly as the engine's role
 * projection discloses it to THIS caller (project_snapshot_for_role in
 * crates/vtt-server/src/server.rs): GM/admin get full stat blocks including
 * hidden NPCs; players get their own sheet in full and everyone else as
 * public board tokens ({name, is_visible, position, is_player, is_dead});
 * spectators see board tokens only. Every field except `id` is therefore
 * OPTIONAL and absence means "the projection withheld it", never zero.
 */
export interface RewoundEntity {
  id: string;
  name?: string;
  position?: number[];
  is_player?: boolean;
  is_dead?: boolean;
  /** Present only on your own sheet or with GM/admin privileges. */
  current_hp?: number;
}

/** The embedded post-rewind GameSession projection (subset the client uses). */
export interface RewoundSessionSnapshot {
  session_id?: string;
  entities: Record<string, RewoundEntity>;
}

/** Defensive parse of the embedded `engine_rewind.snapshot` block. A
 * malformed or absent snapshot yields null — never a guessed shape. */
export function parseRewoundSnapshot(raw: unknown): RewoundSessionSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rawEntities = (raw as { entities?: unknown }).entities;
  if (typeof rawEntities !== 'object' || rawEntities === null) return null;
  const entities: Record<string, RewoundEntity> = {};
  for (const [key, value] of Object.entries(
    rawEntities as Record<string, unknown>
  )) {
    if (!value || typeof value !== 'object') continue; // skip malformed entries
    const e = value as Record<string, unknown>;
    entities[key] = {
      id: typeof e.id === 'string' && e.id.length > 0 ? e.id : key,
      name: typeof e.name === 'string' ? e.name : undefined,
      position:
        Array.isArray(e.position) && e.position.every((c) => typeof c === 'number')
          ? (e.position as number[])
          : undefined,
      is_player: e.is_player === true,
      is_dead: e.is_dead === true,
      current_hp: typeof e.current_hp === 'number' ? e.current_hp : undefined,
    };
  }
  const sessionId = (raw as { session_id?: unknown }).session_id;
  return {
    ...(typeof sessionId === 'string' ? { session_id: sessionId } : {}),
    entities,
  };
}

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

/* --- Token reconciliation (iteration 28) ----------------------------------
 *
 * The engine rewinds FULL state server-side (HP, positions, consciousness,
 * death saves, concentration); the client's local token mirror was the gap.
 * `computeTokenReconciliation` turns the authoritative post-rewind entity
 * projection into per-token patches for the board mirror.
 */

/** Minimal view of the client Token needed here (structural — avoids an
 * import cycle with components/TacticalCanvas). */
export interface ReconcilableToken {
  id: string;
  hp: number;
  x: number;
  y: number;
}

/**
 * Per-token patch derived from the authoritative projection. A field is only
 * present when the projection actually disclosed it (own sheet / GM view /
 * public position), so callers never overwrite a value with a guess.
 */
export interface TokenRewindPatch {
  id: string;
  /** Authoritative post-rewind HP (only when the projection discloses HP). */
  hp?: number;
  /** Authoritative grid coordinates (position is [x, y, z] in the engine). */
  x?: number;
  y?: number;
}

export interface TokenReconciliationPlan {
  /** Patches to apply to the local mirror, one per matched token. */
  patches: TokenRewindPatch[];
  /**
   * Snapshot entities that disclose a position but match no local token.
   * These are engine-side creatures this browser has no mirror of (spawned
   * by another seat, or removed locally). Reported so the caller can log
   * honestly instead of fabricating tokens it knows nothing about.
   */
  unmatchedEntityIds: string[];
  /** Local ids the snapshot no longer lists AND whose sheet is disclosed
   * (i.e. provably gone from authoritative state, not merely hidden from
   * this role's projection). Callers may drop these; blind deletion of
   * non-disclosed ids would erase legitimately GM-hidden tokens. */
  provablyRemovedTokenIds: string[];
  /** True when the snapshot carried NO usable entity data (older engine,
   * malformed body): callers must leave every token untouched. */
  empty: boolean;
}

/**
 * Plan how the local token mirror must change to match the rewound engine.
 *
 * Rules, in order:
 *   1. An empty/unusable snapshot yields `empty: true` and zero changes.
 *   2. For each LOCAL token present in the snapshot, patch exactly the
 *      fields the projection discloses (hp only on own sheet/GM; x/y only
 *      when a numeric position array exists).
 *   3. A local token absent from the snapshot is "provably removed" ONLY
 *      when its own sheet would have been disclosed (current_hp present on a
 *      matched sibling implies a privileged view; otherwise removal is only
 *      claimed for tokens the caller marked as theirs via `ownedTokenIds`,
 *      because a player-role projection silently drops hidden NPCs and other
 *      seats' sheets).
 *   4. Snapshot entities matching no local token are reported unmatched —
 *      never fabricated into the mirror here.
 */
export function computeTokenReconciliation(
  tokens: ReconcilableToken[],
  snapshot: RewoundSessionSnapshot | null | undefined,
  options?: { ownedTokenIds?: string[] }
): TokenReconciliationPlan {
  const plan: TokenReconciliationPlan = {
    patches: [],
    unmatchedEntityIds: [],
    provablyRemovedTokenIds: [],
    empty: true,
  };
  if (!snapshot || typeof snapshot.entities !== 'object' || snapshot.entities === null) {
    return plan;
  }
  const entries = Object.entries(snapshot.entities).filter(
    ([, e]) => !!e && typeof e === 'object'
  );
  // No entity data at all == nothing authoritative to reconcile against;
  // touching state here would be fabrication, not convergence.
  if (entries.length === 0) return plan;

  plan.empty = false;
  // A privileged view discloses HP somewhere; under such a view absence from
  // the snapshot really does mean the entity no longer exists.
  const privilegedView = entries.some(([, e]) => typeof e.current_hp === 'number');
  const owned = new Set(options?.ownedTokenIds ?? []);
  const matched = new Set<string>();

  for (const token of tokens) {
    const entity =
      snapshot.entities[token.id] ??
      entries.find(([, e]) => e.id === token.id)?.[1];
    if (!entity) {
      // Absent + (privileged view or explicitly owned) ⇒ genuinely removed.
      if (privilegedView || owned.has(token.id)) {
        plan.provablyRemovedTokenIds.push(token.id);
      }
      continue;
    }
    matched.add(entity.id === token.id ? token.id : entity.id);
    const patch: TokenRewindPatch = { id: token.id };
    if (typeof entity.current_hp === 'number') patch.hp = entity.current_hp;
    const pos = entity.position;
    if (
      Array.isArray(pos) &&
      pos.length >= 2 &&
      pos.every((c) => typeof c === 'number')
    ) {
      patch.x = pos[0];
      patch.y = pos[1];
    }
    if (patch.hp !== undefined || patch.x !== undefined || patch.y !== undefined) {
      plan.patches.push(patch);
    }
  }

  for (const [key, e] of entries) {
    const id = typeof e.id === 'string' && e.id ? e.id : key;
    if (!matched.has(id)) plan.unmatchedEntityIds.push(id);
  }
  return plan;
}
