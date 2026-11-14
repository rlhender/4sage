// Deterministic archipelago generator. The same seed yields the same map in
// Node and in the browser, so the server only ever sends the seed.

export const COLS = 30;
export const ROWS = 23;

const SQ3 = Math.sqrt(3);

// Pointy-top hexes. Edge d runs from corner d to corner d+1 and faces DIRS[d].
export const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
export const CORNERS = [
  [SQ3 / 2, -0.5], [SQ3 / 2, 0.5], [0, 1], [-SQ3 / 2, 0.5], [-SQ3 / 2, -0.5], [0, -1],
];

const REGION_DEFS = [
  { name: 'Frostmere', col: 5, row: 4, count: 5,
    names: ['Skarn', 'Hollowfen', 'Whitecairn', 'Vintermouth', 'Eldrun', 'Icewatch'] },
  { name: 'Ashen Reach', col: 15, row: 4, count: 6,
    names: ['Cinderholt', 'Emberwick', 'Sootfall', 'Kilnmoor', 'Blackmarrow', 'Charstead'] },
  { name: 'Verdant Coil', col: 25, row: 4, count: 7,
    names: ['Mossgate', 'Thornwick', 'Fernhollow', 'Greenmantle', 'Briarford', 'Oakhaven', 'Willowmere'] },
  { name: 'Sunspire', col: 5, row: 17, count: 6,
    names: ['Goldmere', 'Dawnwatch', 'Amberfield', 'Solace', 'Brightwater', 'Highsun'] },
  { name: 'Stormcradle', col: 15, row: 17, count: 7,
    names: ['Galehead', 'Thunderby', 'Squallport', 'Rainmoor', 'Tempest Rock', 'Mistral', 'Greywave'] },
  { name: 'Duskmarch', col: 25, row: 17, count: 5,
    names: ['Nightfen', 'Gloamstead', 'Ravenmoor', 'Umberdeep', 'Shadewell', 'Murkholm'] },
];

const LANE_MAX = 5.5; // longest optional sea lane, in hex units
const LANES_PER_REGION = 3;

export function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toAxial = (col, row) => [col - ((row - (row & 1)) >> 1), row];
const toOffset = (q, r) => [q + ((r - (r & 1)) >> 1), r];

// Grid topology is the same for every seed, so build it once.
const N = COLS * ROWS;
const POS = [];
const NB_DIR = []; // neighbour index per direction, -1 when off the grid
for (let i = 0; i < N; i++) {
  const [q, r] = toAxial(i % COLS, Math.floor(i / COLS));
  POS.push([SQ3 * (q + r / 2), 1.5 * r]);
  NB_DIR.push(DIRS.map(([dq, dr]) => {
    const [c, w] = toOffset(q + dq, r + dr);
    return c < 0 || c >= COLS || w < 0 || w >= ROWS ? -1 : w * COLS + c;
  }));
}
const NB = NB_DIR.map((list) => list.filter((n) => n >= 0));
const dist = (i, j) => {
  const dx = POS[i][0] - POS[j][0];
  const dy = POS[i][1] - POS[j][1];
  return Math.sqrt(dx * dx + dy * dy);
};

// Where each island sits. 'centre' swaps the two smallest islands into the
// middle column, where they have more neighbours.
const LAYOUTS = { corners: [0, 1, 2, 3, 4, 5], centre: [1, 0, 2, 3, 5, 4] };
// Map positions in order round the edge: top row left to right, then bottom row right to left.
const RING = [0, 1, 2, 5, 4, 3];

// Identifies a map shape; two maps with the same seed and key are identical.
export const shapeKey = (shape = {}) => `${shape.smallIslands ?? 'centre'}:${shape.islandSizes ?? 'varied'}:${shape.seaLanes ?? 'ring'}`;

