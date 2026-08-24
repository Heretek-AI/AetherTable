import React, { useState } from 'react';
import { Scroll, Share2, Sparkles, Shield } from 'lucide-react';
import { globalAudio } from '../render/audio_manager';
import { ModalShell } from './ui/ModalShell';

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
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Digital Handouts & Secret Notes Vault"
      subtitle="Inspect stylized parchment letters, clue ciphers, and broadcast secrets to the table."
      icon={<Scroll className="w-5 h-5" />}
      size="lg"
      tone="parchment"
    >
      {/* Content Layout: 2 Columns */}
      <div className="flex min-h-0">
          {/* Left Column: Handouts List (aged-paper ledger rail) */}
          <div className="w-1/3 border-r border-[var(--rp-leather-700)] p-4 space-y-2 overflow-y-auto vtt-scrollbar font-mono text-xs">
            <div
              className="text-[10px] font-bold uppercase tracking-wider mb-2 font-display"
              style={{ color: 'var(--statblock-header)' }}
            >
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
                      ? 'bg-[var(--parchment-paper-aged)] border-tavern-accent shadow-md'
                      : 'border-[color-mix(in_srgb,var(--rp-leather-700)_50%,transparent)] hover:border-[var(--rp-leather-600)]'
                  }`}
                  style={{ color: 'var(--parchment-ink)' }}
                >
                  <div className="flex items-center space-x-2">
                    <span>{h.icon}</span>
                    <span className="font-bold truncate">{h.title}</span>
                  </div>

                  <div className="flex items-center justify-between text-[10px] opacity-80">
                    <span className="uppercase">{h.category}</span>
                    <span
                      className={
                        h.revealedTo === 'gm_only'
                          ? 'vtt-badge vtt-badge-danger'
                          : 'vtt-badge vtt-badge-success'
                      }
                    >
                      {h.revealedTo === 'gm_only' ? 'GM Only' : 'Revealed'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Column: Stylized Parchment Viewer */}
          <div className="w-2/3 p-6 overflow-y-auto flex flex-col justify-between">
            {broadcastAlert && (
              <div className="mb-3 border-l-4 border-[var(--state-success)] bg-[color-mix(in_srgb,var(--state-success)_12%,transparent)] rounded-r-lg px-3 py-2 text-xs flex items-center space-x-2 animate-fadeIn">
                <Sparkles className="w-4 h-4 shrink-0" style={{ color: 'var(--state-success)' }} />
                <span style={{ color: 'var(--parchment-ink)' }}>{broadcastAlert}</span>
              </div>
            )}

            {/* Parchment Document Frame — tokenized rustic surface
                (.vtt-parchment: aged paper gradient, iron frame, candlelight
                edge burn; see index.css component layer). Aged variant so the
                document reads distinct from the parchment shell around it. */}
            <div className="vtt-parchment p-6 rounded-2xl relative space-y-4">
              <div className="flex items-start justify-between border-b-2 pb-3" style={{ borderColor: 'var(--statblock-rule)' }}>
                <div>
                  <h3 className="text-xl font-extrabold tracking-wide font-display" style={{ color: 'var(--parchment-ink)' }}>
                    {activeHandout.title}
                  </h3>
                  <div className="text-[11px] font-mono mt-0.5 opacity-70" style={{ color: 'var(--parchment-ink)' }}>
                    {activeHandout.dateFound}
                  </div>
                </div>
                <span className="text-2xl">{activeHandout.icon}</span>
              </div>

              <div className="text-sm leading-relaxed whitespace-pre-line font-serif italic" style={{ color: 'var(--parchment-ink)' }}>
                "{activeHandout.fullText}"
              </div>

              <div className="pt-3 border-t flex items-center justify-between text-[11px] font-mono opacity-70" style={{ borderColor: 'var(--rp-leather-700)', color: 'var(--parchment-ink)' }}>
                <span>Authentic Campaign Relic</span>
                <span>Seal Verified: OK</span>
              </div>
            </div>

            {/* Action Bar */}
            <div className="pt-4 flex items-center justify-between border-t border-[var(--rp-leather-700)] mt-4">
              <div className="flex items-center space-x-2 text-xs font-mono" style={{ color: 'var(--parchment-ink)', opacity: 0.8 }}>
                <Shield className="w-4 h-4" style={{ color: 'var(--tavern-accent-deep)' }} />
                <span>Current Access: <strong style={{ color: 'var(--parchment-ink)' }}>{String(activeHandout.revealedTo)}</strong></span>
              </div>

              <div className="flex items-center space-x-2 font-mono text-xs">
                {/* Whisper to Party → secondary leather-outline control.
                    Note: this sheet holds no upload/delete flows; its only
                    destructive-capable action (reveal) is intentionally not
                    danger-toned since it is non-destructive. */}
                <button
                  onClick={() => handleShare(activeHandout, 'party')}
                  className="vtt-btn vtt-btn-secondary"
                  style={{ color: 'var(--parchment-ink)' }}
                >
                  Whisper to Party
                </button>
                <button
                  onClick={() => handleShare(activeHandout, 'all')}
                  className="vtt-btn vtt-btn-primary font-display tracking-wide"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Reveal to All Table</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </ModalShell>
  );
};
