import React, { useState } from 'react';
import {
  BookOpen,
  Share2,
  Sparkles,
  Check,
  RefreshCw,
  AlertTriangle,
  Info,
  Lock,
  GitBranch,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { ModalShell } from './ui/ModalShell';
import {
  generateQuest,
  orderQuestNodes,
  type QuestGraph,
  type QuestNode as EngineQuestNode,
} from '../api/quest_store';

interface QuestJournalModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShareToChat?: (text: string) => void;
  /**
   * Live session role from the App shell (same convention as StreamerHUDModal:
   * passed IN rather than mirrored). Defaults to the App shell's own default
   * seat. Quest generation and GM notes are gated on this in the UI; the
   * gateway also enforces GM on POST /api/v1/quest/generate via its auth
   * dependency, so this is a UX gate layered on real server enforcement.
   */
  userRole?: 'gm' | 'player' | 'spectator';
}

const NODE_BADGE: Record<string, string> = {
  HOOK: 'vtt-badge vtt-badge-success',
  CLIMAX: 'vtt-badge vtt-badge-danger',
  RESOLUTION: 'vtt-badge vtt-badge-success',
};

function nodeBadge(nodeType: string): string {
  return NODE_BADGE[nodeType] ?? 'vtt-badge';
}

/** Iteration 79's generator parameters — the exact body /api/v1/quest/generate accepts. */
const GENERATE_DEFAULTS = {
  campaign_theme: 'The Iron Succession',
  primary_house: 'house_vane',
  rival_house: 'house_silverpeak',
};

