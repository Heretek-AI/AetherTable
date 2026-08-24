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
        return <Sparkles className="w-3.5 h-3.5 text-[var(--rp-parchment-200)]" />;
      case 'boss':
        return <Skull className="w-3.5 h-3.5 text-rose-200" />;
      case 'scout':
        return <Crosshair className="w-3.5 h-3.5 text-amber-200" />;
      case 'fighter':
      default:
        return <Shield className="w-3.5 h-3.5 text-[var(--rp-parchment-200)]" />;
    }
  };

  if (isCollapsed) {
    return (
      <aside aria-label="Initiative Tracker Sidebar" className="h-full vtt-glass-panel p-2 flex flex-col items-center justify-between shrink-0 w-12 transition-all">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 bg-black/30 hover:bg-[var(--rp-leather-700)] rounded-lg text-[var(--rp-parchment-300)] hover:text-white border border-[var(--tavern-border)] transition"
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
                idx === currentTurnIndex ? 'border-[var(--tavern-accent)] scale-110 shadow-md shadow-amber-900/50' : 'border-[var(--tavern-border)]'
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
          className="p-2 bg-[var(--rp-amber-600)] hover:bg-[var(--rp-amber-500)] text-white rounded-lg transition"
          title="Advance Turn"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside aria-label="Initiative Tracker Sidebar" className="w-72 h-full vtt-glass-panel flex flex-col justify-between shrink-0 transition-all">
      {/* Header */}
      <div>
        <div className="p-3.5 border-b border-[var(--tavern-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Swords className="w-4 h-4 text-[var(--tavern-accent)]" />
            <span className="vtt-engraved font-bold text-xs tracking-wide">
              Initiative Order
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono font-semibold px-2 py-0.5 bg-[var(--rp-leather-700)] text-[var(--rp-parchment-200)] rounded border border-[var(--tavern-accent)]/40">
              Round {roundNumber}
            </span>
            <button
              onClick={onToggleCollapse}
              className="p-1 opacity-60 hover:opacity-100 transition"
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
                    ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_14%,transparent)] border-[var(--tavern-accent)]/70 shadow-lg shadow-black/40'
                    : isSelected
                    ? 'bg-[var(--tavern-surface)] border-[var(--tavern-border)]'
                    : 'bg-black/20 border-[var(--tavern-border)]/60 hover:bg-[var(--rp-leather-700)]/40'
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
                      <div className="font-semibold text-xs text-[var(--rp-parchment-100)] flex items-center gap-1.5">
                        {token.name}
                        {isDead && <Skull className="w-3 h-3 text-rose-500" />}
                      </div>
                      <div className="text-[10px] text-[var(--rp-parchment-300)] font-mono">
                        {token.isPlayer ? 'Player Character' : 'Hostile Entity'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 text-xs font-mono text-[var(--rp-parchment-200)]">
                    <Shield className="w-3.5 h-3.5 text-tavern-accent" />
                    <span>{token.ac} AC</span>
                  </div>
                </div>

                {/* HP Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] font-mono text-[var(--rp-parchment-300)]">
                    <span className="flex items-center gap-1">
                      <Heart className="w-2.5 h-2.5 text-rose-400" /> Health
                    </span>
                    <span className="font-bold text-[var(--rp-parchment-100)]">
                      {Math.max(0, token.hp)} / {token.maxHp}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-black/40 rounded-full overflow-hidden border border-[var(--tavern-border)]">
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
      <div className="p-3 border-t border-[var(--tavern-border)] bg-black/30">
        <button
          onClick={onNextTurn}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-[var(--rp-amber-600)] hover:bg-[var(--rp-amber-500)] active:bg-[var(--tavern-accent-deep)] text-white font-semibold text-xs rounded-lg transition shadow-md shadow-amber-950 border border-amber-400/30"
        >
          <span>Advance Turn</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
