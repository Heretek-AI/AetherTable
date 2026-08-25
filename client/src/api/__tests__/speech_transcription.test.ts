/**
 * Iteration-39: VAD speech segments must reach the intent surface as text.
 *
 * These tests pin the PURE pieces of the speech-transcription core:
 *   - engine resolution from the env flag (off by default → honest "none"),
 *   - transcript shaping (whitespace + known Whisper silence artifacts),
 *   - the utterance state machine (pending/ready/failed/unavailable),
 *   - wire-format capture (Float32 segment retention + WAV blob encoding).
 *
 * No network, no ONNX, no DOM: everything here runs in the node vitest env.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_RETAINED_SEGMENT_SAMPLES,
  MIN_TRANSCRIBABLE_MS,
  AudioSegmentBuffer,
  float32ToWavPcm16Blob,
  reduceVoiceTranscription,
  resolveTranscriptionEngine,
  shapeTranscript,
  type VoiceTranscriptionEvent,
  type VoiceUtterance,
} from '../speech_transcription';

describe('resolveTranscriptionEngine', () => {
  it('defaults to none for falsy / missing flags', () => {
    expect(resolveTranscriptionEngine(undefined)).toBe('none');
    expect(resolveTranscriptionEngine('')).toBe('none');
    expect(resolveTranscriptionEngine(false)).toBe('none');
    expect(resolveTranscriptionEngine(0)).toBe('none');
  });

  it('accepts the usual truthy spellings', () => {
    expect(resolveTranscriptionEngine('true')).toBe('browser-whisper');
    expect(resolveTranscriptionEngine('1')).toBe('browser-whisper');
    expect(resolveTranscriptionEngine('YES')).toBe('browser-whisper');
    expect(resolveTranscriptionEngine(true)).toBe('browser-whisper');
  });

  it('treats anything unrecognised as off rather than guessing', () => {
    expect(resolveTranscriptionEngine('on')).toBe('none');
    expect(resolveTranscriptionEngine('false')).toBe('none');
    expect(resolveTranscriptionEngine({})).toBe('none');
  });
});

describe('shapeTranscript', () => {
  it('trims and collapses whitespace in a usable transcript', () => {
    expect(shapeTranscript('  I cast   Fireball\nat the warlord! ')).toBe(
      'I cast Fireball at the warlord!',
    );
  });

  it('returns null for non-string input', () => {
    expect(shapeTranscript(null)).toBeNull();
    expect(shapeTranscript(undefined)).toBeNull();
    expect(shapeTranscript(42)).toBeNull();
  });

  it('returns null when nothing intelligible remains after trimming', () => {
    expect(shapeTranscript('   ')).toBeNull();
    expect(shapeTranscript('')).toBeNull();
  });

  it('drops bracketed / parenthesised sound-event tags Whisper emits on noise', () => {
    expect(shapeTranscript('[Music]')).toBeNull();
    expect(shapeTranscript('(wind blowing)')).toBeNull();
    expect(shapeTranscript('[BLANK_AUDIO] [Applause]')).toBeNull();
    // Real words survive alongside tags.
    expect(shapeTranscript('[Music] I attack the goblin')).toBe('I attack the goblin');
  });

  it('rejects the classic tiny-model hallucinations on silent tails', () => {
    expect(shapeTranscript('Thank you.')).toBeNull();
    expect(shapeTranscript('Thank you for watching!')).toBeNull();
    expect(shapeTranscript('Bye.')).toBeNull();
    // But a sentence that merely contains those words is kept.
    expect(shapeTranscript('I say thank you to the innkeeper')).toBe(
      'I say thank you to the innkeeper',
    );
  });

  it('keeps genuine short utterances like a yes/no call', () => {
    expect(shapeTranscript('Yes.')).toBe('Yes.');
    expect(shapeTranscript('no')).toBe('no');
  });
});

describe('reduceVoiceTranscription', () => {
  const seg = (id: string, durationMs = 1500): VoiceTranscriptionEvent => ({
    type: 'SEGMENT',
    id,
    durationMs,
  });

  it('ignores sub-minimum blips instead of transcribing junk', () => {
    const out = reduceVoiceTranscription([], seg('a', MIN_TRANSCRIBABLE_MS - 1));
    expect(out.utterances).toHaveLength(0);
    expect(out.keptText).toBeNull();
  });

  it('opens a pending utterance for a real segment', () => {
    const out = reduceVoiceTranscription([], seg('a'));
    expect(out.utterances).toEqual([
      { id: 'a', state: 'pending', text: '', durationMs: 1500 },
    ]);
  });

  it('caps retained utterances, dropping the oldest first', () => {
    let state: VoiceUtterance[] = [];
    for (let i = 0; i < 12; i++) state = reduceVoiceTranscription(state, seg(`u${i}`)).utterances;
    expect(state).toHaveLength(4);
    expect(state.map((u) => u.id)).toEqual(['u8', 'u9', 'u10', 'u11']);
  });

  it('marks a ready utterance with shaped text', () => {
    let state = reduceVoiceTranscription([], seg('a')).utterances;
    const out = reduceVoiceTranscription(state, { type: 'TEXT_READY', id: 'a', text: '  I  search the room ' });
    expect(out.utterances[0]).toMatchObject({ id: 'a', state: 'ready', text: 'I search the room' });
  });

  it('downgrades ready-with-junk to an honest failure, never an empty bubble', () => {
    let state = reduceVoiceTranscription([], seg('a')).utterances;
    const out = reduceVoiceTranscription(state, { type: 'TEXT_READY', id: 'a', text: '[Music]' });
    expect(out.utterances[0].state).toBe('failed');
    expect(out.utterances[0].text).toBe('');
    expect(out.utterances[0].detail).toMatch(/intelligible/i);
  });

  it('records failures with their reason', () => {
    let state = reduceVoiceTranscription([], seg('a')).utterances;
    const out = reduceVoiceTranscription(state, { type: 'FAILED', id: 'a', reason: 'model download aborted' });
    expect(out.utterances[0]).toMatchObject({ state: 'failed', detail: 'model download aborted' });
  });

  it('engine-unavailable flips every pending utterance honestly', () => {
    let state = reduceVoiceTranscription([], seg('a')).utterances;
    state = reduceVoiceTranscription(state, seg('b')).utterances;
    const out = reduceVoiceTranscription(state, {
      type: 'ENGINE_UNAVAILABLE',
      reason: 'transcription disabled (VITE_ENABLE_BROWSER_STT unset)',
    });
    for (const u of out.utterances) {
      expect(u.state).toBe('unavailable');
      expect(u.detail).toContain('VITE_ENABLE_BROWSER_STT');
    }
  });

  it('KEEP hands back the shaped text exactly once and removes the bubble', () => {
    let state = reduceVoiceTranscription([], seg('a')).utterances;
    state = reduceVoiceTranscription(state, { type: 'TEXT_READY', id: 'a', text: 'I roll Athletics' }).utterances;
    const kept = reduceVoiceTranscription(state, { type: 'KEEP', id: 'a' });
    expect(kept.keptText).toBe('I roll Athletics');
    expect(kept.utterances).toHaveLength(0);

    const again = reduceVoiceTranscription(kept.utterances, { type: 'KEEP', id: 'a' });
    expect(again.keptText).toBeNull();
  });

  it('refuses to KEEP anything that is not ready text', () => {
    let state = reduceVoiceTranscription([], seg('a')).utterances;
    const out = reduceVoiceTranscription(state, { type: 'KEEP', id: 'a' });
    expect(out.keptText).toBeNull();
    expect(out.utterances).toHaveLength(1); // still pending, still visible
  });

  it('DISMISS removes one utterance; unknown ids are no-ops', () => {
    let state = reduceVoiceTranscription([], seg('a')).utterances;
    state = reduceVoiceTranscription(state, seg('b')).utterances;
    expect(reduceVoiceTranscription(state, { type: 'DISMISS', id: 'a' }).utterances.map((u) => u.id)).toEqual(['b']);
    expect(reduceVoiceTranscription(state, { type: 'DISMISS', id: 'ghost' }).utterances).toHaveLength(2);
    expect(reduceVoiceTranscription(state, { type: 'TEXT_READY', id: 'ghost', text: 'x' }).utterances).toHaveLength(2);
  });
});

describe('AudioSegmentBuffer (wire-format capture)', () => {
  it('retains a segment until released', () => {
    const buf = new AudioSegmentBuffer();
    buf.retain('a', new Float32Array([0.1, 0.2]));
    expect(buf.has('a')).toBe(true);
    expect(buf.release('a')).toEqual(new Float32Array([0.1, 0.2]));
    expect(buf.has('a')).toBe(false);
    expect(buf.release('a')).toBeUndefined();
  });

  it('bounds total retained samples by evicting oldest segments first', () => {
    const buf = new AudioSegmentBuffer();
    const half = Math.floor(MAX_RETAINED_SEGMENT_SAMPLES / 2);
    buf.retain('old', new Float32Array(half));
    buf.retain('newer', new Float32Array(half));
    // Third segment of equal size cannot fit while both are held: 'old' evicts.
    buf.retain('newest', new Float32Array(half));
    expect(buf.has('old')).toBe(false);
    expect(buf.has('newer')).toBe(true);
    expect(buf.retainedSamples()).toBeLessThanOrEqual(MAX_RETAINED_SEGMENT_SAMPLES);
  });

  it('clamps single oversized segments down to the cap', () => {
    const buf = new AudioSegmentBuffer();
    buf.retain('huge', new Float32Array(MAX_RETAINED_SEGMENT_SAMPLES * 3));
    expect(buf.retainedSamples()).toBe(MAX_RETAINED_SEGMENT_SAMPLES);
  });

  it('releaseAll empties retention (capture stop must not leak mic audio)', () => {
    const buf = new AudioSegmentBuffer();
    buf.retain('a', new Float32Array(10));
    buf.retain('b', new Float32Array(20));
    buf.releaseAll();
    expect(buf.retainedSamples()).toBe(0);
  });
});

describe('float32ToWavPcm16Blob', () => {
  it('writes a canonical 16-bit PCM RIFF/WAVE header at 16 kHz mono', async () => {
    const blob = float32ToWavPcm16Blob(new Float32Array([0, 0.5, -0.5]), 16000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ascii = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    // PCM, mono, 16000 Hz, 16-bit.
    expect(bytes[20]).toBe(1); // format tag = PCM
    expect(bytes[22]).toBe(1); // channels = 1
    expect(bytes[24] | (bytes[25] << 8)).toBe(16000);
    expect(bytes[34]).toBe(16); // bits per sample
    expect(ascii(36, 4)).toBe('data');
    // 44-byte header + 3 samples * 2 bytes.
    expect(bytes.length).toBe(44 + 6);
    expect((bytes[40] | (bytes[41] << 8) | (bytes[42] << 16) | bytes[43] * 16777216)).toBe(6);
  });

  it('quantises samples into [-32768, 32767] without wrapping', async () => {
    const blob = float32ToWavPcm16Blob(new Float32Array([-1, 1, 0]), 16000);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(0);
  });
});
