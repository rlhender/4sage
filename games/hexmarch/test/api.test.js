import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { replay } from '../engine/engine.js';

process.env.BOT_DELAY_MS = '1';
process.env.GRACE_MS = '40';
process.env.PHASE_MS = '20000';
const { startServer } = await import('../server/server.js');

const dataDir = mkdtempSync(path.join(tmpdir(), 'hexmarch-data-'));
let server = await startServer(0, { dataDir });
let base = `http://localhost:${server.address().port}`;
test.after(() => server.shutdown());

// A minimal HTTP player.
function player() {
  const me = { token: null, code: null };
  me.call = async (method, route, body) => {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(me.token ? { Authorization: `Bearer ${me.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { http: response.status, ...(await response.json()) };
  };
  me.create = async (name, extra) => { const r = await me.call('POST', '/rooms', { name, ...extra }); me.token = r.token; me.code = r.code; return r; };
  me.join = async (code, name) => { const r = await me.call('POST', `/rooms/${code}/join`, { name }); me.token = r.token; me.code = code; return r; };
  me.state = (query = '') => me.call('GET', `/rooms/${me.code}${query}`);
  me.move = (body) => me.call('POST', `/rooms/${me.code}/move`, body);
  // Seal something legal using only the JSON view: everything on the castle, then hold.
  me.hold = async () => {
    const s = await me.state('?view=json');
    return me.move(s.phase === 'place'
      ? { placements: [{ territory: s.game.players[s.seat].castle, armies: s.game.income }] }
      : { orders: [] });
  };
  return me;
}

test('the guide and the odds are served without a seat', async () => {
  const guide = await fetch(`${base}/api/guide`);
  assert.equal(guide.status, 200);
  const text = await guide.text();
  assert.match(text, /Hexmarch for AI players/);
  assert.match(text, /Border clashes/);
  const odds = await (await fetch(`${base}/api/odds?attackers=3&defenders=2`)).json();
  assert.ok(Math.abs(odds.win - 0.6564) < 0.001);
  const clash = await (await fetch(`${base}/api/odds?attackers=4&defenders=4&clash=1`)).json();
  assert.ok(Math.abs(clash.aWins - clash.bWins) < 1e-9);
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
});

test('requests are refused clearly when they are wrong', async () => {
  const ada = player();
  const made = await ada.create('Ada');
  assert.deepEqual([made.http, made.ok, made.code.length], [200, true, 4]);
  assert.equal((await ada.call('POST', '/rooms/ZZZZ/join', { name: 'x' })).http, 404);
  assert.equal((await ada.call('POST', `/rooms/${ada.code}/start`)).http, 409, 'one player cannot start');
  assert.match((await ada.move({ orders: [] })).error, /not started/);
  assert.equal((await fetch(`${base}/api/rooms/${ada.code}`)).status, 401, 'no token');
  assert.equal((await fetch(`${base}/api/rooms/${ada.code}?token=nope`)).status, 401);
  assert.equal((await fetch(`${base}/api/rooms/${ada.code}?token=${ada.token}`)).status, 200, 'the token may go in the query');
  assert.equal((await player().create('Bad', { rules: { castleGarison: 3 } })).http, 400);
  const grace = player();
  await grace.join(ada.code, 'Grace');
  assert.equal((await grace.call('POST', `/rooms/${ada.code}/bots`, { strategy: 'aggressive' })).http, 403, 'not the host');
  const raw = await fetch(`${base}/api/rooms`, { method: 'POST', body: '{not json' });
  assert.equal(raw.status, 400);
});

test('an AI plays a whole game over HTTP from briefings', async () => {
  const ai = player();
  await ai.create('Machine', { phaseSeconds: 30, rules: { maxRounds: 6 } });
  await ai.call('POST', `/rooms/${ai.code}/bots`, { strategy: 'aggressive' });
  await ai.call('POST', `/rooms/${ai.code}/bots`, { strategy: 'fortress' });
  const lobby = await ai.state();
  assert.deepEqual([lobby.status, lobby.mustAct, lobby.host], ['lobby', false, true]);
  assert.deepEqual(lobby.players.map((p) => p.kind), ['agent', 'bot', 'bot']);
  await ai.call('POST', `/rooms/${ai.code}/start`);

  let state;
  for (let guard = 0; guard < 40; guard++) {
    state = await ai.state('?wait=5');
    if (state.status === 'over' || !state.briefing.includes('ACTION NEEDED')) break;
    assert.equal(state.mustAct, true);
    assert.equal(state.game, undefined, 'the default view is the briefing only');
    // Decide from the text alone, as a language model would.
    const text = state.briefing;
    let reply;
    if (state.phase === 'place') {
      const income = Number(text.match(/place exactly (\d+) new armies/)[1]);
      const castle = Number(text.match(/^#(\d+) [^:\n]+ \(YOUR CASTLE\)/m)[1]);
      reply = { placements: [{ territory: castle, armies: income }] };
    } else {
      reply = { orders: [] };
    }
    const sealed = await ai.move(reply);
    assert.equal(sealed.ok, true, sealed.error);
    assert.equal(sealed.resolved, true, 'bots had already sealed, so the phase resolves at once');
  }
  // Either the six rounds ran out or a bot took the castle; both end the AI's part.
  assert.ok(state.status === 'over' || /castle has fallen/.test(state.briefing));
  if (state.status === 'over') assert.match(state.briefing, /GAME OVER/);
});

test('a person in the browser and an AI over HTTP share one game', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const seen = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    seen.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  // Resolves with a message that matches, whether it has arrived already or not.
  const next = (match) => new Promise((resolve, reject) => {
    const had = seen.findLast(match);
    if (had) { resolve(had); return; }
    const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 5000);
    waiters.push({ match, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
  });
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ t: 'create', name: 'Human' }));
  const { code } = await next((m) => m.t === 'joined');

  const ai = player();
  const joined = await ai.join(code, 'Machine');
  assert.equal(joined.seat, 1);
  const lobby = await next((m) => m.t === 'room' && m.players.length === 2);
  assert.deepEqual(lobby.players.map((p) => p.kind), ['human', 'agent']);

  // The AI long-polls in the lobby and is woken by the start.
  const woken = ai.state('?wait=10');
  ws.send(JSON.stringify({ t: 'start' }));
  const first = await woken;
  assert.deepEqual([first.status, first.mustAct, first.phase], ['playing', true, 'place']);

  // The AI seals; the person sees only that it has.
  await ai.hold();
  const sealed = await next((m) => m.t === 'room' && m.game?.players[1].ready);
  assert.equal(sealed.game.placements, null);
  assert.equal((await ai.state()).mustAct, false);

  // The AI waits for its next move while the person places.
  const waiting = ai.state('?wait=10');
  const human = seen.findLast((m) => m.t === 'room').game;
  ws.send(JSON.stringify({ t: 'submit', submission: { placements: [{ territory: human.players[0].castle, armies: human.income }] } }));
  const orders = await waiting;
  assert.deepEqual([orders.phase, orders.mustAct], ['orders', true]);
  assert.match(orders.briefing, /Human placed/);
  ws.close();
});

test('the MCP endpoint works with the official client', async () => {
  const client = new Client({ name: 'hexmarch-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  assert.equal(client.getServerVersion().name, 'hexmarch');
  assert.match(client.getInstructions(), /hexmarch_get_guide/);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ['hexmarch_create_room', 'hexmarch_get_state', 'hexmarch_submit_move', 'hexmarch_get_odds']) assert.ok(names.includes(name), name);
  assert.ok(tools.every((t) => t.inputSchema.type === 'object' && t.description.length > 20));

  const text = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content[0].text, isError: !!result.isError };
  };
  assert.match((await text('hexmarch_get_guide', {})).text, /The loop/);
  const made = JSON.parse((await text('hexmarch_create_room', { name: 'Toolie' })).text);
  const seat = { code: made.code, token: made.token };
  await text('hexmarch_add_bot', { ...seat, strategy: 'aggressive' });
  await text('hexmarch_start_game', seat);

  const state = await text('hexmarch_get_state', { ...seat, wait: 5 });
  const [head, ...rest] = state.text.split('\n\n');
  assert.equal(JSON.parse(head).mustAct, true);
  const brief = rest.join('\n\n');
  assert.match(brief, /^HEXMARCH  round 1/);
  const income = Number(brief.match(/place exactly (\d+) new armies/)[1]);
  const castle = Number(brief.match(/^#(\d+) [^:\n]+ \(YOUR CASTLE\)/m)[1]);

  const wrong = await text('hexmarch_submit_move', { ...seat, placements: [{ territory: castle, armies: income + 1 }] });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /exactly/);
  const right = await text('hexmarch_submit_move', { ...seat, placements: [{ territory: castle, armies: income }] });
  assert.equal(right.isError, false);
  assert.match(right.text, /phase: ORDERS/);
  assert.ok(Math.abs(JSON.parse((await text('hexmarch_get_odds', { attackers: 3, defenders: 2 })).text).win - 0.6564) < 0.001);
  assert.equal((await text('hexmarch_get_state', { code: 'ZZZZ', token: 'x' })).isError, true);
  await client.close();

  // Plain JSON-RPC, as a client without the SDK would send it.
  const post = (body) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await (await post({ jsonrpc: '2.0', id: 1, method: 'nope' })).json()).error.code, -32601);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
});

test('the example agent plays a game against bots over HTTP', async () => {
  const script = fileURLToPath(new URL('../examples/http-agent.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--server', base, '--strategy', 'tuned', '--bots', 'passive,fortress'], { timeout: 60_000 });
  assert.match(stdout, /is seated in room [A-Z]{4}/);
  assert.match(stdout, /Game over in round \d+|My castle fell/);
});

test('games survive a restart and finished games are filed as records', async () => {
  const ai = player();
  await ai.create('Keeper', { rules: { maxRounds: 2 } });
  await ai.call('POST', `/rooms/${ai.code}/bots`, { strategy: 'passive' });
  await ai.call('POST', `/rooms/${ai.code}/start`);
  await ai.hold();
  const before = await ai.state('?view=json');
  assert.equal(before.phase, 'orders');

  await new Promise((resolve) => setTimeout(resolve, 400)); // let the batched save land
  await server.shutdown();
  server = await startServer(0, { dataDir });
  base = `http://localhost:${server.address().port}`;

  const after = await ai.state('?view=json');
  assert.equal(after.status, 'playing', 'the room and the token still work');
  assert.deepEqual(after.game.territories, before.game.territories);
  assert.equal(after.mustAct, true);

  for (let guard = 0; guard < 6 && (await ai.state()).status !== 'over'; guard++) await ai.hold();
  assert.equal((await ai.state()).status, 'over');
  const files = readdirSync(path.join(dataDir, 'records')).filter((f) => f.endsWith(`-${ai.code}.json`));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(path.join(dataDir, 'records', files[0]), 'utf8'));
  assert.deepEqual(record.seats.map((s) => s.kind), ['agent', 'bot']);
  assert.equal(replay(record).result.round, record.result.round, 'the filed record replays');
});
