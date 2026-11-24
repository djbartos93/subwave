// Format clock policy: what the DJ should do at the next song boundary, given a
// per-show hour template (schemas/format-clock.ts). Pure: inputs in, decision
// out, no clock, no settings, no I/O. The live engine passes forecast numbers;
// the editor's preview passes estimates. Position is DERIVED from how many
// songs started in the hour, never stored, so a restart resumes correctly.
//
// Terms. A clock's steps split into the OPENER (non-song steps before the first
// song), the BODY (first song step to last song step) and the CLOSER (non-song
// steps after the last song). The decision is made at a BOUNDARY, the seam
// before a new song, and its time is the seam's start: the actions it returns
// air in that seam, so their estimated length is charged against the hour
// here, not in the caller's forecast.
//
// Never call this a bare "clock": clock-policy.ts and the "clock switch" mean
// the spoken time check.
import type { FormatClock, FormatClockBreakKind, FormatClockStep } from '../schemas/format-clock.js';

// Spec estimates. The song and imaging figures are replaced by the show's own
// (music/show-timing.ts); these are what is left when nothing is measurable.
export const DEFAULT_AVG_SONG_SEC = 210;
export const LINK_BREAK_SEC = 20;
export const STATION_ID_BREAK_SEC = 12;
export const SEGMENT_BREAK_SEC = 60;
export const DEFAULT_IMAGING_SEC = 8;
// Fit-last-song: a song is "the last that should start" inside this many
// average songs of :00; the cap carries a small tolerance, and below the
// floor the normal fill or overrun applies instead.
export const FIT_TRIGGER_FACTOR = 1.5;
export const FIT_TOLERANCE_SEC = 10;
export const FIT_MIN_SEC = 90;

export interface FormatClockEstimates {
  avgSongSec: number;
  linkSec: number;
  stationIdSec: number;
  segmentSec: number;
  imagingSec: number;
}

export const DEFAULT_ESTIMATES: FormatClockEstimates = {
  avgSongSec: DEFAULT_AVG_SONG_SEC,
  linkSec: LINK_BREAK_SEC,
  stationIdSec: STATION_ID_BREAK_SEC,
  segmentSec: SEGMENT_BREAK_SEC,
  imagingSec: DEFAULT_IMAGING_SEC,
};

export type FormatClockShape = Pick<FormatClock, 'steps' | 'fillRule' | 'fitLastSong'>;

export type FormatClockAction =
  | { type: 'imaging' }
  | { type: 'break'; kind: FormatClockBreakKind; skill?: string; topOfHour?: boolean };

export interface FormatClockDecision {
  /** Imaging first, then talk: the fixed seam order. */
  actions: FormatClockAction[];
  /** Cap, in seconds, for the song about to be picked; null = no cap. */
  maxSongSec: number | null;
  position: { songOfHour: number; stepIndex: number; totalSteps: number };
  /** Steps shed from THIS boundary's actions because the hour is running late. */
  dropped: number;
  note: string;
}

export interface FormatClockBoundaryInput {
  clock: FormatClockShape;
  /** Station hour start of the boundary, ms. Only labels the note. */
  hourStartMs: number;
  /** Forecast air time of the seam, ms. */
  boundaryMs: number;
  /** The hour's end (the next station :00), ms. */
  hourEndMs: number;
  /** Songs that START in the boundary's hour before this boundary (aired plus
   *  already queued with forecast starts). */
  songsStartedInHour: number;
  estimates: FormatClockEstimates;
  /** The show's minimum track length floor, seconds, for the fit cap. */
  minSongSec?: number | null;
  /** False when the previous hour was not this clock's (the first hour after a
   *  show change, a restart into a new show): the closer is not carried. */
  carryCloser?: boolean;
}

/** Estimated seconds a step takes on air. */
export function stepSeconds(step: FormatClockStep, est: FormatClockEstimates): number {
  if (step.type === 'song') return est.avgSongSec;
  if (step.type === 'imaging') return est.imagingSec;
  if (step.kind === 'station-id') return est.stationIdSec;
  if (step.kind === 'segment') return est.segmentSec;
  return est.linkSec;
}

const isSong = (s: FormatClockStep) => s.type === 'song';

