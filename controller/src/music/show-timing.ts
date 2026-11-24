// Timing estimates for a show's format clock (broadcast/format-clock-policy.ts):
// the average length of a song the show can actually pick, and the average
// length of an imaging clip it may air. Shared by the editor preview and the
// live engine, so one number answers both.
//
// The song figure reads the SAME pools the Candidates diagnostic counts
// (show-candidates.ts buildShowPools: filters, length limits, exclusions), then
// falls back to the whole library, then to 210 s. It walks the library, so it
// is cached and the live engine only ever PEEKS it from a synchronous path
// (peekShowTiming), refreshing it off the hot path with estimateShowTiming.
import { statSync } from 'node:fs';
import * as library from './library.js';
import * as jingles from '../broadcast/jingles.js';
import { allowedForShow } from '../broadcast/show-allowlist.js';
import { measuredClipDurationMs } from '../broadcast/queue/voice-io.js';
import { buildShowPools, gatherShowPoolInputs, type Candidate } from './show-candidates.js';
import { trackLengthSeconds } from './track-floor.js';
import { DEFAULT_AVG_SONG_SEC, DEFAULT_ESTIMATES, DEFAULT_IMAGING_SEC, type FormatClockEstimates } from '../broadcast/format-clock-policy.js';

export type SongEstimateSource = 'show' | 'library' | 'fallback';
export type ImagingEstimateSource = 'jingles' | 'fallback';

export interface ShowTiming {
  estimates: FormatClockEstimates;
  songSource: SongEstimateSource;
  imagingSource: ImagingEstimateSource;
  /** Playable songs the song average was taken over. */
  songSamples: number;
  computedAt: number;
}

/** Mean of the known, positive lengths in seconds; null with none known. */
export function averageSeconds(values: Iterable<number | null | undefined>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) { sum += v; n++; }
  }
  return n ? sum / n : null;
}

const rowSeconds = (rows: readonly Candidate[]) => rows.map((r) => trackLengthSeconds(r));

/**
 * Pure: the show's average song length from its pools. The strict playlist
 * universe wins when the show locks to one, as the picker does; an empty pool
 * falls to the library-wide mean, then to the 210 s default.
 */
export function songEstimate(
  effective: readonly Candidate[],
  libraryRows: readonly Candidate[],
): { sec: number; source: SongEstimateSource; samples: number } {
  const own = averageSeconds(rowSeconds(effective));
  if (own != null) return { sec: Math.round(own), source: 'show', samples: effective.length };
  const lib = averageSeconds(rowSeconds(libraryRows));
  if (lib != null) return { sec: Math.round(lib), source: 'library', samples: libraryRows.length };
  return { sec: DEFAULT_AVG_SONG_SEC, source: 'fallback', samples: 0 };
}

// filename:size -> seconds. A re-imported clip is a new file with a new name.
const clipSeconds = new Map<string, number | null>();

/** Average real duration of the show's allowed jingles (the station list when
 *  the allowlist is empty); the spec's 8 s when none can be measured. */
export async function imagingEstimate(allowedJingles: readonly string[] | undefined): Promise<{ sec: number; source: ImagingEstimateSource }> {
  const items = allowedForShow(await jingles.list(), allowedJingles, (j: { filename: string }) => j.filename);
  const durations: Array<number | null> = [];
  for (const j of items as Array<{ filename: string; size?: number }>) {
    const key = `${j.filename}:${j.size ?? ''}`;
    if (!clipSeconds.has(key)) {
      let sec: number | null = null;
      try {
        const path = await jingles.getPath(j.filename);
        if (path && statSync(path).size > 0) {
          const ms = measuredClipDurationMs(path);
          sec = ms != null ? ms / 1000 : null;
        }
      } catch { /* unmeasurable: it just does not count */ }
      clipSeconds.set(key, sec);
    }
    durations.push(clipSeconds.get(key) ?? null);
  }
  const avg = averageSeconds(durations);
  return avg != null ? { sec: Math.round(avg * 10) / 10, source: 'jingles' } : { sec: DEFAULT_IMAGING_SEC, source: 'fallback' };
}

// Ten minutes: the library walk is the expensive part and a show's pool moves
// slowly. Keyed on what the figure depends on, so an edited show misses.
const TIMING_TTL_MS = 10 * 60_000;
const timingCache = new Map<string, { at: number; timing: ShowTiming }>();
const inflight = new Map<string, Promise<ShowTiming>>();

function cacheKey(show: any): string {
  return JSON.stringify([
    show?.id ?? null, show?.moods, show?.genres, show?.energies, show?.eras, show?.vocals,
    show?.filtersStrict, show?.maxTrackSeconds, show?.minTrackLengthSeconds, show?.playlistIds,
    show?.playlistStrict, show?.excludedPlaylistIds, show?.excludedAlbumKinds, show?.excludeExplicit,
    show?.allowedJingles,
  ]);
}

/** Last computed estimates for this show, or null before the first one. Sync
 *  and free: safe in a per-minute resolver. Stale entries still answer. */
export function peekShowTiming(show: any): ShowTiming | null {
  return timingCache.get(cacheKey(show))?.timing ?? null;
}

export function resetShowTimingCache(): void {
  timingCache.clear();
  inflight.clear();
  clipSeconds.clear();
}

/** The show's estimates (`null` show = the station at large). Cached; callers
 *  on a hot path use peekShowTiming and call this to refresh. */
export async function estimateShowTiming(show: any, { force = false }: { force?: boolean } = {}): Promise<ShowTiming> {
  const key = cacheKey(show);
  const hit = timingCache.get(key);
  if (!force && hit && Date.now() - hit.at < TIMING_TTL_MS) return hit.timing;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = (async () => {
    await library.load();
    const inputs = await gatherShowPoolInputs(show ?? {});
    const pools = buildShowPools(inputs);
    const effective = (pools.playlistStrict ? pools.playlistEffective : pools.libraryEffective) ?? [];
    const song = songEstimate(effective, inputs.libraryRows);
    const img = await imagingEstimate(show?.allowedJingles);
    const timing: ShowTiming = {
      estimates: { ...DEFAULT_ESTIMATES, avgSongSec: song.sec, imagingSec: img.sec },
      songSource: song.source,
      imagingSource: img.source,
      songSamples: song.samples,
      computedAt: Date.now(),
    };
    timingCache.set(key, { at: timing.computedAt, timing });
    return timing;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}
