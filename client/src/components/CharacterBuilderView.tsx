import React, { useState, useEffect } from 'react';
import {
  User,
  Shield,
  Sparkles,
  Sword,
  Wand2,
  Dice5,
  Download,
  Plus,
  Check,
  ChevronRight,
  ChevronLeft,
  Flame,
  Heart,
  Zap,
  Activity,
  Layers,
  FileText
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { Token } from './TacticalCanvas';

interface CharacterBuilderViewProps {
  onDeployCharacter: (token: Omit<Token, 'id' | 'x' | 'y'>) => void;
}

interface AbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

const POINT_BUY_COSTS: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

export const CharacterBuilderView: React.FC<CharacterBuilderViewProps> = ({ onDeployCharacter }) => {
  const [step, setStep] = useState<number>(1);
  const [name, setName] = useState('Valerius the Bold');
  const [selectedRace, setSelectedRace] = useState('Mountain Dwarf');
  const [selectedClass, setSelectedClass] = useState('Fighter');
  const [background, setBackground] = useState('Soldier');
  const [alignment, setAlignment] = useState('Neutral Good');
  const [level, setLevel] = useState(5);

  // Ability Scores
  const [statMode, setStatMode] = useState<'point_buy' | 'standard_array' | 'roll'>('point_buy');
  const [baseScores, setBaseScores] = useState<AbilityScores>({
    str: 15,
    dex: 13,
    con: 14,
    int: 10,
    wis: 12,
    cha: 8,
  });

  const [availableSpells, setAvailableSpells] = useState<any[]>([]);
  const [selectedSpells, setSelectedSpells] = useState<string[]>(['Fireball', 'Shield', 'Magic Missile']);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  useEffect(() => {
    fetch('/api/v1/orchestrator/compendium/spells?limit=50')
      .then((r) => r.json())
      .then((data) => {
        if (data.spells) setAvailableSpells(data.spells);
      })
      .catch((e) => console.error(e));
  }, []);

  // Race bonuses
  const getRacialBonus = (ability: keyof AbilityScores): number => {
    switch (selectedRace) {
      case 'Mountain Dwarf':
        return ability === 'str' ? 2 : ability === 'con' ? 2 : 0;
      case 'High Elf':
        return ability === 'dex' ? 2 : ability === 'int' ? 1 : 0;
      case 'Human':
        return 1;
      case 'Tiefling':
        return ability === 'cha' ? 2 : ability === 'int' ? 1 : 0;
      case 'Lightfoot Halfling':
        return ability === 'dex' ? 2 : ability === 'cha' ? 1 : 0;
      case 'Dragonborn':
        return ability === 'str' ? 2 : ability === 'cha' ? 1 : 0;
      default:
        return 0;
    }
  };

  const getFinalScore = (ability: keyof AbilityScores) => {
    return baseScores[ability] + getRacialBonus(ability);
  };

  const getModifier = (ability: keyof AbilityScores) => {
    const score = getFinalScore(ability);
    return Math.floor((score - 10) / 2);
  };

  const calculatePointBuyTotal = () => {
    return (
      POINT_BUY_COSTS[baseScores.str] +
      POINT_BUY_COSTS[baseScores.dex] +
      POINT_BUY_COSTS[baseScores.con] +
      POINT_BUY_COSTS[baseScores.int] +
      POINT_BUY_COSTS[baseScores.wis] +
      POINT_BUY_COSTS[baseScores.cha]
    );
  };

  const adjustScore = (ability: keyof AbilityScores, delta: number) => {
    const current = baseScores[ability];
    const next = current + delta;
    if (next < 8 || next > 15) return;

    const currentCost = calculatePointBuyTotal();
    const costDiff = POINT_BUY_COSTS[next] - POINT_BUY_COSTS[current];

    if (currentCost + costDiff <= 27 || delta < 0) {
      setBaseScores((prev) => ({ ...prev, [ability]: next }));
      globalAudio.playTurnAdvance();
    }
  };

  const roll4d6DropLowest = () => {
    globalAudio.playDiceRoll();
    const rollStat = () => {
      const rolls = Array.from({ length: 4 }, () => Math.floor(Math.random() * 6) + 1);
      rolls.sort((a, b) => a - b);
      return rolls[1] + rolls[2] + rolls[3];
    };
    setBaseScores({
      str: Math.min(15, Math.max(8, rollStat())),
      dex: Math.min(15, Math.max(8, rollStat())),
      con: Math.min(15, Math.max(8, rollStat())),
      int: Math.min(15, Math.max(8, rollStat())),
      wis: Math.min(15, Math.max(8, rollStat())),
      cha: Math.min(15, Math.max(8, rollStat())),
    });
  };

  // Calculate Computed Vitals
  const dexMod = getModifier('dex');
  const conMod = getModifier('con');
  const strMod = getModifier('str');
  const wisMod = getModifier('wis');

  const computedAC = selectedClass === 'Barbarian'
    ? 10 + dexMod + conMod
    : selectedClass === 'Monk'
    ? 10 + dexMod + wisMod
    : selectedClass === 'Wizard'
    ? 10 + dexMod
    : 14 + Math.min(2, dexMod) + 2; // Scale Mail + Shield for Fighter/Paladin

  const computedHP = (selectedClass === 'Barbarian' ? 12 : selectedClass === 'Fighter' || selectedClass === 'Paladin' ? 10 : 8) + (level - 1) * 6 + conMod * level;

  const handleExportPdf = async () => {
    setIsExportingPdf(true);
    try {
      const payload = {
        name,
        level,
        class_name: selectedClass,
        race: selectedRace,
        background,
        alignment,
        ac: computedAC,
        hp: computedHP,
        max_hp: computedHP,
        speed: selectedRace.includes('Dwarf') || selectedRace.includes('Halfling') ? '25 ft' : '30 ft',
        str_score: getFinalScore('str'),
        dex_score: getFinalScore('dex'),
        con_score: getFinalScore('con'),
        int_score: getFinalScore('int'),
        wis_score: getFinalScore('wis'),
        cha_score: getFinalScore('cha'),
        str_mod: strMod,
        dex_mod: dexMod,
        passive_perception: 10 + wisMod + 2,
        actions: [
          { name: 'Primary Weapon Strike', atk: `+${strMod + 3}`, damage: '1d12 + ' + strMod + ' Slashing', range: 'Melee (5 ft)' },
          { name: 'Secondary Ranged Attack', atk: `+${dexMod + 3}`, damage: '1d8 + ' + dexMod + ' Piercing', range: '80/320 ft' },
        ],
        spells: selectedSpells.map((s) => ({ name: s, level: 1, school: 'Evocation', casting_time: '1 action', range: '60 ft' })),
      };

      const res = await fetch('/api/v1/orchestrator/character/export-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.toLowerCase().replace(/\s+/g, '_')}_sheet.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error('PDF Export Error:', e);
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handleDeployToBattlefield = () => {
    globalAudio.playSpellCast();
    onDeployCharacter({
      name,
      hp: computedHP,
      maxHp: computedHP,
      ac: computedAC,
      color: '#3b82f6',
      isPlayer: true,
      avatarIconType: selectedClass === 'Wizard' ? 'mage' : selectedClass === 'Rogue' ? 'scout' : 'fighter',
    });
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden">
      {/* Top Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold font-display flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-400" />
            <span>5e Character Creation Studio</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Strict Orcpub modifier graph, 27-point buy calculator, SRD spellbook, and 1-click vector PDF exporter.
          </p>
        </div>

        {/* Wizard Steps */}
        <div className="flex items-center gap-2 bg-slate-900/90 p-1 rounded-xl border border-slate-800 font-mono text-xs">
          {['1. Race', '2. Class', '3. Ability Scores', '4. Spellbook', '5. Review & Deploy'].map((label, idx) => (
            <button
              key={label}
              onClick={() => setStep(idx + 1)}
              className={`px-3 py-1 rounded-lg transition font-semibold ${
                step === idx + 1
                  ? 'bg-purple-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Body */}
      <div className="flex-1 p-6 overflow-y-auto vtt-scrollbar max-w-5xl mx-auto w-full">
        {/* STEP 1: RACE */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-sm font-bold font-display uppercase tracking-wider text-purple-400">
              Select Race & Ancestry
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { name: 'Mountain Dwarf', desc: '+2 STR, +2 CON, Darkvision, Dwarven Resilience', speed: '25 ft' },
                { name: 'High Elf', desc: '+2 DEX, +1 INT, Darkvision, Keen Senses, Fey Ancestry', speed: '30 ft' },
                { name: 'Human', desc: '+1 All Abilities, Versatile, Standard Language Mastery', speed: '30 ft' },
                { name: 'Tiefling', desc: '+2 CHA, +1 INT, Darkvision, Hellfire Resistance', speed: '30 ft' },
                { name: 'Lightfoot Halfling', desc: '+2 DEX, +1 CHA, Lucky, Brave, Halfling Nimbleness', speed: '25 ft' },
                { name: 'Dragonborn', desc: '+2 STR, +1 CHA, Draconic Breath Weapon & Resistance', speed: '30 ft' },
              ].map((r) => (
                <div
                  key={r.name}
                  onClick={() => setSelectedRace(r.name)}
                  className={`p-4 rounded-xl border cursor-pointer transition ${
                    selectedRace === r.name
                      ? 'bg-purple-950/50 border-purple-500 shadow-lg'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <h3 className="font-bold text-sm text-slate-100 font-display">{r.name}</h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">{r.desc}</p>
                  <div className="text-[10px] font-mono text-purple-400 mt-2">Speed: {r.speed}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STEP 2: CLASS */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-sm font-bold font-display uppercase tracking-wider text-purple-400">
              Select Class & Archetype
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { name: 'Fighter', hitDie: 'd10', primary: 'STR / DEX', saves: 'STR, CON', desc: 'Masters of martial combat and weapons.' },
                { name: 'Wizard', hitDie: 'd6', primary: 'INT', saves: 'INT, WIS', desc: 'Scholarly magic-users capable of manipulating reality.' },
                { name: 'Rogue', hitDie: 'd8', primary: 'DEX', saves: 'DEX, INT', desc: 'Stealthy specialists in precision strikes and expertise.' },
                { name: 'Cleric', hitDie: 'd8', primary: 'WIS', saves: 'WIS, CHA', desc: 'Divine champions channeling deity miracles.' },
                { name: 'Paladin', hitDie: 'd10', primary: 'STR, CHA', saves: 'WIS, CHA', desc: 'Holy warriors bound by sacred oaths.' },
                { name: 'Barbarian', hitDie: 'd12', primary: 'STR, CON', saves: 'STR, CON', desc: 'Fierce warriors fueled by primal rage.' },
              ].map((c) => (
                <div
                  key={c.name}
                  onClick={() => setSelectedClass(c.name)}
                  className={`p-4 rounded-xl border cursor-pointer transition ${
                    selectedClass === c.name
                      ? 'bg-purple-950/50 border-purple-500 shadow-lg'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <h3 className="font-bold text-sm text-slate-100 font-display">{c.name}</h3>
                  <div className="text-[10px] font-mono text-purple-400 mt-0.5">Hit Die: {c.hitDie} · Primary: {c.primary}</div>
                  <p className="text-xs text-slate-400 mt-2 leading-relaxed">{c.desc}</p>
                  <div className="text-[10px] font-mono text-slate-500 mt-2">Saves: {c.saves}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STEP 3: ABILITY SCORES (POINT BUY) */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold font-display uppercase tracking-wider text-purple-400">
                  Ability Score Point Buy Calculator (5e SRD)
                </h2>
                <p className="text-xs text-slate-400">
                  Points Spent: <strong className="text-purple-300">{calculatePointBuyTotal()} / 27</strong>
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={roll4d6DropLowest}
                  className="flex items-center gap-1 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-purple-300 rounded-lg text-xs font-mono border border-slate-800"
                >
                  <Dice5 className="w-4 h-4" />
                  <span>Roll 4d6 Drop Lowest</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as (keyof AbilityScores)[]).map((ability) => {
                const base = baseScores[ability];
                const racial = getRacialBonus(ability);
                const finalScore = base + racial;
                const mod = Math.floor((finalScore - 10) / 2);

                return (
                  <div
                    key={ability}
                    className="p-3 bg-slate-900/80 rounded-xl border border-slate-800 text-center flex flex-col items-center justify-between shadow"
                  >
                    <span className="text-xs font-bold uppercase font-mono text-purple-300">{ability}</span>
                    
                    <div className="my-2">
                      <div className="text-2xl font-black font-display text-slate-100">{finalScore}</div>
                      <div className="text-xs font-mono font-bold text-sky-400">{mod >= 0 ? `+${mod}` : mod}</div>
                    </div>

                    <div className="text-[10px] font-mono text-slate-500 mb-2">
                      Base {base} {racial > 0 && <span className="text-emerald-400">+{racial}</span>}
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => adjustScore(ability, -1)}
                        className="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold"
                      >
                        -
                      </button>
                      <button
                        onClick={() => adjustScore(ability, 1)}
                        className="w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 4: SPELLBOOK */}
        {step === 4 && (
          <div className="space-y-4">
            <h2 className="text-sm font-bold font-display uppercase tracking-wider text-purple-400">
              Select Prepared Spells ({selectedSpells.length} Selected)
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {availableSpells.slice(0, 18).map((spell) => {
                const isSelected = selectedSpells.includes(spell.name);
                return (
                  <div
                    key={spell.id}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedSpells(selectedSpells.filter((s) => s !== spell.name));
                      } else {
                        setSelectedSpells([...selectedSpells, spell.name]);
                      }
                      globalAudio.playTurnAdvance();
                    }}
                    className={`p-3 rounded-xl border cursor-pointer transition ${
                      isSelected
                        ? 'bg-purple-950/60 border-purple-500 shadow'
                        : 'bg-slate-900/60 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="font-bold text-xs text-slate-100 font-display">{spell.name}</h4>
                      {isSelected && <Check className="w-3.5 h-3.5 text-purple-400" />}
                    </div>
                    <div className="text-[10px] font-mono text-purple-400 mt-0.5">
                      {spell.level === 0 ? 'Cantrip' : `Level ${spell.level}`} · {spell.school}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">{spell.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 5: REVIEW & DEPLOY */}
        {step === 5 && (
          <div className="space-y-6">
            <div className="vtt-glass-panel p-6 rounded-2xl border border-slate-800">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="text-xl font-bold font-display bg-transparent border-b border-purple-500/50 text-slate-100 focus:outline-none focus:border-purple-400"
                  />
                  <div className="text-xs font-mono text-purple-300 mt-1">
                    Level {level} {selectedRace} {selectedClass} · {background}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleExportPdf}
                    disabled={isExportingPdf}
                    className="flex items-center gap-1.5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-purple-300 rounded-xl text-xs font-mono font-bold border border-slate-700 transition shadow"
                  >
                    <Download className="w-4 h-4" />
                    <span>{isExportingPdf ? 'Generating PDF...' : 'Export 5e PDF Sheet'}</span>
                  </button>

                  <button
                    onClick={handleDeployToBattlefield}
                    className="flex items-center gap-1.5 px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-bold font-mono transition shadow-lg shadow-purple-950 active:scale-95"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Deploy to Tabletop</span>
                  </button>
                </div>
              </div>

              {/* Combat Vitals Strip */}
              <div className="grid grid-cols-4 gap-3 my-6 font-mono text-center">
                <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                  <div className="text-[10px] text-slate-500">ARMOR CLASS</div>
                  <div className="text-xl font-bold text-sky-400">{computedAC}</div>
                </div>
                <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                  <div className="text-[10px] text-slate-500">HIT POINTS</div>
                  <div className="text-xl font-bold text-emerald-400">{computedHP}</div>
                </div>
                <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                  <div className="text-[10px] text-slate-500">SPEED</div>
                  <div className="text-xl font-bold text-amber-400">
                    {selectedRace.includes('Dwarf') || selectedRace.includes('Halfling') ? '25 ft' : '30 ft'}
                  </div>
                </div>
                <div className="p-3 bg-slate-900 rounded-xl border border-slate-800">
                  <div className="text-[10px] text-slate-500">PROFICIENCY</div>
                  <div className="text-xl font-bold text-purple-400">+3</div>
                </div>
              </div>

              {/* Final Ability Score Badges */}
              <div className="grid grid-cols-6 gap-2 text-center font-mono">
                {(['str', 'dex', 'con', 'int', 'wis', 'cha'] as (keyof AbilityScores)[]).map((ab) => (
                  <div key={ab} className="p-2.5 bg-slate-900/60 rounded-xl border border-slate-800/80">
                    <div className="text-[10px] uppercase text-slate-400">{ab}</div>
                    <div className="text-sm font-bold text-slate-100">{getFinalScore(ab)}</div>
                    <div className="text-[11px] text-sky-400">
                      {getModifier(ab) >= 0 ? `+${getModifier(ab)}` : getModifier(ab)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Wizard Step Footer Navigation */}
      <div className="p-4 border-t border-slate-800 bg-slate-900/80 flex items-center justify-between">
        <button
          onClick={() => setStep(Math.max(1, step - 1))}
          disabled={step === 1}
          className="flex items-center gap-1 px-4 py-1.5 rounded-lg text-xs font-mono text-slate-400 hover:text-slate-200 disabled:opacity-30"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Previous</span>
        </button>

        <span className="text-xs font-mono text-slate-500">Step {step} of 5</span>

        <button
          onClick={() => setStep(Math.min(5, step + 1))}
          disabled={step === 5}
          className="flex items-center gap-1 px-4 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-30 text-white rounded-lg text-xs font-mono font-semibold transition"
        >
          <span>Next</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
