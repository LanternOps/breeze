import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { Controller, useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { AlertLifecycleDefaultsResponse, LifecycleSource, RearmMode } from '@breeze/shared';
import type { MonitorFormValues } from './MonitorEditor';
import { autoResolveLabel, fetchLifecycleDefaults, rearmLabel, sourceLabel } from './lifecycleDefaults';

const FIELD_CLASS = 'h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';
const LABEL_CLASS = 'text-xs font-medium text-muted-foreground';

function overrideDisclosure(t: TFunction, source: LifecycleSource, value: string): string {
  switch (source) {
    case 'org':
      return t('monitoring:editor.lifecycle.overrides.org', { value });
    case 'builtin':
      return t('monitoring:editor.lifecycle.overrides.builtin', { value });
    default:
      return t('monitoring:editor.lifecycle.overrides.partner', { value });
  }
}

// Blank = inherit (null). 0 stays 0: it is a real cooldown.
const parseNumberInput = (text: string): number | null => (text.trim() === '' ? null : Number(text));

export interface MonitorLifecycleFieldsProps {
  /** The org whose defaults this monitor inherits; null reads the partner default. */
  orgId: string | null;
  /** False until the monitor's owner is known, so the read targets the right level. */
  ready: boolean;
  /** Partner-wide monitors resolve against each device's org at evaluation time, so say so. */
  showPartnerWideHint: boolean;
}

/**
 * The monitor override level (settings rule 3's stated exception: the monitor
 * beats the org, disclosed on each field that sets a value). Every field's
 * blank/Inherit state is `null` on the wire, so a PATCH can return to inherit.
 */
export default function MonitorLifecycleFields({ orgId, ready, showPartnerWideHint }: MonitorLifecycleFieldsProps) {
  const { t } = useTranslation(['monitoring', 'common']);
  const { control, watch, setValue, formState: { errors } } = useFormContext<MonitorFormValues>();
  const [defaults, setDefaults] = useState<AlertLifecycleDefaultsResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setDefaults(null);
    setUnavailable(false);
    fetchLifecycleDefaults(orgId)
      .then((data) => {
        if (!cancelled) setDefaults(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('Could not load the alert lifecycle defaults (%s)', err instanceof Error ? err.message : 'unknown error');
        setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, ready]);

  const kind = watch('kind');
  const condition = watch('condition');
  const autoResolve = watch('autoResolve');
  const rearmMode = watch('rearmMode');
  const cooldown = watch('cooldownMinutes');

  const effective = defaults?.effective ?? null;
  const sources = defaults?.sources ?? null;

  const inheritOption = (value: string | null, source: LifecycleSource | null) =>
    value !== null && source !== null
      ? t('monitoring:lifecycle.inheritOption', { value, source: sourceLabel(t, source) })
      : t('monitoring:lifecycle.inheritOptionPlain');

  const disclosure = (value: string | null, source: LifecycleSource | null) =>
    value !== null && source !== null
      ? overrideDisclosure(t, source, value)
      : t('monitoring:editor.lifecycle.overrides.unknown');

  // OD5: a new event during the cooldown is delayed, not lost, unless the window
  // is shorter than the cooldown and it ages out first. Warn, never block.
  const windowMinutes = kind === 'event_log' ? Number((condition as { windowMinutes?: unknown })?.windowMinutes) : NaN;
  const effectiveCooldown = cooldown ?? effective?.cooldownMinutes ?? null;
  const showWindowWarning = effectiveCooldown !== null && Number.isFinite(windowMinutes) && windowMinutes < effectiveCooldown;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label className={LABEL_CLASS} htmlFor="monitor-editor-auto-resolve">{t('monitoring:editor.fields.autoResolve')}</label>
          <Controller
            name="autoResolve"
            control={control}
            render={({ field }) => (
              <select
                id="monitor-editor-auto-resolve"
                data-testid="monitor-editor-auto-resolve"
                className={FIELD_CLASS}
                ref={field.ref}
                onBlur={field.onBlur}
                value={field.value === null || field.value === undefined ? '' : String(field.value)}
                onChange={(e) => field.onChange(e.target.value === '' ? null : e.target.value === 'true')}
              >
                <option value="">
                  {inheritOption(effective ? autoResolveLabel(t, effective.autoResolve) : null, sources?.autoResolve ?? null)}
                </option>
                <option value="true">{t('monitoring:lifecycle.autoResolveOn')}</option>
                <option value="false">{t('monitoring:lifecycle.autoResolveOff')}</option>
              </select>
            )}
          />
          {autoResolve !== null && autoResolve !== undefined && (
            <p data-testid="monitor-editor-lifecycle-override-auto-resolve" className="text-xs text-muted-foreground">
              {disclosure(effective ? autoResolveLabel(t, effective.autoResolve) : null, sources?.autoResolve ?? null)}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label className={LABEL_CLASS} htmlFor="monitor-editor-rearm-mode">{t('monitoring:lifecycle.rearmLabel')}</label>
          <Controller
            name="rearmMode"
            control={control}
            render={({ field }) => (
              <select
                id="monitor-editor-rearm-mode"
                data-testid="monitor-editor-rearm-mode"
                className={FIELD_CLASS}
                ref={field.ref}
                onBlur={field.onBlur}
                value={field.value ?? ''}
                onChange={(e) => {
                  const next = e.target.value === '' ? null : (e.target.value as RearmMode);
                  field.onChange(next);
                  // The delay belongs to after_delay; a hidden stale value must not block Save.
                  if (next !== 'after_delay') setValue('rearmDelayMinutes', null, { shouldDirty: true });
                }}
              >
                <option value="">
                  {inheritOption(effective ? rearmLabel(t, effective) : null, sources?.rearmMode ?? null)}
                </option>
                <option value="new_evidence">{t('monitoring:lifecycle.rearmNewEvidence')}</option>
                <option value="after_delay">{t('monitoring:lifecycle.rearmAfterDelay')}</option>
              </select>
            )}
          />
          {rearmMode !== null && rearmMode !== undefined && (
            <p data-testid="monitor-editor-lifecycle-override-rearm" className="text-xs text-muted-foreground">
              {disclosure(effective ? rearmLabel(t, effective) : null, sources?.rearmMode ?? null)}
            </p>
          )}
          {rearmMode === 'after_delay' && (
            <>
              <label className={LABEL_CLASS} htmlFor="monitor-editor-rearm-delay">{t('monitoring:lifecycle.rearmDelayLabel')}</label>
              <Controller
                name="rearmDelayMinutes"
                control={control}
                render={({ field }) => (
                  <input
                    id="monitor-editor-rearm-delay"
                    data-testid="monitor-editor-rearm-delay"
                    type="number"
                    min={1}
                    max={1440}
                    step="1"
                    className={FIELD_CLASS}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ''}
                    aria-invalid={errors.rearmDelayMinutes ? true : undefined}
                    onChange={(e) => field.onChange(parseNumberInput(e.target.value))}
                  />
                )}
              />
              {errors.rearmDelayMinutes && (
                <p role="alert" data-testid="monitor-editor-rearm-delay-error" className="text-xs text-destructive">
                  {t('monitoring:lifecycle.errors.rearmDelay')}
                </p>
              )}
            </>
          )}
        </div>

        <div className="space-y-2">
          <label className={LABEL_CLASS} htmlFor="monitor-editor-cooldown">{t('monitoring:editor.fields.cooldownMinutes')}</label>
          <Controller
            name="cooldownMinutes"
            control={control}
            render={({ field }) => (
              <input
                id="monitor-editor-cooldown"
                data-testid="monitor-editor-cooldown"
                type="number"
                min={0}
                max={1440}
                step="1"
                className={FIELD_CLASS}
                ref={field.ref}
                onBlur={field.onBlur}
                value={field.value ?? ''}
                placeholder={effective ? String(effective.cooldownMinutes) : undefined}
                onChange={(e) => field.onChange(parseNumberInput(e.target.value))}
              />
            )}
          />
          {cooldown !== null && cooldown !== undefined ? (
            <p data-testid="monitor-editor-lifecycle-override-cooldown" className="text-xs text-muted-foreground">
              {disclosure(effective ? String(effective.cooldownMinutes) : null, sources?.cooldownMinutes ?? null)}
            </p>
          ) : (
            sources && (
              <p className="text-xs text-muted-foreground">
                {t('common:inheritedField.inheritsFrom', { source: sourceLabel(t, sources.cooldownMinutes) })}
              </p>
            )
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t('monitoring:lifecycle.rearmHelp')}</p>

      {showPartnerWideHint && <p className="text-xs text-muted-foreground">{t('monitoring:editor.lifecycle.partnerWideHint')}</p>}

      {unavailable && (
        <p data-testid="monitor-editor-lifecycle-unavailable" className="text-xs text-muted-foreground">
          {t('monitoring:editor.lifecycle.inheritedUnavailable')}
        </p>
      )}

      {showWindowWarning && (
        <p data-testid="monitor-editor-lifecycle-window-warning" className="text-xs text-amber-700 dark:text-amber-400">
          {t('monitoring:editor.lifecycle.windowWarning', { window: windowMinutes, cooldown: effectiveCooldown })}
        </p>
      )}
    </div>
  );
}
