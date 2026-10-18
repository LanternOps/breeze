---
title: Bulk edit tags and custom field values from the device list
status: approved 2026-10-17. Every decision approved as recommended (§6). Advisor quorum (Fable position + Codex gpt-6-astra xhigh, read-only) folded in; the two disagreements (OD-4, OD-5) were resolved by the owner (§9).
date: 2026-10-15
issues: "#8833 (this spec)"
related: "#8832 (tag and custom-field writes never schedule dynamic-group re-evaluation; hard dependency), #8837 (tag registry; the picker must accept it later), #8835 (assigned contact) and #8836 (asset lifecycle state), which will each want a bulk 'set X' action"
---

# Bulk edit tags and custom field values

All file:line references were re-verified against `origin/main` at `601877a6ef` (2026-10-15).

## 1. Problem

A customer evaluating Breeze for asset and inventory management (2026-10-15) wanted to classify
many devices at once, for example "mark these 40 as pending destruction" or "tag everything at
this site finance-dept". Breeze cannot do that today.

- **The bulk menu has no classification actions.** `DeviceList.tsx:2932-3090` offers reboot, send
  message, run script, deploy software, maintenance on/off, wake, compare, link multiboot / VM
  host, remove and delete manual asset. Removed selections get restore and permanent delete.
  Dispatch goes `DevicesPage.tsx:1602` (`handleBulkAction`) → `runBulkAction` (`:1729`).
- **No bulk write route exists for either attribute.** The device bulk routes are
  `POST /devices/bulk/commands` and `/bulk/maintenance` (`routes/devices/commands.ts:51,330`), plus
  `/bulk/restore` and `/bulk/permanent-delete` (`routes/devices/bulkLifecycle.ts:93,201`).
- **Tags are written by whole-array replace.** `PATCH /devices/:id` sets `updates.tags = data.tags`
  (`routes/devices/core.ts:2220`). When two technicians edit the same device, one edit is lost.
  Adding one tag to 40 devices takes 40 read-modify-write round trips from the browser. The
  validator is `tags: z.array(z.string())`, with no bound on length or count (`schemas.ts:212`).
- **Custom field values are written one device at a time.** The write paths are
  `PATCH /devices/:id/custom-fields` (`customFieldValues.ts:200-313`), the custom-field branch of
  `PATCH /devices/:id` (`core.ts:2158-2176`), the CSV importer (`customFieldImport.ts`, which matches
  by serial or hostname and is MFA-gated) and script write-back. None of them supports "select
  rows, set value".
- **The AI cannot do it either.** `manage_tags` adds or removes tags on exactly one `deviceId`
  (`services/aiToolsDevice.ts:725-830`). It is rate-limited to 20 calls per 5 minutes
  (`aiToolRateLimits.ts:110`), writes no route audit row and schedules no group re-evaluation.
- **Dynamic groups go stale.** None of the tag or custom-field write paths call
  `requestDeviceGroupReevaluation` (`jobs/deviceGroupJobs.ts:246`). #8832 fixes the existing paths.
  The bulk routes must not become a new path with the same bug.

## 2. Users and scope

| User | What they can do |
|---|---|
| Org-scope technician with `devices:write` | Bulk-edit devices in their org, limited to the sites in `allowedSiteIds` when site-restricted. |
| Partner-scope technician with `devices:write` | Bulk-edit a selection spanning several customer orgs. Limited to the orgs `canAccessOrg` allows (including `org_access = 'selected'`) and to `allowedSiteIds`. |
| System scope | Same routes, no special casing. A cross-partner selection is possible here, and §4.1 handles it. |
| Portal (customer) users, API keys, Partner API | Not in v1 (§5). |

**Cross-org selections are normal.** The partner device list spans orgs, so a select-all on a
filtered page routinely mixes customers. This has three consequences:

- Tags are free text with no per-org meaning, so a cross-org tag edit applies the same way to
  every device.
- Custom field **definitions belong to an owner**, either one org or the whole partner
  (`custom_field_definitions` is org XOR partner). Visibility is resolved per org by
  `loadVisibleCustomFieldDefinitions` (`services/customFields/queries.ts:76-106`). Within one
  partner, a key cannot be both partner-wide and org-owned
  (`migrations/2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql`). Across orgs, the same
  key can still be two different org-owned definitions with different types or dropdown options.
  The route therefore resolves and validates **per org**, and the dialog checks type compatibility
  up front (§4.3, §4.5).
- Definitions can be restricted to device OS types (`deviceTypes`), so validation runs per
  `(orgId, osType)` group.

**Eligible rows.** v1 covers agent devices (`devices` rows) in every selection kind: active, mixed
**and removed**. Tagging a removed device "disposed" is exactly the customer's use case, and
`PATCH /devices/:id` already accepts decommissioned devices.

