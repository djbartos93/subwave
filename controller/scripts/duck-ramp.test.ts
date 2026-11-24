// settings.duckRamp: how long each duck layer takes to pull the music down
// when a clip starts and to bring it back up when it ends, as a range per
// direction that radio.liq's smooth_duck draws inside for every clip
// (broadcast/duck-ramp-policy.ts, liquidsoap/radio.liq DUCKING).
//
// Pinned here, each because it fails silently on its own:
//
//   1. The defaults are the durations radio.liq shipped as smooth_add
//      literals (0.8 s on both voice layers, 0.3 s on sfx), fixed, so an
//      upgrade sounds the same, and the controller's speech budget at the
//      defaults is the old 800 ms lead-in and 700 ms tail.
//   2. The block survives a cold load and repairs field by field; the save
//      path refuses what the load path repairs, including a min above its max.
//      A change flags a mixer restart; an idempotent save does not.
//   3. Each voice layer gets a silent lead-in as long as its longest down
//      ramp, named by its length so a save never rewrites the file a running
//      mixer picked, and boot refills a missing one.
//   4. The controller budgets by the ramps the RUNNING mixer loaded
//      (duck-ramps.json), never the saved setting.
//   5. radio.liq agrees: three smooth_duck layers on their own ramps, the same
//      defaults and bounds, and the same lead-in file name.
//
// Run: `npm test -- duck-ramp`.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { coldLoadSettings } from './test-utils/settings.js';

const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { STATE_DIR, config } = await import('../src/config.js');
const { liqDuckRampPath, LEADIN_DIR, ensureLeadinWavs } = await import('../src/settings/liquidsoap.js');
const { DUCK_RAMP_SEC_BOUNDS, duckRampPatchSchema } = await import('../src/schemas/settings.js');
const policy = await import('../src/broadcast/duck-ramp-policy.js');
const status = await import('../src/broadcast/duck-ramp-status.js');
const voiceIo = await import('../src/broadcast/queue/voice-io.js');

const liq = readFileSync(
  fileURLToPath(new URL('../../liquidsoap/radio.liq', import.meta.url)),
  'utf8',
);

const ramp = (downMin: number, downMax: number, upMin: number, upMax: number) =>
  ({ downMin, downMax, upMin, upMax });

// The memo in duck-ramp-status.ts holds a read for 2 s; tests step the clock
// past it instead of waiting.
let clock = Date.now();
const later = () => (clock += 10_000);

// ---------------------------------------------------------------------------
// 1. Defaults
// ---------------------------------------------------------------------------

test('the defaults are the durations radio.liq shipped, fixed', async () => {
  const s = await coldLoadSettings({});
  assert.deepEqual(s.duckRamp, {
    voice: ramp(0.8, 0.8, 0.8, 0.8),
    intro: ramp(0.8, 0.8, 0.8, 0.8),
    sfx: ramp(0.3, 0.3, 0.3, 0.3),
  });
  assert.deepEqual(DEFAULTS.duckRamp, s.duckRamp);
});

test('at the defaults the speech budget is the old 800 ms lead-in and 700 ms tail', () => {
  assert.equal(policy.leadinMsFor(policy.DUCK_RAMP_DEFAULTS), 800);
  assert.equal(policy.tailMsFor(policy.DUCK_RAMP_DEFAULTS), 700);
  assert.equal(voiceIo.VOICE_LEADIN_MS, 800);
  assert.equal(voiceIo.VOICE_TAIL_MS, 700);
  assert.equal(voiceIo.HANDOFF_TO_AIR_MS, 1050);
});

// ---------------------------------------------------------------------------
// 2. Load, save, restart
// ---------------------------------------------------------------------------

test('a configured block survives a cold load', async () => {
  const stored = { voice: ramp(0.4, 1.6, 1, 3), intro: ramp(0.5, 0.5, 2, 2), sfx: ramp(0.1, 0.2, 0.3, 0.4) };
  const s = await coldLoadSettings({ duckRamp: stored });
  assert.deepEqual(s.duckRamp, stored);
});

test('the load path repairs field by field, and swaps a reversed pair', async () => {
  const s = await coldLoadSettings({
    duckRamp: { voice: { downMin: 9, downMax: 1.2, upMin: 'x', upMax: 2 }, intro: { downMin: 2, downMax: 1 } },
  });
  // downMin 9 is out of bounds and falls back to 0.8; upMin 'x' falls back too.
  assert.deepEqual(s.duckRamp.voice, ramp(0.8, 1.2, 0.8, 2));
  // Both in bounds but the wrong way round: swapped, not dropped.
  assert.deepEqual(s.duckRamp.intro, ramp(1, 2, 0.8, 0.8));
  assert.deepEqual(s.duckRamp.sfx, DEFAULTS.duckRamp.sfx);
});

