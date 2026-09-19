---
tracking_issue: LanternOps/breeze#5023
---
# Device Removal 05 — Single Permanent Delete Runs the Cascade in a System Context

> **For agentic workers:** Use superpowers:executing-plans. Small, single-PR.

**Goal:** `DELETE /devices/:id/permanent` cleans the same set of tables as bulk purge. Today the single route runs `purgeRemovedDevice` under the caller's tenant RLS context, and `services/deviceDeletion.ts` documents that at least one cascade table (`abuse_endpoint_fingerprints`) is invisible under tenant policy — so single purge strands rows that bulk purge (system context, `jobs/deviceBulkPurge.ts`) removes.

**Constraints:** Authorisation stays exactly where it is (`getDeviceWithOrgAndSiteCheck` + status pre-check BEFORE the escalation). The escalation is `runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, deviceId))))` — `runOutsideDbContext` first, because we are inside the request's `withDbAccessContext` transaction (CLAUDE.md; double-holding a pooled connection hangs at pool size). The `purgeRemovedDevice` lock + status re-check still runs (under system ctx the row is visible, so the `FOR UPDATE` actually holds — strictly better than today, where an RLS-filtered row silently locks nothing, per the deviceDeletion.ts comment). Keep the 23503/55P03 branches. Audit + cache invalidation unchanged.

**Tasks (TDD, one commit each):**
1. `cascadeDelete.test.ts` (behaviour half): assert `runOutsideDbContext` and `withSystemDbAccessContext` are each called once during a successful `DELETE /:id/permanent`, and NOT called when the pre-check 400s (non-removed) or the chokepoint 404s. Red → implement in `routes/devices/core.ts` → green. Also assert the ordering: the chokepoint select happens before `runOutsideDbContext`.
2. Doc comment on the route explaining the escalation and why it is safe (authorised first; matches bulk worker; the invisible-table note). Update the observation in `services/deviceDeletion.ts` header if it references "the route" running tenant-scoped.
3. Integration: extend `deviceLifecycle.integration.test.ts` with one case that inserts a row into a cascade table that is RLS-hidden from tenant context (pick the one named in `deviceDeletion.ts`; if it needs unusual fixtures, use any cascade table with an RLS policy and run the purge from an ORG-scoped `withDbAccessContext` to show the old behaviour left the row, then from the new route path to show it is gone). If constructing that proves >30 min, drop this task and say so in the PR body.
4. PR `fix(api): single permanent delete cascades in a system context like bulk purge (#2787 follow-up)`. Refs #5023. Stop at the PR.
