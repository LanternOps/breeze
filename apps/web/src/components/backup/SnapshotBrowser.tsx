import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Database,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  History,
  RefreshCw,
} from 'lucide-react';
import { cn, marginLeftPxClass } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type TreeNode = {
  id: string;
  name: string;
  type: 'folder' | 'file';
  size?: string;
  modified?: string;
  children?: TreeNode[];
};

type SnapshotFile = {
  id: string;
  name: string;
  size?: string;
  modified?: string;
  path?: string;
};

type Snapshot = {
  id: string;
  label: string | null;
  createdAt: string;
  sizeBytes: number | null;
  fileCount: number | null;
  location: string | null;
  expiresAt: string | null;
  legalHold: boolean;
  legalHoldReason: string | null;
  legalHoldSource?: 'policy' | 'manual' | null;
  isImmutable: boolean;
  immutableUntil: string | null;
  immutabilityEnforcement: 'application' | 'provider' | null;
  requestedImmutabilityEnforcement: 'application' | 'provider' | null;
  immutabilityFallbackReason: string | null;
  retentionBlockedReason?: 'legal_hold' | 'immutable_until' | null;
  tree?: TreeNode;
  files?: SnapshotFile[];
};

type SnapshotTreeItem = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
  children?: SnapshotTreeItem[];
};

function toTreeNodes(items: SnapshotTreeItem[]): TreeNode[] {
  return items.map((item) => ({
    id: item.path,
    name: item.name,
    type: item.type === 'directory' ? 'folder' : 'file',
    size: typeof item.sizeBytes === 'number' ? `${item.sizeBytes} B` : undefined,
    modified: item.modifiedAt,
    children: item.children ? toTreeNodes(item.children) : undefined,
  }));
}

