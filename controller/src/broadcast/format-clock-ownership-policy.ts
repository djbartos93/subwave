// Format clock ownership and seam policy: the decisions the live engine
// (broadcast/format-clock.ts) and its callers share, kept in one place so no
// second copy of a check exists. Pure: values in, answers out, no settings, no
// clock, no I/O. Imports only types, so settings/jingle-rotate.ts can read it
// without a cycle.
//
// Never call a format clock a bare "clock": clock-policy.ts and the "clock
// switch" mean the spoken time check.
import type { FormatClockAction, FormatClockDecision } from './format-clock-policy.js';

const MINUTE_MS = 60_000;

// ── Which show has a clock ─────────────────────────────────────────────────

/** The clock id a show names, or null (absent, '', null and non-strings). */
export function showClockId(show: { formatClockId?: unknown } | null | undefined): string | null {
  const id = show?.formatClockId;
  return typeof id === 'string' && id ? id : null;
}

/** The clock a show runs, or null when it names none or names one that no
 *  longer exists (a dangling id reads as no clock, like a deleted guest). */
export function resolveShowClock<C extends { id: string }>(
  show: { formatClockId?: unknown } | null | undefined,
  clocks: readonly C[] | null | undefined,
): C | null {
  const id = showClockId(show);
  if (!id || !Array.isArray(clocks)) return null;
  return clocks.find((c) => c?.id === id) ?? null;
}

/** Whether any saved show runs a format clock. Drives the jingle rotate's
 *  controller ownership: a mixer-owned rotate cannot be told to stand down. */
export function anyShowHasFormatClock(
  s: { shows?: unknown; formatClocks?: unknown } | null | undefined,
): boolean {
  if (!Array.isArray(s?.shows) || !Array.isArray(s?.formatClocks)) return false;
  return (s.shows as Array<{ formatClockId?: unknown }>).some((show) => resolveShowClock(show, s.formatClocks as Array<{ id: string }>) !== null);
}

// ── What stands down while a clock owns the talk ───────────────────────────

// Every automatic talker the slot table runs. The session roll and the show
// handoffs are not here: they are state, not talk, and the clock never owns
// them. Listener request intros and manual operator triggers are exempt by
// construction (neither passes the slot table's eligibility path).
export const FORMAT_CLOCK_STANDS_DOWN_ROWS: ReadonlySet<string> = new Set([
  'hourly', 'programme', 'banter', 'station-id', 'segment', 'jingle',
]);

/** The slot table's one check: does this row stand down for the clock? */
export function formatClockStandsDown(kind: string, owns: boolean): boolean {
  return owns && FORMAT_CLOCK_STANDS_DOWN_ROWS.has(kind);
}

/** The over-music jingle ID is an automatic talker outside the table. */
export function overlayStandsDownForClock(owns: boolean): boolean {
  return owns;
}

/** A per-skill `cron:` timer is the other automatic talker outside the table. */
export function skillCronStandsDownForClock(owns: boolean): boolean {
  return owns;
}

// ── The station hour a boundary falls in ───────────────────────────────────

/**
 * The station-zone hour containing `ms`: its start (the latest :00 at or
 * before) and its end (the next :00). Scanned minute by minute, not by adding
 * an hour: zones sit at :30 and :45 offsets and a DST step is not always a
 * whole hour (show-boundary.ts stationHourBoundaries, #353). `minuteAt` is the
 * station-zone minute of an instant.
 */
export function stationHourAround(ms: number, minuteAt: (ms: number) => number): { hourStartMs: number; hourEndMs: number } {
  const floor = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  let start = floor;
  for (let i = 0; i <= 125 && minuteAt(start) !== 0; i++) start -= MINUTE_MS;
  if (minuteAt(start) !== 0) start = floor - (floor % (60 * MINUTE_MS)); // unreachable for real zones
  let end = floor + MINUTE_MS;
  for (let i = 0; i <= 125 && minuteAt(end) !== 0; i++) end += MINUTE_MS;
  if (minuteAt(end) !== 0) end = start + 60 * MINUTE_MS;
  return { hourStartMs: start, hourEndMs: end };
}

// ── Songs started in the hour ──────────────────────────────────────────────

