/**
 * Unit tests for src/render/viewport_sync.ts framing math.
 *
 * computeBroadcastViewport is documented as pure (no DOM, no timers), so it is
 * exercised directly here with a null CRDT client — fog layers are simply
 * absent from the input and framing falls back to token anchors alone. The
 * rAF-driven polling loop is NOT tested (it is host-environment code).
 *
 * Coordinate convention under test: screenX = boardX * zoom + panX.
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_CELL_PX,
  computeBroadcastViewport,
  type BroadcastViewportInput,
  type ProjectedBoardToken,
} from '../viewport_sync';

function token(x: number, y: number, id = `t${x}-${y}`): ProjectedBoardToken {
  return { id, name: id, x, y, isPlayer: true };
}

function baseInput(overrides: Partial<BroadcastViewportInput> = {}): BroadcastViewportInput {
  return {
    spectatorMode: true,
    projectedTokens: [],
    totalTokenCount: 0,
    excludedChatLines: 0,
    syncClient: null,
    gridWidth: 20,
    gridHeight: 15,
    viewportWidthPx: 1200,
    viewportHeightPx: 900,
    ...overrides,
  };
}

describe('gm_passthrough mode', () => {
  it('reports a null camera and zero letterbox when spectatorMode is off', () => {
    const snap = computeBroadcastViewport(baseInput({ spectatorMode: false }));
    expect(snap.mode).toBe('gm_passthrough');
    expect(snap.camera).toBeNull();
    expect(snap.focusRect).toBeNull();
    expect(snap.letterbox).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('still reports the exclusion readout honestly', () => {
    const snap = computeBroadcastViewport(
      baseInput({ spectatorMode: false, projectedTokens: [token(1, 1)], totalTokenCount: 4, excludedChatLines: 7 })
    );
    expect(snap.readout).toEqual({
      visibleTokens: 1,
      hiddenTokens: 3,
      excludedChatLines: 7,
      partyFogLayers: 0,
    });
  });
});

describe('spectator_projected — bounding-box fit', () => {
  it('centers the padded bounding box of the visible tokens', () => {
    // Tokens at cells (2,2) and (5,6): centers at (150,150) and (330,390).
    // Padded box (pad = 75px): x [75..405], y [75..465] -> center (240, 270).
    const snap = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(2, 2), token(5, 6)] })
    );
    expect(snap.mode).toBe('spectator_projected');
    const { camera } = snap;
    expect(camera).not.toBeNull();
    expect(snap.focusRect).toEqual({ minX: 75, minY: 75, maxX: 405, maxY: 465 });

    const contentW = 405 - 75; // 330
    const contentH = 465 - 75; // 390
    const expectedZoom = Math.min(1200 / contentW, 900 / contentH); // min(3.63, 2.30) -> clamped to MAX_ZOOM 2.2? No: 2.30 > 2.2 so clamped to 2.2
    expect(camera!.zoom).toBeCloseTo(Math.min(expectedZoom, 2.2), 10);
    expect(camera!.panX).toBeCloseTo(1200 / 2 - 240 * camera!.zoom, 6);
    expect(camera!.panY).toBeCloseTo(900 / 2 - 270 * camera!.zoom, 6);
  });

  it('applies the 1.25-cell padding symmetrically around the anchor box', () => {
    const pad = 1.25 * BOARD_CELL_PX; // 75px
    const snap = computeBroadcastViewport(baseInput({ projectedTokens: [token(4, 3)] }));
    const cx = (4 + 0.5) * BOARD_CELL_PX; // 270
    const cy = (3 + 0.5) * BOARD_CELL_PX; // 210
    expect(snap.focusRect).toEqual({ minX: cx - pad, minY: cy - pad, maxX: cx + pad, maxY: cy + pad });
  });

  it('clamps the padded rect to board edges instead of framing off-board space', () => {
    // A single token in the corner cannot pad past (0,0).
    const snap = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(0, 0)], gridWidth: 10, gridHeight: 10 })
    );
    expect(snap.focusRect!.minX).toBe(0);
    expect(snap.focusRect!.minY).toBe(0);
    expect(snap.focusRect!.maxX).toBeLessThanOrEqual(10 * BOARD_CELL_PX);
    expect(snap.focusRect!.maxY).toBeLessThanOrEqual(10 * BOARD_CELL_PX);

    // And at the far corner it cannot exceed the board extent.
    const far = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(9, 9)], gridWidth: 10, gridHeight: 10 })
    );
    expect(far.focusRect!.maxX).toBe(10 * BOARD_CELL_PX);
    expect(far.focusRect!.maxY).toBe(10 * BOARD_CELL_PX);
  });

  it('zoom clamps to [0.5, 2.2]: a tight pair never exceeds MAX_ZOOM', () => {
    // Two adjacent tokens: content ~210x210 after padding; 1200/210 >> 2.2.
    const tight = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(5, 5), token(6, 5)] })
    );
    expect(tight.camera!.zoom).toBeCloseTo(2.2, 10);

    // A spread spanning most of a large board forces MIN_ZOOM to bite.
    const wide = computeBroadcastViewport(
      baseInput({
        projectedTokens: [token(0, 0), token(59, 39)],
        gridWidth: 60,
        gridHeight: 40,
        viewportWidthPx: 800,
        viewportHeightPx: 600,
      })
    );
    // Content spans the full board plus padding clamped at the edges.
    expect(wide.camera!.zoom).toBeCloseTo(0.5, 10);
  });

  it('never produces a non-finite or negative zoom', () => {
    const snap = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(7, 7)], viewportWidthPx: 100, viewportHeightPx: 80 })
    );
    expect(Number.isFinite(snap.camera!.zoom)).toBe(true);
    expect(snap.camera!.zoom).toBeGreaterThanOrEqual(0.5);
    expect(snap.camera!.zoom).toBeLessThanOrEqual(2.2);
  });

  it('letterboxes the fitted content within the capture surface', () => {
    // Content wider than tall relative to the surface: vertical bars appear.
    const snap = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(0, 0), token(19, 0)] })
    );
    const shownW = (snap.focusRect!.maxX - snap.focusRect!.minX) * snap.camera!.zoom;
    const shownH = (snap.focusRect!.maxY - snap.focusRect!.minY) * snap.camera!.zoom;
    expect(shownW).toBeLessThanOrEqual(1200 + 0.01);
    expect(shownH).toBeLessThanOrEqual(900 + 0.01);
    expect(snap.letterbox.top).toBeCloseTo(Math.max(0, (900 - shownH) / 2), 6);
    expect(snap.letterbox.left).toBeCloseTo(Math.max(0, (1200 - shownW) / 2), 6);
    // Letterbox is symmetric top/bottom and left/right.
    expect(snap.letterbox.top).toBeCloseTo(snap.letterbox.bottom, 6);
    expect(snap.letterbox.left).toBeCloseTo(snap.letterbox.right, 6);
  });

  it('camera transform maps the focus-rect center to the viewport center exactly', () => {
    const snap = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(1, 8), token(12, 2), token(6, 11)] })
    );
    const centerX = (snap.focusRect!.minX + snap.focusRect!.maxX) / 2;
    const centerY = (snap.focusRect!.minY + snap.focusRect!.maxY) / 2;
    expect(snap.camera!.panX + centerX * snap.camera!.zoom).toBeCloseTo(600, 6);
    expect(snap.camera!.panY + centerY * snap.camera!.zoom).toBeCloseTo(450, 6);
  });
});

describe('locked_board_center empty state', () => {
  it('locks to board center with zero tokens and no fog when spectatorMode is on', () => {
    const snap = computeBroadcastViewport(baseInput());
    expect(snap.mode).toBe('locked_board_center');
    expect(snap.camera).not.toBeNull();
    expect(snap.focusRect).toEqual({ minX: 0, minY: 0, maxX: 1200, maxY: 900 }); // 20*60 x 15*60

    const boardW = 20 * BOARD_CELL_PX;
    const boardH = 15 * BOARD_CELL_PX;
    const zoom = snap.camera!.zoom;
    // Locked-center zoom is capped below the general MAX_ZOOM envelope.
    expect(zoom).toBeLessThanOrEqual(0.6);
    expect(zoom).toBeGreaterThanOrEqual(0.5);
    expect(snap.camera!.panX).toBeCloseTo(1200 / 2 - (boardW / 2) * zoom, 6);
    expect(snap.camera!.panY).toBeCloseTo(900 / 2 - (boardH / 2) * zoom, 6);
    expect(snap.note).toMatch(/LOCKED to board center/);
  });

  it('whole-board overview fits inside the capture surface with letterbox bars', () => {
    const snap = computeBroadcastViewport(baseInput());
    const boardW = 20 * BOARD_CELL_PX;
    const boardH = 15 * BOARD_CELL_PX;
    const zoom = snap.camera!.zoom;
    const shownW = boardW * zoom;
    const shownH = boardH * zoom;
    expect(shownW).toBeLessThanOrEqual(1200);
    expect(shownH).toBeLessThanOrEqual(900);
    expect(snap.letterbox.top).toBeCloseTo((900 - shownH) / 2, 6);
    expect(snap.letterbox.left).toBeCloseTo((1200 - shownW) / 2, 6);
  });

  it('a tiny viewport clamps the locked zoom UP to MIN_ZOOM rather than over-zooming content', () => {
    const snap = computeBroadcastViewport(baseInput({ viewportWidthPx: 300, viewportHeightPx: 200 }));
    // min(300/1200, 200/900) = 0.222 -> clamped up to 0.5 by the envelope.
    expect(snap.camera!.zoom).toBeCloseTo(0.5, 10);
  });
});

describe('readout honesty', () => {
  it('derives hiddenTokens from the caller-supplied unfiltered count only', () => {
    const snap = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(1, 1), token(2, 2)], totalTokenCount: 9 })
    );
    expect(snap.readout.visibleTokens).toBe(2);
    expect(snap.readout.hiddenTokens).toBe(7);
  });

  it('never counts hidden tokens as negative if counts disagree', () => {
    const snap = computeBroadcastViewport(
      baseInput({ projectedTokens: [token(1, 1), token(2, 2)], totalTokenCount: 1 })
    );
    expect(snap.readout.hiddenTokens).toBe(0);
  });

  it('with a null CRDT client reports zero fog layers regardless of mode', () => {
    for (const mode of [true, false]) {
      const snap = computeBroadcastViewport(baseInput({ spectatorMode: mode, syncClient: null }));
      expect(snap.readout.partyFogLayers).toBe(0);
    }
  });
});
