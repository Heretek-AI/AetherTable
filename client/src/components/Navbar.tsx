import React, { useState, useRef, useEffect } from 'react';
import { 
  Swords, 
  BookOpen, 
  Dices, 
  LineChart, 
  AlertOctagon, 
  Wifi, 
  Layers, 
  Volume2, 
  VolumeX, 
  CheckCircle2, 
  Sparkles, 
  UserCheck, 
  Users, 
  Crown, 
  Package, 
  Radio, 
  Sliders,
  Scroll,
  Flame,
  Globe,
  Settings,
  ShieldAlert,
  LogOut,
  User as UserIcon,
  ChevronDown,
  ShoppingBag,
  Music,
  Search,
  Command,
  Video,
  Wand2,
  Tv,
  Zap,
  Save,
  Moon,
  Castle,
  Eye,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { User, DEMO_ACCOUNTS } from '../types/auth';
import {
  ATMOSPHERE_PRESETS,
  AtmospherePreset,
  DEFAULT_ATMOSPHERE_ID,
} from '../theme/atmospheres';

export type SaaSView = 'landing' | 'tabletop' | 'compendium' | 'builder' | 'encounters' | 'marketplace' | 'lobby' | 'dynasty' | 'bundles' | 'quests' | 'wfc' | 'analytics' | 'admin';

interface NavbarProps {
  currentView: SaaSView;
  onSelectView: (view: SaaSView) => void;
  onOpenSafety: () => void;
  onOpenAudioMixer?: () => void;
  onOpenJukebox?: () => void;
  /** Active Dynamic Thematic Atmosphere id ('default' = stock palette). */
  activeAtmosphereId?: string;
  /** GM-only: applies a preset to :root + persists it (see theme/atmospheres.ts). */
  onSelectAtmosphere?: (id: string) => void;
  /** False for players/spectators: they see the selection read-only. */
  canManageAtmosphere?: boolean;
  onOpenCommandPalette?: () => void;
  onOpenMapEditor?: () => void;
  onOpenHandouts?: () => void;
  onOpenQuestJournal?: () => void;
  onOpenCampaignSaves?: () => void;
  onToggleVideoMesh?: () => void;
  onOpenStreamerHUD?: () => void;
  onOpenSubscription?: () => void;
  onOpenUserSettings?: () => void;
  onOpenAuth?: () => void;
  onFastSwitchUser?: (user: User) => void;
  currentUser?: User;
  latencyMs: number;
  campaignName: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onSelectView,
  onOpenSafety,
  onOpenAudioMixer,
  onOpenJukebox,
  activeAtmosphereId,
  onSelectAtmosphere,
  canManageAtmosphere,
  onOpenCommandPalette,
  onOpenMapEditor,
  onOpenHandouts,
  onOpenQuestJournal,
  onOpenCampaignSaves,
  onToggleVideoMesh,
  onOpenStreamerHUD,
  onOpenSubscription,
  onOpenUserSettings,
  onOpenAuth,
  onFastSwitchUser,
  currentUser,
  latencyMs,
  campaignName,
}) => {
  const [isMuted, setIsMuted] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState<'compendium' | 'characters' | 'gm_studio' | 'tools' | null>(null);

  const navRef = useRef<HTMLDivElement | null>(null);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setActiveDropdown(null);
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    globalAudio.isMuted = next;
  };

  const handleNavClick = (view: SaaSView) => {
    onSelectView(view);
    setActiveDropdown(null);
    globalAudio.playTurnAdvance();
  };

  const toggleDropdown = (name: 'compendium' | 'characters' | 'gm_studio' | 'tools') => {
    setActiveDropdown((prev) => (prev === name ? null : name));
    globalAudio.playTurnAdvance();
  };

  return (
    <header
      ref={navRef}
      className="h-14 bg-[color-mix(in_srgb,var(--tavern-bg)_95%,transparent)] backdrop-blur-md px-4 flex items-center justify-between shrink-0 select-none shadow-md"
      style={{ zIndex: 'var(--z-chrome)', borderBottom: '1px solid var(--tavern-border)' }}
    >
      {/* Brand & Global Search */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => handleNavClick('landing')}
          className="flex items-center gap-2 hover:opacity-90 transition cursor-pointer text-left group"
          title="Return to SaaS Landing Page"
        >
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-red-600 flex items-center justify-center shadow-lg shadow-amber-950/50 group-hover:scale-105 transition-transform">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 leading-none">
              <span className="vtt-engraved font-extrabold text-sm tracking-tight">
                AetherTable
              </span>
              <span className="text-[9px] uppercase font-mono px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-600/50 font-bold">
                SaaS
              </span>
            </div>
            <span className="text-[10px] text-[var(--rp-parchment-300)] font-mono mt-0.5 truncate max-w-[130px]">
              {campaignName}
            </span>
          </div>
        </button>

        {/* Global Fast Search Command Palette Button */}
        {onOpenCommandPalette && (
          <button
            onClick={onOpenCommandPalette}
            className="hidden md:flex items-center space-x-2 px-2.5 py-1 bg-[var(--tavern-surface)] hover:bg-[var(--rp-leather-700)] border border-[var(--tavern-border)] hover:border-[var(--tavern-accent)]/50 text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] rounded-lg text-xs font-mono transition shadow-inner cursor-pointer"
            title="Open Universal Search Palette (Cmd+K)"
          >
            <Search className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden xl:inline">Search...</span>
            <span className="text-[9px] px-1 py-0.2 bg-black/40 border border-[var(--tavern-border)] text-[var(--rp-parchment-300)] rounded">
              ⌘K
            </span>
          </button>
        )}
      </div>

      {/* Categorized Navigation Dropdown Hub */}
      <nav aria-label="Main Navigation" className="flex items-center space-x-1.5 font-mono text-xs">
        {/* 1. Tactical Tabletop (Direct Link) */}
        <button
          onClick={() => handleNavClick('tabletop')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-bold transition-all cursor-pointer ${
            currentView === 'tabletop'
              ? 'bg-amber-600 text-white shadow-md shadow-amber-950 border border-amber-400/40'
              : 'text-[var(--rp-parchment-200)] hover:text-white hover:bg-[var(--tavern-surface)]'
          }`}
        >
          <Swords className="w-4 h-4 text-amber-400" />
          <span>Tabletop</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-0.5" />
        </button>

        {/* 2. Compendium & Lore Dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('compendium')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold transition cursor-pointer ${
              activeDropdown === 'compendium' || ['compendium', 'bundles', 'dynasty'].includes(currentView)
                ? 'bg-[var(--tavern-surface)] text-[var(--tavern-accent)] border border-[var(--tavern-border)]'
                : 'text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] hover:bg-[var(--tavern-surface)]'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            <span className="hidden xl:inline">Compendium & Lore</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {activeDropdown === 'compendium' && (
            <div className="absolute left-0 top-11 w-56 vtt-glass-panel rounded-xl shadow-2xl p-1.5 animate-fadeIn space-y-1" style={{ zIndex: 'var(--z-popover)' }}>
              <button
                onClick={() => handleNavClick('compendium')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <BookOpen className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="font-bold">Compendium Codex</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">319 Spells & 318 Monsters</div>
                </div>
              </button>

              {onOpenQuestJournal && (
                <button
                  onClick={() => {
                    onOpenQuestJournal();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <BookOpen className="w-4 h-4 text-[var(--rp-parchment-300)] shrink-0" />
                  <div>
                    <div className="font-bold">Quest & Campaign Journal</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Active Objectives & NPC Dossiers</div>
                  </div>
                </button>
              )}

              {onOpenHandouts && (
                <button
                  onClick={() => {
                    onOpenHandouts();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Scroll className="w-4 h-4 text-rose-400 shrink-0" />
                  <div>
                    <div className="font-bold">Digital Handouts Vault</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Parchment Clues & Letters</div>
                  </div>
                </button>
              )}

              <button
                onClick={() => handleNavClick('bundles')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <Package className="w-4 h-4 text-tavern-accent shrink-0" />
                <div>
                  <div className="font-bold">Campaign Bundles</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">.vttbundle Exporter/Importer</div>
                </div>
              </button>

              <button
                onClick={() => handleNavClick('dynasty')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <Crown className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="font-bold">Dynasty & Factions</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Noble Houses & Feud Matrix</div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* 3. Characters & Encounters Dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('characters')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold transition cursor-pointer ${
              activeDropdown === 'characters' || ['builder', 'encounters', 'lobby'].includes(currentView)
                ? 'bg-[var(--tavern-surface)] text-[var(--tavern-accent)] border border-[var(--tavern-border)]'
                : 'text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] hover:bg-[var(--tavern-surface)]'
            }`}
          >
            <UserCheck className="w-4 h-4" />
            <span className="hidden xl:inline">Characters & Party</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {activeDropdown === 'characters' && (
            <div className="absolute left-0 top-11 w-56 vtt-glass-panel rounded-xl shadow-2xl p-1.5 animate-fadeIn space-y-1" style={{ zIndex: 'var(--z-popover)' }}>
              <button
                onClick={() => handleNavClick('builder')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <Sparkles className="w-4 h-4 text-[var(--tavern-accent)] shrink-0" />
                <div>
                  <div className="font-bold">Character Studio</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">5-Step Wizard & Point Buy</div>
                </div>
              </button>

              <button
                onClick={() => handleNavClick('encounters')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <Flame className="w-4 h-4 text-orange-400 shrink-0" />
                <div>
                  <div className="font-bold">Encounter Builder</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">XP Budgets & CR Thresholds</div>
                </div>
              </button>

              <button
                onClick={() => handleNavClick('lobby')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <Users className="w-4 h-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-bold">Campaign Lobby</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Multiplayer Seat Claiming</div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* 4. Marketplace (Direct Link) */}
        <button
          onClick={() => handleNavClick('marketplace')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold transition cursor-pointer ${
            currentView === 'marketplace'
              ? 'bg-amber-600 text-white shadow border border-amber-400/40'
              : 'text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] hover:bg-[var(--tavern-surface)]'
          }`}
        >
          <ShoppingBag className="w-4 h-4 text-emerald-400" />
          <span className="hidden xl:inline">Marketplace</span>
        </button>

        {/* 5. GM World Studio Dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('gm_studio')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl font-semibold transition cursor-pointer ${
              activeDropdown === 'gm_studio' || ['wfc', 'quests', 'analytics', 'admin'].includes(currentView)
                ? 'bg-[var(--tavern-surface)] text-[var(--tavern-accent)] border border-[var(--tavern-border)]'
                : 'text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] hover:bg-[var(--tavern-surface)]'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span className="hidden xl:inline">GM World Studio</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {activeDropdown === 'gm_studio' && (
            <div className="absolute left-0 top-11 w-56 vtt-glass-panel rounded-xl shadow-2xl p-1.5 animate-fadeIn space-y-1" style={{ zIndex: 'var(--z-popover)' }}>
              <button
                onClick={() => handleNavClick('wfc')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <Layers className="w-4 h-4 text-[var(--rp-crimson-400)] shrink-0" />
                <div>
                  <div className="font-bold">WFC Dungeon Studio</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Procedural Dungeon Synthesis</div>
                </div>
              </button>

              <button
                onClick={() => handleNavClick('quests')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <Scroll className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="font-bold">Quest & Dialogue Trees</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Branching Concordia NPC Pacts</div>
                </div>
              </button>

              {onOpenMapEditor && (
                <button
                  onClick={() => {
                    onOpenMapEditor();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <PenToolIcon className="w-4 h-4 text-teal-400 shrink-0" />
                  <div>
                    <div className="font-bold">Map & LoS Editor</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">4-Layer Drawing & Wall Cells</div>
                  </div>
                </button>
              )}

              <button
                onClick={() => handleNavClick('analytics')}
                className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
              >
                <LineChart className="w-4 h-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-bold">SLA Telemetry</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Latency & Reliability Metrics</div>
                </div>
              </button>

              {currentUser?.role === 'admin' && (
                <button
                  onClick={() => handleNavClick('admin')}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-rose-950/50 transition text-rose-300 cursor-pointer border-t border-[var(--tavern-border)] pt-2"
                >
                  <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
                  <div>
                    <div className="font-bold">Admin Console</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Cluster & RBAC Controls</div>
                  </div>
                </button>
              )}
            </div>
          )}
        </div>
      </nav>

      {/* Utilities, Table Tools Hub & User Profile */}
      <div className="flex items-center gap-2">
        {/* Table Tools & Audio Dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('tools')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono transition cursor-pointer ${
              activeDropdown === 'tools'
                ? 'bg-amber-950/80 text-amber-300 border-amber-600/60 shadow'
                : 'bg-[var(--tavern-surface)] text-[var(--rp-parchment-200)] border-[var(--tavern-border)] hover:bg-[var(--rp-leather-700)]'
            }`}
            title="Tabletop Audio, Soundscapes, Map Layers & Streamer Tools"
          >
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden 2xl:inline">Table Tools</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {activeDropdown === 'tools' && (
            <div className="absolute right-0 top-11 w-60 vtt-glass-panel rounded-xl shadow-2xl p-1.5 animate-fadeIn space-y-1 font-mono text-xs" style={{ zIndex: 'var(--z-popover)' }}>
              {onOpenCampaignSaves && (
                <button
                  onClick={() => {
                    onOpenCampaignSaves();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Save className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-bold">Campaign Saves</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Persist & resume sessions</div>
                  </div>
                </button>
              )}

              {onOpenJukebox && (
                <button
                  onClick={() => {
                    onOpenJukebox();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Music className="w-4 h-4 text-[var(--rp-parchment-300)] shrink-0" />
                  <div>
                    <div className="font-bold">Jukebox & Soundscapes</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Ambient multi-track audio</div>
                  </div>
                </button>
              )}

              {/* ── Dynamic Thematic Atmosphere (GOALS.md Pillar 2) ─────────
                  Selecting a preset overrides the semantic palette tokens on
                  :root via a style element (theme/atmospheres.ts) and persists
                  to localStorage.
                  LIMITATION, stated honestly: atmosphere state lives in local
                  React state + this browser's storage only — there is no sync
                  channel, so non-GM clients do NOT receive the host's choice;
                  they see their own locally-applied selection read-only here. */}
              {onSelectAtmosphere && (
                <div className="pt-1 mt-1 border-t border-[var(--tavern-border)]">
                  <div className="flex items-center gap-1.5 px-2 py-1 text-[9px] uppercase tracking-wider font-bold text-[var(--rp-parchment-300)]">
                    <Moon className="w-3 h-3 text-[var(--encounter-token-ring)]" />
                    Table Atmosphere
                    {!canManageAtmosphere && (
                      <span className="ml-auto normal-case tracking-normal text-[8px] text-[var(--rp-parchment-300)]/70">
                        GM-controlled
                      </span>
                    )}
                  </div>

                  {[
                    ...(canManageAtmosphere
                      ? [{ id: DEFAULT_ATMOSPHERE_ID, name: 'Default Obsidian', description: 'Stock tavern & parchment palette' } as Pick<AtmospherePreset, 'id' | 'name' | 'description'>]
                      : []),
                    ...ATMOSPHERE_PRESETS,
                  ].map((preset) => {
                    const isActive = activeAtmosphereId === preset.id;
                    const PresetIcon = ATMOSPHERE_ICONS[preset.id];
                    return (
                      <button
                        key={preset.id}
                        onClick={() => {
                          if (!canManageAtmosphere) return;
                          onSelectAtmosphere(preset.id);
                          setActiveDropdown(null);
                        }}
                        disabled={!canManageAtmosphere && !isActive}
                        title={
                          canManageAtmosphere
                            ? `Apply ${preset.name}`
                            : `${preset.name} — only the GM can change the table atmosphere`
                        }
                        className={`w-full flex items-center space-x-2.5 p-2 rounded-lg text-left transition ${
                          isActive
                            ? 'bg-amber-950/60 text-amber-300'
                            : canManageAtmosphere
                              ? 'hover:bg-[var(--rp-leather-700)] text-[var(--rp-parchment-200)] cursor-pointer'
                              : 'text-[var(--rp-parchment-300)] opacity-70 cursor-default'
                        }`}
                      >
                        {PresetIcon ? (
                          <PresetIcon className="w-4 h-4 shrink-0 text-[var(--encounter-token-ring)]" />
                        ) : (
                          <Moon className="w-4 h-4 shrink-0 text-[var(--rp-parchment-300)]" />
                        )}
                        <div className="min-w-0">
                          <div className="font-bold">{preset.name}</div>
                          <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans truncate">
                            {preset.description}
                          </div>
                        </div>
                        {isActive && <CheckCircle2 className="w-3.5 h-3.5 ml-auto shrink-0 text-emerald-400" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {onOpenMapEditor && (
                <button
                  onClick={() => {
                    onOpenMapEditor();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Layers className="w-4 h-4 text-amber-400 shrink-0" />
                  <div>
                    <div className="font-bold">Map & LoS Layers</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Dynamic lighting editor</div>
                  </div>
                </button>
              )}

              {onOpenHandouts && (
                <button
                  onClick={() => {
                    onOpenHandouts();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Scroll className="w-4 h-4 text-rose-400 shrink-0" />
                  <div>
                    <div className="font-bold">Handouts Vault</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Secret notes & parchment</div>
                  </div>
                </button>
              )}

              {onOpenStreamerHUD && (
                <button
                  onClick={() => {
                    onOpenStreamerHUD();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Video className="w-4 h-4 text-red-400 shrink-0" />
                  <div>
                    <div className="font-bold">Streamer Broadcast Mode</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">OBS clean & Discord webhooks</div>
                  </div>
                </button>
              )}

              {onToggleVideoMesh && (
                <button
                  onClick={() => {
                    onToggleVideoMesh();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Users className="w-4 h-4 text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-bold">WebRTC Video Mesh</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Player camera & audio tiles</div>
                  </div>
                </button>
              )}

              {onOpenAudioMixer && (
                <button
                  onClick={() => {
                    onOpenAudioMixer();
                    setActiveDropdown(null);
                  }}
                  className="w-full flex items-center space-x-2.5 p-2 rounded-lg text-left hover:bg-[var(--rp-leather-700)] transition text-[var(--rp-parchment-200)] cursor-pointer"
                >
                  <Radio className="w-4 h-4 text-[var(--tavern-accent)] shrink-0" />
                  <div>
                    <div className="font-bold">3D Audio Radar</div>
                    <div className="text-[10px] text-[var(--rp-parchment-300)] font-sans">Spatial stereo mixer</div>
                  </div>
                </button>
              )}
            </div>
          )}
        </div>

        {/* User Profile & Multi-User Menu */}
        {currentUser ? (
          <div className="relative">
            <button
              onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
              className="flex items-center space-x-2 p-1.5 bg-[var(--tavern-surface)] hover:bg-[var(--rp-leather-700)] border border-[var(--tavern-border)] hover:border-[var(--tavern-accent)]/60 rounded-xl transition cursor-pointer"
            >
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center text-[var(--rp-ink-900)] font-bold text-xs shadow">
                {currentUser.displayName.charAt(0)}
              </div>
              <div className="hidden lg:flex flex-col text-left">
                <span className="text-[11px] font-bold text-[var(--rp-parchment-100)] leading-none">
                  {currentUser.displayName.split(' ')[0]}
                </span>
                <span className="text-[9px] font-mono text-amber-400 uppercase font-semibold">
                  {currentUser.role}
                </span>
              </div>
              <ChevronDown className="w-3 h-3 text-[var(--rp-parchment-300)]" />
            </button>

            {/* Dropdown Menu */}
            {isUserMenuOpen && (
              <div className="absolute right-0 top-12 w-64 vtt-glass-panel rounded-2xl shadow-2xl p-2 animate-fadeIn space-y-1 font-mono text-xs" style={{ zIndex: 'var(--z-popover)' }}>
                <div className="p-2 border-b border-[var(--tavern-border)] text-left">
                  <div className="font-bold text-[var(--rp-parchment-100)]">{currentUser.displayName}</div>
                  <div className="text-[10px] text-[var(--rp-parchment-300)] truncate">{currentUser.email}</div>
                  <div className="flex items-center space-x-1.5 mt-1">
                    <span className="px-1.5 py-0.2 bg-amber-950 text-amber-300 border border-amber-600/50 rounded text-[9px] font-bold uppercase">
                      {currentUser.role}
                    </span>
                    {/* Subscription badge: aged-leather chip instead of the old violet. */}
                    <span className="px-1.5 py-0.2 bg-[var(--rp-leather-700)] text-[var(--rp-parchment-200)] border border-[var(--rp-amber-600)]/40 rounded text-[9px] font-bold uppercase">
                      {currentUser.subscriptionTier} Tier
                    </span>
                  </div>
                </div>

                {/* Switch Perspective (Multiplayer Simulator) */}
                <div className="p-1 text-[10px] text-[var(--rp-parchment-300)] font-bold uppercase tracking-wider">
                  Switch Client Perspective
                </div>
                {DEMO_ACCOUNTS.map((demo) => (
                  <button
                    key={demo.user.id}
                    onClick={() => {
                      if (onFastSwitchUser) onFastSwitchUser(demo.user);
                      setIsUserMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition cursor-pointer ${
                      currentUser.id === demo.user.id ? 'bg-amber-950/60 text-amber-300 font-bold' : 'hover:bg-[var(--rp-leather-700)] text-[var(--rp-parchment-200)]'
                    }`}
                  >
                    <span>{demo.user.displayName.split(' ')[0]}</span>
                    <span className="text-[9px] opacity-70">[{demo.user.role.toUpperCase()}]</span>
                  </button>
                ))}

                <div className="border-t border-[var(--tavern-border)] pt-1">
                  {onOpenUserSettings && (
                    <button
                      onClick={() => {
                        onOpenUserSettings();
                        setIsUserMenuOpen(false);
                      }}
                      className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-lg text-[var(--rp-parchment-200)] hover:bg-[var(--rp-leather-700)] hover:text-white transition cursor-pointer"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      <span>User Settings</span>
                    </button>
                  )}

                  {currentUser.role === 'admin' && (
                    <button
                      onClick={() => {
                        handleNavClick('admin');
                        setIsUserMenuOpen(false);
                      }}
                      className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-lg text-rose-300 hover:bg-rose-950/60 transition cursor-pointer font-bold"
                    >
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                      <span>Admin Console</span>
                    </button>
                  )}

                  {onOpenAuth && (
                    <button
                      onClick={() => {
                        onOpenAuth();
                        setIsUserMenuOpen(false);
                      }}
                      className="w-full flex items-center space-x-2 px-2 py-1.5 rounded-lg text-[var(--rp-parchment-300)] hover:bg-[var(--rp-leather-700)] hover:text-rose-400 transition cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      <span>Switch Account / Sign Out</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          onOpenAuth && (
            <button
              onClick={onOpenAuth}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs rounded-lg shadow transition cursor-pointer"
            >
              Sign In
            </button>
          )
        )}

        {/* Audio Mute Toggle */}
        <button
          onClick={toggleMute}
          className={`p-1.5 rounded-lg border transition cursor-pointer ${
            isMuted
              ? 'bg-[var(--tavern-surface)] text-rose-400 border-[var(--tavern-border)]'
              : 'bg-[var(--tavern-surface)] text-amber-400 border-[var(--tavern-border)] hover:text-white'
          }`}
          title={isMuted ? 'Unmute Audio Cues' : 'Mute Audio Cues'}
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>

        {/* Live Latency Status */}
        <div className="hidden 2xl:flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/30 border border-[var(--tavern-border)] text-[11px] font-mono text-[var(--rp-parchment-200)] shadow-inner">
          <Wifi className="w-3 h-3 text-emerald-400 animate-pulse" />
          <span>Sync: <strong className="text-emerald-400">{latencyMs}ms</strong></span>
        </div>

        {/* Hardware Safety X-Card */}
        <button
          onClick={onOpenSafety}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-xs font-bold font-mono tracking-wider shadow-lg shadow-rose-950 border border-rose-400/40 transition active:scale-95 cursor-pointer"
          title="Trigger Immediate Scene Rewind"
        >
          <AlertOctagon className="w-3.5 h-3.5" />
          <span>X-CARD</span>
        </button>
      </div>
    </header>
  );
};

// Per-preset glyph for the Atmosphere picker; unknown ids fall back to Moon.
const ATMOSPHERE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'gothic-horror': Castle,
  'high-fantasy': Sparkles,
  'eldritch-mystery': Eye,
};

// Helper icon component for pen/layer tool
function PenToolIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 19 7-7 3 3-7 7-3-3z" />
      <path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
      <path d="m2 2 7.586 7.586" />
      <circle cx="11" cy="11" r="2" />
    </svg>
  );
}
