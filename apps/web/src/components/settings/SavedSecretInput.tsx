import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { MASKED_SECRET, isMaskedSecret } from '@/lib/redactedSecret';

type Props = {
  /** The value held for the save: the masked marker, a typed value, '' (remove) or undefined (unset). */
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  label: string;
  testId: string;
  /** Placeholder when nothing is saved. */
  notSetPlaceholder?: string;
  disabled?: boolean;
  maxLength?: number;
  /** Rendered under the field (e.g. a "managed by partner" note). */
  children?: ReactNode;
};

/**
 * A settings field for a stored secret. The API returns a saved secret only as
 * the masked marker. The field stays empty with a "saved" placeholder and the
 * marker stays in `value`, so a save keeps the saved value; typing replaces
 * it, and Remove sends an explicit empty string, which clears it.
 */
export default function SavedSecretInput({
  value,
  onChange,
  label,
  testId,
  notSetPlaceholder,
  disabled,
  maxLength,
  children,
}: Props) {
  const { t } = useTranslation('settings');
  const [hasSaved, setHasSaved] = useState(() => isMaskedSecret(value));
  useEffect(() => {
    if (isMaskedSecret(value)) setHasSaved(true);
  }, [value]);

  const removed = hasSaved && value === '';
  const placeholder = removed
    ? t('savedSecret.removedPlaceholder')
    : hasSaved
      ? t('savedSecret.savedPlaceholder')
      : notSetPlaceholder;

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <div className={`flex gap-2 ${disabled ? 'opacity-60' : ''}`}>
        <input
          type="password"
          autoComplete="new-password"
          data-testid={testId}
          value={isMaskedSecret(value) ? '' : (value ?? '')}
          disabled={disabled}
          maxLength={maxLength}
          onChange={e => onChange(e.target.value || (hasSaved ? MASKED_SECRET : undefined))}
          placeholder={placeholder}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        />
        {hasSaved && !removed && !disabled && (
          <button
            type="button"
            data-testid={`${testId}-remove`}
            onClick={() => onChange('')}
            className="h-10 shrink-0 rounded-md border px-3 text-sm hover:bg-muted"
          >
            {t('savedSecret.remove')}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}
