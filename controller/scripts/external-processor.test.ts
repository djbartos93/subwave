// settings.processor: the external broadcast processor (radio.liq's EXTERNAL
// PROCESSOR block, docs/external-processor.md). The mixer sends its finished mix
// to a bridge over SRT, airs what comes back, and falls back to the dry mix
// whenever the return is not ready.
//
// Pinned here, each because it fails silently on its own:
//
//   1. Off by default, and an absent block is the pre-existing station: the
//      handoff file must say "false" so radio.liq builds nothing.
//   2. The block survives a cold load (load() composes explicitly, so a field
//      missing there vanishes on the next restart) and repairs field by field.
//   3. update() refuses what radio.liq would silently leave unbuilt: on with no
//      host, or one port for both legs. Any change flags a mixer restart; an
//      idempotent save does not.
//   4. The listener lead follows the RUNNING mixer's marker, and adds the delay
//      only while the processed return airs, never on the dry fallback, never
//      from a stale or absent marker.
//   5. A hosted station can neither save it nor build it.
//   6. radio.liq keeps the stage where the docs say: after the idle gate, before
//      the bus limiter, with the dry mix as the fallback.
//
// No containers and no network. Run: `npm test -- external-processor`.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-external-processor-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const {
  LIQ_PROCESSOR_ENABLED_PATH,
  LIQ_PROCESSOR_HOST_PATH,
  LIQ_PROCESSOR_SEND_PORT_PATH,
  LIQ_PROCESSOR_RETURN_PORT_PATH,
  LIQ_PROCESSOR_DELAY_MS_PATH,
} = await import('../src/settings/liquidsoap.js');
const { processorPatchSchema } = await import('../src/schemas/settings.js');
const {
  normalizeProcessorSettings,
  processorConfigIssue,
  processorLeadSeconds,
  processorStatus,
  PROCESSOR_MARKER_STALE_MS,
} = await import('../src/broadcast/processor-policy.js');
const { config } = await import('../src/config.js');
const { advertisedBufferSeconds } = await import('../src/broadcast/stream-mounts.js');
const { stripManagedSettings } = await import('../src/setup/hosted.js');
const { validateSettingsPatch } = await import('../src/settings/patch-registry.js');

async function coldLoad(processor: unknown) {
  return (await coldLoadSettings(processor === undefined ? {} : { processor })).processor;
}

const ON = { enabled: true, host: '192.168.1.50', sendPort: 9000, returnPort: 9001, delayMs: 2500 };

// ---------------------------------------------------------------------------
// 1. Off by default
// ---------------------------------------------------------------------------

test('an absent block is off, and the mixer is told so', async () => {
  const p = await coldLoad(undefined);
  assert.deepEqual(p, { enabled: false, host: '', sendPort: 9000, returnPort: 9001, delayMs: 0 });
  assert.deepEqual(DEFAULTS.processor, p);
  await settings.update({ station: 'SUB/WAVE test' });
  assert.equal(readFileSync(LIQ_PROCESSOR_ENABLED_PATH, 'utf8'), 'false');
  assert.equal(readFileSync(LIQ_PROCESSOR_HOST_PATH, 'utf8'), '');
  assert.equal(readFileSync(LIQ_PROCESSOR_SEND_PORT_PATH, 'utf8'), '9000');
  assert.equal(readFileSync(LIQ_PROCESSOR_RETURN_PORT_PATH, 'utf8'), '9001');
  assert.equal(readFileSync(LIQ_PROCESSOR_DELAY_MS_PATH, 'utf8'), '0');
});

// ---------------------------------------------------------------------------
// 2. Cold load and repair
// ---------------------------------------------------------------------------

test('a configured block survives a cold load', async () => {
  assert.deepEqual(await coldLoad(ON), ON);
});

test('load repairs each field on its own', async () => {
  const p = await coldLoad({ enabled: 'yes', host: 'bad host\nname', sendPort: 70000, returnPort: 9100, delayMs: -5 });
  assert.equal(p.enabled, false, 'only a literal true turns it on');
  assert.equal(p.host, '', 'a host the file cannot carry is dropped');
  assert.equal(p.sendPort, 9000);
  assert.equal(p.returnPort, 9100, 'a good sibling is kept');
  assert.equal(p.delayMs, 0);
  assert.deepEqual(normalizeProcessorSettings(null), DEFAULTS.processor);
});

// ---------------------------------------------------------------------------
// 3. Save rules, files and the restart flag
// ---------------------------------------------------------------------------

test('a save writes every handoff file radio.liq reads', async () => {
  await coldLoad(undefined);
  const r = await settings.update({ processor: ON });
  assert.equal(r.requiresRestart, true);
  assert.equal(readFileSync(LIQ_PROCESSOR_ENABLED_PATH, 'utf8'), 'true');
  assert.equal(readFileSync(LIQ_PROCESSOR_HOST_PATH, 'utf8'), '192.168.1.50');
  assert.equal(readFileSync(LIQ_PROCESSOR_SEND_PORT_PATH, 'utf8'), '9000');
  assert.equal(readFileSync(LIQ_PROCESSOR_RETURN_PORT_PATH, 'utf8'), '9001');
  assert.equal(readFileSync(LIQ_PROCESSOR_DELAY_MS_PATH, 'utf8'), '2500');
});

test('an idempotent save asks for no restart, a changed delay does', async () => {
  await coldLoad(ON);
  assert.equal((await settings.update({ processor: ON })).requiresRestart, false);
  assert.equal((await settings.update({ processor: { delayMs: 2600 } })).requiresRestart, true);
  assert.equal(settings.get().processor.host, '192.168.1.50', 'a partial patch keeps the rest');
});

