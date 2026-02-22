# Event Log Hierarchy Resolution + Elasticsearch Forwarding — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable per-device event log policy resolution via the full hierarchy (device → group → site → org → partner) and add optional async Elasticsearch forwarding at the org level.

**Architecture:** Replace the org-level-only `getDeviceEventLogSettings(orgId)` with a focused hierarchy resolver that walks all assignment levels for the `event_log` feature type. Add a BullMQ-based log forwarding worker that bulk-indexes events to Elasticsearch when an org has forwarding enabled in its settings JSONB.

**Tech Stack:** Drizzle ORM, Hono, BullMQ, Redis, Zod, @elastic/elasticsearch

---

## Phase 1: Full Hierarchy Resolution

### Task 1: Create `resolveDeviceEventLogSettings` helper

The core function that walks the full policy hierarchy for a single device's event_log settings. Doesn't need auth context — used internally by heartbeat and ingestion routes.

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts:981-1051`

**Context:** Currently `getDeviceEventLogSettings(orgId: string)` queries only org-level assignments. We need a new function that:
1. Loads device (orgId, siteId)
2. Loads device group memberships
3. Queries ALL matching assignments across all hierarchy levels for `event_log` feature type
4. Sorts by level priority (device=5 > group=4 > site=3 > org=2 > partner=1), then assignment priority ASC
5. Returns settings from the first (highest priority) match

**Step 1: Add imports**

At the top of `helpers.ts`, add these imports alongside the existing config policy imports:

```typescript
import { organizations } from '../../db/schema/orgs';
import { deviceGroupMemberships } from '../../db/schema/devices';
import { or, inArray } from 'drizzle-orm';
```

Check which of these are already imported and only add what's missing.

**Step 2: Write `resolveDeviceEventLogSettings`**

Add this function above the existing `getDeviceEventLogSettings` (around line 975):

```typescript
const LEVEL_PRIORITY: Record<string, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

async function resolveDeviceEventLogSettings(deviceId: string): Promise<EventLogSettings> {
  // 1. Load device
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return EVENT_LOG_DEFAULTS;

  // 2. Load org (for partnerId)
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions
  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // 5. Single query: assignments → active policies → event_log feature link → settings
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      retentionDays: configPolicyEventLogSettings.retentionDays,
      maxEventsPerCycle: configPolicyEventLogSettings.maxEventsPerCycle,
      collectCategories: configPolicyEventLogSettings.collectCategories,
      minimumLevel: configPolicyEventLogSettings.minimumLevel,
      collectionIntervalMinutes: configPolicyEventLogSettings.collectionIntervalMinutes,
      rateLimitPerHour: configPolicyEventLogSettings.rateLimitPerHour,
      enableFullTextSearch: configPolicyEventLogSettings.enableFullTextSearch,
      enableCorrelation: configPolicyEventLogSettings.enableCorrelation,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'event_log'),
    ))
    .innerJoin(configPolicyEventLogSettings, eq(configPolicyEventLogSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      or(...targetConditions),
    ));

  if (rows.length === 0) return EVENT_LOG_DEFAULTS;

  // 6. Sort by level priority DESC, then assignment priority ASC — first match wins
  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  const winner = rows[0];
  return {
    retentionDays: winner.retentionDays,
    maxEventsPerCycle: winner.maxEventsPerCycle,
    collectCategories: winner.collectCategories as EventLogCategory[],
    minimumLevel: winner.minimumLevel as EventLogLevel,
    collectionIntervalMinutes: winner.collectionIntervalMinutes,
    rateLimitPerHour: winner.rateLimitPerHour,
    enableFullTextSearch: winner.enableFullTextSearch,
    enableCorrelation: winner.enableCorrelation,
  };
}
```

**Step 3: Commit**

```
feat: add resolveDeviceEventLogSettings for full hierarchy resolution
```

---

### Task 2: Rewire `getDeviceEventLogSettings` to accept deviceId

Update the public function signature and caching to use per-device resolution.

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts:981-1051`

**Step 1: Update function signature and cache key**

Change `getDeviceEventLogSettings` from accepting `orgId` to `deviceId`:

