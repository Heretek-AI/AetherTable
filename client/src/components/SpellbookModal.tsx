import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, Search, BookOpen, RefreshCw } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { Statblock } from '../ui/Statblock';
import {
  EngineActionOutcome,
  EngineCastSpellOutcome,
  EngineCompendiumSpell,
  EngineSpellbookEntity,
  compendiumSpellToEngineDefinition,
  engineCastSpell,
  engineSessionRoster,
  ensureEngineSession,
  fetchCompendiumSpells,
} from '../api/rules_engine';

interface SpellbookModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Legacy demo hook. The grimoire now resolves casts through the
   * authoritative engine itself (see handleCast below), so this callback is
   * deliberately NOT invoked — calling it would double-bookkeep the cast
   * through App.tsx's approximate-damage demo path.
   */
  onCastSpellWithUpcast?: (
    spellName: string,
    baseLevel: number,
    castLevel: number,
    damageFormula: string
  ) => void;
}

const ORDINALS = ['Cantrip', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
const levelLabel = (level: number) => ORDINALS[level] ?? `${level}`;

type ListState = 'loading' | 'ready' | 'error';

/** The last cast outcome, rendered verbatim inside an aria-live region. */
type CastOutcome =
  | { kind: 'applied'; data: EngineCastSpellOutcome }
  | { kind: 'rejected'; status: number; code: string | null; message: string | null }
  | { kind: 'unreachable'; detail: string };

export const SpellbookModal: React.FC<SpellbookModalProps> = ({ isOpen, onClose }) => {
  /* --- Live SRD compendium ------------------------------------------------ */
  const [spells, setSpells] = useState<EngineCompendiumSpell[]>([]);
  const [listState, setListState] = useState<ListState>('loading');
  const [search, setSearch] = useState('');

  /* --- Live engine roster (caster sheet + targets) ------------------------ */
  const [roster, setRoster] = useState<EngineSpellbookEntity[] | null>(null);
  const [rosterNote, setRosterNote] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [castLevel, setCastLevel] = useState<number | null>(null);
  const [casting, setCasting] = useState(false);
  const [outcome, setOutcome] = useState<CastOutcome | null>(null);

  const loadSpells = useCallback(async () => {
    setListState('loading');
    const payload = await fetchCompendiumSpells(400);
    if (!payload) {
      // Honest empty state: no invented local spell list on failure.
      setSpells([]);
      setListState('error');
      return;
    }
    setSpells(payload.spells);
    setSelectedId((current) => current ?? payload.spells[0]?.id ?? null);
    setListState('ready');
  }, []);

  const loadRoster = useCallback(async () => {
    const sessionId = await ensureEngineSession();
    if (!sessionId) {
      setRoster(null);
      setRosterNote(
        'Rules engine session unavailable — caster sheet, slots and concentration cannot be read.'
      );
      return;
    }
    const result = await engineSessionRoster(sessionId);
    if (result.kind === 'applied') {
      setRoster(result.data);
      setRosterNote(result.data.length === 0 ? 'The engine session has no entities yet.' : null);
      return;
    }
    setRoster(null);
    setRosterNote(
      result.kind === 'rejected'
        ? `Session state refused (${result.code ?? `HTTP ${result.status}`})${result.message ? `: ${result.message}` : ''}`
        : 'Rules engine unreachable — slot ledger and concentration cannot be read.'
    );
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadSpells();
    void loadRoster();
  }, [isOpen, loadSpells, loadRoster]);

  const selectedSpell = useMemo(
    () => spells.find((s) => s.id === selectedId) ?? null,
    [spells, selectedId]
  );

  /* --- Caster & target selection from the projected roster ---------------- */
  const caster = useMemo<EngineSpellbookEntity | null>(() => {
    if (!roster || roster.length === 0) return null;
    const alive = roster.filter((e) => !e.is_dead);
    // Prefer an entity whose OWN sheet (slot ledger) this caller can see.
    return (
      alive.find((e) => e.is_player && e.spell_slots_remaining !== undefined) ??
      alive.find((e) => e.is_player) ??
      alive[0] ??
      null
    );
  }, [roster]);

  const target = useMemo<EngineSpellbookEntity | null>(
    () => roster?.find((e) => !e.is_player && !e.is_dead) ?? null,
    [roster]
  );

  /**
   * Upcast options bounded by the caster's REAL unexpended slots when the
   * role projection exposes their sheet; otherwise every legal level up to 9
   * is offered and labelled unverified — the engine remains the arbiter and
   * will answer NO_SPELL_SLOTS if the ledger disagrees.
   */
  const slotOptions = useMemo<{ levels: number[]; verified: boolean }>(() => {
    if (!selectedSpell || selectedSpell.level > 9) return { levels: [], verified: false };
    const min = Math.max(0, selectedSpell.level);
    const ledger = caster?.spell_slots_remaining;
    if (!ledger) {
      return {
        levels: Array.from({ length: 10 - min }, (_, i) => min + i),
        verified: false,
      };
    }
    const levels: number[] = [];
    for (let lvl = min; lvl <= 9; lvl++) {
      if ((ledger[String(lvl)] ?? 0) > 0) levels.push(lvl);
    }
    return { levels, verified: true };
  }, [selectedSpell, caster]);

  // Keep the chosen slot level legal whenever the selection or ledger moves.
  useEffect(() => {
    setCastLevel((current) => {
      if (slotOptions.levels.length === 0) return null;
      if (current != null && slotOptions.levels.includes(current)) return current;
      return Math.min(...slotOptions.levels);
    });
  }, [slotOptions]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byLevel = new Map<number, EngineCompendiumSpell[]>();
    for (const spell of spells) {
      if (
        q &&
        !spell.name.toLowerCase().includes(q) &&
        !(spell.school ?? '').toLowerCase().includes(q)
      ) {
        continue;
      }
      const bucket = byLevel.get(spell.level);
      if (bucket) bucket.push(spell);
      else byLevel.set(spell.level, [spell]);
    }
    return [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
  }, [spells, search]);

  const concentrationOn = caster?.concentration?.spell_id ?? null;

  const handleCast = async () => {
    if (!selectedSpell || castLevel == null || casting) return;
    setCasting(true);
    setOutcome(null);
    try {
      const sessionId = await ensureEngineSession();
      if (!sessionId) {
        setOutcome({
          kind: 'unreachable',
          detail: 'Rules engine unreachable — the cast was not attempted.',
        });
        return;
      }
      if (!caster) {
        setOutcome({
          kind: 'unreachable',
          detail:
            'No visible caster entity in the engine session — spawn tokens before casting.',
        });
        return;
      }
      const result = await engineCastSpell({
        sessionId,
        casterId: caster.id,
        targetId: target?.id,
        spell: compendiumSpellToEngineDefinition(selectedSpell),
        castLevel,
      });
      if (result.kind === 'applied') {
        setOutcome({ kind: 'applied', data: result.data });
        // Slots were spent / concentration may have changed engine-side.
        void loadRoster();
      } else if (result.kind === 'rejected') {
        setOutcome({
          kind: 'rejected',
          status: result.status,
          code: result.code,
          message: result.message,
        });
      } else {
        setOutcome({
          kind: 'unreachable',
          detail: 'Rules engine unreachable — the cast was not applied.',
        });
      }
    } finally {
      setCasting(false);
    }
  };

  const canCast = listState === 'ready' && !!selectedSpell && castLevel != null && !casting;

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Digital Grimoire"
      subtitle={
        listState === 'ready'
          ? `${spells.length} SRD spells from the live compendium`
          : 'Reading the SRD compendium…'
      }
      icon={<BookOpen className="w-5 h-5" />}
      size="lg"
      footer={
        <div className="flex justify-end space-x-3">
          <button onClick={onClose} className="vtt-btn vtt-btn-secondary text-xs">
            Cancel
          </button>
          <button
            onClick={() => void handleCast()}
            disabled={!canCast}
            className="vtt-btn vtt-btn-primary font-display tracking-wide active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {casting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            <span>
              {castLevel != null ? `Cast at Level ${castLevel}` : 'Select a Slot'}
            </span>
          </button>
        </div>
      }
    >
      {/* Content Body: Left Spell List (5 cols) + Right Spell Statblock & Upcaster (7 cols) */}
      <div className="grid grid-cols-1 md:grid-cols-12">
        {/* Left Column: Compendium Spell Selector */}
        <div className="md:col-span-5 border-r border-tavern-border pr-4 space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--rp-parchment-300)] pointer-events-none" />
            <input
              type="text"
              placeholder="Search grimoire..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={listState !== 'ready'}
              className="vtt-input w-full pl-8 text-xs"
            />
          </div>

          {listState === 'loading' && (
            <div className="p-6 text-center text-xs font-mono text-[var(--rp-parchment-300)]">
              Fetching SRD spells…
            </div>
          )}

          {listState === 'error' && (
            <div className="p-4 vtt-surface rounded-lg space-y-2 text-xs text-[var(--rp-parchment-200)]">
              <p>
                The compendium endpoint is unreachable, so no spell list can be shown. Nothing is
                fabricated client-side.
              </p>
              <button
                onClick={() => void loadSpells()}
                className="vtt-btn vtt-btn-secondary text-xs"
              >
                Retry
              </button>
            </div>
          )}

          {listState === 'ready' && grouped.length === 0 && (
            <div className="p-6 text-center text-xs font-mono text-[var(--rp-parchment-300)]">
              No compendium spells match “{search}”.
            </div>
          )}

          {listState === 'ready' &&
            grouped.map(([level, bucket]) => (
              <div key={level} className="space-y-1.5">
                <h4 className="text-[10px] uppercase tracking-widest font-mono text-[var(--rp-parchment-300)] pt-1">
                  {levelLabel(level)} level · {bucket.length}
                </h4>
                {bucket.map((spell) => {
                  const isSelected = selectedId === spell.id;
                  return (
                    <div
                      key={spell.id}
                      onClick={() => {
                        setSelectedId(spell.id);
                        setOutcome(null);
                      }}
                      className={`p-3 rounded-lg border transition-all cursor-pointer flex items-center justify-between ${
                        isSelected
                          ? 'bg-tavern-surface border-tavern-accent shadow-[0_0_14px_rgba(217,119,6,0.25)]'
                          : 'vtt-surface rounded-lg hover:border-[var(--rp-leather-600)]'
                      }`}
                    >
                      <div>
                        <div
                          className={`text-xs font-bold ${isSelected ? 'text-tavern-accent' : 'text-[var(--rp-parchment-100)]'}`}
                        >
                          {spell.name}
                        </div>
                        <div className="text-[10px] text-[var(--rp-parchment-300)]">
                          Level {spell.level} · {spell.school || '—'}
                        </div>
                      </div>
                      {/* School badge — printed-book chip */}
                      <span className="vtt-badge font-mono">Lvl {spell.level}</span>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>

        {/* Right Column: Printed Spell Statblock & Authoritative Cast */}
        <div className="md:col-span-7 pl-4 space-y-4">
          {!selectedSpell && listState === 'ready' && (
            <div className="p-6 text-center text-xs font-mono text-[var(--rp-parchment-300)]">
              Select a spell from the grimoire.
            </div>
          )}

          {selectedSpell && (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-tavern-border pb-2">
                <h3 className="text-lg font-bold font-display text-[var(--rp-parchment-100)]">
                  {selectedSpell.name}
                </h3>
                <span className="vtt-badge font-mono font-bold">
                  Level {selectedSpell.level} {selectedSpell.school}
                </span>
              </div>

              {/* Detail pane — rendered straight from the fetched compendium
                  record via the shared book-style Statblock renderer. */}
              <div className="vtt-parchment rounded-xl p-4">
                <Statblock item={{ ...selectedSpell }} kind="spell" />
              </div>

              {/* Upcasting Slot Selector — bounded by the caster's real ledger */}
              <div className="p-3 vtt-surface rounded-xl space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-[var(--rp-parchment-200)] font-mono">
                  <span>Upcast Spell Level:</span>
                  <span className="text-sm text-tavern-accent">
                    {castLevel != null ? `Level ${castLevel} Slot` : '—'}
                  </span>
                </div>

                {slotOptions.levels.length > 0 ? (
                  <div className="flex items-center flex-wrap gap-2">
                    {slotOptions.levels.map((lvl) => (
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
                ) : (
                  <div className="text-[11px] text-[var(--rp-parchment-300)] font-mono">
                    The caster&apos;s ledger shows no unexpended slot at level{' '}
                    {selectedSpell.level} or higher. The engine will refuse with NO_SPELL_SLOTS.
                  </div>
                )}

                <div className="text-[11px] text-[var(--rp-parchment-300)] font-mono pt-1">
                  {slotOptions.verified ? (
                    <>
                      <strong className="text-tavern-accent">Slot Ledger:</strong> bounded by the
                      caster&apos;s unexpended slots from engine session-state.
                    </>
                  ) : (
                    <>
                      <strong className="text-tavern-accent">Slots Unverified:</strong> your role
                      projection does not expose the caster&apos;s sheet — the engine decides.
                    </>
                  )}
                </div>

                {caster?.spell_slots_remaining !== undefined && (
                  <div className="text-[11px] font-mono text-[var(--rp-parchment-300)]">
                    {Object.entries(caster.spell_slots_remaining)
                      .filter(([, n]) => n > 0)
                      .map(([lvl, n]) => `L${lvl}: ${n}`)
                      .join(' · ') || 'All slots expended.'}
                  </div>
                )}
              </div>

              {/* Caster / target + active concentration, from session-state */}
              <div className="p-3 vtt-surface rounded-xl space-y-1.5 text-[11px] font-mono text-[var(--rp-parchment-300)]">
                {rosterNote && <div className="text-[var(--rp-amber-500)]">{rosterNote}</div>}
                {caster && (
                  <div>
                    <strong className="text-tavern-accent">Caster:</strong>{' '}
                    {caster.name ?? caster.id}
                  </div>
                )}
                {concentrationOn && (
                  <div>
                    <strong className="text-tavern-accent">Concentrating:</strong>{' '}
                    {concentrationOn}
                  </div>
                )}
                {target && (
                  <div>
                    <strong className="text-tavern-accent">Target:</strong> {target.name ?? target.id}
                  </div>
                )}
              </div>

              {/* Verbatim engine outcome — quoted, never paraphrased into
                  local state. aria-live announces rejections too. */}
              <div aria-live="polite" role="status">
                {outcome?.kind === 'applied' && (
                  <div className="p-3 rounded-xl vtt-surface border border-tavern-accent/40 space-y-1 text-[11px] font-mono">
                    <div className="text-xs font-bold text-tavern-accent">
                      Engine applied the cast{outcome.data.counterspelled ? ' (counterspelled)' : ''}
                    </div>
                    <div>slot_level_used: {outcome.data.slot_level_used}</div>
                    <div>damage_total: {outcome.data.damage_total}</div>
                    <div>
                      target_hp_remaining:{' '}
                      {outcome.data.target_hp_remaining ?? '—'}
                    </div>
                    <div>
                      concentration_started: {String(outcome.data.concentration_started)}
                    </div>
                    {outcome.data.counterspelled && <div>counterspelled: true</div>}
                    {outcome.data.damage_total === 0 && (
                      <div className="text-[var(--rp-parchment-300)] italic">
                        The SRD compendium record carries no damage expression, so the engine
                        resolved the slot expenditure at zero damage rather than guessing dice.
                      </div>
                    )}
                  </div>
                )}
                {outcome?.kind === 'rejected' && (
                  <div className="p-3 rounded-xl vtt-surface border border-red-500/40 space-y-1 text-[11px] font-mono text-red-300">
                    <div className="font-bold">
                      Rejected by the engine — {outcome.code ?? `HTTP ${outcome.status}`}
                    </div>
                    {outcome.message && <div>{outcome.message}</div>}
                  </div>
                )}
                {outcome?.kind === 'unreachable' && (
                  <div className="p-3 rounded-xl vtt-surface border border-[var(--rp-leather-600)] text-[11px] font-mono text-[var(--rp-parchment-200)]">
                    {outcome.detail}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
};
