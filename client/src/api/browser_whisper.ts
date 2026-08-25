/**
 * Browser-local Whisper adapter (iteration-39, Pillar 11).
 *
 * Choice of transcription path, documented:
 *
 *   The gateway exposes NO transcription route (python/vtt_orchestrator/
 *   server.py has no audio endpoint), and the client owns no backend code —
 *   so "ship the blob to an authenticated gateway endpoint" was not an
 *   honest option. In-browser Whisper via transformers.js IS viable here:
 *   the existing Silero VAD already hands us 16 kHz mono Float32Array bursts
 *   (render/voice_capture.ts onSpeechEnd), which is exactly the input
 *   transformers.js `automatic-speech-recognition` expects; no resampling,
 *   no MediaRecorder, no server round-trip. A probe build confirmed the
 *   dependency code-splits into its own lazy chunk (~570 kB min) with the
 *   full build still well inside the 15 s gate.
 *
 *   Costs, stated plainly: first use downloads ~40-80 MB of quantized ONNX
 *   weights from the Hugging Face CDN and inference runs on WASM in this
 *   tab. That is why it is opt-in behind VITE_ENABLE_BROWSER_STT and why
 *   every failure degrades to the honest "transcription unavailable" state
 *   instead of a broken mic button.
 */

/** Vite env flag that opts this browser into downloading model weights. */
export const BROWSER_STT_FLAG = 'VITE_ENABLE_BROWSER_STT';

/** Quantized tiny English model: smallest viable, ~40-80 MB download. */
export const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny.en';

export type WhisperLoadState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'disabled';

export interface WhisperProgress {
  status: string;
  progress?: number;
}

export type WhisperPipelineLike = (
  audio: Float32Array,
) => Promise<{ text?: string } | Array<{ text?: string }> | string>;

/** Just enough of @huggingface/transformers for ASR, injectable for tests. */
export interface WhisperModuleLike {
  env?: Record<string, unknown>;
  pipeline(
    task: 'automatic-speech-recognition',
    modelId: string,
    options: { dtype?: string; progress_callback?: (p: WhisperProgress) => void },
  ): Promise<WhisperPipelineLike>;
}

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export interface BrowserWhisperOptions {
  /** Resolved env flag; false keeps every import path cold. */
  enabled?: boolean;
  modelId?: string;
  /** DI seam — defaults to the real dynamic import (bundled, then CDN). */
  loadModule?: () => Promise<WhisperModuleLike>;
  onProgress?: (p: WhisperProgress) => void;
}

/**
 * Resolve the raw import.meta.env value into the enabled boolean. Only the
 * explicit truthy spellings enable; everything else stays off.
 */
export function resolveBrowserSttEnabled(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Real module loader: prefer the bundled copy (vite code-splits it), fall
 * back to the jsDelivr ESM build if the optional dependency is absent
 * (`npm install --omit=optional`). Both are dynamic imports — nothing loads
 * until the first transcription after the flag is set.
 */
function defaultLoadModule(): Promise<WhisperModuleLike> {
  return import('@huggingface/transformers')
    .then((m) => m as unknown as WhisperModuleLike)
    .catch((bundledError: unknown) => {
      const url = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
      return import(/* @vite-ignore */ url).catch(() => {
        throw bundledError instanceof Error ? bundledError : new Error(String(bundledError));
      });
    });
}

/**
 * Lazy singleton-style transcriber. All state transitions are honest and
 * observable: 'disabled' means the flag said no; 'error' carries the real
 * reason and the next transcribe() call retries loading.
 */
export class BrowserWhisperTranscriber {
  public readonly kind = 'browser-whisper' as const;

  private readonly enabled: boolean;
  private readonly modelId: string;
  private readonly loadModule: () => Promise<WhisperModuleLike>;
  private readonly onProgress?: (p: WhisperProgress) => void;

  private state: WhisperLoadState = 'idle';
  private lastError: string | null = null;
  private pipelinePromise: Promise<WhisperPipelineLike> | null = null;

  constructor(options: BrowserWhisperOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.modelId = options.modelId ?? WHISPER_MODEL_ID;
    this.loadModule = options.loadModule ?? defaultLoadModule;
    this.onProgress = options.onProgress;
  }

  public getState(): WhisperLoadState {
    return this.state;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Transcribe one VAD burst. Never throws — failures come back as
   * { ok:false, reason } so callers can surface them verbatim.
   */
  public async transcribe(audio: Float32Array): Promise<TranscribeResult> {
    if (!this.enabled) {
      this.lastError = `transcription disabled (${BROWSER_STT_FLAG} not set)`;
      this.state = 'disabled';
      return { ok: false, reason: this.lastError };
    }
    try {
      const pipeline = await this.ensurePipeline();
      const output = await pipeline(audio);
      return { ok: true, text: extractText(output) };
    } catch (e) {
      // Drop the cached promise so the next attempt genuinely retries.
      this.pipelinePromise = null;
      this.state = 'error';
      this.lastError = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: this.lastError };
    }
  }

  private ensurePipeline(): Promise<WhisperPipelineLike> {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.state = 'loading';
    this.pipelinePromise = this.loadModule()
      .then((mod) => {
        // Weights come from the HF hub at runtime; never look for local copies.
        if (mod.env && typeof mod.env === 'object') {
          mod.env.allowLocalModels = false;
        }
        return mod.pipeline('automatic-speech-recognition', this.modelId, {
          dtype: 'q8',
          progress_callback: (p: WhisperProgress) => this.onProgress?.(p),
        });
      })
      .then((pipeline) => {
        this.state = 'ready';
        this.lastError = null;
        return pipeline;
      })
      .catch((e: unknown) => {
        this.pipelinePromise = null;
        this.state = 'error';
        this.lastError = e instanceof Error ? e.message : String(e);
        throw e;
      });
    return this.pipelinePromise;
  }
}

/**
 * Normalize the pipeline's several output shapes to one trimmed string.
 * Only whitespace is touched here — silence-artifact / junk policy lives in
 * shapeTranscript (api/speech_transcription.ts), the single place that
 * decides whether text is bubble-worthy.
 */
function extractText(output: Awaited<ReturnType<WhisperPipelineLike>>): string {
  const raw =
    typeof output === 'string'
      ? output
      : Array.isArray(output)
        ? (output[0]?.text ?? '')
        : (output?.text ?? '');
  return raw.trim();
}
