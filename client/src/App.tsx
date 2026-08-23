import React, { useState, useRef } from 'react';
import { Navbar, SaaSView } from './components/Navbar';
import { TacticalCanvas, Token } from './components/TacticalCanvas';
import { InitiativeTracker } from './components/InitiativeTracker';
import { CharacterSheet } from './components/CharacterSheet';
import { NarrativeChat, ChatMessage } from './components/NarrativeChat';
import { SafetyModal } from './components/SafetyModal';
import { AudioMixerModal } from './components/AudioMixerModal';
import { CompendiumView } from './components/CompendiumView';
import { CharacterBuilderView } from './components/CharacterBuilderView';
import { EncounterBuilderView } from './components/EncounterBuilderView';
import { LobbyView } from './components/LobbyView';
import { DynastyView } from './components/DynastyView';
import { BundleManagerView } from './components/BundleManagerView';
import { QuestDialogueView } from './components/QuestDialogueView';
import { WfcStudioView } from './components/WfcStudioView';
import { AnalyticsView } from './components/AnalyticsView';
import { LandingPageView } from './components/LandingPageView';
import { MacroQuickbar } from './components/MacroQuickbar';
import { SpellbookModal } from './components/SpellbookModal';
import { SubscriptionModal } from './components/SubscriptionModal';
import { ParticleFXManager } from './render/particle_effects';
import { DiceBox3D } from './render/dice_box_3d';
import { globalSpatialAudio } from './render/spatial_audio';
import { globalWebRTCMesh } from './render/webrtc_mesh';