- Network rows (`discovered_assets`) are skipped client-side and shown with the existing
  "N of M eligible" note (`DeviceList.tsx:1296-1309`).
- Manual assets are OD-4.
- Devices in the unassigned holding org (`notParkedDeviceCondition`,
  `services/unassignedPool/selectorPredicate.ts:36`) and ephemeral Quick Support devices are
  refused with `NOT_FOUND`. The device list hides them (`core.ts:1115`), but
  `getDevicesWithOrgAndSiteCheck` does not, so the bulk helper must exclude them itself.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Two routes, `POST /devices/bulk/tags` and `POST /devices/bulk/custom-fields`, built on one internal helper. No generic "set attribute" route (OD-1). | Each attribute has its own validation, permission bar and audit action. |
| D2 | Gate both routes with `devices:write` + `requireMfa()`, the same as `PATCH /devices/:id` (`core.ts:2102-2103`). | A 500-device edit must not sit behind a weaker gate than the one-device edit (`bulkLifecycle.ts:11-13`). `requireMfa` enforces tenant MFA policy. It does not force a fresh MFA challenge (`middleware/auth.ts:1031`). |
| D3 | Cap the selection at 500 (`BULK_LIFECYCLE_MAX_DEVICES`, `schemas.ts:450`). The server deduplicates ids. | Every other device bulk route uses the same cap. The deploy action's 200 cap (`DevicesPage.tsx:1744-1751`) exists because of URL length and does not apply to a POST body. |
| D4 | Tags support add and remove only, never replace. The new array is computed with array operators from the **locked** current value. | No client-side read-modify-write, so concurrent bulk editors cannot overwrite each other (§4.2). |
| D5 | Custom fields: one field per request, with a value or `null` (clear). | This matches the dialog. It also keeps each failure code tied to one field. |
| D6 | Verdicts are per device and a request can partly succeed. The route answers `200 { succeeded, failed }` even when every device failed. | `/bulk/restore` and `/bulk/maintenance` already use this contract. The web reads the body, not the status (`DevicesPage.tsx:1549-1559`). |
| D7 | The write phase opens **one short transaction per org, in ascending org UUID order**. Each transaction runs one set-based statement. The routes opt out of the ambient request transaction (`middleware/selfManagedDbContextRoutes.ts`). | Partner-export lock guards reject org locks taken in descending order, and partner locks taken after org locks (§4.4). Per-org transactions satisfy both rules, including for cross-partner system-scope selections. They also keep row locks short. |
| D8 | Writes are idempotent: re-sending the same request changes nothing and reports `changed: false`. No idempotency key. | Add and remove are set operations. The custom-field upsert already skips unchanged rows with `IS DISTINCT FROM` (`queries.ts:252-256`). |
| D9 | One audit event per **changed** device, none for unchanged devices. Audit and re-evaluation run after commit (`runAfterDbContextCommit`, `db/index.ts:858`). | The importer follows the same rule (`services/customFields/import/audit.ts:19-21`): re-runs must not bury the real writes. Neither must be announced for a transaction that rolled back. |
| D10 | Call `requestDeviceGroupReevaluation` once per changed device, without awaiting it. | Required by #8832. The job is coalesced per device (`deviceGroupJobs.ts:153-200`), so this is cheap. |
| D11 | No new tables, columns, migrations or RLS policies. | The writes touch `devices.tags` and `device_custom_field_values`, which are already org-scoped with forced RLS. |
| D12 | Tags to **add** are trimmed and lowercased. Tags to **remove** are matched exactly as stored. | Lowercased adds match the UI (`DeviceSettingsModal.tsx:53`) and stop new `Finance`/`finance` splits. Exact removal keeps legacy mixed-case tags such as `VIP` removable (Codex). The repo-wide rule belongs to #8837 (OD-6). |

## 4. Proposed design

### 4.1 Shared route skeleton

Both routes live in a new `apps/api/src/routes/devices/bulkAttributes.ts`.

- **Mounting.** The router is mounted in `routes/devices/index.ts` after the API-key-compatible
  routers (`customFieldValuesRoutes`, `customFieldImportRoutes`, `:58-72`) and **before
  `coreRoutes`**. `/bulk/*` is a static path that `/:id` would otherwise capture.
- **Auth.** Auth middleware is attached per route, never with `.use('*')`, so it cannot shadow an
  API-key branch.
- **Tests.** `bulkAttributes.mountorder.test.ts` mirrors `bulkLifecycle.mountorder.test.ts`.
- **Transactions.** Both paths are added to `selfManagedDbContextRoutes`, the same treatment
  `/bulk/restore` gets.

The shared helper is `services/devices/bulkAttributeWrite.ts`:

