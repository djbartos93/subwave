'use client';

// One format clock: name, an ordered step list, the fill rule, and the projected
// hour beside them. The draft lives in the panel (a whole-document editor, like
// the Rundown); validity is the shared schema's own answer, never a copy of it.

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { FORMAT_CLOCK_BREAK_KINDS, FORMAT_CLOCK_FILL_RULES } from '@/lib/schemas.generated';
import type { AdminFetch } from '@/lib/admin-query';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { Btn, Card } from '../ui';
import type { SkillOption } from '../shows/types';
import { ClockTimeline } from './ClockTimeline';
import { useClockPreview } from './queries';
import {
  BREAK_KIND_LABELS,
  FILL_RULE_HELP,
  FILL_RULE_LABELS,
  FORMAT_CLOCK_NAME_MAX,
  FORMAT_CLOCK_STEPS_MAX,
  addStep,
  canAddStep,
  draftIssue,
  moveStep,
  removeStep,
  updateStep,
  type ClockDraft,
  type FormatClockBreakKind,
  type FormatClockFillRule,
  type FormatClockStep,
} from './lib';

// Radix Select refuses an empty-string item, so "no show" travels as this.
const DEFAULTS_SHOW = '__defaults__';

export interface PreviewShowOption {
  id: string;
  name: string;
  usesClock: boolean;
}

