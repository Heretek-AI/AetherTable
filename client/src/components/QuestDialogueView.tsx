import React, { useState, useEffect } from 'react';
import {
  Compass,
  GitBranch,
  Shield,
  Award,
  Coins,
  Sparkles,
  CheckCircle,
  AlertTriangle,
  Send,
  RefreshCw,
  Users,
  Scroll,
  ArrowRight,
  Flame,
  Check,
} from 'lucide-react';

interface QuestChoice {
  choice_id: string;
  target_node_id: string;
  prompt_text: string;
  skill_check_required?: [string, number];
  faction_reputation_deltas: Record<string, number>;
  rewards_gold: number;
  rewards_xp: number;
}

interface QuestNode {
  node_id: string;
  node_type: string;
  title: string;
  narrative_prompt: string;
  associated_faction_id?: string;
  choices: QuestChoice[];
}

interface QuestGraph {
  quest_id: string;
  title: string;
  summary: string;
  initial_node_id: string;
  nodes: Record<string, QuestNode>;
}

interface ConcordiaPactResult {
  pact_agreed: boolean;
  final_terms: string;
  house_a_approval: number;
  house_b_approval: number;
  reputation_deltas: Record<string, number>;
  consequence_narrative: string;
}

interface QuestDialogueViewProps {
  onInjectQuest?: (questTitle: string, initialObjective: string) => void;
}

