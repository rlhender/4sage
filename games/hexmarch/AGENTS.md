# Hexmarch for AI players

How a program or a language model takes a seat in a Hexmarch game. Nothing
here depends on a particular model, vendor or agent framework: if you can
make HTTP requests, you can play. The rules follow in the second half of
this guide.

`SERVER` below is wherever the game is hosted, for example
`https://hexmarch.example.com` or `http://localhost:3000`.

## The loop

1. **Get a seat.** Create a room, or join one a person made (they give you
   the four-letter code). You receive a `token`. Keep the code and the token;
   every later call needs both.
2. **Wait for your move.** Ask for the state with `wait=50`. The call returns
   as soon as it is your move, or the game is over, or 50 seconds pass.
3. **Read the briefing.** When `mustAct` is true, the `briefing` text tells
   you what is asked and lists your territories, their neighbours, the odds,
   and what happened last round.
4. **Reply in JSON.** Send placements in the place phase, orders in the
   orders phase. If the reply is rejected the `error` says exactly why;
   fix it and send again.
5. Go to 2 until `status` is `over`, or the briefing says your castle fell.

Every round has two moves from you: one placement, then one set of orders.
All players move at the same time, so there is no "turn" to wait for beyond
the other players sealing theirs. Each phase has a time limit
(`secondsLeft`); if it runs out, the server moves for you.

## Over HTTP

Send JSON bodies with `Content-Type: application/json`. Send your token as
`Authorization: Bearer TOKEN`. Every response is JSON with `ok` true or
false; failures carry an `error` message.

| Call | What it does |
|------|--------------|
| `POST /api/rooms` `{"name":"..."}` | Create a room and become host. Optional `phaseSeconds` (0 = no limit) and `rules`. Returns `code` and `token`. |
| `POST /api/rooms/CODE/join` `{"name":"..."}` | Join before the game starts. Returns `token`. |
| `GET /api/rooms/CODE?wait=50` | Your view. Blocks up to `wait` seconds (55 at most) until you must act or the game ends. `view=json` returns the structured view instead of the briefing, `view=full` both. |
| `POST /api/rooms/CODE/move` `{"placements":[...]}` or `{"orders":[...]}` | Seal your move. Send again to replace it until the last player seals. |
| `POST /api/rooms/CODE/retract` | Take your sealed move back. |
| `POST /api/rooms/CODE/bots` `{"strategy":"aggressive"}` | Host: add a built-in bot (`balanced`, `aggressive`, `fortress`, `passive`, `tuned`). |
| `POST /api/rooms/CODE/start` | Host: start the game. |
| `POST /api/rooms/CODE/options` `{"phaseSeconds":600}` | Host: change the time limit; before the start, also `rules`. |
| `DELETE /api/rooms/CODE/players/ID` | Host: remove a player before the start. |
| `POST /api/rooms/CODE/rematch` | Host: back to the lobby after a game. |
| `POST /api/rooms/CODE/leave` | Give up your seat; a bot takes over mid-game. |
| `GET /api/odds?attackers=5&defenders=3` | Exact odds of a fight. Add `castle=1` for a castle defended by its owner, `clash=1` for a border clash. |
| `GET /api/guide` | This guide and the rules. |

A whole game against two bots:

```
curl -s -X POST SERVER/api/rooms -H 'Content-Type: application/json' -d '{"name":"Ada"}'
#   -> {"ok":true,"code":"KQZM","token":"3f9c...","status":"lobby",...}

curl -s -X POST SERVER/api/rooms/KQZM/bots  -H 'Authorization: Bearer 3f9c...' -H 'Content-Type: application/json' -d '{"strategy":"aggressive"}'
curl -s -X POST SERVER/api/rooms/KQZM/bots  -H 'Authorization: Bearer 3f9c...' -H 'Content-Type: application/json' -d '{"strategy":"fortress"}'
curl -s -X POST SERVER/api/rooms/KQZM/start -H 'Authorization: Bearer 3f9c...'

curl -s 'SERVER/api/rooms/KQZM?wait=50'     -H 'Authorization: Bearer 3f9c...'
#   -> {"ok":true,"status":"playing","mustAct":true,"phase":"place","briefing":"HEXMARCH  round 1 ..."}

curl -s -X POST SERVER/api/rooms/KQZM/move  -H 'Authorization: Bearer 3f9c...' -H 'Content-Type: application/json' \
     -d '{"placements":[{"territory":21,"armies":4}]}'
curl -s -X POST SERVER/api/rooms/KQZM/move  -H 'Authorization: Bearer 3f9c...' -H 'Content-Type: application/json' \
     -d '{"orders":[{"from":21,"to":19,"armies":5}]}'
```

To play against people, have one of them create the room in the browser and
tell you the code, then use `join` instead of creating a room. You appear
in their lobby as a player.

`examples/http-agent.js` in the game's repository is a complete player in
one file and a starting point for your own.

## Over MCP

The server is also an MCP server at `SERVER/mcp` (Streamable HTTP, no
authentication, no session). Add it to any MCP-capable client; for example,
in a JSON client configuration:

```
{ "mcpServers": { "hexmarch": { "type": "http", "url": "SERVER/mcp" } } }
```

The tools mirror the HTTP calls: `hexmarch_get_guide`,
`hexmarch_create_room`, `hexmarch_join_room`, `hexmarch_add_bot`,
`hexmarch_start_game`, `hexmarch_get_state`, `hexmarch_submit_move`,
`hexmarch_get_odds` and `hexmarch_leave_room`. Pass `code` and `token` to
each call that acts for your seat.

## Playing well

- The briefing's percentages are the exact chance of capturing a neighbour
  if you send everything you can against the garrison there now. The real
  garrison may be smaller (the defender sent armies out) or the territory
  may be reinforced or taken by someone else first. Use the odds call for
  other force sizes.
- Whatever you send leaves home. A castle stripped to one army is an easy
  target, and losing it ends your game however much land you hold.
- Two forces attacking each other across a border meet in the field before
  either reaches land. If you expect an attack from a neighbour, attacking
  back along the same border fights their army with yours instead of with
  your garrison.
- Holding a whole island pays its bonus every round.
- There are two ways to win: take every other castle, or hold 65% of the
  territories at the end of a round. Watch for a rival nearing that share.
- Winning a border clash gives your survivors +1 on their highest die in
  the battle that follows.
- An empty orders list is a legal move.
