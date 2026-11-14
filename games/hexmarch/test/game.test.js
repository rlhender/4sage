import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, rng32 } from '../shared/map.js';
import {
  applyAction, botAction, createGame, findSet, forceEndTurn, getMap, isSet,
  reachable, reinforcementsFor, tradeValue, viewFor,
} from '../shared/game.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` }));

// Feeds dice rolls: each value is the face the next die should show.
const dice = (...faces) => {
  let i = 0;
  return () => (faces[i++ % faces.length] - 1) / 6 + 0.01;
};

// A game with a hand-built position on a real map, player 0 to move.
function setup(seed = 7, count = 2) {
  const state = createGame(players(count), seed, rng32(seed));
  state.turn = 0;
  state.phase = 'reinforce';
  state.reinforcements = 3;
  return { state, map: getMap(seed) };
}

test('maps are deterministic, fully assigned and connected', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const map = generateMap(seed);
    assert.equal(map.territories.length, 36, `seed ${seed}`);
    assert.deepEqual(map, generateMap(seed), `seed ${seed} is not deterministic`);
    for (const t of map.territories) {
      assert.ok(t.cells.length >= 2, `seed ${seed}: ${t.name} is too small`);
      assert.ok(t.adj.length >= 1, `seed ${seed}: ${t.name} has no neighbours`);
      for (const n of t.adj) assert.ok(map.territories[n].adj.includes(t.id), 'adjacency must be symmetric');
    }
    const seen = new Set([0]);
    const queue = [0];
    while (queue.length) {
      for (const n of map.territories[queue.pop()].adj) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    assert.equal(seen.size, 36, `seed ${seed}: map is not connected`);
  }
});

test('a new game deals every territory and the right number of armies', () => {
  for (const [count, armies] of [[2, 36], [3, 31], [4, 26], [5, 22], [6, 18]]) {
    const state = createGame(players(count), 11, rng32(count));
    assert.ok(state.owner.every((o) => o >= 0 && o < count));
    assert.ok(state.armies.every((n) => n >= 1));
    for (let p = 0; p < count; p++) {
      const total = state.armies.reduce((sum, n, t) => sum + (state.owner[t] === p ? n : 0), 0);
      assert.equal(total, armies);
    }
    assert.equal(state.phase, 'reinforce');
    assert.equal(state.reinforcements, reinforcementsFor(state, state.turn));
  }
});

test('reinforcements count territories and region bonuses', () => {
  const { state, map } = setup();
  state.owner.fill(1);
  state.owner[0] = 0;
  assert.equal(reinforcementsFor(state, 0), 3);
  const region = map.regions[2];
  region.territories.forEach((t) => { state.owner[t] = 0; });
  const owned = state.owner.filter((o) => o === 0).length;
  assert.equal(reinforcementsFor(state, 0), Math.max(3, Math.floor(owned / 3)) + region.bonus);
  state.owner.fill(0);
  assert.equal(reinforcementsFor(state, 0), 12 + map.regions.reduce((sum, r) => sum + r.bonus, 0));
});

test('card sets and trade values', () => {
  assert.ok(isSet([1, 1, 1]));
  assert.ok(isSet([0, 1, 2]));
  assert.ok(!isSet([0, 0, 1]));
  assert.equal(findSet([0, 0, 1, 1]), null);
  assert.deepEqual(findSet([0, 0, 1, 2]), [0, 2, 3]);
  assert.deepEqual([0, 1, 5, 6, 7].map(tradeValue), [4, 6, 15, 20, 25]);
});

test('turn order and phase rules are enforced', () => {
  const { state } = setup();
  const mine = state.owner.indexOf(0);
  const theirs = state.owner.indexOf(1);
  assert.equal(applyAction(state, 1, { type: 'endPhase' }).ok, false, 'wrong player');
  assert.equal(applyAction(state, 0, { type: 'endPhase' }).ok, false, 'armies left to place');
  assert.equal(applyAction(state, 0, { type: 'place', territory: theirs, count: 1 }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'place', territory: mine, count: 4 }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'place', territory: mine, count: 1.5 }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'attack', from: mine, to: theirs }).ok, false, 'wrong phase');
  const before = state.armies[mine];
  assert.ok(applyAction(state, 0, { type: 'place', territory: mine, count: 3 }).ok);
  assert.equal(state.armies[mine], before + 3);
  assert.equal(state.phase, 'attack', 'placing the last army starts the attack phase');
});

