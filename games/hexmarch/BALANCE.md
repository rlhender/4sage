# Balance

How Hexmarch uses its computer players to judge maps and rules, what that
has shown, and what was changed because of it.

## Method

The lab (`ai/lab.js`) plays hundreds of complete games between the built-in
strategies and measures the result. It reports numbers and checks them
against stated limits; it does not know what is fun. Treat a failed check
as a reason to look, and a pass as "no obvious problem", not as proof.

### Judging rules

A mixed field (aggressive, balanced, fortress, passive) plays on random
maps under a rule set, and the same games are played under the standard
rules for comparison.

| Measure | Meaning | Healthy |
|---------|---------|---------|
| average rounds | game length | 6 to 25 |
| reach the round limit | nobody won outright: a stalemate | at most 10% |
| over within 3 rounds | decided before anyone could respond | at most 10% |
| round-3 leader wins | snowballing: the rest of the game is a formality | at most 75% |
| best strategy win rate | one way of playing dominates (even share is 25%) | at most 55% |
| passive win rate | sitting still pays | at most 30% |
| lead changes, border clashes, attacks that capture, first castle falls | descriptive; no limit set | |

The limits are judgements. They live in `CRITERIA` in `ai/lab.js`.

### Judging maps

Every seat plays the same strategy on one map, hundreds of times with
different deals and dice. Any difference in results then comes from where a
player's castle starts. For each starting island the lab reports the win
rate and how far it is from an even share, in standard errors. A map is
**fair** if no island is 2 or more away, **skewed** if any is 3 or more,
**uneven** in between. With about six islands compared per map, roughly a
quarter of perfectly fair maps would be called uneven by chance, so only
"skewed" is strong evidence.

### Running it

```
node cli/hexmarch.js rules                                   # every rule and its default
node cli/hexmarch.js lab rules --rule fallenLand=captor      # one variant against standard
node cli/hexmarch.js lab sweep --name castleGarrison --values 5,8,12
node cli/hexmarch.js lab maps --seeds 1-60 --save
node cli/hexmarch.js lab rules --rule castleDefence=1 --adapt 8   # re-tune a strategy for the variant first
```

`--save` writes the fair maps to `balance/maps.json`; the server deals new
games only from that list when it exists. Add `--json` for raw results.

## What the lab changed

The first version of the rules was measured on 2026-11-14, found wanting in
three ways, and changed. Design aims, set on the owner's behalf: a game of
roughly 12 to 18 rounds, few stalemates, no start that is clearly better
than another, and more than one way to win.

| | first rules | standard rules now |
|---|---|---|
| average rounds (mixed field) | 21.7 | 17.2 |
| average rounds (with the tuned strategy) | 17.3 | 14.4 |
| reach the round limit | 10% | 3% |
| over within 3 rounds | 0% | 0% |
| round-3 leader wins | 56% | 56% |
| maps judged fair / skewed | 9 / 9 of 30 | 36 / 5 of 60 |
| win rate by starting island, 4 players (even share 25%) | 17% to 31% | 23% to 29% |

Mixed field: 400 games, four strategies, random maps. Maps: three identical
players, 300 to 400 games a map.

### 1. Games were too long and too often stalemates

Under the first rules the last castle had to fall. Games averaged 22 rounds
and one in ten ran to the round limit, mostly two survivors grinding
through neutral land.

- **Added a second way to win: hold 65% of the territories at the end of a
  round** (`dominationShare`). It ends games that are already decided.
  At 55% most games ended this way and castles hardly mattered; at 65%,
  with the tuned strategy in the field, 57% of games end with the last
  castle and 39% by domination, so both are live.
- **Castles start with 8 armies instead of 5** (`castleGarrison`). Fewer
  stalemates (8% to 3%) at no cost in length.

### 2. Where you started mattered too much

On the first maps a castle on some islands won far more often than on
others: in four-player games, 17% from the worst island and 31% from the
best, against an even share of 25%. Of 24 maps, 23 were skewed.

The cause was the sea lanes. Islands were joined to their nearest
neighbours, which left the map a tree: islands at the ends had a single way
in and were natural fortresses (about 1.3 lanes on average for the best
starting islands, about 2 for the worst). Island size, bonus and position
each made a smaller difference, and making the islands equal in size did
not help.

- **Islands are now joined in a ring** (`seaLanes`), so each has exactly
  two ways in. Win rate by starting island is now 31% to 35% with three
  players and 23% to 29% with four.
- **The two smallest islands sit in the middle of the map**
  (`smallIslands`), not in the corners.
- The server deals only from the 36 maps judged fair
  (`balance/maps.json`).

### 3. Border clashes are rare, and that is accepted for now

A border clash needs two players to attack each other across the same
border in the same round. In bot play that happens in about one game in
fifteen. Three things were tried:

- A counter-attack habit for the strategies: no change.
- Strategies that guess the opponents' orders and plan against them
  (`foresight`): self-play tuning kept the foresight in every run (0.5 to
  1.0), so it helps. The readiness to counter-attack came out anywhere
  from 0 to 0.5 across three runs, which means it makes no consistent
  difference to winning, and clashes stayed as rare whatever it was.
- The reason is in the arithmetic. Army counts are public and fights go to
  the end, so the weaker side of a border knows it is weaker and loses its
  whole force if it attacks. Holding is right, so the two rarely meet.

Decision: keep the clash as it is, and **reward it when it happens: the
winner's survivors add 1 to their highest die in the battle that follows**
(`clashMomentum`). This cannot be measured with clashes this rare; it is a
judgement that a won field battle should matter. Whether people clash more
than bots is the open question, and finished games on the server are
recorded so that it can be answered.

## Rule variants against the standard rules

400 games each, mixed field.

| | standard | fallen land to captor | castle defence +1 | no domination win | nearest-neighbour lanes |
|---|---|---|---|---|---|
| average rounds | 17.2 | 7.9 | 19.1 | 19.3 | 17.8 |
| reach the round limit | 3% | 1% | 6% | 4% | 5% |
| over within 3 rounds | 0% | 8% | 0% | 0% | 0% |
| round-3 leader wins | 56% | 73% | 47% | 56% | 55% |
| lead changes a game | 1.3 | 0.9 | 1.5 | 1.3 | 1.3 |
| best strategy win rate | 39% | 46% | 40% | 38% | 43% |
| passive win rate | 8% | 2% | 7% | 8% | 12% |

- **Handing a fallen player's land to the captor** makes games very short
  and nearly decides them at the first castle: rejected.
- **A castle defence bonus** now passes every check and gives the most
  comebacks (the early leader wins 47%, against 56%), for two more rounds.
  It is the most promising change not yet made.
- Other things tried and not adopted: more income (`minIncome=4`: more
  comebacks but about three rounds longer), one die for defenders (faster,
  fewer lead changes), two dice for attackers (17% stalemates).

## What to try next

- `castleDefence=1` with the strategies re-tuned for it (`--adapt`).
- Everything at two, five and six players; so far only three and four.
- Compare with real games: finished games on the server are filed in
  `DATA_DIR/records` in the same replayable format. In particular, how
  often people clash.
- A retreat rule (an attack breaks off at half strength). Attacks would no
  longer be all or nothing, which may be what makes clashes worth having.

## Limits of this evidence

- The players are heuristics. A rule that looks fine against them may break
  against people or stronger AIs, and the reverse.
- The fixed personalities were written for the first rules; only `tuned`
  has been re-tuned for the current ones.
- All results are for random deals; nobody chooses their castle.
- Numbers go stale. Re-run after any change to rules or strategies.
