# Org Access Migration Plan

## Overview

Migrate all API endpoints from requiring `orgId` query parameter to using auth context helpers that are pre-computed in middleware.

## Auth Context Helpers

Location: `apps/api/src/middleware/auth.ts`

```typescript
interface AuthContext {
  // ... existing fields ...

  accessibleOrgIds: string[] | null;  // null = system (all), [] = none, [...] = specific orgs

  orgCondition(orgIdColumn: PgColumn): SQL | undefined;  // Returns filter condition
  canAccessOrg(orgId: string): boolean;                   // Check specific org access
}
```

## Usage Pattern

### Listing Resources (GET endpoints)

```typescript
deviceRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  const conditions = [];

  // One line - handles all scopes automatically
  const orgFilter = auth.orgCondition(devices.orgId);
  if (orgFilter) conditions.push(orgFilter);

  // Optional: allow filtering to specific org
  if (query.orgId) {
    if (!auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied' }, 403);
    }
    conditions.push(eq(devices.orgId, query.orgId));
  }

  const data = await db.select().from(devices).where(and(...conditions));
});
```

### Creating Resources (POST endpoints)

```typescript
deviceRoutes.post('/', async (c) => {
  const auth = c.get('auth');
  const { orgId, ...data } = c.req.valid('json');

  // Validate org access
  if (!auth.canAccessOrg(orgId)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // Create resource
  await db.insert(devices).values({ orgId, ...data });
});
```

## Migration Status

### ✅ Complete
| File | Endpoint | Notes |
|------|----------|-------|
| `middleware/auth.ts` | - | Added `orgCondition` and `canAccessOrg` helpers |
| `devices.ts` | `GET /devices` | Example migration |

### 🔲 Priority 1: Dashboard Critical
| File | Endpoint | Notes |
|------|----------|-------|
| `alerts.ts` | `GET /alerts` | Called by dashboard |
| `alerts.ts` | `GET /alerts/rules` | |
| `orgs.ts` | `GET /orgs/sites` | Already partially fixed |
| `discovery.ts` | `GET /discovery/profiles` | Already partially fixed |

### 🔲 Priority 2: Common Operations
| File | Endpoints |
|------|-----------|
| `alerts.ts` | POST/PUT rules, channels, policies (POST `/alerts/channels` returns 400 without `orgId`; needs org handler) |
| `groups.ts` | CRUD operations |
| `scripts.ts` | CRUD operations |
| `webhooks.ts` | CRUD operations |
| `filters.ts` | CRUD operations |

### 🔲 Priority 3: Feature-Specific
| File | Endpoints |
|------|-----------|
| `analytics.ts` | dashboards, metrics |
| `automations.ts` | automations, policies |
| `deployments.ts` | deployments |
| `maintenance.ts` | windows |
| `patchPolicies.ts` | patch policies |
| `reports.ts` | reports |
| `policies.ts` | policies |
| `psa.ts` | PSA integration |

## Migration Checklist Per Route

For each route handler:

1. [ ] Replace scope-checking logic with `auth.orgCondition(table.orgId)`
2. [ ] Use `auth.canAccessOrg(orgId)` for validating specific org params
3. [ ] Remove "orgId is required" error returns
4. [ ] Make `orgId` optional in schemas if not already
5. [ ] Remove unused `organizations` table queries

## Before/After Example

### Before (35 lines)
```typescript
if (auth.scope === 'organization') {
  if (!auth.orgId) {
    return c.json({ error: 'Organization context required' }, 403);
  }
  conditions.push(eq(devices.orgId, auth.orgId));
} else if (auth.scope === 'partner') {
  if (query.orgId) {
    const hasAccess = await ensureOrgAccess(query.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    conditions.push(eq(devices.orgId, query.orgId));
  } else {
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId as string));

    const orgIds = partnerOrgs.map(o => o.id);
    if (orgIds.length === 0) {
      return c.json({ data: [], pagination: { page, limit, total: 0 } });
    }
    conditions.push(inArray(devices.orgId, orgIds));
  }
} else if (auth.scope === 'system' && query.orgId) {
  conditions.push(eq(devices.orgId, query.orgId));
}
```

### After (10 lines)
```typescript
const orgFilter = auth.orgCondition(devices.orgId);
if (orgFilter) {
  conditions.push(orgFilter);
}

if (query.orgId) {
  if (!auth.canAccessOrg(query.orgId)) {
    return c.json({ error: 'Access to this organization denied' }, 403);
  }
  conditions.push(eq(devices.orgId, query.orgId));
}
```

## Future: PostgreSQL RLS

Once stable, consider migrating to Row-Level Security:

```sql
CREATE POLICY org_access ON devices
  USING (org_id = ANY(current_setting('app.accessible_org_ids')::uuid[]));
```

Set the session variable in middleware before queries:
```typescript
await db.execute(sql`SET app.accessible_org_ids = ${auth.accessibleOrgIds}`);
```