test('the save path refuses out-of-bounds seconds, naming the layer and field', () => {
  for (const bad of [0, 0.05, 5.5, 'slow']) {
    const r = duckRampPatchSchema.safeParse({ intro: { upMax: bad } });
    assert.equal(r.success, false, `upMax=${JSON.stringify(bad)} should be refused`);
    assert.match(String(r.error), /duckRamp\.intro\.upMax must be a number of seconds in \[0\.1, 5\]/);
  }
  assert.equal(duckRampPatchSchema.safeParse({ voice: { downMin: DUCK_RAMP_SEC_BOUNDS.min, downMax: DUCK_RAMP_SEC_BOUNDS.max } }).success, true);
});

test('update() refuses a min above its max, judged on the merged block', async () => {
  await coldLoadSettings({ duckRamp: { voice: ramp(0.5, 1, 0.8, 0.8) } });
  // Only one end moves, and it crosses the saved other end.
  await assert.rejects(
    () => settings.update({ duckRamp: { voice: { downMin: 1.5 } } }),
    /duckRamp\.voice\.downMin must not be above duckRamp\.voice\.downMax/,
  );
  assert.deepEqual(settings.get().duckRamp.voice, ramp(0.5, 1, 0.8, 0.8), 'the refused save changed nothing');
});

test('a change flags a mixer restart, an idempotent save does not', async () => {
  await coldLoadSettings({});
  const changed = await settings.update({ duckRamp: { voice: { upMin: 1, upMax: 2 } } });
  assert.equal(changed.requiresRestart, true);
  const same = await settings.update({ duckRamp: { voice: { upMin: 1, upMax: 2 } } });
  assert.equal(same.requiresRestart, false);
  assert.deepEqual(settings.get().duckRamp.voice, ramp(0.8, 0.8, 1, 2));
});

test('a save writes one handoff file per layer', async () => {
  await coldLoadSettings({});
  await settings.update({ duckRamp: { intro: { downMin: 0.5, downMax: 1.25 } } });
  assert.equal(readFileSync(liqDuckRampPath('voice'), 'utf8'), '0.8 0.8 0.8 0.8');
  assert.equal(readFileSync(liqDuckRampPath('intro'), 'utf8'), '0.5 1.25 0.8 0.8');
  assert.equal(readFileSync(liqDuckRampPath('sfx'), 'utf8'), '0.3 0.3 0.3 0.3');
});

// ---------------------------------------------------------------------------
// 3. Lead-ins
// ---------------------------------------------------------------------------

function wavSeconds(path: string): number {
  const b = readFileSync(path);
  const byteRate = b.readUInt32LE(28);
  return b.readUInt32LE(40) / byteRate;
}

test('each voice layer gets a lead-in as long as its longest down ramp', async () => {
  await coldLoadSettings({});
  await settings.update({ duckRamp: { voice: { downMin: 0.5, downMax: 1.5 } } });
  const voiceLeadin = join(LEADIN_DIR, 'leadin-1500ms.wav');
  assert.equal(policy.leadinFileName(settings.get().duckRamp.voice), 'leadin-1500ms.wav');
  assert.ok(Math.abs(wavSeconds(voiceLeadin) - 1.5) < 0.001);
  assert.ok(existsSync(join(LEADIN_DIR, 'leadin-800ms.wav')), 'the intro layer keeps its own');
});

test('a lead-in on disk is never rewritten, and boot refills a missing one', async () => {
  const s = await coldLoadSettings({ duckRamp: { voice: ramp(2, 2, 0.8, 0.8) } });
  const path = join(LEADIN_DIR, 'leadin-2000ms.wav');
  rmSync(path, { force: true });
  await ensureLeadinWavs(s);
  assert.ok(existsSync(path), 'boot wrote the missing lead-in');
  const before = statSync(path).mtimeMs;
  await ensureLeadinWavs(s);
  assert.equal(statSync(path).mtimeMs, before, 'an existing lead-in is left alone');
});

// ---------------------------------------------------------------------------
// 4. The controller budgets by the running mixer
// ---------------------------------------------------------------------------

test('no marker reads as the defaults a pre-marker mixer runs', () => {
  rmSync(config.liquidsoap.duckRampsFile, { force: true });
  assert.deepEqual(status.currentDuckRamps(later()), policy.DUCK_RAMP_DEFAULTS);
  assert.equal(status.voiceLeadinMs(later()), 800);
  assert.equal(status.voiceTailMs(later()), 700);
});