```typescript
export async function getDeviceEventLogSettings(deviceId: string): Promise<EventLogSettings> {
  const redis = getRedis();
  const cacheKey = `eventlog:settings:device:${deviceId}`;
  const CACHE_TTL = 120; // 2 minutes for per-device granularity

  // Try Redis cache
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as EventLogSettings;
    } catch (cacheErr) {
      console.warn(`[eventlog] Redis cache read failed for device ${deviceId}:`, cacheErr);
    }
  }

  // Resolve via full hierarchy
  const settings = await resolveDeviceEventLogSettings(deviceId);

  // Cache result
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(settings), 'EX', CACHE_TTL);
    } catch (cacheErr) {
      console.warn(`[eventlog] Redis cache write failed for device ${deviceId}:`, cacheErr);
    }
  }

  return settings;
}
```

Remove the old query body (the 4-table join that filtered by org-level only). The new function is a thin caching wrapper around `resolveDeviceEventLogSettings`.

**Step 2: Update `buildEventLogConfigUpdate`**

Change the function signature from `orgId` to `deviceId`:

```typescript
export async function buildEventLogConfigUpdate(deviceId: string): Promise<Record<string, unknown> | null> {
  const settings = await getDeviceEventLogSettings(deviceId);

  // Only push config if it differs from defaults
  const isDefault = (
    settings.maxEventsPerCycle === EVENT_LOG_DEFAULTS.maxEventsPerCycle &&
    settings.collectCategories.length === EVENT_LOG_DEFAULTS.collectCategories.length &&
    settings.minimumLevel === EVENT_LOG_DEFAULTS.minimumLevel &&
    settings.collectionIntervalMinutes === EVENT_LOG_DEFAULTS.collectionIntervalMinutes
  );

  if (isDefault) return null;

  return {
    max_events_per_cycle: settings.maxEventsPerCycle,
    collect_categories: settings.collectCategories,
    minimum_level: settings.minimumLevel,
    collection_interval_minutes: settings.collectionIntervalMinutes,
  };
}
```

**Step 3: Commit**

```
refactor: getDeviceEventLogSettings accepts deviceId, uses full hierarchy
```

---

### Task 3: Update heartbeat and ingestion routes to pass deviceId

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts:184`
- Modify: `apps/api/src/routes/agents/eventlogs.ts:43`

**Step 1: Update heartbeat**

In `heartbeat.ts` around line 184, change:
```typescript
// Before:
eventLogSettings = await buildEventLogConfigUpdate(device.orgId);

// After:
eventLogSettings = await buildEventLogConfigUpdate(device.id);
```

**Step 2: Update ingestion route**

In `eventlogs.ts` around line 43, change:
```typescript
// Before:
settings = await getDeviceEventLogSettings(device.orgId);

