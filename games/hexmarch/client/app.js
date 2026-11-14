// Browser client. It knows nothing about the rules: it draws the view the
// server sends, collects placements and orders, and sends them back as the
// same JSON any other kind of player would submit.

import { CORNERS, generateMap, shapeKey } from '/engine/map.js';
import { captureOdds } from '/engine/odds.js';
import { describeEvent, describePlacements } from '/engine/report.js';

const COLORS = ['#e5534b', '#4c9aff', '#3fb950', '#f0b429', '#b072e8', '#22c3bd'];
const NEUTRAL_COLOR = '#5d6b7a';
const STRATEGIES = ['balanced', 'aggressive', 'fortress', 'passive', 'tuned'];
const TIME_LIMITS = [[60, '1 minute a phase'], [180, '3 minutes a phase'], [600, '10 minutes a phase'], [1800, '30 minutes a phase'], [0, 'No time limit']];
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

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
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
let deadline = null; // local clock time at which the current phase closes
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

function onMessage(msg) {
  if (msg.t === 'joined') {
    session = { code: msg.code, token: msg.token };
    store.set(SESSION_KEY, session);
    history.replaceState(null, '', `?room=${msg.code}`);
  } else if (msg.t === 'room') {
    room = msg;
    deadline = msg.msLeft == null ? null : Date.now() + msg.msLeft;
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
  toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
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
  if (room?.game && !room.game.result && !confirm('Leave the game? A bot will take over your seat.')) return;
  send({ t: 'leave' });
  goHome();
  history.replaceState(null, '', location.pathname);
});

let botStrategy = 'balanced';

function renderLobby() {
  const isHost = room.hostId === room.you;
  $('#lobbyCode').textContent = room.code;
  $('#lobbyPlayers').replaceChildren(...room.players.map((p, seat) => el('li', { style: 'flex-wrap:nowrap' },
    el('span', { class: 'dot', style: `background:${COLORS[seat]}` }),
    el('span', { class: 'name', text: p.name }),
    p.id === room.you && el('span', { class: 'tag', text: 'you' }),
    p.id === room.hostId && el('span', { class: 'tag', text: 'host' }),
    p.kind === 'agent' && el('span', { class: 'tag', text: 'AI' }),
    isHost && p.id !== room.you && el('button', { text: 'Remove', onclick: () => send({ t: 'remove', id: p.id }) }),
  )));
  if (!isHost) {
    $('#lobbyActions').replaceChildren(el('span', { class: 'hint', text: 'Waiting for the host to start the game…' }));
    return;
  }
  const pick = el('select', { 'aria-label': 'Bot strategy', onchange: (e) => { botStrategy = e.target.value; } },
    STRATEGIES.map((s) => el('option', { value: s, selected: s === botStrategy, text: `${s} bot` })));
  $('#lobbyActions').replaceChildren(
    el('button', { class: 'primary', text: 'Start game', disabled: room.players.length < 2, onclick: () => send({ t: 'start' }) }),
    pick,
    el('button', { text: 'Add bot', disabled: room.players.length >= 6, onclick: () => send({ t: 'addBot', strategy: botStrategy }) }),
    el('button', { text: 'Copy invite link', onclick: copyInvite }),
    el('select', { 'aria-label': 'Time limit for each phase', onchange: (e) => send({ t: 'options', phaseSeconds: Number(e.target.value) }) },
      TIME_LIMITS.map(([seconds, text]) => el('option', { value: seconds, selected: seconds === room.options.phaseSeconds, text }))),
  );
}

// ---------- map ----------

let map = null;
let terrEls = [];
let edgeEls = [];
let badgeEls = [];
let arrowLayer = null;

const px = (v) => (v * HEX).toFixed(1);
const hexPath = (cells) => cells.map(([x, y]) =>
  `M${CORNERS.map(([cx, cy]) => `${px(x + cx)},${px(y + cy)}`).join('L')}Z`).join('');

