import { useEffect, useMemo, useState } from 'react';
import { Calendar, GitCompare, RotateCcw, User } from 'lucide-react';
import { cn } from '@/lib/utils';

type ScriptVersion = {
  id: string;
  version: string;
  date: string;
  author: string;
  changelog: string[];
  content: string;
};

type DiffLine = {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
};

const mockVersions: ScriptVersion[] = [
  {
    id: 'v4',
    version: '1.4.0',
    date: '2024-08-21T10:15:00Z',
    author: 'Avery Park',
    changelog: ['Added device status checks', 'Improved error logging'],
    content: `#!/bin/bash\ncheck_status() {\n  systemctl is-active agent.service\n}\nlog_info() {\n  echo "[INFO] $1"\n}\nlog_info "Starting diagnostics"\ncheck_status\nlog_info "Done"`
  },
  {
    id: 'v3',
    version: '1.3.0',
    date: '2024-07-08T15:30:00Z',
    author: 'Jordan Lee',
    changelog: ['Refined logging output', 'Added retry loop'],
    content: `#!/bin/bash\ncheck_status() {\n  systemctl is-active agent.service\n}\nlog_info() {\n  echo "[INFO] $1"\n}\nlog_info "Starting diagnostics"\ncheck_status\nlog_info "Finished"`
  },
  {
    id: 'v2',
    version: '1.2.0',
    date: '2024-05-12T09:10:00Z',
    author: 'Morgan Nash',
    changelog: ['Added status check function'],
    content: `#!/bin/bash\ncheck_status() {\n  systemctl is-active agent.service\n}\ncheck_status\nlog_info "Finished"`
  },
  {
    id: 'v1',
    version: '1.1.0',
    date: '2024-03-19T11:45:00Z',
    author: 'Morgan Nash',
    changelog: ['Initial diagnostic script'],
    content: `#!/bin/bash\necho "Starting diagnostics"\nsystemctl is-active agent.service\necho "Finished"`
  }
];

const diffLines = (base: string, compare: string): DiffLine[] => {
  if (!base && !compare) return [];
  const baseLines = base.split('\n');
  const compareLines = compare.split('\n');
  const max = Math.max(baseLines.length, compareLines.length);
  const lines: DiffLine[] = [];

  for (let i = 0; i < max; i += 1) {
    const baseLine = baseLines[i];
    const compareLine = compareLines[i];
    if (baseLine === compareLine) {
      if (baseLine !== undefined) {
        lines.push({ type: 'unchanged', text: baseLine });
      }
    } else {
      if (baseLine !== undefined) {
        lines.push({ type: 'removed', text: baseLine });
      }
      if (compareLine !== undefined) {
        lines.push({ type: 'added', text: compareLine });
      }
    }
  }

  return lines;
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

export default function ScriptVersionHistory() {
  const [versions] = useState<ScriptVersion[]>(mockVersions);
  const [activeVersionId, setActiveVersionId] = useState<string>(mockVersions[0].id);
  const [compareLeftId, setCompareLeftId] = useState<string | null>(null);
  const [compareRightId, setCompareRightId] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ScriptVersion | null>(null);

  const sortedVersions = useMemo(() => {
    return [...versions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [versions]);

  useEffect(() => {
    if (sortedVersions.length === 0) return;
    if (!compareRightId) {
      setCompareRightId(sortedVersions[0].id);
    }
    if (!compareLeftId) {
      setCompareLeftId(sortedVersions[1]?.id ?? sortedVersions[0].id);
    }
  }, [compareLeftId, compareRightId, sortedVersions]);

  const leftVersion = sortedVersions.find(version => version.id === compareLeftId) ?? sortedVersions[0];
  const rightVersion = sortedVersions.find(version => version.id === compareRightId) ?? sortedVersions[0];
  const activeVersion = sortedVersions.find(version => version.id === activeVersionId);

  const lines = useMemo(() => {
    return diffLines(leftVersion?.content ?? '', rightVersion?.content ?? '');
  }, [leftVersion, rightVersion]);

  const handleRollback = () => {
    if (!rollbackTarget) return;
    setActiveVersionId(rollbackTarget.id);
    setRollbackTarget(null);
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Version History</h2>
          <p className="text-sm text-muted-foreground">Track script revisions and compare changes.</p>
        </div>
        <div className="text-sm text-muted-foreground">
          Active version:{' '}
          <span className="font-medium text-foreground">
            {activeVersion ? `v${activeVersion.version}` : activeVersionId}
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-3">
          {sortedVersions.map(version => (
            <div
              key={version.id}
              className={cn(
                'rounded-md border bg-background p-4',
                activeVersionId === version.id && 'border-primary/40 bg-primary/5'
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">v{version.version}</span>
                    {activeVersionId === version.id && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(version.date)}
                    </span>
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {version.author}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRollbackTarget(version)}
                  className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  <RotateCcw className="h-3 w-3" />
                  Rollback
                </button>
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {version.changelog.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="rounded-lg border bg-muted/20 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <GitCompare className="h-4 w-4" />
              Compare Versions
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                value={compareLeftId ?? ''}
                onChange={event => setCompareLeftId(event.target.value)}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                {sortedVersions.map(version => (
                  <option key={version.id} value={version.id}>
                    v{version.version}
                  </option>
                ))}
              </select>
              <select
                value={compareRightId ?? ''}
                onChange={event => setCompareRightId(event.target.value)}
                className="h-9 rounded-md border bg-background px-3 text-sm"
              >
                {sortedVersions.map(version => (
                  <option key={version.id} value={version.id}>
                    v{version.version}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 max-h-72 overflow-auto rounded-md border bg-background/60 p-3 font-mono text-xs">
            {lines.length === 0 ? (
              <p className="text-muted-foreground">Select two versions to view a diff.</p>
            ) : (
              lines.map((line, index) => (
                <div
                  key={`${line.type}-${index}`}
                  className={cn(
                    'flex whitespace-pre-wrap rounded px-2 py-0.5',
                    line.type === 'added' && 'bg-green-500/10 text-green-700',
                    line.type === 'removed' && 'bg-red-500/10 text-red-700'
                  )}
                >
                  <span className="mr-2 w-4 text-muted-foreground">
                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                  </span>
                  <span>{line.text || ''}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {rollbackTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold">Rollback Script</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Roll back to version <span className="font-medium">v{rollbackTarget.version}</span>? This will make it the active revision.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setRollbackTarget(null)}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRollback}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Confirm Rollback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
