import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  History,
  RefreshCw,
  RotateCcw
} from 'lucide-react';
import { cn } from '@/lib/utils';

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
  label: string;
  tree?: TreeNode;
  files?: SnapshotFile[];
};

export default function SnapshotBrowser() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState('/');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchSnapshots = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/backup/snapshots');
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

  const selectedSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === selectedSnapshotId),
    [selectedSnapshotId, snapshots]
  );

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
            nodePath === selectedFolder ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'
          )}
          style={{ marginLeft: depth * 14 }}
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
        <h2 className="text-xl font-semibold text-foreground">Snapshot Browser</h2>
        <p className="text-sm text-muted-foreground">
          Explore snapshots, browse files, and restore with confidence.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
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
                  {snapshot.label}
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
                  <span key={crumb} className="ml-2 text-muted-foreground">
                    {crumb}
                    {index < breadcrumbs.length - 1 && <span className="mx-1">/</span>}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent">
                  <RotateCcw className="h-4 w-4" />
                  Restore selected
                </button>
                <button className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  <Download className="h-4 w-4" />
                  Download file
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border">
              <table className="w-full">
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
              <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                {selectedSnapshot?.files?.length
                  ? 'Select a folder in the tree to view files.'
                  : 'No files available for this snapshot.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
