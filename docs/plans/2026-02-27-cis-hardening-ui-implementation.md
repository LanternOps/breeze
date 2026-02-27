# CIS Hardening UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the CIS Hardening dashboard page — a single tabbed page for MSP admins to monitor CIS benchmark compliance across their fleet.

**Architecture:** Astro page at `/cis-hardening` with a single React island (`CisHardeningPage`) hydrated via `client:load`. Three tabs (Compliance, Baselines, Remediations) with summary stat cards. One new API endpoint (`GET /cis/remediations`) needed for the Remediations tab. Follows existing SecurityDashboard + ThreatList patterns.

**Tech Stack:** Astro, React, TypeScript, Tailwind CSS, Lucide React icons, `fetchWithAuth` for API calls.

**Design doc:** `docs/plans/2026-02-27-cis-hardening-ui-design.md`

---

## Task 0: Add `GET /cis/remediations` API endpoint

The Remediations tab needs a list endpoint. The current API only has POST endpoints for remediation actions.

**Files:**
- Modify: `apps/api/src/routes/cisHardening.ts` (add new route after line 850)

**Step 1: Add the list remediations route**

Add this route at the end of `cisHardening.ts`, before the closing of the file:

```typescript
const listRemediationsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['pending_approval', 'queued', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
  deviceId: z.string().uuid().optional(),
  baselineId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

cisHardeningRoutes.get(
  '/remediations',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', listRemediationsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(cisRemediationActions.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(cisRemediationActions.orgId);
      if (orgCondition) conditions.push(orgCondition);
    }
    if (query.status) conditions.push(eq(cisRemediationActions.status, query.status));
    if (query.approvalStatus) conditions.push(eq(cisRemediationActions.approvalStatus, query.approvalStatus));
    if (query.deviceId) conditions.push(eq(cisRemediationActions.deviceId, query.deviceId));
    if (query.baselineId) conditions.push(eq(cisRemediationActions.baselineId, query.baselineId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(cisRemediationActions)
      .where(where);

    const rows = await db
      .select({
        action: cisRemediationActions,
        deviceHostname: devices.hostname,
        baselineName: cisBaselines.name,
      })
      .from(cisRemediationActions)
      .innerJoin(devices, eq(cisRemediationActions.deviceId, devices.id))
      .leftJoin(cisBaselines, eq(cisRemediationActions.baselineId, cisBaselines.id))
      .where(where)
      .orderBy(desc(cisRemediationActions.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map((row) => ({
        ...row.action,
        createdAt: row.action.createdAt.toISOString(),
        executedAt: row.action.executedAt?.toISOString() ?? null,
        approvedAt: row.action.approvedAt?.toISOString() ?? null,
        deviceHostname: row.deviceHostname,
        baselineName: row.baselineName,
      })),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0),
      },
    });
  }
);
```

**Step 2: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/api/src/routes/cisHardening.ts
git commit -m "feat(api): add GET /cis/remediations list endpoint for UI"
```

---

## Task 1: Add sidebar navigation entry

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

**Step 1: Add CIS Hardening to monitoringNav**

In `Sidebar.tsx`, find the `monitoringNav` array (line 54) and add the entry. Also import `ClipboardCheck` for a distinct icon (ShieldCheck is already used for Security):

```typescript
// Change import to add ClipboardCheck
import {
  // ... existing imports ...
  ClipboardCheck,
} from 'lucide-react';

// Add to monitoringNav after AI Risk Engine:
const monitoringNav = [
  { name: 'Monitoring', href: '/monitoring', icon: Activity },
  { name: 'Security', href: '/security', icon: ShieldCheck },
  { name: 'AI Risk Engine', href: '/ai-risk', icon: BrainCircuit },
  { name: 'CIS Benchmarks', href: '/cis-hardening', icon: ClipboardCheck },
];
```

**Step 2: Verify TypeScript compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): add CIS Benchmarks to sidebar navigation"
```

---

## Task 2: Create Astro page wrapper

**Files:**
- Create: `apps/web/src/pages/cis-hardening/index.astro`

**Step 1: Create the page directory and file**

```bash
mkdir -p apps/web/src/pages/cis-hardening
```

**Step 2: Write the Astro page**

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import CisHardeningPage from '../../components/cisHardening/CisHardeningPage';
---

<DashboardLayout title="CIS Benchmarks">
  <CisHardeningPage client:load />
