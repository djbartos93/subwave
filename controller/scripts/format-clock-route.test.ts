// POST /format-clocks/preview and the timing estimates behind it, through a
// real Express app. The library is empty here, so the estimates take the
// documented fallbacks (210 s song, 8 s imaging); the pure averages are pinned
// directly.
//
// Run: `npm test -- format-clock-route`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-format-clock-route-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/format-clocks.js');
const { averageSeconds, songEstimate, imagingEstimate, resetShowTimingCache } = await import('../src/music/show-timing.js');

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const authorization = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;

after(async () => {
  server.close();
  await removeTempDir(stateRoot);
});

const post = (body: unknown, auth = true) => fetch(`${base}/format-clocks/preview`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization } : {}) },
  body: JSON.stringify(body),
});

const CLOCK = {
  name: 'Preview',
  steps: [{ type: 'song' }, { type: 'break', kind: 'link' }, { type: 'song' }],
  fitLastSong: false,
};

test('the preview is admin-only', async () => {
  assert.equal((await post({ clock: CLOCK }, false)).status, 401);
});

test('an unsaved draft projects against the fallback estimates', async () => {
  resetShowTimingCache();
  const res = await post({ clock: CLOCK });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.show, null);
  assert.deepEqual(body.estimates, { avgSongSec: 210, linkSec: 20, stationIdSec: 12, segmentSec: 60, imagingSec: 8 });
  assert.deepEqual(body.sources, { song: 'fallback', imaging: 'fallback', songSamples: 0 });
  assert.equal(body.projection.steps[0].type, 'song');
  assert.equal(body.projection.steps[1].startSec, 210);
  assert.equal(typeof body.projection.totalSec, 'number');
  assert.equal(body.projection.vsHourSec, body.projection.totalSec - 3600);
});

test('a show id selects that show, and an unknown one is a 404', async () => {
  await settings.load();
  const personaId = settings.get().personas[0].id;
  await settings.update({ shows: [{ name: 'Mornings', personaId }] });
  const showId = settings.get().shows[0].id;
  const ok = await post({ clock: CLOCK, showId });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json() as any).show, { id: showId, name: 'Mornings' });
  assert.equal((await post({ clock: CLOCK, showId: 's_nope' })).status, 404);
});

test('an invalid draft is a 400 with field errors, not a 500', async () => {
  const res = await post({ clock: { ...CLOCK, steps: [{ type: 'break', kind: 'link' }] } });
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.match(body.error, /song step/);
  assert.ok(body.fieldErrors.clock?.steps || body.fieldErrors['clock.steps']);
});

test('averageSeconds ignores unknown and non-positive lengths', () => {
  assert.equal(averageSeconds([100, 200, null, undefined, 0, -5, NaN]), 150);
  assert.equal(averageSeconds([]), null);
});

test('songEstimate: the show pool, then the library, then 210', () => {
  const rows = (...d: number[]) => d.map((duration) => ({ duration }));
  assert.deepEqual(songEstimate(rows(120, 240), rows(900)), { sec: 180, source: 'show', samples: 2 });
  assert.deepEqual(songEstimate([], rows(300, 400)), { sec: 350, source: 'library', samples: 2 });
  assert.deepEqual(songEstimate(rows(), rows()), { sec: 210, source: 'fallback', samples: 0 });
  // A pool of unmeasured rows is as good as empty.
  assert.equal(songEstimate([{ duration: null }], rows(300)).source, 'library');
});

test('imagingEstimate falls back to 8 s with no measurable jingle', async () => {
  assert.deepEqual(await imagingEstimate(['gone.wav']), { sec: 8, source: 'fallback' });
});

// The dashboard card polls this every 10 s; it must stay a small admin read,
// not a reach into /debug.
test('GET /format-clocks/status is admin-only and reports no owner with no clock on air', async () => {
  assert.equal((await fetch(`${base}/format-clocks/status`)).status, 401);
  const res = await fetch(`${base}/format-clocks/status`, { headers: { authorization } });
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.owning, false);
  assert.equal(body.clock, null);
});
