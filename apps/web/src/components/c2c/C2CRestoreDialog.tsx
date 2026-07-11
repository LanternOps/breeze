import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Undo2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { formatNumber } from '@/lib/i18n/format';

type C2CItem = {
  id: string;
  itemType: string;
  userEmail: string | null;
  subjectOrName: string | null;
  parentPath: string | null;
  sizeBytes: number | null;
  itemDate: string | null;
};

type C2CConnection = {
  id: string;
  provider: string;
  displayName: string;
  status: string;
};

type C2CRestoreDialogProps = {
  items: C2CItem[];
  onClose: () => void;
  onComplete: () => void;
};

function formatBytes(bytes: number | null): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const precision = exp === 0 ? 0 : 1;
  return `${formatNumber(bytes / 1024 ** exp, { minimumFractionDigits: precision, maximumFractionDigits: precision })} ${units[exp]}`;
}

function formatDate(value: string | null): string {
  return formatDateTime(value, { fallback: '-' });
}

function formatProvider(provider: string, t: (key: string) => string): string {
  if (provider === 'microsoft_365' || provider === 'microsoft365') return t('longTail.c2c.C2CRestoreDialog.providers.microsoft365');
  if (provider === 'google_workspace') return t('longTail.c2c.C2CRestoreDialog.providers.googleWorkspace');
  return provider;
}

