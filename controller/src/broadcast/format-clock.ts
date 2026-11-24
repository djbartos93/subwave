// Format clock: the impure glue between a show's hour template
// (schemas/format-clock.ts), the pure decision (format-clock-policy.ts) and the
// station's live state. It resolves which clock a pick airs under, gathers the
// policy's inputs (the station hour, how many songs started in it, the show's
// timing estimates), turns the decision into one seam plan, and fires the
// seam's non-link actions. The decisions themselves live in the two policy
// modules; this file only reads, assembles and calls.
//
// Position is derived at every boundary from what has aired and what is queued
// (songsStartedInHour), never stored, so a restart resumes where the hour is.
// Nothing here is public: the decision record is admin-only (/debug), and the
// public feed allowlists in util/public-feed.ts never name it.
//
// Never call a format clock a bare "clock": clock-policy.ts and the "clock
// switch" mean the spoken time check. docs/internals/broadcast.md, "Format
// clocks".
import * as settings from '../settings.js';
import { zonedParts } from '../time.js';
import type { FormatClock } from '../schemas/format-clock.js';
import {
  DEFAULT_ESTIMATES,
  decideBoundary,
  type FormatClockBoundaryInput,
  type FormatClockDecision,
  type FormatClockEstimates,
} from './format-clock-policy.js';
import {
  carryCloser,
  planSeam,
  resolveShowClock,
  showClockId,
  songsStartedInHour,
  stationHourAround,
  type SeamPlan,
  type SeamTalk,
} from './format-clock-ownership-policy.js';
import { estimateShowTiming, peekShowTiming } from '../music/show-timing.js';
import { linkAirDate } from './queue/pure.js';

const stationMinuteAt = (ms: number) => zonedParts(new Date(ms)).minute;

// ── Which clock, and who owns the talk ─────────────────────────────────────

/** The clock a (resolved) show runs, or null. */
export function clockForShow(show: { formatClockId?: unknown } | null | undefined): FormatClock | null {
  try {
    return resolveShowClock(show, settings.get()?.formatClocks as FormatClock[] | undefined);
  } catch {
    return null;
  }
}

/**
 * Whether a format clock owns the automatic talk at `now`: the show on AIR (the
 * live grid and takeover, never a steer, which leans picks without changing the
 * show) runs one. The one answer the slot table, the over-music overlay and the
 * per-skill cron timers stand down on.
 */
export function formatClockOwnsTalk(now: Date = new Date()): boolean {
  try {
    return clockForShow(settings.resolveActiveShow(now)) !== null;
  } catch {
    return false;
  }
}

// ── Gathering the policy's inputs ──────────────────────────────────────────

export interface BoundaryGathering {
  clock: FormatClock;
  /** The show the pick airs in (its id and clock id, for the closer carry). */
  show: { id?: string | null; formatClockId?: unknown; allowedJingles?: string[] } | null;
  /** The show on air during the previous station hour, or null. */
  previousShow: { id?: string | null; formatClockId?: unknown } | null;
  nowMs: number;
  /** Forecast air time of the new pick, ms. */
  boundaryMs: number;
  minuteAt: (ms: number) => number;
  /** Start instants (ms) of the on-air track and history. */
  startedMs: ReadonlyArray<number>;
  /** Forecast start instants of queued items; null = unknown. */
  queuedStartMs: ReadonlyArray<number | null>;
  estimates: FormatClockEstimates;
  minSongSec: number | null;
}

/** The policy input for one boundary. Pure: every live read arrives in `g`. */
export function buildBoundaryInput(g: BoundaryGathering): FormatClockBoundaryInput {
  const { hourStartMs, hourEndMs } = stationHourAround(g.boundaryMs, g.minuteAt);
  const previous = g.previousShow
    ? { showId: g.previousShow.id ?? null, clockId: showClockId(g.previousShow) }
    : null;
  return {
    clock: g.clock,
    hourStartMs,
    hourEndMs,
    boundaryMs: g.boundaryMs,
    songsStartedInHour: songsStartedInHour({
      hourStartMs, boundaryMs: g.boundaryMs, nowMs: g.nowMs,
      startedMs: g.startedMs, queuedStartMs: g.queuedStartMs,
    }),
    estimates: g.estimates,
    minSongSec: g.minSongSec,
    carryCloser: carryCloser(previous, { showId: g.show?.id ?? null, clockId: showClockId(g.show) }),
  };
}

