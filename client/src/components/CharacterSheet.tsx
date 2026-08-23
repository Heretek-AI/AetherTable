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
  Skull,
  Eye,
  Heart,
  Moon,
  Sun,
  CheckCircle2,
  XCircle,
  AlertCircle,
  BookOpen
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface CharacterSheetProps {
  activeToken: Token | null;
  onExecuteAttack: (actionName: string, damageFormula: string, damageType: string) => void;
  onCastSpell: (spellId: string, spellName: string, level: number) => void;
  onRollCheck: (skillName: string, modifier: number, dc: number) => void;
  onOpenGrimoire?: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const CharacterSheet: React.FC<CharacterSheetProps> = ({
  activeToken,
  onExecuteAttack,
  onCastSpell,
  onRollCheck,
  onOpenGrimoire,
  isCollapsed,
  onToggleCollapse,
}) => {
  const [activeTab, setActiveTab] = useState<'actions' | 'spells' | 'inventory' | 'features'>('actions');

  // Spell Slots State (D&D Beyond Style)
  const [spellSlots, setSpellSlots] = useState<{ [lvl: number]: { total: number; used: number } }>({
    1: { total: 4, used: 1 },
    2: { total: 3, used: 1 },
    3: { total: 2, used: 0 },
  });

  // Death Saves State
  const [deathSuccesses, setDeathSuccesses] = useState<number>(0);
  const [deathFailures, setDeathFailures] = useState<number>(0);

  // Active Conditions State
  const [selectedConditions, setSelectedConditions] = useState<string[]>([]);

  const toggleSpellSlot = (level: number, slotIndex: number) => {
    setSpellSlots((prev) => {
      const current = prev[level] || { total: 2, used: 0 };
      const newUsed = slotIndex < current.used ? current.used - 1 : current.used + 1;
      return {
        ...prev,
        [level]: { ...current, used: Math.max(0, Math.min(current.total, newUsed)) },
      };
    });
  };

  const handleToggleCondition = (cond: string) => {
    setSelectedConditions((prev) =>
      prev.includes(cond) ? prev.filter((c) => c !== cond) : [...prev, cond]
    );
  };

  const handleLongRest = () => {
    setSpellSlots({
      1: { total: 4, used: 0 },
      2: { total: 3, used: 0 },
      3: { total: 2, used: 0 },
    });
    setDeathSuccesses(0);
    setDeathFailures(0);
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

  if (isCollapsed) {
    return (
      <aside aria-label="Character Sheet Sidebar" className="h-full vtt-glass-panel border-l border-slate-800/80 p-2 flex flex-col items-center justify-between shrink-0 w-12 transition-all">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 bg-slate-900 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white border border-slate-800 transition cursor-pointer"
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
      <aside aria-label="Character Sheet Sidebar" className="w-88 h-full vtt-glass-panel border-l border-slate-800/80 p-6 flex flex-col items-center justify-center text-slate-500 text-center shrink-0">
        <div className="w-12 h-12 rounded-full bg-slate-900 flex items-center justify-center mb-3 text-slate-600">
          <User className="w-6 h-6" />
        </div>
        <span className="font-semibold text-sm text-slate-300">No Target Selected</span>
        <span className="text-xs text-slate-500 mt-1">Select a token on the battle map or initiative list.</span>
      </aside>
    );
  }

  return (
    <aside aria-label="Character Sheet Sidebar" className="w-88 h-full vtt-glass-panel border-l border-slate-800/80 flex flex-col justify-between shrink-0 overflow-y-auto vtt-scrollbar">
      <div className="p-4 space-y-4">
        {/* Token Header Banner (D&D Beyond Style) */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-white shadow-xl border-2 border-amber-500/40 relative"
              style={{ backgroundColor: activeToken.color }}
            >
              {renderTokenIcon(activeToken)}
              {activeToken.elevationFeet && activeToken.elevationFeet > 0 ? (
                <span className="absolute -bottom-1 -right-1 px-1 text-[8px] font-mono bg-amber-950 border border-amber-500 text-amber-300 rounded font-bold">
                  +{activeToken.elevationFeet}ft
                </span>
              ) : null}
            </div>
            <div>
              <h2 className="font-bold text-sm text-slate-100 font-serif tracking-wide">{activeToken.name}</h2>
              <div className="flex items-center space-x-2 text-[11px] font-mono">
                <span className="text-amber-400 font-semibold">
                  {activeToken.isPlayer ? 'Level 5 Hero' : 'Hostile Entity'}
                </span>
                <span className="text-slate-600">•</span>
                <span className="text-slate-400">Prof: +3</span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-1">
            <button
              onClick={handleLongRest}
              className="p-1.5 text-slate-400 hover:text-amber-300 hover:bg-slate-800/70 rounded transition"
              title="Take Long Rest (Recover HP & Spell Slots)"
            >
              <Sun className="w-4 h-4" />
            </button>
            <button
              onClick={onToggleCollapse}
              className="p-1.5 text-slate-500 hover:text-slate-200 hover:bg-slate-800/70 rounded transition cursor-pointer"
              title="Collapse Character Sheet"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Quick Vitals Grid (D&D Beyond HUD) */}
        <div className="grid grid-cols-3 gap-2 text-center font-mono">
          <div className="p-2.5 bg-slate-900/80 rounded-xl border border-slate-800 shadow-inner">
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">ARMOR</div>
            <div className="text-base font-bold text-sky-400">{activeToken.ac} AC</div>
          </div>
          <div className="p-2.5 bg-slate-900/80 rounded-xl border border-slate-800 shadow-inner">
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">HEALTH</div>
            <div className="text-base font-bold text-emerald-400">
              {Math.max(0, activeToken.hp)} <span className="text-xs text-slate-500">/ {activeToken.maxHp}</span>
            </div>
          </div>
          <div className="p-2.5 bg-slate-900/80 rounded-xl border border-slate-800 shadow-inner">
            <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">SPEED</div>
            <div className="text-base font-bold text-amber-400">30 ft</div>
          </div>
        </div>

        {/* Ability Scores Bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono font-bold text-slate-500 tracking-wider">ABILITY SCORES</span>
            <span className="text-[9px] font-mono text-slate-500">FLOORED MODS</span>
          </div>
          <div className="grid grid-cols-6 gap-1 text-center font-mono">
            {[
              { name: 'STR', score: 18, mod: '+4' },
              { name: 'DEX', score: 14, mod: '+2' },
              { name: 'CON', score: 16, mod: '+3' },
              { name: 'INT', score: 10, mod: '+0' },
              { name: 'WIS', score: 12, mod: '+1' },
              { name: 'CHA', score: 8, mod: '-1' },
            ].map((ab) => (
              <div key={ab.name} className="p-1.5 bg-slate-950/80 rounded-lg border border-slate-800 shadow-inner">
                <div className="text-[8px] text-slate-500 font-bold">{ab.name}</div>
                <div className="text-xs font-bold text-amber-300">{ab.mod}</div>
                <div className="text-[8px] text-slate-600 font-mono">{ab.score}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Passive Senses */}
        <div className="p-2 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center justify-between text-[11px] font-mono">
          <div className="flex items-center space-x-1.5 text-slate-300">
            <Eye className="w-3.5 h-3.5 text-amber-400" />
            <span>Perception: <strong className="text-amber-300">14</strong></span>
          </div>
          <div className="text-slate-400">
            <span>Insight: <strong className="text-slate-300">11</strong></span>
          </div>
          <div className="text-slate-400">
            <span>Invest: <strong className="text-slate-300">10</strong></span>
          </div>
        </div>

        {/* Action Budget Badges */}
        <div className="p-2 bg-slate-900/50 rounded-lg border border-slate-800/80 flex items-center justify-between text-[11px] font-mono">
          <span className="flex items-center gap-1 text-emerald-400 font-semibold">
            <Zap className="w-3 h-3" /> Action (1)
          </span>
          <span className="flex items-center gap-1 text-sky-400 font-semibold">
            <Sparkles className="w-3 h-3" /> Bonus (1)
          </span>
          <span className="flex items-center gap-1 text-purple-400 font-semibold">
            <Shield className="w-3 h-3" /> Reaction (1)
          </span>
        </div>

        {/* Tab Switcher (D&D Beyond Style) */}
        <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 font-mono text-xs">
          <button
            onClick={() => setActiveTab('actions')}
            className={`flex-1 py-1.5 rounded-md transition text-center font-bold cursor-pointer ${
              activeTab === 'actions' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Actions
          </button>
          <button
            onClick={() => setActiveTab('spells')}
            className={`flex-1 py-1.5 rounded-md transition text-center font-bold cursor-pointer ${
              activeTab === 'spells' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Spells
          </button>
          <button
            onClick={() => setActiveTab('inventory')}
            className={`flex-1 py-1.5 rounded-md transition text-center font-bold cursor-pointer ${
              activeTab === 'inventory' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Items
          </button>
          <button
            onClick={() => setActiveTab('features')}
            className={`flex-1 py-1.5 rounded-md transition text-center font-bold cursor-pointer ${
              activeTab === 'features' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            State
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'actions' && (
          <div className="space-y-3">
            <div className="space-y-2">
              <button
                onClick={() => onExecuteAttack('Greataxe Slash', '1d12 + 4', 'slashing')}
                className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-850 border border-slate-700/60 hover:border-amber-500/50 rounded-lg text-left transition group cursor-pointer shadow-sm"
              >
                <div className="flex items-center gap-2.5">
                  <Sword className="w-4 h-4 text-rose-400 group-hover:scale-110 transition-transform" />
                  <div>
                    <div className="text-xs font-bold text-slate-100 group-hover:text-amber-200">Greataxe Slash</div>
                    <div className="text-[10px] text-slate-400 font-mono">+6 to hit · 1d12 + 4 Slashing</div>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-rose-950 text-rose-300 rounded border border-rose-800 font-mono">
                  Melee
                </span>
              </button>

              <button
                onClick={() => onExecuteAttack('Shortbow Shot', '1d6 + 2', 'piercing')}
                className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-850 border border-slate-700/60 hover:border-amber-500/50 rounded-lg text-left transition group cursor-pointer shadow-sm"
              >
                <div className="flex items-center gap-2.5">
                  <Sword className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
                  <div>
                    <div className="text-xs font-bold text-slate-100 group-hover:text-amber-200">Shortbow Shot</div>
                    <div className="text-[10px] text-slate-400 font-mono">+4 to hit · 1d6 + 2 Piercing</div>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-amber-950 text-amber-300 rounded border border-amber-800 font-mono">
                  Ranged
                </span>
              </button>
            </div>

            {/* Skill Checks */}
            <div className="pt-2 border-t border-slate-800">
              <span className="text-[10px] font-mono font-bold text-slate-500 tracking-wider">SKILL CHECKS</span>
              <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                <button
                  onClick={() => onRollCheck('Athletics', 4, 15)}
                  className="p-2 bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/40 rounded-lg text-xs font-mono text-slate-300 hover:text-white transition text-left cursor-pointer"
                >
                  Athletics (+4)
                </button>
                <button
                  onClick={() => onRollCheck('Stealth', 2, 14)}
                  className="p-2 bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/40 rounded-lg text-xs font-mono text-slate-300 hover:text-white transition text-left cursor-pointer"
                >
                  Stealth (+2)
                </button>
                <button
                  onClick={() => onRollCheck('Perception', 1, 12)}
                  className="p-2 bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/40 rounded-lg text-xs font-mono text-slate-300 hover:text-white transition text-left cursor-pointer"
                >
                  Perception (+1)
                </button>
                <button
                  onClick={() => onRollCheck('Arcana', 0, 15)}
                  className="p-2 bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/40 rounded-lg text-xs font-mono text-slate-300 hover:text-white transition text-left cursor-pointer"
                >
                  Arcana (+0)
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'spells' && (
          <div className="space-y-4">
            {/* Spell Slots Tracker Matrix (D&D Beyond Style) */}
            <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
              <div className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">
                Spell Slots Matrix
              </div>
              <div className="space-y-1.5">
                {[1, 2, 3].map((lvl) => {
                  const slot = spellSlots[lvl] || { total: 2, used: 0 };
                  return (
                    <div key={lvl} className="flex items-center justify-between text-xs font-mono">
                      <span className="text-slate-400">Level {lvl}</span>
                      <div className="flex items-center space-x-1.5">
                        {Array.from({ length: slot.total }).map((_, i) => {
                          const isUsed = i < slot.used;
                          return (
                            <button
                              key={i}
                              onClick={() => toggleSpellSlot(lvl, i)}
                              className={`w-4 h-4 rounded-full border transition cursor-pointer ${
                                isUsed
                                  ? 'bg-slate-800 border-slate-700'
                                  : 'bg-purple-600 border-purple-400 shadow-sm shadow-purple-500/50'
                              }`}
                              title={`Level ${lvl} Slot ${i + 1}: ${isUsed ? 'Expended' : 'Available'}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Open Digital Grimoire Button */}
            {onOpenGrimoire && (
              <button
                onClick={onOpenGrimoire}
                className="w-full py-2 bg-purple-950/70 hover:bg-purple-900 border border-purple-600/50 text-purple-200 rounded-lg text-xs font-bold font-mono transition flex items-center justify-center space-x-1.5 shadow-sm cursor-pointer"
              >
                <BookOpen className="w-3.5 h-3.5 text-purple-400" />
                <span>Open Digital Grimoire & Upcaster</span>
              </button>
            )}

            {/* Spells List */}
            <div className="space-y-2">
              <button
                onClick={() => onCastSpell('spell_fireball', 'Fireball', 3)}
                className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-850 border border-slate-700/60 hover:border-amber-500/50 rounded-lg text-left transition group cursor-pointer shadow-sm"
              >
                <div className="flex items-center gap-2.5">
                  <Flame className="w-4 h-4 text-orange-400 group-hover:scale-110 transition-transform" />
                  <div>
                    <div className="text-xs font-bold text-slate-100 group-hover:text-amber-200">Fireball</div>
                    <div className="text-[10px] text-slate-400 font-mono">8d6 Fire · 20ft Sphere</div>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-orange-950 text-orange-300 rounded border border-orange-800 font-mono">
                  Level 3
                </span>
              </button>

              <button
                onClick={() => onCastSpell('spell_magic_missile', 'Magic Missile', 1)}
                className="w-full flex items-center justify-between p-2.5 bg-slate-900 hover:bg-slate-850 border border-slate-700/60 hover:border-amber-500/50 rounded-lg text-left transition group cursor-pointer shadow-sm"
              >
                <div className="flex items-center gap-2.5">
                  <Wand2 className="w-4 h-4 text-purple-400 group-hover:scale-110 transition-transform" />
                  <div>
                    <div className="text-xs font-bold text-slate-100 group-hover:text-amber-200">Magic Missile</div>
                    <div className="text-[10px] text-slate-400 font-mono">3d4 + 3 Force · Auto-Hit</div>
                  </div>
                </div>
                <span className="text-[10px] px-2 py-0.5 bg-purple-950 text-purple-300 rounded border border-purple-800 font-mono">
                  Level 1
                </span>
              </button>
            </div>
          </div>
        )}

        {activeTab === 'inventory' && (
          <div className="space-y-2.5 text-xs font-mono text-slate-300">
            <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 flex justify-between items-center">
              <span>Encumbrance Capacity:</span>
              <span className="text-amber-400 font-bold">48.5 / 270 lbs</span>
            </div>
            <div className="p-2 bg-slate-900/70 rounded-lg border border-slate-800 flex justify-between items-center">
              <span>+1 Greataxe (Equipped)</span>
              <span className="text-[10px] text-emerald-400">7 lbs</span>
            </div>
            <div className="p-2 bg-slate-900/70 rounded-lg border border-slate-800 flex justify-between items-center">
              <span>Potion of Healing (x2)</span>
              <span className="text-[10px] text-slate-400">1 lb</span>
            </div>
            <div className="p-2 bg-slate-900/70 rounded-lg border border-slate-800 flex justify-between items-center">
              <span>Explorer's Pack</span>
              <span className="text-[10px] text-slate-400">40.5 lbs</span>
            </div>
          </div>
        )}

        {activeTab === 'features' && (
          <div className="space-y-4">
            {/* Death Saves Tracker (D&D Beyond Style) */}
            <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
              <div className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">
                Death Saving Throws
              </div>
              <div className="space-y-2 text-xs font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-emerald-400">Successes:</span>
                  <div className="flex space-x-1.5">
                    {[1, 2, 3].map((i) => (
                      <button
                        key={i}
                        onClick={() => setDeathSuccesses(i === deathSuccesses ? i - 1 : i)}
                        className={`w-4 h-4 rounded-full border cursor-pointer ${
                          i <= deathSuccesses ? 'bg-emerald-500 border-emerald-300' : 'bg-slate-900 border-slate-700'
                        }`}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-rose-400">Failures:</span>
                  <div className="flex space-x-1.5">
                    {[1, 2, 3].map((i) => (
                      <button
                        key={i}
                        onClick={() => setDeathFailures(i === deathFailures ? i - 1 : i)}
                        className={`w-4 h-4 rounded-full border cursor-pointer ${
                          i <= deathFailures ? 'bg-rose-500 border-rose-300' : 'bg-slate-900 border-slate-700'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Condition Rings Tracker */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">
                Active Condition Rings
              </div>
              <div className="flex flex-wrap gap-1.5">
                {['Prone', 'Poisoned', 'Blinded', 'Stunned', 'Invisible', 'Charmed', 'Restrained'].map((cond) => {
                  const isActive = selectedConditions.includes(cond);
                  return (
                    <button
                      key={cond}
                      onClick={() => handleToggleCondition(cond)}
                      className={`px-2 py-0.5 text-[10px] font-mono rounded border transition cursor-pointer ${
                        isActive
                          ? 'bg-rose-950 text-rose-300 border-rose-600 font-bold'
                          : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {cond}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
