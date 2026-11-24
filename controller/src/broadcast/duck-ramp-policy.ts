// Duck ramp timing (settings.duckRamp): every decision about it, pure.
//
// Each duck layer in radio.liq (voice = say.txt's heavy duck, intro = the
// talk-over link's light duck, sfx = the stinger dip) pulls the music down when
// a clip starts and brings it back up when the clip ends. Each direction is a
// range in seconds, and the mixer draws a fresh value inside it for every clip
// (radio.liq `smooth_duck`), so a min equal to its max is a fixed time. The
// defaults are the literals radio.liq shipped (`smooth_add` duration 0.8 on the
// voice layers, 0.3 on sfx), so an upgrade sounds the same.
//
// Four questions live here and nowhere else:
//   * what a stored block repairs to on load (normalizeDuckRamps);
//   * which saved combinations update() refuses (duckRampIssue);
//   * the handoff file radio.liq reads, and the silent lead-in each voice layer
//     needs (rampFileContents, leadinFileName);
//   * how long the controller budgets for the lead-in and the duck's release,
//     read from the RUNNING mixer's duck-ramps.json, never the saved setting:
//     ramps are read at mixer startup, so between a save and a restart the
//     setting describes a mixer that is not running yet.
//
// The silent lead-in is pushed ahead of every spoken clip so the duck finishes
// before the first word. smooth_add also fades the clip itself in over the same
// ramp, so the lead-in must last the longest down ramp the layer can draw: it
// is exactly that layer's downMax.

import {
  DUCK_RAMP_FIELDS,
  DUCK_RAMP_LAYERS,
  DUCK_RAMP_SEC_BOUNDS,
} from '../schemas/settings.js';

export type DuckRampLayer = (typeof DUCK_RAMP_LAYERS)[number];

export interface DuckRamp {
  downMin: number;
  downMax: number;
  upMin: number;
  upMax: number;
}

export type DuckRamps = Record<DuckRampLayer, DuckRamp>;

const fixed = (sec: number): DuckRamp => ({ downMin: sec, downMax: sec, upMin: sec, upMax: sec });

export const DUCK_RAMP_DEFAULTS: DuckRamps = {
  voice: fixed(0.8),
  intro: fixed(0.8),
  sfx: fixed(0.3),
};

// The controller's budget at the defaults: the 0.8 s lead-in, and a 700 ms
// tail that covers the 0.8 s release plus poll slack (it always has, because
// the hold starts after the handoff, not at the first sample). A longer release
// extends the tail by the difference; a shorter one never shrinks it, because
// an over-estimate only adds a little air and an under-estimate lets the next
// segment start over the music's return.
export const DEFAULT_LEADIN_MS = 800;
export const DEFAULT_TAIL_MS = 700;
const DEFAULT_RELEASE_MS = 800;

function secIn(raw: unknown, fallback: number): number {
  return typeof raw === 'number'
    && Number.isFinite(raw)
    && raw >= DUCK_RAMP_SEC_BOUNDS.min
    && raw <= DUCK_RAMP_SEC_BOUNDS.max
    ? raw
    : fallback;
}

function normalizeLayer(raw: unknown, fallback: DuckRamp): DuckRamp {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = Object.fromEntries(
    DUCK_RAMP_FIELDS.map((f) => [f, secIn(s[f], fallback[f])]),
  ) as unknown as DuckRamp;
  // A hand-edited pair the wrong way round is swapped rather than dropped: both
  // numbers were the operator's, only their order is wrong.
  if (out.downMin > out.downMax) [out.downMin, out.downMax] = [out.downMax, out.downMin];
  if (out.upMin > out.upMax) [out.upMin, out.upMax] = [out.upMax, out.upMin];
  return out;
}

/** load()'s repair of a stored block: each field falls back to its default on
 *  its own, so one hand-edited value costs that value, not the block. */
export function normalizeDuckRamps(stored: unknown): DuckRamps {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  return Object.fromEntries(
    DUCK_RAMP_LAYERS.map((layer) => [layer, normalizeLayer(s[layer], DUCK_RAMP_DEFAULTS[layer])]),
  ) as unknown as DuckRamps;
}

/** A patch merged over the current block, field by field. */
export function mergeDuckRamps(
  cur: DuckRamps,
  patch: Partial<Record<DuckRampLayer, Partial<DuckRamp>>>,
): DuckRamps {
  const next = structuredClone(cur);
  for (const layer of DUCK_RAMP_LAYERS) {
    const p = patch[layer];
    if (!p) continue;
    for (const f of DUCK_RAMP_FIELDS) {
      if (p[f] !== undefined) next[layer][f] = p[f] as number;
    }
  }
  return next;
}

/** update()'s whole-layer rule, judged on the MERGED block (a patch may move
 *  one end of a range). Null when every range is usable. */
export function duckRampIssue(ramps: DuckRamps): string | null {
  for (const layer of DUCK_RAMP_LAYERS) {
    const r = ramps[layer];
    if (r.downMin > r.downMax) return `duckRamp.${layer}.downMin must not be above duckRamp.${layer}.downMax`;
    if (r.upMin > r.upMax) return `duckRamp.${layer}.upMin must not be above duckRamp.${layer}.upMax`;
  }
  return null;
}

/** liquidsoap_duck_ramp_<layer>.txt: "downMin downMax upMin upMax". */
export function rampFileContents(r: DuckRamp): string {
  return `${r.downMin} ${r.downMax} ${r.upMin} ${r.upMax}`;
}

/** Milliseconds, rounded the way radio.liq rounds (floor of x*1000 + 0.5). */
export function rampMs(sec: number): number {
  return Math.floor(sec * 1000 + 0.5);
}

/** The silent lead-in a voice layer needs: named by its length, so the file a
 *  running mixer picked at startup is never rewritten under it by a save. */
export function leadinFileName(r: DuckRamp): string {
  return `leadin-${rampMs(r.downMax)}ms.wav`;
}

/** The ramps radio.liq loaded, from its parsed duck-ramps.json. Absent or
 *  malformed (a broadcast image that predates the marker) reads as the
 *  defaults, which is what such a mixer runs. */
export function runningDuckRamps(marker: unknown): DuckRamps {
  if (!marker || typeof marker !== 'object') return structuredClone(DUCK_RAMP_DEFAULTS);
  return normalizeDuckRamps(marker);
}

/** What the controller budgets for the silent lead-in ahead of a clip: the
 *  longer of the two voice layers' down ramps, since a budget does not know
 *  which layer a clip will ride. */
export function leadinMsFor(ramps: DuckRamps): number {
  return Math.max(rampMs(ramps.voice.downMax), rampMs(ramps.intro.downMax));
}

/** The duck's release plus slack after a clip ends: the default tail, grown by
 *  however much the longest voice-layer release exceeds the default 0.8 s. */
export function tailMsFor(ramps: DuckRamps): number {
  const release = Math.max(rampMs(ramps.voice.upMax), rampMs(ramps.intro.upMax));
  return DEFAULT_TAIL_MS + Math.max(0, release - DEFAULT_RELEASE_MS);
}