// ── The seam a pick cycle plans ────────────────────────────────────────────

/** What a pick cycle needs back for a show that runs a clock. */
export interface FormatSeam {
  clock: FormatClock;
  decision: FormatClockDecision;
  plan: SeamPlan;
  /** The pick's length cap in seconds (applied by the picker), or null. */
  maxSongSec: number | null;
  /** The jingle allowlist of the show the seam airs in. */
  allowedJingles: string[];
  showId: string | null;
}

/** The compact form carried on a queue item and fired when it airs. */
export interface QueuedSeam {
  imaging: number;
  talk: SeamTalk | null;
  allowedJingles: string[];
  showId: string | null;
}

export const queuedSeam = (seam: FormatSeam): QueuedSeam | null =>
  seam.plan.imaging > 0 || seam.plan.talk
    ? { imaging: seam.plan.imaging, talk: seam.plan.talk, allowedJingles: seam.allowedJingles, showId: seam.showId }
    : null;

/** The queue surface this module reads. */
export interface FormatClockQueue {
  current?: { startedAt?: string | null } | null;
  history: Array<{ startedAt?: string | null }>;
  upcoming: unknown[];
  airForecastSec(item: any): number | null;
  log(kind: string, line: string): void;
}

/**
 * Plan the seam the pick being made now will air behind. `showAt` is the pick's
 * look-ahead date (null when the on-air clock is unknown); `finalTrackHandoff`
 * is true when a show-change handoff owns the seam. Null for a show without a
 * clock, which leaves the caller on today's link counter.
 */
export function planFormatSeam(
  queue: FormatClockQueue,
  { showAt, finalTrackHandoff }: { showAt: Date | null; finalTrackHandoff: boolean },
  now: Date = new Date(),
): FormatSeam | null {
  const nowMs = now.getTime();
  // Pick paths read the show through resolvePickShow so a steer keeps working.
  const show = settings.resolvePickShow(showAt ?? now);
  const clock = clockForShow(show);
  if (!show || !clock) return null;

  let boundaryMs = showAt ? linkAirDate(showAt).getTime() : nowMs;
  // A changeover pick resolves to the incoming show a little before the grid
  // turns; it opens the incoming show's hour, so it is judged at that :00.
  const atBoundary = settings.resolveActiveShow(new Date(boundaryMs));
  if ((atBoundary?.id ?? null) !== (show.id ?? null)) {
    boundaryMs = stationHourAround(boundaryMs, stationMinuteAt).hourEndMs;
  }
  const hour = stationHourAround(boundaryMs, stationMinuteAt);

  const timing = peekShowTiming(show);
  // Warm the cache for the next boundary: the figure is a library walk, never
  // computed on this path.
  void estimateShowTiming(show).catch(() => {});

  const startedMs = [queue.current, ...queue.history].map((e) => Date.parse(String(e?.startedAt ?? '')));
  const input = buildBoundaryInput({
    clock,
    show,
    previousShow: settings.resolveActiveShow(new Date(hour.hourStartMs - 60_000)),
    nowMs,
    boundaryMs,
    minuteAt: stationMinuteAt,
    startedMs,
    queuedStartMs: queue.upcoming.map((item) => {
      const sec = queue.airForecastSec(item);
      return sec == null ? null : nowMs + sec * 1000;
    }),
    estimates: timing?.estimates ?? DEFAULT_ESTIMATES,
    minSongSec: settings.effectiveMinTrackSec(show),
  });
  const decision = decideBoundary(input);
  const plan = planSeam(decision, { finalTrackHandoff });
  const seam: FormatSeam = {
    clock, decision, plan, maxSongSec: decision.maxSongSec,
    allowedJingles: Array.isArray(show.allowedJingles) ? show.allowedJingles : [],
    showId: show.id ?? null,
  };
  record(queue, seam, show, input);
  return seam;
}

// ── Admin visibility ───────────────────────────────────────────────────────

export interface FormatClockDecisionRecord {
  at: string;
  clockId: string;
  clockName: string;
  showId: string | null;
  showName: string | null;
  songOfHour: number;
  /** 1-based step number for display; null when the boundary sits past the body. */
  step: number | null;
  totalSteps: number;
  dropped: number;
  actions: string[];
  maxSongSec: number | null;
  note: string;
}