// A step that can be shed when the hour runs late. A top-of-hour ID never is.
function droppable(step: FormatClockStep): boolean {
  if (step.type === 'imaging') return step.dropIfLate === true;
  if (step.type === 'break') return step.dropIfLate === true && !(step.kind === 'station-id' && step.topOfHour === true);
  return false;
}

interface Layout {
  songIdx: number[];
  opener: FormatClockStep[];
  closer: FormatClockStep[];
}

function layoutOf(steps: readonly FormatClockStep[]): Layout {
  const songIdx: number[] = [];
  steps.forEach((s, i) => { if (isSong(s)) songIdx.push(i); });
  if (!songIdx.length) return { songIdx, opener: [], closer: [] };
  return {
    songIdx,
    opener: steps.slice(0, songIdx[0]),
    closer: steps.slice(songIdx[songIdx.length - 1] + 1),
  };
}

function toAction(step: FormatClockStep): FormatClockAction | null {
  if (step.type === 'song') return null;
  if (step.type === 'imaging') return { type: 'imaging' };
  const a: FormatClockAction = { type: 'break', kind: step.kind };
  if (step.skill) a.skill = step.skill;
  if (step.topOfHour) a.topOfHour = true;
  return a;
}

// Imaging first, then talk; each group keeps its clock order.
function seamOrder(actions: FormatClockAction[]): FormatClockAction[] {
  return [...actions.filter((a) => a.type === 'imaging'), ...actions.filter((a) => a.type !== 'imaging')];
}

const secs = (ms: number) => ms / 1000;

export interface BoundaryPlan extends FormatClockDecision {
  /** The steps shed from this boundary (projectHour marks them). */
  droppedSteps: FormatClockStep[];
  /** The steps this boundary aired, in clock order, before the seam ordering. */
  keptSteps: FormatClockStep[];
}

