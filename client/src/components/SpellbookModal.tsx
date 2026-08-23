import React, { useState } from 'react';
import {
  Sparkles,
  Flame,
  Wand2,
  Shield,
  Zap,
  Clock,
  Compass,
  X,
  Search,
  Check,
  Plus,
  BookOpen,
  Filter,
} from 'lucide-react';

interface SpellbookModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCastSpellWithUpcast: (spellName: string, baseLevel: number, castLevel: number, damageFormula: string) => void;
}

const PREPARED_SPELLS_DATA = [
  { id: 'fireball', name: 'Fireball', level: 3, school: 'Evocation', time: '1 Action', range: '150 ft', duration: 'Instantaneous', components: 'V, S, M', desc: 'A bright streak flashes from your pointing finger to a point you choose and blossoms with a low roar into an explosion of flame. Each creature in a 20ft sphere must make a DEX save.', damage: '8d6', upcastDamage: '+1d6 per slot above 3rd' },
  { id: 'magic_missile', name: 'Magic Missile', level: 1, school: 'Evocation', time: '1 Action', range: '120 ft', duration: 'Instantaneous', components: 'V, S', desc: 'You create three glowing darts of magical force. Each dart hits a creature of your choice that you can see within range. A dart deals 1d4 + 1 force damage.', damage: '3d4 + 3', upcastDamage: '+1 dart (1d4+1) per slot above 1st' },
  { id: 'shield', name: 'Shield', level: 1, school: 'Abjuration', time: '1 Reaction', range: 'Self', duration: '1 round', components: 'V, S', desc: 'An invisible barrier of magical force appears and protects you. Until the start of your next turn, you have a +5 bonus to AC.', damage: '0', upcastDamage: 'No scaling' },
  { id: 'misty_step', name: 'Misty Step', level: 2, school: 'Conjuration', time: '1 Bonus Action', range: 'Self (30ft)', duration: 'Instantaneous', components: 'V', desc: 'Briefly surrounded by silvery mist, you teleport up to 30 feet to an unoccupied space that you can see.', damage: '0', upcastDamage: 'No scaling' },
  { id: 'scorching_ray', name: 'Scorching Ray', level: 2, school: 'Evocation', time: '1 Action', range: '120 ft', duration: 'Instantaneous', components: 'V, S', desc: 'You create three rays of fire and hurl them at targets within range. You can hurl them at one target or several.', damage: '6d6', upcastDamage: '+1 ray (2d6) per slot above 2nd' },
  { id: 'cure_wounds', name: 'Cure Wounds', level: 1, school: 'Evocation', time: '1 Action', range: 'Touch', duration: 'Instantaneous', components: 'V, S', desc: 'A creature you touch regains hit points equal to 1d8 + your spellcasting ability modifier.', damage: '1d8 + 4', upcastDamage: '+1d8 healing per slot above 1st' },
];

export const SpellbookModal: React.FC<SpellbookModalProps> = ({
  isOpen,
  onClose,
  onCastSpellWithUpcast,
}) => {
  const [selectedSpell, setSelectedSpell] = useState<typeof PREPARED_SPELLS_DATA[0]>(PREPARED_SPELLS_DATA[0]);
  const [castLevel, setCastLevel] = useState<number>(3);
  const [search, setSearch] = useState<string>('');

  if (!isOpen) return null;

  const filtered = PREPARED_SPELLS_DATA.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) || s.school.toLowerCase().includes(search.toLowerCase())
  );

  const handleCast = () => {
    onCastSpellWithUpcast(selectedSpell.name, selectedSpell.level, castLevel, selectedSpell.damage);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-purple-500/40 rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-purple-950/50 border border-purple-600/40 rounded-xl text-purple-400">
              <BookOpen className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif tracking-wide text-slate-100">
                Digital Grimoire & Spell Upcaster
              </h2>
              <p className="text-xs text-slate-400">
                Prepared Spells: 6 / 9 · Spell Save DC: 15 · Spell Attack Bonus: +7
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body: Left Spell List (5 cols) + Right Spell Details & Upcaster (7 cols) */}
        <div className="grid grid-cols-1 md:grid-cols-12 flex-1 overflow-hidden">
          {/* Left Column: Prepared Spell Selector */}
          <div className="md:col-span-5 border-r border-slate-800 p-4 space-y-3 overflow-y-auto max-h-[60vh]">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search grimoire..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-purple-500"
              />
            </div>

            <div className="space-y-1.5">
              {filtered.map((spell) => {
                const isSelected = selectedSpell.id === spell.id;
                return (
                  <div
                    key={spell.id}
                    onClick={() => {
                      setSelectedSpell(spell);
                      setCastLevel(spell.level);
                    }}
                    className={`p-3 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-purple-950/60 border-purple-500 text-purple-200'
                        : 'bg-slate-950/40 border-slate-800 hover:bg-slate-800 text-slate-300'
                    }`}
                  >
                    <div>
                      <div className="text-xs font-bold">{spell.name}</div>
                      <div className="text-[10px] text-slate-400">
                        Level {spell.level} · {spell.school}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono px-2 py-0.5 bg-slate-900 border border-slate-700 rounded text-slate-300">
                      Lvl {spell.level}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Statblock & Upcasting Engine */}
          <div className="md:col-span-7 p-6 space-y-4 overflow-y-auto max-h-[60vh] flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <h3 className="text-lg font-bold font-serif text-slate-100">{selectedSpell.name}</h3>
                <span className="px-2 py-0.5 bg-purple-950 border border-purple-600/50 text-purple-300 text-xs font-mono font-bold rounded">
                  Level {selectedSpell.level} {selectedSpell.school}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-[11px] font-mono text-slate-300 bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                <div><strong>Casting:</strong> {selectedSpell.time}</div>
                <div><strong>Range:</strong> {selectedSpell.range}</div>
                <div><strong>Duration:</strong> {selectedSpell.duration}</div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed font-sans italic bg-slate-950/60 p-3 rounded-lg border border-slate-800/80">
                "{selectedSpell.desc}"
              </p>

              {/* Upcasting Slot Selector */}
              <div className="p-3 bg-purple-950/30 border border-purple-700/40 rounded-xl space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-purple-300 font-mono">
                  <span>Upcast Spell Level:</span>
                  <span className="text-sm text-amber-400">Level {castLevel} Slot</span>
                </div>

                <div className="flex items-center space-x-2">
                  {[selectedSpell.level, selectedSpell.level + 1, selectedSpell.level + 2, selectedSpell.level + 3].filter((l) => l <= 9).map((lvl) => (
                    <button
                      key={lvl}
                      onClick={() => setCastLevel(lvl)}
                      className={`flex-1 py-1.5 rounded-lg font-mono text-xs font-bold transition cursor-pointer ${
                        castLevel === lvl
                          ? 'bg-purple-600 text-white shadow-lg shadow-purple-900/50 border border-purple-400'
                          : 'bg-slate-900 border border-slate-700 text-slate-400 hover:text-white'
                      }`}
                    >
                      Lvl {lvl}
                    </button>
                  ))}
                </div>

                <div className="text-[11px] text-slate-400 font-mono pt-1">
                  <strong className="text-purple-300">Upcast Benefit:</strong> {selectedSpell.upcastDamage}
                </div>
              </div>
            </div>

            {/* Cast Button */}
            <div className="pt-4 border-t border-slate-800 flex justify-end space-x-3">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleCast}
                className="flex items-center space-x-2 px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-bold rounded-lg shadow-lg shadow-purple-950/60 transition active:scale-95 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>Cast at Level {castLevel}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
