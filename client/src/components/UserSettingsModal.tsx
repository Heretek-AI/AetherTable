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
  HardDrive,
  Check,
  X,
  Shield,
  Crown,
  Sparkles,
  Radio,
  Eye,
} from 'lucide-react';

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

  if (!isOpen) return null;

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

  const diceThemes: { id: DiceTheme; name: string; color: string; desc: string }[] = [
    { id: 'gold', name: 'Mythic Gold', color: 'from-amber-400 to-amber-600', desc: 'Heroic polished gold with radiant glow.' },
    { id: 'crimson', name: 'Blood Crimson', color: 'from-rose-500 to-red-700', desc: 'Fierce lethal red with embers.' },
    { id: 'mithril', name: 'Mithril Blue', color: 'from-sky-400 to-indigo-600', desc: 'Arcane mithril with shimmering weave.' },
    { id: 'emerald', name: 'Emerald Poison', color: 'from-emerald-400 to-teal-600', desc: 'Venomous jade with acid spark.' },
    { id: 'obsidian', name: 'Arcane Obsidian', color: 'from-slate-700 to-slate-900', desc: 'Deep void basalt with purple glyphs.' },
  ];

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-slate-800 rounded-xl text-slate-300">
              <Settings className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif tracking-wide text-slate-100">
                User Preferences & Profile
              </h2>
              <div className="flex items-center space-x-2 text-xs font-mono mt-0.5">
                <span className="text-amber-400 font-bold">{currentUser.displayName}</span>
                <span className="text-slate-600">•</span>
                <span className="px-1.5 py-0.2 bg-slate-800 text-slate-300 rounded uppercase text-[10px]">
                  {currentUser.role}
                </span>
              </div>
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

        {/* Content Body with Left Nav Tabs */}
        <div className="grid grid-cols-1 md:grid-cols-12 flex-1 overflow-hidden">
          {/* Left Navigation */}
          <div className="md:col-span-4 border-r border-slate-800 p-3 space-y-1 bg-slate-950/40">
            <button
              onClick={() => setActiveTab('profile')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold font-mono transition cursor-pointer ${
                activeTab === 'profile' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:bg-slate-850'
              }`}
            >
              <UserIcon className="w-4 h-4" />
              <span>Profile & Identity</span>
            </button>

            <button
              onClick={() => setActiveTab('dice')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold font-mono transition cursor-pointer ${
                activeTab === 'dice' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:bg-slate-850'
              }`}
            >
              <Dices className="w-4 h-4" />
              <span>3D Dice Themes</span>
            </button>

            <button
              onClick={() => setActiveTab('audio')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold font-mono transition cursor-pointer ${
                activeTab === 'audio' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:bg-slate-850'
              }`}
            >
              <Volume2 className="w-4 h-4" />
              <span>Voice & 3D Audio</span>
            </button>

            <button
              onClick={() => setActiveTab('canvas')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold font-mono transition cursor-pointer ${
                activeTab === 'canvas' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:bg-slate-850'
              }`}
            >
              <Sliders className="w-4 h-4" />
              <span>Canvas Preferences</span>
            </button>
          </div>

          {/* Right Tab Content */}
          <div className="md:col-span-8 p-6 space-y-4 overflow-y-auto max-h-[60vh]">
            {activeTab === 'profile' && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-300">Display Name</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-300">Email Address (Read-only)</label>
                  <input
                    type="text"
                    disabled
                    value={currentUser.email}
                    className="w-full bg-slate-950/50 border border-slate-800 text-slate-500 rounded-lg px-3 py-2 text-xs font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-mono text-slate-300">Character & Player Bio</label>
                  <textarea
                    rows={3}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Describe your character's oath, ancestry, or DM style..."
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-400">Subscription Tier:</span>
                  <span className="px-2 py-0.5 bg-amber-950 border border-amber-600/50 text-amber-300 font-bold rounded uppercase">
                    {currentUser.subscriptionTier} Tier
                  </span>
                </div>
              </div>
            )}

            {activeTab === 'dice' && (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">
                  Select your personal 3D dice material shaders rendered on the active tabletop canvas.
                </p>

                <div className="space-y-2">
                  {diceThemes.map((dt) => {
                    const isSelected = diceTheme === dt.id;
                    return (
                      <div
                        key={dt.id}
                        onClick={() => setDiceTheme(dt.id)}
                        className={`p-3 rounded-xl border transition cursor-pointer flex items-center justify-between ${
                          isSelected
                            ? 'bg-slate-850 border-amber-500 shadow-md shadow-amber-950/30'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center space-x-3">
                          <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${dt.color} flex items-center justify-center font-bold text-white shadow`}>
                            <Dices className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="text-xs font-bold text-slate-200">{dt.name}</div>
                            <div className="text-[10px] text-slate-400">{dt.desc}</div>
                          </div>
                        </div>

                        {isSelected && <Check className="w-4 h-4 text-amber-400" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'audio' && (
              <div className="space-y-4 text-xs font-mono">
                <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300 font-bold">3D Positional Audio Panning</span>
                    <button
                      onClick={() => setSpatialAudioEnabled(!spatialAudioEnabled)}
                      className={`px-3 py-1 rounded-lg font-bold transition cursor-pointer ${
                        spatialAudioEnabled ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {spatialAudioEnabled ? 'ENABLED' : 'DISABLED'}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400 font-sans">
                    Spatializes token sound effects and creature roars using Web Audio stereo azimuth and distance roll-off.
                  </p>
                </div>

                <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-300 font-bold">Voice Transmission Mode</span>
                    <div className="flex space-x-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                      <button
                        onClick={() => setVoiceMode('vad')}
                        className={`px-2 py-1 rounded text-[10px] font-bold ${
                          voiceMode === 'vad' ? 'bg-purple-600 text-white' : 'text-slate-400'
                        }`}
                      >
                        Voice Activity
                      </button>
                      <button
                        onClick={() => setVoiceMode('ptt')}
                        className={`px-2 py-1 rounded text-[10px] font-bold ${
                          voiceMode === 'ptt' ? 'bg-purple-600 text-white' : 'text-slate-400'
                        }`}
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
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
                  <span>Grid Snap Sensitivity</span>
                  <span className="text-amber-400 font-bold">Exact 5ft Cell</span>
                </div>
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
                  <span>Token Elevation Badges</span>
                  <span className="text-emerald-400 font-bold">Visible (+15ft)</span>
                </div>
                <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between">
                  <span>Dynamic Lighting Shadows</span>
                  <span className="text-purple-400 font-bold">Raycast 2D Occlusion</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-slate-950/80 border-t border-slate-800 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center space-x-1.5 px-5 py-2 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white text-xs font-bold rounded-lg shadow-lg shadow-amber-950/60 transition cursor-pointer"
          >
            {savedSuccess ? <Check className="w-4 h-4 text-emerald-300" /> : null}
            <span>{savedSuccess ? 'Saved Preferences!' : 'Save Changes'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
