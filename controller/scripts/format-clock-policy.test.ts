// broadcast/format-clock-policy.ts: pure decisions for a show's format clock.
// Times are seconds converted to ms; the hour runs 0..3600.
//
// Run: `npm test -- format-clock-policy`.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ESTIMATES,
  decideBoundary,
  planBoundary,
  projectHour,
  type FormatClockBoundaryInput,
  type FormatClockEstimates,
  type FormatClockShape,
} from '../src/broadcast/format-clock-policy.js';
import type { FormatClockStep } from '../src/schemas/format-clock.js';

const EST: FormatClockEstimates = { avgSongSec: 200, linkSec: 20, stationIdSec: 12, segmentSec: 60, imagingSec: 8 };
const song: FormatClockStep = { type: 'song' };
const link = (extra: object = {}): FormatClockStep => ({ type: 'break', kind: 'link', ...extra });
const imaging = (extra: object = {}): FormatClockStep => ({ type: 'imaging', ...extra });
const topId: FormatClockStep = { type: 'break', kind: 'station-id', topOfHour: true };
const clock = (steps: FormatClockStep[], over: Partial<FormatClockShape> = {}): FormatClockShape =>
  ({ steps, fillRule: 'songs', fitLastSong: false, ...over });

// A boundary `timeLeftSec` before the hour turns.
function at(c: FormatClockShape, songsStartedInHour: number, timeLeftSec: number, over: Partial<FormatClockBoundaryInput> = {}) {
  return decideBoundary({
    clock: c, hourStartMs: 0, hourEndMs: 3600_000, boundaryMs: (3600 - timeLeftSec) * 1000,
    songsStartedInHour, estimates: EST, ...over,
  });
}
const kinds = (d: ReturnType<typeof at>) => d.actions.map((a) => (a.type === 'imaging' ? 'imaging' : a.kind + (a.topOfHour ? '*' : '')));

test('the first boundary of the hour airs the previous closer, then this opener, imaging before talk', () => {
  const c = clock([topId, song, link(), song, imaging(), song, imaging(), link()]);
  const d = at(c, 0, 3600);
  // closer = [imaging, link], opener = [station-id*]; seam order puts imaging first.
  assert.deepEqual(kinds(d), ['imaging', 'link', 'station-id*']);
  assert.equal(d.position.songOfHour, 1);
  assert.equal(d.position.stepIndex, 1);
  assert.equal(d.position.totalSteps, 8);
});

test('carryCloser: false (first hour of a show) airs only the opener', () => {
  const c = clock([topId, song, song, imaging(), link()]);
  assert.deepEqual(kinds(at(c, 0, 3600, { carryCloser: false })), ['station-id*']);
  assert.deepEqual(kinds(at(c, 0, 3600)), ['imaging', 'link', 'station-id*']);
});

test('a clock with no opener or closer has nothing to say at the seam', () => {
  assert.deepEqual(at(clock([song, link(), song]), 0, 3600).actions, []);
});

test('between steps: the non-song steps between song N-1 and song N', () => {
  const c = clock([song, link(), song, imaging(), { type: 'break', kind: 'segment', skill: 'news' }, song, song]);
  assert.deepEqual(kinds(at(c, 1, 3000)), ['link']);
  assert.deepEqual(kinds(at(c, 2, 2800)), ['imaging', 'segment']);
  assert.deepEqual(kinds(at(c, 3, 2000)), []);
});

test('a segment step carries its skill into the action', () => {
  const c = clock([song, { type: 'break', kind: 'segment', skill: 'news' }, song]);
  assert.deepEqual(at(c, 1, 3000).actions, [{ type: 'break', kind: 'segment', skill: 'news' }]);
});

test('talk keeps clock order after imaging', () => {
  const c = clock([song, link(), imaging(), { type: 'break', kind: 'station-id' }, song]);
  assert.deepEqual(kinds(at(c, 1, 3000)), ['imaging', 'link', 'station-id']);
});

