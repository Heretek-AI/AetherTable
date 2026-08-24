import React, { useState } from 'react';
import { Map, RefreshCw, Check, AlertTriangle, WifiOff } from 'lucide-react';
import {
  engineGenerateMap,
  EngineGeneratedMap,
  EngineMapGenerateOutcome,
} from '../api/rules_engine';

interface WfcStudioViewProps {
  onApplyMapToSession: (tiles: number[][], width: number, height: number) => void;
}

/**
 * Every terminal state is explicit; there is NO local map synthesis anywhere
 * in this file. Before the first successful engine call the canvas shows an
 * honest empty state instead of a fabricated grid.
 */
type GenStatus =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'applied'; map: EngineGeneratedMap }
  /** The solver exhausted every restart — quote the engine's code verbatim. */
  | { kind: 'contradiction'; code: string }
  /** The gateway refused for another documented reason (4xx / contract break). */
  | { kind: 'rejected'; status: number; code: string | null; message: string | null }
  /** Engine or gateway unreachable — no map was decided on. */
  | { kind: 'unreachable' };

/** Tile codes emitted by vtt-core's DungeonGenerator::generate_room (u8). */
const TILE_LEGEND: Array<{ code: number; label: string; swatch: string }> = [
  {
    code: 0,
    label: 'Floor (walkable)',
    swatch: 'bg-black/40 border border-black/50',
  },
  {
    code: 1,
    label: 'Wall (blocks LoS)',
    swatch:
      'bg-[var(--rp-iron-800)] border border-[var(--rp-leather-600)]',
  },
  {
    code: 2,
    label: 'Door',
    swatch: 'bg-emerald-900/60 border border-emerald-500/70',
  },
  {
    code: 3,
    label: 'Altar',
    swatch:
      'bg-[color-mix(in_srgb,var(--rp-crimson-650)_35%,transparent)] border border-[var(--rp-crimson-650)]',
  },
  {
    code: 4,
    label: 'Chest',
    swatch: 'bg-amber-900/50 border border-amber-500/70',
  },
];

