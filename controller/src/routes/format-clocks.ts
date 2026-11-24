// Admin format clock routes. The clock list itself rides in GET/POST /settings
// (`formatClocks`, validated by settings.update()); this is the editor's
// read-only preview: it projects an UNSAVED draft against a show's own
// estimates and never persists or schedules anything.

import express from 'express';
import { z } from 'zod';
import * as settings from '../settings.js';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { queue } from '../broadcast/queue.js';
import { formatClockSchema } from '../schemas/format-clock.js';
import { projectHour } from '../broadcast/format-clock-policy.js';
import { estimateShowTiming } from '../music/show-timing.js';
import { formatClockStatus } from '../broadcast/format-clock.js';

export const router = express.Router();

// The dashboard's "Format clock now" readout: who owns the talk and the last
// boundary decision. Its own small read so the card's poll never builds the
// whole /debug snapshot (which probes Icecast, the mixer log and Navidrome).
// Admin only; never in util/public-feed.ts.
router.get('/format-clocks/status', requireAdmin, (_req, res) => {
  try {
    res.json(formatClockStatus());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const previewSchema = z.object({
  clock: formatClockSchema,
  showId: z.string().max(64).nullish(),
});

router.post('/format-clocks/preview', requireAdmin, validateBody(previewSchema), async (req, res) => {
  try {
    const { clock, showId } = req.body as z.output<typeof previewSchema>;
    await settings.load();
    let show: any = null;
    if (showId) {
      show = (settings.get().shows || []).find((s: { id: string }) => s.id === showId) ?? null;
      if (!show) return res.status(404).json({ error: `no such show: ${showId}` });
    }
    const timing = await estimateShowTiming(show);
    const minSongSec = settings.effectiveMinTrackSec(show);
    res.json({
      show: show ? { id: show.id, name: show.name } : null,
      projection: projectHour(clock, timing.estimates, { minSongSec }),
      estimates: timing.estimates,
      sources: { song: timing.songSource, imaging: timing.imagingSource, songSamples: timing.songSamples },
    });
  } catch (err: any) {
    queue.log('error', 'POST /format-clocks/preview failed: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});