export function generateMap(seed, shape = {}) {
  const layout = LAYOUTS[shape.smallIslands] ?? LAYOUTS.centre;
  const spot = (ri) => REGION_DEFS[layout[ri]];
  // Islands of 5, 6 and 7 territories, or six of each when sizes are equal.
  const size = (ri) => (shape.islandSizes === 'equal' ? 6 : REGION_DEFS[ri].count);
  const rand = rng32(seed);
  const rint = (a, b) => a + Math.floor(rand() * (b - a + 1));

  // 1. Grow one island per region, always leaving open water between islands.
  const regionOf = new Array(N).fill(-1);
  const islands = REGION_DEFS.map((def, ri) => {
    const center = (spot(ri).row + rint(-1, 1)) * COLS + spot(ri).col + rint(-1, 1);
    regionOf[center] = ri;
    return { center, cells: [center], target: size(ri) * rint(7, 9), done: false };
  });
  for (let growing = true; growing;) {
    growing = false;
    islands.forEach((isle, ri) => {
      if (isle.done) return;
      if (isle.cells.length >= isle.target) { isle.done = true; return; }
      let best = -1;
      let bestScore = Infinity;
      const seen = new Set();
      for (const c of isle.cells) {
        for (const n of NB[c]) {
          if (regionOf[n] !== -1 || seen.has(n)) continue;
          seen.add(n);
          const col = n % COLS;
          const row = Math.floor(n / COLS);
          if (col < 1 || col > COLS - 2 || row < 1 || row > ROWS - 2) continue;
          if (NB[n].some((m) => regionOf[m] !== -1 && regionOf[m] !== ri)) continue;
          const score = dist(n, isle.center) + rand() * 1.8;
          if (score < bestScore) { bestScore = score; best = n; }
        }
      }
      if (best < 0) { isle.done = true; return; }
      regionOf[best] = ri;
      isle.cells.push(best);
      growing = true;
    });
  }

  // 2. Split each island into contiguous territories.
  const terrOf = new Array(N).fill(-1);
  const terrs = [];
  islands.forEach((isle, ri) => {
    const def = REGION_DEFS[ri];
    const seeds = [isle.cells[Math.floor(rand() * isle.cells.length)]];
    while (seeds.length < size(ri)) {
      let best = -1;
      let bestD = -1;
      for (const c of isle.cells) {
        const d = Math.min(...seeds.map((s) => dist(c, s)));
        if (d > bestD) { bestD = d; best = c; }
      }
      seeds.push(best);
    }
    const base = terrs.length;
    seeds.forEach((s, i) => {
      terrOf[s] = base + i;
      terrs.push({ id: base + i, name: def.names[i], region: ri, seed: s, cells: [s] });
    });
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < size(ri); i++) {
        const t = terrs[base + i];
        let best = -1;
        let bestD = Infinity;
        for (const c of t.cells) {
          for (const n of NB[c]) {
            if (regionOf[n] !== ri || terrOf[n] !== -1) continue;
            const d = dist(n, t.seed);
            if (d < bestD) { bestD = d; best = n; }
          }
        }
        if (best >= 0) { terrOf[best] = t.id; t.cells.push(best); grew = true; }
      }
    }
  });

  // 3. Land borders.
  const adj = terrs.map(() => new Set());
  for (let i = 0; i < N; i++) {
    if (terrOf[i] < 0) continue;
    for (const n of NB[i]) {
      if (terrOf[n] >= 0 && terrOf[n] !== terrOf[i]) adj[terrOf[i]].add(terrOf[n]);
    }
  }

  // 4. Sea lanes: a spanning tree over the islands, plus short extra crossings.
  const crossings = [];
  for (let a = 0; a < islands.length; a++) {
    for (let b = a + 1; b < islands.length; b++) {
      let best = null;
      for (const i of islands[a].cells) {
        for (const j of islands[b].cells) {
          const d = dist(i, j);
          if (!best || d < best.d) best = { a, b, i, j, d };
        }
      }
      crossings.push(best);
    }
  }
  crossings.sort((x, y) => x.d - y.d);
  const lanes = [];
  const laneCount = islands.map(() => 0);
  const addLane = (c) => {
    const ta = terrOf[c.i];
    const tb = terrOf[c.j];
    adj[ta].add(tb);
    adj[tb].add(ta);
    laneCount[c.a]++;
    laneCount[c.b]++;
    lanes.push({ a: ta, b: tb, from: POS[c.i], to: POS[c.j] });
  };
  if (shape.seaLanes === 'nearest') {
    // A spanning tree over the islands plus short extra crossings. Leaves
    // islands with one way in, which the balance lab found to be unfair.
    const group = islands.map((_, i) => i);
    const find = (x) => (group[x] === x ? x : (group[x] = find(group[x])));
    const spare = [];
    for (const c of crossings) {
      if (find(c.a) !== find(c.b)) { group[find(c.a)] = find(c.b); addLane(c); } else spare.push(c);
    }
    for (const c of spare) {
      if (c.d <= LANE_MAX && laneCount[c.a] < LANES_PER_REGION && laneCount[c.b] < LANES_PER_REGION) addLane(c);
    }
  } else {
    // A ring: every island is joined to the next one round the edge of the
    // map, so each has exactly two ways in.
    const at = (position) => layout.indexOf(position);
    RING.forEach((position, k) => {
      const [a, b] = [at(position), at(RING[(k + 1) % RING.length])].sort((x, y) => x - y);
      addLane(crossings.find((c) => c.a === a && c.b === b));
    });
  }

  // 5. Geometry for the client, in hex-size units.
  const territories = terrs.map((t) => {
    const cx = t.cells.reduce((s, c) => s + POS[c][0], 0) / t.cells.length;
    const cy = t.cells.reduce((s, c) => s + POS[c][1], 0) / t.cells.length;
    let label = t.cells[0];
    let labelD = Infinity;
    for (const c of t.cells) {
      const d = (POS[c][0] - cx) ** 2 + (POS[c][1] - cy) ** 2;
      if (d < labelD) { labelD = d; label = c; }
    }
    const outline = [];
    for (const c of t.cells) {
      NB_DIR[c].forEach((n, d) => {
        if (n >= 0 && terrOf[n] === t.id) return;
        const [x, y] = POS[c];
        const p = CORNERS[d];
        const q = CORNERS[(d + 1) % 6];
        outline.push([x + p[0], y + p[1], x + q[0], y + q[1]]);
      });
    }
    return {
      id: t.id,
      name: t.name,
      region: t.region,
      cells: t.cells.map((c) => POS[c]),
      label: POS[label],
      outline,
      adj: [...adj[t.id]].sort((x, y) => x - y),
    };
  });

  const regions = REGION_DEFS.map((def, ri) => ({
    id: ri,
    name: def.name,
    bonus: size(ri) - 2,
    territories: territories.filter((t) => t.region === ri).map((t) => t.id),
  }));

  return { seed, layout: shapeKey(shape), territories, regions, lanes };
}
