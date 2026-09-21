import { useEffect, useState } from 'react';
import { useFormContext, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { MonitorKind } from '@breeze/shared';
import { fetchAllScripts } from '@/lib/scriptsFetch';
import { MONITOR_KIND_FIELDS, type KindField } from './monitorKindFields';

/**
 * Which translated-option namespace a select field's values live under.
 * Keyed by `field.key` alone, EXCEPT where two kinds reuse the same schema
 * key for a differently-shaped enum — `antivirus.check` and
 * `backup_continuity.check` both author into a field literally named `check`
 * (#5291), so those two are keyed `${kind}:${key}` and looked up first.
 */
export const SELECT_OPTION_NAMESPACE: Record<string, string> = {
  category: 'eventCategories',
  level: 'eventLevels',
  resource: 'resources',
  direction: 'directions',
  errorType: 'directions',
  match: 'compositeMatch',
  presence: 'presences',
  checkType: 'checkTypes',
  'antivirus:check': 'antivirusChecks',
  'backup_continuity:check': 'backupChecks',
};

interface FetchedScript {
  id: string;
  name: string;
}

export interface MonitorConditionFieldsProps {
  kind: MonitorKind;
  /** react-hook-form path prefix for the condition object, e.g. 'condition'. */
  name: string;
}

/**
 * Renders one kind's condition inputs from `MONITOR_KIND_FIELDS` (#5289) —
 * one field-map-driven renderer instead of hand-coding 13 kind-specific forms.
 * Reads/writes through `useFormContext()`; the parent must wrap in `<FormProvider>`.
 */
export default function MonitorConditionFields({ kind, name }: MonitorConditionFieldsProps) {
  const { t } = useTranslation('monitoring');
  const { register, watch, formState: { errors } } = useFormContext<FieldValues>();
  const fields = MONITOR_KIND_FIELDS[kind];

  const conditionErrors = (errors[name] as Record<string, { message?: string } | undefined> | undefined) ?? {};

  // One subscription for the whole condition object rather than one `watch()`
  // call per `showWhen` field — the field list (and therefore how many
  // fields would need watching) varies by `kind`, and calling a hook a
  // variable number of times per render breaks the rules of hooks.
  const conditionValues = (watch(name) as Record<string, unknown> | undefined) ?? {};
  const isVisible = (field: KindField): boolean =>
    !field.showWhen || String(conditionValues[field.showWhen.key] ?? '') === field.showWhen.equals;

  const needsScripts = fields.some((field) => field.kind === 'script');
  const [scripts, setScripts] = useState<FetchedScript[]>([]);
  const [scriptsError, setScriptsError] = useState(false);

  useEffect(() => {
    if (!needsScripts) return;
    let cancelled = false;
    fetchAllScripts<FetchedScript>()
      .then((result) => {
        if (!cancelled) setScripts(result.data);
      })
      .catch(() => {
        if (!cancelled) setScriptsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsScripts]);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.filter(isVisible).map((field) => {
        const path = `${name}.${field.key}`;
        const label = t(/* i18n-dynamic */ field.labelKey) + (field.unit ? ` (${field.unit})` : '');
        const fieldError = conditionErrors[field.key]?.message;

        if (field.kind === 'boolean') {
          return (
            <div key={field.key} className="flex items-center gap-2 pt-5">
              <input
                id={`condition-field-${field.key}`}
                data-testid={`condition-field-${field.key}`}
                type="checkbox"
                className="h-4 w-4 rounded border"
                {...register(path)}
              />
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`condition-field-${field.key}`}>
                {label}
              </label>
            </div>
          );
        }

        if (field.kind === 'script') {
          return (
            <div key={field.key} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`condition-field-${field.key}`}>
                {label}
              </label>
              <select
                id={`condition-field-${field.key}`}
                data-testid={`condition-field-${field.key}`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register(path)}
                // Explicit `value` (in addition to `register`'s own binding)
                // so the DOM stays in sync with form state even when the
                // matching <option> doesn't exist yet at mount/reset time —
                // e.g. editing a saved script monitor, where `reset()` from
                // the fetched monitor can land before this component's own
                // async `/scripts` fetch has populated the option list.
                // Without this, assigning a value with no matching <option>
                // is a native-select no-op that never gets retried once the
                // option does appear, so the picker silently reverts to the
                // placeholder (#6207).
                value={String(conditionValues[field.key] ?? '')}
              >
                <option value="">{t('fields.scriptSelectPlaceholder')}</option>
                {scripts.map((script) => (
                  <option key={script.id} value={script.id}>
                    {script.name}
                  </option>
                ))}
              </select>
              {scriptsError && <p className="text-xs text-destructive">{t('fields.scriptLoadError')}</p>}
              {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
            </div>
          );
        }

        if (field.kind === 'operator') {
          return (
            <div key={field.key} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`condition-field-${field.key}`}>
                {label}
              </label>
              <select
                id={`condition-field-${field.key}`}
                data-testid={`condition-field-${field.key}`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register(path)}
              >
                {(['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const).map((op) => (
                  <option key={op} value={op}>
                    {t(/* i18n-dynamic */ `operators.${op}`)}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        if (field.kind === 'select') {
          return (
            <div key={field.key} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`condition-field-${field.key}`}>
                {label}
              </label>
              <select
                id={`condition-field-${field.key}`}
                data-testid={`condition-field-${field.key}`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register(path)}
              >
                {(field.options ?? []).map((opt) => {
                  const ns =
                    SELECT_OPTION_NAMESPACE[`${kind}:${field.key}`] ?? SELECT_OPTION_NAMESPACE[field.key] ?? 'directions';
                  return (
                    <option key={opt} value={opt}>
                      {t(/* i18n-dynamic */ `${ns}.${opt}`, { defaultValue: opt })}
                    </option>
                  );
                })}
              </select>
            </div>
          );
        }

        return (
          <div key={field.key} className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor={`condition-field-${field.key}`}>
              {label}
            </label>
            <input
              id={`condition-field-${field.key}`}
              data-testid={`condition-field-${field.key}`}
              type={field.kind === 'number' ? 'number' : 'text'}
              min={field.min}
              max={field.max}
              step={field.step ?? (field.kind === 'number' ? 1 : undefined)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register(
                path,
                field.kind === 'number'
                  // `valueAsNumber` turns an emptied field into NaN, not
                  // undefined — for an `optional()` condition field (most of
                  // them), that serializes as `condition.<key>: null`, which
                  // the wire schema rejects (optional accepts an ABSENT key,
                  // not an explicit null), surfacing only as a generic
                  // "Save failed" banner with no field pointed at. Map an
                  // empty value to undefined so JSON.stringify drops the key
                  // entirely, same as never having touched the field.
                  // react-hook-form also runs `setValueAs` over the
                  // registered default (not only live DOM events) — a kind
                  // whose default condition omits this optional key mounts
                  // it as `undefined`, which must stay undefined rather than
                  // become `Number(undefined)` (NaN).
                  ? { setValueAs: (v: string | number | undefined) => (v === '' || v == null ? undefined : Number(v)) }
                  : {},
              )}
            />
            {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
          </div>
        );
      })}
    </div>
  );
}
