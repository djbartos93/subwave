// The format clock's ownership and seam policy (broadcast/format-clock-ownership-policy.ts):
// which rows stand down, the station hour a boundary falls in, how many songs
// started in it, when the previous hour's closer is carried, and how a decision
// folds into one seam. Pure, so no settings or state. Run: `npm test -- format-clock-ownership`.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORMAT_CLOCK_STANDS_DOWN_ROWS, anyShowHasFormatClock, capSelectionMax, carryCloser, formatClockStandsDown,
  overlayStandsDownForClock, planSeam, resolveShowClock, showClockId, skillCronStandsDownForClock,
  songsStartedInHour, stationHourAround,
} from '../src/broadcast/format-clock-ownership-policy.js';
import { jingleRotateOwner, mixerJingleRatioFile } from '../src/broadcast/jingle-rotate.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);
const minuteAtOffset = (offsetMin: number) => (ms: number) => ((Math.floor(ms / MIN) + offsetMin) % 60 + 60) % 60;

test('every automatic slot row stands down for a clock, and nothing else does', () => {
  assert.deepEqual([...FORMAT_CLOCK_STANDS_DOWN_ROWS].sort(),
    ['banter', 'hourly', 'jingle', 'programme', 'segment', 'station-id']);
  for (const kind of FORMAT_CLOCK_STANDS_DOWN_ROWS) {
    assert.equal(formatClockStandsDown(kind, true), true, kind);
    assert.equal(formatClockStandsDown(kind, false), false, `${kind} without a clock`);
  }
  assert.equal(formatClockStandsDown('something-new', true), false);
  assert.equal(overlayStandsDownForClock(true), true);
  assert.equal(overlayStandsDownForClock(false), false);
  assert.equal(skillCronStandsDownForClock(true), true);
  assert.equal(skillCronStandsDownForClock(false), false);
});

test('a show runs a clock only when it names one that exists', () => {
  const clocks = [{ id: 'fc_one' }];
  assert.equal(showClockId({ formatClockId: 'fc_one' }), 'fc_one');
  for (const bad of [undefined, null, '', 5, {}]) assert.equal(showClockId({ formatClockId: bad }), null);
  assert.equal(resolveShowClock({ formatClockId: 'fc_one' }, clocks), clocks[0]);
  assert.equal(resolveShowClock({ formatClockId: 'fc_gone' }, clocks), null);
  assert.equal(resolveShowClock({ formatClockId: 'fc_one' }, undefined), null);
  assert.equal(anyShowHasFormatClock({ shows: [{ formatClockId: 'fc_one' }], formatClocks: clocks }), true);
  assert.equal(anyShowHasFormatClock({ shows: [{ formatClockId: 'fc_gone' }], formatClocks: clocks }), false);
  assert.equal(anyShowHasFormatClock({ shows: [{}], formatClocks: clocks }), false);
  assert.equal(anyShowHasFormatClock(null), false);
  assert.equal(anyShowHasFormatClock({}), false);
});

test('the jingle rotate is controller-owned while any show runs a clock, and only then', () => {
  const clocks = [{ id: 'fc_one' }];
  const withClock = { jingleRatio: 4, shows: [{ id: 'a' }, { id: 'b', formatClockId: 'fc_one' }], formatClocks: clocks };
  assert.equal(jingleRotateOwner(withClock), 'controller');
  // The mixer's own ratio file reads 0 (its documented "off"), and the saved
  // ratio is untouched.
  assert.equal(mixerJingleRatioFile(withClock), '0');
  assert.equal(withClock.jingleRatio, 4);
  // No show with a clock, or only a dangling id: the pre-existing station.
  assert.equal(jingleRotateOwner({ jingleRatio: 4, shows: [{ id: 'a' }], formatClocks: clocks }), 'mixer');
  assert.equal(jingleRotateOwner({ jingleRatio: 4, shows: [{ formatClockId: 'fc_gone' }], formatClocks: clocks }), 'mixer');
  assert.equal(jingleRotateOwner({ jingleRatio: 4 }), 'mixer');
  assert.equal(mixerJingleRatioFile({ jingleRatio: 4 }), '4');
  // The explicit opt-in still wins without a clock.
  assert.equal(jingleRotateOwner({ jingleRotate: 'controller' }), 'controller');
});

