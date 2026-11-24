'use client';

// Read-only: what the live format clock decided most recently. The numbers come
// from the admin-only GET /format-clocks/status, so a clock never appears on a
// public surface. Quiet when no show on air has a clock.

import { useAdminAuth } from '../../../lib/adminAuth';
import { fmtClock } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { Card, Pill } from '../ui';
import { useFormatClockStatusQuery } from '../format-clocks/queries';
import { fmtMmSs } from '../format-clocks/lib';

export function FormatClockNowCard({ tz, locale }: { tz?: string; locale?: StationLocale }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const query = useFormatClockStatusQuery(adminFetch, hydrated && !needsAuth);
  const status = query.data ?? null;
  const last = status?.last ?? null;
  // The decision belongs to the clock that is on air now; one left over from an
  // earlier show would mislead.
  const current = last && status?.clock && last.clockId === status.clock.id ? last : null;

  return (
    <Card title="Format clock now" sub="read-only" right={status?.owning ? <Pill tone="accent" dot>on air</Pill> : undefined}>
      {!status || status.error ? (
        <div className="text-[12px] text-muted">
          {query.isPending ? 'Loading…' : 'Format clock status is unavailable.'}
        </div>
      ) : !status.owning || !status.clock ? (
        <div className="text-[12px] text-muted">
          No format clock on air{status.show ? `: ${status.show.name} uses the station's normal talk` : ''}.
        </div>
      ) : (
        <div className="grid gap-1.5 text-[12px]">
          <div>
            <span className="font-bold">{status.clock.name}</span>
            {status.show && <span className="text-muted"> · {status.show.name}</span>}
          </div>
          {current ? (
            <>
              <div className="font-mono text-[11px]">
                Song {current.songOfHour} of the hour ·{' '}
                {current.step != null ? `step ${current.step} of ${current.totalSteps}` : 'past the clock steps'}
              </div>
              <div className="text-muted">{current.note}</div>
              <div className="text-[10px] text-muted">
                {current.actions.length > 0 ? `Seam: ${current.actions.join(', ')}. ` : ''}
                {current.dropped > 0 ? `${current.dropped} dropped, running late. ` : ''}
                {current.maxSongSec != null ? `Next song capped at ${fmtMmSs(current.maxSongSec)}. ` : ''}
                Decided {fmtClock(current.at, tz, locale)}.
              </div>
            </>
          ) : (
            <div className="text-muted">Waiting for the next pick to place a step.</div>
          )}
        </div>
      )}
    </Card>
  );
}
