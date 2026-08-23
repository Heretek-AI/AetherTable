import React, { useState } from 'react';
import { Layers, Shield, Plus, Trash2, PenTool, Check } from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { ModalShell } from './ui/ModalShell';

export type MapLayerType = 'map' | 'walls' | 'tokens' | 'gm_hidden';

export interface GridWall {
  x: number;
  y: number;
}

interface MapLayerEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  walls: GridWall[];
  onUpdateWalls: (walls: GridWall[]) => void;
  activeLayer: MapLayerType;
  onSelectLayer: (layer: MapLayerType) => void;
}

export const MapLayerEditorModal: React.FC<MapLayerEditorModalProps> = ({
  isOpen,
  onClose,
  walls,
  onUpdateWalls,
  activeLayer,
  onSelectLayer,
}) => {
  const [newX, setNewX] = useState('5');
  const [newY, setNewY] = useState('4');

  const layers: { id: MapLayerType; name: string; icon: string; description: string; color: string }[] = [
    {
      id: 'map',
      name: 'Map & Background Layer',
      icon: '🗺️',
      description: 'Dungeon tile textures, grid snap alignment, and terrain elevations.',
      color: 'border-sky-500 bg-sky-950/40 text-sky-300',
    },
    {
      id: 'walls',
      name: 'Dynamic Lighting & Walls',
      icon: '🧱',
      description: 'Raycasting line-of-sight obstruction walls, doors, and optical barriers.',
      color: 'border-amber-500 bg-amber-950/40 text-amber-300',
    },
    {
      id: 'tokens',
      name: 'Tokens & Objects Layer',
      icon: '🧙‍♂️',
      description: 'Interactive player character tokens, monsters, and treasure chests.',
      color: 'border-purple-500 bg-purple-950/40 text-purple-300',
    },
    {
      id: 'gm_hidden',
      name: 'GM Hidden Info Layer',
      icon: '🤫',
      description: 'Secret trap perception DCs, ambush trigger zones, and DM notes.',
      color: 'border-rose-500 bg-rose-950/40 text-rose-300',
    },
  ];

  const handleAddWall = (e: React.FormEvent) => {
    e.preventDefault();
    const x = parseInt(newX, 10);
    const y = parseInt(newY, 10);

    if (!isNaN(x) && !isNaN(y)) {
      if (!walls.some((w) => w.x === x && w.y === y)) {
        onUpdateWalls([...walls, { x, y }]);
        globalAudio.playTurnAdvance();
      }
    }
  };

  const handleRemoveWall = (index: number) => {
    const nextWalls = walls.filter((_, idx) => idx !== index);
    onUpdateWalls(nextWalls);
    globalAudio.playWeaponImpact();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Multi-Layer Tactical Map & LoS Editor"
      subtitle="Roll20 style layer switcher, dynamic line-of-sight wall drawing, and GM hidden annotations."
      icon={<Layers className="w-5 h-5" />}
      size="lg"
      footer={
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
          >
            Apply & Close Editor
          </button>
        </div>
      }
    >
      {/* Body Content */}
      <div className="space-y-6">
          {/* Layer Selection */}
          <div className="space-y-3">
            <label className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">
              Active Working Layer
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {layers.map((layer) => {
                const isSelected = activeLayer === layer.id;
                return (
                  <div
                    key={layer.id}
                    onClick={() => {
                      onSelectLayer(layer.id);
                      globalAudio.playTurnAdvance();
                    }}
                    className={`p-3.5 rounded-xl border transition cursor-pointer flex flex-col justify-between ${
                      isSelected
                        ? `${layer.color} shadow-lg shadow-black/40`
                        : 'bg-slate-950/60 border-slate-800 hover:border-slate-700 text-slate-400'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-2.5">
                        <span className="text-xl">{layer.icon}</span>
                        <div className="text-xs font-bold text-slate-100">{layer.name}</div>
                      </div>
                      {isSelected && <Check className="w-4 h-4 text-amber-400" />}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2 font-sans">{layer.description}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Wall & Dynamic Lighting Editor */}
          {activeLayer === 'walls' && (
            <div className="space-y-4 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <div className="text-xs font-mono font-bold text-amber-300 uppercase flex items-center space-x-1.5">
                  <PenTool className="w-4 h-4" />
                  <span>LoS Raycast Wall Cells ({walls.length})</span>
                </div>
              </div>

              {/* Add Wall Form */}
              <form onSubmit={handleAddWall} className="p-4 bg-slate-950 rounded-xl border border-slate-800 flex items-center space-x-3">
                <div className="flex items-center space-x-2 text-xs font-mono">
                  <label className="text-slate-400">Grid X:</label>
                  <input
                    type="number"
                    value={newX}
                    onChange={(e) => setNewX(e.target.value)}
                    className="w-16 bg-slate-900 border border-slate-700 rounded p-1.5 text-slate-200"
                  />
                </div>
                <div className="flex items-center space-x-2 text-xs font-mono">
                  <label className="text-slate-400">Grid Y:</label>
                  <input
                    type="number"
                    value={newY}
                    onChange={(e) => setNewY(e.target.value)}
                    className="w-16 bg-slate-900 border border-slate-700 rounded p-1.5 text-slate-200"
                  />
                </div>

                <button
                  type="submit"
                  className="flex items-center space-x-1 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs font-mono rounded-lg shadow transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Place Wall Cell</span>
                </button>
              </form>

              {/* Current Walls List */}
              <div className="grid grid-cols-3 gap-2 max-h-36 overflow-y-auto font-mono text-xs">
                {walls.map((wall, idx) => (
                  <div
                    key={idx}
                    className="p-2 bg-slate-950/80 rounded-lg border border-slate-800 flex items-center justify-between text-slate-300"
                  >
                    <span className="text-amber-400 font-bold">
                      [{wall.x}, {wall.y}]
                    </span>

                    <button
                      onClick={() => handleRemoveWall(idx)}
                      className="text-slate-500 hover:text-rose-400 transition cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

        {/* GM Hidden Info Layer View */}
        {activeLayer === 'gm_hidden' && (
          <div className="p-4 bg-rose-950/30 border border-rose-900/50 rounded-xl space-y-2 text-xs font-mono text-rose-200">
            <div className="font-bold flex items-center space-x-1.5">
              <Shield className="w-4 h-4 text-rose-400" />
              <span>GM Hidden Annotations Active</span>
            </div>
            <p className="text-slate-300 font-sans text-xs">
              • [Trap DC 15 Investigation]: Spiked pit trigger at grid [D4].<br />
              • [Ambush Trigger]: 2x Shadow Wraiths appear when token crosses tile [G6].<br />
              • [Secret Door DC 14 Perception]: Concealed revolving stone behind altar at [H2].
            </p>
          </div>
        )}
      </div>
    </ModalShell>
  );
};
