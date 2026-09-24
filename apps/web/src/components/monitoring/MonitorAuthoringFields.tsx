import { useFieldArray, useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { MonitorKind } from '@breeze/shared';
import { SERVER_EVALUATED_MONITOR_KINDS } from '@breeze/shared';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor } from './monitorKindFields';

/**
 * Legal composite children (#5289 W05c2, Task 12) — `SERVER_EVALUATED_MONITOR_KINDS`
 * from the shared package, the only kinds whose evidence the server sweep reads
 * itself. Re-exported here under the name the plan/tests use; kept as a
 * standalone const (rather than importing the shared name directly in JSX)
 * so a future kind added to the shared list needs no change here.
 */
export const COMPOSITE_CHILD_KINDS = SERVER_EVALUATED_MONITOR_KINDS;

export function CompositeConditionFields({ name }: { name: string }) {
  const { t } = useTranslation(['monitoring', 'common']);
  const { control, register, watch, setValue } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name: `${name}.children` });

  return (
    <fieldset className="space-y-3 rounded border p-3">
      <legend>{t('monitoring:editor.composite.children')}</legend>
      <select data-testid="composite-match" {...register(`${name}.match`)}>
        <option value="all">{t('monitoring:compositeMatch.all')}</option>
        <option value="any">{t('monitoring:compositeMatch.any')}</option>
      </select>
      {fields.map((field, index) => {
        const prefix = `${name}.children.${index}`;
        const kind = watch(`${prefix}.kind`) as MonitorKind;
        return (
          <div key={field.id} data-testid={`composite-child-${index}`} className="space-y-2 rounded border p-3">
            <select
              aria-label={t('monitoring:device.kind')}
              data-testid={`composite-kind-${index}`}
              value={kind}
              onChange={(event) => {
                const next = event.target.value as (typeof COMPOSITE_CHILD_KINDS)[number];
                setValue(`${prefix}.kind`, next, { shouldDirty: true });
                setValue(`${prefix}.condition`, defaultConditionFor(next), { shouldDirty: true });
              }}
            >
              {COMPOSITE_CHILD_KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(/* i18n-dynamic */ `monitoring:kinds.${value}`)}
                </option>
              ))}
            </select>
            <MonitorConditionFields kind={kind} name={`${prefix}.condition`} />
            <button
              type="button"
              data-testid={`composite-remove-${index}`}
              disabled={fields.length <= 2}
              onClick={() => remove(index)}
            >
              {t('common:actions.remove')}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        data-testid="composite-add"
        disabled={fields.length >= 10}
        onClick={() => append({ kind: 'cpu', condition: defaultConditionFor('cpu') })}
      >
        {t('monitoring:editor.composite.add')}
      </button>
    </fieldset>
  );
}

export function RestartResponseFields() {
  const { t } = useTranslation('monitoring');
  const { watch, setValue, register } = useFormContext();
  const responses: Array<Record<string, unknown>> = watch('responses') ?? [];

  return (
    <div className="space-y-3">
      {responses.map((response, index) => {
        if (response.type !== 'execute_command') return null;
        return (
          <fieldset key={index} className="rounded border p-3">
            <label>
              <input
                type="checkbox"
                data-testid={`restart-${index}-toggle`}
                checked={response.kind === 'restart_service'}
                onChange={(event) => {
                  const next = { ...response };
                  if (event.target.checked) {
                    Object.assign(next, { kind: 'restart_service', command: '', maxAttempts: 3, cooldownSeconds: 300 });
                  } else {
                    delete next.kind;
                    delete next.maxAttempts;
                    delete next.cooldownSeconds;
                  }
                  setValue(`responses.${index}`, next, { shouldDirty: true });
                }}
              />
              {t('editor.restart.label')}
            </label>
            {response.kind === 'restart_service' &&
              ([
                ['maxAttempts', 0, 50, 3],
                ['cooldownSeconds', 30, 86400, 300],
              ] as const).map(([key, min, max, fallback]) => (
                <label key={key} className="block">
                  {t(/* i18n-dynamic */ `editor.restart.${key}`)}
                  <input
                    type="number"
                    data-testid={`restart-${index}-${key}`}
                    min={min}
                    max={max}
                    step={1}
                    defaultValue={Number(response[key] ?? fallback)}
                    {...register(`responses.${index}.${key}`, { valueAsNumber: true, min, max })}
                  />
                </label>
              ))}
          </fieldset>
        );
      })}
    </div>
  );
}