export function planBoundary(input: FormatClockBoundaryInput): BoundaryPlan {
  const { clock, estimates: est } = input;
  const steps = clock.steps;
  const { songIdx, opener, closer } = layoutOf(steps);
  const total = steps.length;
  const S = songIdx.length;
  const N = Math.max(0, Math.floor(input.songsStartedInHour)) + 1;
  const timeLeft = Math.max(0, secs(input.hourEndMs - input.boundaryMs));

  const empty = (note: string): BoundaryPlan => ({
    actions: [], maxSongSec: null, position: { songOfHour: N, stepIndex: -1, totalSteps: total },
    dropped: 0, note, droppedSteps: [], keptSteps: [],
  });
  if (!S) return empty('no song step in the format clock');

  // Which body song this boundary starts (1-based, k) and whether it is a wrap.
  const inBody = N <= S;
  const k = inBody ? N : clock.fillRule === 'loop' ? ((N - 1) % S) + 1 : 0;

  // Rule 1 and 2: the steps that air in this seam.
  let seam: FormatClockStep[] = [];
  if (N === 1) {
    seam = [...(input.carryCloser === false ? [] : closer), ...opener];
  } else if (k >= 2) {
    seam = steps.slice(songIdx[k - 2] + 1, songIdx[k - 1]);
  }

  // Rule 3: the remaining body from here, against the time left. Only a
  // boundary that is still inside the body (or a loop's cycle) has one.
  const droppedSteps: FormatClockStep[] = [];
  let futureShed = 0;
  let keptSeam = seam;
  if (k >= 1) {
    const future = steps.slice(songIdx[k - 1] + 1, songIdx[S - 1] + 1);
    const remaining = (list: readonly FormatClockStep[]) => list.reduce((t, s) => t + stepSeconds(s, est), 0);
    // [seam..., this song, future...] as one list, so "latest first" spans it.
    const timeline: Array<{ step: FormatClockStep; where: 'seam' | 'future' | 'song' }> = [
      ...seam.map((step) => ({ step, where: 'seam' as const })),
      { step: steps[songIdx[k - 1]], where: 'song' as const },
      ...future.map((step) => ({ step, where: 'future' as const })),
    ];
    const need = () => remaining(timeline.map((t) => t.step));
    while (need() > timeLeft) {
      let at = -1;
      for (let i = timeline.length - 1; i >= 0; i--) {
        if (timeline[i].where !== 'song' && droppable(timeline[i].step)) { at = i; break; }
      }
      if (at < 0) break;
      const [gone] = timeline.splice(at, 1);
      if (gone.where === 'seam') droppedSteps.push(gone.step); else futureShed++;
    }
    keptSeam = timeline.filter((t) => t.where === 'seam').map((t) => t.step);
  }

  const actions = seamOrder(keptSeam.map(toAction).filter((a): a is FormatClockAction => a != null));
  const seamSec = keptSeam.reduce((t, s) => t + stepSeconds(s, est), 0);

  // Rule 4: fit the song that ends the hour.
  let maxSongSec: number | null = null;
  let fitted = false;
  if (clock.fitLastSong) {
    const lastBodySong = inBody && N === S;
    if (lastBodySong || timeLeft < FIT_TRIGGER_FACTOR * est.avgSongSec) {
      // A top-of-hour ID is meant to air AT :00, so only the other closer
      // steps are made room for before it.
      const closerSec = closer.filter((s) => !(s.type === 'break' && s.topOfHour === true))
        .reduce((t, s) => t + stepSeconds(s, est), 0);
      const cap = Math.floor(timeLeft - seamSec - closerSec + FIT_TOLERANCE_SEC);
      const floor = Math.max(FIT_MIN_SEC, input.minSongSec && input.minSongSec > 0 ? input.minSongSec : 0);
      if (cap >= floor) { maxSongSec = cap; fitted = true; }
    }
  }

  // Rule 5: a short hour. songs-then-break: one link at the boundary whose song
  // will cross :00.
  const shortHour = !inBody && clock.fillRule !== 'loop';
  let fillLink = false;
  const planActions = [...actions];
  if (shortHour && clock.fillRule === 'songs-then-break' && timeLeft < est.avgSongSec && timeLeft > 0) {
    planActions.push({ type: 'break', kind: 'link' });
    fillLink = true;
  }

  const stepIndex = k >= 1 ? songIdx[k - 1] : -1;
  const offsetMin = Math.max(0, Math.round(secs(input.boundaryMs - input.hourStartMs) / 60));
  const parts = [`song ${N} at +${offsetMin}m`];
  if (planActions.length) parts.push(planActions.map((a) => (a.type === 'imaging' ? 'imaging' : a.kind)).join(', '));
  if (droppedSteps.length || futureShed) parts.push(`late: dropped ${droppedSteps.length} here, ${futureShed} ahead`);
  if (fitted) parts.push(`fit cap ${maxSongSec}s`);
  if (shortHour) parts.push(`short hour (${clock.fillRule})`);
  if (fillLink) parts.push('fill link');

  return {
    actions: planActions,
    maxSongSec,
    position: { songOfHour: N, stepIndex, totalSteps: total },
    dropped: droppedSteps.length,
    note: parts.join('; '),
    droppedSteps,
    keptSteps: keptSeam,
  };
}

/** The decision at one boundary. See the header for the rules. */
export function decideBoundary(input: FormatClockBoundaryInput): FormatClockDecision {
  const { droppedSteps: _d, keptSteps: _k, ...decision } = planBoundary(input);
  return decision;
}

// ── projectHour ─────────────────────────────────────────────────────────────

export interface ProjectedStep {
  type: 'song' | 'imaging' | 'break';
  kind?: FormatClockBreakKind;
  skill?: string;
  /** Where it sits: the previous hour's closer, the opener, the body, or fill. */
  section: 'closer' | 'opener' | 'body' | 'fill';
  /** Index of the clock step this came from; null for a fill song. */
  stepIndex: number | null;
  startSec: number;
  durationSec: number;
  /** Shed because the hour runs late. It occupies no time. */
  dropped: boolean;
}

export interface HourProjection {
  steps: ProjectedStep[];
  /** Estimated end of the last step, in seconds from the hour's start. */
  totalSec: number;
  /** totalSec minus 3600: negative = short, positive = overrun. */
  vsHourSec: number;
  songs: number;
  note: string;
}

const HOUR_SEC = 3600;

/**
 * The editor's preview: one steady-state hour, simulated through the same
 * boundary rules the live engine runs. It opens at the seam with the previous
 * hour's closer and this hour's opener, then follows the body, then the fill
 * rule until the hour turns.
 */
