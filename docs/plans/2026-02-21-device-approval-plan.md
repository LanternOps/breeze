# Device Approval & Network Awareness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the baseline-diff approach with an explicit device approval model — Assets tab shows all discovered devices with `pending | approved | dismissed` status, new devices trigger alerts, and a partner-level known guests whitelist auto-approves technician devices.

**Architecture:** `discoveredAssets` gains an `approvalStatus` column replacing the old `status` enum. Discovery scan completion triggers approval logic (check known guests → upsert asset → fire alert if pending). The Baselines tab is removed; alert settings move into Discovery Profile config.

**Tech Stack:** PostgreSQL + Drizzle ORM, Hono, BullMQ, React + Tailwind

**Design doc:** `docs/plans/2026-02-21-device-approval-design.md`

---

## Task 1: Database Migration

**Files:**
- Create: `apps/api/src/db/migrations/2026-02-21-device-approval.sql`
- Modify: `apps/api/src/db/schema/discovery.ts`

**Step 1: Write the migration SQL**

```sql
-- apps/api/src/db/migrations/2026-02-21-device-approval.sql

-- 1. New approval status enum
CREATE TYPE discovered_asset_approval_status AS ENUM ('pending', 'approved', 'dismissed');

-- 2. Add approval columns to discovered_assets
ALTER TABLE discovered_assets
  ADD COLUMN approval_status discovered_asset_approval_status NOT NULL DEFAULT 'pending',
  ADD COLUMN is_online boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN dismissed_by uuid REFERENCES users(id),
  ADD COLUMN dismissed_at timestamptz;

-- 3. Migrate existing status values
UPDATE discovered_assets SET approval_status = 'approved' WHERE status IN ('managed', 'identified');
UPDATE discovered_assets SET approval_status = 'dismissed', dismissed_at = ignored_at, dismissed_by = ignored_by WHERE status = 'ignored';
UPDATE discovered_assets SET is_online = false WHERE status = 'offline';
UPDATE discovered_assets SET is_online = true WHERE status NOT IN ('offline');
-- 'new' stays as 'pending' (default)

-- 4. Rename ignored_by/ignored_at to dismissed_by/dismissed_at
-- (data already migrated above, drop old columns)
ALTER TABLE discovered_assets DROP COLUMN ignored_by;
ALTER TABLE discovered_assets DROP COLUMN ignored_at;

-- 5. Drop old status enum column (keep enum type for now in case of rollback)
ALTER TABLE discovered_assets DROP COLUMN status;

-- 6. known_guests table
CREATE TABLE network_known_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  mac_address varchar(17) NOT NULL,
  label varchar(255) NOT NULL,
  notes text,
  added_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX network_known_guests_partner_mac_unique ON network_known_guests(partner_id, mac_address);
CREATE INDEX network_known_guests_partner_id_idx ON network_known_guests(partner_id);

-- 7. Add alert_settings to discovery_profiles
ALTER TABLE discovery_profiles
  ADD COLUMN alert_settings jsonb;

-- 8. Add profile_id to network_change_events (nullable, alongside existing baseline_id)
ALTER TABLE network_change_events
  ADD COLUMN profile_id uuid REFERENCES discovery_profiles(id) ON DELETE SET NULL;
CREATE INDEX network_change_events_profile_id_idx ON network_change_events(profile_id);
```

**Step 2: Run the migration**

```bash
cd /Users/toddhebebrand/breeze
DATABASE_URL=<your-url> npx tsx apps/api/src/db/migrations/run.ts
```

Expected: migration completes without errors.

**Step 3: Update the Drizzle schema**

In `apps/api/src/db/schema/discovery.ts`:

- Remove `discoveredAssetStatusEnum` definition and the `status` column from `discoveredAssets`
- Remove `ignoredBy` and `ignoredAt` columns
- Add the following:

```typescript
export const discoveredAssetApprovalStatusEnum = pgEnum('discovered_asset_approval_status', [
  'pending',
  'approved',
  'dismissed'
]);
```

Replace the `status`, `ignoredBy`, `ignoredAt` columns in `discoveredAssets` with:

```typescript
approvalStatus: discoveredAssetApprovalStatusEnum('approval_status').notNull().default('pending'),
isOnline: boolean('is_online').notNull().default(false),
approvedBy: uuid('approved_by').references(() => users.id),
approvedAt: timestamp('approved_at'),
dismissedBy: uuid('dismissed_by').references(() => users.id),
dismissedAt: timestamp('dismissed_at'),
```

Add the `networkKnownGuests` table:

```typescript
import { partners } from './orgs';

export const networkKnownGuests = pgTable('network_known_guests', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  macAddress: varchar('mac_address', { length: 17 }).notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  notes: text('notes'),
  addedBy: uuid('added_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerMacUnique: uniqueIndex('network_known_guests_partner_mac_unique').on(table.partnerId, table.macAddress),
  partnerIdIdx: index('network_known_guests_partner_id_idx').on(table.partnerId)
}));
```

