/**
 * Unit coverage for the ICE plumbing added in iteration 26 (TURN/STUN gap).
 *
 * Scope honestly bounded: this suite proves the iceServers ARRAY that reaches
 * the Peer constructor is built correctly from VITE_TURN_* inputs. It cannot
 * prove NAT traversal end-to-end — that requires two distinct networks and a
 * live coturn (see docker-compose.yml `vtt-coturn`). What it CAN prove:
 *  - STUN is always present (PeerJS's own default had exactly one, ours does
 *    too, explicitly),
 *  - TURN is appended ONLY when url+username+credential arrive TOGETHER,
 *  - no credential material is ever synthesized or defaulted in code.
 */
import { describe, expect, it } from 'vitest';

import { buildIceServers } from '../webrtc_mesh';

describe('buildIceServers', () => {
  it('always includes public STUN', () => {
    const servers = buildIceServers();
    expect(servers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('appends a TURN entry only with a complete credential triple', () => {
    const servers = buildIceServers(
      'turn:turn.example.com:3478?transport=udp',
      '1756100000:alice',
      'base64hmac=='
    );
    expect(servers).toHaveLength(2);
    expect(servers[1]).toEqual({
      urls: 'turn:turn.example.com:3478?transport=udp',
      username: '1756100000:alice',
      credential: 'base64hmac==',
    });
  });

  it.each([
    ['missing url', undefined, 'user', 'cred'],
    ['missing username', 'turn:t.example.com:3478', undefined, 'cred'],
    ['missing credential', 'turn:t.example.com:3478', 'user', undefined],
    ['empty-string url', '', 'user', 'cred'],
    ['empty-string username', 'turn:t.example.com:3478', '', 'cred'],
    ['empty-string credential', 'turn:t.example.com:3478', 'user', ''],
  ])('degrades to STUN-only when %s', (_label, url, user, cred) => {
    expect(buildIceServers(url, user, cred)).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('never fabricates credentials when nothing is configured', () => {
    for (const s of buildIceServers(undefined, undefined, undefined)) {
      expect(s.username).toBeUndefined();
      expect(s.credential).toBeUndefined();
      expect(String(s.urls)).not.toMatch(/^turn:/);
    }
  });
});
