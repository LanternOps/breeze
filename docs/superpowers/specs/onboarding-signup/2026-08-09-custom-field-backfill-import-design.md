# Custom-Field / UDF Backfill Import — Design

**Date:** 2026-08-09
**Status:** Approved — all decisions settled; §0 resolved to **Option B** by the user 2026-08-09
**Issue:** #3257 (epic #3249, Phase 3)
**Related:** #3242 (the preview→commit pipeline this mirrors), #3258 (the other Phase-3 doc)

## Summary

Let an MSP bring their user-defined fields across when migrating — Datto `udf1`–`udf30`,
ConnectWise Automate EDFs, Kaseya VSA custom fields, NinjaOne/N-central custom
properties, Atera custom values. Two passes: **field-definition import** so `udf7`
becomes a named, typed field once instead of being retyped thirty times, then
**value backfill** joined to enrolled devices, with preview → commit and per-row match
status.

This runs after Phase 4 of a migration (devices must exist), so it cannot share a
transaction, payload, or UI flow with the org importer.

**The largest finding is that the destination is not ready.** `custom_field_definitions`
has no uniqueness on `field_key`, no XOR constraint, no partner-wide authorization gate,
and there is no value-vs-type validation anywhere in the product. Pouring 300k
hand-entered values into that is how a migration turns into a support incident. §0 and §2
are about fixing the destination first.

## Context — verified 2026-08-09

- **Definitions** (`db/schema/customFields.ts`) — `custom_field_definitions`, dual-axis
  nullable `org_id`/`partner_id`, columns `name`, `field_key`, `type`
  (`text|number|boolean|dropdown|date`), `options` jsonb, `required`, `default_value` jsonb,
  `device_types` text[]. Dual-axis RLS shipped in `2026-06-11-i-custom-fields-dual-axis-rls.sql`;
  registered in `DUAL_AXIS_TENANT_TABLES`, `CORE_ORG_CASCADE_DELETE_ORDER`, and
  `CORE_TENANT_EXPORT_POLICY`.
- **Values are not a table.** `devices.customFields` is `jsonb('custom_fields').default({})`
  (`db/schema/devices.ts:105`). Written by `routes/devices/customFieldValues.ts` (`{...existing,
  ...updates}`) and also by `PATCH /devices/:id` (`routes/devices/core.ts:1238-1246`).
- **`devices.custom_fields` is `excludedOpen`** (`tenantExportPolicyRegistry.ts:140`) — values
  are dropped from the GDPR tenant export. They *are* published through the partner API's
  `custom-field-values` resource, so the gap is the tenant export specifically.
- **No index of any kind on `custom_fields`.** Every `custom.<key>` filter compiles to an
  unindexed `jsonb_extract_path_text` scan (`filterEngine.ts:181-182`). The sibling jsonb
  column `devices.management_posture` has three expression indexes
  (`0001-baseline.sql:9400-9414`) — someone already hit this wall next door.
- **Join keys.** `devices.hostname` exists and is deliberately **not** unique per org
  (`routes/agents/enrollment.ts` inserts a fresh row on hostname collision, per the #2764
  identity design). `serial_number` lives on `device_hardware`, nullable, not unique. There is
  **no `external_id` on devices** and no incumbent-RMM identity recorded anywhere.
- **Migration dates:** the last shipped migration is `2026-08-18-drop-organizations-accounting-columns.sql`.
  Today's date does **not** sort last, contrary to the Phase-3 handoff note. New migrations
  must be dated `2026-08-19` or later or they replay out of order on a fresh database.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Value storage | **Promote to `device_custom_field_values`, keep `devices.custom_fields` as a trigger-maintained projection** | §0 — settled (Option B, 2026-08-09). The flat value namespace corrupts a shipped export contract. |
| Destination hardening | **Four prerequisites, before any importer** | §2. Uniqueness, XOR, partner-wide gate, type validation. |
| Mapping targets | **Custom fields *and* first-class columns (`device_warranty`)** | §3. Warranty expiry is the issue's headline field and already has a better home. |
| Join key | **`deviceId` → serial → hostname, org-scoped, never guess** | §4 |
| Request shape | **Partner-scoped, many orgs per request** | Matches `orgImport`; a Datto export is partner-wide. Safety comes from per-row authorization, not request shape. |
| Auth | **`requireMfa()`, no `X-API-Key`, site-gated** | §5 — the existing value route bypasses both. |
| Row cap | **1000 per request (`MAX_IMPORT_ROWS`), one transaction per org-chunk** | §6 — a per-org exclusive advisory lock is held until COMMIT. |
| Field-key case | **snake_case only** | §7 — `assetTag` is readable but not creatable today. |
| Scope | **Device-level only in v1** | §8 |

