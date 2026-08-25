import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, 
  Compass, 
  Navigation, 
  Sparkles, 
  Wand2, 
  Sword, 
  Skull, 
  Crosshair, 
  Flame, 
  Circle,
  Square,
  Triangle,
  Eye,
  Users,
  CloudRain
} from 'lucide-react';
import { ParticleFXManager } from '../render/particle_effects';
import { DiceBox3D, ActiveDiceRoll } from '../render/dice_box_3d';
import { RaycastLighting, Point } from '../render/raycast_lighting';
import {
  ensureFogMask,
  fogLayerIdForUser,
  renderFogOverlay,
  revealCellsInsidePolygon,
  unionFogMasks,
  FOG_LAYER_PREFIX,
} from '../render/fog_overlay';
import { WeatherEffectsManager, WeatherType } from '../render/weather_effects';
import { PixiBoard } from '../render/pixi_board';
import {
  elevationOffsetPx,
  groundShadowFor,
} from '../render/elevation_projection';
import { ServerDiceBox } from '../render/dice_box_real';
import { globalAudio } from '../render/audio_manager';
import type { YjsCrdtClient } from '../sync/yjs_doc_client';
import { User } from '../types/auth';
import { ConcentrationBadge, concentrationBadgeLabel } from './ConcentrationBadge';
import type { ConcentrationInfo } from '../api/concentration_state';

export interface Token {
  id: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  ac: number;
  color: string;
  isPlayer: boolean;
  avatarIconType?: string;
  conditions?: string[];
  elevationFeet?: number;
  /**
   * Pillar 9 (streamer/spectator secrecy): mirrors the engine entity flag
   * `is_visible` (crates/vtt-core/src/state.rs). `false` = GM-hidden entity.
   *
   * NOTE: this component does NOT enforce the flag — the App shell filters
   * hidden tokens OUT of the `tokens` prop before spectators ever see them
   * (filter-at-the-data-flow-layer, not inside the renderer). The field lives
   * on the type so hidden tokens can round-trip through snapshots/CRDT payloads
   * without being silently dropped for GMs, who must still see and re-reveal
   * them. Defaults to `true` (undefined = visible).
   */
  isVisible?: boolean;
}

interface TacticalCanvasProps {
  tokens: Token[];
  onTokenMove: (tokenId: string, newX: number, newY: number) => void;
  selectedTokenId: string | null;
  onSelectToken: (tokenId: string) => void;
  onUpdateTokenElevation?: (tokenId: string, newElevation: number) => void;
  currentUser?: User;
  /** Live peer pointers in BOARD coordinates. Empty array = no peers connected — nothing is rendered. */
  remoteCursors?: { id: string; name: string; color: string; x: number; y: number }[];
  /** Emitted on board hover with the hovered cell so the app can publish our cursor via CRDT awareness. */
  onLocalCursorMove?: (boardX: number, boardY: number) => void;
  activePing?: { x: number; y: number } | null;
  gridWidth?: number;
  gridHeight?: number;
  walls?: { x: number; y: number }[];
  particleFXRef?: React.MutableRefObject<ParticleFXManager | null>;
  diceBoxRef?: React.MutableRefObject<DiceBox3D | null>;
  /**
   * CRDT client backing fog-of-war. When absent (no Yjs transport wired by the
   * app shell) NO fog renders and nothing is written — an honest empty state,
   * never a fabricated default mask. Fog mask conventions are documented in
   * render/fog_overlay.ts.
   */
  syncClient?: YjsCrdtClient | null;
  /**
   * Pillar 9 spectator/streamer mode (set by the App shell when
   * userRole === 'spectator'). Effects:
   *  - fog-of-war is NEVER omniscient for spectators: they see the party's
   *    shared exploration memory, not the GM's unmasked map;
   *  - spectators observe only — their viewport does not WRITE fog reveals
   *    into the shared CRDT layers;
   *  - the "GM Sight" omniscient vision-perspective control is removed.
   *
   * Hidden-token exclusion itself happens upstream (see Token.isVisible):
   * this component simply renders whatever filtered token list it receives.
   *
   * BACKEND GAP: fog layers live in a shared Y.Doc with no per-role read
   * ACL — any connected peer can technically read another layer. True
   * spectator isolation needs the relay to withhold non-party fog layers.
   */
  spectatorMode?: boolean;
  /**
   * Per-token active-concentration map, derived from engine session-state
   * (see `parseConcentrationFromSessionState`). Entries with no projection
   * simply don't render — absence of data is not painted as "not concentrating".
   */
  concentrationByToken?: Record<string, ConcentrationInfo>;
}

export type VisionPerspective = 'party' | 'selected' | 'gm_omniscient';
export type TokenLightMode = 'torch' | 'lantern' | 'darkvision' | 'none';

