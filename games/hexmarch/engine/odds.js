// Exact odds for fights to the death, for anyone (human, bot or LLM) who
// wants to reason about expected outcomes before committing armies.

const MAX = 120; // table size; larger fights are scaled down to fit

// Chance of each (lossA, lossB) when A rolls nA dice against B's nB dice.
// In a battle ties cost the attacker; in a border clash they cost both sides.
function rollOutcomes(nA, nB, clash) {
  const tally = new Map();
  const dice = new Array(nA + nB).fill(1);
  const total = 6 ** dice.length;
  for (let n = 0; n < total; n++) {
    let v = n;
    for (let i = 0; i < dice.length; i++) { dice[i] = 1 + (v % 6); v = Math.floor(v / 6); }
    const a = dice.slice(0, nA).sort((x, y) => y - x);
    const b = dice.slice(nA).sort((x, y) => y - x);
    let lossA = 0;
    let lossB = 0;
    for (let i = 0; i < Math.min(nA, nB); i++) {
      if (a[i] > b[i]) lossB++;
      else if (a[i] < b[i] || !clash) lossA++;
      else { lossA++; lossB++; }
    }
    const key = lossA * 4 + lossB;
    tally.set(key, (tally.get(key) ?? 0) + 1 / total);
  }
  return [...tally].map(([key, p]) => ({ lossA: key >> 2, lossB: key & 3, p }));
}

// table[a][b] = [P(A wins), P(B wins), expected A left, expected B left]
function buildTable(diceA, diceB, clash) {
  const outcomes = {};
  const table = [];
  for (let a = 0; a <= MAX; a++) {
    table.push([]);
    for (let b = 0; b <= MAX; b++) {
      if (a === 0 || b === 0) { table[a].push([a > 0 ? 1 : 0, b > 0 ? 1 : 0, a, b]); continue; }
      const nA = Math.min(diceA, a);
      const nB = Math.min(diceB, b);
      const cell = [0, 0, 0, 0];
      for (const o of (outcomes[nA * 4 + nB] ??= rollOutcomes(nA, nB, clash))) {
        const next = table[a - o.lossA][b - o.lossB];
        for (let i = 0; i < 4; i++) cell[i] += o.p * next[i];
      }
      table[a].push(cell);
    }
  }
  return table;
}

let battleTable = null;
let clashTable = null;

function lookup(table, a, b) {
  const scale = Math.max(1, Math.max(a, b) / MAX);
  const index = (n) => (n > 0 ? Math.min(MAX, Math.max(1, Math.round(n / scale))) : 0);
  const cell = table[index(a)][index(b)];
  return [cell[0], cell[1], cell[2] * scale, cell[3] * scale];
}

// An attacking force (up to 3 dice) against a garrison (up to 2 dice, wins ties).
export function captureOdds(attackers, defenders) {
  const [win, , attackersLeft, defendersLeft] = lookup(battleTable ??= buildTable(3, 2, false), attackers, defenders);
  return { win, attackersLeft, defendersLeft };
}

// Two attacking forces meeting on a border (up to 3 dice each, ties cost both).
export function clashOdds(a, b) {
  const [aWins, bWins, aLeft, bLeft] = lookup(clashTable ??= buildTable(3, 3, true), a, b);
  return { aWins, bWins, bothDestroyed: Math.max(0, 1 - aWins - bWins), aLeft, bLeft };
}
