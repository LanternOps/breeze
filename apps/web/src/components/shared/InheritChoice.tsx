import { useTranslation } from 'react-i18next';

export interface InheritChoiceOption<T extends string | boolean> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Shown under the option, e.g. why it is disabled. */
  hint?: string;
  testId: string;
}

export interface InheritChoiceProps<T extends string | boolean> {
  id: string;
  legend: string;
  options: InheritChoiceOption<T>[];
  /** null = inherit. */
  value: T | null;
  /** What a null value resolves to. */
  inheritedValue: T;
  /** Where the inherited value comes from, e.g. "Partner default" or "Breeze default". */
  inheritedSourceLabel: string;
  /**
   * true: the first radio is "Inherit — {value} ({source})" and emits null.
   * false (a partner default, whose blank is the Breeze default): no inherit
   * radio; a null value checks the option equal to `inheritedValue` and tags it
   * with its source, so the resolved value is still shown.
   */
  allowInherit: boolean;
  onChange: (value: T | null) => void;
  disabled?: boolean;
}

/**
 * Shared "one way to inherit" control for enums and booleans (settings rule 4;
 * `InheritedField` covers text and numbers). A blank value always shows the
 * inherited VALUE and its source, never just the word "inherit".
 */
export function InheritChoice<T extends string | boolean>({
  id,
  legend,
  options,
  value,
  inheritedValue,
  inheritedSourceLabel,
  allowInherit,
  onChange,
  disabled,
}: InheritChoiceProps<T>) {
  const { t } = useTranslation('common');
  const inheritedLabel = options.find((o) => o.value === inheritedValue)?.label ?? String(inheritedValue);
  const name = `${id}-choice`;
  // Without an inherit radio, a blank value reads as its resolved option.
  const shown = value === null && !allowInherit ? inheritedValue : value;

  return (
    <fieldset id={id} data-testid={id} disabled={disabled} className="space-y-1">
      <legend className="text-sm font-medium">{legend}</legend>
      {allowInherit && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={name}
            checked={value === null}
            disabled={disabled}
            data-testid={`${id}-inherit`}
            onChange={() => onChange(null)}
          />
          <span>{t('inheritChoice.inherit', { value: inheritedLabel, source: inheritedSourceLabel })}</span>
        </label>
      )}
      {options.map((option) => (
        <label key={String(option.value)} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={name}
            className="mt-0.5"
            checked={shown === option.value}
            disabled={disabled || option.disabled}
            data-testid={option.testId}
            onChange={() => onChange(option.value)}
          />
          <span>
            <span className={option.disabled ? 'text-muted-foreground' : undefined}>{option.label}</span>
            {!allowInherit && value === null && option.value === inheritedValue && (
              <span data-testid={`${id}-source`} className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {inheritedSourceLabel}
              </span>
            )}
            {option.hint && <span className="block text-xs text-muted-foreground">{option.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