test('dropIfLate sheds the latest droppable step first, until the body fits', () => {
  // Boundary 2: [link1] + song2 + song3 + imaging + link2 + song4 = 20+600+8+20 ... see below.
  const c = clock([song, link({ dropIfLate: true }), song, imaging({ dropIfLate: true }), song, link({ dropIfLate: true }), song]);
  // remaining from boundary 2 = link 20 + 3 songs 600 + imaging 8 + link 20 = 648.
  assert.deepEqual(kinds(at(c, 1, 700)), ['link']);
  // 640: the LAST link goes (628), the seam link stays.
  const a = planBoundary({ clock: c, hourStartMs: 0, hourEndMs: 3600_000, boundaryMs: (3600 - 640) * 1000, songsStartedInHour: 1, estimates: EST });
  assert.deepEqual(a.actions.map((x) => x.type), ['break']);
  assert.equal(a.dropped, 0);
  assert.match(a.note, /1 ahead/);
  // 625: the imaging goes too (620), still not this boundary's link.
  const b = at(c, 1, 625);
  assert.deepEqual(kinds(b), ['link']);
  assert.equal(b.dropped, 0);
  assert.match(b.note, /2 ahead/);
  // 615: only now does the seam link itself go.
  const d = at(c, 1, 615);
  assert.deepEqual(d.actions, []);
  assert.equal(d.dropped, 1);
  // Songs are never dropped: with nothing droppable left, it just runs over.
  assert.deepEqual(at(c, 1, 100).actions, []);
});

test('a step without dropIfLate is kept however late the hour is', () => {
  const c = clock([song, link(), song, imaging(), song]);
  assert.deepEqual(kinds(at(c, 1, 10)), ['link']);
});

test('a top-of-hour station ID is never dropped, even when flagged', () => {
  const stubborn = { type: 'break', kind: 'station-id', topOfHour: true, dropIfLate: true } as FormatClockStep;
  const c = clock([song, stubborn, song]);
  const d = at(c, 1, 5);
  assert.deepEqual(kinds(d), ['station-id*']);
  assert.equal(d.dropped, 0);
  // An ordinary station ID with the flag does go.
  const plain = clock([song, { type: 'break', kind: 'station-id', dropIfLate: true }, song]);
  assert.deepEqual(at(plain, 1, 5).actions, []);
});

test('fitLastSong caps the last body song to the time left, with the tolerance', () => {
  const c = clock([song, link(), song, link(), song], { fitLastSong: true });
  // Song 3 is the last body song: 700 s left, minus its 20 s link, plus 10 s.
  const d = at(c, 2, 700);
  assert.equal(d.maxSongSec, 690);
  assert.deepEqual(kinds(d), ['link']);
  // Earlier songs with plenty of hour left are not capped.
  assert.equal(at(c, 1, 2000).maxSongSec, null);
  // Off: never a cap.
  assert.equal(at({ ...c, fitLastSong: false }, 2, 700).maxSongSec, null);
});

test('fitLastSong also caps a fill song inside 1.5 average songs of :00', () => {
  const c = clock([song, song], { fitLastSong: true });
  assert.equal(at(c, 5, 250).maxSongSec, 260);
  assert.equal(at(c, 5, 301).maxSongSec, null); // not inside 1.5 x 200 yet
});

test('the fit cap returns null below 90 s and below the show floor', () => {
  const c = clock([song, song], { fitLastSong: true });
  assert.equal(at(c, 5, 80).maxSongSec, 90);   // 80 + 10 tolerance reaches the 90 s floor
  assert.equal(at(c, 5, 79).maxSongSec, null); // 89 does not: the normal overrun applies
  assert.equal(at(c, 5, 250, { minSongSec: 270 }).maxSongSec, null);
  assert.equal(at(c, 5, 250, { minSongSec: 260 }).maxSongSec, 260);
});

test('the fit cap leaves room for the closer, except a top-of-hour ID that airs at :00', () => {
  const c = clock([song, song, imaging(), topId], { fitLastSong: true });
  // closer = [imaging 8, top id]: only the imaging is made room for.
  assert.equal(at(c, 1, 500).maxSongSec, 500 - 8 + 10);
});

test("fill 'songs': after the body, plain songs and no actions", () => {
  const c = clock([song, link(), song], { fillRule: 'songs' });
  const d = at(c, 2, 1500);
  assert.deepEqual(d.actions, []);
  assert.equal(d.maxSongSec, null);
  assert.equal(d.position.stepIndex, -1);
  assert.equal(d.position.songOfHour, 3);
});

