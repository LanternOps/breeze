# Tenant isolation reference

Use the private canonical methodology for evidence and authorized runtime stages.
Tenant hierarchy: Partner → Organization → Site → Device Group → Device. Enumerate
actual tables, policies, route middleware, tools, jobs, caches and storage at the
reviewed SHA. `auth.orgCondition()` is defense in depth; missing filtering alone is not
proof of a leak if effective RLS denies access, and presence alone does not prove safety.

## Database requirements

The API uses unprivileged `breeze_app`. Tenant-scoped tables require ENABLE and FORCE
RLS with policies shipped in the creating migration. Check six tenancy shapes in
project instructions: direct org, id-keyed org, partner-axis, dual-axis, device-id and
user-id. Check required allowlists and cross-axis FK integrity. Distinguish deliberately
system-scoped tables such as `device_commands` from accidentally unprotected data.

Trace `withDbAccessContext` and context cleanup. System context is legitimate for
background jobs, seeds and bounded bootstrap lookups. Verify trusted actor/tenant
resolution, narrow privilege, and `runOutsideDbContext` before system context when
inside a request. Check SECURITY DEFINER grants/search_path and bare-pool request
queries. Establish reachability and actual privileges before assigning impact.

## Coverage

- Reads/writes/deletes, list/count/search/export and nested/bulk IDs.
- Partner all/selected/none, cross-partner/org and same-org site/group restrictions.
- Dual-axis and indirect policies, USING/WITH CHECK and forged foreign references.
- Cached/object/event/job data and policy enforcement outside the database.
- Transfers, revocation, suspension/deletion, queue retries and stale approvals.
- Pool reuse and concurrent requests retaining another actor's context.

## Runtime proof

Use only the authorized isolated lab with synthetic tenants. Test as `breeze_app`,
with matching positive controls so a generally broken route is not mistaken for isolation.
Cross-tenant SELECT normally yields no rows; UPDATE/DELETE may affect zero rows;
forged INSERT or disallowed new row data must reject. Assert no leak/change and record
whether rejection came from RLS, another constraint or application validation. Test
API authorization separately from database invariants. Record exact SQL/request,
context, expected/actual result and fixed SHA; a coverage-contract pass proves neither
all policies' semantics nor protection of non-DB boundaries.
