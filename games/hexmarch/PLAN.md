# Hexmarch build plan

A living checklist. Tick items as they land, keep "Where things stand" current,
and anyone (a person or another model) can pick the work up from here.

- **Goal:** a simultaneous-turn conquest game that people and AIs play
  together on a server the owner hosts, where the AIs are also used to find
  out which maps and which rules make a well-balanced game.
- **Branch:** `claude/happy-tesla-0dt81j`. Everything lives in `games/hexmarch/`.
- **Verify any change with:** `npm test` (must stay green before every commit).
- **Priorities** follow the repository convention: MH must-have, SH
  should-have, NH nice-to-have, WH won't-have for now.

## Where things stand

_Update this section at the end of every working session._

- Milestones 0 to 8 are built, tested (40 tests) and pushed.
- The owner has handed over the design decisions ("make the best decisions
  for an engaging game"). Decisions taken since are in the table below
  (rows 9 to 13) with their evidence in `BALANCE.md`.
- The deployment files are checked only as far as a clean production
  install, start and full game on Linux; nobody has yet run them on a real
  VPS. That is the owner's next step (milestone 5, last item).
- Nothing is in progress. Next up: the first open item under "Later".

## What the owner asked for

1. Everyone takes their turn at the same time: public placement, then secret
   orders resolved together, with border clashes before territory battles.
2. Castles in the spirit of Castle Risk, as an original game (own map, name
   and rules text; no copy of that game's board or cards).
3. The engine is independent of the GUI and fully playable headless.
4. Any AI can play: no dependence on one model, vendor or agent harness.
5. AIs with different strategies play each other many times and improve.
6. Hosted on the owner's VPS, playable by humans and AIs together.
7. AIs are used to prove out good and bad maps and good and bad rules.
8. Work is planned, checkpointed and committed so it can be handed off.

## Architecture

```
            browser GUI          any AI agent            any MCP client
           (WebSocket)        (plain HTTP + JSON)      (MCP over HTTP)
                 \                    |                      /
                  +---------- server/rooms.js -------------+     one process,
                              rooms, seats, timers               state in memory,
                                      |                          saved to disk
                              engine/engine.js   <---- ai/strategies.js (bots)
                         rules, dice, JSON state        ai/arena.js, ai/lab.js
                                                        (mass play, tuning, balance)
```

### Decisions

| # | Decision | Why | Rejected |
|---|----------|-----|----------|
| 1 | One central server; every player is a seat in a room | Humans and AIs meet in the same game without special cases | Peer-to-peer; separate AI-only server |
| 2 | AIs play over plain HTTP + JSON with a token per seat | Works from any language, model or harness; nothing to install | A vendor SDK; WebSocket-only (hard for tool-calling agents) |
| 3 | The same actions are also exposed as an MCP endpoint | MCP is the common way agent harnesses load tools; it is a thin wrapper over decision 2, not a second implementation | MCP only (shuts out simple scripts); a Claude-only skill |
| 4 | Agents wait by long-polling (`wait=` seconds) | No busy polling, no missed turns, cheap for token-metered agents | Short polling; server push to agents |
| 5 | Agents read a text briefing and answer in JSON | Models reason best over a short, pre-digested description (their land, each neighbour, the odds) and act most reliably through a strict JSON shape. The full JSON view stays available for programs | JSON only (forces the model to join tables by id); free-text moves |
| 6 | Rules are data (`rules` in the game config) with today's behaviour as defaults | Lets the lab compare rule sets without code changes, and every game records the rules it used | Hard-coded constants |
| 7 | State is in memory, written to disk on change | Fast and simple; survives restarts; finished games become records for analysis | A database |
| 8 | No production dependencies beyond `ws` | Small, easy to host and audit; the MCP endpoint is hand-written and tested against the official client | Web frameworks; the MCP SDK at runtime |
| 9 | Aim for a game of 12 to 18 rounds with few stalemates, no start clearly better than another, and more than one way to win | Chosen on the owner's behalf as what "engaging" means in numbers the lab can check | Tuning by feel |
| 10 | Win by last castle, or by holding 65% of the territories | Ends games that are already decided; at 65% both ways to win stay live (57% castle, 39% domination with the tuned strategy) | Last castle only (22 rounds, 10% stalemates); 55% (castles hardly matter) |
| 11 | Castles start with 8 armies; a fallen player's land turns neutral | Fewer stalemates; handing land to the captor decides the game at the first castle | Garrison 5; land to the captor |
| 12 | Islands joined in a ring of sea lanes, the two smallest in the middle | Every island has two ways in; win rate by starting island went from 17-31% to 23-29% | Nearest-neighbour lanes (one-entry fortress islands); equal-sized islands (no better) |
| 13 | Border clashes stay rare and are rewarded when they happen (+1 die for the winner's next battle); fights still go to the end | With public army counts the weaker side should not attack, so clashes are occasional by nature; a retreat rule is the untested alternative | Forcing clashes by rule before seeing how people play |

## Milestones

### 0. Foundations (done)

- [x] MH Headless deterministic engine; a game is plain JSON (`engine/engine.js`)
- [x] MH Simultaneous rounds: sealed placement, sealed orders, border clashes,
      territory battles, late moves, castle elimination
- [x] MH Deterministic map generator from a seed (`engine/map.js`)
- [x] MH Exact battle odds (`engine/odds.js`)
- [x] MH Replayable game record (`exportRecord`, `replay`)
- [x] MH AI strategies as weights: aggressive, balanced, fortress, passive, random
- [x] MH Mass simulation and self-play tuning (`ai/arena.js`, `tuned` strategy)
- [x] MH Command line: simulate, tune, play a game one JSON move at a time
- [x] MH Browser GUI over WebSocket rooms, with bots of any strategy
- [x] MH Rulebook and JSON reference (`PLAYING.md`)

### 1. Rules as data

So rule sets can be compared without touching code.

- [x] MH `engine/rules.js`: defaults, validation, one line of documentation per rule
- [x] MH Engine reads every tunable from `state.config.rules`
- [x] MH Odds accept dice counts, tie rule and castle bonus
- [x] MH Strategies read the rules from their view, so bots stay sensible under variants
- [x] MH The view and the record carry the rules in force
- [x] MH Tests: defaults reproduce earlier games; each rule changes what it should

### 2. Briefing for AI players

- [x] MH `engine/briefing.js`: text briefing built from a view: what to do now,
      standings, your land with every neighbour and capture odds, castle
      threats, island progress, last round
- [x] MH Exact reply format and limits stated in every briefing
- [x] SH Briefing stays under about 1,500 tokens on a full board
- [x] MH Tests: briefing matches the view; an agent that reads only the
      briefing can produce a legal move

### 3. HTTP API for agents

- [x] MH `server/rooms.js`: room logic separated from transports
- [x] MH Endpoints: create room, join, add bot, start, state (long-poll),
      submit, retract, leave, rematch, odds, guide
- [x] MH Token per seat (`Authorization: Bearer`), agents shown as players in the lobby
- [x] MH Long-polling with a version counter
- [x] SH Room option for the phase time limit (models can be slow)
- [x] MH `GET /api/guide`: rules and API instructions served by the game itself
- [x] MH Tests: an agent plays a full game over HTTP beside a WebSocket human

### 4. MCP endpoint

- [x] MH `POST /mcp` (Streamable HTTP, stateless JSON responses): initialize,
      tools/list, tools/call, ping
- [x] MH Tools mirroring the HTTP API, with JSON Schemas
- [x] MH Test against the official MCP client (dev dependency only)

### 5. Persistence and deployment

- [x] MH Rooms saved to `DATA_DIR` on change and restored at start
- [x] SH Finished games written as records for later analysis
- [x] MH `deploy/`: systemd unit, reverse-proxy example with TLS and WebSocket
      upgrade, environment file, step-by-step guide
- [x] MH Clean-clone check: `npm ci --omit=dev && npm start` serves the game
- [ ] MH Owner: deploy to the VPS and play a game (see `deploy/README.md`)

### 6. Balance lab

- [x] MH `ai/lab.js` game-health metrics: length, stalemates, early blowouts,
      snowballing, lead changes, clashes per game, attacker success, win rate
      by strategy
- [x] MH Map evaluation: mirror matches on one map; win rate by starting
      island with error bars; verdict fair or skewed; structural facts
- [x] MH Rules evaluation: baseline against a variant, and sweeps of one rule
- [x] SH Strategies re-tuned for a variant before judging it (`--adapt`)
- [x] SH Vetted map list (`balance/maps.json`) that the server draws from
- [x] MH Command line: `lab maps`, `lab rules`, `lab sweep`
- [x] MH `BALANCE.md`: how to run it, what the numbers mean, findings so far

### 7. Agent kit

- [x] MH `examples/http-agent.js`: a complete outside player in one file,
      usable as a template for any language or model
- [x] MH `AGENTS.md`: connect an AI by HTTP or MCP, with copy-paste examples
- [x] SH `skill/hexmarch-player/SKILL.md` for harnesses that load skills

### 8. Balance changes from the lab

- [x] MH Rules for a second way to win, clash momentum and the map's shape
      (`dominationShare`, `clashMomentum`, `seaLanes`, `smallIslands`,
      `islandSizes`, `islandBonusBase`)
- [x] MH Strategies guess the opponents' orders and plan against them
      (`foresight`, `counter`)
- [x] MH New standard rules chosen from lab comparisons; strategy re-tuned
- [x] MH Fair-map list rebuilt (36 of 60 maps); the server deals from it
- [x] MH `BALANCE.md` rewritten around what was found and changed
- [x] SH Round playback in the GUI: everyone's orders revealed, then each
      clash, battle and move shown in turn

## Later

In rough order of value. None of these is started.

- [ ] SH Try `castleDefence=1` with strategies re-tuned for it; it gives the
      most comebacks of any variant measured
- [ ] SH Measure at two, five and six players; only three and four so far
- [ ] SH A retreat rule (an attack breaks off at half strength), as the
      candidate for making border clashes worth having
- [ ] SH An LLM-backed seat run by the server itself (needs an API key and a
      provider choice from the owner; today an LLM plays from outside)
- [ ] SH Feed finished human games into the lab, to compare with bot results
- [ ] SH Phone layout: a portrait arrangement of the islands, or pinch zoom
- [ ] SH Spectator links for a room
- [ ] NH Map generator options in the lab (island count, sizes, sea lanes)
- [ ] NH Stronger AI: look-ahead on likely enemy orders, opponent modelling
- [ ] NH Access key for creating rooms on a public server
- [ ] NH Cards or leaders, as original designs
- [ ] WH Accounts, ranking, matchmaking
- [ ] WH Horizontal scaling (rooms live in one process by design)

## Questions for the owner

None are blocking. The owner asked for design decisions to be made without
check-ins; they are recorded above. Two would still benefit from an owner's
view when there is one:

- Should the server be open to anyone who has the address, or need a key?
- After playing with people: do border clashes happen often enough?

## Working conventions

- One commit per finished step, tests green, pushed to the branch.
- Engine code stays free of I/O and of anything GUI- or server-specific.
- Every new rule gets a default that preserves current behaviour, a line in
  `engine/rules.js`, and a test.
- User-facing rules text lives in `PLAYING.md`; agent instructions in
  `AGENTS.md`; balance method and results in `BALANCE.md`.
