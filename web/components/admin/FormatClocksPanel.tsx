'use client';

// Shows → Format clocks. A format clock is a per-show hour template: where the
// DJ talks and where imaging airs. The list rides settings.formatClocks, saved
// whole through POST /settings; deleting one is safe because the controller
// clears the pointer on every show that used it, which then falls back to the
// station's normal talk.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { AdminResponseError } from '../../lib/admin-query';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Btn, Card, Eyebrow, Pill } from './ui';
import { useSettingsMutation, useSettingsQuery } from './settings/queries';
import { useShowSkillsQuery } from './shows/queries';
import type { SettingsResponse, SkillOption } from './shows/types';
import { ClockEditor, type PreviewShowOption } from './format-clocks/ClockEditor';
import {
  FILL_RULE_LABELS,
  FORMAT_CLOCKS_LIMIT,
  duplicateClock,
  mintClockId,
  newClockDraft,
  sameClock,
  showsUsingClock,
  songCount,
  withClock,
  withoutClock,
  type ClockDraft,
  type FormatClock,
} from './format-clocks/lib';

function writeError(error: unknown): string {
  if (error instanceof AdminResponseError) {
    const fe = error.body.fieldErrors;
    const first = fe ? Object.values(fe).find(v => typeof v === 'string') : undefined;
    if (first) return first;
    return typeof error.body.error === 'string' && error.body.error ? error.body.error : `failed (${error.status})`;
  }
  return errorMessage(error);
}