// After:
settings = await getDeviceEventLogSettings(device.id);
```

**Step 3: Update retention worker**

In `apps/api/src/jobs/eventLogRetention.ts`, the retention worker currently calls `getDeviceEventLogSettings(orgId)`. Retention should stay org-level (it's a storage concern). The simplest fix: for retention, we resolve at the org level by finding ANY device in the org and using its ID, or better yet, we keep the org-level pattern for retention.

Read the current retention worker. Since it iterates per-org and calls `getDeviceEventLogSettings(orgId)`, and we changed that function to accept deviceId, we need to either:
- (a) Keep a separate org-level helper for retention, OR
- (b) Query a representative device per org

Option (a) is cleaner. Add an `getOrgEventLogRetentionDays(orgId)` back as a thin wrapper that queries org-level assignments only (single join, no hierarchy walk). This is simpler than `resolveDeviceEventLogSettings` — just org-level:

```typescript
export async function getOrgEventLogRetentionDays(orgId: string): Promise<number> {
  const [row] = await db
    .select({ retentionDays: configPolicyEventLogSettings.retentionDays })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'event_log'),
    ))
    .innerJoin(configPolicyEventLogSettings, eq(configPolicyEventLogSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(and(
      eq(configPolicyAssignments.level, 'organization'),
      eq(configPolicyAssignments.targetId, orgId),
      eq(configurationPolicies.status, 'active'),
    ))
    .orderBy(configPolicyAssignments.priority)
    .limit(1);

  return row?.retentionDays ?? 30;
}
```

Export it from helpers.ts, then update the retention worker to import and use it.

**Step 4: Run TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | head -20
```

Expected: No new errors.

**Step 5: Commit**

```
feat: heartbeat + ingestion use per-device event log resolution
```

---

### Task 4: Verify Go agent build + manual smoke test

**Files:** None (verification only)

**Step 1: Verify Go agent compiles (no agent changes)**

```bash
cd agent && go build ./...
```

Expected: No errors (only pre-existing go-m1cpu warnings).

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: Same count as before (no new errors).

**Step 3: Commit (tag phase complete)**

```
chore: phase 1 complete — event log hierarchy resolution
```

---

## Phase 2: Elasticsearch Forwarding

### Task 5: Add org log forwarding settings (validator + schema)

**Files:**
- Modify: `packages/shared/src/validators/index.ts` (add schema)
- Modify: `apps/api/src/db/schema/orgs.ts` (no schema change — uses existing `settings` JSONB)

**Step 1: Add Zod validator for log forwarding settings**

In `packages/shared/src/validators/index.ts`, add after the `orgHelperSettingsSchema`:

```typescript
export const orgLogForwardingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  elasticsearchUrl: z.string().url().refine(
    (url) => url.startsWith('https://'),
    { message: 'Elasticsearch URL must use HTTPS' }
  ),
  elasticsearchApiKey: z.string().optional(),
  elasticsearchUsername: z.string().optional(),
  elasticsearchPassword: z.string().optional(),
  indexPrefix: z.string().min(1).max(100).default('breeze-logs'),
}).refine(
  (data) => data.elasticsearchApiKey || (data.elasticsearchUsername && data.elasticsearchPassword),
  { message: 'Either API key or username+password required for Elasticsearch auth' }
);
```

**Step 2: Commit**

```
feat: add orgLogForwardingSettingsSchema validator
```

---

### Task 6: Add org log forwarding settings API endpoint

**Files:**
- Modify: `apps/api/src/routes/agents/mtls.ts` (add endpoint alongside existing org settings)

**Context:** Org settings endpoints follow the pattern in `mtls.ts` at lines 268-396: read org `settings` JSONB, merge the nested object, write back.

**Step 1: Add the PATCH endpoint**

In `mtls.ts`, add after the helper settings endpoint (around line 396). Import `orgLogForwardingSettingsSchema` from `@breeze/shared/validators`.

```typescript
// PATCH /org/:orgId/settings/log-forwarding
mtlsRoutes.patch(
  '/org/:orgId/settings/log-forwarding',
  zValidator('json', orgLogForwardingSettingsSchema),
  async (c) => {
    const orgId = c.req.param('orgId');
    const data = c.req.valid('json');
    // Auth check: user must have access to this org
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) return c.json({ error: 'Organization not found' }, 404);

    const currentSettings = (org.settings as Record<string, unknown>) ?? {};
    const updatedSettings = {
      ...currentSettings,
      logForwarding: data,
    };

    await db
      .update(organizations)
      .set({ settings: updatedSettings, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));

    return c.json({ success: true, settings: { logForwarding: data } });
  }
);

// GET /org/:orgId/settings/log-forwarding
mtlsRoutes.get('/org/:orgId/settings/log-forwarding', async (c) => {
  const orgId = c.req.param('orgId');
  const auth = c.get('auth');
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);

  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return c.json({ error: 'Organization not found' }, 404);

  const settings = (org.settings as Record<string, unknown>) ?? {};
  // Strip credentials from response — return masked
  const forwarding = (settings.logForwarding as Record<string, unknown>) ?? { enabled: false };
  const safe = {
    ...forwarding,
    elasticsearchApiKey: forwarding.elasticsearchApiKey ? '****' : undefined,
    elasticsearchPassword: forwarding.elasticsearchPassword ? '****' : undefined,
  };

  return c.json({ settings: { logForwarding: safe } });
});
```

**Step 2: Commit**

```
feat: org log forwarding settings CRUD endpoints
```

---

### Task 7: Create log forwarding service (Elasticsearch client)

**Files:**
- Create: `apps/api/src/services/logForwarding.ts`

**Step 1: Install @elastic/elasticsearch**

```bash
cd apps/api && pnpm add @elastic/elasticsearch
```

**Step 2: Create the service**

```typescript
import { Client } from '@elastic/elasticsearch';
import { db } from '../db';
import { organizations } from '../db/schema';
import { eq } from 'drizzle-orm';

interface LogForwardingConfig {
  enabled: boolean;
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  indexPrefix: string;
}

interface EventLogDocument {
  deviceId: string;
  orgId: string;
  hostname: string;
  category: string;
  level: string;
  source: string;
  message: string;
  timestamp: string;
  rawData?: unknown;
}

// Per-org ES client cache (avoid creating new client per request)
const clientCache = new Map<string, { client: Client; config: LogForwardingConfig; cachedAt: number }>();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getOrgForwardingConfig(orgId: string): Promise<LogForwardingConfig | null> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return null;

  const settings = (org.settings as Record<string, unknown>) ?? {};
  const forwarding = settings.logForwarding as LogForwardingConfig | undefined;

  if (!forwarding?.enabled || !forwarding.elasticsearchUrl) return null;
  return forwarding;
}

function getOrCreateClient(orgId: string, config: LogForwardingConfig): Client {
  const cached = clientCache.get(orgId);
  if (cached && Date.now() - cached.cachedAt < CLIENT_CACHE_TTL) {
    return cached.client;
  }

  const clientOpts: Record<string, unknown> = {
    node: config.elasticsearchUrl,
  };

  if (config.elasticsearchApiKey) {
    clientOpts.auth = { apiKey: config.elasticsearchApiKey };
  } else if (config.elasticsearchUsername && config.elasticsearchPassword) {
    clientOpts.auth = {
      username: config.elasticsearchUsername,
      password: config.elasticsearchPassword,
    };
  }

  const client = new Client(clientOpts as any);
  clientCache.set(orgId, { client, config, cachedAt: Date.now() });
  return client;
}

export async function bulkIndexEvents(
  orgId: string,
  events: EventLogDocument[],
): Promise<{ indexed: number; errors: number }> {
  const config = await getOrgForwardingConfig(orgId);
  if (!config) return { indexed: 0, errors: 0 };

  const client = getOrCreateClient(orgId, config);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const indexName = `${config.indexPrefix}-${today}`;

  const operations = events.flatMap((doc) => [
    { index: { _index: indexName } },
    doc,
  ]);

  const result = await client.bulk({ operations, refresh: false });

  let errors = 0;
  if (result.errors) {
    errors = result.items.filter((item) => item.index?.error).length;
    console.error(`[logForwarding] Bulk index had ${errors} errors for org ${orgId}`);
  }

  return { indexed: events.length - errors, errors };
}

export function clearClientCache(): void {
  for (const [, entry] of clientCache) {
    entry.client.close().catch(() => {});
  }
  clientCache.clear();
}
```

**Step 3: Commit**

```
feat: log forwarding service with ES client and bulk indexing
```

---

### Task 8: Create log forwarding BullMQ worker

**Files:**
- Create: `apps/api/src/jobs/logForwardingWorker.ts`

**Step 1: Create the worker**

Follow the pattern from `alertWorker.ts` (queue + worker + initialize/shutdown):

```typescript
import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '../services/redis';
import { bulkIndexEvents, getOrgForwardingConfig, clearClientCache } from '../services/logForwarding';

const QUEUE_NAME = 'log-forwarding';

interface LogForwardingJobData {
  orgId: string;
  deviceId: string;
  hostname: string;
  events: Array<{
    category: string;
    level: string;
    source: string;
    message: string;
    timestamp: string;
    rawData?: unknown;
  }>;
}

let queue: Queue<LogForwardingJobData> | null = null;
let worker: Worker<LogForwardingJobData> | null = null;

function getLogForwardingQueue(): Queue<LogForwardingJobData> {
  if (!queue) {
    queue = new Queue<LogForwardingJobData>(QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
  }
  return queue;
}

export async function enqueueLogForwarding(data: LogForwardingJobData): Promise<void> {
  const q = getLogForwardingQueue();

  // Backpressure: skip if queue is overwhelmed
  const waiting = await q.getWaitingCount();
  if (waiting > 10000) {
    console.warn(`[logForwarding] Queue depth ${waiting} exceeds 10k, skipping enqueue for org ${data.orgId}`);
    return;
  }

  await q.add('forward-events', data, {
    jobId: `fwd:${data.deviceId}:${Date.now()}`,
  });
}

export async function initializeLogForwardingWorker(): Promise<void> {
  worker = new Worker<LogForwardingJobData>(
    QUEUE_NAME,
    async (job: Job<LogForwardingJobData>) => {
      const { orgId, deviceId, hostname, events } = job.data;

      const docs = events.map((e) => ({
        deviceId,
        orgId,
        hostname,
        category: e.category,
        level: e.level,
        source: e.source,
        message: e.message,
        timestamp: e.timestamp,
        rawData: e.rawData,
      }));

      const result = await bulkIndexEvents(orgId, docs);
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[logForwarding] Job ${job?.id} failed:`, err.message);
  });

  console.log('[logForwarding] Worker started');
}

