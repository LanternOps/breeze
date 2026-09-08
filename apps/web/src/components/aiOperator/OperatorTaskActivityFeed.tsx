/**
 * Device-scoped AI Operator task feed (Wave W07 of #5205, read-only side).
 * Embedded on the device detail page by another process — this file only
 * fetches and renders; it does not wire itself into DeviceDetails.tsx.
 *
 * Shape copied from `DeviceTicketsTab.tsx`: fetch on mount, loading/error
 * (with retry)/empty states, a list of link rows.
 */
import { useCallback, useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { cn } from '@/lib/utils';
import type { AiOperatorTaskListItemDto } from '@breeze/shared';
import { taskStateLabel } from './operatorTaskLabels';

export default function OperatorTaskActivityFeed({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('aiOperator');
  const [tasks, setTasks] = useState<AiOperatorTaskListItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth(`/ai/operator/tasks?deviceId=${deviceId}&limit=50`);
      if (res.ok) {
        const body = await res.json();
        setTasks((body.data ?? []) as AiOperatorTaskListItemDto[]);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground" data-testid="operator-task-feed-loading">{t('operatorTaskFeed.loading')}</p>;
  }
  if (error) {
    return (
      <div className="p-4 text-center" data-testid="operator-task-feed-error">
        <p className="text-sm text-muted-foreground">{t('operatorTaskFeed.loadFailed')}</p>
        <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="operator-task-feed-retry">{t('common:actions.retry')}</button>
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="operator-task-feed-empty">
        {t('operatorTaskFeed.empty')}
      </p>
    );
  }

  return (
    <ul className="divide-y" data-testid="operator-task-feed-list">
      {tasks.map((task) => (
        <li key={task.id}>
          <a
            href={`/operator/tasks/${task.id}`}
            className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/50"
            data-testid={`operator-task-feed-row-${task.id}`}
          >
            <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium')}>
              {taskStateLabel(t, task.state)}
            </span>
            <span className="truncate font-medium">{task.objective}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatDateTime(task.updatedAt)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
