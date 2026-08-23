import React, { useState } from 'react';
import {
  Music,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Sliders,
  Sparkles,
  Flame,
  CloudRain,
  Skull,
  Swords,
  X,
  Radio,
  Zap,
  Check,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';

interface SoundscapeJukeboxModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SoundscapeTrack {
  id: string;
  name: string;
  category: 'ambient' | 'combat' | 'exploration';
  icon: React.ReactNode;
  description: string;
  color: string;
  bpm: number;
}

export const SoundscapeJukeboxModal: React.FC<SoundscapeJukeboxModalProps> = ({
  isOpen,
  onClose,
}) => {
  // Backed by the real WebAudio ambience engine (audio_manager.startAmbience).
  // Starts paused: opening the modal must not blast audio uninvited.
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTrackId, setActiveTrackId] = useState<string>('tavern');
  const [masterVolume, setMasterVolume] = useState(80);
  const [ambientVolume, setAmbientVolume] = useState(70);
  const [fxVolume, setFxVolume] = useState(90);
  const [musicVolume, setMusicVolume] = useState(65);

  if (!isOpen) return null;

  const tracks: SoundscapeTrack[] = [
    {
      id: 'tavern',
      name: 'Cozy Tavern Hearth',
      category: 'ambient',
      icon: <Flame className="w-5 h-5 text-amber-400" />,
      description: 'Crackling hearthfire, warm acoustic lute melodies, and joyful laughter.',
      color: 'from-amber-600 to-orange-700',
      bpm: 90,
    },
    {
      id: 'storm',
      name: 'Dark Forest Downpour',
      category: 'exploration',
      icon: <CloudRain className="w-5 h-5 text-sky-400" />,
      description: 'Heavy rainfall on pines, rolling thunderclaps, and howling autumn wind.',
      color: 'from-sky-600 to-indigo-800',
      bpm: 72,
    },
    {
      id: 'crypt',
      name: 'Ancient Crypt Shadows',
      category: 'exploration',
      icon: <Skull className="w-5 h-5 text-purple-400" />,
      description: 'Distant water droplets, echoing stone scrapes, and chilling eldritch whispers.',
      color: 'from-purple-700 to-slate-900',
      bpm: 60,
    },
    {
      id: 'boss',
      name: 'Epic Dragon Boss Clash',
      category: 'combat',
      icon: <Swords className="w-5 h-5 text-rose-400" />,
      description: 'Thundering orchestral war drums, brass fanfares, and roaring dragon flames.',
      color: 'from-rose-600 to-red-800',
      bpm: 140,
    },
  ];

  const soundboardCues = [
    { name: 'Sword Clash', action: () => globalAudio.playWeaponImpact(), icon: '⚔️' },
    { name: 'Spell Cast', action: () => globalAudio.playSpellCast(), icon: '✨' },
    { name: 'Dice Shockwave', action: () => globalAudio.playDiceRoll(), icon: '🎲' },
    { name: 'Victory Fanfare', action: () => globalAudio.playTurnAdvance(), icon: '🎺' },
  ];

  /** Start/stop the synthesised ambience loop for the active preset. */
  const handleTogglePlay = () => {
    if (isPlaying) {
      globalAudio.stopAmbience();
      setIsPlaying(false);
    } else {
      globalAudio.startAmbience(activeTrackId, masterVolume / 100);
      setIsPlaying(true);
    }
  };

  const handleSelectTrack = (id: string) => {
    setActiveTrackId(id);
    // Switching presets while playing crossfades the engine to the new recipe;
    // while paused it just updates the selection.
    if (isPlaying) {
      globalAudio.startAmbience(id, masterVolume / 100);
    }
    globalAudio.playTurnAdvance();
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-xl text-white shadow-lg shadow-purple-950/50">
              <Music className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif tracking-wide text-slate-100">
                Tactical Jukebox & Ambient Soundscapes
              </h2>
              <p className="text-xs text-slate-400">
                Immersive multi-layer environmental soundscapes and real-time tabletop soundboard.
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

        {/* Content Body */}
        <div className="p-6 space-y-6 overflow-y-auto max-h-[60vh]">
          {/* Active Soundscape Player Banner */}
          <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800 flex items-center justify-between shadow-inner">
            <div className="flex items-center space-x-4">
              <button
                onClick={handleTogglePlay}
                className={`w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-lg transition transform active:scale-95 cursor-pointer ${
                  isPlaying ? 'bg-amber-600 shadow-amber-950/50' : 'bg-slate-800 text-slate-400'
                }`}
              >
                {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 fill-white ml-0.5" />}
              </button>

              <div>
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-bold text-slate-100">
                    {tracks.find((t) => t.id === activeTrackId)?.name}
                  </span>
                  <span className="px-2 py-0.5 bg-amber-950/80 border border-amber-600/40 text-amber-300 text-[10px] font-mono rounded-full uppercase">
                    {isPlaying ? 'PLAYING NOW' : 'PAUSED'}
                  </span>
                </div>
                <div className="text-xs text-slate-400 font-mono mt-0.5">
                  Tempo: {tracks.find((t) => t.id === activeTrackId)?.bpm} BPM · Atmospheric Loop
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Volume2 className="w-4 h-4 text-slate-400" />
              <input
                type="range"
                min="0"
                max="100"
                value={masterVolume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMasterVolume(v);
                  // Live update — no need to pause/resume to change loudness.
                  globalAudio.setAmbienceVolume(v / 100);
                }}
                className="w-28 accent-amber-500 cursor-pointer"
              />
              <span className="text-xs font-mono text-slate-400 w-8 text-right">{masterVolume}%</span>
            </div>
          </div>

          {/* Soundscape Presets Selection */}
          <div className="space-y-3">
            <div className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center space-x-1.5">
              <Radio className="w-4 h-4 text-purple-400 animate-pulse" />
              <span>Select Environmental Preset</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {tracks.map((track) => {
                const isSelected = activeTrackId === track.id;
                return (
                  <div
                    key={track.id}
                    onClick={() => handleSelectTrack(track.id)}
                    className={`p-3.5 rounded-xl border transition cursor-pointer flex flex-col justify-between ${
                      isSelected
                        ? 'bg-slate-850 border-amber-500 shadow-md shadow-amber-950/30'
                        : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center space-x-3">
                        <div className={`p-2 rounded-lg bg-slate-900 border border-slate-800 shadow`}>
                          {track.icon}
                        </div>
                        <div>
                          <div className="text-xs font-bold text-slate-100">{track.name}</div>
                          <div className="text-[10px] font-mono text-slate-400 uppercase">{track.category}</div>
                        </div>
                      </div>

                      {isSelected && <Check className="w-4 h-4 text-amber-400" />}
                    </div>

                    <p className="text-[11px] text-slate-400 mt-2 font-sans">{track.description}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Multi-Track Audio Faders */}
          <div className="space-y-3">
            <div className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">
              Audio Layer Faders
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
                <div className="flex justify-between text-slate-300 font-semibold">
                  <span>Ambient</span>
                  <span>{ambientVolume}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={ambientVolume}
                  onChange={(e) => setAmbientVolume(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
              </div>

              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
                <div className="flex justify-between text-slate-300 font-semibold">
                  <span>Combat Music</span>
                  <span>{musicVolume}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={musicVolume}
                  onChange={(e) => setMusicVolume(Number(e.target.value))}
                  className="w-full accent-purple-500 cursor-pointer"
                />
              </div>

              <div className="p-3 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
                <div className="flex justify-between text-slate-300 font-semibold">
                  <span>Effects & Spells</span>
                  <span>{fxVolume}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={fxVolume}
                  onChange={(e) => setFxVolume(Number(e.target.value))}
                  className="w-full accent-emerald-500 cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Soundboard 1-Click Cues */}
          <div className="space-y-3">
            <div className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">
              Instant Soundboard Cues
            </div>

            <div className="grid grid-cols-4 gap-2">
              {soundboardCues.map((cue, idx) => (
                <button
                  key={idx}
                  onClick={cue.action}
                  className="p-2.5 bg-slate-950 hover:bg-slate-850 border border-slate-800 hover:border-amber-500/50 rounded-xl text-center transition cursor-pointer flex flex-col items-center justify-center space-y-1 group"
                >
                  <span className="text-lg group-hover:scale-125 transition-transform">{cue.icon}</span>
                  <span className="text-[10px] font-mono font-bold text-slate-300 group-hover:text-amber-300">
                    {cue.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950/80 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
          >
            Close Jukebox
          </button>
        </div>
      </div>
    </div>
  );
};
