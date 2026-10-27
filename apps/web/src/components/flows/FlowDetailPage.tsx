import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDetailDto, FlowValidationResult } from '@breeze/shared';
import { useFlowsGate } from '../../stores/featuresStore';
import { ScopeBadge } from '../shared/ScopeBadge';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { ActionError } from '@/lib/runAction';
import { usePermissions } from '@/lib/permissions';
import { useHashTab } from '@/lib/useHashState';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';
import { disableFlow, getFlow } from './api';
import { FlowEnableDialog } from './FlowEnableDialog';
import { FlowRunDialog } from './FlowRunDialog';
import { FlowRunsTab } from './FlowRunsTab';
import { FlowStepList } from './FlowStepList';
import { FlowIssuesPanel } from './FlowIssuesPanel';
import { FlowRefusalBanner, FlowUsageMeter } from './FlowUsageMeter';
import { FlowWebhookPanel } from './FlowWebhookPanel';
import { TriggerSummary } from './TriggerSummary';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; flow: FlowDetailDto; validation: FlowValidationResult }
  | { kind: 'not_found' }
  | { kind: 'error' };

const TABS = ['overview', 'runs', 'webhook'] as const;

/**
 * Flow detail (#5218 W3 PR B review surface; #5219 W4 adds enable / disable /
 * run-now). Flows are still drafted in AI chat; this page reviews and operates
 * them. Actions need `automations.write` (UX only: the API re-checks).
 */
export default function FlowDetailPage({ flowId }: { flowId: string }) {
  const { t } = useTranslation('flows');
  const { enabled, loaded } = useFlowsGate();
  const { can } = usePermissions();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [reloadSeq, setReloadSeq] = useState(0);
  const [tab, setTab] = useHashTab(TABS, 'overview');
  const [enableOpen, setEnableOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);
  // W05 (#10270): the enable that just ran cleared the webhook secret.
  const [secretInvalidated, setSecretInvalidated] = useState(false);

  const reload = () => setReloadSeq((n) => n + 1);

  const confirmDisable = async () => {
    if (disabling) return;
    setDisabling(true);
    try {
      await disableFlow(flowId);
      setDisableOpen(false);
      reload();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('errors.disableFailed') }); // ActionError already toasted
      setDisableOpen(false);
      reload(); // the flow's state may have changed under us (e.g. already disabled)
    } finally {
      setDisabling(false);
    }
  };

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
  }, [enabled, flowId, reloadSeq]);

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
  const canWrite = can('automations', 'write');
  const canEnable = canWrite && (flow.status === 'draft' || flow.status === 'disabled' || flow.status === 'paused');
  const canDisable = canWrite && (flow.status === 'enabled' || flow.status === 'paused');
  const canRun = canWrite && flow.status === 'enabled' && definition.trigger.type === 'manual';
  const isWebhook = definition.trigger.type === 'webhook' && flow.webhook !== null;
  const tabs = TABS.filter((id) => id !== 'webhook' || isWebhook);
  // A #webhook hash on a flow that has no webhook falls back to the overview.
  const activeTab = tabs.includes(tab) ? tab : 'overview';
  const openTab = (id: (typeof TABS)[number]) => {
    window.location.hash = id;
    setTab(id);
  };

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
        {flow.status === 'paused' && flow.pausedReason && (
          <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="flow-paused-reason">
            {t(/* i18n-dynamic */ `status.pausedReason.${flow.pausedReason}`)}
          </p>
        )}
        <FlowRefusalBanner refusal={flow.lastAdmissionRefusal ?? null} />
        {secretInvalidated && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" data-testid="flow-webhook-secret-invalidated">
            <span>{t('enable.webhookSecretInvalidated')}</span>
            {isWebhook && (
              <button type="button" className="rounded border border-current px-2 py-0.5 text-xs" data-testid="flow-webhook-secret-invalidated-open" onClick={() => openTab('webhook')}>
                {t('webhook.secret.create')}
              </button>
            )}
          </div>
        )}
        {(canEnable || canDisable) && (
          <div className="flex flex-wrap gap-2 pt-2" data-testid="flow-actions">
            {canEnable && (
              <button type="button" className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" data-testid="flow-enable" onClick={() => setEnableOpen(true)}>
                {t('actions.enable')}
              </button>
            )}
            {canRun && (
              <button type="button" className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" data-testid="flow-run-now" onClick={() => setRunOpen(true)}>
                {t('actions.runNow')}
              </button>
            )}
            {canDisable && (
              <button type="button" className="rounded border px-3 py-1.5 text-sm" data-testid="flow-disable" onClick={() => setDisableOpen(true)}>
                {t('actions.disable')}
              </button>
            )}
          </div>
        )}
      </header>

      <div role="tablist" className="flex gap-4 border-b" data-testid="flow-tabs">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            data-testid={`flow-tab-${id}`}
            className={cn('-mb-px border-b-2 px-1 pb-2 text-sm', activeTab === id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground')}
            onClick={() => openTab(id)}
          >
            {t(/* i18n-dynamic */ `tabs.${id}`)}
          </button>
        ))}
      </div>

      {activeTab === 'runs' ? (
        <FlowRunsTab flowId={flowId} ownerScope={flow.ownerScope} />
      ) : activeTab === 'webhook' ? (
        <FlowWebhookPanel flow={flow} canWrite={canWrite} onSecretChanged={() => { setSecretInvalidated(false); reload(); }} />
      ) : (
        <>
      {flow.usage && <FlowUsageMeter usage={flow.usage} />}

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
        <FlowStepList steps={definition.steps} summaries={validation.steps} preApprovedStepIds={flow.preApprovedStepIds ?? []} />
      </section>
        </>
      )}

      {enableOpen && (
        <FlowEnableDialog
          open
          flow={flow}
          validation={validation}
          onClose={() => setEnableOpen(false)}
          onStale={reload}
          onEnabled={(result) => {
            setEnableOpen(false);
            setSecretInvalidated(result.webhookSecretInvalidated === true);
            reload();
          }}
        />
      )}
      {runOpen && <FlowRunDialog open flow={flow} onClose={() => setRunOpen(false)} />}
      <ConfirmDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirm={confirmDisable}
        title={t('disable.title')}
        message={t('disable.message')}
        confirmLabel={t('actions.disable')}
        isLoading={disabling}
        confirmTestId="flow-disable-confirm"
      />
    </div>
  );
}