export function projectHour(
  clock: FormatClockShape,
  estimates: FormatClockEstimates = DEFAULT_ESTIMATES,
  opts: { minSongSec?: number | null } = {},
): HourProjection {
  const steps = clock.steps;
  const { songIdx, opener, closer } = layoutOf(steps);
  const out: ProjectedStep[] = [];
  if (!songIdx.length) return { steps: out, totalSec: 0, vsHourSec: -HOUR_SEC, songs: 0, note: 'no song step' };

  const hourStartMs = 0;
  const hourEndMs = HOUR_SEC * 1000;
  let at = 0;
  let songs = 0;
  for (let guard = 0; guard < 400 && at < HOUR_SEC; guard++) {
    const plan = planBoundary({
      clock, hourStartMs, hourEndMs, boundaryMs: at * 1000, songsStartedInHour: songs, estimates,
      minSongSec: opts.minSongSec ?? null,
    });
    const N = songs + 1;
    const inBody = N <= songIdx.length;
    const k = plan.position.stepIndex >= 0 ? songIdx.indexOf(plan.position.stepIndex) + 1 : 0;

    // The seam's steps in clock order, so a dropped one shows where it was.
    const seamSteps: Array<{ step: FormatClockStep; index: number | null; section: ProjectedStep['section'] }> = [];
    if (N === 1) {
      closer.forEach((s, i) => seamSteps.push({ step: s, index: songIdx[songIdx.length - 1] + 1 + i, section: 'closer' }));
      opener.forEach((s, i) => seamSteps.push({ step: s, index: i, section: 'opener' }));
    } else if (k >= 2) {
      for (let i = songIdx[k - 2] + 1; i < songIdx[k - 1]; i++) seamSteps.push({ step: steps[i], index: i, section: inBody ? 'body' : 'fill' });
    }
    const shed = [...plan.droppedSteps];
    const ordered: typeof seamSteps = [];
    for (const group of [true, false]) {
      for (const s of seamSteps) if ((s.step.type === 'imaging') === group) ordered.push(s);
    }
    for (const s of ordered) {
      const idx = shed.indexOf(s.step);
      const dropped = idx >= 0;
      if (dropped) shed.splice(idx, 1);
      const durationSec = dropped ? 0 : stepSeconds(s.step, estimates);
      out.push(describe(s.step, s.section, s.index, at, durationSec, dropped));
      at += durationSec;
    }
    const fillLink = plan.actions.length > plan.keptSteps.length;
    if (fillLink) {
      out.push({ type: 'break', kind: 'link', section: 'fill', stepIndex: null, startSec: at, durationSec: estimates.linkSec, dropped: false });
      at += estimates.linkSec;
    }
    if (at >= HOUR_SEC) break;
    const songSec = plan.maxSongSec != null ? Math.min(estimates.avgSongSec, plan.maxSongSec) : estimates.avgSongSec;
    out.push({
      type: 'song', section: inBody ? 'body' : 'fill', stepIndex: plan.position.stepIndex >= 0 ? plan.position.stepIndex : null,
      startSec: at, durationSec: songSec, dropped: false,
    });
    at += songSec;
    songs++;
  }
  const totalSec = Math.round(at);
  return {
    steps: out.map((s) => ({ ...s, startSec: Math.round(s.startSec), durationSec: Math.round(s.durationSec) })),
    totalSec,
    vsHourSec: totalSec - HOUR_SEC,
    songs,
    // The fit cap lands up to FIT_TOLERANCE_SEC past :00 on purpose, so that
    // much over still fills the hour.
    note: totalSec > HOUR_SEC + FIT_TOLERANCE_SEC ? 'overruns the hour'
      : totalSec < HOUR_SEC - FIT_TOLERANCE_SEC ? 'ends short of the hour' : 'fills the hour',
  };
}

function describe(
  step: FormatClockStep, section: ProjectedStep['section'], index: number | null,
  startSec: number, durationSec: number, dropped: boolean,
): ProjectedStep {
  const base: ProjectedStep = { type: step.type, section, stepIndex: index, startSec, durationSec, dropped };
  if (step.type === 'break') {
    base.kind = step.kind;
    if (step.skill) base.skill = step.skill;
  }
  return base;
}
