// The hourly time check switch (settings.djBehaviour.hourlyTimeCheck →
// broadcast/clock-policy.ts hourlySlotPlan) and the show welcome that rides the
// same :00 slot.
//
// Four properties are load-bearing:
//
//  - OFF is opt-in only. A settings.json written before the key existed, or a
//    non-boolean written by hand, reads as ON, so an upgrade still airs the
//    time check. Pinned by a cold load, because load() composes djBehaviour
//    field by field and a field missing there saves fine and then vanishes.
//  - OFF drops only the time check. With showWelcome on, the hour that starts
//    a scheduled show still airs its welcome; a plain hour airs nothing.
//  - A show welcome is not a routine check, so a quiet persona's
//    every-other-hour cadence never skips it.
//  - The welcome-only prompt carries no clock reading: no time clause and no
//    "Local time:" numerals, while the daypart tags stay.
//
// Run: `npm test -- hourly-time-check`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chatCompletionResponse } from './test-utils/llm.js';
import { coldLoadSettings } from './test-utils/settings.js';

const settings = await import('../src/settings.js');
const { decideHourlySlot, hourlySlotPlan, hourlyTimeCheckEnabled, autoTimeCheckAllowed } =
  await import('../src/broadcast/clock-policy.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');
const { generateHourlyTime } = await import('../src/llm/dj.js');

// Hour 10 is even and hour 11 odd, which is what the quiet rung reads.
const at = (hour: number, minute = 0) => new Date(2026, 0, 15, hour, minute, 0);

async function setFrequency(frequency: string) {
  await settings.update({
    personas: settings.get().personas.map((p: { id: string }, i: number) =>
      (i === 0 ? { ...p, frequency, djMode: false } : p)),
  });
}

test('the slot decision covers every combination', () => {
  for (const timeCheckAllowed of [true, false]) {
    for (const welcomeOn of [true, false]) {
      for (const showStarted of [true, false]) {
        assert.deepEqual(
          decideHourlySlot({ timeCheckAllowed, welcomeOn, showStarted }),
          { timeCheck: timeCheckAllowed, welcome: welcomeOn && showStarted },
          JSON.stringify({ timeCheckAllowed, welcomeOn, showStarted }),
        );
      }
    }
  }
});

test('absent or malformed reads as ON, and a saved OFF survives a cold load', async () => {
  await coldLoadSettings({});
  assert.equal(settings.get().djBehaviour.hourlyTimeCheck, true);
  assert.equal(hourlyTimeCheckEnabled(), true);

  await coldLoadSettings({ djBehaviour: { hourlyTimeCheck: 'false' } });
  assert.equal(hourlyTimeCheckEnabled(), true, 'a non-boolean on disk coerces to ON, never OFF');

  await settings.update({ djBehaviour: { hourlyTimeCheck: false } });
  const saved = JSON.parse(JSON.stringify(settings.get()));
  await coldLoadSettings(saved);
  assert.equal(settings.get().djBehaviour.hourlyTimeCheck, false, 'OFF survives a controller restart');
  assert.equal(autoTimeCheckAllowed(), false);

  await settings.update({ djBehaviour: { hourlyTimeCheck: true } });
  assert.equal(autoTimeCheckAllowed(), true);
});

test('a non-boolean is refused on save', async () => {
  await assert.rejects(
    () => settings.update({ djBehaviour: { hourlyTimeCheck: 'no' } } as never),
    /djBehaviour.hourlyTimeCheck must be a boolean/,
  );
  assert.equal(hourlyTimeCheckEnabled(), true, 'the refused write left the switch alone');
});

