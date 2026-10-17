---
title: Custom fields in the Devices report and a device-list CSV export
date: 2026-10-15
status: approved 2026-10-17 (all decisions as recommended, §8)
issue: "#7324 (follow-up to #6594; #6990 shipped the filter picker and list column)"
related: "#8834 form factor, #8835 assigned contact, #8836 lifecycle state (each adds a first-class device column)"
author: Todd Hebebrand (design), Claude (spec)
quorum: Claude + Codex gpt-6-astra xhigh (one read-only round); outcome in §9
---

# Custom fields in the Devices report and a device-list CSV export

## 1. Problem

#6594 asked for fleet-wide visibility of custom field values. #6990 shipped two
of the four surfaces: the advanced-filter picker and an opt-in device-list
column. Two remain, and both turn out to be bigger than "add custom fields":

1. **The Devices report cannot carry a custom field.** The report builder's
   column picker is decorative for this type. The server ignores it.
2. **The device list has no export at all.** No control, no endpoint. An MSP
   with a populated custom field can see it on screen and has no way to get it
   into a spreadsheet.

Current state (main `601877a6ef`, verified 2026-10-15):

- **The server never reads `config.columns`.** `generateDeviceInventoryReport`
  (`apps/api/src/services/reportGenerationService.ts:415`) calls
  `readDeviceInventoryRows` (`:392`), a fixed Drizzle select of 13 keys. Manual
  assets (#4622) are projected onto the same 13 keys (`:463-516`). Nothing in
  the file references `columns`.
- **The builder's Devices catalog does not match the data.**
  `fieldDefinitionsByType.devices` (`apps/web/src/components/reports/ReportBuilder.tsx:548`)
  lists eleven ids that `normalizePreviewRow` (`:641`) aliases client-side onto
  the 13 server keys:
  - `os` is `osType` + `osVersion`; `serial` is `serialNumber`; `last_seen` is
    `lastSeenAt`.
  - **"Memory usage" is `ramTotalMb`** (installed RAM, not usage). **"Disk
    usage" is `diskTotalGb`.** **"Patch level" is `agentVersion`.**
  - `site`, `owner` and `cpu` have no source in the row. `previewColumns`
    (`:1239-1254`) hides any selected field that is null on every row, so they
    silently vanish from the preview.
- **The builder always saves `config.columns`** (`:1644`; default
  `['hostname','os','status','site','last_seen']`, `:608`). Every saved Devices
  report therefore carries alias ids that today mean nothing server-side.
  Scheduled recipients get all 13 columns regardless.
- **The advanced device filter is preview-only, and the preview is wrong.**
  `deviceFilter` (`:901`) is never written into the saved config. The preview
  enforces it by intersecting row hostnames with `useFilterPreview`
  (`:906`, `:1164-1199`). That hook passes no `limit`, and `POST /filters/preview`
  returns at most 10 devices (`apps/api/src/routes/filters.ts:223`,
  `allDevices.slice(0, limit ?? 10)`). So an advanced filter matching 300
  devices previews at most 10 rows, and the saved report ignores the filter
  entirely.
- **`config.filters` strips unknown keys.** `legacyReportConfigSchema.filters`
  (`apps/api/src/services/reportConfigSchemas.ts:44-50`) is a plain
  `z.object`. A filter stored under `filters` must be declared there.
- **`GET /custom-fields` is not org-scoped for partner callers.** Under partner
  scope it returns partner-wide definitions plus every accessible org's
  definitions (`apps/api/src/routes/customFields.ts:236-249`). `query.orgId` is
  declared (`:66`) but never read. A builder targeting org A would offer org B's
  fields.
- **`fieldKey` is immutable and `name` is mutable.** `updateCustomFieldSchema`
  (`customFields.ts:54-62`) has no `fieldKey`. `custom.<fieldKey>` is therefore
  a stable column id, and the display label has to be resolved late.
- **The device list holds the whole fleet in the browser.** `fetchAllDevices`
  (`apps/web/src/lib/devicesFetch.ts`) walks the `/devices` cursor to
  exhaustion (200 per page, 40,000-row ceiling). `DevicesPage` merges in the
  network and manual-asset arms. Search, VPN, class, status and decommissioned
  filtering run client-side through `matchesMergedListFilters`
  (`components/devices/mergedListFilter.ts`). The advanced filter is resolved
  server-side to an id set (`useAdvancedFilterIds`). Sorting is client-side
  (`DeviceList.tsx` `sortValue`).
- **MCP mostly shares the generator.** For human principals,
  `export_dataset`'s `device_inventory` adapter
  (`apps/api/src/services/aiToolsExportDatasets.ts:313-336`) calls
  `generateDeviceInventoryReport`. AI-agent principals go through
  `agentInventoryPager` (`:140-168`), which calls `readDeviceInventoryRows`
  directly with run-frame and site narrowing. A column change has to land in
  `readDeviceInventoryRows` to reach both paths.
- **Definitions are hard-deleted** (`customFields.ts:493`). An admin can delete
  a field and recreate one with the same key, so a key alone does not identify
  a definition over time.

### 1.1 The "third surface" question (resolved)

#7324 left open whether the PDF/CSV export path keeps its own device column
list, which would make it a third surface to wire. **It does not.**

- There is no `/reports/:id/export` route. Saved-run downloads are
  `GET /reports/runs/:id/download` (`apps/api/src/routes/reports/runs.ts:468-587`).
- That route renders CSV through `rowsToCsv`, Excel through `rowsToTsv`
  (`packages/shared/src/utils/csvExport.ts:81-92`), and PDF by handing the
  snapshot to the browser.
- Scheduled email attachments use the same two functions
  (`apps/api/src/services/reportDelivery.ts:152,179`).
- The browser export (`components/reports/reportExport.ts:76-101`) and the
  run preview table (`ReportPreview.tsx:82-85`) do too.
- The generic PDF table (`packages/shared/src/reportPdf/reportPdf.ts:1972-1974`)
  is the fourth consumer.

All of them derive headers from `Object.keys(rows[0])`. `device_inventory` has
no curated PDF arm. **The row shape in `report_runs.result.rows` is the column
list.** Whatever the generator emits, every renderer prints.

Two consequences:

- A custom field added to the generator's rows reaches CSV, Excel, PDF, email
  and preview with no per-renderer column wiring.
- Every renderer currently prints raw keys as headers: `humanizeHeader` in the
  PDF, the literal key in CSV. A column called `custom.bdr_windows_activation`
  would reach a customer's spreadsheet as that string. The renderers therefore
  need a **label** channel, though not a column list (§4.4).

The exception is `hardware_lifecycle`. It has a curated PDF renderer with its
own fixed columns (`reportPdf.ts`, `renderHardwareLifecycleReport`) and typed
rows inside `summary.rows`. It *is* an independent surface, which is one reason
it stays out of scope (§7).

## 2. Users and scope

- **MSP technicians and admins** building or scheduling Devices reports for a
  customer org. They want a custom field such as "BDR activation" or "Asset
  owner" as a column, a filter on one, and a customer-ready PDF or CSV.
- **The same users on `/devices`.** They want "what I'm looking at, as a CSV"
  for an audit, a quote or a spreadsheet reconciliation.
- **Automation.** MCP `export_dataset` callers and scheduled-report email
  recipients consume the same rows.

In scope: the `device_inventory` report type (builder "Devices") and the
`/devices` list. Out of scope: §7.

## 3. Principles

1. **One column catalog, bound per surface.** A device column is identified by
   a stable id. Each surface (report generator, device list, export) binds that
   id through an exhaustive `Record`, so a missing binding is a compile error.
   #8834, #8835 and #8836 then become one catalog entry plus one binding per
   surface, with the compiler naming each place to touch.
2. **The snapshot is self-describing.** A stored run carries its own column
   order and labels, so later renames and deletions never rewrite history or
   break an old download.
3. **Never silently change an existing scheduled report.** Saved reports keep
   today's 13-column output until someone re-saves them in the builder.
4. **A filter can only narrow.** A persisted device filter is ANDed inside the
   existing org, site-authority, ephemeral and parked pins. It is never a
   replacement for them.

## 4. Part A: custom-field columns and filters in the Devices report

### 4.1 Column catalog

Add a shared static catalog,
`packages/shared/src/reports/deviceInventoryColumns.ts`:

```ts
export const DEVICE_INVENTORY_COLUMN_IDS = [
  'hostname', 'displayName', 'osType', 'osVersion', 'agentVersion', 'status',
  'lastSeenAt', 'enrolledAt', 'cpuModel', 'ramTotalMb', 'diskTotalGb',
  'serialNumber', 'deviceId',
  // cheap additions that close the builder's dead fields:
  'siteName', 'manufacturer', 'model', 'lastUser',
] as const;
export type DeviceInventoryColumnId = (typeof DEVICE_INVENTORY_COLUMN_IDS)[number];

export interface DeviceInventoryColumnMeta {
  labelKey: string;   // reports.reportBuilder.fields.devices.<id>
  label: string;      // English; used by server-rendered CSV/PDF
  type: 'string' | 'number' | 'date' | 'boolean';
  defaultSelected: boolean;
}
export const DEVICE_INVENTORY_COLUMNS: Record<DeviceInventoryColumnId, DeviceInventoryColumnMeta>;

/** Today's 13 keys, in today's order. The legacy output contract. */
export const LEGACY_DEVICE_INVENTORY_COLUMNS: readonly DeviceInventoryColumnId[];

export const CUSTOM_COLUMN_PREFIX = 'custom.';   // same namespace as filterEngine
export const MAX_REPORT_CUSTOM_COLUMNS = 25;
```

The API binding lives next to the generator
(`apps/api/src/services/reports/deviceInventoryColumnBindings.ts`):
`Record<DeviceInventoryColumnId, { select: SQL | AnyPgColumn; manualAsset: (a) => unknown }>`.
Because the binding is exhaustive, adding an id to the shared tuple fails
typecheck until the generator knows how to read it. The same applies to the
device list's `exportValue` (§5.2).

- **Custom columns** are `custom.<fieldKey>`, the namespace `filterEngine`
  already parses (`getCustomFieldKey`, `filterEngine.ts:62-71`, same
  `CUSTOM_FIELD_KEY_PATTERN`). They are resolved at generation time against the
  definitions visible to the report's org: partner-wide rows for the org's
  partner plus rows owned by that org.
- **Saved identity is key plus definition id.** `columns` holds
  `custom.<fieldKey>`, which is readable and diffable. A sibling
  `config.customColumnBindings: Record<'custom.<key>', { definitionId }>`
  records which definition the user picked. Because definitions are
  hard-deleted, a key on its own would silently bind to a recreated field.
  §4.6 and Decision 5 cover what happens when the binding and the live
  definition disagree.
- **Save-time validation** (config schema): each entry is a known static id or
  a pattern-valid `custom.<key>`. At most `MAX_REPORT_CUSTOM_COLUMNS` custom
  entries and no duplicates. Existence is not checked at save time: a
  definition can be deleted after save anyway, and §4.6 handles it.

The builder's Devices catalog is generated from this shared list, plus the
target org's custom definitions. The hand-written `fieldDefinitionsByType.devices`
and the Devices branch of `normalizePreviewRow` are deleted. Preview rows then
arrive already keyed by catalog id. The other four builder types are untouched.

### 4.2 Back-compat: versioned columns

Every saved Devices report already carries alias ids in `config.columns`.
Honoring them as written would cut scheduled output from 13 columns to 3–5 and
drop `owner`/`cpu` outright. Instead:

- The builder writes **`config.columnsVersion: 2`** alongside catalog-id
  `columns`. The key is declared in `legacyReportConfigSchema` as
  `z.literal(2).optional()`.
- The generator honors `columns` **only when `columnsVersion === 2`**.
  Otherwise it emits exactly `LEGACY_DEVICE_INVENTORY_COLUMNS` in today's order
  and key names. A test pins this byte-for-byte against a fixture.
- **Opening a legacy report in the builder does not upgrade it.** The column
  panel shows a "Standard columns (all 13)" state that reflects what the
  report actually delivers today. Renaming the report or changing its schedule
  and saving keeps it legacy, so its delivered columns cannot change as a side
  effect.
  - Only an explicit change to the column selection switches the report to v2.
    The builder pre-fills the selection with the 13 legacy columns, not the
    builder default subset.
  - Before saving it shows the resulting column list ("This report will now
    deliver: …").
  - The legacy alias ids are mapped for display only: `serial` to
    `serialNumber`, `memory` to `ramTotalMb`, and so on. `owner` and `cpu` have
    no source and are not carried over.
  - No migration and no backfill.
  - This tightening came from the codex round (§9).

`export_dataset` and any config without `columnsVersion` keep the 13-key shape,
so existing MCP callers see no change.

### 4.3 Data fetch: one correlated subquery returning jsonb

When at least one custom column is selected, the generator resolves
`fieldKey` to `definition_id` once, against the org-visible definitions above.
It then adds a single select expression to `readDeviceInventoryRows`:

```sql
(SELECT jsonb_object_agg(
          v.definition_id::text,
          COALESCE(to_jsonb(v.value_text), to_jsonb(v.value_number),
                   to_jsonb(v.value_bool), to_jsonb(v.value_date::text)))
   FROM device_custom_field_values v
  WHERE v.device_id = devices.id
    AND v.definition_id = ANY($resolvedDefinitionIds)) AS custom_values
```

The generator then spreads `custom_values[defId]` into `row['custom.<key>']`.

**Recommended over the alternatives:**

| Option | Cost at 10k devices × k custom columns | Problems |
|---|---|---|
| **One correlated jsonb subquery (recommended, pending the plan gate below)** | 10k probes on `device_custom_field_values_device_def_uq (device_id, definition_id)`, each returning ≤ k rows | Expression is raw SQL inside a Drizzle select. That is acceptable, and `filterEngine` does the same. |
| k correlated scalar subqueries (the `filterEngine` pattern, `:331-375`) | k × 10k probes; plan width grows with k | Coerces to text and loses number, bool and date types. Matches by `field_key` and relies on `LIMIT 1` against duplicates. |
| Bulk `WHERE definition_id = ANY(...)`, merged in JS | One scan of `definition_idx` | For a **partner-wide** definition the index spans every org's values under that partner, so the scan scales with the partner, not the report. A second query also loses the single-statement snapshot. |
| Aggregate `GROUP BY device_id` joined to the scoped device set | One hash or merge join | Also avoids unrelated orgs. It is a plausible winner on dense data, which is why the plan gate below exists. |
| Read the `devices.custom_fields` projection | Free (column already on the row) | The projection is retained only for legacy readers (`deviceCustomFieldValues.ts:9-13`). A new reader deepens a dependency the schema says to shrink. Keys are not definition-scoped. |

**Plan gate (W2, before merge).** The "10k probes" estimate is a hypothesis.
Before merge, capture `EXPLAIN (ANALYZE, BUFFERS)` for the correlated subquery
and the aggregate-join alternative, under real RLS (`breeze_app`). Use a seeded
10k-device org with 25 selected fields, and run it twice: sparse values (5%
populated) and dense values (100% populated). Ship whichever is faster. Both
emit the same `custom_values` jsonb, so the choice is invisible above
`readDeviceInventoryRows`.

**Definition resolution is explicit, not RLS-dependent.** The scheduled worker
runs under system DB context. Resolution therefore uses an explicit predicate
(`org_id = $reportOrg OR partner_id = $reportOrgPartner`), never "whatever the
session can see".

The subquery runs in the caller's DB context. On the request path, RLS on
`device_custom_field_values` (`breeze_has_org_access(org_id)`) applies. The
scheduled worker runs under `withSystemDbAccessContext`, so isolation there
rests on the outer `devices.org_id = $org` pin and the `device_id` correlation.
The composite FK `(device_id, org_id) → devices(id, org_id)` makes that sound.
Keying by `definition_id` rather than `field_key` means a value enters the row
only through that explicit resolution. Within one org, a key already maps to at
most one definition (owner unique indexes plus the anti-shadow trigger,
`customFields.ts:13-29`). The id key matters across time: deletion and
recreation.

Manual-asset rows get `null` for every custom column, and for every static
column without a manual projection.

Volume: `device_inventory` is `detailRowCap: UNCAPPED`. 10k rows × (13 + 25)
columns is roughly 8–12 MB of `result` JSONB. That is the same order as a wide
inventory today, and `previousBaselineFor` already avoids reading `rows`.
No cap is introduced here.

### 4.4 One row shape, a column descriptor, and labels

`ReportResult` gains an optional descriptor:

```ts
columns?: Array<{
  id: string;            // 'hostname' | 'custom.bdr_windows_activation'
  label: string;         // English static label, or the definition name at generation time
  labelKey?: string;     // static columns only; web translates
  type: 'string' | 'number' | 'date' | 'boolean';
  kind: 'static' | 'custom';
  missing?: true;        // §4.6
}>;
```

- Rows remain flat objects keyed by `id`. Every row carries every column key
  (nulls included), because consumers read the header from the first row.
- `rowsToCsv(rows, columns?)`, `rowsToTsv(rows, columns?)`, the generic PDF
  table and `ReportPreview` use `columns` for **order and header labels** when
  it is present. Without it they fall back to `Object.keys(rows[0])`. Old
  snapshots and every other report type are byte-identical.
- **Propagation sites, all of which must forward `columns` and `warnings`:**
  - the download route (`runs.ts:468-587`);
  - `emailReportRun`'s argument list in the worker
    (`reportScheduleWorker.ts:1031`), which forwards selected result fields
    explicitly, not the whole result;
  - `reportDelivery` (`:152,179`);
  - `exportReport` (`reportExport.ts:40`), whose `opts` grows a `columns`
    field;
  - `ReportPreview`.
- **Zero rows with a descriptor** produce a header-only CSV or Excel file
  instead of today's 409 (`runs.ts:551`). An empty weekly report should still
  parse. Results without `columns` keep the 409.

**i18n.** Custom labels are user content: the definition `name`, snapshotted at
generation and never translated. A rename does not rewrite past runs, which is
correct for a point-in-time snapshot. Static labels: the web preview and
builder translate via `labelKey`, keeping the existing
`reports.reportBuilder.fields.devices.<id>` convention. New ids need all seven
locales (`localeParity`). Server-rendered CSV and PDF use the English `label`;
the PDF is `en-US` today (`reportPdf.ts:2028`).
Per-report locale is out of scope.

The PDF is landscape at 8 pt (`reportPdf.ts:1983`). Past about 12 columns it
becomes unreadable. Decision 8 sets the policy. The recommendation is a
hard cap of 12 columns for PDF-format reports, validated at save time. CSV and
Excel allow the full set.

### 4.5 Persisting the advanced filter

- Store as **`config.filters.deviceFilter`**, declared in
  `legacyReportConfigSchema.filters` with the shared
  `filterConditionGroupSchema` (`packages/shared/src/validators/filters.ts`).
  Today's strict `filters` object would otherwise strip it.
- **Validated compilation, not raw `buildGroupSQL`.** `filterEngine` exports
  `compileDeviceFilterPredicate(group)`, which:
  - runs the semantic `validateFilter` (`filterEngine.ts:1030`): known field,
    operator legal for the type, well-formed `custom.` key;
  - caps nesting depth and condition count (proposed: depth 4, 50 conditions);
  - only then returns `buildGroupSQL` (`:735`).
  Save-time validation calls the same function, so a filter that would fail at
  run time is refused at save. The generator ANDs the predicate into the
  agent-device branch alongside the org, ephemeral, parked and
  authority-site conditions (principle 4).
- `custom.*` conditions work as they do in dynamic groups. The
  execution-refused tiering does not apply, because a report is a read and not
  an execution target.
- A present `deviceFilter` **excludes the manual-asset branch**, the same rule
  `osTypes` and `deviceIds` already follow (`reportGenerationService.ts:463-465`).
  A hand-entered asset cannot satisfy a device predicate.
- **Bounded execution.** When a `deviceFilter` is present, the inventory query
  runs inside the same statement-timeout wrapper the evaluator uses
  (`withFilterStatementTimeout`, `filterEngine.ts:847`). It is exported for
  this purpose. A pathological condition then fails the run cleanly instead of
  pinning a connection. Exporting `buildGroupSQL` alone would bypass that
  timeout.
- **The preview** sends `deviceFilter` (and `columns`/`columnsVersion`) to
  `POST /reports/generate`. The hostname intersection against the 10-device
  preview is deleted, which fixes the silent truncation in §1.

The builder's simple `filterConditions` remain preview-only, as today. That
pre-existing gap is noted in §7.

### 4.6 Scheduled reports and drift

- The worker calls `generateReport` with the stored config, so columns and
  filter apply with no worker change. Membership is evaluated at run time, so
  a weekly report reflects the current fleet.
- **A selected custom field whose definition was deleted** keeps its column.
  The cells are empty, and the descriptor carries
  `{ label: '<fieldKey> (field removed)', missing: true }`. `summary.warnings`
  gets one line. Column order and count stay stable for downstream parsers.
  The builder flags the stale column on the next edit.
- **Deleted and recreated under the same key:** the live definition id differs
  from `customColumnBindings`. The recommendation is to rebind to the new
  definition and add a warning ("'Asset owner' now reads a recreated field").
  See Decision 5.
- A definition renamed after save renders with its new name on the next run.
- **What "stable" promises.** Column identity and order are stable. Header
  *text* is not, because it is the definition's current name. A consumer that
  needs machine-stable headers should use the JSON download or
  `export_dataset`, both keyed by `custom.<fieldKey>`. A machine-header CSV
  option is out of scope (§7).

### 4.7 MCP parity

- `export_dataset({ dataset: 'device_inventory' })` accepts
  `filters.columns: string[]` (same ids, same validation).
  - Human principals: `deviceInventoryAdapter` forwards it as `columns` with
    `columnsVersion: 2`.
  - AI-agent principals: `agentInventoryPager` (`:140-168`) passes the resolved
    column plan straight to `readDeviceInventoryRows`. Its device-frame, run
    and site narrowing (`inArray(devices.id, ids)`, `allowedSiteIds`) is
    unchanged. The custom subquery is correlated to the already-narrowed device
    rows, so it cannot widen them.
- The tool description lists `custom.<fieldKey>`. Models discover keys through
  the existing `query_custom_fields` tool.
- `generate_report` inherits columns through the stored config.

### 4.8 Supporting fix: org-scoped definitions

`GET /custom-fields` honors `orgId`. For a partner caller with access to that
org it returns partner-wide definitions plus that org's own. This is the
already-declared, ignored parameter. The builder fetches with its target org,
and the generator uses the same resolution server-side. The device list keeps
the unscoped call: it shows the union across orgs, and cells are blank where a
field does not apply.

## 5. Part B: device-list CSV export

### 5.1 Recommendation: client-side generation from the list's own state

**Export what the user is looking at, and only when the list is complete.**
That means:

- every row matching the current filters, across all pages, not just the
  visible page;
- in the current sort order;
- with the visible columns in rendered order, including visible custom-field
  columns.

From the bulk-selection menu, "Export selected (N)" exports only the selected
rows. Both paths reuse `DeviceList`'s `sortedDevices` (`DeviceList.tsx:1162`),
so file order equals screen order by construction.

**Completeness.** The list degrades silently in places:

- the network and manual-asset arms turn a fetch failure into an empty array
  (`DevicesPage.tsx:693-711`);
- `fetchAllDevices` stops at `MAX_PAGES`.

Each arm therefore reports a completeness flag: `complete`, `degraded`, or
`truncated`. When any arm is not complete, the "all matches" export is
disabled, with a tooltip naming the incomplete arm. "Export selected" stays
available. A partial file must never pass as "the list".

The device list already holds exactly that row set in memory: the full fleet
via the cursor walk, the merged network and manual arms, the client-side
filters and sorts. Generating the file in the browser is therefore the only
design where the file provably equals the screen.

**Server-side streaming, rejected for the list (Decision 2):**

- *WYSIWYG.* The server would need to re-implement `matchesMergedListFilters`,
  the class/VPN/decommissioned facets, the three-arm merge and every
  `sortValue` comparator. Two implementations of the same predicate drift, and
  the first drift ships a CSV that disagrees with the screen.
- *Exposure.* None is added. The browser already received every exported value
  from `/devices`, `/devices/manual` and the network arm under the user's RLS
  context and site restrictions. No new authorization surface exists to get
  wrong.
- *Scale.* 10k rows × about 40 columns is roughly 4–8 MB of string.
  Building it and saving a `Blob` takes well under a second in a modern
  browser. The list's 40,000-row ceiling bounds the worst case, and there is
  no server load or rate limit to design.
- *What server-side would buy* is an authoritative audit record and
  headless/API access. Headless access already exists: `export_dataset` for
  MCP and the report pipeline for scheduled delivery. The portal's
  `GET /devices/export.csv` (`routes/portal/devices.ts:21`) stays a separate,
  fixed-column customer export.

### 5.2 Column model: `exportValue` on every column

`DeviceList`'s `columnDefs` (`DeviceList.tsx:1586`) is a
`Record<ColumnId, { header, cell }>`. Each entry gains
`exportValue: (d: Device) => string | number | boolean | null`.

- Because the `Record` is exhaustive over `COLUMN_IDS`
  (`columnVisibility.ts:9`), #8834, #8835 and #8836 cannot add a list column
  without an export value. This is the cheap-first-class-column property on
  this surface.
- **Values are machine-friendly:**
  - ISO 8601 UTC timestamps, not "3 minutes ago";
  - numbers without thousands separators or localization;
  - `true`/`false`;
  - multi-values joined with `; `.
- **Units match the screen and are named in the header.** The list shows RAM
  in GB under "RAM" (`DeviceList.tsx:2139`), so the export header is
  "RAM (GB)" with GB values, never MB under a header that implies GB.
  `exportValue` returns the value already converted. The column definition
  carries an `exportHeaderSuffix` for the unit.
- **Headers are the localized column titles the user sees, plus the unit.**
- Custom columns export `device.customFields[fieldKey]` with the definition
  `name` as header, the same value `customColumnCell` renders (`:2655`).
- A trailing **"Breeze device ID"** column is always included. It makes the
  file joinable against the Partner API and MCP exports. Network and
  manual-asset rows export their own ids, and the class column tells them
  apart.
- Serialization uses the shared `toCsv`, which neutralizes formulas in every
  cell, headers included.

Placement and naming:

- **Button:** "Export CSV" in the list toolbar, beside the column picker,
  labeled with the count ("Export 1,284 devices"). It is disabled while the
  advanced filter is loading or errored (`advancedFilterBlocked`), so an
  in-flight filter never exports the unfiltered fleet.
- **Bulk menu:** "Export selected".
- **Filename:** `devices-<org-slug | all-organizations>-YYYY-MM-DD.csv`, dated
  in the user's timezone, with the slug sanitized to `[a-z0-9-]`.

### 5.3 Audit, permission, rate limits

- **Audit:** the client calls an authenticated route,
  `POST /devices/export-events` (`devices:read`), via `fetchWithAuth` with
  `keepalive: true`. It cannot be `navigator.sendBeacon`, because the API
  authenticates with a bearer header.
  - The server writes `writeRouteAudit` action **`device.list.export`**,
    resource type `device_list`.
  - It derives the authorized scope itself: the caller's org scope and site
    restriction.
  - Client-supplied `{ rowCount, columnIds, hasAdvancedFilter, selectionOnly }`
    are recorded as `details.clientReported`, which is telemetry, not proof.
  - The download is not blocked on this call (Decision 3). Blocking adds
    no security, since the data is already in the page, and only adds a
    failure mode. Report downloads follow the same precedent: their audit
    write is also non-fatal (`sensitiveReadAudit.ts:42`).
  - The route is rate-limited like other audit-producing writes.
- **Permission:** `devices:read`, the permission that already loads the list.
  No new permission (Decision 4).
- **Rate limits:** none on generation. Nothing hits the server.

### 5.4 MCP parity

The list export is a UI convenience over data the agent can already reach.
`export_dataset({ dataset: 'device_inventory', filters: { columns: [...] } })`
(§4.7) is the headless equivalent, scoped and narrowed by the same generator.
No new MCP tool.

## 6. Tenancy and data model impact

- **No new table, no new column, no migration.** `columns`, `columnsVersion`,
  `customColumnBindings` and `filters.deviceFilter` live in the existing
  `reports.config` JSONB.
  `result.columns` lives in the existing `report_runs.result`. Org-cascade,
  merge and export registries are untouched.
- **RLS:** unchanged. The new subquery reads `device_custom_field_values`
  (shape 5, direct `breeze_has_org_access(org_id)`) under the caller's context
  (§4.3).
- **One new audit action:** `device.list.export`.
- **Config schema:** `legacyReportConfigSchema` gains `columnsVersion`,
  `customColumnBindings` and `filters.deviceFilter`, and validates `columns`
  entries. The schema stays
  loose. `schemas.configParity.test.ts` must still pass.

## 7. Out of scope

- **`hardware_lifecycle` custom columns** (Decision 6). It is a curated,
  customer-facing replacement plan with its own PDF renderer and typed rows in
  `summary.rows`. Custom columns there need a renderer design, not a generator
  change.
- Server-side sort of report rows (`sortBy`/`groupBy` remain builder-side
  presentation).
- Making the builder's simple `filterConditions` real server-side.
- Custom fields in the Partner API device DTO (`routes/partnerApi/devices.ts`
  reads only identifier keys from the projection).
- Per-report locale for server-rendered output.
- A machine-header CSV option (headers as `custom.<key>` ids).
- Excel-native `.xlsx` and a UTF-8 BOM for the list export. Existing exports
  emit plain UTF-8 CSV, and this one matches.
- Retiring the `devices.custom_fields` projection.

## 8. Decisions (approved 2026-10-17)

Todd approved every decision as recommended on 2026-10-17. Numbering is kept
so the in-text "Decision N" references still resolve. The rejected options are
kept one line each for the record.

1. **Legacy `config.columns`: `columnsVersion: 2` gate (option a).** Legacy
   reports are untouched until re-saved, and only an explicit change to the
   column selection upgrades a report to v2, never an unrelated edit (§4.2).
   Rejected: (b) server-side alias reinterpretation; (c) a new `outputColumns`
   key.
2. **Device-list CSV is generated client-side from list state (option a).**
   Revisit only if the list stops loading the whole fleet client-side.
   Rejected: (b) server-side streaming endpoint.
3. **The export audit call never blocks the download (option a).** It is
   best-effort. Rejected: (b) download only after the audit write succeeds.
4. **The device-list export requires `devices:read` only (option a).** No new
   permission and no `reports:export` check. This deliberately allows a role
   denied `reports:export` to download the list it can already see (§9).
   Rejected: (b) also require `reports:export`.
5. **Deleted custom columns stay, empty, labeled "(field removed)", with a
   warning (option a).** Recreated under the same key: **rebind to the new
   definition with a warning (option a).** Rejected: dropping the column;
   treating a recreated field as removed until re-selected.
6. **`hardware_lifecycle` custom columns are out of scope (option a).** CSV-only
   extra columns (b) is the follow-up if asked. Rejected for now: (c) full
   renderer support.
7. **Two catalogs, each exhaustive, sharing ids where they overlap (option a),
   now.** Unifying into one `DEVICE_FIELD_CATALOG` (b) happens after #8834,
   #8835 and #8836 have all landed.
8. **PDF-format Devices reports are hard-capped at 12 columns, validated at
   save time; CSV and Excel are uncapped (option b).** Rejected: (a) warn
   only; (c) a continuation table.

## 9. Advisor quorum

Codex (`gpt-6-astra`, xhigh, read-only, one round against main `601877a6ef`)
reviewed this position.

**Codex agreed with:**
- the server-owned column projection, the shared static catalog with
  exhaustive API bindings, explicit versioning, and the result descriptor;
- the "third surface" finding: generic renderers have no independent column
  list, and `hardware_lifecycle` is the only curated exception;
- client-side list export when the list is complete;
- keeping the list and report registries separate (Decision 7).

**Folded in from codex:**
- Legacy reports are not upgraded by an incidental edit. Only an explicit
  column change switches to v2, pre-filled with all 13 columns (§4.2).
- `definitionId` is persisted alongside the key, because definitions are
  hard-deleted (§4.1, §4.6).
- The CSV "stable schema" claim is narrowed to identity and order (§4.6).
- AI-agent `export_dataset` goes through `agentInventoryPager`, so the column
  plan lands in `readDeviceInventoryRows` (§1, §4.7).
- Per-arm completeness gates the "all matches" export, and both export paths
  reuse `sortedDevices` (§5.1).
- The audit call is an authenticated `fetchWithAuth` with keepalive, not
  `sendBeacon`. The server derives scope; client counts are telemetry (§5.3).
- Filter compilation is validated, capped and run under the statement timeout,
  not a raw `buildGroupSQL` export (§4.5).
- Definition resolution is explicit, not RLS-dependent, under the worker's
  system context (§4.3).
- Descriptor propagation sites and header-only zero-row files are spelled out
  (§4.4).
- Export units match the screen (RAM in GB) (§5.2).
- PDF width policy became Decision 8.
- The duplicate-key rationale for keying by definition id was softened, since
  same-org duplicates are already prevented (§4.3).

**Disagreements (both since resolved):**
- **Fetch strategy (§4.3).** Codex would not accept "correlated subquery
  wins" without measurement and proposed an aggregate joined to the scoped
  device set. Resolved as a merge gate: measure both under RLS with sparse and
  dense data, and ship the faster. The recommendation is unchanged pending
  that gate.
- **Export permission (Decision 4).** Codex considers `devices:read`
  defensible but a deliberate policy widening relative to `reports:export`.
  Todd approved `devices:read` on 2026-10-17.

## 10. Test and rollout notes

**Delivery: two waves, independently shippable.** Part B is the smaller and
more visible one and has no dependency on Part A.

- **W1 (Part B, list export):** `exportValue` on every `ColumnId`, the toolbar
  and bulk actions, the audit route.
- **W2 (Part A):** shared catalog, bindings, `columnsVersion`, the jsonb
  subquery, `result.columns`, renderer label support, persisted filter,
  builder rewrite for Devices, `GET /custom-fields?orgId`, `export_dataset`
  columns.

Tests:

- **Shared:** `rowsToCsv`/`rowsToTsv` with and without `columns`. Order,
  labels and formula neutralization of a custom label starting with `=`.
  Byte-identical output without `columns`.
- **API unit:**
  - the generator emits exactly the legacy 13 keys when `columnsVersion` is
    absent (pinned fixture);
  - honors v2 `columns`;
  - manual-asset rows carry null custom cells;
  - a deleted definition yields the `missing` descriptor;
  - a `deviceFilter` drops the manual branch and ANDs with site authority;
  - a `deviceFilter` failing `validateFilter` or over the depth/count cap is
    refused at save;
  - a recreated definition rebinds with a warning;
  - a v2 result with zero rows downloads a header-only CSV;
  - the worker's `emailReportRun` receives `columns`;
  - a legacy report edited without touching columns stays legacy;
  - config schema rejects malformed `custom.` ids and more than 25 custom
    columns.
- **API integration (real Postgres, Integration Tests job):**
  - an org-A report selecting a partner-wide field returns only org-A values;
  - an org-owned field of org B with the same key is never resolved for org A;
  - a site-restricted authority plus a `deviceFilter` cannot widen;
  - the scheduled-worker path under system context still returns only the
    report org's values;
  - an agent-principal `export_dataset` with `columns` stays inside its run
    frame;
  - the §4.3 plan gate: `EXPLAIN (ANALYZE, BUFFERS)` evidence for both fetch
    shapes is attached to the W2 PR.
- **Web:**
  - the builder maps legacy aliases and saves v2;
  - the preview sends `deviceFilter` (and no longer intersects hostnames);
  - the device-list export emits visible columns in order, all filtered rows
    across pages, and selected-only from the bulk menu;
  - a degraded network or manual arm disables "all matches" export;
  - RAM exports as "RAM (GB)";
  - the button is disabled while `advancedFilterBlocked`;
  - a `ColumnId` without `exportValue` fails typecheck (type-level test);
  - new locale keys exist in all seven locales.
- **E2E (Playwright, `data-testid`):** populate a custom field, add it as a
  list column, export, and assert the header and value. Build a Devices report
  with that column plus a `custom.` filter, generate, download the CSV, and
  assert the column.
- **Rollout:** no flag needed. Legacy reports are unchanged by construction
  (Decision 1). Release notes call out that changing a Devices report's
  columns in the builder makes its column selection authoritative.
