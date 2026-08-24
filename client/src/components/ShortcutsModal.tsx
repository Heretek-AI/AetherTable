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
            <h3 className="vtt-section-header text-xs font-bold mb-2">
              <span>{group}</span>
            </h3>
            {/* Two-column printed-book rules table on dark tavern chrome. */}
            <table className="vtt-table vtt-table--dark text-xs">
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Keys</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ keys, description }) => (
                  <tr key={description}>
                    <td className="py-1.5">{description}</td>
                    <td className="py-1.5">
                      <span className="flex items-center gap-1">
                        {keys.map((k) => (
                          <kbd
                            key={k}
                            className="inline-block min-w-[1.75rem] text-center px-1.5 py-0.5 rounded-md bg-tavern-bg border border-tavern-border border-b-2 border-b-[var(--rp-leather-600)] text-[10px] font-mono font-semibold text-[var(--rp-parchment-200)] shadow-sm"
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </ModalShell>
  );
};
