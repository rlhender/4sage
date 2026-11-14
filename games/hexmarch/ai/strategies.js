// Computer players. A strategy sees exactly what a human or an LLM sees (the
// observation from engine.observe) and returns the same JSON submission, so
// every kind of player is interchangeable.
//
// One decision procedure, driven by a handful of weights and by exact battle
// odds; the named personalities are just different weights, and tuning a
// strategy means searching for better ones.
//
// Because everyone moves at once, a good move depends on what the others are
// about to do. A strategy with foresight guesses each opponent's orders (by
// asking what a plain player would do in their seat) and plans against that:
// it strikes territories it expects to be emptied, and it meets an expected
// attack on the border when that protects its land better than waiting.

import { captureOdds, clashOdds } from '../engine/odds.js';

export const WEIGHTS = {
  aggression: [0, 1], // how poor the odds can be before it will not attack
  castleGuard: [0, 2], // garrison kept at the castle, as a multiple of nearby enemy armies
  reserve: [0, 1], // garrison kept on other borders, as a share of the largest neighbour
  commit: [0.3, 1], // share of its free armies sent on an attack
  castleHunt: [0, 3], // extra value of capturing an enemy castle
  islandFocus: [0, 3], // extra value of completing, or breaking up, an island
  foresight: [0, 1], // how far it trusts its guess at the other players' orders
  counter: [0, 1], // how much it will risk to meet an expected attack in the field
};

export const PRESETS = {
  aggressive: { aggression: 0.9, castleGuard: 0.3, reserve: 0, commit: 1, castleHunt: 2, islandFocus: 0.5, foresight: 0.3, counter: 0.8 },
  balanced: { aggression: 0.6, castleGuard: 0.7, reserve: 0.2, commit: 0.9, castleHunt: 1, islandFocus: 1, foresight: 0.6, counter: 0.5 },
  fortress: { aggression: 0.3, castleGuard: 1.3, reserve: 0.5, commit: 0.7, castleHunt: 0.5, islandFocus: 1.5, foresight: 0.8, counter: 0.3 },
  passive: { aggression: 0, castleGuard: 1, reserve: 0.6, commit: 0.6, castleHunt: 0.3, islandFocus: 0.5, foresight: 0.5, counter: 0 },
};

// The plain player every strategy assumes its opponents to be.
const ASSUMED = { aggression: 0.6, castleGuard: 0.7, reserve: 0.2, commit: 0.9, castleHunt: 1, islandFocus: 1, foresight: 0, counter: 0 };

const OWN_CASTLE_VALUE = 8;
const GOOD_ENOUGH = 0.92; // stop pooling armies once a capture is this likely

function survey(obs, w) {
  const me = obs.you;
  const T = obs.territories;
  const mine = T.filter((t) => t.owner === me).map((t) => t.id);
  const castle = obs.players[me].castle;
  const others = (t) => T[t].adjacent.filter((n) => T[n].owner !== me);
  const hostile = (t) => others(t).filter((n) => T[n].owner !== null); // neutrals never attack
  const threat = (t) => hostile(t).reduce((sum, n) => sum + T[n].armies, 0);
  const regionOf = new Map();
  for (const region of obs.regions) for (const t of region.territories) regionOf.set(t, region);

  // What a territory is worth capturing.
  const value = (n) => {
    let v = 1;
    if (T[n].castleOf !== undefined) v += 3 * w.castleHunt;
    const region = regionOf.get(n);
    if (region.territories.every((t) => t === n || T[t].owner === me)) v += w.islandFocus * region.bonus;
    else if (region.heldBy !== null && region.heldBy !== me) v += 0.5 * w.islandFocus * region.bonus;
    return v;
  };

  // What one of its own territories is worth keeping.
  const worth = (t) => 1 + (t === castle ? OWN_CASTLE_VALUE : 0) + (regionOf.get(t).heldBy === me ? w.islandFocus * regionOf.get(t).bonus : 0);

  // Armies that must stay home.
  const keep = (t) => (t === castle
    ? Math.max(1, Math.ceil(w.castleGuard * threat(t)))
    : 1 + Math.floor(w.reserve * Math.max(0, ...hostile(t).map((n) => T[n].armies))));

  // Chance that a force captures territory n against a given garrison.
  const odds = (force, n, garrison = T[n].armies, momentum = false) =>
    captureOdds(force, garrison, obs.rules, T[n].castleOf === T[n].owner, momentum).win;

  return { me, T, mine, castle, others, hostile, threat, value, worth, keep, odds };
}

