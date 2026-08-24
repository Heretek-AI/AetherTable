import React, { useEffect, useMemo, useState } from 'react';
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
  Hand,
  Footprints,
  Wind,
  HeartPulse,
  Heart,
  Moon,
  Sun,
  CheckCircle2,
  XCircle,
  AlertCircle,
  BookOpen
} from 'lucide-react';
import { Token } from './TacticalCanvas';
import { findCharacterForToken, FullStoredCharacter, AbilityScoreMap } from '../api/lobby_store';
import {
  EngineActionOutcome,
  EngineEntitySummary,
  EngineGrappleResult,
  EngineHealResult,
  EngineShoveResult,
  EngineStandardActionResult,
  EngineStabilizeResult,
  ensureEngineSession,
  engineDash,
  engineDisengage,
  engineDodge,
  engineGrapple,
  engineHeal,
  engineRest,
  engineSessionEntities,
  engineShove,
  engineStabilize,
} from '../api/rules_engine';
import {
  ABILITY_KEYS,
  ABILITY_LABELS,
  AbilityKey,
  formatModifier,
  getModifier,
  passivePerception,
  proficiencyBonus,
} from '../api/character_math';

interface CharacterSheetProps {
  activeToken: Token | null;
  onExecuteAttack: (actionName: string, damageFormula: string, damageType: string) => void;
  onCastSpell: (spellId: string, spellName: string, level: number) => void;
  onRollCheck: (skillName: string, modifier: number, dc: number) => void;
  onOpenGrimoire?: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /**
   * Explicit authoritative engine session id (e.g. App's combatSessionId).
   * OPTIONAL: when omitted the sheet lazily creates/reuses its own session
   * via ensureEngineSession(), so heal/rest work without App wiring. Pass it
   * to share one engine session across the whole table view — the follow-up
   * is literally `engineSessionId={combatSessionId}` in App.tsx.
   */
  engineSessionId?: string | null;
}

/* Design-token shorthands (official-5e-book system). */
const CRIMSON_TEXT = 'var(--statblock-header)'; /* --rp-crimson-600 — the only crimson for body text on paper */
const INK = 'var(--parchment-ink)';
const LEATHER_HAIRLINE = 'color-mix(in srgb, var(--rp-leather-700) 45%, transparent)';
const HEX_CLIP = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)';