test('on with no host, or one port for both legs, is refused', async () => {
  await coldLoad(undefined);
  await assert.rejects(settings.update({ processor: { enabled: true } }), /processor\.host is required/);
  await assert.rejects(
    settings.update({ processor: { ...ON, returnPort: 9000 } }),
    /must differ/,
  );
  assert.equal(settings.get().processor.enabled, false, 'a refused save changes nothing');
  // Off, a half-typed config may be parked.
  await settings.update({ processor: { enabled: false, host: '', sendPort: 9000, returnPort: 9000 } });
  assert.equal(processorConfigIssue(settings.get().processor), null);
});

test('turning it on can use a host saved earlier', async () => {
  await coldLoad({ ...ON, enabled: false });
  await settings.update({ processor: { enabled: true } });
  assert.equal(settings.get().processor.enabled, true);
});

test('the schema refuses a host the handoff file cannot carry', () => {
  for (const bad of ['two words', 'host\nname', 'a;b', 42, null]) {
    assert.equal(processorPatchSchema.safeParse({ host: bad }).success, false, `host=${JSON.stringify(bad)}`);
  }
  for (const good of ['', 'breakaway.lan', '10.0.0.5', 'fe80::1']) {
    assert.equal(processorPatchSchema.safeParse({ host: good }).success, true, `host=${good}`);
  }
  assert.equal(processorPatchSchema.safeParse({ sendPort: 0 }).success, false);
  assert.equal(processorPatchSchema.safeParse({ delayMs: 10001 }).success, false);
});

test('the key is in the route inventory, with field errors', () => {
  assert.equal(validateSettingsPatch({ processor: { delayMs: 100 } }), null);
  const bad = validateSettingsPatch({ processor: { sendPort: 'x' } });
  assert.ok(bad?.fieldErrors?.['processor.sendPort']);
});

// ---------------------------------------------------------------------------
// 4. The listener lead follows the running mixer
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const marker = (over: Record<string, unknown>) => ({
  enabled: true, onAir: 'processed', delayMs: 2500, since: NOW / 1000 - 60, at: NOW / 1000 - 5, ...over,
});

test('the delay counts only while the processed return airs', () => {
  assert.equal(processorLeadSeconds(processorStatus(marker({}), NOW)), 2.5);
  assert.equal(processorLeadSeconds(processorStatus(marker({ onAir: 'dry' }), NOW)), 0);
  assert.equal(processorLeadSeconds(processorStatus(marker({ enabled: false }), NOW)), 0);
});

test('an absent, stale or malformed marker adds nothing', () => {
  assert.equal(processorLeadSeconds(processorStatus(null, NOW)), 0);
  const stale = marker({ at: (NOW - PROCESSOR_MARKER_STALE_MS - 1000) / 1000 });
  assert.equal(processorLeadSeconds(processorStatus(stale, NOW)), 0);
  assert.equal(processorLeadSeconds(processorStatus(marker({ at: 'soon' }), NOW)), 0);
  assert.equal(processorLeadSeconds(processorStatus(marker({ onAir: 'maybe' }), NOW)), 0);
  assert.equal(processorLeadSeconds(processorStatus(marker({ delayMs: 99999 }), NOW)), 0);
});

test('the advertised buffer adds the running delay, not the saved one', async () => {
  await coldLoad({ ...ON, delayMs: 9000 });
  const base = advertisedBufferSeconds(Date.now() + 10_000);
  writeFileSync(
    config.liquidsoap.processorStatusFile,
    JSON.stringify(marker({ at: Date.now() / 1000, delayMs: 1500 })),
  );
  // Past the 2 s memo on both readers.
  const withProc = advertisedBufferSeconds(Date.now() + 20_000);
  assert.equal(Math.round((withProc - base) * 1000), 1500);
});

// ---------------------------------------------------------------------------
// 5. Hosted stations
// ---------------------------------------------------------------------------

test('a hosted station drops the key and never builds the stage', async () => {
  process.env.SUBWAVE_HOSTED = '1';
  try {
    const { patch, dropped } = stripManagedSettings({ processor: ON, crossfadeDuration: 8 });
    assert.equal('processor' in patch, false);
    assert.deepEqual(dropped, ['processor']);
    // A restored settings.json can still carry it; the handoff file says no.
    await coldLoad(ON);
    await settings.update({ station: 'SUB/WAVE hosted' });
    assert.equal(readFileSync(LIQ_PROCESSOR_ENABLED_PATH, 'utf8'), 'false');
  } finally {
    delete process.env.SUBWAVE_HOSTED;
  }
});

// ---------------------------------------------------------------------------
// 6. Where radio.liq builds it
// ---------------------------------------------------------------------------

test('radio.liq builds the stage after the idle gate, before the bus limiter', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const liq = readFileSync(path.join(here, '../../liquidsoap/radio.liq'), 'utf8');
  const idle = liq.indexOf('id="idle_gate"');
  const stage = liq.indexOf('fallback(id="processor_fallback", track_sensitive=false, [processed, radio])');
  const limiter = liq.indexOf('radio = compress(');
  assert.ok(idle > 0 && stage > idle, 'the stage must see the idle gate');
  assert.ok(limiter > stage, 'the limiter must catch the processed return too');
  // The send follows the on-air lifecycle, so an off-air mixer stops pulling.
  assert.match(liq, /id="processor_send",[\s\S]*?start=false,/);
  assert.match(liq, /def stream_up\(\)[\s\S]*?start_processor\(\)/);
  assert.match(liq, /def stream_down\(\)[\s\S]*?stop_processor\(\)/);
});
