# Hexmarch

An online multiplayer territory-conquest game for two to six players, played
in the browser. Every game takes place on a freshly generated archipelago of
six hex-tile islands joined by sea lanes.

It lives in this repository as a self-contained project: nothing outside
`games/hexmarch/` depends on it.

## Run it

Requires Node.js 20 or newer.

```
cd games/hexmarch
npm install
npm start
```

Open http://localhost:3000, create a room, and share the four-letter code or
the invite link. Add bots from the lobby to fill seats or to play alone.

`npm test` runs the rules and server tests.

## How to play

Each turn has three phases:

1. **Reinforce** — you receive one army per three territories (minimum three),
   plus a bonus for every island you hold completely. Tap your territories to
   place them. Sets of three cards (three alike, or one of each) can be traded
   for extra armies; each trade in the game is worth more than the last.
   Holding five cards forces a trade.
2. **Attack** — tap one of your territories, then a neighbouring enemy. The
   attacker rolls up to three dice and the defender up to two; the highest
   dice are compared in pairs and ties go to the defender. *Blitz* keeps
   rolling until one side breaks. Capturing at least one territory in a turn
   earns a card. Eliminating a player takes their cards.
3. **Fortify** — optionally move armies once between two territories connected
   through your own land, which ends the turn.

The last player standing wins.

## Layout

| Path | What's here |
|------|-------------|
| `shared/map.js` | Deterministic map generator. The server sends only a seed; server and client build the same map from it. |
| `shared/game.js` | Rules engine: pure functions over a JSON state, plus the bot. |
| `server/server.js` | HTTP static server and WebSocket game server. Rooms are held in memory. |
| `client/` | Browser client: plain ES modules and SVG, no build step. |
| `test/` | `node:test` suites for the rules and the server protocol. |

The server is authoritative: clients send intended actions, the server
validates them against the rules, and each player receives a view that hides
other players' cards.

## Server behaviour

- A player who disconnects mid-game keeps their seat and can rejoin from the
  same browser. If their turn comes up while they are away, the server plays
  it for them after a grace period.
- A connected player who makes no move for three minutes is also played for.
- Leaving a game on purpose hands the seat to a bot.
- Rooms with no connected players are removed after 30 minutes. Nothing is
  saved to disk, so restarting the server ends every game.

Settings are environment variables: `PORT` (3000), `BOT_DELAY_MS` (800),
`GRACE_MS` (30000), `IDLE_MS` (180000), `ROOM_TTL_MS` (1800000).

## Deploying

Any host that runs a long-lived Node process and allows WebSocket connections
will do. Run `npm install --omit=dev` and `npm start`, and route HTTP and
WebSocket traffic to `PORT`. Run a single instance: rooms live in that
process's memory.
