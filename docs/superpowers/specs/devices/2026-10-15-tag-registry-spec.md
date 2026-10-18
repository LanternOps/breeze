---
title: Device tag registry — tag list with colors, rename/merge, case normalisation, suggestions; compliance tag-targeting fix; docs correction
status: approved 2026-10-17 — every decision approved as recommended (§11); advisor quorum Opus + Codex gpt-6-astra xhigh (§12)
date: 2026-10-15
issues: "#8837 (this spec)"
related: "#8833 (bulk edit — its Edit-tags picker consumes this registry), #8832 (dynamic groups on tags/custom fields never re-evaluate), #5425 (closed — manual-asset tags in GET /tags), #8836 / #8835 (lifecycle state / assigned contact — must NOT be tags), #3257 (custom field definitions — the org-XOR-partner + no-shadow precedent)"
---

# Device tag registry

Evidence labels: **verified** means read in source at `601877a6ef` or reproduced; **inferred** means
reasoned from code but not executed.

## 1. Problem

Device tags are a free-text `text[]` with no dictionary behind them. That makes them weak for the
inventory and classification work customers are now asking for (2026-10-15 asset/inventory ask).

- **No registry.** `devices.tags` (`apps/api/src/db/schema/devices.ts:156`),
  `manual_assets.tags` (`manualAssets.ts:44`) and `discovered_assets.tags` (`discovery.ts:218`) are
  bare arrays. A tag exists only while some row carries it. No color, no description, no rename, no
  merge. `GET /tags` and `GET /tags/devices` (`routes/tags.ts:77,156`) are read-only aggregations over
  devices and manual assets; network (discovered) asset tags are not aggregated at all. (verified)
- **No normalisation.** Only `DeviceSettingsModal.tsx:52-57` lowercases. The API route schema is
  `tags: z.array(z.string()).optional()` with no length or count limit
  (`routes/devices/schemas.ts:212`), while the shared `updateDeviceSchema` says 50 chars / 20 tags
  (`packages/shared/src/validators/index.ts:173`), and the MCP schema says 100 chars / 50 tags
  (`services/aiToolSchemas.ts:2113`). `ManualAssetModal.tsx:208` trims but keeps case. So API, MCP and
  manual-asset writes produce `Finance` next to `finance`. (verified)
- **Consumers disagree on case.** SQL matches are case-sensitive (filter engine `&&`/`@>`,
  `GET /tags/devices` `= ANY`, AI-agent trigger tags `runService.ts:643`), while backup criticality
  (`routes/backup/criticality.ts:40-58`), AI protected-resource tags (`aiGuardrails.ts:2361`) and legacy
  automation conditions (`automationRuntime.ts:1045`) lowercase first. The same tag can match in one
  feature and miss in another. (verified)
- **No picker.** Tags are typed into a text box with no suggestions; the only consumer of `GET /tags`
  in the web app is the compliance-policy editor (`automations/PolicyEditPage.tsx:91`). (verified)
- **Docs are wrong.** `apps/docs/src/content/docs/features/tags.mdx:161` says configuration policies
  support `tags` as a target type. They do not: assignment levels are
  `partner | organization | site | device_group | device`
  (`schema/configurationPolicies.ts:72-78`). (verified)
- **Compliance-policy tag targeting is broken.** See §7. (verified at the SQL level)
- Scripts already have a tag table with name + color (`script_tags`, `scripts.ts:169-178`), but it
  has no owner XOR check, no uniqueness, and is a separate vocabulary. Tickets, plugins and ticket
  forms each carry their own arrays.

## 2. Users and scope

- **MSP technician (partner scope):** defines one vocabulary (`production`, `pci-scope`,
  `pending-destruction`, `kiosk`) once and uses it across every customer org, with colors that read
  the same everywhere.
- **Org admin / internal IT (org scope):** sees the partner vocabulary, can add org-only tags, cannot
  edit partner-wide ones.
- **API / MCP / automation callers:** keep writing free-text tag arrays; the server normalises and
  registers.

In scope: the registry table, one normalisation function on every device/manual-asset/network-asset
tag write path, registry CRUD + rename + merge + delete, `/settings/tags`, a shared tag picker, the
compliance-policy targeting fix, and the docs correction.

## 3. Decisions (approved 2026-10-17; detail in §11)

