// Pure helpers for the Format clocks editor: step-list edits, the draft's
// validity, and the labels and times the projected timeline prints. No React, so
// every one of them is pinned by lib.test.ts. Limits and rules come from the
// shared schema (`@/lib/schemas.generated`), never restated here.
import {
  FORMAT_CLOCK_NAME_MAX,
  FORMAT_CLOCK_STEPS_MAX,
  FORMAT_CLOCKS_LIMIT,
  formatClockSchema,
  type FormatClock,
  type FormatClockBreakKind,
  type FormatClockFillRule,
  type FormatClockStep,
} from '@/lib/schemas.generated';

export { FORMAT_CLOCK_NAME_MAX, FORMAT_CLOCK_STEPS_MAX, FORMAT_CLOCKS_LIMIT };
export type { FormatClock, FormatClockBreakKind, FormatClockFillRule, FormatClockStep };

export const HOUR_SEC = 3600;

export const BREAK_KIND_LABELS: Record<FormatClockBreakKind, string> = {
  link: 'Link',
  'station-id': 'Station ID',
  segment: 'Segment',
};

export const FILL_RULE_LABELS: Record<FormatClockFillRule, string> = {
  songs: 'Songs only',
  loop: 'Loop the clock',
  'songs-then-break': 'Songs then a break',
};

export const FILL_RULE_HELP: Record<FormatClockFillRule, string> = {
  songs: 'If the steps run out before the hour does, play plain songs until the hour turns.',
  loop: 'If the steps run out early, start the clock over, songs and breaks included.',
  'songs-then-break': 'Play plain songs, then one link break before the song that crosses the hour.',
};

/** A draft clock as the editor holds it: the id is minted client-side. */
export type ClockDraft = FormatClock;

