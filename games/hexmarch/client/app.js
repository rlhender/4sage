import { CORNERS } from '/shared/map.js';
import { CARD_NAMES, HAND_LIMIT, findSet, getMap, reachable, tradeValue } from '/shared/game.js';

const COLORS = ['#e5534b', '#4c9aff', '#3fb950', '#f0b429', '#b072e8', '#22c3bd'];
const PHASES = { reinforce: 'Reinforce', attack: 'Attack', fortify: 'Fortify' };
const HEX = 20; // hex size in SVG units
const SESSION_KEY = 'hexmarch:session';
const NAME_KEY = 'hexmarch:name';

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...kids.flat().filter((k) => k != null && k !== false));
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } },
};

// ---------- connection ----------

let ws = null;
let room = null;
let session = store.get(SESSION_KEY);
let retry = null;

function connect(hello) {
  clearTimeout(retry);
  if (ws) { ws.onclose = null; ws.close(); }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { $('#conn').hidden = true; ws.send(JSON.stringify(hello)); };
  ws.onmessage = (event) => onMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (!session) return;
    $('#conn').hidden = false;
    retry = setTimeout(() => connect({ t: 'rejoin', ...session }), 1500);
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
const act = (action) => send({ t: 'action', action });

function onMessage(msg) {
  if (msg.t === 'joined') {
    session = { code: msg.code, token: msg.token };
    store.set(SESSION_KEY, session);
    history.replaceState(null, '', `?room=${msg.code}`);
  } else if (msg.t === 'room') {
    room = msg;
    render();
  } else if (msg.t === 'error') {
    if (msg.code === 'norejoin') goHome();
    toast(msg.message);
  }
}

function goHome() {
  session = null;
  room = null;
  store.remove(SESSION_KEY);
  render();
}

let toastTimer = null;
function toast(text, ok = false) {
  const node = $('#toast');
  node.textContent = text;
  node.className = ok ? 'toast ok' : 'toast';
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

// ---------- home and lobby ----------

const inviteLink = () => `${location.origin}${location.pathname}?room=${room.code}`;

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast('Invite link copied.', true);
  } catch {
    toast(inviteLink(), true);
  }
}

function playerName() {
  const name = $('#name').value.trim() || 'Commander';
  store.set(NAME_KEY, name);
  return name;
}

$('#create').addEventListener('click', () => connect({ t: 'create', name: playerName() }));
$('#join').addEventListener('click', () => {
  const code = $('#code').value.trim().toUpperCase();
  if (code.length !== 4) { toast('Enter the four-letter room code.'); return; }
  connect({ t: 'join', code, name: playerName() });
});
$('#code').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#join').click(); });
$('#roomTag').addEventListener('click', copyInvite);
$('#leave').addEventListener('click', () => {
  if (room?.game && room.game.phase !== 'over' && !confirm('Leave the game? A bot will take over your seat.')) return;
  send({ t: 'leave' });
  goHome();
  history.replaceState(null, '', location.pathname);
});

function renderLobby() {
  const isHost = room.hostId === room.you;
  $('#lobbyCode').textContent = room.code;
  $('#lobbyPlayers').replaceChildren(...room.players.map((p, seat) => el('li', {},
    el('span', { class: 'dot', style: `background:${COLORS[seat]}` }),
    el('span', { class: 'name', text: p.name }),
    p.id === room.you && el('span', { class: 'tag', text: 'you' }),
    p.id === room.hostId && el('span', { class: 'tag', text: 'host' }),
    isHost && p.isBot && el('button', { text: 'Remove', onclick: () => send({ t: 'removeBot', id: p.id }) }),
  )));
  $('#lobbyActions').replaceChildren(...(isHost ? [
    el('button', { class: 'primary', text: 'Start game', disabled: room.players.length < 2, onclick: () => send({ t: 'start' }) }),
    el('button', { text: 'Add bot', disabled: room.players.length >= 6, onclick: () => send({ t: 'addBot' }) }),
    el('button', { text: 'Copy invite link', onclick: copyInvite }),
  ] : [
    el('span', { class: 'hint', text: 'Waiting for the host to start the game…' }),
  ]));
}

// ---------- map ----------

let map = null;
let terrEls = [];
let edgeEls = [];
let badgeEls = [];

const px = (v) => (v * HEX).toFixed(1);
const hexPath = (cells) => cells.map(([x, y]) =>
  `M${CORNERS.map(([cx, cy]) => `${px(x + cx)},${px(y + cy)}`).join('L')}Z`).join('');

