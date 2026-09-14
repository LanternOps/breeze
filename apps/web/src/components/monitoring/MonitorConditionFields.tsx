import { useFormContext, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { MonitorKind } from '@breeze/shared';
import { MONITOR_KIND_FIELDS } from './monitorKindFields';

/** Which translated-option namespace a select field's values live under. */
const SELECT_OPTION_NAMESPACE: Record<string, string> = {
  category: 'eventCategories',
  level: 'eventLevels',
  resource: 'resources',
  direction: 'directions',
  errorType: 'directions',
};

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
  const { register, formState: { errors } } = useFormContext<FieldValues>();
  const fields = MONITOR_KIND_FIELDS[kind];

  const conditionErrors = (errors[name] as Record<string, { message?: string } | undefined> | undefined) ?? {};

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const path = `${name}.${field.key}`;
        const label = t(/* i18n-dynamic */ field.labelKey) + (field.unit ? ` (${field.unit})` : '');
        const fieldError = conditionErrors[field.key]?.message;

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
                  const ns = SELECT_OPTION_NAMESPACE[field.key] ?? 'directions';
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