let lastRecord: FormatClockDecisionRecord | null = null;
let lastLogKey = '';

function record(queue: FormatClockQueue, seam: FormatSeam, show: any, input: FormatClockBoundaryInput): void {
  const d = seam.decision;
  const actions = [
    ...(seam.plan.wantLink ? ['link'] : []),
    ...Array.from({ length: seam.plan.imaging }, () => 'imaging'),
    ...(seam.plan.talk ? [seam.plan.talk.kind === 'segment' ? `segment:${seam.plan.talk.skill ?? '?'}` : 'station-id'] : []),
  ];
  const note = [d.note, ...seam.plan.notes].filter(Boolean).join('; ');
  lastRecord = {
    at: new Date().toISOString(),
    clockId: seam.clock.id,
    clockName: seam.clock.name,
    showId: show?.id ?? null,
    showName: show?.name ?? null,
    songOfHour: d.position.songOfHour,
    step: d.position.stepIndex >= 0 ? d.position.stepIndex + 1 : null,
    totalSteps: d.position.totalSteps,
    dropped: d.dropped,
    actions,
    maxSongSec: d.maxSongSec,
    note,
  };
  // One booth line per boundary: a retried pick cycle reaches the same one.
  const key = `${seam.clock.id}|${input.hourStartMs}|${d.position.songOfHour}|${note}`;
  if (key === lastLogKey) return;
  lastLogKey = key;
  const step = lastRecord.step != null ? `step ${lastRecord.step} of ${lastRecord.totalSteps}` : 'past the body';
  queue.log('scheduler', `[format-clock] "${seam.clock.name}" ${step}: ${note || 'plain song'}`);
}

/** The admin snapshot (/debug): who owns the talk now and the last decision.
 *  Never reaches util/public-feed.ts. */
export function formatClockStatus(now: Date = new Date()) {
  const show = settings.resolveActiveShow(now);
  const clock = clockForShow(show);
  return {
    owning: clock !== null,
    clock: clock ? { id: clock.id, name: clock.name } : null,
    show: show ? { id: show.id, name: show.name } : null,
    last: lastRecord,
  };
}

export function resetFormatClockState(): void {
  lastRecord = null;
  lastLogKey = '';
}

// ── Firing the seam's non-link actions ─────────────────────────────────────

/** The generators the scheduler owns, registered at start so this module (which
 *  the queue imports) never imports the scheduler (which imports the queue). */
export interface SeamRunners {
  stationId(opts: { topOfHour: boolean }): Promise<unknown>;
  segment(skill: string): Promise<unknown>;
}

let runners: SeamRunners | null = null;

export function registerSeamRunners(r: SeamRunners | null): void {
  runners = r;
}

export interface SeamQueue extends Pick<FormatClockQueue, 'log'> {
  playImagingJingle(allowedJingles: readonly string[] | undefined): Promise<boolean>;
}

/**
 * Fire a seam: imaging first, then the talk break. Imaging is a jingle drawn
 * through the rotate's own draw, handed over now and placed by the mixer at the
 * next safe boundary (the end of the track it was fired against). The talk
 * break generates now and airs at the next track boundary. Every step traps
 * its own failure: a seam that cannot air never costs the music.
 */
export async function fireSeam(queue: SeamQueue, seam: QueuedSeam): Promise<void> {
  for (let i = 0; i < seam.imaging; i++) {
    try {
      await queue.playImagingJingle(seam.allowedJingles);
    } catch (err) {
      queue.log('error', `[format-clock] imaging failed: ${(err as Error).message}`);
    }
  }
  const talk = seam.talk;
  if (!talk) return;
  if (!runners) {
    queue.log('scheduler', `[format-clock] ${talk.kind} skipped, the scheduler is not running`);
    return;
  }
  try {
    if (talk.kind === 'station-id') await runners.stationId({ topOfHour: talk.topOfHour === true });
    else if (talk.skill) await runners.segment(talk.skill);
    else queue.log('scheduler', '[format-clock] segment skipped, the step names no skill');
  } catch (err) {
    queue.log('error', `[format-clock] ${talk.kind} failed: ${(err as Error).message}`);
  }
}
