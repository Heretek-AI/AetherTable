/**
 * Iteration-39: the browser-Whisper adapter is only allowed to touch the real
 * transformers.js module in a real browser. These tests drive it through an
 * injected module loader so the suite stays offline and deterministic, and pin
 * the honest state machine: disabled → never imports; failure → surfaced
 * reason + retryable; success → shaped text out.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BROWSER_STT_FLAG,
  BrowserWhisperTranscriber,
  resolveBrowserSttEnabled,
  type WhisperModuleLike,
  type WhisperPipelineLike,
} from '../browser_whisper';

function fakeModule(overrides: Partial<WhisperModuleLike> = {}): WhisperModuleLike {
  return {
    env: {},
    pipeline: vi.fn(async () => {
      const fn = vi.fn(async () => ({ text: ' I draw my sword ' }));
      (fn as unknown as { dispose?: () => void }).dispose = vi.fn();
      return fn;
    }),
    ...overrides,
  };
}

describe('resolveBrowserSttEnabled', () => {
  it('reads the documented flag spellings', () => {
    expect(resolveBrowserSttEnabled(undefined)).toBe(false);
    expect(resolveBrowserSttEnabled('true')).toBe(true);
    expect(resolveBrowserSttEnabled('1')).toBe(true);
    expect(resolveBrowserSttEnabled('false')).toBe(false);
    expect(BROWSER_STT_FLAG).toBe('VITE_ENABLE_BROWSER_STT');
  });
});

describe('BrowserWhisperTranscriber', () => {
  it('never loads the model when the flag is off', async () => {
    const loader = vi.fn(async () => fakeModule());
    const t = new BrowserWhisperTranscriber({ enabled: false, loadModule: loader });
    const out = await t.transcribe(new Float32Array(1600));
    expect(out).toMatchObject({ ok: false });
    expect(String((out as { reason: string }).reason)).toMatch(/disabled/i);
    expect(loader).not.toHaveBeenCalled();
    expect(t.getState()).toBe('disabled');
  });

  it('loads once, transcribes, and reports ready', async () => {
    const mod = fakeModule();
    const loader = vi.fn(async () => mod);
    const t = new BrowserWhisperTranscriber({ enabled: true, loadModule: loader });
    expect(t.getState()).toBe('idle');

    const out = await t.transcribe(new Float32Array(16000));
    expect(out).toEqual({ ok: true, text: 'I draw my sword' }); // shaped: trimmed
    expect(t.getState()).toBe('ready');
    expect(loader).toHaveBeenCalledTimes(1);
    // Second call reuses the loaded pipeline — no second model fetch.
    await t.transcribe(new Float32Array(16000));
    expect(mod.pipeline).toHaveBeenCalledTimes(1);

    const pipelineFn = await (mod.pipeline as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(pipelineFn).toHaveBeenCalledWith(expect.any(Float32Array));
  });

  it('surfaces load failure honestly and allows retry on next call', async () => {
    let fail = true;
    const loader = vi.fn(async (): Promise<WhisperModuleLike> => {
      if (fail) throw new TypeError('Failed to fetch dynamically imported module');
      return fakeModule();
    });
    const t = new BrowserWhisperTranscriber({ enabled: true, loadModule: loader });

    const first = await t.transcribe(new Float32Array(1600));
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toMatch(/fetch|load/i);
    expect(t.getState()).toBe('error');
    expect(t.getLastError()).toMatch(/fetch|load/i);

    fail = false; // e.g. connectivity restored
    const second = await t.transcribe(new Float32Array(1600));
    expect(second).toEqual({ ok: true, text: 'I draw my sword' });
    expect(t.getState()).toBe('ready');
  });

  it('reports inference failure without losing the ability to retry', async () => {
    const boom = vi.fn(async () => {
      throw new Error('ONNX abort: out of memory');
    });
    const mod = fakeModule({
      pipeline: vi.fn(async () => boom as unknown as Awaited<ReturnType<WhisperModuleLike['pipeline']>>),
    });
    const t = new BrowserWhisperTranscriber({ enabled: true, loadModule: async () => mod });

    const out = await t.transcribe(new Float32Array(1600));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/out of memory/i);
  });

  it('passes loading progress to the configured callback while fetching', async () => {
    let reported: Array<{ status: string; progress?: number }> = [];
    const mod = fakeModule({
      pipeline: vi.fn(async (
        _task: string,
        _model: string,
        opts: { progress_callback?: (p: { status: string; progress?: number }) => void },
      ) => {
        opts.progress_callback?.({ status: 'progress', progress: 42 });
        opts.progress_callback?.({ status: 'ready' });
        return (async () => ({ text: 'hi' })) as unknown as WhisperPipelineLike;
      }),
    });
    const t = new BrowserWhisperTranscriber({
      enabled: true,
      loadModule: async () => mod,
      onProgress: (p) => reported.push(p),
    });
    await t.transcribe(new Float32Array(1600));
    expect(reported.map((p) => p.status)).toEqual(['progress', 'ready']);
    expect(reported[0].progress).toBe(42);
  });
});