function flattenTree(items: SnapshotTreeItem[], parentPath = '/'): SnapshotFile[] {
  return items.flatMap((item) => {
    const itemPath = item.path || parentPath;
    if (item.type === 'file') {
      const folderPath = itemPath.split('/').slice(0, -1).join('/') || '/';
      return [{
        id: itemPath,
        name: item.name,
        size: typeof item.sizeBytes === 'number' ? `${item.sizeBytes} B` : undefined,
        modified: item.modifiedAt,
        path: folderPath,
      }];
    }
    return item.children ? flattenTree(item.children, itemPath) : [];
  });
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SnapshotBrowser() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState('/');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState('');
  const [immutableDays, setImmutableDays] = useState(30);
  const [immutabilityMode, setImmutabilityMode] = useState<'application' | 'provider'>('application');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const fetchSnapshots = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/backup/snapshots');
      if (!response.ok) {
        throw new Error('Failed to fetch snapshots');
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? {};
      const snapshotList = Array.isArray(data) ? data : data.snapshots ?? [];
      setSnapshots(Array.isArray(snapshotList) ? snapshotList : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshots();
  }, [fetchSnapshots]);

  useEffect(() => {
    if (!selectedSnapshotId && snapshots.length > 0) {
      setSelectedSnapshotId(snapshots[0].id);
    }
  }, [selectedSnapshotId, snapshots]);

  useEffect(() => {
    if (!selectedSnapshotId) return;

    let cancelled = false;
    const loadSnapshotBrowse = async () => {
      try {
        const response = await fetchWithAuth(`/backup/snapshots/${selectedSnapshotId}/browse`);
        if (!response.ok) {
          throw new Error('Failed to browse snapshot');
        }
        const payload = await response.json();
        const items = Array.isArray(payload?.data) ? payload.data as SnapshotTreeItem[] : [];
        const treeNodes = toTreeNodes(items);
        const files = flattenTree(items);

        if (cancelled) return;
        setSnapshots((prev) => prev.map((snapshot) => (
          snapshot.id === selectedSnapshotId
            ? {
                ...snapshot,
                tree: treeNodes.length > 0
                  ? { id: '/', name: 'Root', type: 'folder', children: treeNodes }
                  : undefined,
                files,
              }
            : snapshot
        )));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to browse snapshot');
        }
      }
    };

    void loadSnapshotBrowse();
    return () => {
      cancelled = true;
    };
  }, [selectedSnapshotId]);

  const handleProtectionAction = useCallback(async (
    action: 'apply-hold' | 'release-hold' | 'apply-immutability' | 'release-immutability',
  ) => {
    if (!selectedSnapshotId) return;

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setActionError('A reason is required for snapshot protection changes.');
      return;
    }

    if (action === 'apply-immutability' && immutableDays < 1) {
      setActionError('Immutable days must be at least 1.');
      return;
    }

    const path = (() => {
      switch (action) {
        case 'apply-hold':
          return `/backup/snapshots/${selectedSnapshotId}/legal-hold`;
        case 'release-hold':
          return `/backup/snapshots/${selectedSnapshotId}/legal-hold`;
        case 'apply-immutability':
          return `/backup/snapshots/${selectedSnapshotId}/immutability`;
        case 'release-immutability':
          return `/backup/snapshots/${selectedSnapshotId}/immutability/release`;
      }
    })();

    const selectedSnapshot = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;
    const body = action === 'apply-immutability'
      ? (
        selectedSnapshot?.isImmutable && selectedSnapshot.immutableUntil
          ? {
              reason: trimmedReason,
              extendUntil: new Date(new Date(selectedSnapshot.immutableUntil).getTime() + immutableDays * 24 * 60 * 60 * 1000).toISOString(),
              enforcement: immutabilityMode,
            }
          : { reason: trimmedReason, immutableDays, enforcement: immutabilityMode }
      )
      : { reason: trimmedReason };
    const method = action === 'release-hold' ? 'DELETE' : 'POST';

    try {
      setActionLoading(true);
      setActionError(undefined);
      setActionMessage(undefined);

      const response = await fetchWithAuth(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? 'Failed to update snapshot protection');
      }

      const updated = payload?.data ?? payload;
      setSnapshots((prev) => prev.map((snapshot) => (
        snapshot.id === selectedSnapshotId
          ? {
              ...snapshot,
              ...updated,
              label: updated.label ?? snapshot.label,
              tree: snapshot.tree,
              files: snapshot.files,
            }
          : snapshot
      )));
      setActionMessage(
        action === 'apply-hold'
          ? 'Legal hold applied.'
          : action === 'release-hold'
            ? 'Legal hold released.'
            : action === 'apply-immutability'
              ? `${immutabilityMode === 'provider' ? 'Provider' : 'Application'} immutability ${selectedSnapshot?.isImmutable ? 'extended' : 'applied'}.`
              : 'Application immutability released.'
      );
      setReason('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update snapshot protection');
    } finally {
      setActionLoading(false);
    }
  }, [immutableDays, immutabilityMode, reason, selectedSnapshotId, snapshots]);

  const selectedSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === selectedSnapshotId),
    [selectedSnapshotId, snapshots]
  );
  const selectedSnapshotDisplayLabel = selectedSnapshot?.label ?? selectedSnapshot?.id ?? 'Snapshot';

  useEffect(() => {
    if (selectedSnapshot?.tree?.id) {
      setExpanded(new Set([selectedSnapshot.tree.id]));
    } else {
      setExpanded(new Set());
    }
    setSelectedFolder('/');
    setSelectedFiles(new Set());
  }, [selectedSnapshotId, selectedSnapshot?.tree?.id]);

  const visibleFiles = useMemo(() => {
    return (selectedSnapshot?.files ?? []).filter((file) => (file.path ?? '/') === selectedFolder);
  }, [selectedFolder, selectedSnapshot?.files]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleFile = (id: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderTree = (node: TreeNode, depth = 0, path = '') => {
    const isFolder = node.type === 'folder';
    const nodePath = depth === 0 ? '/' : `${path}/${node.name}`.replace('//', '/');
    const isExpanded = expanded.has(node.id);

    return (
      <div key={node.id}>
        <div
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1 text-sm',
            nodePath === selectedFolder ? 'bg-primary/10 text-foreground' : 'text-muted-foreground',
            marginLeftPxClass(depth * 14)
          )}
        >
          {isFolder ? (
            <button onClick={() => toggleExpanded(node.id)} className="text-muted-foreground">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          ) : (
            <span className="w-4" />
          )}
          {isFolder ? (
            <button
              onClick={() => setSelectedFolder(nodePath)}
              className="flex items-center gap-2"
            >
              {isExpanded ? (
                <FolderOpen className="h-4 w-4" />
              ) : (
                <Folder className="h-4 w-4" />
              )}
              {node.name}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {node.name}
            </div>
          )}
        </div>
        {isFolder && isExpanded && node.children && (
          <div className="space-y-1">
            {node.children.map((child) => renderTree(child, depth + 1, nodePath))}
          </div>
        )}
      </div>
    );
  };

  const breadcrumbs = selectedFolder.split('/').filter(Boolean);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading snapshots...</p>
        </div>
      </div>
    );
  }

  if (error && snapshots.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchSnapshots}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Snapshots</h2>
        <p className="text-sm text-muted-foreground">
          Manage backup restore points, inspect protection state, and browse files inside each snapshot.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
        {(error || actionError) && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {actionError ?? error}
          </div>
        )}
        {actionMessage && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {actionMessage}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <History className="h-4 w-4" />
            Snapshot
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={selectedSnapshotId}
              onChange={(event) => setSelectedSnapshotId(event.target.value)}
            >
              {snapshots.map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  {snapshot.label ?? snapshot.id}
                </option>
              ))}
            </select>
            <button
              onClick={fetchSnapshots}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        {selectedSnapshot && (
          <div className="grid gap-4 rounded-lg border bg-muted/15 p-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{selectedSnapshotDisplayLabel}</span>
                {selectedSnapshot.legalHold && (
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                    Legal hold
                  </span>
                )}
                {selectedSnapshot.isImmutable && (
                  <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700">
                    {selectedSnapshot.immutabilityEnforcement === 'provider' ? 'Provider immutability' : 'Application immutability'}
                  </span>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border bg-background p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <CalendarClock className="h-3.5 w-3.5" />
                    Snapshot Timing
                  </div>
                  <div className="mt-2 space-y-1 text-sm text-foreground">
                    <div>Created: {formatDateTime(selectedSnapshot.createdAt)}</div>
                    <div>Expires: {formatDateTime(selectedSnapshot.expiresAt)}</div>
                    <div>Immutable until: {formatDateTime(selectedSnapshot.immutableUntil)}</div>
                  </div>
                </div>
                <div className="rounded-md border bg-background p-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Database className="h-3.5 w-3.5" />
                    Snapshot Details
                  </div>
                  <div className="mt-2 space-y-1 text-sm text-foreground">
                    <div>Size: {formatBytes(selectedSnapshot.sizeBytes)}</div>
                    <div>Files: {selectedSnapshot.fileCount ?? '-'}</div>
                    <div className="break-all text-muted-foreground">{selectedSnapshot.location ?? '-'}</div>
                  </div>
                </div>
              </div>

              {(selectedSnapshot.legalHoldReason || selectedSnapshot.immutabilityEnforcement) && (
                <div className="rounded-md border bg-background p-3 text-sm">
                  {selectedSnapshot.legalHoldReason && (
                    <div>
                      <span className="font-medium text-foreground">Hold reason:</span>{' '}
                      <span className="text-muted-foreground">{selectedSnapshot.legalHoldReason}</span>
                    </div>
                  )}
                  {selectedSnapshot.legalHoldSource && (
                    <div>
                      <span className="font-medium text-foreground">Hold source:</span>{' '}
                      <span className="text-muted-foreground">
                        {selectedSnapshot.legalHoldSource === 'policy' ? 'Inherited from backup policy' : 'Applied manually'}
                      </span>
                    </div>
                  )}
                  {selectedSnapshot.immutabilityEnforcement && (
                    <div>
                      <span className="font-medium text-foreground">Enforcement:</span>{' '}
                      <span className="text-muted-foreground">
                        {selectedSnapshot.immutabilityEnforcement === 'provider'
                          ? 'Provider-enforced WORM'
                          : 'Application-level cleanup protection'}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {selectedSnapshot.requestedImmutabilityEnforcement === 'provider' &&
                selectedSnapshot.immutabilityEnforcement === 'application' && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800">
                    Provider immutability was requested by policy, but Breeze applied application protection instead.
                    {selectedSnapshot.immutabilityFallbackReason && (
                      <div className="mt-1 text-xs text-amber-900/80">
                        Reason: {selectedSnapshot.immutabilityFallbackReason}
                      </div>
                    )}
                  </div>
                )}
            </div>

            <div className="space-y-3 rounded-md border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Protection Controls
              </div>
              <p className="text-xs text-muted-foreground">
                These actions apply to the selected snapshot only. Application protection is enforced by Breeze retention cleanup. Releasing protection can make an expired snapshot eligible for deletion immediately.
              </p>
              {selectedSnapshot.retentionBlockedReason && (
                <p className="text-xs text-muted-foreground">
                  Retention cleanup is currently blocked by {selectedSnapshot.retentionBlockedReason === 'legal_hold' ? 'legal hold' : 'immutability'} for this snapshot.
                </p>
              )}
              <div>
                <label className="text-xs font-medium text-muted-foreground">Reason</label>
                <input
                  aria-label="Reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Reason for applying or releasing protection"
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Application immutability days</label>
                <input
                  aria-label="Application immutability days"
                  type="number"
                  min={1}
                  max={3650}
                  value={immutableDays}
                  onChange={(event) => setImmutableDays(Number(event.target.value) || 30)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Immutability enforcement</label>
                <select
                  value={immutabilityMode}
                  onChange={(event) => setImmutabilityMode(event.target.value as 'application' | 'provider')}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="application">Application-level</option>
                  <option value="provider">Provider-enforced</option>
                </select>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={actionLoading || selectedSnapshot.legalHold}
                  onClick={() => void handleProtectionAction('apply-hold')}
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 disabled:opacity-50"
                >
                  {actionLoading ? 'Working...' : 'Apply legal hold'}
                </button>
                <button
                  type="button"
                  disabled={actionLoading || !selectedSnapshot.legalHold}
                  onClick={() => void handleProtectionAction('release-hold')}
                  className="rounded-md border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                >
                  Release legal hold
                </button>
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => void handleProtectionAction('apply-immutability')}
                  className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-800 disabled:opacity-50"
                >
                  {selectedSnapshot.isImmutable ? 'Extend immutability' : 'Apply immutability'}
                </button>
                <button
                  type="button"
                  disabled={
                    actionLoading ||
                    !selectedSnapshot.isImmutable ||
                    selectedSnapshot.immutabilityEnforcement === 'provider'
                  }
                  onClick={() => void handleProtectionAction('release-immutability')}
                  className="rounded-md border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                >
                  Release app immutability
                </button>
              </div>
              {selectedSnapshot.immutabilityEnforcement === 'provider' && selectedSnapshot.isImmutable && (
                <p className="text-xs text-muted-foreground">
                  Provider-enforced immutability cannot be released from Breeze.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="rounded-md border bg-muted/10 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">File Tree</h3>
            <div className="mt-3 space-y-1 text-sm">
              {selectedSnapshot?.tree ? (
                renderTree(selectedSnapshot.tree)
              ) : (
                <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                  No file tree available.
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Path:</span>
                <span className="ml-2 text-muted-foreground">/</span>
                {breadcrumbs.map((crumb, index) => (
                  <span key={`${index}-${crumb}`} className="ml-2 text-muted-foreground">
                    {crumb}
                    {index < breadcrumbs.length - 1 && <span className="mx-1">/</span>}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Use the restore workflow to recover or export files from this snapshot.
              </p>
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[400px]">
                <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Select</th>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Size</th>
                    <th className="px-4 py-3">Modified</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleFiles.map((file) => (
                    <tr key={file.id} className="text-sm text-foreground">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.id)}
                          onChange={() => toggleFile(file.id)}
                          aria-label={`Select ${file.name}`}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          {file.name}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{file.size}</td>
                      <td className="px-4 py-3 text-muted-foreground">{file.modified}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {visibleFiles.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {selectedSnapshot?.files?.length
                  ? 'Select a folder in the tree to view its files.'
                  : 'No files in this snapshot. The backup may still be processing.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
