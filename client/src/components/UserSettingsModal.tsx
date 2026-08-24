import React, { useState } from 'react';
import {
  User,
  UserRole,
  DiceTheme,
  SubscriptionTier,
} from '../types/auth';
import {
  Settings,
  User as UserIcon,
  Dices,
  Volume2,
  Sliders,
  Check,
} from 'lucide-react';
import { ModalShell } from './ui/ModalShell';

interface UserSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User;
  onUpdateUser: (updated: User) => void;
}

export const UserSettingsModal: React.FC<UserSettingsModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onUpdateUser,
}) => {
  const [activeTab, setActiveTab] = useState<'profile' | 'dice' | 'audio' | 'canvas'>('profile');
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [bio, setBio] = useState(currentUser.bio || '');
  const [diceTheme, setDiceTheme] = useState<DiceTheme>(currentUser.diceTheme || 'gold');
  const [spatialAudioEnabled, setSpatialAudioEnabled] = useState(true);
  const [voiceMode, setVoiceMode] = useState<'ptt' | 'vad'>('vad');
  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = () => {
    onUpdateUser({
      ...currentUser,
      displayName,
      bio,
      diceTheme,
    });
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 1200);
  };

  // Swatch gradients stay as raw material previews (they depict the physical
  // dice shader colours, not UI chrome) but are drawn only on tavern chrome.
  const diceThemes: { id: DiceTheme; name: string; color: string; desc: string }[] = [
    { id: 'gold', name: 'Mythic Gold', color: 'linear-gradient(135deg, var(--rp-amber-500), var(--rp-amber-600))', desc: 'Heroic polished gold with radiant glow.' },
    { id: 'crimson', name: 'Blood Crimson', color: 'linear-gradient(135deg, var(--rp-crimson-400), var(--rp-crimson-700))', desc: 'Fierce lethal red with embers.' },
    { id: 'mithril', name: 'Mithril Blue', color: 'linear-gradient(135deg, #7dd3fc, #4338ca)', desc: 'Arcane mithril with shimmering weave.' },
    { id: 'emerald', name: 'Emerald Poison', color: 'linear-gradient(135deg, #34d399, #0d9488)', desc: 'Venomous jade with acid spark.' },
    { id: 'obsidian', name: 'Arcane Obsidian', color: 'linear-gradient(135deg, var(--rp-leather-600), var(--rp-iron-900))', desc: 'Deep void basalt with purple glyphs.' },
  ];

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="User Preferences & Profile"
      subtitle={`Signed in as ${currentUser.displayName} · ${String(currentUser.role).toUpperCase()}`}
      icon={<Settings className="w-5 h-5" />}
      size="lg"
      footer={
        /* Footer Actions */
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-secondary text-xs"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="vtt-btn vtt-btn-primary font-display tracking-wide"
          >
            {savedSuccess ? <Check className="w-4 h-4" /> : null}
            <span>{savedSuccess ? 'Saved Preferences!' : 'Save Changes'}</span>
          </button>
        </div>
      }
    >
      {/* Content Body with Left Nav Tabs */}
      <div className="grid grid-cols-1 md:grid-cols-12">
          {/* Left Navigation */}
          <nav className="md:col-span-4 border-r border-tavern-border p-3 space-y-1 bg-tavern-bg/40">
            <button
              onClick={() => setActiveTab('profile')}
              data-active={activeTab === 'profile'}
              className="vtt-tab w-full flex items-center justify-start text-left"
            >
              <UserIcon className="w-4 h-4 mr-2" />
              <span>Profile &amp; Identity</span>
            </button>

            <button
              onClick={() => setActiveTab('dice')}
              data-active={activeTab === 'dice'}
              className="vtt-tab w-full flex items-center justify-start text-left"
            >
              <Dices className="w-4 h-4 mr-2" />
              <span>3D Dice Themes</span>
            </button>

            <button
              onClick={() => setActiveTab('audio')}
              data-active={activeTab === 'audio'}
              className="vtt-tab w-full flex items-center justify-start text-left"
            >
              <Volume2 className="w-4 h-4 mr-2" />
              <span>Voice &amp; 3D Audio</span>
            </button>

            <button
              onClick={() => setActiveTab('canvas')}
              data-active={activeTab === 'canvas'}
              className="vtt-tab w-full flex items-center justify-start text-left"
            >
              <Sliders className="w-4 h-4 mr-2" />
              <span>Canvas Preferences</span>
            </button>
          </nav>

          {/* Right Tab Content */}
          <div className="md:col-span-8 p-6 space-y-4 overflow-y-auto max-h-[60vh] vtt-scrollbar">
            {activeTab === 'profile' && (
              <div className="space-y-4">
                <h3 className="vtt-section-header text-sm font-bold">Identity</h3>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Display Name</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="vtt-input w-full text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Email Address (Read-only)</label>
                  <input
                    type="text"
                    disabled
                    value={currentUser.email}
                    className="vtt-input w-full text-xs font-mono opacity-60 cursor-not-allowed"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Character &amp; Player Bio</label>
                  <textarea
                    rows={3}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Describe your character's oath, ancestry, or DM style..."
                    className="vtt-input w-full p-3 text-xs"
                  />
                </div>

                <div className="p-3 rounded-xl vtt-surface flex items-center justify-between text-xs font-mono">
                  <span className="text-[var(--rp-parchment-300)]">Subscription Tier:</span>
                  <span className="vtt-badge">{currentUser.subscriptionTier} Tier</span>
                </div>
              </div>
            )}

            {activeTab === 'dice' && (
              <div className="space-y-3">
                <h3 className="vtt-section-header text-sm font-bold">Dice Material Shaders</h3>
                <p className="text-xs text-[var(--rp-parchment-300)] font-prose">
                  Select your personal 3D dice material shaders rendered on the active tabletop canvas.
                </p>

                <div className="space-y-2">
                  {diceThemes.map((dt) => {
                    const isSelected = diceTheme === dt.id;
                    return (
                      <div
                        key={dt.id}
                        onClick={() => setDiceTheme(dt.id)}
                        role="radio"
                        aria-checked={isSelected}
                        className={`p-3 rounded-xl border transition cursor-pointer flex items-center justify-between ${
                          isSelected
                            ? 'bg-[color-mix(in_srgb,var(--tavern-accent)_10%,transparent)] border-tavern-accent'
                            : 'vtt-card-elevated'
                        }`}
                      >
                        <div className="flex items-center space-x-3">
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-white shadow"
                            style={{ background: dt.color }}
                          >
                            <Dices className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="text-xs font-bold font-display text-[var(--rp-parchment-100)]">{dt.name}</div>
                            <div className="text-[10px] text-[var(--rp-parchment-300)]">{dt.desc}</div>
                          </div>
                        </div>

                        {isSelected && <Check className="w-4 h-4 text-tavern-accent" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'audio' && (
              <div className="space-y-4 text-xs font-mono">
                <h3 className="vtt-section-header text-sm font-bold">Voice &amp; Audio</h3>

                <div className="p-3.5 rounded-xl vtt-surface space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--rp-parchment-100)] font-bold">3D Positional Audio Panning</span>
                    <button
                      onClick={() => setSpatialAudioEnabled(!spatialAudioEnabled)}
                      aria-pressed={spatialAudioEnabled}
                      className={`px-3 py-1 rounded-lg font-bold transition cursor-pointer ${
                        spatialAudioEnabled
                          ? 'bg-[color-mix(in_srgb,var(--state-success)_75%,transparent)] text-white'
                          : 'bg-tavern-bg text-[var(--rp-parchment-300)] border border-tavern-border'
                      }`}
                    >
                      {spatialAudioEnabled ? 'ENABLED' : 'DISABLED'}
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--rp-parchment-300)] font-prose">
                    Spatializes token sound effects and creature roars using Web Audio stereo azimuth and distance roll-off.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl vtt-surface space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--rp-parchment-100)] font-bold">Voice Transmission Mode</span>
                    <div className="vtt-tabbar">
                      <button
                        onClick={() => setVoiceMode('vad')}
                        data-active={voiceMode === 'vad'}
                        className="vtt-tab text-[10px]"
                      >
                        Voice Activity
                      </button>
                      <button
                        onClick={() => setVoiceMode('ptt')}
                        data-active={voiceMode === 'ptt'}
                        className="vtt-tab text-[10px]"
                      >
                        Push-to-Talk (Space)
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'canvas' && (
              <div className="space-y-3 text-xs font-mono">
                <h3 className="vtt-section-header text-sm font-bold">Canvas</h3>

                <div className="p-3 rounded-xl vtt-surface flex items-center justify-between">
                  <span>Grid Snap Sensitivity</span>
                  <span className="text-tavern-accent font-bold">Exact 5ft Cell</span>
                </div>
                <div className="p-3 rounded-xl vtt-surface flex items-center justify-between">
                  <span>Token Elevation Badges</span>
                  <span className="text-emerald-400 font-bold">Visible (+15ft)</span>
                </div>
                <div className="p-3 rounded-xl vtt-surface flex items-center justify-between">
                  <span>Dynamic Lighting Shadows</span>
                  <span className="text-tavern-accent font-bold">Raycast 2D Occlusion</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </ModalShell>
  );
};