export const WfcStudioView: React.FC<WfcStudioViewProps> = ({ onApplyMapToSession }) => {
  const [gridWidth, setGridWidth] = useState(16);
  const [gridHeight, setGridHeight] = useState(12);
  const [theme, setTheme] = useState('dungeon');
  // Editable so deterministic regeneration is demonstrable: re-clicking
  // Generate with an unchanged seed re-posts the identical request.
  const [seedText, setSeedText] = useState('1337');
  const [status, setStatus] = useState<GenStatus>({ kind: 'idle' });
  const [lastRequest, setLastRequest] = useState<string | null>(null);

  const parsedSeed = (): number | undefined => {
    const trimmed = seedText.trim();
    if (!trimmed) return undefined; // engine applies its default (1337)
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return undefined;
    // The engine's seed is a u64; clamp rather than send a value serde rejects.
    return Math.min(Math.floor(n), 2 ** 64 - 1);
  };

  const handleGenerate = async () => {
    setStatus({ kind: 'generating' });
    const seed = parsedSeed();
    const outcome: EngineMapGenerateOutcome = await engineGenerateMap({
      width: gridWidth,
      height: gridHeight,
      seed,
      theme,
    });
    setLastRequest(
      `${gridWidth}×${gridHeight} · seed ${seed ?? 'engine default'} · theme "${theme}"`,
    );
    switch (outcome.kind) {
      case 'applied':
        setStatus({ kind: 'applied', map: outcome.data });
        break;
      case 'rejected':
        setStatus(
          outcome.code === 'WFC_CONTRADICTION_EXHAUSTED'
            ? { kind: 'contradiction', code: outcome.code }
            : { kind: 'rejected', status: outcome.status, code: outcome.code, message: outcome.message },
        );
        break;
      case 'unreachable':
        setStatus({ kind: 'unreachable' });
        break;
    }
  };

  const applied = status.kind === 'applied' ? status.map : null;
  const canDeploy =
    applied !== null &&
    applied.width === gridWidth &&
    applied.height === gridHeight;

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full bg-tavern-bg overflow-hidden">
      {/* Left Config Controls Sidebar */}
      <div className="w-full md:w-80 h-full vtt-glass-panel border-r border-tavern-border p-5 flex flex-col justify-between overflow-y-auto vtt-scrollbar">
        <div className="space-y-5">
          <div className="flex items-center gap-2.5 pb-4 border-b border-tavern-border">
            <div className="w-8 h-8 rounded-lg bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)] border border-tavern-border flex items-center justify-center text-tavern-accent">
              <Map className="w-4 h-4" />
            </div>
            <div>
              <h2 className="vtt-statblock-nameplate text-sm font-bold">WFC Dungeon Studio</h2>
              <div className="text-[11px] text-tavern-accent font-prose italic">Wave Function Collapse</div>
            </div>
          </div>

          {/* Theme Selector — travels to the engine's RoomDescriptor, but
              vtt-wfc currently renders every theme from its single dungeon
              tileset, so this choice does not change the tiles yet. */}
          <div className="space-y-1.5">
            <label className="text-xs font-display [font-variant:small-caps] tracking-wide font-bold text-[var(--rp-parchment-300)]">Environment Theme</label>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="vtt-select w-full font-prose"
            >
              <option value="dungeon">Ancient Catacombs (Stone &amp; Iron)</option>
              <option value="crypt_vampire">Baron&apos;s Crypt (Obsidian &amp; Gold)</option>
              <option value="cavern_underdark">Underdark Chasm (Fungal &amp; Magma)</option>
            </select>
            <p className="text-[10px] font-prose text-[var(--rp-parchment-300)] opacity-70">
              Cosmetic for now: the engine generates all themes from one dungeon tileset.
            </p>
          </div>

          {/* Grid Size Sliders */}
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)] mb-1">
                <span>Width: <span className="font-prose text-parchment-paper">{gridWidth}</span> Cells (<span className="font-prose text-parchment-paper">{gridWidth * 5}</span> ft)</span>
              </div>
              <input
                type="range"
                min={10}
                max={24}
                value={gridWidth}
                onChange={(e) => setGridWidth(Number(e.target.value))}
                className="w-full accent-tavern-accent"
              />
            </div>
            <div>
              <div className="flex justify-between text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)] mb-1">
                <span>Height: <span className="font-prose text-parchment-paper">{gridHeight}</span> Cells (<span className="font-prose text-parchment-paper">{gridHeight * 5}</span> ft)</span>
              </div>
              <input
                type="range"
                min={8}
                max={18}
                value={gridHeight}
                onChange={(e) => setGridHeight(Number(e.target.value))}
                className="w-full accent-tavern-accent"
              />
            </div>
          </div>

          {/* Seed Input — editable, not "CSPRNG entropy": you choose it, and
              the same seed regenerates the byte-identical map engine-side. */}
          <div className="p-3 bg-tavern-bg rounded-lg border border-tavern-border text-xs space-y-1">
            <label className="text-[10px] font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)]">Generation Seed</label>
            <input
              type="text"
              inputMode="numeric"
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              placeholder="blank = engine default 1337"
              className="vtt-input w-full font-prose text-tavern-accent font-bold"
            />
            <p className="text-[10px] font-prose text-[var(--rp-parchment-300)] opacity-70">
              Same seed + same size ⇒ identical map (solver RNG is engine-side).
              Re-click Generate with an unchanged seed to verify.
            </p>
          </div>

          {/* Generate Button */}
          <button
            onClick={handleGenerate}
            disabled={status.kind === 'generating'}
            className="vtt-btn vtt-btn-primary w-full disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${status.kind === 'generating' ? 'animate-spin' : ''}`} />
            <span>{status.kind === 'generating' ? 'Colliding Wave Function…' : 'Generate via Engine Solver'}</span>
          </button>

          {/* Honest failure banners — nothing below ever invents a map. */}
          {status.kind === 'contradiction' && (
            <div className="p-3 rounded-lg border border-red-500/50 bg-red-950/40 text-xs space-y-1">
              <div className="flex items-center gap-2 font-bold text-red-300">
                <AlertTriangle className="w-4 h-4" /> Solver exhausted
              </div>
              <p className="font-prose text-red-200">
                {status.code}: every collapse attempt contradicted, so no consistent map exists
                for these dimensions. Nothing was generated — adjust the size or pick a new seed
                and try again.
              </p>
            </div>
          )}
          {status.kind === 'unreachable' && (
            <div className="p-3 rounded-lg border border-amber-500/50 bg-amber-950/40 text-xs space-y-1">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <WifiOff className="w-4 h-4" /> Rules engine unreachable
              </div>
              <p className="font-prose text-amber-100">
                The generation proxy did not answer, so no map was produced. This studio does not
                synthesize maps locally — start the orchestrator/engine and retry.
              </p>
            </div>
          )}
          {(status.kind === 'rejected') && (
            <div className="p-3 rounded-lg border border-red-500/50 bg-red-950/40 text-xs space-y-1">
              <div className="flex items-center gap-2 font-bold text-red-300">
                <AlertTriangle className="w-4 h-4" /> Generation refused (HTTP {status.status})
              </div>
              <p className="font-prose text-red-200">
                {status.code ? `${status.code}: ` : ''}
                {status.message ?? 'The gateway rejected the request without a machine code.'}
              </p>
            </div>
          )}
        </div>

        {/* Send to Table — uses the existing App-level import callback
            (custom walls only); no new wiring was added for this. */}
        <div className="pt-4 border-t border-tavern-border space-y-2">
          <button
            onClick={() =>
              applied && onApplyMapToSession(applied.tiles, applied.width, applied.height)
            }
            disabled={!canDeploy}
            title={
              canDeploy
                ? undefined
                : 'Generate a map at the current dimensions first — the deployed layout must match them.'
            }
            className="vtt-btn vtt-btn-secondary w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Check className="w-4 h-4" />
            <span>Send to Table</span>
          </button>
          {applied && !canDeploy && (
            <p className="text-[10px] font-prose text-amber-300">
              The generated map is {applied.width}×{applied.height}; move the sliders back to those
              dimensions (or regenerate) before sending.
            </p>
          )}
          {applied && canDeploy && (
            <p className="text-[10px] font-prose text-[var(--rp-parchment-300)] opacity-70">
              Imports walls only today — doors, altars and chests arrive as open floor on the
              battle map (existing session-import behavior).
            </p>
          )}
        </div>
      </div>

      {/* Right Map Canvas Preview */}
      <div className="flex-1 h-full bg-tavern-bg p-6 flex flex-col items-center justify-center overflow-auto vtt-scrollbar">
        <div className="text-center mb-4 text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)]">
          {applied
            ? <>Engine-Solved Map (<span className="font-prose text-parchment-paper">{applied.width} × {applied.height}</span>) · Seed <span className="font-prose text-tavern-accent">#{seedText.trim() || '1337 (engine default)'}</span></>
            : lastRequest
              ? <>No map on screen — last request: <span className="font-prose">{lastRequest}</span></>
              : <>No map generated yet</>}
        </div>

        {applied ? (
          <>
            {/* Map Visualization Grid — tavern frame on leather matting */}
            <div className="rounded-2xl p-4 bg-[color-mix(in_srgb,var(--rp-leather-700)_55%,black)] shadow-2xl">
              <div
                className="grid p-3 rounded-xl border-2 border-tavern-border shadow-inner"
                style={{
                  gridTemplateColumns: `repeat(${applied.width}, 32px)`,
                  gridTemplateRows: `repeat(${applied.height}, 32px)`,
                  gap: '2px',
                }}
              >
                {applied.tiles.map((row, y) =>
                  row.map((cell, x) => {
                    const legend = TILE_LEGEND.find((t) => t.code === cell);
                    return (
                      <div
                        key={`tile-${x}-${y}`}
                        title={`(${x}, ${y}) — ${legend?.label ?? `unknown tile ${cell}`}`}
                        className={`w-8 h-8 rounded-sm ${
                          legend?.swatch ?? 'bg-fuchsia-900/40 border border-fuchsia-500/60'
                        }`}
                      >
                        {cell === 2 && (
                          <div className="w-full h-full flex items-center justify-center text-emerald-300 text-[10px] font-mono">▸</div>
                        )}
                        {cell === 3 && (
                          <div className="w-full h-full flex items-center justify-center text-[var(--rp-crimson-400)] text-[10px]">✦</div>
                        )}
                        {cell === 4 && (
                          <div className="w-full h-full flex items-center justify-center text-amber-400 text-[10px] font-mono">▣</div>
                        )}
                      </div>
                    );
                  }),
                )}
              </div>
            </div>

            {/* Legend — exactly the codes the engine emits */}
            <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-1 text-[11px] font-prose text-[var(--rp-parchment-300)]">
              {TILE_LEGEND.map((t) => (
                <span key={t.code} className="flex items-center gap-1.5">
                  <span className={`inline-block w-3 h-3 rounded-sm ${t.swatch}`} />
                  <span className="font-mono opacity-70">{t.code}</span> {t.label}
                </span>
              ))}
            </div>
          </>
        ) : (
          /* Honest empty state: no fabricated preview before the engine answers. */
          <div className="rounded-2xl px-10 py-14 border-2 border-dashed border-tavern-border text-center max-w-md">
            <Map className="w-10 h-10 mx-auto mb-4 text-[var(--rp-parchment-300)] opacity-40" />
            <p className="text-sm font-prose text-[var(--rp-parchment-300)]">
              Maps here come only from the Rust WFC solver
              (socket matching, restart-on-contradiction, flood-fill walkability). Set your
              dimensions and seed, then generate — nothing is drawn until the engine returns tiles.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