Add `alertSettings` to `discoveryProfiles`:

```typescript
alertSettings: jsonb('alert_settings').$type<DiscoveryProfileAlertSettings>(),
```

Add `profileId` to `networkChangeEvents`:

```typescript
profileId: uuid('profile_id').references(() => discoveryProfiles.id),
```

Add the alert settings type (can go in `apps/api/src/db/schema/discovery.ts` or `packages/shared/src/types/`):

```typescript
export interface DiscoveryProfileAlertSettings {
  enabled: boolean;
  alertOnNew: boolean;
  alertOnDisappeared: boolean;
  alertOnChanged: boolean;
  changeRetentionDays: number;
}
```

Export `networkKnownGuests` and `DiscoveryProfileAlertSettings` from `apps/api/src/db/schema/index.ts`.

**Step 4: Verify TypeScript compiles**

```bash
cd /Users/toddhebebrand/breeze
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: no new errors related to `status`, `ignoredBy`, `ignoredAt`.

**Step 5: Commit**

```bash
git add apps/api/src/db/migrations/2026-02-21-device-approval.sql apps/api/src/db/schema/discovery.ts apps/api/src/db/schema/index.ts
git commit -m "feat: device approval schema — approvalStatus, isOnline, knownGuests, profileAlertSettings"
```

---

## Task 2: Known Guests API

**Files:**
- Create: `apps/api/src/routes/networkKnownGuests.ts`
- Create: `apps/api/src/routes/networkKnownGuests.test.ts`
- Modify: `apps/api/src/index.ts`

**Step 1: Write the failing tests**

```typescript
// apps/api/src/routes/networkKnownGuests.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = { select: vi.fn(), insert: vi.fn(), delete: vi.fn() };
vi.mock('../db', () => ({ db: mockDb }));

describe('GET /partner/known-guests', () => {
  it('returns 401 when not authenticated', async () => {
    // use testClient pattern from existing route tests
  });

  it('returns 403 when user has no partnerId', async () => {
    // auth present but no partner scope
  });

  it('returns list of known guests for authenticated partner', async () => {
    // mock db returning rows, expect mapped response
  });
});

describe('POST /partner/known-guests', () => {
  it('rejects invalid MAC address format', async () => {
    // body: { macAddress: 'not-a-mac', label: 'Test' }
    // expect 400
  });

  it('creates a known guest with normalized MAC', async () => {
    // body: { macAddress: 'AA:BB:CC:DD:EE:FF', label: 'Test laptop' }
    // expect 201, MAC stored as 'aa:bb:cc:dd:ee:ff'
  });

  it('returns 409 on duplicate MAC for same partner', async () => {
    // db throws unique violation
    // expect 409
  });
});

describe('DELETE /partner/known-guests/:id', () => {
  it('deletes guest belonging to authenticated partner', async () => {
    // expect 200
  });

  it('returns 404 when guest does not belong to partner', async () => {
    // expect 404
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd /Users/toddhebebrand/breeze
npx vitest run apps/api/src/routes/networkKnownGuests.test.ts
```

Expected: FAIL (file does not exist yet).

**Step 3: Implement the route**

```typescript
// apps/api/src/routes/networkKnownGuests.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { networkKnownGuests } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const networkKnownGuestsRoutes = new Hono();

networkKnownGuestsRoutes.use('*', authMiddleware);

const macRegex = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;

const createGuestSchema = z.object({
  macAddress: z.string().regex(macRegex, 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)'),
  label: z.string().min(1).max(255),
  notes: z.string().optional()
});

// GET /partner/known-guests
networkKnownGuestsRoutes.get('/', requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

  const guests = await db
    .select()
    .from(networkKnownGuests)
    .where(eq(networkKnownGuests.partnerId, auth.partnerId))
    .orderBy(networkKnownGuests.createdAt);

  return c.json({ data: guests });
});

// POST /partner/known-guests
networkKnownGuestsRoutes.post('/', requireScope('partner', 'system'), zValidator('json', createGuestSchema), async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

  const body = c.req.valid('json');
  const normalizedMac = body.macAddress.toLowerCase();

  try {
    const [guest] = await db
      .insert(networkKnownGuests)
      .values({
        partnerId: auth.partnerId,
        macAddress: normalizedMac,
        label: body.label,
        notes: body.notes ?? null,
        addedBy: auth.user?.id ?? null
      })
      .returning();

    return c.json({ data: guest }, 201);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('unique') || message.includes('duplicate')) {
      return c.json({ error: 'This MAC address is already in your known guests list' }, 409);
    }
    throw err;
  }
});

// DELETE /partner/known-guests/:id
networkKnownGuestsRoutes.delete('/:id', requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);

  const id = c.req.param('id');

  const deleted = await db
    .delete(networkKnownGuests)
    .where(and(
      eq(networkKnownGuests.id, id),
      eq(networkKnownGuests.partnerId, auth.partnerId)
    ))
    .returning({ id: networkKnownGuests.id });

  if (deleted.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});