1. **Dedupe** `deviceIds`.
2. **Authorise** the whole selection in one short RLS-scoped read with
   `getDevicesWithOrgAndSiteCheck` (`helpers.ts:261`). This applies the same `ensureOrgAccess` /
   `canAccessSite` verdicts as the single-device chokepoint. Holding-org and ephemeral devices
   become `NOT_FOUND`.
3. **Group** the authorised devices by `orgId` and sort the groups by org UUID, ascending.
4. **Write each org in its own transaction** with `withDbAccessContext(ctx, …)` and the caller's
   RLS context. The attribute writer locks only rows that still match the **verified** `(id,
   org_id, site_id)` (and `os_type` for custom fields), using `SELECT … FOR UPDATE` or a locking CTE
   in the same statement. It then writes and returns, per device, the old and new value.
   - A verified device that the locked read no longer finds (moved, deleted or re-sited since the
     check) is reported as `STATE_CHANGED`, never as unchanged.
5. **After each org's commit**, write that org's audit events and re-evaluation requests.
6. **Respond:**

```ts
{
  bulkId: string;                 // uuid, stamped on every audit event of this request
  succeeded: Array<{ deviceId: string; changed: boolean }>;
  failed: Array<{ deviceId: string; code: BulkAttributeFailCode; message: string; fieldKey?: string }>;
}
type BulkAttributeFailCode =
  | 'NOT_FOUND' | 'SITE_ACCESS_DENIED' | 'STATE_CHANGED'                // authorisation / race
  | 'UNKNOWN_FIELD' | 'NOT_APPLICABLE_TO_DEVICE' | 'INVALID_VALUE'      // custom fields only
  | 'ERROR';                                                            // this org's transaction failed
```

**Failure granularity.** Access and validation failures apply to individual devices. A
Postgres-level failure rolls back that **one org's** transaction, and every device in that org is
reported `ERROR`. Orgs that already committed stay committed and are reported as they are. The
error is logged server-side with the org id; a device is never silently dropped.

**Request-level failures** reject the whole request with a 4xx: a malformed body, more than 500
ids, a tag in both `add` and `remove`, missing MFA or a missing permission.

### 4.2 `POST /devices/bulk/tags`

```ts
{
  deviceIds: uuid[1..500],
  add:    string[0..50],   // trimmed, lowercased, 1..100 chars, no control characters
  remove: string[0..50],   // matched exactly as stored; 1..1000 chars so legacy long tags stay removable
}
// refine: add.length + remove.length >= 1; no string in both lists after normalising add → 400
```

For each org, inside its transaction, the writer runs one statement:

```sql
WITH locked AS (
  SELECT id, COALESCE(tags, '{}') AS old_tags
    FROM devices
   WHERE id = ANY($ids) AND org_id = $orgId AND site_id = ANY($verifiedSiteIds)
   FOR UPDATE
), computed AS (
  SELECT id, old_tags,
         ARRAY(SELECT t FROM unnest(old_tags) WITH ORDINALITY u(t, o)
                WHERE NOT (t = ANY($remove)) ORDER BY o)
      || ARRAY(SELECT a FROM unnest($add) WITH ORDINALITY x(a, o)
                WHERE NOT (a = ANY(old_tags)) ORDER BY o) AS new_tags
    FROM locked
)
UPDATE devices d SET tags = c.new_tags, updated_at = now()
  FROM computed c
 WHERE d.id = c.id AND c.new_tags IS DISTINCT FROM c.old_tags
RETURNING d.id, c.old_tags, c.new_tags;
```

The plan pins the per-device site check exactly (pairing each id with its verified site rather
than `site_id = ANY(...)`). The ids in `locked` but not in `RETURNING` are `changed: false`. The
verified ids missing from `locked` are `STATE_CHANGED`.

- **Concurrency.** The new array comes from the value read under `FOR UPDATE`, so two technicians
  adding different tags to the same device both win, in lock order. A later whole-array `PATCH
  /devices/:id` can still overwrite a bulk edit (Codex). That is a property of `PATCH`, and #8837
  is the place to move `PATCH` to add/remove deltas.
