# Importing Custom Fields From Another RMM — Design Spec

**Date:** 2026-09-02
**Issue:** [#3257](https://github.com/LanternOps/breeze/issues/3257) (p1) · **Epic:** #3249 (Phase 3)
**Supersedes:** `docs/superpowers/specs/onboarding-signup/2026-08-09-custom-field-backfill-import-design.md`
**Sibling specs:** `2026-08-08-bulk-org-site-import-design.md` (#3242, shipped), `2026-08-09-organization-contacts-design.md` (#3258, shipped 2026-09-02)
**Status:** Draft — 7 open decisions below
**Advisor quorum:** own position + independent read-only review by Codex (`gpt-5.6-sol`, `xhigh`),
2026-09-02. Agreements folded in below and marked **[quorum]**; the two genuine disagreements are
Open Decisions 1 and 2, left unresolved rather than silently picked.

> **Why this supersedes the 2026-08-09 doc.** That doc was written before #3242 and
> #3258 landed and is now stale in four load-bearing ways, each re-verified against
> `main` at `2e2e094e0` on 2026-09-02:
>
> 1. **Its migration-date rule is wrong by seven weeks.** It says "date migrations
>    `2026-08-19` or later". The newest committed migration is now
>    `2026-10-04-100003-portal-visibility-indexes.sql`. Per CLAUDE.md's ratchet rule a
>    new file must sort after the newest *committed* migration, so it must be named
>    `2026-10-05-HHMMSS-*` or later — today's date sorts more than a month early.
> 2. **Its §2.3 partner-wide gate has half-shipped.** `routes/customFields.ts` now
>    imports and calls `canManagePartnerWidePolicies` (`:59`, `:142`, `:318`). The
>    web half did **not** ship: `CustomFieldsPage.tsx` has no `ownerScope` selector
>    and never sends `orgId`/`partnerId` (verified by grep — zero hits). That is a
>    **live regression today**, not a future risk. See §5.1.
> 3. **A far better precedent exists.** #3258 shipped `services/contacts/import.ts`,
>    `routes/importScope.ts`, and `contact_external_links` — a durable external-identity
>    table. The 2026-08-09 doc deferred device identity entirely ("no re-match key…
>    mitigation is that the import is cheap to re-run"). §4 replaces that with
>    `device_external_links`, mirroring two shipped tables.
> 4. **Its §0 storage decision is still unbuilt but its premise still holds.** No
>    `device_custom_field_values` table exists; `devices.custom_fields` is still jsonb;
>    the export-duplication defect it identified reproduces verbatim at
>    `routes/partnerApi/configuration.ts:428-441` today. Carried forward as settled.

---

## Problem

An MSP migrating off Datto RMM, ConnectWise Automate, NinjaOne or N-able N-central
abandons every user-defined field on the way in. That is the largest block of genuine,
hand-entered customer data in the incumbent: warranty expiry, asset tag, purchase date,
physical location, primary user, contract reference — accumulated over years, one machine
at a time.

Breeze has the destination (`custom_field_definitions` + `devices.custom_fields`) and a
value-write endpoint. It has **no import path into either**, and no CSV parser on the API
side at all. The documented workaround (`migration/toolkit.mdx`) is a bash loop over the
API. Meanwhile the two sibling gaps in the same epic are closed: organizations/sites
(#3242) and contacts (#3258) both import today with a preview→commit pipeline. Custom
fields are the remaining hole in Phase 3 of a migration.

**This cannot share a flow with #3242.** Values attach to devices, and devices only exist
after enrollment (Phase 4). It is inherently a later pass with a different join problem:
the only key every source exports is hostname, which Breeze deliberately does not make
unique per org (`routes/agents/enrollment.ts` mints a fresh row on hostname collision, per
the #2764 identity design) and which changes when a machine is renamed.

**Two things the source data does to us that the issue does not mention.** First,
`custom_field_definitions` has no unique index on `field_key` and no XOR constraint on
`(org_id, partner_id)` — verified, only a PK and two FKs exist. Re-running a definitions
import would mint duplicate `udf7` rows, and nothing prevents a `(NULL, NULL)` row that is
invisible to every non-system caller and survives org cascade forever. Second, nothing
anywhere validates a value against its definition's declared `type` — and custom-field
values are both an execution sink (`installerVariables.ts` substitutes
`{{device.customField.<key>}}` into installer command lines that reach
`sendCommandToAgent`) and a targeting control (`filterEngine`'s `custom.<key>` path feeds
`groupMembership.ts` and `deploymentTargetResolver.ts`, which decide which devices receive
software installs and automation runs). Bulk-loading 300k unvalidated strings from a
competitor's export into that surface is the actual risk in this feature.

---

## Users & scope — partner vs org

**Primary user: a partner-scoped migration operator.** A Datto or Automate export is
partner-wide with a company column; forcing one CSV per org would mean 60–200 uploads with
no safety return. Both shipped importers already answer this the same way, and this one
reuses their answer:

- **Request shape is partner-scoped and multi-org**, resolved through the existing
  `resolveImportPartnerId(auth, body.partnerId, subject)` (`routes/importScope.ts`). Only
  `system` scope may name a partner other than its own; an organization token carries a
  `partnerId` but has no authority over its siblings.
- **Safety comes from per-row authorization, not from request shape.** Resolving devices
  across orgs requires a system DB context, and `breeze_has_org_access` short-circuits to
  `TRUE` under system scope (`0001-baseline.sql:1663-1671`). **RLS is not the backstop on
  this path.** Every isolation guarantee is app-layer and must be proven by a forge test
  that runs under system context, exactly as `services/contacts/import.ts` does
  (`runOutsideDbContext(() => withSystemDbAccessContext(...))` at `:229`, `:259`, `:849`,
  `:897`).
- **Site-restricted org users are in scope and must be gated.** `allowedSiteIds` is
  populated only on the org axis (`services/permissions.ts:159-171`; the partner branch never
  sets it), so a site-restricted caller must be checked with
  `canAccessSite(perms, device.siteId)` — a plain boolean, so the caller fails closed on
  `false`.
  **[quorum]** This only coheres if organization scope can reach the route at all. The routes
  therefore take `requireScope('organization', 'partner', 'system')`, matching
  `routes/orgContacts.ts:208,224,251` — which also forwards `auth.allowedSiteIds` into the
  import context (`:162`, `:271`). An earlier draft of this spec said
  `requireScope('partner','system')`, which would have made the site-gating paragraph dead
  code: an org token would never have reached the handler.

**Definitions are a config table, so partner-wide-first applies (CLAUDE.md #2135).**
`custom_field_definitions` is already dual-axis (`org_id` XOR `partner_id`, both nullable)
with dual-axis RLS shipped in `2026-06-11-i-custom-fields-dual-axis-rls.sql`. The incumbents'
own scoping maps onto that axis cleanly, and the importer should preserve it rather than
flattening everything to one org:

| Source | Source scope | Breeze owner |
|---|---|---|
| Datto RMM `udf1`–`udf30` | One schema for the whole Datto tenant | **partner-wide** (`partner_id`) |
| NinjaOne custom fields — *global* | Tenant-wide | **partner-wide** |
| NinjaOne custom fields — *organization* / *location* | Per customer | **org-owned** (`org_id`) |
| ConnectWise Automate EDFs — *computer* | Per Automate instance | **partner-wide** |
| Automate EDFs — *location* / *client* | Per customer | org-level — **out of scope**, §"Out of scope" |
| N-central custom properties — *device* | Per N-central instance | **partner-wide** |
| N-central — *customer* / *site* | Per customer | org-level — **out of scope** |

Datto's `udf1`–`udf30` is the shape that makes this worth doing: thirty slots, one schema,
identical across the fleet. It is a single partner-wide definitions import, not 200 org
ones.

**Values are always org-scoped and device-scoped**, regardless of which axis their
definition sits on. That asymmetry is the source of the storage defect in §3.1.

**Not a user of this feature:** an unattended integration. The importer does **not** accept
`X-API-Key` (§5.2).

---

## Proposed design

### 1. Two passes, two route pairs

Definitions and values have different tenancy, authorization and lifecycle. They do not
share an endpoint.

```
POST /custom-fields/import/preview        POST /custom-fields/import          ← definitions
POST /devices/custom-fields/import/preview  POST /devices/custom-fields/import  ← values
```

Name the services `customFieldDefinitionImport` and `deviceCustomFieldImport` — never
`customFieldImport`. `tickets.custom_fields` (`db/schema/portal.ts:74`) and the PSA/Jira
`customFields` (`services/psa/jira.ts:26`) are unrelated namesakes already in the tree.

### 2. Import formats

**CSV is a client-parsed pass-through, exactly as #3242/#3258 do it.** `apps/web/src/lib/csvParse.ts`
already ships; the API never sees a CSV byte, it receives `rows: T[]`. This keeps the API
free of a CSV dependency (there is still none in any `package.json`) and lets the browser do
column mapping against real headers.

**Canonical value row** (the wire shape; the browser maps the vendor's headers onto it):

```ts
interface DeviceCustomFieldImportRow {
  // Join keys — at least one required, resolved in the order of §4.
  deviceId?: string;                 // authoritative
  externalId?: string;               // the incumbent's device UID
  externalSystem?: string;           // 'datto_rmm' | 'ninjaone' | 'cw_automate' | 'n_central' | 'csv'
  serialNumber?: string;
  hostname?: string;
  organization?: string;             // org name or externalId, to narrow the search
  organizationId?: string;
  // Payload — one row carries every mapped column for one device.
  values: Array<{ target: MappingTarget; value: string | number | boolean | null }>;
}

type MappingTarget =
  | { kind: 'customField'; fieldKey: string }
  | { kind: 'warranty'; field: 'warrantyEndDate' | 'warrantyStartDate' | 'manufacturer' };
```

**Canonical definition row:**

```ts
interface CustomFieldDefinitionImportRow {
  fieldKey: string;                  // snake_case; /^[a-z][a-z0-9_]*$/, enforced today
  name: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  // Shape follows the SHARED contract (packages/shared/src/types/filters.ts:183), not the
  // route's current local schema — see §5.1, the two disagree today and the route is wrong.
  options?: { choices?: Array<{ label: string; value: string }>; min?: number; max?: number };
  required?: boolean;
  deviceTypes?: Array<'windows' | 'macos' | 'linux'>;
  ownerScope: 'partner' | 'organization';
  organizationId?: string;           // required when ownerScope === 'organization'
  sourceLabel?: string;              // e.g. 'udf7' — preserved in the audit, not stored
}
```

**Vendor API pull is deliberately not in v1.** Every source needs its own credential, its
own paging, and its own rate limit; #3246 (`getCompanies()`) shows the PSA-connector seam is
a separate project. The seam is left open the same way `orgImport` did it — a
`DeviceCustomFieldImportSource` interface producing canonical rows, with `csv` as the only
implementation — so a Datto connector is additive later, not a rewrite.

**A note on `udf7`.** Datto exports the slot name, not a label. The definitions importer
therefore takes `sourceLabel` and the operator supplies `name`; the web step pre-fills
`name` from `sourceLabel` so thirty slots are renamed in one screen rather than thirty
modals. `fieldKey` is snake_case only: `createCustomFieldSchema.fieldKey` and
`CUSTOM_FIELD_KEY_PATTERN` (`filterEngine.ts:43`) both enforce it, so a camelCase key can be
*read* but never created or filtered.

### 3. Where values live

#### 3.1 Carried-forward decision: promote values to a table (2026-08-09 §0, Option B)

Settled by the user on 2026-08-09 and **re-verified as still-true on 2026-09-02**. The
defect it fixes reproduces verbatim on `main`:

```sql
-- routes/partnerApi/configuration.ts:428-441 (customFieldValueSource), current main
JOIN public.custom_field_definitions f
  ON (f.org_id = eo.id OR (f.org_id IS NULL AND f.partner_id = $partnerId))
 AND d.custom_fields ? f.field_key
...
md5(d.id::text || ':' || f.id::text) AS identity_hash
```

`devices.custom_fields` is one flat jsonb keyed by a bare string, while the definition
namespace is dual-axis. When an org-owned `udf7` and a partner-wide `udf7` both exist, this
emits **two partner-export records for one datum**, each with a different synthetic id
(the hash includes `f.id`). No constraint on the current shape can prevent it — uniqueness
would have to span two nullable ownership columns across disjoint row sets — and a per-org
definitions import is precisely the thing that manufactures the collision at scale.

```sql
device_custom_field_values (
  id, device_id, org_id, definition_id,
  value_text, value_number, value_bool, value_date,
  source, created_at, updated_at
)
UNIQUE (device_id, definition_id)
```

`devices.custom_fields` stays as a **trigger-maintained projection**, so the ~34 JS readers,
both partner-export statement triggers and the MCP projection keep working unchanged; only
three SQL consumers are rewritten (`filterEngine.ts:175-182`,
`partnerApi/configuration.ts:433,440`). It additionally closes the tenant-export gap
(`devices.custom_fields` is `excludedOpen` in `tenantExportPolicyRegistry.ts`, so values are
dropped from the GDPR export today), gives `custom.<key>` filters a B-tree instead of an
unindexed `jsonb_extract_path_text` scan, and cascades away orphaned values when a
definition is deleted — a live bug today.

**[quorum] Two holes in Option B as drafted, which is why Open Decision 1 is now genuinely
open rather than a carried-forward formality.** Codex found both and they hold:

1. **The projection cannot represent the very collision the table exists to fix.**
   `device_custom_field_values` is keyed by `definition_id`, so an org-owned `udf7` and a
   partner-wide `udf7` can each hold a distinct value for one device — but
   `devices.custom_fields` is a flat object with one `udf7` key. The projection is
   lossy exactly where it matters, and the legacy backfill cannot determine *which* of two
   collided definitions owns an existing blob value. Normalizing does not remove the need to
   forbid cross-axis shadowing; it presupposes it.
2. **The existing writers are not moved.** Both `routes/devices/customFieldValues.ts:205` and
   the `PATCH /devices/:id` path (`routes/devices/core.ts:1441`) still merge into the jsonb
   directly. The draft never said to move them to the new source of truth, and never defined
   reverse synchronization — so the "source of truth" would be bypassed on day one by the two
   shipped write paths.

Both are fixable inside Option B (add the anti-shadowing constraint first; move both writers
in the same PR), but noticing that the anti-shadowing constraint is *independently sufficient*
to fix the export defect removes what was the decisive argument for normalizing at all. That
is the substance of Open Decision 1.

**If Option B proceeds it is a prerequisite PR (phase 3a), not a footnote.** Retrofitting the
storage model *after* backfilling 300k values is strictly worse than doing it before.
Sequencing is in the rollout notes.

#### 3.2 Mapping targets — not every UDF belongs in a custom field

The issue names warranty expiry first. `device_warranty` already exists
(`db/schema/warranty.ts:28-52`): one row per device (unique `device_id`), typed
`warranty_start_date`/`warranty_end_date`, a `status` enum, an index on the end date, and a
`data_source` column defaulting to `'provider'` — an `'import'` source is a designed
extension point. It feeds `warrantyAlertEvaluator.ts`, the warranty dashboard, and
`routes/partnerApi/inventory.ts`. `filterEngine` has no warranty field at all.

Importing warranty expiry into a custom field therefore ships the flagship use case
**inert**: no alert fires, the dashboard stays empty. Hence `MappingTarget` above. v1
supports `customField` and `warranty`; warranty writes `data_source: 'import'` and never
clobbers a `data_source = 'provider'` row without an explicit opt-in, because a
manufacturer lookup is more trustworthy than a hand-typed CSV.

**[quorum] Writing `warranty_end_date` alone leaves the feature inert anyway.**
`evaluateWarrantyAlerts` returns early on `status === 'unknown'`
(`services/warrantyAlertEvaluator.ts:140`), and `status` defaults to `'unknown'`. The importer
must therefore **compute and write `status`** the way `warrantySync.ts:169` does, not just the
date. An earlier draft's test assertion ("an imported end date makes the evaluator fire") would
have failed for exactly this reason. Whether warranty belongs in v1 at all is Open Decision 7.

**Reserved keys warn.** `routes/partnerApi/devices.ts:123-125` derives
`stableIdentifiers.assetTag` from `['assetTag','asset_tag']`, and likewise `inventoryId`
and `externalId`. Asset tag is one of the five fields the issue names, so importing to
`asset_tag` **does** populate a partner-integration identity contract fleet-wide — intended,
but the preview must say so on the row.

### 4. Device matching keys

Resolution order, **always within one organization**, first hit wins:

1. **`deviceId`** — authoritative.
2. **`(externalSystem, externalId)`** via a new `device_external_links` table — see below.
3. **`serialNumber`** → `device_hardware.serial_number` (`db/schema/devices.ts:235`).
   **[quorum] There is no index on this column** — `device_hardware` declares no index block
   beyond its `device_id` primary key. A serial-keyed resolution pass across a partner is a
   sequential scan per lookup. Add `(org_id, serial_number)` in the same migration wave, and
   normalise case and whitespace on both sides of the comparison.
4. **`hostname`** → `devices.hostname`, case-insensitive.

0 matches → `not-found`. More than 1 → `ambiguous`. **Never guess.**

**`device_external_links` is the substantive addition over the 2026-08-09 design**, which
had no durable device identity and accepted stranded re-imports. Two shipped tables now
establish the exact pattern: `organization_external_links` (`db/schema/orgExternalLinks.ts`,
unique on `(partner_id, system, external_id)`, composite FK to `organizations(id, partner_id)`)
and `contact_external_links` (`db/schema/contacts.ts:115-134`, unique on
`(org_id, system, external_id)`, composite FK to `contacts(id, org_id)`). Devices should get
the same thing, and `devices` already carries the `devices_id_org_id_uniq` index
(`db/schema/devices.ts:196`) that the composite FK needs.

Why it matters concretely: every source in the issue exports a stable device UID (Datto
`uid`, Ninja device id, Automate `ComputerID`, N-central `applianceID`). Recording it on the
first successful match turns a fuzzy hostname join into an exact lookup on **every**
subsequent run — which is what makes a multi-day migration (import, enroll more machines,
re-import) work at all, and what makes §6's idempotency exact rather than best-effort.

**Junk serials are already in the database and must be filtered on both sides of the join.**
The agent has the denylist — `cleanHardwareIdentityValue()`
(`agent/internal/collectors/hardware.go:156-190`): `"default string"`, `"none"`,
`"system serial number"`, `"to be filled by"`, `"o.e.m"`, and three exact all-zero strings
(`:164` — **[quorum]** an exact-match list, not a general all-zeros pattern, so a zero run of
a different length passes straight through) — but applies it **only on Windows**
(`hardware_windows.go:136`). Linux reads raw DMI (`hardware_linux.go:35`) and macOS shells out
to `system_profiler` (`hardware_darwin.go:36` — **[quorum]**, not IOKit as an earlier draft
said); both write the raw value through. Port that exact list to a
shared TS constant rather than authoring a second, divergent one, and apply it to the DB
side as well as the CSV side — otherwise every Linux box reporting `Default string`
collapses into one giant ambiguous group.

**Hostname ambiguity will be common, not rare.** `devices.hostname` is deliberately not
unique per org, and `possible_replacement_of_device_id` (`db/schema/devices.ts:159`) exists
precisely because re-imaged and replaced machines legitimately produce several rows — the
machines an MSP most wants backfilled. Rather than dead-ending them, preview returns ranked
candidates using enrollment's own collision priority chain (token-authenticated > online >
non-decommissioned > oldest, `routes/agents/enrollment.ts:514-518`) and the operator picks
one explicitly. The rule stays "never auto-pick"; the UI stops being a dead end.

### 5. Hardening the destination — prerequisites, not polish

#### 5.1 The partner-wide gate is half-shipped and is a live regression

`routes/customFields.ts` now calls `canManagePartnerWidePolicies` on the partner-wide
create branch (`:318`) and in the mutate check (`:142`). `CustomFieldsPage.tsx` was never
updated: it has no `ownerScope` control and never sends `orgId` or `partnerId` (grep: zero
hits for any of them). Because a partner-scoped user with no ownership in the body falls
through to `partnerId = auth.partnerId`, and `canManagePartnerWidePolicies` requires
`partnerOrgAccess === 'all'` (`services/partnerWideAccess.ts:25-29`), **an ordinary tech
with `orgAccess='selected'` gets a 403 from the plain create modal today.** #2135 playbook
step 6 was skipped.

Fixing that is a prerequisite for this feature and is worth fixing regardless: create-only
`ownerScope` selector plus an "All orgs" badge, pattern
`apps/web/src/components/software/PolicyForm.tsx`, hiding the partner-wide option for users
lacking the capability.

**[quorum] The selector alone is not enough** — restricted users also get unconditional Edit
and Delete controls on partner-wide rows (`CustomFieldsPage.tsx:383`), which the API then
refuses at `:142`. Phase 0 must gate those actions too, or it swaps one 403 for another.

**[quorum] Phase 0 should also fix a second, unrelated live bug in the same file.** The route's
local `customFieldOptionsSchema` declares `choices: z.array(z.string())`
(`routes/customFields.ts:12-18`), but the shared contract and the UI both use
`Array<{label, value}>` (`packages/shared/src/types/filters.ts:183`;
`CustomFieldsPage.tsx:218`). So **creating a dropdown custom field through the web UI is
rejected by its own API today.** The route schema is also missing `minLength`/`maxLength`,
which zod silently strips from the UI's `text` payload. This matters to #3257 directly:
`dropdown` is the type NinjaOne and N-central choice fields map onto, and the definitions
importer would inherit the same rejection. Reconcile on the shared type.

#### 5.2 Uniqueness, XOR, and value validation

- **Unique `field_key` per owner.** Two partial unique indexes
  (`(org_id, field_key) WHERE org_id IS NOT NULL`, `(partner_id, field_key) WHERE partner_id
  IS NOT NULL`). Without this the definitions import has no idempotency key and a re-run
  mints duplicate `udf7` rows. **Existing duplicates must be reported, not resolved:**
  deleting one silently retypes every value stored under that key (the survivor dictates
  `type`; values carry none), and renaming one orphans every value instantly and breaks
  consumers that hold the key as configuration (`remoteAccessLauncher.ts:73`
  `provider.customFieldKey`; `installerVariables.ts:30,51-53`). **[quorum] `RAISE WARNING` does not block a deploy** —
  `autoMigrate` wraps the file in `client.begin` and only a raised *exception* aborts it
  (`db/autoMigrate.ts:680-697`); a warning returns success and the file is recorded as applied
  forever. So: `RAISE WARNING` the count and the affected `(owner, field_key)` pairs
  (CLAUDE.md's forensic row-count rule), then `RAISE EXCEPTION` to abort when the count is
  non-zero. Pair it with a read-only preflight query against both prod regions before the PR
  merges, so the failure surfaces in review rather than in a deploy.
- **XOR check** `((org_id IS NULL) <> (partner_id IS NULL))`, copying
  `2026-07-01-alert-rules-partner-ownership.sql:38-48`. Today `(NULL, NULL)` is structurally
  legal, invisible to every non-system caller, and **survives org cascade forever** because
  the cascade deletes by `org_id` — a latent GDPR orphan.
- **`validateCustomFieldValue(definition, value)`** — enforce the declared `type`,
  `options.choices` for `dropdown`, `required`, and that `fieldKey` resolves to a visible
  definition. It does not exist anywhere today (grep: zero hits);
  `customFieldValueSchema` and `updateDeviceSchema.customFields` both accept an
  unconstrained `Record<string, string|number|boolean|null>`. **Apply it to the two existing
  write paths as well as the importer** — `routes/devices/customFieldValues.ts` and the
  `PATCH /devices/:id` path — otherwise the importer is validated and the trivially
  scriptable API-key route beside it is not.
- **The importer does not accept `X-API-Key`.** The existing value route's `dualAuth`
  applies `requireMfa` only on the JWT branch and deliberately skips the site allowlist for
  API keys. A bulk backfill is exactly the operation that should require MFA and honour site
  limits. Both import route pairs: `requireScope('organization','partner','system')` +
  `requireOrgWrite` + `requireMfa()`, matching `routes/orgContacts.ts:208,224,251` — see the
  scope note in "Users & scope" for why `organization` must be in that list.
- **Do not reuse `getDeviceWithOrgCheck`** (`routes/devices/helpers.ts:83-113`) on this
  path: it selects with no org predicate and checks in JS afterwards, which is fine under
  RLS and is the *only* check under a system context.

### 6. Dry-run preview, conflict policy, idempotency

**Preview → commit, mirroring `services/contacts/import.ts` exactly**, including its
TOCTOU discipline: commit re-derives every annotation against fresh state and rejects any
row whose annotation changed since preview, with identity pinning so an acknowledgement
cannot transfer to a different device.

**Value annotations:**

| Annotation | Meaning | Commits? |
|---|---|---|
| `matched` | Exactly one device resolved | yes |
| `link-match` | Resolved by `device_external_links` | yes, no acknowledgement needed — the durable link *is* the acknowledgement |
| `ambiguous` | >1 candidate; ranked list returned | only with an echoed `deviceId` |
| `not-found` | 0 candidates | no |
| `org-not-found` | No such org under this partner, **or not the caller's** — never an existence oracle | no |
| `no-definition` | `fieldKey` resolves to no visible definition | no |
| `type-error` | Value fails `validateCustomFieldValue` | no |
| `reserved-key` | Maps to `asset_tag`/`inventory_id`/`external_id` | yes, with an explicit warning shown |
| `already-set` | Stored value already equals the incoming value | reported under `skipped` |

**Definition annotations:** `create` | `already-exists` | `type-conflict`. `type` is
immutable on update today (`updateCustomFieldSchema` omits it), so a differing type is a
conflict, never a silent cast.

**Conflict policy = the contacts importer's `mode`, verbatim** (`ContactImportMode`,
`services/contacts/types.ts:128`): `skip` (default) leaves an existing value untouched and
reports it under `skipped`; `update` overwrites. Using the same word with the same default
in a third importer is worth more than a marginally better one. `update` is still a MERGE —
an absent column never erases a stored value.

**Idempotency** is therefore exact rather than approximate: re-uploading the same file in
default `skip` mode writes nothing and reports every row `already-set` or `link-match`
+`skipped`. Under §3.1's table, `UNIQUE (device_id, definition_id)` makes the upsert
authoritative; `device_external_links` makes the *match* authoritative.

#### 6.1 Annotation granularity is per VALUE, not per row [quorum]

One device row carries up to 30 values, but `no-definition`, `type-error`, `already-set` and
the `skip`/`update` conflict policy are all **per value**. The draft's flat row-level
annotation table cannot express the normal case — a row where 28 values land, one has no
definition, and one fails type validation. So:

- Every row's annotation resolves in two layers: a **row-level match outcome**
  (`matched`/`link-match`/`ambiguous`/`not-found`/`org-not-found`/`identity-conflict`) and a
  **per-value outcome** (`applied`/`skipped-already-set`/`no-definition`/`type-error`/
  `reserved-key`) carried in a `values[]` array on the annotated row.
- A row with a resolved device and a mix of good and bad values **partially applies**: good
  values are written, bad ones are reported. Atomicity is per row-transaction, so a
  `write-failed` rolls back that device's values only.
- **The 1000 cap must bound expanded values, not device rows.** 1000 rows × 30 values is
  30,000 writes in one request. Cap both: `MAX_IMPORT_ROWS` (1000) **and**
  `MAX_IMPORT_VALUES` (a separate, lower ceiling on `sum(row.values.length)`), rejected at the
  zod layer with a message telling the browser to split the chunk.
- The summary counts values, not rows, or an operator cannot reconcile "30,000 in the file"
  against "1,180 imported".

**`identity-conflict` is a new row outcome [quorum].** The draft said "first hit wins" across
`deviceId` → link → serial → hostname. When a row supplies several identifiers that resolve to
*different* devices, first-hit-wins silently picks one and discards evidence that the row is
wrong. Resolve every supplied identifier, and when they disagree, annotate `identity-conflict`
and refuse — the same "never guess" rule already applied to `ambiguous`.

**Response contract:** always HTTP 200, even with a non-empty `errors[]` — the web caller
consumes it through `runAction`, which treats a `success: false` body as a hard failure and
would hide an otherwise-successful partial import. Errors carry a typed `code`, never
free text, and `write-failed` copy is chosen from the SQLSTATE rather than the driver
message (a pg error's `.message` carries column values and constraint text). All three
rules are lifted from `ContactImportSummary`.

**Row cap 1000** (`MAX_IMPORT_ROWS`, shared) — and see §6.1 on why the cap must also bound
*expanded values*, not just device rows.

**One transaction per DEVICE ROW. [quorum]** An earlier draft said "one transaction per
org-chunk"; that is wrong twice over, and the shipped precedent already says so in a header
comment. `services/contacts/import.ts:9-16` gives each row its own transaction because inside
one Postgres transaction per-row failure isolation is *unachievable* — a failed statement
aborts the transaction and every later statement raises 25P02. A per-org chunk therefore
cannot return a trustworthy per-row `write-failed` at all: the first bad row poisons the rest
of the chunk. Route handlers already run inside the request's `withDbAccessContext`
transaction, so each row escapes via `runOutsideDbContext` and opens its own, exactly as
`contacts/import.ts` and `orgImport` do.

Per-row transactions also satisfy the lock constraint strictly better than chunking did.
`breeze_partner_export_devices_update()` is an `AFTER UPDATE … FOR EACH STATEMENT` trigger on
`devices` whose change tuple **includes `custom_fields`**
(`2026-07-18-partner-export-org-locks.sql:317-352`), and on a custom-field change it calls the
org-lock helper, which takes a shared partner lock plus `pg_advisory_xact_lock(...)` per org
(`2026-07-22-partner-export-lock-upgrade-hardening.sql:99,113`). That lock is
**transaction-scoped — released at transaction end, on commit *or* rollback**, not "only at
COMMIT" as an earlier draft said.

Two corrections to that earlier draft, both **[quorum]** and both verified:
- The second trigger, `breeze_partner_export_z_custom_values_update`, does **not** normally
  take an additional partner-exclusive lock — it observes the org lock already recorded and
  skips acquisition (`2026-07-24-partner-export-configuration-material-state.sql:68`).
- "Blocks heartbeats for those orgs" was overstated. Routine heartbeat fields are absent from
  the trigger's comparison tuple, so an unrelated device's heartbeat does not contend on the
  advisory lock. **Enrollment does**, and a heartbeat touching one of the imported devices can
  still wait on ordinary row locks. The constraint is real; its blast radius is narrower than
  claimed.

The projection trigger in §3.1 keeps the same locks in play, so this holds under either
storage outcome.

### 7. UI flow

One "Import from another RMM" utility reachable from the device list and from Settings →
Custom Fields, modelled on `apps/web/src/components/organizations/BulkContactImport.tsx`
(the newest and most complete of the two shipped importers).

```
Step 0  Source picker — Datto RMM / NinjaOne / ConnectWise Automate / N-central / Generic CSV
        (chooses header presets for guessMapping and sets externalSystem)
Step 1  Definitions ─ upload the incumbent's field list
        → ownerScope: All orgs (partner-wide) | one organization   [gated per §5.1]
        → rename udf1..udf30 in one grid, pre-filled from sourceLabel
        → preview: create / already-exists / type-conflict
        → commit
Step 2  Values ─ drag-drop CSV → csvParse.ts
        → per-column mapping target (custom field | warranty | ignore) + join-key column
        → preview table with per-row status badges
        → ambiguous rows expand to ranked candidates, require an explicit pick
        → commit in 1000-row chunks, cumulative progress, partial success surfaced
```

Step 1 is skippable when the definitions already exist (a re-run). `select-all` spans only
`matched` and `link-match` rows — never `ambiguous`, matching the existing guard that a bulk
toggle must not opt hundreds of rows into a fuzzy match. All results surface through
`runAction`, including partial success across chunks. Tab state goes in
`window.location.hash` per CLAUDE.md, not query params.

---

## Tenancy & data model impact

### `device_custom_field_values` — RLS shape 5 (device-id scoped, hot, denormalized `org_id`)

Agent-adjacent write volume, so it denormalizes `org_id` and uses a direct
`breeze_has_org_access(org_id)` policy rather than an `EXISTS` join.

| Contract | Entry |
|---|---|
| RLS | `org_id` policy in the **same migration** that creates the table; auto-discovered by `rls-coverage.integration.test.ts` (shape 1 discovery covers the `org_id` column) |
| Org cascade | `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) — alphabetical; sorts between `device_commands` and `device_groups`, both children, no FK-order hazard |
| Device cascade | `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`) |
| Device+org denorm | `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same file) — **required**, `moveOrg` must rewrite `org_id` |
| Export policy | `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) — typed columns `value_text`/`value_number`/`value_bool`/`value_date` are `included`, which **closes** the gap where `devices.custom_fields` is `excludedOpen` and values vanish from the GDPR export |

FK to `custom_field_definitions(id)` `ON DELETE CASCADE` — this is what fixes today's
orphaned-value bug. Note the definitions row itself is dual-axis, so a partner-wide
definition deleted during a partner teardown cascades values across many orgs; that is
correct and is why the FK is on `definition_id`, not a string.

**[quorum] Two tenant-coherence constraints the draft left to the app layer, which is not
good enough on a shape-5 table.** A direct-`org_id` RLS policy *trusts* `org_id`; a forged or
mistaken stamp otherwise blesses a cross-tenant row:

- **Composite FK `(device_id, org_id) → devices(id, org_id)`**, available because
  `devices_id_org_id_uniq` already exists (`db/schema/devices.ts:196`). Without it, a row can
  claim a device from another tenant while carrying an `org_id` its writer can see.
- **`definition_id` must belong to that org or to that org's partner.** There is no single-FK
  way to express this (the definition is dual-axis), so it needs a trigger or a validation
  function invoked on write. Left purely app-layer, a partner-wide `udf7` from partner B can
  be attached to a device in partner A's org and RLS will not notice.

**[quorum] `moveOrg` ordering is a real hazard for both new tables.**
`routes/devices/moveOrg.ts:211` updates the device row **first** and rewrites child
`org_id`s afterwards (`:346`). An immediate composite FK to `devices(id, org_id)` fails at
step one. Either declare the FK `DEFERRABLE INITIALLY DEFERRED` (the `ai_agents` precedent from
#4595) or reorder `moveOrg`. Verify which, with a real integration test that moves a device
carrying values — do not assume.

**[quorum] Validating a partner-wide definition from an org-scoped write path is not free.**
Org RLS on `custom_field_definitions` does not expose partner-axis rows
(`2026-06-11-i-custom-fields-dual-axis-rls.sql:28`), so `validateCustomFieldValue` on the
existing org/API-key write paths cannot see the definition it must validate against. It needs a
deliberately bounded system lookup (device → org → partner → visible definitions), not an
incidental one. Design it as a named helper with its own test, or the validation silently
degrades to "unknown key" for every partner-wide field — which is most of them (§5.1).

### `device_external_links` — RLS shape 5

Mirrors `organization_external_links` structurally. Composite FK
`(device_id, org_id) → devices(id, org_id) ON DELETE CASCADE`, available because
`devices_id_org_id_uniq` already exists. Same four registration lists as above, **including**
`CORE_DEVICE_ORG_DENORMALIZED_TABLES`. `system` and `external_id` are `included`
(tenant identifiers, not secrets); `label` is `included`.

**[quorum] The tenant export of normalized values is incomplete as drafted.**
`services/tenantExport.ts:150` reads each table by its configured org key only. Partner-wide
definitions have `org_id = NULL`, so an exported `device_custom_field_values` row would carry
an opaque `definition_id` and no `field_key`, `name` or `type` — a GDPR export the subject
cannot read. The export policy for this table must therefore **denormalize** `field_key`,
`name` and `type` into the exported projection (a `specific` policy — the escape hatch used
twice already in `tenantExportPolicyRegistry.ts`), not just list the value columns.

The unique-key axis is Open Decision 2.

### `orgMergeRegistry` — the sixth registration list, missed by the draft [quorum]

CLAUDE.md's table names five lists; `services/orgMergeRegistry.ts` is a sixth, and every
org-cascade table needs a policy in it. Both new tables must be registered.

**More consequentially, it interacts with §5.2's new unique index.**
`custom_field_definitions` is currently a plain repoint on merge
(`orgMergeRegistry.ts:491`). Adding `UNIQUE (org_id, field_key)` makes a merge **fail with
23505** whenever both the source and destination org define the same key — which, for two orgs
imported from the same Datto tenant, is every key. Blind dedupe is worse: deleting the loser
cascade-deletes its normalized values. This needs an explicit reconcile-or-rekey policy written
in the same PR as the index, not discovered by a failed merge in production.

### `custom_field_definitions` — no shape change

Already dual-axis, already in `DUAL_AXIS_TENANT_TABLES`, `CORE_ORG_CASCADE_DELETE_ORDER`
(`tenantCascade.ts:200`) and `CORE_TENANT_EXPORT_POLICY`
(`tenantExportPolicyRegistry.ts:153`). Adding two partial unique indexes and a CHECK
constraint changes **no** column, so no registration list moves. Add a
`customFieldDefinitionsPartnerRls.integration.test.ts` suite anyway (cross-partner forge →
42501, XOR → 23514, org isolation) — #2135 playbook step 6, never written for this table.

### Import jobs

**v1 is stateless — no job table.** Both shipped importers hold acknowledgement state on the
client and write audits only (`services/orgImport/audit.ts`, `services/contacts/audit.ts`).
A third importer that invents a persisted job would be the odd one out, and a job row is a
new `org_id` table with four registration lists and a retention story.

Stated explicitly because the issue asks: **if a persisted job record is ever added, it
carries `org_id` (or `partner_id` — the run is partner-scoped, so it is arguably a
dual-axis config-ish row) and must land in RLS policies, `CORE_ORG_CASCADE_DELETE_ORDER`,
`CORE_TENANT_EXPORT_POLICY` and — if it stores the uploaded rows — `excludedOpen` for any
jsonb payload column, all in the same PR.** That is the contract CLAUDE.md records as having
shipped broken five times. Whether v1 should take that on anyway is Open Decision 3.

Auditing in v1: `writeRouteAudit` per definition created and per device backfilled, carrying
`externalSystem`, the resolution method (`id`/`link`/`serial`/`hostname`) and the row count —
so a post-migration dispute about "where did this asset tag come from" is answerable.

### Known-inert surfaces — flagged, not fixed

- **No dynamic group re-evaluates after an import**, for two independent reasons:
  `events/deviceEvents.ts:114` maps `customFields → 'custom'` while `filterEngine.ts:685-687`
  records the verbatim `custom.<key>`, and an array-overlap lookup never matches; and
  `initializeDeviceEventHandlers` (`deviceEvents.ts:170`) has **no caller anywhere** in
  `apps/api/src`. The whole device-change → `updateDeviceMemberships` pipeline is unwired.
  Pre-existing and out of scope, but it means imported values do not affect targeting until
  something else touches the device. File it.
- **MCP/AI exposure**: `customFields` is in `SAFE_DEVICE_RESOURCE_FIELDS`
  (`mcpServer.ts:1875`), so every imported value is exposed to the `breeze://devices/{id}`
  MCP resource on landing.
- **Secret scanning at volume**: `custom-field-values` is classified `'customer-authored'`
  (`partnerApi/exportSafety.classification.ts:46`). A competitor's UDF dump is a plausible
  way for credentials to arrive in bulk into a store whose own route header warns it is "NOT
  A SECRETS STORE". Confirm the heuristic does not false-positive at volume and block a
  partner export.

---

## Out of scope

- **Org- and site-level custom fields.** Automate and N-central both have them and the issue
  names them. There is genuinely nowhere to put them: `custom_field_definitions` has no site
  axis, and organizations/sites carry only a generic `settings` jsonb with no value home.
  Narrower than it looks now that #3258 shipped — the most valuable org-level fields in
  practice (contract reference, account manager) are contact/contract data, which
  `organization_contacts` and the contracts module already model.
- **Vendor API pull.** Seam left open; `csv` is the only source in v1.
- **Importing values for devices that do not exist.** Devices arrive by enrollment; a value
  with no device is a pending join with no expiry. `device_external_links` makes the re-run
  after later enrollment exact, which is the right answer.
- **Changing a definition's `type` on re-import.** Immutable today; a conflict, never a
  silent cast.
- **Recording incumbent identity at enrollment** so late-arriving devices are backfilled on
  arrival. The pattern exists (`modules/mcpInvites/matchInviteOnEnrollment.ts:28-54`) and
  becomes trivial once `device_external_links` exists — file as follow-up.
- **Dynamic-group recompute after import** — the pipeline is unwired; separate issue.
- **Per-key expression indexes** — moot under §3.1.
- Contacts (#3258, shipped) and orgs/sites (#3242, shipped).

---

## Open Decisions

> Decisions **1** and **2** are live disagreements between my position and the Codex advisor.
> They are recorded unresolved, with both arguments, rather than silently picked. Decisions
> 3–6 are agreed by both; Decision 7 is new, raised by the advisor.

### 1. Storage: normalize values, or forbid cross-axis shadowing and stay on jsonb? — **DISAGREEMENT**

- **A — `device_custom_field_values` + projection (prerequisite PR).** Pro: correctness by
  construction; closes the GDPR export gap; indexes `custom.<key>`; cascades orphaned values;
  gives type validation an anchor. Con: migration + full backfill + projection trigger + three
  SQL rewrites + moving both existing writers — and, per §3.1, it does **not** stand alone: the
  projection is lossy under a collided key and the backfill cannot attribute an existing blob
  value to one of two collided definitions, so it needs C's constraint anyway.
- **B — Ship the importer on jsonb, refuse collisions at preview only.** Pro: fastest. Con: the
  collision stays reachable through `PATCH /devices/:id` and the API-key value route, which
  have no such check. Rejected by both reviewers.
- **C — Forbid cross-axis shadowing at the database, keep jsonb (Codex's position).** Make one
  effective `field_key` namespace per device: an org-owned key may not collide with a
  partner-wide key visible to that org. Pro: this **alone** fixes the export-duplication defect
  that was A's decisive argument, it is one constraint plus a cleanup report instead of a
  storage migration, and #3257 ships far sooner. Con: leaves `custom.<key>` filters unindexed
  at 100× volume, leaves values `excludedOpen` in the tenant export (closable via
  `openContainerReviewed`, `tenantExportPolicy.ts:223-227`), leaves definition deletes orphaning
  values, and the constraint itself is awkward to express — uniqueness across two nullable
  ownership columns over disjoint row sets is exactly what §3.1 says no index can do, so C needs
  a trigger or an exclusion constraint, not a unique index.

**My recommendation: A**, on CLAUDE.md's "optimize for the long term" rule — retrofitting the
storage model after 300k values land is the retrofit pattern that already cost us #1724 and
#2126–#2129. **Codex recommends C**, on the ground that A is a platform redesign smuggled into
an import feature and its decisive justification dissolves once C exists.

**Honest read of the disagreement:** Codex is right that C is sufficient for the *export*
defect, which weakens A materially. I still favour A because C's remaining costs are permanent
and compound with volume, and because C's constraint is not cheap either. **This is the one
decision that should not be settled by an agent — it is a scope-and-sequencing call for Todd.**
If #3257 needs to ship this quarter, C is the honest answer and A becomes a filed follow-up.

### 2. `device_external_links` unique key: which axis, and does it need a source-instance namespace? — **PARTIAL DISAGREEMENT**

- **A — `(partner_id, system, external_id)`**, mirroring `organization_external_links`. Pro:
  survives `moveOrg` untouched, and devices do move orgs when a migration restructures the
  tenancy tree; a Datto UID is unique across the Datto tenant, which is partner-shaped.
- **B — `(org_id, system, external_id)`**, mirroring `contact_external_links`. Con: `moveOrg`
  becomes responsible for a uniqueness invariant it does not own today.
- **C — `(partner_id, system, source_instance, external_id)` (Codex's refinement).** Adds an
  account/instance discriminator. Pro: an MSP running **two** Datto instances, or uploading two
  unrelated CSVs both keyed `1`, does not get a spurious collision — and `system: 'csv'` makes
  that failure mode near-certain, because a CSV's `external_id` namespace is whatever the
  operator's spreadsheet happened to contain. Con: diverges from two shipped link tables.

**Both agree the axis should be partner, not org.** The disagreement is C. Codex is right that
the hazard is real; the counter is that it is *already shipped twice* on
`organization_external_links` and `contact_external_links`, so introducing a third, differently
shaped link table trades a hypothetical collision for certain inconsistency.

**Recommend A now, with `source_instance` reserved:** ship the column nullable and include it in
the unique index from day one (`COALESCE(source_instance, '')`), so adopting C later is a
backfill rather than a migration of a unique key. **Flag for Todd:** if the CSV collision is
judged likely, C should be adopted for all three tables at once, not just this one.

### 3. Stateless import, or a persisted import job? — **AGREED**

- **A — Stateless**, matching #3242 and #3258. **B — Persisted `custom_field_import_jobs`.**

**Recommend A. Both reviewers agree.** [quorum] The draft's argument for A was arithmetically
wrong in A's own favour and is now corrected: because the canonical row carries *all* of one
device's values (§2), a 10,000-device backfill is roughly **10 requests, not 300**. The
resumability concern that motivated B barely exists. `device_external_links` makes any retry
exact rather than a fresh fuzzy join. Revisit only if a vendor-API source lands.

### 4. Import the incumbent's field types, or land everything as text? — **AGREED**

- **A — Import declared types, operator confirms per field.** **B — Everything as `text`.**

**Recommend A. Both reviewers agree.** B's reversibility is illusory: `type` is immutable
today, so "retype later" means delete-and-recreate, which orphans every value. A degrades to B
by inaction, because Step 1 defaults each field to `text`. [quorum] **Added requirement:** the
browser must define explicit CSV coercion rules for numbers, booleans and ISO dates before
preview, or every `number` column arrives as a string and annotates `type-error` fleet-wide.

### 5. Ambiguous hostname rows: resolve in-flow, or refuse? — **AGREED**

- **A — Ranked candidates + explicit, identity-pinned pick.** **B — Refuse; require a durable key.**

**Recommend A. Both reviewers agree.** [quorum] **With one correction:** enrollment's priority
chain orders *presentation only* and must never read as identity proof. Each candidate is shown
with serial, OS, enrollment date and last-seen so the operator picks on evidence. Codex
considers the enrollment-derived ranking itself unnecessary complexity and would ship a plain
deterministic list; that is a UI-polish disagreement, not a design one, and either satisfies the
"never auto-pick" rule.

### 6. Does the §5.1 partner-wide UI gap ship as a separate PR ahead of this feature? — **AGREED**

- **A — Separate small PR now.** **B — Fold into the definitions-import PR.**

**Recommend A. Both reviewers agree.** It is a live 403 today, independent of #3257. [quorum]
**Scope is larger than the draft said:** Phase 0 must also gate Edit/Delete on partner-wide rows
(`CustomFieldsPage.tsx:383`), and should fix the dropdown `options.choices` shape mismatch that
makes dropdown creation fail through the UI right now (§5.1). Both are shipped bugs found while
specifying this feature; neither should wait on it.

### 7. Does `warranty` stay a v1 mapping target? — **NEW, raised by the advisor**

- **A — Keep it in v1.** Pro: warranty expiry is the issue's headline field and lands inert in a
  custom field; `device_warranty` already has the alerting, the dashboard and the partner-API
  surface. Con: it is a **second destination service** with its own precedence rule
  (`provider` vs `import`), its own status computation (`warrantySync.ts:169`), and its own
  tests — and it is specified in two paragraphs while the custom-field path gets ten.
- **B — Defer to a follow-up**, ship `customField` only.

**Recommend A, but only if specified to the same depth** — otherwise B. Codex's objection is
fair: as drafted, warranty is half a feature riding along, and the status-computation gap
(§3.2) is exactly the kind of thing that half-specified scope produces. Concretely: either the
implementing plan gives warranty its own task with the status rule, the provider-precedence
rule and its own tests, or it comes out of v1 and is filed.

## Test & rollout notes

### Rollout sequence

| Phase | Content | Gate |
|---|---|---|
| 0 | §5.1 `ownerScope` selector + "All orgs" badge + Edit/Delete gating + the dropdown `options.choices` shape fix, all in `CustomFieldsPage.tsx` / `routes/customFields.ts` | Open Decision 6 — ships regardless of #3257 |
| 1 | Definition constraints migration (unique indexes, XOR) + `customFieldDefinitionsPartnerRls.integration.test.ts` | duplicate-`field_key` report must come back zero on both prod regions before the index is created |
| 2 | `validateCustomFieldValue` applied to **both** existing write paths + the importer | behaviour change on a shipped API — needs a release note |
| 2.5 | Anti-shadowing constraint: an org-owned `field_key` may not collide with a partner-wide key visible to that org | required under **both** branches of Open Decision 1 |
| 3a | `device_custom_field_values` + projection trigger + backfill + 3 SQL rewrites + **move both existing writers** onto the table | Open Decision 1 — skipped entirely if C wins |
| 3b | `device_external_links` (+ `(org_id, serial_number)` index on `device_hardware`) + resolution service + definitions importer + values importer + web UI | — |

**Migration naming:** the newest committed migration is
`2026-10-04-100003-portal-visibility-indexes.sql`. Every new file here must sort after it —
`2026-10-05-HHMMSS-<slug>.sql` or later. Today's date sorts more than a month early and would
replay ahead of shipped history. Re-check against `origin/main` immediately before push; the
pre-push hook re-runs `check-migration-naming.sh --against-ref origin/main` and the ceiling
moves.

**Production pre-flight for phase 1:** run the duplicate-`field_key` report as a read-only
query on both regions *before* merging, since the migration fails loudly by design and a
non-zero count blocks the deploy. Per the managed-Postgres lesson, any backfill statement
must set `breeze.scope = system` or it is a silent 0-row no-op as `doadmin` — CI's superuser
masks this.

### Tests

- **Resolution**: explicit id wins; link beats serial; serial beats hostname; junk serials
  excluded on **both** sides of the join; hostname collision yields ranked candidates and
  refuses to auto-pick; a cross-org hostname collision never resolves outside the caller's
  orgs.
- **Isolation (the one that matters)**: a cross-partner forge executed under **system DB
  context** is rejected by the app layer. The test must not rely on RLS, which returns TRUE
  in system scope — an appeal to RLS here is a vacuous assertion.
- **Site gating**: a site-restricted org user cannot backfill a device outside their sites.
- **Auth**: `X-API-Key` rejected on all four import routes; MFA required; an org token
  naming another partner in the body gets 403 from `resolveImportPartnerId`.
- **Validation**: `number` rejects `"abc"`; `dropdown` rejects a value outside
  `options.choices`; unknown `fieldKey` → `no-definition`; and the same validation fires on
  `PATCH /devices/:id/custom-fields` and `PATCH /devices/:id`.
- **Idempotency**: re-running an identical import in `skip` mode writes nothing and reports
  every row `already-set`/`skipped`; a second run after `device_external_links` exists
  resolves by link with zero hostname lookups (assert the query count, not just the result).
- **Transaction isolation**: a row that fails to write does not poison its neighbours — assert
  that rows after a deliberately failing row still commit (this is the property a per-org chunk
  could not provide, §6).
- **Partial value application**: a row with 28 good values, one `no-definition` and one
  `type-error` writes 28 values and reports 2, in one transaction.
- **Caps**: `MAX_IMPORT_VALUES` rejects 1000 rows × 30 values at the zod layer.
- **`identity-conflict`**: a row whose `serialNumber` and `hostname` resolve to different
  devices is refused, not resolved by first-hit-wins.
- **Tenant coherence**: a forged `device_custom_field_values` row naming a device in another
  org is rejected by the composite FK; a `definition_id` from another partner is rejected by
  the coherence trigger. Both must fail in the DATABASE, not only in the service.
- **`moveOrg`**: moving a device that carries values and an external link succeeds, and both
  children land on the new `org_id` (the FK-ordering hazard, §Tenancy).
- **Org merge**: merging two orgs that both define `asset_tag` does not raise 23505 and does
  not cascade-delete either org's values (§`orgMergeRegistry`).
- **Warranty target** (if Decision 7 keeps it): an imported `warranty_end_date` **plus a
  computed `status`** makes `warrantyAlertEvaluator` fire — assert the status write explicitly,
  since `status='unknown'` silently returns null (`warrantyAlertEvaluator.ts:140`) and a test
  that only writes the date would pass vacuously against a null return. Also: it appears in
  `routes/partnerApi/inventory.ts`, and a `data_source='provider'` row is not clobbered without
  opt-in.
- **Export**: with an org-owned and a partner-wide `udf7` both present and both valued, the
  partner export emits exactly **one** record per datum (the regression test for §3.1 —
  write it against today's code first and watch it fail).
- **Contracts**: RLS coverage, org cascade, device cascade (`CORE_DEVICE_CASCADE_DELETE_TABLES`
  **and** `CORE_DEVICE_ORG_DENORMALIZED_TABLES`), export policy, erasure roundtrip. Both
  export-policy suites need a live DB and cannot fail in **Test API** — run
  `vitest.integration.config.ts` locally before the PR.
- **Prerequisites**: the duplicate-`field_key` migration fails loudly with a count when
  duplicates exist and is a no-op when they do not; the XOR constraint rejects `(NULL,NULL)`
  and `(set,set)`; a tech with `orgAccess='selected'` cannot create a partner-wide definition
  and the UI hides the option.
- **Projection**: a value write updates both the table and `devices.custom_fields`, and still
  bumps `partner_export_updated_at`.

### Docs

Update `migration/overview.mdx` Phase 5 and each per-vendor guide (Datto, NinjaOne,
Automate, N-central) with the backfill flow and the source field surfaces named in the issue.
