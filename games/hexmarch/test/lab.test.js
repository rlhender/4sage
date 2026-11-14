import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CRITERIA, evaluateMap, evaluateRules, health } from '../ai/lab.js';

const CLI = fileURLToPath(new URL('../cli/hexmarch.js', import.meta.url));

test('rule evaluation is repeatable and reports every health measure', () => {
  const run = () => evaluateRules({ games: 40, seed: 2 });
  const a = run();
  assert.deepEqual(a.metrics, run().metrics);
  for (const key of Object.keys(CRITERIA)) assert.equal(typeof a.metrics[key], 'number', key);
  const total = Object.values(a.metrics.winRates).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(total + a.metrics.drawRate - 1) < 0.01);
  assert.deepEqual(a.failed, a.checks.filter((c) => !c.ok).map((c) => c.check));
});

test('an obviously bad rule set is flagged', () => {
  const short = evaluateRules({ rules: { maxRounds: 2 }, games: 40, seed: 2 });
  assert.ok(short.failed.includes('stalemateRate') && short.failed.includes('averageRounds'), short.failed.join());
  assert.equal(health({ stalemateRate: 0.02, blowoutRate: 0.5 }).find((c) => c.check === 'blowoutRate').ok, false);
  assert.throws(() => evaluateRules({ rules: { nope: 1 }, games: 1 }), /Unknown rule/);
});

test('map evaluation accounts for every start and describes the map', () => {
  const result = evaluateMap({ mapSeed: 5, games: 60, players: 3, seed: 4 });
  assert.ok(['fair', 'uneven', 'skewed'].includes(result.verdict));
  assert.ok(result.islands.every((i) => i.winRate >= 0 && i.winRate <= 1 && i.starts >= 20));
  assert.ok(result.islands.reduce((sum, i) => sum + i.wins, 0) <= 60);
  assert.equal(result.structure.regions.length, 6);
  assert.ok(result.structure.seaLanes >= 5, 'the islands are connected');
  assert.equal(result.largestDeviation, Math.max(...result.islands.map((i) => Math.abs(i.z))));
});

test('the lab runs from the command line', () => {
  const out = execFileSync(process.execPath, [CLI, 'lab', 'sweep', '--name', 'castleGarrison', '--values', '5,9', '--games', '12'], { encoding: 'utf8' });
  assert.match(out, /castleGarrison=5 \(standard\)\s+castleGarrison=9/);
  assert.match(out, /average rounds/);
  assert.match(execFileSync(process.execPath, [CLI, 'rules'], { encoding: 'utf8' }), /castleDefence\s+0\s+0 to 3/);
});
