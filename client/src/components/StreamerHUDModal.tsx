import React, { useRef, useState } from 'react';
import { useFocusTrap } from './ui/useFocusTrap';
import {
  Video,
  Radio,
  X,
  Check,
  Tv,
  Send,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';

interface StreamerHUDModalProps {
  isOpen: boolean;
  onClose: () => void;
  onToggleCinematicMode?: (enabled: boolean) => void;
}

export const StreamerHUDModal: React.FC<StreamerHUDModalProps> = ({
  isOpen,
  onClose,
  onToggleCinematicMode,
}) => {
  const [isCinematicActive, setIsCinematicActive] = useState(false);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState('https://discord.com/api/webhooks/1042/aether_stream');
  const [relayCrits, setRelayCrits] = useState(true);
  const [relayDeathSaves, setRelayDeathSaves] = useState(true);
  const [relayBossKills, setRelayBossKills] = useState(true);
  const [testSent, setTestSent] = useState(false);

  if (!isOpen) return null;

  const handleToggleCinematic = () => {
    const next = !isCinematicActive;
    setIsCinematicActive(next);
    globalAudio.playTurnAdvance();
    if (onToggleCinematicMode) onToggleCinematicMode(next);
  };

  const handleSendTestWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    globalAudio.playDiceRoll();
    setTestSent(true);
    setTimeout(() => setTestSent(false), 2500);
  };

  // Shared dialog behavior (ESC dismiss + focus trap) without restructuring
  // this bespoke overlay onto ModalShell — same pattern, ladder z-index.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap({ active: true, containerRef, onEscape: onClose });

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-4" style={{ zIndex: 'var(--z-modal)' }}>
      <div ref={containerRef} tabIndex={-1} role="dialog" aria-modal="true">
      <div className="vtt-glass-panel rounded-2xl max-w-xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col font-sans animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-tavern-border flex items-center justify-between bg-tavern-bg/80">
          <div className="flex items-center space-x-3">
            {/* Flat tavern tile with gold-leaf icon (no cold gradient chrome) */}
            <div className="p-2.5 bg-tavern-bg border border-tavern-border rounded-xl text-tavern-accent">
              <Video className="w-6 h-6" />
            </div>
            <div>
              <h2 className="vtt-engraved text-xl font-bold font-display">
                Streamer Broadcast & Discord Relay
              </h2>
              <p className="text-xs text-[var(--rp-parchment-300)]">
                OBS clean overlay mode, cinematic turn auto-focus, and Discord webhook live roll alerts.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close modal"
            autoFocus  // move keyboard focus into the dialog on open
                        className="p-1.5 text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)] rounded-lg hover:bg-white/10 transition cursor-pointer"
          >
              <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6 overflow-y-auto vtt-scrollbar max-h-[60vh]">
          {/* Cinematic Mode Toggle Card */}
          <div className="p-4 vtt-surface rounded-2xl flex items-center justify-between shadow-inner">
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <Tv className="w-4 h-4 text-tavern-accent" />
                <span className="text-sm font-bold text-[var(--rp-parchment-100)]">Cinematic Broadcast Mode</span>
                {/* State chip — printed-book badge carries the on/off state */}
                <span className={isCinematicActive ? 'vtt-badge vtt-badge-success' : 'vtt-badge'}>
                  {isCinematicActive ? 'ACTIVE' : 'OFF'}
                </span>
              </div>
              <p className="text-xs text-[var(--rp-parchment-300)] font-sans">
                Hides debug bars, telemetry, and administrative chrome for clean OBS window capture.
              </p>
            </div>

            <button
              onClick={handleToggleCinematic}
              className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition cursor-pointer border ${
                isCinematicActive
                  ? 'bg-gradient-to-b from-[var(--rp-amber-500)] to-[var(--rp-amber-600)] text-[var(--rp-ink-900)] border-[color-mix(in_srgb,var(--rp-amber-500)_70%,black)]'
                  : 'vtt-btn-secondary'
              }`}
            >
              {isCinematicActive ? 'ACTIVE (OBS Clean)' : 'Enable Cinematic'}
            </button>
          </div>

          {/* Discord Webhook Relay Form */}
          <form onSubmit={handleSendTestWebhook} className="space-y-4">
            <div
              className="text-xs font-bold uppercase tracking-wider flex items-center space-x-1.5"
              style={{ color: 'var(--tavern-accent)' }}
            >
              <Radio className="w-4 h-4 animate-pulse" />
              <span>Live Discord Webhook Broadcaster</span>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-[var(--rp-parchment-300)]">Discord Channel Webhook URL</label>
              <input
                type="text"
                value={discordWebhookUrl}
                onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                className="vtt-input w-full font-mono text-xs"
              />
            </div>

            {/* Event Checkboxes */}
            <div className="space-y-2 pt-2">
              <label className="flex items-center space-x-2.5 text-xs font-mono text-[var(--rp-parchment-200)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayCrits}
                  onChange={(e) => setRelayCrits(e.target.checked)}
                  className="accent-[var(--tavern-accent)] rounded"
                />
                <span>Broadcast Critical Hits & Fumbles (Natural 20s / 1s)</span>
              </label>

              <label className="flex items-center space-x-2.5 text-xs font-mono text-[var(--rp-parchment-200)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayDeathSaves}
                  onChange={(e) => setRelayDeathSaves(e.target.checked)}
                  className="accent-[var(--tavern-accent)] rounded"
                />
                <span>Broadcast Character Death Saves</span>
              </label>

              <label className="flex items-center space-x-2.5 text-xs font-mono text-[var(--rp-parchment-200)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayBossKills}
                  onChange={(e) => setRelayBossKills(e.target.checked)}
                  className="accent-[var(--tavern-accent)] rounded"
                />
                <span>Broadcast Boss Monster Defeat Fanfares</span>
              </label>
            </div>

            <button
              type="submit"
              className="vtt-btn vtt-btn-secondary font-mono"
            >
              {testSent ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--state-success)' }} /> : <Send className="w-3.5 h-3.5" />}
              <span>{testSent ? 'Test Payload Dispatched to Discord!' : 'Dispatch Test Webhook Alert'}</span>
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="p-4 bg-tavern-bg/80 border-t border-tavern-border flex justify-end">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-primary font-display tracking-wide"
          >
            Save & Close Streamer HUD
          </button>
        </div>
      </div>
      </div>
    </div>
  );
};
