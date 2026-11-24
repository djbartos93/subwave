// The editor preview's wire shape: POST /format-clocks/preview. Mirrors
// controller/src/broadcast/format-clock-policy.ts (HourProjection) and
// routes/format-clocks.ts; kept here by hand because those are impure modules
// the schema mirror does not carry.
import type { FormatClockBreakKind } from '@/lib/schemas.generated';

export interface ProjectedStep {
  type: 'song' | 'imaging' | 'break';
  kind?: FormatClockBreakKind;
  skill?: string;
  section: 'closer' | 'opener' | 'body' | 'fill';
  stepIndex: number | null;
  startSec: number;
  durationSec: number;
  dropped: boolean;
}

export interface HourProjection {
  steps: ProjectedStep[];
  totalSec: number;
  vsHourSec: number;
  songs: number;
  note: string;
}

export interface FormatClockEstimates {
  avgSongSec?: number;
  linkSec?: number;
  stationIdSec?: number;
  segmentSec?: number;
  imagingSec?: number;
}

export interface ClockPreview {
  show: { id: string; name: string } | null;
  projection: HourProjection;
  estimates: FormatClockEstimates;
  sources: { song: string; imaging: string; songSamples?: number };
}

/** GET /format-clocks/status (broadcast/format-clock.ts formatClockStatus). */
export interface FormatClockStatus {
  owning: boolean;
  clock: { id: string; name: string } | null;
  show: { id: string; name: string } | null;
  last: {
    at: string;
    clockId: string;
    clockName: string;
    showId: string | null;
    showName: string | null;
    songOfHour: number;
    step: number | null;
    totalSteps: number;
    dropped: number;
    actions: string[];
    maxSongSec: number | null;
    note: string;
  } | null;
  error?: string;
}