- **Arrays are bound per element** as `ARRAY[$1, $2, ...]::text[]`. Never write `${arr}::text[]`:
  Drizzle spreads it into a row constructor that Postgres rejects (`aiToolsDevice.ts:806-808`,
  #8297).
- **Why not `runBulkIsolated` per device.** `runBulkIsolated` (`lib/bulkOps.ts`) is for per-item
  work that can be slow or fail on its own; restore, for example, admits each device against the
  partner device limit. A tag edit has no per-device business rule after authorisation, so 500
  transactions would do the work of one fast statement per org.
- **Audit.** One `writeRouteAudit` event per changed device: `action: 'device.tags.update'`,
  `details: { added, removed, bulk: true, bulkId }`. `added` and `removed` are the **actual** delta,
  computed from `old_tags`/`new_tags`, not the requested lists. Tags are not sensitive, so the values
  are recorded.
- **Re-evaluation.** `changedFields: ['tags']`, `reason: 'device.tags.bulk_update'`.

### 4.3 `POST /devices/bulk/custom-fields`

```ts
{
  deviceIds: uuid[1..500],
  fieldKey: string(1..100),
  expectedType: 'text' | 'number' | 'boolean' | 'dropdown' | 'date',
  value: string(≤10000) | number | boolean | null,
}
```

1. **Authorise** (§4.1).
2. **Validate per group.** Group the authorised devices by `(orgId, osType)` and call
   `validateCustomFieldMap(orgId, osType, { [fieldKey]: value })`
   (`services/customFields/validateValueMap.ts:44`) once per group. Load the definition list once
   per **org** and reuse it across that org's OS-type groups; each call reloads today, so the helper
   memoises it.
3. **Check type compatibility.** If an org's matched definition has a type other than
   `expectedType`, every device in that org fails with `INVALID_VALUE` and
   `message: 'definition type differs in this organization'`. This stops a value from being coerced
   into a different-typed field that happens to share the key.
4. **Map rejections to codes.** A failing group applies its reason to every device in the group:
   `unknown_field` → `UNKNOWN_FIELD`, `not_applicable_to_device` → `NOT_APPLICABLE_TO_DEVICE`, and
   anything from `validateCustomFieldValue` → `INVALID_VALUE`.
5. **Upsert per org.** Inside the org's transaction, lock the passing devices pinned to `(id,
   org_id, site_id, os_type)`. Then upsert with **one** multi-row
   `INSERT … SELECT FROM unnest(...) ON CONFLICT (device_id, definition_id) DO UPDATE … WHERE
   <IS DISTINCT FROM guard> RETURNING device_id`.
   - This is `persistDeviceCustomFieldValues` (`queries.ts:228-262`) generalised from one device to
     N. It stays in the same module so both callers share `valueColumnsFor` and the distinct-guard.
   - `source` is `'manual'`.
   - The statement-level projection trigger
     (`migrations/2026-10-11-160000-device-custom-field-values.sql`, `breeze_device_custom_field_project`)
     rebuilds `devices.custom_fields` with a single `UPDATE`. The route never writes the jsonb.
6. **`null` is a stored explicit clear** (all value columns null, `queries.ts:171`), not a deletion.
   This matches the single-device path. The device page currently shows a definition's default for
   a null value (`DeviceInfoTab.tsx:1485-1486`, Codex); W2 fixes that before the editor is shared.
7. **Audit.** One event per changed device, with `action: 'device.custom_field.update'` (the same
   action as the single path, so existing filters find it) and
   `details: { changedFields: [fieldKey], bulk: true, bulkId }`, plus `value` when the definition
   type is `dropdown`, `boolean` or `date` (OD-5 = B).
8. **Re-evaluation.** `changedFields: ['custom.<fieldKey>']`. This is the spelling
   `filterEngine.ts:63-66,331` parses, and `mapChangedFieldsToFilterFields` passes dotted names
   through unchanged (`events/deviceEvents.ts:180-183`). #8832 owns confirming the overlap check
   end to end.

The single-device `PATCH` is all-or-nothing per request, because one PATCH is one operator action
(`validateValueMap.ts:33-37`). The bulk route can partly succeed **across devices** but is
all-or-nothing **for each device**. It is the same contract applied N times.

**Why custom fields need care.** Custom-field values are substituted into installer command lines
(`services/installerVariables.ts:8,46-48`), and they cannot drive execution targeting as group
rules (`filterEngine.ts:217,281-286`). The bulk route does not widen who can write them: the
permission, MFA and validation are unchanged. It does widen how fast a mistake spreads, which is
why the dialog confirms the scope before sending (§4.5).

**Audit delivery is weaker than the single-device path.** `PATCH /devices/:id/custom-fields`
awaits `createAuditLog` and returns 500 if the audit row did not land (`customFieldValues.ts:284-305`).
The bulk route fans out after commit through the audit queue, which retries a bounded number of
times and can drop events (`services/auditService.ts:59`). This is the importer's posture. The
trade is deliberate: awaiting 500 inserts inside the write would hold the org lock far longer. The
plan records the trade in the route's header comment.

### 4.4 Tenancy, RLS and data-model impact

- **No new tables, migration or columns.** Nothing needs registering in
  `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` or `CORE_TENANT_EXPORT_POLICY`.
- **RLS is the backstop, not the gate.** Every transaction runs under the caller's
  `withDbAccessContext`. `devices` (shape 1, direct `org_id`) and `device_custom_field_values`
  (direct `org_id`, RLS created in `migrations/2026-10-11-160000-device-custom-field-values.sql`)
  already hide other tenants' rows. The application check in §4.1 is still required, because RLS
  does not enforce the **site** axis or partner `org_access = 'selected'`.
- **Writes are pinned to verified rows.** The locked read filters on the ids, org and site that the
  access check approved, never on the raw request list. A device that moved between check and write
  is `STATE_CHANGED` and is not written (Codex).
- **Partner-export lock ordering is the reason for per-org transactions.** `devices` carries
  statement-level partner-export triggers, for example `breeze_partner_export_custom_values_update`
  (`migrations/2026-07-24-partner-export-configuration-material-state.sql:410-413`) and the
  relationship-owner triggers (`2026-07-20-partner-export-reconstruction-material-state.sql:386-393`).
  The lock helpers they reach enforce two rules:
  - Org locks must be taken in ascending UUID order within a transaction
    (`2026-07-22-partner-export-lock-upgrade-hardening.sql:107-111`).
  - No new partner lock may follow an org lock
    (`2026-07-22-z-partner-export-lock-key-collision-hardening.sql:35-39`).

  One statement sorts its own org set (`:84`). Several statements in one transaction across orgs
  can violate either rule, and an `ON CONFLICT DO UPDATE` upsert fires both the INSERT and UPDATE
  statement triggers. Per-org transactions in ascending order satisfy both rules by construction.
  The integration tests in §7 prove it with a two-org and a two-partner selection. Which of these
  triggers actually acquire locks on a tags-only update was not traced here. The plan should not
  depend on the answer.
- **Execution targeting is unaffected.** `tags` and `custom.*` are both in the execution-refused
  set (`filterEngine.ts:214,217,252-276,286`). A bulk edit can move devices into or out of dynamic
  groups, but it cannot make a group a script, policy or update-ring target.

### 4.5 Web

**Bulk menu.** Two entries go in a new block above the destructive section of `DeviceList.tsx`.
They appear for active, mixed **and** removed selections, so the removed block (`:3068-3088`) gets
them too:

- `Edit tags…` (`data-testid="bulk-edit-tags"`)
- `Set custom field…` (`data-testid="bulk-set-custom-field"`)

Gating rules for both entries:

- They are not agent-gated (`agentOnlyDisabled` does not apply).
- They show the "N of M eligible" suffix when the selection contains network rows (or manual rows,
  depending on OD-4).
- Both action strings go into `INTENTIONALLY_UNGATED_BULK_ACTIONS` (`bulkActionGating.ts:130`), so
  the contract test in `DeviceList.test.tsx` that binds the gating sets to the emitted actions stays
  honest.
- The entries are hidden from users without `devices:write`.

**Edit tags dialog** (`BulkEditTagsDialog.tsx`):

- The header names the scope, for example "Edit tags on 40 devices in 3 organizations".
- There are two chip inputs, **Add** and **Remove**.
  - Add suggestions come from a `TagSource` prop. In v1 it reads `GET /tags` (`routes/tags.ts:77`),
    which is already org- and site-scoped. #8837 swaps in a registry-backed source (colors,
    canonical names) without changing the dialog.
  - Add input is trimmed and lowercased as the user types.
  - Remove suggestions are the tags **actually present on the selection**, exactly as stored, with
    counts (for example "VIP — 31 of 40"). They are computed client-side from the loaded rows.

**Set custom field dialog** (`BulkSetCustomFieldDialog.tsx`):

- **Definition picker.** Definitions come from `GET /custom-fields`, the same source
  `CustomFieldValueImportStep.tsx:177` uses. That route accepts but ignores `orgId`/`deviceType`
  filters (`routes/customFields.ts:221-240`, Codex), so applicability is computed **client-side**
  from each definition's `orgId`/`partnerId`/`deviceTypes` against the selected rows.
  - Each option shows how many selected devices it applies to.
  - Options are grouped by key. If the key has definitions of different types across the
    selection's orgs, the dialog warns and sends `expectedType` for the type the user picked. The
    other orgs' devices show as "not applicable" in the preview.
  - A definition that applies to none of the selection is disabled, with the reason.
- **Value editor.** `renderFieldEditor` (`DeviceInfoTab.tsx:734`) is extracted into a shared
  `CustomFieldValueEditor`, used by both the device page and this dialog. A dropdown renders its
  options, a date renders a date input, and so on. The null-shows-default bug is fixed in the same
  change.
- **Clear.** A "Clear value on these devices" checkbox sends `value: null`.
- **Confirm step.** It restates the scope and the pre-computed "will apply to N, M not applicable".

**Sending and reporting.**

- One request per action. The client rejects selections over 500 with a message; it never
  truncates them silently (as the deploy path does with a `console.warn`).
- The request goes through `runAction` (`lib/runAction.ts`) **without `successMessage`**, which
  always toasts success (`runAction.ts:201`, Codex). The caller builds the outcome toast from the
  body, like `reportMaintenanceEntryOutcome` (`DevicesPage.tsx:1560-1600`):
  - All succeeded: "Updated 37 devices. 3 already had these tags."
  - Partial or all failed: an error toast with failed hostnames and reasons through
    `summarizeFailedDevices` (`DevicesPage.tsx:109`).
- The list refreshes on success. Dynamic-group membership catches up about 5 seconds after commit
  (`DEVICE_GROUP_REEVALUATION_DELAY_MS`, `deviceGroupJobs.ts:229`); the toast does not mention
  groups.
- There is no progress bar. Both routes are synchronous and finish well inside a normal request
  at 500 devices (OD-3).

### 4.6 MCP and AI tools

**`manage_tags`** (`aiToolsDevice.ts:725-830`):

- **Input.** Accepts `deviceIds: uuid[1..50]` alongside the existing `deviceId`, which stays for
  back-compat; add/remove takes exactly one of the two. Both go in the schema
  (`aiToolSchemas.ts:2110-2121`) **and** in `deviceArgs: ['deviceId', 'deviceIds']`.
  `enforceDeviceArgs` (`aiTools.ts:257-277`) then checks every id and fails the whole call if any
  is out of reach. That is the right behaviour for the AI, which should not receive a partial
  result it did not ask for.
- **Shared service.** The add/remove handler calls the same service as the HTTP route, which adds
  normalisation, locked computation, audit and re-evaluation. It replaces today's add, which uses
  `array_agg(DISTINCT …)` and so reorders the array, and the per-tag `array_remove` loop.
- **Tier.** add/remove move to **Tier 3** (OD-2); `list` stays Tier 1 (`TIER1_ACTIONS`,
  `aiGuardrails.ts:258-260`). The repo's written rule is that "a tool mirroring a `requireMfa()`
  route must be at least Tier 2, and Tier 3 if the route mutates" (`aiGuardrails.ts:1779-1783`).
  Both `PATCH /devices/:id` and the new bulk route mutate and require MFA, so today's Tier 2
  `manage_tags` add/remove already breaks that rule. In chat, one approval then covers up to 50
  devices, which is better than 50 auto-executed calls.
- **MCP limits.** MCP denies Tier 3 tools unless the operator opts in
  (`routes/mcpServer.ts:1685-1692`), and it rejects device arrays that span more than one org
  (`routes/mcpExecutionOrg.ts:188-191`). Over MCP, bulk `manage_tags` is therefore single-org and
  opt-in, by design.
- **Rate limit and approval text.** The rate limit stays at 20 calls per 5 minutes. The approval
  summary (`aiGuardrails.ts:3238-3242`) learns `deviceIds`, for example "ADD tags [x] on 12
  devices".

**`set_custom_field`** is deferred (OD-7). Two things must come first: custom-field values must be
redacted from MCP tool-argument logging, because a generic `value` key does not match the secret-key
sanitizer (`routes/mcpServer.ts:2072`, `services/auditPayloadSanitizer.ts:7`), and there needs to be
a way to mark fields that feed installer variables as not AI-writable.

## 5. Out of scope

- Replace-all tag semantics in bulk ("set tags to exactly X").
- Moving `PATCH /devices/:id` from whole-array replace to deltas. That belongs with #8837.
- Bulk move to site or group, bulk display name and bulk device role.
- More than one custom field per bulk request. The body shape leaves room for a later `values` map.
- API-key (`X-API-Key`) and Partner API access to the bulk routes.
- The tag registry, colors, rename/merge and repo-wide normalisation (#8837).
- Bulk assigned contact (#8835) and bulk lifecycle state (#8836). Both reuse the helper (OD-1).
- Fixing the missing re-evaluation in the four existing write paths (#8832).
- "Select all N matching the filter" across pages. The selection is what the list has loaded.
- Undo. The audit trail records the exact delta, and reverting is another bulk edit.

## 6. Decisions (approved 2026-10-17)

The owner approved every open decision as recommended on 2026-10-17. The numbering is kept so
earlier references (OD-n) still resolve. Rejected options stay listed so the reasoning survives.

**OD-1. Per-attribute routes. Approved: A.** Per-attribute routes (`/bulk/tags`,
`/bulk/custom-fields`, later `/bulk/contact` and `/bulk/lifecycle-state`) on a shared helper. Each
route keeps its own validation, permission bar and audit action; #8836 may need a stricter gate,
because a "disposed" transition is closer to `devices:delete`, and per-route gates make that a
one-line difference. The helper holds the shared code: selection, verdicts, per-org transactions,
response, audit and re-evaluation. Rejected: B, one `POST /devices/bulk/attributes` with a
discriminated union whose permission and audit rules differ per branch (harder to review).

**OD-2. `manage_tags` tier. Approved: B.** add/remove move to Tier 3; `list` stays Tier 1. This
follows the written MFA-parity rule (`aiGuardrails.ts:1779-1783`) and also fixes the existing
single-device violation. Accepted cost: an approval click in chat, MCP access becomes opt-in, and
single-device `manage_tags` add/remove changes behaviour too (release note). Rejected: A, Tier 2
with a 50-device cap.

**OD-3. Synchronous. Approved: A.** Both routes are synchronous at the 500 cap: per-org set-based
writes with milliseconds of lock time. Revisit only if a "select all matching" mode raises the cap.
Rejected: B, a queued job with a poll endpoint like `/bulk/permanent-delete`.

**OD-4. Manual assets. Approved: A for W1–W3, plus B as W4 inside this feature.** W1–W3 cover agent
devices only; manual rows are skipped and shown with the "N of M eligible" note. W4 adds
`manualAssetIds[]` to bulk tags and writes `manual_assets.tags` with the same locked delta. Custom
fields stay agent-only (manual assets have no custom-field values table). Manual assets have their
own storage and authorisation (`manualAssetConditions`, `routes/tags.ts:42`), which is why they get a
separate wave. Codex would have deferred manual assets out of this feature; the owner kept them in,
because spare laptops and phones are exactly what an inventory customer wants to classify.

**OD-5. Custom-field values in the bulk audit event. Approved: B.** Record the value when the
definition type is `dropdown`, `boolean` or `date`; record keys only for `text` and `number`.
"Who marked these 40 as pending-destruction" is the question an asset audit asks, and keys alone
cannot answer it. Enumerations, booleans and dates cannot carry a secret. Codex preferred keys only
with no exceptions; the owner chose B. The single-device path is unchanged.

**OD-6. Tag normalisation before #8837 lands. Approved: A.** Lowercase and trim **adds** on the bulk
route and in `manage_tags`; match **removes** exactly as stored; #8837 picks the repo-wide rule and
applies it to `PATCH` too. Implementation order note: the combined implementation plan
(`docs/superpowers/plans/2026-10-17-tag-registry-and-bulk-edit.md`) lands #8837's normaliser and
lowercase backfill **before** this feature's W1, so in practice the bulk route calls #8837's
`normalizeTagList` for adds and removes, and every stored tag is already a lowercase slug when W1
ships. The decision still governs if the order ever changes. Rejected: B, trim only.

**OD-7. AI custom-field write tool. Approved: B, defer.** Not needed for #8833, and custom-field
values feed installer command lines. A follow-up issue needs two prerequisites first: values
redacted from MCP and tool-argument logging, and a way to mark installer-variable fields as not
AI-writable. Rejected: A, ship `set_custom_field` at Tier 3 with at most 50 devices.

## 7. Test and rollout notes

**Wave plan.** One PR per wave. W1 is blocked on #8832 merging, unless W1 carries the shared
re-evaluation call itself while #8832 is still open.

| Wave | Contents |
|---|---|
| W1 | `bulkAttributeWrite` helper, `POST /devices/bulk/tags`, `POST /devices/bulk/custom-fields`, batched custom-field upsert, `selfManagedDbContextRoutes` entries, mount-order test. |
| W2 | Web: menu entries, the two dialogs, shared `CustomFieldValueEditor` (with the null/default fix), client service functions, outcome toasts. |
| W3 | `manage_tags` `deviceIds[]` through the shared service, plus the Tier 3 change (OD-2 = B). |
| W4 | Manual-asset tags (OD-4 = A+B). |

**Tests.** Write each assertion first and watch it fail.

| Test | Where | CI job that catches it |
|---|---|---|
| Route: 400 for an add/remove overlap, more than 500 ids, more than 50 tags, or an empty op; 403 without `devices:write`; MFA required | `routes/devices/bulkAttributes.test.ts` | `test-api` |
| Route: per-device verdicts (`NOT_FOUND`, `SITE_ACCESS_DENIED`, holding org, ephemeral); `changed` true and false; audit only for changed devices, with the actual delta; re-evaluation per changed device with `['tags']` / `['custom.<key>']`, registered post-commit | same | `test-api` |
| Route: an org transaction that throws reports `ERROR` for that org only, and earlier orgs stay committed | same | `test-api` |
| Custom fields: per-org definition resolution (partner-wide in org A, an org-owned definition of another type in org B, missing in org C), `expectedType` mismatch, `deviceTypes` gate, `null` clears | same | `test-api` |
| Mount order: `/devices/bulk/tags` reaches its handler through the assembled router, not `/:id`; the API-key PATCH on `customFieldValuesRoutes` still works | `bulkAttributes.mountorder.test.ts` | `test-api` |
| `selfManagedDbContextRoutes` lists both paths | `middleware/selfManagedDbContextRoutes.test.ts` | `test-api` |
| Concurrency: two concurrent bulk adds of different tags on one device both persist; a device re-sited between check and write comes back `STATE_CHANGED` and is not written | `__tests__/integration/bulkDeviceAttributes.integration.test.ts` (real Postgres) | `integration-test` |
| Lock ordering: one bulk tag edit and one bulk custom-field edit across two orgs, in an order where the higher UUID comes first in the request, and across two partners under system scope, both succeed with no partner-export lock exception | same | `integration-test` |
| RLS: a partner user with `org_access = 'selected'` cannot write a device in an org outside their selection; a site-restricted user cannot write a device in a denied site, even though RLS alone would allow the row | same | `integration-test` |
| Dynamic group: a bulk tag add moves a device into a group with a `tags` rule after the job runs | extend `__tests__/integration/dynamicGroupReevaluation.integration.test.ts` | `integration-test` |
| Web: the dialogs send the right body; client cap; outcome toast for all/partial/none failed; network rows skipped; type-conflict warning | `BulkEditTagsDialog.test.tsx`, `BulkSetCustomFieldDialog.test.tsx` | `test-web` |
| Web: the gating contract includes the two new action strings | `DeviceList.test.tsx` | `test-web` |
| Web: the new dialogs and their client module are added to `TARGET_GLOBS` in `lib/__tests__/no-silent-mutations.test.ts`, so a bare mutating `fetchWithAuth` fails the build. Do not add them to `runActionAllowlist.ts`, which already exempts `services/deviceActions.ts`. Put the new client calls in the dialogs or a new `lib/api/bulkDeviceAttributes.ts` that the guard sees. | `no-silent-mutations.test.ts` | `test-web` |
| AI: `manage_tags` with `deviceIds` gates every id (one foreign id denies the call), audits and re-evaluates; tier contract updated for OD-2 | `aiToolsDevice.test.ts`, `aiTools.deviceGate.test.ts`, guardrail contract tests | `test-api` |

`pnpm test` does not run the integration suites. Run the integration file locally against
`pnpm test-stack up` before opening the PR (`docs/agents/testing.md`). No cascade or export contract
suite is affected, because there is no new table or column.

**Rollout.** No feature flag: the routes are additive, and the menu entries appear for users with
`devices:write`. Docs: add a "Bulk editing" section to `apps/docs/src/content/docs/features/tags.mdx`
and `custom-fields.mdx`. Release note: "Bulk edit tags and custom fields from the device list". Because
OD-2 = B, the release note must also say that `manage_tags` add/remove now asks for approval.

## 8. Rejected alternatives

- **Loop the existing `PATCH /devices/:id` from the browser.** Keeps the replace race, sends up to
  500 requests and gives no shared audit `bulkId`.
- **Extend the CSV importer.** Its matching by serial and hostname, and its preview flow, answer
  "load a file", not "these rows I selected".
- **`runBulkIsolated` per device.** See §4.2. It is right for restore and wrong for a one-statement
  write.
- **One transaction for the whole request.** Breaks partner-export lock ordering on multi-org
  selections (§4.4).

## 9. Advisor quorum

**Fable position:** the original draft. **Codex** (`gpt-6-astra`, `xhigh`, read-only) reviewed it
against the code.

Agreements folded in:

- Per-attribute routes.
- MFA parity, and that `requireMfa` follows tenant policy rather than forcing a fresh challenge.
- Set-based writes over `runBulkIsolated` per device.
- Removed selections stay in scope.
- Defer `set_custom_field`.

Corrections folded in:

- Removal matches tags exactly (D12).
- Old and new values are read under lock, so audit records the actual delta.
- Per-org transactions in ascending org order, because of the partner-export lock guards (D7, §4.4).
- Writes are pinned to the verified org and site, with `STATE_CHANGED` for moved devices.
- Holding-org and ephemeral devices are excluded explicitly.
- `expectedType` and client-side applicability, because `GET /custom-fields` ignores its filters.
- The null-shows-default bug is fixed before the editor is shared.
- Post-commit fan-out, with the weaker audit-delivery guarantee documented.
- `runAction` is used without `successMessage`.
- MCP is single-org for device arrays.
- Bulk `manage_tags` moves to Tier 3 under the written MFA-parity rule (OD-2, where Fable changed
  position).

Disagreements, resolved by the owner on 2026-10-17:

- **OD-4:** Fable would add manual-asset tags as W4 of this feature; Codex would defer them.
  Approved: W4 inside this feature.
- **OD-5:** Fable would record dropdown, boolean and date values in audit; Codex wants keys only,
  with no exceptions. Approved: record those three types' values.
