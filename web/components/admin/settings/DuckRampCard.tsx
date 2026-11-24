'use client';

import type { ChangeEvent } from 'react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Card, Pill } from '../ui';
import {
  SettingsFieldError,
  type DuckRampLayerForm,
  type DuckRampLayerKey,
  type FormState,
  type FormUpdater,
  type SettingsFieldErrors,
} from './shared';

/**
 * settings.duckRamp: how long each duck layer takes to pull the music down
 * when a clip starts and to bring it back up when it ends. Each direction is a
 * range the mixer draws inside for every clip (radio.liq smooth_duck), so the
 * same min and max is a fixed time. Read at mixer startup, like the depths.
 */
const LAYERS: { key: DuckRampLayerKey; label: string; hint: string }[] = [
  {
    key: 'voice',
    label: 'DJ over silence',
    hint: 'The heavy duck: station IDs, the hourly time, weather and request intros.',
  },
  {
    key: 'intro',
    label: 'DJ over a track',
    hint: 'The light duck for between-track links that talk over the song.',
  },
  {
    key: 'sfx',
    label: 'Sound effects',
    hint: 'The small dip under a stinger. It has no lead-in, so a slow pull-down only softens the dip; it never delays the sound.',
  },
];

const DIRECTIONS = [
  { label: 'Pull down', min: 'downMin', max: 'downMax' },
  { label: 'Bring back up', min: 'upMin', max: 'upMax' },
] as const;

export function DuckRampCard({ form, setForm, fieldErrors, current }: {
  form: FormState;
  setForm: FormUpdater;
  fieldErrors: SettingsFieldErrors;
  current?: Partial<Record<DuckRampLayerKey, Partial<Record<keyof DuckRampLayerForm, number>>>>;
}) {
  const set = (layer: DuckRampLayerKey, field: keyof DuckRampLayerForm, value: string) =>
    setForm(f => ({ ...f, duckRamp: { ...f.duckRamp, [layer]: { ...f.duckRamp[layer], [field]: value } } }));

  return (
    <Card title="Duck timing" sub="how fast the DJ pulls the fader">
      <div className="grid gap-4">
        <div className="field-hint">
          How long the music takes to drop when the DJ starts talking, and to come back when they
          stop. Give a range and every break picks its own time inside it, so the fader never moves
          the same way twice; set both ends the same for a fixed time. 0.1 to 5 seconds. The voice
          layers wait out the whole pull-down before the first word, so a slower pull-down also
          delays the voice by that much.
        </div>
        {LAYERS.map(layer => (
          <div key={layer.key} className="field">
            <div className="flex items-center gap-2">
              <Label>{layer.label}</Label>
              <Pill tone="ink">restart required</Pill>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {DIRECTIONS.map(dir => (
                <div key={dir.label} className="flex flex-wrap items-center gap-2">
                  <span className="w-28 text-[12px] text-muted">{dir.label}</span>
                  <Input
                    className="mono-num w-20"
                    aria-label={`${layer.label}: ${dir.label.toLowerCase()}, shortest seconds`}
                    type="number"
                    step={0.05}
                    min={0.1}
                    max={5}
                    value={form.duckRamp[layer.key][dir.min]}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => set(layer.key, dir.min, e.target.value)}
                  />
                  <span className="text-[12px] text-muted">to</span>
                  <Input
                    className="mono-num w-20"
                    aria-label={`${layer.label}: ${dir.label.toLowerCase()}, longest seconds`}
                    type="number"
                    step={0.05}
                    min={0.1}
                    max={5}
                    value={form.duckRamp[layer.key][dir.max]}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => set(layer.key, dir.max, e.target.value)}
                  />
                  <span className="text-[12px] text-muted">s</span>
                </div>
              ))}
            </div>
            {(['downMin', 'downMax', 'upMin', 'upMax'] as const).map(f => (
              <SettingsFieldError key={f} path={`duckRamp.${layer.key}.${f}`} errors={fieldErrors} />
            ))}
            <SettingsFieldError path="duckRamp" errors={fieldErrors} />
            <div className="field-hint">
              {layer.hint}
              {current?.[layer.key] && (
                <> Saved: down {current[layer.key]?.downMin}–{current[layer.key]?.downMax} s,
                  up {current[layer.key]?.upMin}–{current[layer.key]?.upMax} s.</>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
