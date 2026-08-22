import React, { useState } from 'react';
import { Shield, Sparkles, AlertOctagon, Activity, Dices, Terminal, Wifi } from 'lucide-react';
import { TacticalCanvas, Token } from './components/TacticalCanvas';
import { InitiativeTracker } from './components/InitiativeTracker';
import { CharacterSheet } from './components/CharacterSheet';
import { NarrativeChat, ChatMessage } from './components/NarrativeChat';
import { SafetyModal } from './components/SafetyModal';

export default function App() {
  const [tokens, setTokens] = useState<Token[]>([
    {
      id: 'token_pc_thorin',
      name: 'Thorin Oakenshield',
      x: 3,
      y: 4,
      hp: 42,
      maxHp: 42,
      ac: 18,
      color: '#3b82f6',
      isPlayer: true,
      avatarIcon: '🛡️',
    },
    {
      id: 'token_pc_lyra',
      name: 'Lyra Moonshadow',
      x: 3,
      y: 5,
      hp: 28,
      maxHp: 28,
      ac: 15,
      color: '#8b5cf6',
      isPlayer: true,
      avatarIcon: '✨',
    },
    {
      id: 'token_orc_warlord',
      name: 'Orc Warlord',
      x: 10,
      y: 4,
      hp: 58,
      maxHp: 58,
      ac: 16,
      color: '#ef4444',
      isPlayer: false,
      avatarIcon: '⚔️',
    },
    {
      id: 'token_goblin_1',
      name: 'Goblin Scout',
      x: 11,
      y: 6,
      hp: 12,
      maxHp: 12,
      ac: 14,
      color: '#f97316',
      isPlayer: false,
      avatarIcon: '🏹',
    },
  ]);

  const [selectedTokenId, setSelectedTokenId] = useState<string | null>('token_pc_thorin');
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [roundNumber, setRoundNumber] = useState(1);
  const [isSafetyOpen, setIsSafetyOpen] = useState(false);
  const [latencyMs, setLatencyMs] = useState(8);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg_1',
      sender: 'Encounter DM (AI)',
      role: 'dm',
      content: 'The heavy iron portcullis slams shut behind you. The ancient dungeon hall echoes with guttering torchlight as the Orc Warlord steps forward, greatsword leveled at your chest.',
      timestamp: '12:00 PM',
    },
    {
      id: 'msg_2',
      sender: 'System Auditor',
      role: 'system',
      content: 'Session #1042 initiated. World invariants active: Conservation Law [OK], Spatial Matrix [OK], Lore Continuity [OK].',
      timestamp: '12:00 PM',
    },
  ]);

  const [spotlightWeights, setSpotlightWeights] = useState<{ [player: string]: number }>({
    Thorin: 0.55,
    Lyra: 0.45,
  });

  const selectedToken = tokens.find((t) => t.id === selectedTokenId) || null;

  const handleTokenMove = (tokenId: string, newX: number, newY: number) => {
    setTokens((prev) =>
      prev.map((t) => (t.id === tokenId ? { ...t, x: newX, y: newY } : t))
    );
    const moved = tokens.find((t) => t.id === tokenId);
    if (moved) {
      addSystemMessage(`${moved.name} moved to coordinate [${String.fromCharCode(65 + newX)}${newY + 1}].`);
    }
  };

  const handleNextTurn = () => {
    const nextIdx = (currentTurnIndex + 1) % tokens.length;
    setCurrentTurnIndex(nextIdx);
    if (nextIdx === 0) {
      setRoundNumber((r) => r + 1);
    }
    const current = tokens[nextIdx];
    setSelectedTokenId(current.id);
    addSystemMessage(`Round ${nextIdx === 0 ? roundNumber + 1 : roundNumber}: It is now ${current.name}'s turn.`);
  };

  const addSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `sys_${Date.now()}`,
        sender: 'Rules Engine',
        role: 'system',
        content: text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleExecuteAttack = (actionName: string, damageFormula: string, damageType: string) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];
    const roll = Math.floor(Math.random() * 20) + 1;
    const attackBonus = 6;
    const totalAttack = roll + attackBonus;
    const isHit = totalAttack >= target.ac;

    let dmg = 0;
    let rolls = [roll];
    if (isHit) {
      const d12 = Math.floor(Math.random() * 12) + 1;
      dmg = d12 + 4;
      rolls = [d12];

      setTokens((prev) =>
        prev.map((t) =>
          t.id === target.id ? { ...t, hp: Math.max(0, t.hp - dmg) } : t
        )
      );
    }

    const narrative = isHit
      ? `Thorin swings with decisive force! The greataxe connects for ${dmg} ${damageType} damage against ${target.name}.`
      : `Thorin lunges forward with ${actionName}, but ${target.name} deflects the blow with their shield!`;

    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: 'Thorin Oakenshield',
        role: 'player',
        content: `I declare ${actionName} against ${target.name}!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails: {
          total: totalAttack,
          expression: `1d20 + ${attackBonus}`,
          rolls: [roll],
        },
      },
      {
        id: `dm_${Date.now() + 1}`,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: narrative,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails: isHit
          ? {
              total: dmg,
              expression: damageFormula,
              rolls,
            }
          : undefined,
      },
    ]);
  };

  const handleCastSpell = (spellId: string, spellName: string, level: number) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];
    const dmg = Math.floor(Math.random() * 24) + 12; // 8d6 fire approx
    setTokens((prev) =>
      prev.map((t) =>
        t.id === target.id ? { ...t, hp: Math.max(0, t.hp - dmg) } : t
      )
    );

    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: 'Lyra Moonshadow',
        role: 'player',
        content: `I channel arcane energy and cast ${spellName} (Level ${level})!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: `dm_${Date.now() + 1}`,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: `A blazing sphere of flame erupts across the chamber! ${target.name} is engulfed in the blast, suffering ${dmg} fire damage.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleRollCheck = (skillName: string, modifier: number, dc: number) => {
    const roll = Math.floor(Math.random() * 20) + 1;
    const total = roll + modifier;
    const passed = total >= dc;

    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Player',
        role: 'player',
        content: `Rolling ${skillName} check (DC ${dc})...`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        diceRollDetails: {
          total,
          expression: `1d20 + ${modifier}`,
          rolls: [roll],
        },
      },
      {
        id: `dm_${Date.now() + 1}`,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: passed
          ? `Success! You successfully execute your ${skillName} attempt with precision.`
          : `Failure. The attempt is thwarted by the treacherous conditions of the catacombs.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleSendMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Player',
        role: 'player',
        content: text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: `dm_${Date.now() + 1}`,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: `The DM acknowledges: "${text}". The dungeon reacts to your presence.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleSafetyRewind = (topic: string) => {
    addSystemMessage(`SAFETY CARD TRIGGERED: Topic '${topic}' flagged. Scene state rewound 1 turn.`);
    setMessages((prev) => [
      ...prev,
      {
        id: `dm_${Date.now()}`,
        sender: 'Director Agent (Safety)',
        role: 'dm',
        content: `The scene shifts smoothly away from the flagged subject. We resume the encounter at the catacomb entrance.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Top Header Navigation Bar */}
      <header className="h-12 border-b border-slate-800 px-4 flex items-center justify-between bg-slate-950/90 backdrop-blur-md z-30">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-bold text-sm tracking-wide text-purple-400">
            <Sparkles className="w-5 h-5 text-purple-400" />
            <span>AI-Native VTT Engine</span>
          </div>
          <span className="text-xs text-slate-500 font-mono">|</span>
          <span className="text-xs font-mono text-slate-300">Campaign: The Fall of Baron Vane</span>
        </div>

        {/* Right Status Indicators & Safety Button */}
        <div className="flex items-center gap-3 font-mono text-xs">
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-md text-emerald-400">
            <Wifi className="w-3.5 h-3.5" />
            <span>CRDT Sync: {latencyMs}ms</span>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-md text-sky-400">
            <Activity className="w-3.5 h-3.5" />
            <span>MCR: 100% · HCI: 1.0</span>
          </div>

          <button
            onClick={() => setIsSafetyOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-md transition shadow-md shadow-rose-950"
          >
            <AlertOctagon className="w-4 h-4" />
            <span>X-CARD</span>
          </button>
        </div>
      </header>

      {/* Main Tabletop Area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left: Initiative Tracker */}
        <InitiativeTracker
          tokens={tokens}
          currentTurnIndex={currentTurnIndex}
          onNextTurn={handleNextTurn}
          onSelectToken={(id) => setSelectedTokenId(id)}
          selectedTokenId={selectedTokenId}
          roundNumber={roundNumber}
        />

        {/* Center: Tactical Battle Map Canvas */}
        <main className="flex-1 h-full relative">
          <TacticalCanvas
            tokens={tokens}
            onTokenMove={handleTokenMove}
            selectedTokenId={selectedTokenId}
            onSelectToken={(id) => setSelectedTokenId(id)}
          />
        </main>

        {/* Right: Character Sheet & Action Deck */}
        <CharacterSheet
          activeToken={selectedToken}
          onExecuteAttack={handleExecuteAttack}
          onCastSpell={handleCastSpell}
          onRollCheck={handleRollCheck}
        />
      </div>

      {/* Bottom: Narrative Chat & Dice Console */}
      <NarrativeChat
        messages={messages}
        onSendMessage={handleSendMessage}
        spotlightWeights={spotlightWeights}
      />

      {/* Safety X-Card Modal */}
      <SafetyModal
        isOpen={isSafetyOpen}
        onClose={() => setIsSafetyOpen(false)}
        onTriggerRewind={handleSafetyRewind}
      />
    </div>
  );
}
