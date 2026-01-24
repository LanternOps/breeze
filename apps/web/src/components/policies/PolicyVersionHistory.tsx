import { useMemo, useState } from 'react';
import { ArrowLeftRight, Clock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PolicyVersion = {
  id: string;
  version: number;
  createdAt: string;
  author: string;
  settings: Record<string, unknown>;
};

type PolicyVersionHistoryProps = {
  versions?: PolicyVersion[];
  onCompare?: (version: PolicyVersion) => void;
  onRollback?: (version: PolicyVersion) => void;
};

const mockVersions: PolicyVersion[] = [
  {
    id: 'ver-5',
    version: 5,
    createdAt: '2024-04-11T10:10:00Z',
    author: 'Ava Patel',
    settings: { realtimeScanning: true, firewallDefault: 'block', vpnRequired: true }
  },
  {
    id: 'ver-4',
    version: 4,
    createdAt: '2024-04-05T15:32:00Z',
    author: 'Mason Cole',
    settings: { realtimeScanning: true, firewallDefault: 'allow', vpnRequired: true }
  },
  {
    id: 'ver-3',
    version: 3,
    createdAt: '2024-03-22T09:14:00Z',
    author: 'Evelyn Hart',
    settings: { realtimeScanning: false, firewallDefault: 'allow', vpnRequired: false }
  },
  {
    id: 'ver-2',
    version: 2,
    createdAt: '2024-03-10T12:05:00Z',
    author: 'Noah Kim',
    settings: { realtimeScanning: false, firewallDefault: 'allow', vpnRequired: true }
  }
];

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function PolicyVersionHistory({
  versions = mockVersions,
  onCompare,
  onRollback
}: PolicyVersionHistoryProps) {
  const [compareId, setCompareId] = useState<string | null>(null);
  const [pendingRollbackId, setPendingRollbackId] = useState<string | null>(null);

  const compareVersion = useMemo(
    () => versions.find(version => version.id === compareId) ?? null,
    [compareId, versions]
  );

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Version History</h3>
          <p className="text-sm text-muted-foreground">
            Track changes and rollback to previous policy states.
          </p>
        </div>
        <div className="text-sm text-muted-foreground">{versions.length} versions</div>
      </div>

      <div className="mt-6 space-y-4">
        {versions.map((version, index) => (
          <div key={version.id} className="relative pl-8">
            <span className="absolute left-2 top-2 h-full w-px bg-muted" />
            <span
              className={cn(
                'absolute left-0 top-1.5 flex h-4 w-4 items-center justify-center rounded-full border',
                index === 0 ? 'border-primary bg-primary/20' : 'border-muted-foreground bg-card'
              )}
            />
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-sm font-semibold">Version {version.version}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {formatDate(version.createdAt)} by {version.author}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCompareId(prev => (prev === version.id ? null : version.id));
                      onCompare?.(version);
                    }}
                    className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                  >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    Compare
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingRollbackId(version.id)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Rollback
                  </button>
                </div>
              </div>
              {pendingRollbackId === version.id && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                  <span className="text-destructive">
                    Confirm rollback to version {version.version}?
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onRollback?.(version);
                        setPendingRollbackId(null);
                      }}
                      className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingRollbackId(null)}
                      className="rounded-md border px-2 py-1 text-xs font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {compareVersion && (
        <div className="mt-6 rounded-lg border bg-muted/30 p-4">
          <div className="text-sm font-semibold">
            Settings diff for version {compareVersion.version}
          </div>
          <p className="text-xs text-muted-foreground">
            Showing snapshot settings JSON for quick comparison.
          </p>
          <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-background p-3 text-xs text-foreground">
            {JSON.stringify(compareVersion.settings, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
