/**
 * Speech-transcription core (iteration-39, Pillar 11 / Pillar 5).
 *
 * The Silero VAD already detects real speech bursts, but until now
 * onSpeechEnd audio was thrown away: spoken player intent never reached the
 * intent classifier. This module is the pure core of the honest minimum fix:
 *
 *   - resolveTranscriptionEngine: which engine may run, from one env flag.
 *     Default OFF → 'none', and the UI says so instead of pretending.
 *   - shapeTranscript: raw STT text → bubble-worthy text. Strips known
 *     Whisper silence artifacts so a cough never becomes a chat message,
 *     and returns null rather than an empty bubble.
 *   - reduceVoiceTranscription: the utterance state machine. A transcript is
 *     NEVER auto-sent; it reaches 'ready' and waits for the user to KEEP it
 *     into the normal chat input (which flows through the existing intent
 *     pipeline) or DISMISS it.
 *   - AudioSegmentBuffer / float32ToWavPcm16Blob: wire-format capture of the
 *     previously-discarded VAD segments, memory-bounded, so the audio outlives
 *     the callback only as long as transcription needs it.
 *
 * The actual model loading lives in api/browser_whisper.ts and runs only when
 * explicitly enabled; this file has zero heavy imports so the unit suite stays
 * offline.
 */

/** VAD blips shorter than this are not worth transcribing (junk output). */
export const MIN_TRANSCRIBABLE_MS = 400;

/**
 * How many recent voice utterances the UI retains. Voice drafts are ephemeral
 * prompts for the player, not history; the chat log itself stays text-only.
 */
export const MAX_VOICE_UTTERANCES = 4;

/**
 * Memory ceiling for retained mic audio across pending transcriptions:
 * ~30 seconds of 16 kHz mono Float32. Segments are evicted oldest-first once
 * exceeded, because a stuck queue must never grow without bound.
 */
export const MAX_RETAINED_SEGMENT_SAMPLES = 16_000 * 30;

/** Which STT engine the client will actually use this session. */
export type TranscriptionEngineKind =
  /** transformers.js Whisper running fully in this browser tab. */
  | 'browser-whisper'
  /** No engine: UI must surface "transcription unavailable" honestly. */
  | 'none';

/**
 * Resolve the engine from the raw env flag value. Anything not explicitly
 * enabling browser STT resolves to 'none' — silent-on by design, because the
 * first use downloads tens of MB of model weights.
 */
export function resolveTranscriptionEngine(rawFlag: unknown): TranscriptionEngineKind {
  if (typeof rawFlag === 'boolean') return rawFlag ? 'browser-whisper' : 'none';
  if (rawFlag === null || rawFlag === undefined) return 'none';
  const v = String(rawFlag).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' ? 'browser-whisper' : 'none';
}

/**
 * Known tiny-model hallucinations emitted over silence/noise. Matching is
 * exact-after-trim (case/punctuation insensitive) so a real sentence merely
 * containing these words survives untouched.
 */
const SILENCE_ARTIFACTS = [
  'thank you',
  'thank you for watching',
  'thank you for listening',
  'thanks for watching',
  'bye',
  'bye bye',
  'okay',
  'ok',
  'uh',
  'um',
  'hmm',
  'you',
];

/**
 * Raw STT output → text fit for a user-editable draft bubble, or null when
 * nothing intelligible was said. Collapses whitespace, strips bracketed /
 * parenthesised sound-event tags ([Music], (wind blowing), [BLANK_AUDIO]),
 * drops pure silence-hallucination outputs ("Thank you.", "[Music]"), and
 * refuses empty results.
 */
export function shapeTranscript(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.replace(/\s+/g, ' ').trim();
  // Sound-event tags: [Music], [Applause], (wind blowing), [BLANK_AUDIO]…
  text = text
    .replace(/[\[(（][^\])）]{0,40}[\])）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const normalized = text
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (SILENCE_ARTIFACTS.includes(normalized)) return null;
  return text;
}

/** One captured voice segment's journey through transcription. */
export interface VoiceUtterance {
  id: string;
  state:
    | 'pending' /** audio captured, transcription in flight */
    | 'ready' /** shaped transcript awaiting the user's keep/discard decision */
    | 'failed' /** engine ran but produced nothing usable, or errored */
    | 'unavailable'; /** no engine this session — honest dead end */
  text: string;
  /** Honest reason for failed/unavailable; empty otherwise. */
  detail?: string;
  durationMs: number;
}

