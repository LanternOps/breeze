# Multi-Tenant Isolation Reference

## Tenant Hierarchy

```
Partner (MSP)
  └── Organization (Customer)
       └── Site (Location)
            └── Device Group
                 └── Device
```

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/middleware/auth.ts` | `orgCondition()`, `accessibleOrgIds`, scope resolution |
| `apps/api/src/db/index.ts` | `withDbAccessContext()`, RLS context vars (`breeze.scope`, `breeze.org_id`, `breeze.accessible_org_ids`) |
| `apps/api/src/services/permissions.ts` | RBAC permission checks |
| All route files in `apps/api/src/routes/` | Must use `auth.orgCondition(table.orgId)` in every query |

## Correct Isolation Pattern

Every DB query on tenant-scoped data must include org filtering:

```typescript
// CORRECT: query-level filtering
const devices = await db.select().from(devicesTable)
  .where(and(
    auth.orgCondition(devicesTable.orgId),
    // ...other conditions
  ));
```

```typescript
// WRONG: fetch-then-filter (data leak risk)
const device = await db.select().from(devicesTable)
  .where(eq(devicesTable.id, deviceId));
// attacker can access any device by guessing ID
```

## Scope Types

| Scope | `accessibleOrgIds` | Behavior |
|-------|--------------------|----------|
| `system` | `null` | No org filter (admin access) |
| `partner` | Array from `partnerUsers.orgAccess` | Filtered to partner's orgs |
| `organization` | `[orgId]` | Single org only |

## Common Bypass Vectors to Check

1. **Missing org filter on lookup-by-ID**: `findById(id)` without org scoping — attacker enumerates IDs
2. **JOIN leaks**: Query joins tenant table A with shared table B, but B references other tenants
3. **Aggregation leaks**: `COUNT(*)` or `SUM()` without org filter exposes cross-tenant totals
4. **Bulk operations**: `DELETE FROM ... WHERE id IN (...)` without verifying each ID belongs to the org
5. **Nested resource access**: `/orgs/:orgId/sites/:siteId/devices/:deviceId` — must verify siteId belongs to orgId AND deviceId belongs to siteId
6. **System context escalation**: `withSystemDbAccessContext()` used outside bootstrap (enrollment/agent auth)
7. **Partner org leaks**: Partner with `orgAccess: 'selected'` accessing org not in their allowed list
8. **Cache poisoning**: Cached query results served to wrong tenant
9. **Export/report endpoints**: CSV/PDF exports without org scoping
10. **Search endpoints**: Full-text search returning results from other orgs

## Audit Procedure

1. **Grep for all DB queries**: Search `apps/api/src/routes/` for `db.select`, `db.update`, `db.delete`, `db.insert`
2. **For each query**: Verify `auth.orgCondition()` or equivalent org filter is present
3. **Check `withSystemDbAccessContext`**: Every usage must be justified (enrollment, internal lookups)
4. **Check route middleware**: Every route serving tenant data must have `authMiddleware` + appropriate scope
5. **Test cross-tenant access**: For each resource type, verify a user in Org A cannot access Org B's data by ID

## RLS is the source of truth — not `orgCondition` alone

The API connects to Postgres as the **unprivileged `breeze_app` role**, and every tenant-scoped table
must have **RLS enabled + forced + a policy**. `orgCondition()` is defense-in-depth; the question the
review must always answer is: **"Would RLS stop a forged cross-tenant write even if the app-layer
filter were missing or bypassed?"** Treat "the app layer checks it" as INSUFFICIENT.

**For every new/changed tenant-scoped table:**
- [ ] RLS `ENABLE` + `FORCE` + a policy shipped **in the same migration** that creates the table.
- [ ] The policy matches one of the **six tenancy shapes** (see CLAUDE.md): direct `org_id`,
      id-keyed, partner-axis (flat, never tree traversal), dual-axis (`users`), device-id scoped
      (hot tables denormalize `org_id`; cold tables use `EXISTS` join), user-id scoped.
- [ ] Added to the matching allowlist in `rls-coverage.integration.test.ts` (shapes 2–6).
- [ ] Anything system-scoped is explicitly flagged `INTENTIONAL_UNSCOPED` (e.g. `device_commands`).

**RLS-bypass findings are HIGH/CRITICAL:** a `SECURITY DEFINER` function, a `withSystemDbAccessContext`
call reachable from a request path, or a bare-pool query in request code can each defeat RLS.

**Prove it, don't assume it.** For any table/endpoint where isolation is unclear, write the concrete
forge and confirm it's rejected:

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
# attempt a cross-tenant INSERT/SELECT as breeze_app — MUST fail:
#   ERROR: new row violates row-level security policy for table "<table>"
```

A finding that "RLS would not stop this" should carry the exact statement that proves it.
