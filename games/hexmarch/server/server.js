// Hexmarch server: serves the client and runs every game authoritatively
// over WebSockets. Rooms live in memory; nothing is persisted.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  MIN_PLAYERS, MAX_PLAYERS, applyAction, botAction, createGame, forceEndTurn, viewFor,
} from '../shared/game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/shared/': path.join(ROOT, 'shared'), '/': path.join(ROOT, 'client') };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const env = (name, fallback) => Number(process.env[name] ?? fallback);
const BOT_DELAY_MS = env('BOT_DELAY_MS', 800); // pause between bot moves
const GRACE_MS = env('GRACE_MS', 30_000); // wait for a dropped player before playing for them
const IDLE_MS = env('IDLE_MS', 180_000); // wait for a connected but silent player
const ROOM_TTL_MS = env('ROOM_TTL_MS', 30 * 60_000); // empty rooms are removed after this
const MAX_ROOMS = 500;

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BOT_NAMES = ['Vex', 'Orla', 'Brann', 'Sable', 'Quill', 'Maro'];

const rooms = new Map();

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return name || 'Player';
}

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const sendError = (ws, message, code) => send(ws, { t: 'error', message, code });

function broadcast(room) {
  room.players.forEach((player, seat) => {
    if (!player.ws) return;
    send(player.ws, {
      t: 'room',
      code: room.code,
      you: player.id,
      hostId: room.hostId,
      players: room.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, connected: p.connected })),
      game: room.game ? viewFor(room.game, seat) : null,
    });
  });
}

const hasHumans = (room) => room.players.some((p) => !p.isBot && p.connected);

function touch(room) {
  room.emptySince = hasHumans(room) ? null : room.emptySince ?? Date.now();
}

// Decide whether the server has to move for the current player, and when.
function schedule(room) {
  clearTimeout(room.timer);
  room.timer = null;
  const game = room.game;
  if (!game || game.phase === 'over' || !hasHumans(room)) return;
  const seat = game.turn;
  const player = room.players[seat];
  const auto = player.isBot || room.autopilot === seat;
  const delay = auto ? BOT_DELAY_MS : player.connected ? IDLE_MS : GRACE_MS;
  room.timer = setTimeout(() => {
    if (!player.isBot) room.autopilot = seat;
    if (!applyAction(game, seat, botAction(game)).ok) forceEndTurn(game);
    afterMove(room, seat);
  }, delay);
}

function afterMove(room, seat) {
  if (room.game.turn !== seat) room.autopilot = null;
  broadcast(room);
  schedule(room);
}

function addPlayer(room, name, ws) {
  const player = {
    id: randomBytes(4).toString('hex'),
    token: randomBytes(16).toString('hex'),
    name,
    isBot: !ws,
    connected: !!ws,
    ws: ws ?? null,
  };
  room.players.push(player);
  if (ws) attach(ws, room, player);
  return player;
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) {
    player.ws.session = null;
    player.ws.close(4000, 'Signed in elsewhere');
  }
  player.ws = ws;
  player.connected = true;
  ws.session = { room, player };
  send(ws, { t: 'joined', code: room.code, token: player.token });
}

function removePlayer(room, player) {
  if (room.game) {
    // Mid-game the seat has to stay, so a bot takes it over.
    player.isBot = true;
    player.connected = false;
    player.ws = null;
    room.game.players[room.players.indexOf(player)].isBot = true;
  } else {
    room.players.splice(room.players.indexOf(player), 1);
  }
  const nextHost = room.players.find((p) => !p.isBot);
  if (!nextHost) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) room.hostId = nextHost.id;
  touch(room);
  broadcast(room);
  schedule(room);
}

function onDisconnect(ws) {
  const session = ws.session;
  if (!session) return;
  ws.session = null;
  const { room, player } = session;
  if (!room.game) { removePlayer(room, player); return; }
  player.connected = false;
  player.ws = null;
  touch(room);
  broadcast(room);
  schedule(room);
}

