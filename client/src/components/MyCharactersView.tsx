import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Users,
  Eye,
  Rocket,
  Trash2,
  RefreshCw,
  X,
  AlertTriangle,
  Sparkles,
  LogIn,
} from 'lucide-react';
import { ModalShell } from './ui/ModalShell';
import {
  deleteCharacter,
  deployCharacter,
  getCharacter,
  listCharacters,
  type DeleteCharacterOutcome,
  type FullStoredCharacter,
  type StoredCharacter,
} from '../api/lobby_store';
import {
  describeHp,
  evaluateDeployGate,
  shapeGalleryCards,
  type GalleryCard,
} from '../api/character_gallery';
import { getStoredToken } from '../api/auth_headers';
import { globalAudio } from '../render/audio_manager';
import type { Token } from './TacticalCanvas';

interface MyCharactersViewProps {
  /** Live engine session id, when one exists — Deploy requires it. */
  activeSessionId?: string | null;
  /**
   * Local-canvas deploy (the same path the builder's "Deploy to Tabletop"
   * uses): adds a token and switches to the tabletop view. Optional only so
   * the view stays testable; the Deploy button renders without it but still
   * respects the session gate.
   */
  onDeployToTabletop?: (token: Omit<Token, 'id' | 'x' | 'y'>) => void;
  /** Opens the builder for new sheets (the gallery itself is read-only). */
  onOpenBuilder?: () => void;
}

/**
 * Iteration 14 (Loop 3) — "My Characters" gallery.
 *
 * One card per sheet the signed-in player owns server-side
 * (narrative_state.player_characters via GET /api/v1/characters), with the
 * three actions that stable management actually needs:
 *
 *   - VIEW opens the persisted record in a modal stat-block (the right-dock
 *     CharacterSheet is bound to a selected CANVAS token; this is how you read
 *     a sheet that has never been placed on the board);
 *   - DEPLOY re-uses the existing POST /{id}/deploy flow, gated on an active
 *     engine session (disabled with an honest reason otherwise);
 *   - DELETE asks once, then calls the gateway's DELETE route through
 *     api/lobby_store.deleteCharacter and surfaces refusal verbatim.
 *
 * The LIST endpoint strips each record's `data` blob, so HP arrives through a
 * per-card getCharacter hydration pass — cards render immediately with an em
 * dash where HP is still unknown rather than blocking the whole grid on it.
 */
