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
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onTriggerRewind(selectedTopic);
              onClose();
            }}
            className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg text-xs flex items-center gap-1.5 transition shadow-lg shadow-rose-950"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Rewind Scene & Apply
          </button>
        </div>
      }
    >
      {/* Content */}
      <div className="space-y-4 text-xs text-slate-300">
          <p>
            Invoking the <strong>X-Card</strong> instantly pauses narrative generation, removes the triggering topic from context memory, and executes an authoritative state rewind to the preceding game event.
          </p>

          <div className="space-y-1.5">
            <label className="font-mono text-[11px] font-bold text-slate-400">SELECT TOPIC / TRIGGER:</label>
            <select
              value={selectedTopic}
              onChange={(e) => setSelectedTopic(e.target.value)}
              className="w-full p-2 bg-slate-950 border border-slate-700 rounded-lg text-slate-200 focus:outline-none focus:border-rose-500"
            >
              {topics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-[11px] text-slate-400 flex items-start gap-2 font-mono">
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>No explanation is required. The system will seamlessly resume with the trigger removed.</span>
          </div>
        </div>
    </ModalShell>
  );
};
