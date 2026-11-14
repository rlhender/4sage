// Turns structured round events into one-line English, for the GUI, the CLI
// and for LLM players who want a quick read of what just happened.
// `view` is anything with `players[seat].name` and `territories[id].name`.

export function describeEvent(event, view) {
  const who = (seat) => (seat === null || seat === -1 ? 'Neutral' : view.players[seat].name);
  const place = (t) => view.territories[t].name;
  switch (event.type) {
    case 'clash': {
      const { a, b } = event;
      const outcome = event.winner === null
        ? 'both forces were destroyed'
        : `${who(event.winner)} won with ${Math.max(a.left, b.left)} left`;
      return `Border clash between ${place(a.from)} and ${place(b.from)}: ${who(a.seat)} ${a.armies} against ${who(b.seat)} ${b.armies}; ${outcome}.`;
    }
    case 'battle': {
      const odds = `${event.attackers} against ${event.defenders}`;
      const late = event.late ? ' (arriving as reinforcements)' : event.momentum ? ' (with momentum from the clash)' : '';
      return event.captured
        ? `${who(event.attacker)} took ${place(event.territory)} from ${who(event.defender)}${late}: ${odds}, ${event.attackersLeft} left.`
        : `${who(event.defender)} held ${place(event.territory)} against ${who(event.attacker)}${late}: ${odds}, ${event.defendersLeft} left.`;
    }
    case 'move':
      return `${who(event.seat)} moved ${event.armies} from ${place(event.from)} to ${place(event.to)}.`;
    case 'eliminated':
      return `${who(event.seat)}'s castle fell to ${who(event.by)}. ${who(event.seat)} is out.`;
    case 'gameOver': {
      const reason = { lastCastle: 'the last castle standing', domination: 'holding most of the map', roundLimit: 'the round limit', mutualElimination: 'mutual elimination' }[event.reason];
      return event.winner === null ? `The game ends in a draw (${reason}).` : `${who(event.winner)} wins by ${reason}.`;
    }
    default:
      return JSON.stringify(event);
  }
}

export function describePlacements(placements, view) {
  return placements.flatMap((list, seat) => (list ? [
    `${view.players[seat].name} placed ${list.map((p) => `${p.armies} on ${view.territories[p.territory].name}`).join(', ')}.`,
  ] : []));
}
