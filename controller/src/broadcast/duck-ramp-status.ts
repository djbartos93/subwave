// Reads radio.liq's duck-ramps.json: the IO shell around duck-ramp-policy.ts,
// which owns every decision about it.

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import {
  leadinMsFor,
  runningDuckRamps,
  tailMsFor,
  type DuckRamps,
} from './duck-ramp-policy.js';

// A 2s memo, as in stream-mounts.ts: speech budgets ask on every clip, and the
// file changes only when the mixer restarts.
const MEMO_MS = 2_000;
let memo: { at: number; value: DuckRamps } | null = null;

/** The ramps the running mixer loaded. */
export function currentDuckRamps(now: number = Date.now()): DuckRamps {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(config.liquidsoap.duckRampsFile, 'utf8'));
  } catch {
    // Absent is normal on a broadcast image that predates the marker.
    parsed = null;
  }
  const value = runningDuckRamps(parsed);
  memo = { at: now, value };
  return value;
}

/** The silent lead-in ahead of a clip, as the running mixer airs it. */
export function voiceLeadinMs(now: number = Date.now()): number {
  return leadinMsFor(currentDuckRamps(now));
}

/** The duck's release plus slack after a clip, as the running mixer airs it. */
export function voiceTailMs(now: number = Date.now()): number {
  return tailMsFor(currentDuckRamps(now));
}
