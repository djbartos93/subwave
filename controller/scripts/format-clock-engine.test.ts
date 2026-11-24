// The format clock's live engine, through real settings: which clock a pick
// airs under, whether one owns the talk, the policy inputs it gathers (the
// STATION hour, songs started across an hour seam, the closer carry), the seam
// it hands the queue, the per-hour fade cut, the stand-down at the slot table
// and the cron gates, and that a show WITHOUT a clock is untouched.
// Run: `npm test -- format-clock-engine`.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-format-clock-engine-'));
process.env.STATE_DIR = stateRoot;
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = '1';

const settings = await import('../src/settings.js');
const fc = await import('../src/broadcast/format-clock.js');
const showBoundary = await import('../src/broadcast/show-boundary.js');
const { jingleRotateOwner, mixerJingleRatioFile } = await import('../src/broadcast/jingle-rotate.js');
const { talkEligible, skillCronStandDownReason } = await import('../src/broadcast/scheduler.js');
const { queue } = await import('../src/broadcast/queue.js');

// 2026-01-15, a Thursday, clear of any DST step.
const day = (h: number, m = 0, s = 0) => Date.UTC(2026, 0, 15, h, m, s);
const iso = (ms: number) => new Date(ms).toISOString();

const CLOCK = {
  id: 'fc_main',
  name: 'Main hour',
  fillRule: 'songs',
  fitLastSong: false,
  steps: [
    { type: 'break', kind: 'station-id', topOfHour: true }, // closer
  ] as any[],
};
// song, link, song, imaging, song, station-id (top of hour closer)
CLOCK.steps = [
  { type: 'song' },
  { type: 'break', kind: 'link' },
  { type: 'song' },
  { type: 'imaging' },
  { type: 'song' },
  { type: 'break', kind: 'station-id', topOfHour: true },
];

type Seed = { clockHours?: number[]; timezone?: string; fade?: boolean | null; stationFade?: boolean };

// Every day paints 'plainshow' except the hours that run the clock show.
async function seed({ clockHours = [], timezone = 'UTC', fade = null, stationFade = false }: Seed = {}) {
  await settings.load();
  const personaId = settings.get().personas[0].id;
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) week[d] = Array.from({ length: 24 }, (_, h) => (clockHours.includes(h) ? 'ckshow' : 'plainshow'));
  await settings.update({
    timezone,
    fadeAtShowEnd: stationFade,
    formatClocks: [CLOCK],
    shows: [
      { id: 'ckshow', name: 'Clock Show', topic: 'a format', personaId, formatClockId: 'fc_main', fadeAtShowEnd: fade },
      { id: 'plainshow', name: 'Plain Show', topic: 'no clock', personaId, fadeAtShowEnd: null },
    ],
    schedule: week,
    scheduleOverride: null,
  } as any);
}

// What the policy reads off the queue: started instants and queued forecasts.
function fakeQueue(opts: { current?: number | null; history?: number[]; upcomingInSec?: Array<number | null> }) {
  const log: string[] = [];
  const upcoming = (opts.upcomingInSec ?? []).map((sec, i) => ({ id: i, sec }));
  return {
    log,
    q: {
      current: opts.current != null ? { startedAt: iso(opts.current) } : null,
      history: (opts.history ?? []).map((ms) => ({ startedAt: iso(ms) })),
      upcoming,
      airForecastSec: (item: any) => item.sec,
      log: (_kind: string, line: string) => { log.push(line); },
    },
  };
}

beforeEach(() => { fc.resetFormatClockState(); });
after(async () => { await removeTempDir(stateRoot); });

test('a show owns the talk only while it runs a clock that exists', async () => {
  await seed({ clockHours: [9] });
  assert.equal(fc.formatClockOwnsTalk(new Date(day(9, 30))), true);
  assert.equal(fc.formatClockOwnsTalk(new Date(day(10, 30))), false);
  assert.equal(fc.clockForShow(settings.resolveActiveShow(new Date(day(9, 30))))?.id, 'fc_main');
  assert.equal(fc.clockForShow(settings.resolveActiveShow(new Date(day(10, 30)))), null);
  // Deleting the clock clears the pointer (the persona-deleted behaviour), so
  // nothing is owned afterwards.
  await settings.update({ formatClocks: [] } as any);
  assert.equal(fc.formatClockOwnsTalk(new Date(day(9, 30))), false);
});

