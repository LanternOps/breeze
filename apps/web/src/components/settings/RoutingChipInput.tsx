import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { ChipResult } from './ticketRoutingModel';

interface Props {
  testId: string;
  label: string;
  hint?: string;
  values: string[];
  max: number;
  /** Maps a raw entry to its normalized value, or an error token under `ticketRouting.errors.*`. */
  normalize: (raw: string) => ChipResult;
  /** Error token shown when `max` is reached. */
  maxError: string;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/** Enter / comma / Add to commit a chip; invalid entries stay in the box with an error. */
export default function RoutingChipInput({
  testId,
  label,
  hint,
  values,
  max,
  normalize,
  maxError,
  onChange,
  disabled,
}: Props) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    if (!draft.trim()) return;
    const result = normalize(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (values.includes(result.value)) {
      setDraft('');
      setError(null);
      return;
    }
    if (values.length >= max) {
      setError(maxError);
      return;
    }
    onChange([...values, result.value]);
    setDraft('');
    setError(null);
  };

  return (
    <div data-testid={testId}>
      <label className="block text-xs font-medium text-muted-foreground" htmlFor={`${testId}-input`}>
        {label}
      </label>
      {values.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {values.map((v) => (
            <li
              key={v}
              data-testid={`${testId}-chip-${v}`}
              className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
            >
              {v}
              {!disabled && (
                <button
                  type="button"
                  data-testid={`${testId}-remove-${v}`}
                  aria-label={t('ticketRouting.chips.remove', { value: v })}
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="mt-1 flex gap-2">
          <input
            id={`${testId}-input`}
            data-testid={`${testId}-input`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commit();
              }
            }}
            className="h-9 w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            data-testid={`${testId}-add`}
            onClick={commit}
            className="h-9 shrink-0 rounded-md border px-3 text-sm hover:bg-muted"
          >
            {t('ticketRouting.chips.add')}
          </button>
        </div>
      )}
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p role="alert" data-testid={`${testId}-error`} className="mt-0.5 text-xs text-destructive">
          {t(/* i18n-dynamic */ `ticketRouting.errors.${error}`)}
        </p>
      )}
    </div>
  );
}
