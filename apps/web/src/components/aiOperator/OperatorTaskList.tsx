/**
 * Org-wide Operator task list for the /operator workspace (W06 R1b). The
 * server's `GET /ai/operator/tasks` already scopes to the caller's orgs and
 * sites, and to the switcher's org via the `?orgId=` `fetchWithAuth` injects
 * (#10112); this lists every task it returns, newest first, with its keyset
 * cursor. Same shape as `OperatorTaskActivityFeed` without the device filter.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { AiOperatorTaskListItemDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { taskStateLabel } from './operatorTaskLabels';
import { WorkflowsLoadError, readServerError } from '@/lib/api/aiOperatorWorkflows';

const PAGE_SIZE = 25;

type Page = { data: AiOperatorTaskListItemDto[]; nextCursor: string | null };

async function fetchPage(cursor: string | null): Promise<Page> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  const res = await fetchWithAuth(`/ai/operator/tasks?${params.toString()}`);
  if (!res.ok) {
    throw new WorkflowsLoadError(res.status, res.status >= 400 && res.status < 500 ? await readServerError(res) : null);
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown; nextCursor?: unknown } | null;
  // A wrong-shaped body is a broken response, not "no tasks".
  if (!body || !Array.isArray(body.data)) throw new Error('task list malformed');
  return { data: body.data as AiOperatorTaskListItemDto[], nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null };
}

export default function OperatorTaskList() {
  const { t } = useTranslation('aiOperator');
  const [tasks, setTasks] = useState<AiOperatorTaskListItemDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  /** A 4xx refusal's own text, shown without a Retry that cannot change it. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);

  const loadFirst = useCallback(async () => {
    const mine = ++seq.current;
    setStatus('loading');
    try {
      const page = await fetchPage(null);
      if (mine !== seq.current) return;
      setTasks(page.data);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (err) {
      if (mine !== seq.current) return;
      console.error('[operator-task-list] load failed', err);
      setRefusal(err instanceof WorkflowsLoadError && !err.retryable ? err.serverMessage ?? t('taskList.loadFailed') : null);
      setStatus('error');
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const mine = seq.current;
    setMoreStatus('loading');
    try {
      const page = await fetchPage(cursor);
      if (mine !== seq.current) return;
      setTasks((prev) => [...prev, ...page.data.filter((p) => !prev.some((x) => x.id === p.id))]);
      setCursor(page.nextCursor);
      setMoreStatus('idle');
    } catch (err) {
      if (mine !== seq.current) return;
      console.error('[operator-task-list] next page failed', err);
      setMoreStatus('error');
    }
  }, [cursor]);

  useEffect(() => {
    void loadFirst();
    return () => { seq.current += 1; };
  }, [loadFirst]);

  if (status === 'loading') {
    return <p data-testid="operator-task-list-loading" className="text-sm text-muted-foreground">{t('taskList.loading')}</p>;
  }
  if (status === 'error') {
    return (
      <div data-testid="operator-task-list-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{refusal ?? t('taskList.loadFailed')}</p>
        {refusal === null && (
          <button
            type="button"
            data-testid="operator-task-list-retry"
            onClick={() => void loadFirst()}
            className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('common:actions.retry')}
          </button>
        )}
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div data-testid="operator-task-list-empty" className="rounded-lg border p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t('taskList.empty')}</p>
        <p className="mt-1">{t('taskList.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul data-testid="operator-task-list" className="divide-y rounded-lg border">
        {tasks.map((task) => (
          <li key={task.id}>
            <a
              href={`/operator/tasks/${task.id}`}
              data-testid={`operator-task-list-row-${task.id}`}
              className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/50"
            >
              <span className="inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-xs font-medium">
                {taskStateLabel(t, task.state)}
              </span>
              <span className="truncate font-medium">{task.objective}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatDateTime(task.updatedAt)}</span>
            </a>
          </li>
        ))}
      </ul>
      {cursor && (
        <div className="text-center">
          <button
            type="button"
            data-testid="operator-task-list-more"
            disabled={moreStatus === 'loading'}
            onClick={() => void loadMore()}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {t('taskList.loadMore')}
          </button>
          {moreStatus === 'error' && (
            <p role="alert" data-testid="operator-task-list-more-error" className="mt-1 text-xs text-destructive">
              {t('taskList.loadMoreFailed')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