---

## 0. Decision — where values live

**Settled 2026-08-09: Option B.** The issue reads as an import feature; it is actually a
storage-model question, and answering it wrongly is the expensive outcome. Option A is
recorded below as the rejected alternative.

### The problem with the current model

`devices.custom_fields` is one flat jsonb object per device, keyed by a bare string.
Nothing in `devices.custom_fields.udf7` records *which definition* it belongs to — but the
definition namespace is **dual-axis**. The shipped partner-export query joins them by
string match (`routes/partnerApi/configuration.ts:427-440`, verified):

```sql
JOIN public.custom_field_definitions f
  ON (f.org_id = eo.id OR (f.org_id IS NULL AND f.partner_id = $partnerId))
 AND d.custom_fields ? f.field_key
...
md5(d.id::text || ':' || f.id::text) AS identity_hash
```

If an org-owned `udf7` and a partner-wide `udf7` both exist, this emits **two export
records for one datum**, with two different synthetic ids (the hash includes `f.id`).
`customFieldSource()` at `:410-425` duplicates the definitions the same way.

That collision cannot be prevented by any constraint on this shape: uniqueness would have
to span two nullable ownership columns across disjoint row sets. And the importer is
precisely what manufactures the scenario — today essentially every custom field is
partner-wide (§2.3), and a per-org definitions import creates org-owned rows beside them
in bulk.

### Option A — stay on jsonb, refuse collisions at preview

Cheapest. The importer detects an org-owned key colliding with a visible partner-wide key
and refuses the row. Residual risk: the hazard remains open on the plain API (which has no
such check), the export gap stays (fixable — see below), and every `custom.<key>` filter
stays unindexed as volume grows 100×.

### Option B — `device_custom_field_values` + a trigger-maintained jsonb projection — CHOSEN

A real values table keyed by `definition_id`, with `devices.custom_fields` kept as a
derived projection so existing readers do not change.

```sql
device_custom_field_values (
  id, device_id, org_id, definition_id,
  value_text, value_number, value_bool, value_date,
  source, created_at, updated_at
)
UNIQUE (device_id, definition_id)
```

- **Correctness by construction.** A value points at exactly one definition; the export
  join becomes a lookup and the duplicate-record defect disappears.
- **34 of 37 consumers do not change.** A full enumeration finds 37 consumer sites, but only
  **three** touch the jsonb in SQL — `filterEngine.ts:181-182` and
  `partnerApi/configuration.ts:433,440`. The rest are JS reads that consume whatever the
  row already carries: `stripSensitiveDeviceFields` echoes
  (`routes/devices/core.ts:1009,1294,1441,1484`, `moveOrg.ts:280`, `provision.ts:367`),
  Drizzle select projections (`core.ts:622,814`), the `resolveRemoteAccessLaunch` hand-offs
  (`core.ts:995,1084`), plus `remoteAccessLauncher.ts:73`, `installerVariables.ts:53`,
  `softwareDeployment.ts:300,395`, `aiToolsDevice.ts:560`, `DeviceInfoTab.tsx:1175`. The
  projection keeps all of them, both partner-export triggers, and the MCP projection working.
- **Indexing.** A plain B-tree on `(device_id, definition_id)` and on `value_date` replaces
  a full scan per filter.
- **Export.** Typed columns are `included`, closing the tenant-export gap properly.
- **Fixes two live bugs for free:** deleting a definition currently leaves orphaned keys in
  every device's blob (a `definition_id` FK cascades), and type validation finally has an
  anchor.

**Cost, stated honestly:** a migration with a backfill of every existing blob, a projection
trigger (write amplification on every value change), three query rewrites, and the writer
move. It is a prerequisite PR, not a footnote — but it is one PR, not the multi-PR project
I first assumed.

