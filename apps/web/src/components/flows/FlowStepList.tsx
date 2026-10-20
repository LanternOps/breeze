import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDocumentV1, FlowStepSummary } from '@breeze/shared';
import { useHashState } from '@/lib/useHashState';
import { cn } from '@/lib/utils';

const STEP_HASH_PREFIX = 'step-';

function parseStepHash(hash: string): string | null | undefined {
  return hash.startsWith(STEP_HASH_PREFIX) ? hash.slice(STEP_HASH_PREFIX.length) : undefined;
}

/**
 * Ordered, read-only list of a flow's steps (#5218). The selected step lives in
 * `window.location.hash` (`#step-<id>`) per the web URL-state rule, so a link
 * from the issues panel — or a pasted URL — lands on the right step.
 *
 * `compact` (the chat card) shows only tool + tier + approval and does not
 * touch the hash: a chat transcript can hold many cards and must not fight
 * over the page URL.
 */
export function FlowStepList({
  steps,
  summaries,
  compact = false,
}: {
  steps: FlowDocumentV1['steps'];
  summaries: FlowStepSummary[];
  compact?: boolean;
}) {
  const { t } = useTranslation('flows');
  const [hashSelected, setSelected] = useHashState<string | null>(null, parseStepHash);
  const selected = compact ? null : hashSelected;
  const byId = new Map(summaries.map((s) => [s.id, s]));

  return (
    <ol className="space-y-2" data-testid="flow-steps">
      {steps.map((step, index) => {
        const summary = byId.get(step.id);
        const tier = summary?.tier ?? null;
        const approval = summary?.approval ?? step.approval;
        const isSelected = selected === step.id;
        return (
          <li
            key={step.id}
            id={compact ? undefined : `${STEP_HASH_PREFIX}${step.id}`}
            data-testid={`flow-step-${step.id}`}
            aria-current={isSelected ? 'true' : undefined}
            className={cn('rounded-md border p-3 text-sm', isSelected && 'border-primary bg-primary/5')}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{index + 1}.</span>
              {compact ? (
                <span className="font-mono text-xs">{step.id}</span>
              ) : (
                <button
                  type="button"
                  data-testid={`flow-step-${step.id}-select`}
                  className="font-mono text-xs font-medium hover:underline"
                  onClick={() => {
                    window.location.hash = `${STEP_HASH_PREFIX}${step.id}`;
                    setSelected(step.id);
                  }}
                >
                  {step.id}
                </button>
              )}
              <span className="font-medium" data-testid={`flow-step-${step.id}-tool`}>{step.tool}</span>
              {summary && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {t(/* i18n-dynamic */ `step.source.${summary.source}`)}
                </span>
              )}
              {tier !== null && (
                <span
                  data-testid={`flow-step-${step.id}-tier`}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium"
                >
                  {t('step.tier', { tier })}
                </span>
              )}
              <span className="text-xs text-muted-foreground" data-testid={`flow-step-${step.id}-approval`}>
                {approval === 'pre_approved' ? t('step.approvalPreApproved') : t('step.approvalDefault')}
              </span>
            </div>
            {!compact && (
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                {step.when && (
                  <div>
                    <dt className="text-muted-foreground">{t('step.when')}</dt>
                    <dd className="font-mono">{step.when}</dd>
                  </div>
                )}
                {step.forEach && (
                  <div>
                    <dt className="text-muted-foreground">{t('step.forEach')}</dt>
                    <dd className="font-mono">{step.forEach.items}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">{t('step.onFailure')}</dt>
                  <dd className="font-mono">{step.onFailure}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('step.timeout')}</dt>
                  <dd className="font-mono">{step.timeoutSec}s</dd>
                </div>
              </dl>
            )}
            {!compact && (
              <details className="mt-2" data-testid={`flow-step-${step.id}-input`}>
                <summary className="cursor-pointer text-xs text-muted-foreground">{t('step.input')}</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(step.input, null, 2)}
                </pre>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