```

**Step 4: Register route in `apps/api/src/index.ts`**

```typescript
import { networkKnownGuestsRoutes } from './routes/networkKnownGuests';
// ...
app.route('/api/partner/known-guests', networkKnownGuestsRoutes);
```

**Step 5: Run tests**

```bash
npx vitest run apps/api/src/routes/networkKnownGuests.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/routes/networkKnownGuests.ts apps/api/src/routes/networkKnownGuests.test.ts apps/api/src/index.ts
git commit -m "feat: known guests API — CRUD endpoints at /partner/known-guests"
```

---

## Task 3: Asset Approval API

**Files:**
- Modify: `apps/api/src/routes/discovery.ts`
- Modify: `apps/api/src/routes/discovery.test.ts`

**Step 1: Write failing tests for new endpoints**

Add to `apps/api/src/routes/discovery.test.ts`:

```typescript
describe('PATCH /discovery/assets/:id/approve', () => {
  it('sets approvalStatus to approved and records approvedBy/approvedAt', async () => {});
  it('returns 404 when asset not found for this org', async () => {});
});

describe('PATCH /discovery/assets/:id/dismiss', () => {
  it('sets approvalStatus to dismissed and records dismissedBy/dismissedAt', async () => {});
});

describe('POST /discovery/assets/bulk-approve', () => {
  it('approves multiple assets belonging to the org', async () => {});
  it('ignores asset IDs not belonging to the org', async () => {});
});

describe('POST /discovery/assets/bulk-dismiss', () => {
  it('dismisses multiple assets belonging to the org', async () => {});
});
```

**Step 2: Run to verify they fail**

```bash
npx vitest run apps/api/src/routes/discovery.test.ts
```

**Step 3: Update discovery routes**

In `apps/api/src/routes/discovery.ts`:

a) **Remove** the `/assets/:id/ignore` endpoint (lines around 689–730).

b) **Update** the `GET /assets` query — replace `status` filter param with `approvalStatus`:
```typescript
// Replace:
status: z.enum(['new', 'identified', 'managed', 'ignored', 'offline']).optional(),
// With:
approvalStatus: z.enum(['pending', 'approved', 'dismissed']).optional(),
```
Update the query's `.where()` to use `discoveredAssets.approvalStatus` instead of `discoveredAssets.status`.

c) **Add** approve endpoint:
```typescript
discoveryRoutes.patch('/assets/:id/approve', authMiddleware, requireScope('devices:write'), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const orgCond = auth.orgCondition(discoveredAssets.orgId);
  const conditions = [eq(discoveredAssets.id, id)];
  if (orgCond) conditions.push(orgCond);

  const updated = await db
    .update(discoveredAssets)
    .set({ approvalStatus: 'approved', approvedBy: auth.user?.id ?? null, approvedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: discoveredAssets.id });

  if (updated.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});
```

d) **Add** dismiss endpoint (same pattern, `approvalStatus: 'dismissed'`, `dismissedBy`, `dismissedAt`).

e) **Add** bulk-approve endpoint:
```typescript
const bulkApproveSchema = z.object({ assetIds: z.array(z.string().uuid()).min(1).max(200) });

discoveryRoutes.post('/assets/bulk-approve', authMiddleware, requireScope('devices:write'),
  zValidator('json', bulkApproveSchema), async (c) => {
    const auth = c.get('auth');
    const { assetIds } = c.req.valid('json');
    const orgCond = auth.orgCondition(discoveredAssets.orgId);
    const conditions: SQL[] = [inArray(discoveredAssets.id, assetIds)];
    if (orgCond) conditions.push(orgCond);

    const updated = await db
      .update(discoveredAssets)
      .set({ approvalStatus: 'approved', approvedBy: auth.user?.id ?? null, approvedAt: new Date() })
      .where(and(...conditions))
      .returning({ id: discoveredAssets.id });

    return c.json({ approvedCount: updated.length });
  });
```

f) **Add** bulk-dismiss (same pattern).

**Step 4: Update the profile PATCH to accept `alertSettings`**

Find the profile update route in `discovery.ts`. Add `alertSettings` to the update schema:

```typescript
const updateProfileSchema = z.object({
  // ... existing fields ...
  alertSettings: z.object({
    enabled: z.boolean(),
    alertOnNew: z.boolean(),
    alertOnDisappeared: z.boolean(),
    alertOnChanged: z.boolean(),
    changeRetentionDays: z.number().int().min(1).max(365)
  }).optional()
});
```

Include `alertSettings` in the `.set()` call when present.

**Step 5: Run tests**

```bash
npx vitest run apps/api/src/routes/discovery.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts
git commit -m "feat: asset approve/dismiss endpoints, remove ignore endpoint, profile alertSettings"
```

---

## Task 4: Discovery Worker — Approval Logic

**Files:**
- Modify: `apps/api/src/jobs/discoveryWorker.ts`
- Create: `apps/api/src/services/assetApproval.ts`
- Create: `apps/api/src/services/assetApproval.test.ts`
- Modify: `apps/api/src/jobs/networkBaselineWorker.ts`

**Step 1: Write failing tests for approval logic**

```typescript
// apps/api/src/services/assetApproval.test.ts
import { describe, it, expect, vi } from 'vitest';
import { normalizeMac, isKnownGuest, buildApprovalDecision } from './assetApproval';

