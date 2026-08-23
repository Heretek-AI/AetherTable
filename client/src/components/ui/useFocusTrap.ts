import { useEffect, useRef } from 'react';

/**
 * Focus-trap hook for modal sheets (WCAG 2.4.3 / ARIA dialog pattern).
 *
 * While `active`:
 *  - the previously-focused element is remembered and restored on deactivate,
 *    so keyboard users return to the button that opened the sheet;
 *  - initial focus lands on `initialFocusRef.current` if given, else the first
 *    focusable descendant of the container;
 *  - Tab / Shift+Tab cycle strictly within the container subtree — this
 *    scoping is what makes nested sheets (e.g. Shortcuts over Spellbook) safe:
 *    each trap only intercepts keys while its own container is active and
 *    listeners are per-instance, so the topmost trap sees the event first.
 *  - Escape invokes `onEscape` (dismiss) instead of bubbling to the page.
 */
export function useFocusTrap(options: {
  active: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  onEscape?: () => void;
}): void {
  const { active, containerRef, initialFocusRef, onEscape } = options;
  // Remembered across effect re-runs via a ref so restore works even if the
  // component re-renders between open and close.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Initial focus: explicit target wins; otherwise first focusable child,
    // falling back to the container itself (make it tabIndex={-1} for that).
    const initial =
      initialFocusRef?.current ??
      (container.querySelector<HTMLElement>(FOCUSABLE) ?? container);
    initial?.focus();

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stop propagation so an underlying page handler (or a parent trap)
        // doesn't also react to one keypress.
        event.stopPropagation();
        if (onEscape) {
          event.preventDefault();
          onEscape();
        }
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeydown, true);
    return () => {
      document.removeEventListener('keydown', handleKeydown, true);
      // Restore focus to wherever the user was before the sheet opened.
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    };
  }, [active, containerRef, initialFocusRef, onEscape]);
}