export function App() {
  const [currentView, setCurrentView] = useState<SaaSView>('tabletop');
  const [campaignTitle, setCampaignTitle] = useState('The Fall of Baron Vane');
  const [isSafetyOpen, setIsSafetyOpen] = useState(false);
  const [isAudioMixerOpen, setIsAudioMixerOpen] = useState(false);
  const [isSpellbookOpen, setIsSpellbookOpen] = useState(false);
  const [isSubscriptionOpen, setIsSubscriptionOpen] = useState(false);
  const [latencyMs, setLatencyMs] = useState(8);
  const [userRole, setUserRole] = useState<'gm' | 'player' | 'spectator'>('gm');

  const [isLeftDockCollapsed, setIsLeftDockCollapsed] = useState(false);
  const [isRightDockCollapsed, setIsRightDockCollapsed] = useState(false);

  const particleFXRef = useRef<ParticleFXManager | null>(null);
  const diceBoxRef = useRef<DiceBox3D | null>(null);

  // Authoritative Tokens
  const [tokens, setTokens] = useState<Token[]>([
    {
      id: 'thorin_1',
      name: 'Thorin Oakenshield',
      x: 4,
      y: 4,
      hp: 42,
      maxHp: 42,
      ac: 18,
      color: '#3b82f6',
      isPlayer: true,
      avatarIconType: 'fighter',
    },
    {
      id: 'lyra_1',
      name: 'Lyra Moonshadow',
      x: 4,
      y: 5,
      hp: 28,
      maxHp: 28,
      ac: 15,
      color: '#8b5cf6',
      isPlayer: true,
      avatarIconType: 'caster',
      elevationFeet: 15,
    },
    {
      id: 'orc_warlord_1',
      name: 'Orc Warlord',
      x: 10,
      y: 4,
      hp: 58,
      maxHp: 58,
      ac: 16,
      color: '#dc2626',
      isPlayer: false,
      avatarIconType: 'boss',
    },
    {
      id: 'goblin_scout_1',
      name: 'Goblin Scout',
      x: 11,
      y: 6,
      hp: 12,
      maxHp: 12,
      ac: 14,
      color: '#f59e0b',
      isPlayer: false,
      avatarIconType: 'scout',
    },
  ]);

  const [customWalls, setCustomWalls] = useState<{ x: number; y: number }[]>([
    { x: 8, y: 2 }, { x: 8, y: 3 }, { x: 8, y: 4 }, { x: 8, y: 5 }, { x: 8, y: 6 },
    { x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 },
  ]);

  const [selectedTokenId, setSelectedTokenId] = useState<string | null>('thorin_1');
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [roundNumber, setRoundNumber] = useState(1);
  const [spotlightWeights, setSpotlightWeights] = useState({ Thorin: 0.55, Lyra: 0.45 });
  const [isStreamingResponse, setIsStreamingResponse] = useState(false);

  // Chat & Narrative Messages
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'msg_init_1',
      sender: 'Encounter DM (AI)',
      role: 'dm',
      content:
        'The ancient stone portcullis drops with a thunderous crash. The Orc Warlord steps forward, greatsword scraping across the crypt flags as torchlight flares in his eyes.',
      timestamp: '12:00 PM',
    },
    {
      id: 'msg_init_2',
      sender: 'Pre-Commit Auditor',
      role: 'system',
      content:
        'Session #1042 authoritative invariants active: [Entity Conservation: OK, Spatial LoS: OK, 3-Tier Lore: OK].',
      timestamp: '12:00 PM',
    },
  ]);

  const selectedToken = tokens.find((t) => t.id === selectedTokenId) || tokens[0];

  const addSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `sys_${Date.now()}`,
        sender: 'System Auditor',
        role: 'system',
        content: text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleTokenMove = (tokenId: string, newX: number, newY: number) => {
    setTokens((prev) =>
      prev.map((t) => (t.id === tokenId ? { ...t, x: newX, y: newY } : t))
    );
    globalWebRTCMesh.updatePeerPosition(tokenId, newX, newY);
  };

  const handleNextTurn = () => {
    const nextIndex = (currentTurnIndex + 1) % tokens.length;
    if (nextIndex === 0) {
      setRoundNumber((r) => r + 1);
    }
    setCurrentTurnIndex(nextIndex);
    setSelectedTokenId(tokens[nextIndex].id);
    globalSpatialAudio.setListenerPosition(tokens[nextIndex].x, tokens[nextIndex].y);
    addSystemMessage(`Turn passed to ${tokens[nextIndex].name} (Round ${nextIndex === 0 ? roundNumber + 1 : roundNumber}).`);
  };

  // SSE Stream Narrative Reader
  const streamNarrativeResponse = async (
    userIntent: string,
    enginePayload: any,
    targetMsgId: string
  ) => {
    setIsStreamingResponse(true);
    try {
      const response = await fetch('/api/v1/orchestrator/narrative/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_intent: userIntent,
          engine_execution_payload: enginePayload,
        }),
      });

      if (!response.body) {
        throw new Error('ReadableStream not supported');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') break;
            try {
              const data = JSON.parse(dataStr);
              if (data.token) {
                accumulatedText += data.token;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === targetMsgId ? { ...m, content: accumulatedText } : m
                  )
                );
              }
            } catch (e) {
              // Non-json chunk
            }
          }
        }
      }
    } catch (e) {
      console.error('SSE Streaming error:', e);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === targetMsgId
            ? { ...m, content: 'The strike lands with authoritative impact.' }
            : m
        )
      );
    } finally {
      setIsStreamingResponse(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === targetMsgId ? { ...m, isStreaming: false } : m))
      );
    }
  };

  const handleExecuteAttack = (actionName: string, damageFormula: string, damageType: string) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];
    const dmg = Math.floor(Math.random() * 12) + 4;
    setTokens((prev) =>
      prev.map((t) =>
        t.id === target.id ? { ...t, hp: Math.max(0, t.hp - dmg) } : t
      )
    );

    // 3D Positional Audio + Particle Shockwave + 3D Dice
    globalSpatialAudio.playSpatialImpact(target.x, target.y);
    if (particleFXRef.current) {
      particleFXRef.current.spawnMeleeImpact((target.x + 0.5) * 60, (target.y + 0.5) * 60);
    }
    if (diceBoxRef.current) {
      diceBoxRef.current.rollDice('d20', 20, (target.x + 0.5) * 60, (target.y + 0.5) * 60);
    }

    const dmMsgId = `dm_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Thorin Oakenshield',
        role: 'player',
        content: `I swing with my ${actionName} (${damageFormula} ${damageType})!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      `I attack ${target.name} with ${actionName}`,
      { action_name: actionName, is_hit: true, total_damage: dmg, is_critical: true },
      dmMsgId
    );
  };

  const handleCastSpell = (spellId: string, spellName: string, level: number) => {
    const target = tokens.find((t) => !t.isPlayer && t.hp > 0) || tokens[2];
    const dmg = Math.floor(Math.random() * 24) + 12;
    setTokens((prev) =>
      prev.map((t) =>
        t.id === target.id ? { ...t, hp: Math.max(0, t.hp - dmg) } : t
      )
    );

    // 3D Positional Audio + Spell Particle Shockwave + 3D Dice
    globalSpatialAudio.playSpatialSpell(target.x, target.y);
    if (particleFXRef.current) {
      particleFXRef.current.spawnFireballShockwave((target.x + 0.5) * 60, (target.y + 0.5) * 60, 220);
    }
    if (diceBoxRef.current) {
      diceBoxRef.current.rollDice('d20', 18, (target.x + 0.5) * 60, (target.y + 0.5) * 60);
    }

    const dmMsgId = `dm_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `msg_${Date.now()}`,
        sender: selectedToken?.name || 'Lyra Moonshadow',
        role: 'player',
        content: `I invoke the arcane weave and unleash ${spellName} (Level ${level})!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      `I cast ${spellName} on ${target.name}`,
      { action_name: spellName, is_hit: true, total_damage: dmg },
      dmMsgId
    );
  };

  const handleRollCheck = (skillName: string, modifier: number, dc: number) => {
    const roll = Math.floor(Math.random() * 20) + 1;
    const total = roll + modifier;
    const passed = total >= dc;

    if (selectedToken) {
      globalSpatialAudio.playSpatialDice(selectedToken.x, selectedToken.y);
    }

    if (diceBoxRef.current && selectedToken) {
      diceBoxRef.current.rollDice('d20', roll, (selectedToken.x + 0.5) * 60, (selectedToken.y + 0.5) * 60);
    }

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
          ? `Success! You execute your ${skillName} attempt with remarkable finesse.`
          : `Failure. The conditions prove too hazardous for your ${skillName} maneuver.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleSendMessage = (text: string) => {
    const dmMsgId = `dm_${Date.now() + 1}`;
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
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      text,
      { action_name: 'Custom Action', is_hit: true, total_damage: 10 },
      dmMsgId
    );
  };

  const handleSafetyRewind = (topic: string) => {
    addSystemMessage(`SAFETY CARD TRIGGERED: Topic '${topic}' flagged. Scene state rewound 1 turn.`);
    setMessages((prev) => [
      ...prev,
      {
        id: `dm_${Date.now()}`,
        sender: 'Director Agent (Safety)',
        role: 'dm',
        content: `The scene shifts smoothly away from '${topic}'. State rewound to preceding stable event.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleSpawnFromCompendium = (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => {
    const newId = `token_spawned_${Date.now()}`;
    const newToken: Token = {
      ...tokenData,
      id: newId,
      x: 7,
      y: 5,
    };
    setTokens((prev) => [...prev, newToken]);
    setSelectedTokenId(newId);
    setCurrentView('tabletop');
    addSystemMessage(`Spawned ${newToken.name} to the battlefield at [H6].`);
  };

  const handleDeployFromBuilder = (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => {
    const newId = `hero_builder_${Date.now()}`;
    const newToken: Token = {
      ...tokenData,
      id: newId,
      x: 3,
      y: 4,
    };
    setTokens((prev) => [...prev, newToken]);
    setSelectedTokenId(newId);
    setCurrentView('tabletop');
    addSystemMessage(`Hero ${newToken.name} crafted in Character Studio and deployed to the battlefield!`);
  };

  const handleDeployFromBundleManager = (tokenData: Omit<Token, 'id' | 'x' | 'y'>) => {
    const newId = `homebrew_${Date.now()}`;
    const newToken: Token = {
      ...tokenData,
      id: newId,
      x: 10,
      y: 7,
    };
    setTokens((prev) => [...prev, newToken]);
    setSelectedTokenId(newId);
    setCurrentView('tabletop');
    addSystemMessage(`Custom Homebrew Creature ${newToken.name} instantiated on the battlefield at [K8]!`);
  };

  const handleLaunchFromLobby = (seatId: string) => {
    if (seatId === 'seat_gm') {
      setUserRole('gm');
      addSystemMessage('Joined session as Game Master (Omniscient view enabled).');
    } else if (seatId === 'seat_spectator') {
      setUserRole('spectator');
      addSystemMessage('Joined session as Spectator.');
    } else {
      setUserRole('player');
      addSystemMessage(`Joined session as Player (Bound to active seat).`);
    }
    setCurrentView('tabletop');
  };

  const handleInjectDynastyLore = (houseName: string, text: string) => {
    addSystemMessage(`DYNASTY LORE ASSERTED: ${text}`);
    setMessages((prev) => [
      ...prev,
      {
        id: `dm_${Date.now()}`,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: `The heralds proclaim the ancient standing of ${houseName}. The current political climate shifts as long-standing bloodline pacts take precedence.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
  };

  const handleInjectQuest = (questTitle: string, initialObjective: string) => {
    setCampaignTitle(questTitle);
    addSystemMessage(`QUEST ACTIVATED: ${questTitle}`);
    setMessages((prev) => [
      ...prev,
      {
        id: `quest_${Date.now()}`,
        sender: 'Campaign Director (AI)',
        role: 'system',
        content: `⚔️ Quest Activated: "${questTitle}"\n\n${initialObjective}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    globalSpatialAudio.playSpatialCreatureRoar(4, 4);
    setCurrentView('tabletop');
  };

  const handleUpdateTokenElevation = (tokenId: string, newElevation: number) => {
    setTokens((prev) =>
      prev.map((t) => (t.id === tokenId ? { ...t, elevationFeet: newElevation } : t))
    );
    addSystemMessage(`Token elevation updated to ${newElevation}ft.`);
  };

  const handleLaunchEncounter = (
    monsters: Omit<Token, 'id' | 'x' | 'y'>[],
    customPositions?: { x: number; y: number }[]
  ) => {
    const newTokens: Token[] = monsters.map((m, idx) => {
      const pos = customPositions && customPositions[idx] ? customPositions[idx] : { x: 8 + (idx % 4), y: 3 + Math.floor(idx / 4) * 2 };
      return {
        ...m,
        id: `encounter_mob_${Date.now()}_${idx}`,
        x: pos.x,
        y: pos.y,
      };
    });

    setTokens((prev) => [...prev.filter((t) => t.isPlayer), ...newTokens]);
    setSelectedTokenId(newTokens[0]?.id || null);
    setCurrentView('tabletop');
    addSystemMessage(`⚔️ ENCOUNTER LAUNCHED: ${newTokens.length} hostile entities deployed to the battlefield!`);
    globalSpatialAudio.playSpatialCreatureRoar(8, 4);
  };

  const handleApplyWfcMap = (matrix: number[][], width: number, height: number) => {
    const newWalls: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (matrix[y][x] === 1) {
          newWalls.push({ x, y });
        }
      }
    }
    setCustomWalls(newWalls);
    setCurrentView('tabletop');
    addSystemMessage(`Applied procedural WFC dungeon layout (${width}x${height} tiles) to active session.`);
  };

  const handleMacroRoll = (
    macroName: string,
    formula: string,
    isWhisper: boolean,
    advDis: 'normal' | 'advantage' | 'disadvantage'
  ) => {
    const d20Roll =
      advDis === 'advantage'
        ? Math.max(Math.floor(Math.random() * 20) + 1, Math.floor(Math.random() * 20) + 1)
        : advDis === 'disadvantage'
        ? Math.min(Math.floor(Math.random() * 20) + 1, Math.floor(Math.random() * 20) + 1)
        : Math.floor(Math.random() * 20) + 1;

    if (diceBoxRef.current) {
      diceBoxRef.current.rollDice('d20', d20Roll, 400, 300);
    }
    if (particleFXRef.current) {
      particleFXRef.current.spawnGoldCritBurst(400, 300, 30);
    }

    const dmMsgId = `dm_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `macro_${Date.now()}`,
        sender: selectedToken?.name || 'Thorin',
        role: 'player',
        content: `🎲 ${isWhisper ? '[WHISPER TO GM] ' : ''}Triggered Macro: ${macroName} (${formula}) [${advDis.toUpperCase()}] -> Result: ${d20Roll + 4}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
      {
        id: dmMsgId,
        sender: 'Encounter DM (AI)',
        role: 'dm',
        content: '...',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isStreaming: true,
      },
    ]);

    streamNarrativeResponse(
      `I execute ${macroName} with result ${d20Roll + 4}`,
      { action_name: macroName, is_hit: true, total_damage: d20Roll + 4 },
      dmMsgId
    );
  };

  const handleCastSpellWithUpcast = (
    spellName: string,
    baseLevel: number,
    castLevel: number,
    damageFormula: string
  ) => {
    handleCastSpell(
      `spell_${spellName.toLowerCase().replace(/ /g, '_')}`,
      `${spellName} (Upcast Lvl ${castLevel})`,
      castLevel
    );
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Top Universal Navbar */}
      <Navbar
        currentView={currentView}
        onSelectView={setCurrentView}
        onOpenSafety={() => setIsSafetyOpen(true)}
        onOpenAudioMixer={() => setIsAudioMixerOpen(true)}
        onOpenSubscription={() => setIsSubscriptionOpen(true)}
        latencyMs={latencyMs}
        campaignName={campaignTitle}
      />

      {/* View Content */}
      <div className="flex-1 flex overflow-hidden relative min-h-0">
        {currentView === 'landing' && (
          <LandingPageView
            onEnterApp={(target) => setCurrentView((target as SaaSView) || 'tabletop')}
            onOpenPricing={() => setIsSubscriptionOpen(true)}
          />
        )}

        {currentView === 'tabletop' && (
          <div className="flex-1 flex flex-col h-full overflow-hidden min-h-0 relative">
            {/* Tabletop Center Workspace */}
            <div className="flex-1 flex overflow-hidden relative min-h-0">
              {/* Left Dock: Initiative Tracker */}
              <InitiativeTracker
                tokens={tokens}
                currentTurnIndex={currentTurnIndex}
                onNextTurn={handleNextTurn}
                onSelectToken={(id) => setSelectedTokenId(id)}
                selectedTokenId={selectedTokenId}
                roundNumber={roundNumber}
                isCollapsed={isLeftDockCollapsed}
                onToggleCollapse={() => setIsLeftDockCollapsed(!isLeftDockCollapsed)}
              />

              {/* Center Tactical Canvas */}
              <main className="flex-1 h-full relative min-h-0 overflow-hidden">
                <TacticalCanvas
                  tokens={tokens}
                  onTokenMove={handleTokenMove}
                  selectedTokenId={selectedTokenId}
                  onSelectToken={(id) => setSelectedTokenId(id)}
                  onUpdateTokenElevation={handleUpdateTokenElevation}
                  walls={customWalls}
                  particleFXRef={particleFXRef}
                  diceBoxRef={diceBoxRef}
                />
              </main>

              {/* Right Dock: Character Sheet */}
              <CharacterSheet
                activeToken={selectedToken}
                onExecuteAttack={handleExecuteAttack}
                onCastSpell={handleCastSpell}
                onRollCheck={handleRollCheck}
                onOpenGrimoire={() => setIsSpellbookOpen(true)}
                isCollapsed={isRightDockCollapsed}
                onToggleCollapse={() => setIsRightDockCollapsed(!isRightDockCollapsed)}
              />
            </div>

            {/* In-Canvas Roll20 Style Macro Quickbar */}
            <MacroQuickbar onExecuteRoll={handleMacroRoll} />

            {/* Bottom Floating Console */}
            <NarrativeChat
              messages={messages}
              onSendMessage={handleSendMessage}
              spotlightWeights={spotlightWeights}
              isStreamingResponse={isStreamingResponse}
            />
          </div>
        )}

        {currentView === 'compendium' && (
          <CompendiumView onSpawnToken={handleSpawnFromCompendium} />
        )}

        {currentView === 'builder' && (
          <CharacterBuilderView onDeployCharacter={handleDeployFromBuilder} />
        )}

        {currentView === 'encounters' && (
          <EncounterBuilderView onLaunchEncounter={handleLaunchEncounter} />
        )}

        {currentView === 'lobby' && (
          <LobbyView onLaunchCampaign={handleLaunchFromLobby} />
        )}

        {currentView === 'dynasty' && (
          <DynastyView onInjectLoreToCampaign={handleInjectDynastyLore} />
        )}

        {currentView === 'bundles' && (
          <BundleManagerView
            tokens={tokens}
            walls={customWalls}
            onDeployToken={handleDeployFromBundleManager}
          />
        )}

        {currentView === 'quests' && (
          <QuestDialogueView onInjectQuest={handleInjectQuest} />
        )}

        {currentView === 'wfc' && (
          <WfcStudioView onApplyMapToSession={handleApplyWfcMap} />
        )}

        {currentView === 'analytics' && (
          <AnalyticsView />
        )}
      </div>

      {/* 3D Spatial Audio & Radar Modal */}
      <AudioMixerModal
        isOpen={isAudioMixerOpen}
        onClose={() => setIsAudioMixerOpen(false)}
        tokens={tokens}
        selectedTokenId={selectedTokenId}
      />

      {/* Hardware Safety X-Card Modal */}
      <SafetyModal
        isOpen={isSafetyOpen}
        onClose={() => setIsSafetyOpen(false)}
        onTriggerRewind={handleSafetyRewind}
      />

      {/* D&D Beyond Digital Grimoire & Upcasting Modal */}
      <SpellbookModal
        isOpen={isSpellbookOpen}
        onClose={() => setIsSpellbookOpen(false)}
        onCastSpellWithUpcast={handleCastSpellWithUpcast}
      />

      {/* SaaS Subscription & Account Profile Modal */}
      <SubscriptionModal
        isOpen={isSubscriptionOpen}
        onClose={() => setIsSubscriptionOpen(false)}
      />
    </div>
  );
}

export default App;
