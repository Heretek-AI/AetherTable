/**
 * Yjs CRDT relay (y-websocket).
 *
 * Merges Y.Doc updates causally from all peers and persists room docs to
 * ./ydata so rooms survive restarts. WebSocket upgrades require a
 * gateway-signed HMAC session token (?token=...), verified with the shared
 * AUTH_SECRET — the same credential contract as the Rust engine.
 *
 * AUTHORIZATION MODEL (audit A3 findings #3 and #4)
 *
 * Every remote doc frame is authorized by the DELIVERING CONNECTION's
 * HMAC-verified identity, never by the clientIDs its structs claim. y-websocket
 * passes the originating conn object as the Yjs transaction origin, so the
 * connIdentity registry below (populated at upgrade from the verified token)
 * is the single source of truth for both guards:
 *
 *   - atmosphere (scripts/ysync_atmosphere_guard.mjs): only gm/admin
 *     connections may write or delete the 'atmosphere' map;
 *   - speech (scripts/ysync_speech_guard.mjs): a connection may write only
 *     its own `user:<userId>` ledger key.
 *
 * Struct clientIDs are attacker-chosen 32-bit values on the wire; treating
 * them as identity let any peer forge deltas claiming an already-bound GM or
 * victim clientID (audit A3 finding #3). Awareness claims are no longer part
 * of any authorization decision — the relay still parses awareness frames,
 * but only to keep them out of attribution entirely (fail closed by absence).
 *
 * AMPLIFICATION CONTROLS (audit A3 finding #4): each guard reports every
 * eviction to a per-connection token bucket; once a connection exhausts its
 * corrective-broadcast budget it is DISCONNECTED instead of being allowed to
 * trigger further repairs. Persistence is dirty-flag + 1s debounce so bursts
 * of updates coalesce into ONE whole-document disk write instead of one
 * synchronous write per update.
 *
 * Run from client/ where the y-websocket dependency is installed:
 *   node scripts/ysync-server.mjs
 */
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Dependencies live in client/node_modules; anchor resolution there so this
// script runs from any working directory (including the compose container).
const require = createRequire(new URL('../client/package.json', import.meta.url));
const wsModule = require('ws');
// ws <8 exposes Server; >=8 exposes WebSocketServer.
const WebSocketServer = wsModule.WebSocketServer || wsModule.Server;
const { setupWSConnection, setPersistence, getYDoc } = require('y-websocket/bin/utils');
const Y = require('yjs');
import { installSpeechGuard } from './ysync_speech_guard.mjs';
import { installAtmosphereGuard } from './ysync_atmosphere_guard.mjs';
import {
  createCorrectiveRateLimiter,
  createCorrectiveEventGate,
  createDebouncedPersister,
} from './ysync_relay_throttle.mjs';

const PORT = process.env.PORT || 6380;
const DATA_DIR = process.env.YSYNC_DATA_DIR || path.join(process.cwd(), 'ydata');
fs.mkdirSync(DATA_DIR, { recursive: true });

const docPath = (room) => path.join(DATA_DIR, `${room.replace(/[^\w-]/g, '_')}.ydoc`);

// --- Persistence: debounced whole-document flushes (audit A3 #4) ------------

function persistDoc(roomName, ydoc) {
  try {
    fs.writeFileSync(docPath(roomName), Buffer.from(Y.encodeStateAsUpdate(ydoc)));
  } catch (e) {
    console.warn(`[ysync] persistence flush failed for '${roomName}':`, e);
  }
}

/** room name -> debounced persister handle */
const persisters = new Map();

function persisterFor(roomName, ydoc) {
  let p = persisters.get(roomName);
  if (!p) {
    p = createDebouncedPersister(() => persistDoc(roomName, ydoc));
    persisters.set(roomName, p);
  }
  return p;
}

// Simple file persistence: bindYDoc on load, coalesced flush on update.
const persistence = {
  bindState: async (docName, ydoc) => {
    const file = docPath(docName);
    if (fs.existsSync(file)) {
      try {
        Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(file)));
      } catch {
        /* corrupted snapshot — start fresh */
      }
    }
    ydoc.on('update', () => {
      // Dirty-flag + 1s debounce: a burst of updates (including every guard
      // eviction broadcast) collapses into one synchronous whole-doc write.
      persisterFor(docName, ydoc).markDirty();
    });
  },
  writeState: async (docName, ydoc) => {
    const p = persisters.get(docName);
    if (p) p.flushNow();
    else persistDoc(docName, ydoc);
  },
};

setPersistence(persistence);

// --- Corrective-broadcast amplification gate (audit A3 #4) -------------------

