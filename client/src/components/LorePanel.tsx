import React, { useState, useEffect } from 'react';
import { BookOpen, ScrollText, Users, SendHorizonal, ShieldAlert, CheckCircle2, AlertTriangle, PlugZap, Crown } from 'lucide-react';
import {
  assertLore,
  listPersonas,
  type AssertLoreResult,
  type EpistemicTier,
  type NpcPersona,
} from '../api/lore_store';
import { getStoredToken } from '../api/auth_headers';

const TIERS: EpistemicTier[] = ['SUBJECTIVE_RUMOR', 'PROPOSED_FACT', 'VALIDATED_CANON'];

/**
 * Canon assertion surface for the epistemic graph. Everything shown comes from
 * the real endpoints: GET /api/v1/npc/ (public) and POST /api/v1/lore/assert
 * (token-required). Paradox rejections are displayed verbatim — the graph's
 * reason is world state, not an error to hide.
 *
 * Server-enforced tier policy (iteration 5): every assertion ENTERS at
 * SUBJECTIVE_RUMOR; only GM tokens may promote, and only one step per call.
 * The dropdown therefore defaults to SUBJECTIVE_RUMOR so a player submission
 * is honest on the first try; higher tiers still exist in the picker for
 * GMs to drive their own staged canon flow.
 */
