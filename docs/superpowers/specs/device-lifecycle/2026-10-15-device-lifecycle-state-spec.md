---
tracking_issue: LanternOps/breeze#8836
---
# Device Asset Lifecycle State — Design Spec

**Date:** 2026-10-15
**Issue:** #8836 (`enhancement`, `category:devices`, `category:reporting`, `effort:l`, `priority:p2`)
**Status:** APPROVED 2026-10-17. Every decision was approved as recommended (see **Decisions**); Decision 6 is a named owner exception. Advisor quorum run: Fable position plus Codex `xhigh` read-only critique (`gpt-6-astra`). Nine Codex corrections were verified and folded in. Two disagreements (Decisions 3 and 6) were resolved by the owner on 2026-10-17.
**Related:** #8835 (assigned contact, the boundary between "Unassigned" and `spare`), #8833 (bulk edit), #8832 (dynamic groups do not re-evaluate on user edits), #7324 (lifecycle must be first-class in reports), #5720 / #8793 (Hardware Lifecycle costs and refresh planning, which this feeds), #4622 (manual assets), #5023 / #3987 / #2787 (Remove / Restore / Delete permanently, shipped).

## Problem

A customer (2026-10-15) needs to follow devices through retirement: assigned, then unassigned or in storage, then marked for destruction, then destroyed. They need to report on each bucket. Breeze has no such concept on agent devices.

