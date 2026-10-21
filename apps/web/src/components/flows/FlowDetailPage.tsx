import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDetailDto, FlowValidationResult } from '@breeze/shared';
import { useFlowsGate } from '../../stores/featuresStore';
import { ScopeBadge } from '../shared/ScopeBadge';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { getFlow } from './api';
import { FlowStepList } from './FlowStepList';
import { FlowIssuesPanel } from './FlowIssuesPanel';
import { TriggerSummary } from './TriggerSummary';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; flow: FlowDetailDto; validation: FlowValidationResult }
  | { kind: 'not_found' }
  | { kind: 'error' };

/**
 * Read-only flow detail (#5218 W3 PR B). No enable / edit / delete controls:
 * flows are drafted in AI chat and only reviewed here.
 */
export default function FlowDetailPage({ flowId }: { flowId: string }) {
  const { t } = useTranslation('flows');
  const { enabled, loaded } = useFlowsGate();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getFlow(flowId)
      .then(({ flow, validation }) => {
        if (!cancelled) setState({ kind: 'ready', flow, validation });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number } | null)?.status;
        setState({ kind: status === 404 ? 'not_found' : 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, flowId]);

  const notFound = (
    <p className="p-4 text-sm text-muted-foreground" data-testid="flow-not-found">{t('errors.notFound')}</p>
  );

  if (!enabled) return loaded ? notFound : null;
  if (state.kind === 'not_found') return notFound;
  if (state.kind === 'error') {
    return <p className="p-4 text-sm text-destructive" data-testid="flow-error">{t('errors.loadFailed')}</p>;
  }
  if (state.kind === 'loading') return null;

  const { flow, validation } = state;
  const { definition } = flow;

  return (
    <div className="space-y-6 p-4" data-testid="flow-detail">
      <a className="text-sm text-primary hover:underline" href="/flows" data-testid="flow-back">
        {t('detail.back')}
      </a>

      <header className="space-y-1">
        <h1 className="text-xl font-semibold" data-testid="flow-name">{flow.name}</h1>
        {flow.description && <p className="max-w-2xl text-sm text-muted-foreground">{flow.description}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{flow.slug}</span>
          <span className="rounded bg-muted px-1.5 py-0.5" data-testid="flow-status">{t(/* i18n-dynamic */ `status.${flow.status}`)}</span>
          <span>{t('detail.version', { version: flow.definitionVersion })}</span>
          <ScopeBadge orgId={flow.orgId} partnerId={flow.partnerId} isSystem={false} />
          <span>{t('step.tier', { tier: flow.effectiveTier })}</span>
          <span>{formatDateTime(flow.updatedAt)}</span>
          {flow.aiSessionId && <span>{t('detail.createdInChat')}</span>}
        </div>
      </header>

      <p
        className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
        data-testid="flow-preview-notice"
      >
        {t('previewNotice')}
      </p>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('detail.trigger')}</h2>
        <p className="font-mono text-sm" data-testid="flow-trigger">
          <TriggerSummary trigger={definition.trigger} />
        </p>
      </section>

      {definition.inputs.length > 0 && (
        <section className="space-y-2" data-testid="flow-inputs">
          <h2 className="text-sm font-semibold">{t('detail.inputs')}</h2>
          <table className="w-full text-sm">
            <tbody>
              {definition.inputs.map((input) => (
                <tr key={input.name} className="border-t">
                  <td className="p-2 font-mono">{input.name}</td>
                  <td className="p-2 text-muted-foreground">{input.type}</td>
                  <td className="p-2 text-muted-foreground">{input.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <FlowIssuesPanel issues={validation.issues} />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('detail.steps')}</h2>
        <FlowStepList steps={definition.steps} summaries={validation.steps} />
      </section>
    </div>
  );
}
