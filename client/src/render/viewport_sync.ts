/**
 * Broadcast viewport synchronization (GOALS.md Pillar 9).
 *
 * A streamer capturing the table window must broadcast EXACTLY the
 * spectator-filtered board — never the GM's unmasked map. This module is the
 * camera half of that contract: it polls the ALREADY-FILTERED projected state
 * once per animation frame and fits a letterboxed camera rectangle over the
 * party's visible area.
 *
 * ── WHY THERE IS NO DOUBLE FILTRATION ───────────────────────────────────────
 * The App shell filters GM-hidden tokens out of the token list before any
 * spectator-facing surface receives it (`visibleTokens`; see App.tsx Pillar 9
 * block). This controller therefore takes `projectedTokens` — the same filtered
 * list the canvas renders — and NEVER re-applies an `isVisible` check. Hidden
 * entities are physically absent from the input, so they cannot influence the
 * fitted frame even indirectly (a camera framed on a secret would leak its
 * position through the framing itself). Re-filtering here would silently
 * duplicate the one authoritative filter and invite drift between the two.
 *
 * Fog handling follows the same principle: the fitted region is the UNION of
 * every party-shared `user:*` reveal mask (the same union TacticalCanvas draws),
 * so the camera tracks explored terrain only. The GM keeps NO fog layer by
 * design (omniscient seats are layer-less — see fog_overlay.ts), which is why
 * the GM's map can never widen this frame.
 *
 * ── WHAT THIS MODULE DOES NOT DO (honest limits) ────────────────────────────
 *  1. It never writes to the interactive canvas. Pan/zoom state lives inside
 *     TacticalCanvas and is deliberately not reachable from here; this
 *     controller PUBLISHES a camera transform for the capture surface (window
 *     capture + crop in OBS, or any future picture-in-picture renderer). It
 *     cannot and does not steer the GM's own viewport.
 *  2. When spectatorMode is OFF it reports `gm_passthrough` with a null camera:
 *     mirroring "whatever the operator's canvas shows" faithfully means the
 *     capture inherits the seat's full content, and this module has no honest
 *     way to read TacticalCanvas's encapsulated pan/zoom to describe it.
 *  3. With zero visible tokens AND zero revealed fog cells the camera LOCKS to
 *     the board center rather than inventing a subject (callers surface that
 *     fact via `mode: 'locked_board_center'`).
 */

import {
  FOG_LAYER_PREFIX,
  ensureFogMask,
  isCellRevealed,
  unionFogMasks,
} from './fog_overlay';
import type { YjsCrdtClient } from '../sync/yjs_doc_client';

/** Board pixels per grid cell — must match TacticalCanvas.cellSize. */
export const BOARD_CELL_PX = 60;

/** Zoom envelope mirrored from TacticalCanvas's wheel/tool controls. */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.2;
/** Fit margin around the party's bounding box, in grid cells. */
const FIT_PADDING_CELLS = 1.25;
/** Zoom used when the frame locks to board center (whole-board overview). */
const LOCKED_CENTER_ZOOM = 0.6;

/** Capture modes reported to the Streamer HUD. */
export type BroadcastCaptureMode =
  /** Tracking the spectator-projected board (filtered tokens + party fog). */
  | 'spectator_projected'
  /** spectatorMode off: capture mirrors the operator's canvas verbatim. */
  | 'gm_passthrough'
  /** Nothing visible: frame locked to board center (disclosed, not invented). */
  | 'locked_board_center';

/** Camera transform in TacticalCanvas's coordinate convention:
 *  screenX = boardX * zoom + panX (origin-top-left stage transform). */
export interface BroadcastCamera {
  panX: number;
  panY: number;
  zoom: number;
}

/** Screen-space letterbox bars around the fitted content rectangle. */
export interface BroadcastLetterbox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The fitted region of board space, in board pixels. */
export interface BroadcastFocusRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Honest READOUT of what the projection excludes from the capture. */
export interface BroadcastProjectionReadout {
  /** Tokens PRESENT in the projected (already-filtered) list. */
  visibleTokens: number;
  /** Tokens the App shell removed upstream (metadata count — never re-derived
   *  here; see the no-double-filtration note in the module header). */
  hiddenTokens: number;
  /** Chat lines excluded from the spectator message stream. */
  excludedChatLines: number;
  /** Party-shared fog layers merged into the tracked exploration area. */
  partyFogLayers: number;
}

export interface BroadcastViewportSnapshot {
  mode: BroadcastCaptureMode;
  /** Null for `gm_passthrough`: see honest-limit #2 in the module header. */
  camera: BroadcastCamera | null;
  focusRect: BroadcastFocusRect | null;
  letterbox: BroadcastLetterbox;
  readout: BroadcastProjectionReadout;
  /** One-line disclosure rendered verbatim by the Streamer HUD. */
  note: string;
}

