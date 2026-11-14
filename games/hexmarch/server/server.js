// Hexmarch server. One process serves three ways into the same rooms:
//   - the browser GUI, over a WebSocket at /ws
//   - any program or AI, over the JSON HTTP API under /api
//   - any MCP client, at /mcp
// It holds no rules; those live in engine/. Room logic lives in rooms.js.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadTuned } from '../ai/tuned.js';
import { createHub } from './rooms.js';
import { actions, handleApi } from './api.js';
import { handleMcp } from './mcp.js';
import { createStore, pickVettedMap } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/engine/': path.join(ROOT, 'engine'), '/': path.join(ROOT, 'client') };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const env = (name, fallback) => Number(process.env[name] ?? fallback);

// The instructions an AI player needs, served by the game itself.
let guideText = null;
const guide = () => (guideText ??= ['AGENTS.md', 'PLAYING.md'].map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n\n---\n\n'));

async function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (pathname === '/healthz') { res.writeHead(200).end('ok'); return; }
  if (pathname === '/') pathname = '/index.html';
  const prefix = pathname.startsWith('/engine/') ? '/engine/' : '/';
  const base = STATIC[prefix];
  const file = path.join(base, pathname.slice(prefix.length));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// One browser connection. Messages map one-to-one onto hub operations.
function serveSocket(hub, ws) {
  let seat = null; // { room, player } once this connection has a seat
  const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const sink = (view) => send({ t: 'room', ...view });
  const error = (message, code) => send({ t: 'error', message, code });
  sink.close = () => { seat = null; ws.close(4000, 'Signed in elsewhere'); };

  function take(room, player) {
    seat = { room, player };
    send({ t: 'joined', code: room.code, token: player.token });
    const previous = hub.attach(room, player, sink);
    if (previous && previous !== sink) previous.close?.();
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    try {
      if (!seat) {
        if (msg.t === 'create') {
          const made = hub.create(msg.name);
          return made.ok ? take(made.room, made.player) : error(made.error);
        }
        if (msg.t === 'join') {
          const made = hub.join(msg.code, msg.name);
          return made.ok ? take(made.room, made.player) : error(made.error);
        }
        if (msg.t === 'rejoin') {
          const found = hub.find(msg.code, msg.token);
          return found ? take(found.room, found.player) : error('That game is no longer available.', 'norejoin');
        }
        return error('Join a room first.');
      }
      const { room, player } = seat;
      const outcome = {
        leave: () => { seat = null; return hub.leave(room, player); },
        addBot: () => hub.addBot(room, player, msg.strategy),
        remove: () => hub.removePlayer(room, player, msg.id),
        options: () => hub.setOptions(room, player, { phaseSeconds: msg.phaseSeconds }),
        start: () => hub.start(room, player),
        rematch: () => hub.rematch(room, player),
        submit: () => hub.move(room, player, msg.submission),
        retract: () => hub.takeBack(room, player),
      }[msg.t]?.();
      if (outcome && !outcome.ok) error(outcome.error);
    } catch (err) {
      console.error(err);
      error('Something went wrong.');
    }
  });
  ws.on('close', () => { if (seat) hub.detach(seat.room, seat.player, sink); });
  ws.on('error', () => {});
}

export async function startServer(port = 3000, options = {}) {
  loadTuned();
  const store = options.dataDir ? createStore(options.dataDir) : null;
  const hub = createHub({
    phaseMs: env('PHASE_MS', 180_000),
    graceMs: env('GRACE_MS', 30_000),
    botDelayMs: env('BOT_DELAY_MS', 1500),
    roomTtlMs: env('ROOM_TTL_MS', 30 * 60_000),
    pickMapSeed: pickVettedMap,
    store,
  });
  for (const saved of store?.load() ?? []) hub.restore(saved);
  const act = actions(hub, guide);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/mcp') { await handleMcp(act, req, res); return; }
      if (await handleApi(act, guide, req, res, url)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      await serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });
  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    serveSocket(hub, ws);
  });

  // Drop dead sockets and rooms nobody has touched for a while.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
    hub.sweep();
  }, 30_000);
  sweep.unref();

  server.on('close', () => {
    clearInterval(sweep);
    hub.close();
    store?.flush();
  });
  // Stop at once: end long-polls and idle keep-alive connections too.
  server.shutdown = () => new Promise((resolve) => {
    server.close(resolve);
    for (const ws of wss.clients) ws.terminate();
    hub.close();
    server.closeAllConnections();
  });
  server.hub = hub;
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer(env('PORT', 3000), { dataDir: process.env.DATA_DIR });
  const { port } = server.address();
  console.log(`Hexmarch is running on http://localhost:${port}`);
  console.log(`  browser game  http://localhost:${port}/`);
  console.log(`  agent guide   http://localhost:${port}/api/guide`);
  console.log(`  MCP endpoint  http://localhost:${port}/mcp`);
  console.log(process.env.DATA_DIR ? `  saving games to ${process.env.DATA_DIR}` : '  not saving games (set DATA_DIR to keep them across restarts)');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.shutdown().then(() => process.exit(0)));
}