test("fill 'loop': wraps back to the body start, between steps included", () => {
  const c = clock([song, link(), song], { fillRule: 'loop' });
  assert.deepEqual(kinds(at(c, 2, 1500)), []);       // song 3 = body song 1
  assert.deepEqual(kinds(at(c, 3, 1300)), ['link']); // song 4 = body song 2
  assert.deepEqual(kinds(at(c, 4, 1100)), []);       // song 5 wraps again
  assert.deepEqual(kinds(at(c, 5, 900)), ['link']);
  assert.equal(at(c, 3, 1300).position.stepIndex, 2);
});

test("fill 'songs-then-break': one link where the song will cross :00", () => {
  const c = clock([song, link(), song], { fillRule: 'songs-then-break' });
  assert.deepEqual(at(c, 2, 1000).actions, []);
  assert.deepEqual(kinds(at(c, 2, 150)), ['link']);
  // Still inside the body: the rule does not apply.
  assert.deepEqual(kinds(at(c, 1, 150)), ['link']); // the clock's own between link
  assert.deepEqual(at(clock([song, song], { fillRule: 'songs-then-break' }), 1, 150).actions, []);
  // 'songs' never adds one.
  assert.deepEqual(at(clock([song, song], { fillRule: 'songs' }), 2, 150).actions, []);
});

test('a clock with no song step decides nothing', () => {
  const d = at(clock([link()]), 0, 3600);
  assert.deepEqual(d.actions, []);
  assert.equal(d.maxSongSec, null);
});

test('projectHour totals: a short body fills out with songs and overruns by its tail', () => {
  const est = { ...EST, avgSongSec: 600 };
  const p = projectHour(clock([song, link(), song]), est);
  // 600 + 20 + 600, then fill songs: 1220..1820..2420..3020..3620.
  assert.equal(p.songs, 6);
  assert.equal(p.totalSec, 3620);
  assert.equal(p.vsHourSec, 20);
  assert.equal(p.steps[0].startSec, 0);
  assert.equal(p.steps[1].kind, 'link');
  assert.equal(p.steps[1].startSec, 600);
  assert.equal(p.steps[2].startSec, 620);
  assert.equal(p.steps.at(-1)?.section, 'fill');
});

test('projectHour with fitLastSong ends the hour within the tolerance', () => {
  const est = { ...EST, avgSongSec: 600 };
  const p = projectHour(clock([song, link(), song], { fitLastSong: true }), est);
  assert.equal(p.songs, 6);
  assert.equal(p.totalSec, 3610);
  assert.equal(p.vsHourSec, 10);
  assert.equal(p.steps.at(-1)?.durationSec, 590);
});

test('projectHour opens with the previous closer then the opener, imaging first', () => {
  const p = projectHour(clock([imaging(), song, link(), song, topId]), { ...EST, avgSongSec: 900 });
  assert.deepEqual(p.steps.slice(0, 3).map((s) => [s.type, s.section, s.startSec]), [
    ['imaging', 'opener', 0],
    ['break', 'closer', 8],
    ['song', 'body', 20],
  ]);
});

test('projectHour marks a step shed for lateness and gives it no time', () => {
  const p = projectHour(clock([song, imaging({ dropIfLate: true }), song]), { ...EST, avgSongSec: 2000 });
  const shed = p.steps.find((s) => s.type === 'imaging');
  assert.equal(shed?.dropped, true);
  assert.equal(shed?.durationSec, 0);
  assert.equal(p.steps.filter((s) => s.type === 'song').length, 2);
});

test('projectHour in loop mode repeats the body, and a clock with no song projects nothing', () => {
  const p = projectHour(clock([song, link(), song], { fillRule: 'loop' }), { ...EST, avgSongSec: 400 });
  assert.equal(p.steps.filter((s) => s.kind === 'link').length >= 2, true);
  assert.deepEqual(projectHour(clock([link()]), EST).steps, []);
});

test('the default estimates are the spec figures', () => {
  assert.deepEqual(DEFAULT_ESTIMATES, { avgSongSec: 210, linkSec: 20, stationIdSec: 12, segmentSec: 60, imagingSec: 8 });
});
