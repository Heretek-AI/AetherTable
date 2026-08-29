/**
 * L3.39 — the shared engine/gateway rejection parser (engine_errors.ts) that
 * every engine-action module now funnels its non-2xx bodies through.
 *
 * These are red-first tests: they pin the honesty contract — the machine code
 * and the human sentence are surfaced VERBATIM from whatever the answering
 * layer actually sent, a body the parser cannot read yields two honest nulls
 * (the renderer supplies the `HTTP <status>` fallback), and no code is ever
 * invented from a sentence or a status line.
 */
import { describe, expect, it } from 'vitest';
import {
  engineRejectionDetail,
  rejectionFrom,
  type EngineRejectionDetail,
} from '../engine_errors';

describe('engineRejectionDetail — FastAPI {detail} envelope', () => {
  it('surfaces a bare-string detail verbatim', () => {
    expect(engineRejectionDetail({ detail: 'Missing session token' })).toEqual({
      code: null,
      message: 'Missing session token',
    });
  });

  it('peels the envelope to the engine body, keeping BOTH code and sentence', () => {
    expect(
      engineRejectionDetail({
        detail: { error: 'FORBIDDEN_ROLE', message: 'only GMs may grant or revoke surprise' },
      }),
    ).toEqual({ code: 'FORBIDDEN_ROLE', message: 'only GMs may grant or revoke surprise' });
  });

  it('reads the engine sentence from `detail`, not `message`', () => {
    expect(
      engineRejectionDetail({ detail: { error: 'SURPRISE_WINDOW_CLOSED', detail: 'round 2 already closed' } }),
    ).toEqual({ code: 'SURPRISE_WINDOW_CLOSED', message: 'round 2 already closed' });
  });

  it('surfaces a gateway refusal dict that names only `message`', () => {
    expect(engineRejectionDetail({ detail: { message: 'boom' } })).toEqual({
      code: null,
      message: 'boom',
    });
  });
});

describe('engineRejectionDetail — 422 validation array', () => {
  it('quotes the first entry msg verbatim', () => {
    expect(
      engineRejectionDetail({
        detail: [
          { loc: ['body', 'party_size'], msg: 'party_size must be between 1 and 8', type: 'greater_than_equal' },
        ],
      }),
    ).toEqual({ code: null, message: 'party_size must be between 1 and 8' });
  });

  it('yields honest nulls when the array entry carries no msg', () => {
    expect(engineRejectionDetail({ detail: [{ loc: ['body'], type: 'missing' }] })).toEqual({
      code: null,
      message: null,
    });
  });
});

describe('engineRejectionDetail — raw / unwrapped engine bodies', () => {
  it('keeps a top-level code even though a detail sentence also rides alongside', () => {
    // Some surfaces forward the engine body directly: {error, detail}. Peeling
    // the envelope here would swallow the code under the sentence.
    expect(engineRejectionDetail({ error: 'ALREADY_DELAYED', detail: 'already parked' })).toEqual({
      code: 'ALREADY_DELAYED',
      message: 'already parked',
    });
  });

  it('reads a top-level code from the `code` key with a `message` sentence', () => {
    expect(
      engineRejectionDetail({ code: 'SAFETY_NOT_A_PARTICIPANT', message: 'not a session participant' }),
    ).toEqual({ code: 'SAFETY_NOT_A_PARTICIPANT', message: 'not a session participant' });
  });

  it('surfaces a bare string body (a code-only answer) verbatim as the message', () => {
    expect(engineRejectionDetail('UNKNOWN_MONSTER_ID:shadow_drake')).toEqual({
      code: null,
      message: 'UNKNOWN_MONSTER_ID:shadow_drake',
    });
  });
});

describe('engineRejectionDetail — non-JSON payloads', () => {
  it('yields two nulls for a bodyless response so the renderer falls back', () => {
    expect(engineRejectionDetail(null)).toEqual({ code: null, message: null });
  });

  it('yields two nulls for a shape it does not recognize (a number)', () => {
    expect(engineRejectionDetail(404)).toEqual({ code: null, message: null });
  });
});

describe('rejectionFrom — discriminated rejected outcome', () => {
  it('stamps the status onto the parsed detail', () => {
    const expected: EngineRejectionDetail = { code: null, message: 'Not Found' };
    expect(rejectionFrom(404, { detail: 'Not Found' })).toEqual({
      kind: 'rejected',
      status: 404,
      ...expected,
    });
  });

  it('preserves the engine code + sentence for a 403', () => {
    expect(rejectionFrom(403, { detail: { error: 'FORBIDDEN_ROLE', message: 'only GMs' } })).toEqual({
      kind: 'rejected',
      status: 403,
      code: 'FORBIDDEN_ROLE',
      message: 'only GMs',
    });
  });

  it('stays honest (null message) when a 404 body is empty', () => {
    expect(rejectionFrom(404, null)).toEqual({
      kind: 'rejected',
      status: 404,
      code: null,
      message: null,
    });
  });
});
