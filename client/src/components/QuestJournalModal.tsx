import React, { useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Clock,
  AlertCircle,
  Users,
  Coins,
  Share2,
  X,
  Plus,
  Sparkles,
  Shield,
  Search,
  Check,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';

export interface QuestItem {
  id: string;
  title: string;
  giver: string;
  location: string;
  status: 'active' | 'completed' | 'failed';
  xpReward: number;
  goldReward: number;
  description: string;
  steps: { text: string; done: boolean }[];
}

export interface NPCDossier {
  id: string;
  name: string;
  role: string;
  faction: string;
  disposition: 'friendly' | 'neutral' | 'hostile';
  notes: string;
  avatarIcon: string;
}

interface QuestJournalModalProps {
  isOpen: boolean;
  onClose: () => void;
  onShareToChat?: (text: string) => void;
}

export const QuestJournalModal: React.FC<QuestJournalModalProps> = ({
  isOpen,
  onClose,
  onShareToChat,
}) => {
  const [activeTab, setActiveTab] = useState<'quests' | 'npcs' | 'chronicles' | 'loot'>('quests');
  const [selectedQuestId, setSelectedQuestId] = useState<string>('q1');
  const [shareAlert, setShareAlert] = useState<string | null>(null);

  const [quests, setQuests] = useState<QuestItem[]>([
    {
      id: 'q1',
      title: "Infiltrate Baron Vane's Corrupted Crypt",
      giver: 'Captain Roderick',
      location: 'The Sunken Catacombs',
      status: 'active',
      xpReward: 2400,
      goldReward: 500,
      description:
        'Venture beneath the manor to stop the necrotic ritual. Destroy the Orc Vanguard and recover the blood-sealed treason parchment.',
      steps: [
        { text: 'Breach the outer iron portcullis', done: true },
        { text: 'Defeat the Orc Warlord & Vanguard', done: false },
        { text: 'Disarm the spiked pit trap at [D4]', done: false },
        { text: 'Recover the Blood-Sealed Decree', done: false },
      ],
    },
    {
      id: 'q2',
      title: 'The Stolen Relic of the Silver Dawn',
      giver: 'High Priestess Althea',
      location: 'Cathedral of Light',
      status: 'completed',
      xpReward: 1200,
      goldReward: 250,
      description: 'Recovered the consecrated chalice from goblin looters in the weeping woods.',
      steps: [
        { text: 'Track goblin tracks to cave', done: true },
        { text: 'Retrieve the Consecrated Chalice', done: true },
        { text: 'Return chalice to Althea', done: true },
      ],
    },
    {
      id: 'q3',
      title: 'The Beast of Blackwood Fen',
      giver: 'Townmaster Klaus',
      location: 'Blackwood Marshes',
      status: 'active',
      xpReward: 1800,
      goldReward: 350,
      description: 'Hunt down the hydra terrorizing trading caravans along the marsh road.',
      steps: [
        { text: 'Investigate damaged merchant wagon', done: true },
        { text: 'Craft fire arrows for hydra heads', done: true },
        { text: 'Slay the 5-headed marsh hydra', done: false },
      ],
    },
  ]);

  const [npcs] = useState<NPCDossier[]>([
    {
      id: 'npc1',
      name: 'Baron Vane',
      role: 'Corrupted Noble',
      faction: 'House Vane',
      disposition: 'hostile',
      notes: 'Pacted with shadow entities to usurp the Crown. Highly dangerous sorcerer.',
      avatarIcon: '👑',
    },
    {
      id: 'npc2',
      name: 'Captain Roderick',
      role: 'Town Guard Captain',
      faction: 'Silver Vanguard',
      disposition: 'friendly',
      notes: 'Loyal ally of the party. Promised 500 gold reward for proof of treason.',
      avatarIcon: '🛡️',
    },
    {
      id: 'npc3',
      name: 'Gorthak the Skullsplitter',
      role: 'Orc Warlord',
      faction: 'Iron Vanguard',
      disposition: 'hostile',
      notes: 'Wields an enchanted greataxe. Commands vanguard in the lower crypts.',
      avatarIcon: '⚔️',
    },
  ]);

  const [chronicles] = useState([
    { date: 'Session #1042', entry: 'Entered the Baron Crypt. Encountered Orc Warlord at the portcullis.' },
    { date: 'Session #1041', entry: 'Discovered the Ancient Cipher of the Iron Lich at the Altar of Torment.' },
    { date: 'Session #1040', entry: 'Interrogated Goblin Scout, learned of hidden passage near brazier.' },
  ]);

  const [loot] = useState({
    gold: 1450,
    platinum: 25,
    electrum: 80,
    items: [
      'Potion of Greater Healing (x2)',
      'Spell Scroll of Fireball (3rd level)',
      'Ring of Protection (+1 AC / Saves)',
      'Boots of Elvenkind',
    ],
  });

  if (!isOpen) return null;

  const activeQuest = quests.find((q) => q.id === selectedQuestId) || quests[0];

  const handleToggleStep = (stepIdx: number) => {
    const updated = quests.map((q) => {
      if (q.id === activeQuest.id) {
        const nextSteps = [...q.steps];
        nextSteps[stepIdx].done = !nextSteps[stepIdx].done;
        return { ...q, steps: nextSteps };
      }
      return q;
    });
    setQuests(updated);
    globalAudio.playTurnAdvance();
  };

  const handleShare = (text: string) => {
    if (onShareToChat) onShareToChat(text);
    globalAudio.playTurnAdvance();
    setShareAlert('Quest details broadcasted to party chat!');
    setTimeout(() => setShareAlert(null), 2500);
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-4xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col font-sans animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-gradient-to-br from-amber-500 to-indigo-600 rounded-xl text-white shadow-lg">
              <BookOpen className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif text-slate-100">
                Campaign Notes & Interactive Quest Journal
              </h2>
              <p className="text-xs text-slate-400">
                Active quest objectives, NPC dossiers, session chronicles, and party treasury ledger.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close modal"
            autoFocus  // move keyboard focus into the dialog on open
                        className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
              <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950 px-6 pt-2 font-mono text-xs space-x-2">
          <button
            onClick={() => setActiveTab('quests')}
            className={`px-4 py-2 border-b-2 font-bold transition cursor-pointer ${
              activeTab === 'quests'
                ? 'border-amber-500 text-amber-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Active Quests ({quests.length})
          </button>
          <button
            onClick={() => setActiveTab('npcs')}
            className={`px-4 py-2 border-b-2 font-bold transition cursor-pointer ${
              activeTab === 'npcs'
                ? 'border-purple-500 text-purple-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            NPC Dossiers ({npcs.length})
          </button>
          <button
            onClick={() => setActiveTab('chronicles')}
            className={`px-4 py-2 border-b-2 font-bold transition cursor-pointer ${
              activeTab === 'chronicles'
                ? 'border-sky-500 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Session Chronicles
          </button>
          <button
            onClick={() => setActiveTab('loot')}
            className={`px-4 py-2 border-b-2 font-bold transition cursor-pointer ${
              activeTab === 'loot'
                ? 'border-emerald-500 text-emerald-300'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Party Treasury & Loot
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1 max-h-[60vh]">
          {shareAlert && (
            <div className="p-2.5 mb-4 bg-emerald-950/80 border border-emerald-600/50 rounded-xl text-xs font-mono text-emerald-300 flex items-center space-x-2 animate-fadeIn">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              <span>{shareAlert}</span>
            </div>
          )}

          {/* Quests Tab */}
          {activeTab === 'quests' && (
            <div className="grid grid-cols-3 gap-6 h-full">
              {/* Quest List */}
              <div className="col-span-1 space-y-2 border-r border-slate-800 pr-4 font-mono text-xs">
                {quests.map((q) => {
                  const isSelected = q.id === activeQuest.id;
                  return (
                    <div
                      key={q.id}
                      onClick={() => {
                        setSelectedQuestId(q.id);
                        globalAudio.playTurnAdvance();
                      }}
                      className={`p-3 rounded-xl border transition cursor-pointer space-y-1 ${
                        isSelected
                          ? 'bg-amber-950/40 border-amber-500 text-amber-200 shadow'
                          : 'bg-slate-950/50 border-slate-800 hover:border-slate-700 text-slate-300'
                      }`}
                    >
                      <div className="font-bold truncate">{q.title}</div>
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span>{q.location}</span>
                        <span
                          className={`px-1.5 py-0.2 rounded font-bold uppercase ${
                            q.status === 'completed'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                              : 'bg-amber-950 text-amber-400 border border-amber-800'
                          }`}
                        >
                          {q.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Quest Details Card */}
              <div className="col-span-2 space-y-4 flex flex-col justify-between">
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-lg font-bold font-serif text-slate-100">{activeQuest.title}</h3>
                      <div className="text-xs text-slate-400 font-mono mt-0.5">
                        Giver: <strong className="text-slate-200">{activeQuest.giver}</strong> · Region:{' '}
                        <strong className="text-slate-200">{activeQuest.location}</strong>
                      </div>
                    </div>

                    <div className="flex items-center space-x-2 text-xs font-mono">
                      <span className="px-2 py-1 bg-amber-950 text-amber-300 border border-amber-800 rounded-lg">
                        🪙 {activeQuest.goldReward} GP
                      </span>
                      <span className="px-2 py-1 bg-purple-950 text-purple-300 border border-purple-800 rounded-lg">
                        ⭐ {activeQuest.xpReward} XP
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed font-sans bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                    {activeQuest.description}
                  </p>

                  {/* Step Checklist */}
                  <div className="space-y-2">
                    <div className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider">
                      Objective Steps
                    </div>
                    <div className="space-y-1.5">
                      {activeQuest.steps.map((step, idx) => (
                        <div
                          key={idx}
                          onClick={() => handleToggleStep(idx)}
                          className="flex items-center space-x-2.5 p-2 bg-slate-950/80 rounded-lg border border-slate-800 hover:border-slate-700 transition cursor-pointer text-xs"
                        >
                          <div
                            className={`w-4 h-4 rounded flex items-center justify-center border ${
                              step.done
                                ? 'bg-emerald-600 border-emerald-500 text-white'
                                : 'border-slate-700 bg-slate-900'
                            }`}
                          >
                            {step.done && <Check className="w-3 h-3" />}
                          </div>
                          <span className={step.done ? 'line-through text-slate-500' : 'text-slate-200'}>
                            {step.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex justify-end pt-3 border-t border-slate-800">
                  <button
                    onClick={() => handleShare(`📜 Quest Update: "${activeQuest.title}" (${activeQuest.status.toUpperCase()})`)}
                    className="flex items-center space-x-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>Share Quest to Chat</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* NPCs Tab */}
          {activeTab === 'npcs' && (
            <div className="grid grid-cols-3 gap-4">
              {npcs.map((npc) => (
                <div key={npc.id} className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex items-center space-x-2.5">
                    <span className="text-2xl">{npc.avatarIcon}</span>
                    <div>
                      <div className="text-sm font-bold text-slate-100">{npc.name}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{npc.role} · {npc.faction}</div>
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 font-sans">{npc.notes}</p>
                  <div className="pt-2 border-t border-slate-800 text-[10px] font-mono">
                    Disposition:{' '}
                    <span
                      className={`font-bold uppercase ${
                        npc.disposition === 'friendly'
                          ? 'text-emerald-400'
                          : npc.disposition === 'neutral'
                          ? 'text-amber-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {npc.disposition}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Session Chronicles Tab */}
          {activeTab === 'chronicles' && (
            <div className="space-y-3">
              {chronicles.map((ch, idx) => (
                <div key={idx} className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 flex items-start space-x-3">
                  <span className="px-2 py-1 bg-sky-950 text-sky-400 border border-sky-800 rounded font-mono text-xs font-bold">
                    {ch.date}
                  </span>
                  <p className="text-xs text-slate-200 font-sans flex-1 mt-0.5">{ch.entry}</p>
                </div>
              ))}
            </div>
          )}

          {/* Party Treasury Tab */}
          {activeTab === 'loot' && (
            <div className="space-y-6">
              {/* Coin Pouch */}
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 bg-amber-950/30 border border-amber-800/50 rounded-xl text-center">
                  <div className="text-2xl font-bold font-mono text-amber-300">🪙 {loot.gold}</div>
                  <div className="text-xs text-slate-400 font-mono uppercase mt-1">Gold Pieces (GP)</div>
                </div>
                <div className="p-4 bg-sky-950/30 border border-sky-800/50 rounded-xl text-center">
                  <div className="text-2xl font-bold font-mono text-sky-300">💎 {loot.platinum}</div>
                  <div className="text-xs text-slate-400 font-mono uppercase mt-1">Platinum Pieces (PP)</div>
                </div>
                <div className="p-4 bg-purple-950/30 border border-purple-800/50 rounded-xl text-center">
                  <div className="text-2xl font-bold font-mono text-purple-300">✨ {loot.electrum}</div>
                  <div className="text-xs text-slate-400 font-mono uppercase mt-1">Electrum (EP)</div>
                </div>
              </div>

              {/* Magical Inventory */}
              <div className="space-y-2">
                <div className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider">
                  Shared Party Magical Items
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs">
                  {loot.items.map((item, idx) => (
                    <div key={idx} className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-slate-300 flex items-center space-x-2">
                      <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950/80 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
          >
            Close Journal
          </button>
        </div>
      </div>
    </div>
  );
};
