import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * The default ladder, rendered as the org-page placeholder. It is deliberately
 * NOT a locale string: it is a numeric example of the input format, identical
 * in every language, and a per-locale copy of it pushed every settings.json
 * over its exact-English duplicate baseline.
 */
export const DEFAULT_THRESHOLDS_PLACEHOLDER = '50, 80, 95';

type Props = {
  value: number[] | undefined;
  onChange: (value: number[] | undefined) => void;
  /**
   * Reports whether the text currently in the box parses. Callers gate their
   * Save button on it: `commit()` swallows unparseable text (it never calls
   * `onChange`), so without this the page would silently save the previous
   * value while the red inline error is still on screen.
   */
  onValidityChange?: (valid: boolean) => void;
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

export default function AiBudgetThresholdsInput({ value, onChange, onValidityChange, disabled, placeholder, testId = 'ai-budget-thresholds' }: Props) {
  const { t } = useTranslation('settings');
  const [text, setText] = useState(() => value?.join(', ') ?? '');
  const [invalid, setInvalid] = useState(false);
  // Mirrors `invalid` so the setter below can compare against the live value
  // from any closure (effects included) without taking it as a dependency.
  const invalidRef = useRef(false);
  const onValidityChangeRef = useRef(onValidityChange);
  useEffect(() => { onValidityChangeRef.current = onValidityChange; }, [onValidityChange]);
  // Unparseable text lives only in this component, so a caller that gated its
  // Save button on our validity must be released when we go away.
  useEffect(() => () => { if (invalidRef.current) onValidityChangeRef.current?.(true); }, []);

  const markInvalid = useCallback((next: boolean) => {
    if (invalidRef.current === next) return;
    invalidRef.current = next;
    setInvalid(next);
    onValidityChangeRef.current?.(!next);
  }, []);

  // Re-seed from `value` DURING RENDER, never from an effect (#4659). A passive
  // effect is flushed after the commit, so a queued `setText(value)` could land
  // *after* the user had typed and silently revert the box to the value it was
  // last seeded with; the next blur then committed that stale ladder instead of
  // what was on screen. On CI this reached `AiUsagePage` as a budget PUT
  // carrying `[50, 80, 95]` where the field had been cleared, and `null` where
  // `60, 90` had been typed. Deriving during render leaves no window at all:
  // there is no commit in which the box still shows the previous ladder.
  const [seededFrom, setSeededFrom] = useState(value);
  if (!Object.is(seededFrom, value)) {
    setSeededFrom(value);
    setText(value?.join(', ') ?? '');
    setInvalid(false);
  }

  // The reset above cannot call `markInvalid` (notifying the parent mid-render
  // is illegal) and must not touch `invalidRef` (a render can be discarded), so
  // reconcile both here. A no-op for every `markInvalid`-driven change, since
  // that setter already moved the ref and told the caller synchronously.
  useEffect(() => {
    if (invalidRef.current === invalid) return;
    invalidRef.current = invalid;
    onValidityChangeRef.current?.(!invalid);
  }, [invalid]);

  const commit = () => {
    if (disabled) return;
    const parsed = parseThresholds(text);
    if (!parsed.ok) { markInvalid(true); return; }
    markInvalid(false);
    onChange(parsed.value);
  };

  const errorId = `${testId}-error`;

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
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => { setText(e.target.value); markInvalid(false); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      />
      {invalid && (
        <p id={errorId} data-testid={errorId} className="text-xs text-red-600">{t('aiBudgetThresholds.invalid')}</p>
      )}
    </div>
  );
}
