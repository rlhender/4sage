#!/usr/bin/env node
// A complete outside player in one file. It talks to a Hexmarch server over
// plain HTTP, exactly as any AI would, and is meant to be copied and changed.
//
//   node examples/http-agent.js --server http://localhost:3000 --room ABCD
//       join a room someone else created
//   node examples/http-agent.js --server http://localhost:3000 --bots aggressive,fortress
//       create a room, add bots, start, and play it out
//
// Options: --name Robo  --strategy balanced|aggressive|fortress|passive|tuned
//
// To put a language model in the seat, replace decide(): give the model
// state.briefing and return the JSON it answers with.

import { makeAgent, act } from '../ai/strategies.js';
import { loadTuned } from '../ai/tuned.js';

loadTuned();

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((part) => {
  const [key, ...rest] = part.trim().split(' ');
  return [key, rest.join(' ') || true];
}));
const server = String(args.server ?? 'http://localhost:3000').replace(/\/$/, '');
const name = args.name ?? 'Robo';
const brain = makeAgent(args.strategy ?? 'balanced');

// The only game-specific thinking in this file. `state.game` is the JSON view
// (asked for with view=full); `state.briefing` is the same thing as text.
function decide(state) {
  return act(brain, state.game);
}

let token = null;
async function call(method, path, body) {
  const response = await fetch(`${server}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`${method} ${path}: ${result.error}`);
  return result;
}

const seat = args.room
  ? await call('POST', `/rooms/${args.room}/join`, { name })
  : await call('POST', '/rooms', { name });
token = seat.token;
const room = `/rooms/${seat.code}`;
console.log(`${name} is seated in room ${seat.code}`);

if (!args.room) {
  for (const strategy of String(args.bots ?? 'aggressive,fortress').split(',')) await call('POST', `${room}/bots`, { strategy });
  await call('POST', `${room}/start`);
}

for (;;) {
  const state = await call('GET', `${room}?wait=50&view=full`);
  if (state.status === 'over') {
    const winner = state.result.winner === null ? 'nobody (a draw)' : state.players[state.result.winner].name;
    console.log(`Game over in round ${state.result.round}: ${winner} wins.`);
    break;
  }
  if (state.game && !state.game.players[state.seat].alive) {
    console.log('My castle fell. Leaving the table.');
    break;
  }
  if (!state.mustAct) continue; // in the lobby, or already sealed this phase
  const outcome = await call('POST', `${room}/move`, decide(state));
  console.log(`round ${state.round} ${state.phase}: sealed${outcome.resolved ? ', resolved' : ''}`);
}