test('the gathered input counts songs across the hour seam, on the station zone', async () => {
  await seed({ clockHours: [9, 10] });
  const now = new Date(day(10, 12));
  // 09:50 and 09:55 are the previous hour's; 10:03 and 10:08 (on air) are this
  // hour's; a queued pick forecast 60 s out (10:13) counts too, because the new
  // pick's seam is at 10:14 (showAt carries the 2-minute attribution padding).
  const { q } = fakeQueue({ current: day(10, 8), history: [day(10, 3), day(9, 55), day(9, 50)], upcomingInSec: [60] });
  const seam = fc.planFormatSeam(q, { showAt: new Date(day(10, 16)), finalTrackHandoff: false }, now)!;
  assert.equal(seam.decision.position.songOfHour, 4, 'three songs started in the 10:00 hour, so this is the fourth');
  assert.equal(seam.clock.id, 'fc_main');
});

test('the hour is the STATION hour: a +5:30 zone turns at UTC :30', async () => {
  // 14:40 IST is 09:10 UTC; the station hour opened at 14:00 IST = 08:30 UTC.
  await seed({ clockHours: [14], timezone: 'Asia/Kolkata' });
  const now = new Date(day(9, 10));
  const { q } = fakeQueue({ current: day(9, 5), history: [day(8, 40), day(8, 20)] });
  const seam = fc.planFormatSeam(q, { showAt: null, finalTrackHandoff: false }, now)!;
  // 08:40 and 09:05 are in the IST hour; 08:20 is not.
  assert.equal(seam.decision.position.songOfHour, 3);
});

test('the first seam of an hour carries the closer only from the same show and clock', async () => {
  // 09:02: nothing has started in the 09:00 hour yet, so this is song 1.
  const now = new Date(day(9, 2));
  const queueOf = () => fakeQueue({ current: day(8, 58), history: [day(8, 52)] }).q;

  await seed({ clockHours: [8, 9] });
  const carried = fc.planFormatSeam(queueOf(), { showAt: null, finalTrackHandoff: false }, now)!;
  assert.equal(carried.decision.position.songOfHour, 1);
  assert.deepEqual(carried.plan.talk, { kind: 'station-id', topOfHour: true }, 'the previous hour closed with the top-of-hour ID');

  // The previous hour was a different show with no clock: no closer is carried.
  await seed({ clockHours: [9] });
  const fresh = fc.planFormatSeam(queueOf(), { showAt: null, finalTrackHandoff: false }, now)!;
  assert.equal(fresh.decision.position.songOfHour, 1);
  assert.equal(fresh.plan.talk, null, 'a show change airs no closer of the outgoing show');
});

test('the seam follows the decision: a link, imaging, and a handoff that owns the talk', async () => {
  await seed({ clockHours: [9] });
  const now = new Date(day(9, 20));
  // One song started: this boundary is song 2, between song 1 and 2 sits the link.
  const link = fc.planFormatSeam(fakeQueue({ current: day(9, 15) }).q, { showAt: null, finalTrackHandoff: false }, now)!;
  assert.equal(link.plan.wantLink, true);
  assert.equal(link.plan.imaging, 0);
  // Two songs started: song 3, with the imaging between song 2 and 3.
  const imaging = fc.planFormatSeam(fakeQueue({ current: day(9, 15), history: [day(9, 5)] }).q, { showAt: null, finalTrackHandoff: false }, now)!;
  assert.equal(imaging.plan.wantLink, false);
  assert.equal(imaging.plan.imaging, 1);
  // A show-change handoff owns the seam's talk: the link stands down.
  const handoff = fc.planFormatSeam(fakeQueue({ current: day(9, 15) }).q, { showAt: null, finalTrackHandoff: true }, now)!;
  assert.equal(handoff.plan.wantLink, false);
});