</DashboardLayout>
```

**Step 3: Commit** (wait until Task 3 creates the React component so imports resolve)

---

## Task 3: Create CisHardeningPage main component with tabs

This is the root React component that holds tab state, loads summary data, and renders the active tab.

**Files:**
- Create: `apps/web/src/components/cisHardening/CisHardeningPage.tsx`

**Step 1: Write CisHardeningPage**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import CisSummaryCards from './CisSummaryCards';
import CisComplianceTab from './CisComplianceTab';
import CisBaselinesTab from './CisBaselinesTab';
import CisRemediationsTab from './CisRemediationsTab';

interface CisSummary {
  devicesAudited: number;
  averageScore: number;
  failingDevices: number;
  compliantDevices: number;
}

const tabs = [
  { id: 'compliance', label: 'Compliance' },
  { id: 'baselines', label: 'Baselines' },
  { id: 'remediations', label: 'Remediations' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export default function CisHardeningPage() {
  const [activeTab, setActiveTab] = useState<TabId>('compliance');
  const [summary, setSummary] = useState<CisSummary | null>(null);
  const [baselinesCount, setBaselinesCount] = useState<number>(0);
  const [pendingRemediations, setPendingRemediations] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [complianceRes, baselinesRes, remediationsRes] = await Promise.all([
        fetchWithAuth('/cis/compliance?limit=1'),
        fetchWithAuth('/cis/baselines?active=true&limit=1'),
        fetchWithAuth('/cis/remediations?status=pending_approval&limit=1'),
      ]);

      if (!complianceRes.ok || !baselinesRes.ok || !remediationsRes.ok) {
        throw new Error('Failed to load CIS summary data');
      }

      const [complianceData, baselinesData, remediationsData] = await Promise.all([
        complianceRes.json(),
        baselinesRes.json(),
        remediationsRes.json(),
      ]);

      setSummary(complianceData.summary);
      setBaselinesCount(baselinesData.pagination.total);
      setPendingRemediations(remediationsData.pagination.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary, refreshKey]);

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading CIS hardening data...</p>
        </div>
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={handleRefresh}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">CIS Hardening</h1>
          <p className="text-sm text-muted-foreground">
            Monitor CIS benchmark compliance across your fleet
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <CisSummaryCards
        summary={summary}
        baselinesCount={baselinesCount}
        pendingRemediations={pendingRemediations}
      />

      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab.id
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'compliance' && <CisComplianceTab refreshKey={refreshKey} />}
      {activeTab === 'baselines' && <CisBaselinesTab refreshKey={refreshKey} onMutate={handleRefresh} />}
      {activeTab === 'remediations' && <CisRemediationsTab refreshKey={refreshKey} />}
    </div>
  );
}
```

**Step 2: Verify TypeScript compiles** (after creating all child components — Task 4-8)

---

## Task 4: Create CisSummaryCards component

**Files:**
- Create: `apps/web/src/components/cisHardening/CisSummaryCards.tsx`

**Step 1: Write CisSummaryCards**

