import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowIssue } from '@breeze/shared';
import { cn } from '@/lib/utils';

/** Validation issues for a flow, errors first, each linked to its step anchor. */
export function FlowIssuesPanel({ issues }: { issues: FlowIssue[] }) {
  const { t } = useTranslation('flows');
  const ordered = [
    ...issues.filter((i) => i.severity === 'error'),
    ...issues.filter((i) => i.severity !== 'error'),
  ];

  return (
    <section className="space-y-2" data-testid="flow-issues">
      <h2 className="text-sm font-semibold">{t('issues.title')}</h2>
      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="flow-issues-none">{t('issues.none')}</p>
      ) : (
        <ul className="space-y-1">
          {ordered.map((issue, index) => (
            <li
              key={`${issue.code}-${issue.stepId ?? ''}-${issue.pointer ?? ''}-${index}`}
              data-testid={`flow-issue-${issue.code}`}
              className={cn(
                'rounded-md border px-3 py-2 text-sm',
                issue.severity === 'error'
                  ? 'border-destructive/40 bg-destructive/5'
                  : 'border-amber-500/40 bg-amber-500/5',
              )}
            >
              <span className="mr-2 text-xs font-semibold uppercase">
                {issue.severity === 'error' ? t('issues.error') : t('issues.warning')}
              </span>
              <span>{issue.message}</span>
              {issue.stepId && (
                <a className="ml-2 font-mono text-xs text-primary hover:underline" href={`#step-${issue.stepId}`}>
                  {issue.stepId}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