export const QuestDialogueView: React.FC<QuestDialogueViewProps> = ({ onInjectQuest }) => {
  const [quest, setQuest] = useState<QuestGraph | null>(null);
  const [currentNodeId, setCurrentNodeId] = useState<string>('node_hook');
  const [history, setHistory] = useState<string[]>(['node_hook']);
  const [diplomacyRoll, setDiplomacyRoll] = useState<number>(16);
  const [concessions, setConcessions] = useState<string>('Equal trade tariff exemptions and shared mining rights');
  const [pactResult, setPactResult] = useState<ConcordiaPactResult | null>(null);
  const [isNegotiating, setIsNegotiating] = useState<boolean>(false);
  const [injectedSuccess, setInjectedSuccess] = useState<boolean>(false);

  useEffect(() => {
    fetchQuest();
  }, []);

  const fetchQuest = async () => {
    try {
      const res = await fetch('/api/v1/quest/active');
      if (res.ok) {
        const data = await res.json();
        setQuest(data);
        setCurrentNodeId(data.initial_node_id);
        setHistory([data.initial_node_id]);
      }
    } catch (err) {
      console.error('Error fetching quest:', err);
    }
  };

  const handleSelectChoice = (targetNodeId: string) => {
    setCurrentNodeId(targetNodeId);
    setHistory((prev) => [...prev, targetNodeId]);
  };

  const handleNegotiatePact = async () => {
    setIsNegotiating(true);
    try {
      const res = await fetch('/api/v1/quest/concordia-negotiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          house_a: 'House Vane',
          house_b: 'House Silverpeak',
          diplomacy_roll: diplomacyRoll,
          concessions_offered: concessions,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setPactResult(data);
      }
    } catch (err) {
      console.error('Error negotiating treaty:', err);
    } finally {
      setIsNegotiating(false);
    }
  };

  const handleDeployToTabletop = () => {
    if (quest && onInjectQuest) {
      const currentNode = quest.nodes[currentNodeId] || quest.nodes[quest.initial_node_id];
      onInjectQuest(quest.title, currentNode.narrative_prompt);
      setInjectedSuccess(true);
      setTimeout(() => setInjectedSuccess(false), 3500);
    }
  };

  if (!quest) {
    return (
      <div className="flex items-center justify-center p-12 text-[var(--rp-parchment-300)] font-prose">
        <RefreshCw className="w-6 h-6 animate-spin mr-2" /> Loading Quest & Concordia Engine...
      </div>
    );
  }

  const currentNode = quest.nodes[currentNodeId] || quest.nodes[quest.initial_node_id];

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="vtt-glass-panel rounded-xl p-6 relative overflow-hidden">
        <div className="absolute -right-6 -bottom-6 w-36 h-36 bg-tavern-accent/5 rounded-full blur-2xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="p-3 rounded-xl border border-tavern-border bg-[color-mix(in_srgb,var(--tavern-accent)_12%,transparent)] text-tavern-accent shadow-inner">
              <Scroll className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="vtt-engraved text-xl font-bold tracking-wide">{quest.title}</h2>
                <span className="vtt-badge">
                  DAG Quest Tree
                </span>
              </div>
              <p className="selectable-text text-xs text-[var(--rp-parchment-300)] mt-1 max-w-2xl font-prose">{quest.summary}</p>
            </div>
          </div>

          <button
            onClick={handleDeployToTabletop}
            className="vtt-btn vtt-btn-primary active:scale-95 cursor-pointer"
          >
            {injectedSuccess ? (
              <>
                <Check className="w-4 h-4" />
                <span>Injected into Tabletop!</span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span>Deploy Quest to Tabletop</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Grid: Interactive Dialogue Tree & Concordia Console */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Active Quest State & Decision Branches (7 cols) */}
        <div className="lg:col-span-7 space-y-6">
          <div className="vtt-surface rounded-xl p-6 shadow-xl">
            <div className="flex items-center justify-between pb-3 mb-4 gap-3">
              <h3 className="vtt-section-header text-sm">
                <GitBranch className="w-4 h-4 shrink-0" />
                <span>Active Quest Stage</span>
              </h3>
              <span className="vtt-badge shrink-0">
                {currentNode.node_type}
              </span>
            </div>

            {/* NPC Dialogue Line */}
            <div>
              <span className="vtt-inline-trait text-xs">{currentNode.title}</span>
              <div className="vtt-parchment selectable-text mt-1 mb-6 p-4 rounded-lg shadow-inner">
                <p className="text-sm leading-relaxed font-prose italic">"{currentNode.narrative_prompt}"</p>
              </div>
            </div>

            {/* Choices */}
            <div>
              <h4 className="vtt-section-header text-xs mb-3">
                <Compass className="w-3.5 h-3.5 shrink-0" />
                <span>Branching Choices & Decisions</span>
              </h4>

              {currentNode.choices.length === 0 ? (
                <div className="p-4 rounded-lg border border-[color-mix(in_srgb,var(--state-success)_45%,transparent)] bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] text-emerald-300 text-xs flex items-center space-x-2">
                  <CheckCircle className="w-4 h-4" />
                  <span>Questline Stage Complete! Outcome resolved.</span>
                </div>
              ) : (
                <div className="space-y-3">
                  {currentNode.choices.map((choice) => (
                    <button
                      key={choice.choice_id}
                      onClick={() => handleSelectChoice(choice.target_node_id)}
                      className="vtt-btn vtt-btn-secondary w-full p-4 justify-between text-left group cursor-pointer"
                    >
                      <div className="min-w-0">
                        <p className="selectable-text text-xs font-medium text-parchment-paper group-hover:text-tavern-accent transition-colors font-prose leading-relaxed">
                          {choice.prompt_text}
                        </p>

                        <div className="flex flex-wrap items-center gap-2 mt-3 pt-2 border-t border-tavern-border text-[11px]">
                          {choice.skill_check_required && (
                            <span className="vtt-badge">
                              DC {choice.skill_check_required[1]} {choice.skill_check_required[0]}
                            </span>
                          )}
                          {choice.rewards_gold > 0 && (
                            <span className="vtt-badge">
                              <Coins className="w-3 h-3" />
                              +{choice.rewards_gold} gp
                            </span>
                          )}
                          {choice.rewards_xp > 0 && (
                            <span className="vtt-badge">
                              <Award className="w-3 h-3" />
                              +{choice.rewards_xp} XP
                            </span>
                          )}
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-[var(--rp-parchment-300)] group-hover:text-tavern-accent ml-2 shrink-0 transition-transform group-hover:translate-x-0.5" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* History Breadcrumbs */}
            {history.length > 1 && (
              <div className="mt-6 pt-4 border-t border-tavern-border flex items-center space-x-2 text-xs text-[var(--rp-parchment-300)] font-prose">
                <span className="font-semibold text-parchment-paper font-display [font-variant:small-caps] tracking-wide">Timeline:</span>
                <div className="flex items-center space-x-1">
                  {history.map((hid, idx) => (
                    <span
                      key={idx}
                      onClick={() => setCurrentNodeId(hid)}
                      className="cursor-pointer hover:text-tavern-accent hover:underline transition-colors"
                    >
                      {quest.nodes[hid]?.title || hid} {idx < history.length - 1 && '→'}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Concordia Multi-NPC Negotiation Console (5 cols) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="vtt-surface rounded-xl p-6 shadow-xl">
            <h3 className="vtt-section-header text-sm pb-3 mb-4">
              <Users className="w-4 h-4 shrink-0" />
              <span>Concordia Treaty Negotiation</span>
            </h3>

            <p className="text-xs text-[var(--rp-parchment-300)] leading-relaxed mb-4 font-prose">
              Simulate autonomous multi-party negotiations between Noble House leaders. Offer concessions and roll diplomacy checks.
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)] block mb-1">
                  Player Diplomacy / Persuasion Roll (d20 + mod):
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    type="range"
                    min="1"
                    max="30"
                    value={diplomacyRoll}
                    onChange={(e) => setDiplomacyRoll(parseInt(e.target.value))}
                    className="w-full accent-tavern-accent h-1.5 bg-tavern-bg rounded-lg"
                  />
                  <span className="shrink-0 w-10 text-center font-bold text-sm text-tavern-accent font-prose bg-tavern-bg py-1 rounded-lg border border-tavern-border">
                    {diplomacyRoll}
                  </span>
                </div>
              </div>

              <div>
                <label className="text-xs font-display [font-variant:small-caps] tracking-wide text-[var(--rp-parchment-300)] block mb-1">
                  Diplomatic Concessions Offered:
                </label>
                <textarea
                  value={concessions}
                  onChange={(e) => setConcessions(e.target.value)}
                  rows={2}
                  className="vtt-input w-full font-prose"
                />
              </div>

              <button
                onClick={handleNegotiatePact}
                disabled={isNegotiating}
                className="vtt-btn vtt-btn-primary w-full disabled:opacity-50 active:scale-95 cursor-pointer"
              >
                {isNegotiating ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span>Simulate Concordia Multi-NPC Pact</span>
              </button>
            </div>

            {/* Negotiation Results */}
            {pactResult && (
              <div
                className={`mt-5 p-4 rounded-lg border text-xs space-y-2.5 animate-fadeIn ${
                  pactResult.pact_agreed
                    ? 'bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] border-[color-mix(in_srgb,var(--state-success)_45%,transparent)]'
                    : 'bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)]'
                }`}
              >
                <div className="flex items-center justify-between font-bold text-parchment-paper">
                  <span>{pactResult.pact_agreed ? '✔ Treaty Ratified' : '✖ Treaty Rejected'}</span>
                  <span className="font-prose text-[11px] text-[var(--rp-parchment-200)]">
                    Vane: {(pactResult.house_a_approval * 100).toFixed(0)}% | Silverpeak: {(pactResult.house_b_approval * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="selectable-text italic text-[var(--rp-parchment-200)] font-prose leading-relaxed">"{pactResult.consequence_narrative}"</p>
                <div className="pt-1.5 border-t border-tavern-border font-prose text-[11px] text-[var(--rp-parchment-300)]">
                  <span className="text-parchment-paper font-semibold font-display [font-variant:small-caps] tracking-wide">Terms:</span> {pactResult.final_terms}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
