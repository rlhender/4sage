# Balance

How Hexmarch uses its computer players to judge maps and rules, and what
that has shown so far.

## Method

The lab (`ai/lab.js`) plays hundreds of complete games between the built-in
strategies and measures the result. It reports numbers and checks them
against stated limits; it does not know what is fun. Treat a failed check
as a reason to look, and a pass as "no obvious problem", not as proof.

### Judging rules

A mixed field (aggressive, balanced, fortress, passive) plays on random
maps under a rule set. The same games are played under the standard rules
for comparison.

| Measure | Meaning | Healthy |
|---------|---------|---------|
| average rounds | game length | 6 to 25 |
| reach the round limit | nobody won by conquest: a stalemate | at most 10% |
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
node cli/hexmarch.js lab sweep --name castleGarrison --values 3,5,8,12
node cli/hexmarch.js lab maps --seeds 1-30 --games 400 --save
node cli/hexmarch.js lab rules --rule castleDefence=1 --adapt 8   # re-tune a strategy for the variant first
```

`--save` writes the fair maps to `balance/maps.json`; the server deals new
games only from that list when it exists. Add `--json` for raw results.

## Findings so far

Run on 2026-11-14 with the strategies as tuned that day. 400 games per
column. Re-run after any change to rules or strategies; these numbers go
stale.

### Rules

| | standard | castleGarrison 8 | castleDefence 1 | fallenLand captor | castleIncome 2 |
|---|---|---|---|---|---|
| average rounds | 22.0 | 22.4 | 26.3 ✗ | 10.4 | 18.0 |
| reach the round limit | 9% | 7% | 13% ✗ | 2% | 10% |
| over within 3 rounds | 0% | 0% | 0% | 5% | 8% |
| round-3 leader wins | 57% | 47% | 44% | 76% ✗ | 62% |
| lead changes a game | 1.3 | 1.5 | 1.6 | 0.8 | 1.0 |
| first castle falls (round) | 4.2 | 5.1 | 8.0 | 4.2 | 2.6 |
| best strategy win rate | 39% | 36% | 38% | 49% | 34% |
| border clashes a game | 0.0 | 0.0 | 0.1 | 0.1 | 0.0 |

1. **The standard rules pass every check, but only just on length.** Games
   average 22 rounds (44 decisions a player) and 9% hit the round limit.
2. **Border clashes almost never happen between bots**: about one game in
   ten has one. A clash needs two players to attack each other across the
   same border in the same round, and the bots attack where they are
   strong, not where they are threatened. Giving them a counter-attack
   option did not change this. So the mechanic the game is built around is
   not yet being exercised or tested by bot play. Whether people would
   clash more is unknown.
3. **Handing a fallen player's land to the captor is bad as it stands.**
   Games halve in length, but the early leader wins 76% of the time and the
   aggressive strategy takes 49%.
4. **A castle defence bonus is bad as it stands.** It delays the first
   elimination from round 4 to round 8 and pushes stalemates to 13%.
5. **A larger starting castle garrison looks good.** At 8 the early leader
   wins less often (47% against 57%) and there are more lead changes, at no
   cost in length or stalemates. This is the best candidate for a change to
   the standard rules.
6. **Castle income shortens games but brings early knockouts** (8% over
   within three rounds, first castle down by round 2.6).
7. `clashTies` makes no measurable difference, because of finding 2.

### Maps

Thirty maps (seeds 1 to 30), three identical balanced players, 400 games
each: **9 fair, 12 uneven, 9 skewed.**

- **Starting on a small corner island is an advantage on almost every
  map.** Frostmere and Duskmarch (five territories each, at opposite
  corners) are the best start on 24 of the 30 maps, winning 36% to 46%
  where an even share is 33%. The worst start is nearly always one of the
  four larger islands (Ashen Reach on 10 maps, Verdant Coil 8, Sunspire 6,
  Stormcradle 4), at 14% to 28%. A small island is quick to complete for
  its bonus and has few ways in.
- This is a property of the map generator, not of particular seeds, so
  picking fair seeds only reduces it. The 9 fair seeds are saved and used
  by the server for now.
- Three-player mirror games are much shorter than the mixed four-player
  field (about 9.3 rounds) and 5% to 14% of them are over within three
  rounds, close to or above the limit.

## What to try next

- Make clashes happen: teach the strategies to expect an attack and answer
  it, then see whether clashing is ever the better choice. If it is not,
  the rule may need a reason to clash (for example, a clash winner fighting
  the garrison at an advantage).
- Level the starting islands: scale island bonuses by how defensible an
  island is, give small islands more sea lanes, or forbid castles on them.
- Adopt `castleGarrison=8` and re-measure everything against it.
- Repeat the rule comparisons with strategies re-tuned for each variant
  (`--adapt`), and at two, three, five and six players.
- Compare with real games: finished games on the server are filed in
  `DATA_DIR/records` in the same replayable format.

## Limits of this evidence

- The players are simple heuristics. A rule that looks fine against them
  may break against people or stronger AIs, and the reverse.
- The strategies were tuned under the standard rules, which favours them.
- All results are for random deals; nobody chooses their castle.
