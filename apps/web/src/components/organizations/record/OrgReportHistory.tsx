import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CalendarClock, FileText, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/lib/dateTimeFormat';
import { useLatest, type OrgFetch } from './orgRecordFetch';

/** `GET /reports?orgId=<orgId>` row — only the fields this read-only view shows. */
export interface ReportHistoryDefinition {
  id: string;
  name: string;
  type: string;
  schedule: string;
  format: string;
  lastGeneratedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

/** `GET /reports/runs?orgId=<orgId>&limit=25` row. */
export interface ReportHistoryRun {
  id: string;
  reportId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  rowCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  reportName?: string;
  reportType?: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; definitions: ReportHistoryDefinition[]; runs: ReportHistoryRun[] }
  | { kind: 'forbidden' }
  | { kind: 'error' };

/**
 * Read-only report history for an inactive organization (#6771).
 *
 * An active MSP retains the right to read a suspended/churned/archived
 * customer's report definitions and run metadata for its own records, but
 * generate, schedule, export and download stay refused server-side — so this
 * card renders plain text only, never an action control. Both requests go
 * through the record's org-pinned `orgFetch`, which appends `orgId` itself
 * (`applyOrgId` in `stores/auth.ts`), so the request always names this org
 * explicitly even though it is outside `computeAccessibleOrgIds`.
 */
export default function OrgReportHistory({
  orgId,
  orgFetch,
  statusLabel,
}: {
  orgId: string;
  orgFetch: OrgFetch;
  statusLabel: string;
}) {
  const { t } = useTranslation(['organizations', 'reports']);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const latest = useLatest<LoadState>();

  /** Every key in this card lives under one namespace prefix. */
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.reportHistory.${key}`, vars ?? {}),
    [t],
  );

  const load = useCallback(async () => {
    const result = await latest.run(
      (async (): Promise<LoadState> => {
        try {
          const [defRes, runRes] = await Promise.all([orgFetch('/reports'), orgFetch('/reports/runs?limit=25')]);
          if (defRes.status === 403 || runRes.status === 403) return { kind: 'forbidden' };
          if (!defRes.ok || !runRes.ok) return { kind: 'error' };
          const [defJson, runJson] = (await Promise.all([defRes.json(), runRes.json()])) as [
            { data?: unknown },
            { data?: unknown },
          ];
          return {
            kind: 'loaded',
            definitions: Array.isArray(defJson.data) ? (defJson.data as ReportHistoryDefinition[]) : [],
            runs: Array.isArray(runJson.data) ? (runJson.data as ReportHistoryRun[]) : [],
          };
        } catch (err) {
          console.error('[OrgReportHistory] failed to load report history', err);
          return { kind: 'error' };
        }
      })(),
    );
    if (result === undefined) return;
    setState(result);
  }, [latest, orgFetch]);

  useEffect(() => {
    setState({ kind: 'loading' });
    void load();
  }, [load, orgId]);

  const scheduleLabel = (schedule: string) =>
    t(/* i18n-dynamic */ `reports:reports.reportsList.schedules.${schedule}`, { defaultValue: schedule });
  const statusValueLabel = (status: string) =>
    t(/* i18n-dynamic */ `reports:reports.reportsList.status.${status}`, { defaultValue: status });
  const typeLabel = (type: string) =>
    t(/* i18n-dynamic */ `reports:reports.reportsList.reportTypes.${type}`, { defaultValue: type });

  return (
    <section data-testid="org-report-history" className="rounded-lg border bg-card">
      <header className="flex items-center gap-1.5 border-b px-4 py-2.5">
        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">{tr('title')}</h2>
      </header>

      <p className="flex items-start gap-1.5 border-b bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{tr('readOnlyNote', { status: statusLabel })}</span>
      </p>

      {state.kind === 'loading' && (
        <div data-testid="org-report-history-loading" className="space-y-2 px-4 py-3" aria-busy="true">
          <span className="sr-only">{tr('loading')}</span>
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      )}

      {state.kind === 'forbidden' && (
        <p data-testid="org-report-history-forbidden" className="px-4 py-4 text-sm text-muted-foreground">
          {tr('forbidden')}
        </p>
      )}

      {state.kind === 'error' && (
        <p data-testid="org-report-history-error" className="flex items-center gap-1.5 px-4 py-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          {tr('error')}
        </p>
      )}

      {state.kind === 'loaded' && state.definitions.length === 0 && state.runs.length === 0 && (
        <p data-testid="org-report-history-empty" className="px-4 py-4 text-sm text-muted-foreground">
          {tr('empty')}
        </p>
      )}

      {state.kind === 'loaded' && (state.definitions.length > 0 || state.runs.length > 0) && (
        <div className="divide-y">
          <div className="px-4 py-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {tr('definitionsTitle')}
            </h3>
            {state.definitions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tr('definitionsEmpty')}</p>
            ) : (
              <ul className="space-y-2">
                {state.definitions.map((def) => (
                  <li key={def.id} data-testid="org-report-history-definition" className="text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{def.name}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {typeLabel(def.type)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {scheduleLabel(def.schedule)}
                      {' · '}
                      {def.lastGeneratedAt
                        ? tr('lastGenerated', { date: formatDate(def.lastGeneratedAt) })
                        : tr('neverGenerated')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="px-4 py-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tr('runsTitle')}</h3>
            {state.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tr('runsEmpty')}</p>
            ) : (
              <ul className="space-y-2">
                {state.runs.map((run) => (
                  <li key={run.id} data-testid="org-report-history-run" className="text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{run.reportName ?? run.reportId}</span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        <CalendarClock className="h-3 w-3" aria-hidden="true" />
                        {statusValueLabel(run.status)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(run.completedAt ?? run.createdAt)}
                      {typeof run.rowCount === 'number' ? ` · ${tr('rowCount', { count: run.rowCount })}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