/** Structural subset of TacticalCanvas's Token that framing needs. */
export interface ProjectedBoardToken {
  id: string;
  name: string;
  /** Grid-cell board coordinates (same space as Token.x / Token.y). */
  x: number;
  y: number;
  isPlayer: boolean;
}

export interface BroadcastViewportInput {
  spectatorMode: boolean;
  /**
   * The spectator-projected token list — i.e. the ALREADY-FILTERED array the
   * canvas renders. Do NOT filter again here (see module header).
   */
  projectedTokens: ProjectedBoardToken[];
  /** Size of the UNFILTERED token list, for the exclusion readout only. */
  totalTokenCount: number;
  /** Chat lines the spectator message stream excludes. */
  excludedChatLines: number;
  /** CRDT client backing fog-of-war; null means no fog state exists. */
  syncClient: YjsCrdtClient | null;
  gridWidth: number;
  gridHeight: number;
  /** Capture surface size in CSS pixels (the letterbox container). */
  viewportWidthPx: number;
  viewportHeightPx: number;
}

interface PartyFogSummary {
  /** Union of every party-shared `user:*` mask (null = no layers at all). */
  unionMask: Uint8Array | null;
  /** How many distinct party layers were merged. */
  layerCount: number;
  revealedCells: { x: number; y: number }[];
}

/**
 * Merge every party-shared fog layer exactly the way TacticalCanvas's
 * non-omnicient fallback path does (union of all `user:*` masks) and collect
 * the revealed cells so framing can include explored terrain beyond the party.
 */
function summarizePartyFog(
  syncClient: YjsCrdtClient | null,
  gridWidth: number,
  gridHeight: number
): PartyFogSummary {
  if (!syncClient) return { unionMask: null, layerCount: 0, revealedCells: [] };
  const layerIds = syncClient.getFogLayerIds().filter((id) => id.startsWith(FOG_LAYER_PREFIX));
  if (layerIds.length === 0) return { unionMask: null, layerCount: 0, revealedCells: [] };
  const neededBytes = Math.ceil((gridWidth * gridHeight) / 8);
  const masks = layerIds.map((id) => syncClient.getFogLayer(id));
  const unionMask = ensureFogMask(unionFogMasks(masks, neededBytes), gridWidth, gridHeight);
  const revealedCells: { x: number; y: number }[] = [];
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      if (isCellRevealed(unionMask, gridWidth, x, y)) revealedCells.push({ x, y });
    }
  }
  return { unionMask, layerCount: layerIds.length, revealedCells };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Compute one broadcast-camera frame from the projected state. Pure: no DOM,
 * no timers, no mutation — the polling loop below merely feeds it.
 */