test('the decision is logged once per boundary and kept for the admin status only', async () => {
  await seed({ clockHours: [9] });
  const now = new Date(day(9, 20));
  const { q, log } = fakeQueue({ current: day(9, 15) });
  fc.planFormatSeam(q, { showAt: null, finalTrackHandoff: false }, now);
  fc.planFormatSeam(q, { showAt: null, finalTrackHandoff: false }, now);
  assert.equal(log.filter((l) => l.startsWith('[format-clock]')).length, 1, 'a retried pick cycle does not repeat the line');
  assert.match(log[0], /"Main hour" step \d+ of 6/);
  const status = fc.formatClockStatus(now);
  assert.equal(status.last?.clockName, 'Main hour');
  assert.equal(status.last?.songOfHour, 2);
  assert.equal(status.last?.totalSteps, 6);
  assert.ok(Array.isArray(status.last?.actions));
});

test('a show without a clock is untouched: no seam, same cut boundary, nothing stands down', async () => {
  await seed({ clockHours: [9] });
  const now = new Date(day(10, 20));
  assert.equal(fc.planFormatSeam(fakeQueue({ current: day(10, 15) }).q, { showAt: null, finalTrackHandoff: false }, now), null);
  assert.equal(fc.formatClockOwnsTalk(now), false);
  // The cut scan is the show-change scan for a plain show, fade on or off.
  await settings.update({ fadeAtShowEnd: true } as any);
  assert.equal(showBoundary.nextCutBoundaryMs(day(10, 20), 7200), showBoundary.nextShowBoundaryMs(day(10, 20), 7200));
  // Every row is judged by its own gate, not by the clock: the controller-owned
  // jingle rotate comes due on a clockless hour exactly as it does for any
  // controller-owned station.
  await settings.update({ jingleRatio: 3 } as any);
  (queue as any)._tracksSinceJingle = 5;
  assert.equal(talkEligible('jingle', now, null), true);
});

test('while a clock owns the hour every automatic row stands down, and per-skill crons with them', async () => {
  await seed({ clockHours: [9] });
  await settings.update({ jingleRatio: 3 } as any);
  (queue as any)._tracksSinceJingle = 5;
  const inside = new Date(day(9, 30));
  for (const kind of ['hourly', 'programme', 'banter', 'station-id', 'segment', 'jingle'] as const) {
    assert.equal(talkEligible(kind, inside, null), false, `${kind} stands down inside a clock hour`);
  }
  // The same minute, off the clock hour: the jingle row is due again.
  assert.equal(talkEligible('jingle', new Date(day(10, 30)), null), true);

  const open = { voiceAllowed: true, programmeOnAir: false, djCallsAllowed: true, optionalSegmentsAllowed: true };
  assert.equal(skillCronStandDownReason(open), null);
  assert.equal(skillCronStandDownReason({ ...open, formatClockOwns: true }), 'a format clock owns the talk');
});

test('the jingle rotate is controller-owned while a show has a clock, and the saved choice is kept', async () => {
  await seed({ clockHours: [9] });
  const s = settings.get();
  assert.equal(jingleRotateOwner(s), 'controller');
  assert.equal(s.jingleRotate, 'mixer', 'the saved jingleRotate is not overwritten');
  assert.equal(mixerJingleRatioFile(s), '0');
  // Cold load: the saved value is still the operator's.
  const { setCache } = await import('../src/settings/store.js');
  setCache(null);
  await settings.load();
  assert.equal(settings.get().jingleRotate, 'mixer');
  assert.equal(jingleRotateOwner(settings.get()), 'controller');
  // No show runs a clock any more: the mixer owns it again.
  await settings.update({ formatClocks: [] } as any);
  assert.equal(jingleRotateOwner(settings.get()), 'mixer');
});

test('with the fade on, every station hour inside a clock show is a cut point', async () => {
  await seed({ clockHours: [9, 10, 11], fade: true });
  const from = day(9, 10);
  assert.equal(showBoundary.hourlyCutsActive(new Date(from)), true);
  assert.equal(showBoundary.nextCutBoundaryMs(from, 4 * 3600), day(10, 0), 'the next :00, inside the show');
  // The pick look-ahead and handoff arming still see only the show change.
  assert.equal(showBoundary.nextShowBoundaryMs(from, 4 * 3600), day(12, 0));
  // A track starting after :00 gets the following hour's cut.
  assert.equal(showBoundary.nextCutBoundaryMs(day(10, 1), 4 * 3600), day(11, 0));
  // An hour that is not the clock show's keeps today's scan.
  assert.equal(showBoundary.nextCutBoundaryMs(day(13, 5), 2 * 3600), null);
});

