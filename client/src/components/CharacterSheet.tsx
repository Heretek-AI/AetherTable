import React from 'react';
import { User, Zap, Sword, Shield, Flame, Activity, Sparkles, Wand2 } from 'lucide-react';
import { Token } from './TacticalCanvas';

interface CharacterSheetProps {
  activeToken: Token | null;
  onExecuteAttack: (actionName: string, damageFormula: string, damageType: string) => void;
  onCastSpell: (spellId: string, spellName: string, level: number) => void;
  onRollCheck: (skillName: string, modifier: number, dc: number) => void;
}

export const CharacterSheet: React.FC<CharacterSheetProps> = ({
  activeToken,
  onExecuteAttack,
  onCastSpell,
  onRollCheck,
}) => {
  if (!activeToken) {
    return (
      <div className="w-80 h-full vtt-glass-panel border-l border-slate-800 p-6 flex flex-col items-center justify-center text-slate-500 text-center">
        <User className="w-12 h-12 mb-3 text-slate-700" />
        <span className="font-medium text-sm">No token selected</span>
        <span className="text-xs text-slate-600 mt-1">Select a token on the battle map to inspect actions.</span>
      </div>
    );
  }

  return (
    <div className="w-84 h-full vtt-glass-panel border-l border-slate-800 flex flex-col justify-between overflow-y-auto vtt-scrollbar">
      <div className="p-4 space-y-4">
        {/* Token Header Banner */}
        <div className="flex items-center gap-3 pb-3 border-b border-slate-800">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg text-white shadow-lg border border-slate-600"
            style={{ backgroundColor: activeToken.color }}
          >
            {activeToken.avatarIcon}
          </div>
          <div>
            <h2 className="font-bold text-base text-slate-100">{activeToken.name}</h2>
            <div className="text-xs font-mono text-purple-400">
              {activeToken.isPlayer ? 'Level 5 Adventurer' : 'CR 3.0 Monster'}
            </div>
          </div>
        </div>

        {/* Quick Vitals Grid */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="p-2 bg-slate-900/60 rounded-lg border border-slate-800">
            <div className="text-[10px] text-slate-400 font-mono">ARMOR</div>
            <div className="text-base font-bold text-sky-400">{activeToken.ac} AC</div>
          </div>
          <div className="p-2 bg-slate-900/60 rounded-lg border border-slate-800">
            <div className="text-[10px] text-slate-400 font-mono">HEALTH</div>
            <div className="text-base font-bold text-emerald-400">
              {Math.max(0, activeToken.hp)} / {activeToken.maxHp}
            </div>
          </div>
          <div className="p-2 bg-slate-900/60 rounded-lg border border-slate-800">
            <div className="text-[10px] text-slate-400 font-mono">SPEED</div>
            <div className="text-base font-bold text-amber-400">30 ft</div>
          </div>
        </div>

        {/* Ability Scores */}
        <div className="space-y-1.5">
          <span className="text-[11px] font-mono font-bold text-slate-400 tracking-wider">ABILITIES</span>
          <div className="grid grid-cols-6 gap-1 text-center font-mono">
            {[
              { name: 'STR', score: 18, mod: '+4' },
              { name: 'DEX', score: 14, mod: '+2' },
              { name: 'CON', score: 16, mod: '+3' },
              { name: 'INT', score: 10, mod: '+0' },
              { name: 'WIS', score: 12, mod: '+1' },
              { name: 'CHA', score: 8, mod: '-1' },
            ].map((ab) => (
              <div key={ab.name} className="p-1 bg-slate-950 rounded border border-slate-800">
                <div className="text-[9px] text-slate-500">{ab.name}</div>
                <div className="text-xs font-bold text-slate-200">{ab.mod}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Action Economy Tracker */}
        <div className="p-2.5 bg-slate-900/40 rounded-lg border border-slate-800/80 space-y-1.5">
          <span className="text-[11px] font-mono font-bold text-slate-400 tracking-wider">TURN ACTION BUDGET</span>
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="flex items-center gap-1 text-emerald-400">
              <Zap className="w-3.5 h-3.5" /> Action
            </span>
            <span className="flex items-center gap-1 text-sky-400">
              <Sparkles className="w-3.5 h-3.5" /> Bonus
            </span>
            <span className="flex items-center gap-1 text-purple-400">
              <Shield className="w-3.5 h-3.5" /> Reaction
            </span>
          </div>
        </div>

        {/* Action Deck */}
        <div className="space-y-2">
          <span className="text-[11px] font-mono font-bold text-slate-400 tracking-wider">ATTACK ACTIONS</span>
          <div className="space-y-1.5">
            <button
              onClick={() => onExecuteAttack('Greataxe Slash', '1d12 + 4', 'slashing')}
              className="w-full flex items-center justify-between p-2 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
            >
              <div className="flex items-center gap-2">
                <Sword className="w-4 h-4 text-rose-400 group-hover:scale-110 transition-transform" />
                <div>
                  <div className="text-xs font-bold text-slate-200">Greataxe Slash</div>
                  <div className="text-[10px] text-slate-400 font-mono">+6 to hit · 1d12 + 4 Slashing</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 bg-rose-950 text-rose-300 rounded border border-rose-800 font-mono">
                Melee
              </span>
            </button>

            <button
              onClick={() => onExecuteAttack('Shortbow Shot', '1d6 + 2', 'piercing')}
              className="w-full flex items-center justify-between p-2 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
            >
              <div className="flex items-center gap-2">
                <Sword className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
                <div>
                  <div className="text-xs font-bold text-slate-200">Shortbow Shot</div>
                  <div className="text-[10px] text-slate-400 font-mono">+4 to hit · 1d6 + 2 Piercing</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 bg-amber-950 text-amber-300 rounded border border-amber-800 font-mono">
                80/320 ft
              </span>
            </button>
          </div>
        </div>

        {/* Spells */}
        <div className="space-y-2">
          <span className="text-[11px] font-mono font-bold text-slate-400 tracking-wider">SPELLS & CANTRIPS</span>
          <div className="space-y-1.5">
            <button
              onClick={() => onCastSpell('spell_fireball', 'Fireball', 3)}
              className="w-full flex items-center justify-between p-2 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
            >
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-400 group-hover:scale-110 transition-transform" />
                <div>
                  <div className="text-xs font-bold text-slate-200">Fireball</div>
                  <div className="text-[10px] text-slate-400 font-mono">8d6 Fire · 20ft Sphere · DC 15 DEX</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 bg-orange-950 text-orange-300 rounded border border-orange-800 font-mono">
                Level 3
              </span>
            </button>

            <button
              onClick={() => onCastSpell('spell_magic_missile', 'Magic Missile', 1)}
              className="w-full flex items-center justify-between p-2 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
            >
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-purple-400 group-hover:scale-110 transition-transform" />
                <div>
                  <div className="text-xs font-bold text-slate-200">Magic Missile</div>
                  <div className="text-[10px] text-slate-400 font-mono">3d4 + 3 Force · Auto-Hit</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 bg-purple-950 text-purple-300 rounded border border-purple-800 font-mono">
                Level 1
              </span>
            </button>
          </div>
        </div>

        {/* Skill Checks */}
        <div className="space-y-2">
          <span className="text-[11px] font-mono font-bold text-slate-400 tracking-wider">SKILL RESOLUTIONS</span>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onRollCheck('Athletics', 4, 15)}
              className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded text-xs font-mono text-slate-300 hover:text-white transition text-left"
            >
              Athletics (+4)
            </button>
            <button
              onClick={() => onRollCheck('Stealth', 2, 14)}
              className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded text-xs font-mono text-slate-300 hover:text-white transition text-left"
            >
              Stealth (+2)
            </button>
            <button
              onClick={() => onRollCheck('Perception', 1, 13)}
              className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded text-xs font-mono text-slate-300 hover:text-white transition text-left"
            >
              Perception (+1)
            </button>
            <button
              onClick={() => onRollCheck('Arcana', 0, 15)}
              className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded text-xs font-mono text-slate-300 hover:text-white transition text-left"
            >
              Arcana (+0)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
