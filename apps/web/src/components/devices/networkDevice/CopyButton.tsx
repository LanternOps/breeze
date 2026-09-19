// A local copy control for the identity card. There is no shared clipboard
// helper in apps/web (nine call sites each hand-roll navigator.clipboard), and
// extracting one is a repo-wide refactor that does not belong in a page wave.
//
// The "Copied" label is a CLAIM: a missing clipboard API (non-secure context,
// an older browser) and a rejected write must both leave it unsaid, or the
// operator pastes nothing and blames the paste target.

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const CONFIRMATION_MS = 2_000;

export function CopyButton({
  value,
  label,
  testId,
  onCopied,
}: {
  value: string;
  label: string;
  testId: string;
  onCopied?: (message: string) => void;
}) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Denied or unavailable — say nothing rather than claim a copy.
      return;
    }
    setCopied(true);
    onCopied?.(t('states.copied'));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), CONFIRMATION_MS);
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`${t('actions.copy')} ${label}`}
      onClick={() => void handleCopy()}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
      {copied && <span>{t('states.copied')}</span>}
    </button>
  );
}
