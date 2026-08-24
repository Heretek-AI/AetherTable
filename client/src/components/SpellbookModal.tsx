import React, { useState } from 'react';
import { Sparkles, Search, BookOpen } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { Statblock } from '../ui/Statblock';

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

  const filtered = PREPARED_SPELLS_DATA.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) || s.school.toLowerCase().includes(search.toLowerCase())
  );

  const handleCast = () => {
    onCastSpellWithUpcast(selectedSpell.name, selectedSpell.level, castLevel, selectedSpell.damage);
    onClose();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Digital Grimoire & Spell Upcaster"
      subtitle="Prepared Spells: 6 / 9 · Spell Save DC: 15 · Spell Attack Bonus: +7"
      icon={<BookOpen className="w-5 h-5" />}
      size="lg"
      footer={
        /* Cast Button */
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-secondary text-xs"
          >
            Cancel
          </button>
          <button
            onClick={handleCast}
            className="vtt-btn vtt-btn-primary font-display tracking-wide active:scale-95"
          >
            <Sparkles className="w-4 h-4" />
            <span>Cast at Level {castLevel}</span>
          </button>
        </div>
      }
    >
      {/* Content Body: Left Spell List (5 cols) + Right Spell Statblock & Upcaster (7 cols) */}
      <div className="grid grid-cols-1 md:grid-cols-12">
        {/* Left Column: Prepared Spell Selector */}
        <div className="md:col-span-5 border-r border-tavern-border pr-4 space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--rp-parchment-300)] pointer-events-none" />
            <input
              type="text"
              placeholder="Search grimoire..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="vtt-input w-full pl-8 text-xs"
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
                      ? 'bg-tavern-surface border-tavern-accent shadow-[0_0_14px_rgba(217,119,6,0.25)]'
                      : 'vtt-surface rounded-lg hover:border-[var(--rp-leather-600)]'
                  }`}
                >
                  <div>
                    <div className={`text-xs font-bold ${isSelected ? 'text-tavern-accent' : 'text-[var(--rp-parchment-100)]'}`}>{spell.name}</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)]">
                      Level {spell.level} · {spell.school}
                    </div>
                  </div>
                  {/* School badge — printed-book chip */}
                  <span className="vtt-badge font-mono">Lvl {spell.level}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Printed Spell Statblock & Upcasting Engine */}
        <div className="md:col-span-7 pl-4 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-tavern-border pb-2">
              <h3 className="text-lg font-bold font-display text-[var(--rp-parchment-100)]">{selectedSpell.name}</h3>
              <span className="vtt-badge font-mono font-bold">
                Level {selectedSpell.level} {selectedSpell.school}
              </span>
            </div>

            {/* Detail pane — the spell prints as an official book stat block
                on aged parchment (shared Statblock renderer). Local record
                fields are mapped onto the compendium spell shape; state and
                handlers are untouched. */}
            <div className="vtt-parchment rounded-xl p-4">
              <Statblock
                item={{
                  ...selectedSpell,
                  casting_time: selectedSpell.time,
                  description: selectedSpell.desc,
                  upcast: selectedSpell.upcastDamage === 'No scaling' ? undefined : selectedSpell.upcastDamage,
                }}
                kind="spell"
              />
            </div>

            {/* Upcasting Slot Selector */}
            <div className="p-3 vtt-surface rounded-xl space-y-2">
              <div className="flex items-center justify-between text-xs font-bold text-[var(--rp-parchment-200)] font-mono">
                <span>Upcast Spell Level:</span>
                <span className="text-sm text-tavern-accent">Level {castLevel} Slot</span>
              </div>

              <div className="flex items-center space-x-2">
                {[selectedSpell.level, selectedSpell.level + 1, selectedSpell.level + 2, selectedSpell.level + 3].filter((l) => l <= 9).map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() => setCastLevel(lvl)}
                    className={`flex-1 py-1.5 rounded-lg font-mono text-xs font-bold transition cursor-pointer ${
                      castLevel === lvl
                        ? 'bg-gradient-to-b from-[var(--rp-amber-500)] to-[var(--rp-amber-600)] text-[var(--rp-ink-900)] border border-[color-mix(in_srgb,var(--rp-amber-500)_70%,black)]'
                        : 'bg-tavern-bg border border-tavern-border text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)]'
                    }`}
                  >
                    Lvl {lvl}
                  </button>
                ))}
              </div>

              <div className="text-[11px] text-[var(--rp-parchment-300)] font-mono pt-1">
                <strong className="text-tavern-accent">Upcast Benefit:</strong> {selectedSpell.upcastDamage}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
