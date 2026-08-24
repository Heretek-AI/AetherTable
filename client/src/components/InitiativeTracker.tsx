import React, { useMemo } from 'react';
import {
  Swords,
  ChevronRight,
  ChevronLeft,
  Heart,
  Shield,
  Skull,
  Sparkles,
  Crosshair,
  Play,
  Square,
  Zap,
} from 'lucide-react';
import { Token } from './TacticalCanvas';

/**
 * One rolled initiative slot as reported by the authoritative engine
 * (POST /sessions/{id}/combat/begin → `order[]`). Every field here is real
 * server data — d20 + DEX modifier resolved inside vtt-core; this component
 * never fabricates a combatant or a roll.
 */
export interface CombatantEntry {
  entity_id: string;
  name: string;
  dexterity: number;
  initiative_total: number;
}

/* --- Additive turn-report consumption ------------------------------------
 *
 * The engine's POST /api/v1/sessions/{id}/turn/next response carries its core
 * contract ({status, round, report:{round, ticks}}) PLUS additive disclosure
 * fields that appear only when the underlying rules actually fired:
 *   - `opportunity_attack` / `opportunity_attacks_detail` — OA provocations
 *     ({provoked_by, reaction_type, available}), omitted entirely when nothing
 *     could be provoked;
 *   - `concentration_check` / `concentration_checks` — damage-triggered
 *     concentration saves, omitted when no caster took damage.
 *
 * This component consumes those fields ONLY as display. It never resolves an
 * OA itself, never rolls a save, and renders nothing for a field the response
 * did not contain — absence stays silent instead of becoming an invention.
 */

/** One disclosed opportunity-attack provocation from the last advance. */
export interface TurnOpportunityAttack {
  provokedBy?: string;
  moverId?: string;
}

/** One disclosed concentration save from the last advance. */
export interface TurnConcentrationCheck {
  entityId?: string;
  naturalRoll?: number;
  total?: number;
  dc?: number;
  /** undefined = the response did not say; rendered as "reported", not guessed. */
  maintained?: boolean;
}

/** Parsed view of whatever additive fields the last turn-next response carried. */
export interface TurnAdvancementNotice {
  round?: number;
  opportunityAttacks: TurnOpportunityAttack[];
  concentrationChecks: TurnConcentrationCheck[];
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const numField = (o: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    if (typeof o[k] === 'number') return o[k] as number;
  }
  return undefined;
};

const strField = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    if (typeof o[k] === 'string' && (o[k] as string).length > 0) return o[k] as string;
  }
  return undefined;
};

const parseOaEntry = (raw: unknown): TurnOpportunityAttack | null => {
  const o = asRecord(raw);
  if (!o) return null;
  const provokedBy = strField(o, 'provoked_by', 'attacker_id', 'provokedBy');
  // Without a provoking entity the entry says nothing usable — drop it rather
  // than render "something provoked something".
  if (!provokedBy) return null;
  const moverId = strField(o, 'mover_id', 'mover', 'target_id');
  return { provokedBy, moverId };
};

const parseConcEntry = (raw: unknown): TurnConcentrationCheck | null => {
  const o = asRecord(raw);
  if (!o) return null;
  const entityId = strField(o, 'entity_id', 'target_id', 'caster_id');
  const naturalRoll = numField(o, 'natural_roll', 'natural', 'roll');
  const total = numField(o, 'total');
  const dc = numField(o, 'dc');
  // An entry with no subject AND no numbers discloses nothing.
  if (!entityId && naturalRoll === undefined && total === undefined && dc === undefined) {
    return null;
  }
  let maintained: boolean | undefined;
  for (const k of ['maintained', 'passed', 'success', 'concentration_maintained']) {
    if (typeof o[k] === 'boolean') {
      maintained = o[k] as boolean;
      break;
    }
  }
  return { entityId, naturalRoll, total, dc, maintained };
};

const parseOaList = (raw: unknown): TurnOpportunityAttack[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseOaEntry)
    .filter((e): e is TurnOpportunityAttack => e !== null);
};

const parseConcList = (raw: unknown): TurnConcentrationCheck[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseConcEntry)
    .filter((e): e is TurnConcentrationCheck => e !== null);
};

