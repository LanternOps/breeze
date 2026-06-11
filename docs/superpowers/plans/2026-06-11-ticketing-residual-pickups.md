# Ticketing Residual Pickups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the smaller ticketing follow-ups left open after PR #1245 / #1238: the org-roles `organizations:read` grant, alert-link site-gating, the `devices(site_id)` index, device hard-delete ticket preservation, and three small UX items.

**Architecture:** Independent, individually shippable fixes. R1-R4 are API/data-safety; R5-R7 are web-only. No new tables; one permission-grant migration and one index migration.

**Tech Stack:** Hono + Drizzle (API), React islands (web), Vitest.

**Companion plan:** `docs/superpowers/plans/2026-06-11-ticketing-sla-engine.md` (Phase 2 main thread). These pickups are independent of it and can land before, after, or interleaved.

---

## Delegation matrix

| Task | Owner | Why |
|---|---|---|
| R1 organizations:read grant | Claude | authz change |
| R2 alert-link site gating | Claude | tenant/site isolation |
| R3 devices(site_id) index | **Codex (low)** | mechanical migration |
| R4 hard-delete detaches tickets | Claude | destructive-path semantics |
| R5 queue sort control | Claude (in-session) | UI |
| R6 sticky composer tab | Claude (in-session) | UI |
| R7 cross-tab bulk selection | Claude (in-session) | UI |

Codex template: see the SLA plan's "Codex invocation template" — identical, pointing at this file's task.

**PR grouping:** PR-1 = R1 (authz, reviewable alone). PR-2 = R2 + R4 (ticket data-safety/site-gating) + R3 riding along. PR-3 = R5-R7 (UX).

