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
import { WeatherEffectsManager, WeatherType } from '../render/weather_effects';
import { globalAudio } from '../render/audio_manager';
import { User } from '../types/auth';

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
}

interface TacticalCanvasProps {
  tokens: Token[];
  onTokenMove: (tokenId: string, newX: number, newY: number) => void;
  selectedTokenId: string | null;
  onSelectToken: (tokenId: string) => void;
  onUpdateTokenElevation?: (tokenId: string, newElevation: number) => void;
  currentUser?: User;
  remoteCursors?: { id: string; name: string; color: string; x: number; y: number }[];
  activePing?: { x: number; y: number } | null;
  gridWidth?: number;
  gridHeight?: number;
  walls?: { x: number; y: number }[];
  particleFXRef?: React.MutableRefObject<ParticleFXManager | null>;
  diceBoxRef?: React.MutableRefObject<DiceBox3D | null>;
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
  remoteCursors = [
    { id: 'usr_lyra', name: 'Lyra', color: '#818cf8', x: 6, y: 3 },
    { id: 'usr_player1', name: 'Thorin', color: '#ef4444', x: 3, y: 5 },
  ],
  activePing = null,
  gridWidth = 16,
  gridHeight = 12,
  walls = [
    { x: 8, y: 2 }, { x: 8, y: 3 }, { x: 8, y: 4 }, { x: 8, y: 5 }, { x: 8, y: 6 },
    { x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 },
  ],
  particleFXRef,
  diceBoxRef,
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

  const internalParticleFX = useRef<ParticleFXManager>(new ParticleFXManager());
  const internalDiceBox = useRef<DiceBox3D>(new DiceBox3D());
  const raycastLighting = useRef<RaycastLighting>(new RaycastLighting());
  const weatherEffects = useRef<WeatherEffectsManager>(new WeatherEffectsManager());

  if (particleFXRef) particleFXRef.current = internalParticleFX.current;
  if (diceBoxRef) diceBoxRef.current = internalDiceBox.current;

  const cellSize = 60;

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
    if (!fxCanvas || !lightCanvas) return;

    const fxCtx = fxCanvas.getContext('2d');
    const lightCtx = lightCanvas.getContext('2d');
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

      if (visionPerspective === 'party') {
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
      } else if (visionPerspective === 'selected') {
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

      animId = requestAnimationFrame(renderLoop);
    };