| # | Decision | Why |
|---|---|---|
| D1 | New table `device_tags`: one row per tag definition, `org_id` XOR `partner_id` | Partner-Wide First (`docs/agents/tenancy-rls.md`). A tag vocabulary is config-shaped: MSPs want one list for all orgs. |
| D2 | Membership stays in the existing `text[]` columns, which store **slugs**. No join table | ~25 readers use the arrays directly (filter engine, partner API projection `partnerApi/devices.ts:77`, reports, AI tools, automation runtime, backup criticality, AI-agent subscribers). A join table means rewriting all of them plus the partner-export projection for no functional gain. The registry is a dictionary, not the membership store. See OD-2. |
| D3 | Slug = lowercase canonical identity; `name` = case-preserving display label | Fixes the `Finance`/`finance` split at the source, and makes every consumer's case behaviour agree. See OD-1. |
| D4 | One normaliser, `normalizeTagList()` in `packages/shared/src/utils/tags.ts`, and one zod schema `tagListSchema`, used on every write path | Today there are four different limits and three different case behaviours. |
| D5 | Unregistered slugs keep working. Writes register missing slugs (§5.3) | Free text must keep working for API/MCP callers and existing data. |
| D6 | Rename = change the label; changing a slug is a merge into the new slug | Keeps the common case (fix a label, add a color) zero-blast-radius. Only merge rewrites arrays. See OD-5. |
| D7 | Merge and delete rewrite arrays on devices, manual assets and discovered assets in one transaction, and rewrite structured references (§6.3) or refuse | A tag referenced by a group rule, a compliance target or an AI protected-resource list must not silently stop matching. |
| D8 | Tags stay refused as execution-target group rules in v1 | The gate exists because `devices:write` API keys, which a device-run script can hold, can write tags (`filterEngine.ts:214`). A registry does not change who can write. See OD-4. |
| D9 | Fix compliance tag targeting **and** keep its results out of every execution consumer | Fixing the SQL alone opens a self-steering path into remediation and event automations that the group gate deliberately closes (§7). |
| D10 | Settings page `/settings/tags`, catalog group `data`, next to Custom Fields | Rule 2 (settings live with their domain): tags are device-classification data, the same family as Custom Fields (`settingsCatalog.ts`). |
| D11 | Asset lifecycle state (#8836) and assigned contact (#8835) are **not** modelled as tags | Tags are an open, unordered, multi-valued vocabulary with no transitions, timestamps or history. Lifecycle is a single-valued state machine that drives behaviour (billing, reporting, disposal records); assignment is a foreign key to a contact. Modelling either as tags would lose exactly the properties those specs need, and the two would drift. |

## 4. Data model

### 4.1 `device_tags`

```sql
CREATE TABLE IF NOT EXISTS public.device_tags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid REFERENCES public.partners(id) ON DELETE CASCADE,
  org_id       uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug         varchar(50)  NOT NULL,
  name         varchar(50)  NOT NULL,
  color        varchar(7),                       -- '#RRGGBB' or NULL (neutral chip)
  description  varchar(500),
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  source       varchar(16)  NOT NULL DEFAULT 'manual',  -- 'manual' | 'auto' | 'backfill'
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT device_tags_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT device_tags_slug_format_chk CHECK (slug ~ '^[a-z0-9][a-z0-9._:-]{0,49}$'),
  CONSTRAINT device_tags_color_chk CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT device_tags_source_chk CHECK (source IN ('manual','auto','backfill'))
);
CREATE UNIQUE INDEX IF NOT EXISTS device_tags_partner_slug_uq
  ON public.device_tags (partner_id, slug) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS device_tags_org_slug_uq
  ON public.device_tags (org_id, slug) WHERE partner_id IS NULL;
CREATE INDEX IF NOT EXISTS device_tags_partner_idx ON public.device_tags (partner_id);
CREATE INDEX IF NOT EXISTS device_tags_org_idx ON public.device_tags (org_id);
```

- **No-shadow trigger** `device_tags_no_shadow` (BEFORE INSERT/UPDATE), copied from
  `2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql`: an org-owned slug may not equal a
  partner-wide slug under that org's partner, in either direction. Raises P0001 with
  operator-facing copy; the route maps it to 409. Reason: the arrays are flat, so two definitions of
  one slug would be one datum with two identities (same argument as `customFields.ts:25-28`).
- `name` uniqueness is not enforced in SQL (labels may differ only by case from another tag's slug);
  the route rejects a `name` whose normalised slug collides with another visible tag.
- `ON DELETE CASCADE` on both owner FKs matches the erasure path; the cascade list still deletes the
  org rows explicitly. `created_by … ON DELETE SET NULL` so a partner-wide definition never blocks
  erasure of the org user who created it.
- Owner columns are immutable after insert (trigger or route-level `.omit`); changing owner is the
  promote/merge path in §6.2, never an UPDATE of `org_id`/`partner_id`.

### 4.2 RLS (same migration)

Dual-axis shape, template `2026-12-28-120000-service-catalog-foundation.sql:69-88`:

- `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- One `FOR ALL` policy `device_tags_owner_access`: `breeze_current_scope() = 'system' OR (org_id IS
  NOT NULL AND breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND
  breeze_has_partner_access(partner_id))`, same expression in `WITH CHECK`.
- A separate `FOR SELECT` policy `device_tags_partner_wide_select`:
  `USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`, so org tokens see the
  partner vocabulary. Never appended to the `FOR ALL` policy.

### 4.3 Member columns

No DDL change to `devices.tags`, `manual_assets.tags` or `discovered_assets.tags`. The registry links
to them by slug only; there is no FK (and cannot be one from an array element).

Optional, in the backfill wave, behind measurement: `CREATE INDEX CONCURRENTLY devices_tags_gin ON
devices USING gin (tags)` (`-- @no-transaction` file). There is no GIN index on any tag array today
(verified by grep of `0001-baseline.sql`). Merge/delete do `WHERE tags @> ARRAY[$slug]` scoped to the
owner's orgs; at 10k devices per partner a sequential scan per merge is acceptable, so the index is
justified by the filter engine's `&&`, not by this feature. Measure first.

### 4.4 Registrations (all in the PR that adds the table)

| List | Entry | Enforced by |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `device_tags`, alphabetical | `tenantCascade.integration.test.ts` (Integration Tests) |
| `orgMergeRegistry.ts` | `{ kind: 'repoint-dedupe', key: ['slug'], keyWhere: 'org_id IS NOT NULL' }` — loser's org row colliding with the survivor's org slug is dropped, others repoint. Survivor precedence is explicit: the survivor's label, color and description win, and the dropped loser metadata is written to the merge report (`orgMergeExecutors.ts:64` deletes it otherwise). Arrays need no rewrite: they already hold the slug | `orgMerge.test.ts` (Test API, full suite only) + `orgMergeRegistry.integration.test.ts` |
| `CORE_TENANT_EXPORT_POLICY` | `tablePolicy('org_id', { included: [id, org_id, partner_id, slug, name, color, description, created_by, source, created_at, updated_at], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })` — no json/jsonb/bytea columns | `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` |
| `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`rls-coverage.integration.test.ts:869`) | `device_tags`, with the SELECT-only branch (not in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`) | `rls-coverage.integration.test.ts` |
| Device lists | none — no `device_id` column | — |
| Partner-export material triggers | none on `device_tags` in v1 (the partner API does not publish tag definitions; device rows already publish the slug array) | — |

Org merge also must keep the no-shadow invariant: a loser org row whose slug equals a partner-wide
slug of the survivor's partner (cross-partner merge) must be dropped, not repointed. If
`repoint-dedupe` cannot express that, use `kind: 'custom'` like `custom_field_definitions`
(`orgMergeRegistry.ts:676`). (inferred — confirm against the merge engine in the plan)

Device org move (`moveDeviceOrgInTransaction.ts`): tags travel with the device as slugs. A
partner-wide definition still applies after a same-partner move. An org-owned definition does not
follow, and a cross-partner move (system scope only, `routes/devices/moveOrg.ts:161`) could make an
unchanged slug silently mean something else. Reconcile in the move transaction, mirroring the
custom-field re-homing at `moveDeviceOrgInTransaction.ts:253`: for each slug with no visible
definition in the target, register an org-owned definition in the target (copying label/color,
`source = 'auto'`) and report the count in the move result and audit event. See OD-9 for the
alternative (explicit mapping or audited removal).

## 5. Write paths and normalisation

### 5.1 `normalizeTagList(input: string[]): { slugs: string[]; labels: Map<slug, label> }`

1. Deterministic transforms only: `trim()`, Unicode NFKC, collapse internal whitespace runs to
   `-`.
2. Label = that string (case preserved, ≤ 50 chars). Slug = label lowercased.
3. **Reject, don't strip:** a slug outside `^[a-z0-9][a-z0-9._:-]{0,49}$` is a 400 naming the tag and
   carrying a suggested slug; the picker previews the slug before save. Silent stripping can collapse
   distinct labels into one tag or produce an empty one (Codex, §12).
4. Drop empties; dedupe by slug (first label wins). The count limit (OD-8) is enforced on the
   **final stored array**, after add/remove are applied, not on the request list.

`tagListSchema = z.array(z.string().min(1).max(100)).max(50)` (pre-normalisation bound); the
normaliser enforces the post-normalisation bound and returns a 400 naming the bad tag.

Limits: 50 chars per tag; the per-asset count is OD-8. The backfill migration reports
`max(cardinality(tags))` per table before any cap is enforced.

Existing data cannot be rejected, so the W02 backfill applies the same transforms plus character
stripping for legacy values, and writes a **collision report** (`RAISE WARNING` per org: original
spellings that collapsed to one slug, values that became empty) so operators can see what merged.

### 5.2 Every write path (sweep; each gets the normaliser and a test)

| Path | File | Today |
|---|---|---|
| `PATCH /devices/:id` | `routes/devices/core.ts:2220`, schema `routes/devices/schemas.ts:212` | raw replace, no limits |
| `POST/PATCH /devices/manual` | `routes/devices/manual.ts:301,394`, schema `schemas.ts:144` | raw |
| `POST/PATCH /devices/network` | `routes/devices/network.ts:412`, schema `schemas.ts:192` | raw |
| `PATCH /discovery/assets/:id` | `routes/discovery.ts:1718`, schema `discovery.ts:542` | raw |
| MCP `manage_tags` add/remove | `services/aiToolsDevice.ts:795-830` | raw; `array_remove` exact-match |
| Bulk tags (#8833) | new `POST /devices/bulk/tags` | does not exist |
| Agent / heartbeat | none — no agent route writes tags (`filterEngine.ts:214`) | — |

All of them call one service, `services/deviceTags/applyTags.ts`, which normalises, registers
(§5.3) and returns the slugs to write. A contract test greps the API for writes to the three tag
columns (`tags:` in `.set({…})`/`.values({…})`, raw `UPDATE … SET tags`) outside that service and an
allowlist, the same way `no-silent-mutations.test.ts` guards the web.

`remove` in MCP and the bulk action normalise the requested tags before removal, so `remove
["Finance"]` removes `finance`.

### 5.3 Auto-registration

On write, slugs with no visible definition are registered **in the same transaction** with
`INSERT … ON CONFLICT DO NOTHING`, `source = 'auto'`, `name` = the label the writer typed,
`color = NULL`.

Owner of an auto-registered row (OD-3):

- **Partner-scope writer:** partner-wide row under `auth.partnerId`.
- **Org-scope writer (user or API key):** org-owned row. An org token cannot insert a partner-wide
  row under RLS (`breeze_has_partner_access` is false for org tokens), and escalating to system
  scope on the device PATCH path is the pattern `tenancy-rls.md` warns against. A partner admin can
  later **promote** an org tag to partner-wide (§6.2a).

No-shadow means an org writer typing a slug that already exists partner-wide simply reuses it (the
partner row is visible through the SELECT branch, so no insert happens).

Races: `ON CONFLICT DO NOTHING` does not catch the no-shadow trigger's P0001 (Codex, §12; see
`2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql:269`). `applyTags` therefore takes
`pg_advisory_xact_lock(hashtext('device_tag:' || partner_id || ':' || slug))` for each missing slug
(sorted, to avoid lock-order deadlocks), re-reads the visible definition, and inserts only if still
missing. The no-shadow trigger takes the same lock key, so a concurrent partner-wide create and an
org auto-register serialise. Registration and the array write commit or roll back together.

### 5.4 Reads

`GET /tags` becomes registry-backed: visible definitions (own org rows + partner-wide rows of the
caller's partner; partner scope sees all its orgs' rows) left-joined to in-use counts per class
(`devices`, `manual_assets`, `discovered_assets`, keeping today's ephemeral/parked/retired/linked
exclusions and the site-axis narrowing in `routes/tags.ts:94-108`). Slugs in use with no definition
are returned with `registered: false` so nothing disappears during rollout. Response keeps `id`,
`name`, `tag`, `deviceCount` for compatibility and adds `slug`, `color`, `description`, `owner`
(`partner` | `organization`), `counts`, `registered`. `GET /tags/devices?tag=` normalises its input.
Tags stay readable under `devices:read`.

## 6. Registry operations

API under `routes/tags.ts` (split into `routes/tags/` when it passes ~500 lines):

| Method | Path | Permission |
|---|---|---|
| `POST` | `/tags` | `devices:write`; `ownerScope: 'partner'` additionally `canManagePartnerWidePolicies(auth)` |
| `PATCH` | `/tags/:id` (name, color, description) | same, by the row's owner axis; `ownerScope` omitted from the update schema |
| `POST` | `/tags/:id/merge` `{ intoTagId }` | same, on both rows; MFA step-up (rewrites many rows) |
| `DELETE` | `/tags/:id?removeFromAssets=true` | same; MFA step-up when `removeFromAssets` |
| `POST` | `/tags/:id/promote` | `canManagePartnerWidePolicies(auth)` (§6.2a) |
| `GET` | `/tags/:id/references` | `devices:read` |

All mutations write audit events (`device_tag.created|updated|merged|deleted`) carrying slug, owner,
and affected-row counts.

### 6.1 Rename (label/color/description)

Changes only the definition row. Slug is immutable; arrays are untouched. Instant, no fan-out.

### 6.2 Merge A → B (also: change slug)

One transaction:

1. Lock both definition rows `FOR UPDATE`. Reject if B's owner scope is narrower than A's
   (merging a partner-wide tag into an org-only tag would strand other orgs).
2. Compute the affected org set: A's org, or every org of A's partner for a partner-wide A.
3. Partner-export pre-locks: `devices` and `discovered_assets` carry partner-export statement
   triggers (verified: `breeze_partner_export_devices_update` and the 2026-10-14 discovered-assets
   prelock migration). Acquire partners shared, then orgs exclusive, each ascending, over the
   **union** of every partner/org any statement in the operation will touch, once, before the first
   write of any table — the `services/orgMerge.ts:1189-1203` pattern. (Lock helper semantics on the
   request path are inferred; verify in W03.)
4. `UPDATE devices SET tags = array(SELECT DISTINCT unnest(array_replace(tags, A, B))), updated_at
   = now() WHERE org_id = ANY($orgs) AND tags @> ARRAY[A]::text[]`, likewise for `manual_assets`
   and `discovered_assets`. Bind slugs as `ARRAY[$1]::text[]`, never a bare JS array (§7).
5. Rewrite structured references (§6.3).
6. Delete A. Emit `device.updated` events with `changedFields: ['tags']` for the affected devices
   and request group re-evaluation through the path #8832 adds (or `requestDeviceGroupReevaluation`
   directly if #8832 has not landed).

Changing a slug in the UI is presented as "rename slug", implemented as create-B-then-merge.

### 6.2a Promote an org tag to partner-wide

The no-shadow rule forbids creating a partner-wide row with a slug an org already owns, so promote
is its own operation (`POST /tags/:id/promote`, `canManagePartnerWidePolicies`): in one transaction,
under the §5.3 advisory lock, delete every org-owned row with that slug across the partner's orgs
and insert one partner-wide row (label/color from the promoted row; the other orgs' dropped
metadata goes into the audit event). Arrays hold the same slug, so no asset row is rewritten and no
partner-export lock is needed.

### 6.3 Structured references

Tag slugs are stored by value in these places (verified by grep; the plan re-sweeps):

| Reference | Location | Merge | Delete |
|---|---|---|---|
| Dynamic group rules (`field: 'tags'`) | `device_groups.filter_conditions` jsonb (`schema/devices.ts:671`) | rewrite value | refuse unless `force`; group falls back to no match on that value |
| Saved filters | `saved_filters.conditions` jsonb (`schema/filters.ts:6`) | rewrite | rewrite (drop value) |
| Compliance targets | `automation_policies.targets.tags` / `targetIds` when `targetType = 'tags'` | rewrite | refuse while referenced |
| AI agent triggers | `ai_agents.triggers.deviceTags` (`schema/aiAgents.ts:63`; merged in `aiAgents/effectivePolicy.ts:252`) | rewrite | refuse while referenced |
| AI protected resources | `ai_script_policies.protected_resources.deviceTags` and `ai_agents.protected_resources.deviceTags` (matched in `aiGuardrails.ts:2358-2363`) | rewrite | **always refuse** while referenced — deleting a protected tag silently removes a safety control |
| Playbook triggers | `playbook_definitions.trigger_conditions.deviceTags` (`schema/playbooks.ts:72,90`) | rewrite | refuse while referenced |
| `BACKUP_CRITICAL_DEVICE_TAGS` env | `routes/backup/criticality.ts:47` | not rewritable; `GET /tags/:id/references` reports it | warn |

One module, `services/deviceTags/references.ts`, owns a `TAG_REFERENCE_REWRITERS` list. A contract
test fails when a schema column or jsonb type mentions `deviceTags`/`tags` in a device-tag sense
and is neither in the list nor in an explicit "not a device tag" allowlist (tickets, scripts,
plugins, PSA, Sentry). Same idea as the cascade lists: grep, don't judge.

All jsonb rewrites run under the same transaction as the array rewrite; config-material tables with
partner-export configuration triggers get the configuration lock order instead. None of the
tables above carries one today (verified by grep of the partner-export migrations); the plan re-checks.

### 6.4 Delete

- Default: delete the definition only. The slug stays on assets and shows as unregistered.
- `removeFromAssets=true`: also `array_remove` from the three columns, with the same locks and
  events as merge. Refused while a "refuse" reference in §6.3 exists; the 409 body lists them.

## 7. Compliance-policy tag targeting

**Status: broken — verified at the SQL level, not reproduced end-to-end through the evaluator.**

- The compliance (automation) policy UI offers "Specific tags" (`automations/PolicyForm.tsx:129,205`),
  fed from `GET /tags` (`PolicyEditPage.tsx:91`). The route accepts tag strings for `targetType:
  'tags'` (`routes/policyManagement/helpers.ts:128-130,150-167`), and the evaluator keeps them
  (`policyEvaluationService.ts:402`; `sanitizeUuidList` at `:376` keeps any non-empty string despite
  its name).
- `resolveTargetDevices` then builds `sql\`${devices.tags} && ${targets.tags}\``
  (`policyEvaluationService.ts:1355-1364`). Rendering that with Drizzle 0.45.3's `PgDialect`
  produces `"devices"."tags" && ($1)` for one tag and `&& ($1, $2)` for two. Executed against
  Postgres 16 (prepared statement, untyped parameter): one tag → `ERROR: malformed array literal:
  "finance"`; two tags → `ERROR: operator does not exist: text[] && record`. Every tag-targeted
  compliance policy therefore throws on every evaluation, and
  `automationPolicyTargetedDeviceIds` (the alert-reconcile path) throws too. This is the bug class
  #8297 fixed in `aiToolsDevice.ts:806-809` and #8760 fixed in `filterEngine.ts:589-591,648-649`.
- No test covers this branch (`grep tags` over the `policyEvaluationService*.test.ts` files finds
  nothing).

Fix (its own small PR, W01 — it does not need the registry):

1. Bind as `ARRAY[$1, …]::text[]` (reuse `sqlTextArray` from `filterEngine.ts:601`, exported to a
   shared `db/sqlArrays.ts`), normalising target tags with `normalizeTagList`.
2. **Separate observation from execution.** Tag-targeted resolution feeds
   `triggerRemediationAutomation`, which the groups branch deliberately protects with
   `resolveExecutionSafeGroupIds` (`:1327-1341`) so a device cannot steer itself into automatic
   remediation. Tags are refused for exactly that reason, so fixing the SQL alone would open that
   path. Skipping direct remediation is **not enough**: a non-compliant evaluation still emits
   `policy.violation` (`policyEvaluationService.ts:1497-1503`), and event-triggered automations bind
   straight to the event's device (`jobs/automationWorker.ts:727-740`) (verified). Copying the group
   gate literally would also suppress the observation, because it runs before evaluation. So:
   - tag-targeted policies **evaluate and report** compliance as normal;
   - their evaluation results carry `executionEligible: false` (target provenance
     `agent_writable_tags`), stamped on the `policy.violation` / `policy.evaluated` event payloads
     and on any alert the policy alert bridge creates from them;
   - every execution consumer refuses flagged items: direct remediation dispatch, event-triggered
     automations, alert-triggered automations and AI-agent alert triggers. Each refusal writes
     `policy_evaluation.execution_target_refused_agent_reported_fields` (same action string as the
     group path);
   - the policy form shows a notice when a remediation is configured with tag targets.
   If OD-4 later lifts tags for restricted tags, the flag is computed from that rule instead.
3. Tests: a real-Postgres integration test proving one- and two-tag targeting match the right
   devices; unit tests that a tag-targeted violation dispatches no remediation and that an
   event-triggered automation refuses a flagged `policy.violation`.

## 8. Docs

`features/tags.mdx`:

- Remove "Configuration policies … support `tags` as a target type" (line 161). Replace with: compliance
  policies support tag targets (evaluation and reporting; remediation is not auto-dispatched to tag
  targets); configuration policies target partner / organization / site / device group / device —
  use a device group (static, or dynamic on non-tag rules) to target a subset.
- Replace "There is no separate tag definition table" (line 14) with the registry model:
  slugs on assets, definitions with color/description, partner-wide vs org-only, normalisation rules,
  rename vs merge.
- Add `/settings/tags` and the new endpoints to the API reference table.
- Note that dynamic groups using tags cannot be execution targets, and why.

The docs correction ships with W01 (the targeting fix) so the wrong claim does not wait on the
registry.

## 9. Web UI

- **`/settings/tags`** (`pages/settings/tags.astro`, `components/settings/TagsSettings.tsx`),
  registered in `settingsCatalog.ts` (group `data`, `requiredPermission: devices:read`) so
  `settingsPageRegistry.test.ts` passes. List with chip preview, slug, owner badge ("All orgs" for
  partner-wide), per-class counts, unregistered rows at the bottom with "Register". Row drawer Save
  (rule 7, list screen). Merge and delete are actions with a confirmation that shows the affected
  counts and the references from `GET /tags/:id/references`. Create form has the create-only
  `ownerScope` selector (pattern `components/software/PolicyForm.tsx`).
- **Rule 9 statement for the PR:** home `/settings/tags`; levels partner (default) and org
  (org-only additions, no per-org override of a partner tag's color in v1); resolver
  `services/deviceTags/resolve.ts` (visible definitions for an org); configured in 0 places before
  (no tag settings exist), 1 after.
- **`TagPicker` component** (`components/devices/TagPicker.tsx`): typeahead over `GET /tags?search=`,
  color chips, "Create `<label>`" row when nothing matches, shows the normalised slug it will save.
  Used by `DeviceSettingsModal`, `ManualAssetModal`, the network-asset edit form, and the #8833 bulk
  Edit-tags action. Mutations go through `runAction`.
- **Chips everywhere tags render** (`DeviceList.tsx:2349-2375`, device detail, asset modals) use the
  registry color via one `useTagRegistry()` hook (cached, invalidated on tag mutations). Unregistered
  slugs render neutral.
- `QuickAddChips.tsx:29` "Untagged" chip is unchanged.
- New strings in all 7 locales (`localeParity`).

## 10. Out of scope

- **Unifying ticket, script, plugin and ticket-form tags** with device tags. They are different
  vocabularies with different owners and audiences; `script_tags` keeps its join table. A later spec
  can reuse `device_tags`' shape.
- **Configuration-policy assignment by tag** (a new `config_assignment_level`). Device groups are
  the assignment vehicle; see OD-4 for when tag-ruled groups could qualify.
- **Tag categories / key-value tags** (`env:prod`). The slug charset allows `:` so a later
  category feature can parse it; no category column now.
- **Per-org overrides of a partner tag's color or label.**
- **Lifecycle state (#8836) and assigned contact (#8835).** Not tags (D11).
- **Group re-evaluation on tag change** — fixed by #8832; this spec only calls it.

## 11. Decisions (approved 2026-10-17)

The owner approved every open decision as recommended on 2026-10-17. The numbering is kept so
earlier references (OD-n) still resolve. Rejected options stay listed so the reasoning survives.

**OD-1 — Case handling. Approved: (a)** lowercase slug for identity plus a case-preserving display
`name`. It fixes the split at write time, makes every existing consumer agree without touching them,
and still lets an MSP show `PCI-Scope`. Rejected: (b) case-preserving storage with case-insensitive
matching everywhere (`citext[]` or `lower()` in every reader; needs every reader changed and
expression indexes); (c) lowercase everything with no display label (loses legitimate presentation).

**OD-2 — `text[]` of slugs vs a join table. Approved: (a)** keep `text[]` of slugs; the registry is a
dictionary. About 25 readers, the filter engine and the partner API projection read the arrays.
Rejected: (b) `device_tag_assignments(device_id, tag_id)` plus equivalents for the two asset tables
(three new device-child tables, each with cascade, move, merge and export registration, and a rewrite
of every reader, for referential integrity the write-path choke point and the reference registry
already give). Revisit only if tags need per-assignment metadata (who/when).

**OD-3 — Default owner and auto-registration. Approved: (a)** partner-wide by default for partner
writers, org-owned for org writers, with a promote action (§6.2a), and (c)'s "unregistered" display
as the safety net. Rejected: (b) always partner-wide through a narrow `SECURITY DEFINER` registration
function callable by org tokens (lets every org-scoped API key grow the partner vocabulary across all
the partner's orgs); (c) no auto-registration (leaves the registry incomplete and the picker partial).

**OD-4 — Lifting execution-target gating for tag rules. Approved: (a) now, (b) as a follow-up wave
(W05)** after every write path goes through `applyTags`. (b) adds `device_tags.restricted boolean`;
assigning or removing a restricted tag requires a session user with a new
`devices:tags:restricted` permission (never grantable to API keys or the device-script surface) and
goes through `applyTags`; the filter gate becomes value-aware and allows a `tags` rule only when
every value is a restricted tag of the group's owner; compliance tag targets lift on the same rule.
Conditions (b) must meet (Codex): allow only non-empty exact-membership predicates
(`hasAny`/`hasAll`/`contains` over restricted values; `isEmpty`/`isNotEmpty` stay refused, because
emptiness is controllable through ordinary tags); protect whole-array replacement, merge, delete,
move and restricted→unrestricted downgrades; recheck at dispatch. The same wave covers two execution
consumers that trust tags outside the filter engine today (verified): legacy automation tag
conditions match by **substring** (`automationRuntime.ts:1045-1046`, so `prod` matches
`production`), and AI-agent run scoping trusts `triggers.deviceTags` directly
(`aiAgents/runResourceScope.ts:47-48`). Rejected: (c) lift entirely once registry-backed — the gate
is about who can write, not typos.

**OD-5 — Rename semantics. Approved: (a)** label-only rename, slug immutable; a slug change is a
merge. The frequent operation touches one row; the rare one goes through the audited, locked merge
path. Rejected: (b) rename rewrites the slug everywhere; (c) an alias table resolved at match time
(adds a read-time indirection to every matcher).

**OD-6 — References on merge/delete. Approved: (a)** rewrite structured references on merge; refuse
delete while referenced; always refuse delete for AI protected-resource tags. Merge and
`removeFromAssets` delete ship in v1. Codex's reservation is recorded: rewriting cannot reach
external integrations or `BACKUP_CRITICAL_DEVICE_TAGS`, which is why `GET /tags/:id/references`
reports those and the confirmation dialog shows them. The implementation plan puts merge and delete
in their own wave after the reference registry and its contract test are green (Codex's middle
ground), so the risk lands in the same order either way. Rejected: (b) refuse merge and delete while
any reference exists (makes merge, the main cleanup tool, unusable on a real fleet); (c) rewrite
arrays only and warn (silently breaks group rules, compliance targets and AI safety lists).

**OD-7 — Compliance tag targets and remediation. Approved: (a)** fix the SQL, evaluate and report,
and mark results `executionEligible: false` so remediation, event-triggered automations,
alert-triggered automations and AI-agent alert triggers all refuse them until OD-4(b). Rejected: (b)
fix the SQL with no gate (a self-steering path into remediation the group gate forbids); (c) remove
`tags` from compliance `targetType` (breaks saved policies).

**OD-8 — Per-asset tag count. Approved: (a) 50**, applied to the **final stored array**. The shared
`updateDeviceSchema` (`validators/index.ts:173`, 20 tags) is raised to 50 in the same change so the
documented contract matches. A write that does not grow an array already above 50 (legacy data) is
allowed, so over-cap assets can always be cleaned up. Codex preferred 20 as the documented contract;
the owner chose 50. The backfill still reports `max(cardinality(tags))` per table.

**OD-9 — Org-owned tags on device org move. Approved: (a) for same-partner moves, (b) for
cross-partner moves.** Same-partner: for each slug with no visible definition in the target org,
auto-register an org-owned definition there (copying label/color, `source = 'auto'`) and report the
count in the move result and audit event. Cross-partner (system scope only): the move requires an
explicit mapping from each unresolved slug to a target slug or to removal, and removals are audited.
Dropping slugs silently on a same-partner move would lose customer data, and bulk move paths cannot
ask the mover mid-move; cross-partner moves are rare enough to deserve the mapping step.

## 12. Advisor quorum

Position formed first (Opus), then one independent read-only `codex exec` (gpt-6-astra, xhigh)
critique on 2026-10-15.

**Agreed and folded in:** keep `text[]` of slugs (D2); XOR ownership, per-owner uniqueness, no-shadow
trigger and a separate SELECT-only branch (§4); org writers auto-register org-local, never
partner-wide, and partner tags come from explicit create/promote (§5.3, OD-3); label-only rename with
immutable slug (OD-5); keep execution gating in v1 (OD-4); `/settings/tags` in the Data group;
lifecycle and contact stay structured fields (D11). Folded-in additions from Codex:
`XOR_OWNERSHIP_DUAL_AXIS_TABLES` registration; advisory lock because `ON CONFLICT` does not catch the
no-shadow P0001; reject instead of silently stripping characters; collision report in the backfill;
limit applied to the final array; explicit survivor precedence on org merge; cross-partner move
handling; pre-lock the union before all statements; the `policy.violation` → event-automation path
that makes remediation-only gating insufficient (§7, verified); the substring-matching legacy
automation condition and AI run-scope tag trust (OD-4); emptiness predicates in the v2 gate.
Codex's point that `filter_fields_used` holds field keys, not tag values, is correct; §6.3 does not
rewrite it.

**Disagreements, resolved by the owner 2026-10-17:** OD-6 (merge and force-delete ship in v1, in their
own wave), OD-8 (50 tags per asset, final array), OD-9 (auto-register on same-partner moves, explicit
mapping on cross-partner moves).

## 13. Test and rollout

### Waves

- **W01 — compliance fix + docs** (no registry): §7 and §8 first two bullets. Small PR.
- **W02 — normalisation**: `normalizeTagList`, `tagListSchema`, `applyTags` on every write path in
  §5.2, the write-site contract test. Backfill migration lowercases existing arrays.
- **W03 — registry**: migration (table, RLS, no-shadow trigger, backfill registration), registrations
  (§4.4), registry-backed `GET /tags`, CRUD, rename, merge, delete, references module.
- **W04 — UI**: `/settings/tags`, `TagPicker`, colored chips, locales. #8833's bulk Edit-tags lands
  on the picker.
- **W05 — restricted tags** (OD-4(b), approved as a follow-up wave).

### Migrations

- Names sort after the newest committed migration at implementation time (currently
  `2026-12-28-130000-…`; check, don't assume), `YYYY-MM-DD-HHMMSS-<slug>.sql`.
- Idempotent; no inner `BEGIN`/`COMMIT`; `SELECT set_config('breeze.scope', 'system', true);`
  before the first write.
- **W02 lowercase backfill** writes `devices` and `discovered_assets`, which carry partner-export
  statement triggers: pre-lock partners shared then orgs exclusive, ascending, over every affected
  row, per the `2026-10-14-100050-discovered-assets-source-backfill-prelock.sql` shape
  (`migrationPartnerExportLocks.test.ts`). Report counts with `GET DIAGNOSTICS` + `RAISE WARNING`.
  Also report `max(cardinality(tags))` per table for OD-8.
- **W03 registration backfill** inserts one `device_tags` row per distinct slug: partner-wide under
  the org's partner when the slug is used in that partner's orgs (the no-shadow rule forbids an org
  copy of the same slug), `source = 'backfill'`, `name` = the most frequent original-case spelling
  seen before W02 lowercased it (captured into a temp table in W02, or re-derived from audit if W02
  has shipped first — pick one in the plan), `color = NULL`. Orgs without a partner (if any exist
  in self-hosted installs) get org-owned rows. Read and insert under system scope.
- `pnpm db:check-drift` after each schema change.

### Tests

- Unit: `normalizeTagList` table tests (case, whitespace, unicode, separators, dedupe, limits);
  each write path normalises (route tests with Drizzle mocks); MCP `remove` normalises.
- Contract: write-site grep test (§5.2); tag-reference registry test (§6.3).
- Integration (real Postgres, Integration Tests job): `deviceTagsPartnerRls.integration.test.ts`
  (cross-partner forge 42501, XOR 23514, no-shadow P0001, org token reads partner rows but cannot
  write them, org isolation); merge rewrites arrays across all three tables in one transaction and
  rolls back on a failed reference rewrite; merge under partner-export triggers with two orgs does
  not raise a lock-hierarchy error; compliance tag targeting (§7).
- Registries: `tenantCascade.integration.test.ts`, `orgMergeRegistry.integration.test.ts`,
  `orgMerge.test.ts` (full unit suite), `tenant-export-policy.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts`, `rls-coverage.integration.test.ts`.
- Web: `settingsPageRegistry.test.ts`, `no-silent-mutations.test.ts`, `localeParity`, `TagPicker`
  tests; Playwright (data-testid) for create → assign → merge.
- Run the full contract suites before the W03 PR (tenancy code touched).

### Rollout

No feature flag needed: W02 and W03 are backward compatible (arrays keep their shape; `GET /tags`
keeps its old fields). Self-hosters: release notes mention that tags are now lowercased on write and
existing tags were lowercased by migration, and that `BACKUP_CRITICAL_DEVICE_TAGS` already matched
case-insensitively.
