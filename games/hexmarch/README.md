# Hexmarch

A territory-conquest game for two to six players in which **everyone moves at
once**. Each round all players place their new armies, then seal secret
attack orders that are revealed and resolved together. Each player has a
castle; lose it and you are out. Win by taking the last castle or by
holding most of the map.

It is built so that an AI can play as readily as a person, and so that AIs
can be used to find out which maps and rules make a good game:

- the **engine** runs headless and deterministically, and a whole game is
  plain JSON;
- people play in the browser; **any AI** takes a seat over plain HTTP or
  MCP, with no dependence on a model, vendor or agent framework;
- built-in strategies play complete games by the thousand, improve by
  self-play, and feed a **balance lab** that judges maps and rule sets.

| Read this | For |
|-----------|-----|
| [PLAYING.md](PLAYING.md) | the rules and the JSON formats |
| [AGENTS.md](AGENTS.md) | connecting an AI player (HTTP or MCP) |
| [BALANCE.md](BALANCE.md) | how maps and rules are judged, and findings so far |
| [deploy/README.md](deploy/README.md) | putting it on a server |
| [PLAN.md](PLAN.md) | what is built, what is next, and why it is built this way |

It lives in this repository as a self-contained project: nothing outside
`games/hexmarch/` depends on it.

## Run it

Requires Node.js 20 or newer.

```
cd games/hexmarch
npm install
npm start          # http://localhost:3000
npm test
```

In the browser, create a room, share the four-letter code or invite link,
and add bots from the lobby. An AI joins the same room with the code:

```
node examples/http-agent.js --server http://localhost:3000 --room CODE
```

Set `DATA_DIR=./data` to keep games across restarts.

## Headless

```
node cli/hexmarch.js help

# 500 complete games between strategies, with win rates
node cli/hexmarch.js simulate --players aggressive,fortress,balanced,tuned --games 500

# improve a strategy by self-play; saved as the "tuned" strategy
node cli/hexmarch.js tune --generations 12 --games 90

# judge rules and maps
node cli/hexmarch.js lab rules --rule castleGarrison=8
node cli/hexmarch.js lab maps --seeds 1-30 --save

# play one game a JSON move at a time, with no server
node cli/hexmarch.js new --file game.json --players you,aggressive,fortress
node cli/hexmarch.js observe --file game.json --brief
node cli/hexmarch.js submit --file game.json --json '{"placements":[...]}'
```

## Layout

| Path | What's here |
|------|-------------|
| `engine/engine.js` | The rules. Pure functions over a JSON state: `createGame`, `submit`, `observe`, `exportRecord`, `replay`. No I/O. |
| `engine/rules.js` | Every tunable rule and its default. |
| `engine/map.js` | Deterministic map generator; a seed fully describes a map. |
| `engine/odds.js` | Exact win chances and expected survivors for any fight. |
| `engine/briefing.js` | A player's view as text arranged for deciding; what AI players read. |
| `engine/report.js` | Round events in plain English. |
| `ai/strategies.js` | Computer players: one decision procedure driven by eight weights, with a guess at the opponents' orders. |
| `ai/arena.js` | Whole games between agents, mass simulation, self-play tuning. |
| `ai/lab.js` | The balance lab: game-health measures for rules and maps. |
| `ai/tuned.json`, `balance/maps.json` | Results of the last tuning run and the maps judged fair. |
| `cli/hexmarch.js` | Command line for all of the above. |
| `server/rooms.js` | Rooms, seats and timers, independent of how players connect. |
| `server/server.js`, `api.js`, `mcp.js`, `store.js` | Web server and WebSocket, HTTP API, MCP endpoint, saving to disk. |
| `client/` | Browser GUI: plain ES modules and SVG, no build step. |
| `examples/`, `skill/` | A complete outside player in one file; a skill file for harnesses that load them. |
| `deploy/` | systemd unit, proxy examples and a hosting guide. |
| `test/` | `node:test` suites for the engine, AI, lab, CLI, server, API and MCP. |

## Computer players

A strategy is an object with `place(view)` and `order(view)`; it sees what
any player sees. The built-in ones share one procedure that values targets,
checks exact odds, and attacks when the chance of success clears a
threshold. Their personalities are only different weights:

| Weight | Meaning |
|--------|---------|
| `aggression` | how poor the odds can be before it will not attack |
| `castleGuard` | garrison kept at the castle, relative to nearby enemies |
| `reserve` | garrison kept on other borders |
| `commit` | share of its free armies sent on an attack |
| `castleHunt` | extra value placed on enemy castles |
| `islandFocus` | extra value placed on completing or breaking up islands |
| `foresight` | how far it trusts its guess at what the others will order |
| `counter` | how much it will risk to meet an expected attack in the field |

`aggressive`, `balanced`, `fortress` and `passive` are fixed presets.
`tuned` is found by self-play: each generation, mutated copies of the
champion play the same games against the presets and the best becomes the
next champion.

## Server behaviour

- When a round resolves, the browser plays it back: everyone's orders are
  revealed, then each clash, battle and move is shown in turn.
- Each phase has a time limit (three minutes by default; the host can
  change it per room). When it runs out the server seals a move for anyone
  who has not.
- A browser player who disconnects keeps their seat and can rejoin. If
  everyone still to move has disconnected, the wait is shortened.
- Leaving a game on purpose hands the seat to a bot.
- With `DATA_DIR` set, rooms are saved on every change and restored at
  start, and each finished game is filed as a replayable record.
- Rooms nobody has touched for a while are removed.

Settings are environment variables: `PORT` (3000), `HOST`, `DATA_DIR`,
`PHASE_MS` (180000), `GRACE_MS` (30000), `BOT_DELAY_MS` (1500),
`ROOM_TTL_MS` (1800000).
