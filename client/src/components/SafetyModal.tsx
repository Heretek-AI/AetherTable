import React, { useState } from 'react';
import { AlertOctagon, RotateCcw, ShieldAlert } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';

interface SafetyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTriggerRewind: (topic: string) => void;
}

export const SafetyModal: React.FC<SafetyModalProps> = ({
  isOpen,
  onClose,
  onTriggerRewind,
}) => {
  const [selectedTopic, setSelectedTopic] = useState('General Content Warning');

  const topics = [
    'General Content Warning',
    'Arachnophobia / Spiders',
    'Explicit Violence / Gore',
    'Body Horror / Parasites',
    'Claustrophobia / Entombment',
  ];

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Safety Gateway (X-Card Active)"
      subtitle="Pause the narrative and rewind to before the triggering moment."
      icon={<AlertOctagon className="w-5 h-5" />}
      size="sm"
      footer={
        /* Actions */
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="vtt-btn vtt-btn-secondary text-xs"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onTriggerRewind(selectedTopic);
              onClose();
            }}
            className="vtt-btn vtt-btn-danger text-xs"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Rewind Scene & Apply
          </button>
        </div>
      }
    >
      {/* Content — deliberately stark: this sheet must read as an interrupt,
          not as decoration. Rose stays only where it carries danger meaning. */}
      <div className="space-y-4 text-xs text-[var(--rp-parchment-200)]">
          <p>
            Invoking the <strong>X-Card</strong> flags the topic for removal and requests an authoritative state rewind on the engine ledger, back to the preceding game event. Your local view re-syncs once the engine confirms the revert.
          </p>

          <div className="space-y-1.5">
            <label className="font-mono text-[11px] font-bold text-[var(--rp-parchment-300)]">SELECT TOPIC / TRIGGER:</label>
            <select
              value={selectedTopic}
              onChange={(e) => setSelectedTopic(e.target.value)}
              className="vtt-select w-full text-xs"
            >
              {topics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Crimson left-rule callout — the safety copy is the one place
              where red is semantically load-bearing */}
          <div className="p-3 rounded-r-lg border-l-4 border-[var(--state-danger)] bg-[color-mix(in_srgb,var(--state-danger)_10%,transparent)] text-[11px] text-[var(--rp-parchment-200)] flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--state-danger)' }} />
            <span>No explanation is required. The system will seamlessly resume with the trigger removed.</span>
          </div>
        </div>
    </ModalShell>
  );
};
