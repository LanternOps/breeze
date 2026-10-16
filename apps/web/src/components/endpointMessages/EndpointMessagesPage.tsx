import '@/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { usePermissions } from '@/lib/permissions';
import { ActionError } from '@/lib/runAction';
import { useHashState } from '@/lib/useHashState';
import {
  getEndpointMessage,
  listEndpointMessages,
  resendEndpointMessage,
  retractEndpointMessage,
  type EndpointMessageDetail,
  type EndpointMessageListItem,
} from '@/lib/endpointMessages';
import EndpointMessageDetailView from './EndpointMessageDetailView';
import { SeverityBadge, StatusSummary } from './messageBadges';

const PAGE_SIZE = 50;
const RESEND_ERROR_CODES = new Set(['retracted', 'body_purged', 'in_progress', 'idempotency_conflict', 'nothing_to_resend']);

// The selected batch lives in the URL hash (`#<id>`), per CLAUDE.md.
const idFromHash = (hash: string): string | null => (/^[0-9a-zA-Z-]{1,64}$/.test(hash) ? hash : null);

function toListItem(d: EndpointMessageDetail): EndpointMessageListItem {
  const { body: _body, deliveries: _deliveries, ...item } = d;
  return item;
}

export default function EndpointMessagesPage() {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  const canRead = can('endpoint_messages', 'read');
  const canSend = can('endpoint_messages', 'send');
  const h = 'endpointMessages.history';

  const [items, setItems] = useState<EndpointMessageListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useHashState<string | null>(null, idFromHash);
  const [detail, setDetail] = useState<EndpointMessageDetail | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'missing'>('idle');
  const [confirmRetract, setConfirmRetract] = useState(false);
  const [busy, setBusy] = useState(false);
  const detailSeq = useRef(0);
  // The selection after an await: a mutation's refresh must not replace a
  // different message the user selected meanwhile.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const loadFirstPage = useCallback(async () => {
    try {
      const page = await listEndpointMessages({ limit: PAGE_SIZE });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setListState('ready');
    } catch {
      setListState('error');
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    setListState('loading');
    void loadFirstPage();
  }, [canRead, loadFirstPage]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listEndpointMessages({ limit: PAGE_SIZE, cursor: nextCursor });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      showToast({ message: t(`${h}.loadFailed`), type: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    try {
      const d = await getEndpointMessage(id);
      if (seq !== detailSeq.current) return;
      if (!d) {
        setDetail(null);
        setDetailState('missing');
        return;
      }
      setDetail(d);
      setDetailState('ready');
      // Keep the list row's counts and retracted flag in step with the detail.
      setItems((prev) => prev.map((i) => (i.id === d.id ? toListItem(d) : i)));
    } catch {
      if (seq === detailSeq.current) setDetailState('error');
    }
  }, []);

  useEffect(() => {
    if (!canRead || !selectedId) {
      detailSeq.current++;
      setDetail(null);
      setDetailState('idle');
      return;
    }
    setDetailState('loading');
    void loadDetail(selectedId);
  }, [canRead, selectedId, loadDetail]);

  const select = (id: string) => {
    window.location.hash = id;
    setSelectedId(id);
  };

  const handleRetract = async () => {
    if (!detail) return;
    setConfirmRetract(false);
    setBusy(true);
    try {
      await retractEndpointMessage(detail.id, {
        errorFallback: t(`${h}.messages.retractFailed`),
        successMessage: (data) => {
          const failed = data.results.filter((r) => r.status === 'failed').length;
          return failed > 0
            ? t(`${h}.messages.retractPartial`, { count: failed })
            : t(`${h}.messages.retractSuccess`);
        },
      });
      if (selectedRef.current === detail.id) await loadDetail(detail.id);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ message: t(`${h}.messages.retractFailed`), type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await resendEndpointMessage(detail.id, crypto.randomUUID(), {
        errorFallback: t(`${h}.messages.resendFailed`),
        friendly: (code) => (RESEND_ERROR_CODES.has(code) ? t(`${h}.resendErrors.${code}`) : undefined),
        successMessage: (data) => t(`${h}.messages.resendSuccess`, { count: data.deviceCount }),
      });
      await Promise.all([selectedRef.current === detail.id ? loadDetail(detail.id) : Promise.resolve(), loadFirstPage()]);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ message: t(`${h}.messages.resendFailed`), type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!canRead) {
    return (
      <p className="rounded-md border bg-muted/40 px-4 py-3 text-sm" data-testid="endpoint-messages-no-access">
        {t(`${h}.noAccess`)}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t(`${h}.title`)}</h1>
        <p className="text-sm text-muted-foreground">{t(`${h}.description`)}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-2">
          {listState === 'loading' && <p className="text-sm text-muted-foreground">{t(`${h}.loading`)}</p>}
          {listState === 'error' && (
            <div className="space-y-2 text-sm">
              <p className="text-destructive">{t(`${h}.loadFailed`)}</p>
              <button type="button" onClick={() => { setListState('loading'); void loadFirstPage(); }} className="h-8 rounded-md border px-3 hover:bg-muted">
                {t(`${h}.retry`)}
              </button>
            </div>
          )}
          {listState === 'ready' && items.length === 0 && <p className="text-sm text-muted-foreground">{t(`${h}.empty`)}</p>}
          <ul className="space-y-2">
            {items.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  data-testid={`endpoint-message-row-${m.id}`}
                  aria-current={m.id === selectedId ? 'true' : undefined}
                  onClick={() => select(m.id)}
                  className={`w-full rounded-md border px-3 py-2 text-left hover:bg-muted/50 ${m.id === selectedId ? 'border-primary bg-muted/40' : 'bg-background'}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.title ?? t(`${h}.purgedListTitle`)}</span>
                    <SeverityBadge severity={m.severity} />
                    {m.retractedAt && <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{t(`${h}.badgeRetracted`)}</span>}
                    {m.aiInitiated && <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">{t(`${h}.badgeAi`)}</span>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(m.createdAt).toLocaleString()} · {t(`${h}.devicesLabel`, { count: m.deviceCount })}
                  </p>
                  <StatusSummary counts={m.statusCounts} />
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <button
              type="button"
              data-testid="endpoint-message-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="h-9 w-full rounded-md border text-sm hover:bg-muted disabled:opacity-50"
            >
              {loadingMore ? t(`${h}.loading`) : t(`${h}.loadMore`)}
            </button>
          )}
        </div>

        <div>
          {detailState === 'idle' && <p className="text-sm text-muted-foreground">{t(`${h}.selectPrompt`)}</p>}
          {detailState === 'loading' && <p className="text-sm text-muted-foreground">{t(`${h}.loading`)}</p>}
          {detailState === 'missing' && <p className="text-sm text-muted-foreground">{t(`${h}.notFound`)}</p>}
          {detailState === 'error' && <p className="text-sm text-destructive">{t(`${h}.detailLoadFailed`)}</p>}
          {detailState === 'ready' && detail && (
            <EndpointMessageDetailView
              detail={detail}
              canSend={canSend}
              busy={busy}
              onRetract={() => setConfirmRetract(true)}
              onResend={() => void handleResend()}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmRetract}
        onClose={() => setConfirmRetract(false)}
        onConfirm={() => void handleRetract()}
        title={t(`${h}.retractConfirm.title`)}
        message={t(`${h}.retractConfirm.message`)}
        confirmLabel={t(`${h}.retractConfirm.confirm`)}
        variant="warning"
        confirmTestId="endpoint-message-retract-confirm"
      />
    </div>
  );
}