/**
 * Extract the additive disclosure fields from a raw turn-next (or any action)
 * response body. Returns null when the body carried none of them.
 */
export function parseTurnAdvancement(raw: unknown): TurnAdvancementNotice | null {
  const top = asRecord(raw);
  if (!top) return null;

  const opportunityAttacks = [
    ...parseOaList(top.opportunity_attacks_detail),
    ...parseOaList(top.opportunity_attacks),
    // Back-compat singular field mirrors the first detail entry.
    ...(Array.isArray(top.opportunity_attacks_detail) || Array.isArray(top.opportunity_attacks)
      ? []
      : (() => {
          const single = parseOaEntry(top.opportunity_attack);
          return single ? [single] : [];
        })()),
  ];

  const concentrationChecks = [
    ...parseConcList(top.concentration_checks),
    ...(Array.isArray(top.concentration_checks)
      ? []
      : (() => {
          const single = parseConcEntry(top.concentration_check);
          return single ? [single] : [];
        })()),
  ];

  const round = typeof top.round === 'number' ? top.round : undefined;
  if (opportunityAttacks.length === 0 && concentrationChecks.length === 0) return null;
  return { round, opportunityAttacks, concentrationChecks };
}

interface InitiativeTrackerProps {
  tokens: Token[];
  onNextTurn: () => void;
  onSelectToken: (tokenId: string) => void;
  selectedTokenId: string | null;
  roundNumber: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Authoritative engine combat flag — false renders the explicit empty state. */
  inCombat: boolean;
  /** Rolled initiative order from the engine. Empty until combat begins. */
  combatOrder: CombatantEntry[];
  /** Entity id whose turn it is per the engine's turn_index. */
  activeEntityId: string | null;
  /** Only GMs see Begin/End combat controls. */
  isGm: boolean;
  /** True while a begin/end request is in flight (buttons disable). */
  isCombatBusy?: boolean;
  onBeginCombat: () => void;
  onEndCombat: () => void;
  /**
   * RAW JSON body of the most recent engine turn-advance response, handed over
   * verbatim by the caller. Parsed defensively here; only additive disclosure
   * fields it actually contains are displayed. Null/undefined renders nothing.
   */
  lastTurnResponse?: unknown;
}