export const QuestJournalModal: React.FC<QuestJournalModalProps> = ({
  isOpen,
  onClose,
  onShareToChat,
  userRole = 'gm',
}) => {
  const isGM = userRole === 'gm';
  const [activeTab, setActiveTab] = useState<'quests' | 'notes'>('quests');
  const [selectedQuestId, setSelectedQuestId] = useState<string | null>(null);
  const [shareAlert, setShareAlert] = useState<string | null>(null);

  // Graphs generated THIS SESSION via POST /api/v1/quest/generate. Held in
  // memory only — neither this client nor the modal persists them.
  const [quests, setQuests] = useState<QuestGraph[]>([]);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...GENERATE_DEFAULTS });

  // GM session notes. Deliberately component-local state ONLY — never sent to
  // any server, never written to storage; erased when the tab closes or the
  // modal unmounts. The UI labels this LOCAL-ONLY in three places below.
  const [sessionNotes, setSessionNotes] = useState('');

  const activeQuest =
    quests.find((q) => q.quest_id === selectedQuestId) ?? quests[0] ?? null;

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    const graph = await generateQuest({
      campaign_theme: form.campaign_theme.trim() || GENERATE_DEFAULTS.campaign_theme,
      primary_house: form.primary_house.trim() || GENERATE_DEFAULTS.primary_house,
      rival_house: form.rival_house.trim() || GENERATE_DEFAULTS.rival_house,
    });
    setGenerating(false);
    if (!graph) {
      setGenError(
        'Generation failed — the gateway returned no quest graph. Nothing was invented to fill the gap.'
      );
      return;
    }
    setQuests((prev) => [graph, ...prev]);
    setSelectedQuestId(graph.quest_id);
    globalAudio.playTurnAdvance();
  };

  const handleShare = (text: string) => {
    if (onShareToChat) onShareToChat(text);
    globalAudio.playTurnAdvance();
    setShareAlert('Outline posted to the local chat feed.');
    setTimeout(() => setShareAlert(null), 2500);
  };

  const TABS: { id: typeof activeTab; label: string }[] = [
    {
      id: 'quests',
      label: `Generated Quests${quests.length > 0 ? ` (${quests.length})` : ''}`,
    },
    { id: 'notes', label: 'GM Session Notes · LOCAL-ONLY' },
  ];

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Quest Journal"
      subtitle="Quest graphs generated live by the gateway quest engine, plus GM session notes that never leave this browser."
      icon={<BookOpen className="w-5 h-5" />}
      size="xl"
      footer={
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-primary font-display tracking-wide"
          >
            Close Journal
          </button>
        </div>
      }
    >
      {/* Tab Navigation */}
      <div className="vtt-tabbar w-full font-mono text-xs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            data-active={activeTab === tab.id}
            className="vtt-tab"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content Body */}
      <div className="p-6 overflow-y-auto flex-1 max-h-[60vh] vtt-scrollbar">
        {shareAlert && (
          <div
            className="mb-4 border-l-4 border-[var(--state-success)] bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] rounded-r-lg px-3 py-2 text-xs flex items-center space-x-2 animate-fadeIn"
          >
            <Sparkles className="w-4 h-4 shrink-0" style={{ color: 'var(--state-success)' }} />
            <span className="text-[var(--rp-parchment-200)]">{shareAlert}</span>
          </div>
        )}

        {/* Generated Quests Tab */}
        {activeTab === 'quests' && (
          <div className="space-y-5">
            {/* GM Generation Panel */}
            {isGM ? (
              <div
                className="vtt-surface rounded-xl p-4 space-y-3"
                aria-label="Generate a quest"
              >
                <div className="flex items-center justify-between">
                  <div className="vtt-section-header text-xs font-bold flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-tavern-accent" />
                    Generate Quest (GM)
                  </div>
                  <span
                    className="text-[10px] text-[var(--rp-parchment-300)] font-mono"
                    title="POST /api/v1/quest/generate requires a GM token (Authorization header) — enforced by the gateway."
                  >
                    GM-only · server-enforced
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <label className="space-y-1 block">
                    <span className="text-[10px] uppercase font-mono text-[var(--rp-parchment-300)]">Campaign Theme</span>
                    <input
                      value={form.campaign_theme}
                      onChange={(e) => setForm({ ...form, campaign_theme: e.target.value })}
                      placeholder={GENERATE_DEFAULTS.campaign_theme}
                      className="vtt-input w-full text-xs"
                    />
                  </label>
                  <label className="space-y-1 block">
                    <span className="text-[10px] uppercase font-mono text-[var(--rp-parchment-300)]">Primary House</span>
                    <input
                      value={form.primary_house}
                      onChange={(e) => setForm({ ...form, primary_house: e.target.value })}
                      placeholder={GENERATE_DEFAULTS.primary_house}
                      className="vtt-input w-full text-xs"
                    />
                  </label>
                  <label className="space-y-1 block">
                    <span className="text-[10px] uppercase font-mono text-[var(--rp-parchment-300)]">Rival House</span>
                    <input
                      value={form.rival_house}
                      onChange={(e) => setForm({ ...form, rival_house: e.target.value })}
                      placeholder={GENERATE_DEFAULTS.rival_house}
                      className="vtt-input w-full text-xs"
                    />
                  </label>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void handleGenerate()}
                    disabled={generating}
                    className="vtt-btn vtt-btn-primary font-display tracking-wide disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
                    <span>{generating ? 'Generating…' : 'Generate Quest'}</span>
                  </button>
                  {genError && (
                    <span className="text-xs text-[var(--state-danger,crimson)] flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      {genError}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div
                className="border-l-4 border-[var(--rp-leather-600)] bg-[color-mix(in_srgb,var(--rp-leather-600)_8%,transparent)] rounded-r-lg px-3 py-2 text-xs flex items-center space-x-2"
              >
                <Lock className="w-4 h-4 shrink-0" style={{ color: 'var(--rp-leather-600)' }} />
                <span className="text-[var(--rp-parchment-200)]">
                  Quest generation is a GM action. You can view quests the GM has generated at this table.
                </span>
              </div>
            )}

            {quests.length === 0 ? (
              <div className="vtt-parchment rounded-xl p-6 text-center space-y-2">
                <Info className="w-5 h-5 mx-auto" style={{ color: 'var(--statblock-header)', opacity: 0.7 }} />
                <p className="text-sm font-display" style={{ color: 'var(--parchment-ink)' }}>
                  No quest generated yet this session.
                </p>
                <p className="text-xs" style={{ color: 'var(--parchment-ink)', opacity: 0.75 }}>
                  Everything shown here comes from the engine's theme tables via
                  POST /api/v1/quest/generate — nothing is pre-seeded or demo-filled.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-6">
                {/* Generated-graph list */}
                <div className="col-span-1 space-y-2 border-r border-tavern-border pr-4 font-mono text-xs">
                  {quests.map((q) => {
                    const isSelected = !!activeQuest && q.quest_id === activeQuest.quest_id;
                    return (
                      <div
                        key={q.quest_id}
                        onClick={() => {
                          setSelectedQuestId(q.quest_id);
                          globalAudio.playTurnAdvance();
                        }}
                        className={`p-3 rounded-xl border transition cursor-pointer space-y-1 ${
                          isSelected
                            ? 'bg-tavern-surface border-tavern-accent shadow-[0_0_14px_rgba(217,119,6,0.2)]'
                            : 'vtt-surface rounded-xl hover:border-[var(--rp-leather-600)]'
                        }`}
                      >
                        <div className={`font-bold truncate ${isSelected ? 'text-tavern-accent' : 'text-[var(--rp-parchment-100)]'}`}>{q.title}</div>
                        <div className="flex items-center justify-between text-[10px] text-[var(--rp-parchment-300)]">
                          <span>{Object.keys(q.nodes).length} nodes</span>
                          {q.coverage_note && (
                            <span className="uppercase" title={q.coverage_note}>
                              partial
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Selected graph detail */}
                <div className="col-span-2 space-y-4">
                  {activeQuest && (
                    <>
                      <div className="vtt-parchment rounded-xl p-4 space-y-3">
                        <h3
                          className="text-lg font-bold font-display tracking-wide"
                          style={{ color: 'var(--parchment-ink)' }}
                        >
                          {activeQuest.title}
                        </h3>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--parchment-ink)' }}>
                          {activeQuest.summary}
                        </p>

                        {activeQuest.coverage_note && (
                          <div
                            className="rounded-lg px-3 py-2 text-[11px] leading-relaxed flex items-start space-x-2"
                            style={{
                              backgroundColor: 'color-mix(in srgb, var(--rp-crimson-400) 12%, transparent)',
                              color: 'var(--parchment-ink)',
                            }}
                          >
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--rp-crimson-400)' }} />
                            <span>
                              <strong>Coverage note from the engine:</strong> {activeQuest.coverage_note}
                            </span>
                          </div>
                        )}

                        <div
                          className="flex justify-end pt-2"
                          style={{ borderTop: '1px solid var(--rp-leather-700)' }}
                        >
                          <button
                            onClick={() =>
                              handleShare(
                                `📜 Quest Outline (engine-generated): "${activeQuest.title}" — ${Object.keys(activeQuest.nodes).length} nodes`
                              )
                            }
                            className="vtt-btn vtt-btn-primary font-display tracking-wide"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                            <span>Share Outline to Chat</span>
                          </button>
                        </div>
                      </div>

                      {/* DAG nodes, walked forward from initial_node_id */}
                      <div className="space-y-3">
                        <div
                          className="text-xs font-display tracking-wider uppercase flex items-center gap-2"
                          style={{ color: 'var(--statblock-header)' }}
                        >
                          <GitBranch className="w-4 h-4" />
                          Structure ({orderQuestNodes(activeQuest).length} nodes)
                        </div>
                        {orderQuestNodes(activeQuest).map((node, idx) => (
                          <NodeCard key={node.node_id} node={node} index={idx} graph={activeQuest} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            <p className="text-[10px] font-mono text-[var(--rp-parchment-300)] leading-relaxed">
              Rendered from the gateway quest engine (POST /api/v1/quest/generate, GET
              /api/v1/quest/active). This journal holds generated graphs for this session
              only; it does not persist them, and the gateway keeps only its most recent one.
            </p>
          </div>
        )}

        {/* GM Session Notes Tab */}
        {activeTab === 'notes' && (
          <div className="space-y-3">
            {!isGM && (
              <div className="border-l-4 border-[var(--rp-leather-600)] bg-[color-mix(in_srgb,var(--rp-leather-600)_8%,transparent)] rounded-r-lg px-3 py-2 text-xs flex items-center space-x-2">
                <Lock className="w-4 h-4 shrink-0" style={{ color: 'var(--rp-leather-600)' }} />
                <span className="text-[var(--rp-parchment-200)]">
                  Session notes are GM-only.
                </span>
              </div>
            )}
            <div
              className="border-l-4 border-[#d97706] bg-[color-mix(in_srgb,#d97706_10%,transparent)] rounded-r-lg px-3 py-2 text-xs flex items-start space-x-2"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#d97706' }} />
              <span className="text-[var(--rp-parchment-100)] font-bold">
                LOCAL-ONLY: these notes exist solely in this browser tab's memory. They are
                never sent to the server, never written to disk or campaign saves, and are
                erased permanently when you close this modal, refresh, or leave the table.
              </span>
            </div>
            <textarea
              value={sessionNotes}
              onChange={(e) => isGM && setSessionNotes(e.target.value)}
              readOnly={!isGM}
              rows={12}
              placeholder={
                isGM
                  ? 'Scratch notes for the current session — initiative quirks, NPC moods, open threads… (LOCAL-ONLY, not saved)'
                  : ''
              }
              className="vtt-input w-full text-xs leading-relaxed font-mono resize-y"
              aria-label="GM session notes (local-only)"
            />
            <p className="text-[10px] font-mono text-[var(--rp-parchment-300)]">
              {sessionNotes.length} characters · LOCAL-ONLY · no persistence anywhere
            </p>
          </div>
        )}
      </div>
    </ModalShell>
  );
};

/** One DAG node rendered as an in-world document card with its choice edges. */
const NodeCard: React.FC<{
  node: EngineQuestNode;
  index: number;
  graph: QuestGraph;
}> = ({ node, index, graph }) => (
  <div className="vtt-parchment rounded-xl p-3.5 space-y-2.5">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-[10px]" style={{ color: 'var(--parchment-ink)', opacity: 0.55 }}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <span
          className="text-sm font-bold font-display tracking-wide lowercase truncate"
          style={{ fontVariant: 'small-caps', color: 'var(--statblock-header)' }}
        >
          {node.title}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {node.node_id === graph.initial_node_id && (
          <span className="vtt-badge vtt-badge-success uppercase text-[9px]">start</span>
        )}
        <span className={`${nodeBadge(node.node_type)} uppercase text-[9px]`}>
          {node.node_type.replace(/_/g, ' ')}
        </span>
      </div>
    </div>

    <p className="text-xs leading-relaxed" style={{ color: 'var(--parchment-ink)' }}>
      {node.narrative_prompt}
    </p>

    {node.choices.length > 0 && (
      <div className="space-y-1.5 pt-1">
        <div
          className="text-[10px] uppercase tracking-wider font-mono"
          style={{ color: 'var(--parchment-ink)', opacity: 0.65 }}
        >
          Choices
        </div>
        {node.choices.map((choice) => (
          <div
            key={choice.choice_id}
            className="flex items-start justify-between gap-3 p-2 rounded-lg text-xs"
            style={{
              border: '1px solid var(--rp-leather-700)',
              color: 'var(--parchment-ink)',
            }}
          >
            <span className="leading-snug">{choice.prompt_text}</span>
            <span className="shrink-0 flex flex-col items-end gap-1 font-mono text-[10px]" style={{ opacity: 0.85 }}>
              {choice.skill_check_required && (
                <span>
                  {choice.skill_check_required[0]} DC {choice.skill_check_required[1]}
                </span>
              )}
              {(choice.rewards_gold > 0 || choice.rewards_xp > 0) && (
                <span>
                  {choice.rewards_gold > 0 ? `+${choice.rewards_gold} gp` : ''}
                  {choice.rewards_gold > 0 && choice.rewards_xp > 0 ? ' · ' : ''}
                  {choice.rewards_xp > 0 ? `+${choice.rewards_xp} xp` : ''}
                </span>
              )}
              {Object.entries(choice.faction_reputation_deltas).map(([faction, delta]) => (
                <span key={faction}>
                  {delta >= 0 ? '+' : ''}
                  {delta} rep {faction}
                </span>
              ))}
              <span style={{ opacity: 0.6 }}>→ {graph.nodes[choice.target_node_id]?.title ?? choice.target_node_id}</span>
            </span>
          </div>
        ))}
      </div>
    )}
  </div>
);
