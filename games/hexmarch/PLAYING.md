# Playing Hexmarch

This is the complete rulebook and the JSON interface, written so that a
person, a script or a large language model can play from this page alone.

## The game

Two to six players fight over an archipelago of six islands divided into 36
territories. Territories border their neighbours on the same island. The
islands are joined in a ring by sea lanes, so every island has exactly two
ways in. Each player starts with one **castle**, garrisoned with 8 armies.
Lose your castle and you are out.

You win by being the last castle standing, or by holding 65% of all
territories (24 of the 36) at the end of a round.

Everything on the board is public: who holds each territory, how many armies
are there, and where the castles are. The only secrets are what each player
has sealed for the current phase.

## A round

Everyone acts at the same time. A round has two phases.

### 1. Place

Each player receives new armies:

- one per three territories held, rounded down, and never fewer than 3;
- plus the bonus of every island they hold completely.

Each player seals where those armies go, on their own territories. When the
last player seals, all placements are applied and revealed together.

### 2. Orders

Each player seals a list of orders. An order sends a number of armies from
one of their territories to a neighbouring territory:

- to someone else's or neutral land, it is an **attack**;
- to their own land, it is a **move**.

A territory can give several orders but must always keep at least one army
at home. An empty list holds position. When the last player seals, every
order is revealed and resolved together, in this sequence:

1. **Departure.** All ordered armies leave at once. Whatever stays behind is
   the garrison that defends.
2. **Border clashes.** If two players ordered attacks at each other across
   the same border, those two forces meet first. Each side rolls up to three
   dice, the dice are compared highest against highest, the lower die loses
   an army and a tie costs both sides one. They fight until one force is
   gone. The winner's survivors carry on with momentum: in the battle that
   follows they add 1 to their highest die. The loser's attack is over.
3. **Territory battles.** Each attacking force fights the garrison of its
   target. The attacker rolls up to three dice, the defender up to two, and
   ties go to the defender. They fight until one side is gone. If the
   garrison falls, the survivors take the territory.
   - All of one player's forces heading for the same territory fight as one.
   - If several players attack the same territory, the largest force goes
     first (ties are broken at random) and each later force fights whoever
     holds the territory by then.
4. **Moves.** Moving armies arrive after the fighting. If the destination
   has fallen in the meantime, they attack whoever took it.
5. **Castles.** Any player whose castle is now held by someone else is
   eliminated. The rest of their land becomes neutral: it keeps its armies,
   defends itself, and never attacks.

There is no retreat: every fight goes to the end.

### House rules

The numbers above are the standard rules. A room can be created with
different ones (castle strength, income, dice, what happens to a fallen
player's land, and so on). Every view lists the rules in force under
`rules`, the briefing names any that differ from standard, and
`node cli/hexmarch.js rules` lists them all.

### Ending

The game ends at the end of a round in which only one castle is left, or
in which one player holds 65% of all territories. It also ends after the
last round (40), when the player with the most territories wins, then the
most armies; an exact tie is a draw. If the last players eliminate each
other in the same round, the same comparison decides it.

## JSON interface

Every kind of player gets the same view and sends the same two messages.

### What you see

`observe` returns one object. Seats are numbered from 0; an owner of `null`
is neutral.

```
{
  "you": 0,                      your seat
  "round": 3, "maxRounds": 40,
  "rules": {...},                the rules in force
  "phase": "place",              "place", "orders" or "over"
  "income": 5,                   armies you must place this phase
  "submitted": null,             what you have sealed this phase, if anything
  "players": [
    {"seat":0, "name":"...", "alive":true, "castle":21,
     "territories":12, "armies":31, "income":5, "ready":false}
  ],
  "territories": [
    {"id":21, "name":"Solace", "region":"Sunspire", "owner":0, "armies":7,
     "castleOf":0, "adjacent":[18,19,22,23,27]}
  ],
  "regions": [
    {"name":"Sunspire", "bonus":4, "territories":[18,19,20,21,22,23], "heldBy":null}
  ],
  "placements": null,            in the orders phase: this round's placements, by seat
  "lastRound": {                 the most recent resolved round
    "round": 2,
    "placements": [...], "orders": [...],   everything each seat sealed
    "events": [...]                         what happened, in order
  },
  "result": null                 when over: {"winner": seat or null, "reason": "...", "round": n}
}
```

`castleOf` appears only on the castles of players still in the game.
`ready` says whether a player has sealed, never what.

Events are `clash`, `battle`, `move`, `eliminated` and `gameOver`. A battle
looks like this:

```
{"type":"battle", "territory":19, "attacker":0, "defender":1, "from":[21,22],
 "attackers":7, "defenders":3, "attackersLeft":7, "defendersLeft":0, "captured":true}
```

### What you send

In the place phase, placements that add up to exactly your income:

```
{"placements": [{"territory": 21, "armies": 3}, {"territory": 22, "armies": 2}]}
```

In the orders phase, any number of orders, or none:

```
{"orders": [{"from": 21, "to": 19, "armies": 5}, {"from": 22, "to": 19, "armies": 2}]}
```

A rejected submission comes back with an `error` that says what was wrong
and changes nothing. You can replace your submission until the last player
seals.

## Playing from the command line

A game lives in one JSON file, so it can be played one step at a time by
anything that can run a command.

```
node cli/hexmarch.js new --file game.json --players you,aggressive,fortress --seed 1
node cli/hexmarch.js observe --file game.json
node cli/hexmarch.js submit --file game.json --json '{"placements":[{"territory":21,"armies":4}]}'
node cli/hexmarch.js submit --file game.json --json '{"orders":[{"from":21,"to":19,"armies":5}]}'
```

Seats named after a strategy (`aggressive`, `balanced`, `fortress`,
`passive`, `tuned`, `random`) are bots and answer immediately. Any other
name is an outside player; with more than one, pass `--seat`. `observe` and
`submit` also return a `summary`: the latest events in plain English.
`observe --brief` prints the text briefing instead: the same facts arranged
for deciding, with every neighbour and the odds beside each territory.

### Odds

Fights are dice, so decide by expected outcome:

```
node cli/hexmarch.js odds 5 3          a force of 5 attacking a garrison of 3
node cli/hexmarch.js odds 5 5 --clash  two forces of 5 meeting on a border
```

This prints the exact chance of winning and the expected survivors. In
code, the same numbers come from `captureOdds` and `clashOdds` in
`engine/odds.js`. Remember that the garrison you will actually meet is what
is left after the defender's own orders leave, which you cannot see.

## Playing from code

```js
import { createGame, observe, submit } from './engine/engine.js';

const state = createGame({ players: ['Ada', 'Grace'], seed: 7 });
const view = observe(state, 0);
submit(state, 0, { placements: [{ territory: view.players[0].castle, armies: view.income }] });
```

`state` is plain JSON and holds the dice seed, so a game can be saved,
resumed and replayed exactly. `exportRecord(state)` gives the smallest
complete description of a game (its settings plus what every seat sealed
each round) and `replay(record)` rebuilds it.
