/**
 * Yjs CRDT relay (y-websocket).
 *
 * Merges Y.Doc updates causally from all peers and persists room docs to
 * ./ydata so rooms survive restarts. WebSocket upgrades require a
 * gateway-signed HMAC session token (?token=...), verified with the shared
 * AUTH_SECRET — the same credential contract as the Rust engine.
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
const decoding = require('lib0/decoding');
import { installSpeechGuard } from './ysync_speech_guard.mjs';

const PORT = process.env.PORT || 6380;
const DATA_DIR = process.env.YSYNC_DATA_DIR || path.join(process.cwd(), 'ydata');
fs.mkdirSync(DATA_DIR, { recursive: true });

const docPath = (room) => path.join(DATA_DIR, `${room.replace(/[^\w-]/g, '_')}.ydoc`);

// Simple file persistence: bindYDoc on load, flush on update.
const persistence = {
  bindState: async (_docName, ydoc) => {
    const file = docPath(_docName);
    if (fs.existsSync(file)) {
      try {
        Y.applyUpdate(ydoc, new Uint8Array(fs.readFileSync(file)));
      } catch {
        /* corrupted snapshot — start fresh */
      }
    }
    ydoc.on('update', () => {
      fs.writeFileSync(file, Buffer.from(Y.encodeStateAsUpdate(ydoc)));
    });
  },
  writeState: async (_docName, ydoc) => {
    fs.writeFileSync(docPath(_docName), Buffer.from(Y.encodeStateAsUpdate(ydoc)));
  },
};

setPersistence(persistence);

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

// --- Speech-map authorization (audit A2 finding #4) -------------------------
//
// Every speech-ledger entry lives under a per-owner key (`user:<userId>`);
// only that user's own devices may write it. The relay enforces this with
// per-writer attribution:
//
//   1. AWARENESS CLAIM BINDING — each peer's awareness state carries its
//      clientID and a `user_id` claim. On every awareness update we bind
//      clientID -> user_id ONLY when the claim matches the connection's
//      HMAC-verified identity; spoofed claims never become authoritative.
//   2. DELTA CHECK — every doc update is decoded; speech keys touched are
//      attributed to their writing clientIDs via step 1. Foreign or
//      unattributed writes are EVICTED from the room doc, and the corrective
//      delete-set update repairs every replica that already merged them.
//
// RESIDUAL threat model (documented honestly in scripts/ysync_speech_guard.mjs):
// re-poisoning with a fresh clock re-triggers eviction each time (loud, not
// silent); unattributed writers fail closed; non-speech maps are out of scope.

/** room name -> guard handle */
const speechGuards = new Map();

function guardForRoom(roomName) {
  let guard = speechGuards.get(roomName);
  if (!guard) {
    const doc = getYDoc(roomName);
    guard = installSpeechGuard(doc);
    doc.on('update', (update) => {
      try {
        guard.checkUpdate(update);
      } catch (e) {
        console.warn(`[ysync] speech-guard delta check failed for '${roomName}':`, e);
      }
    });
    speechGuards.set(roomName, guard);
  }
  return guard;
}

/**
 * Validate an awareness update against the connection's verified identity.
 * The payload layout mirrors y-protocols/awareness#applyAwarenessUpdate:
 * [varUint count] then per entry [varUint clientID][varUint clock][string JSON].
 * Claims that match the connection's HMAC-verified identity are bound to
 * their clientID for speech attribution; mismatched claims are rejected so
 * they can never bless a foreign speech write.
 */
function processAwarenessClaims(roomName, connKey, verifiedUserId, payloadBytes) {
  if (!verifiedUserId || !payloadBytes?.length) return;
  const guard = guardForRoom(roomName);
  try {
    const decoder = decoding.createDecoder(payloadBytes);
    const len = decoding.readVarUint(decoder);
    for (let i = 0; i < len; i++) {
      const clientId = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder); // clock — informational only here
      let claimed;
      try {
        const state = JSON.parse(decoding.readVarString(decoder));
        claimed = state && typeof state === 'object' ? state.user_id : null;
      } catch {
        claimed = null; // unparsable state: treat as no claim
      }
      if (!guard.bindClaim(verifiedUserId, clientId, claimed)) {
        console.warn(
          `[ysync] speech-guard: rejected awareness claim '${claimed}' from conn '${connKey}' (verified as '${verifiedUserId}')`,
        );
      }
    }
  } catch {
    /* malformed awareness payload: leave attribution untouched (fail closed) */
  }
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
    guardForRoom(roomName); // ensure the guard exists before any traffic flows
  } catch (e) {
    console.warn(`[ysync] speech-guard install failed for '${roomName}':`, e);
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    const connKey = `${roomName}#${identity.user_id}`;
    // Inspect awareness frames BEFORE y-websocket applies them, so claims are
    // validated against this connection's HMAC-verified identity.
    ws.on('message', (data, _isBinary) => {
      try {
        const bytes = new Uint8Array(data);
        if (bytes.length === 0 || bytes[0] !== 1 /* messageAwareness */) return;
        // Frame layout: [messageType][varUint8Array payload]
        const decoder = decoding.createDecoder(bytes.subarray(1));
        processAwarenessClaims(
          roomName,
          connKey,
          identity.user_id,
          decoding.readVarUint8Array(decoder),
        );
      } catch {
        /* malformed frame: y-websocket's own handler will reject it too */
      }
    });
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`[ysync] Yjs relay listening on :${PORT} (HMAC auth enforced)`);
});
