/**
 * Unit tests for iteration-35 lobby readiness contract of src/api/lobby_store.ts.
 *
 * Iteration-33 gateway routes pinned these behaviors server-side:
 *  - POST /api/v1/lobbies/{id}/ready   body {"ready": bool} -> refreshed roster
 *    (403 non-member, 404 unknown lobby).
 *  - POST /api/v1/lobbies/{id}/character body {"character_id"} -> refreshed
 *    roster (403 foreign sheet, 404 unknown id).
 *  - POST /api/v1/lobbies/{id}/launch optional {"force": bool}; an unready
 *    non-force launch answers 409 with a STRUCTURED detail:
 *    {"error":"MEMBERS_NOT_READY","message":...,
 *     "unready_members":[{"user_id","display_name"},...]}.
 *
 * Every route requires the HMAC session token via Authorization: Bearer
 * (never a query-string token — proxies log URLs verbatim).
 *
 * These tests stub fetch exactly like lore_store_auth.test.ts does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLobby,
  launchLobby,
  listCharacters,
  ownedCharacters,
  setMemberCharacter,
  setMemberReady,
  type Lobby,
  type StoredCharacter,
} from '../lobby_store';

const TOKEN = 'sig.payload.token';
const store = new Map<string, string>();

type FetchCall = { url: string; init: RequestInit };

function stubFetch(
  respond: () => { ok: boolean; status?: number; json: () => Promise<unknown> },
) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: (init ?? {}) as RequestInit });
    return respond();
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const ROSTER: Lobby = {
  lobby_id: 'L1',
  invite_code: 'VANE42',
  name: 'The Fall of Baron Vane',
  host_user_id: 'host-1',
  engine_session_id: null,
  members: [
    { user_id: 'host-1', display_name: 'Aldric', role: 'gm', ready: true, selected_character_id: null },
    { user_id: 'p2', display_name: 'Brenna', role: 'player', ready: false, selected_character_id: 'c9' },
  ],
};

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
});

describe('createLobby (iteration 73 — optional table selections on the wire)', () => {
  it('accepts a bare name and posts the legacy {name} body', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ROSTER }));

    const lobby = await createLobby('Doomvault');
    expect(calls[0].url).toBe('/api/v1/lobbies');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'Doomvault' });
    expect(lobby?.invite_code).toBe('VANE42');
  });

  it('forwards the optional rule_version / starting_level / party_size selections verbatim', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ROSTER }));

    await createLobby({
      name: 'The Fall of Baron Vane',
      rule_version: 'srd_5_1',
      starting_level: 3,
      party_size: 6,
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: 'The Fall of Baron Vane',
      rule_version: 'srd_5_1',
      starting_level: 3,
      party_size: 6,
    });
  });

  it('omits selections a caller never chose instead of sending placeholder values', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ROSTER }));

    await createLobby({ name: 'Doomvault' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ name: 'Doomvault' });
    expect(body.rule_version).toBeUndefined();
  });

  it('refuses the call entirely when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    expect(await createLobby('Doomvault')).toBeNull();
    expect(await createLobby({ name: 'Doomvault', party_size: 6 })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('setMemberReady', () => {
  it('refuses the call entirely when the caller is signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    expect(await setMemberReady('L1', true)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('POSTs {"ready": <bool>} with the Bearer header and returns the refreshed roster', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ROSTER }));

    const roster = await setMemberReady('L1', true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/lobbies/L1/ready');
    expect(calls[0].init.method).toBe('POST');
    // Identity rides the Authorization header, never the URL/query string.
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ready: true });

    expect(roster).not.toBeNull();
    expect(roster?.members.find((m) => m.user_id === 'p2')?.ready).toBe(false);
  });

  it('sends ready:false when toggling back down (the body is the whole state)', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ROSTER }));
    await setMemberReady('L1', false);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ready: false });
  });

  it('resolves null on a 403 non-member refusal instead of throwing', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 403, json: async () => ({ detail: 'Lobby not accessible' }) }));
    expect(await setMemberReady('nope', true)).toBeNull();
  });
});

describe('setMemberCharacter', () => {
  it('POSTs {"character_id"} with the Bearer header and returns the refreshed roster', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({ ok: true, json: async () => ROSTER }));

    const roster = await setMemberCharacter('L1', 'c9');
    expect(calls[0].url).toBe('/api/v1/lobbies/L1/character');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ character_id: 'c9' });
    expect(roster?.members.find((m) => m.user_id === 'p2')?.selected_character_id).toBe('c9');
  });

  it('resolves null when the sheet belongs to another player (403 foreign sheet)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 403,
      json: async () => ({ detail: 'You do not own this character' }),
    }));
    expect(await setMemberCharacter('L1', 'someone_elses_sheet')).toBeNull();
  });

  it('resolves null on an unknown character id (404)', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({ detail: 'Character not found' }) }));
    expect(await setMemberCharacter('L1', 'ghost-id')).toBeNull();
  });

  it('refuses the call entirely when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    expect(await setMemberCharacter('L1', 'c9')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('launchLobby readiness gate', () => {
  it('reports LAUNCHED with the engine session id on success', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ status: 'LAUNCHED', session_id: 'sess-77', lobby: ROSTER }),
    }));

    const result = await launchLobby('L1');
    expect(result).toMatchObject({ outcome: 'LAUNCHED', sessionId: 'sess-77' });
    expect(calls[0].url).toBe('/api/v1/lobbies/L1/launch');
    // Default launch posts WITHOUT a force flag — the server treats an absent
    // body as force=false, so the client must never imply an override.
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('surfaces the 409 MEMBERS_NOT_READY structure: message plus named unready members', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: false,
      status: 409,
      json: async () => ({
        detail: {
          error: 'MEMBERS_NOT_READY',
          message: 'Cannot launch: members not ready: Brenna',
          unready_members: [{ user_id: 'p2', display_name: 'Brenna' }],
        },
      }),
    }));

    const result = await launchLobby('L1');
    if (!result || result.outcome !== 'MEMBERS_NOT_READY') {
      throw new Error(`expected MEMBERS_NOT_READY, got ${JSON.stringify(result)}`);
    }
    expect(result.message).toMatch(/members not ready/i);
    expect(result.unreadyMembers).toEqual([
      { user_id: 'p2', display_name: 'Brenna' },
    ]);
  });

  it('passes {"force": true} only when the caller explicitly forces', async () => {
    store.set('aethertable_token', TOKEN);
    const calls = stubFetch(() => ({
      ok: true,
      json: async () => ({ status: 'LAUNCHED', session_id: 'sess-8', lobby: ROSTER }),
    }));

    await launchLobby('L1', { force: true });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ force: true });
  });

  it('maps a non-host 403 to NOT_ALLOWED rather than pretending the launch happened', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({ ok: false, status: 403, json: async () => ({ detail: 'Only the host can launch' }) }));
    const result = await launchLobby('L1');
    expect(result).toMatchObject({ outcome: 'NOT_ALLOWED' });
  });

  it('refuses the call entirely when signed out', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    expect(await launchLobby('L1')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('ownedCharacters — selector may only offer the caller\'s own sheets', () => {
  const roster: StoredCharacter[] = [
    { character_id: 'c1', owner_user_id: 'me', name: 'Brenna', character_class: 'ranger', level: 5 },
    { character_id: 'c2', owner_user_id: 'someone_else', name: 'Baron Vane', character_class: 'noble', level: 8 },
    { character_id: 'c3', owner_user_id: 'me', name: 'Pip', character_class: 'rogue', level: 3 },
  ];

  it('keeps only rows whose owner_user_id matches the signed-in user', () => {
    expect(ownedCharacters(roster, 'me').map((c) => c.character_id)).toEqual(['c1', 'c3']);
  });

  it('yields nothing for anonymous visitors rather than leaking any sheet', () => {
    expect(ownedCharacters(roster, null)).toEqual([]);
    expect(ownedCharacters(roster, '')).toEqual([]);
  });

  it('tolerates a malformed roster entry instead of crashing the selector', () => {
    const dirty = [...roster, { character_id: 'c4' } as unknown as StoredCharacter];
    expect(ownedCharacters(dirty, 'me').map((c) => c.character_id)).toEqual(['c1', 'c3']);
  });
});

describe('listCharacters scoping', () => {
  it('returns [] when signed out (no request, no fabricated roster)', async () => {
    const calls = stubFetch(() => ({ ok: true, json: async () => ({}) }));
    expect(await listCharacters()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('unwraps the {characters: [...]} envelope', async () => {
    store.set('aethertable_token', TOKEN);
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        characters: [
          { character_id: 'c1', owner_user_id: 'me', name: 'Brenna', character_class: 'ranger', level: 5 },
        ],
      }),
    }));
    const chars = await listCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0]).toMatchObject({ character_id: 'c1', name: 'Brenna' });
  });
});
