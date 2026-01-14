import { useMemo, useState } from 'react';
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

const snapshots = [
  '2024-03-28 02:00 AM',
  '2024-03-27 02:00 AM',
  '2024-03-26 02:00 AM',
  '2024-03-25 02:00 AM'
];

const tree: TreeNode = {
  id: 'root',
  name: 'root',
  type: 'folder',
  children: [
    {
      id: 'finance',
      name: 'finance',
      type: 'folder',
      children: [
        { id: 'q1', name: 'Q1-report.xlsx', type: 'file', size: '4.2 MB', modified: 'Mar 24' },
        { id: 'tax', name: 'tax-forms', type: 'folder', children: [
          { id: 'tax1', name: '1099.pdf', type: 'file', size: '320 KB', modified: 'Mar 12' },
          { id: 'tax2', name: 'w2.pdf', type: 'file', size: '280 KB', modified: 'Mar 12' }
        ] }
      ]
    },
    {
      id: 'projects',
      name: 'projects',
      type: 'folder',
      children: [
        { id: 'apollo', name: 'apollo', type: 'folder', children: [
          { id: 'ap1', name: 'notes.md', type: 'file', size: '12 KB', modified: 'Mar 27' },
          { id: 'ap2', name: 'specs', type: 'folder', children: [
            { id: 'ap3', name: 'architecture.pdf', type: 'file', size: '1.4 MB', modified: 'Mar 26' }
          ] }
        ] }
      ]
    },
    {
      id: 'system',
      name: 'system',
      type: 'folder',
      children: [
        { id: 'sys1', name: 'logs', type: 'folder', children: [
          { id: 'sys2', name: 'backup.log', type: 'file', size: '2.1 MB', modified: 'Mar 28' }
        ] }
      ]
    }
  ]
};

const flatFileList = [
  { id: 'file-1', name: 'Q1-report.xlsx', size: '4.2 MB', modified: 'Mar 24', path: '/finance' },
  { id: 'file-2', name: '1099.pdf', size: '320 KB', modified: 'Mar 12', path: '/finance/tax-forms' },
  { id: 'file-3', name: 'w2.pdf', size: '280 KB', modified: 'Mar 12', path: '/finance/tax-forms' },
  { id: 'file-4', name: 'notes.md', size: '12 KB', modified: 'Mar 27', path: '/projects/apollo' },
  { id: 'file-5', name: 'architecture.pdf', size: '1.4 MB', modified: 'Mar 26', path: '/projects/apollo/specs' },
  { id: 'file-6', name: 'backup.log', size: '2.1 MB', modified: 'Mar 28', path: '/system/logs' }
];

export default function SnapshotBrowser() {
  const [selectedSnapshot, setSelectedSnapshot] = useState(snapshots[0]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['root', 'finance', 'projects']));
  const [selectedFolder, setSelectedFolder] = useState('/finance');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(['file-1']));

  const visibleFiles = useMemo(() => {
    return flatFileList.filter((file) => file.path === selectedFolder);
  }, [selectedFolder]);

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
    const nodePath = node.id === 'root' ? '/' : `${path}/${node.name}`.replace('//', '/');
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Snapshot Browser</h2>
        <p className="text-sm text-muted-foreground">
          Explore snapshots, browse files, and restore with confidence.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <History className="h-4 w-4" />
            Snapshot
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={selectedSnapshot}
              onChange={(event) => setSelectedSnapshot(event.target.value)}
            >
              {snapshots.map((snapshot) => (
                <option key={snapshot}>{snapshot}</option>
              ))}
            </select>
            <button className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="rounded-md border bg-muted/10 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">File Tree</h3>
            <div className="mt-3 space-y-1 text-sm">{renderTree(tree)}</div>
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
                Select a folder in the tree to view files.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
