import React, { useState } from 'react';
import {
  Scroll,
  FileText,
  Eye,
  Lock,
  Share2,
  X,
  Sparkles,
  Search,
  Check,
  Key,
  Shield,
  Send,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';

export interface DigitalHandout {
  id: string;
  title: string;
  category: 'letter' | 'map' | 'cipher' | 'bounty';
  icon: string;
  teaser: string;
  fullText: string;
  revealedTo: 'all' | 'party' | 'gm_only' | string[];
  dateFound: string;
}

interface HandoutManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBroadcastHandout?: (handout: DigitalHandout) => void;
}

const INITIAL_HANDOUTS: DigitalHandout[] = [
  {
    id: 'baron_letter',
    title: "The Baron's Blood-Sealed Orders",
    category: 'letter',
    icon: '📜',
    teaser: 'A treasonous decree bearing the crimson wax seal of Baron Vane.',
    fullText:
      "To Commander Malakor,\n\nEnsure the catacombs remain sealed. The commoners suspect nothing of the shadow pact. If the adventurers breach the outer portcullis, unleash the Golem Titan and let the necrotic flames consume them.\n\n— Baron Vane",
    revealedTo: 'gm_only',
    dateFound: 'Session #1042 · Baron Crypt Entrance',
  },
  {
    id: 'crypt_map',
    title: 'Tattered Parchment Map of the Crypt',
    category: 'map',
    icon: '🗺️',
    teaser: 'Charred parchment detailing secret revolving walls in the lower vault.',
    fullText:
      "The third flagstone from the eastern brazier unlocks the sunken ossuary. Beware the ceiling pressure plates in the Hall of Whispers.",
    revealedTo: 'all',
    dateFound: 'Session #1040 · Looted from Goblin Scout',
  },
  {
    id: 'lich_cipher',
    title: 'Ancient Cipher of the Iron Lich',
    category: 'cipher',
    icon: '🗝️',
    teaser: 'Eldritch runes carved in obsidian slate (DC 15 Arcana to translate).',
    fullText:
      "WHEN THE ECLIPSE ALIGNS WITH THE PYRE OF BONES, THE IRON LICH SHALL DRINK THE SOULS OF THE UNFORGIVEN. THREE KEYS SHALL OPEN THE SANCTUM: BLOOD, ASH, AND TRUTH.",
    revealedTo: 'party',
    dateFound: 'Session #1041 · Altar of Torment',
  },
  {
    id: 'bounty_orc',
    title: 'Bounty Notice: The Orc Warlord',
    category: 'bounty',
    icon: '⚔️',
    teaser: 'Official city guard bounty notice offering 500 gold for his defeat.',
    fullText:
      "WANTED DEAD OR ALIVE: Gorthak the Skullsplitter, Chieftain of the Iron Vanguard. Responsible for raids across the Western Marches. 500 Gold Reward upon presentation of his greatsword.",
    revealedTo: 'all',
    dateFound: 'Session #1038 · Tavern Notice Board',
  },
];