function buildMap(game) {
  map = generateMap(game.mapSeed, game.rules);
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
  arrowLayer = svgEl('g');
  svg.append(arrowLayer);
  badgeEls = map.territories.map((t) => {
    const group = svgEl('g', { class: 'badge', transform: `translate(${px(t.label[0])},${px(t.label[1])})` });
    group.append(svgEl('circle', { r: 13 }), svgEl('text', { class: 'n' }), svgEl('text', { class: 'keep', y: -21 }, '♜'));
    svg.append(group);
    return group;
  });
  for (const region of map.regions) {
    const cells = region.territories.flatMap((t) => map.territories[t].cells);
    const x = cells.reduce((sum, c) => sum + c[0], 0) / cells.length;
    const y = Math.min(...cells.map((c) => c[1])) - 1.7;
    svg.append(svgEl('text', { class: 'region-label', x: px(x), y: px(y) }, `${region.name.toUpperCase()} +${game.regions[region.id].bonus}`));
  }
}

function drawArrows(orders, g) {
  arrowLayer.replaceChildren();
  for (const o of orders) {
    const [x1, y1] = map.territories[o.from].label.map((v) => v * HEX);
    const [x2, y2] = map.territories[o.to].label.map((v) => v * HEX);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const sx = x1 + ux * 15;
    const sy = y1 + uy * 15;
    const ex = x2 - ux * 22;
    const ey = y2 - uy * 22;
    const move = g.territories[o.to].owner === g.you;
    arrowLayer.append(
      svgEl('line', { class: `arrow${move ? ' move' : ''}`, x1: sx, y1: sy, x2: ex, y2: ey }),
      svgEl('path', {
        class: 'arrow-head',
        d: `M${ex + ux * 8},${ey + uy * 8}L${ex - uy * 6},${ey + ux * 6}L${ex + uy * 6},${ey - ux * 6}Z`,
      }),
      svgEl('text', { class: 'arrow-n', x: (sx + ex) / 2, y: (sy + ey) / 2 }, o.armies),
    );
  }
}

// ---------- game ----------

// Drafts live only in the browser until the player seals them.
const ui = { key: '', placing: new Map(), amount: 1, orders: [], from: null, to: null, count: null };

const sum = (values) => [...values].reduce((a, b) => a + b, 0);
const playing = (g) => !g.result && g.players[g.you].alive;
const sealed = (g) => g.submitted !== null;
const drafting = (g) => playing(g) && !sealed(g);
const shownOrders = (g) => (g.phase !== 'orders' || !playing(g) ? [] : sealed(g) ? g.submitted : ui.orders);

// Armies in a territory that have no draft order yet.
const available = (g, t) => g.territories[t].armies - 1 - sum(ui.orders.filter((o) => o.from === t).map((o) => o.armies));

function onTerritory(t) {
  const g = room?.game;
  if (!g || !drafting(g)) return;
  const terr = g.territories[t];
  if (g.phase === 'place') {
    const left = g.income - sum(ui.placing.values());
    if (terr.owner === g.you && left > 0) ui.placing.set(t, (ui.placing.get(t) ?? 0) + Math.min(ui.amount, left));
  } else if (t === ui.from) {
    ui.from = null;
    ui.to = null;
  } else if (ui.from != null && g.territories[ui.from].adjacent.includes(t)) {
    ui.to = t;
    ui.count = null;
  } else if (terr.owner === g.you && available(g, t) > 0) {
    ui.from = t;
    ui.to = null;
  }
  render();
}

function syncDrafts(g) {
  const key = `${g.mapSeed}:${g.round}:${g.phase}`;
  if (key === ui.key) return;
  ui.key = key;
  ui.placing = new Map();
  ui.orders = [];
  ui.from = null;
  ui.to = null;
  ui.count = null;
}

