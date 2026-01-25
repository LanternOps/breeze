# Org Access Migration Plan

## Overview

Migrate all API endpoints from requiring `orgId` query parameter to using `auth.accessibleOrgIds` which is pre-computed in the auth middleware.

## Implementation Complete

### Auth Context Now Includes `accessibleOrgIds`

Location: `apps/api/src/middleware/auth.ts`

```typescript
export interface AuthContext {
  // ... existing fields ...

  /**
   * Pre-computed list of org IDs this user can access.
   * - string[] = user can access these specific orgs (org or partner scope)
   * - null = user can access ALL orgs (system scope)
   */
  accessibleOrgIds: string[] | null;
}
```

Computed automatically in `authMiddleware` and `optionalAuthMiddleware`.

## Migration Pattern

### Before (Complex)
```typescript
// Each route had to do this logic:
if (auth.scope === 'organization') {
  if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
  orgId = auth.orgId;
} else if (auth.scope === 'partner') {
  if (!orgId) return c.json({ error: 'orgId is required for partner scope' }, 400);
  // verify access...
} else if (!orgId) {
  return c.json({ error: 'orgId is required' }, 400);
}
```

### After (Simple)
```typescript
import { inArray } from 'drizzle-orm';

// Route code is now trivial:
const conditions = [];

// Add org filter if user has limited access
if (auth.accessibleOrgIds !== null) {
  if (auth.accessibleOrgIds.length === 0) {
    return c.json({ data: [] }); // User has no orgs
  }
  conditions.push(inArray(table.orgId, auth.accessibleOrgIds));
}
// null means system scope - no org filter needed

// Optional: allow filtering to specific org via query param
if (query.orgId) {
  if (auth.accessibleOrgIds && !auth.accessibleOrgIds.includes(query.orgId)) {
    return c.json({ error: 'Access denied' }, 403);
  }
  conditions.push(eq(table.orgId, query.orgId));
}

const data = await db.select().from(table).where(and(...conditions));
```

## Files to Update

### Priority 1: Dashboard Critical
| File | Endpoint | Status |
|------|----------|--------|
| `devices.ts` | `GET /devices` | 🔲 Update |
| `alerts.ts` | `GET /alerts` | 🔲 Update |
| `orgs.ts` | `GET /orgs/sites` | 🔲 Update (already partially fixed) |

### Priority 2: Common Operations
| File | Endpoints |
|------|-----------|
| `alerts.ts` | rules, channels, policies |
| `groups.ts` | device groups |
| `scripts.ts` | scripts |
| `webhooks.ts` | webhooks |
| `filters.ts` | saved filters |

### Priority 3: Feature-Specific
| File | Endpoints |
|------|-----------|
| `analytics.ts` | dashboards, metrics |
| `automations.ts` | automations, policies |
| `deployments.ts` | deployments |
| `discovery.ts` | profiles, jobs |
| `maintenance.ts` | windows |
| `patchPolicies.ts` | patch policies |
| `reports.ts` | reports |

## Update Checklist Per File

For each file:

1. [ ] Add `inArray` to drizzle-orm imports
2. [ ] Make `orgId` optional in query schemas
3. [ ] Replace org access logic with `auth.accessibleOrgIds` check
4. [ ] Remove "orgId is required" error returns
5. [ ] Test with org, partner, and system scope users

## Example Migration: devices.ts

```typescript
// Before
if (auth.scope === 'organization') {
  if (!auth.orgId) {
    return c.json({ error: 'Organization context required' }, 403);
  }
  conditions.push(eq(devices.orgId, auth.orgId));
} else if (auth.scope === 'partner') {
  if (query.orgId) {
    // verify access...
    conditions.push(eq(devices.orgId, query.orgId));
  } else {
    const partnerOrgs = await db.select(...).from(organizations)...;
    conditions.push(inArray(devices.orgId, orgIds));
  }
}

// After
if (auth.accessibleOrgIds !== null) {
  if (auth.accessibleOrgIds.length === 0) {
    return c.json({ data: [], pagination: { page, limit, total: 0 } });
  }
  conditions.push(inArray(devices.orgId, auth.accessibleOrgIds));
}
```

## Future: PostgreSQL RLS

Once stable, consider migrating to Row-Level Security:

```sql
-- Example RLS policy
CREATE POLICY org_access ON devices
  USING (org_id = ANY(current_setting('app.accessible_org_ids')::uuid[]));
```

This would move the access control to the database level.
