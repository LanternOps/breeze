import { useState, useEffect, useCallback } from 'react';
import { Package, Search, ShieldCheck, AlertTriangle, RefreshCw, Plus, Pencil, Trash2, Play, Lock } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import ThirdPartyCatalogEditor, { type CatalogEditorInitial } from './ThirdPartyCatalogEditor';

const testResultStyles: Record<string, string> = {
  pass: 'bg-green-100 text-green-800',
  fail: 'bg-red-100 text-red-800',
  inconclusive: 'bg-yellow-100 text-yellow-800',
  skipped: 'bg-gray-100 text-gray-700',
};

type CatalogEntry = {
  id: string;
  source: string;
  packageId: string;
  vendor: string;
  friendlyName: string;
  category: string;
  defaultSeverity: 'critical' | 'important' | 'moderate' | 'low' | 'unknown';
  breezeTested: boolean;
  lastTestedAt: string | null;
  lastTestedVersion: string | null;
  lastTestedResult: string | null;
  notes: string | null;
  homepageUrl: string | null;
};

type EditorState =
  | { kind: 'closed' }
  | { kind: 'add' }
  | { kind: 'edit'; entry: CatalogEntry };

const severityStyles: Record<string, string> = {
  critical: 'bg-red-100 text-red-800',
  important: 'bg-orange-100 text-orange-800',
  moderate: 'bg-yellow-100 text-yellow-800',
  low: 'bg-green-100 text-green-800',
  unknown: 'bg-gray-100 text-gray-700',
};

type PendingTest = {
  entryId: string;
  startedAt: number;
  initialLastTestedAt: string | null;
};