export default function FormatClocksPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const enabled = hydrated && !needsAuth;
  const settingsQuery = useSettingsQuery<SettingsResponse>({ adminFetch, enabled });
  const skillsQuery = useShowSkillsQuery(adminFetch, enabled);
  const save = useSettingsMutation<SettingsResponse>({ adminFetch });

  const data = settingsQuery.data ?? null;
  const clocks = useMemo<FormatClock[]>(() => data?.values?.formatClocks ?? [], [data?.values?.formatClocks]);
  const shows = useMemo(() => data?.values?.shows ?? [], [data?.values?.shows]);
  const skills: SkillOption[] = skillsQuery.data ?? [];

  // One clock is open at a time. `isNew` = not saved yet, so it is not in `clocks`.
  const [draft, setDraft] = useState<ClockDraft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const saved = draft ? clocks.find(c => c.id === draft.id) ?? null : null;
  const dirty = !!draft && !!saved && !sameClock(saved, draft);

  const openClock = (c: FormatClock) => {
    setIsNew(false);
    setDraft({ ...c, steps: c.steps.map(s => ({ ...s })) });
  };
  const addClock = () => {
    setIsNew(true);
    setDraft(newClockDraft(mintClockId()));
  };
  const duplicate = (c: FormatClock) => {
    setIsNew(true);
    setDraft(duplicateClock(c, mintClockId(), clocks.map(x => x.name)));
  };

  const persist = async (next: FormatClock[]): Promise<boolean> => {
    try {
      await save.mutateAsync({ formatClocks: next });
      return true;
    } catch (e) {
      notify.err(writeError(e));
      return false;
    }
  };

  const onSave = async () => {
    if (!draft) return;
    const wasNew = isNew;
    if (await persist(withClock(clocks, draft))) {
      setIsNew(false);
      notify.ok(wasNew ? 'Format clock created.' : 'Format clock saved.');
    }
  };

  const doDelete = async (id: string) => {
    const name = clocks.find(c => c.id === id)?.name ?? 'clock';
    if (await persist(withoutClock(clocks, id))) {
      if (draft?.id === id) setDraft(null);
      notify.ok(`Deleted “${name}”.`);
    }
  };

  const err = settingsQuery.error && !data ? errorMessage(settingsQuery.error) : null;
  if (err) {
    return (
      <Card title="Format clocks" sub="hour templates">
        <ErrorState error={err} onRetry={() => void settingsQuery.refetch()} retrying={settingsQuery.isFetching} />
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title="Format clocks" sub="hour templates">
        <SkeletonRows rows={3} />
      </Card>
    );
  }

  const previewShows: PreviewShowOption[] = draft
    ? shows
        .filter((s): s is typeof s & { id: string } => typeof s.id === 'string')
        .map(s => ({
          id: s.id,
          name: (s.name || '').trim() || 'Untitled show',
          usesClock: s.formatClockId === draft.id,
        }))
        .sort((a, b) => Number(b.usesClock) - Number(a.usesClock))
    : [];

  const deleting = confirmDeleteId ? clocks.find(c => c.id === confirmDeleteId) ?? null : null;
  const deletingUsers = deleting ? showsUsingClock(shows as Array<{ id: string; name?: string; formatClockId?: unknown }>, deleting.id) : [];

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-4 p-4">
          <div>
            <Eyebrow className="text-vermilion">show plan · format clocks</Eyebrow>
            <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
              Decide where the DJ talks, hour by hour.
            </div>
            <div className="mt-1 max-w-[62ch] text-[11px] leading-[1.6] text-muted">
              A format clock is an hour template: songs, links, station IDs, segments and imaging in the order you
              choose. Pick one on a show under Format clock. Music still comes from the show&apos;s own settings.
            </div>
          </div>
          <Button asChild variant="accent" size="sm" className="min-h-9 sm:min-h-0">
            <Link href="/admin/shows">Back to shows →</Link>
          </Button>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="caption">format clocks · {clocks.length}/{FORMAT_CLOCKS_LIMIT}</span>
        <Btn tone="accent" className="min-h-9 sm:min-h-0" disabled={clocks.length >= FORMAT_CLOCKS_LIMIT || (isNew && !!draft)} onClick={addClock}>
          + New clock
        </Btn>
      </div>

      {clocks.length === 0 && !draft && (
        <EmptyState
          title="No format clocks yet"
          description="Add one to script an hour: where the links, IDs and imaging fall."
        />
      )}

      {clocks.map(c => {
        const users = showsUsingClock(shows as Array<{ id: string; name?: string; formatClockId?: unknown }>, c.id);
        const open = draft?.id === c.id && !isNew;
        return (
          <section key={c.id} className="card">
            <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-extrabold">{c.name}</span>
                  {open && <Pill tone="accent" dot>editing</Pill>}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Pill className="text-[8px]">{c.steps.length} steps</Pill>
                  <Pill className="text-[8px]">{songCount(c.steps)} songs</Pill>
                  <Pill className="text-[8px]">{FILL_RULE_LABELS[c.fillRule]}</Pill>
                  {c.fitLastSong && <Pill className="text-[8px]">fits the hour</Pill>}
                </div>
                <div className="mt-1.5 text-[11px] text-muted">
                  {users.length === 0 ? 'No show uses this clock.' : `Used by ${users.join(', ')}.`}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Btn sm onClick={() => openClock(c)}>Edit</Btn>
                <Btn sm disabled={clocks.length >= FORMAT_CLOCKS_LIMIT} onClick={() => duplicate(c)}>Duplicate</Btn>
                <Btn sm tone="danger" onClick={() => setConfirmDeleteId(c.id)}>Delete</Btn>
              </div>
            </div>
          </section>
        );
      })}

      {draft && (
        <ClockEditor
          key={draft.id}
          draft={draft}
          onChange={setDraft}
          skills={skills}
          shows={previewShows}
          adminFetch={adminFetch}
          dirty={dirty}
          isNew={isNew}
          saving={save.isPending}
          onSave={() => void onSave()}
          onClose={() => setDraft(null)}
          onDelete={() => setConfirmDeleteId(draft.id)}
        />
      )}

      <V3AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={o => { if (!o) setConfirmDeleteId(null); }}
        title="Delete format clock"
        description={
          <>
            Delete <b>{deleting?.name ?? 'this clock'}</b>? This takes effect right away.
            {deletingUsers.length > 0
              ? <> {deletingUsers.join(', ')} will go back to the station&apos;s normal talk.</>
              : <> Shows using it fall back to the station&apos;s normal talk.</>}
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) void doDelete(id);
        }}
      />
    </div>
  );
}