describe('normalizeMac', () => {
  it('lowercases and trims', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
  });
  it('returns null for empty/null input', () => {
    expect(normalizeMac(null)).toBeNull();
    expect(normalizeMac('')).toBeNull();
  });
});

describe('buildApprovalDecision', () => {
  it('returns auto-approve for known guest MAC', () => {
    const decision = buildApprovalDecision({
      existingAsset: null,
      isKnownGuest: true,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('approved');
    expect(decision.shouldAlert).toBe(false);
  });

  it('returns pending + alert for new device when alertOnNew enabled', () => {
    const decision = buildApprovalDecision({
      existingAsset: null,
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('pending');
    expect(decision.shouldAlert).toBe(true);
    expect(decision.eventType).toBe('new_device');
  });

  it('returns no alert for new device when alertOnNew disabled', () => {
    const decision = buildApprovalDecision({
      existingAsset: null,
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: false, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90 }
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it('returns pending + alert when MAC changes on approved device', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'approved', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:02',
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: false, alertOnDisappeared: false, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.approvalStatus).toBe('pending');
    expect(decision.shouldAlert).toBe(true);
    expect(decision.eventType).toBe('device_changed');
  });

  it('does not alert for dismissed device that reappears', () => {
    const decision = buildApprovalDecision({
      existingAsset: { approvalStatus: 'dismissed', macAddress: 'aa:bb:cc:00:00:01' },
      incomingMac: 'aa:bb:cc:00:00:01',
      isKnownGuest: false,
      alertSettings: { enabled: true, alertOnNew: true, alertOnDisappeared: true, alertOnChanged: true, changeRetentionDays: 90 }
    });
    expect(decision.shouldAlert).toBe(false);
  });
});
```

**Step 2: Run to verify they fail**

```bash
npx vitest run apps/api/src/services/assetApproval.test.ts
```

Expected: FAIL (file does not exist).

**Step 3: Implement `assetApproval.ts`**

```typescript
// apps/api/src/services/assetApproval.ts
import type { DiscoveryProfileAlertSettings } from '../db/schema';

export function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const normalized = mac.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export interface ApprovalDecisionInput {
  existingAsset: { approvalStatus: string; macAddress?: string | null } | null;
  incomingMac?: string | null;
  isKnownGuest: boolean;
  alertSettings: DiscoveryProfileAlertSettings;
}

export interface ApprovalDecision {
  approvalStatus: 'pending' | 'approved' | 'dismissed';
  shouldAlert: boolean;
  eventType?: 'new_device' | 'device_changed' | 'device_disappeared';
  macChanged?: boolean;
}

export function buildApprovalDecision(input: ApprovalDecisionInput): ApprovalDecision {
  const { existingAsset, incomingMac, isKnownGuest, alertSettings } = input;

  // Known guest — always auto-approve, never alert
  if (isKnownGuest) {
    return { approvalStatus: 'approved', shouldAlert: false };
  }

  // New device
  if (!existingAsset) {
    const shouldAlert = alertSettings.enabled && alertSettings.alertOnNew;
    return { approvalStatus: 'pending', shouldAlert, eventType: shouldAlert ? 'new_device' : undefined };
  }

  // Dismissed device — no alert regardless of what changed
  if (existingAsset.approvalStatus === 'dismissed') {
    return { approvalStatus: 'dismissed', shouldAlert: false };
  }

  // MAC changed on known device
  const existingMac = normalizeMac(existingAsset.macAddress);
  const currentMac = normalizeMac(incomingMac);
  if (existingMac && currentMac && existingMac !== currentMac) {
    const shouldAlert = alertSettings.enabled && alertSettings.alertOnChanged;
    return {
      approvalStatus: 'pending',
      shouldAlert,
      eventType: shouldAlert ? 'device_changed' : undefined,
      macChanged: true
    };
  }

  // No change — preserve existing approval status
  return { approvalStatus: existingAsset.approvalStatus as 'pending' | 'approved' | 'dismissed', shouldAlert: false };
}
```

**Step 4: Run tests**

```bash
npx vitest run apps/api/src/services/assetApproval.test.ts
```

Expected: PASS.

**Step 5: Wire into discovery worker**

In `apps/api/src/jobs/discoveryWorker.ts`, update `handleProcessResults()`. After existing assets are upserted, add:

```typescript
import { normalizeMac, buildApprovalDecision } from '../services/assetApproval';
import { networkKnownGuests, discoveryProfiles } from '../db/schema';
import { inArray, eq } from 'drizzle-orm';

// Inside handleProcessResults, after writing discoveredAssets:

// Load profile alertSettings
const [profile] = await db
  .select({ alertSettings: discoveryProfiles.alertSettings })
  .from(discoveryProfiles)
  .where(eq(discoveryProfiles.id, job.data.profileId))
  .limit(1);

const alertSettings = profile?.alertSettings ?? {
  enabled: false, alertOnNew: false, alertOnDisappeared: false, alertOnChanged: false, changeRetentionDays: 90
};

if (!alertSettings.enabled) return; // No alerting configured for this profile

// Load known guests for this partner
const partnerKnownGuests = auth.partnerId
  ? await db
      .select({ macAddress: networkKnownGuests.macAddress })
      .from(networkKnownGuests)
      .where(eq(networkKnownGuests.partnerId, auth.partnerId))
  : [];

const knownGuestMacs = new Set(partnerKnownGuests.map(g => g.macAddress));

// Load existing assets for comparison
const scannedIps = hosts.map(h => h.ip).filter(Boolean);
const existingAssets = scannedIps.length > 0
  ? await db.select().from(discoveredAssets).where(
      and(eq(discoveredAssets.orgId, orgId), inArray(discoveredAssets.ipAddress, scannedIps))
    )
  : [];
const existingByIp = new Map(existingAssets.map(a => [a.ipAddress, a]));

// Process each host
for (const host of hosts) {
  if (!host.ip) continue;
  const existing = existingByIp.get(host.ip) ?? null;
  const guestMac = normalizeMac(host.mac);
  const isGuest = !!guestMac && knownGuestMacs.has(guestMac);

  const decision = buildApprovalDecision({
    existingAsset: existing ? { approvalStatus: existing.approvalStatus, macAddress: existing.macAddress } : null,
    incomingMac: host.mac,
    isKnownGuest: isGuest,
    alertSettings
  });

  // Update approvalStatus and isOnline
  await db.update(discoveredAssets)
    .set({ approvalStatus: decision.approvalStatus, isOnline: true, lastSeenAt: new Date() })
    .where(and(eq(discoveredAssets.orgId, orgId), eq(discoveredAssets.ipAddress, host.ip)));

  // Fire alert and log change event if needed
  if (decision.shouldAlert && decision.eventType) {
    await db.insert(networkChangeEvents).values({
      orgId,
      siteId: job.data.siteId,
      profileId: job.data.profileId,
      eventType: decision.eventType,
      ipAddress: host.ip,
      macAddress: host.mac ?? null,
      hostname: host.hostname ?? null,
      assetType: normalizeAssetType(host.assetType),
      previousState: existing ? { macAddress: existing.macAddress, hostname: existing.hostname } : null,
      currentState: { macAddress: host.mac, hostname: host.hostname, assetType: host.assetType }
    });
    // existing createNetworkChangeAlert helper handles alert creation
  }
}

// Mark approved assets not seen in this scan as offline
if (scannedIps.length > 0 && alertSettings.alertOnDisappeared) {
  const seenIps = new Set(hosts.map(h => h.ip));
  for (const asset of existingAssets) {
    if (!seenIps.has(asset.ipAddress) && asset.approvalStatus === 'approved' && asset.isOnline) {
      await db.update(discoveredAssets)
        .set({ isOnline: false })
        .where(eq(discoveredAssets.id, asset.id));
      // log device_disappeared change event
    }
  }
}
```

**Step 6: Add change event retention job**

In `apps/api/src/jobs/networkBaselineWorker.ts`, add a new job handler:

```typescript
// Add to job handler switch:
if (job.name === 'prune-change-events') {
  return handlePruneChangeEvents(job);
}

async function handlePruneChangeEvents(_job: Job) {
  // For each profile with alertSettings.changeRetentionDays configured:
  const profiles = await db
    .select({ id: discoveryProfiles.id, alertSettings: discoveryProfiles.alertSettings })
    .from(discoveryProfiles)
    .where(sql`${discoveryProfiles.alertSettings}->>'enabled' = 'true'`);

  for (const profile of profiles) {
    const days = profile.alertSettings?.changeRetentionDays ?? 90;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await db.delete(networkChangeEvents).where(
      and(
        eq(networkChangeEvents.profileId, profile.id),
        lt(networkChangeEvents.detectedAt, cutoff)
      )
    );
  }
}
```

Register the cron in `apps/api/src/index.ts`:

```typescript
await getNetworkBaselineQueue().add(
  'prune-change-events',
  {},
  { repeat: { pattern: '0 3 * * *' } } // 3am daily
);
```

**Step 7: Commit**

```bash
git add apps/api/src/services/assetApproval.ts apps/api/src/services/assetApproval.test.ts apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/networkBaselineWorker.ts
git commit -m "feat: asset approval logic in discovery worker, known guest check, change event retention"
```

---

## Task 5: Remove Baselines Tab

**Files:**
- Modify: `apps/web/src/components/discovery/DiscoveryPage.tsx`

**Step 1: Remove baselines from the tab list and imports**

In `DiscoveryPage.tsx`:

```typescript
// Change:
const DISCOVERY_TABS = ['profiles', 'jobs', 'assets', 'topology', 'baselines', 'changes'] as const;
// To:
const DISCOVERY_TABS = ['profiles', 'jobs', 'assets', 'topology', 'changes'] as const;
```

Remove from `tabLabels`:
```typescript
// Remove:
baselines: 'Baselines',
```

Remove the import:
```typescript
// Remove:
import NetworkBaselinesPanel from './NetworkBaselinesPanel';
```

Remove the render block:
```typescript
// Remove the entire block:
{activeTab === 'baselines' && (
  <NetworkBaselinesPanel ... />
)}
```

Remove `changesBaselineFilter` state and `handleNavigateToChanges` callback usage of baseline filter if it's only used for baselines (the Changes tab filter can default to showing all profiles).

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: no errors related to removed imports.

**Step 3: Commit**

```bash
git add apps/web/src/components/discovery/DiscoveryPage.tsx
git commit -m "feat: remove Baselines tab from Discovery page"
```

---

## Task 6: Assets Tab — Approval UI

**Files:**
- Modify: `apps/web/src/components/discovery/DiscoveredAssetList.tsx`
- Modify: `apps/web/src/components/discovery/DiscoveryPage.tsx`

**Step 1: Update the asset types and status config**

In `DiscoveredAssetList.tsx`:

```typescript
// Replace:
export type DiscoveredAssetStatus = 'new' | 'identified' | 'managed' | 'ignored' | 'offline';
// With:
export type DiscoveredAssetApprovalStatus = 'pending' | 'approved' | 'dismissed';
```

Replace `statusConfig` with approval-focused config:

```typescript
export const approvalStatusConfig: Record<DiscoveredAssetApprovalStatus, { label: string; color: string }> = {
  pending:   { label: 'Pending',   color: 'bg-amber-500/20 text-amber-700 border-amber-500/40' },
  approved:  { label: 'Approved',  color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  dismissed: { label: 'Dismissed', color: 'bg-muted text-muted-foreground border-muted' }
};
```

Update `DiscoveredAsset` type:
```typescript
type DiscoveredAsset = {
  // ... existing fields minus status ...
  approvalStatus: DiscoveredAssetApprovalStatus;
  isOnline: boolean;
};
```

Update `mapAsset()` to map `approvalStatus` and `isOnline` from API response.

**Step 2: Update filters and table UI**

Replace status filter dropdown:

```tsx
<select
  value={approvalFilter}
  onChange={e => setApprovalFilter(e.target.value)}
  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
>
  <option value="all">All statuses</option>
  <option value="pending">Pending</option>
  <option value="approved">Approved</option>
  <option value="dismissed">Dismissed</option>
</select>
```

Replace `Status` column header/cell with `Approval` column using `approvalStatusConfig`.

Add `Online` column (green/gray dot):
```tsx
<td className="px-4 py-3">
  <span className={`inline-block h-2 w-2 rounded-full ${asset.isOnline ? 'bg-green-500' : 'bg-muted-foreground/40'}`} title={asset.isOnline ? 'Online' : 'Offline'} />
</td>
```

Add row highlight for pending:
```tsx
<tr
  key={asset.id}
  className={`transition hover:bg-muted/40 ${asset.approvalStatus === 'pending' ? 'border-l-2 border-l-amber-400' : ''}`}
>
```

**Step 3: Replace row actions**

```tsx
// Replace Ignore/Delete buttons with:
{asset.approvalStatus !== 'approved' && (
  <button
    type="button"
    onClick={e => { e.stopPropagation(); handleApprove(asset); }}
    className="flex h-8 w-8 items-center justify-center rounded-md border border-green-500/40 text-green-700 hover:bg-green-500/10"
    title="Approve"
  >
    <CheckCircle2 className="h-4 w-4" />
  </button>
)}
{asset.approvalStatus !== 'dismissed' && (
  <button
    type="button"
    onClick={e => { e.stopPropagation(); handleDismiss(asset); }}
    className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
    title="Dismiss"
  >
    <XCircle className="h-4 w-4" />
  </button>
)}
```

Implement `handleApprove` and `handleDismiss`:

```typescript
const handleApprove = async (asset: DiscoveredAsset) => {
  await fetchWithAuth(`/discovery/assets/${asset.id}/approve`, { method: 'PATCH' });
  await fetchAssets();
};

const handleDismiss = async (asset: DiscoveredAsset) => {
  await fetchWithAuth(`/discovery/assets/${asset.id}/dismiss`, { method: 'PATCH' });
  await fetchAssets();
};
```

**Step 4: Bulk actions**

Replace bulk delete with bulk approve/dismiss:

```typescript
const handleBulkApprove = async () => {
  const ids = [...selectedAssetIds];
  if (ids.length === 0) return;
  await fetchWithAuth('/discovery/assets/bulk-approve', {
    method: 'POST',
    body: JSON.stringify({ assetIds: ids })
  });
  setSelectedAssetIds(new Set());
  await fetchAssets();
};
```

**Step 5: Pending badge on tab**

In `DiscoveryPage.tsx`, fetch pending count and display in tab label:

```typescript
const [pendingCount, setPendingCount] = useState(0);

// Fetch on mount and after approval actions:
const fetchPendingCount = useCallback(async () => {
  const response = await fetchWithAuth('/discovery/assets?approvalStatus=pending&limit=1');
  const data = await response.json().catch(() => null);
  setPendingCount(data?.total ?? 0);
}, []);
```

Update tab label:
```typescript
const tabLabels: Record<DiscoveryTab, string> = {
  // ...
  assets: pendingCount > 0 ? `Assets (${pendingCount})` : 'Assets',
  // ...
};
```

**Step 6: Commit**

```bash
git add apps/web/src/components/discovery/DiscoveredAssetList.tsx apps/web/src/components/discovery/DiscoveryPage.tsx
git commit -m "feat: asset approval UI — pending/approved/dismissed filter, approve/dismiss actions, pending badge"
```

---

## Task 7: Discovery Profile Form — Alert Settings

**Files:**
- Modify: `apps/web/src/components/discovery/DiscoveryProfileForm.tsx`
- Modify: `apps/web/src/components/discovery/DiscoveryPage.tsx`

**Step 1: Add `alertSettings` to form types**

In `DiscoveryProfileForm.tsx`, add to `DiscoveryProfileFormValues`:

```typescript
export type ProfileAlertSettings = {
  enabled: boolean;
  alertOnNew: boolean;
  alertOnDisappeared: boolean;
  alertOnChanged: boolean;
  changeRetentionDays: number;
};

// Add to DiscoveryProfileFormValues:
alertSettings: ProfileAlertSettings;
```

Default value:
```typescript
const defaultAlertSettings: ProfileAlertSettings = {
  enabled: false,
  alertOnNew: true,
  alertOnDisappeared: true,
  alertOnChanged: true,
  changeRetentionDays: 90
};
```

**Step 2: Add alert settings section to the form JSX**

Add after the schedule section:

```tsx
<div className="border-t pt-4">
  <h3 className="text-sm font-medium">Network Alerting</h3>
  <p className="text-xs text-muted-foreground mt-1">Alert when new or changed devices are detected on this subnet.</p>

  <label className="mt-3 flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      checked={formValues.alertSettings.enabled}
      onChange={e => setFormValues(prev => ({
        ...prev,
        alertSettings: { ...prev.alertSettings, enabled: e.target.checked }
      }))}
      className="h-4 w-4 rounded border"
    />
    Enable network alerting
  </label>

  {formValues.alertSettings.enabled && (
    <div className="mt-3 rounded-md border p-3 space-y-2 text-sm">
      {(['alertOnNew', 'alertOnDisappeared', 'alertOnChanged'] as const).map(key => (
        <label key={key} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={formValues.alertSettings[key]}
            onChange={e => setFormValues(prev => ({
              ...prev,
              alertSettings: { ...prev.alertSettings, [key]: e.target.checked }
            }))}
            className="h-4 w-4 rounded border"
          />
          {{ alertOnNew: 'New device detected', alertOnDisappeared: 'Device disappeared', alertOnChanged: 'Device MAC changed' }[key]}
        </label>
      ))}
      <div className="pt-1">
        <label className="block text-xs font-medium text-muted-foreground mb-1">Retain change log (days)</label>
        <input
          type="number"
          min={1}
          max={365}
          value={formValues.alertSettings.changeRetentionDays}
          onChange={e => setFormValues(prev => ({
            ...prev,
            alertSettings: { ...prev.alertSettings, changeRetentionDays: Number(e.target.value) || 90 }
          }))}
          className="h-9 w-32 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
    </div>
  )}
</div>
```

**Step 3: Pass alertSettings in submit handler in DiscoveryPage.tsx**

In `handleSubmitProfile`, include `alertSettings` in the payload:

```typescript
const payload = {
  // ... existing fields ...
  alertSettings: values.alertSettings
};
```

Also map `alertSettings` from API response back to form in `mapProfileToDisplay` / `scheduleToForm`.

**Step 4: Commit**

```bash
git add apps/web/src/components/discovery/DiscoveryProfileForm.tsx apps/web/src/components/discovery/DiscoveryPage.tsx
git commit -m "feat: alert settings section in discovery profile form"
```

---

## Task 8: Known Guests in Partner Settings

**Files:**
- Create: `apps/web/src/components/settings/KnownGuestsSettings.tsx`
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx`

**Step 1: Create KnownGuestsSettings component**

```tsx
// apps/web/src/components/settings/KnownGuestsSettings.tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type KnownGuest = {
  id: string;
  macAddress: string;
  label: string;
  notes: string | null;
  createdAt: string;
};

const macRegex = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

export default function KnownGuestsSettings() {
  const [guests, setGuests] = useState<KnownGuest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mac, setMac] = useState('');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchGuests = useCallback(async () => {
    setLoading(true);
    const response = await fetchWithAuth('/partner/known-guests');
    if (!response.ok) { setError('Failed to load known guests'); setLoading(false); return; }
    const data = await response.json();
    setGuests(data.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchGuests(); }, [fetchGuests]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!macRegex.test(mac)) { setError('Invalid MAC format (XX:XX:XX:XX:XX:XX)'); return; }
    if (!label.trim()) { setError('Label is required'); return; }
    setSaving(true);
    setError(null);
    const response = await fetchWithAuth('/partner/known-guests', {
      method: 'POST',
      body: JSON.stringify({ macAddress: mac, label: label.trim(), notes: notes.trim() || undefined })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(data?.error ?? 'Failed to add guest');
    } else {
      setMac(''); setLabel(''); setNotes('');
      await fetchGuests();
    }
    setSaving(false);
  };

  const handleRemove = async (id: string) => {
    const response = await fetchWithAuth(`/partner/known-guests/${id}`, { method: 'DELETE' });
    if (!response.ok) { setError('Failed to remove guest'); return; }
    await fetchGuests();
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold">Known Guests</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Devices on this whitelist are automatically approved across all your managed organizations.
        Use this for technician laptops or other known visitor devices.
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <form onSubmit={handleAdd} className="mt-4 flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="AA:BB:CC:DD:EE:FF"
          value={mac}
          onChange={e => setMac(e.target.value)}
          className="h-9 w-48 rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="text"
          placeholder="Label (e.g. John's laptop)"
          value={label}
          onChange={e => setLabel(e.target.value)}
          className="h-9 flex-1 min-w-48 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="text"
          placeholder="Notes (optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="h-9 flex-1 min-w-48 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </form>

      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">MAC Address</th>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">Loading...</td></tr>
            ) : guests.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">No known guests yet.</td></tr>
            ) : guests.map(guest => (
              <tr key={guest.id} className="hover:bg-muted/40">
                <td className="px-4 py-3 font-mono text-sm">{guest.macAddress}</td>
                <td className="px-4 py-3 text-sm">{guest.label}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{guest.notes ?? '—'}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleRemove(guest.id)}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 ml-auto"
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

**Step 2: Add to PartnerSettingsPage**

In `apps/web/src/components/settings/PartnerSettingsPage.tsx`, import and render `KnownGuestsSettings` below the existing settings card:

```tsx
import KnownGuestsSettings from './KnownGuestsSettings';

// At the end of the page's return JSX:
<KnownGuestsSettings />
```

**Step 3: Commit**

```bash
git add apps/web/src/components/settings/KnownGuestsSettings.tsx apps/web/src/components/settings/PartnerSettingsPage.tsx
git commit -m "feat: known guests whitelist in partner settings"
```

---

## Task 9: Update Changes Tab — Profile Filter

**Files:**
- Modify: `apps/web/src/components/discovery/NetworkChangesPanel.tsx`

**Step 1: Update baseline filter → profile filter**

The Changes panel currently filters by `baselineId`. Update to filter by `profileId`:

- Rename state `baselineId` → `profileId` in `FilterState`
- Fetch `discoveryProfiles` instead of `networkBaselines` for the filter dropdown
- Update filter label from "Baseline" to "Profile"
- Update API query param from `baselineId` to `profileId`
- Update `NetworkChangesPanel` props: `baselineFilterId` → `profileFilterId`
- Update `DiscoveryPage.tsx` to pass `profileFilterId` instead of `baselineFilterId`

**Step 2: Commit**

```bash
git add apps/web/src/components/discovery/NetworkChangesPanel.tsx apps/web/src/components/discovery/DiscoveryPage.tsx
git commit -m "feat: changes tab filters by profile instead of baseline"
```

---

## Final Verification

```bash
# TypeScript
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# Unit tests
npx vitest run apps/api/src/services/assetApproval.test.ts
npx vitest run apps/api/src/routes/networkKnownGuests.test.ts
npx vitest run apps/api/src/routes/discovery.test.ts
```

Manually verify:
- `/discovery` loads on Assets tab by default
- No Baselines tab visible
- Pending devices show amber highlight
- Approve/Dismiss buttons update status
- Bulk approve works
- Profile form shows alert settings section
- Partner Settings shows Known Guests table with add/remove
- Changes tab filter shows profiles, not baselines
