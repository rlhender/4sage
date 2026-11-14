# Hexmarch

A territory-conquest game for two to six players in which **everyone moves at
once**. Each round all players place their new armies, then seal secret
attack orders that are revealed and resolved together. Each player has a
castle; lose it and you are out.

The game is built so that an AI can play it as readily as a person:

- the **engine** runs headless and deterministically, and a whole game is
  plain JSON;
- every player (the browser GUI, a built-in strategy, a script, a large
  language model) sees the same JSON view and sends the same JSON moves;
- complete games between AI strategies run by the thousand from the command
  line, and strategies improve themselves by repeated play.

The rules and the JSON interface are in [PLAYING.md](PLAYING.md).

It lives in this repository as a self-contained project: nothing outside
`games/hexmarch/` depends on it.

## Run it

Requires Node.js 20 or newer.

```
cd games/hexmarch
npm install
npm start          # the browser game, on http://localhost:3000
npm test
```

In the browser, create a room, share the four-letter code or invite link,
and add bots of whichever strategy you like from the lobby.

## Headless play

```
# 500 complete games between three strategies, with win rates
node cli/hexmarch.js simulate --players aggressive,fortress,balanced --games 500

# improve a strategy by self-play and save it as the "tuned" strategy
node cli/hexmarch.js tune --generations 12 --games 90

# play one game a JSON move at a time (how an LLM plays)
node cli/hexmarch.js new --file game.json --players you,aggressive,fortress
node cli/hexmarch.js observe --file game.json
node cli/hexmarch.js submit --file game.json --json '{"placements":[...]}'
```

`node cli/hexmarch.js help` lists every command.

## Layout

| Path | What's here |
|------|-------------|
| `engine/engine.js` | The rules. Pure functions over a JSON state: `createGame`, `submit`, `observe`, `exportRecord`, `replay`. No I/O, no GUI. |
| `engine/map.js` | Deterministic map generator; a seed fully describes a map. |
| `engine/odds.js` | Exact win chances and expected survivors for any fight. |
| `engine/report.js` | Turns round events into plain English. |
| `ai/strategies.js` | Computer players: one decision procedure driven by six weights, with named personalities. |
| `ai/arena.js` | Plays whole games between agents, mass simulation, and self-play tuning. |
| `ai/tuned.json` | The weights found by the last `tune` run. |
| `cli/hexmarch.js` | Command line for all of the above. |
| `server/server.js` | Web server and WebSocket rooms. Holds no rules: it passes sealed moves to the engine. |
| `client/` | Browser GUI: plain ES modules and SVG, no build step. |
| `test/` | `node:test` suites for the engine, the AI, the CLI and the server. |

## AI players

A strategy is an object with `place(view)` and `order(view)`. The built-in
ones share one procedure that values targets, checks exact odds, and attacks
when the chance of success clears a threshold. Their personalities are only
different weights:

| Weight | Meaning |
|--------|---------|
| `aggression` | how poor the odds can be before it will not attack |
| `castleGuard` | garrison kept at the castle, relative to nearby enemies |
| `reserve` | garrison kept on other borders |
| `commit` | share of its free armies sent on an attack |
| `castleHunt` | extra value placed on enemy castles |
| `islandFocus` | extra value placed on completing or breaking up islands |

`aggressive`, `balanced`, `fortress` and `passive` are fixed presets.
`tuned` is found by `tune`: each generation, mutated copies of the current
champion play the same games against the presets, and the best performer
becomes the next champion.

`place` and `order` may be asynchronous, so an agent backed by an LLM API
has the same shape. None is included yet.

## Server behaviour

- Each phase has a time limit (three minutes by default). When it runs out,
  the server seals a move for anyone who has not, using the balanced strategy.
- A player who disconnects keeps their seat and can rejoin from the same
  browser. If everyone still to move has disconnected, the wait is shortened.
- Leaving a game on purpose hands the seat to a bot.
- Rooms with no connected players are removed after 30 minutes. Nothing is
  saved to disk, so restarting the server ends every game.

Settings are environment variables: `PORT` (3000), `PHASE_MS` (180000),
`GRACE_MS` (30000), `BOT_DELAY_MS` (1500), `ROOM_TTL_MS` (1800000).

## Deploying

Any host that runs a long-lived Node process and allows WebSocket connections
will do. Run `npm install --omit=dev` and `npm start`, and route HTTP and
WebSocket traffic to `PORT`. Run a single instance: rooms live in that
process's memory.
