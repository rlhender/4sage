// Hexmarch server: serves the browser client and hosts games over WebSockets.
// It owns no rules. It passes sealed submissions to the engine, lets bots take
// their seats through the same interface, and sends each player their view.
// Rooms live in memory; nothing is persisted.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { MIN_PLAYERS, MAX_PLAYERS, createGame, observe, retract, submit } from '../engine/engine.js';
import { PRESETS, act, makeAgent } from '../ai/strategies.js';
import { loadTuned } from '../ai/tuned.js';

loadTuned();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = { '/engine/': path.join(ROOT, 'engine'), '/': path.join(ROOT, 'client') };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const env = (name, fallback) => Number(process.env[name] ?? fallback);
const PHASE_MS = env('PHASE_MS', 180_000); // time everyone has to seal a phase
const GRACE_MS = env('GRACE_MS', 30_000); // shorter wait when only dropped players are missing
const BOT_DELAY_MS = env('BOT_DELAY_MS', 1500); // pace of a game only bots are still playing
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
      game: room.game ? observe(room.game, seat) : null,
      msLeft: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    });
  });
}

const hasHumans = (room) => room.players.some((p) => !p.isBot && p.connected);

function touch(room) {
  room.emptySince = hasHumans(room) ? null : room.emptySince ?? Date.now();
}

// Seal a move on behalf of a seat: its own bot, or a stand-in for a human
// who ran out of time.
function moveFor(room, seat) {
  const game = room.game;
  const agent = room.players[seat].agent ?? makeAgent('balanced');
  if (submit(game, seat, act(agent, observe(game, seat))).ok) return;
  const castle = game.players[seat].castle;
  submit(game, seat, game.phase === 'place'
    ? { placements: [{ territory: castle, armies: game.income[seat] }] }
    : { orders: [] });
}

function moveForAll(room, isDue) {
  const game = room.game;
  const phase = `${game.round}:${game.phase}`;
  room.players.forEach((player, seat) => {
    if (`${game.round}:${game.phase}` !== phase) return; // the phase resolved; the rest belong to the next one
    if (game.players[seat].alive && game.submitted[seat] === null && isDue(player)) moveFor(room, seat);
  });
}

// Called after anything changes: bots seal at once, humans get until the
// deadline, and a game with only bots left is stepped along at a watchable pace.
function drive(room) {
  clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
  const game = room.game;
  if (!game || game.phase === 'over' || !hasHumans(room)) return;
  const waiting = () => room.players.filter((p, seat) => !p.isBot && game.players[seat].alive && game.submitted[seat] === null);
  const step = (isDue) => () => { moveForAll(room, isDue); drive(room); broadcast(room); };

  if (waiting().length === 0) {
    room.timer = setTimeout(step(() => true), BOT_DELAY_MS);
    return;
  }
  moveForAll(room, (player) => player.isBot);
  const phase = `${game.round}:${game.phase}`;
  if (room.phase !== phase) { room.phase = phase; room.phaseEnds = Date.now() + PHASE_MS; }
  const grace = waiting().every((p) => !p.connected) ? Date.now() + GRACE_MS : Infinity;
  room.deadline = Math.min(room.phaseEnds, grace);
  room.timer = setTimeout(step(() => true), Math.max(0, room.deadline - Date.now()));
}

function addPlayer(room, name, ws, strategy) {
  const player = {
    id: randomBytes(4).toString('hex'),
    token: randomBytes(16).toString('hex'),
    name,
    isBot: !ws,
    connected: !!ws,
    ws: ws ?? null,
    agent: ws ? null : makeAgent(strategy),
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
    player.agent = makeAgent('balanced');
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
  drive(room);
  broadcast(room);
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
  drive(room);
  broadcast(room);
}

function handle(ws, msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'create' || msg.t === 'join' || msg.t === 'rejoin') {
    if (ws.session) return;
    if (msg.t === 'create') {
      if (rooms.size >= MAX_ROOMS) return sendError(ws, 'The server is full. Try again later.');
      const room = { code: newCode(), players: [], game: null, timer: null, deadline: null, phase: null, emptySince: null };
      rooms.set(room.code, room);
      room.hostId = addPlayer(room, cleanName(msg.name), ws).id;
      return broadcast(room);
    }
    const room = rooms.get(String(msg.code ?? '').toUpperCase());
    if (msg.t === 'rejoin') {
      const player = room?.players.find((p) => !p.isBot && p.token === msg.token);
      if (!player) return sendError(ws, 'That game is no longer available.', 'norejoin');
      attach(ws, room, player);
      touch(room);
      drive(room);
      return broadcast(room);
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
      const strategy = PRESETS[msg.strategy] ? msg.strategy : 'balanced';
      const used = room.players.map((p) => p.name.split(' ')[0]);
      const name = BOT_NAMES.find((n) => !used.includes(n)) ?? 'Bot';
      addPlayer(room, `${name} (${strategy} bot)`, null, strategy);
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
      room.game = createGame({ players: room.players.map((p) => p.name), seed: randomInt(2 ** 31) });
      drive(room);
      return broadcast(room);
    }

    case 'rematch': {
      if (!isHost || !room.game || room.game.phase !== 'over') return;
      clearTimeout(room.timer);
      room.game = null;
      room.deadline = null;
      return broadcast(room);
    }

    case 'submit': {
      if (!room.game) return;
      const outcome = submit(room.game, room.players.indexOf(player), msg.submission);
      if (!outcome.ok) return sendError(ws, outcome.error);
      drive(room);
      return broadcast(room);
    }

    case 'retract': {
      if (!room.game) return;
      retract(room.game, room.players.indexOf(player));
      return broadcast(room);
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
  const prefix = pathname.startsWith('/engine/') ? '/engine/' : '/';
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
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });

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
