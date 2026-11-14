// Rules engine. Pure functions over a JSON-serialisable state; the server is
// the only place that mutates a real game, the client imports the helpers.

import { generateMap } from './map.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const CARD_NAMES = ['Crest', 'Sigil', 'Banner'];
export const HAND_LIMIT = 5; // holding this many forces a trade

const START_ARMIES = { 2: 36, 3: 31, 4: 26, 5: 22, 6: 18 };
const TRADE_VALUES = [4, 6, 8, 10, 12, 15];
const LOG_LIMIT = 80;

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

export function tradeValue(tradesSoFar) {
  return tradesSoFar < TRADE_VALUES.length
    ? TRADE_VALUES[tradesSoFar]
    : 15 + 5 * (tradesSoFar - TRADE_VALUES.length + 1);
}

export function isSet(cards) {
  if (cards.length !== 3) return false;
  const kinds = new Set(cards).size;
  return kinds === 1 || kinds === 3;
}

// Indices of a tradeable set in the hand, or null.
export function findSet(hand) {
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      for (let k = j + 1; k < hand.length; k++) {
        if (isSet([hand[i], hand[j], hand[k]])) return [i, j, k];
      }
    }
  }
  return null;
}

export function reinforcementsFor(state, p) {
  const map = getMap(state.mapSeed);
  const owned = state.owner.filter((o) => o === p).length;
  let n = Math.max(3, Math.floor(owned / 3));
  for (const region of map.regions) {
    if (region.territories.every((t) => state.owner[t] === p)) n += region.bonus;
  }
  return n;
}