function buildMap(seed) {
  map = getMap(seed);
  const svg = $('#map');
  svg.replaceChildren();
  const all = map.territories.flatMap((t) => t.cells);
  const xs = all.map((c) => c[0]);
  const ys = all.map((c) => c[1]);
  const left = (Math.min(...xs) - 2) * HEX;
  const top = (Math.min(...ys) - 3.2) * HEX;
  const width = (Math.max(...xs) + 2) * HEX - left;
  const height = (Math.max(...ys) + 2.2) * HEX - top;
  svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);

  for (const lane of map.lanes) {
    svg.append(svgEl('line', {
      class: 'lane', x1: px(lane.from[0]), y1: px(lane.from[1]), x2: px(lane.to[0]), y2: px(lane.to[1]),
    }));
  }
  for (const region of map.regions) {
    const cells = region.territories.flatMap((t) => map.territories[t].cells);
    svg.append(svgEl('path', { class: 'shore', d: hexPath(cells) }));
  }
  terrEls = map.territories.map((t) => {
    const node = svgEl('path', { class: 'terr', d: hexPath(t.cells), 'data-t': t.id });
    node.append(svgEl('title'));
    node.addEventListener('click', () => onTerritory(t.id));
    svg.append(node);
    return node;
  });
  edgeEls = map.territories.map((t) => {
    const d = t.outline.map(([x1, y1, x2, y2]) => `M${px(x1)},${px(y1)}L${px(x2)},${px(y2)}`).join('');
    const node = svgEl('path', { class: 'edge', d, 'data-t': t.id });
    svg.append(node);
    return node;
  });
  badgeEls = map.territories.map((t) => {
    const group = svgEl('g', { class: 'badge', transform: `translate(${px(t.label[0])},${px(t.label[1])})` });
    const text = svgEl('text');
    group.append(svgEl('circle', { r: 13 }), text);
    svg.append(group);
    return text;
  });
  for (const region of map.regions) {
    const cells = region.territories.flatMap((t) => map.territories[t].cells);
    const x = cells.reduce((sum, c) => sum + c[0], 0) / cells.length;
    const y = Math.min(...cells.map((c) => c[1])) - 1.7;
    const label = svgEl('text', { class: 'region-label', x: px(x), y: px(y) });
    label.textContent = `${region.name.toUpperCase()} +${region.bonus}`;
    svg.append(label);
  }
}

// ---------- game ----------

const ui = { key: '', from: null, to: null, amount: 1, count: null, combatId: -1 };

const mySeat = () => room.players.findIndex((p) => p.id === room.you);
const myTurn = (g) => g.phase !== 'over' && g.turn === mySeat();

function hasEnemyNeighbour(g, t) {
  return map.territories[t].adj.some((n) => g.owner[n] !== g.owner[t]);
}

// Territories the current player can usefully tap right now.
function options(g) {
  const me = mySeat();
  const mine = (t) => g.owner[t] === me;
  const ids = map.territories.map((t) => t.id);
  if (!myTurn(g)) return new Set();
  if (g.phase === 'reinforce') return new Set(g.reinforcements > 0 ? ids.filter(mine) : []);
  if (g.phase === 'attack') {
    if (ui.from == null) return new Set(ids.filter((t) => mine(t) && g.armies[t] >= 2 && hasEnemyNeighbour(g, t)));
    return new Set(map.territories[ui.from].adj.filter((t) => !mine(t)));
  }
  if (ui.from == null) return new Set(ids.filter((t) => mine(t) && g.armies[t] >= 2));
  return reachable(g, ui.from);
}

function onTerritory(t) {
  const g = room?.game;
  if (!g || !myTurn(g)) return;
  const me = mySeat();
  const mine = g.owner[t] === me;
  if (g.phase === 'reinforce') {
    if (mine && g.reinforcements > 0) {
      act({ type: 'place', territory: t, count: Math.min(ui.amount, g.reinforcements) });
    }
    return;
  }
  if (t === ui.from) {
    ui.from = null;
    ui.to = null;
  } else if (ui.from != null && options(g).has(t)) {
    ui.to = t;
    ui.count = null;
  } else if (mine && g.armies[t] >= 2) {
    ui.from = t;
    ui.to = null;
  }
  render();
}

function syncSelection(g) {
  const key = `${g.round}:${g.turn}:${g.phase}`;
  if (key !== ui.key) {
    ui.key = key;
    ui.from = null;
    ui.to = null;
    ui.count = null;
  }
  const me = mySeat();
  if (ui.from != null && (g.owner[ui.from] !== me || g.armies[ui.from] < 2)) { ui.from = null; ui.to = null; }
  if (ui.to != null && g.phase === 'attack' && g.owner[ui.to] === me) ui.to = null;
}

