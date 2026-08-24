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
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const Y = require('yjs');

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
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`[ysync] Yjs relay listening on :${PORT} (HMAC auth enforced)`);
});
