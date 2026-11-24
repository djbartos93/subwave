'use client';

// The projected hour: one steady-state hour of the draft clock, run through the
// controller's own boundary rules (POST /format-clocks/preview). Read-only.

import { cn } from '../../../lib/cn';
import {
  HOUR_SEC,
  SECTION_LABELS,
  fmtMmSs,
  hourFitLabel,
  HOUR_FIT_SLACK_SEC,
  imagingSourceLabel,
  songSourceLabel,
  stepLabel,
} from './lib';
import type { PreviewState } from './queries';

export function ClockTimeline({ preview, valid }: { preview: PreviewState; valid: boolean }) {
  const data = preview.data;
  if (!valid) {
    return <div className="text-[12px] text-muted">Fix the clock above to see its projected hour.</div>;
  }
  if (!data) {
    return (
      <div className="text-[12px] text-muted">
        {preview.error ? `Preview unavailable: ${preview.error}` : 'Projecting the hour…'}
      </div>
    );
  }
  const { projection, estimates, sources } = data;
  const over = projection.vsHourSec >= HOUR_FIT_SLACK_SEC;
  const short = projection.vsHourSec <= -HOUR_FIT_SLACK_SEC;
  const songSec = estimates.avgSongSec ?? 0;
  const imagingSec = estimates.imagingSec ?? 0;
  return (
    <div className={cn('grid gap-3', preview.loading && 'opacity-60')} aria-busy={preview.loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-mono text-[13px] font-bold">
          {fmtMmSs(projection.totalSec)} <span className="text-muted">of {fmtMmSs(HOUR_SEC)}</span>
        </div>
        <div
          className={cn(
            'text-[12px] font-semibold',
            over ? 'text-[var(--danger)]' : short ? 'text-vermilion' : 'text-muted',
          )}
        >
          {hourFitLabel(projection.vsHourSec)} · {projection.songs} {projection.songs === 1 ? 'song' : 'songs'}
        </div>
      </div>
      {preview.error && <div className="text-[11px] text-[var(--danger)]">Preview not refreshed: {preview.error}</div>}
      <ol className="m-0 grid list-none gap-0 border border-separator-strong p-0">
        {projection.steps.map((s, i) => {
          const fill = s.section === 'fill' && s.type === 'song';
          return (
            <li
              key={i}
              className="grid grid-cols-[3.5rem_1fr_auto] items-baseline gap-3 border-b border-dashed border-separator-strong px-2.5 py-1.5 last:border-b-0"
            >
              <span className="font-mono text-[11px] text-muted">{fmtMmSs(s.startSec)}</span>
              <span className={cn('text-[12px]', s.dropped && 'text-muted line-through')}>
                {fill ? 'Song (fill)' : stepLabel(s)}
                {s.dropped && <span className="ml-2 no-underline">dropped, running late</span>}
              </span>
              <span className="font-mono text-[9px] tracking-[0.12em] text-muted uppercase">
                {SECTION_LABELS[s.section]}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="text-[10px] leading-[1.6] text-muted">
        Songs about {fmtMmSs(songSec)} each, from {songSourceLabel(sources.song)}
        {sources.songSamples ? ` (${sources.songSamples} tracks)` : ''}. Imaging about {Math.round(imagingSec)} s, from{' '}
        {imagingSourceLabel(sources.imaging)}. Estimates only: the real hour follows the real songs.
        {projection.note ? ` ${projection.note}` : ''}
      </div>
    </div>
  );
}
