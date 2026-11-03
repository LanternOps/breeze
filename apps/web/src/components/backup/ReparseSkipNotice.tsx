import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import '../../lib/i18n';
import type { ReparseSkipSummary } from '@breeze/shared';

// #9543: skipped reparse points are a deliberate, informational outcome of a
// backup scan (they add nothing to errorCount), so they render as a muted
// info line beside — never inside — the job's error/warning text. The agent's
// full note (per-kind counts and sampled paths) stays one click away.
export default function ReparseSkipNotice({
  summary,
  className,
}: {
  summary: ReparseSkipSummary;
  className?: string;
}) {
  const { t } = useTranslation('backup');
  return (
    <div
      data-testid="backup-job-reparse-skipped"
      className={cn('rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground', className)}
    >
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('reparseSkipNotice.summary', { count: summary.total })}</span>
      </p>
      <details className="mt-1 pl-5">
        <summary className="cursor-pointer font-medium">{t('reparseSkipNotice.showDetails')}</summary>
        <p className="mt-1 whitespace-pre-wrap break-words font-mono">{summary.detail}</p>
      </details>
    </div>
  );
}