    renderLoop();
    return () => cancelAnimationFrame(animId);
  }, [tokens, selectedTokenId, visionPerspective, tokenLightMode, gridWidth, gridHeight]);

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
        return <Sparkles className="w-5 h-5 text-purple-200" />;
      case 'boss':
        return <Skull className="w-5 h-5 text-rose-200" />;
      case 'scout':
        return <Crosshair className="w-5 h-5 text-amber-200" />;
      case 'fighter':
      default:
        return <Shield className="w-5 h-5 text-sky-200" />;
    }
  };

  return (
    <div
      className="relative w-full h-full bg-slate-950 overflow-hidden cursor-crosshair select-none"
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
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-rose-950/90 border border-rose-500/80 rounded-xl text-xs font-mono font-bold text-rose-200 shadow-2xl backdrop-blur-md animate-bounce">
          ⚠️ {permissionWarning}
        </div>
      )}

      {/* Floating Tactical Overlay Controls */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2 vtt-glass-panel p-2 rounded-xl text-xs font-mono shadow-2xl border border-slate-800">
        {/* Zoom Controls */}
        <div className="flex items-center gap-1 bg-slate-900/90 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setZoom((z) => Math.min(2.2, z + 0.15))}
            className="w-6 h-6 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
          >
            +
          </button>
          <span className="text-slate-400 px-1">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
            className="w-6 h-6 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
          >
            -
          </button>
        </div>

        <div className="h-4 w-px bg-slate-800" />

        {/* Ruler Tool */}
        <button
          onClick={() => {
            setMeasureMode(!measureMode);
            setMeasureOrigin(null);
            setMeasureTarget(null);
            setAoeShape('none');
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${
            measureMode ? 'bg-purple-600 text-white font-bold' : 'bg-slate-900/90 hover:bg-slate-800 text-slate-300 border border-slate-800'
          }`}
        >
          <Compass className="w-3.5 h-3.5" />
          <span>{measureMode && measureTarget ? `${calculateDistanceFeet()} ft` : 'Ruler'}</span>
        </button>

        {/* AoE Templates */}
        <div className="flex items-center gap-1 bg-slate-900/90 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setAoeShape(aoeShape === 'sphere' ? 'none' : 'sphere')}
            className={`p-1.5 rounded ${aoeShape === 'sphere' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            title="20ft Sphere AoE (Fireball)"
          >
            <Circle className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setAoeShape(aoeShape === 'cone' ? 'none' : 'cone')}
            className={`p-1.5 rounded ${aoeShape === 'cone' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            title="15ft Cone AoE (Burning Hands)"
          >
            <Triangle className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setAoeShape(aoeShape === 'cube' ? 'none' : 'cube')}
            className={`p-1.5 rounded ${aoeShape === 'cube' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            title="20ft Cube AoE"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="h-4 w-px bg-slate-800" />

        {/* Multi-Player POV & Vision Perspective Selector */}
        <div className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-lg border border-slate-800 text-[11px] font-mono">
          <button
            onClick={() => {
              setVisionPerspective('party');
              globalAudio.playTurnAdvance();
            }}
            className={`flex items-center gap-1 px-2 py-1 rounded transition ${
              visionPerspective === 'party'
                ? 'bg-purple-600 text-white font-bold'
                : 'text-slate-400 hover:text-slate-200'
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
                ? 'bg-purple-600 text-white font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="Individual Token Optical POV"
          >
            <Eye className="w-3 h-3" />
            <span>Token POV</span>
          </button>

          <button
            onClick={() => {
              setVisionPerspective('gm_omniscient');
              globalAudio.playTurnAdvance();
            }}
            className={`flex items-center gap-1 px-2 py-1 rounded transition ${
              visionPerspective === 'gm_omniscient'
                ? 'bg-purple-600 text-white font-bold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
            title="GM Master Sight (Unmasked Omniscient View)"
          >
            <Sparkles className="w-3 h-3" />
            <span>GM Sight</span>
          </button>
        </div>

        {/* Dynamic Light Source Preset (Roll20 Style) */}
        <button
          onClick={() => {
            const modes: TokenLightMode[] = ['torch', 'lantern', 'darkvision', 'none'];
            const nextIdx = (modes.indexOf(tokenLightMode) + 1) % modes.length;
            setTokenLightMode(modes[nextIdx]);
            globalAudio.playTurnAdvance();
          }}
          className="flex items-center gap-1.5 bg-slate-900/90 px-2.5 py-1 rounded-lg border border-slate-800 text-[11px] font-mono text-orange-400 font-bold hover:bg-slate-800 transition cursor-pointer"
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
          className="flex items-center gap-1.5 bg-slate-900/90 px-2.5 py-1 rounded-lg border border-slate-800 text-[11px] font-mono text-sky-400 font-bold hover:bg-slate-800 transition cursor-pointer"
          title="Toggle Dynamic Tabletop Weather FX"
        >
          <CloudRain className="w-3.5 h-3.5 text-sky-400" />
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
          <div className="flex items-center gap-1.5 bg-slate-900/90 px-2 py-1 rounded-lg border border-slate-800 text-[11px] font-mono text-amber-300">
            <span>Elevation: {tokens.find((t) => t.id === selectedTokenId)?.elevationFeet || 0}ft</span>
            <button
              onClick={() => {
                const currentEl = tokens.find((t) => t.id === selectedTokenId)?.elevationFeet || 0;
                onUpdateTokenElevation(selectedTokenId, currentEl + 5);
              }}
              className="w-5 h-5 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded text-slate-200 font-bold cursor-pointer"
              title="Raise elevation +5ft"
            >
              +
            </button>
            <button
              onClick={() => {
                const currentEl = tokens.find((t) => t.id === selectedTokenId)?.elevationFeet || 0;
                onUpdateTokenElevation(selectedTokenId, Math.max(0, currentEl - 5));
              }}
              className="w-5 h-5 flex items-center justify-center bg-slate-800 hover:bg-slate-700 rounded text-slate-200 font-bold cursor-pointer"
              title="Lower elevation -5ft"
            >
              -
            </button>
          </div>
        )}

        {/* Center Button */}
        <button
          onClick={() => setPan({ x: 30, y: 30 })}
          className="p-1.5 bg-slate-900/90 hover:bg-slate-800 text-slate-300 rounded-lg border border-slate-800 transition"
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
          className="grid relative rounded-xl border-2 border-slate-800 shadow-2xl bg-slate-950 overflow-hidden"
          style={{
            gridTemplateColumns: `repeat(${gridWidth}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${gridHeight}, ${cellSize}px)`,
          }}
        >
          {/* Grid Cells */}
          {Array.from({ length: gridHeight }).map((_, y) =>
            Array.from({ length: gridWidth }).map((_, x) => {
              const wall = isWall(x, y);
              
              let isInsideAoe = false;
              if (aoeOrigin && aoeShape === 'sphere') {
                const dist = Math.sqrt((x - aoeOrigin.x) ** 2 + (y - aoeOrigin.y) ** 2);
                isInsideAoe = dist <= 4.0;
              }

              return (
                <div
                  key={`cell-${x}-${y}`}
                  onClick={() => handleCellClick(x, y)}
                  className={`relative border border-slate-900/80 transition-all ${
                    wall
                      ? 'bg-slate-850 border-slate-700/80 shadow-inner'
                      : (x + y) % 2 === 0
                      ? 'bg-slate-900/90 hover:bg-slate-850'
                      : 'bg-slate-900/60 hover:bg-slate-850/60'
                  }`}
                  style={{ width: cellSize, height: cellSize }}
                >
                  <span className="absolute bottom-1 right-1 text-[8px] font-mono text-slate-700 select-none pointer-events-none">
                    {String.fromCharCode(65 + x)}{y + 1}
                  </span>

                  {wall && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-slate-600/70">
                      <Shield className="w-5 h-5 opacity-40" />
                    </div>
                  )}

                  {isInsideAoe && (
                    <div className="absolute inset-0 bg-orange-500/30 border border-orange-400/60 pointer-events-none animate-pulse-glow" />
                  )}
                </div>
              );
            })
          )}

          {/* Tokens Layer */}
          {tokens.map((token) => {
            const isSelected = selectedTokenId === token.id;
            const isDragging = draggedTokenId === token.id;

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
                    className="absolute -inset-1 rounded-full border-2 border-dashed border-cyan-400 animate-spin pointer-events-none z-20"
                    title={`Active Conditions: ${token.conditions.join(', ')}`}
                  />
                )}

                {isSelected && (
                  <div className="absolute inset-0.5 rounded-full border-2 border-purple-400 animate-pulse-glow" />
                )}

                {token.elevationFeet && token.elevationFeet > 0 ? (
                  <span className="absolute -top-1 -right-1 px-1.5 py-0.2 bg-amber-950/90 border border-amber-500/70 text-amber-300 text-[8px] font-mono font-bold rounded-full shadow-lg z-40">
                    +{token.elevationFeet}ft
                  </span>
                ) : null}

                <div
                  className={`w-11 h-11 rounded-full flex items-center justify-center shadow-xl border-2 transition-transform ${
                    isSelected ? 'border-purple-400 scale-110 shadow-purple-500/50' : 'border-slate-300/80 shadow-black/80'
                  }`}
                  style={{ backgroundColor: token.color }}
                >
                  {renderTokenIcon(token)}
                </div>

                <div className="w-10 h-1.5 bg-slate-950 rounded-full mt-1 overflow-hidden border border-slate-700 shadow-sm">
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

                <span className="text-[10px] font-mono font-semibold text-slate-200 px-1.5 py-0.5 bg-slate-950/90 border border-slate-800 rounded mt-0.5 backdrop-blur-md whitespace-nowrap shadow">
                  {token.name}
                </span>
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
            className="absolute inset-0 pointer-events-none z-20"
          />

          {/* 3D Dice & WebGL Particle FX Overlay Canvas */}
          <canvas
            ref={fxCanvasRef}
            width={gridWidth * cellSize}
            height={gridHeight * cellSize}
            className="absolute inset-0 pointer-events-none z-40"
          />
        </div>
      </div>
    </div>
  );
};
