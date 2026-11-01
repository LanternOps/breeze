import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDocumentV1, FlowRunStepDetailDto, FlowRunStepSummaryDto } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { getFlowRunStep } from './api';
import { formatDurationMs, statusChipClass } from './flowRunFormat';

type BodyState =
  | { kind: 'loading' }
  | { kind: 'ready'; step: FlowRunStepDetailDto }
  | { kind: 'error' };

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** One display unit: 1 item (its attempt rows) or 2+ items that ran in parallel. */
type ItemCluster = { items: number; rows: FlowRunStepSummaryDto[] };

/**
 * Splits one step's for-each item rows into display units. Rows are first
 * folded per ITEM (retry attempts of one item are not parallel items): an item's
 * interval runs from its earliest attempt's startedAt to its latest attempt's
 * finishedAt (open-ended if any attempt is unfinished). Items whose intervals
 * overlap form one parallel group (2+ items), anything else a single item. An
 * item with no started attempt never groups. Rows within a cluster are ordered
 * by (itemIndex, attempt).
 */
function clusterItems(rows: FlowRunStepSummaryDto[]): ItemCluster[] {
  const byItem = new Map<number, FlowRunStepSummaryDto[]>();
  for (const r of rows) {
    const k = r.itemIndex ?? 0;
    const list = byItem.get(k) ?? [];
    list.push(r);
    byItem.set(k, list);
  }
  const order = (a: FlowRunStepSummaryDto, b: FlowRunStepSummaryDto) =>
    (a.itemIndex ?? 0) - (b.itemIndex ?? 0) || a.attempt - b.attempt;
  type Unit = { index: number; rows: FlowRunStepSummaryDto[]; start: number | null; end: number };
  const units: Unit[] = [...byItem.entries()].map(([index, list]) => {
    const started = list.filter((r) => r.startedAt);
    const start = started.length > 0 ? Math.min(...started.map((r) => new Date(r.startedAt!).getTime())) : null;
    const end = list.some((r) => !r.finishedAt)
      ? Infinity
      : Math.max(...list.map((r) => new Date(r.finishedAt!).getTime()));
    return { index, rows: list.slice().sort(order), start, end };
  });
  const timed = units.filter((u) => u.start !== null).sort((a, b) => a.start! - b.start!);
  const untimed = units.filter((u) => u.start === null);
  const clusters: Unit[][] = [];
  let end = -Infinity;
  for (const u of timed) {
    if (clusters.length > 0 && u.start! < end) {
      clusters[clusters.length - 1].push(u);
      end = Math.max(end, u.end);
    } else {
      clusters.push([u]);
      end = u.end;
    }
  }
  for (const u of untimed) clusters.push([u]);
  const first = (c: Unit[]) => Math.min(...c.map((u) => u.index));
  return clusters
    .sort((a, b) => first(a) - first(b))
    .map((c) => ({ items: c.length, rows: c.flatMap((u) => u.rows).sort(order) }));
}

/**
 * Steps in definition order merged with the run's step rows. Unreached steps
 * are greyed, for-each items nest under their step, and bodies load lazily
 * when a row is expanded and reload when the row's status / timing changes.
 */