- `devices.status` is **operational**: `online | offline | maintenance | decommissioned | quarantined | updating | pending` (`apps/api/src/db/schema/devices.ts:9,104`). It describes what the agent is doing, and heartbeats overwrite most of it.
- "Removed" (`status = 'decommissioned'` + `decommissioned_at`, `devices.ts:374-380`) means "stop managing". `DELETE /devices/:id` (`routes/devices/core.ts:2432`) runs `decommissionDeviceInTransaction` (`services/deviceDecommission.ts:22`): status flip, pending work cancelled, optional queued `self_uninstall`. The device leaves the default list (`DeviceList.tsx:1098-1105`) and billing (`services/contractQuantities.ts:16`), and its commands are refused. A `device_lifecycle` config policy can purge it N days later (`jobs/removedDevicePurge.ts`). Removed says nothing about where the hardware is.
- No retired, in-storage, pending-destruction or disposed state exists. There is no disposal date and no wipe or certificate-of-destruction reference. Agent devices have no asset tag or cost. Only `manual_assets.retired_at` / `asset_tag` exist (`schema/manualAssets.ts:37,45`).
- Custom fields can approximate a state (dropdown + filter + column since v0.118). They have no transition timestamps. They keep no history of values: the audit records keys only (`routes/devices/customFieldValues.ts:282-301`). They do not appear in reports (#7324). They fire no automation trigger and do not re-evaluate dynamic groups (#8832). Nothing ties "disposed" to the real device state, so the two drift apart.

## Users & scope

- **MSP technician / service desk:** marks a laptop `spare` when it comes back, `pending_disposal` when it goes in the destruction pile, and `disposed` with the certificate number when the vendor returns the paperwork. They want to do this one at a time and in bulk ("these 40").
- **MSP account manager / customer:** wants counts and lists per bucket, a disposal register with dates and certificate numbers, and refresh planning that does not count spares and destroyed machines as live demand.
- **Automation author:** wants to act when a device changes state, for example open a "wipe and collect" ticket on `pending_disposal`, or alert when a `lost_stolen` device comes back online.

**In scope:** agent devices (`devices`). The history table is shaped so manual assets can join later (Decision 8). **Out of scope:** see below.

## Proposed design

### Two axes, one invariant

Lifecycle state is an **inventory** axis, independent of operational `status`. A device can be `online` and `spare` (a loaner on a bench). It can be `offline` and `in_service` (a laptop on holiday). It can be `decommissioned` and `spare` (offboarded, agent removed, back on the shelf). Only one rule couples the two axes:

> **`disposed` ⇒ Removed.** A destroyed machine cannot still be managed. It is enforced in the database: `CHECK (lifecycle_state <> 'disposed' OR status = 'decommissioned')`.

Without this rule the two drift (the custom-field failure in the Problem section). With it, a disposed device gets every Removed behaviour (hidden by default, not billed, commands refused, purge-eligible) and no code path needs a second set of checks.

### States

| State | Meaning | Allowed while active? | Allowed while Removed? |
|---|---|---|---|
| `in_service` (default) | Deployed and in use | yes | yes (offboarded, lifecycle not recorded) |
| `spare` | Owned, not deployed: storage, loaner pool, awaiting redeploy | yes | yes |
| `pending_disposal` | Marked for wipe / destruction / return, not yet gone | yes | yes |
| `disposed` | Gone from the org's ownership: destroyed, recycled, resold, returned to lessor, donated | **no** (CHECK) | yes |
| `lost_stolen` | Whereabouts unknown | yes | yes |

Enum members, and whether `lost_stolen` ships in v1, are Decision 1.

### Transitions

Transitions are deliberately **loose**. An ITAM state machine with forced paths (`spare` must pass through `pending_disposal` before `disposed`) gets in the way of a tech recording what already happened. The server enforces only invariants:

1. **Into `disposed`:** the device must be Removed, or the request asks to Remove it in the same transaction (`remove: { uninstallAgent }`). Disposal fields (`disposal_method`, `disposal_reference`, `disposed_at`) are accepted **only** on a transition into `disposed` or on a disposal correction (rule 4). `disposal_method` is required on entry. The other two are optional, because the certificate often arrives weeks later. Without `remove`, an active device gets `409 DEVICE_NOT_REMOVED`: offboarding only ever happens when the caller asked for it and holds `DEVICES_DELETE`. For an already-Removed device, Remove is **not** run again, because `decommissionDeviceInTransaction` restamps `decommissioned_at` (`deviceDecommission.ts:30-36`) and would restart the purge window.
2. **Out of `disposed`** ("undo disposal"): allowed, `note` required, and the device stays Removed. Restoring is a separate, later action.
3. **Restore of a `disposed` device** (`POST /devices/:id/restore`, `/bulk/restore`): refused with `409 DEVICE_DISPOSED` and copy that says "Undo the disposal first." The check sits inside `restoreRemovedDevice` (`services/deviceLifecycle.ts:192`), under the `FOR UPDATE` lock it already takes, so the CHECK constraint is never the thing that answers (a 23514 would surface as a 500). Restore of any other state leaves the state unchanged.
4. **Same-state writes** are no-ops. They write no event and publish nothing, so a bulk "set spare" over a mixed selection is idempotent. **One exception: disposal correction.** A `disposed → disposed` write that carries disposal fields (the certificate number arrived, or the date was wrong) writes a new event with `kind = 'correction'`. It never edits the original row, so the first record of disposal is preserved. (Codex: an entry-only rule would force a fake undo/redo cycle to attach a late certificate.)
5. **Remove** never changes lifecycle state by itself. The Remove dialog gains an optional "Also mark as" select, defaulting to *Leave unchanged* (see Surfaces). This avoids guessing the hardware's fate from an offboarding action.
6. **Permanent delete / purge** is unchanged. History rows **detach** (below) instead of being deleted.

### Side effects of a transition (one service, one transaction)

New `services/deviceLifecycleState.ts` exports `setDeviceLifecycleState(tx, input)`. The single route, the bulk route and the Remove dialog all call it, so the three paths cannot drift. Per device, in **one** transaction:

1. `SELECT … FROM devices WHERE id = $1 FOR UPDATE`. This path takes **no partner lock**, because it admits nothing, so the devices row is its first and only row lock. Restore takes partner admission first and then the device (`deviceLifecycle.ts:173-183`). Purge locks the device and then the cascade. Neither ordering inverts against a single devices-row lock. Then re-check org/site against the authorised values, as `restoreRemovedDevice` does, and refuse `STATE_CHANGED` if the device moved. Compare `expectedState` when supplied.
2. If `to = disposed` and the device is not Removed: run `decommissionDeviceInTransaction(tx, …)` **before** step 3. The CHECK is evaluated per statement, not deferred, so the status flip must land first (or share step 3's UPDATE).
3. `UPDATE devices SET lifecycle_state, lifecycle_state_changed_at = now(), lifecycle_state_changed_by, lifecycle_note`.
4. `INSERT INTO device_lifecycle_events (…)` with from/to, note, disposal fields, `source`, actor, and the hostname and serial snapshots.

**Inside the same transaction** when step 2 ran: clear `possible_replacement_of_device_id` pointers (`core.ts:2477-2495`). It is a DB write and must commit or roll back with the Remove. **After the real commit:** remote-session teardown and agent WS disconnect (`core.ts:2497-2515`). Extract both halves to `services/deviceRemoval.ts` so DELETE and this path share them. *Codex correction:* in the single DELETE route today, `db.transaction` is nested inside the request's `withDbAccessContext` transaction, so its "post-commit" effects run before the outer commit. The new single route and the bulk route must be listed in `selfManagedDbContextRoutes` so that "after commit" is true. After that come `writeRouteAudit('device.lifecycle_state_change')`, `publishEvent('device.lifecycle_state_changed')`, and `requestDeviceGroupReevaluation({ changedFields: ['lifecycleState'] })`. The last two are retried and deduplicated by their existing machinery (event-bus subscriber retry; the reevaluation job id is per device and merges fields) (add `lifecycleState` to `mapChangedFieldsToFilterFields`, `events/deviceEvents.ts:150-159`, as #8832 does for tags).

### Data model

**`devices` (new columns):**

| Column | Type | Notes |
|---|---|---|
| `lifecycle_state` | `device_lifecycle_state` NOT NULL DEFAULT `'in_service'` | metadata-only `ADD COLUMN` on PG16, no row rewrite and no backfill write |
| `lifecycle_state_changed_at` | `timestamptz` NULL | NULL = never changed since enrollment |
| `lifecycle_state_changed_by` | `uuid` NULL → `users(id)` ON DELETE SET NULL | same pattern as `maintenance_started_by` (`devices.ts:120`) |
| `lifecycle_note` | `varchar(1000)` NULL | latest note, for the list tooltip and the badge |

**`device_lifecycle_events` (new, Shape 1):**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid NOT NULL → `organizations` ON DELETE CASCADE | |
| `device_id` | uuid NULL | composite FK `(device_id, org_id) → devices(id, org_id)` **ON DELETE SET NULL (device_id)** DEFERRABLE INITIALLY IMMEDIATE (precedent for the column-list form: `m365_intune_devices`, `cascadeDelete.test.ts:301-320`) |
| `manual_asset_id` | uuid NULL | reserved for parity (Decision 8); composite FK to `manual_assets(id, org_id)`, same shape; CHECK at most one subject set |
| `subject_label` | varchar(255) NOT NULL | hostname / display name snapshot, so a detached row stays legible (same discipline as `DeviceSnapshotRow.hostname`, `contractQuantities.ts:51-56`) |
| `subject_serial_number` | varchar(255) NULL | snapshot from `device_hardware` |
| `from_state` | `device_lifecycle_state` NULL | NULL only on rows written by a future import |
| `to_state` | `device_lifecycle_state` NOT NULL | |
| `note` | varchar(1000) NULL | required by the API when leaving `disposed` |
| `disposal_method` | `device_disposal_method` NULL | `destroyed \| recycled \| resold \| donated \| returned_to_lessor \| transferred \| other` |
| `disposal_reference` | varchar(255) NULL | certificate / work-order number |
| `disposed_at` | date NULL | when it physically happened (may be backdated). Distinct from `created_at` |
| `kind` | varchar(16) NOT NULL DEFAULT `'transition'` | `transition \| correction` (closed CHECK); a correction has `from_state = to_state = 'disposed'` |
| `source` | varchar(32) NOT NULL | `single \| bulk \| remove_dialog` (closed CHECK) |
| `actor_user_id` | uuid NULL → `users` ON DELETE SET NULL | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `detached_at` | timestamptz NULL | stamped by a `BEFORE UPDATE` row trigger when the last subject id becomes NULL (device purge/delete, manual-asset delete, move-org detach). The retention clock for detached rows (Decision 6) |

CHECK `device_lifecycle_events_disposal_fields_chk`: `to_state = 'disposed' OR (disposal_method IS NULL AND disposal_reference IS NULL AND disposed_at IS NULL)`. Indexes: `(org_id, created_at DESC)`, `(device_id, created_at DESC)`, and a partial `(org_id, disposed_at) WHERE to_state = 'disposed'` for the disposal register.

**Why the events detach instead of cascading.** Two reasons, both verified. First, `audit_logs` are retention-pruned per org (`jobs/auditRetention.ts`), so the audit trail cannot hold disposal evidence. (Audit details are queryable jsonb, but they are untyped, and they disappear on the retention schedule.) Second, the nightly purge (`removedDevicePurge.ts`) deletes disposed devices automatically once a `device_lifecycle` policy exists. If the events cascaded, an org with a 90-day purge window would lose its certificate-of-destruction numbers 90 days after disposal, with no human involved. Detaching (as `tickets` and `invoice_line_devices` do, `core.ts:207-209`) keeps a disposal register that outlives the device row. **The owner approved this on 2026-10-17 as a named disposal-register exception to the locked "Delete permanently = purge history" decision, with access and retention rules for detached rows (Decision 6).** See Decision 6.

**Cross-org device move: events stay with the source org.** *(Codex correction, adopted.)* The evidence that customer A disposed of or stocked a machine belongs to customer A. That is the precedent `ai_agent_runs` and `ai_operator_tasks` set (`core.ts:229-245`: history stays with the source org, and moveOrg detaches `device_id`). On `POST /devices/:id/move-org` the events are detached (`device_id = NULL`), not restamped. Org **merge** is different: both orgs become one tenant, so merge repoints them.

### Operational behaviour per state

The effect set is kept to **one chokepoint**, so that each additional suppression is a decision rather than an accident. Maintenance suppression is scattered across `offlineAlertEffects.ts:94-98`, `alertService.ts:1168-1175`, `patchAlerts.ts:235,378`, the deployment scheduler and patch jobs. Copying lifecycle checks into each of those is the fail-open-by-omission pattern.

| | in_service | spare | pending_disposal | lost_stolen | disposed |
|---|---|---|---|---|---|
| Offline **alert** admission (both offline paths, see below) | normal | **suppressed** | **suppressed** | **normal** (Decision 3) | n/a (Removed) |
| `status` goes offline | yes | yes (truthful) | yes | yes | n/a |
| Other alert kinds, patching, scripts, deployments | normal | normal | normal (Decision 3) | normal | refused (Removed) |
| `device.online` / `device.offline` events | published, payload gains `lifecycleState` | same | same | same (so "lost device came online" is an automation condition) | n/a |
| Billing (`billableDeviceConds`) | billed | billed (Decision 4) | billed | billed | not billed (Removed) |
| Default device list | shown | shown | shown | shown | hidden (Removed) |
| Purge policy | n/a | n/a unless Removed | n/a unless Removed | n/a unless Removed | eligible (Removed), events detach |

A spare on a shelf and a machine in the destruction pile are offline by nature. Paging someone about them is the noise this feature exists to remove. A spare that comes online with a failing disk should still alert, so only the offline kind is suppressed.

**"One chokepoint" is one predicate, consulted from both places offline alerts come from.** *(Codex correction, verified.)* There are two offline paths, not one:
- the monitor-backed path in `offlineAlertEffects.ts` (its maintenance check at `:89-98`);
- the general rule evaluator's `offline` condition handler, which also answers the legacy `{type:'status'}` "Device Offline" rows written by the config-policy editor (`services/alertConditions/handlers/offline.ts:19-23`).

A single exported `lifecycleSuppressesOfflineAlerts(state)` in `services/deviceLifecycleState.ts` is called from both. In the effect path it reads the state **under the durable admission lock** (`lockCurrentOfflineObservation`, `offlineAlertEffects.ts:147`), so a state change racing admission is decided on current data. The test suite asserts both paths with positive controls.

**Edges, defined:**
- Entering a suppressing state does **not** auto-resolve an already-open offline alert. The operator resolves it, and no new one is admitted.
- Leaving a suppressing state for `in_service` while the device is still offline must produce an alert. A completed, suppressed transition effect will not replay on its own. `setDeviceLifecycleState` enqueues a fresh offline evaluation for the device in that case. The plan picks the mechanism (a new effect keyed on the lifecycle event id, so retries are idempotent).
- `device.online` / `device.offline` payloads carry a `lifecycleState` snapshot taken at publish time, so retried deliveries keep their meaning.

### Surfaces

**API (session principal):**

| Route | Guard | Shape |
|---|---|---|
| `PUT /devices/:id/lifecycle` | `requireInteractiveSession` (`middleware/auth.ts:88-100`) + `devices:write` + `requireMfa()`; **plus** `DEVICES_DELETE` when `remove` is present | `{ state, note?, disposal?: { method, reference?, disposedAt? }, remove?: { uninstallAgent: boolean }, expectedState? }` → `{ device, event, uninstallQueued? }`. `expectedState` is optional optimistic concurrency for the dialog (409 `STATE_CHANGED` on mismatch) |
| `GET /devices/:id/lifecycle-events` | `devices:read` | paged, newest first |
| `POST /devices/bulk/lifecycle` | as PUT | `{ deviceIds (≤500), state, note?, disposal?, remove? }` → `{ succeeded[], failed[{deviceId, code}] }`. Uses `runBulkIsolated` (`lib/bulkOps.ts`), one transaction per device, listed in `selfManagedDbContextRoutes`. Same pattern as `/bulk/restore` (`bulkLifecycle.ts:92`). Mounted before `/:id` routes |
| `GET /devices`, `GET /devices/:id` | existing | DTO gains `lifecycleState`, `lifecycleStateChangedAt`, `lifecycleNote` via `projectPublicDevice` |

**Writers are user sessions only.** Requests authenticated by API key, MCP OAuth, AI agent or agent token are refused. `requireMfa()` alone does not guarantee this: it passes for any context when 2FA is globally off (`middleware/auth.ts:1053-1085`). The existing `requireInteractiveSession` guard exists for exactly this case, so use it. This keeps `lifecycleState` a server-controlled, admin-set field, so it can be offered as an **execution-target** filter field. Tags are refused as targeting keys precisely because a `devices:write` API key can write them (`filterEngine.ts:212`). A dynamic group "pending disposal → run wipe script" must not be enterable by a device-run script.

**Device page.** A badge next to the status pill in `DeviceDetails.tsx` (near the status maps at `:155-176`), shown **only when the state is not `in_service`** so the common case adds no noise. Clicking it opens `LifecycleStateDialog`. The same dialog is reachable from the actions menu. The dialog holds a state radio and a note. For `disposed` it adds method, reference and date. When the device is still active it also embeds the **Remove** section, reusing `RemoveDeviceDialog`'s agent radio, which defaults to *Uninstall* per the locked 2026-08-24 decision. The submit copy then reads "Remove and mark disposed". A **Lifecycle** card in `DeviceInfoTab.tsx` shows the current state, who set it and when, and the history timeline from `GET …/lifecycle-events`.

**Device list.** A `lifecycle` column in `columnVisibility.ts`, off by default. Quick chips: In service / Spare / Pending disposal / Lost / Disposed. The **Disposed** chip also sets `includeDecommissioned`, because disposed rows are Removed and hidden by default (`DeviceList.tsx:1098-1105`). Otherwise the chip would show zero. The filter field `lifecycleState` (enum) and `lifecycleStateChangedAt` (date, which gives "spare for more than 90 days") are added to `services/filterEngine.ts` (`FILTER_FIELDS`, next to `status` at `:77`) and to the web `filterFields.ts`. Trust tier: **server-controlled**, given the session-only writer rule above.

**Bulk.** "Set lifecycle state…" in the bulk bar, through `runAction`. It is offered for active selections **and** for removed-only selections. Marking already-Removed devices disposed is the main bulk use. This **extends** the shipped removed-only menu (#5023, "Restore, Delete permanently, Compare — nothing else"). The gating contract in `bulkActionGating.ts` (`REMOVED_ONLY_BULK_ACTIONS` `:158`, `INTENTIONALLY_UNGATED_BULK_ACTIONS` `:130`) needs a classification that admits it in both. The plan picks the set and extends `DeviceList.test.tsx`'s exactly-one-set assertion. For mixed selections the confirm shows "N will be removed and marked disposed, M are already removed".

**Remove dialog.** Optional "Also mark as: Leave unchanged / Spare / Pending disposal / Disposed (requires method)". It calls the same service with `source = 'remove_dialog'`. This is the natural offboarding moment, and it costs one select.

**Reports.**
- `device_inventory` (`reportGenerationService.ts:415`): add columns `lifecycleState`, `lifecycleStateChangedAt`, `disposalMethod`, `disposalReference`, `disposedAt`. The disposal columns come from the latest `to_state='disposed'` event via `LEFT JOIN LATERAL`. Add `filters.lifecycleStates[]`, default all. The report has **no status filter today**, so Removed and disposed devices already appear. Keep that and make it legible with the new column. The generator's select is fixed and ignores `config.columns` (#7324). These columns go into the fixed select and into the CSV/PDF column list, and the plan must confirm whether the PDF renderer keeps its own list (the open question #7324 raises).
- `hardware_lifecycle` (`hardwareLifecycleReport.ts:170-176`): it already excludes Removed devices, and so excludes disposed ones. Include `in_service` and `spare`, with spare rows labelled. Exclude `pending_disposal` and `lost_stolen` from the replacement schedule, since they are already leaving. Add a summary line, "N spares on hand".
- **Feeds #8793 / #5720:** refresh demand is `in_service` only. `spare` is available supply, shown as a count against each quarter. #5720's cost lines price `in_service` demand. The lifecycle predicate is defined once in `packages/shared/src/utils/hardwareLifecycle.ts`, so both reports read the same rule.
- Disposal register: v1 ships the API read route `GET /devices/lifecycle-register?orgId=` (partner/system scope only, Decision 6), which lists `to_state='disposed'` events including detached ones. A report type and UI over it are a follow-up.

**Partner API** (`routes/partnerApi/devices.ts`): the record gains `lifecycle: { state, changedAt }`. The export cursor is `devices.partner_export_updated_at`. Only the trigger `breeze_partner_export_devices_update` bumps it, and its `ROW(...)` change list is explicit (`migrations/2026-07-18-partner-export-org-locks.sql:310-345`). A lifecycle-only change would therefore **not** advance the cursor, and incremental consumers would silently miss it. The migration must `CREATE OR REPLACE` that function with `lifecycle_state` and `lifecycle_state_changed_at` added to **all three** `ROW(...)` comparisons in it. The strict record schema `partnerDeviceExportRecordSchema` (`routes/partnerApi/schemas.ts:141`) gains the field. Partner API `dtoSafety` / `exportSafety.classification` tests are updated. **Resync note:** the `ADD COLUMN … DEFAULT` does not touch rows, so existing rows do not advance the cursor. Consumers see `in_service` on a row's next change. The release note tells Partner API consumers to run one full resync to pick up the field everywhere (it reads `in_service` for every device until someone changes it). Device writes through the Partner API stay out of scope.

**Automation.** New event type `device.lifecycle_state_changed` (`services/eventBus.ts` union) with payload `{ deviceId, fromState, toState, actorUserId, source, disposalMethod? }`, published after commit. It is added to `getEventTypeOptions` in `AutomationForm.tsx:187`, with i18n in all 7 locales. Webhooks receive it through the `'*'` subscriber (`eventSubscribers.ts:117-121`). *Adjacent finding, not fixed here:* `device.decommissioned` is declared (`eventBus.ts:17,597`) and subscribed by the web app (`DevicesPage.tsx:1138`, `DeviceDetailPage.tsx:298`), but nothing publishes it.

**AI.** `query_devices` gains `lifecycleState` (`services/aiToolSchemas.ts:204-211`), and `get_device_details` returns it. No AI write tool in v1, because write tools are approval-gated and a separate decision. Use `z.enum`, never `z.undefined()`.

### Interaction with #8835 (assigned contact)

These are independent axes. `spare` means "not deployed". "Unassigned" means `primary_contact_id IS NULL`. A kiosk is `in_service` and unassigned. A loaner held by a tech is `spare` and assigned. Neither is derived from the other. Once #8835 ships, the dialog's transition to `spare` / `pending_disposal` / `disposed` offers a pre-ticked "Clear assigned contact". #8835 Decision 4 (approved 2026-10-17) records assignment changes in this spec's `device_lifecycle_events` table, so #8836's waves land first and the table's `kind` vocabulary is designed to admit an `assignment` kind (see the combined implementation plan).

## Tenancy & data model impact

**RLS shape: Shape 1** for `device_lifecycle_events`, using `breeze_has_org_access(org_id)`. It is auto-discovered by `rls-coverage.integration.test.ts`, so no allowlist entry is needed. The `devices` columns inherit the existing devices policies.

**`org_id NOT NULL` justification:** this is a per-device inventory record, not config or policy. A partner-wide lifecycle event is not a coherent concept, so the Partner-Wide First default does not apply.

**Migration sketch.** One file, idempotent, no inner `BEGIN`/`COMMIT`. The name must sort after the newest committed migration (currently `2026-12-28-130000-pam-reconciliation-reset-capability.sql`). The plan pins the slot. Do not name it for today's date.

```sql
DO $$ BEGIN
  CREATE TYPE device_lifecycle_state AS ENUM ('in_service','spare','pending_disposal','disposed','lost_stolen');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE device_disposal_method AS ENUM ('destroyed','recycled','resold','donated','returned_to_lessor','transferred','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS lifecycle_state device_lifecycle_state NOT NULL DEFAULT 'in_service',
  ADD COLUMN IF NOT EXISTS lifecycle_state_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_state_changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lifecycle_note varchar(1000);
-- DROP CONSTRAINT IF EXISTS + ADD: devices_lifecycle_disposed_removed_chk
--   CHECK (lifecycle_state <> 'disposed' OR status = 'decommissioned')
-- (validates instantly: every existing row is 'in_service')

CREATE TABLE IF NOT EXISTS device_lifecycle_events (... as above ...);
-- (device_id, org_id)       -> devices(id, org_id)       ON DELETE SET NULL (device_id) DEFERRABLE INITIALLY IMMEDIATE
-- (manual_asset_id, org_id) -> manual_assets(id, org_id) ON DELETE SET NULL (manual_asset_id) DEFERRABLE INITIALLY IMMEDIATE
--   (manual_assets_id_org_id exists per 2026-10-14-100200-device-warranty-manual-asset-subject.sql — verify)
-- indexes as above
ALTER TABLE device_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_lifecycle_events FORCE ROW LEVEL SECURITY;
-- four policies, each: breeze_current_scope() = 'system' OR breeze_has_org_access(org_id); pg_policies existence-checked

-- Partner API cursor: CREATE OR REPLACE FUNCTION public.breeze_partner_export_devices_update()
--   with lifecycle_state, lifecycle_state_changed_at appended to every ROW(...) comparison.
```

**System scope / backfill.** The migration **writes no rows**. The DEFAULT fills existing rows without an `UPDATE`, and `ALTER TABLE` fires no statement triggers. No `set_config('breeze.scope','system',true)` is needed, and `migrationRlsScope.test.ts` should agree; confirm this rather than assume it. If the plan adds any backfill (for example, seeding `spare` from an existing custom field), it **must** elect system scope first. Because `devices` carries partner-export statement triggers, it must also take the partner-then-org export locks before writing (`apps/api/migrations/README.md`, lock helper section, enforced by `migrationPartnerExportLocks.test.ts`). The recommendation is no backfill. A one-shot "map custom field X to lifecycle state" admin action can follow if asked for.

**Every registration this touches:**

| List | File | Entry |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `services/tenantCascade.ts` | `'device_lifecycle_events'` between `'device_ip_history'` (`:561`) and `'device_link_groups'` (`:565`). FK direction: it references `devices` and `manual_assets`, both later in the list, so it is deleted first, which is correct. |
| `orgMergeRegistry.ts` | `REPOINT_TABLES` (`:767`, near `"device_ip_history"` `:924`) | plain `repoint`. No org-unique key. |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | new `device_lifecycle_events` entry, **and** the existing `devices` entry (`:436`) gains its four new columns |
| `DEVICE_DETACH_DEVICE_ID_TABLES` | `routes/devices/core.ts:207` | **yes**. `device_id` is SET NULL on device delete. `cascadeDelete.test.ts:161` requires exactly one of cascade/detach/linked. |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `routes/devices/core.ts:314` | **no**. History stays with the source org on move-org (see Data model). List it in `INTENTIONALLY_NO_ORG_ID` in `moveOrg.coverage.test.ts`, as `ai_agent_runs` is, and add an explicit detach (`device_id = NULL`) for this table in `services/deviceOrgMove/moveDeviceOrgInTransaction.ts`, next to the `ai_agent_runs` detach. Otherwise the composite FK aborts the move with 23503 once `devices.org_id` changes. `moveOrg.coverage.test.ts:123` goes red until one of the two is done. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `core.ts:631` | **no** (detach, not cascade) |
| `AUDIT_ADMIN_REQUIRED_TABLES` | `tenantCascade.ts` | **no**. Not append-only at the DB level in v1. No route updates or deletes rows, and a correction is a new event. |
| `rls-coverage` allowlists | `rls-coverage.integration.test.ts` | **no** (Shape 1, auto-discovered) |
| `manual_assets` | only if Decision 8 brings parity into v1 | `DEVICE_LINKED…` does not apply. A manual-asset delete detaches through the FK. |

**Export-policy buckets:**
- `devices` → `included`: `lifecycle_state`, `lifecycle_state_changed_at`, `lifecycle_state_changed_by`, `lifecycle_note`. None matches `SUSPICIOUS_NAME_PARTS` (`services/tenantExportPolicy.ts:42-61`).
- `device_lifecycle_events` → `included`: every column. `disposal_reference` is a certificate number, not a credential, and does not match the suspicious list. `reviewedIncluded`, `excludedSensitive`, `excludedOpen`: **none**. No json/jsonb/bytea column by design, so the history round-trips through tenant export intact.

## Out of scope

- **Attachments** (certificate-of-destruction PDFs, wipe reports). There is no per-org file storage yet (#3845). `disposal_reference` holds the certificate number until it exists.
- **Disposal-vendor integrations** (ITAD portals, pickup scheduling).
- **Asset tag and purchase cost on agent devices.** Partner API `stableIdentifiers.assetTag` already reads a custom field (`partnerApi/devices.ts:120`). First-class asset tag and cost belong with #5720 / a separate issue.
- **Data-sanitisation evidence** (NIST 800-88 method, verification). It is a natural extension of the event row: new nullable columns, additive.
- **Configurable per-state behaviour** through the `device_lifecycle` config policy. v1 behaviour per state is fixed. Making suppression configurable is additive once real demand shows which knob MSPs want.
- **AI write tool**, **Partner API writes**, **disposal-register report**, **device-list CSV export** (#7324).
- Fixing `device.decommissioned` never being published (adjacent finding, file separately).

## Decisions (approved 2026-10-17)

The owner approved every decision below **as recommended** on 2026-10-17. Each keeps its original number; the options are retained for the record, and the **Approved** line is binding.

**1. Enum members.**
(a) `in_service | spare | pending_disposal | disposed`, as the issue lists; (b) (a) + `lost_stolen`; (c) (b) + `in_repair` / `returned`.
**Recommend (b).** `lost_stolen` has distinct, security-relevant semantics. It keeps monitoring (you want to know when it comes online) and is the natural automation hook for lock/wipe. *Codex agrees* that the five are a reasonable minimum. The default `in_service` also labels every **already-Removed** device `in_service`. That is documented as "unknown, defaulted" (with `lifecycle_state_changed_at IS NULL`). No transitions are invented for history. `in_repair` is covered by `spare` plus a note. `returned` / `resold` / `transferred` are disposal *methods*, not states. Adding enum values later is cheap (`ALTER TYPE … ADD VALUE`), so (a) is defensible if the owner wants the minimum.

**Approved (2026-10-17): (b).** Five members: `in_service | spare | pending_disposal | disposed | lost_stolen`. Already-Removed devices read `in_service` with `lifecycle_state_changed_at IS NULL` ("unknown, defaulted"); no history is invented.

**2. Does `disposed` force Remove?**
(a) Yes, DB CHECK `disposed ⇒ decommissioned`, and the dialog removes atomically; (b) yes, app-layer only; (c) no, `disposed` is a label.
**Recommend (a).** (c) is the custom-field drift that motivated the issue. (b) is fail-open-by-omission: the bulk path, the AI and a future import would each need the rule. The constraint makes the invalid state unrepresentable. Restore is the only code path that flips status away from `decommissioned` (`deviceLifecycle.ts:219`), and it gets an explicit 409 under its existing lock. The plan must grep every `status:` writer (heartbeat terminal-status guard, parked-device paths, reaper) to confirm none can un-remove a row.

**Approved (2026-10-17): (a).** DB CHECK `devices_lifecycle_disposed_removed_chk`; the dialog removes atomically; Restore refuses `disposed` with `409 DEVICE_DISPOSED` under its existing lock. The plan carries the `status:` writer sweep.

**3. Suppression for `pending_disposal`, `spare` and `lost_stolen`.**
(a) Offline-alert admission only (one predicate, both offline paths) for `spare` and `pending_disposal`; (a′) as (a) plus `lost_stolen`; (b) (a) + suppress patching / deployments for `pending_disposal`; (c) no suppression, operators use maintenance or Remove.
**Recommend (a).** For `lost_stolen` my first position was (a′): a lost laptop is offline by nature and the open offline alert is noise. **Codex disagrees** and would keep offline alerts for `lost_stolen` unless explicitly opted out. A lost device going *offline* after being seen is itself a signal, and silencing it should be deliberate. I now lean towards Codex's view, because suppression is the riskier default for a security state. The owner should pick. Shelf and destruction-pile devices are offline by nature, so offline alerts about them are the noise. Every other signal is still useful if the device powers on. (b) means adding a lifecycle check to each patch and deployment path (`patchJobs.ts`, `deploymentEngine.ts`, `softwareDeploymentScheduler.ts`), a scatter with no contract test. If patching a device about to be wiped is a real problem, the answer is Remove (leave agent) at `pending_disposal` time, which the Remove dialog now offers.

**Approved (2026-10-17): (a).** Offline-alert admission is suppressed for `spare` and `pending_disposal` **only**. `lost_stolen` keeps offline alerts (Codex's position). One predicate, `lifecycleSuppressesOfflineAlerts(state)`, consulted from both offline paths. No patch/deployment suppression.

**4. `spare` and billing.** *(Codex agrees with (a), and adds: show "still billable" in the dialog.)*
(a) No change: billing follows Removed only; (b) `spare` (and `pending_disposal` / `lost_stolen`) excluded inside `billableDeviceConds`; (c) partner setting choosing which states bill.
**Recommend (a) for v1, (c) as a follow-up.** `billableDeviceConds` is "the one set of predicates" (`contractQuantities.ts:10-12`). Wiring a field any technician can flip into it lets a misclick or a bulk action lower a customer's invoice. Managed spares still consume agent, patching and monitoring. An MSP that wants spares free should Remove them, or wait for (c), a partner-wide setting with its own audit.

**Approved (2026-10-17): (a).** Billing follows Removed only; the dialog shows "still billable" for `spare` / `pending_disposal` / `lost_stolen`. (c) is a follow-up issue.

**5. History table vs audit-only.**
(a) `device_lifecycle_events` table; (b) audit log only (`device.lifecycle_state_change` with details).
**Recommend (a).** Audit rows are retention-pruned per org (`jobs/auditRetention.ts`). Their details are untyped jsonb. Reports cannot join them, and a disposal register built on them would vanish on the retention schedule. The audit row is still written, for the cross-cutting trail.

**Approved (2026-10-17): (a).** Typed `device_lifecycle_events` table; the audit row is still written.

**6. Do lifecycle events survive permanent delete / purge?**
(a) Detach (`device_id` SET NULL, snapshots keep the row legible); (b) cascade-delete with the device, matching the locked "Delete permanently = purge history".
**Fable recommends (a), and it needs an explicit owner exception to the 2026-08-24 decision. It must not be applied silently. Codex disagrees with adopting it by reinterpretation:** either the owner grants a named "disposal-register exception" with its own access and retention rules, or the history cascades (b). Both advisors agree it is the owner's call and that the spec must not narrow a locked decision on its own. That decision separated *telemetry and operational history* (metrics, sessions, inventory) from the device. A disposal record is evidence about the org's asset ("we destroyed serial X on date Y, certificate Z"), and it is most needed after the device row is gone. Under (b), an org with a 90-day `device_lifecycle` purge window silently loses its certificate numbers 90 days after disposal. An org-level erasure still deletes the events (org cascade), so GDPR erasure is unaffected.

**Approved (2026-10-17): (a) detach — a NAMED OWNER EXCEPTION (the "disposal-register exception") to the 2026-08-24 "Delete permanently = purge history" rule.** On permanent delete or automatic purge, `device_lifecycle_events.device_id` is SET NULL and the row keeps its `subject_label` / `subject_serial_number` snapshots as a disposal register. The 2026-08-24 rule otherwise stands unchanged for every other device-history table. Conditions of the exception (Codex's condition for agreeing, adopted):
- **Scope.** Only `device_lifecycle_events` rows. No other table may cite this exception; a new detaching history table needs its own owner decision.
- **Access to detached rows** (`device_id IS NULL AND manual_asset_id IS NULL`): readable **only** by partner-scope (and system-scope) users who hold `devices:read` **and** have access to the owning org. Org-scope users never see detached rows. In v1 the only readers are one dedicated route, `GET /devices/lifecycle-register?orgId=` (partner/system scope, `devices:read`, org-access check), and tenant export. `GET /devices/:id/lifecycle-events` filters by `device_id`, so it never returns detached rows. RLS stays Shape 1 (`breeze_has_org_access(org_id)`); the partner-scope rule is enforced in the route and pinned by a route test with an org-scope negative control.
- **Retention of detached rows.** Detached rows join the `device_lifecycle` retention family: a daily job (`device-lifecycle-event-retention`, sibling of `removed-device-purge`) deletes rows whose `detached_at` is older than `DEVICE_LIFECYCLE_EVENT_RETENTION_DAYS` (default **400**, clamped 30..3650). `detached_at` is stamped by a `BEFORE UPDATE` row trigger when the last subject id becomes NULL, so the clock starts at detach, not at disposal. The trigger fires on the FK's RI update and on the move-org detach alike. Attached rows are never pruned by this job.
- **Erasure.** Org erasure (org cascade) still deletes every row, attached or detached. Tenant export includes them.
- **Not applied silently.** PR text and the Devices docs name the exception.

**7. Who may write lifecycle state?**
(a) User sessions only, `devices:write` + MFA; `lifecycleState` is server-controlled and allowed as an execution-target filter field; (b) also `devices:write` API keys, with the field refused for execution targeting, like tags.
**Recommend (a)** (Codex agrees, and points to `requireInteractiveSession`). "Pending disposal → wipe" groups and automations are the point of the feature. If a device-run script holding a `devices:write` key could put any device into that group, it would be an escalation path. API-key writes can come with the Partner API write surface later.

**Approved (2026-10-17): (a).** User sessions only (`requireInteractiveSession` + `devices:write` + `requireMfa()`, plus `DEVICES_DELETE` when `remove` is present). `lifecycleState` is a server-controlled filter field that execution targeting may use.

**8. Manual-asset parity.**
(a) v1 agent devices only; the events table carries a nullable `manual_asset_id` from day one (composite tenant FK, same detach behaviour); `manual_assets.lifecycle_state` in a later wave; (b) both in v1; (c) devices only, no reserved column.
**Recommend (a).** The canonical manual asset ("spare laptop in a drawer", #4622) is exactly a lifecycle subject, so parity is wanted. Reserving the column now avoids a second migration on a populated table. Shipping it in v1 widens an `effort:l` issue across a third device class and its separate client-side filter path (`mergedListFilter.ts`). **Sub-question for that wave (Codex):** `retired_at` does not necessarily mean disposed, because retirement can come before disposal. The mapping (does `retired_at` follow `pending_disposal`, `disposed`, or stay independent?) must be decided explicitly, not derived.

**Approved (2026-10-17): (a).** v1 covers agent devices only. `device_lifecycle_events.manual_asset_id` is reserved in the first migration. `manual_assets.lifecycle_state` ships in a later wave (plan W6), and that wave decides the `retired_at` mapping explicitly.

**9. Bulk action on removed-only selections.**
(a) Offer "Set lifecycle state" in the removed-only bulk menu, extending the shipped #5023 "nothing else" list; (b) keep that menu frozen, and offer the action only on active selections and the device page.
**Recommend (a).** Bulk-marking already-Removed devices disposed is the primary bulk workflow ("these 40 went to the shredder"). The #5023 rule existed to stop offering actions that 400 on removed devices. This one is valid on them.

**Approved (2026-10-17): (a).** "Set lifecycle state" is offered on removed-only selections too, extending the #5023 list.

## Advisor note (quorum)

Fable formed the position first. Codex `xhigh` (`gpt-6-astra`, read-only, run from this worktree; GitHub was unreachable from its sandbox, so it worked from the brief and the code) critiqued it independently. Every code claim it made that the spec relies on was re-verified.

**Agreed:** operational vs inventory separation; the five-member enum; the DB CHECK `disposed ⇒ decommissioned`; loose transitions with idempotent no-ops; billing unchanged (Removed is the only billing lever); a typed history table over audit-only; session-only writers; #8835 as an independent axis; deferring manual-asset parity.

**Codex corrections adopted** (each verified in code):
1. Two offline-alert paths, not one: the `offline` condition handler with its legacy `status` alias (`alertConditions/handlers/offline.ts:19-23`). The predicate is shared and read under the admission lock (`offlineAlertEffects.ts:147`).
2. `requireInteractiveSession` (`middleware/auth.ts:88-100`) is the right guard, not user identity plus MFA.
3. Remove's "post-commit" effects run inside the request transaction today (`core.ts:2468`), so the new routes are self-managed. Clearing the replacement pointer stays inside the transaction.
4. Restore takes partner admission **before** the device lock (`deviceLifecycle.ts:173-183`). My first draft mis-stated its order.
5. Re-running Remove on an already-Removed device would reset `decommissioned_at` (`deviceDecommission.ts:30-36`) and restart the purge clock. It is never re-run.
6. Disposal corrections are append-only `correction` events, not entry-only fields.
7. Events stay with the source org on a cross-org move, following the `ai_agent_runs` precedent (`core.ts:229-245`).
8. All three partner-export `ROW` lists, the strict DTO schema (`partnerApi/schemas.ts:141`), and a resync note for defaulted rows.
9. `retired_at ≠ disposed`. The manual-asset mapping is an explicit decision.

**Disagreements, recorded for the owner (now resolved, see Decisions):**
- **Decision 6:** Codex rejects reinterpreting the locked "purge history" decision. It wants an explicit exception or cascade. Fable recommends detach but agrees it needs owner sign-off.
- **Decision 3:** Codex keeps offline alerts for `lost_stolen`. Fable first suppressed them and now leans towards Codex.
- The CHECK constraint, billing and the history table were not disputed.

## Test & rollout notes

**Unit / route (Test API).**
- `services/deviceLifecycleState.test.ts`: transition rules. Into `disposed` without `remove` on an active device returns 409. Disposal fields on a non-disposed transition return 400. Leaving `disposed` without a note returns 400. A same-state write is a no-op (no event, no publish). `expectedState` mismatch returns 409.
- `routes/devices/lifecycle.test.ts`: permission matrix (`devices:write`, plus `DEVICES_DELETE` when `remove` is present, plus MFA). API-key principal refused. Cross-org 404. Site-scoped tech 403. Bulk cap 500. Bulk per-device isolation.
- `restoreRemovedDevice` refuses `disposed` with `DEVICE_DISPOSED` **under the lock**. The CHECK is a backstop, never the responder.
- `cascadeDelete.test.ts` / `moveOrg.coverage.test.ts` go red the moment the table lands without its two device-list registrations. That is the intended early warning.
- Offline suppression on **both** paths (`offlineAlertEffects` and the `offline` / legacy `status` condition handler), each with a positive control. An `in_service` device admits an alert, and the same input on `spare` does not. A red without the positive control proves nothing. Plus: moving `spare → in_service` while offline produces an alert.
- A disposal correction appends a `correction` event and leaves the original untouched. Setting disposed on an already-Removed device does not move `decommissioned_at`.
- `filterEngine` field present; trust-tier classification asserted; `mapChangedFieldsToFilterFields` maps `lifecycleState`.
- `reportGenerationService` and `hardwareLifecycleReport`: new columns and filters. Spare included and labelled, `pending_disposal` excluded.
- Partner API: a lifecycle-only change advances the cursor (trigger `ROW` list). `exportSafety.classification` updated.
- `autoMigrate.test.ts`, `migrationRlsScope.test.ts`, `migrationPartnerExportLocks.test.ts` (the migration writes no rows, so it needs neither scope nor locks; assert that the guards agree).

**Integration (Integration Tests job; these cannot fail in Test API).**
- `rls-coverage.integration.test.ts` (auto). Plus `deviceLifecycleEvents.integration.test.ts`: as `breeze_app`, a cross-tenant insert fails with 42501, and the positive control in the right org succeeds.
- `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, `orgLifecycleFoundations` ("merge contract": both composite FKs DEFERRABLE).
- Real Postgres. Permanent delete of a disposed device leaves its events with `device_id IS NULL` and snapshots intact. A cross-org move detaches the events and leaves them in the source org (no 23503). Org merge repoints them. A Restore racing a set-disposed loses cleanly (one 409, no 23514, no 40P01). The CHECK rejects a hand-forged `disposed` on an active row.
- `dynamicGroupReevaluation.integration.test.ts`: a lifecycle change moves the device into and out of a `lifecycleState` group.

**Web.** Dialog states (embedded Remove section only when active + disposed). Badge hidden for `in_service`. The Disposed chip flips `includeDecommissioned`. The bulk gating contract is extended. `runAction` is on every mutation (`no-silent-mutations.test.ts`). New strings go into all 7 locales (`localeParity`).

**E2E.** Mark a device spare from the device page, see the badge and the chip count, then bulk-mark two removed devices disposed with a certificate number and see them under the Disposed chip. `data-testid` only.

**Feature flag.** None. The default `in_service` makes the feature invisible until used.

**Docs.** The Devices page in `apps/docs/` gets a lifecycle section explaining the two axes and the `disposed ⇒ Removed` rule. Add the upgrade note: a new migration, no env vars.

**Suggested wave split (for the plan).**
1. Migration + schema + all registrations + contract tests + `deviceLifecycleState` service + `PUT`/`GET` routes + DTO + the Restore guard. Lands green on its own.
2. Web: badge, dialog (including the embedded Remove), Lifecycle card, list column, chips, filter field + `filterEngine` + group re-evaluation.
3. Bulk route + bulk bar + Remove-dialog "Also mark as", plus the `deviceRemoval.ts` extraction.
4. Behaviour: offline-alert suppression, event payloads, the automation trigger, the AI filter, the Partner API (including the trigger `ROW` list).
5. Reports: `device_inventory` and `hardware_lifecycle` columns and filters, and the shared lifecycle predicate for #8793 / #5720. Docs.
6. (Decision 8) Manual-asset parity.