export function ClockEditor({
  draft, onChange, skills, shows, adminFetch, dirty, isNew, saving, onSave, onClose, onDelete,
}: {
  draft: ClockDraft;
  onChange: (next: ClockDraft) => void;
  skills: SkillOption[];
  /** Every show; the ones using this clock are listed first by the caller. */
  shows: PreviewShowOption[];
  adminFetch: AdminFetch;
  dirty: boolean;
  isNew: boolean;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const issue = useMemo(() => draftIssue(draft), [draft]);
  const [previewShow, setPreviewShow] = useState<string>(
    () => shows.find(s => s.usesClock)?.id ?? DEFAULTS_SHOW,
  );
  const previewShowId = shows.some(s => s.id === previewShow) ? previewShow : null;
  const preview = useClockPreview(adminFetch, issue ? null : draft, previewShowId, true);

  const setSteps = (steps: FormatClockStep[]) => onChange({ ...draft, steps });
  const nameId = 'format-clock-name';

  return (
    <Card
      title={isNew ? 'New format clock' : draft.name.trim() || 'Format clock'}
      sub="editor"
      right={<Btn sm onClick={onClose}>Close</Btn>}
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-5">
          <div className="field">
            <Label htmlFor={nameId}>name</Label>
            <Input
              id={nameId}
              value={draft.name}
              maxLength={FORMAT_CLOCK_NAME_MAX}
              placeholder="e.g. Morning drive"
              onChange={e => onChange({ ...draft, name: e.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="eyebrow">steps · {draft.steps.length}/{FORMAT_CLOCK_STEPS_MAX}</span>
              <div className="flex flex-wrap gap-2">
                <Btn sm disabled={!canAddStep(draft.steps)} onClick={() => setSteps(addStep(draft.steps, { type: 'song' }))}>
                  + Song
                </Btn>
                <Btn sm disabled={!canAddStep(draft.steps)} onClick={() => setSteps(addStep(draft.steps, { type: 'imaging' }))}>
                  + Imaging
                </Btn>
                <Btn sm disabled={!canAddStep(draft.steps)} onClick={() => setSteps(addStep(draft.steps, { type: 'break', kind: 'link' }))}>
                  + Break
                </Btn>
              </div>
            </div>
            <ol className="m-0 grid list-none gap-2 p-0">
              {draft.steps.map((step, i) => (
                <StepRow
                  key={i}
                  step={step}
                  index={i}
                  last={i === draft.steps.length - 1}
                  skills={skills}
                  onPatch={patch => setSteps(updateStep(draft.steps, i, patch))}
                  onMove={delta => setSteps(moveStep(draft.steps, i, delta))}
                  onRemove={() => setSteps(removeStep(draft.steps, i))}
                />
              ))}
            </ol>
            <div className="text-[11px] leading-[1.6] text-muted">
              Songs come from the show&apos;s own music settings. The clock only decides where the DJ talks and imaging airs.
            </div>
          </div>

          <div className="grid items-start gap-5 sm:grid-cols-2">
            <div className="field">
              <Label>if the hour runs short</Label>
              <Select
                value={draft.fillRule}
                onValueChange={v => onChange({ ...draft, fillRule: v as FormatClockFillRule })}
              >
                <SelectTrigger aria-label="Fill rule"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FORMAT_CLOCK_FILL_RULES.map(r => (
                    <SelectItem key={r} value={r}>{FILL_RULE_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="field-hint">{FILL_RULE_HELP[draft.fillRule]}</div>
            </div>
            <div className="field">
              <Label>fit the last song to the hour</Label>
              <label className="flex items-center gap-2 text-[12px]">
                <Switch
                  checked={draft.fitLastSong}
                  onCheckedChange={v => onChange({ ...draft, fitLastSong: v })}
                  aria-label="Fit the last song to the hour"
                />
                {draft.fitLastSong ? 'On' : 'Off'}
              </label>
              <div className="field-hint">
                Picks a song short enough to end near the top of the hour, when one fits.
              </div>
            </div>
          </div>
        </div>

        <div className="grid content-start gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <span className="eyebrow">projected hour</span>
            <div className="field !m-0 min-w-[180px]">
              <Label>preview with show</Label>
              <Select value={previewShowId ?? DEFAULTS_SHOW} onValueChange={setPreviewShow}>
                <SelectTrigger aria-label="Preview with show"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULTS_SHOW}>None (defaults)</SelectItem>
                  {shows.map(s => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}{s.usesClock ? ' (uses this clock)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <ClockTimeline preview={preview} valid={!issue} />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-separator-strong pt-4">
        <div className="min-h-5 text-[12px] text-[var(--danger)]" role={issue ? 'alert' : undefined}>
          {issue ?? ''}
        </div>
        <div className="flex flex-wrap gap-2">
          {!isNew && <Btn tone="danger" disabled={saving} onClick={onDelete}>Delete</Btn>}
          <Btn tone="accent" disabled={!!issue || saving || (!dirty && !isNew)} onClick={onSave}>
            {saving ? 'Saving…' : isNew ? 'Create clock' : 'Save clock'}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

function StepRow({
  step, index, last, skills, onPatch, onMove, onRemove,
}: {
  step: FormatClockStep;
  index: number;
  last: boolean;
  skills: SkillOption[];
  onPatch: (patch: { kind?: FormatClockBreakKind; skill?: string; dropIfLate?: boolean; topOfHour?: boolean }) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const skillKnown = step.type === 'break' && step.skill ? skills.some(s => s.kind === step.skill) : true;
  return (
    <li className="grid gap-2 border border-separator-strong bg-[var(--card-bg)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-6 font-mono text-[11px] text-muted">{String(n).padStart(2, '0')}</span>
        <span className="min-w-[4.5rem] text-[12px] font-bold">
          {step.type === 'song' ? 'Song' : step.type === 'imaging' ? 'Imaging' : 'Break'}
        </span>

        {step.type === 'break' && (
          <Select value={step.kind} onValueChange={v => onPatch({ kind: v as FormatClockBreakKind })}>
            <SelectTrigger className="w-[9.5rem]" aria-label={`Step ${n} break kind`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {FORMAT_CLOCK_BREAK_KINDS.map(k => (
                <SelectItem key={k} value={k}>{BREAK_KIND_LABELS[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {step.type === 'break' && step.kind === 'segment' && (
          <Select value={step.skill ?? ''} onValueChange={v => onPatch({ skill: v })}>
            <SelectTrigger className="w-[12rem]" aria-label={`Step ${n} skill`}>
              <SelectValue placeholder="Choose a skill" />
            </SelectTrigger>
            <SelectContent>
              {skills.map(s => (
                <SelectItem key={s.kind} value={s.kind}>{s.label || s.name || s.kind}</SelectItem>
              ))}
              {!skillKnown && step.skill && (
                <SelectItem value={step.skill}>{step.skill} (unavailable)</SelectItem>
              )}
            </SelectContent>
          </Select>
        )}

        <span className="ml-auto flex items-center gap-1">
          <Btn sm aria-label={`Move step ${n} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={14} aria-hidden />
          </Btn>
          <Btn sm aria-label={`Move step ${n} down`} disabled={last} onClick={() => onMove(1)}>
            <ArrowDown size={14} aria-hidden />
          </Btn>
          <Btn sm tone="danger" aria-label={`Remove step ${n}`} onClick={onRemove}>
            <Trash2 size={14} aria-hidden />
          </Btn>
        </span>
      </div>

      {step.type !== 'song' && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pl-9">
          {step.type === 'break' && step.kind === 'station-id' && (
            <label className="flex items-center gap-2 text-[11px]" title="Always airs, even when the hour is running late">
              <Switch
                checked={step.topOfHour === true}
                onCheckedChange={v => onPatch({ topOfHour: v })}
                aria-label={`Step ${n} top of hour`}
              />
              Top of hour
            </label>
          )}
          {!(step.type === 'break' && step.topOfHour) && (
            <label className="flex items-center gap-2 text-[11px]" title="Skipped when the hour is running late">
              <Switch
                checked={step.dropIfLate === true}
                onCheckedChange={v => onPatch({ dropIfLate: v })}
                aria-label={`Step ${n} drop if late`}
              />
              Drop if late
            </label>
          )}
        </div>
      )}
    </li>
  );
}
