// The balance lab: plays many games between computer players and measures
// whether a map or a set of rules makes for a healthy game. Nothing here is
// an opinion about what is fun; it reports numbers and checks them against
// stated limits, so maps and rules can be compared and the limits argued over.

import { getMap } from '../engine/engine.js';
import { rng32 } from '../engine/map.js';
import { resolveRules } from '../engine/rules.js';
import { makeAgent } from './strategies.js';
import { playGame, tune } from './arena.js';

// What counts as healthy. Each limit is a judgement; change them here.
export const CRITERIA = {
  stalemateRate: { max: 0.10, doc: 'Games that run to the round limit without a winner by conquest.' },
  blowoutRate: { max: 0.10, doc: 'Games decided within three rounds, before anyone can respond.' },
  averageRounds: { min: 6, max: 25, doc: 'Typical game length in rounds.' },
  snowball: { max: 0.75, doc: 'How often whoever leads after round three goes on to win.' },
  dominance: { max: 0.55, doc: 'Win rate of the most successful strategy in a mixed field.' },
  turtleRate: { max: 0.30, doc: 'Win rate of the passive strategy; high means sitting still pays.' },
};

// A map is fair if no starting island wins more than this far from an even
// share, and skewed beyond the second figure.
export const FAIR_GAP = 0.08;
export const SKEWED_GAP = 0.15;

const leaderOf = (state) => {
  const counts = state.players.map((p, seat) => (p.alive ? state.owner.filter((o) => o === seat).length : -1));
  const top = Math.max(...counts);
  return counts.filter((c) => c === top).length === 1 ? counts.indexOf(top) : null;
};

// Plays one game and returns the facts the lab cares about.
function observeGame(agents, seed, options) {
  let leader = null;
  let leadChanges = 0;
  let earlyLeader = null;
  const state = playGame(agents, seed, {
    ...options,
    onRound(s, round) {
      const now = leaderOf(s);
      if (now !== null && leader !== null && now !== leader) leadChanges++;
      if (now !== null) leader = now;
      if (round === 3) earlyLeader = now;
    },
  });
  const events = state.history.flatMap((h) => (h.events ?? []).map((e) => ({ ...e, round: h.round })));
  const battles = events.filter((e) => e.type === 'battle');
  return {
    state,
    rounds: state.result.round,
    reason: state.result.reason,
    winner: state.result.winner,
    earlyLeader,
    leadChanges,
    clashes: events.filter((e) => e.type === 'clash').length,
    battles: battles.length,
    captures: battles.filter((e) => e.captured).length,
    firstElimination: events.find((e) => e.type === 'eliminated')?.round ?? null,
  };
}

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const round3 = (x) => Math.round(x * 1000) / 1000;

function summarise(games) {
  const long = games.filter((g) => g.rounds > 3 && g.earlyLeader !== null);
  return {
    games: games.length,
    averageRounds: round3(mean(games.map((g) => g.rounds))),
    stalemateRate: round3(mean(games.map((g) => (g.reason === 'roundLimit' ? 1 : 0)))),
    blowoutRate: round3(mean(games.map((g) => (g.rounds <= 3 ? 1 : 0)))),
    drawRate: round3(mean(games.map((g) => (g.winner === null ? 1 : 0)))),
    snowball: round3(mean(long.map((g) => (g.winner === g.earlyLeader ? 1 : 0)))),
    leadChanges: round3(mean(games.map((g) => g.leadChanges))),
    clashesPerGame: round3(mean(games.map((g) => g.clashes))),
    battlesPerGame: round3(mean(games.map((g) => g.battles))),
    attackerSuccess: round3(mean(games.map((g) => (g.battles ? g.captures / g.battles : 0)))),
    firstElimination: round3(mean(games.filter((g) => g.firstElimination !== null).map((g) => g.firstElimination))),
  };
}

// Each criterion checked against the metrics it applies to.
export function health(metrics) {
  return Object.entries(CRITERIA).flatMap(([key, limit]) => {
    const value = metrics[key];
    if (value === undefined) return [];
    const ok = (limit.min === undefined || value >= limit.min) && (limit.max === undefined || value <= limit.max);
    const range = [limit.min !== undefined ? `at least ${limit.min}` : null, limit.max !== undefined ? `at most ${limit.max}` : null].filter(Boolean).join(', ');
    return [{ check: key, value, ok, limit: range, doc: limit.doc }];
  });
}

// ---------- rules ----------