function renderMap(g) {
  const opts = options(g);
  const picking = myTurn(g) && g.phase !== 'reinforce';
  map.territories.forEach((t) => {
    const color = COLORS[g.owner[t.id]];
    const node = terrEls[t.id];
    node.style.fill = color;
    node.style.stroke = color;
    const selected = t.id === ui.from || t.id === ui.to;
    node.classList.toggle('dim', picking && !selected && !opts.has(t.id));
    node.firstChild.textContent = `${t.name} — ${g.players[g.owner[t.id]].name}, ${g.armies[t.id]} armies`;
    badgeEls[t.id].textContent = g.armies[t.id];
    const edge = edgeEls[t.id];
    edge.setAttribute('class', `edge${selected ? ' sel' : opts.has(t.id) && picking ? ' opt' : ''}`);
    if (selected) edge.parentNode.insertBefore(edge, badgeEls[0].parentNode);
  });
}

function stepper(min, max, onChange) {
  ui.count = Math.max(min, Math.min(max, ui.count ?? max));
  const label = el('span', { class: 'count', text: ui.count });
  const range = el('input', { type: 'range', min, max, value: ui.count, 'aria-label': 'Armies to move' });
  range.addEventListener('input', () => {
    ui.count = Number(range.value);
    label.textContent = ui.count;
    onChange?.();
  });
  return [range, label];
}

function renderActions(g) {
  const bar = $('#actions');
  const me = mySeat();
  const name = (t) => map.territories[t].name;
  const prompt = (text) => el('span', { class: 'prompt', text });

  if (g.phase === 'over') {
    bar.replaceChildren(
      el('span', { class: 'prompt banner', text: `${g.players[g.winner].name} rules the archipelago.` }),
      room.hostId === room.you
        ? el('button', { class: 'primary', text: 'Play again', onclick: () => send({ t: 'rematch' }) })
        : el('span', { class: 'hint', text: 'Waiting for the host…' }),
    );
    return;
  }
  if (!myTurn(g)) {
    const text = g.players[me]?.alive === false
      ? 'You have been eliminated. You can keep watching.'
      : `Waiting for ${g.players[g.turn].name}…`;
    bar.replaceChildren(prompt(text));
    return;
  }

  if (g.phase === 'reinforce') {
    const hand = g.players[me].cards;
    const set = findSet(hand);
    const mustTrade = hand.length >= HAND_LIMIT;
    const kids = [];
    if (mustTrade) kids.push(prompt('You hold five cards and must trade a set before placing armies.'));
    else if (g.reinforcements > 0) kids.push(prompt(`Tap your territories to place ${g.reinforcements} ${g.reinforcements === 1 ? 'army' : 'armies'}.`));
    else kids.push(prompt('All armies placed. Trade your set now, or move on.'));
    if (g.reinforcements > 0 && !mustTrade) {
      for (const [label, amount] of [['+1', 1], ['+5', 5], ['All', 999]]) {
        kids.push(el('button', {
          class: ui.amount === amount ? 'on' : '', text: label, 'aria-pressed': String(ui.amount === amount),
          onclick: () => { ui.amount = amount; render(); },
        }));
      }
    }
    if (set) {
      kids.push(el('button', {
        class: 'primary', text: `Trade set (+${tradeValue(g.trades)})`, onclick: () => act({ type: 'trade', cards: set }),
      }));
    }
    if (g.reinforcements === 0 && !mustTrade) {
      kids.push(el('button', { text: 'Begin attacks', onclick: () => act({ type: 'endPhase' }) }));
    }
    bar.replaceChildren(...kids);
    return;
  }

  if (g.phase === 'attack') {
    const kids = [];
    if (g.pending) {
      const { to, max } = g.pending;
      kids.push(prompt(`${name(to)} is yours. Send in more armies?`));
      kids.push(...stepper(0, max));
      kids.push(el('button', { class: 'primary', text: 'Move', onclick: () => act({ type: 'advance', count: ui.count }) }));
    } else if (ui.from == null) {
      kids.push(prompt('Tap one of your territories to attack from.'));
    } else if (ui.to == null) {
      kids.push(prompt(`${name(ui.from)}: tap a neighbouring enemy to attack.`));
    } else {
      const attack = (blitz) => act({ type: 'attack', from: ui.from, to: ui.to, blitz });
      kids.push(prompt(`${name(ui.from)} (${g.armies[ui.from]}) → ${name(ui.to)} (${g.armies[ui.to]})`));
      kids.push(el('button', { class: 'primary', text: 'Attack', onclick: () => attack(false) }));
      kids.push(el('button', { text: 'Blitz', title: 'Keep rolling until one side breaks', onclick: () => attack(true) }));
    }
    kids.push(el('button', { class: 'ghost', text: 'End attacks', onclick: () => act({ type: 'endPhase' }) }));
    bar.replaceChildren(...kids);
    return;
  }

  const kids = [];
  if (ui.from == null) {
    kids.push(prompt('Optional: tap a territory to move armies from, or end your turn.'));
  } else if (ui.to == null) {
    kids.push(prompt(`${name(ui.from)}: tap a connected territory of yours to move to.`));
  } else {
    kids.push(prompt(`${name(ui.from)} → ${name(ui.to)}`));
    kids.push(...stepper(1, g.armies[ui.from] - 1));
    kids.push(el('button', {
      class: 'primary', text: 'Move and end turn',
      onclick: () => act({ type: 'fortify', from: ui.from, to: ui.to, count: ui.count }),
    }));
  }
  kids.push(el('button', { class: 'ghost', text: 'End turn', onclick: () => act({ type: 'endPhase' }) }));
  bar.replaceChildren(...kids);
}