export function FlowRunTimeline({
  runId,
  definition,
  steps,
  bodiesPrunedAt = null,
  runActive = false,
}: {
  runId: string;
  definition: FlowDocumentV1;
  steps: FlowRunStepSummaryDto[];
  /** Set once retention pruned the run's bodies; null + `bodiesPruned` rows means the API redacted them for this reader. */
  bodiesPrunedAt?: string | null;
  /** True while the run is non-terminal: steps not yet reached read "Pending" instead of "Not reached". */
  runActive?: boolean;
}) {
  const { t } = useTranslation('flows');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  /** rowId -> the status key its in-flight / loaded body was fetched for. */
  const requested = useRef<Map<string, string>>(new Map());

  const byStep = new Map<string, FlowRunStepSummaryDto[]>();
  for (const row of steps) {
    const list = byStep.get(row.stepId) ?? [];
    list.push(row);
    byStep.set(row.stepId, list);
  }
  const known = new Set(definition.steps.map((s) => s.id));
  const groups = [
    ...definition.steps.map((s) => ({ id: s.id, tool: s.tool })),
    ...[...byStep.keys()].filter((id) => !known.has(id)).map((id) => ({ id, tool: byStep.get(id)![0].tool })),
  ];

  const load = (row: FlowRunStepSummaryDto) => {
    const rowId = row.id;
    const key = `${row.status}|${row.finishedAt ?? ''}|${row.durationMs ?? ''}`;
    if (requested.current.get(rowId) === key) return;
    requested.current.set(rowId, key);
    // Keep showing the previous body while a changed row reloads (no flicker).
    setBodies((b) => (b[rowId]?.kind === 'ready' ? b : { ...b, [rowId]: { kind: 'loading' } }));
    getFlowRunStep(runId, rowId)
      .then((step) => {
        if (requested.current.get(rowId) === key) setBodies((b) => ({ ...b, [rowId]: { kind: 'ready', step } }));
      })
      .catch(() => {
        if (requested.current.get(rowId) !== key) return;
        requested.current.delete(rowId); // a failed load is never cached: the next expand / poll retries
        setBodies((b) => ({ ...b, [rowId]: { kind: 'error' } }));
      });
  };

  useEffect(() => {
    for (const row of steps) {
      if (open[row.id] && !row.bodiesPruned) load(row);
    }
  }, [steps, open]);

  const toggle = (row: FlowRunStepSummaryDto) => {
    setOpen((o) => ({ ...o, [row.id]: !o[row.id] }));
  };

  const renderBody = (row: FlowRunStepSummaryDto) => {
    if (row.bodiesPruned) {
      return <p className="text-xs text-muted-foreground" data-testid={`flow-run-step-pruned-${row.id}`}>{bodiesPrunedAt ? t('runDetail.step.pruned') : t('runDetail.step.redacted')}</p>;
    }
    const state = bodies[row.id];
    if (!state || state.kind === 'loading') {
      return <p className="text-xs text-muted-foreground" data-testid={`flow-run-step-loading-${row.id}`}>{t('runDetail.step.loading')}</p>;
    }
    if (state.kind === 'error') {
      return <p className="text-xs text-destructive" data-testid={`flow-run-step-error-${row.id}`}>{t('runDetail.step.loadFailed')}</p>;
    }
    const { step } = state;
    const out = step.output as { status?: unknown } | null;
    const httpStatus = row.tool === 'http_request' && out && typeof out.status === 'number' ? out.status : null;
    return (
      <div className="space-y-2" data-testid={`flow-run-step-body-${row.id}`}>
        {httpStatus !== null && (
          <p className="text-xs font-medium" data-testid={`flow-run-step-httpstatus-${row.id}`}>
            {t('runDetail.step.httpStatus', { status: httpStatus })}
          </p>
        )}
        <div>
          <div className="text-xs font-medium">{t('runDetail.step.input')}</div>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{json(step.renderedInput)}</pre>
        </div>
        <div>
          <div className="text-xs font-medium">{t('runDetail.step.output')}</div>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{json(step.output)}</pre>
          {step.outputTruncated && (
            <p className="text-xs text-muted-foreground" data-testid={`flow-run-step-truncated-${row.id}`}>{t('runDetail.step.truncated')}</p>
          )}
        </div>
      </div>
    );
  };

  const renderRow = (row: FlowRunStepSummaryDto, itemRow: boolean) => {
    const expanded = !!open[row.id];
    return (
      <li
        key={row.id}
        className={cn('rounded border p-2', itemRow && 'ml-4')}
        data-testid={itemRow ? `flow-run-item-${row.id}` : `flow-run-row-${row.id}`}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {itemRow && <span className="font-medium">{t('runDetail.step.item', { index: (row.itemIndex ?? 0) + 1 })}</span>}
          <span className={statusChipClass(row.status)} data-testid={`flow-run-step-status-${row.id}`}>
            {t(/* i18n-dynamic */ `runDetail.step.status.${row.status}`)}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs" data-testid={`flow-run-step-approval-${row.id}`}>
            {t(/* i18n-dynamic */ `runDetail.step.approval.${row.approvalMode}`)}
          </span>
          {row.approvedByUserId && (
            <span className="text-xs text-muted-foreground" data-testid={`flow-run-step-approver-${row.id}`}>
              {t('runDetail.step.approver', { id: row.approvedByUserId })}
            </span>
          )}
          {row.attempt > 1 && <span className="text-xs text-muted-foreground">{t('runDetail.step.attempt', { n: row.attempt })}</span>}
          <span className="text-xs text-muted-foreground" data-testid={`flow-run-step-duration-${row.id}`}>{formatDurationMs(row.durationMs)}</span>
          <button
            type="button"
            className="ml-auto text-xs text-primary hover:underline"
            aria-expanded={expanded}
            data-testid={`flow-run-step-toggle-${row.id}`}
            onClick={() => toggle(row)}
          >
            {expanded ? t('runDetail.step.hide') : t('runDetail.step.show')}
          </button>
        </div>
        {row.aiUsage && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`flow-run-step-aiusage-${row.id}`}>
            {t('runDetail.step.aiUsage', {
              input: row.aiUsage.inputTokens,
              output: row.aiUsage.outputTokens,
              cost: formatCents(row.aiUsage.costCents),
            })}
          </p>
        )}
        {row.errorCode && (
          <p className="mt-1 text-xs text-destructive" data-testid={`flow-run-step-errorcode-${row.id}`}>
            {t(/* i18n-dynamic */ `runDetail.error.${row.errorCode}`, { defaultValue: row.errorCode })}
          </p>
        )}
        {expanded && <div className="mt-2">{renderBody(row)}</div>}
      </li>
    );
  };

  return (
    <ol className="space-y-2" data-testid="flow-run-timeline">
      {groups.map((g) => {
        const rows = (byStep.get(g.id) ?? []).slice().sort((a, b) => (a.itemIndex ?? -1) - (b.itemIndex ?? -1) || a.attempt - b.attempt);
        const reached = rows.length > 0;
        return (
          <li
            key={g.id}
            className={cn('space-y-2 rounded-md border p-3', !reached && 'opacity-50')}
            data-testid={`flow-run-step-${g.id}`}
            data-reached={reached ? 'true' : 'false'}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono font-medium">{g.id}</span>
              <span className="text-xs text-muted-foreground">{g.tool}</span>
              {!reached && <span className="text-xs italic text-muted-foreground">{runActive ? t('runDetail.step.pending') : t('runDetail.step.notReached')}</span>}
            </div>
            {reached && (
              <ul className="space-y-2">
                {[
                  ...rows.filter((row) => row.itemIndex === null).map((row) => renderRow(row, false)),
                  ...clusterItems(rows.filter((row) => row.itemIndex !== null)).map((cluster) =>
                    cluster.items > 1 ? (
                      <li key={`group-${cluster.rows[0].id}`} className="space-y-2 rounded border border-dashed p-2" data-testid="flow-run-parallel-group">
                        <p className="text-xs text-muted-foreground">{t('runDetail.parallel', { count: cluster.items })}</p>
                        <ul className="space-y-2">
                          {cluster.rows.map((row) => renderRow(row, true))}
                        </ul>
                      </li>
                    ) : (
                      cluster.rows.map((row) => renderRow(row, true))
                    ),
                  ),
                ]}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