test('trading a set adds armies and five cards force a trade', () => {
  const { state } = setup();
  const mine = state.owner.indexOf(0);
  state.players[0].cards = [0, 0, 1, 1, 2];
  assert.equal(applyAction(state, 0, { type: 'place', territory: mine, count: 1 }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'trade', cards: [0, 1, 2] }).ok, false, 'not a set');
  assert.equal(applyAction(state, 0, { type: 'trade', cards: [0, 0, 2] }).ok, false, 'duplicate index');
  assert.ok(applyAction(state, 0, { type: 'trade', cards: [0, 2, 4] }).ok);
  assert.deepEqual(state.players[0].cards, [0, 1]);
  assert.equal(state.reinforcements, 7);
  assert.equal(state.trades, 1);
});

// Finds a border between player 0 and player 1 and sets the armies on it.
function border(state, map, attackers, defenders) {
  for (const t of map.territories) {
    const to = t.adj.find((n) => state.owner[t.id] === 0 && state.owner[n] === 1);
    if (to === undefined) continue;
    state.armies[t.id] = attackers;
    state.armies[to] = defenders;
    state.phase = 'attack';
    return { from: t.id, to };
  }
  throw new Error('no border found');
}

test('combat compares the highest dice and ties go to the defender', () => {
  const { state, map } = setup();
  const { from, to } = border(state, map, 5, 3);
  // Attacker rolls 6,3,1 against defender 5,3: one loss each.
  assert.ok(applyAction(state, 0, { type: 'attack', from, to }, dice(6, 3, 1, 5, 3)).ok);
  assert.equal(state.armies[from], 4);
  assert.equal(state.armies[to], 2);
  assert.deepEqual(state.combat.att, [6, 3, 1]);
  assert.deepEqual(state.combat.def, [5, 3]);
  assert.equal(state.combat.conquered, false);
  assert.equal(state.owner[to], 1);
});

test('attacks must cross a border with at least two armies', () => {
  const { state, map } = setup();
  const { from, to } = border(state, map, 1, 1);
  assert.equal(applyAction(state, 0, { type: 'attack', from, to }).ok, false);
  state.armies[from] = 3;
  const far = map.territories.find((t) => state.owner[t.id] === 1 && !map.territories[from].adj.includes(t.id));
  assert.equal(applyAction(state, 0, { type: 'attack', from, to: far.id }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'attack', from, to: from }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'attack', from, to: 99 }).ok, false);
});

test('conquest moves the attacking dice in and offers the rest', () => {
  const { state, map } = setup();
  const { from, to } = border(state, map, 6, 1);
  assert.ok(applyAction(state, 0, { type: 'attack', from, to }, dice(6, 6, 6, 1)).ok);
  assert.equal(state.owner[to], 0);
  assert.equal(state.armies[to], 3);
  assert.equal(state.armies[from], 3);
  assert.deepEqual(state.pending, { from, to, max: 2 });
  assert.equal(applyAction(state, 0, { type: 'advance', count: 3 }).ok, false);
  assert.ok(applyAction(state, 0, { type: 'advance', count: 2 }).ok);
  assert.equal(state.armies[to], 5);
  assert.equal(state.armies[from], 1);
  assert.equal(state.pending, null);
  assert.equal(state.conquered, true);
});

test('blitz keeps rolling until the attacker runs dry', () => {
  const { state, map } = setup();
  const { from, to } = border(state, map, 4, 9);
  assert.ok(applyAction(state, 0, { type: 'attack', from, to, blitz: true }, dice(1)).ok);
  assert.equal(state.armies[from], 1);
  assert.equal(state.armies[to], 9);
  assert.equal(state.combat.attLoss, 3);
});