export const InitiativeTracker: React.FC<InitiativeTrackerProps> = ({
  tokens,
  onNextTurn,
  onSelectToken,
  selectedTokenId,
  roundNumber,
  isCollapsed,
  onToggleCollapse,
  inCombat,
  combatOrder,
  activeEntityId,
  isGm,
  isCombatBusy = false,
  onBeginCombat,
  onEndCombat,
  lastTurnResponse,
}) => {
  // Additive turn report: whatever the engine's last advance actually
  // disclosed (OA provocations, concentration saves). Nothing here is derived
  // or remembered across advances beyond what the caller hands us.
  const turnNotice = useMemo(() => parseTurnAdvancement(lastTurnResponse), [lastTurnResponse]);

  /** Best-effort id → display name using ONLY data we already have. */
  const displayNameFor = (entityId?: string): string => {
    if (!entityId) return 'unknown combatant';
    const fromOrder = combatOrder.find((c) => c.entity_id === entityId);
    if (fromOrder) return fromOrder.name;
    const fromToken = tokens.find((t) => t.id === entityId);
    return fromToken ? fromToken.name : entityId;
  };

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

  // Join an engine order entry back onto its board token for color/HP/AC.
  // Entries without a matching local token still render (engine name + roll).
  const tokenFor = (entityId: string): Token | undefined =>
    tokens.find((t) => t.id === entityId);

  const renderAvatar = (entityId: string, name: string) => {
    const token = tokenFor(entityId);
    return (
      <div
        className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold text-white shadow shrink-0"
        style={{ backgroundColor: token?.color || '#57534e' }}
      >
        {token ? renderTokenIcon(token) : name.charAt(0).toUpperCase()}
      </div>
    );
  };

  // ---------------------------------------------------------------- collapsed

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

        {!inCombat ? (
          <Swords className="w-4 h-4 text-[var(--rp-parchment-300)] opacity-50" aria-label="Combat not started" />
        ) : (
          <div className="flex flex-col items-center gap-2">
            {combatOrder.map((entry) => {
              const isActiveTurn = entry.entity_id === activeEntityId;
              return (
                <div
                  key={entry.entity_id}
                  onClick={() => onSelectToken(entry.entity_id)}
                  className={`w-7 h-7 rounded-full flex items-center justify-center cursor-pointer border transition-transform ${
                    isActiveTurn ? 'border-[var(--tavern-accent)] scale-110 shadow-md shadow-amber-900/50' : 'border-[var(--tavern-border)]'
                  }`}
                >
                  {renderAvatar(entry.entity_id, entry.name)}
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={onNextTurn}
          disabled={!inCombat || combatOrder.length === 0}
          className="p-2 bg-[var(--rp-amber-600)] hover:bg-[var(--rp-amber-500)] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          title={inCombat ? 'Advance Turn' : 'Combat not started'}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  // ------------------------------------------------------------------ expanded

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
            {inCombat && (
              <span className="text-[11px] font-mono font-semibold px-2 py-0.5 bg-[var(--rp-leather-700)] text-[var(--rp-parchment-200)] rounded border border-[var(--tavern-accent)]/40">
                Round {roundNumber}
              </span>
            )}
            <button
              onClick={onToggleCollapse}
              className="p-1 opacity-60 hover:opacity-100 transition"
              title="Collapse Panel"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Combatant List / Empty State */}
        {!inCombat ? (
          <div className="p-6 flex flex-col items-center gap-3 text-center max-h-[calc(100vh-270px)] overflow-y-auto vtt-scrollbar">
            <Swords className="w-8 h-8 text-[var(--rp-parchment-300)] opacity-40" />
            <div className="font-semibold text-xs text-[var(--rp-parchment-100)]">
              Combat not started
            </div>
            <div className="text-[10px] text-[var(--rp-parchment-300)] leading-relaxed">
              No initiative has been rolled. Spawn entities on the board, then
              begin combat to roll d20 + DEX for everyone.
            </div>
            {isGm && (
              <button
                onClick={onBeginCombat}
                disabled={isCombatBusy}
                className="mt-1 w-full flex items-center justify-center gap-2 py-2 px-3 bg-[var(--rp-amber-600)] hover:bg-[var(--rp-amber-500)] disabled:opacity-50 disabled:cursor-wait text-white font-semibold text-xs rounded-lg transition border border-amber-400/30"
                title="Roll initiative and open combat"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{isCombatBusy ? 'Rolling…' : 'Begin Combat'}</span>
              </button>
            )}
          </div>
        ) : (
          <div className="p-2.5 space-y-2 overflow-y-auto vtt-scrollbar max-h-[calc(100vh-270px)]">
            {combatOrder.length === 0 && (
              <div className="text-[10px] text-[var(--rp-parchment-300)] p-3 text-center">
                Combat is active but no combatants are tracked yet.
              </div>
            )}
            {combatOrder.map((entry) => {
              const token = tokenFor(entry.entity_id);
              const isActiveTurn = entry.entity_id === activeEntityId;
              const isSelected = selectedTokenId === entry.entity_id;
              const isDead = token ? token.hp <= 0 : false;

              return (
                <div
                  key={entry.entity_id}
                  onClick={() => onSelectToken(entry.entity_id)}
                  className={`p-3 rounded-xl transition-all cursor-pointer border ${
                    isActiveTurn
                      ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_14%,transparent)] border-[var(--tavern-accent)]/70 shadow-lg shadow-black/40'
                      : isSelected
                      ? 'bg-[var(--tavern-surface)] border-[var(--tavern-border)]'
                      : 'bg-black/20 border-[var(--tavern-border)]/60 hover:bg-[var(--rp-leather-700)]/40'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {renderAvatar(entry.entity_id, entry.name)}
                      <div className="min-w-0">
                        <div className="font-semibold text-xs text-[var(--rp-parchment-100)] flex items-center gap-1.5 truncate">
                          {entry.name}
                          {isDead && <Skull className="w-3 h-3 text-rose-500 shrink-0" />}
                        </div>
                        <div className="text-[10px] text-[var(--rp-parchment-300)] font-mono">
                          DEX {entry.dexterity >= 0 ? `+${entry.dexterity}` : entry.dexterity}
                          {token ? ` · ${token.isPlayer ? 'Player Character' : 'Hostile Entity'}` : ''}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {/* Server-rolled initiative total (d20 + DEX mod). */}
                      <span
                        className={`text-xs font-mono font-bold px-2 py-0.5 rounded border ${
                          isActiveTurn
                            ? 'text-white bg-[var(--tavern-accent-deep)] border-[var(--tavern-accent)]'
                            : 'text-[var(--rp-parchment-200)] bg-[var(--rp-leather-700)] border-[var(--tavern-border)]'
                        }`}
                        title="Rolled initiative (d20 + DEX)"
                      >
                        {entry.initiative_total}
                      </span>
                      {token && (
                        <div className="flex items-center gap-1 text-xs font-mono text-[var(--rp-parchment-200)]">
                          <Shield className="w-3.5 h-3.5 text-tavern-accent" />
                          <span>{token.ac}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* HP Bar — only when the entry maps onto a known token. */}
                  {token && (
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
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Additive engine disclosures from the most recent turn advance.
          Renders ONLY fields the response actually carried — an advance that
          provoked nothing and triggered no concentration save shows no strip
          at all. Display-only: this component never resolves a reaction. */}
      {inCombat && turnNotice && (
        <div className="mx-3 mb-2 rounded-xl border border-[var(--rp-amber-600)]/40 bg-black/30 p-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-[var(--rp-parchment-300)]">
            <Zap className="w-3 h-3 text-tavern-accent" />
            <span>
              Turn report{typeof turnNotice.round === 'number' ? ` · Round ${turnNotice.round}` : ''}
            </span>
          </div>
          {turnNotice.opportunityAttacks.map((oa, i) => (
            <div key={`oa_${i}`} className="text-[10px] text-[var(--rp-parchment-200)] font-mono">
              ⚔ Opportunity attack provoked by{' '}
              <strong className="text-[var(--rp-parchment-100)]">{displayNameFor(oa.provokedBy)}</strong>
              {oa.moverId ? ` against ${displayNameFor(oa.moverId)}` : ''} — reaction available
            </div>
          ))}
          {turnNotice.concentrationChecks.map((cc, i) => (
            <div key={`cc_${i}`} className="text-[10px] text-[var(--rp-parchment-200)] font-mono">
              ✦ Concentration save
              {cc.entityId ? (
                <>
                  {' '}— <strong className="text-[var(--rp-parchment-100)]">{displayNameFor(cc.entityId)}</strong>
                </>
              ) : null}
              {typeof cc.naturalRoll === 'number' ? ` · d20 ${cc.naturalRoll}` : ''}
              {typeof cc.total === 'number' ? ` → ${cc.total}` : ''}
              {typeof cc.dc === 'number' ? ` vs DC ${cc.dc}` : ''}
              {' '}—{' '}
              {cc.maintained === undefined ? (
                <span className="text-[var(--rp-parchment-300)]">reported</span>
              ) : cc.maintained ? (
                <span className="text-emerald-400">maintained</span>
              ) : (
                <span className="text-rose-400">BROKEN</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Footer Controls */}
      <div className="p-3 border-t border-[var(--tavern-border)] bg-black/30 space-y-2">
        {inCombat && (
          <button
            onClick={onNextTurn}
            disabled={combatOrder.length === 0}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-[var(--rp-amber-600)] hover:bg-[var(--rp-amber-500)] active:bg-[var(--tavern-accent-deep)] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xs rounded-lg transition shadow-md shadow-amber-950 border border-amber-400/30"
          >
            <span>Advance Turn</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
        {inCombat && isGm && (
          <button
            onClick={onEndCombat}
            disabled={isCombatBusy}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-black/40 hover:bg-rose-950/60 disabled:opacity-50 disabled:cursor-wait text-[var(--rp-parchment-200)] hover:text-rose-200 font-semibold text-xs rounded-lg transition border border-[var(--tavern-border)]"
            title="Clear the initiative tracker"
          >
            <Square className="w-3 h-3" />
            <span>{isCombatBusy ? 'Ending…' : 'End Combat'}</span>
          </button>
        )}
      </div>
    </aside>
  );
};