export function mintClockId(random: () => number = Math.random): string {
  let out = 'fc_';
  for (let i = 0; i < 6; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}

/** A starting point for a new clock: valid on its own, easy to reshape. */
export function newClockDraft(id: string): ClockDraft {
  return {
    id,
    name: '',
    steps: [
      { type: 'song' },
      { type: 'song' },
      { type: 'break', kind: 'link' },
      { type: 'song' },
      { type: 'song' },
    ],
    fillRule: 'songs',
    fitLastSong: true,
  };
}

/** "Morning" -> "Morning copy", "Morning copy" -> "Morning copy 2", cut to the name limit. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = name.replace(/ copy(?: \d+)?$/, '');
  const fit = (n: string) => n.slice(0, FORMAT_CLOCK_NAME_MAX);
  const lower = new Set(taken.map(t => t.trim().toLowerCase()));
  let candidate = fit(`${base} copy`);
  for (let n = 2; lower.has(candidate.toLowerCase()) && n < 100; n++) {
    const suffix = ` copy ${n}`;
    candidate = base.slice(0, FORMAT_CLOCK_NAME_MAX - suffix.length) + suffix;
  }
  return candidate;
}

export function duplicateClock(clock: FormatClock, id: string, taken: readonly string[]): ClockDraft {
  return {
    id,
    name: copyName(clock.name, taken),
    steps: clock.steps.map(s => ({ ...s })),
    fillRule: clock.fillRule,
    fitLastSong: clock.fitLastSong,
  };
}

// ── step list edits (each returns a new array, never mutates) ─────────────

export function canAddStep(steps: readonly FormatClockStep[]): boolean {
  return steps.length < FORMAT_CLOCK_STEPS_MAX;
}

export function addStep(steps: readonly FormatClockStep[], step: FormatClockStep): FormatClockStep[] {
  return canAddStep(steps) ? [...steps, step] : [...steps];
}

export function removeStep(steps: readonly FormatClockStep[], index: number): FormatClockStep[] {
  return steps.filter((_, i) => i !== index);
}

/** Swap a step with its neighbour. Out-of-range moves are a no-op. */
export function moveStep(steps: readonly FormatClockStep[], index: number, delta: -1 | 1): FormatClockStep[] {
  const to = index + delta;
  if (index < 0 || index >= steps.length || to < 0 || to >= steps.length) return [...steps];
  const next = [...steps];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export type StepPatch = { kind?: FormatClockBreakKind; skill?: string; dropIfLate?: boolean; topOfHour?: boolean };

/**
 * Edit one step. Fields that stop applying are cleared with the change that
 * ended them, so the draft stays in the shape the schema saves: a segment's
 * skill goes when the kind changes, and a top-of-hour ID is never dropped.
 */
export function updateStep(steps: readonly FormatClockStep[], index: number, patch: StepPatch): FormatClockStep[] {
  return steps.map((step, i) => {
    if (i !== index) return step;
    if (step.type === 'song') return step;
    if (step.type === 'imaging') {
      return patch.dropIfLate ? { type: 'imaging', dropIfLate: true } : { type: 'imaging' };
    }
    const kind = patch.kind ?? step.kind;
    const out: Extract<FormatClockStep, { type: 'break' }> = { type: 'break', kind };
    if (kind === 'segment') {
      const skill = patch.skill !== undefined ? patch.skill : step.skill;
      if (skill) out.skill = skill;
    }
    const topOfHour = kind === 'station-id'
      && (patch.topOfHour !== undefined ? patch.topOfHour : step.topOfHour === true);
    if (topOfHour) out.topOfHour = true;
    else {
      const dropIfLate = patch.dropIfLate !== undefined ? patch.dropIfLate : step.dropIfLate === true;
      if (dropIfLate) out.dropIfLate = true;
    }
    return out;
  });
}

export function songCount(steps: readonly FormatClockStep[]): number {
  return steps.filter(s => s.type === 'song').length;
}

/** A short plain description of a step for lists and the timeline. */
export function stepLabel(step: { type: FormatClockStep['type']; kind?: FormatClockBreakKind; skill?: string }): string {
  if (step.type === 'song') return 'Song';
  if (step.type === 'imaging') return 'Imaging';
  const kind = step.kind ? BREAK_KIND_LABELS[step.kind] : 'Break';
  return step.kind === 'segment' && step.skill ? `${kind}: ${step.skill}` : kind;
}

// ── validity and dirtiness ────────────────────────────────────────────────

/** The schema's first complaint about a draft, or null when it would save. */
export function draftIssue(draft: ClockDraft): string | null {
  const parsed = formatClockSchema.safeParse(draft);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (!issue) return 'This clock is not valid.';
  // A segment's missing skill is reported with the step number.
  if (issue.path[0] === 'steps' && typeof issue.path[1] === 'number') {
    return `Step ${issue.path[1] + 1}: ${issue.message}`;
  }
  return issue.message;
}

export function sameClock(a: FormatClock, b: FormatClock): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The saved list with `draft` replacing its namesake by id, or appended. */
export function withClock(list: readonly FormatClock[], draft: FormatClock): FormatClock[] {
  const at = list.findIndex(c => c.id === draft.id);
  if (at < 0) return [...list, draft];
  return list.map((c, i) => (i === at ? draft : c));
}

export function withoutClock(list: readonly FormatClock[], id: string): FormatClock[] {
  return list.filter(c => c.id !== id);
}

/** Names of the shows pointing at a clock. */
export function showsUsingClock(shows: ReadonlyArray<{ id: string; name?: string; formatClockId?: unknown }>, clockId: string): string[] {
  return shows.filter(s => s.formatClockId === clockId).map(s => (s.name || '').trim() || 'Untitled show');
}

// ── timeline formatting ───────────────────────────────────────────────────

/** Seconds from the hour start as mm:ss. Minutes are not wrapped: 61:05 is
 *  an hour that ran over. Negatives and non-finite values read as 00:00. */
export function fmtMmSs(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Within this many seconds of 60:00 an hour reads as filled. The live fit cap
 *  aims up to 10 s past :00 on purpose (format-clock-policy.ts
 *  FIT_TOLERANCE_SEC), and the figures are estimates. */
export const HOUR_FIT_SLACK_SEC = 15;

/** "5:00 short of the hour", "2:10 over the hour" or "Fills the hour". */
export function hourFitLabel(vsHourSec: number): string {
  const abs = Math.abs(Math.round(vsHourSec));
  if (abs < HOUR_FIT_SLACK_SEC) return 'Fills the hour';
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  const t = `${m}:${String(s).padStart(2, '0')}`;
  return vsHourSec < 0 ? `${t} short of the hour` : `${t} over the hour`;
}

export const SECTION_LABELS: Record<'closer' | 'opener' | 'body' | 'fill', string> = {
  closer: 'closing the last hour',
  opener: 'opening',
  body: 'body',
  fill: 'fill',
};

export function songSourceLabel(source: string): string {
  if (source === 'show') return "the show's own tracks";
  if (source === 'library') return 'the library average';
  return 'the default';
}

export function imagingSourceLabel(source: string): string {
  return source === 'jingles' ? "the show's jingles" : 'the default';
}
