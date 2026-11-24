'use client';

import { useEffect, useRef, useState } from 'react';
import { adminJson, useAdminQuery, type AdminFetch } from '@/lib/admin-query';
import { errorMessage } from '@/lib/notify';
import type { FormatClock } from '@/lib/schemas.generated';
import type { ClockPreview, FormatClockStatus } from './types';

export const formatClockKeys = {
  all: ['format-clocks'] as const,
  status: () => ['format-clocks', 'status'] as const,
};

/** The operator readout from GET /format-clocks/status (admin only): a small
 *  read of its own, so the 10 s poll never builds the whole /debug snapshot. */
export function useFormatClockStatusQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<FormatClockStatus | null>({
    key: formatClockKeys.status(),
    adminFetch,
    enabled,
    refetchInterval: 10_000,
    request: async (fetcher, signal) =>
      (await adminJson<FormatClockStatus>(fetcher, '/format-clocks/status', undefined, signal)) ?? null,
    toastOnError: false,
  });
}

export interface PreviewState {
  data: ClockPreview | null;
  /** A request is in flight or waiting out the debounce. */
  loading: boolean;
  error: string | null;
}

const PREVIEW_DEBOUNCE_MS = 400;

/**
 * The editor's projected timeline. A preview is imperative and never cached
 * (web/CLAUDE.md): the draft changes every keystroke, so each change waits out a
 * short debounce, aborts the request before it, and only the newest answer is
 * kept. `draft` null (an invalid draft) shows nothing rather than a 400.
 */
export function useClockPreview(
  adminFetch: AdminFetch,
  draft: FormatClock | null,
  showId: string | null,
  enabled: boolean,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ data: null, loading: false, error: null });
  // adminFetch's identity can change with the credential; the effect reads the
  // latest through a ref so it re-runs only when the draft does.
  const fetchRef = useRef(adminFetch);
  fetchRef.current = adminFetch;
  const key = draft ? JSON.stringify({ draft, showId }) : '';

  useEffect(() => {
    if (!enabled || !draft) {
      setState(prev => (prev.loading || prev.error ? { ...prev, loading: false, error: null } : prev));
      return;
    }
    const controller = new AbortController();
    setState(prev => ({ ...prev, loading: true }));
    const timer = setTimeout(() => {
      adminJson<ClockPreview>(
        fetchRef.current,
        '/format-clocks/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clock: draft, showId }),
        },
        controller.signal,
      ).then(
        data => setState({ data, loading: false, error: null }),
        err => {
          if (controller.signal.aborted) return;
          setState(prev => ({ ...prev, loading: false, error: errorMessage(err) }));
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `key` carries the draft and show; the objects themselves are rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return state;
}
