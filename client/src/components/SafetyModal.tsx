import React, { useState } from 'react';
import { AlertOctagon, RotateCcw, FastForward, ShieldAlert, X } from 'lucide-react';

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

  if (!isOpen) return null;

  const topics = [
    'General Content Warning',
    'Arachnophobia / Spiders',
    'Explicit Violence / Gore',
    'Body Horror / Parasites',
    'Claustrophobia / Entombment',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-slate-900 border-2 border-rose-600 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 bg-rose-950/60 border-b border-rose-900/80 flex items-center justify-between">
          <div className="flex items-center gap-2 text-rose-300 font-bold text-base">
            <AlertOctagon className="w-5 h-5 text-rose-500" />
            <span>Safety Gateway (X-Card Active)</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            autoFocus  // move keyboard focus into the dialog on open
            className="text-slate-400 hover:text-white transition"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs text-slate-300">
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

        {/* Actions */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-end gap-2">
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
      </div>
    </div>
  );
};
