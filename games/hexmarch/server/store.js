// Keeps rooms on disk so a restart does not end every game, and files each
// finished game as a replayable record for later analysis.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VERSION, exportRecord } from '../engine/engine.js';

const SAVE_DELAY_MS = 250;

export function createStore(dir) {
  const roomsDir = path.join(dir, 'rooms');
  const recordsDir = path.join(dir, 'records');
  mkdirSync(roomsDir, { recursive: true });
  mkdirSync(recordsDir, { recursive: true });
  const fileFor = (code) => path.join(roomsDir, `${code}.json`);
  const pending = new Map();
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const [code, snapshot] of pending) {
      // Write beside the target and rename, so a crash never leaves half a file.
      const tmp = `${fileFor(code)}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot));
      renameSync(tmp, fileFor(code));
    }
    pending.clear();
  }

  return {
    flush,
    // Saves are batched: a busy room is written at most a few times a second.
    save(snapshot) {
      pending.set(snapshot.code, snapshot);
      if (!timer) { timer = setTimeout(flush, SAVE_DELAY_MS); timer.unref(); }
    },
    remove(code) {
      pending.delete(code);
      rmSync(fileFor(code), { force: true });
    },
    record(room) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const seats = room.players.map((p) => ({ name: p.name, kind: p.kind, strategy: p.strategy }));
      writeFileSync(path.join(recordsDir, `${stamp}-${room.code}.json`), JSON.stringify({ ...exportRecord(room.game), seats }));
    },
    // Saved rooms, skipping anything unreadable or from an incompatible version.
    load() {
      return readdirSync(roomsDir).filter((f) => f.endsWith('.json')).flatMap((f) => {
        try {
          const saved = JSON.parse(readFileSync(path.join(roomsDir, f), 'utf8'));
          const usable = saved.code && Array.isArray(saved.players) && saved.options
            && (!saved.game || (saved.game.version === VERSION && saved.game.config?.rules));
          return usable ? [saved] : [];
        } catch {
          return [];
        }
      });
    },
  };
}

// New games use a map the balance lab has judged fair, when a list exists.
const VETTED = fileURLToPath(new URL('../balance/maps.json', import.meta.url));
let vetted;
export function pickVettedMap() {
  if (vetted === undefined) {
    try { vetted = existsSync(VETTED) ? JSON.parse(readFileSync(VETTED, 'utf8')).fair : []; } catch { vetted = []; }
  }
  return vetted.length ? vetted[randomInt(vetted.length)] : randomInt(2 ** 31);
}
