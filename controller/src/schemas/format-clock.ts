// Shared format clock schema: a per-show hour template that says WHEN the DJ
// talks and when imaging airs (broadcast/format-clock-policy.ts reads it).
// Run by validateFormatClocksStrict (the update() chokepoint), normalizeFormatClocks
// (the lenient load path), the admin editor and the mirrored browser copy.
//
// No context factory: a step's skill slug is shape-checked only and resolved
// against the live skill catalog at air time, so nothing here depends on live
// state. Impure rules (id minting, cross-row de-duplication) live in
// format-clock-server.ts, which is not mirrored.
//
// Never call one of these a bare "clock": clock-policy.ts and the "clock
// switch" already mean the spoken time check.
import { z } from 'zod';

// Same pattern as a show id, re-declared per module (zod-only imports).
export const FORMAT_CLOCK_ID_RE = /^[a-z0-9_]{3,32}$/;
export const FORMAT_CLOCKS_LIMIT = 32;
export const FORMAT_CLOCK_NAME_MAX = 60;
export const FORMAT_CLOCK_STEPS_MAX = 60;
export const FORMAT_CLOCK_FILL_RULES = ['songs', 'loop', 'songs-then-break'] as const;
export const FORMAT_CLOCK_BREAK_KINDS = ['link', 'station-id', 'segment'] as const;
// Twin of schemas/skill.ts SKILL_SLUG_RE, re-declared under its own name
// because every top-level name across schemas/*.ts shares one scope.
const FORMAT_CLOCK_SKILL_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

export type FormatClockFillRule = (typeof FORMAT_CLOCK_FILL_RULES)[number];
export type FormatClockBreakKind = (typeof FORMAT_CLOCK_BREAK_KINDS)[number];

export type FormatClockStep =
  | { type: 'song' }
  | { type: 'imaging'; dropIfLate?: boolean }
  | { type: 'break'; kind: FormatClockBreakKind; skill?: string; dropIfLate?: boolean; topOfHour?: boolean };

export interface FormatClock {
  id: string;
  name: string;
  steps: FormatClockStep[];
  fillRule: FormatClockFillRule;
  fitLastSong: boolean;
}

// `=== true` reads, like a show's booleans: both paths read these that way.
const formatClockFlag = () => z.unknown().optional().transform((v) => v === true);
const formatClockNullToUndefined = (v: unknown) => (v == null ? undefined : v);

const formatClockSongStep = z.object({ type: z.literal('song') });
const formatClockImagingStep = z.object({ type: z.literal('imaging'), dropIfLate: formatClockFlag() });
const formatClockBreakStep = z.object({
  type: z.literal('break'),
  kind: z.enum(FORMAT_CLOCK_BREAK_KINDS, {
    error: `kind must be one of: ${FORMAT_CLOCK_BREAK_KINDS.join(', ')}`,
  }),
  skill: z.preprocess(
    formatClockNullToUndefined,
    z
      .string()
      .trim()
      .regex(FORMAT_CLOCK_SKILL_RE, 'skill must be a lowercase slug (a-z, 0-9, hyphens), 1-49 chars')
      .optional(),
  ),
  dropIfLate: formatClockFlag(),
  topOfHour: formatClockFlag(),
});

// Flags are emitted only when true and a field that does not apply to the kind
// is dropped, so a saved row is one canonical shape. A top-of-hour ID is never
// dropped, so its dropIfLate is moot and removed.
function formatClockCanonicalStep(raw: z.output<typeof formatClockStepUnion>): FormatClockStep {
  if (raw.type === 'song') return { type: 'song' };
  if (raw.type === 'imaging') return raw.dropIfLate ? { type: 'imaging', dropIfLate: true } : { type: 'imaging' };
  const out: FormatClockStep = { type: 'break', kind: raw.kind };
  if (raw.kind === 'segment' && raw.skill) out.skill = raw.skill;
  const top = raw.kind === 'station-id' && raw.topOfHour;
  if (top) out.topOfHour = true;
  else if (raw.dropIfLate) out.dropIfLate = true;
  return out;
}

const formatClockStepUnion = z.discriminatedUnion('type', [formatClockSongStep, formatClockImagingStep, formatClockBreakStep], {
  error: 'step type must be song, imaging or break',
});

const formatClockStepSchema = formatClockStepUnion
  .check((c) => {
    if (c.value.type === 'break' && c.value.kind === 'segment' && !c.value.skill) {
      c.issues.push({ code: 'custom', input: c.value, path: ['skill'], message: 'a segment break needs a skill' });
    }
  })
  .transform(formatClockCanonicalStep);

export const formatClockSchema = z
  .object({
    // Optional (a new clock has no id yet); a MALFORMED one is re-minted, as a
    // show's is, because shows point at this id.
    id: z
      .string()
      .regex(FORMAT_CLOCK_ID_RE, 'id must be 3-32 characters: lowercase letters, digits or underscores')
      .optional()
      .catch(undefined),
    name: z
      .string({ error: `name must be 1-${FORMAT_CLOCK_NAME_MAX} chars` })
      .trim()
      .min(1, `name must be 1-${FORMAT_CLOCK_NAME_MAX} chars`)
      .max(FORMAT_CLOCK_NAME_MAX, `name must be 1-${FORMAT_CLOCK_NAME_MAX} chars`),
    steps: z
      .array(formatClockStepSchema, { error: 'steps must be an array' })
      .min(1, 'a format clock needs at least one step')
      .max(FORMAT_CLOCK_STEPS_MAX, `must have at most ${FORMAT_CLOCK_STEPS_MAX} steps`),
    fillRule: z.preprocess(
      formatClockNullToUndefined,
      z.enum(FORMAT_CLOCK_FILL_RULES, {
        error: `fillRule must be one of: ${FORMAT_CLOCK_FILL_RULES.join(', ')}`,
      }).default('songs'),
    ),
    // On unless explicitly false.
    fitLastSong: z.unknown().optional().transform((v) => v !== false),
  })
  .check((c) => {
    if (!c.value.steps.some((s) => s.type === 'song')) {
      c.issues.push({ code: 'custom', input: c.value.steps, path: ['steps'], message: 'a format clock needs at least one song step' });
    }
  });

export type FormatClockParsed = z.output<typeof formatClockSchema>;

export const formatClocksSchema = z
  .array(formatClockSchema, { error: 'must be an array' })
  .max(FORMAT_CLOCKS_LIMIT, `must be at most ${FORMAT_CLOCKS_LIMIT} entries`);

// The LOAD path's per-field repair, beside the rules it repairs against: a
// malformed step is dropped and the list capped, so one bad step costs the
// step, not the clock. The schema is still run on the result, and a clock
// left with no song or no name still fails it and is dropped by the caller.
export function repairFormatClockForLoad(raw: Record<string, unknown>): Record<string, unknown> {
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .filter((s) => formatClockStepRepairs(s))
        .slice(0, FORMAT_CLOCK_STEPS_MAX)
    : undefined;
  return {
    ...raw,
    id: typeof raw.id === 'string' && FORMAT_CLOCK_ID_RE.test(raw.id) ? raw.id : undefined,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, FORMAT_CLOCK_NAME_MAX) : undefined,
    steps,
    fillRule: (FORMAT_CLOCK_FILL_RULES as readonly unknown[]).includes(raw.fillRule) ? raw.fillRule : undefined,
  };
}

// True when a stored step would pass the step schema on its own.
function formatClockStepRepairs(raw: unknown): boolean {
  return raw != null && typeof raw === 'object' && formatClockStepSchema.safeParse(raw).success;
}
