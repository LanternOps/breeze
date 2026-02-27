# SentinelOne Integration UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a setup-only SentinelOne integration UI under Settings > Integrations with connection management, sync status, and S1 Site-to-Breeze Organization mapping.

**Architecture:** New Astro page mounts a self-contained React component (Islands pattern). Backend gets two new endpoints for site listing/mapping and a new DB table. All state is local React hooks; API calls use `fetchWithAuth()`.

**Tech Stack:** Astro, React, Tailwind CSS, lucide-react, Hono, Drizzle ORM, PostgreSQL

---

### Task 1: Add `s1SiteMappings` table to Drizzle schema

**Files:**
- Modify: `apps/api/src/db/schema/sentinelOne.ts:95` (append after s1Actions table)

**Step 1: Add the table definition**

Add to the end of `apps/api/src/db/schema/sentinelOne.ts`:

```typescript
export const s1SiteMappings = pgTable('s1_site_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull().references(() => s1Integrations.id),
  siteName: varchar('site_name', { length: 200 }).notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  uniqueSiteIdx: uniqueIndex('s1_site_mappings_integration_site_idx').on(table.integrationId, table.siteName),
  orgIdx: index('s1_site_mappings_org_idx').on(table.orgId)
}));
```

**Step 2: Create the SQL migration**

Create `apps/api/src/db/migrations/2026-02-27-s1-site-mappings.sql`:

```sql
-- S1 Site-to-Organization mappings
-- Maps SentinelOne site names to Breeze organizations for multi-tenant agent routing
CREATE TABLE IF NOT EXISTS s1_site_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID NOT NULL REFERENCES s1_integrations(id),
  site_name VARCHAR(200) NOT NULL,
  org_id UUID NOT NULL REFERENCES organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS s1_site_mappings_integration_site_idx
  ON s1_site_mappings (integration_id, site_name);

CREATE INDEX IF NOT EXISTS s1_site_mappings_org_idx
  ON s1_site_mappings (org_id);
```