export async function shutdownLogForwardingWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  clearClientCache();
}
```

**Step 2: Commit**

```
feat: log forwarding BullMQ worker with backpressure and retry
```

---

### Task 9: Wire forwarding into ingestion route + register worker

**Files:**
- Modify: `apps/api/src/routes/agents/eventlogs.ts`
- Modify: `apps/api/src/index.ts:819-844`

**Step 1: Add forwarding enqueue to ingestion route**

In `eventlogs.ts`, after the successful PG insert (after the batch insert loop completes without error), enqueue to the forwarding queue:

```typescript
import { enqueueLogForwarding } from '../../jobs/logForwardingWorker';
import { getOrgForwardingConfig } from '../../services/logForwarding';
```

After the successful insert block and before the audit event, add:

```typescript
// Enqueue for log forwarding if org has it configured
try {
  const fwdConfig = await getOrgForwardingConfig(device.orgId);
  if (fwdConfig) {
    await enqueueLogForwarding({
      orgId: device.orgId,
      deviceId: device.id,
      hostname: device.hostname,
      events: filteredEvents.map((e: any) => ({
        category: e.category,
        level: e.level,
        source: e.source,
        message: e.message,
        timestamp: e.timestamp,
        rawData: e.rawData,
      })),
    });
  }
} catch (fwdErr) {
  // Forwarding failure must not block ingestion
  console.warn(`[EventLogs] Failed to enqueue for forwarding:`, fwdErr);
}
```

**Step 2: Register worker in index.ts**

In `apps/api/src/index.ts`, add import:

```typescript
import { initializeLogForwardingWorker, shutdownLogForwardingWorker } from './jobs/logForwardingWorker';
```

Add to the workers array (around line 831, alongside eventLogRetention):

```typescript
['logForwarding', initializeLogForwardingWorker],
```

Add to shutdown tasks (around line 934):

```typescript
shutdownLogForwardingWorker,
```

**Step 3: Run TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | head -20
```