**One premise I had wrong.** I believed `excludedOpen` was absolute and therefore that the
export gap could only be fixed by promotion. It is not: `tenantExportPolicy.ts:223-227`
requires only `openContainerReviewed: true` to include an open container, and `tablePolicy`
has a `specific` escape hatch already used twice (registry `:119`, `:255`). So the export gap
is fixable under Option A too. It is a supporting argument for B, not a decisive one — the
decisive argument is the export-contract corruption above.

### Decision

**Option B, sequenced as a prerequisite phase (3a) ahead of the importer (3b)** — chosen by
the user on 2026-08-09. The reason is CLAUDE.md's own rule: retrofitting the storage model
*after* backfilling 300k values is strictly worse than doing it before, and this is a
correctness argument about shipped behaviour rather than a taste argument about schema style.

Option A was declined. It remains the fallback if phase 3a proves larger than estimated, but
taking it would mean accepting that the cross-axis collision stays reachable through the
plain API, that `custom.<key>` filters stay unindexed at 100× volume, and that the
tenant-export gap is closed by the `openContainerReviewed` escape hatch rather than by
having queryable data.

---

## 1. Two passes, two route pairs

Definitions and values have different tenancy, different authorization, and different
lifecycles. They do not share an endpoint.

- `POST /custom-fields/import/preview` · `POST /custom-fields/import` — **definitions**.
  Config data; org **or** partner owned; partner-wide writes gated (§2.3).
- `POST /devices/custom-fields/import/preview` · `POST /devices/custom-fields/import` —
  **values**. Device data; org-scoped; device resolution and site gating (§4, §5).

Name them unambiguously in code (`deviceCustomFieldImport`, not `customFieldImport`):
`tickets.custom_fields` (`db/schema/portal.ts:74`) and the PSA/Jira `customFields`
(`services/psa/jira.ts:26`) are unrelated namesakes.

---

## 2. Harden the destination first

All four are missing today, and all four are load-bearing for a bulk import.

### 2.1 Uniqueness on `field_key` — the definitions import has no idempotency key

