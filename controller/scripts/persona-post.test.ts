// POST /personas, over real HTTP against a real state dir.
//
// The one-persona upsert an API or MCP client uses instead of posting the whole
// roster to /settings. It mirrors POST /shows: replace on id match, else
// append, and settings.update() validates the whole array. What this pins:
// a new persona gets a minted id and lands last; an edit replaces only its own
// row; the stored avatar survives any body (the upload route owns the file); a
// bad field is a 400 that names it; a full roster is a 409; and all of it
// survives a cold reload.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset (middleware/auth.ts),
// so the router mounts bare. Run: `npm test -- persona-post`.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listen as listenHttp } from './test-utils/http.js';
import { createTempDir } from './test-utils/temp-dir.js';

const testRoot = createTempDir(path.join(tmpdir(), 'subwave-persona-post-'));
const stateRoot = path.join(testRoot, 'state');
mkdirSync(stateRoot);
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { PERSONA_LIMIT } = await import('../src/schemas/persona.js');
const { router } = await import('../src/routes/personas.js');

const app = express();
app.use(express.json());
app.use(router);
const { server, url: base } = await listenHttp(app);
server.unref();

await settings.load();
const SEED = JSON.parse(JSON.stringify(settings.get().personas)) as Array<Record<string, any>>;

const VOICE = { engine: 'inherit', cloudProvider: 'openai', voice: '' };

async function reset() {
  await settings.update({ personas: SEED });
}

const post = (persona: Record<string, unknown>) =>
  fetch(`${base}/personas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });

async function coldReload() {
  setCache(null);
  await settings.load();
  return settings.get();
}

test('a persona with no id is added last with a minted id', async () => {
  await reset();
  const res = await post({ name: 'Night Owl', soul: 'A calm late-night voice.', frequency: 'quiet', tts: VOICE });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.match(body.persona.id, /^[a-z0-9_]{3,32}$/);
  assert.equal(body.persona.name, 'Night Owl');

  const after = await coldReload();
  assert.equal(after.personas.length, SEED.length + 1);
  assert.equal(after.personas.at(-1).id, body.persona.id, 'the new persona lands last');
  assert.deepEqual(
    after.personas.slice(0, SEED.length).map((p: any) => p.id),
    SEED.map((p) => p.id),
    'the rest of the roster is unchanged',
  );
});

test('a known id replaces only that persona, and the stored avatar survives', async () => {
  await reset();
  const target = SEED[1]!;
  // Give the stored persona an avatar as if one had been uploaded.
  await settings.update({
    personas: SEED.map((p) => (p.id === target.id ? { ...p, avatar: `${target.id}.png` } : p)),
  });

  const res = await post({ ...target, soul: 'Rewritten soul.', avatar: undefined });
  assert.equal(res.status, 200);

  const after = await coldReload();
  const edited = after.personas.find((p: any) => p.id === target.id);
  assert.equal(edited.soul, 'Rewritten soul.');
  assert.equal(edited.avatar, `${target.id}.png`, 'an absent avatar keeps the stored one');
  assert.equal(after.personas.length, SEED.length);
  for (const p of SEED.filter((q) => q.id !== target.id)) {
    assert.equal(after.personas.find((q: any) => q.id === p.id).soul, p.soul, `${p.id} is untouched`);
  }
});

test('a new persona never takes an avatar from the body', async () => {
  await reset();
  const res = await post({ name: 'Ghost', soul: 'Says little.', frequency: 'quiet', tts: VOICE, avatar: 'ghost_dj.png' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.persona.avatar, '');
});

test('a bad field is a 400 that names it, and nothing is written', async () => {
  await reset();
  const res = await post({ name: 'Loud', soul: 'x', frequency: 'constantly', tts: VOICE });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.match(body.error, /^frequency must be one of/, 'the message stands alone, without a doubled path');
  assert.ok(body.fieldErrors['persona.frequency'], 'fieldErrors carries the dotted path');
  const after = await coldReload();
  assert.equal(after.personas.length, SEED.length);
});

test('a full roster refuses a new persona with 409', async () => {
  const filler = Array.from({ length: PERSONA_LIMIT - SEED.length }, (_, i) => ({
    name: `Filler ${i}`,
    soul: 'Filler.',
    frequency: 'quiet',
    tts: VOICE,
  }));
  await settings.update({ personas: [...SEED, ...filler] });
  const res = await post({ name: 'One Too Many', soul: 'x', frequency: 'quiet', tts: VOICE });
  assert.equal(res.status, 409);
  await reset();
});
