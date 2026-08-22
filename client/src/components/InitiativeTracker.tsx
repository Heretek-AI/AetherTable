import React, { useState } from 'react';
import { 
  Swords, 
  ChevronRight, 
  ChevronLeft, 
  Heart, 
  Shield, 
  Skull, 
  Sparkles, 
  Crosshair, 
  Activity,
  Layers
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface InitiativeTrackerProps {
  tokens: Token[];
  currentTurnIndex: number;
  onNextTurn: () => void;
  onSelectToken: (tokenId: string) => void;
  selectedTokenId: string | null;
  roundNumber: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const InitiativeTracker: React.FC<InitiativeTrackerProps> = ({
  tokens,
  currentTurnIndex,
  onNextTurn,
  onSelectToken,
  selectedTokenId,
  roundNumber,
  isCollapsed,
  onToggleCollapse,
}) => {
  const renderTokenIcon = (token: Token) => {
    const iconType = token.avatarIconType || (token.isPlayer ? 'fighter' : 'boss');
    switch (iconType) {
      case 'mage':
      case 'caster':
        return <Sparkles className="w-3.5 h-3.5 text-purple-200" />;
      case 'boss':
        return <Skull className="w-3.5 h-3.5 text-rose-200" />;
      case 'scout':
        return <Crosshair className="w-3.5 h-3.5 text-amber-200" />;
      case 'fighter':
      default:
        return <Shield className="w-3.5 h-3.5 text-sky-200" />;
    }
  };

  if (isCollapsed) {
    return (
      <aside aria-label="Initiative Tracker Sidebar" className="h-full vtt-glass-panel border-r border-slate-800/80 p-2 flex flex-col items-center justify-between shrink-0 w-12 transition-all">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 bg-slate-900 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white border border-slate-800 transition"
          title="Expand Initiative Tracker"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        <div className="flex flex-col items-center gap-2">
          {tokens.map((token, idx) => (
            <div
              key={token.id}
              onClick={() => onSelectToken(token.id)}
              className={`w-7 h-7 rounded-full flex items-center justify-center cursor-pointer border transition-transform ${
                idx === currentTurnIndex ? 'border-purple-400 scale-110 shadow-md shadow-purple-500/50' : 'border-slate-700'
              }`}
              style={{ backgroundColor: token.color }}
              title={`${token.name} (${token.hp}/${token.maxHp} HP)`}
            >
              {renderTokenIcon(token)}
            </div>
          ))}
        </div>

        <button
          onClick={onNextTurn}
          className="p-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition"
          title="Advance Turn"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside aria-label="Initiative Tracker Sidebar" className="w-72 h-full vtt-glass-panel border-r border-slate-800/80 flex flex-col justify-between shrink-0 transition-all">
      {/* Header */}
      <div>
        <div className="p-3.5 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Swords className="w-4 h-4 text-purple-400" />
            <span className="font-bold text-xs tracking-wide text-slate-100 font-display">
              Initiative Order
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-semibold px-2 py-0.5 bg-purple-950 text-purple-300 rounded border border-purple-800">
              Round {roundNumber}
            </span>
            <button
              onClick={onToggleCollapse}
              className="p-1 text-slate-500 hover:text-slate-200 transition"
              title="Collapse Panel"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Combatant List */}
        <div className="p-2.5 space-y-2 overflow-y-auto vtt-scrollbar max-h-[calc(100vh-270px)]">
          {tokens.map((token, index) => {
            const isActiveTurn = index === currentTurnIndex;
            const isSelected = selectedTokenId === token.id;
            const isDead = token.hp <= 0;

            return (
              <div
                key={token.id}
                onClick={() => onSelectToken(token.id)}
                className={`p-3 rounded-xl transition-all cursor-pointer border ${
                  isActiveTurn
                    ? 'bg-purple-950/40 border-purple-500/80 shadow-lg shadow-purple-950/40'
                    : isSelected
                    ? 'bg-slate-900/90 border-slate-700'
                    : 'bg-slate-900/40 border-slate-800/60 hover:bg-slate-850'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold text-white shadow"
                      style={{ backgroundColor: token.color }}
                    >
                      {renderTokenIcon(token)}
                    </div>
                    <div>
                      <div className="font-semibold text-xs text-slate-100 flex items-center gap-1.5">
                        {token.name}
                        {isDead && <Skull className="w-3 h-3 text-rose-500" />}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {token.isPlayer ? 'Player Character' : 'Hostile Entity'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 text-xs font-mono text-slate-300">
                    <Shield className="w-3.5 h-3.5 text-sky-400" />
                    <span>{token.ac} AC</span>
                  </div>
                </div>

                {/* HP Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-mono text-slate-400">
                    <span className="flex items-center gap-1">
                      <Heart className="w-2.5 h-2.5 text-rose-400" /> Health
                    </span>
                    <span className="font-bold text-slate-200">
                      {Math.max(0, token.hp)} / {token.maxHp}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
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
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer Next Turn Button */}
      <div className="p-3 border-t border-slate-800/80 bg-slate-950/90">
        <button
          onClick={onNextTurn}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white font-semibold text-xs rounded-lg transition shadow-md shadow-purple-950 border border-purple-400/30"
        >
          <span>Advance Turn</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