/**
 * How many songs START in `[hourStartMs, boundaryMs)`: tracks that have started
 * (the on-air one and history) plus queued ones whose forecast start falls in
 * the window. Jingles, beds and spoken clips are not songs and never reach
 * either list; requests are songs and do. A queued item with no forecast is
 * counted at `nowMs` (it precedes the boundary, so it starts before it).
 */
export function songsStartedInHour(input: {
  hourStartMs: number;
  boundaryMs: number;
  nowMs: number;
  /** Start instants (ms) of the on-air track and history. NaN entries are skipped. */
  startedMs: ReadonlyArray<number>;
  /** Forecast start instants of queued items; null = no forecast. */
  queuedStartMs: ReadonlyArray<number | null>;
}): number {
  let n = 0;
  for (const t of input.startedMs) {
    if (Number.isFinite(t) && t >= input.hourStartMs && t < input.boundaryMs) n++;
  }
  for (const f of input.queuedStartMs) {
    const t = f ?? input.nowMs;
    if (Number.isFinite(t) && t >= input.hourStartMs && t < input.boundaryMs) n++;
  }
  return n;
}

/**
 * Whether the previous hour's closer is carried into this hour's first seam:
 * only when the previous hour was the same show running the same clock. A show
 * change, a clockless predecessor or a different clock airs no closer, because
 * that hour never ran this clock's body.
 */
export function carryCloser(
  previous: { showId: string | null; clockId: string | null } | null,
  current: { showId: string | null; clockId: string | null },
): boolean {
  if (!previous || !current.clockId) return false;
  return previous.showId === current.showId && previous.clockId === current.clockId;
}

// ── The seam ───────────────────────────────────────────────────────────────

export interface SeamTalk {
  kind: 'station-id' | 'segment';
  skill?: string;
  topOfHour?: boolean;
}

export interface SeamPlan {
  /** A link rides the pick (the one talker the queue already attaches). */
  wantLink: boolean;
  /** How many imaging jingles air at this seam. */
  imaging: number;
  /** The one clock-owned talk break that is not a link, or null. */
  talk: SeamTalk | null;
  /** Why an action of the decision did not air, for the booth log. */
  notes: string[];
}

/**
 * The decision's actions as one seam. A seam carries one talker: the track's
 * own link and a deferred break contend for the same boundary (the queue holds
 * a deferred clip for the next one when the incoming track carries a link,
 * #1258), so a clock break that is not a link takes the seam and the link
 * stands down, and a second such break is dropped. A show-change handoff owns
 * the seam's talk outright (its greeting counts as the new hour's opening), so
 * only imaging survives there.
 */
export function planSeam(decision: Pick<FormatClockDecision, 'actions'>, opts: { finalTrackHandoff: boolean }): SeamPlan {
  const notes: string[] = [];
  const actions: FormatClockAction[] = decision.actions;
  const imaging = actions.filter((a) => a.type === 'imaging').length;
  const breaks = actions.filter((a): a is Extract<FormatClockAction, { type: 'break' }> => a.type === 'break');
  const links = breaks.filter((b) => b.kind === 'link');
  const others = breaks.filter((b) => b.kind !== 'link');

  if (opts.finalTrackHandoff) {
    if (breaks.length) notes.push('the show handoff owns this seam, so its breaks stand down');
    return { wantLink: false, imaging, talk: null, notes };
  }
  let talk: SeamTalk | null = null;
  if (others.length) {
    const first = others[0];
    talk = { kind: first.kind as SeamTalk['kind'] };
    if (first.skill) talk.skill = first.skill;
    if (first.topOfHour) talk.topOfHour = true;
    if (others.length > 1) notes.push(`one talker per seam: dropped ${others.length - 1} more break(s)`);
    if (links.length) notes.push('the link stands down for the break at this seam');
  }
  return { wantLink: links.length > 0 && !talk, imaging, talk, notes };
}

/** The tighter of the station's selection cap and the format clock's cap. */
export function capSelectionMax(selectionMaxSec: number | null, formatMaxSec: number | null | undefined): number | null {
  if (formatMaxSec == null || !(formatMaxSec > 0)) return selectionMaxSec;
  return selectionMaxSec == null ? formatMaxSec : Math.min(selectionMaxSec, formatMaxSec);
}
