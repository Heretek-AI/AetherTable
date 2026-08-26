import React, { useEffect, useRef, useState } from 'react';
import {
  Wand2,
  Copy,
  Check,
  BookOpen,
  AlertTriangle,
  Loader2,
  Download,
  Users,
  ScrollText,
  ChevronLeft,
} from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import { createLobby, type Lobby } from '../api/lobby_store';
import { authHeaders } from '../api/auth_headers';
import {
  canAdvanceStep,
  clampPartySize,
  clientOnlyWizardFields,
  DEFAULT_PARTY_SIZE,
  PARTY_SIZE_MAX,
  PARTY_SIZE_MIN,
  reviewRows,
  RULE_VERSION_OPTIONS,
  ruleVersionLabel,
  STARTING_LEVEL_OPTIONS,
  wizardCreateRequestBody,
  WIZARD_STEPS,
  type CampaignRuleVersion,
  type CampaignWizardConfig,
} from '../api/campaign_wizard_state';
import { ATMOSPHERE_PRESETS, DEFAULT_ATMOSPHERE_ID } from '../theme/atmospheres';

// Shared wizard types + step/payload logic live in api/campaign_wizard_state.ts
// (iteration 70) where they are unit-testable; re-exported here for callers
// that import them from this module (App.tsx does).
export type { CampaignRuleVersion, CampaignWizardConfig };

/**
 * Guided campaign setup wizard (GOALS.md Pillar 2).
 *
 * HONEST SCOPE — what is real vs stored-as-data:
 *  - The lobby is REAL: created through POST /api/v1/lobbies via
 *    lobby_store.createLobby; the invite code shown on the final step is the
 *    one the backend generated, never a local placeholder. The wizard only
 *    reports success after that call returns a lobby.
 *  - Rule version, party size and starting level are DATA ONLY. Today's lobby
 *    API accepts just `{ name }` — there is no server field for them yet — so
 *    they are carried to App via onComplete and kept client-side until a
 *    campaign-settings endpoint exists.
 *  - Atmosphere selection reuses theme/atmospheres.ts presets; applying it is
 *    the same LOCAL-ONLY mechanism as the Navbar picker (no sync channel).
 *  - "Load starter adventure" performs the only real action available: it
 *    downloads the selected catalog entry as a .vttbundle via
 *    POST /api/v1/adventures/starter/{key}/export (authenticated). It does not
 *    inject content into the session — bundle import stays in Bundle Manager.
 */

/** Catalog entry shape returned by GET /api/v1/adventures/starter. */
export interface StarterAdventureEntry {
  key: string;
  title: string;
  level_range: string;
  ruleset: string;
  encounter_count: number;
  synopsis: string;
}

interface CampaignWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called ONLY after a real lobby exists. `loadAdventureKey` is the chosen
   * starter adventure key, or null when the GM skipped it.
   */
  onComplete: (
    lobby: Lobby,
    config: CampaignWizardConfig,
    loadAdventureKey: string | null
  ) => void;
}

const RULE_VERSIONS = RULE_VERSION_OPTIONS;

const STEPS = WIZARD_STEPS;

