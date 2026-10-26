import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { FLOW_RUN_STATUSES, isTerminalFlowRunStatus } from '@breeze/shared';
import type { FlowRunStatus, FlowRunSummaryDto } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useOrgStore } from '../../stores/orgStore';
import { ResponsiveTable, DataCard } from '../shared/ResponsiveTable';
import { listFlowRuns } from './api';
import { formatDurationMs, runDurationMs, statusChipClass } from './flowRunFormat';

const PAGE_LIMIT = 50;
const POLL_MS = 10_000;

/** Runs tab of the flow detail page (#5219 W4). Polls while any visible run is active. */
export function FlowRunsTab({ flowId, ownerScope }: { flowId: string; ownerScope: 'organization' | 'partner' | string }) {
  const { t } = useTranslation('flows');
  const organizations = useOrgStore((s) => s.organizations) ?? [];
  const [status, setStatus] = useState<FlowRunStatus | ''>('');
  const [runs, setRuns] = useState<FlowRunSummaryDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const showOrg = ownerScope === 'partner';

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let active = false;
      try {
        const res = await listFlowRuns(flowId, { limit: PAGE_LIMIT, ...(status ? { status } : {}) });
        if (cancelled) return;
        setRuns(res.runs);
        setFailed(false);
        active = res.runs.some((r) => !isTerminalFlowRunStatus(r.status));
      } catch {
        if (cancelled) return;
        setFailed(true);
        setRuns((prev) => prev ?? []);
        active = true; // keep trying: a failed list is not "no runs"
      }
      if (active && !cancelled && !document.hidden) timer = setTimeout(() => { void load(); }, POLL_MS);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [flowId, status]);

  const rows = runs ?? [];
  const orgName = (id: string) => organizations.find((o) => o.id === id)?.name ?? id;
  const chip = (r: FlowRunSummaryDto, testId = true) => (
    <span className={statusChipClass(r.status)} data-testid={testId ? `flow-run-status-${r.id}` : undefined}>
      {t(/* i18n-dynamic */ `runs.status.${r.status}`)}
    </span>
  );
  const trigger = (r: FlowRunSummaryDto) =>
    `${t(/* i18n-dynamic */ `runs.trigger.${r.triggerKind}`, { defaultValue: r.triggerKind })} · ${t(/* i18n-dynamic */ `runs.via.${r.triggeredVia}`, { defaultValue: r.triggeredVia })}`;
  const started = (r: FlowRunSummaryDto) => formatDateTime(r.startedAt ?? r.createdAt);
  const startedLink = (r: FlowRunSummaryDto, testId = true) => (
    <a className="font-medium hover:underline" href={`/flows/runs/${r.id}`} data-testid={testId ? `flow-run-link-${r.id}` : undefined}>
      {started(r)}
    </a>
  );
  const duration = (r: FlowRunSummaryDto) => formatDurationMs(runDurationMs(r));

  return (
    <div className="space-y-3" data-testid="flow-runs-tab">
      <div className="flex items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="flow-runs-status-filter">{t('runs.filter.label')}</label>
        <select
          id="flow-runs-status-filter"
          data-testid="flow-runs-status-filter"
          className="rounded border bg-background px-2 py-1 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value as FlowRunStatus | '')}
        >
          <option value="">{t('runs.filter.all')}</option>
          {FLOW_RUN_STATUSES.map((s) => (
            <option key={s} value={s}>{t(/* i18n-dynamic */ `runs.status.${s}`)}</option>
          ))}
        </select>
      </div>

      {failed && <p className="text-sm text-destructive" data-testid="flow-runs-error">{t('runs.loadFailed')}</p>}

      {runs !== null && rows.length === 0 && !failed ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="flow-runs-empty">
          {t('runs.empty')}
        </p>
      ) : (
        <ResponsiveTable
          table={
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">{t('runs.columns.started')}</th>
                  <th className="p-2">{t('runs.columns.status')}</th>
                  <th className="p-2">{t('runs.columns.trigger')}</th>
                  <th className="p-2">{t('runs.columns.duration')}</th>
                  {showOrg && <th className="p-2">{t('runs.columns.org')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t" data-testid={`flow-run-row-${r.id}`}>
                    <td className="p-2">{startedLink(r)}</td>
                    <td className="p-2">{chip(r)}</td>
                    <td className="p-2">{trigger(r)}</td>
                    <td className="p-2">{duration(r)}</td>
                    {showOrg && <td className="p-2">{orgName(r.orgId)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          }
          cards={
            <>
              {rows.map((r) => (
                <DataCard key={r.id}>
                  {startedLink(r, false)}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {chip(r, false)}
                    <span>{trigger(r)}</span>
                    <span>{duration(r)}</span>
                    {showOrg && <span>{orgName(r.orgId)}</span>}
                  </div>
                </DataCard>
              ))}
            </>
          }
        />
      )}
    </div>
  );
}
