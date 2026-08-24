import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from './useFocusTrap';

/**
 * Shared modal sheet — the single implementation of the ARIA dialog pattern
 * for the whole app: ESC dismiss, focus trap + focus restore, backdrop click,
 * labelled dialog semantics, and a ladder-assigned z-index (never a raw z-50;
 * see --z-* tokens in index.css). Migrating a hand-rolled modal is mechanical:
 * delete its outer overlay/panel divs and render <ModalShell> around content.
 */

const SIZES: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

export interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Panel width preset. */
  size?: keyof typeof SIZES;
  /**
   * Surface treatment: 'tavern' = dark wood/iron chrome panel,
   * 'parchment' = in-world paper document (uses .vtt-parchment),
   * 'statblock' = printed-book stat-block page (uses .vtt-statblock; the
   * header switches from gold-leaf engraving to book-red small caps, which
   * stays readable on light paper). Exactly these three tones — no ad-hoc.
   */
  tone?: 'tavern' | 'parchment' | 'statblock';
  footer?: ReactNode;
  /** Set false for sheets that must not close on stray backdrop clicks. */
  closeOnBackdrop?: boolean;
  /** True for modals opened on top of another modal (--z-modal-nested). */
  nested?: boolean;
  /** Move initial keyboard focus to a specific control (e.g. a text input). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function ModalShell({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  size = 'md',
  tone = 'tavern',
  footer,
  closeOnBackdrop = true,
  nested = false,
  initialFocusRef,
  children,
}: ModalShellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useFocusTrap({ active: isOpen, containerRef, initialFocusRef, onEscape: onClose });

  // Lock page scroll while open — long sheets would otherwise scroll the app
  // behind the modal instead of their own body.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const onPaper = tone === 'parchment' || tone === 'statblock';
  const surface =
    tone === 'parchment'
      ? 'vtt-parchment rounded-xl'
      : tone === 'statblock'
      ? 'vtt-statblock rounded-xl'
      : 'vtt-glass-panel border rounded-xl';

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      style={{ zIndex: nested ? 'var(--z-modal-nested)' : 'var(--z-modal)' }}
      onMouseDown={(e) => {
        // mousedown (not click) so dragging out of the panel doesn't dismiss.
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${surface} w-full ${SIZES[size]} max-h-[85vh] flex flex-col shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Engraved header — Cinzel display face with gold-leaf gradient
            (dark chrome) or book-red small caps (paper surfaces) */}
        <div className={`flex items-start gap-3 px-5 py-4 shrink-0 ${onPaper ? 'border-b border-[var(--rp-leather-700)]' : 'border-b border-[var(--tavern-border)]'}`}>
          {icon && (
            <span className={`mt-0.5 ${onPaper ? 'text-[var(--rp-crimson-600)]' : 'text-[var(--tavern-accent)]'}`} aria-hidden="true">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className={`${onPaper ? 'text-[var(--statblock-header)] tracking-wide' : 'vtt-engraved'} font-display text-lg font-semibold truncate`}
              style={onPaper ? { fontFamily: 'var(--font-display)', fontVariant: 'small-caps' } : undefined}
            >
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs opacity-70 mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="shrink-0 p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-y-auto vtt-scrollbar px-5 py-4 flex-1 min-h-0">
          {children}
        </div>

        {footer && (
          <div className={`px-5 py-3 border-t shrink-0 ${onPaper ? 'border-[var(--rp-leather-700)] bg-black/5' : 'border-[var(--tavern-border)] bg-black/20'}`}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
