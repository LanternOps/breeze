import { useRef, useState } from 'react';
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

/**
 * Steps in definition order merged with the run's step rows. Unreached steps
 * are greyed, for-each items nest under their step, and bodies load lazily
 * (once per step row) when a row is expanded.
 */
export function FlowRunTimeline({
  runId,
  definition,
  steps,
  bodiesPrunedAt = null,
}: {
  runId: string;
  definition: FlowDocumentV1;
  steps: FlowRunStepSummaryDto[];
  /** Set once retention pruned the run's bodies; null + `bodiesPruned` rows means the API redacted them for this reader. */
  bodiesPrunedAt?: string | null;
}) {
  const { t } = useTranslation('flows');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  const requested = useRef<Set<string>>(new Set());

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

  const load = (rowId: string) => {
    if (requested.current.has(rowId)) return;
    requested.current.add(rowId);
    setBodies((b) => ({ ...b, [rowId]: { kind: 'loading' } }));
    getFlowRunStep(runId, rowId)
      .then((step) => setBodies((b) => ({ ...b, [rowId]: { kind: 'ready', step } })))
      .catch(() => {
        requested.current.delete(rowId); // a failed load may be retried on the next expand
        setBodies((b) => ({ ...b, [rowId]: { kind: 'error' } }));
      });
  };

  const toggle = (row: FlowRunStepSummaryDto) => {
    const next = !open[row.id];
    setOpen((o) => ({ ...o, [row.id]: next }));
    if (next && !row.bodiesPruned) load(row.id);
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
    return (
      <div className="space-y-2" data-testid={`flow-run-step-body-${row.id}`}>
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
              {!reached && <span className="text-xs italic text-muted-foreground">{t('runDetail.step.notReached')}</span>}
            </div>
            {reached && (
              <ul className="space-y-2">
                {rows.map((row) => renderRow(row, row.itemIndex !== null))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