export const TacticalCanvas: React.FC<TacticalCanvasProps> = ({
  tokens,
  onTokenMove,
  selectedTokenId,
  onSelectToken,
  onUpdateTokenElevation,
  currentUser,
  remoteCursors = [],
  onLocalCursorMove,
  activePing = null,
  gridWidth = 16,
  gridHeight = 12,
  walls = [
    { x: 8, y: 2 }, { x: 8, y: 3 }, { x: 8, y: 4 }, { x: 8, y: 5 }, { x: 8, y: 6 },
    { x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 },
  ],
  particleFXRef,
  diceBoxRef,
  syncClient = null,
  spectatorMode = false,
  concentrationByToken = {},
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 30, y: 30 });
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [draggedTokenId, setDraggedTokenId] = useState<string | null>(null);
  const [permissionWarning, setPermissionWarning] = useState<string | null>(null);
  const [tokenLightMode, setTokenLightMode] = useState<TokenLightMode>('torch');
  const [currentWeather, setCurrentWeather] = useState<WeatherType>('rain');
  
  // Tools
  const [measureMode, setMeasureMode] = useState(false);
  const [measureOrigin, setMeasureOrigin] = useState<{ x: number; y: number } | null>(null);
  const [measureTarget, setMeasureTarget] = useState<{ x: number; y: number } | null>(null);
  const [aoeShape, setAoeShape] = useState<'none' | 'sphere' | 'cone' | 'cube' | 'line'>('none');
  const [aoeOrigin, setAoeOrigin] = useState<{ x: number; y: number } | null>(null);
  const [visionPerspective, setVisionPerspective] = useState<VisionPerspective>('party');

  // FX Canvas Refs
  const fxCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lightingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pixiHostRef = useRef<HTMLDivElement | null>(null);
  const pixiBoard = useRef<PixiBoard | null>(null);
  const physicsDice = useRef<ServerDiceBox | null>(null);

  const internalParticleFX = useRef<ParticleFXManager>(new ParticleFXManager());
  const internalDiceBox = useRef<DiceBox3D>(new DiceBox3D());
  const raycastLighting = useRef<RaycastLighting>(new RaycastLighting());
  const weatherEffects = useRef<WeatherEffectsManager>(new WeatherEffectsManager());

  // --- Fog of war (CRDT-backed) -------------------------------------------
  // Overlay canvas for explored/unexplored darkening; the EFFECTIVE mask it
  // renders is refreshed by fog observers + local LoS seeding below. It lives
  // in a ref (not state) because the render loop repaints every frame anyway.
  const fogCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const effectiveFogMaskRef = useRef<Uint8Array | null>(null);
  const lastFogSeedAtRef = useRef(0);
  /** Local LoS → own-layer reveal writes are throttled to ~1 write/second. */
  const FOG_SEED_INTERVAL_MS = 1000;

  // GMs/admins (and anonymous solo sessions — same authority precedent as the
  // token click handler above) are omniscient: no fog is rendered or written.
  // Spectators are never omniscient regardless of the signed-in account's role:
  // a spectator seat must not inherit GM fog clearance (Pillar 9).
  const fogOmniscient =
    !spectatorMode &&
    (!currentUser || currentUser.role === 'admin' || currentUser.role === 'gm');

  // Spectators are pinned to party-shared sight; the GM-omniscient perspective
  // is unreachable for them (its button is also hidden below). Derived once so
  // both the render loop and the write path agree.
  const effectivePerspective: VisionPerspective = spectatorMode
    ? 'party'
    : visionPerspective;

  /**
   * Effective fog mask for the LOCAL perspective. Convention (full contract in
   * render/fog_overlay.ts):
   *   - omniscient viewer            → null (no fog at all)
   *   - own `user:<id>` layer exists → that layer (complement drawn dark)
   *   - no own layer yet             → union of other players' shared layers
   *                                     (party exploration memory); an empty
   *                                     union means fully-fogged.
   * Returns null whenever there is no CRDT client: no synced fog state means
   * nothing is fabricated locally.
   */
  const computeEffectiveFogMask = (): Uint8Array | null => {
    if (!syncClient || fogOmniscient) return null;
    const cells = gridWidth * gridHeight;
    const neededBytes = Math.ceil(cells / 8);
    if (currentUser) {
      const ownId = fogLayerIdForUser(currentUser.id);
      const own = syncClient.getFogLayer(ownId);
      if (own) return ensureFogMask(own, gridWidth, gridHeight);
      // No own mask yet: fall through to party-shared memory.
    }
    const peerMasks = syncClient
      .getFogLayerIds()
      .filter((id) => id.startsWith(FOG_LAYER_PREFIX))
      .map((id) => syncClient.getFogLayer(id));
    return unionFogMasks(peerMasks, neededBytes);
  };

  // Live updates: remote reveals (and our own echoed writes) merged into the
  // Y.Doc refresh the effective mask immediately — other players' exploration
  // appears on the next frame without any polling.
  useEffect(() => {
    if (!syncClient) {
      effectiveFogMaskRef.current = null;
      return;
    }
    const refresh = () => {
      effectiveFogMaskRef.current = computeEffectiveFogMask();
    };
    const unobserveAll = syncClient.observeFogLayers(refresh);
    if (currentUser) {
      const unobserveOwn = syncClient.observeFogLayer(fogLayerIdForUser(currentUser.id), refresh);
      return () => {
        unobserveAll();
        unobserveOwn();
      };
    }
    refresh();
    return unobserveAll;
    // computeEffectiveFogMask closes over syncClient/user/grid; the primitive
    // deps below cover every input it reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncClient, currentUser?.id, currentUser?.role, gridWidth, gridHeight]);

  // Physics dice (three.js + ammo.wasm) landing on SERVER-determined faces,
  // falling back to the 2D canvas tumble when WASM assets are unavailable.
  if (!physicsDice.current) physicsDice.current = new ServerDiceBox('dice-box-mount');
  type DieType = 'd20' | 'd12' | 'd8' | 'd6' | 'd4';
  const rollDiceAuthoritative = (
    type: DieType,
    value: number,
    x?: number,
    y?: number
  ) => {
    void (async () => {
      const ok = await physicsDice.current?.rollPredetermined(type, value);
      if (!ok && x !== undefined && y !== undefined) {
        internalDiceBox.current.rollDice(type, value, x, y);
      }
    })();
  };

  if (particleFXRef) particleFXRef.current = internalParticleFX.current;
  if (diceBoxRef) {
    diceBoxRef.current = {
      rollDice: rollDiceAuthoritative,
    } as unknown as DiceBox3D;
  }

  const cellSize = 60;

  // GPU-batched board layer (WebGL/WebGPU via PixiJS v8). When init fails
  // (no context, SSR, etc.) the DOM grid fallback below stays in charge.
  useEffect(() => {
    let cancelled = false;
    const host = pixiBoard.current;
    void host;
    const el = pixiHostRef.current;
    if (el && !pixiBoard.current) {
      const board = new PixiBoard(cellSize);
      board
        .init(el, gridWidth, gridHeight, new Set(walls.map((w) => `${w.x}:${w.y}`)))
        .then((ok) => {
          if (!cancelled && !ok) {
            board.destroy();
            return;
          }
          if (!cancelled) pixiBoard.current = board;
        });
    }
    return () => {
      cancelled = true;
      pixiBoard.current?.destroy();
      pixiBoard.current = null;
    };
    // Rebuild only when the board geometry changes.
  }, [gridWidth, gridHeight]);

  // Wall edits redraw the batched board layer.
  useEffect(() => {
    const board = pixiBoard.current;
    if (board?.isReady) {
      void board.redraw(gridWidth, gridHeight, new Set(walls.map((w) => `${w.x}:${w.y}`)));
    }
  }, [walls, gridWidth, gridHeight]);

  // Initialize and update raycast walls
  useEffect(() => {
    raycastLighting.current.updateWalls(walls, cellSize, gridWidth, gridHeight);
  }, [walls, gridWidth, gridHeight]);

  useEffect(() => {
    weatherEffects.current.setWeather(currentWeather);
  }, [currentWeather]);

  // Main Render Animation Loop for 3D Dice, Particle FX, and Dynamic 2D Raycast Vision
  useEffect(() => {
    let animId: number;
    const fxCanvas = fxCanvasRef.current;
    const lightCanvas = lightingCanvasRef.current;
    const fogCanvas = fogCanvasRef.current;
    if (!fxCanvas || !lightCanvas) return;

    const fxCtx = fxCanvas.getContext('2d');
    const lightCtx = lightCanvas.getContext('2d');
    const fogCtx = fogCanvas ? fogCanvas.getContext('2d') : null;
    if (!fxCtx || !lightCtx) return;

    const renderLoop = () => {
      // 1. Clear FX Canvas
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);

      // Render Dynamic Weather Shaders
      weatherEffects.current.updateAndRender(fxCtx, fxCanvas.width, fxCanvas.height);

      // Render Particles
      internalParticleFX.current.updateAndRender(fxCtx);

      // Render 3D Dice
      internalDiceBox.current.updateAndRender(fxCtx, (roll: ActiveDiceRoll) => {
        globalAudio.playWeaponImpact();
        if (roll.dieType === 'd20' && roll.targetValue === 20) {
          internalParticleFX.current.spawnGoldCritBurst(roll.currentX, roll.currentY, 50);
        } else {
          internalParticleFX.current.spawnMeleeImpact(roll.currentX, roll.currentY);
        }
      });

      // 2. Render 2D Raycast Lighting & Shadows based on Perspective Mode & Token Light Mode
      lightCtx.clearRect(0, 0, lightCanvas.width, lightCanvas.height);

      const lightRadius =
        tokenLightMode === 'torch'
          ? 260
          : tokenLightMode === 'lantern'
          ? 360
          : tokenLightMode === 'darkvision'
          ? 420
          : 130;

      if (effectivePerspective === 'party') {
        const playerSources: Point[] = tokens
          .filter((t) => t.isPlayer)
          .map((t) => ({
            x: (t.x + 0.5) * cellSize,
            y: (t.y + 0.5) * cellSize,
          }));
        
        if (playerSources.length > 0) {
          raycastLighting.current.renderMultiSourceLightingMask(
            lightCtx,
            playerSources,
            gridWidth * cellSize,
            gridHeight * cellSize,
            lightRadius
          );
        }
      } else if (effectivePerspective === 'selected') {
        const active = tokens.find((t) => t.id === selectedTokenId) || tokens[0];
        if (active) {
          const source: Point = {
            x: (active.x + 0.5) * cellSize,
            y: (active.y + 0.5) * cellSize,
          };
          raycastLighting.current.renderLightingMask(
            lightCtx,
            source,
            gridWidth * cellSize,
            gridHeight * cellSize,
            lightRadius
          );
        }
      }
      // 'gm_omniscient' leaves the lighting layer unmasked (full sight)

      // 3. CRDT fog-of-war overlay: darken every cell the local perspective
      // has not explored yet. No syncClient → mask is null → canvas is simply
      // cleared (honest absence of fog state, never a fabricated default).
      if (fogCtx) {
        renderFogOverlay(fogCtx, {
          mask: effectiveFogMaskRef.current,
          gridWidth,
          gridHeight,
          cellSize,
        });
      }

      // 4. Write path: seed OUR layer's revealed bits from the same LoS
      // polygons the lighting pass just drew, so explored area genuinely
      // accumulates per player through the Y.Doc and merges across the table.
      // Throttled to ~1 write/second; only fires when something new was seen.
      // Spectators never author exploration memory — they observe the party's,
      // they don't expand it (Pillar 9: read-only seats).
      if (
        syncClient &&
        !fogOmniscient &&
        !spectatorMode &&
        currentUser &&
        effectivePerspective !== 'gm_omniscient'
      ) {
        const nowMs = performance.now();
        if (nowMs - lastFogSeedAtRef.current >= FOG_SEED_INTERVAL_MS) {
          lastFogSeedAtRef.current = nowMs;
          const seedSources: Point[] =
            visionPerspective === 'party'
              ? tokens
                  .filter((t) => t.isPlayer)
                  .map((t) => ({
                    x: (t.x + 0.5) * cellSize,
                    y: (t.y + 0.5) * cellSize,
                  }))
              : (() => {
                  const active = tokens.find((t) => t.id === selectedTokenId) || tokens[0];
                  return active
                    ? [{ x: (active.x + 0.5) * cellSize, y: (active.y + 0.5) * cellSize }]
                    : [];
                })();

          if (seedSources.length > 0) {
            const ownLayerId = fogLayerIdForUser(currentUser.id);
            const ownMask = ensureFogMask(syncClient.getFogLayer(ownLayerId), gridWidth, gridHeight);
            let changed = false;
            seedSources.forEach((source) => {
              const poly = raycastLighting.current.computeVisibilityPolygon(source, lightRadius);
              changed =
                revealCellsInsidePolygon(ownMask, gridWidth, gridHeight, cellSize, poly) || changed;
            });
            if (changed) {
              syncClient.setFogLayer(ownLayerId, ownMask);
              effectiveFogMaskRef.current = computeEffectiveFogMask();
            }
          }
        }
      }

      animId = requestAnimationFrame(renderLoop);
    };

    renderLoop();
    return () => cancelAnimationFrame(animId);
  }, [
    tokens,
    selectedTokenId,
    effectivePerspective,
    spectatorMode,
    tokenLightMode,
    gridWidth,
    gridHeight,
    cellSize,
    syncClient,
    fogOmniscient,
    currentUser,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]);

  const isWall = (x: number, y: number) => {
    return walls.some((w) => w.x === x && w.y === y);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      setStartPan({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - startPan.x, y: e.clientY - startPan.y });
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const handleCellClick = (x: number, y: number) => {
    if (aoeShape !== 'none') {
      setAoeOrigin({ x, y });
      globalAudio.playSpellCast();
      if (aoeShape === 'sphere') {
        internalParticleFX.current.spawnFireballShockwave(
          (x + 0.5) * cellSize,
          (y + 0.5) * cellSize,
          240
        );
      }
      return;
    }

    if (measureMode) {
      if (!measureOrigin) {
        setMeasureOrigin({ x, y });
      } else {
        setMeasureTarget({ x, y });
      }
      return;
    }

    if (draggedTokenId) {
      if (!isWall(x, y)) {
        onTokenMove(draggedTokenId, x, y);
      }
      setDraggedTokenId(null);
    }
  };

  const calculateDistanceFeet = () => {
    if (!measureOrigin || !measureTarget) return 0;
    const dx = measureTarget.x - measureOrigin.x;
    const dy = measureTarget.y - measureOrigin.y;
    return Math.round(Math.sqrt(dx * dx + dy * dy) * 5);
  };

  const renderTokenIcon = (token: Token) => {
    const iconType = token.avatarIconType || (token.isPlayer ? 'fighter' : 'boss');
    switch (iconType) {
      case 'mage':
      case 'caster':
        return <Sparkles className="w-5 h-5 text-parchment-aged" />;
      case 'boss':
        return <Skull className="w-5 h-5 text-rose-200" />;
      case 'scout':
        return <Crosshair className="w-5 h-5 text-amber-200" />;
      case 'fighter':
      default:
        return <Shield className="w-5 h-5 text-tavern-accent" />;
    }
  };

  return (
    <div
      className="relative w-full h-full bg-tavern-bg overflow-hidden cursor-crosshair select-none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={(e) => {
        const newZoom = Math.min(Math.max(0.5, zoom - e.deltaY * 0.001), 2.2);
        setZoom(newZoom);
      }}
    >
      {/* Permission Warning Banner */}
      {permissionWarning && (
        <>
          {/* Toast layer: was z-50 — the same plane as every modal backdrop, so it
              fought with sheets opened over the canvas. Toast rung sits above all
              interactive chrome but below modals. */}
          <div className="absolute top-16 left-1/2 -translate-x-1/2 px-4 py-2 bg-rose-950/90 border border-rose-500/80 rounded-xl text-xs font-mono font-bold text-rose-200 shadow-2xl backdrop-blur-md animate-bounce" style={{ zIndex: 'var(--z-toast)' }}>
            ⚠️ {permissionWarning}
          </div>
        </>
      )}

      {/* Floating Tactical Overlay Controls */}
      {/* Canvas tool rail. flex-wrap + max-width keep tools inside the canvas
          area: without them the rail ran under the right character-sheet dock
          on ≤1440px screens, silently clipping the elevation stepper. */}
      {/* Tool rail sits at chrome layer: above canvas FX but below any popover/modal. */}
      <div className="absolute top-4 left-4 flex flex-wrap items-center gap-2 max-w-[calc(100%-2rem)] vtt-glass-panel p-2 rounded-xl text-xs font-mono shadow-2xl" style={{ zIndex: 'var(--z-chrome)' }}>
        {/* Zoom Controls */}
        <div className="flex items-center gap-1 vtt-surface p-0.5 rounded-lg">
          <button
            onClick={() => setZoom((z) => Math.min(2.2, z + 0.15))}
            aria-label="Zoom in"
            className="w-6 h-6 flex items-center justify-center bg-black/30 hover:bg-black/20 rounded text-parchment-aged"
          >
            +
          </button>
          <span className="text-parchment-aged/80 px-1" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
            aria-label="Zoom out"
            className="w-6 h-6 flex items-center justify-center bg-black/30 hover:bg-black/20 rounded text-parchment-aged"
          >
            -
          </button>
        </div>

        <div className="h-4 w-px bg-tavern-border" />

        {/* Ruler Tool */}
        <button
          onClick={() => {
            setMeasureMode(!measureMode);
            setMeasureOrigin(null);
            setMeasureTarget(null);
            setAoeShape('none');
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
            measureMode ? 'bg-rule-red text-parchment-aged font-bold' : 'vtt-surface hover:bg-black/20 text-parchment-aged/80'
          }`}
        >
          <Compass className="w-3.5 h-3.5" />
          <span>{measureMode && measureTarget ? `${calculateDistanceFeet()} ft` : 'Ruler'}</span>
        </button>

        {/* AoE Templates */}
        <div className="flex items-center gap-1 vtt-surface p-0.5 rounded-lg">
          <button
            onClick={() => setAoeShape(aoeShape === 'sphere' ? 'none' : 'sphere')}
            className={`p-1.5 rounded ${aoeShape === 'sphere' ? 'bg-orange-600 text-white' : 'text-parchment-aged/70 hover:text-parchment-aged'}`}
            title="20ft Sphere AoE (Fireball)"
            aria-label="Toggle 20ft sphere area-of-effect template"
          >
            <Circle className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setAoeShape(aoeShape === 'cone' ? 'none' : 'cone')}
            className={`p-1.5 rounded ${aoeShape === 'cone' ? 'bg-orange-600 text-white' : 'text-parchment-aged/70 hover:text-parchment-aged'}`}
            title="15ft Cone AoE (Burning Hands)"
            aria-label="Toggle 15ft cone area-of-effect template"
          >
            <Triangle className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setAoeShape(aoeShape === 'cube' ? 'none' : 'cube')}
            className={`p-1.5 rounded ${aoeShape === 'cube' ? 'bg-orange-600 text-white' : 'text-parchment-aged/70 hover:text-parchment-aged'}`}
            title="20ft Cube AoE"
            aria-label="Toggle 20ft cube area-of-effect template"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="h-4 w-px bg-tavern-border" />

        {/* Multi-Player POV & Vision Perspective Selector */}
        <div className="flex items-center gap-1 vtt-surface p-1 rounded-lg text-[11px] font-mono">
          <button
            onClick={() => {
              setVisionPerspective('party');
              globalAudio.playTurnAdvance();
            }}
            className={`flex items-center gap-1 px-2 py-1 rounded transition ${
              visionPerspective === 'party'
                ? 'bg-rule-red text-parchment-aged font-bold'
                : 'text-parchment-aged/70 hover:text-parchment-aged'
            }`}
            title="Party Shared Optical Vision"
          >
            <Users className="w-3 h-3" />
            <span>Party Sight</span>
          </button>

          <button
            onClick={() => {
              setVisionPerspective('selected');
              globalAudio.playTurnAdvance();
            }}
            className={`flex items-center gap-1 px-2 py-1 rounded transition ${
              visionPerspective === 'selected'
                ? 'bg-rule-red text-parchment-aged font-bold'
                : 'text-parchment-aged/70 hover:text-parchment-aged'
            }`}
            title="Individual Token Optical POV"
          >
            <Eye className="w-3 h-3" />
            <span>Token POV</span>
          </button>

          {/* GM omniscient sight is a GM-only control — removed entirely for
              spectator/streamer seats (Pillar 9); spectatorMode also pins the
              effective perspective to 'party' above. */}
          {!spectatorMode && (
            <button
              onClick={() => {
                setVisionPerspective('gm_omniscient');
                globalAudio.playTurnAdvance();
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded transition ${
                visionPerspective === 'gm_omniscient'
                  ? 'bg-rule-red text-parchment-aged font-bold'
                  : 'text-parchment-aged/70 hover:text-parchment-aged'
              }`}
              title="GM Master Sight (Unmasked Omniscient View)"
            >
              <Sparkles className="w-3 h-3" />
              <span>GM Sight</span>
            </button>
          )}
        </div>

        {/* Dynamic Light Source Preset (Roll20 Style) */}
        <button
          onClick={() => {
            const modes: TokenLightMode[] = ['torch', 'lantern', 'darkvision', 'none'];
            const nextIdx = (modes.indexOf(tokenLightMode) + 1) % modes.length;
            setTokenLightMode(modes[nextIdx]);
            globalAudio.playTurnAdvance();
          }}
          className="flex items-center gap-1.5 vtt-surface px-2.5 py-1 rounded-lg text-[11px] font-mono text-orange-400 font-bold hover:bg-black/20 transition cursor-pointer"
          title="Toggle Dynamic Lighting Source Preset"
        >
          <Flame className="w-3.5 h-3.5 text-orange-400" />
          <span>
            {tokenLightMode === 'torch'
              ? 'Torch (20/40ft)'
              : tokenLightMode === 'lantern'
              ? 'Lantern (30/60ft)'
              : tokenLightMode === 'darkvision'
              ? 'Darkvision (60ft)'
              : 'No Light'}
          </span>
        </button>

        {/* Dynamic Tabletop Weather Selector (Roll20 Style) */}
        <button
          onClick={() => {
            const weathers: WeatherType[] = ['rain', 'snow', 'embers', 'fog', 'none'];
            const nextIdx = (weathers.indexOf(currentWeather) + 1) % weathers.length;
            const nextWeather = weathers[nextIdx];
            setCurrentWeather(nextWeather);
            globalAudio.playTurnAdvance();
          }}
          className="flex items-center gap-1.5 vtt-surface px-2.5 py-1 rounded-lg text-[11px] font-mono text-[color:var(--rp-parchment-300)] font-bold hover:bg-black/20 transition cursor-pointer"
          title="Toggle Dynamic Tabletop Weather FX"
        >
          <CloudRain className="w-3.5 h-3.5 text-[color:var(--rp-parchment-300)]" />
          <span>
            {currentWeather === 'rain'
              ? 'Rain & Thunder'
              : currentWeather === 'snow'
              ? 'Snow Blizzard'
              : currentWeather === 'embers'
              ? 'Volcanic Embers'
              : currentWeather === 'fog'
              ? 'Rolling Fog'
              : 'Clear Weather'}
          </span>
        </button>

        {/* Token Elevation Stepper (Roll20 Style) */}
        {selectedTokenId && onUpdateTokenElevation && (
          <div className="flex items-center gap-1.5 vtt-surface px-2 py-1 rounded-lg text-[11px] font-mono text-amber-300">
            <span>Elevation: {tokens.find((t) => t.id === selectedTokenId)?.elevationFeet || 0}ft</span>
            <button
              onClick={() => {
                const currentEl = tokens.find((t) => t.id === selectedTokenId)?.elevationFeet || 0;
                onUpdateTokenElevation(selectedTokenId, currentEl + 5);
              }}
              className="w-5 h-5 flex items-center justify-center bg-black/30 hover:bg-black/20 rounded text-parchment-aged font-bold cursor-pointer"
              title="Raise elevation +5ft"
            >
              +
            </button>
            <button
              onClick={() => {
                const currentEl = tokens.find((t) => t.id === selectedTokenId)?.elevationFeet || 0;
                onUpdateTokenElevation(selectedTokenId, Math.max(0, currentEl - 5));
              }}
              className="w-5 h-5 flex items-center justify-center bg-black/30 hover:bg-black/20 rounded text-parchment-aged font-bold cursor-pointer"
              title="Lower elevation -5ft"
            >
              -
            </button>
          </div>
        )}

        {/* Center Button */}
        <button
          onClick={() => setPan({ x: 30, y: 30 })}
          className="p-1.5 vtt-surface hover:bg-black/20 text-parchment-aged/80 rounded-lg transition"
          title="Recenter Map Viewport"
        >
          <Navigation className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Grid Canvas Stage */}
      <div
        className="absolute transition-transform duration-75 origin-top-left"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          width: `${gridWidth * cellSize}px`,
          height: `${gridHeight * cellSize}px`,
        }}
      >
        <div
          className="relative rounded-xl border-2 border-tavern-border shadow-2xl bg-tavern-bg overflow-hidden"
          style={{ width: gridWidth * cellSize, height: gridHeight * cellSize }}
        >
          {/* GPU-batched floor/wall layer (PixiJS v8 WebGL/WebGPU). */}
          <div ref={pixiHostRef} className="absolute inset-0" />
          {/* Physics dice overlay: full-stage WASM canvas, click-transparent. */}
          <div id="dice-box-mount" className="absolute inset-0 pointer-events-none z-30" />

          {/* Interaction + highlight overlay: only the cells that matter
              (AoE footprint) are individual DOM nodes; plain floor cells are
              handled by one click-mapping surface below. */}
          {Array.from({ length: gridHeight }).map((_, y) =>
            Array.from({ length: gridWidth }).map((_, x) => {
              if (!aoeOrigin || aoeShape !== 'sphere') return null;
              const dist = Math.sqrt((x - aoeOrigin.x) ** 2 + (y - aoeOrigin.y) ** 2);
              return dist <= 4.0 ? (
                <div
                  key={`aoe-${x}-${y}`}
                  className="absolute inset-0 bg-orange-500/30 border border-orange-400/60 pointer-events-none animate-pulse-glow"
                  style={{
                    width: cellSize,
                    height: cellSize,
                    left: x * cellSize,
                    top: y * cellSize,
                  }}
                />
              ) : null;
            })
          )}
          <div
            className="absolute inset-0"
            onClick={(event) => {
              const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
              const cx = Math.floor((event.clientX - rect.left) / cellSize);
              const cy = Math.floor((event.clientY - rect.top) / cellSize);
              handleCellClick(cx, cy);
            }}
            onMouseMove={(event) => {
              if (!onLocalCursorMove) return;
              // Same mapping as the click surface: pixel → grid-cell board coords.
              const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
              const cx = Math.floor((event.clientX - rect.left) / cellSize);
              const cy = Math.floor((event.clientY - rect.top) / cellSize);
              if (cx >= 0 && cy >= 0 && cx < gridWidth && cy < gridHeight) {
                onLocalCursorMove(cx, cy);
              }
            }}
          />


          {/* Tokens Layer */}
          {tokens.map((token) => {
            const isSelected = selectedTokenId === token.id;
            const isDragging = draggedTokenId === token.id;

            // Pillar 9 elevation projection (render/elevation_projection.ts):
            // pure 2.5D convention — sprite stack lifts by ~4px/ft while a soft
            // ground shadow stays pinned to the board cell and shrinks/fades.
            // PRESENTATION ONLY: lighting, fog seeding, occlusion and spatial
            // audio all consume raw grid coords below and must never see these
            // pixel offsets (they are applied exactly once, here).
            const elevationFeet = token.elevationFeet ?? 0;
            const elevationOffset = elevationOffsetPx(elevationFeet);
            const groundShadow = groundShadowFor(elevationFeet, cellSize);

            return (
              <div
                key={token.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectToken(token.id);

                  // Token Authority Enforcement
                  const hasAuthority =
                    !currentUser ||
                    currentUser.role === 'admin' ||
                    currentUser.role === 'gm' ||
                    (currentUser.assignedTokenIds &&
                      (currentUser.assignedTokenIds.includes('*') || currentUser.assignedTokenIds.includes(token.id)));

                  if (!hasAuthority) {
                    setPermissionWarning(`Authority Denied: ${token.name} is controlled by another player or the GM.`);
                    setTimeout(() => setPermissionWarning(null), 3000);
                    return;
                  }

                  setDraggedTokenId(isDragging ? null : token.id);
                }}
                className={`absolute flex flex-col items-center justify-center transition-all duration-200 cursor-pointer ${
                  isSelected ? 'z-30' : 'z-10'
                }`}
                style={{
                  left: `${token.x * cellSize}px`,
                  top: `${token.y * cellSize}px`,
                  width: `${cellSize}px`,
                  height: `${cellSize}px`,
                  // Airborne tokens read above grounded ones; the selected rung
                  // (z-30 class) still wins, so selection styling is untouched.
                  zIndex: !isSelected && elevationOffset > 0 ? 20 : undefined,
                }}
              >
                {/* Ground shadow ellipse: pinned to the board cell (NOT lifted
                    with the sprite) so the gap between shadow and token body
                    is what reads as altitude. Deterministic from elevation. */}
                {elevationFeet > 0 && (
                  <div
                    className="absolute rounded-[50%] bg-black pointer-events-none"
                    aria-hidden="true"
                    style={{
                      width: `${groundShadow.widthPx}px`,
                      height: `${groundShadow.heightPx}px`,
                      left: `${(cellSize - groundShadow.widthPx) / 2}px`,
                      top: `${cellSize - groundShadow.heightPx / 2 - cellSize * 0.14}px`,
                      opacity: groundShadow.opacity,
                      filter: 'blur(3px)',
                    }}
                  />
                )}

                {/* Lifted sprite stack: everything that belongs to the token
                    body (rings, badge, disc, hp bar, label) translates up by
                    the projected offset; the shadow above does not move. */}
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center transition-transform duration-200 ease-out"
                  style={{
                    transform: `translateY(-${elevationOffset}px)`,
                  }}
                >
                {/* Dynamic Token Aura Field (10ft Paladin Aura / Spirit Guardians) */}
                {isSelected && (
                  <div
                    className="absolute rounded-full border border-amber-400/40 bg-amber-500/10 pointer-events-none animate-pulse-glow z-0"
                    style={{
                      width: `${cellSize * 3}px`,
                      height: `${cellSize * 3}px`,
                      left: `${-cellSize}px`,
                      top: `${-cellSize}px`,
                    }}
                  />
                )}

                {/* Token Condition Aura Ring */}
                {token.conditions && token.conditions.length > 0 && (
                  <div
                    className="absolute -inset-1 rounded-full border-2 border-dashed border-rule-red animate-spin pointer-events-none z-20"
                    title={`Active Conditions: ${token.conditions.join(', ')}`}
                  />
                )}

                {/* Concentration ring accent (iteration 58). Solid violet —
                    deliberately NOT dashed/spinning so it never reads as the
                    condition ring. Label comes verbatim from engine
                    session-state (`concentration.spell_id`); a token with no
                    projection simply gets nothing here. */}
                {(() => {
                  const conc = concentrationByToken[token.id];
                  if (!conc) return null;
                  return (
                    <>
                      <div
                        data-testid="concentration-ring"
                        className="absolute -inset-[3px] rounded-full border-2 border-violet-400/90 pointer-events-none z-30"
                        style={{ boxShadow: '0 0 8px rgba(167,139,250,0.55)' }}
                        title={concentrationBadgeLabel(conc) ?? undefined}
                      />
                      <div className="absolute -top-1.5 -right-1 z-40 pointer-events-none">
                        <ConcentrationBadge info={conc} variant="token" />
                      </div>
                    </>
                  );
                })()}

                {isSelected && (
                  <div className="absolute inset-0.5 rounded-full border-2 border-tavern-accent animate-pulse-glow" />
                )}

                {token.elevationFeet && token.elevationFeet > 0 ? (
                  <span className="absolute -top-1 -right-1 px-1.5 py-0.2 bg-amber-950/90 border border-amber-500/70 text-amber-300 text-[8px] font-mono font-bold rounded-full shadow-lg z-40">
                    +{token.elevationFeet}ft
                  </span>
                ) : null}

                <div
                  className={`w-11 h-11 rounded-full flex items-center justify-center shadow-xl border-2 transition-transform ${
                    isSelected ? 'border-tavern-accent scale-110 shadow-amber-600/50' : 'border-parchment-aged/80 shadow-black/80'
                  }`}
                  style={{ backgroundColor: token.color }}
                >
                  {renderTokenIcon(token)}
                </div>

                <div className="w-10 h-1.5 bg-black/60 rounded-full mt-1 overflow-hidden border border-tavern-border shadow-sm">
                  <div
                    className={`h-full transition-all duration-300 ${
                      token.hp / token.maxHp > 0.5
                        ? 'bg-emerald-500'
                        : token.hp / token.maxHp > 0.2
                        ? 'bg-amber-500'
                        : 'bg-rose-500'
                    }`}
                    style={{ width: `${Math.max(0, (token.hp / token.maxHp) * 100)}%` }}
                  />
                </div>

                <span className="text-[10px] font-mono font-semibold text-parchment-aged px-1.5 py-0.5 bg-black/70 border border-tavern-border rounded mt-0.5 backdrop-blur-md whitespace-nowrap shadow">
                  {token.name}
                </span>
                </div>
              </div>
            );
          })}

          {/* Live Multiplayer Remote Player Cursors */}
          {remoteCursors.map((cursor) => (
            <div
              key={cursor.id}
              className="absolute pointer-events-none z-35 transition-all duration-300 flex items-center space-x-1.5"
              style={{
                left: `${(cursor.x + 0.4) * cellSize}px`,
                top: `${(cursor.y + 0.4) * cellSize}px`,
              }}
            >
              <div
                className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-lg animate-pulse"
                style={{ backgroundColor: cursor.color }}
              />
              <span
                className="px-2 py-0.5 text-[9px] font-mono font-bold text-white rounded-md shadow-2xl backdrop-blur-md border border-white/30 whitespace-nowrap"
                style={{ backgroundColor: cursor.color }}
              >
                🎯 {cursor.name} [{String.fromCharCode(65 + cursor.x)}{cursor.y + 1}]
              </span>
            </div>
          ))}

          {/* Active Tactical Beacon Map Ping */}
          {activePing && (
            <div
              className="absolute pointer-events-none z-35 flex items-center justify-center -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${(activePing.x + 0.5) * cellSize}px`,
                top: `${(activePing.y + 0.5) * cellSize}px`,
                width: `${cellSize * 2}px`,
                height: `${cellSize * 2}px`,
              }}
            >
              <div className="w-full h-full rounded-full border-4 border-amber-400 bg-amber-400/20 animate-ping" />
              <div className="absolute w-4 h-4 rounded-full bg-amber-300 border-2 border-white shadow-lg" />
            </div>
          )}

          {/* 2D Raycast Lighting & Line-of-Sight Mask Layer */}
          <canvas
            ref={lightingCanvasRef}
            width={gridWidth * cellSize}
            height={gridHeight * cellSize}
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 'var(--z-tokens)' }}
          />

          {/* Fog-of-war overlay: darkens unexplored cells for the local
              perspective (CRDT-backed via syncClient). Sits one rung above the
              lighting mask so explored-but-unlit cells keep their dim glow
              while never-explored cells hide tokens and terrain alike. */}
          <canvas
            ref={fogCanvasRef}
            width={gridWidth * cellSize}
            height={gridHeight * cellSize}
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 'calc(var(--z-tokens) + 1)' }}
          />

          {/* 3D Dice & WebGL Particle FX Overlay Canvas — fx rung. Was z-40,
              which collided with popover dropdowns anchored over the canvas. */}
          <canvas
            ref={fxCanvasRef}
            width={gridWidth * cellSize}
            height={gridHeight * cellSize}
            className="absolute inset-0 pointer-events-none"
            style={{ zIndex: 'var(--z-fx)' }}
          />
        </div>
      </div>
    </div>
  );
};