```typescript
import { BarChart3, AlertTriangle, Layers, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CisSummary {
  devicesAudited: number;
  averageScore: number;
  failingDevices: number;
  compliantDevices: number;
}

interface CisSummaryCardsProps {
  summary: CisSummary | null;
  baselinesCount: number;
  pendingRemediations: number;
}

function scoreVariant(score: number): string {
  if (score >= 80) return 'text-emerald-600';
  if (score >= 60) return 'text-amber-600';
  return 'text-red-600';
}

function scoreBarColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-amber-500';
  return 'bg-red-500';
}

export default function CisSummaryCards({ summary, baselinesCount, pendingRemediations }: CisSummaryCardsProps) {
  const avgScore = summary?.averageScore ?? 0;
  const failing = summary?.failingDevices ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Average Score */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Average Score</p>
            <p className={cn('text-xl font-semibold', scoreVariant(avgScore))}>{avgScore}%</p>
            <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
              <div
                className={cn('h-1.5 rounded-full transition-all', scoreBarColor(avgScore))}
                style={{ width: `${avgScore}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Failing Devices */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Failing Devices</p>
            <p className={cn('text-xl font-semibold', failing > 0 ? 'text-red-600' : 'text-emerald-600')}>
              {failing}
            </p>
          </div>
        </div>
      </div>

      {/* Active Baselines */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Active Baselines</p>
            <p className="text-xl font-semibold">{baselinesCount}</p>
          </div>
        </div>
      </div>

      {/* Pending Remediations */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted/30 p-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Pending Remediations</p>
            <p className={cn('text-xl font-semibold', pendingRemediations > 0 ? 'text-amber-600' : 'text-foreground')}>
              {pendingRemediations}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit** (batch with other components)

---

## Task 5: Create CisComplianceTab with expandable rows

The primary tab — "what needs fixing." Shows a filterable table of devices sorted by score ascending.

**Files:**
- Create: `apps/web/src/components/cisHardening/CisComplianceTab.tsx`
- Create: `apps/web/src/components/cisHardening/CisComplianceRow.tsx`

**Step 1: Write CisComplianceTab**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import { formatRelativeTime } from '@/lib/utils';
import CisComplianceRow from './CisComplianceRow';

interface ComplianceEntry {
  result: {
    id: string;
    orgId: string;
    deviceId: string;
    baselineId: string;
    checkedAt: string;
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    score: number;
    findings: unknown[];
    summary: Record<string, unknown>;
    createdAt: string;
  };
  baseline: {
    id: string;
    orgId: string;
    name: string;
    osType: string;
    benchmarkVersion: string;
    level: string;
  };
  device: {
    id: string;
    hostname: string;
    osType: string;
    status: string;
  };
}

interface CisComplianceTabProps {
  refreshKey: number;
}

function scoreBarColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-amber-500';
  return 'bg-red-500';
}

export default function CisComplianceTab({ refreshKey }: CisComplianceTabProps) {
  const [entries, setEntries] = useState<ComplianceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [osFilter, setOsFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (osFilter !== 'all') params.set('osType', osFilter);

      const res = await fetchWithAuth(`/cis/compliance?${params}`);
      if (!res.ok) throw new Error('Failed to load compliance data');
      const data = await res.json();
      setEntries(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [osFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  const filtered = search
    ? entries.filter((e) =>
        e.device.hostname.toLowerCase().includes(search.toLowerCase()) ||
        e.baseline.name.toLowerCase().includes(search.toLowerCase())
      )
    : entries;

  // Sort by score ascending (worst first)
  const sorted = [...filtered].sort((a, b) => a.result.score - b.result.score);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Compliance Overview</h2>
          <p className="text-sm text-muted-foreground">{sorted.length} device results</p>
        </div>
        <div className="flex flex-1 flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
          <div className="relative w-full lg:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search hostname or baseline..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <select
            value={osFilter}
            onChange={(e) => setOsFilter(e.target.value)}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All OS</option>
            <option value="windows">Windows</option>
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Baseline</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Failed Checks</th>
              <th className="px-4 py-3">Last Scanned</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading compliance data...
                  </span>
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No compliance results found.
                </td>
              </tr>
            ) : (
              sorted.map((entry) => (
                <CisComplianceRow
                  key={entry.result.id}
                  entry={entry}
                  expanded={expandedId === entry.result.id}
                  onToggle={() =>
                    setExpandedId(expandedId === entry.result.id ? null : entry.result.id)
                  }
                  scoreBarColor={scoreBarColor}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

**Step 2: Write CisComplianceRow**

```typescript
import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import { formatRelativeTime } from '@/lib/utils';

interface Finding {
  checkId: string;
  title: string;
  severity: string;
  status: string;
  evidence?: Record<string, unknown> | null;
  message?: string | null;
}

interface ComplianceEntry {
  result: {
    id: string;
    orgId: string;
    deviceId: string;
    baselineId: string;
    checkedAt: string;
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    score: number;
    findings: unknown[];
    summary: Record<string, unknown>;
    createdAt: string;
  };
  baseline: {
    id: string;
    orgId: string;
    name: string;
    osType: string;
    benchmarkVersion: string;
    level: string;
  };
  device: {
    id: string;
    hostname: string;
    osType: string;
    status: string;
  };
}

interface CisComplianceRowProps {
  entry: ComplianceEntry;
  expanded: boolean;
  onToggle: () => void;
  scoreBarColor: (score: number) => string;
}

const severityBadge: Record<string, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
};

export default function CisComplianceRow({ entry, expanded, onToggle, scoreBarColor }: CisComplianceRowProps) {
  const { result, baseline, device } = entry;

  // Use findings from compliance data directly (already returned in the payload)
  const failedFindings = (result.findings as Finding[]).filter((f) => f.status === 'fail');

  return (
    <>
      <tr
        className="cursor-pointer text-sm hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="font-medium">{device.hostname}</span>
          </div>
        </td>
        <td className="px-4 py-3">{baseline.name}</td>
        <td className="px-4 py-3 capitalize">{device.osType}</td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="w-8 text-right font-medium">{result.score}</span>
            <div className="h-2 w-16 rounded-full bg-muted">
              <div
                className={cn('h-2 rounded-full transition-all', scoreBarColor(result.score))}
                style={{ width: `${result.score}%` }}
              />
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-red-600 font-medium">{result.failedChecks}</td>
        <td className="px-4 py-3 text-muted-foreground">
          {formatRelativeTime(new Date(result.checkedAt))}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={6} className="bg-muted/20 px-6 py-4">
            {failedFindings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No failed checks to display.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Failed Checks ({failedFindings.length})
                </p>
                <div className="divide-y rounded-md border bg-card">
                  {failedFindings.map((finding) => (
                    <div key={finding.checkId} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <span className={cn(
                        'inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold',
                        severityBadge[finding.severity] ?? 'bg-muted text-muted-foreground border-muted'
                      )}>
                        {finding.severity}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{finding.checkId}</span>
                      <span className="flex-1">{finding.title}</span>
                      {finding.message && (
                        <span className="max-w-xs truncate text-xs text-muted-foreground">{finding.message}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
```

**Step 3: Commit** (batch with other components)

---

## Task 6: Create CisBaselinesTab with CRUD

Baselines CRUD list with create/edit modal and trigger-scan action.

**Files:**
- Create: `apps/web/src/components/cisHardening/CisBaselinesTab.tsx`
- Create: `apps/web/src/components/cisHardening/CisBaselineForm.tsx`

**Step 1: Write CisBaselinesTab**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { Plus, Play, Pencil, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import CisBaselineForm from './CisBaselineForm';

interface Baseline {
  id: string;
  orgId: string;
  name: string;
  osType: string;
  benchmarkVersion: string;
  level: string;
  customExclusions: string[];
  scanSchedule: { enabled?: boolean; intervalHours?: number } | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CisBaselinesTabProps {
  refreshKey: number;
  onMutate: () => void;
}

const levelBadge: Record<string, string> = {
  l1: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  l2: 'bg-purple-500/20 text-purple-700 border-purple-500/30',
  custom: 'bg-gray-500/20 text-gray-700 border-gray-500/30',
};

export default function CisBaselinesTab({ refreshKey, onMutate }: CisBaselinesTabProps) {
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Baseline | null>(null);
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState<string | null>(null);

  const fetchBaselines = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth('/cis/baselines?limit=200');
      if (!res.ok) throw new Error('Failed to load baselines');
      const data = await res.json();
      setBaselines(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBaselines();
  }, [fetchBaselines, refreshKey]);

  const handleTriggerScan = async (baseline: Baseline) => {
    setScanning(baseline.id);
    try {
      const res = await fetchWithAuth('/cis/scan', {
        method: 'POST',
        body: JSON.stringify({ baselineId: baseline.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to trigger scan');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(null);
    }
  };

  const handleFormClose = () => {
    setEditing(null);
    setCreating(false);
  };

  const handleFormSaved = () => {
    handleFormClose();
    fetchBaselines();
    onMutate();
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Baselines</h2>
          <p className="text-sm text-muted-foreground">{baselines.length} baseline profiles</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Baseline
        </button>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Level</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading baselines...
                  </span>
                </td>
              </tr>
            ) : baselines.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No baselines configured. Create one to get started.
                </td>
              </tr>
            ) : (
              baselines.map((b) => (
                <tr key={b.id} className="text-sm">
                  <td className="px-4 py-3 font-medium">{b.name}</td>
                  <td className="px-4 py-3 capitalize">{b.osType}</td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold uppercase',
                      levelBadge[b.level] ?? 'bg-muted text-muted-foreground'
                    )}>
                      {b.level}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{b.benchmarkVersion}</td>
                  <td className="px-4 py-3">
                    {b.scanSchedule?.enabled ? (
                      <span className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        Every {b.scanSchedule.intervalHours}h
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                        Disabled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold',
                      b.isActive
                        ? 'border-emerald-500/30 bg-emerald-500/20 text-emerald-700'
                        : 'bg-muted text-muted-foreground'
                    )}>
                      {b.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(b)}
                        className="rounded-md border p-1.5 hover:bg-muted"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTriggerScan(b)}
                        disabled={!b.isActive || scanning === b.id}
                        className="rounded-md border p-1.5 hover:bg-muted disabled:opacity-50"
                        title="Trigger Scan"
                      >
                        {scanning === b.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <CisBaselineForm
          baseline={editing}
          onClose={handleFormClose}
          onSaved={handleFormSaved}
        />
      )}
    </div>
  );
}
```

**Step 2: Write CisBaselineForm**

```typescript
import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';

interface Baseline {
  id: string;
  orgId: string;
  name: string;
  osType: string;
  benchmarkVersion: string;
  level: string;
  customExclusions: string[];
  scanSchedule: { enabled?: boolean; intervalHours?: number } | null;
  isActive: boolean;
}

interface CisBaselineFormProps {
  baseline: Baseline | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function CisBaselineForm({ baseline, onClose, onSaved }: CisBaselineFormProps) {
  const isEdit = !!baseline;
  const [name, setName] = useState(baseline?.name ?? '');
  const [osType, setOsType] = useState(baseline?.osType ?? 'windows');
  const [benchmarkVersion, setBenchmarkVersion] = useState(baseline?.benchmarkVersion ?? '');
  const [level, setLevel] = useState(baseline?.level ?? 'l1');
  const [scheduleEnabled, setScheduleEnabled] = useState(baseline?.scanSchedule?.enabled ?? false);
  const [intervalHours, setIntervalHours] = useState(baseline?.scanSchedule?.intervalHours ?? 24);
  const [isActive, setIsActive] = useState(baseline?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const handleSave = async () => {
    if (!name.trim() || !benchmarkVersion.trim()) {
      setError('Name and benchmark version are required');
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        osType,
        benchmarkVersion: benchmarkVersion.trim(),
        level,
        isActive,
        scanSchedule: {
          enabled: scheduleEnabled,
          intervalHours,
        },
      };
      if (isEdit) body.id = baseline.id;

      const res = await fetchWithAuth('/cis/baselines', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save baseline');
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{isEdit ? 'Edit Baseline' : 'New Baseline'}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label htmlFor="bl-name" className="mb-1.5 block text-sm font-medium">Name</label>
            <input
              id="bl-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="e.g. Windows 11 L1"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="bl-os" className="mb-1.5 block text-sm font-medium">OS Type</label>
              <select
                id="bl-os"
                value={osType}
                onChange={(e) => setOsType(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="windows">Windows</option>
                <option value="macos">macOS</option>
                <option value="linux">Linux</option>
              </select>
            </div>
            <div>
              <label htmlFor="bl-level" className="mb-1.5 block text-sm font-medium">Level</label>
              <select
                id="bl-level"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="l1">L1</option>
                <option value="l2">L2</option>
                <option value="custom">Custom</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="bl-version" className="mb-1.5 block text-sm font-medium">Benchmark Version</label>
            <input
              id="bl-version"
              type="text"
              value={benchmarkVersion}
              onChange={(e) => setBenchmarkVersion(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="e.g. 3.0.0"
            />
          </div>

          <div className="flex items-center gap-3">
            <input
              id="bl-schedule"
              type="checkbox"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="bl-schedule" className="text-sm font-medium">Enable scheduled scans</label>
            {scheduleEnabled && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Every</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={intervalHours}
                  onChange={(e) => setIntervalHours(Number(e.target.value))}
                  className="w-16 rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <span className="text-sm text-muted-foreground">hours</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <input
              id="bl-active"
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label htmlFor="bl-active" className="text-sm font-medium">Active</label>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : isEdit ? (
              'Save Changes'
            ) : (
              'Create Baseline'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 3: Commit** (batch with other components)

---

## Task 7: Create CisRemediationsTab

Read-only status view of remediation actions.

**Files:**
- Create: `apps/web/src/components/cisHardening/CisRemediationsTab.tsx`

**Step 1: Write CisRemediationsTab**

```typescript
import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import { formatRelativeTime } from '@/lib/utils';

interface RemediationAction {
  id: string;
  orgId: string;
  deviceId: string;
  baselineId: string | null;
  checkId: string;
  action: string;
  status: string;
  approvalStatus: string;
  createdAt: string;
  executedAt: string | null;
  approvedAt: string | null;
  deviceHostname: string;
  baselineName: string | null;
}

interface CisRemediationsTabProps {
  refreshKey: number;
}

const statusBadge: Record<string, string> = {
  pending_approval: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  queued: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  in_progress: 'bg-sky-500/20 text-sky-700 border-sky-500/30',
  completed: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30',
  failed: 'bg-red-500/20 text-red-700 border-red-500/30',
  cancelled: 'bg-gray-500/20 text-gray-600 border-gray-500/30',
};

const approvalBadge: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  approved: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30',
  rejected: 'bg-red-500/20 text-red-700 border-red-500/30',
};

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

export default function CisRemediationsTab({ refreshKey }: CisRemediationsTabProps) {
  const [actions, setActions] = useState<RemediationAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (statusFilter !== 'all') params.set('status', statusFilter);

      const res = await fetchWithAuth(`/cis/remediations?${params}`);
      if (!res.ok) throw new Error('Failed to load remediation actions');
      const data = await res.json();
      setActions(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Remediations</h2>
          <p className="text-sm text-muted-foreground">{actions.length} remediation actions</p>
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All statuses</option>
          <option value="pending_approval">Pending Approval</option>
          <option value="queued">Queued</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Check ID</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Baseline</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Approval</th>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">Completed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading remediations...
                  </span>
                </td>
              </tr>
            ) : actions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No remediation actions found.
                </td>
              </tr>
            ) : (
              actions.map((a) => (
                <tr key={a.id} className="text-sm">
                  <td className="px-4 py-3 font-mono text-xs">{a.checkId}</td>
                  <td className="px-4 py-3 font-medium">{a.deviceHostname}</td>
                  <td className="px-4 py-3 text-muted-foreground">{a.baselineName ?? '—'}</td>
                  <td className="px-4 py-3 capitalize">{a.action}</td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize',
                      statusBadge[a.status] ?? 'bg-muted text-muted-foreground'
                    )}>
                      {formatStatus(a.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize',
                      approvalBadge[a.approvalStatus] ?? 'bg-muted text-muted-foreground'
                    )}>
                      {a.approvalStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatRelativeTime(new Date(a.createdAt))}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {a.executedAt ? formatRelativeTime(new Date(a.executedAt)) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

**Step 2: Commit** (batch with other components)

---

## Task 8: Create all files, verify compilation, and commit

This task brings everything together.

**Step 1: Create the directory**

```bash
mkdir -p apps/web/src/components/cisHardening
mkdir -p apps/web/src/pages/cis-hardening
```

**Step 2: Create all files from Tasks 2-7**

Create each file as specified in the tasks above.

**Step 3: Verify TypeScript compiles**

```bash
cd apps/web && npx tsc --noEmit
```
Expected: No errors

**Step 4: Commit all frontend files**

```bash
git add apps/web/src/pages/cis-hardening/index.astro \
       apps/web/src/components/cisHardening/CisHardeningPage.tsx \
       apps/web/src/components/cisHardening/CisSummaryCards.tsx \
       apps/web/src/components/cisHardening/CisComplianceTab.tsx \
       apps/web/src/components/cisHardening/CisComplianceRow.tsx \
       apps/web/src/components/cisHardening/CisBaselinesTab.tsx \
       apps/web/src/components/cisHardening/CisBaselineForm.tsx \
       apps/web/src/components/cisHardening/CisRemediationsTab.tsx \
       apps/web/src/components/layout/Sidebar.tsx

git commit -m "feat(web): add CIS Hardening dashboard page with 3-tab layout"
```

**Step 5: Commit the API endpoint**

```bash
git add apps/api/src/routes/cisHardening.ts
git commit -m "feat(api): add GET /cis/remediations list endpoint"
```

---

## Summary

| Task | What it builds | Files |
|------|---------------|-------|
| 0 | `GET /cis/remediations` API endpoint | `apps/api/src/routes/cisHardening.ts` |
| 1 | Sidebar "CIS Benchmarks" nav entry | `apps/web/src/components/layout/Sidebar.tsx` |
| 2 | Astro page wrapper | `apps/web/src/pages/cis-hardening/index.astro` |
| 3 | Main page component with tabs | `apps/web/src/components/cisHardening/CisHardeningPage.tsx` |
| 4 | Summary stat cards | `apps/web/src/components/cisHardening/CisSummaryCards.tsx` |
| 5 | Compliance tab + expandable rows | `CisComplianceTab.tsx` + `CisComplianceRow.tsx` |
| 6 | Baselines tab + create/edit form | `CisBaselinesTab.tsx` + `CisBaselineForm.tsx` |
| 7 | Remediations tab (read-only) | `apps/web/src/components/cisHardening/CisRemediationsTab.tsx` |
| 8 | Integration + verify + commit | All files above |