function renderMap(g) {
  const picking = drafting(g) && g.phase === 'orders';
  const options = new Set();
  if (picking && ui.from == null) g.territories.forEach((t) => { if (t.owner === g.you && available(g, t.id) > 0) options.add(t.id); });
  if (picking && ui.from != null) g.territories[ui.from].adjacent.forEach((t) => options.add(t));

  g.territories.forEach((t) => {
    const color = t.owner === null ? NEUTRAL_COLOR : COLORS[t.owner];
    const node = terrEls[t.id];
    node.style.fill = color;
    node.style.stroke = color;
    const selected = picking && (t.id === ui.from || t.id === ui.to);
    node.classList.toggle('dim', picking && ui.from != null && !selected && !options.has(t.id));
    const holder = t.owner === null ? 'neutral' : g.players[t.owner].name;
    const keep = t.castleOf !== undefined ? `, ${g.players[t.castleOf].name}'s castle` : '';
    node.firstChild.textContent = `${t.name} — ${holder}, ${t.armies} armies${keep}`;

    const draft = g.phase === 'place' && drafting(g) ? ui.placing.get(t.id) ?? 0 : 0;
    const badge = badgeEls[t.id];
    badge.setAttribute('class', `badge${t.castleOf !== undefined ? ' castle' : ''}${draft ? ' boost' : ''}`);
    badge.children[1].textContent = t.armies + draft;
    badge.children[2].style.display = t.castleOf !== undefined ? '' : 'none';

    const edge = edgeEls[t.id];
    edge.setAttribute('class', `edge${selected ? ' sel' : options.has(t.id) ? ' opt' : ''}`);
    if (selected) edge.parentNode.insertBefore(edge, arrowLayer);
  });
  drawArrows(shownOrders(g), g);
}

function stepper(min, max, onChange) {
  ui.count = Math.max(min, Math.min(max, ui.count ?? max));
  const label = el('span', { class: 'count', text: ui.count });
  const range = el('input', { type: 'range', min, max, value: ui.count, 'aria-label': 'Armies to send' });
  range.addEventListener('input', () => {
    ui.count = Number(range.value);
    label.textContent = ui.count;
    onChange();
  });
  return [range, label];
}

function renderActions(g) {
  const bar = $('#actions');
  const name = (t) => g.territories[t].name;
  const prompt = (text) => el('span', { class: 'prompt', text });

  if (g.result) {
    const text = g.result.winner === null ? 'The game is a draw.' : `${g.players[g.result.winner].name} wins.`;
    bar.replaceChildren(
      el('span', { class: 'prompt banner', text }),
      room.hostId === room.you
        ? el('button', { class: 'primary', text: 'Play again', onclick: () => send({ t: 'rematch' }) })
        : el('span', { class: 'hint', text: 'Waiting for the host…' }),
    );
    return;
  }
  if (!playing(g)) {
    bar.replaceChildren(prompt('Your castle has fallen. You can keep watching.'));
    return;
  }
  if (sealed(g)) {
    const waiting = g.players.filter((p) => p.alive && !p.ready).map((p) => p.name);
    bar.replaceChildren(
      prompt(`${g.phase === 'place' ? 'Placement' : 'Orders'} sealed. Waiting for ${waiting.join(', ') || 'the round to resolve'}…`),
      el('button', {
        text: 'Change',
        onclick: () => {
          if (g.phase === 'place') ui.placing = new Map(g.submitted.map((p) => [p.territory, p.armies]));
          else ui.orders = g.submitted.map((o) => ({ ...o }));
          send({ t: 'retract' });
        },
      }),
    );
    return;
  }

  if (g.phase === 'place') {
    const left = g.income - sum(ui.placing.values());
    const placements = [...ui.placing].map(([territory, armies]) => ({ territory, armies }));
    bar.replaceChildren(
      prompt(left > 0
        ? `Tap your territories to place ${left} more ${left === 1 ? 'army' : 'armies'}. Placements are revealed once everyone has sealed.`
        : 'All armies placed. Seal your placement.'),
      ...[['+1', 1], ['+5', 5], ['All', 999]].map(([text, amount]) => el('button', {
        class: ui.amount === amount ? 'on' : '', text, 'aria-pressed': String(ui.amount === amount),
        onclick: () => { ui.amount = amount; render(); },
      })),
      el('button', { class: 'ghost', text: 'Reset', disabled: ui.placing.size === 0, onclick: () => { ui.placing = new Map(); render(); } }),
      el('button', { class: 'primary', text: 'Seal placement', disabled: left > 0, onclick: () => send({ t: 'submit', submission: { placements } }) }),
    );
    return;
  }

  const kids = [];
  if (ui.from != null && ui.to != null) {
    const target = g.territories[ui.to];
    const attack = target.owner !== g.you;
    const odds = el('span', { class: 'odds' });
    const showOdds = () => {
      odds.textContent = attack
        ? `${Math.round(captureOdds(ui.count, target.armies, g.rules, target.castleOf === target.owner).win * 100)}% to capture as it stands`
        : 'Reinforcement';
    };
    kids.push(prompt(`${name(ui.from)} → ${name(ui.to)}`), ...stepper(1, available(g, ui.from), showOdds), odds);
    showOdds();
    kids.push(el('button', {
      class: 'primary', text: 'Add order',
      onclick: () => {
        const same = ui.orders.find((o) => o.from === ui.from && o.to === ui.to);
        if (same) same.armies += ui.count; else ui.orders.push({ from: ui.from, to: ui.to, armies: ui.count });
        ui.from = null;
        ui.to = null;
        ui.count = null;
        render();
      },
    }));
  } else {
    kids.push(prompt(ui.from == null
      ? 'Tap one of your territories, then a neighbour, to order an attack or a move. Orders stay secret until everyone has sealed.'
      : `${name(ui.from)}: tap a neighbouring territory.`));
  }
  kids.push(el('button', {
    class: ui.from == null ? 'primary' : '',
    text: ui.orders.length ? `Seal ${ui.orders.length} order${ui.orders.length === 1 ? '' : 's'}` : 'Hold position',
    onclick: () => send({ t: 'submit', submission: { orders: ui.orders } }),
  }));
  if (ui.orders.length) {
    kids.push(el('div', { class: 'chips' }, ui.orders.map((o, i) => el('button', {
      class: 'chip', title: 'Remove this order', text: `${name(o.from)} → ${name(o.to)} ×${o.armies}  ✕`,
      onclick: () => { ui.orders.splice(i, 1); render(); },
    }))));
  }
  bar.replaceChildren(...kids);
}

