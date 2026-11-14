#!/usr/bin/env node
// Command-line front end to the engine: mass simulation, strategy tuning, and
// a file-based way to play a game one JSON submission at a time, which is how
// an LLM (or a script, or a person) plays headless.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGame, exportRecord, observe, submit } from '../engine/engine.js';
import { captureOdds, clashOdds } from '../engine/odds.js';
import { RULES, parseRule } from '../engine/rules.js';
import { briefing } from '../engine/briefing.js';
import { describeEvent, describePlacements } from '../engine/report.js';
import { PRESETS, act, makeAgent } from '../ai/strategies.js';
import { simulate, tune } from '../ai/arena.js';
import { CRITERIA, evaluateMaps, evaluateRules, randomSeeds } from '../ai/lab.js';
import { TUNED_FILE, loadTuned } from '../ai/tuned.js';

const MAPS_FILE = fileURLToPath(new URL('../balance/maps.json', import.meta.url));

const HELP = `Hexmarch command line

  simulate --players aggressive,fortress,balanced [--games 200] [--seed 1] [--rule key=value ...]
      Play many complete games between strategies and report win rates as JSON.

  tune [--generations 10] [--games 60] [--seed 1]
      Improve a strategy by self-play and save it as the "tuned" strategy.

  new --file game.json --players you,aggressive,fortress [--seed 1] [--rule key=value ...]
      Start a game saved in a file. Seats named after a strategy are bots;
      any other name is an outside player who moves with "submit".

  observe --file game.json [--seat 0] [--brief]
      Print what that seat can see, as JSON, or with --brief as a text
      briefing written for a language model to decide from.

  submit --file game.json [--seat 0] --json '{"placements":[...]}' | '{"orders":[...]}'
      Seal that seat's move for the current phase. Bots answer at once.

  record --file game.json
      Print the compact, replayable record of the game so far.

  odds <attackers> <defenders> [--clash]
      Exact odds of a fight to the death.

  lab maps --seeds 1-30 | --random 30 [--games 300] [--players 3,4] [--strategy balanced] [--save]
      Judge maps: identical players on each map, win rate by starting island.
      --save writes the fair ones to balance/maps.json, which the server uses.

  lab rules --rule key=value [--rule ...] [--games 400] [--adapt 8]
      Compare a rule set with the standard rules on game-health measures.
      --adapt re-tunes a strategy for the new rules first (generations).

  lab sweep --name castleGarrison --values 3,5,8,12 [--games 300]
      Try several values of one rule.

  rules
      List every rule that can be changed, with its default.

Strategies: ${Object.keys(PRESETS).join(', ')}, random (plus "tuned" after running tune).
Rules and JSON formats: see PLAYING.md.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { args._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    const value = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (key === 'rule') (args.rule ??= []).push(value); else args[key] = value;
  }
  return args;
}

// JSON that stays readable: one territory, player or event per line.
function pretty(value, depth = 0) {
  const pad = '  '.repeat(depth);
  if (Array.isArray(value) && value.length && typeof value[0] === 'object' && value[0] !== null && depth <= 2) {
    return `[\n${value.map((v) => `${pad}  ${JSON.stringify(v)}`).join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && depth <= 1) {
    const rows = Object.entries(value).filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${pretty(v, depth + 1)}`);
    return `{\n${rows.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

const number = (value, fallback) => (value === undefined ? fallback : Number(value));

// Rule overrides from repeated "--rule key=value" flags (and --max-rounds).
function rulesFrom(args) {
  const rules = Object.fromEntries((args.rule ?? []).map(parseRule));
  if (args['max-rounds']) rules.maxRounds = Number(args['max-rounds']);
  return rules;
}
const die = (message) => { console.error(message); process.exit(1); };

function loadGame(args) {
  if (typeof args.file !== 'string') die('Give the game file with --file.');
  if (!existsSync(args.file)) die(`No game file at ${args.file}. Start one with "new".`);
  return JSON.parse(readFileSync(args.file, 'utf8'));
}

const saveGame = (file, game) => writeFileSync(file, JSON.stringify(game));

// Let every bot seat that has not moved this phase seal its move.
function runBots(game) {
  const { state, seats } = game;
  for (let progressed = true; progressed && state.phase !== 'over';) {
    progressed = false;
    for (const [seat, kind] of seats.entries()) {
      if (kind === 'outside' || !state.players[seat].alive || state.submitted[seat] !== null) continue;
      if (state.phase === 'over') break;
      const outcome = submit(state, seat, act(makeAgent(kind), observe(state, seat)));
      if (!outcome.ok) throw new Error(`Bot ${kind} failed: ${outcome.error}`);
      progressed = true;
    }
    // If only bots are left alive they keep playing until the game ends.
    if (seats.some((kind, seat) => kind === 'outside' && state.players[seat].alive)) break;
  }
}

function outsideSeat(game, args) {
  if (args.seat !== undefined) return Number(args.seat);
  const seat = game.seats.indexOf('outside');
  if (seat < 0) die('This game has no outside players.');
  return seat;
}

function view(game, seat) {
  const obs = observe(game.state, seat);
  const summary = [];
  if (obs.lastRound) summary.push(...obs.lastRound.events.map((e) => describeEvent(e, obs)));
  if (obs.placements) summary.push(...describePlacements(obs.placements, obs));
  return { ...obs, summary };
}

// Fixed-width text table from rows of cells.
function table(rows) {
  const width = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((cell, i) => String(cell).padEnd(width[i])).join('  ').trimEnd()).join('\n');
}

const pct = (x) => `${Math.round(x * 100)}%`;
const METRIC_ROWS = [
  ['averageRounds', 'average rounds', (x) => x.toFixed(1)],
  ['stalemateRate', 'reach the round limit', pct],
  ['blowoutRate', 'over within 3 rounds', pct],
  ['snowball', 'round-3 leader wins', pct],
  ['leadChanges', 'lead changes a game', (x) => x.toFixed(1)],
  ['clashesPerGame', 'border clashes a game', (x) => x.toFixed(1)],
  ['attackerSuccess', 'attacks that capture', pct],
  ['firstElimination', 'first castle falls (round)', (x) => x.toFixed(1)],
  ['dominance', 'best strategy win rate', pct],
  ['turtleRate', 'passive win rate', pct],
];

// Metrics for several rule sets side by side, with failed checks marked.
function compare(columns) {
  const rows = [['', ...columns.map((c) => c.label)]];
  for (const [key, label, format] of METRIC_ROWS) {
    if (columns.every((c) => c.result.metrics[key] === undefined)) continue;
    rows.push([label, ...columns.map((c) => `${format(c.result.metrics[key])}${c.result.failed.includes(key) ? ' !' : ''}`)]);
  }
  const names = Object.keys(columns[0].result.metrics.winRates);
  for (const name of names) rows.push([`  ${name} wins`, ...columns.map((c) => pct(c.result.metrics.winRates[name] ?? 0))]);
  rows.push(['checks failed', ...columns.map((c) => c.result.failed.length || 'none')]);
  return `${table(rows)}\n\n! marks a value outside the limits in ai/lab.js (CRITERIA).`;
}

function seedList(args) {
  if (args.random) return randomSeeds(Number(args.random), number(args.seed, 1));
  const text = String(args.seeds ?? '1-20');
  if (text.includes('-')) {
    const [from, to] = text.split('-').map(Number);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  return text.split(',').map(Number);
}

const lab = {
  maps(args) {
    // Several table sizes can be judged at once (--players 3,4); a map then
    // gets its worst verdict and largest gap across them.
    const tables = String(args.players ?? 3).split(',').map(Number);
    const options = { games: number(args.games, 300), strategy: args.strategy ?? 'balanced', rules: rulesFrom(args), seed: number(args.seed, 1) };
    const rank = ['fair', 'uneven', 'skewed'];
    const runs = tables.map((players) => evaluateMaps({ seeds: seedList(args), ...options, players, onMap: (r) => process.stderr.write(`map ${r.mapSeed}, ${players} players: ${r.verdict}\n`) }));
    const results = runs[0].map((first, i) => {
      const all = runs.map((run) => run[i]);
      const worstRun = all.reduce((a, b) => (b.largestGap / b.evenShare > a.largestGap / a.evenShare ? b : a));
      return { ...worstRun, verdict: rank[Math.max(...all.map((r) => rank.indexOf(r.verdict)))] };
    });
    options.players = tables;
    if (args.save) {
      const fair = results.filter((r) => r.verdict === 'fair').map((r) => r.mapSeed);
      mkdirSync(path.dirname(MAPS_FILE), { recursive: true });
      writeFileSync(MAPS_FILE, `${JSON.stringify({ settings: options, fair, judged: results.map((r) => ({ mapSeed: r.mapSeed, verdict: r.verdict, largestGap: r.largestGap })) }, null, 2)}\n`);
    }
    if (args.json) { console.log(JSON.stringify(results)); return; }
    const best = (r) => r.islands.reduce((a, b) => (b.winRate > a.winRate ? b : a));
    const worst = (r) => r.islands.reduce((a, b) => (b.winRate < a.winRate ? b : a));
    console.log(table([
      ['map', 'verdict', 'gap', 'best start', 'worst start', 'rounds', 'blowouts', 'stalemates'],
      ...[...results].sort((a, b) => a.largestGap - b.largestGap).map((r) => [
        r.mapSeed, r.verdict, `${Math.round(r.largestGap * 100)} pts`,
        `${best(r).island} ${pct(best(r).winRate)}`, `${worst(r).island} ${pct(worst(r).winRate)}`,
        r.metrics.averageRounds.toFixed(1), pct(r.metrics.blowoutRate), pct(r.metrics.stalemateRate),
      ]),
    ]));
    const count = (v) => results.filter((r) => r.verdict === v).length;
    console.log(`\n${results.length} maps, identical ${options.strategy} players at tables of ${tables.join(' and ')}, ${options.games} games each. Each row shows the table size where the map did worst.`);
    console.log(`fair ${count('fair')}, uneven ${count('uneven')}, skewed ${count('skewed')}. Gap is how far the best or worst starting island's win rate is from an even share: up to 8 points is fair, 15 or more is skewed.`);
    if (args.save) console.log(`Saved the fair maps to ${path.relative(process.cwd(), MAPS_FILE)}.`);
  },

  rules(args) {
    const options = { games: number(args.games, 400), seed: number(args.seed, 1), adapt: number(args.adapt, 0) };
    const variant = rulesFrom(args);
    if (!Object.keys(variant).length) die('Give at least one --rule key=value to compare with the standard rules.');
    const columns = [
      { label: 'standard', result: evaluateRules({ ...options }) },
      { label: Object.entries(variant).map(([k, v]) => `${k}=${v}`).join(' '), result: evaluateRules({ ...options, rules: variant }) },
    ];
    if (args.json) { console.log(JSON.stringify(columns)); return; }
    console.log(compare(columns));
    for (const c of columns) if (c.result.adapted) console.log(`adapted strategy under ${c.label}: ${JSON.stringify(c.result.adapted)}`);
  },

  sweep(args) {
    const rule = RULES[args.name];
    if (!rule || typeof args.values !== 'string') die('Usage: lab sweep --name <rule> --values a,b,c');
    const options = { games: number(args.games, 300), seed: number(args.seed, 1), adapt: number(args.adapt, 0) };
    const columns = args.values.split(',').map((raw) => {
      const value = rule.options ? raw : Number(raw);
      return { label: `${args.name}=${value}${value === rule.default ? ' (standard)' : ''}`, result: evaluateRules({ ...options, rules: { ...rulesFrom(args), [args.name]: value } }) };
    });
    console.log(args.json ? JSON.stringify(columns) : compare(columns));
  },
};

const commands = {
  lab(args) {
    const run = lab[args._[1]];
    if (!run) die('Usage: lab maps | lab rules | lab sweep. See "help".');
    run(args);
  },

  rules() {
    console.log(table([['rule', 'default', 'allowed', 'meaning'], ...Object.entries(RULES).map(([key, r]) => [
      key, r.default, r.options ? r.options.join(' | ') : `${r.min} to ${r.max}`, r.doc,
    ])]));
    console.log(`\nHealth limits used by the lab: ${Object.entries(CRITERIA).map(([k, c]) => `${k} ${[c.min !== undefined ? `>= ${c.min}` : '', c.max !== undefined ? `<= ${c.max}` : ''].filter(Boolean).join(' and ')}`).join('; ')}.`);
  },

  simulate(args) {
    if (typeof args.players !== 'string') die('Give the strategies with --players, for example aggressive,fortress,balanced.');
    console.log(pretty(simulate({
      strategies: args.players.split(','),
      games: number(args.games, 200),
      seed: number(args.seed, 1),
      rules: rulesFrom(args),
    })));
  },

  tune(args) {
    const result = tune({
      start: PRESETS.tuned ?? PRESETS.balanced,
      generations: number(args.generations, 10),
      games: number(args.games, 60),
      seed: number(args.seed, 1),
      onGeneration: (g, weights) => console.error(`generation ${g.generation}: win rate ${(g.winRate * 100).toFixed(0)}%  ${JSON.stringify(weights)}`),
    });
    writeFileSync(TUNED_FILE, `${JSON.stringify(result, null, 2)}\n`);
    console.log(pretty({ saved: path.relative(process.cwd(), TUNED_FILE), weights: result.weights, winRate: result.history.at(-1).winRate }));
  },

  new(args) {
    if (typeof args.file !== 'string' || typeof args.players !== 'string') die('Usage: new --file game.json --players you,aggressive,fortress');
    const names = args.players.split(',');
    const seats = names.map((n) => (PRESETS[n] || n === 'random' ? n : 'outside'));
    const state = createGame({
      players: names.map((n, i) => (seats[i] === 'outside' ? n : `${n} (bot ${i})`)),
      seed: number(args.seed, 1),
      rules: rulesFrom(args),
    });
    const game = { state, seats };
    runBots(game);
    saveGame(args.file, game);
    console.log(pretty(view(game, Math.max(0, seats.indexOf('outside')))));
  },

  observe(args) {
    const game = loadGame(args);
    const seat = outsideSeat(game, args);
    console.log(args.brief ? briefing(observe(game.state, seat)) : pretty(view(game, seat)));
  },

  submit(args) {
    const game = loadGame(args);
    const seat = outsideSeat(game, args);
    let submission;
    try {
      submission = JSON.parse(typeof args.json === 'string' ? args.json : readFileSync(0, 'utf8'));
    } catch {
      die('The submission is not valid JSON. Pass it with --json or on standard input.');
    }
    const outcome = submit(game.state, seat, submission);
    if (!outcome.ok) die(pretty({ ok: false, error: outcome.error }));
    runBots(game);
    saveGame(args.file, game);
    const obs = view(game, seat);
    console.log(pretty({
      ok: true,
      resolved: outcome.resolved,
      round: obs.round,
      phase: obs.phase,
      waitingFor: obs.players.filter((p) => p.alive && !p.ready).map((p) => p.name),
      summary: outcome.resolved ? obs.summary : [],
      result: obs.result,
    }));
  },

  record(args) {
    console.log(JSON.stringify(exportRecord(loadGame(args).state)));
  },

  odds(args) {
    const [a, b] = args._.slice(1).map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) die('Usage: odds <attackers> <defenders> [--clash]');
    console.log(pretty(args.clash ? clashOdds(a, b) : captureOdds(a, b)));
  },
};

loadTuned();
const args = parseArgs(process.argv.slice(2));
const command = commands[args._[0]];
if (!command) {
  console.log(HELP);
  process.exit(args._[0] && args._[0] !== 'help' ? 1 : 0);
}
command(args);