export default function C2CRestoreDialog({
  items: initialItems,
  onClose,
  onComplete,
}: C2CRestoreDialogProps) {
  const { t } = useTranslation('common');
  const [items, setItems] = useState<C2CItem[]>(initialItems);
  const [connections, setConnections] = useState<C2CConnection[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [itemType, setItemType] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [targetMode, setTargetMode] = useState<'original' | 'alternate'>('original');
  const [targetConnectionId, setTargetConnectionId] = useState('');
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const fetchItems = useCallback(async () => {
    try {
      setLoadingItems(true);
      setError(undefined);
      const params = new URLSearchParams({ limit: '100' });
      if (search.trim()) params.set('search', search.trim());
      if (itemType) params.set('itemType', itemType);
      if (userEmail.trim()) params.set('userEmail', userEmail.trim());
      const response = await fetchWithAuth(`/c2c/items?${params.toString()}`);
      if (!response.ok) throw new Error(t('longTail.c2c.C2CRestoreDialog.errors.loadBackupItems'));
      const payload = await response.json();
      setItems(payload?.data ?? payload?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.c2c.C2CRestoreDialog.errors.loadBackupItems'));
    } finally {
      setLoadingItems(false);
    }
  }, [itemType, search, userEmail, t]);

  const fetchConnections = useCallback(async () => {
    try {
      setLoadingConnections(true);
      const response = await fetchWithAuth('/c2c/connections');
      if (!response.ok) throw new Error(t('longTail.c2c.C2CRestoreDialog.errors.loadRestoreTargets'));
      const payload = await response.json();
      setConnections(payload?.data ?? payload?.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.c2c.C2CRestoreDialog.errors.loadRestoreTargets'));
    } finally {
      setLoadingConnections(false);
    }
  }, [t]);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    void Promise.all([fetchConnections(), initialItems.length === 0 ? fetchItems() : Promise.resolve()]);
  }, [fetchConnections, fetchItems, initialItems.length]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds]
  );

  const availableTargets = useMemo(
    () => connections.filter((connection) => connection.status === 'active'),
    [connections]
  );
  const restoreAvailable = false;

  const canSubmit =
    restoreAvailable &&
    selectedIds.size > 0 &&
    (targetMode === 'original' || (targetMode === 'alternate' && !!targetConnectionId));

  const toggleItem = (itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const handleRestore = useCallback(async () => {
    if (!canSubmit) return;
    try {
      setSubmitting(true);
      setError(undefined);
      const response = await fetchWithAuth('/c2c/restore', {
        method: 'POST',
        body: JSON.stringify({
          itemIds: Array.from(selectedIds),
          targetConnectionId: targetMode === 'alternate' ? targetConnectionId : undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? t('longTail.c2c.C2CRestoreDialog.errors.startRestore'));
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.c2c.C2CRestoreDialog.errors.startRestore'));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, onComplete, selectedIds, targetConnectionId, targetMode, t]);

  const itemTypeLabel = (type: string) => {
    const key = `longTail.c2c.C2CRestoreDialog.itemTypes.${type}`;
    const label = t(/* i18n-dynamic */ key);
    return label === key ? type : label;
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('longTail.c2c.C2CRestoreDialog.title')}
      maxWidth="5xl"
      className="overflow-hidden"
    >
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('longTail.c2c.C2CRestoreDialog.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('longTail.c2c.C2CRestoreDialog.description')}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <div className="space-y-5 p-6">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <section className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Search className="h-4 w-4" />
            {t('longTail.c2c.C2CRestoreDialog.searchItems')}
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_220px_auto_auto]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('longTail.c2c.C2CRestoreDialog.searchPlaceholder')}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm"
              />
            </label>
            <select
              value={itemType}
              onChange={(event) => setItemType(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('longTail.c2c.C2CRestoreDialog.allTypes')}</option>
              <option value="email">{t('longTail.c2c.C2CRestoreDialog.itemTypes.email')}</option>
              <option value="file">{t('longTail.c2c.C2CRestoreDialog.itemTypes.file')}</option>
              <option value="calendar_event">{t('longTail.c2c.C2CRestoreDialog.itemTypes.calendar_event')}</option>
              <option value="contact">{t('longTail.c2c.C2CRestoreDialog.itemTypes.contact')}</option>
              <option value="chat_message">{t('longTail.c2c.C2CRestoreDialog.itemTypes.chat_message')}</option>
            </select>
            <input
              type="text"
              value={userEmail}
              onChange={(event) => setUserEmail(event.target.value)}
              placeholder={t('longTail.c2c.C2CRestoreDialog.filterByUserEmail')}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
            <button
              type="button"
              onClick={fetchItems}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              {loadingItems ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('common:actions.refresh')}
            </button>
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setItemType('');
                setUserEmail('');
                setSelectedIds(new Set());
                void fetchWithAuth('/c2c/items?limit=100')
                  .then((response) => response.json())
                  .then((payload) => setItems(payload?.data ?? payload?.items ?? []))
                  .catch(() => {});
              }}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              <Undo2 className="h-4 w-4" />
              {t('longTail.c2c.C2CRestoreDialog.reset')}
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-foreground">{t('longTail.c2c.C2CRestoreDialog.selectItems')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('longTail.c2c.C2CRestoreDialog.resultCount', { count: items.length, selected: selectedIds.size })}
              </p>
            </div>
            {selectedIds.size > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('longTail.c2c.C2CRestoreDialog.restoreSetReady')}
              </span>
            )}
          </div>
          <div className="max-h-[320px] overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b bg-muted/50">
                  <th className="w-12 px-4 py-3 text-left font-medium" />
                  <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CRestoreDialog.table.item')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('common:labels.type')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('common:labels.user')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CRestoreDialog.table.path')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('longTail.c2c.C2CRestoreDialog.table.size')}</th>
                  <th className="px-4 py-3 text-left font-medium">{t('longTail.c2c.C2CRestoreDialog.table.date')}</th>
                </tr>
              </thead>
              <tbody>
                {loadingItems ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
                      <span className="mt-2 block">{t('longTail.c2c.C2CRestoreDialog.loadingItems')}</span>
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                      {t('longTail.c2c.C2CRestoreDialog.emptySearch')}
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr
                      key={item.id}
                      className={cn(
                        'border-b last:border-0 hover:bg-muted/30',
                        selectedIds.has(item.id) && 'bg-primary/5'
                      )}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.id)}
                          onChange={() => toggleItem(item.id)}
                          className="h-4 w-4 rounded"
                        />
                      </td>
                      <td className="max-w-[280px] px-4 py-3 font-medium text-foreground">
                        <div className="truncate">{item.subjectOrName ?? t('longTail.c2c.C2CRestoreDialog.untitledItem')}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-primary">
                          {itemTypeLabel(item.itemType)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{item.userEmail ?? '-'}</td>
                      <td className="max-w-[220px] px-4 py-3 text-muted-foreground">
                        <div className="truncate">{item.parentPath ?? '-'}</div>
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">{formatBytes(item.sizeBytes)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(item.itemDate)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Server className="h-4 w-4" />
              {t('longTail.c2c.C2CRestoreDialog.restoreTarget')}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setTargetMode('original')}
                className={cn(
                  'rounded-lg border p-4 text-left transition-colors',
                  targetMode === 'original' ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                )}
              >
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Undo2 className="h-4 w-4 text-primary" />
                  {t('longTail.c2c.C2CRestoreDialog.restoreOriginalTenant')}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('longTail.c2c.C2CRestoreDialog.restoreOriginalDescription')}
                </p>
              </button>
              <button
                type="button"
                onClick={() => setTargetMode('alternate')}
                className={cn(
                  'rounded-lg border p-4 text-left transition-colors',
                  targetMode === 'alternate' ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'
                )}
              >
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Cloud className="h-4 w-4 text-primary" />
                  {t('longTail.c2c.C2CRestoreDialog.restoreAnotherConnection')}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('longTail.c2c.C2CRestoreDialog.restoreAnotherDescription')}
                </p>
              </button>
            </div>
            {targetMode === 'alternate' && (
              <div>
                <label htmlFor="restore-target" className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('longTail.c2c.C2CRestoreDialog.targetConnection')}
                </label>
                <select
                  id="restore-target"
                  value={targetConnectionId}
                  onChange={(event) => setTargetConnectionId(event.target.value)}
                  disabled={loadingConnections}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">{t('longTail.c2c.C2CRestoreDialog.selectConnection')}</option>
                  {availableTargets.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.displayName} · {formatProvider(connection.provider, t)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <CheckCircle2 className="h-4 w-4" />
              {t('common:actions.confirm')}
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-xs text-muted-foreground">{t('longTail.c2c.C2CRestoreDialog.selectedItems')}</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{selectedIds.size}</p>
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-xs text-muted-foreground">{t('longTail.c2c.C2CRestoreDialog.restoreTarget')}</p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {targetMode === 'original'
                  ? t('longTail.c2c.C2CRestoreDialog.originalConnection')
                  : availableTargets.find((connection) => connection.id === targetConnectionId)?.displayName ?? t('longTail.c2c.C2CRestoreDialog.selectTarget')}
              </p>
            </div>
            {selectedItems.slice(0, 3).map((item) => (
              <div key={item.id} className="rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{item.subjectOrName ?? t('longTail.c2c.C2CRestoreDialog.untitledItem')}</span>
                {' · '}
                {item.userEmail ?? t('longTail.c2c.C2CRestoreDialog.noUser')}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center justify-between border-t px-6 py-4">
        <p className="text-xs text-muted-foreground">
          {t('longTail.c2c.C2CRestoreDialog.restoreDisabled')}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={!canSubmit || submitting}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            {t('longTail.c2c.C2CRestoreDialog.restoreComingSoon')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
