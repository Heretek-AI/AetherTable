import React, { useState } from 'react';
import { Shield, Compass, Navigation } from 'lucide-react';

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
  avatarIcon: string;
}

interface TacticalCanvasProps {
  tokens: Token[];
  onTokenMove: (tokenId: string, newX: number, newY: number) => void;
  selectedTokenId: string | null;
  onSelectToken: (tokenId: string) => void;
  gridWidth?: number;
  gridHeight?: number;
}

export const TacticalCanvas: React.FC<TacticalCanvasProps> = ({
  tokens,
  onTokenMove,
  selectedTokenId,
  onSelectToken,
  gridWidth = 16,
  gridHeight = 12,
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [draggedTokenId, setDraggedTokenId] = useState<string | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureOrigin, setMeasureOrigin] = useState<{ x: number; y: number } | null>(null);
  const [measureTarget, setMeasureTarget] = useState<{ x: number; y: number } | null>(null);
  const [fogRevealed, setFogRevealed] = useState<boolean[][]>(() => {
    const grid = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(false));
    tokens.forEach((t) => {
      if (t.isPlayer) {
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const ny = Math.floor(t.y) + dy;
            const nx = Math.floor(t.x) + dx;
            if (ny >= 0 && ny < gridHeight && nx >= 0 && nx < gridWidth) {
              if (Math.sqrt(dx * dx + dy * dy) <= 3.5) {
                grid[ny][nx] = true;
              }
            }
          }
        }
      }
    });
    return grid;
  });

  const cellSize = 56;

  const walls = [
    { x: 8, y: 2 }, { x: 8, y: 3 }, { x: 8, y: 4 }, { x: 8, y: 5 }, { x: 8, y: 6 },
    { x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 },
  ];

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
        setFogRevealed((prev) => {
          const next = prev.map((row) => [...row]);
          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const ny = y + dy;
              const nx = x + dx;
              if (ny >= 0 && ny < gridHeight && nx >= 0 && nx < gridWidth) {
                if (Math.sqrt(dx * dx + dy * dy) <= 3.5) {
                  next[ny][nx] = true;
                }
              }
            }
          }
          return next;
        });
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

  return (
    <div
      className="relative w-full h-full bg-slate-950 overflow-hidden cursor-crosshair select-none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={(e) => {
        const newZoom = Math.min(Math.max(0.5, zoom - e.deltaY * 0.001), 2.0);
        setZoom(newZoom);
      }}
    >
      {/* Controls Overlay */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2 vtt-glass-panel p-1.5 rounded-lg text-xs font-mono">
        <button
          onClick={() => setZoom((z) => Math.min(2.0, z + 0.1))}
          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
        >
          +
        </button>
        <span className="text-slate-400">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-200"
        >
          -
        </button>
        <div className="h-4 w-px bg-slate-700 mx-1" />
        <button
          onClick={() => {
            setMeasureMode(!measureMode);
            setMeasureOrigin(null);
            setMeasureTarget(null);
          }}
          className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
            measureMode ? 'bg-purple-600 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
          }`}
        >
          <Compass className="w-3.5 h-3.5" />
          Ruler {measureMode && measureTarget && `(${calculateDistanceFeet()} ft)`}
        </button>
        <button
          onClick={() => setPan({ x: 40, y: 40 })}
          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 flex items-center gap-1"
        >
          <Navigation className="w-3.5 h-3.5" /> Center
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
          className="grid relative border border-slate-800 shadow-2xl rounded"
          style={{
            gridTemplateColumns: `repeat(${gridWidth}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${gridHeight}, ${cellSize}px)`,
          }}
        >
          {Array.from({ length: gridHeight }).map((_, y) =>
            Array.from({ length: gridWidth }).map((_, x) => {
              const wall = isWall(x, y);
              const revealed = fogRevealed[y][x];

              return (
                <div
                  key={`cell-${x}-${y}`}
                  onClick={() => handleCellClick(x, y)}
                  className={`relative border border-slate-900/60 transition-colors ${
                    wall
                      ? 'bg-slate-800 border-slate-700 shadow-inner'
                      : (x + y) % 2 === 0
                      ? 'bg-slate-900/80 hover:bg-slate-800/60'
                      : 'bg-slate-900/50 hover:bg-slate-800/40'
                  }`}
                  style={{ width: cellSize, height: cellSize }}
                >
                  <span className="absolute bottom-0.5 right-1 text-[9px] font-mono text-slate-700 select-none pointer-events-none">
                    {String.fromCharCode(65 + x)}{y + 1}
                  </span>

                  {!revealed && (
                    <div className="absolute inset-0 bg-slate-950/90 pointer-events-none backdrop-blur-[1px]" />
                  )}

                  {wall && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-slate-600">
                      <Shield className="w-5 h-5 opacity-40" />
                    </div>
                  )}
                </div>
              );
            })
          )}

          {tokens.map((token) => {
            const isSelected = selectedTokenId === token.id;
            const isDragging = draggedTokenId === token.id;

            return (
              <div
                key={token.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectToken(token.id);
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
                {isSelected && (
                  <div className="absolute inset-0 rounded-full border-2 border-purple-400 animate-pulse-glow" />
                )}

                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-lg border-2 ${
                    isSelected ? 'border-purple-400 scale-110 shadow-purple-500/50' : 'border-slate-300'
                  }`}
                  style={{ backgroundColor: token.color }}
                >
                  {token.avatarIcon}
                </div>

                <div className="w-9 h-1.5 bg-slate-900/90 rounded-full mt-0.5 overflow-hidden border border-slate-700">
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

                <span className="text-[10px] font-mono font-medium text-slate-300 px-1 py-0.5 bg-slate-900/80 rounded mt-0.5 backdrop-blur-sm whitespace-nowrap">
                  {token.name}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