export const HandoutManagerModal: React.FC<HandoutManagerModalProps> = ({
  isOpen,
  onClose,
  onBroadcastHandout,
}) => {
  const [selectedHandoutId, setSelectedHandoutId] = useState<string>('baron_letter');
  const [searchQuery, setSearchQuery] = useState('');
  const [broadcastAlert, setBroadcastAlert] = useState<string | null>(null);
  const [handouts, setHandouts] = useState<DigitalHandout[]>(INITIAL_HANDOUTS);

  if (!isOpen) return null;

  const activeHandout = handouts.find((h) => h.id === selectedHandoutId) || handouts[0];

  const handleShare = (handout: DigitalHandout, target: 'all' | 'party') => {
    const updated = handouts.map((h) =>
      h.id === handout.id ? { ...h, revealedTo: target } : h
    );
    setHandouts(updated);
    globalAudio.playTurnAdvance();
    if (onBroadcastHandout) onBroadcastHandout(handout);

    setBroadcastAlert(`Shared "${handout.title}" with ${target === 'all' ? 'All Table' : 'Party'}!`);
    setTimeout(() => setBroadcastAlert(null), 2500);
  };

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden shadow-2xl flex flex-col font-sans animate-fadeIn">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-gradient-to-br from-amber-600 to-rose-700 rounded-xl text-white shadow-lg">
              <Scroll className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-serif text-slate-100">
                Digital Handouts & Secret Notes Vault
              </h2>
              <p className="text-xs text-slate-400">
                Inspect stylized parchment letters, clue ciphers, and broadcast secrets to the table.
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

        {/* Content Layout: 2 Columns */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Left Column: Handouts List */}
          <div className="w-1/3 border-r border-slate-800 p-4 space-y-2 overflow-y-auto bg-slate-950/50 font-mono text-xs">
            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-2">
              Campaign Clues ({handouts.length})
            </div>

            {handouts.map((h) => {
              const isSelected = h.id === selectedHandoutId;
              return (
                <div
                  key={h.id}
                  onClick={() => {
                    setSelectedHandoutId(h.id);
                    globalAudio.playTurnAdvance();
                  }}
                  className={`p-3 rounded-xl border transition cursor-pointer flex flex-col space-y-1 ${
                    isSelected
                      ? 'bg-amber-950/50 border-amber-500 shadow-md text-amber-200'
                      : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 text-slate-300'
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <span>{h.icon}</span>
                    <span className="font-bold truncate">{h.title}</span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] opacity-70">
                    <span className="uppercase">{h.category}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded ${
                        h.revealedTo === 'gm_only'
                          ? 'bg-rose-950 text-rose-300 border border-rose-800'
                          : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                      }`}
                    >
                      {h.revealedTo === 'gm_only' ? 'GM Only' : 'Revealed'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Column: Stylized Parchment Viewer */}
          <div className="w-2/3 p-6 overflow-y-auto flex flex-col justify-between bg-slate-900">
            {broadcastAlert && (
              <div className="p-2.5 mb-3 bg-emerald-950/80 border border-emerald-600/50 rounded-xl text-xs font-mono text-emerald-300 flex items-center space-x-2 animate-fadeIn">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                <span>{broadcastAlert}</span>
              </div>
            )}

            {/* Parchment Document Frame */}
            <div className="bg-amber-50/95 text-slate-900 p-6 rounded-2xl border-4 border-amber-900/30 shadow-2xl relative font-serif space-y-4">
              <div className="flex items-start justify-between border-b-2 border-amber-900/20 pb-3">
                <div>
                  <h3 className="text-xl font-extrabold text-amber-950 tracking-wide">
                    {activeHandout.title}
                  </h3>
                  <div className="text-[11px] font-mono text-amber-800/80 mt-0.5">
                    {activeHandout.dateFound}
                  </div>
                </div>
                <span className="text-2xl">{activeHandout.icon}</span>
              </div>

              <div className="text-sm leading-relaxed whitespace-pre-line text-amber-950/90 font-serif italic">
                "{activeHandout.fullText}"
              </div>

              <div className="pt-3 border-t border-amber-900/20 flex items-center justify-between text-[11px] font-mono text-amber-900/70">
                <span>Authentic Campaign Relic</span>
                <span>Seal Verified: OK</span>
              </div>
            </div>

            {/* Action Bar */}
            <div className="pt-4 flex items-center justify-between border-t border-slate-800 mt-4">
              <div className="flex items-center space-x-2 text-xs font-mono text-slate-400">
                <Shield className="w-4 h-4 text-amber-400" />
                <span>Current Access: <strong className="text-slate-200">{String(activeHandout.revealedTo)}</strong></span>
              </div>

              <div className="flex items-center space-x-2 font-mono text-xs">
                <button
                  onClick={() => handleShare(activeHandout, 'party')}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition cursor-pointer"
                >
                  Whisper to Party
                </button>
                <button
                  onClick={() => handleShare(activeHandout, 'all')}
                  className="flex items-center space-x-1.5 px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg shadow transition cursor-pointer"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Reveal to All Table</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
