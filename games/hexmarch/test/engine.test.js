import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../engine/map.js';
import {
  NEUTRAL, createGame, exportRecord, getMap, incomeFor, observe, replay, retract, submit,
} from '../engine/engine.js';
import { captureOdds, clashOdds } from '../engine/odds.js';
import { describeEvent } from '../engine/report.js';

const names = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

// A two-player game with a hand-built position: seat 0 holds territory `a`,
// seat 1 holds its neighbour `b`, and both castles are moved out of the way.
function duel(armiesA, armiesB, seed = 3) {
  const state = createGame({ players: names(2), seed });
  const map = getMap(seed);
  const a = map.territories.find((t) => t.adj.length >= 2).id;
  const [b, c] = map.territories[a].adj;
  const spare = map.territories.map((t) => t.id).filter((t) => ![a, b, c].includes(t) && !map.territories[a].adj.includes(t));
  state.owner.fill(NEUTRAL);
  state.armies.fill(1);
  state.owner[a] = 0;
  state.owner[b] = 1;
  state.armies[a] = armiesA;
  state.armies[b] = armiesB;
  state.players[0].castle = spare[0];
  state.players[1].castle = spare[1];
  state.owner[spare[0]] = 0;
  state.owner[spare[1]] = 1;
  state.armies[spare[0]] = 9;
  state.armies[spare[1]] = 9;
  state.phase = 'orders';
  return { state, map, a, b, c, castles: [spare[0], spare[1]] };
}

const events = (state) => state.history.findLast((h) => h.events).events;
const seal = (state, seat, orders) => assert.ok(submit(state, seat, { orders }).ok);

