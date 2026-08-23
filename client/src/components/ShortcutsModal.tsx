import React from 'react';
import { Keyboard, X } from 'lucide-react';

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Every global keyboard shortcut the app honours, grouped by surface.
 * Opened with `?` (when not typing) or from the command palette.
 *
 * Keep this list in sync with the `handleKeyDown` effect in `App.tsx` —
 * the modal is documentation, App.tsx is the source of truth.
 */
interface ShortcutRow {
  keys: string[];
  description: string;
}

const SHORTCUT_GROUPS: { group: string; rows: ShortcutRow[] }[] = [
  {
    group: 'Global',
    rows: [
      { keys: ['⌘', 'K'], description: 'Open / close the universal command palette' },
      { keys: ['?'], description: 'Show this shortcut cheat-sheet' },
      { keys: ['Esc'], description: 'Close the top-most open modal' },
    ],
  },
  {
    group: 'Tactical canvas',
    rows: [
      { keys: ['Alt', 'Drag'], description: 'Pan the battlemap' },
      { keys: ['Drag'], description: 'Move the selected token' },
      { keys: ['+ / −'], description: 'Zoom in / out (50% – 220%)' },
    ],
  },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div
        className="vtt-glass-panel rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto vtt-scrollbar"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/90 backdrop-blur rounded-t-2xl">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-100">
            <Keyboard className="w-5 h-5 text-amber-400" aria-hidden="true" />
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Groups */}
        <div className="px-5 py-4 space-y-5">
          {SHORTCUT_GROUPS.map(({ group, rows }) => (
            <section key={group}>
              <h3 className="text-[11px] font-mono uppercase tracking-widest text-slate-500 mb-2">
                {group}
              </h3>
              <ul className="space-y-1.5">
                {rows.map(({ keys, description }) => (
                  <li
                    key={description}
                    className="flex items-center justify-between gap-4 py-1.5 px-2 rounded-lg hover:bg-slate-800/40"
                  >
                    <span className="text-xs text-slate-300">{description}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {keys.map((k) => (
                        <kbd
                          key={k}
                          className="min-w-[1.75rem] text-center px-1.5 py-0.5 rounded-md bg-slate-800 border border-slate-700 border-b-2 text-[10px] font-mono font-semibold text-slate-200 shadow-sm"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
