---
issues: [LanternOps/breeze#12115, LanternOps/breeze#12116]
waves: [W1, W2]
status: draft (plan-drafted). Not yet registered as a feature; register at approval.
---

# Partner API: time-entry feed and device-patch list. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner service principal can read customer time entries (`time-entries:read`, #12115) and per-device patch state (`patches:read`, #12116) through `/api/v1/partner-api`, so integrators stop reading `time_entries`, `device_patches` and `patches` straight from the database.

**Architecture:** There are two waves, one endpoint family each, and each ships on its own.

- **W1, time entries.** This is a latest-state change feed on the tickets/alerts pattern. A `partner_feed_xid` column is stamped by a trigger, traversals are bounded by xid8, and tokens are `since`/`checkpoint`/`cursor`. A `/time-entries/ids` reconciliation list covers hard deletes and moves out of the org set.
- **W2, device patches.** This is a live-state keyset list on the `/device-status` pattern. It adds no change tracking and no trigger on the agent-written `device_patches` table. Consumers poll the filtered set.

Both run inside the GET partner-RLS context that `partnerApiAuthMiddleware` holds. Both add an opt-in read scope, and neither scope joins a preset or the Weavestream default.

**Tech Stack:** Hono + Zod, Drizzle on PostgreSQL (forced RLS, `breeze_app`), hand-written SQL migrations, Vitest (unit + `*.integration.test.ts`), React settings page + react-i18next (8 locales), Astro docs.

**Spec:** There is no separate spec doc. The requirements are the two issues plus the maintainer comments accepting them for planning. Executors read #12115, #12116 and this plan. Each Open Decision below states the default this plan builds.

## Global Constraints

- Base path `/api/v1/partner-api`, envelope `schemaVersion: '1'`, page size `limit` default 100 and max 500 (`PARTNER_EXPORT_DEFAULT_LIMIT` / `PARTNER_EXPORT_MAX_LIMIT`).
- Compatibility rule (`apps/docs/src/content/docs/reference/api.mdx` § Schema versioning): within one `schemaVersion` changes are additive only. Fields left out now can be added later. Removing or renaming a field later needs a version bump, so leave out anything uncertain.
- No hourly rate, currency, billing profile, contract line, approval request, site, or technician/user identity in the time-entry DTO (#12115: "Hourly rates can stay out of this scope").
- `patches` is a global, un-tenanted table with no RLS. Read it only joined through an in-scope `device_patches` row (`services/patchSeverityOverlay.ts` header).
- `time_entries` RLS is partner-axis only (`breeze_has_partner_access(partner_id)`, `migrations/2026-06-12-a-ticketing-time-parts.sql:55-63`). The explicit `org_id IN (principal.accessibleOrgIds)` predicate is therefore the org boundary inside a partner, not defence in depth. Every time-entry query carries it.
- Migrations go in `apps/api/migrations/`. Name each one to sort after the newest committed migration: at plan time that is `2027-01-27-150000-export-dataset-alert-index.sql`, but re-check with `ls apps/api/migrations | tail -3` before writing. Each must be idempotent, with no inner `BEGIN/COMMIT`. A `CREATE INDEX CONCURRENTLY` goes in its own `-- @no-transaction` file. Run `pnpm db:check-drift` afterwards.
- Never put a product name in the app UI (scope descriptions, presets).
- A new web locale key goes into all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`.
- The scope SQL allowlist (`breeze_valid_partner_service_principal_scopes`) must equal `PARTNER_SERVICE_PRINCIPAL_SCOPES` as an exact set. Each wave replaces the function in full. **W2 is written against a main that already contains W1**, so its ARRAY carries `time-entries:read` too.

## Open Decisions

Each one is numbered with a recommendation. The plan builds the recommendation; changing one changes the task named.

1. **Time-entry change tracking: `since`/`checkpoint` (xid8 feed) instead of `updatedSince`.**
   - **Recommend the xid8 feed.** An `updated_at > X` watermark skips any write that commits after a later one has been read. The material-change export avoids that with per-org advisory locks, and the tickets feed migration records why that protocol is unsafe on hot tables (the 2026-09-22 outage). `time_entries` is hot: timers, approvals, invoice issue/void and block closes all write to it.
   - The consumer persists an opaque `checkpoint` instead of a timestamp. The maintainer comment on #12115 promised `updatedSince`, so a correction is posted with this plan.
   - *Alternative:* `updatedSince` on the material-change lock protocol. Rejected because of the lock cost on a hot table.
   - The advisor quorum agreed. (Task W1.2)
2. **Hard deletes: a `/time-entries/ids` reconciliation list, not a delete log.** Entries are hard-deleted (`timeEntryService.ts` `deleteTimeEntry`, org/partner cascade). The ids list also covers entries moved out of the principal's org set. This follows the `/tickets/ids` precedent. Consumers prune only after a complete ids traversal. (W1.3)
3. **Entries with `org_id IS NULL` are never exported.** These are partner-internal labour and are not attributable to a customer. Org-attributed entries without a ticket *are* exported. Do not reuse `timeEntryService` `orgAxisSql`, which deliberately lets null-org rows through. (W1.2)
4. **Time-entry DTO.** The issue's fields, plus `coverage`, `billableMinutes`, `source`, `isApproved`, `createdAt`, `updatedAt`, `changeVersion` and `revision`. `ticket` and `workType` are nested labels.
   - **Recommend adding `coverage` + `billableMinutes`.** Without them a portal cannot separate included hours from billable hours, which is the requester's stated use. Neither carries a price.
   - Ticket `internalNumber` and work-type `name` are read-time labels. They are kept out of `revision`, following the `alerts.ts` hostname precedent. (W1.1)
5. **Delegation for `time-entries:read`.** The granter must hold `TIME_ENTRIES_READ` + `TICKETS_READ` + `TIME_ENTRIES_MANAGE_BILLING`.
   - The feed returns every technician's entries. The staff list shows non-admins only their own entries (`routes/timeEntries/timeEntries.ts:224-230`), and the billables CSV needs two grants and covers closed billable work only.
   - `manage_billing` is the existing grant for acting on everyone's billing state.
   - *Alternative:* the wildcard `*:*` (the `manageAll` test). That makes the scope admin-only.
   - *Inferred, not checked:* that `manage_billing` holders see other technicians' entries in the staff UI today. Confirm this in W1.1 before locking it in. (W1.1)
6. **A blocked description redacts the field, not the record.** If the secret scanner flags `description`, deliver the entry with `description: null, descriptionRedacted: true` instead of moving the whole record to `blocked`.
   - A blocked record means hours missing from an ERP total. The tickets/alerts precedent blocks the whole record, but there the lost data is text, not money.
   - *Alternative:* the precedent (whole record to `blocked`), with consumers told to reconcile `blocked` ids. (W1.2)
7. **ERP period close is out of scope for the feed.** The feed returns per-entry state (`billingStatus`, `coverage`, `billableMinutes`).
   - It does not reproduce the hour-pack allocation the portal computes (`services/portal/supportUsage.ts`, block windows and draws), nor invoice selection (`invoiceAssembly.ts`, keyed by `endedAt`).
   - The docs say so plainly and point ERP close at invoices. An hour-block draw/allocation export is a separate issue if the requester needs it. (W1.4)
8. **Device patches: a live-state list instead of a change feed.**
   - The ingest path (`routes/agents/patches.ts:390-439, 590-613`) rewrites `updated_at` on every reported row on every scan. The flip to `missing` and the device org-move cascade change rows without touching it. A trigger on `device_patches` would put feed cost on the agent hot path and restamp unchanged rows.
   - The requester's question ("what is pending now") is answered by a filtered snapshot.
   - The contract has no `since`/`updatedSince`: poll and replace per device. The advisor quorum agreed. (W2.2)
9. **OS-only selection uses `updateType` as well as `source`/`category`.** The requester excludes drivers and Defender definitions. A Windows driver can carry effective category `security` (`agent/internal/patching/category_test.go`), and Linux kernel packages are labelled `system`. Expose `device_patches.reported_update_type` as `updateType` (`driver|firmware|quality|feature|definition|other`, `null` from older agents) and offer it as a filter, with `unknown` matching `null`. Docs give the OS-only recipe: `source=microsoft,apple,linux&updateType=quality,feature,unknown`. (W2.1)
10. **Patch freshness is deferred.** `firstSeenAt` is the device↔patch association's `created_at`. It survives a return to pending, and it resets after a tombstone prune or an agent reinstall. Docs say so.
    - An empty pending list does not prove a recent scan. Each row's `lastCheckedAt` helps, but a device with zero rows has none.
    - **Recommend** documenting this now and deciding separately whether `/device-status` should carry `lastPatchScanAt` (additive).
11. **Wave order is W1 then W2**, as separate PRs and separate releases if needed. The fixed order exists only because both waves replace the scope-allowlist function. The parity test (`services/partnerServicePrincipalScopes.test.ts`) fails a W2 that drops `time-entries:read`.
12. **Out of scope: patch-compliance score source mixing (#12116 background).** "Low patch compliance" reads `security_posture_snapshots.patch_compliance_score` (`services/securityPosture.ts` `scorePatchCompliance`). That score is installed ÷ total over critical/important across **all** sources, and its denominator includes `missing`/`failed`/`skipped`. This endpoint does not change it. File a separate issue: source-filtered compliance, and whether tombstones belong in the denominator.

## Review Focus

1. **A principal with `orgAccess` limited to some orgs, inside a partner that has other orgs.** Time-entry RLS is partner-axis, so only the explicit org predicate hides sibling orgs' entries. Pinned by the W1.2 integration test `partner-scoped principal never sees a sibling org's time entries`.
2. **A time entry rewritten mid-traversal, or committed out of order** (a long transaction that commits after a later one has been read). It must appear on the next traversal, never be skipped. Pinned by the W1.2 integration test `never skips an entry whose transaction commits after a later one`.
3. **Billing-state flips that do not go through `timeEntryService`** (invoice issue/void, block close, approval hold, ticket move/merge raw UPDATEs). They must re-deliver the entry. The trigger stamps on any UPDATE, so one raw-SQL UPDATE in the W1.2 integration test covers the class: `re-delivers an entry updated by raw SQL`.
4. **A device moved to another org, and a Quick Support (ephemeral) device.** Their patch rows must follow the device's current org and never appear for an ephemeral device. Pinned by the W2.2 integration test `patch rows follow the device's current org and skip ephemeral devices`.
5. **A cursor replayed with changed filters, or by another partner.** It must get a 400, not silently cross filters. Pinned by unit tests in W1.2/W2.2: `rejects a cursor minted for other filters` and `rejects a cursor from another partner`.

---

## File Structure

| File | W | Responsibility |
|---|---|---|
| `packages/shared/src/constants/partnerServicePrincipalScopes.ts` (+ `.test.ts`) | 1, 2 | Add `time-entries:read`, `patches:read` to `PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES` with a why-comment. Presets unchanged |
| `apps/api/src/services/partnerServicePrincipalDelegation.ts` (+ `.test.ts`) | 1, 2 | Scope → staff permission mapping (OD 5; `patches:read` → `DEVICES_READ`) |
| `apps/api/src/services/partnerServicePrincipalScopes.test.ts` | 1, 2 | Opt-in assertion; SQL parity is automatic once the migration lands |
| `apps/api/migrations/<ts>-time-entries-partner-feed-xid.sql` | 1 | Column + stamp trigger |
| `apps/api/migrations/<ts+100>-time-entries-partner-feed-index.sql` | 1 | `-- @no-transaction` CONCURRENTLY `(partner_feed_xid, id)` + INVALID guard |
| `apps/api/migrations/<ts+200>-partner-api-time-entries-read-scope.sql` | 1 | Replace `breeze_valid_partner_service_principal_scopes` |
| `apps/api/migrations/<ts>-partner-api-patches-read-scope.sql` | 2 | Replace it again, ARRAY carries both new scopes |
| `apps/api/src/db/schema/timeTracking.ts` | 1 | `partnerFeedXid: xid8(...)` + index mirror (see `db/schema/alerts.ts:184,226`) |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | 1 | `time_entries` → add `partner_feed_xid` to `included` |
| `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` | 1 | Trigger-registry entry for the new trigger |
| `apps/api/src/routes/partnerApi/schemas.ts` (+ `schemas.test.ts`) | 1, 2 | Resources `time-entries`, `device-patches`; DTO/envelope schemas |
| `apps/api/src/routes/partnerApi/exportSafety.classification.ts` | 1, 2 | `RESOURCE_CLASSIFICATION` entries |
| `apps/api/src/routes/partnerApi/timeEntries.ts` (+ `.test.ts`) | 1 | `GET /time-entries`, `GET /time-entries/ids` |
| `apps/api/src/routes/partnerApi/devicePatches.ts` (+ `.test.ts`) | 2 | `GET /device-patches` |
| `apps/api/src/routes/partnerApi/cursor.ts` (+ `cursor.test.ts`) | 2 | Optional `filtersHash` on `PartnerExportCursorFilters` |
| `apps/api/src/routes/partnerApi/index.ts` | 1, 2 | Mount routes |
| `apps/api/src/routes/partnerApi/audit.test.ts` | 1, 2 | `it.each` over resources picks them up; fixture updates only |
| `apps/api/src/__tests__/integration/partnerApiTimeEntriesFeed.integration.test.ts` | 1 | Real-RLS feed tests |
| `apps/api/src/__tests__/integration/partnerApiDevicePatches.integration.test.ts` | 2 | Real-RLS list tests |
| `apps/api/src/__tests__/integration/partnerApiRls.integration.test.ts` | 1, 2 | `ALL_SCOPES`, fixtures, `EXPECTED_COUNTS` |
| `apps/api/src/__tests__/integration/partnerServicePrincipalRls.integration.test.ts` | 1, 2 | PostgreSQL accepts each scope |
| `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts` | 1, 2 | `SITE_SCOPE_INPUT_EXEMPT` entries (only if the scanner flags the handler) |
| `apps/api/src/__tests__/unassignedPoolVisibility.contract.test.ts` | 2 | `EPHEMERAL_ONLY` reason for `devicePatches.ts` |
| `apps/api/src/services/mcpCoverage.ts` | 1, 2 | `partner_api_surface` exemption per new route file |
| `apps/web/src/locales/*/settings.json` (8) | 1, 2 | `scopeDescriptions.time-entries_read`, `scopeDescriptions.patches_read` |
| `apps/web/src/components/settings/PartnerServicePrincipalsPage.test.tsx` | 1, 2 | Offered, not pre-checked |
| `docs/integrations/partner-api.md`, `apps/docs/.../reference/api.mdx`, `.../reference/api-keys.mdx` | 1, 2 | Scope table rows, endpoint rows, a feed section after "Device status feed" |

The scope picker (`PartnerServicePrincipalsPage.tsx`) iterates the shared registry and needs no code change. The Partner API is not in `apps/api/src/openapi.ts` (it is excluded at :25-26), so there is **no OpenAPI work**. The docs pages are the contract. Rate limits need no change: GETs share the key's hourly bucket (`partner_service_principal_keys.rate_limit`, default 600/h). Docs give the request cost (one request per page of ≤500).

---

## Wave W1: `time-entries:read` (#12115)

PR title: `feat(partner-api): time-entries:read feed (#12115)`. Body `Closes #12115`. Before writing the branch, post the OD 1 correction on #12115.

### Task W1.1: Scope, delegation, DB change tracking, DTO schema

**Files:** shared scopes (+test), delegation (+test), `partnerServicePrincipalScopes.test.ts`, three migrations, `timeTracking.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.integration.test.ts`, `schemas.ts` (+test), `exportSafety.classification.ts`, `partnerServicePrincipalRls.integration.test.ts`, 8 locale files, `PartnerServicePrincipalsPage.test.tsx`.

**Interfaces (produces):**
- Scope string `'time-entries:read'` in `PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES`.
- `PARTNER_SERVICE_PRINCIPAL_SCOPE_PERMISSIONS['time-entries:read'] = [TIME_ENTRIES_READ, TICKETS_READ, TIME_ENTRIES_MANAGE_BILLING]`.
- `timeEntries.partnerFeedXid` (xid8, NOT NULL, default `'1'::xid8`). Trigger `breeze_time_entries_partner_feed_xid` BEFORE INSERT OR UPDATE → `public.breeze_time_entries_stamp_partner_feed_xid()`, a copy of the tickets function. Index `idx_time_entries_partner_feed_xid (partner_feed_xid, id)`.
- `'time-entries'` in `PARTNER_EXPORT_RESOURCES`. Exported from `schemas.ts`:
  - `PARTNER_TIME_ENTRY_BILLING_STATUSES = ['not_billed','billed','no_charge','contract','awaiting_approval'] as const`
  - `PARTNER_TIME_ENTRY_COVERAGES = ['billable','included','non_billable'] as const`
  - `PARTNER_TIME_ENTRY_SOURCES` (re-export `TIME_ENTRY_SOURCES` from `@breeze/shared`)
  - `PARTNER_TIME_ENTRY_TEXT_MAX = 12_000`
  - `partnerTimeEntryExportRecordSchema`, `partnerTimeEntryFeedEnvelopeSchema`, `partnerTimeEntryIdListSchema`, types `PartnerTimeEntryExportRecord`.
- Record fields (strict):
  - `id, orgId`
  - `ticket: {id, internalNumber: string|null}|null`
  - `startedAt`, `endedAt|null`, `durationMinutes: int|null`
  - `isBillable`, `billingStatus`, `coverage|null`, `billableMinutes: int|null`
  - `workType: {id, name}|null`
  - `description|null`, `descriptionRedacted: boolean`
  - `source`, `isApproved`, `createdAt`, `updatedAt`
  - `changeVersion` (`/^[0-9]{1,20}$/`), `revision` (sha256 hex)
- Envelope: same shape and superRefine as `partnerTicketFeedEnvelopeSchema` (`mode`, `data ≤500`, `nextCursor`, `hasMore`, `checkpoint`, `blocked?`). No tombstone union.
- Classification: `'time-entries': { default: 'machine-observed', exceptions: { description: 'customer-authored', 'workType.name': 'customer-authored' } }`.

- [ ] **Step 1: Confirm OD 5's inferred premise.** Read `routes/timeEntries/*` and `services/timeEntryService.ts`, and check whether `time_entries:manage_billing` gives cross-technician visibility. If it does not, use the wildcard alternative and note it in the PR body.
- [ ] **Step 2: Failing tests.**
  - `partnerServicePrincipalScopes.test.ts`: `accepts time-entries:read as an explicit opt-in that never joins the default delegation`. Assert validation ok, `DEFAULT_WEAVESTREAM_…` does not contain it, and `hasPartnerServicePrincipalScope(['tickets:read'], 'time-entries:read') === false`.
  - Delegation test row: `['time-entries:read', ...]` requiring all three grants. A granter holding only `TIME_ENTRIES_READ` + `TICKETS_READ` gets 403.
  - `schemas.test.ts` resource list includes `'time-entries'`.
  - New `schemas.test.ts` case `time-entry record rejects rate/user/currency keys`: for each of `hourlyRate, userId, currencyCode, billingProfileId, contractLineId, siteId`, `safeParse({...valid, [k]: x}).success === false`.
  - `dtoSafety.test.ts`: add a `time-entries` field-shape snapshot case.
  - `PartnerServicePrincipalsPage.test.tsx`: `scope-checkbox-time-entries:read` present and not checked.
- [ ] **Step 3: Run them and see them fail.** `pnpm --filter @breeze/api exec vitest run src/services/partnerServicePrincipalScopes.test.ts src/services/partnerServicePrincipalDelegation.test.ts src/routes/partnerApi/schemas.test.ts src/routes/partnerApi/dtoSafety.test.ts` and `pnpm --filter @breeze/web exec vitest run src/components/settings/PartnerServicePrincipalsPage.test.tsx`. Expected: FAIL on the missing scope/resource. (Scoped-run rules: `docs/agents/testing.md`.)
- [ ] **Step 4: Implement the registry, delegation, schemas, classification and locale strings.** The en string is "Read time entries (duration, billing status, coverage, description) in the organizations this principal can reach. No rates or technician identity." Translate it for the other 7 locales.
- [ ] **Step 5: Write the three migrations.**
  - The xid migration copies the tickets one (`2026-12-13-120000`) with the comment-restamp half removed. The header explains why the feed is not on the lock protocol and lists the non-service writers it covers (invoice issue/void, block close, approval hold, ticket move/merge, device move, org merge).
  - The index migration copies `2026-12-13-120100`.
  - The scope migration copies `2027-01-12-400000` with `'time-entries:read'` added after `'device-status:read'`.
  - Add the Drizzle column and index, the export-policy `included` entry and the org-merge trigger-registry entry ("only stamps partner_feed_xid; never reads or reverts org_id").
- [ ] **Step 6: Run the unit tests again and see them pass.** Then run `pnpm db:migrate && pnpm db:check-drift` against a local stack and expect no drift. Then run the integration subset `partnerServicePrincipalRls`, `tenant-export-policy`, `orgMergeRegistry` (commands in `docs/agents/testing.md`). Add a case first: `accepts the opt-in time-entries:read scope in PostgreSQL`.
- [ ] **Step 7: Commit** `feat(partner-api): time-entries:read scope + time_entries feed xid (#12115)`.

### Task W1.2: `GET /time-entries` feed

**Files:** create `routes/partnerApi/timeEntries.ts` and `timeEntries.test.ts`; modify `index.ts`, `mcpCoverage.ts` and `site-scope-coverage.integration.test.ts` (if flagged); create `__tests__/integration/partnerApiTimeEntriesFeed.integration.test.ts`; modify `partnerApiRls.integration.test.ts`.

**Interfaces:**
- Consumes the W1.1 schemas and `createPartnerFeedTokens` (`feedToken.ts`).
- Produces:
  - `export const partnerTimeEntryRoutes: Hono`
  - `export const PARTNER_TIME_ENTRIES_FEED_HMAC_DOMAIN = 'breeze-partner-time-entries-feed-v1'`
  - `export const timeEntriesFeedTokens` (error code `invalid_partner_time_entries_token`, resync code `partner_time_entries_resync_required`)
  - `export function toPartnerTimeEntryRecord(row: TimeEntryFeedRow): PartnerTimeEntryExportRecord`, which is pure.
- Query (strict): `orgId?: uuid`, `startedSince?: ISO-offset timestamp` (filters `started_at >= x`, for a current-period first sync), `since?`, `cursor?`, `limit?`. `since` and `cursor` together → 400 `invalid_partner_export_query`. A foreign `orgId` → 404 `partner_export_org_not_found`.
- SQL:
  - `time_entries` with `partner_id = principal.partnerId AND org_id IN (orgIds)`, the xid window `[lower, horizon)`, `(partner_feed_xid, id) > after`, ordered by `(partner_feed_xid, id)`, `LIMIT limit+1`.
  - LEFT JOIN `tickets ON tickets.id = te.ticket_id AND tickets.org_id = te.org_id`.
  - LEFT JOIN `work_types ON id = te.work_type_id AND partner_id = te.partner_id`.
  - The snapshot/epoch query is the tickets one, with `'public.time_entries'::regclass`.
  - Binding `filtersHash` covers `{orgId, startedSince}`, and `orgSetHash(orgIds)`.
- DTO: `description` truncated to `PARTNER_TIME_ENTRY_TEXT_MAX` (reuse the `truncateText` approach; lift it to a shared helper if this is its second copy). `revision` = `computePartnerExportRevision` of the record minus `ticket.internalNumber` and `workType.name` (alerts hostname precedent).
- Secret handling (OD 6): run `safelyExportDefinition` on the record. If it is unsafe and the only blocked paths are `description`, re-export with `description: null, descriptionRedacted: true`. If any other path is blocked, put the record in `blocked`.

- [ ] **Step 1: Failing unit tests** in `timeEntries.test.ts` (mock pattern: `tickets.test.ts`):
  - `401 without a key; 403 without time-entries:read; 200 with it`
  - `404 for an orgId outside the principal's set; 400 for since+cursor; 400 for an unknown query key`
  - `full sync returns mode full and a checkpoint on the last page; hasMore page returns nextCursor and null checkpoint`
  - `rejects a cursor minted for other filters` (cursor with `orgId=A` replayed with `orgId=B` → 400 `invalid_partner_time_entries_token`)
  - `rejects a cursor from another partner`
  - `a checkpoint beyond the current xmax yields 409 partner_time_entries_resync_required`
  - `a running timer exports endedAt null and durationMinutes null`
  - `a description that trips the secret scanner is redacted, the record still delivered` (`descriptionRedacted: true`, `durationMinutes` intact, `blocked` absent)
  - `revision does not change when only the ticket internalNumber or work type name changes`
  - `never emits hourlyRate, userId, currencyCode` (the envelope parses strictly, and a snapshot of `Object.keys(record)`)
- [ ] **Step 2: Run** `pnpm --filter @breeze/api exec vitest run src/routes/partnerApi/timeEntries.test.ts` and expect FAIL (module missing).
- [ ] **Step 3: Implement** the route, mount it in `index.ts` next to tickets with a one-line scope comment, and add the `mcpCoverage.ts` exemption.
- [ ] **Step 4: Run the unit tests** and expect PASS. Run `src/routes/partnerApi/audit.test.ts` too.
- [ ] **Step 5: Failing integration tests** (`partnerApiTimeEntriesFeed.integration.test.ts`, as `breeze_app` through the real router, modelled on `partnerApiTicketsFeed.integration.test.ts`):
  - `never skips an entry whose transaction commits after a later one`
  - `re-delivers an entry updated by raw SQL` (a `UPDATE time_entries SET billing_status='billed'` without touching `updated_at` → it appears after the prior checkpoint)
  - `partner-scoped principal never sees a sibling org's time entries` (principal with accessibleOrgIds `[A]`, same partner has org B with entries → only A)
  - `hides other partners' entries and null-org entries`
  - `an entry whose ticket moves to an org outside the set leaves the feed`
  - In `partnerApiRls.integration.test.ts`, add `'time-entries:read'` to `ALL_SCOPES`, a fixture entry per partner, and `EXPECTED_COUNTS['time-entries']`.
- [ ] **Step 6: Run them and see them fail, then implement any fixes and see them pass.** Command per `docs/agents/testing.md` (Integration Tests job).
- [ ] **Step 7: Commit** `feat(partner-api): GET /time-entries change feed (#12115)`.

### Task W1.3: `GET /time-entries/ids`

**Interfaces:**
- Response `partnerTimeEntryIdListSchema` `{schemaVersion, data: [{id, orgId, changeVersion}] ≤500, nextCursor, hasMore}`.
- Keyset token from `timeEntriesFeedTokens.encodeKeysetToken`, with `scopeHash = sha256(canonical {list:'time-entry-ids', orgId, orgSet})`.
- Register it **before** any `/time-entries/:id` route. W1 adds no by-id route.

- [ ] **Step 1: Failing unit tests.** `ids pages by id with a keyset cursor bound to orgId` and `rejects an ids cursor replayed with another orgId`. Add the integration case `a hard-deleted entry and a moved-out entry are absent from ids` to the W1.2 integration file.
- [ ] **Step 2: Run them and see them fail. Implement. Run them and see them pass.**
- [ ] **Step 3: Commit** `feat(partner-api): GET /time-entries/ids reconciliation list (#12115)`.

### Task W1.4: Docs

- [ ] **Step 1:** In `docs/integrations/partner-api.md`, add a scope table row and a section "Time entries feed" after "Device status feed". The section covers:
  - The polling contract: page with `cursor` until `hasMore` is false, persist `checkpoint` as `since`, and on 409 resync without `since`.
  - Deletes and moves: reconcile with `/time-entries/ids`, pruning only after a complete traversal.
  - That null-org entries are excluded.
  - `descriptionRedacted`.
  - Field semantics: `durationMinutes` vs `billableMinutes`, `coverage`, `billingStatus` values.
  - The OD 7 paragraph (period close comes from invoices, not this feed).
  - Request cost against the per-key hourly limit.
- [ ] **Step 2:** Add rows in `apps/docs/.../reference/api.mdx` (endpoints, after the device-status row) and `.../reference/api-keys.mdx` (scope table).
- [ ] **Step 3:** Run `pnpm --filter @breeze/docs build` (or the docs check CI runs) and expect success. **Commit** `docs(partner-api): time-entries:read (#12115)`.
- [ ] **Step 4:** Before the PR: run the full API unit suite, the Integration Tests for the touched suites (export policy, org merge, partnerApiRls, the new feed file) and web tests. Open the PR with `Closes #12115`.

---

## Wave W2: `patches:read` (#12116)

Start only after W1 is merged (OD 11). Rebase on main. PR title `feat(partner-api): patches:read device-patch list (#12116)`, body `Closes #12116`.

### Task W2.1: Scope, delegation, DTO schema, cursor filter binding

**Interfaces (produces):**
- `'patches:read'` in `PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES`. Delegation `[DEVICES_READ]`, matching `routes/devices/patches.ts`.
- Migration `<ts>-partner-api-patches-read-scope.sql`, whose ARRAY = W1's ARRAY + `'patches:read'`.
- `'device-patches'` in `PARTNER_EXPORT_RESOURCES`. Exported from `schemas.ts`:
  - `PARTNER_DEVICE_PATCH_STATUSES = ['pending','installed','failed','skipped'] as const` (never `missing`)
  - `PARTNER_PATCH_SOURCES = ['microsoft','apple','linux','third_party','custom'] as const`
  - `PARTNER_PATCH_SEVERITIES = ['critical','important','moderate','low','unknown'] as const`
  - `PARTNER_PATCH_UPDATE_TYPES = ['driver','firmware','quality','feature','definition','other'] as const`
  - `partnerDevicePatchRecordSchema`, `partnerDevicePatchEnvelopeSchema` (`{schemaVersion, data ≤500, nextCursor, hasMore, blocked?}`, same superRefine as device-status)
- Record fields (strict):
  - `id` (device_patches.id), `deviceId`, `orgId`, `siteId|null` (current device site)
  - `status`, `firstSeenAt` (= device_patches.created_at), `lastCheckedAt|null`, `installedAt|null`
  - `patch: { externalId, source, title, severity (effective), category (effective)|null, updateType|null, releaseDate|null, requiresReboot }`
- Excluded: `install_command`, `uninstall_command`, `detect_script`, `download_url`, `metadata`, `last_error`, `description`, `failure_count`, the shared `patches.id`.
- `cursor.ts`: `PartnerExportCursorFilters` gains `filtersHash?: string | null` (`/^[a-f0-9]{64}$/`), with the same "only this resource binds it; others omit the key so their cursors stay byte-identical" comment as `status`.
- Classification: `'device-patches': { default: 'machine-observed' }`.

- [ ] **Step 1: Failing tests.**
  - Scope opt-in test as in W1.1.
  - Delegation row `['patches:read', 'devices', 'read']`.
  - Resource list.
  - `cursor.test.ts`: `a cursor without filtersHash is byte-identical to one minted before the key existed` and `decode rejects a filtersHash mismatch`.
  - `schemas.test.ts`: `device-patch record rejects install_command, detect_script, last_error, metadata` and `status enum excludes missing`.
  - dtoSafety snapshot.
  - Web checkbox offered and not checked.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement**, including 8 locale strings. en: "Read pending and installed patches per device (source, category, update type, severity) in the organizations this principal can reach." Then `pnpm db:check-drift` and the `partnerServicePrincipalRls` integration case `accepts the opt-in patches:read scope in PostgreSQL`.
- [ ] **Step 4: Run the tests and see them pass. Commit** `feat(partner-api): patches:read scope (#12116)`.

### Task W2.2: `GET /device-patches`

**Interfaces:**
- Produces `export const partnerDevicePatchRoutes: Hono` (resource `'device-patches'`, cursor lifetime 24h like device-status).
- Query (strict): `orgId?`, `siteId?`, `deviceId?` (uuid), `status?` csv of `PARTNER_DEVICE_PATCH_STATUSES` (default all four), `source?` csv, `severity?` csv, `updateType?` csv of `PARTNER_PATCH_UPDATE_TYPES ∪ {'unknown'}` (`unknown` ⇒ `IS NULL`), `category?` csv of free strings (≤20 items, each ≤100 chars, exact match on effective category), `cursor?`, `limit?`. Reuse the `csvEnum` helper (lift it from tickets/alerts into a shared `queryParams.ts` if this is its third copy).
- `filtersHash = sha256Hex(canonicalJsonStringify({deviceId, status, source, severity, updateType, category}))` over the normalized sorted lists, bound together with `orgId`/`siteId` in the cursor.
- SQL:
  - `device_patches dp JOIN devices d ON d.id = dp.device_id AND d.org_id = dp.org_id JOIN patches p ON p.id = dp.patch_id`
  - WHERE `d.org_id IN (orgIds)`, `d.is_ephemeral = false`, `dp.status <> 'missing'`, `dp.created_at <= startedAt` (membership bound, device-status precedent), the filters, `dp.id > lastId`
  - ORDER BY `dp.id`, `LIMIT limit+1`
  - Effective severity/category via `EFFECTIVE_PATCH_SEVERITY_SQL` / `EFFECTIVE_PATCH_CATEGORY_SQL`, and the same fragments in the WHERE for the `severity`/`category` filters. Reference query: `services/aiToolsExportDatasets/patches.ts:51,97-114`.
- Each record runs through `safelyExportDefinition` (titles are vendor text). Unsafe records go to `blocked`.

- [ ] **Step 1: Failing unit tests** in `devicePatches.test.ts` (mock pattern: `deviceStatus.test.ts`):
  - `403 without patches:read; devices:read alone is not enough`
  - `404 foreign orgId; 400 unknown status 'missing'; 400 unknown query key; 400 21 category values`
  - `updateType=unknown filters reported_update_type IS NULL`
  - `rejects a cursor minted for other filters` (`source=microsoft` cursor replayed with `source=apple`)
  - `rejects a cursor from another partner`
  - `effective category/severity prefer the shared row and fall back to the device report` (patches.severity `unknown` + reported `critical` → `critical`)
- [ ] **Step 2: Run them and see them fail. Implement** the route, mount it, add the `mcpCoverage.ts` exemption, the `unassignedPoolVisibility` `EPHEMERAL_ONLY` reason (update its pinned file count), and the site-scope exemption if flagged. **Run them and see them pass.**
- [ ] **Step 3: Failing integration tests** `partnerApiDevicePatches.integration.test.ts` (as `breeze_app` through the real router):
  - `patch rows follow the device's current org and skip ephemeral devices` (move a device A→B: the principal for A loses its rows and the principal for B gains them; a Quick Support device's rows never appear)
  - `missing tombstones are never returned`
  - `hides other partners' device patches; patches catalog rows are reachable only through an in-scope device`
  - `OS-only recipe excludes a driver and a definition update` (seed a Windows `driver`, a `definition` and a `quality` row; `source=microsoft&updateType=quality,feature,unknown` → only `quality`)
  - `partnerApiRls.integration.test.ts`: `ALL_SCOPES`, fixtures, `EXPECTED_COUNTS['device-patches']`
- [ ] **Step 4: Query plan gate.** Seed about 200k `device_patches` rows over 10k devices in one partner. Run `EXPLAIN (ANALYZE, BUFFERS)` on the first page and a deep page with `status=pending` across all orgs.
  - Pass means: an index scan and under 200 ms per page on a dev stack.
  - If it fails, add a `-- @no-transaction` CONCURRENTLY partial index `device_patches (id) WHERE status <> 'missing'` (or `(org_id, status, id)` if the planner prefers it) in its own migration, and record the before/after plans in the PR body.
- [ ] **Step 5: Run the integration tests and see them pass. Commit** `feat(partner-api): GET /device-patches live list (#12116)`.

### Task W2.3: Docs and follow-up

- [ ] **Step 1:** In `partner-api.md`, add a scope row and a section "Device patches" after "Time entries feed". It covers:
  - Live-state semantics: no change feed, poll and replace per device, rows bounded by traversal start.
  - That `missing` is never exported.
  - The OS-only recipe (OD 9) and the caveats on Windows drivers in `security` and Linux kernel in `system`.
  - `firstSeenAt` semantics and the freshness caveat (OD 10).
  - That `severity`/`category` are effective values.
  - That this list is not the "Low patch compliance" score (OD 12).
- [ ] **Step 2:** Add `api.mdx` and `api-keys.mdx` rows. Build the docs. **Commit** `docs(partner-api): patches:read (#12116)`.
- [ ] **Step 3:** File the OD 12 issue ("Patch compliance score: per-source scoring and tombstones in the denominator"), linking #12116.
- [ ] **Step 4:** Before the PR: run the full API unit suite, the Integration Tests for the touched suites and web tests. Open the PR with `Closes #12116`.
