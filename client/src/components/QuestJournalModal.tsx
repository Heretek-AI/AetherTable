import React, { useState } from 'react';
import {
  BookOpen,
  Share2,
  Sparkles,
  Check,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { ModalShell } from './ui/ModalShell';

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

/** Status → printed-book badge variant (failed kept for the type contract). */
const STATUS_BADGE: Record<QuestItem['status'], string> = {
  active: 'vtt-badge',
  completed: 'vtt-badge vtt-badge-success',
  failed: 'vtt-badge vtt-badge-danger',
};

const DISPOSITION_BADGE: Record<NPCDossier['disposition'], string> = {
  friendly: 'vtt-badge vtt-badge-success',
  neutral: 'vtt-badge',
  hostile: 'vtt-badge vtt-badge-danger',
};

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

  const TABS: { id: typeof activeTab; label: string }[] = [
    { id: 'quests', label: `Active Quests (${quests.length})` },
    { id: 'npcs', label: `NPC Dossiers (${npcs.length})` },
    { id: 'chronicles', label: 'Session Chronicles' },
    { id: 'loot', label: 'Party Treasury & Loot' },
  ];

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Campaign Notes & Interactive Quest Journal"
      subtitle="Active quest objectives, NPC dossiers, session chronicles, and party treasury ledger."
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

          {/* Quests Tab */}
          {activeTab === 'quests' && (
            <div className="grid grid-cols-3 gap-6 h-full">
              {/* Quest List — ledger entries on tavern chrome */}
              <div className="col-span-1 space-y-2 border-r border-tavern-border pr-4 font-mono text-xs">
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
                          ? 'bg-tavern-surface border-tavern-accent shadow-[0_0_14px_rgba(217,119,6,0.2)]'
                          : 'vtt-surface rounded-xl hover:border-[var(--rp-leather-600)]'
                      }`}
                    >
                      <div className={`font-bold truncate ${isSelected ? 'text-tavern-accent' : 'text-[var(--rp-parchment-100)]'}`}>{q.title}</div>
                      <div className="flex items-center justify-between text-[10px] text-[var(--rp-parchment-300)]">
                        <span>{q.location}</span>
                        <span className={`${STATUS_BADGE[q.status]} uppercase`}>
                          {q.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Quest Details — the quest prints as an in-world document */}
              <div className="col-span-2 space-y-4 flex flex-col justify-between">
                <div className="space-y-4">
                  <div className="vtt-parchment rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-bold font-display tracking-wide" style={{ color: 'var(--parchment-ink)' }}>
                          {activeQuest.title}
                        </h3>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--parchment-ink)', opacity: 0.75 }}>
                          Giver: <strong className="font-display" style={{ color: 'var(--statblock-header)' }}>{activeQuest.giver}</strong> · Region:{' '}
                          <strong style={{ color: 'var(--parchment-ink)' }}>{activeQuest.location}</strong>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2 text-xs shrink-0">
                        <span className="vtt-badge">🪙 {activeQuest.goldReward} GP</span>
                        <span className="vtt-badge">⭐ {activeQuest.xpReward} XP</span>
                      </div>
                    </div>

                    <p className="text-xs leading-relaxed" style={{ color: 'var(--parchment-ink)' }}>
                      {activeQuest.description}
                    </p>

                    {/* Step Checklist — inked checkboxes: leather ring when
                        open, iron-ink fill once struck through */}
                    <div className="space-y-2">
                      <div
                        className="text-xs font-display tracking-wider uppercase"
                        style={{ color: 'var(--statblock-header)' }}
                      >
                        Objective Steps
                      </div>
                      <div className="space-y-1.5">
                        {activeQuest.steps.map((step, idx) => (
                          <div
                            key={idx}
                            onClick={() => handleToggleStep(idx)}
                            className="flex items-center space-x-2.5 p-2 rounded-lg border cursor-pointer transition text-xs"
                            style={{ borderColor: 'var(--rp-leather-700)' }}
                          >
                            <div
                              className={`w-4 h-4 rounded-full flex items-center justify-center border ${
                                step.done ? '' : 'bg-transparent'
                              }`}
                              style={{
                                borderColor: step.done ? 'var(--rp-leather-700)' : 'var(--rp-leather-600)',
                                backgroundColor: step.done ? 'var(--parchment-ink)' : 'transparent',
                                boxShadow: step.done ? 'inset 0 0 0 1px var(--rp-leather-700)' : undefined,
                              }}
                            >
                              {step.done && <Check className="w-3 h-3" style={{ color: 'var(--parchment-paper)' }} />}
                            </div>
                            <span
                              style={{ color: 'var(--parchment-ink)', opacity: step.done ? 0.55 : 0.95 }}
                              className={step.done ? 'line-through' : ''}
                            >
                              {step.text}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end pt-3 border-t border-tavern-border">
                  <button
                    onClick={() => handleShare(`📜 Quest Update: "${activeQuest.title}" (${activeQuest.status.toUpperCase()})`)}
                    className="vtt-btn vtt-btn-primary font-display tracking-wide"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>Share Quest to Chat</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* NPCs Tab — dossier cards as parchment records */}
          {activeTab === 'npcs' && (
            <div className="grid grid-cols-3 gap-4">
              {npcs.map((npc) => (
                <div key={npc.id} className="vtt-parchment p-4 rounded-xl space-y-2">
                  <div className="flex items-center space-x-2.5">
                    <span className="text-2xl">{npc.avatarIcon}</span>
                    <div>
                      {/* Dossier nameplate — Cinzel small caps crimson, book style */}
                      <div
                        className="text-sm font-bold font-display tracking-wide lowercase"
                        style={{ fontVariant: 'small-caps', color: 'var(--statblock-header)' }}
                      >
                        {npc.name}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--parchment-ink)', opacity: 0.7 }}>
                        {npc.role} · {npc.faction}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--parchment-ink)' }}>{npc.notes}</p>
                  <div className="pt-2 border-t text-[10px]" style={{ borderColor: 'var(--rp-leather-700)', color: 'var(--parchment-ink)', opacity: 0.8 }}>
                    Disposition:{' '}
                    <span className={`${DISPOSITION_BADGE[npc.disposition]} uppercase ml-1`}>
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
                <div key={idx} className="vtt-surface rounded-xl p-3.5 flex items-start space-x-3">
                  <span className="vtt-badge shrink-0 font-mono font-bold">
                    {ch.date}
                  </span>
                  <p className="text-xs text-[var(--rp-parchment-200)] flex-1 mt-0.5">{ch.entry}</p>
                </div>
              ))}
            </div>
          )}

          {/* Party Treasury Tab */}
          {activeTab === 'loot' && (
            <div className="space-y-6">
              {/* Coin Pouch */}
              <div className="grid grid-cols-3 gap-4">
                <div className="vtt-card-elevated rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold font-mono text-tavern-accent">🪙 {loot.gold}</div>
                  <div className="text-xs text-[var(--rp-parchment-300)] font-mono uppercase mt-1">Gold Pieces (GP)</div>
                </div>
                <div className="vtt-card-elevated rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold font-mono text-[var(--rp-parchment-100)]">💎 {loot.platinum}</div>
                  <div className="text-xs text-[var(--rp-parchment-300)] font-mono uppercase mt-1">Platinum Pieces (PP)</div>
                </div>
                <div className="vtt-card-elevated rounded-xl p-4 text-center">
                  <div className="text-2xl font-bold font-mono text-[var(--rp-crimson-400)]">✨ {loot.electrum}</div>
                  <div className="text-xs text-[var(--rp-parchment-300)] font-mono uppercase mt-1">Electrum (EP)</div>
                </div>
              </div>

              {/* Magical Inventory */}
              <div className="space-y-2">
                <div className="vtt-section-header text-xs font-bold">
                  Shared Party Magical Items
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs">
                  {loot.items.map((item, idx) => (
                    <div key={idx} className="vtt-surface rounded-lg p-3 text-[var(--rp-parchment-200)] flex items-center space-x-2">
                      <Sparkles className="w-4 h-4 text-tavern-accent shrink-0" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
    </ModalShell>
  );
};
