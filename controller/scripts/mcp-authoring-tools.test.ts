// The MCP authoring tools (src/mcp/authoring-tools.ts), driven through a real
// McpServer + Client pair against a fake SubwaveClient that records every
// write. The controller routes behind them have their own tests; what is
// pinned here is the tool-side work: an update sends the stored record with
// only the given fields changed, a persona's voice is merged and defaulted,
// the schedule tool touches only the hours it names, an unknown id never
// reaches a write, and the trust step for skill code is not exposed at all.
//
// Run: `npm test -- mcp-authoring-tools`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerSubwaveTools } from '../src/mcp/tools.js';
import { applyScheduleSlots, withVoiceDefaults } from '../src/mcp/authoring-tools.js';
import type { SubwaveClient } from '../src/mcp/client.js';

type Row = Record<string, any>;

const emptyWeek = () => Object.fromEntries(Array.from({ length: 7 }, (_, d) => [d, Array(24).fill(null)]));

function fakeClient() {
  const writes: Array<{ method: string; args: unknown[] }> = [];
  const state = {
    personas: [
      {
        id: 'p_night',
        name: 'Night Owl',
        soul: 'Calm.',
        frequency: 'quiet',
        avatar: 'p_night.png',
        tts: { engine: 'kokoro', voice: 'af_heart', cloudProvider: 'openai', gainDb: 2, speed: 1 },
      },
    ] as Row[],
    shows: [{ id: 's_late', name: 'Late', personaId: 'p_night', genres: ['ambient'], topic: 'Slow.' }] as Row[],
    schedule: emptyWeek() as Row,
  };
  state.schedule[1][9] = 's_other';

  const record = (method: string) => async (...args: unknown[]) => {
    writes.push({ method, args });
    const first = args[0] as Row;
    if (method === 'savePersona') return { persona: { id: first.id ?? 'p_new', name: first.name } };
    if (method === 'saveShow') return { show: { id: first.id ?? 's_new', name: first.name } };
    if (method === 'saveSchedule') return { schedule: first, dropped: 0 };
    if (method === 'setSkillPersonas') return { personas: [{ id: 'p_night', name: 'Night Owl', hasSkill: true }] };
    return { skills: [{ name: String(first), label: 'Label', enabled: method === 'toggleSkill', custom: true }] };
  };

  const client: Partial<SubwaveClient> = {
    adminSettings: async () => ({
      values: { personas: state.personas, activePersonaId: 'p_night', shows: state.shows, schedule: state.schedule as any },
    }),
    getSkillFile: async () => ({
      kind: 'dabbers',
      custom: true,
      exists: true,
      label: 'Dabbers',
      cooldown: '6h',
      context: 'clock, show',
      cron: '10 7 * * *',
      cronOnly: true,
      cohosts: false,
      voice: null,
      config: {},
      tags: ['bingo'],
      brief: 'Old brief.',
      window: 'any',
      requiresKey: '',
      // Read-only fields PUT must not receive back.
      hasTool: false,
      toolPending: false,
      knownContextFields: ['clock'],
      configFields: [],
    }),
    savePersona: record('savePersona') as any,
    saveShow: record('saveShow') as any,
    saveSchedule: record('saveSchedule') as any,
    createSkill: (async (body: Row) => {
      writes.push({ method: 'createSkill', args: [body] });
      return { skills: [{ name: body.name, label: body.name, enabled: false, custom: true }] };
    }) as any,
    updateSkill: (async (name: string, body: Row) => {
      writes.push({ method: 'updateSkill', args: [name, body] });
      return { skills: [{ name, label: 'Dabbers', enabled: false, custom: true }] };
    }) as any,
    toggleSkill: record('toggleSkill') as any,
    setSkillPersonas: record('setSkillPersonas') as any,
  };
  return { client, writes };
}

async function connect(client: Partial<SubwaveClient>) {
  const server = new McpServer({ name: 'test', version: '0' });
  registerSubwaveTools(server, client as SubwaveClient);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test-client', version: '0' });
  await server.connect(serverSide);
  await mcp.connect(clientSide);
  return mcp;
}

async function call(client: Partial<SubwaveClient>, name: string, args: Row) {
  const mcp = await connect(client);
  try {
    return await mcp.callTool({ name, arguments: args });
  } finally {
    await mcp.close();
  }
}

test('update_persona sends the stored persona with only the given fields changed', async () => {
  const { client, writes } = fakeClient();
  const res = await call(client, 'subwave_update_persona', { id: 'p_night', soul: 'New soul.', tts: { voice: 'bf_emma' } });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.equal(writes.length, 1);
  const sent = writes[0]!.args[0] as Row;
  assert.equal(sent.id, 'p_night');
  assert.equal(sent.soul, 'New soul.');
  assert.equal(sent.name, 'Night Owl', 'an untouched field keeps its stored value');
  assert.deepEqual(
    sent.tts,
    { engine: 'kokoro', voice: 'bf_emma', cloudProvider: 'openai', gainDb: 2, speed: 1 },
    'a partial voice merges into the stored one',
  );
});

