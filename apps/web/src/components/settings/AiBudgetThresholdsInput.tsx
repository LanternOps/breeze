import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  value: number[] | undefined;
  onChange: (value: number[] | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  testId?: string;
};

export function parseThresholds(raw: string): { ok: true; value: number[] | undefined } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const parts = trimmed.split(/[\s,]+/).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 99)) return { ok: false };
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (uniq.length > 5) return { ok: false };
  return { ok: true, value: uniq };
}

export default function AiBudgetThresholdsInput({ value, onChange, disabled, placeholder, testId = 'ai-budget-thresholds' }: Props) {
  const { t } = useTranslation('settings');
  const [text, setText] = useState(value?.join(', ') ?? '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(value?.join(', ') ?? ''); }, [value]);

  const commit = () => {
    const parsed = parseThresholds(text);
    if (!parsed.ok) { setInvalid(true); return; }
    setInvalid(false);
    onChange(parsed.value);
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {(value ?? []).map((v) => (
          <span key={v} className="rounded-full bg-muted px-2 py-0.5 text-xs">{v}%</span>
        ))}
      </div>
      <input
        type="text"
        inputMode="numeric"
        data-testid={`${testId}-input`}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      />
      {invalid && (
        <p data-testid={`${testId}-error`} className="text-xs text-red-600">{t('aiBudgetThresholds.invalid')}</p>
      )}
    </div>
  );
}
