import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exportRecord, replay } from '../engine/engine.js';
import { rng32 } from '../engine/map.js';
import { PRESETS, WEIGHTS, makeAgent } from '../ai/strategies.js';
import { playGame, simulate, tune } from '../ai/arena.js';

const CLI = fileURLToPath(new URL('../cli/hexmarch.js', import.meta.url));
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('every strategy plays complete, legal games at every table size', () => {
  const kinds = [...Object.keys(PRESETS), 'random'];
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng32(seed);
    const agents = Array.from({ length: 2 + (seed % 5) }, (_, i) => makeAgent(kinds[(seed + i) % kinds.length], `p${i}`, rand));
    const state = playGame(agents, seed); // throws on any illegal submission
    assert.equal(state.phase, 'over');
    assert.ok(state.armies.every((n) => n >= 1), `seed ${seed}: empty territory`);
    assert.ok(state.result.round <= state.config.rules.maxRounds);
    // The record alone reproduces the game.
    assert.deepEqual(replay(exportRecord(state)).owner, state.owner);
  }
});

test('simulation is repeatable and the personalities beat aimless play', () => {
  const run = () => simulate({ strategies: ['aggressive', 'fortress', 'random'], games: 60, seed: 3 });
  const first = run();
  assert.deepEqual(first.results.map((r) => r.wins), run().results.map((r) => r.wins));
  assert.equal(first.results.reduce((sum, r) => sum + r.wins, 0) + first.draws, 60);
  const wins = Object.fromEntries(first.results.map((r) => [r.name, r.wins]));
  assert.ok(wins.aggressive > wins.random && wins.fortress > wins.random, JSON.stringify(wins));
});

test('tuning keeps weights in range and never picks a worse champion', () => {
  const result = tune({ generations: 2, games: 12, seed: 5 });
  for (const [key, [lo, hi]] of Object.entries(WEIGHTS)) {
    assert.ok(result.weights[key] >= lo && result.weights[key] <= hi, key);
  }
  for (const g of result.history) assert.ok(g.winRate >= g.championBefore);
});

test('a game can be played one JSON submission at a time from the command line', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'hexmarch-')), 'game.json');
  const start = JSON.parse(cli('new', '--file', file, '--players', 'me,aggressive,fortress', '--seed', '8'));
  assert.equal(start.phase, 'place');
  assert.equal(start.you, 0);
  assert.equal(start.players[1].ready, true, 'bots seal straight away');

  const castle = start.players[0].castle;
  const placed = JSON.parse(cli('submit', '--file', file, '--json', JSON.stringify({ placements: [{ territory: castle, armies: start.income }] })));
  assert.deepEqual([placed.ok, placed.resolved, placed.phase], [true, true, 'orders']);

  const seen = JSON.parse(cli('observe', '--file', file));
  assert.equal(seen.territories[castle].armies, start.territories[castle].armies + start.income);
  assert.equal(seen.placements.length, 3);
  assert.ok(seen.summary.some((line) => line.startsWith('me placed')));

  assert.throws(() => cli('submit', '--file', file, '--json', '{"orders":[{"from":99,"to":1,"armies":1}]}'), /unknown territory/);
  const held = JSON.parse(cli('submit', '--file', file, '--json', '{"orders":[]}'));
  assert.equal(held.resolved, true);
  assert.ok(held.round === 2 || held.result);
  assert.equal(JSON.parse(cli('record', '--file', file)).rounds.length, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).seats[0], 'outside');
  assert.ok(Math.abs(JSON.parse(cli('odds', '3', '2')).win - 0.6564) < 0.001);
});
