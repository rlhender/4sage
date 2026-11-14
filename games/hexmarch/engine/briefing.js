// A view of the game written for a language model to decide from. The JSON
// view is complete but makes the reader join tables by id; this lays the same
// facts out around the decision: what is asked now, each of your territories
// with its neighbours and the odds, what threatens you, and what just happened.
// The reply is still strict JSON, because that is what models produce reliably.

import { captureOdds } from './odds.js';
import { DEFAULT_RULES, RULES } from './rules.js';
import { describeEvent, describePlacements } from './report.js';

const MAX_EVENT_LINES = 24;

export function briefing(view) {
  const T = view.territories;
  const me = view.you;
  const self = view.players[me];
  const tag = (t) => `#${t} ${T[t].name}`;
  const holder = (t) => (T[t].owner === null ? 'neutral' : T[t].owner === me ? 'yours' : view.players[T[t].owner].name);
  const pct = (p) => `${Math.round(p * 100)}%`;
  const out = [];

  out.push(`HEXMARCH  round ${view.round} of ${view.maxRounds}  phase: ${view.phase.toUpperCase()}  you: ${self.name} (seat ${me})`);

  // ----- what is being asked -----
  out.push('');
  if (view.result) {
    out.push(view.result.winner === null ? 'GAME OVER: a draw.'
      : `GAME OVER: ${view.result.winner === me ? 'you won' : `${view.players[view.result.winner].name} won`} (${view.result.reason}, round ${view.result.round}).`);
  } else if (!self.alive) {
    out.push('Your castle has fallen. You are out of the game and have nothing to send.');
  } else {
    const waiting = view.players.filter((p) => p.alive && !p.ready && p.seat !== me).map((p) => p.name);
    if (view.submitted) {
      out.push(`YOU HAVE SEALED THIS PHASE: ${JSON.stringify(view.submitted)}`);
      out.push(`Waiting for: ${waiting.join(', ') || 'nobody'}. You may send a new reply to replace it until the last player seals.`);
    } else if (view.phase === 'place') {
      out.push(`ACTION NEEDED: place exactly ${view.income} new armies on your own territories.`);
      out.push('Reply with JSON only: {"placements":[{"territory":<id>,"armies":<n>}]}');
      out.push(`The armies must add up to ${view.income}. Everyone places at once; all placements are revealed together before orders.`);
    } else {
      out.push('ACTION NEEDED: give your attack and move orders for this round.');
      out.push('Reply with JSON only: {"orders":[{"from":<id>,"to":<id>,"armies":<n>}]}   ({"orders":[]} holds position)');
      out.push('"from" must be yours and "to" one of its neighbours below. A territory may give several orders but must keep 1 army: it can send at most the "can send" figure in total.');
      out.push('Orders are secret and all resolve together: forces attacking each other across a border clash first; then each force fights the garrison that stayed behind; moves to your own land arrive after the fighting.');
    }
  }

  const changed = Object.keys(RULES).filter((key) => view.rules[key] !== DEFAULT_RULES[key]);
  if (changed.length) out.push(`House rules in this game: ${changed.map((key) => `${key}=${view.rules[key]}`).join(', ')}.`);

  // ----- who is who -----
  out.push('', 'PLAYERS');
  for (const p of view.players) {
    out.push(p.alive
      ? `seat ${p.seat} ${p.name}${p.seat === me ? ' (you)' : ''}: ${p.territories} territories, ${p.armies} armies, +${p.income} a round, castle ${tag(p.castle)}${p.ready && !view.result ? ', has sealed' : ''}`
      : `seat ${p.seat} ${p.name}: eliminated`);
  }

  // ----- your land, one line each -----
  if (self.alive && !view.result) {
    const odds = (force, n) => captureOdds(force, T[n].armies, view.rules, T[n].castleOf === T[n].owner).win;
    out.push('', 'YOUR TERRITORIES  (% = chance to capture that neighbour as it stands if you send everything you can)');
    for (const t of T.filter((x) => x.owner === me)) {
      const send = t.armies - 1;
      const foes = t.adjacent.filter((n) => T[n].owner !== me);
      const own = t.adjacent.filter((n) => T[n].owner === me);
      const threat = foes.reduce((sum, n) => sum + (T[n].owner === null ? 0 : T[n].armies), 0);
      const parts = [`#${t.id} ${t.name}${t.castleOf === me ? ' (YOUR CASTLE)' : ''}: ${t.armies} ${t.armies === 1 ? 'army' : 'armies'}, can send ${send}`];
      if (foes.length) {
        parts.push(`borders ${foes.map((n) => `${tag(n)}${T[n].castleOf !== undefined ? ' CASTLE' : ''} ${holder(n)} ${T[n].armies}${send > 0 ? ` [${pct(odds(send, n))}]` : ''}`).join('; ')}`);
        parts.push(`enemy armies adjacent ${threat}`);
      }
      if (own.length) parts.push(`yours nearby ${own.map((n) => `#${n}(${T[n].armies})`).join(' ')}`);
      out.push(parts.join(' | '));
    }

    out.push('', 'ENEMY CASTLES  (capture one to eliminate its owner)');
    for (const p of view.players.filter((x) => x.alive && x.seat !== me)) {
      const c = T[p.castle];
      const near = c.adjacent.filter((n) => T[n].owner === me);
      out.push(`${tag(c.id)} of ${p.name}: ${c.armies} armies; ${near.length ? `you border it from ${near.map((n) => `#${n}(${T[n].armies})`).join(' ')}` : 'you do not border it'}`);
    }
  }

  out.push('', 'ISLANDS  (hold every territory of an island for its bonus each round)');
  for (const region of view.regions) {
    const mine = region.territories.filter((t) => T[t].owner === me);
    const missing = region.territories.filter((t) => T[t].owner !== me);
    const held = region.heldBy === null ? '' : region.heldBy === me ? ' HELD BY YOU' : ` held by ${view.players[region.heldBy].name}`;
    const need = mine.length && missing.length && missing.length <= 3
      ? `; you need ${missing.map((t) => `${tag(t)} (${holder(t)} ${T[t].armies})`).join(', ')}` : '';
    out.push(`${region.name} +${Math.round(region.bonus * view.rules.islandBonus)}: you hold ${mine.length} of ${region.territories.length}${held}${need}`);
  }

  // ----- what just happened -----
  if (view.placements) {
    out.push('', `PLACEMENTS THIS ROUND  (already included in the army counts above)`);
    out.push(...describePlacements(view.placements, view).map((line) => `- ${line}`));
  }
  if (view.lastRound) {
    const lines = view.lastRound.events.map((e) => describeEvent(e, view));
    out.push('', `RESULTS OF ROUND ${view.lastRound.round}`);
    out.push(...(lines.length ? lines.slice(0, MAX_EVENT_LINES).map((line) => `- ${line}`) : ['- No fighting.']));
    if (lines.length > MAX_EVENT_LINES) out.push(`- (${lines.length - MAX_EVENT_LINES} more events in the JSON view)`);
  }
  return out.join('\n');
}