`routes/customFields.ts` POST does no pre-insert `SELECT` and no uniqueness check; the web
create modal (`CustomFieldsPage.tsx`) contains zero references to `orgId`/`partnerId`/`scope`,
so it cannot warn either. Creating "Asset Tag" twice succeeds. Re-running a definitions
import would mint duplicate `udf7` rows without this.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_org_key_uniq
  ON custom_field_definitions (org_id, field_key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_partner_key_uniq
  ON custom_field_definitions (partner_id, field_key) WHERE partner_id IS NOT NULL;
```

**Cross-axis collision is NOT covered by these** — that is §0's whole point. Under Option B
it stops mattering for correctness; under Option A the importer must refuse it at preview.

**Existing duplicates block the index, and neither obvious cleanup is safe:**

- *Delete the duplicate* — the survivor dictates the `type`. If the two disagree
  (`text` vs `number`), every value already stored under that key is silently retyped, with
  no value-side migration because values carry no type.
- *Rename the duplicate* (`udf7` → `udf7_2`) — values are keyed by the string, so a rename
  orphans every stored value instantly, and breaks consumers holding the key as
  configuration: `remoteAccessLauncher.ts:73` (`provider.customFieldKey`, stored in partner
  settings) and `installerVariables.ts:30,51-53` (`{{device.customField.<key>}}` on software
  packages).

**Resolution:** the migration reports duplicates rather than resolving them. It emits a
`RAISE WARNING` with the count and the affected `(owner, field_key)` pairs per CLAUDE.md's
row-count rule, and creates the index only when the count is zero; otherwise it fails loudly
with the list. Cleanup is an operator decision made with knowledge of which duplicate carries
values — not something a migration should guess. (`CREATE INDEX CONCURRENTLY` is available
if needed — `autoMigrate.ts:572-606` has a documented non-transactional path — but the data,
not the locking, is the obstacle here.)

### 2.2 XOR constraint

`(NULL, NULL)` and `(set, set)` are both structurally legal today. A `(NULL, NULL)` row is
invisible to every non-system caller (`breeze_has_org_access(NULL)` is FALSE) **and survives
org cascade forever**, since the cascade deletes by `org_id` — a latent GDPR orphan.

Existing data almost certainly conforms: `routes/customFields.ts` POST rejects `(set, set)`
with a 400 and makes `(NULL, NULL)` unreachable on every scope. Add the constraint with a
row-count report anyway, copying `2026-07-01-alert-rules-partner-ownership.sql:38-48` — the
guarded `DO $$ … pg_constraint` existence check plus
`CHECK ((org_id IS NULL) <> (partner_id IS NULL))`, the form seventeen tables already use.

### 2.3 The partner-wide gate — a behavioural change, not just hardening

`routes/customFields.ts` create/update/delete carry `requireMfa()` and permission checks but
**no `canManagePartnerWidePolicies`** — the same gap as #3262 for scripts. A bulk import
creating partner-wide definitions is the widest write in the product, so this must land
before the importer, not after.

But it cannot land alone. Because the web create modal never sends ownership, partner-scoped
users fall through to `partnerId = auth.partnerId` with `org_id` null — so **in practice
essentially every custom field an MSP has today is partner-wide**. `canManagePartnerWidePolicies`
requires `partnerOrgAccess === 'all'` (`services/partnerWideAccess.ts:25-29`), so adding it
outright stops ordinary techs with `orgAccess='selected'` from doing what they do today,
through the ordinary UI. A bare 403 is a support ticket, not hardening.

Ship it with the full #2135 playbook step 6: a create-only `ownerScope` selector and an
"All orgs" badge (pattern: `components/software/PolicyForm.tsx`), plus a
`customFieldDefinitionsPartnerRls.integration.test.ts` suite.

### 2.4 Value-vs-declared-type validation — a security control, not a nicety

Nothing anywhere validates a value against its definition. `customFieldValueSchema`
(`customFieldValues.ts:68-75`) and `updateDeviceSchema.customFields`
(`routes/devices/schemas.ts:104`) both accept an unconstrained
`Record<string, string|number|boolean|null>`. No code branches on `type`; `options.choices`,
`min`/`max`, `required`, and "does this `fieldKey` exist at all" are unenforced.

This matters more than it looks, because custom-field values are **both an execution sink
and a targeting control**:

- `installerVariables.ts:30,51-53` substitutes `{{device.customField.<key>}}` into installer
  command lines, which flow through `softwareDeployment.ts` → `queueCommand` →
  `sendCommandToAgent` and execute on the endpoint.
- `filterEngine`'s `custom.<key>` path feeds `services/groupMembership.ts` **and**
  `services/deploymentTargetResolver.ts`, consumed by `deploymentEngine.ts`, `routes/software.ts`
  and `services/automationRuntime.ts` — so values **select which devices receive software
  installs and automation runs.**

Bulk-loading 300k unvalidated strings from a competitor's export into that surface is a mass
injection *and* mass mis-targeting vector.

A shared `validateCustomFieldValue(definition, value)` must therefore be applied to **the two
existing write paths as well as the importer** — otherwise the importer is validated and the
trivially scriptable API-key path beside it is not.

---

## 3. Mapping targets — not every UDF belongs in a custom field

The issue names warranty expiry first. Breeze already has `device_warranty`
(`db/schema/warranty.ts:28-51`): one row per device (`deviceIdIdx` unique), typed
`warranty_start_date` / `warranty_end_date`, a `status` enum, an index on the end date, and a
`data_source` column defaulting to `'provider'` — an `'import'` source is an already-designed
extension point. It is consumed by `warrantyAlertEvaluator.ts`, `warrantySync.ts`,
`routes/devices/warranty.ts`, `routes/partnerApi/inventory.ts` and the Dell/Lenovo/HP
integrations. `filterEngine` has no warranty field at all.

So importing warranty expiry into a custom field ships the flagship use case **inert**: no
alert fires, the warranty dashboard and partner inventory export stay empty, and it is not
even filterable as a first-class field.

The importer therefore takes a **mapping target** per column, not a field key:

```ts
type MappingTarget =
  | { kind: 'customField'; fieldKey: string }
  | { kind: 'warranty'; field: 'warrantyEndDate' | 'warrantyStartDate' | 'manufacturer' };
```

v1 supports `customField` and `warranty` (writing `data_source: 'import'`, never clobbering a
row whose `data_source = 'provider'` without an explicit opt-in — a provider lookup is more
trustworthy than a hand-typed CSV). Other first-class targets are additive later.

---

## 4. Resolving a row to a device

Resolution order, **always within one organization**, first hit wins:

1. **explicit `deviceId`** — authoritative.
2. **`serialNumber`** → `device_hardware.serial_number`.
3. **`hostname`** → `devices.hostname`, case-insensitive.

0 matches → `not-found`. More than 1 → `ambiguous`. **Never guess.**

**Junk serials are already in the database.** The denylist does not need inventing — the agent
has one: `cleanHardwareIdentityValue()` (`agent/internal/collectors/hardware.go:156-190`)
covering `"default string"`, `"none"`, `"system serial number"`, `"to be filled by"`, `"o.e.m"`,
all-zeros. But it is applied **only on Windows** (`hardware_windows.go:136`); Linux
(`hardware_linux.go:35`) and macOS (`hardware_darwin.go:46`) write raw DMI/IOKit values
through. So: port that exact list to a shared TS constant rather than authoring a second,
divergent one, and **apply it to the DB side of the join as well as the CSV side** — otherwise
every Linux box reporting `Default string` collapses into one giant ambiguous match group.

**Hostname ambiguity will be common, not rare.** `devices.hostname` is not unique per org by
design, and `possible_replacement_of_device_id` (`db/schema/devices.ts:159`) plus the
enrollment path exist because re-imaged and replaced machines legitimately produce several
rows — exactly the machines an MSP most wants backfilled. Rather than dead-ending those rows,
preview surfaces the candidates ranked by the collision priority chain enrollment already uses
(token-authenticated > online > non-decommissioned > oldest, `enrollment.ts:514-518`) and the
operator acknowledges one. The rule stays "never auto-pick"; the UI stops being a dead end.

**Devices that enroll after the backfill are stranded.** There is no `external_id` on `devices`
and no incumbent-RMM identity recorded at enrollment, so a late device has no re-match key.
Mitigation in v1 is that the import is cheap to re-run (idempotent). Recording an incumbent
identity at enrollment so backfill can be applied on arrival — the pattern
`modules/mcpInvites/matchInviteOnEnrollment.ts:28-54` uses for `deployment_invites` — is
deferred and worth filing.

---

## 5. Authorization and tenant isolation

Both value routes: `requireScope('partner','system')` + `requireOrgWrite` + `requireMfa()`,
matching the org importer (`routes/orgs.ts:1386,1399`). Partner-scoped and multi-org per
request: a Datto or Automate export is inherently partner-wide with a company column, and
forcing one CSV per org would mean 200 uploads for a mid-size MSP with no safety return.

**Safety comes from per-row authorization, not from the request shape — and RLS is not the
backstop here.** Resolving devices across orgs requires system DB context, and
`breeze_has_org_access` short-circuits to `TRUE` for system scope
(`0001-baseline.sql:1663-1671`). Every isolation guarantee on this path is app-layer. Therefore:

- every resolved device is re-checked against the caller's accessible orgs, per row;
- **site restrictions apply.** `allowedSiteIds` is populated only on the org axis
  (`services/permissions.ts:171`; the partner axis at `:182-185` never sets it), so a
  site-restricted org user must be gated with `canAccessSite(perms, device.siteId)`
  (`services/permissions.ts`, re-exported via `middleware/auth.ts:4`) — it returns a plain
  boolean, so the caller must fail closed on `false`;
- **the importer does not accept `X-API-Key`.** The existing value route's `dualAuth` applies
  `requireMfa` only on the JWT branch and deliberately skips the site allowlist for API keys.
  A bulk backfill is exactly the operation that should require MFA and honour site limits;
- do **not** reuse `getDeviceWithOrgCheck` (`routes/devices/helpers.ts:83-113`) naively — it
  selects with no org predicate and checks in JS afterward, which is fine under RLS and is the
  *only* check under a system context;
- a cross-partner forge integration test proves it, rather than an appeal to RLS.

---

## 6. Batching — the constraint that sets the row cap

`breeze_partner_export_devices_update()` is an `AFTER UPDATE … FOR EACH STATEMENT` trigger on
`devices` whose change tuple **includes `custom_fields`** (`2026-07-18-partner-export-org-locks.sql:320-336`).
On any custom-field change it calls `breeze_partner_export_lock_orgs_exclusive(org_ids)` →
`pg_advisory_xact_lock(1000201, hashtext(org_id))` (`:339`, `:147`) — an **exclusive,
transaction-scoped advisory lock per org, released only at COMMIT** — then issues a second
`UPDATE devices`. A second statement trigger,
`breeze_partner_export_z_custom_values_update` (`2026-07-31-device-custom-value-move-owners.sql:44-49`),
takes partner-exclusive and org locks on the same condition.

A single large transaction therefore holds exclusive locks on every touched org for its whole
duration, blocking heartbeats, enrollment, and every other device write for those orgs.

So: **1000 rows per request** (matching `MAX_IMPORT_ROWS`, `orgImport/index.ts:47` — not the
5000 an earlier draft proposed), and commit **one transaction per org-chunk** within the
request, never one transaction for the whole import. Chunks are independent and idempotent, so
the web UI chunks a large file and reports cumulative progress. Under Option B the projection
trigger keeps the same locks in play, so this holds either way.

---

## 7. Field keys, reserved names, and preview semantics

**snake_case only.** `createCustomFieldSchema.fieldKey` enforces `/^[a-z][a-z0-9_]*$/` and
`CUSTOM_FIELD_KEY_PATTERN` (`filterEngine.ts:43`) is the same, so a camelCase key can be *read*
but never created or filtered. Commit to snake_case explicitly.

**`asset_tag` is a reserved key with a live consumer.** `routes/partnerApi/devices.ts:123-125`
derives `stableIdentifiers.assetTag` from `['assetTag','asset_tag']`, and likewise
`inventoryId`/`externalId`. Asset tag is one of the five fields the issue names. Decision:
importing to `asset_tag` **does** populate the partner-API `stableIdentifiers` contract, and
that is intended — but the preview must say so on the row, because it silently changes a
partner-integration identity field fleet-wide. The importer warns on any mapping to
`asset_tag`, `inventory_id`, or `external_id`.

**Preview → commit** mirrors `orgImport` exactly, including TOCTOU re-derivation
(`checkExpectation`, `orgImport/index.ts:407-448`): commit re-derives every annotation against
fresh state and rejects any row whose annotation changed since preview, with identity pinning
so an acknowledgement cannot transfer to a different device. Annotations:

`matched | ambiguous | not-found | no-definition | type-error | reserved-key | already-set`

Only `matched` commits. `ambiguous` commits only with an acknowledged `deviceId`.

**Idempotency** is overwrite-on-rerun: under Option A the jsonb merge already gives it; under
Option B the `UNIQUE (device_id, definition_id)` upsert does.

**Statefulness:** the flow is stateless with a client-held acknowledgement, exactly like
`orgImport` (which writes audits only, `services/orgImport/audit.ts`). If a persisted import-job
record is added later it will carry `org_id`, and it must then land in
`CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, and RLS policies in the same PR —
the contract CLAUDE.md records as having shipped broken five times.

---

## 8. Scope — device-level only in v1

Automate and N-central both carry org/site-level custom fields, and the issue names them. They
are deferred because there is genuinely nowhere to put them: `custom_field_definitions` has no
site axis, and organizations/sites carry only a generic `settings` jsonb with no value home.
Adding both is a second data-model change and belongs in its own issue.

This is a narrower gap than it looks now that §3 exists: the most valuable org/site-level fields
in practice (contract reference, account manager) are closer to contact and contract data —
which #3258 and the existing contracts module already model — than to device UDFs.

---

## 9. Known-inert surfaces to flag, not fix

After a 300k-value import, **no dynamic group re-evaluates**, for two independent reasons:

1. `events/deviceEvents.ts:114` maps `customFields → 'custom'`, while `filterEngine.ts:685-687`
   records the verbatim `custom.<key>`. The group lookup is an array overlap
   (`deviceEvents.ts:78`), and `'custom'` never overlaps `'custom.warranty_expiry'`.
2. `initializeDeviceEventHandlers` (`deviceEvents.ts:170`) has **no caller anywhere** in
   `apps/api/src`; `emitDeviceChange` / `onDeviceChange` are never called outside their own file.
   The whole device-change → `updateDeviceMemberships` pipeline is unwired.

This is pre-existing and out of scope, but it must be stated: without a post-commit group
recompute, imported values do not affect targeting until something else touches the device.
File it.

Two more worth one line each so they are decisions rather than discoveries:

- **MCP/AI exposure.** `customFields` is in `SAFE_DEVICE_RESOURCE_FIELDS` (`mcpServer.ts:1875`),
  so every imported value is exposed to the `breeze://devices/{id}` MCP resource on landing.
- **Secret-scanning at volume.** `custom-field-values` is classified `'customer-authored'`
  (`partnerApi/exportSafety.classification.ts:46`). A competitor's UDF dump is a plausible way
  for credentials to arrive in bulk into a store whose own route header warns it is
  "NOT A SECRETS STORE". Confirm the heuristic does not false-positive at volume and block a
  partner export.

---

## 10. Web UI

A "Backfill custom fields" utility beside the device list, modelled on
`components/organizations/BulkOrgImport.tsx`: drag-drop CSV → client-side parse
(`lib/csvParse.ts`) → column mapping (each column choosing a **mapping target** per §3, plus the
join-key column) → preview table with per-row status badges → commit in chunks with progress.

`ambiguous` rows expand to show the candidate devices ranked per §4 and require an explicit
pick; select-all spans only `matched`, matching the existing guard that a bulk toggle must never
opt hundreds of rows into a fuzzy match. Results surface through `runAction` including partial
success.

A **definitions** import step precedes it in the same utility: upload the incumbent's field
list, choose org-wide or partner-wide ownership (gated per §2.3), preview `create` /
`already-exists` / `type-conflict` — `type` is immutable on update today, so a re-import with a
different type is a conflict, never a silent change.

---

## 11. Testing

- **Resolution**: explicit id wins; serial beats hostname; junk serials excluded on **both**
  sides of the join; hostname collision yields ranked candidates and refuses to auto-pick;
  cross-org hostname collision never resolves outside the caller's orgs.
- **Isolation**: a cross-partner forge under system DB context is rejected by the app layer —
  the test must not rely on RLS, which returns TRUE in system scope.
- **Site gating**: a site-restricted org user cannot backfill a device outside their sites.
- **Auth**: `X-API-Key` is rejected on both import routes; MFA required.
- **Validation**: a `number` field rejects `"abc"`; a `dropdown` rejects a value outside
  `options.choices`; an unknown `fieldKey` annotates `no-definition`; and the same validation
  applies to `PATCH /devices/:id/custom-fields` and `PATCH /devices/:id`.
- **Idempotency**: re-running an identical import changes nothing and reports every row as
  `already-set`.
- **Batching**: an import spanning three orgs commits three transactions, and no transaction
  spans more than one org's advisory lock.
- **Prerequisites**: the duplicate-`field_key` migration fails loudly with a count when
  duplicates exist and is a no-op when they do not; the XOR constraint rejects `(NULL,NULL)` and
  `(set,set)`; a tech with `orgAccess='selected'` cannot create a partner-wide definition and
  the UI hides the option.
- **Warranty target**: an imported `warranty_end_date` makes `warrantyAlertEvaluator` fire and
  appears in `routes/partnerApi/inventory.ts`; a `data_source='provider'` row is not clobbered
  without opt-in.
- **Contracts**: RLS coverage, org cascade, device cascade
  (`CORE_DEVICE_CASCADE_DELETE_TABLES` **and** `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, since the
  table carries `device_id` and a denormalized `org_id`), export policy, erasure roundtrip.
- **Projection**: a value write updates both the table and `devices.custom_fields`,
  and still bumps `partner_export_updated_at`.

---

## Deferred

| Item | Why not now | Tracked by |
|---|---|---|
| **Org/site-level custom fields** | No site axis on definitions, no value home. §8. | Not filed |
| **Incumbent identity at enrollment** so late-enrolling devices get backfilled on arrival | Needs an enrollment-path change; pattern exists (`matchInviteOnEnrollment.ts`). §4. | Not filed |
| **Dynamic-group recompute after import** | The whole device-change pipeline is unwired. §9. | Not filed |
| **Per-key expression indexes** | Moot — Option B replaces the scan with a B-tree. | Not filed |
| **More first-class mapping targets** (asset tag → a real column, primary user → `devices.last_user`) | Additive once §3's target model exists. | Not filed |

### Explicitly not planned

- **Importing values for devices that do not exist.** Devices arrive by enrollment; a value with
  no device is not data, it is a pending join with no expiry.
- **Changing a definition's `type` on re-import.** Immutable today; a conflict, not a silent cast.
