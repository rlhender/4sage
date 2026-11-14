# Balance

How Hexmarch uses its computer players to judge maps and rules, what that
has shown, and what was changed because of it.

## Method

The lab (`ai/lab.js`) plays hundreds of complete games between the built-in
strategies and measures the result. It reports numbers and checks them
against stated limits; it does not know what is fun. Treat a failed check
as a reason to look, and a pass as "no obvious problem", not as proof.

### Judging rules

A field of different strategies plays on random maps under a rule set, and
the same games are played under the standard rules for comparison.

| Measure | Meaning | Healthy |
|---------|---------|---------|
| average rounds | game length | 6 to 25 |
| reach the round limit | nobody won outright: a stalemate | at most 10% |
| over within 3 rounds | decided before anyone could respond | at most 10% |
| round-3 leader wins | snowballing: the rest of the game is a formality | at most 75% |
| best strategy win rate | one way of playing dominates (meant for four players, where an even share is 25%) | at most 55% |
| passive win rate | sitting still pays | at most 30% |
| lead changes, border clashes, attacks that capture, first castle falls | descriptive; no limit set | |

The limits are judgements. They live in `CRITERIA` in `ai/lab.js`.

### Judging maps

Every seat plays the same strategy on one map, hundreds of times with
different deals and dice. Any difference in results then comes from where a
player's castle starts. For each starting island the lab reports the win
rate and its gap from an even share. A map is **fair** if no island is more
than 8 points from an even share, **skewed** at 15 points or more, and
**uneven** in between.

### Running it

```
node cli/hexmarch.js rules                                   # every rule and its default
node cli/hexmarch.js lab rules --rule fallenLand=captor      # one variant against standard
node cli/hexmarch.js lab sweep --name castleGarrison --values 5,8,12
node cli/hexmarch.js lab maps --seeds 1-60 --players 3,4 --save
node cli/hexmarch.js lab rules --rule castleDefence=1 --adapt 8   # re-tune a strategy for the variant first
```

`--save` writes the fair maps to `balance/maps.json`; the server deals new
games only from that list when it exists. Add `--json` for raw results.

## What the lab changed

The first version of the rules was measured, found wanting in four ways,
and changed. The aims, set on the owner's behalf: a game of roughly 10 to
18 rounds at any table size, few stalemates, no game decided before
players can respond, no start clearly better than another, and more than
one way to win.

All figures below were measured on 2026-11-14 with the strategies as they
stand, 300 to 400 games each.

| | first rules | standard rules now |
|---|---|---|
| average rounds, 2 / 3 / 4 / 6 players | 6.0 / 8.9 / 17.7 / 26.3 | 12.1 / 10.8 / 11.5 / 13.7 |
| over within 3 rounds, 2 / 3 players | 50% / 33% | 2% / 0% |
| reach the round limit, 4 / 6 players | 3% / 6% | 0% / 0% |
| win rate by starting island, 3 players (even 33%) | 27% to 38% | 32% to 35% |
| win rate by starting island, 4 players (even 25%) | 17% to 31% | 23% to 28% |

### 1. Small games ended almost at once

With two or three players, half and a third of games were over within
three rounds. Land was dealt at random across the whole map, so players
began with armies next to each other's castles and could take one before
its owner had moved twice.

- **Every player now starts with a castle and five territories; the rest
  of the map is neutral** (`minSeats`), whatever the number of players.
  The game opens with expansion into neutral land.
- **Nobody starts next to an enemy castle** (`startingLand=buffered`).
- Two alternatives were measured and rejected. Starting each player with
  the land round their castle, or with their whole island, also stopped
  the early knockouts, but made the starting position decide too much on
  each map (a typical gap of 18 points from an even share, against 8).

### 2. Large games were too long and too often stalemates

Under the first rules the last castle had to fall. Four-player games
averaged 18 rounds and six-player games 26, with the survivors grinding
through each other's leftovers.

- **A second way to win: hold 60% of the territories at the end of a
  round** (`dominationShare`). It ends games that are already decided.
  Both ways to win stay live: with three players 68% of games end with the
  last castle and 30% by domination; with four, 39% and 61%.
- **Income is one army per two territories, not three**
  (`territoriesPerArmy`), which suits the smaller starting holdings.
- **Castles start with 8 armies instead of 5** (`castleGarrison`).

### 3. Where you started mattered too much

On the first maps a castle on some islands won far more often than on
others. Three causes were found, each by measuring it:

