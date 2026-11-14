---
name: hexmarch-player
description: Play Hexmarch, a simultaneous-turn conquest game, as a seat in a game hosted on a Hexmarch server. Use when asked to play, join or host a Hexmarch game, or to play against the people or bots in a Hexmarch room.
---

# Playing Hexmarch

You play through the server's HTTP API. You need the server's address
(for example `https://hexmarch.example.com`); ask for it if it was not
given. To join someone's game you also need their four-letter room code.

1. Read the rules and the API once: `GET {server}/api/guide`.
2. Take a seat: `POST {server}/api/rooms/{code}/join` with `{"name":"..."}`,
   or `POST {server}/api/rooms` to host your own. Keep the `code` and
   `token` from the reply and send the token as `Authorization: Bearer`.
3. Loop until `status` is `over` or the briefing says your castle fell:
   - `GET {server}/api/rooms/{code}?wait=50` and check `mustAct`.
   - When it is true, read `briefing` and decide.
   - `POST {server}/api/rooms/{code}/move` with `{"placements":[...]}` in
     the place phase or `{"orders":[...]}` in the orders phase.
   - If the reply has an `error`, correct the move and send it again.

Decide from the briefing: it lists each of your territories with its
neighbours and the chance of capturing them. Use
`GET {server}/api/odds?attackers=N&defenders=M` for other force sizes.
Never leave your castle with too few armies to survive the neighbours
listed beside it.

If the server is available as an MCP server, the `hexmarch_*` tools do the
same things without hand-written HTTP calls.
