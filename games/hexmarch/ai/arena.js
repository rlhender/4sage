// Headless play: run complete games between agents, tally many of them, and
// improve a strategy's weights by having it play over and over.

import { createGame, observe, submit } from '../engine/engine.js';
import { rng32 } from '../engine/map.js';
import { PRESETS, WEIGHTS, act, makeAgent } from './strategies.js';

// Plays one whole game between synchronous agents and returns the final state.
export function playGame(agents, seed, options = {}) {
  const state = createGame({ players: agents.map((a) => a.name), seed, ...options });
  while (state.phase !== 'over') {
    const seat = state.players.findIndex((p, i) => p.alive && state.submitted[i] === null);
    const outcome = submit(state, seat, act(agents[seat], observe(state, seat)));
    if (!outcome.ok) throw new Error(`${agents[seat].name} made an illegal submission: ${outcome.error}`);
  }
  return state;
}

// Plays `games` games between the given strategies, rotating seats so that no
// strategy benefits from where it sits.
export function simulate({ strategies, games = 100, seed = 1, maxRounds }) {
  const rand = rng32(seed);
  const agents = strategies.map((spec, i) => {
    const base = typeof spec === 'string' ? spec : spec.name ?? 'custom';
    const twin = strategies.slice(0, i).filter((s) => (typeof s === 'string' ? s : s.name ?? 'custom') === base).length;
    return makeAgent(typeof spec === 'string' ? spec : spec.weights ?? spec, twin ? `${base}#${twin + 1}` : base, rand);
  });
  const stats = agents.map((a) => ({ name: a.name, wins: 0 }));
  let draws = 0;
  let rounds = 0;
  const reasons = {};
  for (let g = 0; g < games; g++) {
    const shift = g % agents.length;
    const seated = agents.map((_, i) => agents[(i + shift) % agents.length]);
    const state = playGame(seated, seed * 100003 + g, maxRounds ? { maxRounds } : {});
    rounds += state.result.round;
    reasons[state.result.reason] = (reasons[state.result.reason] ?? 0) + 1;
    if (state.result.winner === null) draws++;
    else stats[(state.result.winner + shift) % agents.length].wins++;
  }
  return {
    games,
    seed,
    averageRounds: rounds / games,
    draws,
    endings: reasons,
    results: stats.map((s) => ({ ...s, winRate: s.wins / games })),
  };
}

// Self-improvement by repeated play: each generation, mutated copies of the
// champion play the same set of games against the standard personalities, and
// the best performer becomes the next champion.
export function tune({ start = PRESETS.balanced, generations = 10, games = 60, seed = 1, rivals = ['aggressive', 'fortress', 'balanced'], onGeneration }) {
  const rand = rng32(seed);
  const mutate = (weights) => Object.fromEntries(Object.entries(WEIGHTS).map(([key, [lo, hi]]) => {
    const nudge = (rand() + rand() + rand() - 1.5) * 0.35 * (hi - lo);
    return [key, Math.round(Math.min(hi, Math.max(lo, weights[key] + nudge)) * 100) / 100];
  }));
  const fitness = (weights, generation) => {
    let wins = 0;
    for (let g = 0; g < games; g++) {
      const lineup = [makeAgent(weights, 'candidate'), makeAgent(rivals[g % rivals.length]), makeAgent(rivals[(g + 1) % rivals.length])];
      const shift = g % lineup.length;
      const seated = lineup.map((_, i) => lineup[(i + shift) % lineup.length]);
      const state = playGame(seated, seed * 7919 + generation * 100003 + g);
      if (state.result.winner !== null && seated[state.result.winner].name === 'candidate') wins++;
    }
    return wins / games;
  };

  let champion = { ...start };
  const history = [];
  for (let generation = 1; generation <= generations; generation++) {
    const pool = [champion, ...Array.from({ length: 6 }, () => mutate(champion))];
    const scored = pool.map((weights) => ({ weights, winRate: fitness(weights, generation) }));
    const best = scored.reduce((a, b) => (b.winRate > a.winRate ? b : a));
    champion = best.weights;
    history.push({ generation, winRate: best.winRate, championBefore: scored[0].winRate });
    onGeneration?.(history.at(-1), champion);
  }
  return { weights: champion, history, generations, games, seed, rivals };
}
