import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.BOT_DELAY_MS = '1';
process.env.GRACE_MS = '40';
process.env.PHASE_MS = '5000';
const { startServer } = await import('../server/server.js');

const server = await startServer(0);
const { port } = server.address();
test.after(() => server.shutdown());

// A test client that records every message and lets tests wait for one.
function client() {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  return {
    ws,
    ready: new Promise((resolve) => ws.on('open', resolve)),
    send: (msg) => ws.send(JSON.stringify(msg)),
    // Resolves with the next message matching the predicate.
    next: (match) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 5000);
      waiters.push({ match, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    }),
    last: (t) => inbox.filter((m) => m.t === t).at(-1),
    close: () => ws.close(),
  };
}

const isRoom = (pred = () => true) => (m) => m.t === 'room' && pred(m);

async function twoPlayerGame() {
  const host = client();
  const guest = client();
  await Promise.all([host.ready, guest.ready]);
  host.send({ t: 'create', name: 'Ada' });
  const { code } = await host.next((m) => m.t === 'joined');
  guest.send({ t: 'join', code: code.toLowerCase(), name: 'Grace' });
  await guest.next(isRoom((m) => m.players.length === 2));
  host.send({ t: 'start' });
  const [a, b] = await Promise.all([host.next(isRoom((m) => m.game)), guest.next(isRoom((m) => m.game))]);
  return { host, guest, code, hostView: a, guestView: b };
}

test('serves the client and the engine modules, and nothing outside them', async () => {
  const get = (path) => fetch(`http://localhost:${port}${path}`);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hexmarch/);
  assert.equal((await get('/engine/map.js')).status, 200);
  assert.equal((await get('/app.js')).status, 200);
  assert.equal((await get('/engine/../package.json')).status, 404);
  assert.equal((await get('/..%2fpackage.json')).status, 403);
  assert.equal((await get('/engine/..%2fserver%2fserver.js')).status, 403);
});

const castlePlacement = (view) => ({ placements: [{ territory: view.game.players[view.game.you].castle, armies: view.game.income }] });

test('two players see the same board and seal each phase in secret', async () => {
  const { host, guest, hostView, guestView } = await twoPlayerGame();
  assert.equal(hostView.game.mapSeed, guestView.game.mapSeed);
  assert.deepEqual(hostView.game.territories, guestView.game.territories);
  assert.deepEqual([hostView.game.you, guestView.game.you], [0, 1]);
  assert.equal(hostView.game.phase, 'place');
  assert.ok(hostView.msLeft > 0);

  guest.send({ t: 'submit', submission: { placements: [] } });
  assert.match((await guest.next((m) => m.t === 'error')).message, /exactly/);

  host.send({ t: 'submit', submission: castlePlacement(hostView) });
  const waiting = await guest.next(isRoom((m) => m.game.players[0].ready));
  assert.equal(waiting.game.phase, 'place');
  assert.equal(waiting.game.submitted, null, 'the guest cannot see what the host sealed');
  assert.equal(waiting.game.placements, null);

  guest.send({ t: 'submit', submission: castlePlacement(guestView) });
  const revealed = await host.next(isRoom((m) => m.game.phase === 'orders'));
  assert.deepEqual(revealed.game.placements[1], castlePlacement(guestView).placements);

  host.send({ t: 'submit', submission: { orders: [] } });
  guest.send({ t: 'submit', submission: { orders: [] } });
  const next = await guest.next(isRoom((m) => m.game.round === 2));
  assert.deepEqual(next.game.lastRound.events, []);
  host.close();
  guest.close();
});

test('a sealed move can be taken back until the phase resolves', async () => {
  const { host, guest, hostView } = await twoPlayerGame();
  host.send({ t: 'submit', submission: castlePlacement(hostView) });
  await guest.next(isRoom((m) => m.game.players[0].ready));
  host.send({ t: 'retract' });
  const view = await guest.next(isRoom((m) => !m.game.players[0].ready));
  assert.equal(view.game.phase, 'place');
  host.close();
  guest.close();
});

test('a dropped player is played for after a grace period and can rejoin', async () => {
  const { host, guest, code, hostView } = await twoPlayerGame();
  const guestToken = guest.last('joined').token;
  guest.close();
  await host.next(isRoom((m) => !m.players[1].connected));
  host.send({ t: 'submit', submission: castlePlacement(hostView) });
  // The guest is gone, so the server seals for them once the grace period ends.
  await host.next(isRoom((m) => m.game.phase === 'orders'));

  const back = client();
  await back.ready;
  back.send({ t: 'rejoin', code, token: 'wrong' });
  assert.equal((await back.next((m) => m.t === 'error')).code, 'norejoin');
  back.send({ t: 'rejoin', code, token: guestToken });
  const view = await back.next(isRoom());
  assert.equal(view.players[1].connected, true);
  assert.equal(view.game.you, 1);
  host.close();
  back.close();
});

test('bots with different strategies fill seats and play alongside a human', async () => {
  const host = client();
  await host.ready;
  host.send({ t: 'create', name: 'Solo' });
  await host.next((m) => m.t === 'joined');
  host.send({ t: 'start' });
  assert.match((await host.next((m) => m.t === 'error')).message, /two players/);
  host.send({ t: 'addBot', strategy: 'aggressive' });
  host.send({ t: 'addBot', strategy: 'fortress' });
  const lobby = await host.next(isRoom((m) => m.players.length === 3));
  assert.deepEqual(lobby.players.map((p) => p.kind), ['human', 'bot', 'bot']);
  assert.match(lobby.players[1].name, /aggressive bot/);
  assert.match(lobby.players[2].name, /fortress bot/);
  host.send({ t: 'start' });
  const start = await host.next(isRoom((m) => m.game));
  assert.deepEqual(start.game.players.map((p) => p.ready), [false, true, true], 'bots seal at once');

  // Hold every round; the bots do the fighting until the game ends.
  let view = start;
  for (let guard = 0; guard < 200 && !view.game.result; guard++) {
    const alive = view.game.players[0].alive;
    if (alive && view.game.submitted === null) {
      host.send({ t: 'submit', submission: view.game.phase === 'place' ? castlePlacement(view) : { orders: [] } });
    }
    const before = `${view.game.round}:${view.game.phase}`;
    view = await host.next(isRoom((m) => m.game.result || `${m.game.round}:${m.game.phase}` !== before));
  }
  assert.ok(view.game.result, 'the game finished');
  host.send({ t: 'rematch' });
  assert.equal((await host.next(isRoom((m) => !m.game))).players.length, 3);
  host.close();
});