// Plays a mixed field of strategies on random maps under one rule set.
export function evaluateRules({ rules = {}, lineup = ['aggressive', 'balanced', 'fortress', 'passive'], games = 400, seed = 1, adapt = 0 }) {
  const full = resolveRules(rules);
  let adapted = null;
  const field = [...lineup];
  if (adapt > 0) {
    // Judge a rule set by players who have learned it, not by ones tuned for other rules.
    adapted = tune({ generations: adapt, games: 60, seed, rules: full }).weights;
    field[Math.max(0, field.indexOf('balanced'))] = 'adapted';
  }
  const agents = field.map((name) => makeAgent(name === 'adapted' ? adapted : name, name));
  const wins = Object.fromEntries(field.map((name) => [name, 0]));
  const played = [];
  for (let g = 0; g < games; g++) {
    const shift = g % agents.length;
    const seated = agents.map((_, i) => agents[(i + shift) % agents.length]);
    const game = observeGame(seated, seed * 100003 + g, { rules: full });
    played.push(game);
    if (game.winner !== null) wins[seated[game.winner].name]++;
  }
  const winRates = Object.fromEntries(Object.entries(wins).map(([name, n]) => [name, round3(n / games)]));
  const metrics = {
    ...summarise(played),
    dominance: Math.max(...Object.values(winRates)),
    ...(winRates.passive !== undefined ? { turtleRate: winRates.passive } : {}),
    winRates,
  };
  const checks = health(metrics);
  return { rules: Object.fromEntries(Object.entries(rules)), metrics, checks, failed: checks.filter((c) => !c.ok).map((c) => c.check), adapted };
}

// ---------- maps ----------

function structure(map) {
  const regions = map.regions.map((region) => {
    const lanes = region.territories.reduce((sum, t) => sum
      + map.territories[t].adj.filter((n) => map.territories[n].region !== region.id).length, 0);
    return { name: region.name, territories: region.territories.length, seaLanes: lanes };
  });
  const degree = map.territories.map((t) => t.adj.length);
  return { regions, seaLanes: map.lanes.length, fewestNeighbours: Math.min(...degree), mostNeighbours: Math.max(...degree) };
}

// Mirror matches on one map: every seat plays the same strategy, so any
// difference in results comes from where a player starts, not how they play.
export function evaluateMap({ mapSeed, games = 300, players = 3, strategy = 'balanced', rules = {}, seed = 1 }) {
  const full = resolveRules(rules);
  const map = getMap(mapSeed, full);
  const agents = Array.from({ length: players }, (_, i) => makeAgent(strategy, `${strategy}#${i + 1}`));
  const starts = map.regions.map((region) => ({ island: region.name, starts: 0, wins: 0 }));
  const played = [];
  for (let g = 0; g < games; g++) {
    const game = observeGame(agents, seed * 100003 + g, { mapSeed, rules: full });
    played.push(game);
    game.state.players.forEach((p, seat) => {
      const home = starts[map.territories[p.castle].region];
      home.starts++;
      if (game.winner === seat) home.wins++;
    });
  }
  // How far each starting island's win rate is from an even share, in
  // standard errors. Three or more is very unlikely to be luck.
  const fair = 1 - summarise(played).drawRate;
  const share = fair / players;
  const islands = starts.filter((s) => s.starts >= 20).map((s) => ({
    ...s,
    winRate: round3(s.wins / s.starts),
    z: round3((s.wins - s.starts * share) / Math.sqrt(s.starts * share * (1 - share))),
  }));
  const worst = Math.max(0, ...islands.map((s) => Math.abs(s.z)));
  // The verdict goes by size of effect: how many points the best or worst
  // start is from an even share.
  const gap = round3(Math.max(0, ...islands.map((s) => Math.abs(s.winRate - share))));
  const metrics = summarise(played);
  const checks = health(metrics);
  const verdict = gap >= SKEWED_GAP ? 'skewed' : gap > FAIR_GAP ? 'uneven' : 'fair';
  return {
    mapSeed, players, strategy, games,
    verdict,
    evenShare: round3(share),
    largestGap: gap,
    largestDeviation: worst,
    islands,
    metrics,
    failed: checks.filter((c) => !c.ok).map((c) => c.check),
    structure: structure(map),
  };
}

export function evaluateMaps({ seeds, onMap, ...options }) {
  return seeds.map((mapSeed) => {
    const result = evaluateMap({ mapSeed, ...options });
    onMap?.(result);
    return result;
  });
}

// A fresh batch of random map seeds, for looking beyond the first few.
export function randomSeeds(count, seed = 1) {
  const rand = rng32(seed);
  return Array.from({ length: count }, () => Math.floor(rand() * 2 ** 31));
}
