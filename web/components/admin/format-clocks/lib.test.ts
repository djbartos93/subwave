import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORMAT_CLOCK_STEPS_MAX,
  addStep,
  copyName,
  draftIssue,
  duplicateClock,
  fmtMmSs,
  hourFitLabel,
  mintClockId,
  moveStep,
  newClockDraft,
  removeStep,
  showsUsingClock,
  stepLabel,
  updateStep,
  withClock,
  withoutClock,
  type FormatClockStep,
} from './lib';
import { FORMAT_CLOCK_ID_RE, formatClockSchema } from '@/lib/schemas.generated';

const song: FormatClockStep = { type: 'song' };
const imaging: FormatClockStep = { type: 'imaging' };
const link: FormatClockStep = { type: 'break', kind: 'link' };

test('mm:ss counts minutes past the hour rather than wrapping', () => {
  assert.equal(fmtMmSs(0), '00:00');
  assert.equal(fmtMmSs(65), '01:05');
  assert.equal(fmtMmSs(3600), '60:00');
  assert.equal(fmtMmSs(3725), '62:05');
  assert.equal(fmtMmSs(-4), '00:00');
  assert.equal(fmtMmSs(Number.NaN), '00:00');
});

test('the hour-fit label says short, over, or filled', () => {
  assert.equal(hourFitLabel(-300), '5:00 short of the hour');
  assert.equal(hourFitLabel(130), '2:10 over the hour');
  assert.equal(hourFitLabel(3), 'Fills the hour');
  assert.equal(hourFitLabel(-4), 'Fills the hour');
  // The live fit cap lands up to 10 s past :00 by design.
  assert.equal(hourFitLabel(10), 'Fills the hour');
  assert.equal(hourFitLabel(15), '0:15 over the hour');
});

test('add, remove and move return new arrays and respect the edges', () => {
  const steps = [song, imaging, link];
  assert.deepEqual(addStep(steps, song), [song, imaging, link, song]);
  assert.equal(steps.length, 3);
  assert.deepEqual(removeStep(steps, 1), [song, link]);
  assert.deepEqual(moveStep(steps, 1, -1), [imaging, song, link]);
  assert.deepEqual(moveStep(steps, 0, -1), steps);
  assert.deepEqual(moveStep(steps, 2, 1), steps);
  assert.deepEqual(moveStep(steps, 9, 1), steps);
});

test('add stops at the step limit', () => {
  const full = Array.from({ length: FORMAT_CLOCK_STEPS_MAX }, () => song);
  assert.equal(addStep(full, song).length, FORMAT_CLOCK_STEPS_MAX);
});

test('changing a break keeps only the fields that still apply', () => {
  let steps: FormatClockStep[] = [{ type: 'break', kind: 'segment', skill: 'news', dropIfLate: true }];
  steps = updateStep(steps, 0, { kind: 'link' });
  assert.deepEqual(steps[0], { type: 'break', kind: 'link', dropIfLate: true });
  steps = updateStep(steps, 0, { kind: 'station-id', topOfHour: true });
  // A top-of-hour ID is never dropped, so the flag goes.
  assert.deepEqual(steps[0], { type: 'break', kind: 'station-id', topOfHour: true });
  steps = updateStep(steps, 0, { kind: 'segment', skill: 'weather' });
  assert.deepEqual(steps[0], { type: 'break', kind: 'segment', skill: 'weather' });
});

test('imaging takes only drop-if-late, and a song takes nothing', () => {
  assert.deepEqual(updateStep([imaging], 0, { dropIfLate: true })[0], { type: 'imaging', dropIfLate: true });
  assert.deepEqual(updateStep([{ type: 'imaging', dropIfLate: true }], 0, { dropIfLate: false })[0], imaging);
  assert.deepEqual(updateStep([song], 0, { dropIfLate: true })[0], song);
});

test('a new clock draft is valid once named, and its id fits the shared pattern', () => {
  const draft = newClockDraft(mintClockId());
  assert.match(draft.id, FORMAT_CLOCK_ID_RE);
  assert.ok(draftIssue(draft), 'blank name is refused');
  assert.equal(draftIssue({ ...draft, name: 'Morning' }), null);
  assert.equal(formatClockSchema.safeParse({ ...draft, name: 'Morning' }).success, true);
});

test('a draft with no song, or a segment with no skill, says why', () => {
  const base = { ...newClockDraft('fc_aaaaaa'), name: 'X' };
  assert.match(draftIssue({ ...base, steps: [link] }) ?? '', /song/);
  const issue = draftIssue({ ...base, steps: [song, { type: 'break', kind: 'segment' }] });
  assert.match(issue ?? '', /^Step 2: .*skill/);
});

test('duplicate copies the steps under a fresh id and a unique name', () => {
  const src = { ...newClockDraft('fc_aaaaaa'), name: 'Morning' };
  const copy = duplicateClock(src, 'fc_bbbbbb', ['Morning']);
  assert.equal(copy.id, 'fc_bbbbbb');
  assert.equal(copy.name, 'Morning copy');
  assert.deepEqual(copy.steps, src.steps);
  assert.notEqual(copy.steps, src.steps);
  assert.equal(copyName('Morning copy', ['Morning', 'Morning copy']), 'Morning copy 2');
  assert.ok(copyName('x'.repeat(60), []).length <= 60);
});

test('save replaces by id or appends; delete removes by id', () => {
  const a = { ...newClockDraft('fc_aaaaaa'), name: 'A' };
  const b = { ...newClockDraft('fc_bbbbbb'), name: 'B' };
  assert.deepEqual(withClock([a], b).map(c => c.id), ['fc_aaaaaa', 'fc_bbbbbb']);
  assert.equal(withClock([a, b], { ...a, name: 'A2' })[0]!.name, 'A2');
  assert.deepEqual(withoutClock([a, b], 'fc_aaaaaa').map(c => c.id), ['fc_bbbbbb']);
});

test('which shows use a clock, by name', () => {
  const shows = [
    { id: 's1', name: 'Drive', formatClockId: 'fc_a' },
    { id: 's2', name: 'Late', formatClockId: null },
    { id: 's3', name: ' ', formatClockId: 'fc_a' },
  ];
  assert.deepEqual(showsUsingClock(shows, 'fc_a'), ['Drive', 'Untitled show']);
});

test('step labels are plain', () => {
  assert.equal(stepLabel({ type: 'song' }), 'Song');
  assert.equal(stepLabel({ type: 'break', kind: 'station-id' }), 'Station ID');
  assert.equal(stepLabel({ type: 'break', kind: 'segment', skill: 'news' }), 'Segment: news');
});
