// settings.formatClocks and a show's formatClockId through the full recipe:
// the strict path (update / validateShowsStrict), the lenient load path, and a
// COLD-LOAD round trip, because load() composes each section explicitly and a
// field missing there validates, saves, then silently vanishes on restart.
//
// Run: `npm test -- format-clock-settings`.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(path.join(tmpdir(), 'subwave-format-clock-settings-'));

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { validateShowsStrict, validateFormatClocksStrict } = await import('../src/settings/validate.js');
const { normalizeFormatClocks, normalizeShows } = await import('../src/settings/normalize.js');
const { SETTINGS_PATCH_KEYS, validateSettingsPatch } = await import('../src/settings/patch-registry.js');
const { FORMAT_CLOCKS_LIMIT, FORMAT_CLOCK_STEPS_MAX } = await import('../src/schemas/format-clock.js');

const GOOD = {
  name: 'Top of the hour',
  steps: [
    { type: 'break', kind: 'station-id', topOfHour: true },
    { type: 'song' },
    { type: 'break', kind: 'link' },
    { type: 'song' },
    { type: 'imaging', dropIfLate: true },
    { type: 'song' },
  ],
  fillRule: 'loop',
  fitLastSong: true,
};
const personas = [{ id: 'p_host' }];
const themes = new Set<string>();
const moods = ['chill'];
const showOf = (over: Record<string, unknown> = {}) => ({ name: 'Breakfast', personaId: 'p_host', ...over });

test('a valid clock saves with a minted id and defaults', () => {
  const [c] = validateFormatClocksStrict([{ name: 'Min', steps: [{ type: 'song' }] }]);
  assert.match(c.id, /^fc_[a-z0-9]+$/);
  assert.equal(c.fillRule, 'songs');
  assert.equal(c.fitLastSong, true);
  assert.deepEqual(c.steps, [{ type: 'song' }]);
});

test('steps are canonical: flags only when true, skill only on a segment', () => {
  const [c] = validateFormatClocksStrict([{
    name: 'Canon',
    steps: [
      { type: 'song' },
      { type: 'imaging', dropIfLate: false },
      { type: 'break', kind: 'link', skill: 'news', topOfHour: true, dropIfLate: true },
      { type: 'break', kind: 'segment', skill: 'news' },
      { type: 'break', kind: 'station-id', topOfHour: true, dropIfLate: true },
    ],
  }]);
  assert.deepEqual(c.steps, [
    { type: 'song' },
    { type: 'imaging' },
    { type: 'break', kind: 'link', dropIfLate: true },
    { type: 'break', kind: 'segment', skill: 'news' },
    { type: 'break', kind: 'station-id', topOfHour: true },
  ]);
});

test('strict save refuses what the load path repairs', () => {
  const bad = (over: Record<string, unknown>) => () => validateFormatClocksStrict([{ ...GOOD, ...over }]);
  assert.throws(bad({ steps: [{ type: 'break', kind: 'link' }] }), /song step/);
  assert.throws(bad({ steps: [] }), /at least one step/);
  assert.throws(bad({ steps: Array(FORMAT_CLOCK_STEPS_MAX + 1).fill({ type: 'song' }) }), /at most/);
  assert.throws(bad({ steps: [{ type: 'song' }, { type: 'break', kind: 'segment' }] }), /needs a skill/);
  assert.throws(bad({ steps: [{ type: 'song' }, { type: 'break', kind: 'segment', skill: 'Not A Slug' }] }), /slug/);
  assert.throws(bad({ steps: [{ type: 'song' }, { type: 'break', kind: 'shout' }] }), /kind/);
  assert.throws(bad({ steps: [{ type: 'song' }, { type: 'wave' }] }), /step type/);
  assert.throws(bad({ fillRule: 'random' }), /fillRule/);
  assert.throws(bad({ name: '   ' }), /name/);
  assert.throws(() => validateFormatClocksStrict(Array(FORMAT_CLOCKS_LIMIT + 1).fill(GOOD)), /at most/);
  assert.throws(() => validateFormatClocksStrict('nope'), /array/);
});

