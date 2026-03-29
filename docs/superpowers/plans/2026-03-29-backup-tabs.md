# Backup Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified "Backup" tab on device details (replacing "Backup Verification") and a tabbed layout on the `/backup` page with an org-wide "Verification" tab.

**Architecture:** Two new components (`DeviceBackupTab`, `BackupVerificationOverview`), one refactored component (`BackupDashboard` gets tab navigation and its existing content extracted to `BackupOverviewContent`). The existing `BackupVerificationTab` is embedded as a section within `DeviceBackupTab` with its hardcoded colors normalized.

**Tech Stack:** React, Tailwind CSS with design tokens, existing `fetchWithAuth` pattern, hash-based tab routing.

**Spec:** `docs/superpowers/specs/2026-03-29-backup-tabs-design.md`

---

### Task 1: Normalize BackupVerificationTab colors

**Files:**
- Modify: `apps/web/src/components/backup/BackupVerificationTab.tsx`

- [ ] **Step 1: Replace hardcoded status colors with design tokens**

In `BackupVerificationTab.tsx`, replace the `statusConfig` object (lines 47-53):

```typescript
const statusConfig: Record<VerificationStatus, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pending: { icon: Clock, color: 'text-warning', label: 'Pending' },
  running: { icon: Loader2, color: 'text-primary', label: 'Running' },
  passed: { icon: CheckCircle2, color: 'text-success', label: 'Passed' },
  failed: { icon: XCircle, color: 'text-destructive', label: 'Failed' },
  partial: { icon: AlertTriangle, color: 'text-warning', label: 'Partial' },
};
```

Replace `severityColors` (lines 55-59):

```typescript
const severityColors: Record<string, string> = {
  low: 'bg-warning/10 text-warning border-warning/30',
  medium: 'bg-warning/20 text-warning border-warning/40',
  high: 'bg-destructive/10 text-destructive border-destructive/30',
};
```

Replace `readinessColor` function (lines 68-71):

```typescript
function readinessColor(score: number): string {
  if (score >= 85) return 'text-success';
  if (score >= 70) return 'text-warning';
  return 'text-destructive';
}
```

- [ ] **Step 2: Replace remaining hardcoded colors in the JSX**

Find and replace in the same file:
- `text-green-600` (lines 224, 339) → `text-success`
- `text-red-600` (line 340) → `text-destructive`
- `bg-gray-100` / `text-gray-600` / `border-gray-300` (line 328, "simulated" badge) → `bg-muted text-muted-foreground border-border`

- [ ] **Step 3: Verify no hardcoded colors remain**

Run: `grep -n 'text-yellow\|text-green\|text-red\|text-blue\|bg-yellow\|bg-orange\|bg-red\|bg-gray' apps/web/src/components/backup/BackupVerificationTab.tsx`
Expected: no output

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: clean compile

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/backup/BackupVerificationTab.tsx
git commit -m "fix(web): normalize BackupVerificationTab colors to design tokens"
```

---

### Task 2: Create DeviceBackupTab component

**Files:**
- Create: `apps/web/src/components/backup/DeviceBackupTab.tsx`

- [ ] **Step 1: Create the unified backup tab component**

Create `apps/web/src/components/backup/DeviceBackupTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  HardDrive,
  History,
  PlayCircle,
  ShieldAlert,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import BackupVerificationTab from './BackupVerificationTab';

type BackupStatus = {
  deviceId: string;
  protected: boolean;
  policyId?: string | null;
  lastJob?: {
    id: string;
    status: string;
    createdAt: string;
    completedAt?: string | null;
  } | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  nextScheduledAt?: string | null;
};

type BackupJob = {
  id: string;
  type: string;
  status: string;
  deviceName?: string | null;
  configName?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  totalSize?: number | null;
  errorCount?: number | null;
  errorLog?: string | null;
};

type Snapshot = {
  id: string;
  snapshotId?: string;
  label?: string;
  timestamp: string;
  size?: number | null;
  isIncremental?: boolean;
};