**Deferred (documented, not in this plan):** device-select searchable combobox (M), site-limited banner (M — needs an API surface exposing `allowedSiteIds`; JWT doesn't carry site ids), feed old→new values for field edits (M — `updateTicketFields` writes no oldValue/newValue), `GET /tickets/:id` alertLinks title redaction for out-of-site alerts (decide alongside a broader read-side redaction pass), "Breaching soon" empty state (covered by SLA plan UI work).

---

## Task R1: Grant `organizations:read` to org-scope system roles — **Claude**

> **SUPERSEDED during execution (2026-06-11).** The Step-1 blast-radius audit found `organizations:read` gates a wide dormant surface for org-scope users (full org rows incl. `ssoConfig`/`billingContact` JSONB on two list routes, raw integration settings, the AI route surface, enrollment-key short codes) — granting it to the three org roles would switch all of that on at once. Implemented instead as a route-level fix: `GET /orgs/organizations` lets org-scope callers read their OWN org as a projected `{id, name, slug, status}` row without the permission (inline `requireOrgReadUnlessOwnOrg` middleware, fail-closed); partner/system unchanged. No migration, no seed change, no role grants. If org roles ever do need `organizations:read`, the audit findings below must be addressed first (column projection / serializer on the org-row routes, decision per newly-opened surface).


The deep fix for the cold-load orgs 403: `GET /orgs/organizations` (orgs.ts:690) already supports org scope but is gated by `requirePermission('organizations','read')` (orgs.ts:28), which the seeded `Org Admin`/`Org Technician`/`Org Viewer` roles lack (`apps/api/src/db/seed.ts` SYSTEM_ROLES ~:161-240). PR #1245 shipped a client-side skip; this makes the permission real.

**Files:**
- Create: `apps/api/migrations/2026-06-12-b-org-roles-organizations-read.sql` (re-date to execution date)
- Modify: `apps/api/src/db/seed.ts` (the three org-scope SYSTEM_ROLES permission arrays)

- [ ] **Step 1: Audit the blast radius.** `requireOrgRead` also gates routes in `integrations.ts`, `networkKnownGuests.ts`, `psa.ts`, `patchPolicies.ts`, `apiKeys.ts`. List every `PERMISSIONS.ORGS_READ` call site (`grep -rn "ORGS_READ" apps/api/src/routes/`) and confirm each also carries a `requireScope`/partner guard that keeps org users out where intended. Record the list in the PR description. Also confirm the org-scope branch of `GET /organizations` (orgs.ts:701-705) returns only id/name-level fields. If anything looks newly exposed, stop and re-scope.

- [ ] **Step 2: Write the migration** (modeled on the role-grant block in `2026-06-09-a-native-ticketing-core.sql:163-180`, hardened with `is_system = true` — the report-permissions precedent omitted it and could hit same-named custom roles):

```sql
-- Org-scope system roles need organizations:read so org users can cold-load
-- GET /orgs/organizations (tickets org selector; residual from PR #1245).
-- The permission row ships in the baseline; grant only, no permission insert.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.resource = 'organizations' AND p.action = 'read'
WHERE r.name IN ('Org Admin', 'Org Technician', 'Org Viewer')
  AND r.is_system = true
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions x
    WHERE x.role_id = r.id AND x.permission_id = p.id
  );
```

Verify the `roles.is_system` column name against `apps/api/src/db/schema/users.ts:47` before committing (adjust to the actual column if it differs).

- [ ] **Step 3: Update `seed.ts`** — add `'organizations:read'` to the permission arrays of `Org Admin`, `Org Technician`, `Org Viewer` so fresh installs match migrated ones.

- [ ] **Step 4: Apply + verify locally**

```bash
# restart API to run autoMigrate, then:
docker exec -i breeze-postgres psql -U breeze -d breeze -c "
SELECT r.name FROM roles r
JOIN role_permissions rp ON rp.role_id = r.id
JOIN permissions p ON p.id = rp.permission_id
WHERE p.resource = 'organizations' AND p.action = 'read' AND r.name LIKE 'Org %';"
```

Expected: the three org roles. Re-run autoMigrate → no duplicate rows (NOT EXISTS guard). Then log in as an org-scope user and confirm `GET /orgs/organizations` returns 200 (permission cache refreshes within ≤5 min; bump the `permission-cache:version` Redis key for instant effect while testing).

- [ ] **Step 5: Leave the client-side skip in place** (`TicketsPage.tsx:62,123-125`, `CreateTicketPage.tsx:27-49`) — it becomes a harmless fast path; removing it is optional cleanup, not required.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-12-b-org-roles-organizations-read.sql apps/api/src/db/seed.ts
git commit -m "fix(rbac): grant organizations:read to org-scope system roles (#1245 residual)"
```

---

## Task R2: Site-gate the alert-link paths — **Claude**

A site-restricted org user can currently link/unlink alerts whose device is outside their sites, and create tickets from such alerts (the resulting ticket is then invisible to them). The ticket side is gated (`getScopedTicketOr404` → `deviceInSiteScope`); the alert side is org-checked only (`linkAlertToTicket` at ticketService.ts:571-583; `getAlertWithOrgCheck` in routes/alerts/helpers.ts:68).

**Files:**
- Create: `apps/api/src/routes/tickets/siteScope.ts` (extract `deviceInSiteScope` + `ticketSiteScopeCondition` from `tickets.ts:60-133` — they're module-private today and now needed by the alerts route)
- Modify: `apps/api/src/routes/tickets/tickets.ts` (import from `siteScope.ts`; gate POST `/:id/alerts` :520 and DELETE `/:id/alerts/:alertId` :547)
- Modify: `apps/api/src/routes/alerts/alerts.ts` (gate POST `/alerts/:id/create-ticket` :660-696)
- Test: `apps/api/src/routes/tickets/tickets.test.ts`, `apps/api/src/routes/alerts/alerts.test.ts` (or the alerts route test file's actual name)

- [ ] **Step 1: Write the failing tests**

```ts
// tickets.test.ts
it('POST /tickets/:id/alerts returns 404 when the alert device is outside the caller site scope', async () => {
  // auth: org-scope user with allowedSiteIds ['site-a']
  // alert row: deviceId belonging to 'site-b'
  // expect 404 { error: 'Alert not found' } and linkAlertToTicket NOT called
});
it('DELETE /tickets/:id/alerts/:alertId applies the same gate', async () => {});
it('alert links for in-site devices still work for restricted users', async () => {});

// alerts route test
it('POST /alerts/:id/create-ticket returns 404 for out-of-site alert devices', async () => {});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
cd apps/api && npx vitest run src/routes/tickets/tickets.test.ts src/routes/alerts/*.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

- [ ] **Step 3: Implement.**
  - Move `deviceInSiteScope(auth, deviceId)` and `ticketSiteScopeCondition(auth)` verbatim into `apps/api/src/routes/tickets/siteScope.ts`, export both, and re-import in `tickets.ts` (no behavior change — run the existing suite to prove it).
  - In both ticket alert-link handlers, after `getScopedTicketOr404` succeeds: load the alert's `deviceId` (single select on `alerts`), and if it has a device not in scope, return 404:

```ts
    const alertRows = await db.select({ deviceId: alerts.deviceId }).from(alerts).where(eq(alerts.id, alertId)).limit(1);
    const alertRow = alertRows[0];
    if (!alertRow) return c.json({ error: 'Alert not found' }, 404);
    if (alertRow.deviceId && !(await deviceInSiteScope(auth, alertRow.deviceId))) {
      // Out-of-site alerts are invisible, not forbidden — same shape as the ticket gate.
      return c.json({ error: 'Alert not found' }, 404);
    }
```

  - In `POST /alerts/:id/create-ticket`: after `getAlertWithOrgCheck`, apply the same `deviceInSiteScope` check on `alert.deviceId` before calling `createTicketFromAlert`.
  - Keep `linkAlertToTicket`'s same-org check unchanged (service stays site-agnostic; the route layer owns the site axis — matches the existing pattern where `tickets.ts` routes gate and the service guards org/partner only).

- [ ] **Step 4: Run — expect PASS** (both suites, plus the untouched alert-link happy-path tests).
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tickets/siteScope.ts apps/api/src/routes/tickets/tickets.ts apps/api/src/routes/alerts/alerts.ts apps/api/src/routes/tickets/tickets.test.ts apps/api/src/routes/alerts/
git commit -m "fix(tickets): site-gate alert link/unlink and create-from-alert (#1238 follow-up)"
```

---

## Task R3: `devices(site_id)` index — **Codex (low)**

No index exists on `devices.site_id` (FKs don't create indexes in PG; baseline has only management/mtls partials). Every site-restricted ticket query subqueries `devices.site_id`.

**Files:**
- Create: `apps/api/migrations/2026-06-12-c-devices-site-id-index.sql` (re-date at execution)
- Modify: `apps/api/src/db/schema/devices.ts` (:13-80 — add an extras block if drift check demands it)

- [ ] **Step 1: Write the migration**

```sql
-- Site-axis queries (ticket site scoping, site device lists) filter on
-- devices.site_id; the FK alone creates no index.
CREATE INDEX IF NOT EXISTS devices_site_id_idx ON devices (site_id);
```

- [ ] **Step 2: Apply locally** (restart API or apply manually), verify with `\di devices_site_id_idx`, re-apply to confirm no-op.

- [ ] **Step 3: Drift check** — `pnpm db:check-drift`. If the new index is flagged, add to the `devices` pgTable:

```ts
}, (table) => ({
  siteIdIdx: index('devices_site_id_idx').on(table.siteId)
}));
```

(plus the `index` import from `drizzle-orm/pg-core`). If not flagged, leave the schema untouched — match the repo's existing index-in-SQL-only convention for this table.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-06-12-c-devices-site-id-index.sql apps/api/src/db/schema/devices.ts
git commit -m "perf(devices): index devices.site_id for site-axis scoping queries"
```

---

## Task R4: Device hard-delete detaches tickets instead of cascading — **Claude**

`DELETE /devices/:id/permanent` lists `'tickets'` in `DEVICE_CASCADE_DELETE_TABLES` (routes/devices/core.ts:137-188), destroying ticket history — and it's actually broken today: tickets with comments hit the `ticket_comments.ticket_id` FK (no cascade) → 409. Tickets are business records; detach them (`device_id = NULL` is first-class — deviceless tickets already work).

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts` (cascade list :137-188, delete transaction :1214-1280)
- Test: `apps/api/src/routes/devices/cascadeDelete.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('hard delete detaches tickets (device_id -> NULL) instead of deleting them', async () => {
  // device with one ticket (with comments); run the permanent delete
  // expect UPDATE tickets SET device_id = NULL ... captured, no DELETE FROM tickets
  // expect 200 (previously this scenario 409'd on the ticket_comments FK)
});

// cascadeDelete.test.ts contract: every device_id-FK table must be in the
// cascade list — add an explicit DETACH exception set and assert membership
// of every device_id FK table in exactly one of the two sets.
it('tickets is in the detach set, not the cascade set', () => {
  expect(DEVICE_DETACH_DEVICE_ID_TABLES).toContain('tickets');
  expect(DEVICE_CASCADE_DELETE_TABLES).not.toContain('tickets');
});
```

- [ ] **Step 2: Run — expect FAIL:**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

- [ ] **Step 3: Implement.**
  - Remove `'tickets'` from `DEVICE_CASCADE_DELETE_TABLES`.
  - Add beside it: `export const DEVICE_DETACH_DEVICE_ID_TABLES = ['tickets'] as const;` with a comment: tickets are tenant business records — preserve history, detach the device.
  - In the delete transaction, next to the existing `DEVICE_LINKED_DEVICE_ID_TABLES` NULL-out loop (:1267-1269), add the detach loop:

```ts
      for (const table of DEVICE_DETACH_DEVICE_ID_TABLES) {
        await tx.execute(sql`UPDATE ${sql.raw(table)} SET device_id = NULL WHERE device_id = ${deviceId}`);
      }
```

  (Match the exact style of the adjacent linked-device loop — if it uses a different query helper, copy that.)
  - Update the contract test as in Step 1 so the "every device_id FK table is accounted for" invariant still holds across both lists.

- [ ] **Step 4: Run — expect PASS** (cascadeDelete + any devices core route tests).
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/cascadeDelete.test.ts
git commit -m "fix(devices): hard delete detaches tickets instead of destroying them (#1238 follow-up)"
```

---

## Task R5: Queue sort control — **Claude (in-session)**

The API already supports `?sort=triage|newest|oldest|due` (validator :77, orderBy tickets.ts:252-256). The queue UI never exposes it.

**Files:**
- Modify: `apps/web/src/components/tickets/TicketsPage.tsx` (params built ~:139)
- Test: `apps/web/src/components/tickets/TicketsPage.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it('sort select passes sort=newest to the API and persists in the location hash', async () => {
  // change the select to 'newest'; assert fetch URL contains 'sort=newest'
  // and window.location.hash reflects it (hash-based UI state per CLAUDE.md)
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Add a `sort` state (default `'triage'`), a small `<select data-testid="ticket-sort">` beside the existing filter controls with options Triage / Newest / Oldest / Due date, include it in the request params, and persist it in the hash alongside the existing tab state (follow the component's current hash pattern exactly).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketsPage.tsx apps/web/src/components/tickets/TicketsPage.test.tsx
git commit -m "feat(tickets/web): queue sort control (triage/newest/oldest/due)"
```

---

## Task R6: Sticky composer tab — **Claude (in-session)**

`TicketComposer`'s public/internal mode resets after send because `sendComment → load()` flips `TicketWorkbench` through its loading-skeleton branch (:166-170), unmounting the composer (mode state at TicketComposer.tsx:12).

**Files:**
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx` (:156-170)
- Test: `apps/web/src/components/tickets/TicketWorkbench.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it('keeps the composer mounted (and its internal-note tab selected) across a refresh after send', async () => {
  // select internal tab, send a comment (triggers reload)
  // assert the composer still shows the internal tab selected
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Distinguish initial load from refresh: render the loading skeleton only when `loading && !ticket` (first load); during refreshes keep the current tree mounted (optionally dim/disable via `aria-busy`). This keeps `TicketComposer` mounted so its mode state survives. Do not lift the mode state unless the mount fix proves insufficient.
- [ ] **Step 4: Run — expect PASS** (whole workbench suite — the skeleton-branch tests may need their setup adjusted to assert on first load only).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx
git commit -m "fix(tickets/web): composer tab no longer resets after sending (skeleton only on first load)"
```

---

## Task R7: Cross-tab bulk selection — **Claude (in-session)**

`bulkSelectedIds` is cleared on every tab/filter change (effect at TicketsPage.tsx:177-182). The backend `POST /tickets/bulk` takes raw ids and doesn't care about tabs.

**Files:**
- Modify: `apps/web/src/components/tickets/TicketsPage.tsx` (:82 state, :177-182 effect, :462-470 bulk bar)
- Test: `apps/web/src/components/tickets/TicketsPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps selections when switching tabs', async () => {
  // select 2 tickets on the open tab, switch to mine, assert bulk bar still shows '2 selected'
});
it('clears selections when filters change', async () => {
  // changing org/priority/search filters still clears (results genuinely change meaning)
});
it('bulk bar shows count and a clear button when selection spans hidden rows', async () => {});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Narrow the clearing effect's dependency list to the filter inputs only (org/priority/category/assignee/search), excluding the tab. Update the bulk bar to show `N selected` (count of all selected ids, not just visible ones) plus a `Clear` button (`data-testid="bulk-clear"`). Selected rows not in the current view stay selected silently — the count chip is the indicator.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tickets/TicketsPage.tsx apps/web/src/components/tickets/TicketsPage.test.tsx
git commit -m "feat(tickets/web): bulk selection survives tab switches"
```

---

## Verification

- [ ] Affected API suites single-fork (`tickets`, `alerts`, `devices` cascadeDelete, validators); web `src/components/tickets/`; `npx tsc --noEmit`.
- [ ] R1 live check: org-scope login → tickets page cold load shows the org name with no 403 in the network tab.
- [ ] R4 live check: hard-delete a dev device that has a commented ticket → 200, ticket survives deviceless.
- [ ] PRs per the grouping above; `superpowers:requesting-code-review` before each merge.
