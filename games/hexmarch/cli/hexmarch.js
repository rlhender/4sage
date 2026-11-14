#!/usr/bin/env node
// Command-line front end to the engine: mass simulation, strategy tuning, and
// a file-based way to play a game one JSON submission at a time, which is how
// an LLM (or a script, or a person) plays headless.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGame, exportRecord, observe, submit } from '../engine/engine.js';
import { captureOdds, clashOdds } from '../engine/odds.js';
import { RULES, parseRule } from '../engine/rules.js';
import { briefing } from '../engine/briefing.js';
import { describeEvent, describePlacements } from '../engine/report.js';
import { PRESETS, act, makeAgent } from '../ai/strategies.js';
import { simulate, tune } from '../ai/arena.js';
import { TUNED_FILE, loadTuned } from '../ai/tuned.js';

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

const commands = {
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