test('load repairs: bad steps drop, a bad id is re-minted, a clock with no song is dropped', () => {
  const rows = normalizeFormatClocks([
    { ...GOOD, id: 'Bad Id!', steps: [{ type: 'song' }, 7, { type: 'wave' }, { type: 'break', kind: 'segment' }, { type: 'imaging' }], fillRule: 'bogus' },
    { name: 'No songs', steps: [{ type: 'imaging' }] },
    { steps: [{ type: 'song' }] },
    'junk',
    { ...GOOD, id: 'fc_keep' },
    { ...GOOD, id: 'fc_keep' },
  ]);
  assert.equal(rows.length, 3);
  assert.match(rows[0].id, /^fc_/);
  assert.deepEqual(rows[0].steps, [{ type: 'song' }, { type: 'imaging' }]);
  assert.equal(rows[0].fillRule, 'songs');
  assert.equal(rows[1].id, 'fc_keep');
  assert.notEqual(rows[2].id, 'fc_keep');
  assert.deepEqual(normalizeFormatClocks(undefined), []);
});

test('formatClocks is a registered settings key with a patch schema', () => {
  assert.ok((SETTINGS_PATCH_KEYS as readonly string[]).includes('formatClocks'));
  assert.equal(validateSettingsPatch({ formatClocks: [GOOD] }), null);
  assert.match(validateSettingsPatch({ formatClocks: [{ ...GOOD, steps: [] }] })?.error ?? '', /formatClocks/);
});

test('a show may name an existing clock, and strict save refuses a missing one', () => {
  const ok = validateShowsStrict([showOf({ formatClockId: 'fc_one' })], personas, themes, moods, ['fc_one']);
  assert.equal(ok[0].formatClockId, 'fc_one');
  assert.throws(
    () => validateShowsStrict([showOf({ formatClockId: 'fc_gone' })], personas, themes, moods, ['fc_one']),
    /existing format clock/,
  );
  // absent, '' and null are all "none"
  for (const v of [undefined, '', null, '  ']) {
    assert.equal(validateShowsStrict([showOf({ formatClockId: v })], personas, themes, moods, [])[0].formatClockId, null);
  }
});

test('a programme show cannot also have a format clock', () => {
  assert.throws(
    () => validateShowsStrict([showOf({ programme: true, formatClockId: 'fc_one' })], personas, themes, moods, ['fc_one']),
    /programme show cannot use a format clock/,
  );
  assert.equal(
    validateShowsStrict([showOf({ programme: true })], personas, themes, moods, ['fc_one'])[0].formatClockId,
    null,
  );
});

test('load: a dangling or programme-conflicting formatClockId reads as none, the show survives', () => {
  const rows = normalizeShows([
    showOf({ id: 's_good', formatClockId: 'fc_one' }),
    showOf({ id: 's_dangle', formatClockId: 'fc_gone' }),
    showOf({ id: 's_prog', programme: true, formatClockId: 'fc_one' }),
    showOf({ id: 's_none' }),
  ], ['p_host'], ['fc_one']);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.s_good.formatClockId, 'fc_one');
  assert.equal(by.s_dangle.formatClockId, null);
  assert.equal(by.s_prog.formatClockId, null);
  assert.equal(by.s_prog.programme, true);
  assert.equal(by.s_none.formatClockId, null);
});

test('cold-load round trip: clocks and a show pointer survive a restart', async () => {
  const personaId = (await coldLoadSettings({})).personas[0].id;
  await settings.update({ formatClocks: [GOOD] });
  const id = settings.get().formatClocks[0].id;
  assert.match(id, /^fc_/);
  await settings.update({ shows: [showOf({ personaId, formatClockId: id })] });

  setCache(null);
  const cold = await settings.load();
  assert.equal(cold.formatClocks.length, 1);
  assert.equal(cold.formatClocks[0].id, id);
  assert.deepEqual(cold.formatClocks[0].steps, GOOD.steps);
  assert.equal(cold.formatClocks[0].fillRule, 'loop');
  assert.equal(cold.formatClocks[0].fitLastSong, true);
  assert.equal(cold.shows[0].formatClockId, id);
  // The resolved show carries it too: the live engine reads it there.
  assert.equal(settings.resolveShowById(cold.shows[0].id)?.formatClockId, id);
});

test('update refuses a show naming a clock this patch removes, and clears a pointer when the clock goes', async () => {
  const cur = settings.get();
  const id = cur.formatClocks[0].id;
  await assert.rejects(
    settings.update({ formatClocks: [], shows: [showOf({ personaId: cur.personas[0].id, formatClockId: id })] }),
    /existing format clock/,
  );
  // Removing the clock alone keeps the show and nulls its pointer, as a
  // deleted guest persona leaves the show standing.
  await settings.update({ formatClocks: [] });
  const after = settings.get();
  assert.equal(after.shows.length, 1);
  assert.equal(after.shows[0].formatClockId, null);
  setCache(null);
  assert.equal((await settings.load()).shows[0].formatClockId, null);
});

test('a default install has no clocks', async () => {
  assert.deepEqual((await coldLoadSettings({})).formatClocks, []);
});