- **Sea lanes.** Islands were joined to their nearest neighbours, which
  made the map a tree. Islands at the ends had one way in and were natural
  fortresses. **Islands are now joined in a ring** (`seaLanes`), two lanes
  each, and **the two landings on an island are kept apart** so that one
  army cannot hold both.
- **Castle placement.** Castles were placed as far apart as possible, with
  ties going to the same islands every time, so some islands hosted
  castles twice as often as others and the rare start was usually the
  isolated one. **Castles are now spread evenly round the ring**, one to
  an island, at a random rotation.
- **Island size.** With four players the smaller islands were the better
  start. **All six islands now have six territories** (`islandSizes`).

A fourth apparent cause was the bots, not the map: faced with identical
neutral targets they all chose the lowest-numbered one. They now prefer
land near their own castle and break ties differently by seat. Map
measurements made before that fix are not comparable.

Of 60 maps judged at three and four players, none is skewed and 28 are
fair at both table sizes. The server deals only from those 28
(`balance/maps.json`).

### 4. Border clashes are rare, and that is accepted for now

A border clash needs two players to attack each other across the same
border in the same round. In bot play that now happens about once in fifty
games. Three things were tried:

- A counter-attack habit for the strategies: no change.
- Strategies that guess the opponents' orders and plan against them
  (`foresight`): self-play tuning keeps the foresight, so it helps, but
  clashes stayed as rare.
- The reason is in the arithmetic. Army counts are public and fights go to
  the end, so the weaker side of a border knows it is weaker and loses its
  whole force if it attacks. Holding is right, so the two rarely meet. Now
  that the map opens with neutral land between the players, they meet even
  less.

Decision: keep the clash as it is, and **reward it when it happens: the
winner's survivors add 1 to their highest die in the battle that follows**
(`clashMomentum`). This cannot be measured with clashes this rare; it is a
judgement that a won field battle should matter. Whether people clash more
than bots is the open question, and finished games on the server are
recorded so that it can be answered. If they do not, the game's central
idea needs a rule that gives a reason to clash; a retreat rule is the
first candidate.

## The standard rules today

Four fixed strategies on random maps, 400 games: 12.8 rounds on average,
1% reach the round limit, almost none are over within three rounds, the round-3
leader wins 57%, and the first castle falls in round 4.6 on average.
Win rates: aggressive 44%, balanced 37%, fortress 16%, passive 4%.
Attacks capture their target 91% of the time, which says the strategies
only attack when nearly sure.

By table size, with the tuned strategy in the field:

| players | rounds | reach the limit | over within 3 rounds | round-3 leader wins |
|---|---|---|---|---|
| 2 | 12.1 | 1% | 2% | 65% |
| 3 | 10.8 | 0% | 0% | 51% |
| 4 | 11.5 | 0% | 0% | 54% |
| 5 | 13.1 | 2% | 0% | 53% |
| 6 | 13.7 | 0% | 0% | 51% |

## Rule variants measured and not adopted

- **A fallen player's land goes to the captor**: games are very short and
  the first castle to fall nearly decides them.
- **A castle defence bonus**: more comebacks, at the cost of longer games.
  Measured under earlier rules only; worth repeating.
- **No domination win**: longer, with more stalemates.
- **Two dice for attackers**: 17% stalemates. **One die for defenders**:
  faster, fewer lead changes.
- **Starting with the land round the castle, or the whole island**: see 1.
- **Islands of different sizes**, **small islands in the corners or the
  centre**, **steeper island bonuses**: see 3.

## What to try next

- A retreat rule (an attack breaks off at half strength). Attacks would no
  longer be all or nothing, which may be what makes clashes worth having.
- The aggressive strategy now wins most among the fixed four (44%). Check
  whether that is the rules rewarding aggression too much, or the other
  three being tuned for rules that no longer exist.
- `castleDefence=1` under the current rules, with re-tuned strategies.
- Compare with real games: finished games on the server are filed in
  `DATA_DIR/records` in the same replayable format.

## Limits of this evidence

- The players are heuristics. A rule that looks fine against them may break
  against people or stronger AIs, and the reverse.
- The fixed personalities were written for the first rules; only `tuned`
  has been re-tuned for the current ones.
- Bot habits can masquerade as map or rule effects (see 3). Check a
  surprising result against the strategies before believing it.
- Numbers go stale. Re-run after any change to rules or strategies.
