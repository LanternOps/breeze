import { useTranslation } from 'react-i18next';

interface InheritedFieldProps {
  id: string;
  label: string;
  /** The org's own override value, or '' when blank (= inherit). */
  value: string;
  onChange: (value: string) => void;
  /** The resolved inherited value to DISPLAY when value is blank — never just
   *  the word "inherit". null = no inherited value is configured either. */
  inheritedValue: string | null;
  /** Where the inherited value comes from, e.g. "Partner default", "Category default". */
  inheritedSource: string;
  disabled?: boolean;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  step?: string;
  /** Skip rendering the visible <label> (e.g. inside a compact table cell that
   *  already carries a row label) while keeping the association for a11y via
   *  aria-label. */
  hideLabel?: boolean;
  'data-testid'?: string;
}

/**
 * Shared "one way to inherit" control (settings-consolidation audit rule 4):
 * blank = inherit, and the field always shows the inherited VALUE (via
 * placeholder) plus its source — never just the word "inherit".
 */
export default function InheritedField({
  id,
  label,
  value,
  onChange,
  inheritedValue,
  inheritedSource,
  disabled,
  type = 'text',
  min,
  max,
  step,
  hideLabel,
  ...rest
}: InheritedFieldProps) {
  const { t } = useTranslation('common');
  const testId = rest['data-testid'];
  const isInheriting = value.trim() === '';

  return (
    <div>
      {hideLabel ? null : (
        <label className="text-sm font-medium" htmlFor={id}>
          {label}
        </label>
      )}
      <input
        id={id}
        type={type}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={inheritedValue ?? undefined}
        aria-label={hideLabel ? label || undefined : undefined}
        data-testid={testId}
        className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
      />
      {isInheriting ? (
        inheritedValue !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('inheritedField.inheritsFrom', { source: inheritedSource })}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('inheritedField.noneConfigured', { source: inheritedSource })}
          </p>
        )
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('inheritedField.overriding', { source: inheritedSource })}
        </p>
      )}
    </div>
  );
}