export function choosePlacements(obs, w) {
  const { T, mine, castle, others, threat, value, odds } = survey(obs, w);
  let left = obs.income;
  const placed = new Map();
  const add = (t, n) => { if (n > 0) { placed.set(t, (placed.get(t) ?? 0) + n); left -= n; } };

  // Guard the castle first, then stack where the best attack can be launched.
  add(castle, Math.min(left, Math.max(0, Math.ceil(w.castleGuard * threat(castle)) - T[castle].armies)));
  if (left > 0) {
    let best = castle;
    let bestScore = -1;
    for (const t of mine) {
      for (const n of others(t)) {
        const score = value(n) * odds(T[t].armies - 1 + left, n);
        if (score > bestScore) { bestScore = score; best = t; }
      }
    }
    add(best, left);
  }
  return [...placed].map(([territory, armies]) => ({ territory, armies }));
}

// A guess at what every opponent will order this round.
function predict(obs) {
  const leaving = new Map(); // territory → armies expected to march out of it
  const inbound = new Map(); // one of my territories → attacks expected on it
  for (const p of obs.players) {
    if (!p.alive || p.seat === obs.you) continue;
    for (const o of chooseOrders({ ...obs, you: p.seat }, ASSUMED)) {
      leaving.set(o.from, (leaving.get(o.from) ?? 0) + o.armies);
      if (obs.territories[o.to].owner !== obs.you) continue;
      if (!inbound.has(o.to)) inbound.set(o.to, []);
      inbound.get(o.to).push(o);
    }
  }
  return { leaving, inbound };
}