function renderStatus(g) {
  const bar = $('#status');
  bar.classList.toggle('mine', myTurn(g));
  if (g.phase === 'over') {
    bar.replaceChildren(el('span', { class: 'who', text: 'Game over' }));
    return;
  }
  bar.replaceChildren(
    el('span', { class: 'dot', style: `background:${COLORS[g.turn]}` }),
    el('span', { class: 'who', text: myTurn(g) ? 'Your turn' : `${g.players[g.turn].name}'s turn` }),
    el('span', { class: 'phase', text: `Round ${g.round}` }),
    el('span', { class: 'pips' }, Object.entries(PHASES).map(([id, label]) =>
      el('span', { class: `pip${id === g.phase ? ' now' : ''}`, text: label }))),
  );
}

function renderSide(g) {
  const me = mySeat();
  $('#players').replaceChildren(...g.players.map((p, seat) => {
    const lands = g.owner.filter((o) => o === seat).length;
    const armies = g.armies.reduce((sum, n, t) => sum + (g.owner[t] === seat ? n : 0), 0);
    const info = room.players[seat];
    return el('li', { class: `${p.alive ? '' : 'out'}${g.turn === seat && g.phase !== 'over' ? ' turn' : ''}` },
      el('span', { class: 'dot', style: `background:${COLORS[seat]}` }),
      el('span', { class: 'name', text: p.name }),
      seat === me && el('span', { class: 'tag', text: 'you' }),
      !info.isBot && !info.connected && el('span', { class: 'tag', text: 'away' }),
      el('span', { class: 'stat', title: 'Territories · armies · cards', text: `${lands} ⬢ · ${armies} ● · ${p.cardCount} ▮` }),
    );
  }));

  const hand = g.players[me]?.cards ?? [];
  $('#cards').replaceChildren(...(hand.length
    ? hand.map((c) => el('span', { class: 'chip', text: CARD_NAMES[c] }))
    : [el('span', { text: 'None yet. Capture a territory on your turn to earn one.' })]));

  $('#regions').replaceChildren(...map.regions.map((region) => {
    const first = g.owner[region.territories[0]];
    const held = region.territories.every((t) => g.owner[t] === first);
    return el('li', {},
      el('span', { text: `${region.name} +${region.bonus}` }),
      el('span', { class: 'held', text: held ? g.players[first].name : '—' }),
    );
  }));

  $('#log').replaceChildren(...[...g.log].reverse().map((line) => el('li', { text: line })));

  const dice = $('#dice');
  dice.hidden = !g.combat;
  if (g.combat && g.combatId !== ui.combatId) {
    ui.combatId = g.combatId;
    const c = g.combat;
    const row = (label, rolls, seat) => el('div', { class: 'dice-row' },
      el('span', { class: 'side-name', text: label }),
      rolls.map((n) => el('span', { class: 'die', style: `background:${COLORS[seat]}`, text: n })));
    dice.replaceChildren(
      el('h3', { text: `${map.territories[c.from].name} → ${map.territories[c.to].name}` }),
      row('Attacker', c.att, c.attacker),
      row('Defender', c.def, c.defender),
      el('div', {
        class: 'dice-note',
        text: `${g.players[c.attacker].name} lost ${c.attLoss}, ${g.players[c.defender].name} lost ${c.defLoss}.${c.conquered ? ' Territory captured.' : ''}`,
      }),
    );
  }
}

function render() {
  const game = room?.game;
  $('#home').hidden = !!room;
  $('#lobby').hidden = !room || !!game;
  $('#game').hidden = !game;
  $('#leave').hidden = !room;
  $('#roomTag').hidden = !room;
  if (!room) return;
  $('#roomTag').textContent = room.code;
  if (!game) { renderLobby(); return; }
  if (!map || map.seed !== game.mapSeed) { buildMap(game.mapSeed); ui.combatId = -1; }
  syncSelection(game);
  renderStatus(game);
  renderMap(game);
  renderActions(game);
  renderSide(game);
}

// ---------- boot ----------

$('#name').value = store.get(NAME_KEY) ?? '';
const invited = new URLSearchParams(location.search).get('room')?.toUpperCase();
if (invited) $('#code').value = invited;
if (session && (!invited || invited === session.code)) connect({ t: 'rejoin', ...session });
render();