test('with the fade off the hour seam is not a cut, and the station default is inherited', async () => {
  await seed({ clockHours: [9, 10, 11], fade: false, stationFade: true });
  assert.equal(showBoundary.hourlyCutsActive(new Date(day(9, 10))), false, 'the show\'s own false wins');
  assert.equal(showBoundary.nextCutBoundaryMs(day(9, 10), 4 * 3600), day(12, 0), 'only the show change');
  await seed({ clockHours: [9, 10, 11], fade: null, stationFade: true });
  assert.equal(showBoundary.hourlyCutsActive(new Date(day(9, 10))), true, 'null inherits the station\'s on');
  await seed({ clockHours: [9, 10, 11], fade: null, stationFade: false });
  assert.equal(showBoundary.hourlyCutsActive(new Date(day(9, 10))), false);
});

test('a seam stamped on a held anchor waits for it; one on the track on air fires once', async () => {
  await seed({ clockHours: [9] });
  const fired: Array<{ imaging: number; talk: unknown }> = [];
  (queue as any).playImagingJingle = async () => { fired.push({ imaging: 1, talk: null }); return true; };
  const talked: string[] = [];
  fc.registerSeamRunners({
    stationId: async (o) => { talked.push(`station-id:${o.topOfHour}`); },
    segment: async (skill) => { talked.push(`segment:${skill}`); },
  });
  const seam = (imaging: number, talk: any) => ({
    clock: CLOCK, decision: {} as any, maxSongSec: null, allowedJingles: ['a.wav'], showId: 'ckshow',
    plan: { wantLink: false, imaging, talk, notes: [] },
  }) as any;

  // Held anchor: stamped, not fired. A second decision overwrites the first.
  const held: any = { track: { id: 'h', title: 'Held', artist: 'A' } };
  queue.deliverFormatSeam(seam(1, { kind: 'station-id', topOfHour: true }), held);
  queue.deliverFormatSeam(seam(2, null), held);
  assert.equal(held.formatSeam.imaging, 2);
  assert.equal(held.formatSeam.talk, null);
  assert.deepEqual(fired, []);
  // An empty decision clears the stamp.
  queue.deliverFormatSeam(seam(0, null), held);
  assert.equal(held.formatSeam, undefined);

  // On-air anchor: fires now, and a repeated cycle on it is a no-op.
  const onAir: any = { track: { id: 'o', title: 'On air', artist: 'B' }, startedAt: iso(Date.now()) };
  queue.current = onAir;
  queue.deliverFormatSeam(seam(1, { kind: 'segment', skill: 'weather' }), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired.length, 1);
  assert.deepEqual(talked, ['segment:weather']);
  assert.equal(onAir.formatSeamFired, true);
  queue.deliverFormatSeam(seam(1, { kind: 'segment', skill: 'weather' }), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired.length, 1, 'fired once');
  assert.deepEqual(talked, ['segment:weather']);
  fc.registerSeamRunners(null);
});

test('the random link counter ticks for a clockless show and is left alone for a clock show', async () => {
  const settle = async () => { for (let i = 0; i < 300 && queue.pickerBusy; i++) await new Promise((r) => setTimeout(r, 20)); };
  const q = queue as any;
  q.autoLink = true;
  q.history = [{ track: { id: 'x', title: 'X', artist: 'A' } }];
  q.upcoming = [];
  q.current = null;

  // Off the clock hours: pre-existing behaviour, the counter ticks.
  await seed({ clockHours: [] });
  q.tracksUntilLink = 50;
  q.runPickCycle({ isAutonomous: true });
  assert.equal(q.tracksUntilLink, 49);
  await settle();

  // Every hour runs the clock: the clock decides links, so the counter never moves.
  await seed({ clockHours: Array.from({ length: 24 }, (_, h) => h) });
  q.tracksUntilLink = 50;
  q.runPickCycle({ isAutonomous: true });
  assert.equal(q.tracksUntilLink, 50);
  await settle();
});