export function chooseOrders(obs, w) {
  const { me, T, mine, castle, others, value, worth, keep, odds } = survey(obs, w);
  const rules = obs.rules;
  const orders = [];
  const minWin = 0.95 - 0.55 * w.aggression;
  const free = new Map(mine.map((t) => {
    const spare = Math.max(0, Math.min(T[t].armies - 1, T[t].armies - keep(t)));
    return [t, Math.round(spare * w.commit)];
  }));

  // What it expects of the others. `trust` is the probability it gives to its
  // guess coming true; the rest of the time it assumes everyone holds.
  const trust = w.foresight ?? 0;
  const guess = trust > 0 ? predict(obs) : { leaving: new Map(), inbound: new Map() };
  const inbound = (t) => guess.inbound.get(t) ?? [];
  // Chance of losing territory t, left with `home` armies, to the given forces.
  const risk = (t, home, forces) => {
    const total = forces.reduce((a, b) => a + b, 0);
    return total >= 1 ? captureOdds(total, Math.max(1, home), rules, t === castle).win : 0;
  };

  // What sending everything free from `used` at territory n is expected to do:
  // the chance of taking n, the change in danger to the land left behind, and
  // how likely that land was to fall anyway. Marching out to meet an expected
  // attack turns it into a border clash, which can serve a threatened
  // territory better than waiting behind its walls.
  const assess = (n, used) => {
    let ifHeld = 0; // force arriving if the others hold
    let ifGuessed = 0; // force arriving if the guess comes true
    let clashWon = 1;
    let clashed = false;
    let danger = 0;
    let doomed = 0;
    for (const t of used) {
      const send = free.get(t);
      const coming = inbound(t);
      const facing = coming.find((o) => o.from === n);
      const rest = coming.filter((o) => o.from !== n).map((o) => o.armies);
      const before = trust * risk(t, T[t].armies, coming.map((o) => o.armies));
      let after;
      ifHeld += send;
      if (facing) {
        // The two forces meet on the border; only the winner goes on.
        const clash = clashOdds(send, facing.armies, rules);
        clashWon *= clash.aWins;
        ifGuessed += clash.aWins > 0 ? clash.aLeft / clash.aWins : 0;
        clashed = true;
        const theirs = clash.bWins > 0 ? Math.max(1, Math.round(clash.bLeft / clash.bWins)) : 0;
        after = trust * (clash.bWins * risk(t, T[t].armies - send, [...rest, theirs])
          + (1 - clash.bWins) * risk(t, T[t].armies - send, rest));
      } else {
        ifGuessed += send;
        after = trust * risk(t, T[t].armies - send, coming.map((o) => o.armies));
      }
      danger += (after - before) * worth(t);
      doomed = Math.max(doomed, before);
    }
    const emptied = Math.max(1, T[n].armies - (guess.leaving.get(n) ?? 0));
    const guessed = ifGuessed >= 1 ? clashWon * odds(Math.round(ifGuessed), n, emptied, clashed) : 0;
    return { win: trust * guessed + (1 - trust) * odds(ifHeld, n), danger, doomed };
  };

  // Attacks: repeatedly take the best-scoring target, pooling neighbouring
  // territories until the odds are good enough. A target scores by its value
  // times the chance of taking it, less any added danger at home; relief
  // from danger counts in its favour as far as the counter weight allows.
  const targets = [...new Set(mine.flatMap(others))];
  for (;;) {
    let best = null;
    for (const n of targets) {
      const sources = T[n].adjacent.filter((t) => (free.get(t) ?? 0) > 0).sort((a, b) => free.get(b) - free.get(a));
      const used = [];
      let found = null;
      for (const t of sources) {
        used.push(t);
        found = assess(n, used);
        if (found.win >= GOOD_ENOUGH) break;
      }
      if (!found) continue;
      // Armies in a territory that is likely to fall anyway are cheap to risk,
      // so the bar for attacking with them drops.
      const gain = found.win >= minWin * (1 - w.counter * found.doomed) ? value(n) * found.win : 0;
      const relief = found.danger < 0 ? -found.danger * w.counter : -found.danger;
      const score = gain + relief;
      if (score > 0.05 && (gain > 0 || relief > 0.25) && (!best || score > best.score)) best = { n, used: [...used], score };
    }
    if (!best) break;
    for (const t of best.used) {
      orders.push({ from: t, to: best.n, armies: free.get(t) });
      free.set(t, 0);
    }
    targets.splice(targets.indexOf(best.n), 1);
  }

  // Moves: armies sitting behind the lines walk towards the nearest border.
  const busy = new Set(orders.map((o) => o.from));
  const border = new Set(mine.filter((t) => others(t).length > 0));
  for (const t of mine) {
    if (border.has(t) || busy.has(t) || T[t].armies < 2) continue;
    const cameFrom = new Map([[t, null]]);
    const queue = [t];
    let goal = null;
    for (let i = 0; i < queue.length && goal === null; i++) {
      for (const n of T[queue[i]].adjacent) {
        if (T[n].owner !== me || cameFrom.has(n)) continue;
        cameFrom.set(n, queue[i]);
        if (border.has(n)) { goal = n; break; }
        queue.push(n);
      }
    }
    if (goal === null) continue;
    let step = goal;
    while (cameFrom.get(step) !== t) step = cameFrom.get(step);
    const spare = T[t].armies - keep(t);
    if (spare > 0) orders.push({ from: t, to: step, armies: Math.min(spare, T[t].armies - 1) });
  }
  return orders;
}

// A legal but aimless player, as a baseline and for testing.
function randomAgent(name, rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  return {
    name,
    place(obs) {
      const mine = obs.territories.filter((t) => t.owner === obs.you);
      return Array.from({ length: obs.income }, () => ({ territory: pick(mine).id, armies: 1 }));
    },
    order(obs) {
      return obs.territories
        .filter((t) => t.owner === obs.you && t.armies > 1 && rand() < 0.5)
        .map((t) => ({ from: t.id, to: pick(t.adjacent), armies: 1 + Math.floor(rand() * (t.armies - 1)) }));
    },
  };
}

// An agent is { name, place(obs), order(obs) }. Build one from a preset name,
// 'random', or a weights object.
export function makeAgent(spec, name, rand = Math.random) {
  if (spec === 'random') return randomAgent(name ?? 'random', rand);
  const weights = typeof spec === 'string' ? PRESETS[spec] : spec;
  if (!weights) throw new Error(`Unknown strategy "${spec}". Known: ${Object.keys(PRESETS).join(', ')}, random.`);
  return {
    name: name ?? (typeof spec === 'string' ? spec : 'custom'),
    weights,
    place: (obs) => choosePlacements(obs, weights),
    order: (obs) => chooseOrders(obs, weights),
  };
}

// The submission an agent makes for whatever phase the observation is in.
// place() and order() may be async, so an LLM-backed agent fits the same shape.
export function act(agent, obs) {
  return obs.phase === 'place' ? { placements: agent.place(obs) } : { orders: agent.order(obs) };
}
