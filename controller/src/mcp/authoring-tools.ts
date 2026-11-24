/**
 * Admin authoring tools: create, edit and delete personas, shows and skills,
 * and place shows on the weekly schedule. Every tool here is ADMIN-only.
 *
 * Each write goes to the same controller route the admin panel uses, and the
 * controller validates it with the shared schema, so the input schemas below
 * only describe the fields to the agent. They are deliberately loose: a rule
 * restated here would drift from the real one, and the controller's 400 names
 * the field that failed.
 *
 * An update tool takes only the fields to change. It reads the stored record,
 * lays the given fields over it and saves the whole record back, because the
 * persona and show routes replace the record they are given. That read-then-
 * write can lose an edit made to the SAME record in the admin panel between the
 * two calls; other records are untouched.
 *
 * Deliberately absent: trusting a skill's tool.mjs code. Code only goes live
 * after an operator reviews it in the admin panel (POST
 * /dj/skills/:slug/tool/trust), and an agent that could both write and trust
 * a skill could run anything it wrote on the controller.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SubwaveError, type ScheduleWeek, type SkillCatalogEntry, type SubwaveClient } from "./client.js";
import { output, run, text } from "./tool-result.js";
// Zod-only modules, so they resolve in the standalone stdio server's build too.
import {
  PERSONA_FREQUENCIES,
  PERSONA_IDENT_MODES,
  PERSONA_LINK_STYLES,
  PERSONA_NAME_MAX,
  PERSONA_SCRIPT_LENGTHS,
  PERSONA_SOUL_MAX,
  PERSONA_TTS_ENGINES,
} from "../schemas/persona.js";
import { ALBUM_KINDS, SHOW_ENERGY, SHOW_NAME_MAX, SHOW_TOPIC_MAX, SHOW_VOCALS } from "../schemas/show.js";
import { CONTEXT_FIELDS, SKILL_WINDOWS } from "../schemas/skill.js";

type Row = Record<string, unknown>;

/** Drop keys the caller left out, so an update never clears a field by omission. */
function given(fields: Row): Row {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

const RECORD = output({ id: z.string(), name: z.string() });

// ----------------------------------------------------------------- personas --

const voiceSlot = z
  .object({
    engine: z
      .enum(PERSONA_TTS_ENGINES)
      .describe("TTS engine. 'inherit' uses the station's default voice. List installed voices with subwave_list_personas."),
    voice: z.string().optional().describe("Voice id for that engine, e.g. 'af_heart' (kokoro) or 'en_US-amy-medium.onnx' (piper)."),
    cloudProvider: z.string().optional().describe("Only for engine 'cloud': openai, elevenlabs, …"),
    gainDb: z.number().optional().describe("Loudness trim in dB, -12..12."),
    speed: z.number().optional().describe("Speaking rate, 0.5..2.0 (1.0 normal)."),
  })
  .describe("The persona's on-air voice.");

const PERSONA_FIELDS = {
  name: z.string().max(PERSONA_NAME_MAX).describe(`On-air name, 1-${PERSONA_NAME_MAX} chars.`),
  soul: z
    .string()
    .max(PERSONA_SOUL_MAX)
    .describe(
      `Who this DJ is, in prose, 1-${PERSONA_SOUL_MAX} chars. This is the DJ's system prompt and goes straight ` +
        "into every line they speak on air.",
    ),
  tagline: z.string().describe("Short public description, up to 80 chars."),
  musicLean: z.string().describe("Private music preference that leans picks, up to 500 chars. Never overrides show filters."),
  language: z.string().describe("On-air language as free text, e.g. 'Spanish'. Empty is English."),
  alsoSpeaks: z.string().describe("Comma-separated languages this DJ mixes in. Empty for one language."),
  voiceStyle: z.string().describe("Delivery direction for voices that take one, up to 150 chars."),
  frequency: z.enum(PERSONA_FREQUENCIES).describe("How often the DJ talks between tracks."),
  scriptLength: z.enum(PERSONA_SCRIPT_LENGTHS).describe("How long each spoken line runs."),
  linkStyle: z.enum(PERSONA_LINK_STYLES).describe("'natural' links, or 'announce' (just 'This is <artist>.')."),
  identMode: z.enum(PERSONA_IDENT_MODES).describe("Station IDs: improvised, or read verbatim from identLines."),
  identLines: z.array(z.string()).describe("Station ID lines for identMode 'verbatim', up to 20."),
  djMode: z.boolean().describe("Chattier, club-DJ delivery with transition effects."),
  humour: z.number().min(0).max(10).describe("Tone dial 0-10, 5 neutral."),
  localColour: z.number().min(0).max(10).describe("Tone dial 0-10, 5 neutral: how much local place and weather colour."),
  warmth: z.number().min(0).max(10).describe("Tone dial 0-10, 5 neutral."),
  tts: voiceSlot,
  fallbackVoice: z
    .object({ engine: z.string(), voice: z.string(), cloudProvider: z.string().optional() })
    .nullable()
    .describe("Voice to use when the main one fails to render. null for none."),
  skills: z
    .array(z.string())
    .nullable()
    .describe("Skill names this DJ may run. null means every skill."),
  tags: z.array(z.string()).describe("Organisation-only tags, lowercase slugs, up to 8."),
};

/**
 * The persona schema refuses a missing voice block and a missing cloud
 * provider, which the admin panel always fills. An agent leaving the voice out
 * means "the station's voice", so that is the default: engine 'inherit'. The
 * provider is unused by every engine but 'cloud', where it must be named, so
 * it is defaulted only off cloud.
 */
export function withVoiceDefaults(tts: Row | undefined): Row {
  const slot: Row = { engine: "inherit", voice: "", ...(tts ?? {}) };
  if (slot.cloudProvider === undefined && slot.engine !== "cloud") slot.cloudProvider = "openai";
  return slot;
}

function recordSummary(p: Row | null | undefined): { id: string; name: string } {
  return { id: String(p?.id ?? ""), name: String(p?.name ?? "") };
}

// -------------------------------------------------------------------- shows --

const SHOW_FIELDS = {
  name: z.string().max(SHOW_NAME_MAX).describe(`Show name, 1-${SHOW_NAME_MAX} chars.`),
  topic: z
    .string()
    .max(SHOW_TOPIC_MAX)
    .describe(`The DJ's brief for this show, up to ${SHOW_TOPIC_MAX} chars. Models read it; listeners do not.`),
  description: z.string().describe("Listener-facing blurb for the schedule, up to 300 chars. Empty shows the topic."),
  personaId: z.string().describe("Host persona id (from subwave_list_personas)."),
  guestPersonaIds: z.array(z.string()).describe("Up to 3 co-host persona ids. Needed for banter."),
  moods: z.array(z.string()).describe("Moods from the station's mood list (subwave_list_shows returns it). Empty is any."),
  genres: z.array(z.string()).describe("Genres, matched fuzzily against the library, up to 15."),
  eras: z
    .array(z.object({ fromYear: z.number().nullable(), toYear: z.number().nullable() }))
    .describe("Release-year windows, e.g. [{fromYear: 1988, toYear: 1999}]."),
  energies: z.array(z.enum(SHOW_ENERGY)).describe("Energy levels to lean toward."),
  vocals: z.enum(["", ...SHOW_VOCALS]).describe("'' for any, or only instrumental / only vocal tracks."),
  filtersStrict: z.boolean().describe("true makes moods/genres/eras/energies a hard filter instead of a lean."),
  excludeExplicit: z.boolean().describe("Keep tracks tagged explicit off air."),
  excludedAlbumKinds: z.array(z.enum(ALBUM_KINDS)).describe("Album kinds this show never plays, e.g. 'dj-mix', 'live'."),
  programme: z.boolean().describe("Produced-episode mode: intro, hourly feature beat, outro."),
  banter: z.boolean().describe("Scripted multi-voice breaks with the guest co-hosts."),
  pauseTalk: z.boolean().describe("Long skill segments may stop the music instead of talking over it."),
  segmentSkill: z.string().describe("Skill name to pin the programme feature beat to. Empty lets the DJ choose."),
  preparationSkill: z.string().describe("Skill whose tool prepares the episode before music selection."),
  playlistIds: z.array(z.string()).describe("Navidrome playlist ids to anchor picks on."),
  playlistStrict: z.boolean().describe("Play only from the anchor playlists."),
  playlistExhaust: z.boolean().describe("With playlistStrict: play every anchor track once before repeats."),
  playlistInOrder: z.boolean().describe("With playlistStrict: walk the anchor playlists top to bottom."),
  excludedPlaylistIds: z.array(z.string()).describe("Navidrome playlist ids whose tracks never play in this show."),
  maxTrackSeconds: z.number().nullable().describe("Longest track in seconds. null inherits the station cap, 0 is unlimited."),
  minTrackLengthSeconds: z.number().nullable().describe("Shortest track in seconds. null inherits, 0 is no floor."),
  fadeAtShowEnd: z.boolean().nullable().describe("Fade the last track at the show's end. null inherits the station setting."),
  themeId: z.string().describe("Web player theme id while this show is on air. Empty for the station theme."),
  allowedJingles: z.array(z.string()).describe("Jingle filenames this show may draw. Empty allows every one."),
  allowedBeds: z.array(z.string()).describe("Bed names this show may draw. Empty allows every one."),
  tags: z.array(z.string()).describe("Organisation-only tags, lowercase slugs, up to 8."),
};

// ------------------------------------------------------------------- skills --

const SKILL_FIELDS = {
  brief: z
    .string()
    .describe(
      "The SKILL.md body: what the DJ says in this segment, and when to stay quiet. The segment model " +
        "reads it as instructions. A prompt-only skill has no data tool, so the brief must not ask for live " +
        "data (news, scores, search) the DJ is never given.",
    ),
  label: z.string().describe("Display name in the admin panel."),
  cooldown: z.string().describe("Least time between automatic airings: '45m', '6h', '2d', or a bare number of minutes."),
  context: z
    .array(z.enum(CONTEXT_FIELDS))
    .describe("The live context the segment sees. Empty resets to the default set."),
  cron: z
    .string()
    .nullable()
    .describe("Optional 5-field cron (station timezone) that fires the skill on a timer, e.g. '10 7 * * 1-5'. null clears it."),
  cronOnly: z.boolean().describe("true: air only on the cron timer, never as a random between-track segment."),
  cohosts: z.boolean().describe("Run as a multi-persona discussion with the show's co-hosts."),
  tags: z.array(z.string()).describe("Organisation-only tags, lowercase slugs, up to 8."),
};

const CUSTOM_SKILL_FIELDS = {
  window: z.enum(SKILL_WINDOWS).describe("'any', or 'commute' for weekday rush hours only. Custom skills only."),
  requiresKey: z.string().describe("Env var (UPPER_SNAKE_CASE) the skill needs before it can air. Custom skills only."),
};

// The fields of GET /dj/skills/:kind/file that PUT takes back. Anything else
// it returns (defaults, hasTool, knownContextFields…) is read-only.
const SKILL_FILE_KEYS = [
  "label",
  "cooldown",
  "context",
  "cron",
  "cronOnly",
  "cohosts",
  "tags",
  "brief",
  "voice",
  "config",
  "window",
  "requiresKey",
] as const;

function catalogEntry(skills: SkillCatalogEntry[], name: string): SkillCatalogEntry | null {
  return skills.find((s) => s.name === name) ?? null;
}

function skillSummary(entry: SkillCatalogEntry | null, name: string) {
  return {
    name,
    label: String(entry?.label ?? name),
    enabled: entry?.enabled === true,
    custom: entry?.custom === true,
  };
}

const SKILL_OUTPUT = output({
  name: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  custom: z.boolean(),
});

// ----------------------------------------------------------------- schedule --

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Set hours [startHour, endHour) on each day to `showId` (null clears them). */
export function applyScheduleSlots(
  week: ScheduleWeek,
  days: number[],
  startHour: number,
  endHour: number,
  showId: string | null,
): ScheduleWeek {
  const next: ScheduleWeek = {};
  for (let d = 0; d < 7; d++) {
    const day = Array.isArray(week[d]) ? week[d]! : [];
    next[d] = Array.from({ length: 24 }, (_, h) => day[h] ?? null);
  }
  for (const d of days) {
    for (let h = startHour; h < endHour; h++) next[d]![h] = showId;
  }
  return next;
}

export function registerAuthoringTools(server: McpServer, client: SubwaveClient): void {
  // -------------------------------------------------------------------------
  // subwave_list_personas — the full roster, souls and voices included (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_list_personas",
    {
      title: "List DJ personas",
      description:
        "List every DJ persona with all its fields (soul, tone dials, voice, skills), the default " +
        "persona's id, and the TTS engines and voices installed on this station. ADMIN endpoint. Read " +
        "this before creating or editing a persona so the voice you pick exists.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const s = await client.adminSettings();
        const tts = (s.tts ?? {}) as Row;
        const pick = (k: string) => tts[k];
        return {
          content: [
            text({
              activePersonaId: s.values.activePersonaId,
              personas: s.values.personas,
              voices: {
                engines: pick("engines"),
                available: pick("available"),
                kokoroVoices: pick("kokoroVoices"),
                piperVoices: pick("piperVoices"),
                chatterboxVoices: pick("chatterboxVoices"),
                pocketTtsVoices: pick("pocketTtsVoices"),
                pocketTtsCustomVoices: pick("pocketTtsCustomVoices"),
                cloudProviders: pick("cloudProviders"),
              },
            }),
          ],
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_create_persona (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_create_persona",
    {
      title: "Create a DJ persona",
      description:
        "Add a new DJ persona to the roster. It does not go on air by itself: host a show with it " +
        "(subwave_create_show / subwave_update_show) or make it the default in the admin panel. " +
        "Only name, soul and frequency are required; every other field takes the station default, and " +
        "leaving out tts gives the persona the station's own voice. " +
        "ADMIN endpoint. Avatars are uploaded in the admin panel.",
      inputSchema: {
        ...Object.fromEntries(Object.entries(PERSONA_FIELDS).map(([k, v]) => [k, v.optional()])),
        name: PERSONA_FIELDS.name,
        soul: PERSONA_FIELDS.soul,
        frequency: PERSONA_FIELDS.frequency,
      },
      outputSchema: RECORD,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (fields) =>
      run(async () => {
        const body = given(fields);
        body.tts = withVoiceDefaults(body.tts as Row | undefined);
        const { persona } = await client.savePersona(body);
        const summary = recordSummary(persona);
        return {
          content: [text(`Created persona '${summary.name}' (id ${summary.id}).`)],
          structuredContent: summary,
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_update_persona (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_update_persona",
    {
      title: "Edit a DJ persona",
      description:
        "Change fields on an existing persona. Pass only the fields to change; the rest keep their " +
        "stored values. A partial `tts` (e.g. just `voice`) is merged into the stored voice. Takes " +
        "effect on the persona's next spoken line. ADMIN endpoint.",
      inputSchema: {
        id: z.string().describe("Persona id from subwave_list_personas."),
        ...Object.fromEntries(Object.entries(PERSONA_FIELDS).map(([k, v]) => [k, v.optional()])),
        tts: voiceSlot.partial().optional(),
      },
      outputSchema: RECORD,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ id, ...fields }) =>
      run(async () => {
        const s = await client.adminSettings();
        const current = s.values.personas.find((p) => p.id === id);
        if (!current) {
          throw new SubwaveError(`No persona with id '${id}'. List the ids with subwave_list_personas.`);
        }
        const patch = given(fields as Row);
        const next: Row = { ...current, ...patch, id };
        // Merged rather than replaced, so changing just the voice keeps the
        // engine, gain and speed. The defaults only fill what neither carries.
        next.tts = withVoiceDefaults({ ...((current.tts as Row) ?? {}), ...((patch.tts as Row) ?? {}) });
        const { persona } = await client.savePersona(next);
        const summary = recordSummary(persona);
        return {
          content: [text(`Updated persona '${summary.name}' (${Object.keys(patch).join(", ") || "no changes"}).`)],
          structuredContent: summary,
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_delete_persona (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_delete_persona",
    {
      title: "Delete a DJ persona",
      description:
        "Delete a persona. This also deletes every show it hosts, clears those shows' schedule hours, " +
        "and removes it as a guest elsewhere. The last persona cannot be deleted. Cannot be undone. " +
        "ADMIN endpoint.",
      inputSchema: { id: z.string().describe("Persona id from subwave_list_personas.") },
      outputSchema: output({ id: z.string(), activePersonaId: z.string(), showsLeft: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ id }) =>
      run(async () => {
        const result = await client.deletePersona(id);
        const shows = Array.isArray(result.shows) ? result.shows : [];
        const activePersonaId = String(result.activePersonaId ?? "");
        return {
          content: [text(`Deleted persona ${id}. Default persona is now ${activePersonaId}; ${shows.length} show(s) remain.`)],
          structuredContent: { id, activePersonaId, showsLeft: shows.length },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_list_shows — shows, the weekly grid and the mood list (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_list_shows",
    {
      title: "List shows and the schedule",
      description:
        "List every show with all its fields, the weekly schedule grid (schedule[day][hour] = show id " +
        "or null; day 0 is Sunday, hours in the station timezone), the station's mood names, and the " +
        "persona ids and names a show can be hosted by. ADMIN endpoint.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const s = await client.adminSettings();
        const v = s.values;
        return {
          content: [
            text({
              shows: v.shows,
              schedule: v.schedule,
              timezone: v.timezone || s.serverTimezone,
              moods: (v.moods ?? []).map((m) => m.name),
              personas: v.personas.map((p) => recordSummary(p)),
            }),
          ],
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_create_show (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_create_show",
    {
      title: "Create a show",
      description:
        "Create a show: a host persona, a brief, and music filters. It airs only once it has hours on " +
        "the weekly schedule (subwave_schedule_show). Only name and personaId are required. ADMIN endpoint.",
      inputSchema: {
        ...Object.fromEntries(Object.entries(SHOW_FIELDS).map(([k, v]) => [k, v.optional()])),
        name: SHOW_FIELDS.name,
        personaId: SHOW_FIELDS.personaId,
      },
      outputSchema: RECORD,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (fields) =>
      run(async () => {
        const { show } = await client.saveShow(given(fields));
        const summary = recordSummary(show);
        return {
          content: [text(`Created show '${summary.name}' (id ${summary.id}). Schedule it with subwave_schedule_show.`)],
          structuredContent: summary,
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_update_show (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_update_show",
    {
      title: "Edit a show",
      description:
        "Change fields on an existing show. Pass only the fields to change; the rest keep their stored " +
        "values. Its schedule hours are untouched. ADMIN endpoint.",
      inputSchema: {
        id: z.string().describe("Show id from subwave_list_shows."),
        ...Object.fromEntries(Object.entries(SHOW_FIELDS).map(([k, v]) => [k, v.optional()])),
      },
      outputSchema: RECORD,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ id, ...fields }) =>
      run(async () => {
        const s = await client.adminSettings();
        const current = s.values.shows.find((sh) => sh.id === id);
        if (!current) {
          throw new SubwaveError(`No show with id '${id}'. List the ids with subwave_list_shows.`);
        }
        const patch = given(fields as Row);
        const { show } = await client.saveShow({ ...current, ...patch, id });
        const summary = recordSummary(show);
        return {
          content: [text(`Updated show '${summary.name}' (${Object.keys(patch).join(", ") || "no changes"}).`)],
          structuredContent: summary,
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_delete_show (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_delete_show",
    {
      title: "Delete a show",
      description: "Delete a show and clear its hours from the weekly schedule. Cannot be undone. ADMIN endpoint.",
      inputSchema: { id: z.string().describe("Show id from subwave_list_shows.") },
      outputSchema: output({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ id }) =>
      run(async () => {
        await client.deleteShow(id);
        return { content: [text(`Deleted show ${id} and cleared its schedule hours.`)], structuredContent: { id } };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_schedule_show — put a show on (or clear) hours of the week (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_schedule_show",
    {
      title: "Schedule a show",
      description:
        "Put a show on the weekly schedule for the hours startHour..endHour-1 on each listed day, " +
        "replacing whatever was there; pass showId null to clear those hours instead. Hours are in the " +
        "station timezone (subwave_list_shows reports it). An overnight run such as 22:00-02:00 is two " +
        "calls, one per day. Other hours are untouched. ADMIN endpoint.",
      inputSchema: {
        showId: z.string().nullable().describe("Show id from subwave_list_shows, or null to clear the hours."),
        days: z
          .array(z.number().int().min(0).max(6))
          .min(1)
          .describe("Days of the week: 0 Sunday, 1 Monday … 6 Saturday."),
        startHour: z.number().int().min(0).max(23).describe("First hour, 0-23."),
        endHour: z.number().int().min(1).max(24).describe("Hour the run ends (exclusive), 1-24. 24 is midnight."),
      },
      outputSchema: output({ showId: z.string().nullable(), slots: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ showId, days, startHour, endHour }) =>
      run(async () => {
        if (endHour <= startHour) {
          throw new SubwaveError(
            `endHour (${endHour}) must be after startHour (${startHour}). Split an overnight run into two calls.`,
          );
        }
        const s = await client.adminSettings();
        if (showId !== null && !s.values.shows.some((sh) => sh.id === showId)) {
          throw new SubwaveError(`No show with id '${showId}'. List the ids with subwave_list_shows.`);
        }
        const uniqueDays = [...new Set(days)].sort();
        const week = applyScheduleSlots(s.values.schedule, uniqueDays, startHour, endHour, showId);
        await client.saveSchedule(week);
        const slots = uniqueDays.length * (endHour - startHour);
        const when = `${uniqueDays.map((d) => DAY_NAMES[d]).join(", ")} ${String(startHour).padStart(2, "0")}:00-${String(endHour % 24).padStart(2, "0")}:00`;
        return {
          content: [text(showId ? `Scheduled ${showId} on ${when} (${slots} hour(s)).` : `Cleared ${when} (${slots} hour(s)).`)],
          structuredContent: { showId, slots },
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_get_skill — one skill's SKILL.md fields (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_get_skill",
    {
      title: "Read a DJ skill",
      description:
        "Read one skill's full definition: brief, label, cooldown, context, cron, tags, and whether it " +
        "has a data tool. ADMIN endpoint. Skill names come from subwave_list_skills.",
      inputSchema: { name: z.string().min(1).describe("Skill name from subwave_list_skills.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ name }) =>
      run(async () => {
        const file = await client.getSkillFile(name);
        return { content: [text(file)] };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_create_skill — a custom prompt-only skill (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_create_skill",
    {
      title: "Create a DJ skill",
      description:
        "Create a custom prompt-only segment skill: a brief the DJ voices between tracks. It arrives " +
        "DISABLED; turn it on with subwave_enable_skill, and limit which DJs run it with " +
        "subwave_set_skill_personas. You can run it once right away with subwave_run_skill, which works " +
        "while it is disabled. Data tools (tool.mjs) cannot be added here. ADMIN endpoint.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("The skill's permanent slug: lowercase a-z, 0-9 and hyphens, up to 49 chars."),
        ...Object.fromEntries(Object.entries({ ...SKILL_FIELDS, ...CUSTOM_SKILL_FIELDS }).map(([k, v]) => [k, v.optional()])),
        brief: SKILL_FIELDS.brief,
      },
      outputSchema: SKILL_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (fields) =>
      run(async () => {
        const { skills } = await client.createSkill(given(fields));
        const summary = skillSummary(catalogEntry(skills, fields.name), fields.name);
        return {
          content: [text(`Created skill '${summary.name}' (disabled). Enable it with subwave_enable_skill.`)],
          structuredContent: summary,
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_update_skill (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_update_skill",
    {
      title: "Edit a DJ skill",
      description:
        "Change fields on a skill, built-in or custom. Pass only the fields to change; the rest keep " +
        "their stored values, and a skill's data tool is left as it is. window and requiresKey apply " +
        "to custom skills only. ADMIN endpoint.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name from subwave_list_skills."),
        ...Object.fromEntries(Object.entries({ ...SKILL_FIELDS, ...CUSTOM_SKILL_FIELDS }).map(([k, v]) => [k, v.optional()])),
      },
      outputSchema: SKILL_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ name, ...fields }) =>
      run(async () => {
        const file = await client.getSkillFile(name);
        const current: Row = {};
        for (const key of SKILL_FILE_KEYS) if (file[key] !== undefined) current[key] = file[key];
        const patch = given(fields as Row);
        const { skills } = await client.updateSkill(name, { ...current, ...patch });
        const summary = skillSummary(catalogEntry(skills, name), name);
        return {
          content: [text(`Updated skill '${name}' (${Object.keys(patch).join(", ") || "no changes"}).`)],
          structuredContent: summary,
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_delete_skill (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_delete_skill",
    {
      title: "Delete a DJ skill",
      description:
        "Delete a custom skill's whole folder, its data tool included. Built-in skills cannot be " +
        "deleted; turn them off with subwave_enable_skill instead. Cannot be undone. ADMIN endpoint.",
      inputSchema: { name: z.string().min(1).describe("Custom skill name from subwave_list_skills.") },
      outputSchema: output({ name: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ name }) =>
      run(async () => {
        await client.deleteSkill(name);
        return { content: [text(`Deleted skill '${name}'.`)], structuredContent: { name } };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_enable_skill (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_enable_skill",
    {
      title: "Enable or disable a DJ skill",
      description:
        "Turn a skill's automatic airing on or off. A disabled skill still runs when fired by hand " +
        "(subwave_run_skill). ADMIN endpoint.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name from subwave_list_skills."),
        on: z.boolean().describe("true to let the DJ air it automatically, false to stop."),
      },
      outputSchema: SKILL_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ name, on }) =>
      run(async () => {
        const { skills } = await client.toggleSkill(name, on);
        const summary = skillSummary(catalogEntry(skills, name), name);
        return {
          content: [text(`Skill '${name}' is now ${summary.enabled ? "enabled" : "disabled"}.`)],
          structuredContent: summary,
        };
      }),
  );

  // -------------------------------------------------------------------------
  // subwave_set_skill_personas (admin)
  // -------------------------------------------------------------------------
  server.registerTool(
    "subwave_set_skill_personas",
    {
      title: "Choose which DJs run a skill",
      description:
        "Set exactly which personas may run this skill: the listed ones gain it, every other persona " +
        "loses it. ADMIN endpoint. Persona ids come from subwave_list_personas.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name from subwave_list_skills."),
        personaIds: z.array(z.string()).describe("Every persona id that should run this skill."),
      },
      outputSchema: output({
        name: z.string(),
        personas: z.array(z.object({ id: z.string(), name: z.string(), hasSkill: z.boolean() })),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ name, personaIds }) =>
      run(async () => {
        const { personas } = await client.setSkillPersonas(name, personaIds);
        const on = personas.filter((p) => p.hasSkill).map((p) => p.name);
        return {
          content: [text(`'${name}' now runs for: ${on.length ? on.join(", ") : "no one"}.`)],
          structuredContent: { name, personas },
        };
      }),
  );
}