export const LorePanel: React.FC = () => {
  const [personas, setPersonas] = useState<NpcPersona[] | null>(null);
  const [subject, setSubject] = useState('');
  const [predicate, setPredicate] = useState('');
  const [object, setObject] = useState('');
  const [tier, setTier] = useState<EpistemicTier>('SUBJECTIVE_RUMOR');
  const [result, setResult] = useState<AssertLoreResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Token presence is read per render of a submission attempt, not cached at
  // mount — signing in via AuthModal must not require a remount to unlock.
  const hasToken = Boolean(getStoredToken());

  useEffect(() => {
    let cancelled = false;
    listPersonas().then((npcs) => {
      if (!cancelled) setPersonas(npcs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResult(null);
    setSubmitting(true);
    const r = await assertLore(subject.trim(), predicate.trim(), object.trim(), undefined, { tier });
    setSubmitting(false);
    setResult(r);
  };

  return (
    <div className="vtt-glass-panel rounded-2xl p-5 space-y-4 shadow-lg">
      <h3 className="vtt-section-header text-xs">
        <BookOpen className="w-4 h-4 shrink-0" />
        <span>Canon Lore Assertions</span>
      </h3>

      {!hasToken && (
        <div className="text-[11px] font-prose p-2.5 rounded-lg border border-[color-mix(in_srgb,var(--state-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-warning)_10%,transparent)] flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--state-warning)]" />
          <span>
            Not signed in. Viewing personas works anonymously, but submitting lore requires an
            authenticated session — the graph rejects unauthenticated writes server-side.
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-2.5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="subject (e.g. house_vane)"
            disabled={!hasToken || submitting}
            className="vtt-input text-xs"
          />
          <input
            value={predicate}
            onChange={(e) => setPredicate(e.target.value)}
            placeholder="predicate (e.g. sworn_enemy_of)"
            disabled={!hasToken || submitting}
            className="vtt-input text-xs"
          />
          <input
            value={object}
            onChange={(e) => setObject(e.target.value)}
            placeholder="object (e.g. house_silverpeak)"
            disabled={!hasToken || submitting}
            className="vtt-input text-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value as EpistemicTier)}
            disabled={!hasToken || submitting}
            className="vtt-input text-xs max-w-[220px]"
            aria-label="Epistemic tier"
          >
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={!hasToken || submitting || !subject.trim() || !predicate.trim() || !object.trim()}
            className="vtt-btn vtt-btn-primary text-xs active:scale-95 disabled:opacity-50"
          >
            <SendHorizonal className="w-3.5 h-3.5" />
            <span>{submitting ? 'Submitting…' : 'Assert to Canon Graph'}</span>
          </button>
        </div>
      </form>

      {result && <ResultBanner result={result} />}

      {/* Public persona listing */}
      <div className="pt-2 border-t border-tavern-border space-y-2">
        <h4 className="text-[11px] font-display [font-variant:small-caps] tracking-wider text-[var(--rp-parchment-300)] flex items-center gap-2">
          <Users className="w-3.5 h-3.5 shrink-0" />
          <span>Registered NPC Personas</span>
        </h4>
        {personas === null ? (
          <p className="text-[11px] font-prose text-[var(--rp-parchment-300)] flex items-center gap-1.5">
            <PlugZap className="w-3.5 h-3.5" />
            Persona registry unreachable (GET /api/v1/npc/ failed or backend offline).
          </p>
        ) : personas.length === 0 ? (
          <ScrollText className="w-full text-[11px] font-prose text-[var(--rp-parchment-300)]">
            The registry returned no personas yet.
          </ScrollText>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {personas.map((npc) => (
              <li key={npc.id} className="vtt-badge" title={`${npc.role} (${npc.id})`}>
                {npc.name} · {npc.role}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const ResultBanner: React.FC<{ result: AssertLoreResult }> = ({ result }) => {
  if (result.outcome === 'UNREACHABLE') {
    return (
      <div className="text-[11px] font-prose p-2.5 rounded-lg border border-tavern-border bg-[color-mix(in_srgb,var(--tavern-surface)_60%,transparent)]">
        Backend unreachable — nothing was asserted. No local fallback was applied; retry once the
        gateway is up.
      </div>
    );
  }

  if (result.outcome === 'LORE_TIER_FORBIDDEN') {
    // Iteration 5: surface the server's tier policy honestly. The 403 detail
    // already names the requested tier and the rule; we add the operator
    // instruction ("ask the GM to promote") so the player knows what to do
    // next without inventing a workflow the gateway does not implement.
    return (
      <div className="text-[11px] font-prose p-2.5 rounded-lg border border-[color-mix(in_srgb,var(--state-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-warning)_10%,transparent)] flex items-start gap-2">
        <Crown className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--state-warning)]" />
        <span>
          <strong>GM promotion required.</strong> The gateway refused tier{' '}
          <code className="font-mono text-[10px]">{result.requestedTier}</code>{' '}
          for this caller — only GM tokens may promote lore above SUBJECTIVE_RUMOR.
          Ask the table GM to promote this triple one step at a time.
          <span className="block text-[10px] mt-1 opacity-80">{result.detail}</span>
        </span>
      </div>
    );
  }

  if (result.outcome === 'ERROR') {
    return (
      <div className="text-[11px] font-prose p-2.5 rounded-lg border border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--rp-crimson-400)]" />
        <span>Rejected by gateway: {result.detail}</span>
      </div>
    );
  }

  if (result.outcome === 'REJECTED_PARADOX') {
    return (
      <div className="text-[11px] font-prose p-2.5 rounded-lg border border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] space-y-1">
        <div className="flex items-center gap-2 font-bold text-[var(--rp-crimson-400)]">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>REJECTED_PARADOX ({result.latencyMs}ms)</span>
        </div>
        <p className="whitespace-pre-wrap">{result.reason}</p>
      </div>
    );
  }

  return (
    <div className="text-[11px] font-prose p-2.5 rounded-lg border border-[color-mix(in_srgb,var(--state-success)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] space-y-1">
      <div className="flex items-center gap-2 font-bold text-emerald-300">
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        <span>
          {result.outcome} · tier {result.epistemicTier} · weight {result.assignedWeight} ({result.latencyMs}ms)
        </span>
      </div>
      {result.outcome === 'STAGED' && (
        <p>Held below full canon weight; it will not be treated as VALIDATED_CANON until promoted.</p>
      )}
    </div>
  );
};
