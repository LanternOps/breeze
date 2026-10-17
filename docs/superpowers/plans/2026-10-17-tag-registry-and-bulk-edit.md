---
title: Tag registry (#8837) + bulk edit tags and custom fields (#8833) — combined implementation plan
date: 2026-10-17
status: draft — awaiting owner approval
specs:
  - docs/superpowers/specs/devices/2026-10-15-tag-registry-spec.md
  - docs/superpowers/specs/devices/2026-10-15-bulk-edit-tags-custom-fields-spec.md
tracking_issue_8837: TBD — register after approval
tracking_issue_8833: TBD — register after approval
tracking_issue: TBD — register after approval (two features; register #8837 and #8833 separately, one parent each)
---

# Tag Registry + Bulk Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give device, manual-asset and network-asset tags one normalised slug vocabulary with a
partner-wide/org registry (colors, rename, merge, delete, restricted tags), and let technicians
bulk-edit tags and custom-field values on a device-list selection.

**Architecture:** Tags stay `text[]` of lowercase slugs on the three asset tables (spec 8837 D2). A
new dual-axis `device_tags` table (org XOR partner) is the dictionary. Every tag write goes through
one service, `services/deviceTags/`, which normalises, takes per-slug advisory locks,
auto-registers missing definitions and computes deltas under a row lock. The bulk routes
(`/devices/bulk/tags`, `/devices/bulk/custom-fields`) authorise the whole selection once, then write
one short transaction per org in ascending org UUID order, reusing that service.

**Tech Stack:** Hono + Drizzle (queries only) + hand-written SQL migrations, PostgreSQL 16 forced RLS,
BullMQ (dynamic-group re-evaluation), Astro + React islands, Vitest (unit, integration, RLS coverage),
Playwright (`data-testid` only).

**Specs:** `docs/superpowers/specs/devices/2026-10-15-tag-registry-spec.md` (cited as **R§n**, decisions
**R-OD-n**) and `docs/superpowers/specs/devices/2026-10-15-bulk-edit-tags-custom-fields-spec.md`
(cited as **B§n**, **B-OD-n**). Both approved 2026-10-17 with every decision as recommended.
Executors read the relevant spec sections before each wave.

## Global Constraints

- Slug format, everywhere (SQL CHECK, shared regex, backfill output): `^[a-z0-9][a-z0-9._:-]{0,49}$`.
- Label (`device_tags.name`) ≤ 50 chars, case preserved. Color `^#[0-9a-f]{6}$` or NULL. Description ≤ 500.
- Request bounds before normalisation: delta lists (`add`, `remove`, MCP `tags`)
  `tagListSchema = z.array(z.string().min(1).max(100)).max(50)`; whole-array replacement bodies
  `tagReplaceListSchema = z.array(z.string().min(1).max(100)).max(500)`, so a legacy 60-tag asset can be
  saved as 59 (the 50 cap is enforced on the final array, not on the request, Codex P5).
- Per-asset tag cap: **50 on the final stored array** (R-OD-8). A write that does not grow an array
  already above 50 is allowed.
- Bulk selection cap: 500 ids (`BULK_LIFECYCLE_MAX_DEVICES`, `routes/devices/schemas.ts:450`); server dedupes.
- `manage_tags` with `deviceIds`: 1..50 ids; add/remove are **Tier 3**, `list` stays Tier 1 (B-OD-2).
- Bulk routes: `devices:write` + `requireMfa()`, synchronous, `200 { bulkId, succeeded, failed }` even when all fail.
- Arrays bound per element only: `sqlTextArray` / `sqlUuidArray` from `apps/api/src/db/sqlValues.ts`.
  Never `${jsArray}::text[]`.
- Migrations: `apps/api/migrations/2026-12-30-19HH00-<slug>.sql` (slots below), idempotent, no inner
  `BEGIN`/`COMMIT`, `SELECT set_config('breeze.scope', 'system', true);` before the first write, RLS in
  the same file as the table, `pnpm db:check-drift` after. Newest committed migration at plan time:
  `2026-12-30-120900-trust-page-templates.sql` — re-check before committing.
- Advisory lock class for tag slugs: `pg_advisory_xact_lock(1000258, hashtext(<partner_id>::text || ':' || <slug>))`
  (custom fields use 1000257; partner-export 1000200–1000202; 1000301–1000302 taken).
- Web mutations go through `runAction`; bulk calls **without** `successMessage` (B§4.5).
- New UI strings in every locale under `apps/web/src/lib/i18n/` (localeParity).
- No customer names, hostnames or IPs in code, tests, docs or PR text.
- Audit actions: `device_tag.created|updated|merged|deleted|promoted`, `device.tags.update`
  (bulk, `details: { added, removed, bulk: true, bulkId }`), `device.custom_field.update`
  (bulk, `details: { changedFields: [fieldKey], bulk: true, bulkId, value? }` — `value` only for
  `dropdown`, `boolean`, `date`, B-OD-5), `manual_asset.tags.update`.

## Review Focus

1. **Legacy rule values with case or spaces** (`Finance Dept` stored in a dynamic-group rule, AI
   protected list, compliance target or AI-agent trigger) must keep matching the backfilled slug
   `finance-dept`. Test owner: W02b Task 4.
2. **A legacy asset with more than 50 tags** must stay editable: removing tags works, adding to it
   fails with a clear per-tag message, nothing truncates silently. Test owners: W02b Task 2 (pure
   delta), 8833 W1 Task 3 (`TAG_LIMIT_EXCEEDED`).
3. **A partner technician with `org_access = 'selected'`** tagging a device must never create a
   partner-wide definition (it would publish into orgs they cannot see). Test owner: W02b Task 2.
4. **Slug owned by org A, partner admin tags a device in org B with the same slug** must succeed with
   an org-owned row in B — not a P0001 from the no-shadow trigger and not a 500. Test owner: W02b Task 2.
5. **A configured tag value that normalises to nothing** (`***` in a policy target, `hasAll` rule or AI
   trigger) must match **no** device. Today an empty tag list can fall back to "all devices"
   (`policyEvaluationService.ts:416-420`) and `hasAll([])` matches everything (Codex). Test owner:
   W02b Task 2.4.

---

## 0. State on main at plan time (verified 2026-10-17, `838db35c67`)

| Spec item | State | Consequence for this plan |
|---|---|---|
| R§7 compliance tag targeting (8837 W01) | **Shipped** in #8895 (`62c3cd0087`): tag targets evaluate and report, publish no `policy.*` events, dispatch no remediation, audit `policy_evaluation.execution_target_refused_agent_reported_fields`. `sqlTextArray`/`sqlUuidArray` live in `apps/api/src/db/sqlValues.ts`. | No W01 wave. See PD-1 for the event flag. |
| R§8 docs: config policies cannot target tags | **Shipped** in #8895 (`features/tags.mdx:161`, `:177`). | Remaining docs (registry model, line 14; endpoints; `/settings/tags`) ride W03a and W04. |
| #8832 group re-evaluation on tag / custom-field writes | **Shipped** in #8903: `requestDeviceGroupReevaluationAfterCommit` (`jobs/deviceGroupJobs.ts`) is called by `PATCH /devices/:id` (`core.ts:2299-2316`), `manage_tags` (`aiToolsDevice.ts:824-830`) and `persistDeviceCustomFieldValues`. | B§3 D10 is satisfied by calling the same function. 8833 W1 is unblocked. |
| `organizations.partner_id` | `NOT NULL` (`db/schema/orgs.ts:212`) | No partnerless orgs; every org-owned row has a resolvable partner for the lock key. |
| Org merge | Same partner only (`services/orgMerge.ts:383,732`) | R§4.4's cross-partner no-shadow concern on merge does not arise. A `custom` executor is still needed to report dropped loser metadata (Task 1.2). |

## 1. Wave map

One PR per wave, each independently shippable, merged in this order. "Contract suites" lists the
contract tests the wave must turn (or keep) green; integration suites run **only** in the
`integration-test` CI job and on a local test stack, never via `pnpm test`.

| # | Wave | PR title (prefix) | Depends on | Migration | Tenancy shape | Contract suites that fire |
|---|---|---|---|---|---|---|
| 1 | **8837 W02a** registry table + label-capturing registration backfill | `feat(tags): device_tags registry table (W02a)` | — | `2026-12-30-190000-device-tags-registry.sql` | dual-axis, org XOR partner, SELECT-only partner branch | rls-coverage (DUAL_AXIS + XOR), tenantCascade, tenant-export-policy, tenantExportErasureRoundtrip, orgMergeRegistry (+ `orgMerge.test.ts`), migrationRlsScope, check-migration-naming |
| 2 | **8837 W02b** normalise every write + lowercase backfill + reader match normalisation | `feat(tags): normalised tag slugs on every write path (W02b)` | 1 | `2026-12-30-190100-device-tags-slug-backfill.sql` | writes `device_tags` from request paths | partner-wide-write-coverage, new `deviceTagWriteSites.contract.test.ts`, migrationPartnerExportLocks, migrationRlsScope, aiToolsDeviceScope, aiToolsSiteScope |
| 3 | **8837 W03a** registry API: list, create, rename, promote | `feat(tags): registry-backed /tags API (W03a)` | 2 | none | partner-wide write gate | partner-wide-write-coverage, rls (deviceTagsPartnerRls) |
| 4 | **8837 W03b** references registry, merge, delete | `feat(tags): tag merge and delete with reference rewrite (W03b)` | 3 | none | partner-export prelock on request path | new `deviceTagReferences.contract.test.ts`, integration merge suite |
| 5 | **8837 W03c** tags on device org move | `feat(tags): reconcile tag definitions on device org move (W03c)` | 2 | none | cross-org, cross-partner (system) | moveOrg suites |
| 6 | **8833 W1** bulk routes on a shared helper | `feat(devices): bulk edit tags and custom fields API (#8833 W1)` | 2 (#8832 shipped) | none | per-org tx, ascending org UUID | selfManagedDbContextRoutes, mount-order, integration bulk suite |
| 7 | **8833 W2** web: bulk menu + dialogs + shared custom-field editor | `feat(web): bulk edit tags and custom fields (#8833 W2)` | 6 (W03a for colored suggestions, optional) | none | — | no-silent-mutations, bulk gating contract (`DeviceList.test.tsx`), localeParity |
| 8 | **8833 W3** `manage_tags` `deviceIds[]`, Tier 3 | `feat(ai): bulk manage_tags through the shared writer (#8833 W3)` | 6 | none | MCP single-org | aiToolsDeviceScope, aiToolsSiteScope, aiToolIndex cap, guardrail tier contracts |
| 9 | **8837 W04** UI: `/settings/tags`, `TagPicker`, colored chips | `feat(web): tag settings page and picker (W04)` | 3, 4, 7 | none | — | settingsPageRegistry, no-silent-mutations, localeParity, routeScope |
| 10 | **8833 W4** manual-asset bulk tags | `feat(devices): bulk tags on manual assets (#8833 W4)` | 6, 9 | none | manual-asset authz | integration bulk suite |
| 11 | **8837 W05a** restricted tags: column, permission, write protection, consumer hardening | `feat(tags): restricted tags (W05a)` | 4, 5 | `2026-12-30-190200-device-tags-restricted.sql` | column on dual-axis table | tenant-export-policy (new column), rls-coverage, permission catalog parity |
| 12 | **8837 W05b** lift execution gates for restricted-tag rules | `feat(tags): restricted tags as execution targets (W05b)` | 11 | none | execution gating | executionTargetGating suites, filterEngine contracts |

W03a/W03b/W03c and 8833 W1 touch disjoint files after W02b and may be built in parallel worktrees;
they still **merge** in the order above. Waves 7, 9 and 10 each touch `DeviceList.tsx` (see §2.2).

## 2. Cross-cutting rules

### 2.1 Lock order (every transaction that touches tags)

1. Tag advisory locks, class `1000258`, keys sorted ascending by `(partner_id, slug)`. **Always before
   any partner-export lock in the same transaction.**
2. Partner-export partner locks, ascending. `devices` is **configuration-family** material
   (`migrationPartnerExportLocks.test.ts:191-213`), so a transaction that writes `devices` takes the
   configuration-family helper (partners **exclusive**, then orgs under them); `discovered_assets`
   and other material-family tables take partners **shared**. Use the exact helpers the
   `devices` / `discovered_assets` UPDATE triggers call — the W02b Explore sweep names them in the PR.
3. Partner-export org locks, ascending, over the **union** of every org any later statement touches.
4. Row locks (`SELECT … FOR UPDATE`), then writes.

Every tag writer takes steps 1–3 explicitly before its first row lock — including single-org writers
(PATCH, bulk per-org transaction, MCP), so a row lock is never held while waiting for an export
lock (Codex). Pattern: `services/orgMerge.ts:1189-1203`; migration shape
`2026-10-14-100050-discovered-assets-source-backfill-prelock.sql:93-110` with the configuration-family
helpers for `devices`.

**Existing callers that take export locks first must never take a tag lock** (Codex, P4):

- **Org merge** repoints `device_tags.org_id` after its export prelocks. The no-shadow trigger
  therefore skips (no lock, no check) an UPDATE that changes only `org_id` between two orgs of the same
  partner — the invariant cannot change on a same-partner repoint (W02a Task 1.1).
- **`PATCH /devices/:id`** takes device-row and custom-field locks (`core.ts:~2205`) before writing
  tags today. W02b moves `prepareTagReplace` to the first database work of the handler, before any of
  those (Task 2.3).
- **Device org move** runs `breeze_cascade_device_org_id` export locks. W03c locks the device's slugs
  for the target partner immediately after step-up consumption and before any export lock (Task 5.1).

### 2.2 `DeviceList.tsx` merge rule

`apps/web/src/components/devices/DeviceList.tsx` is touched by 8833 W2 (menu entries), 8837 W04
(registry chip colors) and 8833 W4 (manual-row eligibility), and by other features' column waves.
**Every feature's `DeviceList.tsx` wave lands one at a time: before opening the next wave's PR,
rebase it on `main` after the previous one merged and re-run `DeviceList.test.tsx`.** Do not stack
two `DeviceList.tsx` waves on one another.

**Cross-plan note:** #7324 W1 (device-list column catalog + `exportValue`) must land before any wave
that adds a `DeviceList` **column**. None of these waves adds a column; if a reviewer asks for a
"Tags" column with colors, it waits for #7324 W1.

### 2.3 CI traps

- `pnpm test` does not run `rls-coverage`, `tenantCascade.integration`, `tenant-export-policy`,
  `tenantExportErasureRoundtrip`, `orgMergeRegistry.integration` or any `*.integration.test.ts`. Run them
  on a per-worktree stack (`pnpm test-stack up`; for a browser stack `pnpm wt-stack` with root `.env`
  copied, AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24`),
  then tear it down.
- `orgMerge.test.ts` runs only in the full unit suite — run it explicitly by path.
- RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` (its own
  config; pointing other configs at it prints "No test files found").
- Single-file unit runs: `cd apps/api && npx vitest run <path>`; never `pnpm --filter … test -- --run`.
- Integration file: `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>` against the test stack.
- Typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p apps/api` (and `apps/web`,
  `packages/shared`) — read the exit code; never pipe to `tail`.
- A stacked PR (base ≠ `main`) gets no CI: `gh workflow run CI --ref <branch>`.

### 2.4 File layout (new)

```
packages/shared/src/utils/tags.ts                 normaliser, legacy slug, constants
packages/shared/src/validators/tags.ts            tagListSchema (re-exported from validators/index.ts)
packages/shared/src/types/bulkDeviceAttributes.ts bulk request/response types (API + web)
apps/api/src/services/deviceTags/
  locks.ts            lockTagSlugs
  owner.ts            resolveAutoRegisterOwner (pure)
  register.ts         registerMissingTags
  delta.ts            computeTagDelta (pure)
  applyTags.ts        prepareTagReplace, applyTagDelta, TagValidationError
  match.ts            tagMatchValues (reader-side)
  resolve.ts          listVisibleTagDefinitions, tag usage counts           (W03a)
  promote.ts          promoteTagToPartnerWide                                (W03a)
  references.ts       TAG_REFERENCE_REWRITERS                                (W03b)
  mergeDelete.ts      mergeDeviceTags, deleteDeviceTag                       (W03b)
  moveReconcile.ts    reconcileDeviceTagsOnMove                              (W03c)
  restricted.ts       restricted-tag rules                                   (W05a)
apps/api/src/routes/tags/                          split of routes/tags.ts (W03a)
apps/api/src/services/devices/bulkAttributeWrite.ts (8833 W1)
apps/api/src/routes/devices/bulkAttributes.ts      (8833 W1)
```

## 3. Plan decisions (pinned where the specs leave a choice; quorum outcome in §4)

- **PD-1 — No `executionEligible` event flag.** #8895 shipped the fail-closed subset of R-OD-7(a):
  tag-targeted policies publish no `policy.*` events at all, which closes every execution consumer
  the flag would have had to teach. No API path creates `automation_policies` any more, so the flag
  would serve legacy rows only. W05b restores events and remediation for a tag-targeted policy only
  when every target tag is restricted, with a dispatch-time recheck.
- **PD-2 — Wave split.** R§13 W02 (normalise + lowercase) and W03 (table + registration backfill)
  are re-cut into W02a (table, RLS, registrations, registration backfill that captures the
  original-case label **before** anything is lowercased) and W02b (write choke point, lowercase
  backfill, reader normalisation). This answers R§13's "pick one in the plan": labels are captured
  from live data in W02a, so no staging table and no audit-log archaeology. W02a changes no reader and
  no writer, so it ships alone with zero behaviour change. R§13 W03 is split into W03a/W03b/W03c so
  merge/delete land only after the reference registry and its contract test (R-OD-6 note).
- **PD-3 — Backfilled definitions are org-owned.** *(Deviation from R§13, which makes every backfilled
  slug partner-wide — needs owner confirmation.)* A partner-wide row is readable by every org token
  of that partner through the SELECT branch (R§4.2). Backfilling one customer org's legacy tags as
  partner-wide would show them to every other customer org's users, which today's `GET /tags` does
  not (`routes/tags.ts:77-130`, org-scoped). W02a therefore registers one **org-owned** row per
  `(org, slug)`; the same slug may be org-owned in several orgs (no-shadow forbids only org + partner
  for one slug). W04's settings page flags slugs owned by ≥ 2 orgs with a one-click **Promote to all
  organizations** (W03a `POST /tags/:tagId/promote`), which collapses them.
- **PD-4 — Auto-registration owner.** R-OD-3(a) as approved, with two guards. A missing slug is
  registered **partner-wide** only when the writer is partner or system scope **and**
  `canManagePartnerWidePolicies(auth)` **and** no org-owned row with that slug exists under the
  partner (re-read under the slug lock). Otherwise it is registered **org-owned** in the asset's org.
  The first guard keeps `org_access = 'selected'` technicians from publishing into orgs they cannot
  see; the second turns a would-be P0001 into a valid org-owned row.
- **PD-5 — Reader-side match normalisation instead of a jsonb rewrite migration.** After W02b every
  stored array holds slugs, but rule values stored by value (group rules, saved filters, compliance
  targets, AI-agent triggers, AI protected lists, playbook triggers, `BACKUP_CRITICAL_DEVICE_TAGS`)
  may hold `Finance Dept`. Every reader that compares such a value against the arrays applies
  `tagMatchValues()` (the same lenient transform as the backfill) to the configured side. The jsonb
  shapes stay untouched; merge (W03b) still rewrites them when a slug changes. Contradicts nothing in
  the specs; R§3 D3's "without touching them" was only true for readers that already lowercase.
- **PD-6 — Two transforms, one source of truth.** `normalizeTagList()` is strict (rejects, R§5.1
  step 3) and is used for **writes**. `legacyTagSlug()` is lenient (strips) and is used for the
  backfill and for **matching**. The SQL function `public.breeze_legacy_tag_slug(text)` used by the
  migrations must equal `legacyTagSlug` on a shared fixture list (integration parity test), and on
  every input `normalizeTagList` accepts, both produce the same slug.
- **PD-7 — Delta computed in TypeScript under the row lock.** B§4.2's single CTE is illustrative
  ("the plan pins the per-device site check exactly"). `applyTagDelta` runs two statements inside the
  caller's transaction: `SELECT id, tags FROM <table> WHERE (id, site_id) IN (verified pairs) AND
  org_id = $org FOR UPDATE`, then one `UPDATE … FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, tags text[])`
  for the changed rows. The delta lives in the pure `computeTagDelta`, which carries the cap rule and
  is unit-tested without a database.
- **PD-8 — Removal rule after W02b.** B§3 D12 / B-OD-6 (exact-match removal) was written for a world
  where #8837 had not landed. In this order every stored tag is already a slug when 8833 W1 ships, so
  bulk and MCP removals normalise with `legacyTagSlug()` (B-OD-6 notes this). A remove value that
  normalises to empty is a 400.
- **PD-9 — Cap failure code.** The bulk response gains `TAG_LIMIT_EXCEEDED` (per device). Single-asset
  writes return `400 { error, code: 'TAG_LIMIT_EXCEEDED', limit: 50 }`.
- **PD-10 — Definition management is org-wide governance.** `POST/PATCH/merge/delete/promote` on
  `/tags` require `canMutateOrgWideGovernance(auth)` (refused for site-restricted callers) in addition
  to `devices:write`; auto-registration on an ordinary tag write stays allowed for them. `device_tags`
  is **not** added to the hand-specified governance table list of `site-ceiling-write-coverage.test.ts`
  (that list is an owner decision); the gate is pinned by `routes/tags/registry.siteScope.test.ts`.
- **PD-11 — AI protected-resource tags refuse both delete modes.** Definition-only delete leaves the
  slug matching, but a deleted definition disappears from the picker and invites re-creation with a
  different meaning; R-OD-6(a) says "always refuse".
- **PD-12 — Manual assets in the bulk response.** 8833 W4 adds an optional `manualAssetIds` and a
  separate `manualAssets: { succeeded, failed }` block, so the W1/W2 response shape never changes.

## 4. Advisor quorum (plan level)

Position formed first (Opus, §3). Independent read-only `codex exec` (`gpt-6-astra`, `xhigh`,
2026-10-17) on eight points covering the wave split and the `device_tags` / backfill design.

**Agreed:** P1 drop W01 and no event flag (PD-1); P3 org-owned backfill and the capability +
existing-org-owner guards on auto-registration (PD-3, PD-4); P5 cap on the final array; P6 delta in
TypeScript under the row lock (PD-7).

**Codex corrections adopted** (no remaining disagreement):

- Lock order is not just a rule for new code: org merge, mixed `PATCH` and device move already take
  export or row locks before tags. Fixed by the no-shadow trigger skip, `prepareTagReplace` first in
  `PATCH`, and early slug locks in the move (§2.1). Every tag writer now prelocks export locks before
  row locks.
- `devices` is configuration-family export material: migrations and request-path prelocks use the
  configuration-family helpers (§2.1, Task 2.5).
- Normalise before **composition** (AI policy intersection), canonicalise stored values when finding
  references, and fail closed when a configured value normalises to nothing (Task 2.4, Review Focus 5).
- Whole-array request bodies must not reject a legacy 60→59 save (`tagReplaceListSchema`).
- Register only slugs actually added; do not double-request custom-field re-evaluation; pin `os_type`.
- Org-merge dedupe must report the dropped loser metadata → `kind: 'custom'` executor (Task 1.2).
- `GET /tags` keeps `id` = slug because the policy editor uses it; the uuid moves to `tagId` (Task 3.1).
- References: add `automations.conditions` and deployment filters; rewrite owner-aware, refuse a
  wider-owned reference (Task 4.1).
- `manage_tags`: per-action Tier 3 via `TIER3_ACTIONS`, not a static tier (MCP max rule), and
  `selfManagedDbContext` for add/remove (Task 8.1).
- W05: drop `contains` from execution-safe operators, recheck at every downstream dispatch, fix the
  alert reconcile, cover direct partitioner and inline-filter gates; W05b stays closed until all are done.
- Backfill reports truncations at 50 characters (Task 1.3).

**Codex recommendation not adopted as-is:** "document the ownership deviation in the approved spec".
The spec was approved by the owner; this plan records the deviation (PD-3, OPEN-1) instead of editing
approved text, and the owner decides whether to amend the spec.

## 5. Open Decisions (owner)

- **OPEN-1 — Backfilled and auto-registered vocabulary ownership (PD-3).** The approved spec (R§13)
  backfills every legacy slug as partner-wide, which publishes each customer org's legacy tag names to
  every sibling customer org's users through the SELECT branch.
  - (a) **Org-owned backfill + promote** (this plan; Codex agrees). No new cross-org visibility; partner
    admins promote shared slugs from `/settings/tags` (flagged when ≥ 2 orgs own them). Cost: an MSP
    with a consistent vocabulary sees N org rows until it promotes.
  - (b) Spec as written: partner-wide backfill. One list immediately; leaks org-specific names across
    customers.
  - **Recommend (a).** The disclosure is irreversible once shipped; promotion is one click.
- **OPEN-2 — Legacy automation tag conditions after W05a.** `automations.conditions` `{ type: 'tag' }`
  selects devices that a script then runs on, so an API-key-written tag can steer it even with exact
  matching (Codex P8).
  - (a) In W05b, require every tag in such a condition to be a restricted tag of the automation's
    owner; ship a pre-flight report (in the W05b PR) of automations that would stop matching.
  - (b) Exact matching only (W05a) and accept the residual risk, documented.
  - **Recommend (a)** — it is the same self-steering class the group gate already closes; it is a
    behaviour change for existing automations, hence the owner call and the pre-flight report.

---

## Wave 1 — 8837 W02a: `device_tags` table, RLS, registrations, registration backfill

**Branch:** `feature/<8837-parent#>-tag-registry/wave-<sub#>` · **Migration:** `apps/api/migrations/2026-12-30-190000-device-tags-registry.sql`
**Tenancy shape:** dual-axis config table, `org_id` XOR `partner_id` (Partner-Wide First; the
`org_id NOT NULL` justification is not needed). Template: `2026-12-28-120000-service-catalog-foundation.sql:69-88`.
**Read first:** `docs/agents/tenancy-rls.md`, `apps/api/migrations/README.md`, R§4.

### Task 1.1: Migration — table, constraints, triggers, RLS

**Files:**
- Create: `apps/api/migrations/2026-12-30-190000-device-tags-registry.sql`
- Create: `apps/api/src/db/schema/deviceTags.ts` (export from `apps/api/src/db/schema/index.ts`)
- Test: `apps/api/src/__tests__/integration/deviceTagsPartnerRls.integration.test.ts`

**Interfaces:**
- Produces: table `public.device_tags` exactly as R§4.1 (columns, CHECKs, partial unique indexes
  `device_tags_partner_slug_uq`, `device_tags_org_slug_uq`); Drizzle `deviceTags` table object;
  SQL function `public.breeze_legacy_tag_slug(input text) RETURNS text IMMUTABLE STRICT`;
  trigger function `public.breeze_device_tags_no_shadow()` (BEFORE INSERT OR UPDATE OF slug, org_id,
  partner_id) that **returns NEW without locking or checking** when the UPDATE keeps `slug` and
  `partner_id` and moves `org_id` between two orgs of the same partner (org merge, §2.1);
  `updated_at` touch trigger as in the template. Owner columns are made immutable at the route layer
  (`.strict()` PATCH schema without owner fields, W03a), not by a trigger: a trigger would break the
  org-merge repoint, which legitimately updates `org_id`.
- Policies: `device_tags_owner_access` (FOR ALL, R§4.2 expression in USING and WITH CHECK) and
  `device_tags_partner_wide_select` (FOR SELECT, `org_id IS NULL AND partner_id = public.breeze_current_partner_id()`).

- [ ] **Step 1: Write the failing integration test** `deviceTagsPartnerRls.integration.test.ts`, modelled
  on `customFieldDefinitionsPartnerRls.integration.test.ts`:

```ts
it('rejects a row with both owners (23514) and with neither (23514)')
it('org token reads its own rows and its partner\'s partner-wide rows, not another org\'s rows')
it('org token cannot INSERT or UPDATE a partner-wide row (42501)')
it('partner token cannot forge a row for another partner (42501)')
it('no-shadow: org row with a slug that exists partner-wide raises P0001, and vice versa')
it('no-shadow: two different orgs may own the same slug')
it('same-partner org_id repoint does not take lock 1000258 (completes under lock_timeout while another tx holds it)')
it('slug CHECK rejects "Finance", "-x", "" and a 51-char slug; color CHECK rejects "#FFF"')
it('breeze_legacy_tag_slug matches the shared fixture table')   // PD-6 parity, fixture from Task 2.1
```

- [ ] **Step 2: Run it — expect FAIL** (`relation "device_tags" does not exist`).
  `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceTagsPartnerRls.integration.test.ts`.

- [ ] **Step 3: Write the migration.** Order inside the file: system scope `set_config`;
  `breeze_legacy_tag_slug`; table + indexes; no-shadow function and trigger;
  `ENABLE` + `FORCE ROW LEVEL SECURITY`; the two policies (`DROP POLICY IF EXISTS` first); grants as in
  the template. Every statement idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, guarded `DO` blocks).

  `breeze_legacy_tag_slug` (lenient transform, PD-6):
  `left(regexp_replace(regexp_replace(regexp_replace(lower(normalize(btrim(input), NFKC)), '\s+', '-', 'g'), '[^a-z0-9._:-]', '', 'g'), '^[^a-z0-9]+', ''), 50)`, then strip trailing nothing; `''` when nothing survives.

  No-shadow function: copy `2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql:230-300`,
  substituting `device_tags`/`slug`; take `pg_advisory_xact_lock(1000258, hashtext(<partner>::text || ':' || NEW.slug))`
  before the check (for an org row, `<partner>` is the org's `partner_id`). Messages:
  `tag "%" already exists for all organizations under this partner` /
  `tag "%" is already defined by at least one organization under this partner`.

- [ ] **Step 4: Write the Drizzle schema** `deviceTags` mirroring the SQL (`partnerId`, `orgId` nullable;
  `source` typed `'manual' | 'auto' | 'backfill'`). Run `pnpm db:check-drift` — expect no drift.

- [ ] **Step 5: Run the integration test — expect PASS.**

- [ ] **Step 6: Commit** `feat(tags): device_tags table, RLS and no-shadow trigger`.

### Task 1.2: Registrations

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical)
- Modify: `apps/api/src/services/orgMergeRegistry.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES`,
  `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; **not** `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`)

**Interfaces:**
- orgMergeRegistry: `device_tags: { kind: 'custom', note: … }` with a custom executor registered the
  way `custom_field_definitions` is (`orgMergeRegistry.ts:680`): for each loser org row whose slug the
  survivor org also owns, record `{ slug, name, color, description }` in the merge report / audit
  details, delete it, then repoint the rest. Survivor rows win (R§4.4 "explicit survivor
  precedence"). A plain `repoint-dedupe` would delete the loser metadata **without** reporting it
  (`orgMergeExecutors.ts:64`, Codex). Partner-wide rows have `org_id NULL` and are never touched; org
  merge is same-partner only, so no cross-partner shadowing. The preview's would-drop count uses the
  same predicate.
- Export: `tablePolicy('org_id', { included: ['id','org_id','partner_id','slug','name','color','description','created_by','source','created_at','updated_at'], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`
  (no json/jsonb/bytea columns). W05a adds `restricted` to `included`.
- Not registered (state why in the PR): device lists (no `device_id`), ticket lists, partner-export
  material triggers (R§4.4 last row), `PARTNER_LINKABLE_FEATURE_TYPES` (not a configuration-policy feature).

- [ ] **Step 1: Run the four contract suites first and watch them fail** on the new table:
  `test:rls-coverage`, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`,
  `orgMergeRegistry.integration.test.ts` (test stack). Record the failing assertion names in the PR.
- [ ] **Step 2: Add the four registrations** and a failing-first unit test for the custom merge
  executor (`orgMergeRegistry.extensions.test.ts` or a sibling): two orgs owning `finance` with
  different colors → survivor keeps its color, the report lists the loser's `{ name, color }`.
- [ ] **Step 3: Re-run the four suites + `tenantExportErasureRoundtrip.integration.test.ts` +
  `cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/orgMergeRegistry.extensions.test.ts` — expect PASS.**
- [ ] **Step 4: Commit** `feat(tags): register device_tags in cascade, merge, export and RLS coverage`.

### Task 1.3: Registration backfill (labels captured before lowercasing)

**Files:**
- Modify: `apps/api/migrations/2026-12-30-190000-device-tags-registry.sql` (append; same file, not yet shipped)
- Test: `apps/api/src/__tests__/integration/deviceTagsBackfill.integration.test.ts`

**Interfaces:**
- Produces: one `device_tags` row per `(org_id, breeze_legacy_tag_slug(tag))` over
  `devices.tags ∪ manual_assets.tags ∪ discovered_assets.tags`, `org_id` set, `partner_id NULL`
  (PD-3), `source = 'backfill'`, `color NULL`, `name` = the most frequent original spelling of that slug
  in that org after `btrim` + NFKC + whitespace→`-` + `left(…, 50)` (ties: lexicographically
  smallest); when that label's `lower()` differs from the slug (characters were stripped), `name = slug`.
  `ON CONFLICT (org_id, slug) WHERE partner_id IS NULL DO NOTHING`.
- Reports (`RAISE WARNING`, `GET DIAGNOSTICS`): rows registered; per table `max(cardinality(tags))`;
  collision report — per org, slugs reached from ≥ 2 distinct original spellings, values that
  became empty, and values truncated at 50 characters, first 50 lines then a total. Arrays are
  **not** modified in W02a.

- [ ] **Step 1: Write the failing test**:

```ts
it('registers one org-owned row per (org, slug) across devices, manual and discovered assets')
it('picks the most frequent spelling as name: ["Finance","Finance","finance"] → name "Finance"')
it('falls back to name = slug when characters were stripped: "Café Ops!" → slug "cafe-ops"... name "cafe-ops"')
it('does not create a partner-wide row')
it('is idempotent: running the backfill block twice registers nothing new')
it('leaves devices.tags byte-identical')
```

  Note on the third case: NFKC keeps `é`; the strip removes it, so the slug is `caf-ops` — write
  the assertion from `legacyTagSlug` on the fixture, not by hand.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Append the backfill block** (system scope is already set at the top of the file).
- [ ] **Step 4: Run — expect PASS.** Re-run `migrationRlsScope.test.ts` and `scripts/check-migration-naming.sh`.
- [ ] **Step 5: Commit** `feat(tags): register existing tags with their original labels`.

**Wave 1 exit gate:** all suites in Task 1.2 Step 3 + `deviceTagsPartnerRls` + `deviceTagsBackfill`
green on the test stack; `tsc --noEmit` exit 0 for `apps/api`; `pnpm db:check-drift` clean. PR body:
tenancy shape, every registration, and the PD-3 deviation called out at the top.

---

## Wave 2 — 8837 W02b: normalised writes, slug backfill, reader match normalisation

**Migration:** `apps/api/migrations/2026-12-30-190100-device-tags-slug-backfill.sql`
**Read first:** R§5, B§4.2 (concurrency), §2.1 above.

### Task 2.1: Shared normaliser, legacy slug and `tagListSchema`

**Files:**
- Create: `packages/shared/src/utils/tags.ts`, `packages/shared/src/utils/tags.test.ts`
- Create: `packages/shared/src/utils/__fixtures__/tagSlugFixtures.ts` (shared with the SQL parity test)
- Create: `packages/shared/src/validators/tags.ts`; Modify: `packages/shared/src/validators/index.ts`
  (re-export; `updateDeviceSchema.tags` (`:173`, 20 today) → `tagReplaceListSchema`; the 50 cap is
  server-side on the final array, R-OD-8)

**Interfaces — Produces:**

```ts
export const TAG_SLUG_PATTERN: RegExp;            // /^[a-z0-9][a-z0-9._:-]{0,49}$/
export const MAX_TAG_LENGTH = 50;
export const MAX_TAGS_PER_ASSET = 50;
export type TagRejection = { input: string; reason: 'empty' | 'too_long' | 'invalid_chars'; suggestedSlug: string | null };
export type NormalizedTags = { slugs: string[]; labels: Map<string, string> };
export function normalizeTagList(input: readonly string[]):
  { ok: true; value: NormalizedTags } | { ok: false; rejected: TagRejection[] };
export function legacyTagSlug(input: string): string;   // '' when nothing survives
export const tagListSchema: z.ZodArray<z.ZodString>;          // .max(50)  — delta lists
export const tagReplaceListSchema: z.ZodArray<z.ZodString>;   // .max(500) — whole-array bodies
```

- [ ] **Step 1: Write the failing table tests** (`tags.test.ts`):

```ts
expect(ok(normalizeTagList(['  Finance  ', 'finance', 'PCI Scope']))).toEqual({
  slugs: ['finance', 'pci-scope'], labels: new Map([['finance', 'Finance'], ['pci-scope', 'PCI-Scope']]) });
expect(rejected(normalizeTagList(['Café']))[0]).toMatchObject({ reason: 'invalid_chars', suggestedSlug: 'caf' });
expect(rejected(normalizeTagList(['x'.repeat(51)]))[0].reason).toBe('too_long');
expect(rejected(normalizeTagList(['-lead']))[0].reason).toBe('invalid_chars');
expect(ok(normalizeTagList(['ｆｉｎａｎｃｅ'])).slugs).toEqual(['finance']);       // NFKC
expect(ok(normalizeTagList(['   ', 'a'])).slugs).toEqual(['a']);                    // empties dropped
expect(legacyTagSlug('Finance Dept!')).toBe('finance-dept');
expect(legacyTagSlug('***')).toBe('');
for (const f of TAG_SLUG_FIXTURES) expect(legacyTagSlug(f.input)).toBe(f.slug);
// every input normalizeTagList accepts maps to the same slug under legacyTagSlug (PD-6)
```

- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/utils/tags.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Count limit is **not** enforced here (it applies to the final array, Task 2.2).
- [ ] **Step 4: Run — expect PASS.** Also re-run the W02a parity test (`deviceTagsPartnerRls`) against the fixture.
- [ ] **Step 5: Commit** `feat(shared): tag slug normaliser and legacy slug transform`.

### Task 2.2: `services/deviceTags` write core (locks, owner, register, delta)

**Files:**
- Create: `apps/api/src/services/deviceTags/{locks,owner,register,delta,applyTags}.ts` and
  `owner.test.ts`, `delta.test.ts`, `applyTags.test.ts`
- Test (integration): `apps/api/src/__tests__/integration/deviceTagsApply.integration.test.ts`

**Interfaces — Produces:**

```ts
export type TagTable = 'devices' | 'manual_assets' | 'discovered_assets';
export type TagWriteActor = Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'> & { userId: string | null };

// locks.ts — step 1 of §2.1; dedupes and sorts
export async function lockTagSlugs(partnerId: string, slugs: readonly string[]): Promise<void>;

// owner.ts — pure (PD-4)
export function resolveAutoRegisterOwner(input: {
  actor: TagWriteActor; assetOrgId: string; assetPartnerId: string; orgOwnedElsewhere: boolean;
}): { orgId: string; partnerId: null } | { orgId: null; partnerId: string };

// register.ts — call after lockTagSlugs; re-reads visible definitions; INSERT … ON CONFLICT DO NOTHING
export async function registerMissingTags(input: {
  actor: TagWriteActor; assetOrgId: string; assetPartnerId: string; labels: Map<string, string>;
}): Promise<{ registered: string[] }>;

// delta.ts — pure
export function computeTagDelta(before: readonly string[], add: readonly string[], remove: readonly string[],
  cap?: number): { after: string[]; added: string[]; removed: string[]; overCap: boolean };

// applyTags.ts
export class TagValidationError extends Error { readonly code: 'INVALID_TAG' | 'TAG_LIMIT_EXCEEDED'; readonly rejected: TagRejection[]; }
export async function prepareTagReplace(input: {
  actor: TagWriteActor; assetOrgId: string; assetPartnerId: string; previous: readonly string[]; input: readonly string[];
}): Promise<{ slugs: string[] }>;                          // whole-array writers (PATCH, create)
export type TagDeltaRow = { id: string; outcome: 'changed' | 'unchanged' | 'state_changed' | 'tag_limit_exceeded';
  before: string[]; after: string[]; added: string[]; removed: string[] };
export async function applyTagDelta(input: {
  actor: TagWriteActor; table: TagTable; orgId: string; partnerId: string;
  rows: ReadonlyArray<{ id: string; siteId: string | null }>; add: readonly string[]; remove: readonly string[];
}): Promise<TagDeltaRow[]>;                               // locked read + one UPDATE (PD-7)
```

All functions use the ambient `db` and must run inside a transaction (request tx or `withDbAccessContext`).
`applyTags.ts` mentions `canManagePartnerWidePolicies` (via `owner.ts`), which satisfies
`partner-wide-write-coverage.test.ts` for the `device_tags` writes.

- [ ] **Step 1: Write failing unit tests:**

```ts
// owner.test.ts
it('partner scope with orgAccess all and no org-owned row → partner-wide')
it('partner scope with orgAccess selected → org-owned in asset org')            // Review Focus 3
it('partner scope, slug org-owned elsewhere under the partner → org-owned')      // Review Focus 4
it('org scope → org-owned; system scope → partner-wide under asset partner')
// delta.test.ts
expect(computeTagDelta(['a','b'], ['c','a'], ['b'])).toEqual({ after: ['a','c'], added: ['c'], removed: ['b'], overCap: false });
expect(computeTagDelta(fifty, ['new'], []).overCap).toBe(true);
expect(computeTagDelta(sixty, [], ['t1']).overCap).toBe(false);                  // Review Focus 2
expect(computeTagDelta(sixty, ['t1'], []).overCap).toBe(false);                  // no growth: already present
// applyTags.test.ts (Drizzle mocks)
it('prepareTagReplace throws TagValidationError(INVALID_TAG) naming the tag and suggestedSlug')
it('prepareTagReplace throws TAG_LIMIT_EXCEEDED only when the final array grows past 50')
it('reuses an existing definition whose label differs; never updates its name')   // Review Focus 5
```

- [ ] **Step 2: Write the failing integration test** (`deviceTagsApply.integration.test.ts`, real Postgres):

```ts
it('two concurrent applyTagDelta adds of different tags on one device both persist')
it('a device re-sited between verification and write is state_changed and untouched')
it('a concurrent partner-wide create and org auto-register of the same slug serialise; no P0001 escapes')
it('registration and the array write roll back together when the UPDATE fails')
```

- [ ] **Step 3: Run both — expect FAIL.**
- [ ] **Step 4: Implement.** `applyTagDelta`, in this order (§2.1): normalise `add` strictly and
  `remove` with `legacyTagSlug` (empties → 400 at the caller); `lockTagSlugs(partnerId, add slugs)`;
  explicit partner-export prelock for this org (the helpers the table's UPDATE trigger uses);
  locked read via
  `WHERE (id, site_id) IN (SELECT * FROM unnest(${sqlUuidArray(ids)}, ${sqlUuidArray(siteIds)}))` (a
  `null` siteId — manual assets without a site — compares with `IS NOT DISTINCT FROM`);
  `computeTagDelta` per row; `registerMissingTags` for the slugs **actually added** to at least one row
  (nothing is registered for a row refused by the cap, Codex P6); one
  `UPDATE … FROM jsonb_to_recordset(...)` setting `tags` and `updated_at` for `changed` rows only.
  `prepareTagReplace` takes the same steps for one asset.
  Add to the integration test: `it('a cap-refused add registers no definition')` and
  `it('concurrent PATCH (tags + custom field) and bulk add in one org complete without deadlock over 50 iterations')`.
- [ ] **Step 5: Run — expect PASS.** Commit `feat(tags): tag write service with locks, auto-registration and deltas`.

### Task 2.3: Route every write path through the service + write-site contract test

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts` (PATCH `:id`, `updates.tags` at ~2239),
  `routes/devices/manual.ts` (create ~301, update ~394), `routes/devices/network.ts` (~412),
  `routes/discovery.ts` (~1718), `services/aiToolsDevice.ts` (`manage_tags` add/remove, ~795-842)
- Modify: `apps/api/src/routes/devices/schemas.ts` (`:144`, `:192`, `:212` → `tagListSchema`),
  `routes/discovery.ts` schema (~542), `services/aiToolSchemas.ts` `manage_tags.tags` → `tagListSchema`
- Create: `apps/api/src/__tests__/deviceTagWriteSites.contract.test.ts` + fixtures dir
- Tests: extend `routes/devices/core.groupReevaluation.test.ts`, `manual.test.ts`, `network.test.ts`,
  `discovery.test.ts`, `services/aiToolsDevice.manageTags.test.ts`

**Interfaces:**
- Consumes: `prepareTagReplace`, `applyTagDelta`, `TagValidationError` (Task 2.2).
- Each route maps `TagValidationError` → `400 { error, code, rejected, limit? }`.
- `PATCH /devices/:id`: `prepareTagReplace` is the **first** database work of the handler after the
  permission/step-up checks, before the device-row and custom-field locks at `core.ts:~2205` (§2.1).
- Whole-array bodies (`PATCH /devices/:id`, manual create/update, network, discovery) use
  `tagReplaceListSchema`; MCP `tags` uses `tagListSchema`.
- `manage_tags` add/remove (still single `deviceId` in this wave) call `applyTagDelta` and keep the
  existing `requestDeviceGroupReevaluationAfterCommit` call; the add no longer reorders the array.
- Contract rule: a file under `src/routes/**`, `src/services/**` or `src/jobs/**` that references
  `devices`, `manualAssets` or `discoveredAssets` (or the raw table names) **and** matches a tag-column
  write (`/\bSET\s+tags\s*=/i`, `/\.\s*tags\s*=(?!=)/`, or `tags:` inside an `.insert(...).values(`/`.update(...).set(`
  object) must import from `services/deviceTags` or be in `TAG_WRITE_ALLOWLIST` with a reason.
  Fixture files prove each pattern fires.

- [ ] **Step 1: Write failing route tests** — for each path: `['Finance', 'finance ']` stores
  `['finance']`; `['Café']` → 400 `INVALID_TAG` with `suggestedSlug`; 51 tags → 400 `TAG_LIMIT_EXCEEDED`;
  MCP `remove ['Finance']` removes `finance`; MCP add preserves existing order.
- [ ] **Step 2: Write the contract test and its fixtures; run — expect FAIL** listing the five files above.
- [ ] **Step 3: Implement** the route changes.
- [ ] **Step 4: Run** the touched test files explicitly (list each path) and the contract test — expect PASS.
  Also `src/__tests__/partner-wide-write-coverage.test.ts`, `services/aiToolsDeviceScope.contract.test.ts`,
  `services/aiToolsSiteScope.contract.test.ts`.
- [ ] **Step 5: Commit** `feat(tags): normalise and register tags on every write path`.

### Task 2.4: Reader-side match normalisation (PD-5)

**Files:**
- Create: `apps/api/src/services/deviceTags/match.ts` (+ `match.test.ts`)
- Modify (each reader that compares a configured tag value with the arrays — the Explore sweep in
  this wave confirms the list): `services/filterEngine.ts` (tag conditions), `routes/tags.ts`
  (`GET /tags/devices?tag=`), `services/policyEvaluationService.ts` (`targets.tags`, ~1374-1385),
  `services/aiAgents/runService.ts` (trigger tags, ~643), `services/aiAgents/effectivePolicy.ts`,
  `services/aiAgents/runResourceScope.ts`, `services/aiAgents/alertVerdictSubscriber.ts`,
  `services/aiAgents/metricAnomalySubscriber.ts`, `services/aiGuardrails.ts` (protected `deviceTags`,
  ~2358-2363), `routes/backup/criticality.ts` (`BACKUP_CRITICAL_DEVICE_TAGS`), `services/automationRuntime.ts`
  (~1044-1050, `automations.conditions` `{ type: 'tag', value }`; keeps substring semantics until
  W05a), deployment target filters that embed tag conditions, `services/scriptProposals/policy.ts`,
  playbook trigger evaluation (`playbook_definitions.trigger_conditions.deviceTags`)

**Interfaces — Produces:**
`export function tagMatchValues(values: readonly unknown[]): { slugs: string[]; matchNothing: boolean }` —
`legacyTagSlug` on each string, drop empties and non-strings, dedupe, stable order; `matchNothing` is
true when the input held at least one value and none survived. Every reader that gets
`matchNothing` matches **no** device — it never falls through to "no filter" / "all devices"
(Review Focus 5).

Normalise **before composition**: `aiAgents/effectivePolicy.ts:~252` intersects partner and org tag
lists before matching, so equivalent spellings must be canonicalised first or the intersection is
wrongly empty (Codex P2).

- [ ] **Step 1: Write one failing test per reader:** a configured value `'Finance Dept'` matches a
  device whose tags are `['finance-dept']`; a configured `'FINANCE'` matches `['finance']`; a
  configured `'***'` matches nothing and does not throw; and specifically: a compliance policy with
  `targets.tags: ['***']` evaluates **zero** devices (not all); a group rule `hasAll ['***']` matches
  zero devices; an AI policy whose partner list has `Finance` and org list has `finance` intersects to
  `['finance']`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Apply `tagMatchValues` to the configured side** in each reader. Do not lowercase the
  array side in SQL (keeps the `&&`/`@>` shape; the arrays are slugs after Task 2.5).
- [ ] **Step 4: Run the reader tests + existing `filterEngine*`, `policyEvaluation*`, `aiGuardrails*`,
  `automationRuntime*`, `backup/criticality*` tests — expect PASS.**
- [ ] **Step 5: Commit** `feat(tags): match configured tag values by slug`.

### Task 2.5: Slug backfill migration

**Files:**
- Create: `apps/api/migrations/2026-12-30-190100-device-tags-slug-backfill.sql`
- Test: `apps/api/src/__tests__/integration/deviceTagsSlugBackfill.integration.test.ts`

**Interfaces:** in order — system scope; re-run the W02a registration backfill block verbatim (catches
slugs written between the two releases, with their original case); partner-export prelocks over the
orgs of every `devices` and `discovered_assets` row whose array differs from its normalised form —
**configuration family** for `devices` (partners exclusive, then orgs under exclusive partners;
`migrationPartnerExportLocks.test.ts:191-213, 247-260` rejects shared-only prelocks for `devices`,
Codex) and material family for `discovered_assets` (partners shared, then orgs exclusive), all
ascending, all before the first write (shape of `2026-10-14-100050-…-prelock.sql:93-110`); then for
each of `devices`, `discovered_assets`,
`manual_assets`:
`UPDATE … SET tags = <norm(tags)> WHERE tags IS DISTINCT FROM <norm(tags)>` where `<norm>` keeps the
first occurrence order:
`ARRAY(SELECT s FROM (SELECT breeze_legacy_tag_slug(t) AS s, min(o) AS o FROM unnest(COALESCE(tags,'{}')) WITH ORDINALITY u(t,o) GROUP BY 1) x WHERE s <> '' ORDER BY o)`.
`updated_at` is not touched. `GET DIAGNOSTICS` + `RAISE WARNING` per table with row counts and
`max(cardinality(tags))` after the rewrite (R-OD-8). Arrays above 50 are left as they are.

- [ ] **Step 1: Write the failing test:** mixed-case/spaced/duplicate arrays on all three tables become
  ordered, deduped slugs; a value that normalises to empty is dropped; a 60-tag array keeps 60; the
  migration file passes `migrationPartnerExportLocks.test.ts` and `migrationRlsScope.test.ts`; running
  the file twice changes nothing the second time.
- [ ] **Step 2: Run — expect FAIL.** **Step 3: Write the migration.** **Step 4: Run — expect PASS**, plus
  `cd apps/api && npx vitest run src/db/migrationPartnerExportLocks.test.ts src/db/migrationRlsScope.test.ts`.
- [ ] **Step 5: Commit** `feat(tags): lowercase existing tags to slugs`.

**Wave 2 exit gate:** every test named in Tasks 2.1–2.5; `test:rls-coverage`; the dynamic-group
integration test `dynamicGroupReevaluation.integration.test.ts`; `tsc --noEmit` for `apps/api` and
`packages/shared`. Release note text: tags are now lowercase slugs on write, existing tags were
converted (collision report in the migration log), per-asset limit 50.

---

## Wave 3 — 8837 W03a: registry API (list, create, rename, promote)

### Task 3.1: Split `routes/tags.ts` and make `GET /tags` registry-backed

**Files:**
- Create: `apps/api/src/routes/tags/index.ts` (exports `tagRoutes` — keep the existing export name),
  `routes/tags/list.ts` (`GET /tags`, `GET /tags/devices`), `routes/tags/schemas.ts`
- Delete: `apps/api/src/routes/tags.ts` (moved, behaviour preserved); update the import in `apps/api/src/index.ts`
- Create: `apps/api/src/services/deviceTags/resolve.ts`
- Tests: move `routes/tags*.test.ts` to `routes/tags/list.test.ts`; add cases below

**Interfaces — Produces:**

```ts
export type TagListItem = {
  id: string;            // = slug, kept for compatibility: PolicyEditPage.tsx:~107 prefers record.id over record.tag (Codex)
  tagId: string | null;  // device_tags.id; null when unregistered. Registry routes take :tagId
  tag: string; name: string; slug: string; color: string | null; description: string | null;
  owner: 'partner' | 'organization' | null; registered: boolean; deviceCount: number;
  counts: { devices: number; manualAssets: number; discoveredAssets: number };
};
export async function listVisibleTagDefinitions(auth: AuthContext, opts: { search?: string; orgId?: string }): Promise<TagListItem[]>;
```

`tag` and `deviceCount` keep their current meaning (compat, R§5.4). Counts keep today's
ephemeral/parked/retired/linked exclusions and site narrowing (`routes/tags.ts:94-130`); discovered
assets are counted for the first time.

- [ ] **Step 1: Failing tests:** a registered tag with zero uses is listed; an in-use unregistered slug
  is listed with `registered: false, tagId: null`; `id` equals `slug` for every item; org token sees its own + partner-wide rows, not a
  sibling org's; site-restricted caller's counts exclude other sites; `?search=` matches name and slug.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS). **Step 5:** commit.

### Task 3.2: `POST /tags`, `PATCH /tags/:tagId`, `POST /tags/:tagId/promote`

**Files:**
- Create: `apps/api/src/routes/tags/registry.ts`, `services/deviceTags/promote.ts`
- Tests: `routes/tags/registry.test.ts`, `routes/tags/registry.siteScope.test.ts`,
  `services/deviceTags/promote.test.ts`; extend `deviceTagsPartnerRls.integration.test.ts` (promote)

**Interfaces:**
- `POST /tags { name, color?, description?, ownerScope: 'partner' | 'organization', orgId? }` →
  `201 TagListItem`. Slug from `normalizeTagList([name])`. `ownerScope: 'partner'` requires
  `canManagePartnerWidePolicies(auth)` → else `403 PARTNER_WIDE_WRITE_DENIED_MESSAGE`. P0001 from the
  no-shadow trigger → `409 { code: 'TAG_SHADOWED' }`; unique violation → `409 { code: 'TAG_EXISTS' }`;
  a `name` whose slug equals another visible tag's slug → 409.
- `PATCH /tags/:tagId { name?, color?, description? }` (no `ownerScope`, no `slug` — `.strict()`): label-only
  (R-OD-5). Partner-wide row requires the capability.
- `POST /tags/:tagId/promote` → `promoteTagToPartnerWide({ auth, tagId }): Promise<{ tag: TagListItem; collapsedOrgRows: number }>`:
  under `lockTagSlugs`, delete every org-owned row with that slug across the partner's orgs and
  insert one partner-wide row (label/color from the promoted row). Audit carries dropped metadata.
- All four: `devices:write`, `canMutateOrgWideGovernance(auth)` (PD-10), audit `device_tag.*`.

- [ ] **Step 1: Failing tests** for each status code above, including: `orgAccess: 'selected'` partner
  user → 403 on partner-wide create/patch/promote; site-restricted caller → 403 on all four; PATCH
  body with `slug` → 400; promote of a slug owned by three orgs → one partner-wide row, three
  deleted, audit lists the three labels.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ `partner-wide-write-coverage.test.ts`).
- [ ] **Step 5: Docs** — `apps/docs/src/content/docs/features/tags.mdx`: replace line 14 ("There is no
  separate tag definition table …") with the registry model (slugs, definitions, partner-wide vs
  org, normalisation, rename vs merge) and add the new endpoints to the API table.
- [ ] **Step 6: Commit.**

**Wave 3 exit gate:** route tests, `deviceTagsPartnerRls` (promote cases), partner-wide-write-coverage, `tsc`.

---

## Wave 4 — 8837 W03b: reference registry, merge, delete

### Task 4.1: `TAG_REFERENCE_REWRITERS` + contract test + `GET /tags/:tagId/references`

**Files:**
- Create: `apps/api/src/services/deviceTags/references.ts` (+ `references.test.ts`)
- Create: `apps/api/src/__tests__/deviceTagReferences.contract.test.ts`
- Create: `apps/api/src/routes/tags/lifecycle.ts` (`GET /tags/:tagId/references`; merge and delete in 4.2)

**Interfaces — Produces:**

```ts
export type TagReferenceKind = 'group_rule' | 'saved_filter' | 'compliance_target' | 'ai_agent_trigger'
  | 'ai_protected_resource' | 'playbook_trigger' | 'automation_condition' | 'deployment_filter' | 'env_backup_critical';
export type TagReference = { kind: TagReferenceKind; id: string | null; owner: { orgId: string } | { partnerId: string } | null;
  label: string; rewritable: boolean };
export interface TagReferenceRewriter {
  kind: TagReferenceKind;
  onDelete: 'rewrite' | 'refuse' | 'refuse_always';      // R§6.3 Delete column; PD-11
  find(input: { slugs: string[]; orgIds: string[] }): Promise<TagReference[]>;
  rewrite(input: { from: string; to: string | null; orgIds: string[] }): Promise<number>;   // null = drop value
}
export const TAG_REFERENCE_REWRITERS: readonly TagReferenceRewriter[];
```

Rows per R§6.3: `device_groups.filter_conditions` (refuse), `saved_filters.conditions` (rewrite on
delete), `automation_policies.targets` when tag-targeted (refuse), `ai_agents.triggers.deviceTags`
(refuse), `ai_script_policies.protected_resources.deviceTags` and `ai_agents.protected_resources.deviceTags`
(`refuse_always`), `playbook_definitions.trigger_conditions.deviceTags` (refuse),
`automations.conditions` legacy `{ type: 'tag', value }` (refuse; Codex), tag conditions nested in
deployment target filters (refuse; Codex), `BACKUP_CRITICAL_DEVICE_TAGS` (report only,
`rewritable: false`). Matching inside each rewriter canonicalises the **stored** value with
`tagMatchValues`, so `Finance Dept` stored in a rule counts as a reference to `finance-dept`.

**Owner-aware rewrite (Codex).** The same slug can be org-owned in several orgs, and a partner-wide
reference (a partner-wide AI policy, partner-wide group, partner-wide automation) can name it. A merge
or delete of an **org-owned** tag rewrites only references owned by that org; a reference whose owner
is wider than the tag's owner (partner-wide reference, org-owned tag) is **refused** with a 409 that
lists it, never rewritten globally. A partner-wide tag rewrites references in every org of the
partner plus partner-wide references.

Contract: every `src/db/schema/*.ts` occurrence of a property named `deviceTags`, or a column/jsonb
key named `tags`, is either the `kind` of a rewriter or in `NOT_DEVICE_TAG_SITES` with a reason
(tickets, scripts, script_tags, plugins, ticket forms, PSA, Sentry, KB).

- [ ] **Step 1: Failing tests:** contract test lists the current un-registered sites; each rewriter's
  `find` and `rewrite` on a fixture (Drizzle mocks); `GET /tags/:tagId/references` returns the list and
  the env-var row when the slug is in `BACKUP_CRITICAL_DEVICE_TAGS`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit.

### Task 4.2: Merge and delete

**Files:**
- Create: `apps/api/src/services/deviceTags/mergeDelete.ts`
- Modify: `apps/api/src/routes/tags/lifecycle.ts`
- Tests: `services/deviceTags/mergeDelete.test.ts`; `src/__tests__/integration/deviceTagsMerge.integration.test.ts`

**Interfaces — Produces:**

```ts
export async function mergeDeviceTags(input: { auth: AuthContext; fromId: string; intoId: string }):
  Promise<{ affected: { devices: number; manualAssets: number; discoveredAssets: number }; references: number; deviceIds: string[] }>;
export async function deleteDeviceTag(input: { auth: AuthContext; tagId: string; removeFromAssets: boolean }):
  Promise<{ affected: { devices: number; manualAssets: number; discoveredAssets: number } }>;
export class TagReferencedError extends Error { readonly references: TagReference[] }   // → 409
export class TagScopeNarrowingError extends Error {}                                  // → 409
```

Routes: `POST /tags/:tagId/merge { intoTagId }`, `DELETE /tags/:tagId?removeFromAssets=true|false`, both
`devices:write` + `canMutateOrgWideGovernance` + the capability for any partner-wide row involved + MFA
step-up (the step-up grant middleware `routes/devices/moveOrg.ts` uses) for merge and for delete with
`removeFromAssets=true`. Order inside one transaction is R§6.2 steps 1–6 with §2.1's lock order;
after commit: `device.updated` events with `changedFields: ['tags']` and
`requestDeviceGroupReevaluationAfterCommit` per affected device. Audit `device_tag.merged|deleted`
with counts.

- [ ] **Step 1: Failing tests:** merge rewrites all three tables and every rewritable reference in one
  transaction; a failing reference rewrite rolls everything back (integration); merging partner-wide
  A into org-owned B → 409 `TagScopeNarrowingError`; merge across two orgs under partner-export
  triggers raises no lock-hierarchy error (integration); delete with a dynamic-group reference → 409
  listing it; delete of an AI-protected tag → 409 in both modes; definition-only delete leaves arrays
  untouched and the slug appears as `registered: false`; a merged slug present twice on a device
  dedupes; merging org A's org-owned `finance` while a partner-wide AI policy names `finance` → 409
  listing that policy, and org B's `finance` references are untouched.
- [ ] **Step 2–4:** FAIL → implement → PASS (integration on the test stack).
- [ ] **Step 5: Commit.**

**Wave 4 exit gate:** unit + `deviceTagsMerge.integration` + `deviceTagReferences.contract` + `tsc`.

---

## Wave 5 — 8837 W03c: tag definitions on device org move (R-OD-9)

### Task 5.1: `reconcileDeviceTagsOnMove`

**Files:**
- Create: `apps/api/src/services/deviceTags/moveReconcile.ts` (+ test)
- Modify: `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts` (`MoveDeviceOrgInput`
  gains `tagMap?: Record<string, string | null>`; `MoveDeviceOrgResult` gains
  `tagReconcile: { registered: number; remapped: number; removed: number }`; call next to the custom-field
  re-home at ~277)
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (body `tagMap`, 409 mapping, audit counts)
- Modify: every other caller of `moveDeviceOrgInTransaction` (`unassignedPool/assignParkedDevice*.ts`,
  `routes/devices/core.ts`) — pass no map; same-partner behaviour applies; a cross-partner call without
  a map fails closed
- Tests: `moveReconcile.test.ts`, extend `routes/devices/moveOrg*.test.ts`, integration
  `deviceTagsMove.integration.test.ts`

**Interfaces — Produces:**

```ts
export class TagMappingRequiredError extends Error { readonly unresolved: string[] }   // → 409 { code: 'TAG_MAPPING_REQUIRED', unresolvedTags }
export async function reconcileDeviceTagsOnMove(input: {
  deviceId: string; sourceOrgId: string; targetOrgId: string; sourcePartnerId: string; targetPartnerId: string;
  tagMap?: Record<string, string | null>;
}): Promise<{ registered: number; remapped: number; removed: number }>;
```

Same partner: each slug with no definition visible in the target org gets an org-owned row there
(label/color copied from the source definition, `source = 'auto'`). Cross partner: every slug without
a visible target definition must be a key of `tagMap`; value = target slug (normalised; registered
org-owned in the target if missing) or `null` (removed; audited). Lock order (§2.1): read the device's
tags with a plain `SELECT`, then `lockTagSlugs(targetPartnerId, slugs ∪ mapped targets)` immediately
after step-up consumption and **before** any partner-export lock (`breeze_cascade_device_org_id`, the
custom-field re-home); the reconcile writes happen before `devices.org_id` flips.

- [ ] **Step 1: Failing tests:** same-partner move of a device tagged with an org-only slug registers
  it in the target and reports `registered: 1`; partner-wide slug → nothing registered; cross-partner
  move without `tagMap` → 409 listing the slugs, nothing written; with `{ finance: 'fin', vip: null }`
  → device tags `['fin']`, audit shows `removed: 1`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`moveOrg*` suites + integration). **Step 5:** commit.

---

## Wave 6 — 8833 W1: bulk routes on a shared helper

**Read first:** B§2, B§3, B§4.1–4.4, B§7 test table; PD-7, PD-8, PD-9.

### Task 6.1: Shared types, schemas and the bulk helper

**Files:**
- Create: `packages/shared/src/types/bulkDeviceAttributes.ts` (export from `packages/shared/src/types/index.ts`)
- Modify: `apps/api/src/routes/devices/schemas.ts` (`bulkTagsSchema`, `bulkCustomFieldSchema`)
- Create: `apps/api/src/services/devices/bulkAttributeWrite.ts` (+ `bulkAttributeWrite.test.ts`)

**Interfaces — Produces:**

```ts
// shared
export type BulkAttributeFailCode = 'NOT_FOUND' | 'SITE_ACCESS_DENIED' | 'STATE_CHANGED' | 'UNKNOWN_FIELD'
  | 'NOT_APPLICABLE_TO_DEVICE' | 'INVALID_VALUE' | 'TAG_LIMIT_EXCEEDED' | 'ERROR';
export interface BulkAttributeResponse {
  bulkId: string;
  succeeded: Array<{ deviceId: string; changed: boolean }>;
  failed: Array<{ deviceId: string; code: BulkAttributeFailCode; message: string; fieldKey?: string }>;
}
export interface BulkTagsRequest { deviceIds: string[]; add: string[]; remove: string[] }
export interface BulkCustomFieldRequest { deviceIds: string[]; fieldKey: string;
  expectedType: 'text' | 'number' | 'boolean' | 'dropdown' | 'date'; value: string | number | boolean | null }

// api: bulkAttributeWrite.ts
export interface VerifiedDevice { id: string; orgId: string; partnerId: string; siteId: string; osType: string | null; hostname: string }
export async function authorizeBulkDevices(c: Context, deviceIds: readonly string[], auth: AuthContext):
  Promise<{ verified: VerifiedDevice[]; failed: BulkAttributeResponse['failed'] }>;
export async function runPerOrgWrites(input: {
  auth: AuthContext; verified: readonly VerifiedDevice[];
  writeOrg: (orgId: string, rows: VerifiedDevice[]) => Promise<{ succeeded: BulkAttributeResponse['succeeded'];
    failed: BulkAttributeResponse['failed']; afterCommit: Array<() => void> }>;
}): Promise<Pick<BulkAttributeResponse, 'succeeded' | 'failed'>>;
```

`authorizeBulkDevices`: dedupe; `getDevicesWithOrgAndSiteCheck` (`routes/devices/helpers.ts:261`);
`null` → `NOT_FOUND`, `SITE_ACCESS_DENIED` → that code; holding-org (unassigned pool) and ephemeral
Quick Support devices → `NOT_FOUND` (B§2, the helper does not exclude them). `runPerOrgWrites`: group
by `orgId`, sort ascending, one `withDbAccessContext` per org with the caller's context; a thrown
error marks every device of that org `ERROR` (logged with the org id) and continues; `afterCommit`
callbacks run only after that org's commit.

Schemas: `bulkTagsSchema = z.object({ deviceIds: z.array(z.string().uuid()).min(1).max(BULK_LIFECYCLE_MAX_DEVICES), add: tagListSchema, remove: tagListSchema })`
refined: `add.length + remove.length ≥ 1`; no slug in both after normalising (400). `bulkCustomFieldSchema` per B§4.3.

- [ ] **Step 1: Failing unit tests:** dedupe; parked/ephemeral → `NOT_FOUND`; three orgs given in
  descending UUID order are written ascending; an org whose writer throws → all its devices `ERROR`,
  other orgs' results kept; `afterCommit` not called for the failed org.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit.

### Task 6.2: Batched custom-field upsert

**Files:**
- Modify: `apps/api/src/services/customFields/queries.ts` (next to `persistDeviceCustomFieldValues`, sharing `valueColumnsFor` and the `IS DISTINCT FROM` guard)
- Modify: `apps/api/src/services/customFields/validateValueMap.ts` (optional preloaded definitions)
- Tests: `queries.test.ts`, `validateValueMap.test.ts`

**Interfaces — Produces:**

```ts
export async function persistDeviceCustomFieldValuesBatch(orgId: string,
  rows: ReadonlyArray<{ deviceId: string; write: CustomFieldValueWrite }>,
  source: 'manual' | 'api' | 'script' | 'import', executor?: CustomFieldValueExecutor): Promise<string[]>;  // changed deviceIds
export async function validateCustomFieldMap(orgId: string, deviceOsType: string | null,
  updates: Record<string, unknown>, definitions?: VisibleCustomFieldDefinition[]): Promise<CustomFieldMapResult>;
```

One multi-row `INSERT … SELECT FROM unnest(...) ON CONFLICT (device_id, definition_id) DO UPDATE … WHERE <distinct guard> RETURNING device_id`;
it requests `custom.<fieldKey>` re-evaluation after commit for changed devices, like the single path.

- [ ] **Step 1: Failing tests:** 3 devices, 1 unchanged → returns 2 ids; `null` writes the explicit
  clear; preloaded definitions are used without a reload (spy on `loadVisibleCustomFieldDefinitions`).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit.

### Task 6.3: `POST /devices/bulk/tags` and `POST /devices/bulk/custom-fields`

**Files:**
- Create: `apps/api/src/routes/devices/bulkAttributes.ts` (exports `bulkAttributeRoutes`)
- Modify: `apps/api/src/routes/devices/index.ts` (mount after `customFieldImportRoutes` (~72) and before `coreRoutes`)
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (both paths)
- Tests: `routes/devices/bulkAttributes.test.ts`, `routes/devices/bulkAttributes.mountorder.test.ts`,
  `middleware/selfManagedDbContextRoutes.test.ts`,
  `src/__tests__/integration/bulkDeviceAttributes.integration.test.ts`, extend
  `src/__tests__/integration/dynamicGroupReevaluation.integration.test.ts`

**Interfaces:**
- Consumes: `authorizeBulkDevices`, `runPerOrgWrites` (6.1), `applyTagDelta` (2.2),
  `persistDeviceCustomFieldValuesBatch`, `validateCustomFieldMap` (6.2), `writeRouteAudit`,
  `requestDeviceGroupReevaluationAfterCommit`.
- Middleware per route (never `.use('*')`): `requireScope('organization','partner','system')`,
  `requirePermission(devices:write)`, `requireMfa()`.
- Tags writer per org: `applyTagDelta({ table: 'devices', rows: verified pairs, add, remove })`; map
  `changed` → `{changed:true}`, `unchanged` → `{changed:false}`, `state_changed` → `STATE_CHANGED`,
  `tag_limit_exceeded` → `TAG_LIMIT_EXCEEDED` (PD-9). After commit, per changed device:
  `writeRouteAudit(c, { action: 'device.tags.update', details: { added, removed, bulk: true, bulkId } })`
  (the **actual** delta) and re-evaluation `changedFields: ['tags'], reason: 'device.tags.bulk_update'`.
- Custom-field writer: B§4.3 steps 2–8; the locked read pins `(id, org_id, site_id, os_type)`. Type
  mismatch → `INVALID_VALUE`, message `definition type differs in this organization`. Audit `value`
  only for dropdown/boolean/date (B-OD-5). Re-evaluation `custom.<fieldKey>` is requested by
  `persistDeviceCustomFieldValuesBatch` itself — the route must not request it again (Codex P6).
- Each org transaction takes §2.1 steps 1–3 before its first row lock.
- Route header comment records the weaker audit-delivery trade (B§4.3 last paragraph).

- [ ] **Step 1: Failing route tests** — every row of B§7's test table for `bulkAttributes.test.ts`, plus:
  `add: ['Café']` → 400 naming the tag; `add` that pushes a 50-tag device to 51 → that device
  `TAG_LIMIT_EXCEEDED`, others succeed; bulk custom-field audit has `value: 'pending-destruction'` for
  a dropdown and no `value` for a text field.
- [ ] **Step 2: Failing mount-order + selfManaged tests** (mirror `bulkLifecycle.mountorder.test.ts`).
- [ ] **Step 3: Failing integration tests** — B§7 rows: concurrency, re-sited device, two-org and
  two-partner lock ordering (higher UUID first in the request), `org_access = 'selected'`,
  site-restricted user, dynamic group membership after a bulk add.
- [ ] **Step 4: Run all — expect FAIL. Step 5: Implement. Step 6: Run — expect PASS.**
- [ ] **Step 7: Commit** `feat(devices): bulk edit tags and custom fields API`.

**Wave 6 exit gate:** unit, mount-order, selfManaged, `bulkDeviceAttributes.integration`,
`dynamicGroupReevaluation.integration`, partner-wide-write-coverage, `tsc` (api + shared).

---

## Wave 7 — 8833 W2: web bulk menu, dialogs, shared custom-field editor

### Task 7.1: `CustomFieldValueEditor` extraction with the null-shows-default fix

**Files:**
- Create: `apps/web/src/components/devices/CustomFieldValueEditor.tsx` (+ test)
- Modify: `apps/web/src/components/devices/DeviceInfoTab.tsx` (`renderFieldEditor` ~734 → component; display fix ~1485)

**Interfaces — Produces:** `export function CustomFieldValueEditor(props: { definition: CustomFieldDefinitionView; value: string | number | boolean | null; onChange(v: string | number | boolean | null): void; disabled?: boolean }): JSX.Element`.

- [ ] **Step 1: Failing tests:** dropdown renders its options; date renders a date input; a stored
  `null` renders empty (not the definition default) on the device page.
- [ ] **Step 2–4:** FAIL → implement → PASS (`DeviceInfoTab` tests too). **Step 5:** commit.

### Task 7.2: Client module, dialogs, outcome toast

**Files:**
- Create: `apps/web/src/lib/api/bulkDeviceAttributes.ts`, `components/devices/BulkEditTagsDialog.tsx`,
  `components/devices/BulkSetCustomFieldDialog.tsx`, `components/devices/bulkAttributeOutcome.ts` (+ tests)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS` += the three new files);
  **not** `runActionAllowlist.ts`

**Interfaces — Produces:**

```ts
export async function bulkEditTags(body: BulkTagsRequest): Promise<BulkAttributeResponse>;          // runAction, no successMessage
export async function bulkSetCustomField(body: BulkCustomFieldRequest): Promise<BulkAttributeResponse>;
export function reportBulkAttributeOutcome(res: BulkAttributeResponse, hostnames: Map<string, string>): void;
export type TagSource = { search(q: string): Promise<Array<{ slug: string; name: string; color: string | null }>> };
```

Dialog behaviour per B§4.5. `TagSource` default reads `GET /tags?search=` (registry-backed after
W03a). Add input previews the slug via `normalizeTagList`. Remove suggestions are the slugs on the
loaded rows with counts. Client rejects > 500 ids with a message.

- [ ] **Step 1: Failing tests** (`BulkEditTagsDialog.test.tsx`, `BulkSetCustomFieldDialog.test.tsx`,
  `bulkAttributeOutcome.test.ts`): body shapes; > 500 refused; toasts for all / partial / none failed;
  type-conflict warning; definition applicable to none is disabled with its reason; network rows skipped.
- [ ] **Step 2–4:** FAIL → implement → PASS (+ `no-silent-mutations.test.ts`). **Step 5:** commit.

### Task 7.3: Menu entries and gating (DeviceList merge rule §2.2 applies)

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx` (new block above the destructive section, and in the removed-selection block ~3068-3088)
- Modify: `apps/web/src/components/devices/bulkActionGating.ts` (`INTENTIONALLY_UNGATED_BULK_ACTIONS` += `'bulk-edit-tags'`, `'bulk-set-custom-field'`)
- Modify: `apps/web/src/components/devices/DevicesPage.tsx` (`handleBulkAction` ~1602 opens the dialogs)
- Modify: every locale under `apps/web/src/lib/i18n/`
- Tests: `DeviceList.test.tsx`, `DevicesPage` tests

- [ ] **Step 1: Failing tests:** entries render for active, mixed and removed selections with
  `data-testid="bulk-edit-tags"` / `bulk-set-custom-field`; hidden without `devices:write`; "N of M
  eligible" when network rows are selected; gating contract includes both strings; localeParity.
- [ ] **Step 2–4:** rebase on main, FAIL → implement → PASS. **Step 5:** commit.
- [ ] **Step 6: Docs:** "Bulk editing" sections in `features/tags.mdx` and `features/custom-fields.mdx`.

**Wave 7 exit gate:** `apps/web` vitest for touched files + `no-silent-mutations` + `localeParity` +
`tsc --noEmit -p apps/web` exit 0; a Playwright run on a wt-stack: select 3 devices in 2 orgs → add tag
→ toast → chips updated.

---

## Wave 8 — 8833 W3: `manage_tags` with `deviceIds`, Tier 3

### Task 8.1

**Files:**
- Modify: `apps/api/src/services/aiToolsDevice.ts` (`manage_tags` def ~723-842: base `tier` stays 2,
  `deviceArgs: ['deviceId', 'deviceIds']`, `selfManagedDbContext` declared for `add`/`remove` so the
  per-org transactions commit separately (contract: `aiTools.selfManagedDbContext.test.ts`,
  `aiTools.deviceWaitContext.contract.test.ts`), header comment ~10 → "Tier 3 add/remove, Tier 1 list")
- Modify: `apps/api/src/services/aiToolSchemas.ts` (`manage_tags` ~2131: `deviceIds: z.array(z.string().uuid()).min(1).max(50).optional()`, exactly one of `deviceId`/`deviceIds` for add/remove)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TIER3_ACTIONS.manage_tags = ['add', 'remove']`;
  `TIER1_ACTIONS.manage_tags = ['list']` unchanged; approval summary case ~3304:
  `ADD tags [x] on 12 devices`). **Not** a static `tier: 3`: MCP computes
  `max(baseTier, actionTier)` (`routes/mcpServer.ts:~1595`), so a static Tier 3 would make `list`
  Tier 3 over MCP too (Codex P7).
- Tests: `aiToolsDevice.manageTags.test.ts`, `aiTools.deviceGate.test.ts`, guardrail tier contract tests,
  `aiToolsDeviceScope.contract.test.ts`, `aiToolsSiteScope.contract.test.ts`, `aiToolIndex.test.ts`

**Interfaces:** consumes `runPerOrgWrites` and `applyTagDelta`. Device rows are loaded for the
ids `enforceDeviceArgs` already admitted (`aiTools.ts:257-277`); holding-org and ephemeral devices are
refused like the HTTP route. Audit and re-evaluation as the bulk route with `reason: 'ai_manage_tags'`.

- [ ] **Step 1: Failing tests:** one foreign id denies the whole call; 51 ids → schema error; add on 3
  devices audits 3 events and requests 3 re-evaluations; add/remove resolve to Tier 3 and `list` to
  Tier 1 **both in chat and through the MCP effective-tier computation**; a failure in one org's
  transaction leaves another org's committed write in place; approval text names the device count; MCP Tier 3 opt-in still applies; tool index stays
  under its byte cap.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit. Release note: `manage_tags`
  add/remove now ask for approval (B-OD-2).

---

## Wave 9 — 8837 W04: `/settings/tags`, `TagPicker`, colored chips

### Task 9.1: Client + registry hook + chips

**Files:**
- Create: `apps/web/src/lib/api/deviceTags.ts`, `apps/web/src/hooks/useTagRegistry.ts`,
  `apps/web/src/components/devices/TagChip.tsx` (+ tests)
- Modify: `DeviceList.tsx` chips (~2349-2375; §2.2 rule), device detail and asset modals' chip rendering

**Interfaces — Produces:** `useTagRegistry(): { bySlug: Map<string, TagListItem>; loading: boolean; invalidate(): void }`
(cached per org context; invalidated by every tag mutation); `TagChip({ slug })` renders the registry
color, neutral when unregistered.

### Task 9.2: `TagPicker`

**Files:** Create `apps/web/src/components/devices/TagPicker.tsx` (+ test); Modify `DeviceSettingsModal.tsx`,
`ManualAssetModal.tsx`, the network-asset edit form, `BulkEditTagsDialog.tsx` (Add input → `TagPicker`).

**Interfaces — Produces:** `TagPicker(props: { value: string[]; onChange(slugs: string[]): void; allowCreate?: boolean; 'data-testid'?: string })` —
typeahead over `GET /tags?search=`, color chips, a "Create `<label>`" row that shows the slug it will
save, inline rejection text from `normalizeTagList`.

### Task 9.3: `/settings/tags`

**Files:** Create `apps/web/src/pages/settings/tags.astro`, `components/settings/TagsSettings.tsx`,
`components/settings/TagDrawer.tsx`, `components/settings/MergeTagDialog.tsx`,
`components/settings/DeleteTagDialog.tsx` (+ tests); Modify `apps/web/src/lib/settingsCatalog.ts`
(`{ id: 'tags', group: 'data', href: '/settings/tags', requiredPermission: { resource: 'devices', action: 'read' } }`
next to `custom-fields`), all locales, `lib/routeScope.ts` if the page needs a scope classification.

Behaviour per R§9: owner badge ("All organizations" for partner-wide), per-class counts, unregistered
rows with **Register**, slugs owned by ≥ 2 orgs flagged with **Promote to all organizations** (PD-3),
row drawer with Save (rule 7), merge/delete confirmations showing counts and `GET /tags/:tagId/references`.
Mutations via `runAction`. Rule 9 statement in the PR body: home `/settings/tags`; levels partner
(default) and org (org-only additions); resolver `services/deviceTags/resolve.ts`; configured in 0
places before, 1 after.

- [ ] **Steps for 9.1–9.3:** failing tests first (`settingsPageRegistry.test.ts`,
  `no-silent-mutations.test.ts`, `localeParity`, component tests: picker create row shows slug, merge
  dialog lists references, promote button only for ≥ 2 owning orgs and only with full partner access),
  then implement, then PASS, commit per task. Playwright (data-testid): create tag → assign via
  picker → merge into another → chips update.

---

## Wave 10 — 8833 W4: manual-asset bulk tags

### Task 10.1

**Files:**
- Modify: `apps/api/src/routes/devices/schemas.ts` (`bulkTagsSchema`: `manualAssetIds: z.array(z.string().uuid()).max(500).default([])`;
  refine `deviceIds.length + manualAssetIds.length` in 1..500; `deviceIds` becomes `.default([])`)
- Modify: `apps/api/src/services/devices/bulkAttributeWrite.ts` (`authorizeBulkManualAssets(c, ids, auth)` using
  `manualAssetConditions` (`routes/tags.ts:42`, moved to `routes/tags/list.ts` in W03a) + site check)
- Modify: `apps/api/src/routes/devices/bulkAttributes.ts`; `packages/shared/src/types/bulkDeviceAttributes.ts`
  (`manualAssets?: { succeeded: Array<{ manualAssetId: string; changed: boolean }>; failed: Array<{ manualAssetId: string; code: BulkAttributeFailCode; message: string }> }`, PD-12)
- Modify (web): `BulkEditTagsDialog.tsx`, `DeviceList.tsx` eligibility (§2.2 rule)
- Tests: `bulkAttributes.test.ts`, `bulkDeviceAttributes.integration.test.ts`, dialog tests

**Interfaces:** per org, `applyTagDelta({ table: 'manual_assets', … })` in the same org transaction
after the device writes. Audit `manual_asset.tags.update`. No group re-evaluation (manual assets are
not group members). Custom fields stay agent-only.

- [ ] **Step 1: Failing tests:** mixed selection of 2 devices + 2 manual assets in two orgs updates all 4;
  a manual asset in a denied site → `SITE_ACCESS_DENIED` in `manualAssets.failed`; the W1 response
  shape is unchanged when `manualAssetIds` is absent; the dialog counts manual rows as eligible for
  tags and not for custom fields.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit.

---

## Wave 11 — 8837 W05a: restricted tags (column, permission, write protection, consumer hardening)

**Migration:** `apps/api/migrations/2026-12-30-190200-device-tags-restricted.sql` —
`ALTER TABLE public.device_tags ADD COLUMN IF NOT EXISTS restricted boolean NOT NULL DEFAULT false;`
Export policy: add `restricted` to `included`. Read R-OD-4 in full first.

### Task 11.1: Column, permission, write rules

**Files:** migration; `db/schema/deviceTags.ts`; `tenantExportPolicyRegistry.ts`; the shared permission
grants (`PERMISSION_GRANTS` in `@breeze/shared`, re-exported by `apps/api/src/services/permissions.ts:407`)
gain `devices:tags:restricted` (session users only — the API-key scope catalog and the device-script
surface must not be able to hold it); `services/deviceTags/restricted.ts`; `applyTags.ts`,
`mergeDelete.ts`, `moveReconcile.ts`, `routes/tags/registry.ts`.

**Interfaces — Produces:** `export async function assertRestrictedTagChange(input: { actor: TagWriteActor & { isApiKey: boolean }; orgId: string; partnerId: string; before: readonly string[]; after: readonly string[] }): Promise<void>`
(throws `TagValidationError` code `RESTRICTED_TAG`). Called by `prepareTagReplace` and `applyTagDelta`
for every add or remove of a restricted slug, by merge/delete when either side is restricted, by
`PATCH /tags/:tagId` when `restricted` flips true→false (downgrade), and by move reconcile (a restricted
slug whose definition is not visible in the target is removed and audited).

- [ ] **Steps:** failing tests (API key cannot add/remove a restricted tag; session user without the
  permission cannot; with it can; whole-array PATCH that silently drops a restricted tag is refused;
  downgrade needs the permission; export-policy + rls-coverage suites green with the new column) → implement → PASS → commit.

### Task 11.2: Consumers that trust tags outside the filter engine

**Files:** `services/automationRuntime.ts` (~1044-1050: substring → exact slug membership),
`services/aiAgents/runResourceScope.ts` (~47: `triggers.deviceTags` scope only counts restricted tags
of the agent's owner), tests for both.

- [ ] **Steps:** failing tests (`prod` no longer matches `production`; an agent trigger on an
  unrestricted tag no longer widens run scope) → implement → PASS → commit. Release note: legacy
  automation tag conditions now match exact tags. Exact matching alone still lets an API-key-written
  tag steer a legacy automation (Codex P8); whether those conditions also require restricted tags is
  **OPEN-2**, implemented in W05b if approved.

---

## Wave 12 — 8837 W05b: restricted-tag rules as execution targets

### Task 12.1: Value-aware filter gate

**Files:** `apps/api/src/services/filterEngine.ts` (execution-refused set ~214, ~252-286), its gating
tests, `executionTargetGating*` tests.

Rule: a `tags` condition is execution-safe only when its operator is `hasAny` or `hasAll`, its value
list is non-empty after `tagMatchValues`, and every value is a restricted tag owned by the group's
owner (org group: that org's or its partner's partner-wide restricted tags). `isEmpty`/`isNotEmpty`,
`contains` (it reaches a scalar `ILIKE` today, `filterEngine.ts:~689`, not array membership — Codex;
stricter than R-OD-4(b)'s list) and any unrestricted value stay refused. Re-checked at dispatch, not
only at save. Cover every gate, not only the shared group resolver: direct partitioner callers and
inline-filter gates (the Explore sweep in this wave lists them in the PR).

### Task 12.2: Compliance targets regain execution for restricted-only tags (PD-1)

**Files:** `services/policyEvaluationService.ts` (`targetKindOf` observe-only rule), its tests,
`policyTagTargets.integration.test.ts`.

A tag-targeted policy whose every target tag is restricted publishes `policy.*` events and may
dispatch remediation; any unrestricted target tag keeps today's observe-only behaviour. Re-checked at
evaluation time (a tag downgraded after save goes back to observe-only) **and** at every downstream
dispatch: event-triggered automations, alert-triggered automations and AI-agent alert triggers
(Codex P8). `services/complianceAlertReconcile.ts:~337` closes alerts of every tag-targeted policy
today; it must keep alerts of restricted-only policies open. **W05b does not merge until every
execution gate above and the alert reconcile use the restricted-owner rule** (Codex).

- [ ] **Steps for 12.1–12.2:** failing tests (restricted-only `hasAny` group becomes a valid script
  target; one unrestricted value refuses it; `isEmpty` refused; downgrade after save refuses at
  dispatch; restricted-only compliance policy dispatches remediation, mixed stays observe-only) →
  implement → PASS → commit. Docs: `features/tags.mdx` restricted tags section.

---

## Spec coverage map

| Spec section | Wave / task |
|---|---|
| R§4.1–4.2 table, RLS, no-shadow | W02a 1.1 |
| R§4.4 registrations | W02a 1.2 |
| R§4.3 GIN index | not planned — R§4.3 says measure first; record `EXPLAIN` of the filter engine `&&` on a 10k-device org in the W02b PR and open an issue if it seq-scans badly |
| R§5.1–5.3 normaliser, write paths, auto-registration | W02b 2.1–2.3 |
| R§5.4 reads | W03a 3.1 |
| R§6.1, 6.2a rename, promote | W03a 3.2 |
| R§6.2, 6.3, 6.4 merge, references, delete | W03b 4.1–4.2 |
| R§4.4 device move | W03c 5.1 |
| R§7, R§8 (config-policy claim) | shipped #8895 (§0) |
| R§8 registry docs | W03a 3.2 Step 5, W04, W05b |
| R§9 UI | W04 9.1–9.3 |
| R§13 backfills | W02a 1.3, W02b 2.5 |
| R-OD-4(b) restricted tags | W05a, W05b |
| B§4.1–4.4 routes, helper, tenancy | 8833 W1 6.1–6.3 |
| B§4.5 web | 8833 W2 7.1–7.3 |
| B§4.6 MCP | 8833 W3 8.1 |
| B-OD-4 manual assets | 8833 W4 10.1 |
| B-OD-7 `set_custom_field` | deferred by decision — open a follow-up issue when W3 merges |
