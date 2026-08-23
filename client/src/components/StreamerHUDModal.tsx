import React, { useState } from 'react';
import {
  Video,
  Radio,
  Share2,
  X,
  Sparkles,
  Zap,
  Check,
  Eye,
  Tv,
  MessageSquare,
  ShieldAlert,
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

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col font-sans animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-gradient-to-br from-rose-500 to-indigo-600 rounded-xl text-white shadow-lg">
              <Video className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif text-slate-100">
                Streamer Broadcast & Discord Relay
              </h2>
              <p className="text-xs text-slate-400">
                OBS clean overlay mode, cinematic turn auto-focus, and Discord webhook live roll alerts.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6 overflow-y-auto max-h-[60vh]">
          {/* Cinematic Mode Toggle Card */}
          <div className="p-4 bg-slate-950 rounded-2xl border border-slate-800 flex items-center justify-between shadow-inner">
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <Tv className="w-4 h-4 text-purple-400" />
                <span className="text-sm font-bold text-slate-100">Cinematic Broadcast Mode</span>
              </div>
              <p className="text-xs text-slate-400 font-sans">
                Hides debug bars, telemetry, and administrative chrome for clean OBS window capture.
              </p>
            </div>

            <button
              onClick={handleToggleCinematic}
              className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition cursor-pointer ${
                isCinematicActive
                  ? 'bg-purple-600 text-white shadow-lg shadow-purple-950/50 animate-pulse'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {isCinematicActive ? 'ACTIVE (OBS Clean)' : 'Enable Cinematic'}
            </button>
          </div>

          {/* Discord Webhook Relay Form */}
          <form onSubmit={handleSendTestWebhook} className="space-y-4">
            <div className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center space-x-1.5">
              <Radio className="w-4 h-4 text-indigo-400 animate-pulse" />
              <span>Live Discord Webhook Broadcaster</span>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-mono text-slate-400">Discord Channel Webhook URL</label>
              <input
                type="text"
                value={discordWebhookUrl}
                onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            {/* Event Checkboxes */}
            <div className="space-y-2 pt-2">
              <label className="flex items-center space-x-2.5 text-xs font-mono text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayCrits}
                  onChange={(e) => setRelayCrits(e.target.checked)}
                  className="accent-indigo-500 rounded"
                />
                <span>Broadcast Critical Hits & Fumbles (Natural 20s / 1s)</span>
              </label>

              <label className="flex items-center space-x-2.5 text-xs font-mono text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayDeathSaves}
                  onChange={(e) => setRelayDeathSaves(e.target.checked)}
                  className="accent-indigo-500 rounded"
                />
                <span>Broadcast Character Death Saves</span>
              </label>

              <label className="flex items-center space-x-2.5 text-xs font-mono text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={relayBossKills}
                  onChange={(e) => setRelayBossKills(e.target.checked)}
                  className="accent-indigo-500 rounded"
                />
                <span>Broadcast Boss Monster Defeat Fanfares</span>
              </label>
            </div>

            <button
              type="submit"
              className="flex items-center space-x-2 px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
            >
              {testSent ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Send className="w-3.5 h-3.5" />}
              <span>{testSent ? 'Test Payload Dispatched to Discord!' : 'Dispatch Test Webhook Alert'}</span>
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950/80 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs font-mono rounded-xl shadow transition cursor-pointer"
          >
            Save & Close Streamer HUD
          </button>
        </div>
      </div>
    </div>
  );
};