function renderStatus(g) {
  const bar = $('#status');
  bar.classList.toggle('mine', drafting(g));
  if (g.result) {
    bar.replaceChildren(el('span', { class: 'who', text: `Game over after round ${g.result.round}` }));
    return;
  }
  const alive = g.players.filter((p) => p.alive);
  bar.replaceChildren(
    el('span', { class: 'who', text: `Round ${g.round} of ${g.maxRounds}` }),
    el('span', { class: 'pips' }, [['place', 'Place armies'], ['orders', 'Give orders']].map(([id, label]) =>
      el('span', { class: `pip${id === g.phase ? ' now' : ''}`, text: label }))),
    el('span', { class: 'phase', text: `${alive.filter((p) => p.ready).length}/${alive.length} sealed` }),
    el('span', { class: 'timer', id: 'timer' }),
  );
  tick();
}

function tick() {
  const node = $('#timer');
  if (!node) return;
  if (deadline == null) { node.textContent = ''; return; }
  const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  node.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(tick, 1000);

function renderSide(g) {
  $('#players').replaceChildren(...g.players.map((p) => {
    const info = room.players[p.seat];
    return el('li', { class: `${p.alive ? '' : 'out'}${p.alive && p.ready && !g.result ? ' ready' : ''}` },
      el('span', { class: 'dot', style: `background:${COLORS[p.seat]}` }),
      el('span', { class: 'name', text: p.name }),
      p.seat === g.you && el('span', { class: 'tag', text: 'you' }),
      info.kind === 'agent' && el('span', { class: 'tag', text: 'AI' }),
      info.kind === 'human' && !info.connected && el('span', { class: 'tag', text: 'away' }),
      el('span', { class: 'stat', text: p.alive ? `${p.territories} territories · ${p.armies} armies · +${p.income} a round` : 'castle fallen' }),
    );
  }));

  const lines = [];
  if (g.placements) lines.push(...describePlacements(g.placements, g));
  else if (g.lastRound) lines.push(...g.lastRound.events.map((e) => describeEvent(e, g)));
  $('#reportTitle').textContent = g.placements ? `Round ${g.round} placements`
    : g.lastRound ? `Round ${g.lastRound.round} results` : 'Reports';
  $('#report').replaceChildren(...(lines.length ? lines : ['Nothing to report yet.']).map((text) => el('li', { text })));

  $('#regions').replaceChildren(...g.regions.map((region) => el('li', {},
    el('span', { text: `${region.name} +${region.bonus}` }),
    el('span', { class: 'held', text: region.heldBy === null ? '—' : g.players[region.heldBy].name }),
  )));
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
  if (!map || map.seed !== game.mapSeed || map.layout !== shapeKey(game.rules)) buildMap(game);
  syncDrafts(game);
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