function handle(ws, msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'create' || msg.t === 'join' || msg.t === 'rejoin') {
    if (ws.session) return;
    if (msg.t === 'create') {
      if (rooms.size >= MAX_ROOMS) return sendError(ws, 'The server is full. Try again later.');
      const room = { code: newCode(), players: [], game: null, timer: null, autopilot: null, emptySince: null };
      rooms.set(room.code, room);
      room.hostId = addPlayer(room, cleanName(msg.name), ws).id;
      return broadcast(room);
    }
    const room = rooms.get(String(msg.code ?? '').toUpperCase());
    if (msg.t === 'rejoin') {
      const player = room?.players.find((p) => !p.isBot && p.token === msg.token);
      if (!player) return sendError(ws, 'That game is no longer available.', 'norejoin');
      attach(ws, room, player);
      if (room.game && room.autopilot === room.players.indexOf(player)) room.autopilot = null;
      touch(room);
      broadcast(room);
      return schedule(room);
    }
    if (!room) return sendError(ws, 'No room with that code.');
    if (room.game) return sendError(ws, 'That game has already started.');
    if (room.players.length >= MAX_PLAYERS) return sendError(ws, 'That room is full.');
    addPlayer(room, cleanName(msg.name), ws);
    touch(room);
    return broadcast(room);
  }

  if (!ws.session) return sendError(ws, 'Join a room first.');
  const { room, player } = ws.session;
  const isHost = room.hostId === player.id;

  switch (msg.t) {
    case 'leave':
      ws.session = null;
      return removePlayer(room, player);

    case 'addBot': {
      if (!isHost || room.game) return;
      if (room.players.length >= MAX_PLAYERS) return sendError(ws, 'The room is full.');
      const used = new Set(room.players.map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(`${n} (bot)`)) ?? 'Bot';
      addPlayer(room, `${name} (bot)`, null);
      return broadcast(room);
    }

    case 'removeBot': {
      if (!isHost || room.game) return;
      const bot = room.players.find((p) => p.isBot && p.id === msg.id);
      if (bot) room.players.splice(room.players.indexOf(bot), 1);
      return broadcast(room);
    }

    case 'start': {
      if (!isHost || room.game) return;
      if (room.players.length < MIN_PLAYERS) return sendError(ws, 'You need at least two players. Add a bot or invite a friend.');
      room.game = createGame(room.players, randomInt(2 ** 31));
      room.autopilot = null;
      broadcast(room);
      return schedule(room);
    }

    case 'rematch': {
      if (!isHost || !room.game || room.game.phase !== 'over') return;
      clearTimeout(room.timer);
      room.game = null;
      room.autopilot = null;
      return broadcast(room);
    }

    case 'action': {
      const game = room.game;
      if (!game) return;
      const seat = room.players.indexOf(player);
      const result = applyAction(game, seat, msg.action);
      if (!result.ok) return sendError(ws, result.error);
      return afterMove(room, seat);
    }

    default:
  }
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/healthz') { res.writeHead(200).end('ok'); return; }
  if (pathname === '/') pathname = '/index.html';
  const prefix = pathname.startsWith('/shared/') ? '/shared/' : '/';
  const base = STATIC[prefix];
  const file = path.join(base, pathname.slice(prefix.length));
  if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

export function startServer(port = 3000) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try { handle(ws, msg); } catch (err) { console.error(err); sendError(ws, 'Something went wrong.'); }
    });
    ws.on('close', () => onDisconnect(ws));
    ws.on('error', () => {});
  });

  // Drop dead sockets and rooms nobody has been in for a while.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
    for (const room of rooms.values()) {
      if (room.emptySince && Date.now() - room.emptySince > ROOM_TTL_MS) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
      }
    }
  }, 30_000);
  sweep.unref();

  server.on('close', () => {
    clearInterval(sweep);
    for (const room of rooms.values()) clearTimeout(room.timer);
    rooms.clear();
    for (const ws of wss.clients) ws.terminate();
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer(env('PORT', 3000));
  console.log(`Hexmarch is running on http://localhost:${server.address().port}`);
}
