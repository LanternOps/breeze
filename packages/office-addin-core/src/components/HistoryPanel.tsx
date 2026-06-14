/**
 * Conversation history (per-user, workbook-tagged). Opened from the pane
 * header; lists THIS user's past Excel-client sessions newest-first, each
 * tagged with the workbook it happened in. Clicking a row resumes that session
 * (the controller re-GETs its history and reopens the live stream).
 *
 * The list is fetched lazily on open via the controller, which delegates to
 * GET /client-ai/sessions — a strictly caller-scoped endpoint.
 */
import { useEffect, useState } from 'react';
import type { SessionListItem } from '../api/types';

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function rowLabel(item: SessionListItem): string {
  const title = item.title?.trim();
  if (title) return title;
  return 'Untitled conversation';
}

export function HistoryPanel({
  load,
  onResume,
  onClose,
}: {
  load: () => Promise<SessionListItem[]>;
  onResume: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');

  useEffect(() => {
    let disposed = false;
    setState('loading');
    load()
      .then((rows) => {
        if (disposed) return;
        setItems(rows);
        setState('loaded');
      })
      .catch(() => {
        if (!disposed) setState('error');
      });
    return () => {
      disposed = true;
    };
  }, [load]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-white" data-testid="history-panel">
      {/* pr-10: keep the close × clear of Office's pinned top-right pane button (Mac). */}
      <div className="flex items-center justify-between border-b border-gray-100 py-2 pl-3 pr-10">
        <span className="text-sm font-semibold text-gray-800">Conversation history</span>
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-semibold text-gray-500 hover:text-gray-800"
          aria-label="Close history"
          data-testid="history-close"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {state === 'loading' && (
          <div className="p-4 text-center text-sm text-gray-400" data-testid="history-loading">
            Loading…
          </div>
        )}
        {state === 'error' && (
          <div className="p-4 text-center text-sm text-red-600" data-testid="history-error">
            Couldn&apos;t load your history. Try again.
          </div>
        )}
        {state === 'loaded' && items.length === 0 && (
          <div className="p-4 text-center text-sm text-gray-400" data-testid="history-empty">
            No past conversations yet.
          </div>
        )}
        {state === 'loaded' && items.length > 0 && (
          <div className="space-y-1">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onResume(item.id)}
                className="block w-full rounded-md border border-gray-200 p-2 text-left hover:border-blue-400"
                data-testid={`history-item-${item.id}`}
              >
                <div className="truncate text-sm font-medium text-gray-800">{rowLabel(item)}</div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-gray-500">
                  <span className="flex items-center gap-1.5">
                    {item.workbookName && (
                      <span
                        className="truncate rounded bg-gray-100 px-1.5 py-0.5 text-gray-600"
                        data-testid="history-workbook-tag"
                      >
                        {item.workbookName}
                      </span>
                    )}
                    <span>
                      {item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'}
                    </span>
                  </span>
                  <span className="shrink-0">{formatWhen(item.lastActivityAt ?? item.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
