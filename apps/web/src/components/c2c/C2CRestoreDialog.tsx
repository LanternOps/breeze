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
import { cn } from '@/lib/utils';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';

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

const ITEM_TYPE_LABELS: Record<string, string> = {
  email: 'Email',
  file: 'File',
  calendar_event: 'Calendar',
  contact: 'Contact',
  chat_message: 'Chat',
};

function formatBytes(bytes: number | null): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function formatProvider(provider: string): string {
  if (provider === 'microsoft_365' || provider === 'microsoft365') return 'Microsoft 365';
  if (provider === 'google_workspace') return 'Google Workspace';
  return provider;
}

export default function C2CRestoreDialog({
  items: initialItems,
  onClose,
  onComplete,
}: C2CRestoreDialogProps) {
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
      if (!response.ok) throw new Error('Failed to load backup items');
      const payload = await response.json();
      setItems(payload?.data ?? payload?.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backup items');
    } finally {
      setLoadingItems(false);
    }
  }, [itemType, search, userEmail]);

  const fetchConnections = useCallback(async () => {
    try {
      setLoadingConnections(true);
      const response = await fetchWithAuth('/c2c/connections');
      if (!response.ok) throw new Error('Failed to load restore targets');
      const payload = await response.json();
      setConnections(payload?.data ?? payload?.connections ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load restore targets');
    } finally {
      setLoadingConnections(false);
    }
  }, []);

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
        throw new Error(payload?.error ?? 'Failed to start restore');
      }
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start restore');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, onComplete, selectedIds, targetConnectionId, targetMode]);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Restore Cloud Items"
      maxWidth="5xl"
      className="overflow-hidden"
    >
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Restore Cloud Items</h2>
          <p className="text-sm text-muted-foreground">
            Search backed-up items now; restore execution is not yet implemented.
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
            Search items
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_220px_auto_auto]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search subject or file name"
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm"
              />
            </label>
            <select
              value={itemType}
              onChange={(event) => setItemType(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">All types</option>
              <option value="email">Email</option>
              <option value="file">File</option>
              <option value="calendar_event">Calendar</option>
              <option value="contact">Contact</option>
              <option value="chat_message">Chat</option>
            </select>
            <input
              type="text"
              value={userEmail}
              onChange={(event) => setUserEmail(event.target.value)}
              placeholder="Filter by user email"
              className="h-10 rounded-md border bg-background px-3 text-sm"
            />
            <button
              type="button"
              onClick={fetchItems}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              {loadingItems ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
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
              Reset
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-foreground">Select items</h3>
              <p className="text-xs text-muted-foreground">
                {items.length} result{items.length !== 1 ? 's' : ''}, {selectedIds.size} selected
              </p>
            </div>
            {selectedIds.size > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Restore set ready
              </span>
            )}
          </div>
          <div className="max-h-[320px] overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b bg-muted/50">
                  <th className="w-12 px-4 py-3 text-left font-medium" />
                  <th className="px-4 py-3 text-left font-medium">Item</th>
                  <th className="px-4 py-3 text-left font-medium">Type</th>
                  <th className="px-4 py-3 text-left font-medium">User</th>
                  <th className="px-4 py-3 text-left font-medium">Path</th>
                  <th className="px-4 py-3 text-right font-medium">Size</th>
                  <th className="px-4 py-3 text-left font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {loadingItems ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
                      <span className="mt-2 block">Loading items...</span>
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                      No backup items matched the current search.
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
                        <div className="truncate">{item.subjectOrName ?? 'Untitled item'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-primary">
                          {ITEM_TYPE_LABELS[item.itemType] ?? item.itemType}
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
              Restore target
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
                  Restore to original tenant
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Use the source connection that originally protected the items.
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
                  Restore to another connection
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Redirect the selected items into a different active cloud target.
                </p>
              </button>
            </div>
            {targetMode === 'alternate' && (
              <div>
                <label htmlFor="restore-target" className="mb-1 block text-xs font-medium text-muted-foreground">
                  Target connection
                </label>
                <select
                  id="restore-target"
                  value={targetConnectionId}
                  onChange={(event) => setTargetConnectionId(event.target.value)}
                  disabled={loadingConnections}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Select a connection</option>
                  {availableTargets.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.displayName} · {formatProvider(connection.provider)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <CheckCircle2 className="h-4 w-4" />
              Confirm
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-xs text-muted-foreground">Selected items</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{selectedIds.size}</p>
            </div>
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-xs text-muted-foreground">Restore target</p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {targetMode === 'original'
                  ? 'Original connection'
                  : availableTargets.find((connection) => connection.id === targetConnectionId)?.displayName ?? 'Select a target'}
              </p>
            </div>
            {selectedItems.slice(0, 3).map((item) => (
              <div key={item.id} className="rounded-md bg-background px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{item.subjectOrName ?? 'Untitled item'}</span>
                {' · '}
                {item.userEmail ?? 'No user'}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="flex items-center justify-between border-t px-6 py-4">
        <p className="text-xs text-muted-foreground">
          Restore submission is disabled until cloud-to-cloud restore execution is implemented.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={!canSubmit || submitting}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            Restore coming soon
          </button>
        </div>
      </div>
    </Dialog>
  );
}