// Territories reachable from `from` through an unbroken chain of p's own land.
export function reachable(state, from) {
  const map = getMap(state.mapSeed);
  const p = state.owner[from];
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const n of map.territories[queue.pop()].adj) {
      if (state.owner[n] === p && !seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  seen.delete(from);
  return seen;
}

function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function say(state, text) {
  state.log.push(text);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

export function createGame(playerInfo, mapSeed, rand = Math.random) {
  const count = playerInfo.length;
  if (count < MIN_PLAYERS || count > MAX_PLAYERS) throw new Error('Hexmarch needs 2 to 6 players.');
  const map = getMap(mapSeed);
  const total = map.territories.length;
  const first = Math.floor(rand() * count);

  // Deal territories round-robin starting after the first player, so any
  // leftover land goes to those who move later.
  const owner = new Array(total);
  shuffle([...Array(total).keys()], rand).forEach((t, i) => {
    owner[t] = (first + 1 + i) % count;
  });
  const armies = new Array(total).fill(1);
  for (let p = 0; p < count; p++) {
    const mine = owner.flatMap((o, t) => (o === p ? [t] : []));
    for (let spare = START_ARMIES[count] - mine.length; spare > 0; spare--) {
      armies[mine[Math.floor(rand() * mine.length)]]++;
    }
  }

  const state = {
    mapSeed,
    players: playerInfo.map((p) => ({ name: p.name, isBot: !!p.isBot, alive: true, cards: [] })),
    owner,
    armies,
    turn: first,
    round: 1,
    phase: 'reinforce',
    reinforcements: 0,
    conquered: false,
    pending: null,
    trades: 0,
    combat: null,
    combatId: 0,
    winner: null,
    log: [],
  };
  state.reinforcements = reinforcementsFor(state, first);
  say(state, `${state.players[first].name} moves first.`);
  return state;
}

function endTurn(state, rand) {
  const p = state.turn;
  if (state.conquered) {
    state.players[p].cards.push(Math.floor(rand() * CARD_NAMES.length));
    say(state, `${state.players[p].name} earns a card.`);
  }
  let next = p;
  do {
    next = (next + 1) % state.players.length;
  } while (!state.players[next].alive);
  if (next <= p) state.round++;
  state.turn = next;
  state.phase = 'reinforce';
  state.conquered = false;
  state.pending = null;
  state.reinforcements = reinforcementsFor(state, next);
}

const rollDice = (n, rand) =>
  Array.from({ length: n }, () => 1 + Math.floor(rand() * 6)).sort((a, b) => b - a);

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

export function applyAction(state, p, action, rand = Math.random) {
  if (state.phase === 'over') return fail('The game is over.');
  if (p !== state.turn) return fail('It is not your turn.');
  if (!action || typeof action !== 'object') return fail('Malformed action.');
  const map = getMap(state.mapSeed);
  const me = state.players[p];
  const isTerritory = (t) => Number.isInteger(t) && t >= 0 && t < map.territories.length;
  const nameOf = (t) => map.territories[t].name;

  switch (action.type) {
    case 'trade': {
      if (state.phase !== 'reinforce') return fail('Cards can only be traded while reinforcing.');
      const picks = action.cards;
      if (!Array.isArray(picks) || picks.length !== 3 || new Set(picks).size !== 3
        || !picks.every((i) => Number.isInteger(i) && i >= 0 && i < me.cards.length)) {
        return fail('Pick three of your cards.');
      }
      if (!isSet(picks.map((i) => me.cards[i]))) return fail('Those cards are not a set.');
      me.cards = me.cards.filter((_, i) => !picks.includes(i));
      const value = tradeValue(state.trades++);
      state.reinforcements += value;
      say(state, `${me.name} trades a set for ${value} armies.`);
      return OK;
    }

    case 'place': {
      if (state.phase !== 'reinforce') return fail('Armies can only be placed while reinforcing.');
      if (me.cards.length >= HAND_LIMIT) return fail('Trade a set of cards first.');
      const { territory, count } = action;
      if (!isTerritory(territory) || state.owner[territory] !== p) return fail('Pick one of your territories.');
      if (!Number.isInteger(count) || count < 1 || count > state.reinforcements) return fail('Invalid army count.');
      state.armies[territory] += count;
      state.reinforcements -= count;
      if (state.reinforcements === 0 && !findSet(me.cards)) state.phase = 'attack';
      return OK;
    }

    case 'attack': {
      if (state.phase !== 'attack') return fail('You can only attack during the attack phase.');
      const { from, to } = action;
      if (!isTerritory(from) || !isTerritory(to)) return fail('Unknown territory.');
      if (state.owner[from] !== p) return fail('Attack from one of your territories.');
      if (state.owner[to] === p) return fail('You already hold that territory.');
      if (!map.territories[from].adj.includes(to)) return fail('Those territories do not border each other.');
      if (state.armies[from] < 2) return fail('You need at least two armies to attack.');

      state.pending = null;
      const d = state.owner[to];
      const them = state.players[d];
      let attLoss = 0;
      let defLoss = 0;
      let att;
      let def;
      let conquered = false;
      do {
        att = rollDice(Math.min(3, state.armies[from] - 1), rand);
        def = rollDice(Math.min(2, state.armies[to]), rand);
        for (let i = 0; i < Math.min(att.length, def.length); i++) {
          if (att[i] > def[i]) { state.armies[to]--; defLoss++; } else { state.armies[from]--; attLoss++; }
        }
        conquered = state.armies[to] === 0;
      } while (action.blitz && !conquered && state.armies[from] >= 2);

      state.combat = { from, to, attacker: p, defender: d, att, def, attLoss, defLoss, conquered };
      state.combatId++;
      if (!conquered) {
        say(state, `${me.name} attacks ${nameOf(to)} from ${nameOf(from)}: loses ${attLoss}, destroys ${defLoss}.`);
        return OK;
      }

      // The dice that won the last roll march in; the rest may follow.
      state.owner[to] = p;
      state.armies[to] = att.length;
      state.armies[from] -= att.length;
      state.conquered = true;
      const extra = state.armies[from] - 1;
      if (extra > 0) state.pending = { from, to, max: extra };
      say(state, `${me.name} takes ${nameOf(to)} from ${them.name}.`);

      if (!state.owner.includes(d)) {
        them.alive = false;
        me.cards.push(...them.cards);
        them.cards = [];
        say(state, `${them.name} has been eliminated.`);
        if (state.players.filter((pl) => pl.alive).length === 1) {
          state.phase = 'over';
          state.winner = p;
          state.pending = null;
          say(state, `${me.name} rules the archipelago.`);
        }
      }
      return OK;
    }

    case 'advance': {
      const move = state.pending;
      if (state.phase !== 'attack' || !move) return fail('There is nothing to move.');
      const { count } = action;
      if (!Number.isInteger(count) || count < 0 || count > move.max) return fail('Invalid army count.');
      state.armies[move.from] -= count;
      state.armies[move.to] += count;
      state.pending = null;
      return OK;
    }

    case 'fortify': {
      if (state.phase !== 'fortify') return fail('You can only fortify during the fortify phase.');
      const { from, to, count } = action;
      if (!isTerritory(from) || !isTerritory(to) || from === to) return fail('Unknown territory.');
      if (state.owner[from] !== p || state.owner[to] !== p) return fail('Both territories must be yours.');
      if (!reachable(state, from).has(to)) return fail('Those territories are not connected through your land.');
      if (!Number.isInteger(count) || count < 1 || count > state.armies[from] - 1) return fail('Invalid army count.');
      state.armies[from] -= count;
      state.armies[to] += count;
      say(state, `${me.name} moves ${count} from ${nameOf(from)} to ${nameOf(to)}.`);
      endTurn(state, rand);
      return OK;
    }

    case 'endPhase': {
      if (state.phase === 'reinforce') {
        if (me.cards.length >= HAND_LIMIT) return fail('Trade a set of cards first.');
        if (state.reinforcements > 0) return fail('Place all of your armies first.');
        state.phase = 'attack';
      } else if (state.phase === 'attack') {
        state.pending = null;
        state.phase = 'fortify';
      } else {
        endTurn(state, rand);
      }
      return OK;
    }

    default:
      return fail('Unknown action.');
  }
}

// Used when a turn has to be closed out for someone (timeouts, failed bot moves).
export function forceEndTurn(state, rand = Math.random) {
  if (state.phase === 'over') return;
  if (state.phase === 'reinforce') {
    const mine = state.owner.flatMap((o, t) => (o === state.turn ? [t] : []));
    for (; state.reinforcements > 0; state.reinforcements--) {
      state.armies[mine[Math.floor(rand() * mine.length)]]++;
    }
  }
  endTurn(state, rand);
}

// Next move for whoever's turn it is. Simple and aggressive, not clever.
export function botAction(state) {
  const p = state.turn;
  const map = getMap(state.mapSeed);
  const { owner, armies } = state;
  const enemiesOf = (t) => map.territories[t].adj.filter((n) => owner[n] !== p);
  const mine = owner.flatMap((o, t) => (o === p ? [t] : []));

  if (state.phase === 'reinforce') {
    const set = findSet(state.players[p].cards);
    if (set) return { type: 'trade', cards: set };
    if (state.reinforcements === 0) return { type: 'endPhase' };
    let best = mine[0];
    let bestScore = -Infinity;
    for (const t of mine) {
      const foes = enemiesOf(t);
      if (!foes.length) continue;
      const score = armies[t] - Math.min(...foes.map((n) => armies[n]));
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return { type: 'place', territory: best, count: state.reinforcements };
  }

  if (state.phase === 'attack') {
    if (state.pending) {
      const { from, to, max } = state.pending;
      const push = enemiesOf(to).length > 0 || enemiesOf(from).length === 0;
      return { type: 'advance', count: push ? max : 0 };
    }
    // Go for the largest stack it can outnumber: leaving big stacks alone
    // while chasing weak land is how bot games stall.
    let pick = null;
    let bestSize = 0;
    for (const t of mine) {
      if (armies[t] < 3) continue;
      for (const n of enemiesOf(t)) {
        if (armies[t] - armies[n] < 2 || armies[n] <= bestSize) continue;
        bestSize = armies[n];
        pick = { type: 'attack', from: t, to: n, blitz: true };
      }
    }
    return pick || { type: 'endPhase' };
  }

  // Fortify: pull the biggest idle stack up to the most threatened border.
  const idle = mine
    .filter((t) => armies[t] > 1 && enemiesOf(t).length === 0)
    .sort((a, b) => armies[b] - armies[a])[0];
  if (idle !== undefined) {
    let target = -1;
    let threat = 0;
    for (const t of reachable(state, idle)) {
      const pressure = enemiesOf(t).reduce((sum, n) => sum + armies[n], 0);
      if (pressure > threat) { threat = pressure; target = t; }
    }
    if (target >= 0) return { type: 'fortify', from: idle, to: target, count: armies[idle] - 1 };
  }
  return { type: 'endPhase' };
}

// What one seat is allowed to see: everyone's card counts, only their own hand.
export function viewFor(state, seat) {
  return {
    ...state,
    players: state.players.map((pl, i) => ({
      name: pl.name,
      isBot: pl.isBot,
      alive: pl.alive,
      cardCount: pl.cards.length,
      cards: i === seat ? pl.cards : undefined,
    })),
  };
}
