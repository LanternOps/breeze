import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AiAgentRunAnalysisScopeDto, AiAgentRunChainStepDto } from '@breeze/shared';
import { formatCurrency } from '@/lib/i18n/format';
import { badgeClass, runStatusTone } from './statusBadge';

/**
 * The scope an analysis run was frozen to at admission, as one line. The count
 * is as of launch, so the copy says so. A site whose row is gone or invisible
 * (`siteName` null) gets the unnamed variant rather than an empty name.
 */
export function analysisScopeLabel(t: TFunction, scope: AiAgentRunAnalysisScopeDto): string {
  const count = scope.deviceCount;
  switch (scope.kind) {
    case 'org':
      return t('aiAgentsPage.runs.detail.scope.org', { count });
    case 'site':
      return scope.siteName
        ? t('aiAgentsPage.runs.detail.scope.site', { count, name: scope.siteName })
        : t('aiAgentsPage.runs.detail.scope.siteUnnamed', { count });
    default:
      return t('aiAgentsPage.runs.detail.scope.devices', { count });
  }
}

/**
 * Every step of the analysis chain this run belongs to, in the order the API
 * sends them (depth, then queued time, then id). Two continuations of the same
 * run are both "Step N" and both listed.
 *
 * Goal text is the model's restatement of the technician's ask: it is rendered
 * as a React text child only, never as markup. `steps` is `undefined` when the
 * web is ahead of the API during a rolling deploy, and null for an unchained
 * run; both render nothing.
 */
export default function RunChainSection({
  steps,
  currentRunId,
}: {
  steps: AiAgentRunChainStepDto[] | null | undefined;
  currentRunId: string;
}) {
  const { t } = useTranslation('settings');
  if (!steps || steps.length === 0) return null;

  return (
    <section data-testid="run-detail-chain" className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.detail.chain.title')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('aiAgentsPage.runs.detail.chain.description')}</p>
      <ul className="mt-3 space-y-2">
        {steps.map((s) => (
          <li
            key={s.id}
            data-testid={`run-detail-chain-step-${s.id}`}
            className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm"
          >
            <span className="font-medium">{t('aiAgentsPage.runs.detail.chain.step', { step: s.step })}</span>
            <span className="min-w-0 flex-1 break-words">
              {s.goal ?? <span className="text-muted-foreground">{t('aiAgentsPage.runs.detail.chain.noGoal')}</span>}
            </span>
            <span className={badgeClass(runStatusTone(s.status), { size: 'sm' })}>
              {t(/* i18n-dynamic */ `aiAgentsPage.runs.statuses.${s.status}`)}
            </span>
            <span className="text-xs text-muted-foreground">{formatCurrency(s.costCents / 100)}</span>
            {s.id === currentRunId ? (
              <span data-testid="run-detail-chain-current" className={badgeClass('accent', { size: 'sm' })}>
                {t('aiAgentsPage.runs.detail.chain.current')}
              </span>
            ) : (
              <a
                data-testid={`run-detail-chain-link-${s.id}`}
                href={`/ai-agents/runs/${s.id}`}
                className="text-xs underline"
              >
                {t('aiAgentsPage.runs.detail.chain.open')}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
