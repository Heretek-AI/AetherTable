import React, { useState } from 'react';
import {
  Music,
  Volume2,
  Play,
  Pause,
  Flame,
  CloudRain,
  Skull,
  Swords,
  Radio,
  Check,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { ModalShell } from './ui/ModalShell';

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

  const tracks: SoundscapeTrack[] = [
    {
      id: 'tavern',
      name: 'Cozy Tavern Hearth',
      category: 'ambient',
      icon: <Flame className="w-5 h-5 text-[var(--tavern-accent)]" />,
      description: 'Crackling hearthfire, warm acoustic lute melodies, and joyful laughter.',
      bpm: 90,
    },
    {
      id: 'storm',
      name: 'Dark Forest Downpour',
      category: 'exploration',
      icon: <CloudRain className="w-5 h-5 text-[var(--rp-parchment-300)]" />,
      description: 'Heavy rainfall on pines, rolling thunderclaps, and howling autumn wind.',
      bpm: 72,
    },
    {
      id: 'crypt',
      name: 'Ancient Crypt Shadows',
      category: 'exploration',
      icon: <Skull className="w-5 h-5 text-[var(--rp-crimson-400)]" />,
      description: 'Distant water droplets, echoing stone scrapes, and chilling eldritch whispers.',
      bpm: 60,
    },
    {
      id: 'boss',
      name: 'Epic Dragon Boss Clash',
      category: 'combat',
      icon: <Swords className="w-5 h-5 text-rose-400" />,
      description: 'Thundering orchestral war drums, brass fanfares, and roaring dragon flames.',
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
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Tactical Jukebox & Ambient Soundscapes"
      subtitle="Immersive multi-layer environmental soundscapes and real-time tabletop soundboard."
      icon={<Music className="w-5 h-5" />}
      size="lg"
      footer={
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-[var(--tavern-accent)] hover:bg-[var(--rp-amber-500)] text-[#1c1207] font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
          >
            Close Jukebox
          </button>
        </div>
      }
    >
      {/* Content Body */}
      <div className="space-y-6">
        {/* Active Soundscape Player Banner */}
        <div className="p-4 bg-[var(--tavern-bg)] rounded-2xl border border-[var(--tavern-border)] flex items-center justify-between shadow-inner">
          <div className="flex items-center space-x-4">
            <button
              onClick={handleTogglePlay}
              aria-label={isPlaying ? 'Pause ambience' : 'Play ambience'}
              className={`w-12 h-12 rounded-xl flex items-center justify-center shadow-lg transition transform active:scale-95 cursor-pointer ${
                isPlaying
                  ? 'bg-[var(--tavern-accent)] hover:bg-[var(--rp-amber-500)] text-[#1c1207]'
                  : 'bg-[var(--tavern-surface)] border border-[var(--tavern-border)] text-[#f5ede0]/70'
              }`}
            >
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 fill-current ml-0.5" />}
            </button>

            <div>
              <div className="flex items-center space-x-2">
                <span className="text-sm font-bold text-[#f5ede0]">
                  {tracks.find((t) => t.id === activeTrackId)?.name}
                </span>
                <span className="px-2 py-0.5 bg-[var(--rp-amber-600)]/20 border border-[var(--tavern-accent)]/40 text-amber-300 text-[10px] font-mono rounded-full uppercase">
                  {isPlaying ? 'PLAYING NOW' : 'PAUSED'}
                </span>
              </div>
              <div className="text-xs text-[#f5ede0]/70 font-mono mt-0.5">
                Tempo: {tracks.find((t) => t.id === activeTrackId)?.bpm} BPM · Atmospheric Loop
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <Volume2 className="w-4 h-4 text-[#f5ede0]/70" />
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
              className="w-28 accent-[var(--tavern-accent)] cursor-pointer"
            />
            <span className="text-xs font-mono text-[#f5ede0]/70 w-8 text-right">{masterVolume}%</span>
          </div>
        </div>

        {/* Soundscape Presets Selection */}
        <div className="space-y-3">
          <div className="vtt-engraved text-xs font-mono font-bold uppercase tracking-wider flex items-center space-x-1.5">
            <Radio className="w-4 h-4 animate-pulse" />
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
                      ? 'bg-[var(--tavern-surface)] border-[var(--tavern-accent)] shadow-md shadow-black/40'
                      : 'bg-[var(--tavern-bg)]/70 border-[var(--tavern-border)] hover:border-[var(--tavern-accent)]/50'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="p-2 rounded-lg bg-[var(--tavern-bg)] border border-[var(--tavern-border)] shadow">
                        {track.icon}
                      </div>
                      <div>
                        <div className="text-xs font-bold text-[#f5ede0]">{track.name}</div>
                        <div className="text-[10px] font-mono text-[#f5ede0]/60 uppercase">{track.category}</div>
                      </div>
                    </div>

                    {isSelected && <Check className="w-4 h-4 text-[var(--tavern-accent)]" />}
                  </div>

                  <p className="text-[11px] text-[#f5ede0]/70 mt-2 font-sans">{track.description}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Multi-Track Audio Faders */}
        <div className="space-y-3">
          <div className="text-xs font-mono font-bold text-[#f5ede0]/70 uppercase tracking-wider">
            Audio Layer Faders
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 bg-[var(--tavern-bg)] rounded-xl border border-[var(--tavern-border)] space-y-2 text-xs font-mono">
              <div className="flex justify-between text-[#f5ede0] font-semibold">
                <span>Ambient</span>
                <span>{ambientVolume}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={ambientVolume}
                onChange={(e) => setAmbientVolume(Number(e.target.value))}
                className="w-full accent-[var(--tavern-accent)] cursor-pointer"
              />
            </div>

            <div className="p-3 bg-[var(--tavern-bg)] rounded-xl border border-[var(--tavern-border)] space-y-2 text-xs font-mono">
              <div className="flex justify-between text-[#f5ede0] font-semibold">
                <span>Combat Music</span>
                <span>{musicVolume}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={musicVolume}
                onChange={(e) => setMusicVolume(Number(e.target.value))}
                className="w-full accent-[var(--tavern-accent)] cursor-pointer"
              />
            </div>

            <div className="p-3 bg-[var(--tavern-bg)] rounded-xl border border-[var(--tavern-border)] space-y-2 text-xs font-mono">
              <div className="flex justify-between text-[#f5ede0] font-semibold">
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
          <div className="text-xs font-mono font-bold text-[#f5ede0]/70 uppercase tracking-wider">
            Instant Soundboard Cues
          </div>

          <div className="grid grid-cols-4 gap-2">
            {soundboardCues.map((cue, idx) => (
              <button
                key={idx}
                onClick={cue.action}
                className="p-2.5 bg-[var(--tavern-bg)] hover:bg-[var(--tavern-surface)] border border-[var(--tavern-border)] hover:border-[var(--rp-amber-600)] rounded-xl text-center transition cursor-pointer flex flex-col items-center justify-center space-y-1 group"
              >
                <span className="text-lg group-hover:scale-125 transition-transform">{cue.icon}</span>
                <span className="text-[10px] font-mono font-bold text-[#f5ede0]/90 group-hover:text-amber-300">
                  {cue.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