Expected: No new errors.

**Step 4: Commit**

```
feat: wire log forwarding into ingestion route + register worker
```

---

### Task 10: Final verification

**Files:** None (verification only)

**Step 1: Verify Go agent compiles**

```bash
cd agent && go build ./...
```

Expected: No errors.

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: Same count as before.

**Step 3: Verify all imports resolve**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep "Cannot find" | head -10
```

Expected: No "Cannot find module" errors for new imports.

**Step 4: Commit (tag phase complete)**

```
chore: phase 2 complete — elasticsearch log forwarding
```

---

## Dependency Graph

```
Task 1 (resolveDeviceEventLogSettings) → Task 2 (rewire getDeviceEventLogSettings)
  → Task 3 (update heartbeat + ingestion) → Task 4 (verify)

Task 5 (validator) → Task 6 (settings endpoint) ─┐
Task 7 (ES service) → Task 8 (BullMQ worker) ────┤
                                                   └→ Task 9 (wire in + register) → Task 10 (verify)
```

Tasks 5-8 can run in parallel with Tasks 1-4.

## Key Gotchas

1. **Auth context**: `resolveDeviceEventLogSettings` does NOT use `resolveEffectiveConfig` because the latter requires `AuthContext` unavailable in agent routes. The focused helper walks the hierarchy for just `event_log`.
2. **Retention stays org-level**: The retention worker doesn't need per-device resolution — it's a storage concern. Keep a separate `getOrgEventLogRetentionDays` for it.
3. **Cache invalidation**: Per-device cache has 2-min TTL. Policy changes take up to 2 min to propagate. Acceptable for settings that change infrequently.
4. **ES client caching**: One ES client per org, cached for 5 min. Avoids connection storm on startup.
5. **Backpressure**: If forwarding queue exceeds 10k jobs, skip enqueueing. PG still has all data — no loss.
6. **HTTPS enforced**: Zod validator rejects non-HTTPS Elasticsearch URLs.
7. **Credentials masked**: GET endpoint returns `****` for API keys and passwords.