test('update_persona with an unknown id writes nothing', async () => {
  const { client, writes } = fakeClient();
  const res = await call(client, 'subwave_update_persona', { id: 'p_nope', soul: 'x' });
  assert.equal(res.isError, true);
  assert.match(String((res.content as Row[])[0]!.text), /No persona with id 'p_nope'/);
  assert.equal(writes.length, 0);
});

test('create_persona without a voice inherits the station voice', async () => {
  const { client, writes } = fakeClient();
  const res = await call(client, 'subwave_create_persona', { name: 'Ghost', soul: 'Quiet.', frequency: 'quiet' });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const sent = writes[0]!.args[0] as Row;
  assert.deepEqual(sent.tts, { engine: 'inherit', voice: '', cloudProvider: 'openai' });
  assert.equal('id' in sent, false, 'a create sends no id, so the controller mints one');
});

test('withVoiceDefaults never invents a provider for a cloud voice', () => {
  assert.deepEqual(withVoiceDefaults({ engine: 'cloud', voice: 'alloy' }), { engine: 'cloud', voice: 'alloy' });
  assert.equal(withVoiceDefaults({ engine: 'piper' }).cloudProvider, 'openai');
  assert.equal(withVoiceDefaults({ engine: 'cloud', cloudProvider: 'elevenlabs' }).cloudProvider, 'elevenlabs');
});

test('update_show keeps every stored field it was not given', async () => {
  const { client, writes } = fakeClient();
  const res = await call(client, 'subwave_update_show', { id: 's_late', genres: ['shoegaze'] });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.deepEqual(writes[0]!.args[0], {
    id: 's_late',
    name: 'Late',
    personaId: 'p_night',
    genres: ['shoegaze'],
    topic: 'Slow.',
  });
});

test('schedule_show sets only the named hours and leaves the rest of the grid', async () => {
  const { client, writes } = fakeClient();
  const res = await call(client, 'subwave_schedule_show', { showId: 's_late', days: [5, 6], startHour: 22, endHour: 24 });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const week = writes[0]!.args[0] as Row;
  assert.equal(week[5][22], 's_late');
  assert.equal(week[6][23], 's_late');
  assert.equal(week[5][21], null);
  assert.equal(week[1][9], 's_other', 'another show keeps its hour');
  assert.deepEqual(res.structuredContent, { showId: 's_late', slots: 4 });
});

test('schedule_show refuses a backwards run and an unknown show before any write', async () => {
  const { client, writes } = fakeClient();
  const backwards = await call(client, 'subwave_schedule_show', { showId: 's_late', days: [1], startHour: 22, endHour: 2 });
  assert.equal(backwards.isError, true);
  const unknown = await call(client, 'subwave_schedule_show', { showId: 's_nope', days: [1], startHour: 1, endHour: 2 });
  assert.equal(unknown.isError, true);
  assert.equal(writes.length, 0);
});

test('applyScheduleSlots with null clears hours', () => {
  const week = emptyWeek() as Row;
  week[0][3] = 's_a';
  week[0][4] = 's_a';
  const next = applyScheduleSlots(week, [0], 3, 4, null);
  assert.equal(next[0]![3], null);
  assert.equal(next[0]![4], 's_a');
  assert.equal(week[0][3], 's_a', 'the input grid is not mutated');
});

test('update_skill sends back only the writable SKILL.md fields, with the change applied', async () => {
  const { client, writes } = fakeClient();
  const res = await call(client, 'subwave_update_skill', { name: 'dabbers', brief: 'New brief.' });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const [name, body] = writes[0]!.args as [string, Row];
  assert.equal(name, 'dabbers');
  assert.equal(body.brief, 'New brief.');
  assert.equal(body.cron, '10 7 * * *');
  assert.equal(body.context, 'clock, show');
  for (const readOnly of ['hasTool', 'toolPending', 'knownContextFields', 'configFields', 'kind', 'custom', 'exists']) {
    assert.equal(readOnly in body, false, `${readOnly} is not sent back`);
  }
});

test('create_skill reports the new skill as disabled', async () => {
  const { client } = fakeClient();
  const res = await call(client, 'subwave_create_skill', { name: 'dabbers', brief: 'Call the numbers.' });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.deepEqual(res.structuredContent, { name: 'dabbers', label: 'dabbers', enabled: false, custom: true });
});

test('no tool can trust a skill\'s code', async () => {
  const mcp = await connect({});
  try {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('subwave_create_skill'), 'the authoring tools are registered');
    assert.equal(names.some((n) => /trust/.test(n)), false);
  } finally {
    await mcp.close();
  }
});