const jobStatusConfig: Record<string, { icon: typeof CheckCircle2; className: string; label: string }> = {
  completed: { icon: CheckCircle2, className: 'text-success bg-success/10', label: 'Completed' },
  running: { icon: Clock, className: 'text-primary bg-primary/10', label: 'Running' },
  failed: { icon: XCircle, className: 'text-destructive bg-destructive/10', label: 'Failed' },
  pending: { icon: Clock, className: 'text-muted-foreground bg-muted', label: 'Pending' },
  cancelled: { icon: XCircle, className: 'text-muted-foreground bg-muted', label: 'Cancelled' },
};

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt) return '--';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '--';
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(end)) return '--';
  const s = Math.max(0, Math.floor((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function DeviceBackupTab({ deviceId, timezone }: { deviceId: string; timezone?: string }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const [statusRes, jobsRes, snapshotsRes] = await Promise.all([
        fetchWithAuth(`/backup/status/${deviceId}`),
        fetchWithAuth(`/backup/jobs?deviceId=${deviceId}`),
        fetchWithAuth(`/backup/snapshots?deviceId=${deviceId}`),
      ]);

      if (statusRes.ok) {
        const p = await statusRes.json();
        setStatus(p?.data ?? p);
      }
      if (jobsRes.ok) {
        const p = await jobsRes.json();
        setJobs(Array.isArray(p?.data) ? p.data : []);
      }
      if (snapshotsRes.ok) {
        const p = await snapshotsRes.json();
        setSnapshots(Array.isArray(p?.data) ? p.data : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backup data');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading backup data...</p>
        </div>
      </div>
    );
  }

  // Empty state: no backup configured
  if (!status?.protected && !status?.lastJob && jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <Database className="mx-auto h-10 w-10 text-muted-foreground" />
        <h3 className="mt-4 text-base font-semibold text-foreground">No backup configured</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Assign a backup policy to protect this device.
        </p>
      </div>
    );
  }

  const lastJobStatus = status?.lastJob?.status ?? 'pending';
  const statusCfg = jobStatusConfig[lastJobStatus] ?? jobStatusConfig.pending;
  const StatusIcon = statusCfg.icon;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Status Header */}
      <div className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium', statusCfg.className)}>
              <StatusIcon className="h-3.5 w-3.5" />
              Last: {statusCfg.label}
            </span>
            {status?.lastSuccessAt && (
              <span className="text-xs text-muted-foreground">
                Last success: {formatTime(status.lastSuccessAt)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {status?.nextScheduledAt && (
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Next: {formatTime(status.nextScheduledAt)}
              </span>
            )}
            <button
              type="button"
              onClick={fetchAll}
              className="text-xs font-medium text-primary hover:text-primary/80"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Job History */}
      <div className="rounded-lg border bg-card p-5">
        <h3 className="text-base font-semibold text-foreground">Job History</h3>
        <p className="text-sm text-muted-foreground">Recent backup jobs for this device.</p>
        {jobs.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No backup jobs yet.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[500px] text-sm">
              <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Duration</th>
                  <th className="px-4 py-2">Size</th>
                  <th className="px-4 py-2">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobs.slice(0, 20).map((job) => {
                  const cfg = jobStatusConfig[job.status] ?? jobStatusConfig.pending;
                  const Icon = cfg.icon;
                  return (
                    <tr key={job.id} className="text-sm">
                      <td className="px-4 py-2 capitalize text-foreground">{job.type}</td>
                      <td className="px-4 py-2">
                        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', cfg.className)}>
                          <Icon className="h-3 w-3" />
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{formatTime(job.startedAt)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDuration(job.startedAt, job.completedAt)}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatBytes(job.totalSize)}</td>
                      <td className="px-4 py-2">
                        {(job.errorCount ?? 0) > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="h-3 w-3" />
                            {job.errorCount}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Snapshots */}
      {snapshots.length > 0 && (
        <div className="rounded-lg border bg-card p-5">
          <h3 className="text-base font-semibold text-foreground">Snapshots</h3>
          <p className="text-sm text-muted-foreground">Available restore points.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[400px] text-sm">
              <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Label</th>
                  <th className="px-4 py-2">Timestamp</th>
                  <th className="px-4 py-2">Size</th>
                  <th className="px-4 py-2">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snapshots.map((snap) => (
                  <tr key={snap.id} className="text-sm">
                    <td className="px-4 py-2 font-medium text-foreground">{snap.label ?? snap.snapshotId ?? snap.id.slice(0, 8)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{formatTime(snap.timestamp)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{formatBytes(snap.size)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{snap.isIncremental ? 'Incremental' : 'Full'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Verification & Readiness */}
      <BackupVerificationTab deviceId={deviceId} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: clean compile

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/backup/DeviceBackupTab.tsx
git commit -m "feat(web): add unified DeviceBackupTab component"
```

---

### Task 3: Wire DeviceBackupTab into DeviceDetails

**Files:**
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx`

- [ ] **Step 1: Replace backup-verification with backup in the Tab type**

In `DeviceDetails.tsx`, replace `'backup-verification'` with `'backup'` in the Tab type union (line 72):

Change:
```typescript
  | 'backup-verification';
```
To:
```typescript
  | 'backup';
```

- [ ] **Step 2: Update VALID_TABS array**

In the VALID_TABS array (line 136), replace `'backup-verification'` with `'backup'`:

Change:
```typescript
  'boot-performance', 'playbooks', 'peripherals', 'backup-verification',
```
To:
```typescript
  'boot-performance', 'playbooks', 'peripherals', 'backup',
```

- [ ] **Step 3: Update the tab definition**

In the tabs array (line 188), replace the backup-verification tab:

Change:
```typescript
    { id: 'backup-verification', label: 'Backup Verification', icon: <ShieldCheck className="h-4 w-4" />, title: 'Backup integrity and recovery readiness' }
```
To:
```typescript
    { id: 'backup', label: 'Backup', icon: <Database className="h-4 w-4" />, title: 'Backup status, jobs, snapshots, and verification' }
```

Add `Database` to the lucide-react import at the top of the file if not already present.

- [ ] **Step 4: Update the import**

Replace:
```typescript
import BackupVerificationTab from '../backup/BackupVerificationTab';
```
With:
```typescript
import DeviceBackupTab from '../backup/DeviceBackupTab';
```

- [ ] **Step 5: Update the conditional render block**

Replace (lines 353-355):
```typescript
      {activeTab === 'backup-verification' && (
        <BackupVerificationTab deviceId={device.id} />
      )}
```
With:
```typescript
      {activeTab === 'backup' && (
        <DeviceBackupTab deviceId={device.id} timezone={effectiveTimezone} />
      )}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: clean compile

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/DeviceDetails.tsx
git commit -m "feat(web): replace backup-verification tab with unified backup tab"
```

---

### Task 4: Extract BackupDashboard overview content

The dashboard is 949 lines — already over the 500-line limit. Before adding tabs, extract the overview content into its own component.

**Files:**
- Create: `apps/web/src/components/backup/BackupOverviewContent.tsx`
- Modify: `apps/web/src/components/backup/BackupDashboard.tsx`

- [ ] **Step 1: Create BackupOverviewContent**

Extract the JSX content from `BackupDashboard.tsx`'s return statement (lines 618-949) into a new component. The new component receives all the state and handlers as props.

Create `apps/web/src/components/backup/BackupOverviewContent.tsx`:

```tsx
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HardDrive,
  Loader2,
  PlayCircle,
  ShieldAlert,
  TrendingUp,
  XCircle
} from 'lucide-react';
import { cn, widthPercentClass } from '@/lib/utils';
import BackupJobList from './BackupJobList';

// Re-export or duplicate the types needed — these are the same types
// defined in BackupDashboard.tsx. They should be imported from there
// or defined in a shared types file.

type StatChangeType = 'positive' | 'negative' | 'neutral';
type BackupStat = {
  id?: string;
  name?: string;
  value?: string | number;
  change?: string;
  changeType?: StatChangeType;
};

// ... (include all type definitions used by the overview JSX)

type BackupOverviewContentProps = {
  stats: BackupStat[];
  recentJobs: any[];
  overdueDevices: any[];
  storageProviders: any[];
  usageHistory: any[];
  usageHistoryError?: string;
  attentionItems: any[];
  showAllJobs: boolean;
  setShowAllJobs: (v: boolean) => void;
  error?: string;
  runAllResult?: string;
  runAllLoading: boolean;
  handleRunAllClick: () => void;
  // All the resolve* and format* helpers from the parent
};

export default function BackupOverviewContent(props: BackupOverviewContentProps) {
  // Move the overview JSX here from BackupDashboard's return block
  // This is a mechanical extraction — copy lines 618-949 from BackupDashboard.tsx
  // and adapt to use props instead of local state
}
```

The actual implementation: move the entire return JSX from `BackupDashboard` into this component. The parent passes state as props. Keep all helper functions (resolveJobDevice, resolveJobConfig, etc.) and sub-components (UsageHistoryChart) in `BackupDashboard.tsx` — only the JSX rendering moves.

**Note to implementer:** This is a large mechanical extraction. Read the full `BackupDashboard.tsx` (949 lines), identify the return block (line 618 onward), and move it to the new component. Pass all referenced state variables as props. Keep the run-all dialog in the parent since it uses a ref.

- [ ] **Step 2: Update BackupDashboard to render BackupOverviewContent**

Replace the return block in `BackupDashboard.tsx` with:

```tsx
return (
  <BackupOverviewContent
    stats={stats}
    recentJobs={recentJobs}
    overdueDevices={overdueDevices}
    storageProviders={storageProviders}
    usageHistory={usageHistory}
    usageHistoryError={usageHistoryError}
    attentionItems={attentionItems}
    showAllJobs={showAllJobs}
    setShowAllJobs={setShowAllJobs}
    error={error}
    runAllResult={runAllResult}
    runAllLoading={runAllLoading}
    handleRunAllClick={handleRunAllClick}
  />
);
```

- [ ] **Step 3: Verify both files are under 500 lines**

Run: `wc -l apps/web/src/components/backup/BackupDashboard.tsx apps/web/src/components/backup/BackupOverviewContent.tsx`

Both should be under 500 lines.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: clean compile

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/backup/BackupOverviewContent.tsx apps/web/src/components/backup/BackupDashboard.tsx
git commit -m "refactor(web): extract BackupOverviewContent to comply with 500-line limit"
```

---

### Task 5: Add tab navigation to BackupDashboard

**Files:**
- Modify: `apps/web/src/components/backup/BackupDashboard.tsx`
- Create: `apps/web/src/components/backup/BackupVerificationOverview.tsx`

- [ ] **Step 1: Create BackupVerificationOverview component**

Create `apps/web/src/components/backup/BackupVerificationOverview.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type HealthSummary = {
  status: string;
  verification?: {
    recentFailures?: number;
    totalVerifications?: number;
  };
  readiness?: {
    averageScore?: number;
    lowReadinessCount?: number;
    highReadinessCount?: number;
  };
  escalations?: {
    criticalVerificationFailures?: number;
  };
};

type ReadinessDevice = {
  deviceId: string;
  deviceName?: string;
  readinessScore: number;
  estimatedRtoMinutes?: number | null;
  estimatedRpoMinutes?: number | null;
  riskFactors: Array<{ code: string; severity: string; message: string }>;
  calculatedAt?: string;
};

type Verification = {
  id: string;
  deviceId: string;
  deviceName?: string;
  verificationType: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  filesVerified: number;
  filesFailed: number;
};

function readinessColor(score: number): string {
  if (score >= 85) return 'text-success';
  if (score >= 70) return 'text-warning';
  return 'text-destructive';
}

export default function BackupVerificationOverview() {
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [devices, setDevices] = useState<ReadinessDevice[]>([]);
  const [failures, setFailures] = useState<Verification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const [healthRes, readinessRes, verificationsRes] = await Promise.all([
        fetchWithAuth('/backup/health'),
        fetchWithAuth('/backup/recovery-readiness'),
        fetchWithAuth('/backup/verifications?limit=50'),
      ]);

      if (healthRes.ok) {
        const p = await healthRes.json();
        setHealth(p?.data ?? null);
      }
      if (readinessRes.ok) {
        const p = await readinessRes.json();
        setDevices(Array.isArray(p?.data?.devices) ? p.data.devices : []);
      }
      if (verificationsRes.ok) {
        const p = await verificationsRes.json();
        const all = Array.isArray(p?.data) ? p.data : [];
        setFailures(all.filter((v: Verification) => v.status === 'failed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load verification data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading verification data...</p>
        </div>
      </div>
    );
  }

  const avgScore = health?.readiness?.averageScore ?? 0;
  const lowCount = health?.readiness?.lowReadinessCount ?? 0;
  const highCount = health?.readiness?.highReadinessCount ?? 0;
  const recentFailureCount = health?.verification?.recentFailures ?? 0;
  const lowDevices = devices.filter((d) => d.readinessScore < 85).sort((a, b) => a.readinessScore - b.readinessScore);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Fleet Readiness Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Avg Readiness
          </div>
          <div className="mt-2">
            <span className={cn('text-2xl font-semibold', readinessColor(avgScore))}>{avgScore}</span>
            <span className="ml-1 text-sm text-muted-foreground">/ 100</span>
          </div>
        </div>
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            High Readiness
          </div>
          <div className="mt-2 text-2xl font-semibold text-success">{highCount}</div>
        </div>
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Low Readiness
          </div>
          <div className="mt-2 text-2xl font-semibold text-warning">{lowCount}</div>
        </div>
        <div className="rounded-lg border bg-card px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <XCircle className="h-4 w-4" />
            Recent Failures
          </div>
          <div className="mt-2 text-2xl font-semibold text-destructive">{recentFailureCount}</div>
        </div>
      </div>

      {/* Recent Failures */}
      <div className="rounded-lg border bg-card p-5">
        <h3 className="text-base font-semibold text-foreground">Recent Failures</h3>
        <p className="text-sm text-muted-foreground">Failed verifications across all devices.</p>
        {failures.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No failed verifications. All checks passing.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[500px] text-sm">
              <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Device</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Files OK</th>
                  <th className="px-4 py-2">Files Failed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {failures.slice(0, 20).map((v) => (
                  <tr key={v.id} className="text-sm">
                    <td className="px-4 py-2 font-medium text-foreground">{v.deviceName ?? v.deviceId.slice(0, 8)}</td>
                    <td className="px-4 py-2 capitalize text-muted-foreground">{v.verificationType.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-2 text-muted-foreground">{new Date(v.startedAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-success">{v.filesVerified}</td>
                    <td className="px-4 py-2 text-destructive">{v.filesFailed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Low Readiness Devices */}
      <div className="rounded-lg border bg-card p-5">
        <h3 className="text-base font-semibold text-foreground">Low Readiness Devices</h3>
        <p className="text-sm text-muted-foreground">Devices scoring below 85 — sorted worst first.</p>
        {lowDevices.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            All devices meet the readiness threshold.
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[500px] text-sm">
              <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Device</th>
                  <th className="px-4 py-2">Score</th>
                  <th className="px-4 py-2">Est. RTO</th>
                  <th className="px-4 py-2">Est. RPO</th>
                  <th className="px-4 py-2">Risk Factors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lowDevices.map((d) => (
                  <tr key={d.deviceId} className="text-sm">
                    <td className="px-4 py-2 font-medium text-foreground">{d.deviceName ?? d.deviceId.slice(0, 8)}</td>
                    <td className="px-4 py-2">
                      <span className={cn('font-semibold', readinessColor(d.readinessScore))}>{d.readinessScore}</span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{d.estimatedRtoMinutes ?? '--'} min</td>
                    <td className="px-4 py-2 text-muted-foreground">{d.estimatedRpoMinutes ?? '--'} min</td>
                    <td className="px-4 py-2 text-muted-foreground">{d.riskFactors.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add tab navigation to BackupDashboard**

At the top of BackupDashboard's return block, add tab state and tab bar. Add state:

```tsx
const [activeTab, setActiveTab] = useState<'overview' | 'verification'>(() => {
  if (typeof window === 'undefined') return 'overview';
  const hash = window.location.hash.replace('#', '');
  return hash === 'verification' ? 'verification' : 'overview';
});
```

Add a `useEffect` for hash changes:

```tsx
useEffect(() => {
  const onHashChange = () => {
    const hash = window.location.hash.replace('#', '');
    setActiveTab(hash === 'verification' ? 'verification' : 'overview');
  };
  window.addEventListener('hashchange', onHashChange);
  return () => window.removeEventListener('hashchange', onHashChange);
}, []);
```

Update the return to wrap content with tabs:

```tsx
return (
  <div className="space-y-6">
    {/* Tab bar */}
    <div className="flex gap-1 border-b">
      {(['overview', 'verification'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => {
            setActiveTab(tab);
            window.location.hash = tab === 'overview' ? '' : tab;
          }}
          className={cn(
            'border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors',
            activeTab === tab
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {tab}
        </button>
      ))}
    </div>

    {activeTab === 'overview' && <BackupOverviewContent ... />}
    {activeTab === 'verification' && <BackupVerificationOverview />}
  </div>
);
```

Import `BackupVerificationOverview` at the top of the file.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: clean compile

- [ ] **Step 4: Verify file sizes**

Run: `wc -l apps/web/src/components/backup/BackupDashboard.tsx apps/web/src/components/backup/BackupOverviewContent.tsx apps/web/src/components/backup/BackupVerificationOverview.tsx apps/web/src/components/backup/DeviceBackupTab.tsx`

All files should be under 500 lines.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/backup/BackupVerificationOverview.tsx apps/web/src/components/backup/BackupDashboard.tsx
git commit -m "feat(web): add tabbed backup page with org-wide verification overview"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit --project apps/web/tsconfig.json`
Expected: clean compile

- [ ] **Step 2: Verify no hardcoded colors in new/modified backup components**

Run:
```bash
grep -rn 'text-yellow\|text-green\|text-red\|text-blue\|bg-yellow\|bg-orange\|bg-red\|bg-gray' apps/web/src/components/backup/
```
Expected: no output

- [ ] **Step 3: Verify file sizes**

Run: `wc -l apps/web/src/components/backup/*.tsx | sort -n`
All files should be under 500 lines (800 for declarative schema files).

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A apps/web/src/components/backup/ apps/web/src/components/devices/DeviceDetails.tsx
git commit -m "chore(web): final cleanup for backup tabs"
```
