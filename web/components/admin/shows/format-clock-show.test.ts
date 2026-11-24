import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateShow, showContext, showPayload } from './lib';
import { showSchema } from '@/lib/schemas.generated';

// formatClockId from the stored show to the editor, the wire and the shared
// schema. A field left out of hydrateShow reads as None in the editor; left out
// of showPayload, a save quietly drops the clock.

const stored = { id: 's_clock', name: 'Drive', personaId: 'host' };
const schema = (ids: string[] | null) => showSchema(showContext({
  personas: [{ id: 'host' }], moods: [], themeIds: [], minTrackSeconds: null, formatClockIds: ids,
}));

test('a show from before format clocks hydrates and saves as none', () => {
  const show = hydrateShow(stored);
  assert.equal(show.formatClockId, null);
  assert.equal(showPayload(show).formatClockId, null);
});

test('a chosen clock survives the editor and the payload', () => {
  const show = hydrateShow({ ...stored, formatClockId: ' fc_morning ' });
  assert.equal(show.formatClockId, 'fc_morning');
  assert.equal(showPayload(show).formatClockId, 'fc_morning');
  assert.equal(hydrateShow({ ...stored, formatClockId: '' }).formatClockId, null);
});

test('the select\'s empty value saves as none', () => {
  assert.equal(showPayload({ ...hydrateShow(stored), formatClockId: '' }).formatClockId, null);
});

test('the shared schema accepts a known clock, refuses an unknown one and a programme', () => {
  const ok = schema(['fc_morning']).safeParse(showPayload(hydrateShow({ ...stored, formatClockId: 'fc_morning' })));
  assert.equal(ok.success, true);
  const unknown = schema(['fc_other']).safeParse(showPayload(hydrateShow({ ...stored, formatClockId: 'fc_morning' })));
  assert.equal(unknown.success, false);
  const programme = schema(['fc_morning']).safeParse(
    showPayload(hydrateShow({ ...stored, formatClockId: 'fc_morning', programme: true })),
  );
  assert.equal(programme.success, false);
  // Shape-only when the clock list is not known yet.
  assert.equal(schema(null).safeParse(showPayload(hydrateShow({ ...stored, formatClockId: 'fc_morning' }))).success, true);
});