export default function ThirdPartyCatalog() {
  const [items, setItems] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [requiresPlatformAdmin, setRequiresPlatformAdmin] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [search, setSearch] = useState('');
  const [showOnlyTested, setShowOnlyTested] = useState(false);
  const [editor, setEditor] = useState<EditorState>({ kind: 'closed' });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retestingId, setRetestingId] = useState<string | null>(null);
  const [pendingTests, setPendingTests] = useState<PendingTest[]>([]);

  const fetchCatalog = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      params.set('limit', '500');
      if (search.trim()) params.set('search', search.trim());
      if (showOnlyTested) params.set('breezeTested', 'true');
      const response = await fetchWithAuth(`/third-party-catalog?${params.toString()}`);
      if (!response.ok) {
        // The third-party catalog endpoint is platform-admin-gated end-to-
        // end (`apps/api/src/routes/thirdPartyCatalog/list.ts` uses
        // platformAdminMiddleware), so any 403 here is platform-admin
        // denial. Match the sibling pattern in
        // AccountDeletionRequestsList.tsx:42-45 — status-only check, no
        // body sniff (a backend rewording of the error string would
        // silently break the UI without test coverage). (#721 Case 1)
        if (response.status === 403) {
          setRequiresPlatformAdmin(true);
          setItems([]);
          setTotal(0);
          return;
        }
        throw new Error('Failed to load catalog');
      }
      setRequiresPlatformAdmin(false);
      const data = await response.json();
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [search, showOnlyTested]);

  useEffect(() => {
    const timer = setTimeout(fetchCatalog, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [fetchCatalog, search]);

  // Poll after re-test trigger so admin sees result without a manual refresh.
  useEffect(() => {
    if (pendingTests.length === 0) return;
    const interval = setInterval(() => {
      fetchCatalog();
    }, 5000);
    return () => clearInterval(interval);
  }, [pendingTests.length, fetchCatalog]);

  // Detect completion: when a polled entry's lastTestedAt advances past
  // the value captured at trigger time, remove from pending + show a toast.
  useEffect(() => {
    if (pendingTests.length === 0) return;
    const stillPending: PendingTest[] = [];
    const completed: { entry: CatalogEntry; result: string }[] = [];
    for (const pending of pendingTests) {
      const entry = items.find((it) => it.id === pending.entryId);
      if (!entry) {
        stillPending.push(pending);
        continue;
      }
      const advanced =
        entry.lastTestedAt &&
        (!pending.initialLastTestedAt ||
          new Date(entry.lastTestedAt).getTime() >
            new Date(pending.initialLastTestedAt).getTime());
      if (advanced && entry.lastTestedResult) {
        completed.push({ entry, result: entry.lastTestedResult });
      } else {
        stillPending.push(pending);
      }
    }
    if (completed.length > 0) {
      setPendingTests(stillPending);
      const summary = completed
        .map((c) => `${c.entry.friendlyName}: ${c.result}`)
        .join('; ');
      setNotice(`Test complete — ${summary}`);
    }
  }, [items, pendingTests]);

  const handleRetest = async (entry: CatalogEntry) => {
    const version = window.prompt(
      `Run smoke test for ${entry.friendlyName} at which version?`,
      entry.lastTestedVersion ?? ''
    );
    if (!version || !version.trim()) return;
    setRetestingId(entry.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetchWithAuth(`/third-party-catalog/${entry.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: version.trim() }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error ?? `Failed to queue test (${response.status})`);
      }
      setPendingTests((prev) => [
        ...prev.filter((p) => p.entryId !== entry.id),
        {
          entryId: entry.id,
          startedAt: Date.now(),
          initialLastTestedAt: entry.lastTestedAt,
        },
      ]);
      setNotice(`Test queued for ${entry.friendlyName}. Polling for result…`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue test');
    } finally {
      setRetestingId(null);
    }
  };

  const handleDelete = async (entry: CatalogEntry) => {
    if (!window.confirm(`Delete "${entry.friendlyName}" from the catalog?`)) return;
    setDeletingId(entry.id);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/third-party-catalog/${entry.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete entry');
      await fetchCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  };

  const editorInitial: CatalogEditorInitial | undefined =
    editor.kind === 'edit'
      ? {
          id: editor.entry.id,
          packageId: editor.entry.packageId,
          vendor: editor.entry.vendor,
          friendlyName: editor.entry.friendlyName,
          defaultSeverity: editor.entry.defaultSeverity,
          breezeTested: editor.entry.breezeTested,
          notes: editor.entry.notes,
          homepageUrl: editor.entry.homepageUrl,
        }
      : undefined;

  if (requiresPlatformAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold flex items-center gap-2 mb-6">
          <Package className="w-6 h-6" /> Third-Party Package Catalog
        </h1>
        <div
          data-testid="catalog-requires-platform-admin"
          className="bg-blue-50 border border-blue-200 text-blue-900 px-6 py-8 rounded flex items-start gap-4"
        >
          <Lock className="w-6 h-6 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-1">Platform-admin access required</div>
            <div className="text-sm">
              The third-party catalog is managed by Breeze platform admins. Your account
              ({/* role-aware text intentionally not surfaced — server-side identity is the source of truth */}
              an org/partner admin) can view the curated catalog through normal patch flows but
              cannot edit it directly.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Package className="w-6 h-6" /> Third-Party Package Catalog
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Breeze-curated metadata for third-party software detected by winget on agents.
            Total entries: <span data-testid="catalog-total">{total}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            data-testid="catalog-refresh"
            onClick={fetchCatalog}
            className="px-3 py-2 text-sm border rounded hover:bg-gray-50 flex items-center gap-1"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button
            data-testid="catalog-add-button"
            onClick={() => setEditor({ kind: 'add' })}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1"
          >
            <Plus className="w-4 h-4" /> Add package
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            data-testid="catalog-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, vendor, or winget ID…"
            className="w-full pl-9 pr-3 py-2 border rounded text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="catalog-filter-tested"
            checked={showOnlyTested}
            onChange={(e) => setShowOnlyTested(e.target.checked)}
          />
          Breeze-tested only
        </label>
      </div>

      {error && (
        <div className="bg-red-50 text-red-800 px-4 py-3 rounded mb-4 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {notice && (
        <div
          data-testid="catalog-notice"
          className="bg-blue-50 text-blue-800 px-4 py-3 rounded mb-4 flex items-center justify-between gap-2"
        >
          <span>{notice}</span>
          <button
            onClick={() => setNotice(undefined)}
            className="text-blue-600 hover:underline text-sm"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading catalog…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-500" data-testid="catalog-empty">
          No catalog entries match the current filters.
        </div>
      ) : (
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Vendor</th>
                <th className="px-4 py-2 font-medium">Package</th>
                <th className="px-4 py-2 font-medium">Winget ID</th>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Last test</th>
                <th className="px-4 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr
                  key={entry.id}
                  data-testid={`catalog-row-${entry.id}`}
                  className="border-b hover:bg-gray-50"
                >
                  <td className="px-4 py-2">{entry.vendor}</td>
                  <td className="px-4 py-2">
                    {entry.homepageUrl ? (
                      <a
                        href={entry.homepageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {entry.friendlyName}
                      </a>
                    ) : (
                      entry.friendlyName
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600">
                    {entry.packageId}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                        severityStyles[entry.defaultSeverity] ?? severityStyles.unknown
                      }`}
                    >
                      {entry.defaultSeverity}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {entry.breezeTested && (
                      <span
                        data-testid={`catalog-row-${entry.id}-tested-badge`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-100 text-green-800"
                      >
                        <ShieldCheck className="w-3 h-3" /> Breeze-tested
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {pendingTests.some((p) => p.entryId === entry.id) ? (
                      <span
                        data-testid={`catalog-row-${entry.id}-test-running`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800"
                      >
                        <RefreshCw className="w-3 h-3 animate-spin" /> running…
                      </span>
                    ) : entry.lastTestedResult ? (
                      <span
                        data-testid={`catalog-row-${entry.id}-test-status`}
                        className={`inline-block px-2 py-0.5 rounded text-xs ${
                          testResultStyles[entry.lastTestedResult] ?? testResultStyles.skipped
                        }`}
                        title={entry.lastTestedVersion ? `v${entry.lastTestedVersion}` : undefined}
                      >
                        {entry.lastTestedResult}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {entry.breezeTested && (
                        <button
                          data-testid={`catalog-row-${entry.id}-retest`}
                          onClick={() => handleRetest(entry)}
                          disabled={retestingId === entry.id}
                          className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                          aria-label="Re-test"
                          title="Run smoke test"
                        >
                          <Play className="w-4 h-4 text-blue-600" />
                        </button>
                      )}
                      <button
                        data-testid={`catalog-row-${entry.id}-edit`}
                        onClick={() => setEditor({ kind: 'edit', entry })}
                        className="p-1 rounded hover:bg-gray-200"
                        aria-label="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        data-testid={`catalog-row-${entry.id}-delete`}
                        onClick={() => handleDelete(entry)}
                        disabled={deletingId === entry.id}
                        className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                        aria-label="Delete"
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor.kind !== 'closed' && (
        <ThirdPartyCatalogEditor
          initial={editorInitial}
          onClose={() => setEditor({ kind: 'closed' })}
          onSaved={() => {
            setEditor({ kind: 'closed' });
            fetchCatalog();
          }}
        />
      )}
    </div>
  );
}
