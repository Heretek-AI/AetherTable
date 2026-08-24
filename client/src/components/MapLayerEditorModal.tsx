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

  // Layer identity is carried by icon + nameplate; the selected card is
  // marked by the shared gold-leaf accent rather than per-layer hues.
  const layers: { id: MapLayerType; name: string; icon: string; description: string }[] = [
    {
      id: 'map',
      name: 'Map & Background Layer',
      icon: '🗺️',
      description: 'Dungeon tile textures, grid snap alignment, and terrain elevations.',
    },
    {
      id: 'walls',
      name: 'Dynamic Lighting & Walls',
      icon: '🧱',
      description: 'Raycasting line-of-sight obstruction walls, doors, and optical barriers.',
    },
    {
      id: 'tokens',
      name: 'Tokens & Objects Layer',
      icon: '🧙‍♂️',
      description: 'Interactive player character tokens, monsters, and treasure chests.',
    },
    {
      id: 'gm_hidden',
      name: 'GM Hidden Info Layer',
      icon: '🤫',
      description: 'Secret trap perception DCs, ambush trigger zones, and DM notes.',
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
            className="vtt-btn vtt-btn-primary font-display tracking-wide"
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
            <div className="vtt-section-header text-xs font-bold">
              Active Working Layer
            </div>

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
                        ? 'bg-tavern-surface border-tavern-accent shadow-lg shadow-black/40'
                        : 'vtt-surface rounded-xl hover:border-[var(--rp-leather-600)]'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-2.5">
                        <span className="text-xl">{layer.icon}</span>
                        <div className={`text-xs font-bold ${isSelected ? 'text-tavern-accent' : 'text-[var(--rp-parchment-100)]'}`}>{layer.name}</div>
                      </div>
                      {isSelected && <Check className="w-4 h-4 text-tavern-accent" />}
                    </div>
                    <p className="text-[11px] text-[var(--rp-parchment-300)] mt-2 font-sans">{layer.description}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Wall & Dynamic Lighting Editor */}
          {activeLayer === 'walls' && (
            <div className="space-y-4 pt-2 border-t border-tavern-border">
              <div className="flex items-center justify-between">
                <div
                  className="text-xs font-bold uppercase tracking-wider flex items-center space-x-1.5"
                  style={{ color: 'var(--tavern-accent)' }}
                >
                  <PenTool className="w-4 h-4" />
                  <span>LoS Raycast Wall Cells ({walls.length})</span>
                </div>
              </div>

              {/* Add Wall Form */}
              <form onSubmit={handleAddWall} className="p-4 vtt-surface rounded-xl flex items-center space-x-3">
                <div className="flex items-center space-x-2 text-xs font-mono">
                  <label className="text-[var(--rp-parchment-300)]">Grid X:</label>
                  <input
                    type="number"
                    value={newX}
                    onChange={(e) => setNewX(e.target.value)}
                    className="vtt-input w-16"
                  />
                </div>
                <div className="flex items-center space-x-2 text-xs font-mono">
                  <label className="text-[var(--rp-parchment-300)]">Grid Y:</label>
                  <input
                    type="number"
                    value={newY}
                    onChange={(e) => setNewY(e.target.value)}
                    className="vtt-input w-16"
                  />
                </div>

                <button
                  type="submit"
                  className="vtt-btn vtt-btn-primary"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Place Wall Cell</span>
                </button>
              </form>

              {/* Current Walls List */}
              <div className="grid grid-cols-3 gap-2 max-h-36 overflow-y-auto vtt-scrollbar font-mono text-xs">
                {walls.map((wall, idx) => (
                  <div
                    key={idx}
                    className="p-2 vtt-surface rounded-lg flex items-center justify-between text-[var(--rp-parchment-200)]"
                  >
                    <span className="text-tavern-accent font-bold">
                      [{wall.x}, {wall.y}]
                    </span>

                    <button
                      onClick={() => handleRemoveWall(idx)}
                      className="transition cursor-pointer hover:opacity-80"
                      style={{ color: 'var(--state-danger)' }}
                      aria-label={`Remove wall at ${wall.x}, ${wall.y}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

        {/* GM Hidden Info Layer View — crimson wash marks out-of-table secrets */}
        {activeLayer === 'gm_hidden' && (
          <div className="p-4 rounded-xl space-y-2 text-xs border border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_12%,transparent)]">
            <div className="font-bold flex items-center space-x-1.5" style={{ color: 'var(--state-danger)' }}>
              <Shield className="w-4 h-4" />
              <span>GM Hidden Annotations Active</span>
            </div>
            <p className="text-[var(--rp-parchment-200)] font-sans text-xs leading-relaxed">
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