test('a card is earned only on turns with a conquest', () => {
  const { state, map } = setup();
  const { from, to } = border(state, map, 6, 1);
  applyAction(state, 0, { type: 'attack', from, to }, dice(6, 6, 6, 1));
  applyAction(state, 0, { type: 'endPhase' });
  assert.equal(state.phase, 'fortify');
  applyAction(state, 0, { type: 'endPhase' });
  assert.equal(state.players[0].cards.length, 1);
  assert.equal(state.turn, 1);
  assert.equal(state.phase, 'reinforce');
  forceEndTurn(state);
  assert.equal(state.players[1].cards.length, 0);
  assert.equal(state.turn, 0);
  assert.equal(state.round, 2);
});

test('fortify needs a chain of owned land and ends the turn', () => {
  const { state, map } = setup();
  state.phase = 'fortify';
  const from = map.territories.find((t) => state.owner[t.id] === 0 && reachable(state, t.id).size > 0).id;
  const to = [...reachable(state, from)][0];
  const cut = state.owner.findIndex((o, t) => o === 0 && t !== from && !reachable(state, from).has(t));
  state.armies[from] = 5;
  assert.equal(applyAction(state, 0, { type: 'fortify', from, to, count: 5 }).ok, false, 'must leave one behind');
  if (cut >= 0) assert.equal(applyAction(state, 0, { type: 'fortify', from, to: cut, count: 1 }).ok, false);
  const before = state.armies[to];
  assert.ok(applyAction(state, 0, { type: 'fortify', from, to, count: 4 }).ok);
  assert.equal(state.armies[from], 1);
  assert.equal(state.armies[to], before + 4);
  assert.equal(state.turn, 1);
});

test('eliminating a player takes their cards, and the last one standing wins', () => {
  const { state, map } = setup(7, 3);
  // Player 2 holds one territory next to player 0; player 1 holds everything else.
  const home = map.territories[0];
  state.owner.fill(1);
  state.owner[home.id] = 0;
  state.owner[home.adj[0]] = 2;
  state.armies.fill(1);
  state.armies[home.id] = 10;
  state.players[2].cards = [0, 1];
  state.phase = 'attack';
  assert.ok(applyAction(state, 0, { type: 'attack', from: home.id, to: home.adj[0] }, dice(6, 6, 6, 1)).ok);
  assert.equal(state.players[2].alive, false);
  assert.deepEqual(state.players[0].cards, [0, 1]);
  assert.equal(state.phase, 'attack');

  // Skipped once eliminated.
  applyAction(state, 0, { type: 'endPhase' });
  applyAction(state, 0, { type: 'endPhase' });
  assert.equal(state.turn, 1);
  forceEndTurn(state);
  assert.equal(state.turn, 0);

  // Reduce player 1 to a single territory and take it.
  state.owner.fill(0);
  state.owner[home.adj[0]] = 1;
  state.armies[home.adj[0]] = 1;
  state.phase = 'attack';
  assert.ok(applyAction(state, 0, { type: 'attack', from: home.id, to: home.adj[0] }, dice(6, 6, 6, 1)).ok);
  assert.equal(state.phase, 'over');
  assert.equal(state.winner, 0);
  assert.equal(applyAction(state, 0, { type: 'endPhase' }).ok, false);
});

test('views hide other players\' hands', () => {
  const { state } = setup();
  state.players[0].cards = [0, 1];
  state.players[1].cards = [2];
  const view = viewFor(state, 1);
  assert.equal(view.players[0].cards, undefined);
  assert.equal(view.players[0].cardCount, 2);
  assert.deepEqual(view.players[1].cards, [2]);
});

test('bots always make legal moves and games between them finish', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = rng32(seed * 977);
    const state = createGame(players(2 + (seed % 5)), seed, rand);
    let steps = 0;
    while (state.phase !== 'over') {
      const action = botAction(state);
      const result = applyAction(state, state.turn, action, rand);
      assert.ok(result.ok, `seed ${seed}: bot tried ${JSON.stringify(action)}: ${result.error}`);
      assert.ok(state.armies.every((n) => n >= 1), `seed ${seed}: empty territory`);
      assert.ok(++steps < 200_000, `seed ${seed}: game did not finish`);
    }
    assert.equal(state.players.filter((p) => p.alive).length, 1);
    assert.ok(state.owner.every((o) => o === state.winner));
  }
});