export function computeBroadcastViewport(
  input: BroadcastViewportInput
): BroadcastViewportSnapshot {
  const {
    spectatorMode,
    projectedTokens,
    totalTokenCount,
    excludedChatLines,
    syncClient,
    gridWidth,
    gridHeight,
    viewportWidthPx,
    viewportHeightPx,
  } = input;

  const boardWidthPx = gridWidth * BOARD_CELL_PX;
  const boardHeightPx = gridHeight * BOARD_CELL_PX;
  const boardCenterX = boardWidthPx / 2;
  const boardCenterY = boardHeightPx / 2;
  const readout: BroadcastProjectionReadout = {
    visibleTokens: projectedTokens.length,
    hiddenTokens: Math.max(0, totalTokenCount - projectedTokens.length),
    excludedChatLines,
    partyFogLayers: 0,
  };

  // --- GM passthrough -------------------------------------------------------
  if (!spectatorMode) {
    return {
      mode: 'gm_passthrough',
      camera: null,
      focusRect: null,
      letterbox: { top: 0, right: 0, bottom: 0, left: 0 },
      readout,
      note:
        'Mirroring the operator canvas verbatim: whatever the seated view shows is what the capture shows. Spectator filtering is OFF.',
    };
  }

  const fog = summarizePartyFog(syncClient, gridWidth, gridHeight);
  readout.partyFogLayers = fog.layerCount;

  // --- Collect framing anchors: token centers + revealed fog cell centers ---
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const token of projectedTokens) {
    grow(
      (token.x + 0.5) * BOARD_CELL_PX,
      (token.y + 0.5) * BOARD_CELL_PX
    );
  }
  for (const cell of fog.revealedCells) {
    grow(
      (cell.x + 0.5) * BOARD_CELL_PX,
      (cell.y + 0.5) * BOARD_CELL_PX
    );
  }

  // --- Nothing visible: lock to board center (honest empty state) -----------
  if (!Number.isFinite(minX)) {
    const zoom = clamp(
      Math.min(viewportWidthPx / boardWidthPx, viewportHeightPx / boardHeightPx),
      MIN_ZOOM,
      LOCKED_CENTER_ZOOM
    );
    const shownW = boardWidthPx * zoom;
    const shownH = boardHeightPx * zoom;
    return {
      mode: 'locked_board_center',
      camera: {
        panX: viewportWidthPx / 2 - boardCenterX * zoom,
        panY: viewportHeightPx / 2 - boardCenterY * zoom,
        zoom,
      },
      focusRect: { minX: 0, minY: 0, maxX: boardWidthPx, maxY: boardHeightPx },
      letterbox: {
        top: Math.max(0, (viewportHeightPx - shownH) / 2),
        bottom: Math.max(0, (viewportHeightPx - shownH) / 2),
        left: Math.max(0, (viewportWidthPx - shownW) / 2),
        right: Math.max(0, (viewportWidthPx - shownW) / 2),
      },
      readout,
      note:
        'No tokens are visible in the spectator projection and nothing has been revealed on the shared fog layers — the frame is LOCKED to board center instead of tracking a subject.',
    };
  }

  // --- Fit the party bounding box (+padding) into the capture surface -------
  const pad = FIT_PADDING_CELLS * BOARD_CELL_PX;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(boardWidthPx, maxX + pad);
  maxY = Math.min(boardHeightPx, maxY + pad);

  const contentW = Math.max(BOARD_CELL_PX, maxX - minX);
  const contentH = Math.max(BOARD_CELL_PX, maxY - minY);
  const zoom = clamp(
    Math.min(viewportWidthPx / contentW, viewportHeightPx / contentH),
    MIN_ZOOM,
    MAX_ZOOM
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const shownW = contentW * zoom;
  const shownH = contentH * zoom;

  return {
    mode: 'spectator_projected',
    camera: {
      panX: viewportWidthPx / 2 - centerX * zoom,
      panY: viewportHeightPx / 2 - centerY * zoom,
      zoom,
    },
    focusRect: { minX, minY, maxX, maxY },
    letterbox: {
      top: Math.max(0, (viewportHeightPx - shownH) / 2),
      bottom: Math.max(0, (viewportHeightPx - shownH) / 2),
      left: Math.max(0, (viewportWidthPx - shownW) / 2),
      right: Math.max(0, (viewportWidthPx - shownW) / 2),
    },
    readout,
    note:
      'Frame tracks ONLY the spectator-projected board: filtered token positions plus the party-shared fog union. Hidden entities are absent from the input list, so they cannot shape the framing.',
  };
}

export interface BroadcastViewportLoopHandle {
  stop: () => void;
}

/**
 * Poll `getInput` once per animation frame and push snapshots to `onUpdate`.
 * Emission is coalesced: identical consecutive snapshots (compared by their
 * scalar fields, cheap enough for this payload) are dropped so a React caller
 * re-renders only when the broadcast frame actually changed.
 *
 * Returns a stop handle; the loop self-cancels on stop and never throws into
 * the host component (input errors collapse to a stopped loop, not a crash).
 */
export function startBroadcastViewportLoop(
  getInput: () => BroadcastViewportInput,
  onUpdate: (snapshot: BroadcastViewportSnapshot) => void
): BroadcastViewportLoopHandle {
  let animId = 0;
  let stopped = false;
  let lastKey = '';

  const tick = () => {
    if (stopped) return;
    try {
      const snapshot = computeBroadcastViewport(getInput());
      const key = [
        snapshot.mode,
        snapshot.camera ? `${Math.round(snapshot.camera.panX)}:${Math.round(snapshot.camera.panY)}:${snapshot.camera.zoom.toFixed(3)}` : '-',
        snapshot.focusRect
          ? `${Math.round(snapshot.focusRect.minX)},${Math.round(snapshot.focusRect.minY)},${Math.round(snapshot.focusRect.maxX)},${Math.round(snapshot.focusRect.maxY)}`
          : '-',
        Object.values(snapshot.readout).join('/'),
      ].join('|');
      if (key !== lastKey) {
        lastKey = key;
        onUpdate(snapshot);
      }
    } catch {
      // A transiently unavailable input (e.g. CRDT teardown mid-frame) must not
      // kill the loop; skip this frame and retry on the next one.
    }
    animId = requestAnimationFrame(tick);
  };

  animId = requestAnimationFrame(tick);
  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(animId);
    },
  };
}