export type VoiceTranscriptionEvent =
  /** A closed VAD burst arrived. */
  | { type: 'SEGMENT'; id: string; durationMs: number }
  /** The configured engine cannot run at all this session. */
  | { type: 'ENGINE_UNAVAILABLE'; reason: string }
  /** The engine returned raw text for one utterance. */
  | { type: 'TEXT_READY'; id: string; text: unknown }
  /** One utterance's transcription threw. */
  | { type: 'FAILED'; id: string; reason: string }
  /** Player pressed keep: hand the text to the normal chat input. */
  | { type: 'KEEP'; id: string }
  /** Player discarded it. */
  | { type: 'DISMISS'; id: string };

export interface VoiceReduction {
  utterances: VoiceUtterance[];
  /** Set ONLY on a successful KEEP: the shaped text to prefill chat input. */
  keptText: string | null;
}

const PENDING: Omit<VoiceUtterance, 'id' | 'durationMs'> = {
  state: 'pending',
  text: '',
  detail: undefined,
};

/**
 * Fold one event into the utterance list. Pure: returns new arrays, never
 * mutates input. Unknown ids are no-ops (late events after dismissal).
 */
export function reduceVoiceTranscription(
  state: readonly VoiceUtterance[],
  event: VoiceTranscriptionEvent,
): VoiceReduction {
  const noop = { utterances: state as VoiceUtterance[], keptText: null };

  switch (event.type) {
    case 'SEGMENT': {
      // Too-short blips are ignored outright: transcribing them yields junk
      // and would train players to distrust the draft bubbles.
      if (!(event.durationMs >= MIN_TRANSCRIBABLE_MS)) return noop;
      const next: VoiceUtterance[] = [
        ...state,
        { ...PENDING, id: event.id, durationMs: event.durationMs },
      ];
      return { utterances: next.slice(-MAX_VOICE_UTTERANCES), keptText: null };
    }

    case 'ENGINE_UNAVAILABLE':
      return {
        utterances: state.map((u) =>
          u.state === 'pending'
            ? { ...u, state: 'unavailable', text: '', detail: event.reason }
            : u,
        ),
        keptText: null,
      };

    case 'TEXT_READY':
      return {
        utterances: state.map((u) => {
          if (u.id !== event.id || u.state !== 'pending') return u;
          const shaped = shapeTranscript(event.text);
          return shaped === null
            ? { ...u, state: 'failed', text: '', detail: 'no intelligible speech detected' }
            : { ...u, state: 'ready', text: shaped, detail: undefined };
        }),
        keptText: null,
      };

    case 'FAILED':
      return {
        utterances: state.map((u) =>
          u.id === event.id && u.state === 'pending'
            ? { ...u, state: 'failed', text: '', detail: event.reason }
            : u,
        ),
        keptText: null,
      };

    case 'KEEP': {
      const target = state.find((u) => u.id === event.id);
      // Only READY text may enter the chat input: never auto-submit pending,
      // failed or unavailable segments as player intent.
      if (!target || target.state !== 'ready' || !target.text) return noop;
      return {
        utterances: state.filter((u) => u.id !== event.id),
        keptText: target.text,
      };
    }

    case 'DISMISS':
      return {
        utterances: state.filter((u) => u.id !== event.id),
        keptText: null,
      };
  }
}

/**
 * Retained mic audio for utterances still being transcribed. This is the
 * wire format the VAD hands us (16 kHz mono Float32); it used to be dropped
 * on the floor at NarrativeChat.tsx. Bounded so a wedged transcription queue
 * can never accumulate unbounded microphone buffers.
 */
export class AudioSegmentBuffer {
  private entries: Array<{ id: string; samples: Float32Array }> = [];

  public retain(id: string, samples: Float32Array): void {
    // Replace any duplicate id (shouldn't happen; ids are uuid-ish).
    this.release(id);
    const clamped =
      samples.length > MAX_RETAINED_SEGMENT_SAMPLES
        ? samples.subarray(0, MAX_RETAINED_SEGMENT_SAMPLES)
        : samples;
    this.entries.push({ id, samples: clamped });
    // Evict oldest-first while over budget. A single oversized segment is
    // clamped above, so this loop terminates within a couple of iterations.
    while (this.retainedSamples() > MAX_RETAINED_SEGMENT_SAMPLES && this.entries.length > 1) {
      this.entries.shift();
    }
  }

  public has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }

  public release(id: string): Float32Array | undefined {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return undefined;
    const [entry] = this.entries.splice(idx, 1);
    return entry.samples;
  }

  public releaseAll(): void {
    this.entries = [];
  }

  public retainedSamples(): number {
    return this.entries.reduce((sum, e) => sum + e.samples.length, 0);
  }
}

/**
 * Encode mono float samples as a 16-bit PCM WAV Blob (the transport-neutral
 * wire format should a gateway/relay transcription route ever exist). Header
 * is the canonical 44-byte RIFF/WAVE/fmt/data layout at the given sample rate.
 */
export function float32ToWavPcm16Blob(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
