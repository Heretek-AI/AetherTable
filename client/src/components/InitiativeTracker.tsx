import React from 'react';
import { Swords, ChevronRight, Heart, Shield, Skull } from 'lucide-react';
import { Token } from './TacticalCanvas';

interface InitiativeTrackerProps {
  tokens: Token[];
  currentTurnIndex: number;
  onNextTurn: () => void;
  onSelectToken: (tokenId: string) => void;
  selectedTokenId: string | null;
  roundNumber: number;
}

export const InitiativeTracker: React.FC<InitiativeTrackerProps> = ({
  tokens,
  currentTurnIndex,
  onNextTurn,
  onSelectToken,
  selectedTokenId,
  roundNumber,
}) => {
  return (
    <div className="w-72 h-full vtt-glass-panel border-r border-slate-800 flex flex-col justify-between">
      {/* Header */}
      <div>
        <div className="p-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Swords className="w-4 h-4 text-purple-400" />
            <span className="font-bold text-sm tracking-wide text-slate-100">Initiative Order</span>
          </div>
          <span className="text-xs font-mono px-2 py-0.5 bg-purple-950 text-purple-300 rounded border border-purple-800">
            Round {roundNumber}
          </span>
        </div>

        {/* Combatant List */}
        <div className="p-2 space-y-1.5 overflow-y-auto vtt-scrollbar max-h-[calc(100vh-280px)]">
          {tokens.map((token, index) => {
            const isActiveTurn = index === currentTurnIndex;
            const isSelected = selectedTokenId === token.id;
            const isDead = token.hp <= 0;

            return (
              <div
                key={token.id}
                onClick={() => onSelectToken(token.id)}
                className={`p-2.5 rounded-lg transition-all cursor-pointer border ${
                  isActiveTurn
                    ? 'bg-purple-900/40 border-purple-500 shadow-lg shadow-purple-950/50'
                    : isSelected
                    ? 'bg-slate-800/80 border-slate-600'
                    : 'bg-slate-900/40 border-slate-800/80 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white shadow"
                      style={{ backgroundColor: token.color }}
                    >
                      {token.avatarIcon}
                    </div>
                    <div>
                      <div className="font-medium text-xs text-slate-200 flex items-center gap-1.5">
                        {token.name}
                        {isDead && <Skull className="w-3 h-3 text-rose-500" />}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {token.isPlayer ? 'Player Character' : 'Hostile NPC'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 text-xs font-mono">
                    <div className="flex items-center gap-0.5 text-slate-400">
                      <Shield className="w-3 h-3 text-sky-400" />
                      {token.ac}
                    </div>
                  </div>
                </div>

                {/* Health Bar */}
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[10px] font-mono text-slate-400">
                    <span className="flex items-center gap-0.5">
                      <Heart className="w-2.5 h-2.5 text-rose-400" /> HP
                    </span>
                    <span>
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
      <div className="p-3 border-t border-slate-800 bg-slate-950/80">
        <button
          onClick={onNextTurn}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white font-medium text-xs rounded-lg transition shadow-md shadow-purple-900/30"
        >
          <span>Advance Turn</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
