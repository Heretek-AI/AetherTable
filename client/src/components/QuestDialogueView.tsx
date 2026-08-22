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
      <div className="flex items-center justify-center p-12 text-slate-400">
        <RefreshCw className="w-6 h-6 animate-spin mr-2" /> Loading Quest & Concordia Engine...
      </div>
    );
  }

  const currentNode = quest.nodes[currentNodeId] || quest.nodes[quest.initial_node_id];

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl relative overflow-hidden backdrop-blur-sm">
        <div className="absolute -right-6 -bottom-6 w-36 h-36 bg-amber-500/5 rounded-full blur-2xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-amber-950/40 border border-amber-500/30 rounded-xl text-amber-400 shadow-inner">
              <Scroll className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-xl font-bold text-slate-100 tracking-wide">{quest.title}</h2>
                <span className="px-2 py-0.5 text-xs font-semibold bg-amber-900/40 border border-amber-700/50 text-amber-300 rounded">
                  DAG Quest Tree
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1 max-w-2xl">{quest.summary}</p>
            </div>
          </div>

          <button
            onClick={handleDeployToTabletop}
            className="flex items-center space-x-2 px-4 py-2.5 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white text-xs font-semibold rounded-lg shadow-lg shadow-amber-900/30 transition-all border border-amber-500/40 active:scale-95 cursor-pointer"
          >
            {injectedSuccess ? (
              <>
                <Check className="w-4 h-4 text-emerald-300" />
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
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
              <div className="flex items-center space-x-2">
                <GitBranch className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-slate-200">Active Quest Stage</h3>
              </div>
              <span className="text-xs font-mono px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-300 rounded uppercase">
                {currentNode.node_type}
              </span>
            </div>

            {/* Narrative Box */}
            <div className="p-4 bg-slate-950/70 border border-slate-800/80 rounded-lg text-slate-200 text-sm leading-relaxed mb-6 font-serif italic shadow-inner">
              "{currentNode.narrative_prompt}"
            </div>

            {/* Choices */}
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center space-x-1.5">
                <Compass className="w-3.5 h-3.5 text-amber-400" />
                <span>Branching Choices & Decisions</span>
              </h4>

              {currentNode.choices.length === 0 ? (
                <div className="p-4 bg-emerald-950/30 border border-emerald-800/50 rounded-lg text-emerald-300 text-xs flex items-center space-x-2">
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                  <span>Questline Stage Complete! Outcome resolved.</span>
                </div>
              ) : (
                <div className="space-y-3">
                  {currentNode.choices.map((choice) => (
                    <div
                      key={choice.choice_id}
                      onClick={() => handleSelectChoice(choice.target_node_id)}
                      className="p-4 bg-slate-800/60 hover:bg-slate-800/90 border border-slate-700/60 hover:border-amber-500/50 rounded-lg cursor-pointer transition-all group shadow-sm"
                    >
                      <div className="flex items-start justify-between">
                        <p className="text-xs font-medium text-slate-100 group-hover:text-amber-200 transition-colors">
                          {choice.prompt_text}
                        </p>
                        <ArrowRight className="w-4 h-4 text-slate-500 group-hover:text-amber-400 ml-2 mt-0.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </div>

                      <div className="flex flex-wrap items-center gap-2 mt-3 pt-2 border-t border-slate-700/40 text-[11px]">
                        {choice.skill_check_required && (
                          <span className="px-2 py-0.5 bg-indigo-950/50 border border-indigo-700/40 text-indigo-300 rounded font-mono font-medium">
                            DC {choice.skill_check_required[1]} {choice.skill_check_required[0]}
                          </span>
                        )}
                        {choice.rewards_gold > 0 && (
                          <span className="flex items-center space-x-1 text-amber-300 bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/40">
                            <Coins className="w-3 h-3 text-amber-400" />
                            <span>+{choice.rewards_gold} gp</span>
                          </span>
                        )}
                        {choice.rewards_xp > 0 && (
                          <span className="flex items-center space-x-1 text-sky-300 bg-sky-950/40 px-2 py-0.5 rounded border border-sky-800/40">
                            <Award className="w-3 h-3 text-sky-400" />
                            <span>+{choice.rewards_xp} XP</span>
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* History Breadcrumbs */}
            {history.length > 1 && (
              <div className="mt-6 pt-4 border-t border-slate-800 flex items-center space-x-2 text-xs text-slate-400">
                <span className="font-semibold text-slate-500">Timeline:</span>
                <div className="flex items-center space-x-1">
                  {history.map((hid, idx) => (
                    <span
                      key={idx}
                      onClick={() => setCurrentNodeId(hid)}
                      className="cursor-pointer hover:text-amber-300 hover:underline transition-colors"
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
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-6 shadow-xl backdrop-blur-sm">
            <div className="flex items-center space-x-2 border-b border-slate-800 pb-3 mb-4">
              <Users className="w-4 h-4 text-purple-400" />
              <h3 className="text-sm font-bold text-slate-200">Concordia Treaty Negotiation</h3>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              Simulate autonomous multi-party negotiations between Noble House leaders. Offer concessions and roll diplomacy checks.
            </p>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Player Diplomacy / Persuasion Roll (d20 + mod):
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    type="range"
                    min="1"
                    max="30"
                    value={diplomacyRoll}
                    onChange={(e) => setDiplomacyRoll(parseInt(e.target.value))}
                    className="w-full accent-amber-500 h-1.5 bg-slate-700 rounded-lg"
                  />
                  <span className="w-8 text-center font-mono font-bold text-sm text-amber-400 bg-slate-800 py-1 rounded border border-slate-700">
                    {diplomacyRoll}
                  </span>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Diplomatic Concessions Offered:
                </label>
                <textarea
                  value={concessions}
                  onChange={(e) => setConcessions(e.target.value)}
                  rows={2}
                  className="w-full bg-slate-950/70 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                />
              </div>

              <button
                onClick={handleNegotiatePact}
                disabled={isNegotiating}
                className="w-full flex items-center justify-center space-x-2 py-2.5 bg-gradient-to-r from-purple-700 to-indigo-700 hover:from-purple-600 hover:to-indigo-600 text-white text-xs font-semibold rounded-lg shadow-md transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
              >
                {isNegotiating ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 text-purple-200" />
                )}
                <span>Simulate Concordia Multi-NPC Pact</span>
              </button>
            </div>

            {/* Negotiation Results */}
            {pactResult && (
              <div
                className={`mt-5 p-4 rounded-lg border text-xs space-y-2.5 animate-fadeIn ${
                  pactResult.pact_agreed
                    ? 'bg-emerald-950/30 border-emerald-700/50 text-emerald-200'
                    : 'bg-rose-950/30 border-rose-700/50 text-rose-200'
                }`}
              >
                <div className="flex items-center justify-between font-bold">
                  <span>{pactResult.pact_agreed ? '✔ Treaty Ratified' : '✖ Treaty Rejected'}</span>
                  <span className="font-mono text-[11px]">
                    Vane: {(pactResult.house_a_approval * 100).toFixed(0)}% | Silverpeak: {(pactResult.house_b_approval * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="italic text-slate-300 font-serif">"{pactResult.consequence_narrative}"</p>
                <div className="pt-1.5 border-t border-slate-700/40 font-mono text-[11px] text-slate-400">
                  <span className="text-slate-300 font-semibold">Terms:</span> {pactResult.final_terms}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
