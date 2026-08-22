import React, { useState } from 'react';
import { 
  User, 
  Zap, 
  Sword, 
  Shield, 
  Flame, 
  Activity, 
  Sparkles, 
  Wand2, 
  ChevronRight, 
  ChevronLeft,
  Briefcase,
  Crosshair,
  Skull
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface CharacterSheetProps {
  activeToken: Token | null;
  onExecuteAttack: (actionName: string, damageFormula: string, damageType: string) => void;
  onCastSpell: (spellId: string, spellName: string, level: number) => void;
  onRollCheck: (skillName: string, modifier: number, dc: number) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const CharacterSheet: React.FC<CharacterSheetProps> = ({
  activeToken,
  onExecuteAttack,
  onCastSpell,
  onRollCheck,
  isCollapsed,
  onToggleCollapse,
}) => {
  const [activeTab, setActiveTab] = useState<'actions' | 'spells' | 'inventory'>('actions');

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

  if (isCollapsed) {
    return (
      <aside aria-label="Character Sheet Sidebar" className="h-full vtt-glass-panel border-l border-slate-800/80 p-2 flex flex-col items-center justify-between shrink-0 w-12 transition-all">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 bg-slate-900 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white border border-slate-800 transition"
          title="Expand Character Sheet"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {activeToken && (
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-white shadow border border-slate-600"
            style={{ backgroundColor: activeToken.color }}
            title={activeToken.name}
          >
            {renderTokenIcon(activeToken)}
          </div>
        )}

        <div className="text-[9px] font-mono text-slate-500 [writing-mode:vertical-lr] tracking-widest uppercase">
          {activeToken?.name || 'Character'}
        </div>
      </aside>
    );
  }

  if (!activeToken) {
    return (
      <aside aria-label="Character Sheet Sidebar" className="w-84 h-full vtt-glass-panel border-l border-slate-800/80 p-6 flex flex-col items-center justify-center text-slate-500 text-center shrink-0">
        <div className="w-12 h-12 rounded-full bg-slate-900 flex items-center justify-center mb-3 text-slate-600">
          <User className="w-6 h-6" />
        </div>
        <span className="font-semibold text-sm text-slate-300">No Target Selected</span>
        <span className="text-xs text-slate-500 mt-1">Select a token on the battle map or initiative list.</span>
      </aside>
    );
  }

  return (
    <aside aria-label="Character Sheet Sidebar" className="w-84 h-full vtt-glass-panel border-l border-slate-800/80 flex flex-col justify-between shrink-0 overflow-y-auto vtt-scrollbar">
      <div className="p-4 space-y-4">
        {/* Token Header Banner */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center font-bold text-white shadow-lg border border-slate-600"
              style={{ backgroundColor: activeToken.color }}
            >
              {renderTokenIcon(activeToken)}
            </div>
            <div>
              <h2 className="font-bold text-sm text-slate-100 font-display">{activeToken.name}</h2>
              <div className="text-[11px] font-mono text-purple-400">
                {activeToken.isPlayer ? 'Level 5 Hero' : 'Hostile Entity'}
              </div>
            </div>
          </div>

          <button
            onClick={onToggleCollapse}
            className="p-1 text-slate-500 hover:text-slate-200 transition"
            title="Collapse Character Sheet"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Quick Vitals Grid */}
        <div className="grid grid-cols-3 gap-2 text-center font-mono">
          <div className="p-2 bg-slate-900/70 rounded-lg border border-slate-800">
            <div className="text-[10px] text-slate-400">ARMOR</div>
            <div className="text-sm font-bold text-sky-400">{activeToken.ac} AC</div>
          </div>
          <div className="p-2 bg-slate-900/70 rounded-lg border border-slate-800">
            <div className="text-[10px] text-slate-400">HEALTH</div>
            <div className="text-sm font-bold text-emerald-400">
              {Math.max(0, activeToken.hp)} / {activeToken.maxHp}
            </div>
          </div>
          <div className="p-2 bg-slate-900/70 rounded-lg border border-slate-800">
            <div className="text-[10px] text-slate-400">SPEED</div>
            <div className="text-sm font-bold text-amber-400">30 ft</div>
          </div>
        </div>

        {/* Ability Scores */}
        <div className="space-y-1">
          <span className="text-[10px] font-mono font-bold text-slate-500 tracking-wider">ABILITIES</span>
          <div className="grid grid-cols-6 gap-1 text-center font-mono">
            {[
              { name: 'STR', score: 18, mod: '+4' },
              { name: 'DEX', score: 14, mod: '+2' },
              { name: 'CON', score: 16, mod: '+3' },
              { name: 'INT', score: 10, mod: '+0' },
              { name: 'WIS', score: 12, mod: '+1' },
              { name: 'CHA', score: 8, mod: '-1' },
            ].map((ab) => (
              <div key={ab.name} className="p-1 bg-slate-950 rounded border border-slate-800/80">
                <div className="text-[8px] text-slate-500">{ab.name}</div>
                <div className="text-xs font-bold text-slate-200">{ab.mod}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Action Budget Badges */}
        <div className="p-2 bg-slate-900/50 rounded-lg border border-slate-800/80 flex items-center justify-between text-[11px] font-mono">
          <span className="flex items-center gap-1 text-emerald-400">
            <Zap className="w-3 h-3" /> Action (1)
          </span>
          <span className="flex items-center gap-1 text-sky-400">
            <Sparkles className="w-3 h-3" /> Bonus (1)
          </span>
          <span className="flex items-center gap-1 text-purple-400">
            <Shield className="w-3 h-3" /> Reaction (1)
          </span>
        </div>

        {/* Tab Switcher */}
        <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-800 font-mono text-xs">
          <button
            onClick={() => setActiveTab('actions')}
            className={`flex-1 py-1 rounded transition text-center ${
              activeTab === 'actions' ? 'bg-purple-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Actions
          </button>
          <button
            onClick={() => setActiveTab('spells')}
            className={`flex-1 py-1 rounded transition text-center ${
              activeTab === 'spells' ? 'bg-purple-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Spells
          </button>
          <button
            onClick={() => setActiveTab('inventory')}
            className={`flex-1 py-1 rounded transition text-center ${
              activeTab === 'inventory' ? 'bg-purple-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Inventory
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'actions' && (
          <div className="space-y-2">
            <div className="space-y-1.5">
              <button
                onClick={() => onExecuteAttack('Greataxe Slash', '1d12 + 4', 'slashing')}
                className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
              >
                <div className="flex items-center gap-2">
                  <Sword className="w-4 h-4 text-rose-400 group-hover:scale-110 transition-transform" />
                  <div>
                    <div className="text-xs font-bold text-slate-100">Greataxe Slash</div>
                    <div className="text-[10px] text-slate-400 font-mono">+6 to hit · 1d12 + 4 Slashing</div>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-rose-950 text-rose-300 rounded border border-rose-800 font-mono">
                  Melee
                </span>
              </button>

              <button
                onClick={() => onExecuteAttack('Shortbow Shot', '1d6 + 2', 'piercing')}
                className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
              >
                <div className="flex items-center gap-2">
                  <Sword className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
                  <div>
                    <div className="text-xs font-bold text-slate-100">Shortbow Shot</div>
                    <div className="text-[10px] text-slate-400 font-mono">+4 to hit · 1d6 + 2 Piercing</div>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-amber-950 text-amber-300 rounded border border-amber-800 font-mono">
                  Ranged
                </span>
              </button>
            </div>

            {/* Skill Checks */}
            <div className="pt-2">
              <span className="text-[10px] font-mono font-bold text-slate-500 tracking-wider">SKILL RESOLUTION</span>
              <div className="grid grid-cols-2 gap-1.5 mt-1">
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
              </div>
            </div>
          </div>
        )}

        {activeTab === 'spells' && (
          <div className="space-y-2">
            <button
              onClick={() => onCastSpell('spell_fireball', 'Fireball', 3)}
              className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
            >
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-400 group-hover:scale-110 transition-transform" />
                <div>
                  <div className="text-xs font-bold text-slate-100">Fireball</div>
                  <div className="text-[10px] text-slate-400 font-mono">8d6 Fire · 20ft Sphere</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 bg-orange-950 text-orange-300 rounded border border-orange-800 font-mono">
                Level 3
              </span>
            </button>

            <button
              onClick={() => onCastSpell('spell_magic_missile', 'Magic Missile', 1)}
              className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/60 rounded-lg text-left transition group"
            >
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-purple-400 group-hover:scale-110 transition-transform" />
                <div>
                  <div className="text-xs font-bold text-slate-100">Magic Missile</div>
                  <div className="text-[10px] text-slate-400 font-mono">3d4 + 3 Force · Auto-Hit</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 bg-purple-950 text-purple-300 rounded border border-purple-800 font-mono">
                Level 1
              </span>
            </button>
          </div>
        )}

        {activeTab === 'inventory' && (
          <div className="space-y-2 text-xs font-mono text-slate-300">
            <div className="p-2 bg-slate-900/80 rounded border border-slate-800 flex justify-between">
              <span>Encumbrance:</span>
              <span className="text-purple-400 font-bold">48.5 / 270 lbs</span>
            </div>
            <div className="p-2 bg-slate-900/60 rounded border border-slate-800/80 flex justify-between items-center">
              <span>+1 Greataxe (Equipped)</span>
              <span className="text-[10px] text-emerald-400">7 lbs</span>
            </div>
            <div className="p-2 bg-slate-900/60 rounded border border-slate-800/80 flex justify-between items-center">
              <span>Potion of Healing (x2)</span>
              <span className="text-[10px] text-slate-400">1 lb</span>
            </div>
            <div className="p-2 bg-slate-900/60 rounded border border-slate-800/80 flex justify-between items-center">
              <span>Explorer's Pack</span>
              <span className="text-[10px] text-slate-400">40.5 lbs</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
