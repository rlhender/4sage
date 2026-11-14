// The HTTP API: everything an outside player needs, as plain JSON over HTTP.
// It is deliberately small and stateless (a token per seat) so that any
// program, model or agent harness can play with nothing more than HTTP.
// actions() is the single list of things a player can do; the MCP endpoint
// exposes the same list as tools.

import { captureOdds, clashOdds } from '../engine/odds.js';
import { resolveRules } from '../engine/rules.js';
import { briefing } from '../engine/briefing.js';
import { PRESETS } from '../ai/strategies.js';

const MAX_WAIT_SECONDS = 55;
const MAX_BODY = 64 * 1024;

const fail = (status, error) => ({ ok: false, status, error });

// What an outside player gets back: who they are, whether it is their move,
// and the game as a text briefing, as JSON, or both.
function report(hub, room, player, mode = 'brief') {
  const v = hub.view(room, player);
  const out = {
    ok: true,
    code: v.code,
    status: v.status, // lobby, playing or over
    seat: v.seat,
    host: v.hostId === v.you,
    mustAct: v.mustAct,
    secondsLeft: v.msLeft === null ? null : Math.round(v.msLeft / 1000),
    players: v.players.map((p, seat) => ({ seat, id: p.id, name: p.name, kind: p.kind })),
  };
  if (v.game) {
    out.round = v.game.round;
    out.phase = v.game.phase;
    out.result = v.game.result;
    if (mode !== 'json') out.briefing = briefing(v.game);
    if (mode !== 'brief') out.game = v.game;
  } else {
    out.note = out.host
      ? 'The game has not started. Start it when everyone has joined.'
      : 'Waiting in the lobby for the host to start the game.';
  }
  return out;
}

// Every action, in one place. Each takes plain arguments and returns
// { ok: true, ... } or { ok: false, status, error }.
export function actions(hub, guide) {
  const seated = (args, fn) => {
    const found = hub.find(args.code, args.token);
    return found ? fn(found.room, found.player) : fail(401, 'Unknown room code or token.');
  };
  const then = (outcome, room, player, extra = {}) => (outcome.ok ? { ...report(hub, room, player, 'brief'), ...extra } : outcome);
  const credentials = (made) => (made.ok
    ? { ...report(hub, made.room, made.player), token: made.player.token, keep: 'Send this code and token with every later call.' }
    : made);

  return {
    create_room: (a) => credentials(hub.create(a.name, { kind: 'agent', phaseSeconds: a.phaseSeconds, rules: a.rules })),
    join_room: (a) => credentials(hub.join(a.code, a.name, { kind: 'agent' })),
    add_bot: (a) => seated(a, (room, player) => then(hub.addBot(room, player, a.strategy), room, player)),
    remove_player: (a) => seated(a, (room, player) => then(hub.removePlayer(room, player, a.id), room, player)),
    set_options: (a) => seated(a, (room, player) => then(hub.setOptions(room, player, { phaseSeconds: a.phaseSeconds, rules: a.rules }), room, player)),
    start_game: (a) => seated(a, (room, player) => then(hub.start(room, player), room, player)),
    get_state: (a) => seated(a, async (room, player) => {
      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(a.wait) || 0));
      await hub.wait(room, player, seconds * 1000);
      return hub.rooms.has(room.code) ? report(hub, room, player, a.view) : fail(404, 'That room has closed.');
    }),
    submit_move: (a) => seated(a, (room, player) => {
      const outcome = hub.move(room, player, { placements: a.placements, orders: a.orders });
      return then(outcome, room, player, { resolved: outcome.resolved });
    }),
    retract_move: (a) => seated(a, (room, player) => then(hub.takeBack(room, player), room, player)),
    rematch: (a) => seated(a, (room, player) => then(hub.rematch(room, player), room, player)),
    leave_room: (a) => seated(a, (room, player) => hub.leave(room, player)),
    get_odds: (a) => {
      const [x, y] = [Number(a.attackers), Number(a.defenders)];
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return fail(400, 'attackers and defenders must be whole numbers.');
      // With a seat's code and token the odds use that game's rules.
      let rules = hub.find(a.code, a.token)?.room.game?.config.rules;
      try { rules ??= resolveRules(a.rules); } catch (err) { return fail(400, err.message); }
      return { ok: true, ...(a.clash ? clashOdds(x, y, rules) : captureOdds(x, y, rules, !!a.castle)) };
    },
    get_guide: () => ({ ok: true, guide: guide() }),
    list_strategies: () => ({ ok: true, strategies: Object.keys(PRESETS) }),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(Object.assign(new Error('The request body must be a JSON object.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

// method + path → [action, args from the path]
const ROUTES = [
  ['POST', /^\/api\/rooms$/, 'create_room'],
  ['POST', /^\/api\/rooms\/(\w+)\/join$/, 'join_room'],
  ['GET', /^\/api\/rooms\/(\w+)$/, 'get_state'],
  ['POST', /^\/api\/rooms\/(\w+)\/bots$/, 'add_bot'],
  ['DELETE', /^\/api\/rooms\/(\w+)\/players\/(\w+)$/, 'remove_player'],
  ['POST', /^\/api\/rooms\/(\w+)\/options$/, 'set_options'],
  ['POST', /^\/api\/rooms\/(\w+)\/start$/, 'start_game'],
  ['POST', /^\/api\/rooms\/(\w+)\/move$/, 'submit_move'],
  ['POST', /^\/api\/rooms\/(\w+)\/retract$/, 'retract_move'],
  ['POST', /^\/api\/rooms\/(\w+)\/rematch$/, 'rematch'],
  ['POST', /^\/api\/rooms\/(\w+)\/leave$/, 'leave_room'],
  ['GET', /^\/api\/odds$/, 'get_odds'],
  ['GET', /^\/api\/strategies$/, 'list_strategies'],
];

// Handles a request under /api. Returns false if the path is not ours.
export async function handleApi(act, guide, req, res, url) {
  if (!url.pathname.startsWith('/api')) return false;
  if (req.method === 'GET' && (url.pathname === '/api' || url.pathname === '/api/guide')) {
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(guide());
    return true;
  }
  const route = ROUTES.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
  if (!route) { sendJson(res, 404, { ok: false, error: 'No such endpoint. GET /api/guide lists them.' }); return true; }
  try {
    const [, code, id] = url.pathname.match(route[1]);
    const query = Object.fromEntries(url.searchParams);
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    for (const flag of ['clash', 'castle']) if (flag in query) query[flag] = !['0', 'false'].includes(query[flag]);
    const outcome = await act[route[2]]({ ...query, ...body, code: code ?? body.code, id, token: bearer ?? query.token ?? body.token });
    sendJson(res, outcome.ok ? 200 : outcome.status ?? 400, outcome.ok ? outcome : { ok: false, error: outcome.error });
  } catch (err) {
    sendJson(res, err.status ?? 500, { ok: false, error: err.status ? err.message : 'Something went wrong.' });
    if (!err.status) console.error(err);
  }
  return true;
}
