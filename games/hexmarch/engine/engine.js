// Hexmarch rules engine. Headless and deterministic: a game is a plain JSON
// state, every change goes through submit(), and the dice come from a seed
// stored in the state, so a game can be saved, resumed and replayed exactly.
//
// Every round all players act at once:
//   place  — everyone seals where their new armies go; revealed together.
//   orders — everyone seals attack and move orders; resolved together.

import { generateMap } from './map.js';

export const VERSION = 1;
export const NEUTRAL = -1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const DEFAULT_MAX_ROUNDS = 40;

const START_ARMIES = { 2: 36, 3: 31, 4: 26, 5: 22, 6: 18 };
const CASTLE_GARRISON = 5;

const maps = new Map();
export function getMap(seed) {
  let map = maps.get(seed);
  if (!map) {
    if (maps.size > 200) maps.clear();
    map = generateMap(seed);
    maps.set(seed, map);
  }
  return map;
}

// ---------- randomness (kept in the state so games replay exactly) ----------

function random(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (state, n) => Math.floor(random(state) * n);

function shuffle(state, list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randInt(state, i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function rollDice(state, n) {
  const dice = [];
  for (let i = 0; i < n; i++) dice.push(1 + randInt(state, 6));
  return dice.sort((a, b) => b - a);
}

// ---------- setup ----------

function distancesFrom(map, start) {
  const dist = new Array(map.territories.length).fill(Infinity);
  dist[start] = 0;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const n of map.territories[queue[i]].adj) {
      if (dist[n] === Infinity) { dist[n] = dist[queue[i]] + 1; queue.push(n); }
    }
  }
  return dist;
}

export function incomeFor(state, seat) {
  const map = getMap(state.config.mapSeed);
  const owned = state.owner.filter((o) => o === seat).length;
  let n = Math.max(3, Math.floor(owned / 3));
  for (const region of map.regions) {
    if (region.territories.every((t) => state.owner[t] === seat)) n += region.bonus;
  }
  return n;
}

export function createGame({ players, seed = 1, mapSeed = seed, maxRounds = DEFAULT_MAX_ROUNDS }) {
  const names = players.map((p) => (typeof p === 'string' ? p : p.name));
  const count = names.length;
  if (count < MIN_PLAYERS || count > MAX_PLAYERS) throw new Error('Hexmarch needs 2 to 6 players.');
  if (!Number.isInteger(seed) || !Number.isInteger(mapSeed)) throw new Error('Seeds must be whole numbers.');
  const map = getMap(mapSeed);
  const total = map.territories.length;

  const state = {
    version: VERSION,
    config: { players: names, seed, mapSeed, maxRounds },
    rng: seed >>> 0,
    players: names.map((name) => ({ name, alive: true, castle: -1 })),
    owner: new Array(total).fill(NEUTRAL),
    armies: new Array(total).fill(1),
    round: 1,
    phase: 'place',
    income: [],
    submitted: new Array(count).fill(null),
    history: [{ round: 1 }],
    result: null,
  };

  // Castles go as far apart as the map allows.
  const castles = [randInt(state, total)];
  while (castles.length < count) {
    const dists = castles.map((c) => distancesFrom(map, c));
    let best = -1;
    let bestGap = -1;
    for (let t = 0; t < total; t++) {
      const gap = Math.min(...dists.map((d) => d[t]));
      if (gap > bestGap) { bestGap = gap; best = t; }
    }
    castles.push(best);
  }
  shuffle(state, [...Array(count).keys()]).forEach((seat, i) => {
    state.players[seat].castle = castles[i];
    state.owner[castles[i]] = seat;
    state.armies[castles[i]] = CASTLE_GARRISON;
  });

  // Everything else is dealt out, then spare armies land at random.
  const offset = randInt(state, count);
  shuffle(state, [...Array(total).keys()].filter((t) => !castles.includes(t)))
    .forEach((t, i) => { state.owner[t] = (i + offset) % count; });
  for (let seat = 0; seat < count; seat++) {
    const mine = state.owner.flatMap((o, t) => (o === seat ? [t] : []));
    for (let spare = START_ARMIES[count] - CASTLE_GARRISON - (mine.length - 1); spare > 0; spare--) {
      state.armies[mine[randInt(state, mine.length)]]++;
    }
  }
  state.income = state.players.map((_, seat) => incomeFor(state, seat));
  return state;
}

// ---------- submissions ----------

const fail = (error) => ({ ok: false, error });
const isTerritory = (map, t) => Number.isInteger(t) && t >= 0 && t < map.territories.length;
const label = (map, t) => `${map.territories[t].name} (id ${t})`;

function parsePlacements(state, seat, list) {
  const map = getMap(state.config.mapSeed);
  const income = state.income[seat];
  if (!Array.isArray(list)) {
    return { error: `This is the place phase. Send {"placements":[{"territory":id,"armies":n}]} adding up to ${income}.` };
  }
  const totals = new Map();
  for (const [i, item] of list.entries()) {
    const { territory, armies } = item ?? {};
    if (!isTerritory(map, territory)) return { error: `Placement ${i + 1}: unknown territory.` };
    if (state.owner[territory] !== seat) return { error: `Placement ${i + 1}: ${label(map, territory)} is not yours.` };
    if (!Number.isInteger(armies) || armies < 1) return { error: `Placement ${i + 1}: armies must be a whole number, 1 or more.` };
    totals.set(territory, (totals.get(territory) ?? 0) + armies);
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  if (sum !== income) return { error: `You must place exactly ${income} armies; this places ${sum}.` };
  return { value: [...totals].sort((a, b) => a[0] - b[0]).map(([territory, armies]) => ({ territory, armies })) };
}

function parseOrders(state, seat, list) {
  const map = getMap(state.config.mapSeed);
  if (!Array.isArray(list)) {
    return { error: 'This is the orders phase. Send {"orders":[{"from":id,"to":id,"armies":n}]}; an empty list holds position.' };
  }
  const merged = new Map();
  const leaving = new Map();
  for (const [i, item] of list.entries()) {
    const { from, to, armies } = item ?? {};
    if (!isTerritory(map, from) || !isTerritory(map, to)) return { error: `Order ${i + 1}: unknown territory.` };
    if (state.owner[from] !== seat) return { error: `Order ${i + 1}: ${label(map, from)} is not yours.` };
    if (!map.territories[from].adj.includes(to)) {
      return { error: `Order ${i + 1}: ${label(map, from)} does not border ${label(map, to)}.` };
    }
    if (!Number.isInteger(armies) || armies < 1) return { error: `Order ${i + 1}: armies must be a whole number, 1 or more.` };
    const key = from * 1000 + to;
    merged.set(key, (merged.get(key) ?? 0) + armies);
    leaving.set(from, (leaving.get(from) ?? 0) + armies);
  }
  for (const [from, n] of leaving) {
    if (n > state.armies[from] - 1) {
      return { error: `${label(map, from)} has ${state.armies[from]} armies, so at most ${state.armies[from] - 1} can leave; your orders send ${n}.` };
    }
  }
  return {
    value: [...merged].sort((a, b) => a[0] - b[0])
      .map(([key, armies]) => ({ from: Math.floor(key / 1000), to: key % 1000, armies })),
  };
}

const everyoneReady = (state) => state.players.every((p, i) => !p.alive || state.submitted[i] !== null);

// Seal a player's placements or orders for the current phase. It can be
// replaced until the last player submits, at which point the phase resolves.
export function submit(state, seat, submission) {
  if (state.phase === 'over') return fail('The game is over.');
  const player = Number.isInteger(seat) ? state.players[seat] : undefined;
  if (!player) return fail('Unknown seat.');
  if (!player.alive) return fail('You have been eliminated.');
  const parsed = state.phase === 'place'
    ? parsePlacements(state, seat, submission?.placements)
    : parseOrders(state, seat, submission?.orders);
  if (parsed.error) return fail(parsed.error);
  state.submitted[seat] = parsed.value;
  const resolved = everyoneReady(state);
  if (resolved) advance(state);
  return { ok: true, resolved };
}

export function retract(state, seat) {
  if (state.phase !== 'over' && state.submitted[seat]) state.submitted[seat] = null;
}

// ---------- resolution ----------

function advance(state) {
  const entry = state.history.at(-1);
  const sealed = state.submitted;
  state.submitted = new Array(state.players.length).fill(null);
  if (state.phase === 'place') {
    entry.placements = sealed;
    for (const list of sealed) for (const p of list ?? []) state.armies[p.territory] += p.armies;
    state.phase = 'orders';
    return;
  }
  entry.orders = sealed;
  entry.events = resolveOrders(state, sealed);
  finishRound(state, entry.events);
}

function resolveOrders(state, sealed) {
  const events = [];

  // 1. Every ordered force leaves home at the same moment.
  const attacks = [];
  const moves = [];
  sealed.forEach((list, seat) => {
    for (const o of list ?? []) {
      state.armies[o.from] -= o.armies;
      (state.owner[o.to] === seat ? moves : attacks).push({ seat, from: o.from, to: o.to, armies: o.armies });
    }
  });
  attacks.sort((a, b) => a.from - b.from || a.to - b.to);
  moves.sort((a, b) => a.to - b.to || a.from - b.from);

  // 2. Border clashes: two forces attacking each other across one border
  //    meet in the field first. Ties cost both sides.
  for (const a of attacks) {
    if (a.from > a.to) continue;
    const b = attacks.find((x) => x.from === a.to && x.to === a.from);
    if (!b) continue;
    const before = [a.armies, b.armies];
    while (a.armies > 0 && b.armies > 0) {
      const da = rollDice(state, Math.min(3, a.armies));
      const db = rollDice(state, Math.min(3, b.armies));
      for (let i = 0; i < Math.min(da.length, db.length); i++) {
        if (da[i] >= db[i]) b.armies--;
        if (db[i] >= da[i]) a.armies--;
      }
    }
    events.push({
      type: 'clash',
      a: { seat: a.seat, from: a.from, armies: before[0], left: a.armies },
      b: { seat: b.seat, from: b.from, armies: before[1], left: b.armies },
      winner: a.armies > 0 ? a.seat : b.armies > 0 ? b.seat : null,
    });
  }

  // 3. Territory battles. Forces of one player bound for the same place merge.
  //    When several players attack one territory the largest force goes first,
  //    and each later force fights whoever holds it by then.
  const battle = (force, t, late) => {
    const defender = state.owner[t];
    let att = force.armies;
    let def = state.armies[t];
    const before = [att, def];
    while (att > 0 && def > 0) {
      const da = rollDice(state, Math.min(3, att));
      const dd = rollDice(state, Math.min(2, def));
      for (let i = 0; i < Math.min(da.length, dd.length); i++) {
        if (da[i] > dd[i]) def--; else att--;
      }
    }
    const captured = def === 0;
    if (captured) state.owner[t] = force.seat;
    state.armies[t] = captured ? att : def;
    events.push({
      type: 'battle', territory: t, attacker: force.seat, defender, from: force.from,
      attackers: before[0], defenders: before[1], attackersLeft: att, defendersLeft: def, captured,
      ...(late ? { late: true } : {}),
    });
  };

  const inbound = new Map();
  for (const a of attacks) {
    if (a.armies === 0) continue;
    if (!inbound.has(a.to)) inbound.set(a.to, new Map());
    const forces = inbound.get(a.to);
    const force = forces.get(a.seat) ?? { seat: a.seat, armies: 0, from: [] };
    force.armies += a.armies;
    force.from.push(a.from);
    forces.set(a.seat, force);
  }
  for (const t of [...inbound.keys()].sort((x, y) => x - y)) {
    const forces = [...inbound.get(t).values()].map((f) => ({ ...f, tiebreak: random(state) }));
    forces.sort((x, y) => y.armies - x.armies || x.tiebreak - y.tiebreak);
    for (const force of forces) {
      if (state.owner[t] === force.seat) state.armies[t] += force.armies; else battle(force, t, false);
    }
  }

  // 4. Moves arrive after the fighting. If the destination fell meanwhile,
  //    the arriving armies attack whoever took it.
  for (const m of moves) {
    if (state.owner[m.to] === m.seat) {
      state.armies[m.to] += m.armies;
      events.push({ type: 'move', seat: m.seat, from: m.from, to: m.to, armies: m.armies });
    } else {
      battle({ seat: m.seat, armies: m.armies, from: [m.from] }, m.to, true);
    }
  }
  return events;
}

function standing(state, seat) {
  let territories = 0;
  let armies = 0;
  state.owner.forEach((o, t) => { if (o === seat) { territories++; armies += state.armies[t]; } });
  return { seat, territories, armies };
}

// Best standing wins; an exact tie on territories and armies is a draw.
function leader(standings) {
  const ranked = [...standings].sort((a, b) => b.territories - a.territories || b.armies - a.armies);
  const [first, second] = ranked;
  const tied = second && first.territories === second.territories && first.armies === second.armies;
  return tied ? null : first.seat;
}

function finishRound(state, events) {
  // A player whose castle is in someone else's hands is out; the rest of
  // their land turns neutral and keeps its garrisons.
  const fallen = state.players.flatMap((p, seat) => (p.alive && state.owner[p.castle] !== seat ? [seat] : []));
  const fallenStandings = fallen.map((seat) => standing(state, seat));
  for (const seat of fallen) {
    events.push({ type: 'eliminated', seat, by: state.owner[state.players[seat].castle] });
    state.players[seat].alive = false;
  }
  state.owner.forEach((o, t) => { if (fallen.includes(o)) state.owner[t] = NEUTRAL; });

  const alive = state.players.flatMap((p, seat) => (p.alive ? [seat] : []));
  let result = null;
  if (alive.length === 1) result = { winner: alive[0], reason: 'lastCastle' };
  else if (alive.length === 0) result = { winner: leader(fallenStandings), reason: 'mutualElimination' };
  else if (state.round >= state.config.maxRounds) {
    result = { winner: leader(alive.map((seat) => standing(state, seat))), reason: 'roundLimit' };
  }
  if (result) {
    state.phase = 'over';
    state.result = { ...result, round: state.round };
    events.push({ type: 'gameOver', ...result });
    return;
  }
  state.round++;
  state.phase = 'place';
  state.income = state.players.map((p, seat) => (p.alive ? incomeFor(state, seat) : 0));
  state.history.push({ round: state.round });
}

// ---------- views and records ----------

// Everything one seat may know: the public board, their own sealed
// submission, and only whether the others have sealed theirs.
export function observe(state, seat) {
  const map = getMap(state.config.mapSeed);
  const castleOf = new Map(state.players.flatMap((p, i) => (p.alive ? [[p.castle, i]] : [])));
  const owner = (t) => (state.owner[t] === NEUTRAL ? null : state.owner[t]);
  const current = state.history.at(-1);
  const last = state.history.findLast((h) => h.events);
  return {
    game: 'hexmarch',
    version: VERSION,
    mapSeed: state.config.mapSeed,
    you: seat,
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    income: state.phase === 'place' && state.players[seat]?.alive ? state.income[seat] : 0,
    submitted: state.submitted[seat] ?? null,
    players: state.players.map((p, i) => ({
      seat: i,
      name: p.name,
      alive: p.alive,
      castle: p.castle,
      ...standing(state, i),
      income: p.alive && state.phase !== 'over' ? incomeFor(state, i) : 0,
      ready: state.submitted[i] !== null,
    })),
    territories: map.territories.map((t) => ({
      id: t.id,
      name: t.name,
      region: map.regions[t.region].name,
      owner: owner(t.id),
      armies: state.armies[t.id],
      ...(castleOf.has(t.id) ? { castleOf: castleOf.get(t.id) } : {}),
      adjacent: t.adj,
    })),
    regions: map.regions.map((r) => {
      const first = state.owner[r.territories[0]];
      const held = first !== NEUTRAL && r.territories.every((t) => state.owner[t] === first);
      return { name: r.name, bonus: r.bonus, territories: r.territories, heldBy: held ? first : null };
    }),
    placements: state.phase === 'orders' ? current.placements : null,
    lastRound: last ? { round: last.round, placements: last.placements, orders: last.orders, events: last.events } : null,
    result: state.result,
  };
}

// The smallest complete description of a game: its settings plus what every
// player sealed each round. replay() rebuilds the identical game from it.
export function exportRecord(state) {
  return {
    game: 'hexmarch',
    version: VERSION,
    config: state.config,
    rounds: state.history.filter((h) => h.orders).map((h) => ({ placements: h.placements, orders: h.orders })),
    result: state.result,
  };
}

export function replay(record) {
  const state = createGame(record.config);
  for (const round of record.rounds) {
    for (const step of ['placements', 'orders']) {
      round[step].forEach((list, seat) => {
        if (list === null) return;
        const outcome = submit(state, seat, { [step]: list });
        if (!outcome.ok) throw new Error(`Replay failed in round ${state.round}: ${outcome.error}`);
      });
    }
  }
  return state;
}