test('maps are deterministic, fully assigned and connected', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const map = generateMap(seed);
    assert.equal(map.territories.length, 36, `seed ${seed}`);
    assert.deepEqual(map, generateMap(seed));
    for (const t of map.territories) {
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

test('a new game gives every player a castle and the right armies', () => {
  for (const [count, armies] of [[2, 36], [3, 31], [4, 26], [5, 22], [6, 18]]) {
    const state = createGame({ players: names(count), seed: 11 + count });
    assert.equal(state.phase, 'place');
    assert.ok(state.owner.every((o) => o >= 0 && o < count));
    const castles = state.players.map((p) => p.castle);
    assert.equal(new Set(castles).size, count);
    state.players.forEach((p, seat) => {
      assert.equal(state.owner[p.castle], seat);
      assert.ok(state.armies[p.castle] >= 5);
      assert.equal(state.armies.reduce((sum, n, t) => sum + (state.owner[t] === seat ? n : 0), 0), armies);
      assert.equal(state.income[seat], incomeFor(state, seat));
    });
  }
});

test('placements are sealed, validated, and revealed together', () => {
  const state = createGame({ players: names(2), seed: 5 });
  const mine = state.owner.indexOf(0);
  const theirs = state.owner.indexOf(1);
  const income = state.income[0];
  assert.match(submit(state, 0, { orders: [] }).error, /place phase/);
  assert.match(submit(state, 0, { placements: [{ territory: theirs, armies: income }] }).error, /not yours/);
  assert.match(submit(state, 0, { placements: [{ territory: mine, armies: income - 1 }] }).error, /exactly/);
  assert.match(submit(state, 0, { placements: [{ territory: mine, armies: 1.5 }] }).error, /whole number/);
  assert.match(submit(state, 7, { placements: [] }).error, /Unknown seat/);

  const before = state.armies[mine];
  assert.deepEqual(submit(state, 0, { placements: [{ territory: mine, armies: 1 }, { territory: mine, armies: income - 1 }] }), { ok: true, resolved: false });
  assert.equal(state.armies[mine], before, 'nothing is applied until everyone has sealed');
  assert.equal(observe(state, 1).submitted, null, 'a sealed placement is hidden from others');
  assert.equal(observe(state, 1).players[0].ready, true);
  assert.deepEqual(observe(state, 0).submitted, [{ territory: mine, armies: income }]);

  retract(state, 0);
  assert.equal(observe(state, 0).submitted, null);
  submit(state, 0, { placements: [{ territory: mine, armies: income }] });
  const done = submit(state, 1, { placements: [{ territory: theirs, armies: state.income[1] }] });
  assert.deepEqual(done, { ok: true, resolved: true });
  assert.equal(state.phase, 'orders');
  assert.equal(state.armies[mine], before + income);
  assert.deepEqual(observe(state, 1).placements[0], [{ territory: mine, armies: income }], 'placements are public once resolved');
});

test('orders must come from your land, cross a border and leave a garrison', () => {
  const { state, a, b, castles } = duel(5, 3);
  assert.match(submit(state, 0, { placements: [] }).error, /orders phase/);
  assert.match(submit(state, 0, { orders: [{ from: b, to: a, armies: 1 }] }).error, /not yours/);
  assert.match(submit(state, 0, { orders: [{ from: a, to: castles[1], armies: 1 }] }).error, /does not border/);
  assert.match(submit(state, 0, { orders: [{ from: a, to: b, armies: 5 }] }).error, /at most 4/);
  assert.match(submit(state, 0, { orders: [{ from: a, to: b, armies: 3 }, { from: a, to: b, armies: 2 }] }).error, /at most 4/);
  assert.match(submit(state, 0, { orders: [{ from: a, to: 99, armies: 1 }] }).error, /unknown territory/);
  assert.ok(submit(state, 0, { orders: [{ from: a, to: b, armies: 2 }, { from: a, to: b, armies: 2 }] }).ok);
  assert.deepEqual(state.submitted[0], [{ from: a, to: b, armies: 4 }], 'duplicate orders merge');
});

test('an unopposed attack fights the garrison left behind', () => {
  const { state, a, b } = duel(30, 2);
  seal(state, 0, [{ from: a, to: b, armies: 25 }]);
  seal(state, 1, []);
  const [battle] = events(state);
  assert.equal(battle.type, 'battle');
  assert.equal(battle.attackers, 25);
  assert.equal(battle.defenders, 2);
  assert.equal(battle.captured, true);
  assert.equal(state.owner[b], 0);
  assert.equal(state.armies[b], battle.attackersLeft);
  assert.equal(state.armies[a], 5);
});

test('forces attacking each other clash on the border before either reaches land', () => {
  const { state, a, b } = duel(40, 6);
  seal(state, 0, [{ from: a, to: b, armies: 35 }]);
  seal(state, 1, [{ from: b, to: a, armies: 5 }]);
  const [clash, battle, ...rest] = events(state).filter((e) => e.type !== 'gameOver');
  assert.equal(clash.type, 'clash');
  assert.equal(clash.a.armies + clash.b.armies, 40);
  assert.equal(clash.winner, 0);
  assert.equal(rest.length, 0, 'the beaten force never reaches its target');
  // The clash winner carries on against the single army left in b.
  assert.equal(battle.type, 'battle');
  assert.equal(battle.territory, b);
  assert.equal(battle.attackers, clash.a.armies === 35 ? clash.a.left : clash.b.left);
  assert.equal(battle.defenders, 1);
  assert.equal(state.owner[b], 0);
  assert.equal(state.armies[a], 5, 'the garrison left at home is untouched');
});

test('when two players attack one territory the larger force goes first', () => {
  const { state, a, b, c } = duel(30, 50);
  // c is neutral with 1 army, bordering a (seat 0). Give seat 1 a border with c too.
  const map = getMap(state.config.mapSeed);
  const d = map.territories[c].adj.find((t) => t !== a && t !== b && state.owner[t] === NEUTRAL);
  state.owner[d] = 1;
  state.armies[d] = 50;
  seal(state, 0, [{ from: a, to: c, armies: 10 }]);
  seal(state, 1, [{ from: d, to: c, armies: 40 }]);
  const battles = events(state).filter((e) => e.type === 'battle');
  assert.equal(battles.length, 2);
  assert.deepEqual([battles[0].attacker, battles[0].defender, battles[0].attackers], [1, NEUTRAL, 40]);
  assert.equal(battles[0].captured, true);
  assert.deepEqual([battles[1].attacker, battles[1].defender], [0, 1], 'the smaller force then attacks the new holder');
  assert.equal(battles[1].defenders, battles[0].attackersLeft);
});

test('moves arrive after the fighting, and attack if the destination has fallen', () => {
  const { state, a, b } = duel(4, 60);
  const map = getMap(state.config.mapSeed);
  // Seat 0 reinforces a from another of its territories while seat 1 storms a.
  const back = map.territories[a].adj.find((t) => t !== b);
  state.owner[back] = 0;
  state.armies[back] = 3;
  seal(state, 0, [{ from: back, to: a, armies: 2 }]);
  seal(state, 1, [{ from: b, to: a, armies: 55 }]);
  const [storm, late] = events(state).filter((e) => e.type === 'battle');
  assert.deepEqual([storm.attacker, storm.defenders, storm.captured], [1, 4, true], 'the reinforcements were not there yet');
  assert.deepEqual([late.attacker, late.attackers, late.late], [0, 2, true]);
  assert.equal(state.armies[back], 1);

  // A move into land that is still yours simply adds to it.
  const quiet = duel(4, 4);
  const from = quiet.castles[0];
  const to = getMap(3).territories[from].adj[0];
  quiet.state.owner[to] = 0;
  const had = quiet.state.armies[to];
  seal(quiet.state, 0, [{ from, to, armies: 8 }]);
  seal(quiet.state, 1, []);
  assert.deepEqual(events(quiet.state), [{ type: 'move', seat: 0, from, to, armies: 8 }]);
  assert.equal(quiet.state.armies[to], had + 8);
});

test('losing your castle eliminates you and the last castle wins', () => {
  const state = createGame({ players: names(3), seed: 9 });
  const map = getMap(9);
  const castle = state.players[2].castle;
  const next = map.territories[castle].adj[0];
  state.owner[next] = 0;
  state.armies[next] = 80;
  state.phase = 'orders';
  seal(state, 0, [{ from: next, to: castle, armies: 79 }]);
  seal(state, 1, []);
  seal(state, 2, []);
  assert.equal(state.players[2].alive, false);
  assert.equal(state.owner[castle], 0);
  assert.ok(!state.owner.includes(2), 'the rest of their land turns neutral');
  assert.ok(state.owner.includes(NEUTRAL));
  assert.deepEqual(events(state).at(-1), { type: 'eliminated', seat: 2, by: 0 });
  assert.equal(state.phase, 'place');
  assert.equal(state.round, 2);
  assert.equal(state.income[2], 0);
  assert.match(submit(state, 2, { placements: [] }).error, /eliminated/);

  // Seat 0 then takes seat 1's castle and wins.
  const last = state.players[1].castle;
  const door = map.territories[last].adj[0];
  state.owner[door] = 0;
  state.armies[door] = 80;
  state.phase = 'orders';
  seal(state, 0, [{ from: door, to: last, armies: 79 }]);
  seal(state, 1, []);
  assert.equal(state.phase, 'over');
  assert.deepEqual(state.result, { winner: 0, reason: 'lastCastle', round: 2 });
  assert.match(submit(state, 0, { orders: [] }).error, /over/);
  assert.match(describeEvent(events(state).at(-1), observe(state, 0)), /P1 wins/);
});

test('the round limit ends the game in favour of the largest realm', () => {
  const state = createGame({ players: names(2), seed: 4, maxRounds: 1 });
  for (const seat of [0, 1]) {
    submit(state, seat, { placements: [{ territory: state.players[seat].castle, armies: state.income[seat] }] });
  }
  state.owner[state.owner.findIndex((o, t) => o === 1 && t !== state.players[1].castle)] = 0;
  seal(state, 0, []);
  seal(state, 1, []);
  assert.deepEqual(state.result, { winner: 0, reason: 'roundLimit', round: 1 });
});

test('a game replays exactly from its record', () => {
  const state = createGame({ players: names(3), seed: 21 });
  for (let step = 0; step < 8 && state.phase !== 'over'; step++) {
    state.players.forEach((p, seat) => {
      if (!p.alive || state.phase === 'over') return;
      const mine = state.owner.flatMap((o, t) => (o === seat ? [t] : []));
      if (state.phase === 'place') {
        submit(state, seat, { placements: [{ territory: mine[step % mine.length], armies: state.income[seat] }] });
      } else {
        const from = mine.find((t) => state.armies[t] > 1);
        const orders = from === undefined ? [] : [{ from, to: getMap(21).territories[from].adj[0], armies: state.armies[from] - 1 }];
        submit(state, seat, { orders });
      }
    });
  }
  const record = JSON.parse(JSON.stringify(exportRecord(state)));
  assert.ok(record.rounds.length >= 3);
  const again = replay(record);
  assert.deepEqual(again.owner, state.owner);
  assert.deepEqual(again.armies, state.armies);
  assert.deepEqual(again.history.filter((h) => h.events), state.history.filter((h) => h.events));
});

test('observations are plain JSON that hides only sealed submissions', () => {
  const state = createGame({ players: names(3), seed: 2 });
  const obs = observe(state, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(obs)), obs);
  assert.equal(obs.you, 1);
  assert.equal(obs.territories.length, 36);
  assert.equal(obs.territories.filter((t) => t.castleOf !== undefined).length, 3);
  assert.equal(obs.income, state.income[1]);
  for (const t of obs.territories) assert.ok(t.adjacent.every((n) => obs.territories[n].adjacent.includes(t.id)));
});

test('battle odds are exact', () => {
  assert.equal(captureOdds(5, 0).win, 1);
  assert.equal(captureOdds(0, 5).win, 0);
  assert.ok(Math.abs(captureOdds(1, 1).win - 15 / 36) < 1e-12, 'one die each: the attacker needs a strictly higher roll');
  assert.ok(Math.abs(captureOdds(3, 2).win - 0.6564) < 0.001);
  assert.ok(captureOdds(10, 5).win > captureOdds(6, 5).win);
  const even = clashOdds(7, 7);
  assert.ok(Math.abs(even.aWins - even.bWins) < 1e-9);
  assert.ok(Math.abs(even.aWins + even.bWins + even.bothDestroyed - 1) < 1e-9);
  assert.ok(Math.abs(clashOdds(1, 1).bothDestroyed - 1 / 6) < 1e-12);
  assert.ok(captureOdds(600, 200).win > 0.99, 'large fights are scaled, not rejected');
});