**Step 3: Push schema**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:push
```

Or apply migration directly:
```bash
docker exec -i breeze-postgres-dev psql -U breeze -d breeze < apps/api/src/db/migrations/2026-02-27-s1-site-mappings.sql
```

**Step 4: Commit**

```bash
git add apps/api/src/db/schema/sentinelOne.ts apps/api/src/db/migrations/2026-02-27-s1-site-mappings.sql
git commit -m "feat(s1): add s1_site_mappings table for site-to-org mapping"
```

---

### Task 2: Add sites list and map endpoints to API

**Files:**
- Modify: `apps/api/src/routes/sentinelOne.ts:560` (append after sync route)

**Step 1: Add Zod schemas for the new endpoints**

Add after line 106 (after `integrationQuerySchema`):

```typescript
const siteMapSchema = z.object({
  integrationId: z.string().uuid(),
  siteName: z.string().min(1).max(200),
  orgId: z.string().uuid().nullable()
});
```

**Step 2: Add the import for s1SiteMappings**

Update the import on line 6 to include `s1SiteMappings`:

```typescript
import { devices, s1Actions, s1Agents, s1Integrations, s1SiteMappings, s1Threats } from '../db/schema';
```

Also add `organizations` to the import:

```typescript
import { devices, organizations, s1Actions, s1Agents, s1Integrations, s1SiteMappings, s1Threats } from '../db/schema';
```

**Step 3: Add GET /sites endpoint**

Append after the `/sync` route handler:

```typescript
sentinelOneRoutes.get(
  '/sites',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', integrationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const [integration] = await db
      .select({ id: s1Integrations.id })
      .from(s1Integrations)
      .where(eq(s1Integrations.orgId, orgResult.orgId))
      .limit(1);

    if (!integration) {
      return c.json({ data: [] });
    }

    // Distinct site names with agent counts from metadata->>'siteName'
    const siteRows = await db
      .select({
        siteName: sql<string>`metadata->>'siteName'`,
        agentCount: sql<number>`count(*)::int`
      })
      .from(s1Agents)
      .where(
        and(
          eq(s1Agents.integrationId, integration.id),
          sql`metadata->>'siteName' IS NOT NULL`,
          sql`metadata->>'siteName' != ''`
        )
      )
      .groupBy(sql`metadata->>'siteName'`)
      .orderBy(sql`metadata->>'siteName'`);

    // Current mappings for this integration
    const mappings = await db
      .select({
        siteName: s1SiteMappings.siteName,
        orgId: s1SiteMappings.orgId,
        orgName: organizations.name
      })
      .from(s1SiteMappings)
      .leftJoin(organizations, eq(s1SiteMappings.orgId, organizations.id))
      .where(eq(s1SiteMappings.integrationId, integration.id));

    const mappingBySite = new Map(mappings.map((m) => [m.siteName, { orgId: m.orgId, orgName: m.orgName }]));

    const data = siteRows.map((row) => {
      const mapping = mappingBySite.get(row.siteName);
      return {
        siteName: row.siteName,
        agentCount: row.agentCount,
        mappedOrgId: mapping?.orgId ?? null,
        mappedOrgName: mapping?.orgName ?? null
      };
    });

    return c.json({ data, integrationId: integration.id });
  }
);
```

**Step 4: Add POST /sites/map endpoint**

Append after the GET /sites handler:

```typescript
sentinelOneRoutes.post(
  '/sites/map',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  zValidator('json', siteMapSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    // Verify caller can access the integration
    const [integration] = await db
      .select({ id: s1Integrations.id, orgId: s1Integrations.orgId })
      .from(s1Integrations)
      .where(eq(s1Integrations.id, body.integrationId))
      .limit(1);

    if (!integration || !auth.canAccessOrg(integration.orgId)) {
      return c.json({ error: 'Integration not found or access denied' }, 404);
    }

    // If orgId is null, delete the mapping
    if (body.orgId === null) {
      await db
        .delete(s1SiteMappings)
        .where(
          and(
            eq(s1SiteMappings.integrationId, body.integrationId),
            eq(s1SiteMappings.siteName, body.siteName)
          )
        );

      writeRouteAudit(c, {
        orgId: integration.orgId,
        action: 's1.site.unmap',
        resourceType: 's1_site_mapping',
        resourceName: body.siteName,
        details: { integrationId: body.integrationId }
      });

      return c.json({ data: { siteName: body.siteName, mappedOrgId: null } });
    }

    // Verify caller can access the target org
    if (!auth.canAccessOrg(body.orgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }

    const now = new Date();
    await db
      .insert(s1SiteMappings)
      .values({
        integrationId: body.integrationId,
        siteName: body.siteName,
        orgId: body.orgId,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [s1SiteMappings.integrationId, s1SiteMappings.siteName],
        set: {
          orgId: sql`excluded.org_id`,
          updatedAt: now
        }
      });

    writeRouteAudit(c, {
      orgId: integration.orgId,
      action: 's1.site.map',
      resourceType: 's1_site_mapping',
      resourceName: body.siteName,
      details: { integrationId: body.integrationId, targetOrgId: body.orgId }
    });

    return c.json({ data: { siteName: body.siteName, mappedOrgId: body.orgId } });
  }
);
```

**Step 5: Commit**

```bash
git add apps/api/src/routes/sentinelOne.ts
git commit -m "feat(s1): add GET /sites and POST /sites/map endpoints"
```

---

### Task 3: Add Security tab to IntegrationsPage

**Files:**
- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx`

**Step 1: Add Shield import**

Update the lucide-react import (line 2-10) to include `Shield`:

```typescript
import {
  Activity,
  Cloud,
  Database,
  PlugZap,
  Plus,
  Shield,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react';
```

**Step 2: Add IntegrationCategory id union type**

Update the `id` type in `IntegrationCategory` (line 24) to include `'security'`:

```typescript
  id: 'webhooks' | 'psa' | 'monitoring' | 'backup' | 'security';
```

**Step 3: Add security category to integrationCatalog**

Add after the backup category (after line 156, before the closing `]`):

```typescript
  ,{
    id: 'security',
    label: 'Security',
    description: 'Endpoint detection and response integrations.',
    cta: 'Add security',
    icon: Shield,
    integrations: [
      {
        id: 'sec-s1',
        name: 'SentinelOne',
        description: 'EDR agent sync, threat detection, and containment.',
        status: 'disconnected',
        lastChecked: '—',
        connectedAccounts: 0
      }
    ]
  }
```

**Step 4: Commit**

```bash
git add apps/web/src/components/integrations/IntegrationsPage.tsx
git commit -m "feat(s1): add Security tab to integrations catalog"
```

---

### Task 4: Create SecurityIntegration React component

**Files:**
- Create: `apps/web/src/components/integrations/SecurityIntegration.tsx`

**Step 1: Create the component file**

Create `apps/web/src/components/integrations/SecurityIntegration.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  Shield,
  Unplug
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Integration = {
  id: string;
  orgId: string;
  name: string;
  managementUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
};

type StatusSummary = {
  totalAgents: number;
  mappedDevices: number;
  infectedAgents: number;
  activeThreats: number;
  highOrCriticalThreats: number;
  pendingActions: number;
  reportedThreatCount: number;
};

type SiteRow = {
  siteName: string;
  agentCount: number;
  mappedOrgId: string | null;
  mappedOrgName: string | null;
};

type OrgOption = {
  id: string;
  name: string;
};

type SaveState = {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message?: string;
};

type SyncState = {
  status: 'idle' | 'syncing' | 'done' | 'error';
  message?: string;
};

export default function SecurityIntegration() {
  // Connection form state
  const [name, setName] = useState('');
  const [managementUrl, setManagementUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  // Loaded data
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [summary, setSummary] = useState<StatusSummary | null>(null);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  // UI state
  const [isLoading, setIsLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [syncState, setSyncState] = useState<SyncState>({ status: 'idle' });
  const [siteMapSaving, setSiteMapSaving] = useState<Record<string, boolean>>({});

  const fetchIntegration = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/s1/integration');
      if (!res.ok) return;
      const json = await res.json();
      const data = json.data as Integration | null;
      setIntegration(data);
      if (data) {
        setName(data.name);
        setManagementUrl(data.managementUrl);
        setApiToken(''); // Never expose token
      }
    } catch {
      // Integration not configured yet
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/s1/status');
      if (!res.ok) return;
      const json = await res.json();
      setSummary(json.summary as StatusSummary);
    } catch {
      // Status unavailable
    }
  }, []);

  const fetchSites = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/s1/sites');
      if (!res.ok) return;
      const json = await res.json();
      setSites(json.data as SiteRow[]);
      if (json.integrationId) setIntegrationId(json.integrationId);
    } catch {
      // Sites unavailable
    }
  }, []);

  const fetchOrgs = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/orgs/organizations');
      if (!res.ok) return;
      const json = await res.json();
      const list = (json.data ?? json) as Array<{ id: string; name: string }>;
      setOrgs(list.map((o) => ({ id: o.id, name: o.name })));
    } catch {
      // Orgs unavailable
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchSites(), fetchOrgs()]);
      setIsLoading(false);
    };
    load();
  }, [fetchIntegration, fetchStatus, fetchSites, fetchOrgs]);

  const handleSave = async () => {
    setSaveState({ status: 'saving' });
    try {
      const res = await fetchWithAuth('/s1/integration', {
        method: 'POST',
        body: JSON.stringify({
          name,
          managementUrl,
          apiToken,
          isActive: true
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveState({ status: 'error', message: json.error ?? 'Failed to save' });
        return;
      }
      setSaveState({ status: 'saved', message: json.warning ?? 'Integration saved' });
      setApiToken('');
      await fetchIntegration();
      await Promise.all([fetchStatus(), fetchSites()]);
    } catch (err) {
      setSaveState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleSync = async () => {
    setSyncState({ status: 'syncing' });
    try {
      const res = await fetchWithAuth('/s1/sync', {
        method: 'POST',
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const json = await res.json();
        setSyncState({ status: 'error', message: json.error ?? 'Sync failed' });
        return;
      }
      setSyncState({ status: 'done', message: 'Sync triggered' });
      // Refresh data after short delay for sync to start
      setTimeout(async () => {
        await fetchIntegration();
        await Promise.all([fetchStatus(), fetchSites()]);
      }, 3000);
    } catch (err) {
      setSyncState({ status: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  };

  const handleSiteMap = async (siteName: string, orgId: string | null) => {
    if (!integrationId) return;
    setSiteMapSaving((prev) => ({ ...prev, [siteName]: true }));
    try {
      const res = await fetchWithAuth('/s1/sites/map', {
        method: 'POST',
        body: JSON.stringify({ integrationId, siteName, orgId })
      });
      if (res.ok) {
        await fetchSites();
      }
    } catch {
      // Mapping failed silently — row will not update
    } finally {
      setSiteMapSaving((prev) => ({ ...prev, [siteName]: false }));
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const syncStatusBadge = () => {
    if (!integration) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
          <Unplug className="h-3.5 w-3.5" /> Not configured
        </span>
      );
    }
    if (integration.lastSyncStatus === 'success' || integration.lastSyncStatus === 'partial') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> Connected
        </span>
      );
    }
    if (integration.lastSyncStatus === 'running') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing
        </span>
      );
    }
    if (integration.lastSyncStatus === 'failed') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700">
          <AlertTriangle className="h-3.5 w-3.5" /> Error
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
        <Activity className="h-3.5 w-3.5" /> Pending
      </span>
    );
  };

  const canSave = name.trim().length > 0 && managementUrl.trim().length > 0 && (apiToken.trim().length > 0 || !!integration);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Shield className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">SentinelOne Integration</h1>
          <p className="text-sm text-muted-foreground">Connect your SentinelOne tenant for endpoint detection and response.</p>
        </div>
      </div>

      {/* Connection Setup */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Connection</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Enter your SentinelOne management console URL and API token.
          {!integration && ' Saving requires MFA verification.'}
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My S1 Tenant"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Management URL</label>
            <input
              type="url"
              value={managementUrl}
              onChange={(e) => setManagementUrl(e.target.value)}
              placeholder="https://your-tenant.sentinelone.net"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium">
              API Token
              {integration && <span className="ml-1 text-xs text-muted-foreground">(leave blank to keep existing)</span>}
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder={integration ? '••••••••••••••••' : 'Paste your API token'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || saveState.status === 'saving'}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saveState.status === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {integration ? 'Update' : 'Save & Connect'}
          </button>
          {saveState.status === 'saved' && (
            <span className="text-sm text-emerald-600">{saveState.message}</span>
          )}
          {saveState.status === 'error' && (
            <span className="text-sm text-red-600">{saveState.message}</span>
          )}
        </div>
      </div>

      {/* Status + Summary (only when integration exists) */}
      {integration && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          {/* Sync Status */}
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Sync Status</h2>
              {syncStatusBadge()}
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Last sync</span>
                <span className="text-foreground">
                  {integration.lastSyncAt
                    ? new Date(integration.lastSyncAt).toLocaleString()
                    : 'Never'}
                </span>
              </div>
              {integration.lastSyncError && (
                <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {integration.lastSyncError}
                </div>
              )}
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={handleSync}
                disabled={syncState.status === 'syncing'}
                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {syncState.status === 'syncing'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                Sync Now
              </button>
              {syncState.message && (
                <span className={`ml-3 text-xs ${syncState.status === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
                  {syncState.message}
                </span>
              )}
            </div>
          </div>

          {/* Coverage Summary */}
          {summary && (
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold">Coverage</h2>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-bold">{summary.totalAgents}</p>
                  <p className="text-xs text-muted-foreground">S1 Agents</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{summary.mappedDevices}</p>
                  <p className="text-xs text-muted-foreground">Mapped Devices</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${summary.infectedAgents > 0 ? 'text-red-600' : ''}`}>
                    {summary.infectedAgents}
                  </p>
                  <p className="text-xs text-muted-foreground">Infected</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${summary.activeThreats > 0 ? 'text-red-600' : ''}`}>
                    {summary.activeThreats}
                  </p>
                  <p className="text-xs text-muted-foreground">Active Threats</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{summary.pendingActions}</p>
                  <p className="text-xs text-muted-foreground">Pending Actions</p>
                </div>
                <div>
                  <p className={`text-2xl font-bold ${summary.highOrCriticalThreats > 0 ? 'text-amber-600' : ''}`}>
                    {summary.highOrCriticalThreats}
                  </p>
                  <p className="text-xs text-muted-foreground">High/Critical</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Site Mapping (only when sites exist) */}
      {integration && sites.length > 0 && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Site-to-Organization Mapping</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Map each SentinelOne site to a Breeze organization. Unmapped sites will inherit the integration's default org.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">S1 Site</th>
                  <th className="pb-2 pr-4 font-medium">Agents</th>
                  <th className="pb-2 pr-4 font-medium">Breeze Organization</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.siteName} className="border-b last:border-0">
                    <td className="py-3 pr-4 font-medium">{site.siteName}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{site.agentCount}</td>
                    <td className="py-3 pr-4">
                      <select
                        value={site.mappedOrgId ?? ''}
                        onChange={(e) => handleSiteMap(site.siteName, e.target.value || null)}
                        disabled={siteMapSaving[site.siteName]}
                        className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                      >
                        <option value="">— Select organization —</option>
                        {orgs.map((org) => (
                          <option key={org.id} value={org.id}>{org.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3">
                      {siteMapSaving[site.siteName] ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      ) : site.mappedOrgId ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/integrations/SecurityIntegration.tsx
git commit -m "feat(s1): add SecurityIntegration React component"
```

---

### Task 5: Create Astro page and wire up exports

**Files:**
- Create: `apps/web/src/pages/settings/integrations/security.astro`
- Modify: `apps/web/src/components/integrations/index.ts`

**Step 1: Create the Astro page**

Create `apps/web/src/pages/settings/integrations/security.astro`:

```astro
---
import DashboardLayout from '../../../layouts/DashboardLayout.astro';
import SecurityIntegration from '../../../components/integrations/SecurityIntegration';
---

<DashboardLayout title="Security Integrations">
  <SecurityIntegration client:load />
</DashboardLayout>
```

**Step 2: Add export to index.ts**

Add to `apps/web/src/components/integrations/index.ts`:

```typescript
export { default as SecurityIntegration } from './SecurityIntegration';
```

**Step 3: Commit**

```bash
git add apps/web/src/pages/settings/integrations/security.astro apps/web/src/components/integrations/index.ts
git commit -m "feat(s1): add security integrations Astro page and export"
```

---

### Task 6: Verify and test

**Step 1: Run TypeScript type check**

```bash
cd apps/web && pnpm tsc --noEmit
```

Expected: No type errors.

**Step 2: Run API tests**

```bash
cd apps/api && pnpm vitest run src/routes/sentinelOne
```

Expected: Existing tests pass.

**Step 3: Run full test suite**

```bash
pnpm --filter api exec vitest run
```

Expected: All tests pass.

**Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix(s1): address type/test issues in security integration UI"
```

---

### Summary of all files

**New files:**
- `apps/web/src/components/integrations/SecurityIntegration.tsx`
- `apps/web/src/pages/settings/integrations/security.astro`
- `apps/api/src/db/migrations/2026-02-27-s1-site-mappings.sql`

**Modified files:**
- `apps/api/src/db/schema/sentinelOne.ts` — add `s1SiteMappings` table
- `apps/api/src/routes/sentinelOne.ts` — add GET /sites, POST /sites/map
- `apps/web/src/components/integrations/IntegrationsPage.tsx` — add Security tab
- `apps/web/src/components/integrations/index.ts` — add export
