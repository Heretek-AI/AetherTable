import React from 'react';
import { Keyboard } from 'lucide-react';
import { ModalShell } from './ui/ModalShell';

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
  return (
    /* nested: this cheat-sheet can be opened from inside another modal (e.g.
       the command palette), so it layers on the --z-modal-nested rung. */
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="Keyboard Shortcuts"
      icon={<Keyboard className="w-5 h-5" />}
      size="md"
      nested={true}
    >
      {/* Groups */}
      <div className="space-y-5">
        {SHORTCUT_GROUPS.map(({ group, rows }) => (
          <section key={group}>
            <h3 className="text-[11px] font-mono uppercase tracking-widest text-slate-500 mb-2">
              {group}
            </h3>
            <ul className="space-y-1.5">
              {rows.map(({ keys, description }) => (
                <li
                  key={description}
                  className="flex items-center justify-between gap-4 py-1.5 px-2 rounded-lg hover:bg-white/5"
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
    </ModalShell>
  );
};
