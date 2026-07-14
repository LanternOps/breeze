import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import type { Pax8ProvisionField, ProvisioningValue } from '../../lib/api/pax8Orders';

export function Pax8ProvisioningForm({
  fields,
  value,
  onChange,
  disabled = false,
}: {
  fields: Pax8ProvisionField[];
  value: ProvisioningValue[];
  onChange: (value: ProvisioningValue[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  const current = new Map(value.map((item) => [item.key, item.values]));

  const update = (key: string, values: string[]) => {
    const next = value.filter((item) => item.key !== key);
    const meaningful = values.filter((item) => item !== '');
    if (meaningful.length > 0) next.push({ key, values: meaningful });
    onChange(next);
  };

  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('pax8.provisioning.none')}</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="pax8-provisioning-form">
      {fields.map((field) => {
        const id = `pax8-provision-${field.key}`;
        const values = current.get(field.key) ?? [];
        const possibleValues = field.possibleValues ?? [];
        return (
          <div key={field.key} className="space-y-1.5">
            <label htmlFor={id} className="text-sm font-medium">
              {field.label || field.key}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {t('pax8.provisioning.optional')}
              </span>
            </label>
            {field.valueType === 'Single-Value' ? (
              <select
                id={id}
                data-testid={id}
                value={values[0] ?? ''}
                disabled={disabled}
                onChange={(event) => update(field.key, [event.target.value])}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {possibleValues.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : field.valueType === 'Multi-Value' ? (
              <select
                id={id}
                data-testid={id}
                multiple
                value={values}
                disabled={disabled}
                aria-describedby={field.description ? `${id}-description` : undefined}
                onChange={(event) => update(
                  field.key,
                  [...event.currentTarget.selectedOptions].map((option) => option.value),
                )}
                className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {possibleValues.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : field.valueType === 'Input' ? (
              <input
                id={id}
                data-testid={id}
                type="text"
                value={values[0] ?? ''}
                disabled={disabled}
                onChange={(event) => update(field.key, [event.target.value])}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
              />
            ) : (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                {t('pax8.provisioning.unsupported')}
              </p>
            )}
            {field.description && (
              <p id={`${id}-description`} className="text-xs text-muted-foreground">{field.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
