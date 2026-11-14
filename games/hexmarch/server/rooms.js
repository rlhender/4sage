// Rooms, seats and timers, with no knowledge of how players are connected.
// The WebSocket layer, the HTTP API and the MCP endpoint all call the same
// operations here, so a browser player, an outside AI and a built-in bot are
// just three kinds of seat in the same game.
//
// Every operation returns { ok: true, ... } or { ok: false, status, error }.

import { randomBytes, randomInt } from 'node:crypto';
import { MIN_PLAYERS, MAX_PLAYERS, createGame, observe, retract, submit } from '../engine/engine.js';
import { resolveRules } from '../engine/rules.js';
import { PRESETS, act, makeAgent } from '../ai/strategies.js';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BOT_NAMES = ['Vex', 'Orla', 'Brann', 'Sable', 'Quill', 'Maro'];
const MAX_PHASE_SECONDS = 86_400;

const fail = (status, error) => ({ ok: false, status, error });

export function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return name || 'Player';
}

export function createHub(config = {}) {
  const cfg = {
    phaseMs: 180_000, // default time everyone has to seal a phase; 0 means no limit
    graceMs: 30_000, // shorter wait when everyone still to move has dropped off
    botDelayMs: 1500, // pace of a game that only bots are still playing
    roomTtlMs: 30 * 60_000, // idle rooms are removed after this
    maxRooms: 500,
    pickMapSeed: () => randomInt(2 ** 31),
    store: null, // optional { save(snapshot), remove(code), record(room) }
    ...config,
  };
  const rooms = new Map();

  // ---------- helpers ----------

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
      if (!rooms.has(code)) return code;
    }
  }

  function addPlayer(room, name, kind, strategy) {
    const player = {
      id: randomBytes(4).toString('hex'),
      token: kind === 'bot' ? null : randomBytes(16).toString('hex'),
      name,
      kind, // 'human' (browser), 'agent' (outside AI over HTTP or MCP), 'bot' (built-in strategy)
      strategy: kind === 'bot' ? strategy : null,
      sink: null, // where a live connection wants its views pushed
    };
    room.players.push(player);
    return player;
  }

  const agentFor = (player) => makeAgent(PRESETS[player.strategy] ? player.strategy : 'balanced');
  const seatOf = (room, player) => room.players.indexOf(player);
  const isHost = (room, player) => room.hostId === player.id;
  const present = (player) => player.kind === 'agent' || (player.kind === 'human' && player.sink !== null);
  const status = (room) => (!room.game ? 'lobby' : room.game.phase === 'over' ? 'over' : 'playing');

  function mustAct(room, player) {
    const game = room.game;
    const seat = seatOf(room, player);
    return !!game && game.phase !== 'over' && game.players[seat].alive && game.submitted[seat] === null;
  }

  // What one player is sent: the room, and their own view of the game.
  function view(room, player) {
    const seat = seatOf(room, player);
    return {
      code: room.code,
      version: room.version,
      status: status(room),
      you: player.id,
      seat,
      hostId: room.hostId,
      options: { phaseSeconds: room.options.phaseMs / 1000, rules: room.options.rules },
      players: room.players.map((p) => ({ id: p.id, name: p.name, kind: p.kind, connected: p.kind === 'bot' || present(p) })),
      game: room.game ? observe(room.game, seat) : null,
      mustAct: mustAct(room, player),
      msLeft: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    };
  }

  // ---------- timers ----------

  // Seal a move on behalf of a seat: a bot's own, or a stand-in for a player
  // who ran out of time.
  function moveFor(room, seat) {
    const game = room.game;
    if (submit(game, seat, act(agentFor(room.players[seat]), observe(game, seat))).ok) return;
    submit(game, seat, game.phase === 'place'
      ? { placements: [{ territory: game.players[seat].castle, armies: game.income[seat] }] }
      : { orders: [] });
  }

  function moveForAll(room, isDue) {
    const game = room.game;
    const phase = `${game.round}:${game.phase}`;
    room.players.forEach((player, seat) => {
      if (`${game.round}:${game.phase}` !== phase) return; // resolved; the rest belong to the next phase
      if (game.players[seat].alive && game.submitted[seat] === null && isDue(player)) moveFor(room, seat);
    });
  }

  // Bots seal at once, everyone else gets until the deadline, and a game that
  // only bots are still playing is stepped along at a watchable pace.
  function drive(room) {
    clearTimeout(room.timer);
    room.timer = null;
    room.deadline = null;
    const game = room.game;
    if (!game || game.phase === 'over' || !room.players.some(present)) return;
    const pending = () => room.players.filter((p, seat) => p.kind !== 'bot' && game.players[seat].alive && game.submitted[seat] === null);
    const later = (ms) => {
      room.timer = setTimeout(() => { moveForAll(room, () => true); changed(room); }, Math.max(0, ms));
    };

    if (pending().length === 0) { later(cfg.botDelayMs); return; }
    moveForAll(room, (player) => player.kind === 'bot');
    const phase = `${game.round}:${game.phase}`;
    if (room.phase !== phase) {
      room.phase = phase;
      room.phaseEnds = room.options.phaseMs ? Date.now() + room.options.phaseMs : Infinity;
    }
    const grace = pending().every((p) => !present(p)) ? Date.now() + cfg.graceMs : Infinity;
    const at = Math.min(room.phaseEnds, grace);
    if (at === Infinity) return;
    room.deadline = at;
    later(at - Date.now());
  }

  // Call after any change: move the game on, tell everyone, save.
  function changed(room) {
    if (!rooms.has(room.code)) return;
    room.version++;
    room.lastActive = Date.now();
    drive(room);
    for (const player of room.players) player.sink?.(view(room, player));
    for (const waiter of [...room.waiters]) waiter();
    if (!cfg.store) return;
    cfg.store.save(snapshot(room));
    if (status(room) === 'over' && !room.recorded) {
      room.recorded = true;
      cfg.store.record(room);
    }
  }

  function drop(room) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    for (const waiter of [...room.waiters]) waiter();
    cfg.store?.remove(room.code);
  }

  // ---------- persistence ----------

  function snapshot(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      options: room.options,
      game: room.game,
      players: room.players.map(({ id, token, name, kind, strategy }) => ({ id, token, name, kind, strategy })),
    };
  }

  function restore(saved) {
    if (rooms.has(saved.code)) return;
    const room = {
      code: saved.code,
      hostId: saved.hostId,
      options: saved.options,
      game: saved.game,
      players: saved.players.map((p) => ({ ...p, sink: null })),
      version: 1,
      timer: null,
      deadline: null,
      phase: null,
      phaseEnds: 0,
      lastActive: Date.now(),
      waiters: new Set(),
    };
    rooms.set(room.code, room);
    drive(room);
  }

  // ---------- operations ----------

  function parseOptions(input, base) {
    const options = { ...base };
    if (input?.phaseSeconds !== undefined) {
      const s = Number(input.phaseSeconds);
      if (!Number.isFinite(s) || s < 0 || s > MAX_PHASE_SECONDS) throw new Error(`phaseSeconds must be from 0 (no limit) to ${MAX_PHASE_SECONDS}.`);
      options.phaseMs = Math.round(s * 1000);
    }
    if (input?.rules !== undefined) {
      resolveRules(input.rules); // throws on anything unknown
      options.rules = input.rules ?? {};
    }
    return options;
  }

  function create(name, { kind = 'human', ...input } = {}) {
    if (rooms.size >= cfg.maxRooms) return fail(503, 'The server is full. Try again later.');
    let options;
    try { options = parseOptions(input, { phaseMs: cfg.phaseMs, rules: {} }); } catch (err) { return fail(400, err.message); }
    const room = {
      code: newCode(), hostId: null, options, game: null, players: [],
      version: 0, timer: null, deadline: null, phase: null, phaseEnds: 0, lastActive: Date.now(), waiters: new Set(),
    };
    rooms.set(room.code, room);
    const player = addPlayer(room, cleanName(name), kind);
    room.hostId = player.id;
    changed(room);
    return { ok: true, room, player };
  }

  function join(code, name, { kind = 'human' } = {}) {
    const room = rooms.get(String(code ?? '').toUpperCase());
    if (!room) return fail(404, 'No room with that code.');
    if (room.game) return fail(409, 'That game has already started.');
    if (room.players.length >= MAX_PLAYERS) return fail(409, 'That room is full.');
    const player = addPlayer(room, cleanName(name), kind);
    changed(room);
    return { ok: true, room, player };
  }

  // The room and seat a token belongs to, or null.
  function find(code, token) {
    const room = rooms.get(String(code ?? '').toUpperCase());
    const player = token ? room?.players.find((p) => p.token === token) : undefined;
    if (!player) return null;
    room.lastActive = Date.now();
    return { room, player };
  }

  function setOptions(room, player, input) {
    if (!isHost(room, player)) return fail(403, 'Only the host can change the room settings.');
    if (room.game && input?.rules !== undefined) return fail(409, 'Rules can only be changed before the game starts.');
    try { room.options = parseOptions(input, room.options); } catch (err) { return fail(400, err.message); }
    room.phase = null; // apply a new time limit to the current phase
    changed(room);
    return { ok: true };
  }

  function addBot(room, player, strategy) {
    if (!isHost(room, player)) return fail(403, 'Only the host can add bots.');
    if (room.game) return fail(409, 'Bots can only be added before the game starts.');
    if (room.players.length >= MAX_PLAYERS) return fail(409, 'The room is full.');
    const kind = PRESETS[strategy] ? strategy : 'balanced';
    const used = room.players.map((p) => p.name.split(' ')[0]);
    const bot = addPlayer(room, `${BOT_NAMES.find((n) => !used.includes(n)) ?? 'Bot'} (${kind} bot)`, 'bot', kind);
    changed(room);
    return { ok: true, id: bot.id, name: bot.name };
  }

  function removePlayer(room, player, id) {
    if (!isHost(room, player)) return fail(403, 'Only the host can remove players.');
    if (room.game) return fail(409, 'Players can only be removed before the game starts.');
    const target = room.players.find((p) => p.id === id);
    if (!target || target === player) return fail(404, 'No such player to remove.');
    room.players.splice(room.players.indexOf(target), 1);
    changed(room);
    return { ok: true };
  }

  function start(room, player) {
    if (!isHost(room, player)) return fail(403, 'Only the host can start the game.');
    if (room.game) return fail(409, 'The game has already started.');
    if (room.players.length < MIN_PLAYERS) return fail(409, 'You need at least two players. Add a bot or invite someone.');
    room.game = createGame({
      players: room.players.map((p) => p.name),
      seed: randomInt(2 ** 31),
      mapSeed: cfg.pickMapSeed(),
      rules: room.options.rules,
    });
    room.phase = null;
    changed(room);
    return { ok: true };
  }

  function move(room, player, submission) {
    if (!room.game) return fail(409, 'The game has not started.');
    const outcome = submit(room.game, seatOf(room, player), submission);
    if (!outcome.ok) return fail(400, outcome.error);
    changed(room);
    return outcome;
  }

  function takeBack(room, player) {
    if (!room.game) return fail(409, 'The game has not started.');
    retract(room.game, seatOf(room, player));
    changed(room);
    return { ok: true };
  }

  function rematch(room, player) {
    if (!isHost(room, player)) return fail(403, 'Only the host can start a new game.');
    if (status(room) !== 'over') return fail(409, 'The game is not over.');
    room.game = null;
    room.recorded = false;
    changed(room);
    return { ok: true };
  }

  function leave(room, player) {
    player.sink = null;
    player.token = null;
    if (room.game) {
      // Mid-game the seat has to stay, so a bot takes it over.
      player.kind = 'bot';
      player.strategy = 'balanced';
    } else {
      room.players.splice(room.players.indexOf(player), 1);
    }
    const heir = room.players.find((p) => p.kind !== 'bot');
    if (!heir) { drop(room); return { ok: true }; }
    if (room.hostId === player.id) room.hostId = heir.id;
    changed(room);
    return { ok: true };
  }

  // A live connection starts or stops receiving views for a seat. attach
  // returns the connection it displaced, if any, so the caller can close it.
  function attach(room, player, sink) {
    const previous = player.sink;
    player.sink = sink;
    changed(room);
    return previous;
  }

  function detach(room, player, sink) {
    if (player.sink !== sink) return;
    player.sink = null;
    changed(room);
  }

  // Resolves when it is this player's move or the game is over, when the
  // room moves to a new phase, or after `ms`, whichever comes first.
  function wait(room, player, ms) {
    const settled = () => !rooms.has(room.code) || mustAct(room, player) || status(room) === 'over';
    const stage = () => `${status(room)}:${room.game?.round}:${room.game?.phase}`;
    const before = stage();
    if (ms <= 0 || settled()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); room.waiters.delete(check); resolve(); };
      const check = () => { if (settled() || stage() !== before) done(); };
      const timer = setTimeout(done, ms);
      room.waiters.add(check);
    });
  }

  function sweep() {
    for (const room of rooms.values()) {
      const live = room.players.some((p) => p.sink !== null);
      if (!live && Date.now() - room.lastActive > cfg.roomTtlMs) drop(room);
    }
  }

  function close() {
    for (const room of rooms.values()) {
      clearTimeout(room.timer);
      for (const waiter of [...room.waiters]) waiter();
    }
    rooms.clear();
  }

  return {
    rooms, create, join, find, view, setOptions, addBot, removePlayer, start, move, takeBack, rematch, leave,
    attach, detach, wait, sweep, close, restore, snapshot, isHost, status, mustAct,
  };
}
