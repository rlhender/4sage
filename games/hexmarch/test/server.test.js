import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.BOT_DELAY_MS = '1';
process.env.GRACE_MS = '40';
const { startServer } = await import('../server/server.js');

const server = await startServer(0);
const { port } = server.address();
test.after(() => server.close());

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

test('serves the client and the shared modules, and nothing outside them', async () => {
  const get = (path) => fetch(`http://localhost:${port}${path}`);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hexmarch/);
  assert.equal((await get('/shared/game.js')).status, 200);
  assert.equal((await get('/app.js')).status, 200);
  assert.equal((await get('/shared/../package.json')).status, 404);
  assert.equal((await get('/..%2fpackage.json')).status, 403);
  assert.equal((await get('/shared/..%2f..%2fpackage.json')).status, 403);
  assert.equal((await get('/shared/..%2fserver%2fserver.js')).status, 403);
});

test('two players can create, join and start a game', async () => {
  const { host, guest, hostView, guestView } = await twoPlayerGame();
  assert.equal(hostView.game.mapSeed, guestView.game.mapSeed);
  assert.deepEqual(hostView.game.owner, guestView.game.owner);
  assert.deepEqual(hostView.players.map((p) => p.name), ['Ada', 'Grace']);
  assert.notEqual(hostView.you, guestView.you);
  host.close();
  guest.close();
});

test('only the player whose turn it is can act, and everyone sees the result', async () => {
  const { host, guest, hostView } = await twoPlayerGame();
  const game = hostView.game;
  const [mover, waiter] = game.turn === 0 ? [host, guest] : [guest, host];
  const mine = game.owner.indexOf(game.turn);

  waiter.send({ t: 'action', action: { type: 'place', territory: game.owner.indexOf(1 - game.turn), count: 1 } });
  assert.match((await waiter.next((m) => m.t === 'error')).message, /not your turn/i);

  mover.send({ t: 'action', action: { type: 'place', territory: mine, count: 1 } });
  const seen = await waiter.next(isRoom((m) => m.game.reinforcements === game.reinforcements - 1));
  assert.equal(seen.game.armies[mine], game.armies[mine] + 1);
  host.close();
  guest.close();
});

test('a dropped player can rejoin with their token, and is played for meanwhile', async () => {
  const { host, guest, code, hostView } = await twoPlayerGame();
  const guestToken = guest.last('joined').token;
  const guestSeat = 1;
  guest.close();
  await host.next(isRoom((m) => !m.players[guestSeat].connected));

  // Hand the turn to the absent guest if it is not theirs already.
  if (hostView.game.turn !== guestSeat) {
    const mine = hostView.game.owner.indexOf(0);
    host.send({ t: 'action', action: { type: 'place', territory: mine, count: hostView.game.reinforcements } });
    host.send({ t: 'action', action: { type: 'endPhase' } });
    host.send({ t: 'action', action: { type: 'endPhase' } });
  }
  // After the grace period the server plays the guest's turn and play returns to the host.
  await host.next(isRoom((m) => m.game.turn === 0 && m.game.round > hostView.game.round));

  const back = client();
  await back.ready;
  back.send({ t: 'rejoin', code, token: 'wrong' });
  assert.equal((await back.next((m) => m.t === 'error')).code, 'norejoin');
  back.send({ t: 'rejoin', code, token: guestToken });
  const view = await back.next(isRoom());
  assert.equal(view.players[guestSeat].connected, true);
  assert.equal(view.you, view.players[guestSeat].id);
  host.close();
  back.close();
});

test('a host can play out a whole game against bots', async () => {
  const host = client();
  await host.ready;
  host.send({ t: 'create', name: 'Solo' });
  await host.next((m) => m.t === 'joined');
  host.send({ t: 'start' });
  assert.match((await host.next((m) => m.t === 'error')).message, /two players/);
  host.send({ t: 'addBot' });
  host.send({ t: 'addBot' });
  await host.next(isRoom((m) => m.players.length === 3));
  host.send({ t: 'start' });
  await host.next(isRoom((m) => m.game));
  // Leaving hands the seat to a bot; with no humans left the room is dropped.
  host.send({ t: 'leave' });
  host.send({ t: 'join', code: host.last('joined').code, name: 'Again' });
  assert.match((await host.next((m) => m.t === 'error')).message, /No room/);
  host.close();
});
