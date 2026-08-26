/**
 * Iteration 3 (Loop 3) — "Generate Art…" dialog for map tokens.
 *
 * One modal per open: prompt textarea (prefilled from the token's name), a
 * canvas-size selector, Generate, and an honest loading state (diffusion on
 * the shared GPU really does take ~10-60s). On success the preview shows the
 * generated art and Apply hands the dataURL back to the app shell, which
 * persists it onto the token via updateTokenArt (see yjs_doc_client.ts).
 *
 * Errors are surfaced verbatim through describeMediaFailure — including the
 * sign-in prompt for NOT_SIGNED_IN and the bucket-honest rate-limit line.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ImageIcon, Loader2, X } from 'lucide-react';
import {
  generateTokenArt,
  describeMediaFailure,
  MEDIA_STEPS_DEFAULT,
  type MediaImageSize,
} from '../api/media_store';

export interface TokenArtDialogProps {
  /** The token being decorated; null closes the dialog. */
  token: { id: string; name: string } | null;
  /** Called with the generated dataURL when the user applies the result. */
  onApply: (tokenId: string, dataUrl: string) => void;
  onClose: () => void;
}

const SIZES: MediaImageSize[] = ['512x512', '256x256'];

/** Prompt length cap mirrors the gateway schema (str 1..500). */
const PROMPT_MAX = 500;

export const TokenArtDialog: React.FC<TokenArtDialogProps> = ({ token, onApply, onClose }) => {
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<MediaImageSize>('512x512');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Reset per open so each dialog starts from its own token's name.
  useEffect(() => {
    if (token) {
      setPrompt(token.name);
      setSize('512x512');
      setPreview(null);
      setError(null);
      setLoading(false);
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.id]);

  if (!token) return null;

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    const result = await generateTokenArt(trimmed.slice(0, PROMPT_MAX), size, MEDIA_STEPS_DEFAULT);
    setLoading(false);
    if (result.OK) {
      setPreview(result.dataUrl);
    } else {
      setError(describeMediaFailure(result.failure));
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      style={{ zIndex: 'var(--z-modal)' }}
      onClick={onClose}
      data-testid="token-art-dialog-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Generate art for ${token.name}`}
        className="vtt-glass-panel rounded-2xl border border-tavern-border shadow-2xl w-[min(92vw,440px)] max-h-[90vh] overflow-y-auto p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-parchment-aged font-mono font-bold text-sm flex items-center gap-2">
              <ImageIcon className="w-4 h-4" />
              Generate Art — {token.name}
            </h2>
            <p className="text-[11px] text-parchment-aged/60 font-mono mt-1">
              Diffusion can take ~10–60s; the result is cached for this session.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-parchment-aged/60 hover:text-parchment-aged rounded p-1 hover:bg-black/30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-[11px] font-mono font-bold text-parchment-aged/80 uppercase tracking-wide">
            Prompt
          </span>
          <textarea
            ref={inputRef}
            value={prompt}
            maxLength={PROMPT_MAX}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Describe the portrait — e.g. 'scarred dwarven cleric, ember-lit shrine'"
            className="w-full bg-black/40 border border-tavern-border rounded-lg px-3 py-2 text-xs font-mono text-parchment-aged focus:outline-none focus:border-tavern-accent resize-y"
          />
          <span className="text-[10px] font-mono text-parchment-aged/40 block text-right">
            {prompt.length}/{PROMPT_MAX}
          </span>
        </label>

        <div className="space-y-1.5">
          <span className="text-[11px] font-mono font-bold text-parchment-aged/80 uppercase tracking-wide">
            Size
          </span>
          <div className="flex gap-2">
            {SIZES.map((s) => (
              <button
                key={s}
                onClick={() => setSize(s)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-mono border transition ${
                  size === s
                    ? 'bg-rule-red text-parchment-aged border-rule-red font-bold'
                    : 'vtt-surface text-parchment-aged/70 border-tavern-border hover:bg-black/20'
                }`}
                aria-pressed={size === s}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Honest loading state: diffusion genuinely takes tens of seconds on
            the shared GPU — never a fake spinner-only "done" impression. */}
        {loading && (
          <div
            className="flex items-center gap-3 bg-black/40 border border-tavern-border rounded-lg px-4 py-3"
            data-testid="token-art-loading"
            role="status"
          >
            <Loader2 className="w-4 h-4 animate-spin text-amber-300 shrink-0" />
            <span className="text-[11px] font-mono text-parchment-aged/80">
              Diffusing… this can take ~10–60s on the shared GPU.
            </span>
          </div>
        )}

        {error && (
          <div
            className="bg-rose-950/70 border border-rose-500/60 rounded-lg px-4 py-3 text-[11px] font-mono text-rose-200"
            data-testid="token-art-error"
            role="alert"
          >
            {error}
          </div>
        )}

        {preview && (
          <div className="flex items-center gap-4 bg-black/40 border border-tavern-border rounded-lg p-3">
            <img
              src={preview}
              alt={`Generated art preview for ${token.name}`}
              className="w-24 h-24 rounded-lg object-cover border border-tavern-border shadow-lg"
              data-testid="token-art-preview"
            />
            <button
              onClick={() => onApply(token.id, preview)}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-parchment-aged text-xs font-mono font-bold transition"
              data-testid="token-art-apply"
            >
              Apply to {token.name}
            </button>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg vtt-surface text-parchment-aged/70 text-xs font-mono hover:bg-black/20 transition"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleGenerate()}
            disabled={loading || prompt.trim().length === 0}
            className="px-4 py-2 rounded-lg bg-rule-red hover:bg-rule-red/80 disabled:opacity-50 text-parchment-aged text-xs font-mono font-bold transition"
            data-testid="token-art-generate"
          >
            {loading ? 'Diffusing…' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
};
