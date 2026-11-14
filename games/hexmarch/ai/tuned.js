// The "tuned" strategy is whatever the last `tune` run saved. It is loaded on
// demand by the CLI and the server, which keeps strategies.js free of file access.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRESETS } from './strategies.js';

export const TUNED_FILE = fileURLToPath(new URL('./tuned.json', import.meta.url));

export function loadTuned() {
  if (!existsSync(TUNED_FILE)) return false;
  PRESETS.tuned = JSON.parse(readFileSync(TUNED_FILE, 'utf8')).weights;
  return true;
}
