import { useCallback, useEffect, useMemo, useState } from 'react';
import { Calendar, GitCompare, RotateCcw, User, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type ScriptVersion = {
  id: string;
  version: number;
  date: string;
  author: string;
  authorEmail?: string;
  changelog: string[];
  content: string;
};

type DiffLine = {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
};

type ScriptVersionHistoryProps = {
  scriptId: string;
};

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

export default function ScriptVersionHistory({ scriptId }: ScriptVersionHistoryProps) {
  const [versions, setVersions] = useState<ScriptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [compareLeftId, setCompareLeftId] = useState<string | null>(null);
  const [compareRightId, setCompareRightId] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ScriptVersion | null>(null);
  const [rollbackLoading, setRollbackLoading] = useState(false);

  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      // Note: The API currently returns the script with its current version.
      // When a versions endpoint is available, update to: /scripts/${scriptId}/versions
      const response = await fetchWithAuth(`/scripts/${scriptId}`);
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch script versions');
      }

      const script = await response.json();

      // Build version entry from current script data
      // When a proper versions API exists, this would be replaced with the API response
      const currentVersion: ScriptVersion = {
        id: `v${script.version || 1}`,
        version: script.version || 1,
        date: script.updatedAt || script.createdAt || new Date().toISOString(),
        author: script.createdByName || script.createdBy || 'Unknown',
        authorEmail: script.createdByEmail,
        changelog: script.changelog || ['Current version'],
        content: script.content || ''
      };

      setVersions([currentVersion]);
      setActiveVersionId(currentVersion.id);
      setCompareRightId(currentVersion.id);
      setCompareLeftId(currentVersion.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [scriptId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

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

  const handleRollback = async () => {
    if (!rollbackTarget) return;

    setRollbackLoading(true);
    try {
      // Rollback by updating the script content to the selected version
      const response = await fetchWithAuth(`/scripts/${scriptId}`, {
        method: 'PUT',
        body: JSON.stringify({
          content: rollbackTarget.content
        })
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to rollback script');
      }

      setActiveVersionId(rollbackTarget.id);
      setRollbackTarget(null);
      // Refresh to get the new version
      await fetchVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setRollbackLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="mt-4 text-sm text-muted-foreground">Loading version history...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
        <button
          type="button"
          onClick={fetchVersions}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

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
            {activeVersion ? `v${activeVersion.version}` : 'Unknown'}
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-3">
          {sortedVersions.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No version history available.
            </div>
          ) : (
            sortedVersions.map(version => (
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
                  {activeVersionId !== version.id && (
                    <button
                      type="button"
                      onClick={() => setRollbackTarget(version)}
                      className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Rollback
                    </button>
                  )}
                </div>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {version.changelog.map((item, index) => (
                    <li key={`${version.id}-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            ))
          )}
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
              <p className="text-muted-foreground">
                {sortedVersions.length <= 1
                  ? 'Only one version available. Make changes to see diffs.'
                  : 'Select two versions to view a diff.'}
              </p>
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
                disabled={rollbackLoading}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRollback}
                disabled={rollbackLoading}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {rollbackLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {rollbackLoading ? 'Rolling back...' : 'Confirm Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
