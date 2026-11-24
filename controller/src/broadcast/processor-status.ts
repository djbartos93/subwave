// Reads radio.liq's processor-status.json. The IO shell around
// processor-policy.ts, which owns every decision about it.

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { processorStatus, type ProcessorStatus } from './processor-policy.js';

export type { ProcessorStatus };

// A 2s memo, as in music-starve.ts: /now-playing is every listener's 5s poll.
const MEMO_MS = 2_000;
let memo: { at: number; value: ProcessorStatus } | null = null;

/** The running mixer's external-processor state. */
export function currentProcessorStatus(now: number = Date.now()): ProcessorStatus {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(config.liquidsoap.processorStatusFile, 'utf8'));
  } catch {
    // Absent is normal on a broadcast image that predates the marker.
    parsed = null;
  }
  const value = processorStatus(parsed, now);
  memo = { at: now, value };
  return value;
}
