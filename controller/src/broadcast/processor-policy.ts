// External broadcast processor (processor.*): every decision about it, pure.
// radio.liq sends the finished mix to a bridge on another machine over SRT and
// airs what comes back, falling back to the dry mix whenever the return is not
// ready (docs/external-processor.md, liquidsoap/radio.liq EXTERNAL PROCESSOR).
//
// Three questions live here and nowhere else:
//   * what a stored block repairs to on load (normalizeProcessorSettings);
//   * which saved combinations update() refuses (processorConfigIssue);
//   * how many extra seconds listeners sit behind the live edge, read from the
//     mixer's processor-status.json (processorStatus, processorLeadSeconds).
//
// The lead follows the MARKER, never the saved setting. The setting is read at
// mixer startup, so between a save and a restart it describes a mixer that is
// not running yet (#2142's rule for the buffer, applied here). And the delay is
// only real while the processed return airs: on the dry fallback listeners hear
// the mix with no processing delay at all.

import {
  PROCESSOR_DELAY_MS_BOUNDS,
  PROCESSOR_FAILOVER_MS_BOUNDS,
  PROCESSOR_HOST_RE,
  PROCESSOR_PORT_BOUNDS,
} from '../schemas/settings.js';

export interface ProcessorSettings {
  enabled: boolean;
  host: string;
  sendPort: number;
  returnPort: number;
  delayMs: number;
  /** How long the return may be missing or silent before the dry mix airs. */
  failoverMs: number;
}

export const PROCESSOR_DEFAULTS: ProcessorSettings = {
  enabled: false,
  host: '',
  sendPort: 9000,
  returnPort: 9001,
  delayMs: 0,
  failoverMs: 2000,
};

/** A marker whose heartbeat is older than this is from a mixer that stopped. */
export const PROCESSOR_MARKER_STALE_MS = 60_000;

function intIn(raw: unknown, bounds: { min: number; max: number }, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= bounds.min && raw <= bounds.max
    ? raw
    : fallback;
}

/** load()'s repair of a stored block: each field falls back to its default on
 *  its own, so one hand-edited value costs that value, not the block. */
export function normalizeProcessorSettings(stored: unknown): ProcessorSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const host = typeof s.host === 'string' && PROCESSOR_HOST_RE.test(s.host.trim()) ? s.host.trim() : '';
  return {
    enabled: s.enabled === true,
    host,
    sendPort: intIn(s.sendPort, PROCESSOR_PORT_BOUNDS, PROCESSOR_DEFAULTS.sendPort),
    returnPort: intIn(s.returnPort, PROCESSOR_PORT_BOUNDS, PROCESSOR_DEFAULTS.returnPort),
    delayMs: intIn(s.delayMs, PROCESSOR_DELAY_MS_BOUNDS, PROCESSOR_DEFAULTS.delayMs),
    failoverMs: intIn(s.failoverMs, PROCESSOR_FAILOVER_MS_BOUNDS, PROCESSOR_DEFAULTS.failoverMs),
  };
}

/** update()'s whole-block rules, judged on the MERGED block (a patch may turn
 *  processing on with a host saved earlier). Null when the block is usable.
 *  Off, anything goes: an operator may park a half-typed config. */
export function processorConfigIssue(p: ProcessorSettings): string | null {
  if (!p.enabled) return null;
  if (!p.host) return 'processor.host is required to turn the external processor on';
  if (p.sendPort === p.returnPort) return 'processor.sendPort and processor.returnPort must differ';
  return null;
}

export type ProcessorOnAir = 'processed' | 'dry';

/** Why the dry mix airs: the return stopped arriving, or it arrives silent
 *  while the dry mix is not (radio.liq PROCESSOR SILENCE CHECK). */
export type ProcessorDryReason = 'lost' | 'silent';

export interface ProcessorStatus {
  /** The running mixer built the processor stage. */
  enabled: boolean;
  /** Which side is on air; null when unknown (no marker, stale, malformed). */
  onAir: ProcessorOnAir | null;
  /** Why the dry mix airs; null while processed, or from a mixer that predates
   *  the silence check. */
  reason: ProcessorDryReason | null;
  /** The delay the running mixer was started with. */
  delayMs: number;
  /** Epoch ms the current side went on air, null when unknown. */
  since: number | null;
}

const UNKNOWN: ProcessorStatus = { enabled: false, onAir: null, reason: null, delayMs: 0, since: null };

/** Marker timestamps are liquidsoap `time()`, unix SECONDS. */
function toMs(raw: unknown): number | null {
  const ms = Number(raw) * 1000;
  return typeof raw === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** The running mixer's processor state from the parsed processor-status.json.
 *  Absent, malformed or stale reads as off: an older broadcast image writes no
 *  marker, and a mixer that died mid-run leaves its last one behind. */
export function processorStatus(marker: unknown, now: number): ProcessorStatus {
  if (!marker || typeof marker !== 'object') return UNKNOWN;
  const m = marker as Record<string, unknown>;
  if (m.enabled !== true) return { ...UNKNOWN };
  const at = toMs(m.at);
  if (at === null || now - at > PROCESSOR_MARKER_STALE_MS) return UNKNOWN;
  const onAir = m.onAir === 'processed' || m.onAir === 'dry' ? m.onAir : null;
  const reason = onAir === 'dry' && (m.reason === 'lost' || m.reason === 'silent') ? m.reason : null;
  return {
    enabled: true,
    onAir,
    reason,
    delayMs: intIn(m.delayMs, PROCESSOR_DELAY_MS_BOUNDS, 0),
    since: onAir ? toMs(m.since) : null,
  };
}

/** Extra seconds every listener sits behind the live edge because of the
 *  processor: its delay while the processed return airs, else nothing. */
export function processorLeadSeconds(status: ProcessorStatus): number {
  return status.enabled && status.onAir === 'processed' ? status.delayMs / 1000 : 0;
}