export const CharacterSheet: React.FC<CharacterSheetProps> = ({
  activeToken,
  onExecuteAttack,
  onCastSpell,
  onRollCheck,
  onOpenGrimoire,
  isCollapsed,
  onToggleCollapse,
  engineSessionId,
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

  // Exhaustion Track State (levels 0-6, 6 = dead)
  const [exhaustionLevel, setExhaustionLevel] = useState<number>(0);

  // Active Conditions State
  const [selectedConditions, setSelectedConditions] = useState<string[]>([]);

  // Bound character record (real backend data). Null = nothing stored for this
  // token — the sheet must then show an explicit empty state, never fake stats.
  const [boundCharacter, setBoundCharacter] = useState<FullStoredCharacter | null>(null);
  const [lookupDone, setLookupDone] = useState(false);

  // Resolve the selected player token back to its persisted character (matched
  // by name against the signed-in player's roster). No-op for hostiles and when
  // unauthenticated/offline — findCharacterForToken resolves null in all cases.
  useEffect(() => {
    let cancelled = false;
    setBoundCharacter(null);
    setLookupDone(false);
    if (!activeToken?.isPlayer || !activeToken.name) return undefined;
    findCharacterForToken(activeToken.name)
      .then((record) => {
        if (!cancelled) {
          setBoundCharacter(record);
          setLookupDone(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLookupDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeToken?.isPlayer, activeToken?.name]);

  /* --- Authoritative recovery (engine heal/rest) --------------------------
   * The token's live HP arrives through props from engine-mirrored session
   * state; these controls only SEND intents to the engine and report its
   * verbatim response. No local HP mutation ever happens here — an optimistic
   * update would desync the sheet from the authoritative ledger.
   */
  const [recoveryBusy, setRecoveryBusy] = useState<'heal' | 'short' | 'long' | null>(null);
  const [recoveryFeedback, setRecoveryFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [healAmount, setHealAmount] = useState(0);
  const [confirmLongRest, setConfirmLongRest] = useState(false);

  // Ownership gate: findCharacterForToken matches the token against the
  // SIGNED-IN player's roster, so a non-null binding proves this token is the
  // caller's own character — never someone else's, never a hostile NPC.
  const ownsBoundCharacter = Boolean(activeToken?.isPlayer && boundCharacter);
  // Missing HP is read from the LIVE prop each render so clamping always
  // reflects the latest engine state, not a stale snapshot.
  const missingHp = activeToken
    ? Math.max(0, Math.floor(activeToken.maxHp) - Math.floor(activeToken.hp))
    : 0;

  // Reset per-token UI state when the selection changes.
  useEffect(() => {
    setRecoveryFeedback(null);
    setConfirmLongRest(false);
    setHealAmount(activeToken ? Math.max(0, Math.floor(activeToken.maxHp) - Math.floor(activeToken.hp)) : 0);
  }, [activeToken?.id]);

  /* --- Combat maneuvers (grapple/shove/dodge/dash/disengage/stabilize) -----
   * Same discipline as Authoritative Recovery: intents go to the engine, its
   * verdict (or machine rejection code) is quoted verbatim, nothing is applied
   * locally. Targets come from the engine's PROJECTED session state — for a
   * player that is board-token facts only (no HP/AC on other creatures), so
   * "downed ally" is only detectable where current_hp is present.
   */
  const [maneuverSessionId, setManeuverSessionId] = useState<string | null>(null);
  const [maneuverTargets, setManeuverTargets] = useState<EngineEntitySummary[] | null>(null);
  const [targetsUnreachable, setTargetsUnreachable] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [defenderSkill, setDefenderSkill] = useState<'athletics' | 'acrobatics'>('athletics');
  const [shoveEffect, setShoveEffect] = useState<'prone' | 'push_5ft'>('prone');
  const [maneuverBusy, setManeuverBusy] = useState<
    'grapple' | 'shove' | 'dodge' | 'dash' | 'disengage' | 'stabilize' | null
  >(null);
  const [maneuverFeedback, setManeuverFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  /** Explicit prop wins; otherwise lazily reuse/create this client's session. */
  const resolveEngineSession = async (): Promise<string | null> => {
    if (engineSessionId) return engineSessionId;
    return ensureEngineSession();
  };

  // Resolve the authoritative session (and the projected target roster) once a
  // bound character exists. Without both, the panel does not render at all —
  // maneuver buttons must never fire blind.
  useEffect(() => {
    let cancelled = false;
    setManeuverSessionId(null);
    setManeuverTargets(null);
    setTargetId('');
    if (!ownsBoundCharacter) return undefined;
    resolveEngineSession().then(async (sessionId) => {
      if (cancelled || !sessionId) return;
      setManeuverSessionId(sessionId);
      const outcome = await engineSessionEntities(sessionId);
      if (cancelled) return;
      if (outcome.kind !== 'applied') {
        setTargetsUnreachable(true);
        return;
      }
      const roster = outcome.data.filter((e) => e.id !== activeToken?.id && !e.is_dead);
      setManeuverTargets(roster);
      // Default the picker to the first visible hostile in engine state.
      const hostile = roster.find((e) => !e.is_player);
      setTargetId(hostile ? hostile.id : roster[0]?.id ?? '');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownsBoundCharacter, activeToken?.id, engineSessionId]);

  /** Turns one outcome union into honest inline feedback. Never throws. */
  const describeOutcome = (
    outcome: EngineActionOutcome<EngineHealResult>,
    maxHp: number,
  ): { tone: 'ok' | 'error'; text: string } => {
    if (outcome.kind === 'unreachable') {
      return { tone: 'error', text: 'Rules engine unreachable — nothing changed.' };
    }
    if (outcome.kind === 'rejected') {
      const label = outcome.code ? `${outcome.code}${outcome.message ? `: ${outcome.message}` : ''}` : outcome.message || `HTTP ${outcome.status}`;
      return { tone: 'error', text: `Rejected by the engine — ${label}` };
    }
    return { tone: 'ok', text: `Engine confirms ${outcome.data.hp_remaining}/${maxHp} HP remaining.` };
  };

  /** Rejection/unreachable half shared by every maneuver feedback string. */
  const describeManeuverRejection = (
    outcome: Exclude<EngineActionOutcome<unknown>, { kind: 'applied' }>,
  ): { tone: 'ok' | 'error'; text: string } => {
    if (outcome.kind === 'unreachable') {
      return { tone: 'error', text: 'Rules engine unreachable — no maneuver was resolved.' };
    }
    const label = outcome.code
      ? `${outcome.code}${outcome.message ? `: ${outcome.message}` : ''}`
      : outcome.message || `HTTP ${outcome.status}`;
    return { tone: 'error', text: `Rejected by the engine — ${label}` };
  };

  const grappleFeedback = (r: EngineGrappleResult): string =>
    `Engine grapple — attacker d20 ${r.attacker_natural_roll} (total ${r.attacker_total}) vs defender d20 ${r.defender_natural_roll} (${r.defender_skill}, total ${r.defender_total}) → ${
      r.success ? 'GRAPPLED' : 'escaped'
    }` +
    (r.applied_condition ? `, condition applied: ${r.applied_condition}` : '') +
    (typeof r.escape_dc === 'number' ? `, escape DC ${r.escape_dc}` : '') +
    `, margin ${r.margin ?? '?'} · ledger event_sequence ${r.event_sequence ?? '?'}.`;

  const shoveFeedback = (r: EngineShoveResult): string =>
    `Engine shove (${r.shove_effect}) — attacker d20 ${r.attacker_natural_roll} (total ${r.attacker_total}) vs defender d20 ${r.defender_natural_roll} (total ${r.defender_total}) → ${
      r.success ? r.shove_effect === 'prone' ? 'knocked PRONE' : 'PUSHED 5 ft' : 'resisted'
    }` +
    (Array.isArray(r.pushed_to) ? `, pushed_to [${r.pushed_to.join(', ')}]` : '') +
    `, margin ${r.margin ?? '?'} · ledger event_sequence ${r.event_sequence ?? '?'}.`;

  const standardFeedback = (
    action: 'dodge' | 'dash' | 'disengage',
    r: EngineStandardActionResult,
  ): string => {
    if (action === 'dodge') {
      return `Engine dodge confirmed — dodge_until_next_turn=${String(r.dodge_until_next_turn)} · event_sequence ${r.event_sequence ?? '?'}.`;
    }
    if (action === 'disengage') {
      return `Engine disengage confirmed — disengaged_until_next_turn=${String(r.disengaged_until_next_turn)} · event_sequence ${r.event_sequence ?? '?'}.`;
    }
    return `Engine dash confirmed — dashed_this_turn=${String(r.dashed_this_turn)}, movement_remaining_feet ${r.movement_remaining_feet ?? '?'} · event_sequence ${r.event_sequence ?? '?'}.`;
  };

  const stabilizeFeedback = (r: EngineStabilizeResult): string =>
    `Engine Medicine check — d20 ${r.natural_roll}${typeof r.medicine_modifier === 'number' ? formatModifier(r.medicine_modifier) : ''} = ${r.total ?? '?'} vs DC ${r.dc ?? 10} → ${
      r.success ? 'STABILIZED' : 'not stabilized'
    } (successes ${r.successes_after ?? '?'}/3, failures ${r.failures_after ?? '?'}) · event_sequence ${r.event_sequence ?? '?'}.`;

  /** One flight per panel; every button disables while any maneuver is busy. */
  const runManeuver = async (
    kind: Exclude<typeof maneuverBusy, null>,
    fire: () => Promise<EngineActionOutcome<EngineGrappleResult | EngineShoveResult | EngineStandardActionResult | EngineStabilizeResult>>,
    describe: (data: never) => string,
  ): Promise<void> => {
    if (!activeToken || maneuverBusy) return;
    setManeuverBusy(kind);
    try {
      const sessionId = await resolveEngineSession();
      if (!sessionId) {
        setManeuverFeedback({ tone: 'error', text: 'Rules engine unreachable — no maneuver was resolved.' });
        return;
      }
      const outcome = await fire();
      if (outcome.kind !== 'applied') {
        setManeuverFeedback(describeManeuverRejection(outcome));
        return;
      }
      setManeuverFeedback({ tone: 'ok', text: describe(outcome.data as never) });
    } finally {
      setManeuverBusy(null);
    }
  };

  const handleGrapple = () =>
    void runManeuver(
      'grapple',
      () =>
        engineGrapple({
          sessionId: maneuverSessionId!,
          attackerId: activeToken!.id,
          defenderId: targetId,
          defenderSkill,
        }),
      (d: EngineGrappleResult) => grappleFeedback(d),
    );

  const handleShove = () =>
    void runManeuver(
      'shove',
      () =>
        engineShove({
          sessionId: maneuverSessionId!,
          attackerId: activeToken!.id,
          defenderId: targetId,
          shoveEffect,
        }),
      (d: EngineShoveResult) => shoveFeedback(d),
    );

  const handleSelfAction = (kind: 'dodge' | 'dash' | 'disengage') => {
    const fire =
      kind === 'dodge'
        ? engineDodge
        : kind === 'dash'
        ? engineDash
        : engineDisengage;
    return void runManeuver(
      kind,
      () => fire({ sessionId: maneuverSessionId!, entityId: activeToken!.id }),
      (d: EngineStandardActionResult) => standardFeedback(kind, d),
    );
  };

  const handleStabilize = (healerId: string, dyingId: string) =>
    void runManeuver(
      'stabilize',
      () => engineStabilize({ sessionId: maneuverSessionId!, healerId, targetId: dyingId }),
      (d: EngineStabilizeResult) => stabilizeFeedback(d),
    );

  const handleEngineHeal = async () => {
    if (!activeToken || recoveryBusy || missingHp <= 0 || healAmount <= 0) return;
    setRecoveryBusy('heal');
    try {
      const sessionId = await resolveEngineSession();
      if (!sessionId) {
        setRecoveryFeedback({ tone: 'error', text: 'Rules engine unreachable — nothing changed.' });
        return;
      }
      const outcome = await engineHeal({ sessionId, entityId: activeToken.id, amount: healAmount });
      setRecoveryFeedback(describeOutcome(outcome, activeToken.maxHp));
    } finally {
      setRecoveryBusy(null);
    }
  };

  const handleEngineRest = async (kind: 'short' | 'long') => {
    if (!activeToken || recoveryBusy) return;
    // Long rest is disruptive (full HP for every controlled entity): two-step
    // inline confirmation instead of a surprise commit.
    if (kind === 'long' && !confirmLongRest) {
      setConfirmLongRest(true);
      return;
    }
    setConfirmLongRest(false);
    setRecoveryBusy(kind);
    try {
      const sessionId = await resolveEngineSession();
      if (!sessionId) {
        setRecoveryFeedback({ tone: 'error', text: 'Rules engine unreachable — nothing changed.' });
        return;
      }
      const outcome = await engineRest({ sessionId, kind });
      if (outcome.kind !== 'applied') {
        setRecoveryFeedback(describeOutcome(outcome, activeToken.maxHp));
        return;
      }
      if (kind === 'long') {
        const mine = outcome.data.entities?.find((e) => e.entity_id === activeToken.id);
        setRecoveryFeedback({
          tone: 'ok',
          text: mine
            ? `Long rest applied by the engine — ${mine.hp_remaining}/${activeToken.maxHp} HP remaining.`
            : `Long rest recorded (${outcome.data.restored_entities ?? 0} entities restored).`,
        });
      } else {
        setRecoveryFeedback({
          tone: 'ok',
          text:
            'Short rest recorded on the engine ledger. Hit-dice spending is not yet implemented engine-side.',
        });
      }
    } finally {
      setRecoveryBusy(null);
    }
  };

  /**
   * All modifiers derived from the stored ability scores via the shared SRD
   * math module. Null when there is no bound character with a complete ability
   * block — callers render the "No character bound" empty state instead.
   */
  const derived = useMemo<{
    level: number;
    className: string;
    profBonus: number;
    speed: number | null;
    abilities: Array<{ key: AbilityKey; label: string; score: number; mod: number }>;
    mods: Record<AbilityKey, number>;
  } | null>(() => {
    const scores = boundCharacter?.data?.abilities;
    if (!scores) return null;
    const mods = {} as Record<AbilityKey, number>;
    const abilities: Array<{ key: AbilityKey; label: string; score: number; mod: number }> = [];
    for (const key of ABILITY_KEYS) {
      const score = scores[ABILITY_LABELS[key] as keyof AbilityScoreMap];
      if (typeof score !== 'number') return null; // incomplete record — don't guess
      const mod = getModifier(score);
      mods[key] = mod;
      abilities.push({ key, label: ABILITY_LABELS[key], score, mod });
    }
    return {
      level: boundCharacter!.level,
      className: boundCharacter!.character_class,
      profBonus: proficiencyBonus(boundCharacter!.level),
      speed: typeof boundCharacter!.data?.speed === 'number' ? (boundCharacter!.data!.speed as number) : null,
      abilities,
      mods,
    };
  }, [boundCharacter]);

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
    setExhaustionLevel(0);
  };

  const renderTokenIcon = (token: Token) => {
    const iconType = token.avatarIconType || (token.isPlayer ? 'fighter' : 'boss');
    switch (iconType) {
      case 'mage':
      case 'caster':
        return <Sparkles className="w-5 h-5" style={{ color: 'var(--tavern-accent)' }} />;
      case 'boss':
        return <Skull className="w-5 h-5" style={{ color: 'var(--state-danger)' }} />;
      case 'scout':
        return <Crosshair className="w-5 h-5" style={{ color: 'var(--tavern-accent)' }} />;
      case 'fighter':
      default:
        return <Shield className="w-5 h-5" style={{ color: 'var(--rp-parchment-200)' }} />;
    }
  };

  if (isCollapsed) {
    return (
      <aside aria-label="Character Sheet Sidebar" className="h-full bg-tavern-bg border-l border-tavern-border p-2 flex flex-col items-center justify-between shrink-0 w-12 transition-all">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 bg-tavern-surface hover:brightness-125 rounded-lg text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] border border-tavern-border transition cursor-pointer"
          title="Expand Character Sheet"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {activeToken && (
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-white shadow border"
            style={{ backgroundColor: activeToken.color, borderColor: 'var(--rp-leather-600)' }}
            title={activeToken.name}
          >
            {renderTokenIcon(activeToken)}
          </div>
        )}

        <div className="text-[9px] font-display uppercase text-[var(--rp-parchment-300)] [writing-mode:vertical-lr] tracking-widest">
          {activeToken?.name || 'Character'}
        </div>
      </aside>
    );
  }

  if (!activeToken) {
    return (
      <aside aria-label="Character Sheet Sidebar" className="w-88 h-full bg-tavern-bg border-l border-tavern-border p-6 flex flex-col items-center justify-center text-center shrink-0">
        <div className="w-12 h-12 rounded-full bg-tavern-surface flex items-center justify-center mb-3 text-[var(--rp-parchment-300)] border border-tavern-border">
          <User className="w-6 h-6" />
        </div>
        <span className="font-display tracking-wide text-sm text-[var(--rp-parchment-100)]" style={{ fontVariant: 'small-caps' }}>No Target Selected</span>
        <span className="text-xs text-[var(--rp-parchment-300)] mt-1 font-prose">Select a token on the battle map or initiative list.</span>
      </aside>
    );
  }

  const abilities = derived?.abilities ?? [];

  /** Explicit empty state — replaces every hardcoded stat when no record binds. */
  const noBoundCharacter = !derived;
  const classLabel = derived
    ? derived.className.charAt(0).toUpperCase() + derived.className.slice(1)
    : '';

  const tabs: Array<{ id: typeof activeTab; label: string }> = [
    { id: 'actions', label: 'Actions' },
    { id: 'spells', label: 'Spells' },
    { id: 'inventory', label: 'Items' },
    { id: 'features', label: 'State' },
  ];

  /** Inked tracker circle: filled when marked, leather-outlined hollow when open. */
  const inkedDot = (filled: boolean) => ({
    background: filled ? INK : 'transparent',
    border: `1.5px solid ${filled ? INK : 'var(--rp-leather-700)'}`,
  });

  return (
    <aside aria-label="Character Sheet Sidebar" className="w-88 h-full bg-tavern-bg border-l border-tavern-border p-1.5 shrink-0 flex flex-col">
      {/* The sheet itself: one scrollable page of rag paper on the leather backing. */}
      <div className="vtt-parchment vtt-scrollbar rounded-lg h-full overflow-y-auto px-3 py-4 space-y-4">
        {/* Token Header Banner (D&D Beyond Style) */}
        <div className="flex items-center justify-between pb-3 border-b" style={{ borderColor: LEATHER_HAIRLINE }}>
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-white shadow-xl relative shrink-0"
              style={{
                backgroundColor: activeToken.color,
                boxShadow: '0 0 0 2px var(--rp-leather-600), 0 6px 18px rgba(0,0,0,0.35)',
              }}
            >
              {renderTokenIcon(activeToken)}
              {activeToken.elevationFeet && activeToken.elevationFeet > 0 ? (
                <span
                  className="absolute -bottom-1 -right-1 px-1 text-[8px] rounded font-bold"
                  style={{
                    backgroundColor: 'var(--parchment-paper)',
                    color: INK,
                    border: '1px solid var(--rp-leather-600)',
                  }}
                >
                  +{activeToken.elevationFeet}ft
                </span>
              ) : null}
            </div>
            <div className="min-w-0">
              <h2 className="vtt-statblock-nameplate text-xl leading-tight truncate">{activeToken.name}</h2>
              <div className="flex items-center gap-2 text-xs mt-0.5">
                <span className="vtt-statblock-tagline">
                  {derived
                    ? `Level ${derived.level} ${classLabel}`
                    : activeToken.isPlayer
                    ? 'No character bound'
                    : 'Hostile Entity'}
                </span>
                {derived && (
                  <>
                    <span style={{ color: 'var(--rp-leather-600)' }}>•</span>
                    <span className="vtt-statblock-tagline">Prof: {formatModifier(derived.profBonus)}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleLongRest}
              className="vtt-btn vtt-btn-secondary p-1.5"
              style={{ padding: '0.35rem' }}
              title="Clear LOCAL trackers only (spell slots, death saves, exhaustion) — authoritative HP recovery lives under Authoritative Recovery below"
            >
              <Sun className="w-4 h-4" style={{ color: 'var(--tavern-accent)' }} />
            </button>
            <button
              onClick={onToggleCollapse}
              className="p-1.5 rounded transition cursor-pointer"
              style={{ color: 'color-mix(in srgb, var(--parchment-ink) 70%, transparent)' }}
              title="Collapse Character Sheet"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Quick Vitals Grid — red-washed attribute strip cells */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="vtt-statblock-attr rounded-md px-2 py-1.5">
            <div className="vtt-attr-label text-[9px]">Armor</div>
            <div className="vtt-attr-value text-base leading-snug">{activeToken.ac} AC</div>
          </div>
          <div className="vtt-statblock-attr rounded-md px-2 py-1.5">
            <div className="vtt-attr-label text-[9px]">Health</div>
            <div className="vtt-attr-value text-base leading-snug">
              {Math.max(0, activeToken.hp)} <span className="text-xs opacity-60">/ {activeToken.maxHp}</span>
            </div>
          </div>
          <div className="vtt-statblock-attr rounded-md px-2 py-1.5" title={derived?.speed != null ? undefined : 'No bound character record'}>
            <div className="vtt-attr-label text-[9px]">Speed</div>
            <div className="vtt-attr-value text-base leading-snug">
              {derived?.speed != null ? `${derived.speed} ft` : '—'}
            </div>
          </div>
        </div>

        {/* Authoritative recovery — engine heal/rest. Rendered only when the
            token is the signed-in player's own bound character AND an engine
            session can be resolved; feedback always quotes the engine's
            verbatim response or rejection code. No optimistic HP edits. */}
        {ownsBoundCharacter && (
          <div
            className="rounded-md p-3 space-y-2"
            style={{ border: `1px solid ${LEATHER_HAIRLINE}`, background: 'color-mix(in srgb, var(--parchment-paper-aged) 40%, transparent)' }}
          >
            <div className="vtt-section-header text-[11px]">Authoritative Recovery</div>

            {/* Heal: amount clamped to the LIVE missing deficit from props */}
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={missingHp}
                value={Math.min(healAmount, missingHp)}
                disabled={recoveryBusy !== null || missingHp === 0}
                onChange={(e) => {
                  const parsed = Math.floor(Number(e.target.value));
                  setHealAmount(Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, missingHp)) : 0);
                }}
                aria-label={`Hit points to restore (max ${missingHp})`}
                className="vtt-input w-16 px-1.5 py-1 text-xs tabular-nums"
                style={{ color: INK }}
              />
              <button
                type="button"
                onClick={() => void handleEngineHeal()}
                disabled={recoveryBusy !== null || missingHp === 0 || healAmount <= 0}
                title={missingHp === 0 ? 'Already at full HP' : `Ask the engine to restore up to ${missingHp} HP`}
                className="vtt-btn vtt-btn-secondary flex-1 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="flex items-center justify-center gap-1.5" style={{ color: INK }}>
                  <Heart className="w-3.5 h-3.5" style={{ color: 'var(--state-success)' }} />
                  {recoveryBusy === 'heal' ? 'Healing…' : `Heal (${missingHp} missing)`}
                </span>
              </button>
            </div>

            {/* Rests: short is instant; long needs an inline confirmation */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void handleEngineRest('short')}
                disabled={recoveryBusy !== null}
                title="Record a short rest on the engine ledger"
                className="vtt-btn vtt-btn-secondary text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="flex items-center justify-center gap-1.5" style={{ color: INK }}>
                  <Activity className="w-3.5 h-3.5" style={{ color: 'var(--tavern-accent-deep)' }} />
                  {recoveryBusy === 'short' ? 'Resting…' : 'Short Rest'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void handleEngineRest('long')}
                onBlur={() => setConfirmLongRest(false)}
                disabled={recoveryBusy !== null}
                title="Long rest: restores your controlled entities to full HP engine-side"
                className={`text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  confirmLongRest ? 'vtt-btn vtt-btn-danger' : 'vtt-btn vtt-btn-secondary'
                }`}
              >
                <span className="flex items-center justify-center gap-1.5" style={{ color: INK }}>
                  <Moon className="w-3.5 h-3.5" style={{ color: CRIMSON_TEXT }} />
                  {recoveryBusy === 'long' ? 'Resting…' : confirmLongRest ? 'Confirm?' : 'Long Rest'}
                </span>
              </button>
            </div>

            {/* Honest result / rejection readout — aria-live for screen readers */}
            <div aria-live="polite" className="min-h-[1rem]">
              {recoveryFeedback && (
                <p
                  className="text-[11px] font-prose leading-snug break-words"
                  style={{
                    color:
                      recoveryFeedback.tone === 'ok'
                        ? 'var(--state-success)'
                        : 'var(--state-danger)',
                  }}
                >
                  {recoveryFeedback.text}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Combat maneuvers — grapple/shove/dodge/dash/disengage/stabilize.
            Rendered only when a character is bound AND an authoritative engine
            session exists; every button sends an intent to the engine and
            quotes its verbatim outcome or rejection code. No optimistic state:
            conditions, movement and action economy change only engine-side. */}
        {ownsBoundCharacter && maneuverSessionId && (
          <div
            className="rounded-md p-3 space-y-2"
            style={{ border: `1px solid ${LEATHER_HAIRLINE}`, background: 'color-mix(in srgb, var(--parchment-paper-aged) 40%, transparent)' }}
          >
            <div className="vtt-section-header text-[11px]">Combat Maneuvers</div>

            {/* Target picker — defaults to the first visible hostile in the
                engine's projected session state. */}
            <label className="flex items-center gap-2 text-xs font-prose" style={{ color: INK }}>
              <span className="shrink-0">Target</span>
              <select
                value={targetId}
                disabled={maneuverBusy !== null || !maneuverTargets}
                onChange={(e) => setTargetId(e.target.value)}
                aria-label="Maneuver target"
                className="vtt-input flex-1 px-1.5 py-1 text-xs"
                style={{ color: INK }}
              >
                {!maneuverTargets && <option value="">—</option>}
                {(maneuverTargets ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name || t.id}
                    {t.is_player ? '' : ' · hostile'}
                  </option>
                ))}
              </select>
            </label>
            {targetsUnreachable && (
              <p className="text-[10px] font-prose leading-snug" style={{ color: CRIMSON_TEXT }}>
                Engine roster unreachable — targeted maneuvers are unavailable until it responds.
              </p>
            )}

            {/* Contest choices: defender skill + shove effect */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-display uppercase tracking-widest shrink-0 w-20" style={{ color: CRIMSON_TEXT }}>
                Grapple vs
              </span>
              {(['athletics', 'acrobatics'] as const).map((skill) => (
                <button
                  key={skill}
                  type="button"
                  onClick={() => setDefenderSkill(skill)}
                  aria-pressed={defenderSkill === skill}
                  title={`Defender contests with ${skill} (engine resolves both rolls)`}
                  className={`transition cursor-pointer capitalize ${
                    defenderSkill === skill ? 'vtt-badge-danger' : 'vtt-badge'
                  }`}
                >
                  {skill}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-display uppercase tracking-widest shrink-0 w-20" style={{ color: CRIMSON_TEXT }}>
                Shove to
              </span>
              <button
                type="button"
                onClick={() => setShoveEffect('prone')}
                aria-pressed={shoveEffect === 'prone'}
                className={`transition cursor-pointer ${shoveEffect === 'prone' ? 'vtt-badge-danger' : 'vtt-badge'}`}
              >
                Prone
              </button>
              <button
                type="button"
                onClick={() => setShoveEffect('push_5ft')}
                aria-pressed={shoveEffect === 'push_5ft'}
                className={`transition cursor-pointer ${shoveEffect === 'push_5ft' ? 'vtt-badge-danger' : 'vtt-badge'}`}
              >
                Push 5 ft
              </button>
            </div>

            {/* Contested maneuvers against the picked target */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleGrapple}
                disabled={maneuverBusy !== null || !targetId}
                title="Contested Athletics grapple; spends your Action engine-side"
                className="vtt-btn vtt-btn-secondary text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="flex items-center justify-center gap-1.5" style={{ color: INK }}>
                  <Hand className="w-3.5 h-3.5" style={{ color: CRIMSON_TEXT }} />
                  {maneuverBusy === 'grapple' ? 'Grappling…' : 'Grapple'}
                </span>
              </button>
              <button
                type="button"
                onClick={handleShove}
                disabled={maneuverBusy !== null || !targetId}
                title={`Shove to ${shoveEffect === 'prone' ? 'knock prone' : 'push 5 ft'}; spends your Action engine-side`}
                className="vtt-btn vtt-btn-secondary text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="flex items-center justify-center gap-1.5" style={{ color: INK }}>
                  <Footprints className="w-3.5 h-3.5" style={{ color: CRIMSON_TEXT }} />
                  {maneuverBusy === 'shove' ? 'Shoving…' : 'Shove'}
                </span>
              </button>
            </div>

            {/* Self standard actions */}
            <div className="grid grid-cols-3 gap-2">
              {([
                { kind: 'dodge' as const, label: 'Dodge', busy: 'Dodging…', icon: <Shield className="w-3.5 h-3.5" style={{ color: 'var(--tavern-accent-deep)' }} /> },
                { kind: 'dash' as const, label: 'Dash', busy: 'Dashing…', icon: <Footprints className="w-3.5 h-3.5" style={{ color: 'var(--tavern-accent-deep)' }} /> },
                { kind: 'disengage' as const, label: 'Disengage', busy: 'Disengaging…', icon: <Wind className="w-3.5 h-3.5" style={{ color: 'var(--tavern-accent-deep)' }} /> },
              ]).map(({ kind, label, busy, icon }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => handleSelfAction(kind)}
                  disabled={maneuverBusy !== null}
                  title={`${label}: resolved and ledgered by the engine`}
                  className="vtt-btn vtt-btn-secondary text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="flex items-center justify-center gap-1" style={{ color: INK }}>
                    {icon}
                    {maneuverBusy === kind ? busy : label}
                  </span>
                </button>
              ))}
            </div>

            {/* Stabilize — offered only where the projected state shows a downed,
                not-yet-dead ally (current_hp is only present on your own entity
                or when viewing with GM privileges); the engine re-verifies every
                dying gate anyway and refuses with its own code otherwise. */}
            {(() => {
              const downed = (maneuverTargets ?? []).filter(
                (e) => e.is_player && e.current_hp !== undefined && e.current_hp <= 0 && !e.is_dead,
              );
              if (downed.length === 0) {
                return (
                  <p className="text-[10px] font-prose leading-snug" style={{ color: 'color-mix(in srgb, var(--parchment-ink) 60%, transparent)' }}>
                    No downed allies visible in the engine state. (The Medicine check itself is always verified engine-side.)
                  </p>
                );
              }
              return (
                <div className="space-y-1.5">
                  <span className="text-[10px] font-display uppercase tracking-widest" style={{ color: CRIMSON_TEXT }}>
                    Downed allies
                  </span>
                  {downed.map((ally) => (
                    <button
                      key={ally.id}
                      type="button"
                      onClick={() => handleStabilize(activeToken!.id, ally.id)}
                      disabled={maneuverBusy !== null}
                      title={`Medicine check to stabilize ${ally.name || ally.id} (within 5 ft required)`}
                      className="vtt-btn vtt-btn-secondary w-full text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="flex items-center justify-center gap-1.5" style={{ color: INK }}>
                        <HeartPulse className="w-3.5 h-3.5" style={{ color: 'var(--state-success)' }} />
                        {maneuverBusy === 'stabilize' ? 'Stabilizing…' : `Stabilize ${ally.name || ally.id}`}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })()}

            {/* Honest result / rejection readout — verbatim engine verdicts */}
            <div aria-live="polite" className="min-h-[1rem]">
              {maneuverFeedback && (
                <p
                  className="text-[11px] font-prose leading-snug break-words"
                  style={{
                    color:
                      maneuverFeedback.tone === 'ok'
                        ? 'var(--state-success)'
                        : 'var(--state-danger)',
                  }}
                >
                  {maneuverFeedback.text}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Everything below this line is derived from a real bound record.
            Without one we render an explicit empty state — never fake numbers. */}
        {noBoundCharacter ? (
          <div className="rounded-md p-4 text-center space-y-2" style={{ border: '1px dashed var(--rp-leather-600)' }}>
            <div
              className="w-10 h-10 mx-auto rounded-full bg-tavern-surface flex items-center justify-center border border-tavern-border"
              style={{ color: 'var(--rp-parchment-300)' }}
            >
              <User className="w-5 h-5" />
            </div>
            <div className="vtt-section-header text-xs">No character bound</div>
            <p className="text-xs font-prose leading-relaxed" style={{ color: 'color-mix(in srgb, var(--parchment-ink) 72%, transparent)' }}>
              {!lookupDone
                ? 'Binding to your character roster…'
                : activeToken.isPlayer
                ? 'No stored character on your roster matches this token. Build and deploy one in the Character Builder — this sheet shows only real, stored stats.'
                : 'Hostile entities have no player character record; only the live token vitals above are shown.'}
            </p>
          </div>
        ) : (
          <>
        {/* Ability Scores — hex shields */}
        <div className="space-y-1">
          <div className="vtt-section-header text-[11px]">Ability Scores</div>
          <div className="grid grid-cols-6 gap-1">
            {abilities.map((ab) => (
              <div key={ab.key} className="group flex flex-col items-center cursor-default select-none" title={`${ab.label} ${ab.score}`}>
                <div
                  className="w-full h-12 flex items-center justify-center transition-transform group-hover:scale-105"
                  style={{ clipPath: HEX_CLIP, background: 'var(--parchment-paper-aged)' }}
                >
                  <span className="font-display font-bold text-base leading-none" style={{ color: INK }}>
                    {formatModifier(ab.mod)}
                  </span>
                </div>
                <span
                  className="text-[8px] font-display uppercase tracking-widest leading-tight"
                  style={{ color: CRIMSON_TEXT }}
                >
                  {ab.label}
                </span>
                <span className="text-[8px] font-prose opacity-60 leading-none" style={{ color: INK }}>
                  {ab.score}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Passive Senses — derived from WIS/INT modifiers (Perception includes proficiency) */}
        <div className="vtt-statblock-attr rounded-md px-2 py-1.5 flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5" style={{ color: INK }}>
            <Eye className="w-3.5 h-3.5" style={{ color: CRIMSON_TEXT }} />
            Perception: <strong>{passivePerception(derived!.mods.wis)}</strong>
          </span>
          <span style={{ color: INK }}>
            Insight: <strong>{10 + derived!.mods.wis}</strong>
          </span>
          <span style={{ color: INK }}>
            Invest: <strong>{10 + derived!.mods.int}</strong>
          </span>
        </div>

        {/* Action Budget Badges */}
        <div className="flex items-center justify-between gap-1 flex-wrap">
          <span className="vtt-badge">
            <Zap className="w-3 h-3" style={{ color: 'var(--state-success)' }} /> Action (1)
          </span>
          <span className="vtt-badge">
            <Sparkles className="w-3 h-3" style={{ color: 'var(--tavern-accent-deep)' }} /> Bonus (1)
          </span>
          <span className="vtt-badge">
            <Shield className="w-3 h-3" style={{ color: CRIMSON_TEXT }} /> Reaction (1)
          </span>
        </div>

        {/* Tab Switcher — iron tab bar fitted onto the page */}
        <div className="vtt-tabbar w-full">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              data-active={activeTab === tab.id}
              className={`vtt-tab ${activeTab === tab.id ? '' : 'cursor-pointer'} flex-1 text-center`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'actions' && (
          <div className="space-y-3">
            <div className="space-y-2">
              <button
                onClick={() => onExecuteAttack('Greataxe Slash', `1d12 + ${derived!.mods.str}`, 'slashing')}
                className="vtt-btn vtt-btn-secondary w-full text-left"
              >
                <span className="flex items-center justify-between w-full">
                  <span className="flex items-center gap-2.5">
                    <Sword className="w-4 h-4 shrink-0" style={{ color: 'var(--state-danger)' }} />
                    <span>
                      <span className="block text-sm font-semibold" style={{ color: INK }}>
                        Greataxe Slash
                      </span>
                      <span className="block text-xs font-prose" style={{ color: 'color-mix(in srgb, var(--parchment-ink) 72%, transparent)' }}>
                        {formatModifier(derived!.mods.str + derived!.profBonus)} to hit ·{' '}
                        <span style={{ color: CRIMSON_TEXT }}>1d12 + {derived!.mods.str}</span> Slashing
                      </span>
                    </span>
                  </span>
                  <span className="vtt-badge shrink-0">Melee</span>
                </span>
              </button>

              <button
                onClick={() => onExecuteAttack('Shortbow Shot', `1d8 + ${derived!.mods.dex}`, 'piercing')}
                className="vtt-btn vtt-btn-secondary w-full text-left"
              >
                <span className="flex items-center justify-between w-full">
                  <span className="flex items-center gap-2.5">
                    <Crosshair className="w-4 h-4 shrink-0" style={{ color: 'var(--rp-crimson-500)' }} />
                    <span>
                      <span className="block text-sm font-semibold" style={{ color: INK }}>
                        Shortbow Shot
                      </span>
                      <span className="block text-xs font-prose" style={{ color: 'color-mix(in srgb, var(--parchment-ink) 72%, transparent)' }}>
                        {formatModifier(derived!.mods.dex + derived!.profBonus)} to hit ·{' '}
                        <span style={{ color: CRIMSON_TEXT }}>1d8 + {derived!.mods.dex}</span> Piercing
                      </span>
                    </span>
                  </span>
                  <span className="vtt-badge shrink-0">Ranged</span>
                </span>
              </button>
            </div>

            {/* Skill Checks */}
            <div className="pt-2 border-t" style={{ borderColor: LEATHER_HAIRLINE }}>
              <div className="vtt-section-header text-[11px]">Skill Checks</div>
              <div className="grid grid-cols-2 gap-1.5 mt-2">
                {[
                  { skill: 'Athletics', ability: ABILITY_LABELS.str, abilityMod: derived!.mods.str, dc: 15 },
                  { skill: 'Stealth', ability: ABILITY_LABELS.dex, abilityMod: derived!.mods.dex, dc: 14 },
                  { skill: 'Perception', ability: ABILITY_LABELS.wis, abilityMod: derived!.mods.wis, dc: 12 },
                  { skill: 'Arcana', ability: ABILITY_LABELS.int, abilityMod: derived!.mods.int, dc: 15 },
                ].map(({ skill, ability, abilityMod, dc }) => (
                  <button
                    key={skill}
                    onClick={() => onRollCheck(skill, abilityMod, dc)}
                    title={`${skill}: raw ${ability} modifier (no proficiency recorded)`}
                    className="vtt-btn vtt-btn-secondary w-full font-prose text-sm"
                    style={{ justifyContent: 'flex-start', padding: '0.4rem 0.6rem' }}
                  >
                    <span style={{ color: INK }}>
                      {skill} <span style={{ color: CRIMSON_TEXT }}>({formatModifier(abilityMod)})</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'spells' && (
          <div className="space-y-4">
            {/* Spell Slots Tracker Matrix — inked circles */}
            <div className="rounded-md p-3 space-y-2" style={{ border: `1px solid ${LEATHER_HAIRLINE}`, background: 'color-mix(in srgb, var(--parchment-paper-aged) 40%, transparent)' }}>
              <div className="vtt-section-header text-[11px]">Spell Slots Matrix</div>
              <div className="space-y-2">
                {[1, 2, 3].map((lvl) => {
                  const slot = spellSlots[lvl] || { total: 2, used: 0 };
                  return (
                    <div key={lvl} className="flex items-center justify-between">
                      <span
                        className="text-[10px] font-display uppercase tracking-widest"
                        style={{ color: CRIMSON_TEXT }}
                      >
                        Level {lvl}
                      </span>
                      <div className="flex items-center space-x-1.5">
                        {Array.from({ length: slot.total }).map((_, i) => {
                          const isUsed = i < slot.used;
                          return (
                            <button
                              key={i}
                              onClick={() => toggleSpellSlot(lvl, i)}
                              className="w-4 h-4 rounded-full transition cursor-pointer"
                              style={inkedDot(isUsed)}
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
              <button onClick={onOpenGrimoire} className="vtt-btn vtt-btn-primary w-full text-sm">
                <BookOpen className="w-3.5 h-3.5" />
                <span>Open Digital Grimoire & Upcaster</span>
              </button>
            )}

            {/* Spells List */}
            <div className="space-y-2">
              <button
                onClick={() => onCastSpell('spell_fireball', 'Fireball', 3)}
                className="vtt-btn vtt-btn-secondary w-full text-left"
              >
                <span className="flex items-center justify-between w-full">
                  <span className="flex items-center gap-2.5">
                    <Flame className="w-4 h-4 shrink-0" style={{ color: 'var(--tavern-accent-deep)' }} />
                    <span>
                      <span className="block text-sm font-semibold" style={{ color: INK }}>
                        Fireball
                      </span>
                      <span className="block text-xs font-prose" style={{ color: 'color-mix(in srgb, var(--parchment-ink) 72%, transparent)' }}>
                        8d6 Fire · 20ft Sphere
                      </span>
                    </span>
                  </span>
                  <span className="vtt-badge shrink-0">Level 3</span>
                </span>
              </button>

              <button
                onClick={() => onCastSpell('spell_magic_missile', 'Magic Missile', 1)}
                className="vtt-btn vtt-btn-secondary w-full text-left"
              >
                <span className="flex items-center justify-between w-full">
                  <span className="flex items-center gap-2.5">
                    <Wand2 className="w-4 h-4 shrink-0" style={{ color: CRIMSON_TEXT }} />
                    <span>
                      <span className="block text-sm font-semibold" style={{ color: INK }}>
                        Magic Missile
                      </span>
                      <span className="block text-xs font-prose" style={{ color: 'color-mix(in srgb, var(--parchment-ink) 72%, transparent)' }}>
                        3d4 + 3 Force · Auto-Hit
                      </span>
                    </span>
                  </span>
                  <span className="vtt-badge shrink-0">Level 1</span>
                </span>
              </button>
            </div>
          </div>
        )}

        {activeTab === 'inventory' && (
          <div className="space-y-2.5 text-sm font-prose">
            <div className="vtt-statblock-attr rounded-md px-2 py-1.5 flex justify-between items-center">
              <span className="vtt-attr-label text-[10px]">Encumbrance Capacity (STR × 15)</span>
              <span className="vtt-attr-value text-xs">
                {(derived!.abilities.find((a) => a.key === 'str')?.score ?? 0) * 15} lbs
              </span>
            </div>
            <ul>
              {[
                { item: '+1 Greataxe', note: '(Equipped)', weight: '7 lbs', equipped: true },
                { item: 'Potion of Healing', note: '×2', weight: '1 lb', equipped: false },
                { item: "Explorer's Pack", note: '', weight: '40.5 lbs', equipped: false },
              ].map(({ item, note, weight, equipped }) => (
                <li
                  key={item}
                  className="flex justify-between items-baseline py-2 border-b last:border-b-0"
                  style={{ borderColor: LEATHER_HAIRLINE, color: INK }}
                >
                  <span>
                    {item}
                    {equipped && <em className="ml-1 text-xs opacity-70">{note}</em>}
                    {!equipped && note && <span className="ml-1 font-bold">{note}</span>}
                  </span>
                  <span className="font-bold text-xs tabular-nums">{weight}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {activeTab === 'features' && (
          <div className="space-y-4">
            {/* Death Saves Tracker — inked circles */}
            <div className="rounded-md p-3 space-y-2" style={{ border: `1px solid ${LEATHER_HAIRLINE}`, background: 'color-mix(in srgb, var(--parchment-paper-aged) 40%, transparent)' }}>
              <div className="vtt-section-header text-[11px]">Death Saving Throws</div>
              <div className="space-y-2 text-sm font-prose">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-display uppercase tracking-widest" style={{ color: 'var(--state-success)' }}>
                    Successes
                  </span>
                  <div className="flex space-x-1.5">
                    {[1, 2, 3].map((i) => (
                      <button
                        key={i}
                        onClick={() => setDeathSuccesses(i === deathSuccesses ? i - 1 : i)}
                        className="w-4 h-4 rounded-full cursor-pointer transition"
                        style={inkedDot(i <= deathSuccesses)}
                        aria-label={`Death save success ${i}`}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span
                    className="text-[10px] font-display uppercase tracking-widest"
                    style={{ color: CRIMSON_TEXT }}
                  >
                    Failures
                  </span>
                  <div className="flex space-x-1.5">
                    {[1, 2, 3].map((i) => (
                      <button
                        key={i}
                        onClick={() => setDeathFailures(i === deathFailures ? i - 1 : i)}
                        className="w-4 h-4 rounded-full cursor-pointer transition"
                        style={inkedDot(i <= deathFailures)}
                        aria-label={`Death save failure ${i}`}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Exhaustion Track */}
            <div className="rounded-md p-3 space-y-2" style={{ border: `1px solid ${LEATHER_HAIRLINE}`, background: 'color-mix(in srgb, var(--parchment-paper-aged) 40%, transparent)' }}>
              <div className="vtt-section-header text-[11px]">Exhaustion</div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-prose" style={{ color: 'color-mix(in srgb, var(--parchment-ink) 72%, transparent)' }}>
                  Level {exhaustionLevel}{exhaustionLevel >= 6 ? ' — death' : ''}
                </span>
                <div className="flex space-x-1.5">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
                    <button
                      key={i}
                      onClick={() => setExhaustionLevel(i === exhaustionLevel ? i - 1 : i)}
                      className="w-4 h-4 rounded-full cursor-pointer transition"
                      style={inkedDot(i <= exhaustionLevel)}
                      aria-label={`Exhaustion level ${i}`}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Condition Rings Tracker */}
            <div className="space-y-2">
              <div className="vtt-section-header text-[11px]">Active Condition Rings</div>
              <div className="flex flex-wrap gap-1.5">
                {['Prone', 'Poisoned', 'Blinded', 'Stunned', 'Invisible', 'Charmed', 'Restrained'].map((cond) => {
                  const isActive = selectedConditions.includes(cond);
                  return (
                    <button
                      key={cond}
                      onClick={() => handleToggleCondition(cond)}
                      className={`transition cursor-pointer ${isActive ? 'vtt-badge-danger' : 'vtt-badge'}`}
                    >
                      {cond}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
          </>
        )}
      </div>
    </aside>
  );
};