test('the station hour is found on the station clock, whole-hour and half-hour zones alike', () => {
  const utc = stationHourAround(T0 + 10 * MIN, minuteAtOffset(0));
  assert.deepEqual(utc, { hourStartMs: T0, hourEndMs: T0 + HOUR });
  // An instant exactly on :00 belongs to the hour it opens.
  assert.deepEqual(stationHourAround(T0, minuteAtOffset(0)), { hourStartMs: T0, hourEndMs: T0 + HOUR });
  // +5:30: the station's :00 falls at UTC :30.
  const ist = stationHourAround(T0 + 10 * MIN, minuteAtOffset(30));
  assert.deepEqual(ist, { hourStartMs: T0 - 30 * MIN, hourEndMs: T0 + 30 * MIN });
  // +5:45 (Nepal).
  const npt = stationHourAround(T0 + 50 * MIN, minuteAtOffset(45));
  assert.deepEqual(npt, { hourStartMs: T0 + 15 * MIN, hourEndMs: T0 + 75 * MIN });
});

test('songs started in the hour count across the seam: aired, on air and queued, never the previous hour', () => {
  const hourStartMs = T0;
  const boundaryMs = T0 + 20 * MIN;
  const n = songsStartedInHour({
    hourStartMs, boundaryMs, nowMs: T0 + 12 * MIN,
    // 08:57 belongs to the previous hour; 09:02 and 09:07 count.
    startedMs: [T0 + 7 * MIN, T0 + 2 * MIN, T0 - 3 * MIN, NaN],
    // A queued item forecast at 09:12 counts; one with no forecast counts at
    // now; one past the boundary does not.
    queuedStartMs: [T0 + 12 * MIN, null, T0 + 25 * MIN],
  });
  assert.equal(n, 4);
  // A pick at the very top of the hour has started nothing in it yet.
  assert.equal(songsStartedInHour({
    hourStartMs, boundaryMs: T0 + 2 * MIN, nowMs: T0 + MIN, startedMs: [T0 - 4 * MIN], queuedStartMs: [],
  }), 0);
});

test('the closer is carried only from the same show running the same clock', () => {
  const cur = { showId: 'morning', clockId: 'fc_a' };
  assert.equal(carryCloser({ showId: 'morning', clockId: 'fc_a' }, cur), true);
  assert.equal(carryCloser({ showId: 'night', clockId: 'fc_a' }, cur), false, 'a different show');
  assert.equal(carryCloser({ showId: 'morning', clockId: 'fc_b' }, cur), false, 'a different clock');
  assert.equal(carryCloser({ showId: 'morning', clockId: null }, cur), false, 'no clock before');
  assert.equal(carryCloser(null, cur), false, 'nothing before');
  assert.equal(carryCloser({ showId: 'morning', clockId: 'fc_a' }, { showId: 'morning', clockId: null }), false);
});

test('a seam carries one talker: a break takes it from the link, a second break is dropped', () => {
  const link = { type: 'break', kind: 'link' } as const;
  const id = { type: 'break', kind: 'station-id', topOfHour: true } as const;
  const seg = { type: 'break', kind: 'segment', skill: 'weather' } as const;
  const img = { type: 'imaging' } as const;

  assert.deepEqual(planSeam({ actions: [] }, { finalTrackHandoff: false }), { wantLink: false, imaging: 0, talk: null, notes: [] });
  assert.equal(planSeam({ actions: [link] }, { finalTrackHandoff: false }).wantLink, true);
  const withId = planSeam({ actions: [img, id, link] }, { finalTrackHandoff: false });
  assert.equal(withId.wantLink, false);
  assert.equal(withId.imaging, 1);
  assert.deepEqual(withId.talk, { kind: 'station-id', topOfHour: true });
  assert.ok(withId.notes.some((n) => /link stands down/.test(n)));
  const two = planSeam({ actions: [seg, id] }, { finalTrackHandoff: false });
  assert.deepEqual(two.talk, { kind: 'segment', skill: 'weather' });
  assert.ok(two.notes.some((n) => /dropped 1/.test(n)));
});

test('a show-change handoff owns the seam: no link and no break, imaging survives', () => {
  const plan = planSeam({
    actions: [{ type: 'imaging' }, { type: 'break', kind: 'link' }, { type: 'break', kind: 'station-id' }],
  }, { finalTrackHandoff: true });
  assert.equal(plan.wantLink, false);
  assert.equal(plan.talk, null);
  assert.equal(plan.imaging, 1);
  assert.ok(plan.notes.some((n) => /handoff owns/.test(n)));
  // Nothing to stand down: no note.
  assert.deepEqual(planSeam({ actions: [{ type: 'imaging' }] }, { finalTrackHandoff: true }).notes, []);
});

test('the fit cap only ever tightens the station selection ceiling', () => {
  assert.equal(capSelectionMax(null, null), null);
  assert.equal(capSelectionMax(600, null), 600);
  assert.equal(capSelectionMax(null, 240), 240);
  assert.equal(capSelectionMax(600, 240), 240);
  assert.equal(capSelectionMax(200, 240), 200);
  assert.equal(capSelectionMax(600, 0), 600);
  assert.equal(capSelectionMax(600, undefined), 600);
});