export const MyCharactersView: React.FC<MyCharactersViewProps> = ({
  activeSessionId = null,
  onDeployToTabletop,
  onOpenBuilder,
}) => {
  const [roster, setRoster] = useState<StoredCharacter[] | null>(null);
  // Per-id hydrated detail records (the list endpoint omits `data`).
  const [details, setDetails] = useState<Record<string, FullStoredCharacter | null>>({});
  // Which detail fetches have settled, so "no data" can be distinguished from
  // "still loading" instead of every empty field looking like a failure.
  const [hydratedCount, setHydratedCount] = useState(0);

  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; text: string } | null>(null);

  // Delete confirmation state: which card the dialog is armed for. The dialog
  // carries its own busy/error pair so a failed delete leaves it open with the
  // gateway's answer quoted, rather than silently closing as if nothing happened.
  const [confirmingDelete, setConfirmingDelete] = useState<GalleryCard | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [viewingDetail, setViewingDetail] = useState<FullStoredCharacter | null>(null);
  const signedIn = Boolean(getStoredToken());

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    if (!signedIn) return undefined;
    listCharacters()
      .then((chars) => {
        if (cancelled) return;
        setRoster(chars);
        setHydratedCount(0);
        setDetails({});
        // Hydrate each card's vitals in parallel; failures resolve null and
        // leave that one card's HP as an explicit dash.
        Promise.all(
          chars.map((c) =>
            getCharacter(c.character_id).catch(() => null)
          )
        ).then((fulls) => {
          if (cancelled) return;
          const map: Record<string, FullStoredCharacter | null> = {};
          fulls.forEach((f, i) => {
            map[chars[i].character_id] = f;
          });
          setDetails(map);
          setHydratedCount(fulls.length);
        });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, reloadNonce]);

  const cards = useMemo(
    () => (roster ? shapeGalleryCards(roster, details) : []),
    [roster, details]
  );

  const refresh = useCallback(() => {
    setRoster(null);
    setReloadNonce((n) => n + 1);
  }, []);

  const clearActionError = () => setActionError(null);

  const handleView = async (card: GalleryCard) => {
    setActionError(null);
    setBusyId(card.id);
    try {
      const detail =
        details[card.id] && details[card.id]!.data !== undefined
          ? details[card.id]
          : await getCharacter(card.id);
      if (detail && detail.data !== undefined) {
        setViewingDetail(detail);
        globalAudio.playTurnAdvance();
      } else {
        setActionError({
          id: card.id,
          text:
            detail === null
              ? 'The gateway could not return this character (not found or offline).'
              : 'This stored record has no sheet data to display.',
        });
      }
    } finally {
      setBusyId(null);
    }
  };

  const gate = evaluateDeployGate(activeSessionId);
  const deployAllowed = gate.allowed;

  const handleDeploy = async (card: GalleryCard) => {
    setActionError(null);
    if (!deployAllowed || !onDeployToTabletop) return;
    setBusyId(card.id);
    // Hydration first: the local token needs real vitals, and the gateway
    // derives the engine-side attack block from the stored abilities anyway.
    const detail = details[card.id] ?? (await getCharacter(card.id).catch(() => null));
    if (!detail || !detail.data) {
      setBusyId(null);
      setActionError({ id: card.id, text: 'Could not load this sheet before deploying.' });
      return;
    }
    const hp = typeof detail.data.hp === 'number' ? detail.data.hp : 1;
    const maxHp = typeof detail.data.max_hp === 'number' ? detail.data.max_hp : hp;
    const ac = typeof detail.data.ac === 'number' ? detail.data.ac : 10;
    const deployed = await deployCharacter(card.id, activeSessionId!, 5, 5);
    setBusyId(null);
    if (!deployed) {
      setActionError({
        id: card.id,
        text: 'The gateway refused or could not reach the deploy route.',
      });
      return;
    }
    globalAudio.playSpellCast();
    onDeployToTabletop({
      name: card.name,
      hp,
      maxHp,
      ac,
      color: '#3b82f6',
      isPlayer: true,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmingDelete || deleteBusy) return;
    const target = confirmingDelete;
    setDeleteBusy(true);
    setDeleteError(null);
    const result = await deleteCharacter(target.id);
    setDeleteBusy(false);
    if (result.outcome === 'ok') {
      setRoster((prev) => prev?.filter((c) => c.character_id !== target.id) ?? prev);
      setConfirmingDelete(null);
      setDeleteError(null);
      return;
    }
    // Render the gateway's verbatim detail per branch — never guess. The
    // view never collapses 403/404/network into one fabricated sentence; each
    // branch keeps its own honest copy from the gateway (or the pre-flight
    // pre-check when no token was present).
    setDeleteError(describeDeleteOutcome(result));
  };

  // --- Empty / unauthenticated / error states ------------------------------

  if (!signedIn) {
    return (
      <div className="flex-1 flex flex-col h-full bg-tavern-bg overflow-hidden">
        <GalleryHeader onOpenBuilder={onOpenBuilder} count={null} />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="vtt-surface rounded-2xl p-8 max-w-md text-center space-y-3">
            <LogIn className="w-8 h-8 mx-auto text-[var(--tavern-accent)]" />
            <h2 className="vtt-engraved text-base font-bold">Sign in to see your stable</h2>
            <p className="text-xs text-[var(--rp-parchment-300)] font-sans leading-relaxed">
              Your characters are persisted server-side against your account. Sign in to browse,
              deploy, or retire them.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-tavern-bg text-parchment-aged overflow-hidden">
      <GalleryHeader
        onOpenBuilder={onOpenBuilder}
        onRefresh={refresh}
        count={roster ? cards.length : null}
      />

      <div className="flex-1 p-6 overflow-y-auto vtt-scrollbar max-w-5xl mx-auto w-full">
        {/* Honest load failure: the roster read itself failed (offline / 401). */}
        {loadError && (
          <div role="alert" className="vtt-surface rounded-xl p-4 mb-4 border border-red-500/30">
            <div className="flex items-center gap-2 text-sm font-bold">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              Could not load your characters
            </div>
            <p className="text-xs text-[var(--rp-parchment-300)] font-sans mt-1">
              The gateway did not answer the roster request. Check your connection and retry.
            </p>
          </div>
        )}

        {roster && cards.length === 0 && !loadError && (
          <div className="vtt-surface rounded-2xl p-8 max-w-md mx-auto text-center space-y-3 mt-8">
            <Users className="w-8 h-8 mx-auto text-[var(--tavern-accent)]" />
            <h2 className="vtt-engraved text-base font-bold">No characters yet</h2>
            <p className="text-xs text-[var(--rp-parchment-300)] font-sans leading-relaxed">
              Sheets saved from the Character Studio appear here, ready to inspect, deploy, or
              retire.
            </p>
            {onOpenBuilder && (
              <button onClick={onOpenBuilder} className="vtt-btn vtt-btn-primary text-xs font-mono">
                <Sparkles className="w-4 h-4" />
                <span>Forge your first hero</span>
              </button>
            )}
          </div>
        )}

        {!roster && !loadError && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="vtt-surface rounded-xl p-4 animate-pulse h-36" />
            ))}
          </div>
        )}

        {cards.length > 0 && (
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cards.map((card) => (
              <li
                key={card.id}
                data-testid="character-card"
                data-character-name={card.name}
                className="vtt-surface rounded-xl p-4 flex flex-col gap-3 border-t-2"
                style={{ borderTopColor: 'var(--tavern-accent)' }}
              >
                <div className="min-w-0">
                  <h3 className="font-bold text-sm text-parchment-aged font-display truncate">
                    {card.name}
                  </h3>
                  <div className="text-[10px] font-mono text-tavern-accent uppercase tracking-wide">
                    Level {card.level} · {card.classLabel}
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-2 font-mono text-center">
                  <div className="p-1.5 rounded-lg bg-black/20">
                    <dt className="text-[9px] uppercase text-[color:var(--statblock-header)]">
                      Hit Points
                    </dt>
                    <dd className="text-sm font-bold text-parchment-aged">
                      {describeHp(card.hp)}
                    </dd>
                  </div>
                  <div className="p-1.5 rounded-lg bg-black/20">
                    <dt className="text-[9px] uppercase text-[color:var(--statblock-header)]">
                      Level
                    </dt>
                    <dd className="text-sm font-bold text-parchment-aged">{card.level}</dd>
                  </div>
                </dl>

                {actionError?.id === card.id && (
                  <p role="alert" className="text-[11px] font-sans text-red-300 leading-snug">
                    {actionError.text}
                  </p>
                )}

                <div className="mt-auto grid grid-cols-3 gap-1.5">
                  <button
                    onClick={() => void handleView(card)}
                    disabled={busyId === card.id}
                    title="Inspect the stored sheet"
                    className="vtt-btn vtt-btn-secondary text-[10px] font-mono justify-center"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>View</span>
                  </button>
                  <button
                    onClick={() => void handleDeploy(card)}
                    disabled={!deployAllowed || !onDeployToTabletop || busyId === card.id}
                    title={deployAllowed ? 'Place on the active table' : gate.reason}
                    className="vtt-btn vtt-btn-primary text-[10px] font-mono justify-center"
                  >
                    <Rocket className="w-3.5 h-3.5" />
                    <span>Deploy</span>
                  </button>
                  <button
                    onClick={() => {
                      setDeleteError(null);
                      setConfirmingDelete(card);
                    }}
                    disabled={busyId === card.id}
                    title="Permanently remove this sheet"
                    className="vtt-btn vtt-btn-danger text-[10px] font-mono justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete</span>
                  </button>
                </div>

                {!deployAllowed && (
                  <p className="text-[9px] font-mono text-[var(--rp-parchment-300)] leading-snug">
                    {gate.reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* View modal — the persisted sheet rendered as a book stat block. */}
      <ModalShell
        isOpen={viewingDetail !== null}
        onClose={() => setViewingDetail(null)}
        title={viewingDetail?.name ?? ''}
        subtitle={
          viewingDetail
            ? `Level ${viewingDetail.level} ${viewingDetail.character_class}`
            : undefined
        }
        icon={<Eye className="w-5 h-5" />}
        tone="statblock"
        size="md"
      >
        {viewingDetail?.data && (
          <CharacterRecordBody data={viewingDetail.data} level={viewingDetail.level} />
        )}
      </ModalShell>

      {/* Delete confirmation — asks once, then reports the gateway's verdict. */}
      <ModalShell
        isOpen={confirmingDelete !== null}
        onClose={() => {
          if (!deleteBusy) {
            setConfirmingDelete(null);
            setDeleteError(null);
          }
        }}
        title={`Retire ${confirmingDelete?.name ?? ''}?`}
        subtitle="This permanently removes the stored sheet."
        icon={<AlertTriangle className="w-5 h-5" />}
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <button
              onClick={() => {
                setConfirmingDelete(null);
                setDeleteError(null);
              }}
              disabled={deleteBusy}
              className="vtt-btn vtt-btn-secondary text-xs font-mono"
            >
              <X className="w-4 h-4" />
              <span>Cancel</span>
            </button>
            <button
              onClick={() => void handleConfirmDelete()}
              disabled={deleteBusy}
              className="vtt-btn vtt-btn-danger text-xs font-mono"
            >
              <Trash2 className="w-4 h-4" />
              <span>{deleteBusy ? 'Removing…' : 'Delete forever'}</span>
            </button>
          </div>
        }
      >
        {deleteError ? (
          <p role="alert" className="text-sm font-sans text-red-300 leading-relaxed">
            {deleteError}
          </p>
        ) : (
          <p className="text-sm font-sans leading-relaxed">
            <strong>{confirmingDelete?.name}</strong> (level{' '}
            {confirmingDelete?.level} {confirmingDelete?.classLabel}) will be deleted from the
            campaign database. This cannot be undone.
          </p>
        )}
      </ModalShell>
    </div>
  );
};

/** Shared header row for every gallery state. */
function GalleryHeader({
  count,
  onOpenBuilder,
  onRefresh,
}: {
  count: number | null;
  onOpenBuilder?: () => void;
  onRefresh?: () => void;
}) {
  return (
    <div className="p-4 border-b border-tavern-border flex items-center justify-between shrink-0">
      <div>
        <h1 className="vtt-engraved text-lg font-bold flex items-center gap-2">
          <Users className="w-5 h-5 text-tavern-accent" />
          <span>My Characters</span>
          {count !== null && (
            <span className="vtt-badge font-mono">{count}</span>
          )}
        </h1>
        <p className="text-xs text-parchment-aged/70 mt-0.5">
          Every sheet you own on this account — inspect it, deploy it to the live table, or retire it.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="vtt-btn vtt-btn-secondary text-xs font-mono"
            aria-label="Refresh roster"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Refresh</span>
          </button>
        )}
        {onOpenBuilder && (
          <button onClick={onOpenBuilder} className="vtt-btn vtt-btn-primary text-xs font-mono">
            <Sparkles className="w-4 h-4" />
            <span>New Character</span>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Render the verbatim gateway copy for every DELETE-character failure branch.
 * No fabrications: the view's job is to display what the server said and
 * what the wire situation was. The pre-flight branches (NOT_SIGNED_IN,
 * UNREACHABLE) carry their own pre-written copy because the gateway never
 * had a chance to answer.
 */
function describeDeleteOutcome(outcome: Exclude<DeleteCharacterOutcome, { outcome: 'ok' }>): string {
  switch (outcome.outcome) {
    case 'not_signed_in':
      return outcome.detail;
    case 'forbidden':
      return `The gateway refused: ${outcome.detail}`;
    case 'not_found':
      return `The gateway could not find that character for this account: ${outcome.detail}`;
    case 'rejected':
      return `The gateway rejected the delete request: ${outcome.detail}`;
    case 'unreachable':
      return `Gateway unreachable: ${outcome.detail}`;
  }
}

/** Book-style body for the View modal, straight off the stored `data` blob. */
function CharacterRecordBody({
  data,
  level,
}: {
  data: NonNullable<FullStoredCharacter['data']>;
  level: number;
}) {
  const abilities = (data.abilities ?? {}) as Record<string, number | undefined>;
  const rows: [string, React.ReactNode][] = [
    ['Armor Class', typeof data.ac === 'number' ? data.ac : null],
    [
      'Hit Points',
      typeof data.hp === 'number'
        ? `${data.hp}${typeof data.max_hp === 'number' ? ` / ${data.max_hp}` : ''}`
        : null,
    ],
    ['Speed', typeof data.speed === 'number' ? `${data.speed} ft` : (data.speed ?? null)],
    ['Level', level],
    ['Race', data.race ?? null],
  ];

  return (
    <div className="selectable-text">
      <dl className="vtt-statblock-attr grid grid-cols-3 gap-2 px-3 py-2 my-2 rounded-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="vtt-attr-label text-[11px] leading-tight">{label}</dt>
            <dd className="vtt-attr-value text-sm truncate" title={String(value ?? '')}>
              {value == null || value === '' ? '—' : String(value)}
            </dd>
          </div>
        ))}
      </dl>

      <h4 className="vtt-section-header text-sm font-bold mt-3">Abilities</h4>
      <div className="grid grid-cols-6 gap-2 text-center font-mono my-2">
        {Object.entries(abilities).map(([key, score]) => (
          <div
            key={key}
            className="p-2 rounded-lg border border-[color:var(--rp-leather-700)]/40 bg-black/5"
          >
            <div className="text-[10px] uppercase text-parchment-ink/70">{key.slice(0, 3)}</div>
            <div className="text-sm font-bold text-parchment-ink">
              {typeof score === 'number' ? score : '—'}
            </div>
          </div>
        ))}
      </div>

      {Array.isArray(data.spells) && data.spells.length > 0 && (
        <>
          <h4 className="vtt-section-header text-sm font-bold">Spells</h4>
          <ul className="list-disc pl-5 text-sm font-prose leading-relaxed">
            {(data.spells as unknown[]).map((s, i) => (
              <li key={i}>{typeof s === 'string' ? s : JSON.stringify(s)}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