/**
 * Per-connection token bucket over corrective-broadcast events. ~5 events/min
 * refilling continuously; an exhausted budget disconnects the offending
 * connection instead of allowing further amplification. The CURRENT event's
 * repair always happens first (correctness before rate limiting).
 */
const correctiveLimiter = createCorrectiveRateLimiter();
const correctiveGate = createCorrectiveEventGate({
  limiter: correctiveLimiter,
  disconnect: (conn) => {
    console.warn(
      '[ysync] throttle: corrective-broadcast budget exhausted; disconnecting abusive connection',
    );
    try {
      conn.close(4008, 'corrective-write budget exhausted');
    } catch {
      /* already dead */
    }
  },
});

// --- HMAC token verification (mirrors vtt-server/src/auth.rs) ---------------

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const dot = token.indexOf('.');
  const rawB64 = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);

  let raw;
  try {
    raw = Buffer.from(rawB64, 'base64url');
  } catch {
    return null;
  }

  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(raw).digest('hex');
  const sig = Buffer.from(sigHex, 'hex');
  if (sig.length !== expected.length / 2) return null;
  if (!crypto.timingSafeEqual(sig, Buffer.from(expected, 'hex'))) return null;

  try {
    const payload = JSON.parse(raw.toString('utf8'));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

const AUTH_SECRET =
  process.env.VTT_ENGINE_SECRET || process.env.AUTH_SECRET || 'aethertable-dev-secret';

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', service: 'vtt-ysync-relay' }));
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', setupWSConnection);

// --- Delivery-time identity registry ----------------------------------------
//
// conn object -> { userId, role }: populated at upgrade time from the
// HMAC-verified token. y-websocket passes this same conn object as the Yjs
// transaction origin for every remote frame, so BOTH guards authorize against
// what the relay VERIFIED at delivery time — not against struct clientIDs
// (attacker-chosen) and not against awareness claims (spoofable self-labels).

/** room name -> { speech, atmosphere } guard handles */
const speechGuards = new Map();

// conn object -> { userId, role }: populated at upgrade time from the
// HMAC-verified token (declared before the guards that capture it).
const connIdentity = new WeakMap();

function guardForRoom(roomName) {
  let guard = speechGuards.get(roomName);
  if (!guard) {
    const doc = getYDoc(roomName);
    const speechGuard = installSpeechGuard(doc, {
      userOfConnection: (origin) => connIdentity.get(origin)?.userId ?? null,
      onUnauthorizedWrite: (origin) => {
        if (origin != null) correctiveGate(origin);
      },
    });
    const atmosphereGuard = installAtmosphereGuard(doc, {
      roleOfConnection: (origin) => connIdentity.get(origin)?.role ?? null,
      onUnauthorizedWrite: (origin) => {
        if (origin != null) correctiveGate(origin);
      },
    });
    doc.on('update', (update, origin) => {
      try {
        // Both guards are gated on the DELIVERING connection's verified
        // identity. Relay-local corrective transactions have a null origin
        // and must not be re-checked — see each guard's WIRING CONTRACT.
        if (origin == null) return;
        speechGuard.checkUpdate(update, origin);
        atmosphereGuard.checkUpdate(update, origin);
      } catch (e) {
        console.warn(`[ysync] guard delta check failed for '${roomName}':`, e);
      }
    });
    guard = { speech: speechGuard, atmosphere: atmosphereGuard };
    speechGuards.set(roomName, guard);
  }
  return guard;
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  // y-websocket providers pass the room name as the pathname; tokens ride
  // the query string exactly like the engine's WS endpoint.
  const identity = verifyToken(url.searchParams.get('token') ?? '');
  if (!identity) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    console.warn(
      `[ysync] rejected unauthenticated upgrade for room '${url.pathname}'`
    );
    return;
  }
  // Room name = pathname minus leading slash and query string (the same slice
  // setupWSConnection uses as the Y.Doc name).
  const roomName = decodeURIComponent(url.pathname.slice(1).split('?')[0]);
  try {
    guardForRoom(roomName); // ensure the guards exist before any traffic flows
  } catch (e) {
    console.warn(`[ysync] guard install failed for '${roomName}':`, e);
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    // Register the verified identity under the conn object itself. y-websocket
    // passes this object as the transaction origin of every frame the
    // connection sends, making it the authorization key for both guards.
    const verifiedIdentity = { userId: identity.user_id, role: identity.role ?? null };
    connIdentity.set(ws, verifiedIdentity);
    ws.on('close', () => {
      connIdentity.delete(ws);
      // Free the connection's rate-budget slot with it.
      correctiveLimiter.forget(ws);
    });
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`[ysync] Yjs relay listening on :${PORT} (HMAC auth enforced)`);
});