export const CampaignWizardModal: React.FC<CampaignWizardModalProps> = ({
  isOpen,
  onClose,
  onComplete,
}) => {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [atmosphereId, setAtmosphereId] = useState<string>(DEFAULT_ATMOSPHERE_ID);
  const [ruleVersion, setRuleVersion] = useState<CampaignRuleVersion>('srd_5_2');
  const [partySize, setPartySize] = useState(DEFAULT_PARTY_SIZE);
  const [startingLevel, setStartingLevel] = useState<number>(STARTING_LEVEL_OPTIONS[0]);

  // Creation state — the wizard completes only when createLobby resolves with
  // a real backend lobby.
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdLobby, setCreatedLobby] = useState<Lobby | null>(null);
  /**
   * Honest clipboard feedback: 'copied' only after
   * navigator.clipboard.writeText RESOLVES, 'failed' when it rejects or is
   * unavailable (insecure context / no permission), so we never fabricate a
   * success the user cannot verify.
   */
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleCopyStateReset = (state: 'idle' | 'copied' | 'failed', ms: number) => {
    if (copyResetTimerRef.current !== null) clearTimeout(copyResetTimerRef.current);
    setCopyState(state);
    copyResetTimerRef.current = setTimeout(() => {
      copyResetTimerRef.current = null;
      setCopyState('idle');
    }, ms);
  };

  // Starter-adventure catalog (real GET /api/v1/adventures/starter). Null =
  // fetch failed / still loading; we never fabricate entries to fill the list.
  const [catalogState, setCatalogState] = useState<
    'loading' | 'ready' | 'unavailable'
  >('loading');
  const [adventures, setAdventures] = useState<StarterAdventureEntry[]>([]);
  const [wantAdventure, setWantAdventure] = useState(false);
  const [selectedAdventureKey, setSelectedAdventureKey] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Fetch the real catalog once per open. Failure leaves an honest empty state.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCatalogState('loading');
    fetch('/api/v1/adventures/starter')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        const list: StarterAdventureEntry[] = Array.isArray(data?.adventures)
          ? data.adventures
          : [];
        setAdventures(list);
        setCatalogState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setAdventures([]);
        setCatalogState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Reset transient state between openings so a stale error/code never leaks
  // into the next run of the wizard.
  useEffect(() => {
    if (isOpen) return;
    setStep(0);
    setCreating(false);
    setCreateError(null);
    setCreatedLobby(null);
    if (copyResetTimerRef.current !== null) {
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
    setCopyState('idle');
    setWantAdventure(false);
    setSelectedAdventureKey(null);
    setDownloadError(null);
    setName('');
    setAtmosphereId(DEFAULT_ATMOSPHERE_ID);
    setRuleVersion('srd_5_2');
    setPartySize(DEFAULT_PARTY_SIZE);
    setStartingLevel(STARTING_LEVEL_OPTIONS[0]);
  }, [isOpen]);

  const canAdvance = canAdvanceStep(step, name);

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    // The wire body is exactly { name } — see campaign_wizard_state.ts for the
    // audited boundary between what is sent and what stays client-side.
    const lobby = await createLobby(wizardCreateRequestBody(name).name);
    if (!lobby || !lobby.invite_code) {
      setCreating(false);
      setCreateError(
        'Lobby creation failed — no lobby was created. Sign in (session token required) ' +
          'and make sure the orchestrator gateway is reachable, then try again.'
      );
      return;
    }
    setCreatedLobby(lobby);
    setCreating(false);
  };

  const handleCopyInvite = async () => {
    if (!createdLobby) return;
    // Clipboard API is unavailable on insecure origins and can reject on
    // permission denial — both must surface as failure, not fake success.
    if (!navigator.clipboard?.writeText) {
      scheduleCopyStateReset('failed', 4000);
      return;
    }
    try {
      await navigator.clipboard.writeText(createdLobby.invite_code);
      scheduleCopyStateReset('copied', 2000);
    } catch {
      scheduleCopyStateReset('failed', 4000);
    }
  };

  /**
   * The only honest "load" action available: download the real .vttbundle from
   * the orchestrator's export endpoint. No fabricated import confirmation.
   */
  const handleDownloadAdventure = async (key: string) => {
    setDownloadError(null);
    setDownloadingKey(key);
    try {
      const resp = await fetch(`/api/v1/adventures/starter/${encodeURIComponent(key)}/export`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!resp.ok) {
        setDownloadError(`Export rejected by the gateway (HTTP ${resp.status}).`);
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${key}.vttbundle`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Starter adventure export unreachable — nothing was downloaded.');
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleFinish = () => {
    if (!createdLobby) return;
    onComplete(
      createdLobby,
      { name: name.trim(), atmosphereId, ruleVersion, partySize, startingLevel },
      wantAdventure ? selectedAdventureKey : null
    );
  };

  // Atmosphere display name resolved once so the review ledger shows the
  // human label, not the raw preset id.
  const atmosphereLabel =
    atmosphereId === DEFAULT_ATMOSPHERE_ID
      ? 'Default Obsidian'
      : ATMOSPHERE_PRESETS.find((p) => p.id === atmosphereId)?.name ?? atmosphereId;
  const review = reviewRows({
    name,
    atmosphereId: atmosphereLabel,
    ruleVersion,
    partySize,
    startingLevel,
  });
  const deferredFields = clientOnlyWizardFields({
    name,
    atmosphereId,
    ruleVersion,
    partySize,
    startingLevel,
  });

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="New Campaign Wizard"
      subtitle={
        createdLobby
          ? 'Your table is live — share the invite code.'
          : 'Name your table, pick its rules, seat your party.'
      }
      icon={<Wand2 className="w-5 h-5" />}
      size="lg"
      closeOnBackdrop={!creating}
      initialFocusRef={step === 0 && !createdLobby ? nameInputRef : undefined}
      footer={
        createdLobby ? (
          <div className="flex items-center justify-end gap-2">
            <button onClick={onClose} className="vtt-btn vtt-btn-secondary text-xs">
              Close
            </button>
            <button
              onClick={handleFinish}
              disabled={wantAdventure && !selectedAdventureKey}
              className="vtt-btn vtt-btn-primary text-xs"
              title={
                wantAdventure && !selectedAdventureKey
                  ? 'Pick a starter adventure first, or untick the box'
                  : undefined
              }
            >
              Enter Lobby
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 w-full">
            <button
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0 || creating}
              className="vtt-btn vtt-btn-secondary text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Back
            </button>
            {step < STEPS.length - 1 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canAdvance}
                className="vtt-btn vtt-btn-primary text-xs"
              >
                Next: {STEPS[step + 1]}
              </button>
            ) : (
              <button
                onClick={() => void handleCreate()}
                disabled={!canAdvance || creating}
                className="vtt-btn vtt-btn-primary text-xs"
              >
                {creating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Creating…
                  </>
                ) : (
                  'Create Lobby'
                )}
              </button>
            )}
          </div>
        )
      }
    >
      {/* Step rail */}
      {!createdLobby && (
        <ol className="flex items-center gap-2 mb-4 text-[10px] font-mono uppercase tracking-wider">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded-full border ${
                  i === step
                    ? 'border-tavern-accent text-tavern-accent bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)]'
                    : i < step
                      ? 'border-emerald-500/40 text-emerald-400'
                      : 'border-tavern-border text-[var(--rp-parchment-300)] opacity-60'
                }`}
              >
                {i + 1}. {label}
              </span>
              {i < STEPS.length - 1 && <span className="text-tavern-border">—</span>}
            </li>
          ))}
        </ol>
      )}

      {/* ── Post-create panel: REAL invite code + optional starter adventure ── */}
      {createdLobby ? (
        <div className="space-y-4 text-xs text-[var(--rp-parchment-200)]">
          <div className="p-4 rounded-xl border border-tavern-accent bg-[color-mix(in_srgb,var(--tavern-accent)_8%,transparent)] space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-[var(--rp-parchment-300)]">
                  Invite code (from the server)
                </div>
                <div className="font-mono text-3xl font-bold text-tavern-accent tracking-[0.35em] select-all mt-1">
                  {createdLobby.invite_code}
                </div>
                <div className="text-[10px] text-[var(--rp-parchment-300)] mt-1">
                  Lobby “{createdLobby.name}” · id{' '}
                  <span className="font-mono">{createdLobby.lobby_id}</span> · players join from
                  the Lobby view with this code.
                </div>
              </div>
              <button
                onClick={handleCopyInvite}
                className="vtt-btn vtt-btn-primary px-3 shrink-0"
                title={
                  copyState === 'failed'
                    ? 'Clipboard access was denied or unavailable — select the code and press Ctrl+C'
                    : 'Copy invite code to clipboard'
                }
              >
                {copyState === 'copied' && <Check className="w-4 h-4" />}
                {copyState === 'idle' && <Copy className="w-4 h-4" />}
                {copyState === 'failed' && <AlertTriangle className="w-4 h-4" />}
                <span>
                  {copyState === 'copied'
                    ? 'Copied'
                    : copyState === 'failed'
                      ? 'Press Ctrl+C'
                      : 'Copy'}
                </span>
              </button>
            </div>
          </div>

          {/* Optional starter adventure — real catalog or honest empty state */}
          <div className="p-4 rounded-xl border border-tavern-border bg-tavern-bg/60 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={wantAdventure}
                onChange={(e) => {
                  setWantAdventure(e.target.checked);
                  setDownloadError(null);
                }}
                className="accent-amber-500"
              />
              <BookOpen className="w-4 h-4 text-tavern-accent" />
              <span className="font-bold">Also grab a starter adventure (.vttbundle)</span>
            </label>

            {wantAdventure && (
              <div className="space-y-2 pl-6">
                {catalogState === 'loading' && (
                  <div className="flex items-center gap-2 text-[var(--rp-parchment-300)]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Fetching the starter catalog…
                  </div>
                )}
                {catalogState === 'unavailable' && (
                  <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-600/40 text-amber-200/90">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      Starter adventure catalog unavailable (GET /api/v1/adventures/starter failed).
                      Nothing is listed because nothing could be verified — retry once the
                      orchestrator is reachable.
                    </div>
                  </div>
                )}
                {catalogState === 'ready' && adventures.length === 0 && (
                  <div className="text-[var(--rp-parchment-300)] italic">
                    Catalog reachable but empty — no starter adventures shipped in this build.
                  </div>
                )}
                {catalogState === 'ready' &&
                  adventures.map((adv) => (
                    <label
                      key={adv.key}
                      className="flex items-start gap-2 p-2 rounded-lg border border-tavern-border hover:bg-black/20 transition cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="starter_adventure"
                        checked={selectedAdventureKey === adv.key}
                        onChange={() => {
                          setSelectedAdventureKey(adv.key);
                          setDownloadError(null);
                        }}
                        className="mt-0.5 accent-amber-500"
                      />
                      <ScrollText className="w-4 h-4 shrink-0 mt-0.5 text-tavern-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-[var(--rp-parchment-100)]">{adv.title}</div>
                        <div className="text-[10px] font-mono text-[var(--rp-parchment-300)]">
                          levels {String(adv.level_range)} · {adv.encounter_count} encounter(s) ·{' '}
                          {adv.ruleset}
                        </div>
                        <div className="text-[11px] text-[var(--rp-parchment-300)] font-prose mt-0.5 line-clamp-2">
                          {adv.synopsis}
                        </div>
                      </div>
                      {selectedAdventureKey === adv.key && (
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            void handleDownloadAdventure(adv.key);
                          }}
                          disabled={downloadingKey !== null}
                          className="vtt-btn vtt-btn-secondary px-2 py-1 text-[10px] shrink-0"
                          title="Download this adventure as a .vttbundle archive"
                        >
                          {downloadingKey === adv.key ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Download className="w-3 h-3" />
                          )}
                          Export
                        </button>
                      )}
                    </label>
                  ))}
                {downloadError && (
                  <div className="flex items-start gap-2 p-2 rounded-lg border border-rose-600/50 text-rose-300">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{downloadError}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <p className="text-[10px] text-[var(--rp-parchment-300)] leading-relaxed">
            Note: the lobby API persists this campaign's name only. Recorded with your campaign
            config but not yet sent to the server:
            {deferredFields.map((f, i) => (
              <span key={f.field}>
                {i > 0 && '; '}
                {' '}
                <span className="font-bold">{f.field}</span> ({f.value}) — {f.reason}
              </span>
            ))}
            .
          </p>
        </div>
      ) : (
        /* ── Steps 1–4 ── */
        <div className="space-y-4 text-xs text-[var(--rp-parchment-200)] min-h-[16rem]">
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <label htmlFor="wizard-campaign-name" className="block font-bold mb-1">
                  Campaign name
                </label>
                <input
                  id="wizard-campaign-name"
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="e.g. The Fall of Baron Vane"
                  className="vtt-input w-full"
                />
                <p className="text-[10px] text-[var(--rp-parchment-300)] mt-1">
                  This becomes the real lobby's table name on creation.
                </p>
              </div>

              <div>
                <div className="font-bold mb-1">Table atmosphere</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    {
                      id: DEFAULT_ATMOSPHERE_ID,
                      name: 'Default Obsidian',
                      description: 'Stock tavern & parchment palette.',
                    },
                    ...ATMOSPHERE_PRESETS.map((p) => ({
                      id: p.id,
                      name: p.name,
                      description: p.description,
                    })),
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setAtmosphereId(preset.id)}
                      className={`text-left p-2.5 rounded-lg border transition ${
                        atmosphereId === preset.id
                          ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)] border-tavern-accent ring-1 ring-tavern-accent'
                          : 'border-tavern-border hover:bg-black/20'
                      }`}
                    >
                      <div className="font-bold text-[var(--rp-parchment-100)]">{preset.name}</div>
                      <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans mt-0.5">
                        {preset.description}
                      </div>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--rp-parchment-300)] mt-1">
                  Applies locally on this browser only — atmosphere has no sync channel yet.
                </p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div className="font-bold">Rules version</div>
              {RULE_VERSIONS.map((rv) => (
                <label
                  key={rv.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                    ruleVersion === rv.id
                      ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)] border-tavern-accent ring-1 ring-tavern-accent'
                      : 'border-tavern-border hover:bg-black/20'
                  }`}
                >
                  <input
                    type="radio"
                    name="rule_version"
                    checked={ruleVersion === rv.id}
                    onChange={() => setRuleVersion(rv.id)}
                    className="mt-0.5 accent-amber-500"
                  />
                  <div>
                    <div className="font-bold text-[var(--rp-parchment-100)]">{rv.label}</div>
                    <div className="text-[11px] text-[var(--rp-parchment-300)] font-sans mt-0.5">
                      {rv.blurb}
                    </div>
                  </div>
                </label>
              ))}
              {/* Honest behavior note matching the gateway's loader
                  (server.py prefers srd_5_2_*.json fixtures and falls back to
                  the legacy data/srd_*.json files when absent). */}
              <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-600/40 text-amber-200/90 leading-relaxed">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Content availability today depends on what the gateway loaded, not this choice:
                  when the richer SRD 5.2 fixture files are present they win for every session, and
                  5.1 content falls back to the legacy 5.1 data files when those fixtures are
                  absent. Picking a version here records your preference; it does not yet swap
                  which compendium the server serves.
                </span>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6 pt-2">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold flex items-center gap-2">
                    <Users className="w-4 h-4 text-tavern-accent" />
                    Party size (player seats)
                  </span>
                  <span className="font-mono text-tavern-accent">{partySize}</span>
                </div>
                <input
                  type="range"
                  min={PARTY_SIZE_MIN}
                  max={PARTY_SIZE_MAX}
                  step={1}
                  value={partySize}
                  onChange={(e) => setPartySize(clampPartySize(e.target.value))}
                  className="w-full accent-amber-500"
                />
                <div className="flex justify-between text-[10px] font-mono text-[var(--rp-parchment-300)] mt-1">
                  <span>{PARTY_SIZE_MIN}</span>
                  <span>{PARTY_SIZE_MAX}</span>
                </div>
              </div>

              <div>
                <div className="font-bold mb-2">Starting level</div>
                <div className="flex gap-2">
                  {STARTING_LEVEL_OPTIONS.map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => setStartingLevel(lvl)}
                      className={`flex-1 p-3 rounded-lg border transition font-display font-bold ${
                        startingLevel === lvl
                          ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)] border-tavern-accent ring-1 ring-tavern-accent text-tavern-accent'
                          : 'border-tavern-border hover:bg-black/20'
                      }`}
                    >
                      Level {lvl}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--rp-parchment-300)] mt-2">
                  Stored with the campaign config; characters keep their own persisted levels in
                  the character builder.
                </p>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="font-bold">Review</div>
              <dl className="p-3 rounded-lg border border-tavern-border bg-tavern-bg/60 font-mono space-y-1.5 text-[11px]">
                {review.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4">
                    <dt className="text-[var(--rp-parchment-300)]">{k}:</dt>
                    <dd className="text-[var(--rp-parchment-100)] text-right">{v}</dd>
                  </div>
                ))}
              </dl>

              {createError && (
                <div className="flex items-start gap-2 p-3 rounded-lg border border-rose-600/50 text-rose-300 leading-relaxed">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{createError}</span>
                </div>
              )}

              <p className="text-[10px] text-[var(--rp-parchment-300)] leading-relaxed">
                Creating calls POST /api/v1/lobbies. If the gateway is unreachable or you are
                signed out, nothing is faked — the wizard stays open and shows the error above.
              </p>
            </div>
          )}
        </div>
      )}
    </ModalShell>
  );
};