test('time check off: a plain hour airs nothing, a show change airs only its welcome', async () => {
  await coldLoadSettings({});
  await setFrequency('aggressive');
  assert.equal(shouldFire('hourly', at(10)), true, 'baseline: the time check fires');

  await settings.update({ djBehaviour: { hourlyTimeCheck: false, showWelcome: true } });
  assert.equal(shouldFire('hourly', at(10)), false, 'a plain hour boundary stays silent');
  assert.equal(shouldFire('hourly', at(10), { showStarted: true }), true, 'a show change still fires');
  assert.deepEqual(hourlySlotPlan({ showStarted: true }), { timeCheck: false, welcome: true });

  await settings.update({ djBehaviour: { showWelcome: false } });
  assert.equal(shouldFire('hourly', at(10), { showStarted: true }), false,
    'with the welcome off too, a show change has nothing to air');

  // The idents and banter never read this switch.
  assert.equal(shouldFire('stationId', at(10, 15)), true);
  await settings.update({ djBehaviour: { hourlyTimeCheck: true, showWelcome: false } });
});

test('the clock switch stands the time check down the same way, keeping the welcome', async () => {
  await coldLoadSettings({});
  await setFrequency('aggressive');
  await settings.update({ djSpeakClock: false, djBehaviour: { showWelcome: true } });
  assert.equal(shouldFire('hourly', at(10)), false);
  assert.deepEqual(hourlySlotPlan({ showStarted: true }), { timeCheck: false, welcome: true });
  await settings.update({ djSpeakClock: true, djBehaviour: { showWelcome: false } });
});

test('a quiet persona skips odd hours, but never a show welcome', async () => {
  await coldLoadSettings({});
  await setFrequency('quiet');
  assert.equal(shouldFire('hourly', at(11)), false, 'baseline: quiet skips an odd hour');
  assert.equal(shouldFire('hourly', at(11), { showStarted: true }), false,
    'with the welcome off, a show change on an odd hour is still skipped');
  await settings.update({ djBehaviour: { showWelcome: true } });
  assert.equal(shouldFire('hourly', at(11), { showStarted: true }), true);
  await settings.update({ djBehaviour: { hourlyTimeCheck: false } });
  assert.equal(shouldFire('hourly', at(11), { showStarted: true }), true);
  await settings.update({ djBehaviour: { hourlyTimeCheck: true, showWelcome: false } });
});

async function capturePrompt(args: Record<string, unknown>) {
  const originalLlm = structuredClone(settings.get().llm);
  const realFetch = globalThis.fetch;
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  try {
    await settings.update({ llm: {
      provider: 'openai-compatible', model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false },
    } });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      assert.ok(url.startsWith('http://127.0.0.1:9/'), `unexpected external request: ${url}`);
      requests.push(JSON.parse(String(init?.body)));
      return chatCompletionResponse({ id: 'chatcmpl-welcome',
        message: { role: 'assistant', content: 'A fixture line.' },
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
    }) as typeof fetch;
    await generateHourlyTime({ persona: { name: 'Tom', soul: 'Warm.' }, ...args });
    assert.equal(requests.length, 1);
    const messages = requests[0].messages;
    return {
      system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
      user: messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
    };
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm });
  }
}

const context = {
  clock: { display: '9:00 pm', hhmm: '21:00', spokenHour: 'nine in the evening', spokenTime: 'nine o\'clock', isDark: true },
  activeShow: { name: 'Night Shift' },
};

test('the welcome-only prompt carries no clock reading', async () => {
  await coldLoadSettings({});
  const { user, system } = await capturePrompt({ context, showWelcome: true, timeCheck: false });
  assert.match(user, /"Night Shift"/);
  assert.match(user, /Do not state the time or the hour/);
  assert.doesNotMatch(user, /9:00|21:00|nine/i, 'no clock numerals or spoken time');
  assert.doesNotMatch(user, /time check/i, 'not told to give a time check');
  assert.match(user, /Vibe: after dark/, 'the daypart tags stay');
  assert.match(system, /For this show welcome, do not mention weather/);

  // The ordinary time check is unchanged and still announces the time.
  const timeCheck = await capturePrompt({ context, showWelcome: true });
  assert.match(timeCheck.user, /Local time: 9:00 pm/);
  assert.match(timeCheck.user, /top-of-the-hour time check/);
});
