/**
 * Tests for the glTF miniature opt-in gate (iteration 50).
 *
 * The gate is the ONLY shipped code from the glTF evaluation — these tests pin
 * its honest default (OFF) and its strict string contract, so a future
 * implementation cannot silently enable a heavyweight runtime by accident.
 * See render/gltf_miniatures.ts for the full evaluation record.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isGltfMiniaturesEnabled } from '../gltf_miniatures';

const FLAG = 'VITE_ENABLE_GLTF_MINIATURES' as const;

function setFlag(value: string | undefined): void {
  if (value === undefined) {
    delete (import.meta.env as Record<string, string | undefined>)[FLAG];
  } else {
    (import.meta.env as Record<string, string | undefined>)[FLAG] = value;
  }
}

describe('isGltfMiniaturesEnabled', () => {
  afterEach(() => setFlag(undefined));

  it('defaults to OFF when the flag is unset', () => {
    setFlag(undefined);
    expect(isGltfMiniaturesEnabled()).toBe(false);
  });

  it('is strictly true-string gated (no truthy coercion)', () => {
    setFlag('true');
    expect(isGltfMiniaturesEnabled()).toBe(true);

    for (const notQuite of ['1', 'TRUE', 'yes', 'on', 'enabled', '']) {
      setFlag(notQuite);
      expect(isGltfMiniaturesEnabled()).toBe(false);
    }
  });

  it('is OFF when explicitly set to false', () => {
    setFlag('false');
    expect(isGltfMiniaturesEnabled()).toBe(false);
  });
});