test('the budget follows the marker, not a saved setting', async () => {
  await coldLoadSettings({ duckRamp: { voice: ramp(3, 3, 3, 3) } });
  writeFileSync(config.liquidsoap.duckRampsFile, JSON.stringify({
    voice: ramp(0.5, 1.5, 1, 3),
    intro: ramp(0.8, 1.2, 0.8, 0.8),
    sfx: ramp(0.3, 0.3, 0.3, 0.3),
  }));
  // The longer of the two voice layers' downMax; the tail grows by however
  // much the longest release passes the default 0.8 s.
  assert.equal(status.voiceLeadinMs(later()), 1500);
  assert.equal(status.voiceTailMs(later()), 700 + (3000 - 800));
  // A shorter release never shrinks the tail.
  assert.equal(policy.tailMsFor({ ...policy.DUCK_RAMP_DEFAULTS, voice: ramp(0.2, 0.2, 0.2, 0.2) }), 700);
  rmSync(config.liquidsoap.duckRampsFile, { force: true });
});

test('STATE_DIR holds the marker the mixer writes', () => {
  assert.equal(config.liquidsoap.duckRampsFile, `${STATE_DIR}/duck-ramps.json`);
  assert.match(liq, /"#\{state_dir\}\/duck-ramps\.json"/);
});

// ---------------------------------------------------------------------------
// 5. radio.liq agrees
// ---------------------------------------------------------------------------

test('three smooth_duck layers, each on its own ramp, and no smooth_add left', () => {
  // Each call's arguments run to the `)` alone on its line: p={duck_voice()}
  // holds a `)` of its own.
  const calls = [...liq.matchAll(/= smooth_duck\(\n([\s\S]*?)\n\)/g)].map((m) => m[1]);
  assert.equal(calls.length, 3);
  const bySpecial = (sp: string) => calls.find((c) => new RegExp(`special\\s*=\\s*${sp}\\b`).test(c)) ?? '';
  assert.match(bySpecial('voice'), /ramp\s*=\s*duck_ramp_voice\b/);
  assert.match(bySpecial('intro'), /ramp\s*=\s*duck_ramp_intro\b/);
  assert.match(bySpecial('sfx_bed'), /ramp\s*=\s*duck_ramp_sfx\b/);
  assert.equal(/^\s*\w+\s*=\s*smooth_add\(/m.test(liq), false, 'every duck layer is smooth_duck');
});

test('radio.liq reads the same defaults and bounds the controller writes', () => {
  for (const layer of ['voice', 'intro', 'sfx'] as const) {
    const d = DEFAULTS.duckRamp[layer];
    const list = `[${[d.downMin, d.downMax, d.upMin, d.upMax].map((n) => (Number.isInteger(n) ? `${n}.` : String(n))).join(', ')}]`;
    assert.ok(
      liq.includes(`duck_ramp_${layer} = read_duck_ramp("${layer}", ${list})`),
      `radio.liq's ${layer} default is ${list}`,
    );
  }
  assert.match(liq, /x >= 0\.1 and x <= 5\./);
  assert.equal(DUCK_RAMP_SEC_BOUNDS.min, 0.1);
  assert.equal(DUCK_RAMP_SEC_BOUNDS.max, 5);
  assert.equal(policy.rampFileContents(ramp(0.5, 1, 2, 3)), '0.5 1 2 3');
});

test('radio.liq names the lead-in the way the controller writes it', () => {
  assert.match(liq, /ms = int_of_float\(floor\(list\.nth\(ramp, 1\) \* 1000\. \+ 0\.5\)\)/);
  assert.match(liq, /"#\{state_dir\}\/leadin\/leadin-#\{ms\}ms\.wav"/);
  assert.equal(LEADIN_DIR, `${STATE_DIR}/leadin`);
  assert.equal(policy.rampMs(0.29), 290);
  assert.equal(policy.rampMs(1.25), 1250);
});

test('smooth_duck draws per direction and keeps the stdlib shape', () => {
  const body = liq.slice(liq.indexOf('def smooth_duck('), liq.indexOf('\nend\n', liq.indexOf('def smooth_duck(')));
  assert.match(body, /d = draw\(list\.nth\(ramp, 0\), list\.nth\(ramp, 1\)\)/, 'down ramp drawn on to_special');
  assert.match(body, /d = draw\(list\.nth\(ramp, 2\), list\.nth\(ramp, 3\)\)/, 'up ramp drawn on to_blank');
  assert.match(body, /if hi > lo then random\.float\(min=lo, max=hi\) else lo end/, 'a fixed ramp draws nothing');
  assert.match(body, /normal_volume := mkfade\(start=1\., stop=last_p\(\), duration=d, normal\)/);
  assert.match(body, /special_volume := mkfade\(stop=q, duration=d, special\)/);
  assert.match(body, /add\(normalize=false, \[normal, special\]\)/);
});
