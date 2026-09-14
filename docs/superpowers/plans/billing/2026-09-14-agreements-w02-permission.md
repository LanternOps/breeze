---
tracking_issue: LanternOps/breeze#5822
---
# Agreements W02: `agreements` permission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agreement-template library and the signed-agreement surfaces their own permission resource — `agreements:read` / `agreements:write` — so an MSP can let someone read or author the MSA library without also handing them recurring-billing authority, and vice versa. The API guards flip in the same PR, so a migration back-fill is the only thing standing between an upgrade and a fleet-wide 403.

**Architecture:** One new resource in the shared registry (`PERMISSION_GRANTS`), two rows in the API seed's `DEFAULT_PERMISSIONS`, two role-preset edits, one `RESOURCE_LABELS` entry, one idempotent migration that seeds both permission rows and back-fills every role that already holds the equivalent `contracts:*` grant, and two one-line guard swaps in `routes/contracts/templates.ts` / `documents.ts`. The web side changes exactly one file (`orgRecordTabs.ts`) plus one test fixture. No schema change, no new table, no RLS work, no API path change.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), PostgreSQL with hand-written SQL migrations applied by `apps/api/src/db/autoMigrate.ts`, Hono + Zod, Drizzle, Vitest (API unit with Drizzle mocks; API integration against real Postgres), React islands under Astro, Starlight docs.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-agreements-vocabulary-and-ia-design.md` (approved by Todd 2026-09-14). §4 is normative for this wave; §2 is the vocabulary. **§5 (API path rename with aliases) is DROPPED by advisor quorum (D4 reversal)** — `/contracts/contract-templates` and `/contracts/contract-documents` remain the only paths. Depends on **W01** (copy) for key names only; nothing in this wave reads a locale key.

**Blast radius: HIGH (auth + migration).** Full rigor: red-first unit tests everywhere, a live-Postgres integration test for the migration, and a guard contract test that proves the routes ask for `agreements:*` and not `contracts:*`.

---

## Global Constraints

- **Migration filename must sort AFTER every committed migration** under `localeCompare`, not by calendar date (`apps/api/migrations/README.md` "Rule 3"; shipped names run ahead of real time). Verified on this branch at `origin/main` 610baba63:
  ```bash
  git ls-tree --name-only HEAD apps/api/migrations/ | sed 's#.*/##' \
    | grep -E '^[0-9]{4}-.*\.sql$' \
    | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);
               console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
  # => 2026-10-16-182600-ticket-comment-proposal-note-uq.sql
  ```
  This wave therefore uses **`2026-10-16-190000-agreements-permission.sql`** (`190000` > `182600`; preferred `YYYY-MM-DD-HHMMSS-<slug>` form). Re-run the command before every commit and rename upward if `origin/main` gained a later file — a `pre-push` hook runs `scripts/check-migration-naming.sh --against-ref origin/main` and will fail locally if it did.
- **Do NOT add a file to the closed `2026-08-06` block** (README "Reserved / closed date blocks").
- **Writing rows requires system scope first.** `SELECT set_config('breeze.scope', 'system', true);` must be the first statement in the migration file, before any INSERT. `breeze_current_scope()` defaults to `'none'`; an unwrapped INSERT aborts with 42501 on a non-BYPASSRLS connection. Enforced by `apps/api/src/db/migrationRlsScope.test.ts`, whose frozen baseline of 122 pre-rule migrations is capped at a cutoff filename — **a new migration cannot be silenced by adding it to the baseline. The baseline list must not grow in this PR.**
- **No inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in a transaction. `is_local = true` on the `set_config` scopes the elevation to that transaction, so one line at the top covers the whole file.
- **Every insert reports its row count** via `GET DIAGNOSTICS n = ROW_COUNT` + `RAISE WARNING` (README "Content rules"). Silently fixing data destroys the forensic trail, and a "0" under RLS is indistinguishable from a real 0 without the elevation above.
- **Never edit a shipped migration.** Fix forward.
- **`pnpm db:check-drift` is NOT required for this wave.** Drift checking compares the Drizzle schema in `apps/api/src/db/schema/` against the database. This migration creates no table and alters no column — it only INSERTs rows into the existing `permissions` and `role_permissions` tables. There is no schema change to drift against, and no `apps/api/src/db/schema/` file is touched.
- **Run one API/web/shared test file as `cd <pkg> && npx vitest run <path>`.** Never `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--`, vitest swallows `--run` as a positional filter, stays in watch mode and runs the entire suite (CLAUDE.md, verified repro).
- **Vitest's path filter is a plain substring match**, not a glob — list dotted sibling files explicitly.
- **Branch:** `feature/5822-agreements-ia/wave-5824`. **PR body contains `Closes #5824`.**

---

## Verified facts (read before starting — every line number below was opened and confirmed on this branch)

| Fact | Evidence |
|---|---|
| `PERMISSION_GRANTS` carries **no** description field — only `{ resource, action }`. Descriptions live in `DEFAULT_PERMISSIONS` and the migration. | `packages/shared/src/constants/permissions.ts:14-206`; contracts block `:79-82`; type derivation `:209-214` |
| `apps/api/src/services/permissions.ts:282` aliases the shared registry as `PERMISSIONS`; `KNOWN_PERMISSIONS:289`, `ASSIGNABLE_PERMISSIONS:297` (filters out `*`), `ASSIGNABLE_PERMISSION_KEYS:301` all derive from it automatically. Adding to the registry is enough. | read |
| `DEFAULT_PERMISSIONS` is an untyped array literal starting at `apps/api/src/db/seed.ts:110`; contracts rows at `:177-179`, `documents` at `:182-183`, quotes at `:186-188`. | read |
| `SystemRoleDefinition.permissions` is `string[]` (`seed.ts:272`) — **not** typed against the registry, so a typo will not fail to compile. `seed.test.ts:84-122` is the guard: every system-role grant must exist in `DEFAULT_PERMISSIONS`. | read |
| Role presets: `Partner Billing` at `seed.ts:321-336` (contracts grants `:334`), `Partner Billing Viewer` at `:337-348` (contracts grant `:346`). | read |
| `permissionsCatalog.test.ts:66-71` loops every assignable permission and asserts `body.resourceLabels[p.resource]` is truthy — adding `agreements` to the registry **without** a `RESOURCE_LABELS` entry turns that test red. `RESOURCE_LABELS` is `apps/api/src/routes/permissionsCatalog.ts:12-45` (`contracts:'Contracts'` at `:32`). | read |
| `roles.test.ts:1045-1060` iterates `ASSIGNABLE_PERMISSIONS` with `it.each`, so the new grants get coverage automatically. Run it. | read |
| Guards: `apps/api/src/routes/contracts/templates.ts:35` `readPerm`, `:36` `writePerm`; `documents.ts:22` `readPerm`, `:23` `writePerm`. Used on every route: templates `:74,88,97,107,124,134,161,195,213,226`; documents `:51,62,91`. | read |
| **`templates.test.ts` and `documents.test.ts` have NO grant fixtures to update.** Both mock `../../middleware/auth` with `requirePermission: () => async (_c, next) => next()` — an unconditional pass-through (`templates.test.ts:29-43`, `documents.test.ts:20-33`). The only "contract perms" in those files is a code comment. The negative test therefore needs a **new** file with a permission-aware mock; see Task 4. | read |
| `requirePermission` (`apps/api/src/middleware/auth.ts:862-892`) 401s when `c.get('auth')` is unset, then resolves via `getUserPermissions` and `hasPermission`, throwing 403 `Permission denied`. `requireScope` (`:811-823`) 401s the same way. | read |
| **Wildcards:** matching is per-axis (`apps/api/src/services/permissionMatching.ts:14-23` — `grant.resource === resource \|\| grant.resource === '*'`). The only wildcard permission row anywhere is `*:*` (`seed.ts:263`), and `apps/api/src/routes/roles.ts:291` rejects any wildcard on a custom role. See Task 3 Step 2 for the back-fill consequence. | read |
| **Permission cache exists:** in-process `Map` `permissionCache` (`services/permissions.ts:36`), `CACHE_TTL = 5 * 60 * 1000` (`:37`), cross-process invalidation via Redis version keys (`:38-39`, `getPermissionCacheVersions:45`, `bumpSharedPermissionCacheVersion:73`), exported `clearPermissionCache(userId?)` at `:265`. See Task 3 Step 5. | read |
| `contractTemplateRoutes` / `contractDocumentRoutes` apply **no** `authMiddleware` of their own — they inherit it from `contractRoutes.use('*', authMiddleware)` (`routes/contracts/index.ts:15`). *(Recorded for W3: any future mount of those routers outside `contractRoutes` must wrap them in auth or every caller 401s. No work item in W2.)* | read |
| `TemplatesTab.tsx`, `DocumentsTab.tsx` and `ContractsTabs.tsx` contain **zero** permission code — no `usePermissions`, no `can(`, no `AccessDenied`. Confirmed by reading their import blocks and grepping. See Task 5. | read |
| `orgRecordTabs.ts` `TAB_PERMISSION.billing` is an ANY-of array at `:56-60`; the registry is `:50-...`; `visibleTabs` is the consumer. | read |
| `Sidebar.tsx:337` is the Contracts nav item (`requiredPermission: { resource: 'contracts', action: 'read' }`, `partnerScopeOnly: true`). Billing section starts `:324`. | read |
| `Sidebar.rbac.test.tsx:43-49` `PARTNER_BILLING` mirrors the seeded preset by hand. | read |
| Docs: `apps/docs/src/content/docs/features/contracts.mdx` — `## Permissions` heading at `:215`, its single paragraph at `:217`, `## Related` at `:219`. (The facts file's `:183-185` was stale; verified against the file.) | read |
| Typecheck: **neither `apps/api` nor `apps/web` has a `typecheck` script.** CI runs `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` (`.github/workflows/ci.yml:253`) and `astro check` from `apps/web` (`:257`). `packages/shared` does have `"typecheck": "tsc --noEmit"`. | read |
| A new file under `apps/api/src/__tests__/integration/` is picked up by the shared glob in `apps/api/vitest.integration.config.ts` (`'src/__tests__/integration/**/*.test.ts'`) — no config edit needed. | read |

---

## File structure

| Path | Change |
|---|---|
| `packages/shared/src/constants/permissions.ts` | add `AGREEMENTS_READ` / `AGREEMENTS_WRITE` |
| `packages/shared/src/constants/permissions.test.ts` | red-first assertions |
| `apps/api/src/db/seed.ts` | 2 `DEFAULT_PERMISSIONS` rows; `Partner Billing` +read/write; `Partner Billing Viewer` +read |
| `apps/api/src/db/seed.test.ts` | red-first preset assertions |
| `apps/api/src/routes/permissionsCatalog.ts` | `RESOURCE_LABELS.agreements = 'Agreements'` |
| `apps/api/src/routes/permissionsCatalog.test.ts` | red-first label assertion |
| `apps/api/migrations/2026-10-16-190000-agreements-permission.sql` | **new** — seed both rows + no-regression back-fill |
| `apps/api/src/__tests__/integration/agreementsPermissionMigration.integration.test.ts` | **new** — live-DB replay test |
| `apps/api/src/index.ts` | one `clearPermissionCache()` line after `initializeDatabaseForStartup` |
| `apps/api/src/routes/contracts/templates.ts` | `:35-36` → `AGREEMENTS_READ` / `AGREEMENTS_WRITE` |
| `apps/api/src/routes/contracts/documents.ts` | `:22-23` → `AGREEMENTS_READ` / `AGREEMENTS_WRITE` |
| `apps/api/src/routes/contracts/agreementsPermission.test.ts` | **new** — guard contract test (positive + negative) |
| `apps/web/src/components/organizations/record/orgRecordTabs.ts` | `TAB_PERMISSION.billing` += `agreements:read` |
| `apps/web/src/components/organizations/record/orgRecordTabs.test.ts` | red-first assertion |
| `apps/web/src/components/layout/Sidebar.rbac.test.tsx` | refresh `PARTNER_BILLING` fixture to match the seed |
| `apps/docs/src/content/docs/features/contracts.mdx` | rewrite `## Permissions` |

**Explicitly NOT touched (quorum D4 reversal / scope):** `apps/api/src/index.ts` route mounts, `apps/api/src/routes/contracts/index.ts`, `apps/api/src/middleware/bodyLimit.ts` (+ its test), `apps/web/src/lib/api/contractTemplates.ts`, `apps/web/src/lib/api/contractDocuments.ts`, `apps/web/src/components/contracts/ContractDetail.documents.test.tsx`, `e2e-tests/tests/quote-contract-proposal.spec.ts`, `apps/web/src/components/layout/Sidebar.tsx`, `apps/web/src/components/organizations/record/OrgBillingTab.tsx`, any `apps/api/src/db/schema/` file.

---

### Task 1: Shared permission registry — `AGREEMENTS_READ` / `AGREEMENTS_WRITE`

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts`
- Modify: `packages/shared/src/constants/permissions.test.ts`

**Interfaces:**
- Produces: `PERMISSION_GRANTS.AGREEMENTS_READ = { resource: 'agreements', action: 'read' }`, `PERMISSION_GRANTS.AGREEMENTS_WRITE = { resource: 'agreements', action: 'write' }`. Widens the derived `PermissionResource` union with `'agreements'`, which is what makes the web gate literal in Task 5 compile.
- Consumed by: `apps/api/src/services/permissions.ts:282` (`PERMISSIONS`), Tasks 2, 4, 5.

**No `manage` action** (spec §4): there is nothing to manage beyond write — publish and archive are both write operations on a template.

- [ ] **Step 1: Write the failing test.** Append to `packages/shared/src/constants/permissions.test.ts`, following the shape of the existing `documents permission (service deliverables W03)` block:

```ts
describe('agreements permission (agreements vocabulary + IA split, W02)', () => {
  it('declares read and write on the agreements resource', () => {
    expect(PERMISSION_GRANTS.AGREEMENTS_READ).toEqual({ resource: 'agreements', action: 'read' });
    expect(PERMISSION_GRANTS.AGREEMENTS_WRITE).toEqual({ resource: 'agreements', action: 'write' });
  });

  // The whole point of the resource: the template library must be reachable
  // without recurring-billing authority, and vice versa.
  it('is a distinct resource from contracts', () => {
    expect(PERMISSION_GRANTS.AGREEMENTS_READ).not.toEqual(PERMISSION_GRANTS.CONTRACTS_READ);
    expect(PERMISSION_GRANTS.AGREEMENTS_WRITE).not.toEqual(PERMISSION_GRANTS.CONTRACTS_WRITE);
  });

  // No `manage`: publish and archive are write operations on a template
  // (spec §4). A third action would be an ungated capability with no gate.
  it('declares no third action', () => {
    const agreementKeys = Object.keys(PERMISSION_GRANTS).filter((k) => k.startsWith('AGREEMENTS_'));
    expect(agreementKeys.sort()).toEqual(['AGREEMENTS_READ', 'AGREEMENTS_WRITE']);
  });
});
```

- [ ] **Step 2: Run it — expect RED.**
```bash
cd packages/shared && npx vitest run src/constants/permissions.test.ts
```
Expected failure: `TypeError: Cannot read properties of undefined` / `expected undefined to deeply equal { resource: 'agreements', action: 'read' }`, plus a TS error that `AGREEMENTS_READ` does not exist on the registry.

- [ ] **Step 3: Add the grants.** In `packages/shared/src/constants/permissions.ts`, insert immediately after the `DOCUMENTS_*` block (which ends at `:88`), before the `// Quotes / Proposals` comment at `:90`:

```ts
  // Agreement templates + signed agreements (agreements vocabulary & IA split,
  // spec §4). Deliberately NOT folded into `contracts`: a billing contract and
  // the MSA a customer signs are different objects with different audiences —
  // an MSP may want a technician who can pull up the signed MSA without
  // touching recurring billing, and a billing clerk who runs contracts without
  // authoring legal terms. No `manage` action: publish and archive are write
  // operations on a template, so there is nothing left for a third verb to gate.
  AGREEMENTS_READ: { resource: 'agreements', action: 'read' },
  AGREEMENTS_WRITE: { resource: 'agreements', action: 'write' },
```

- [ ] **Step 4: Run it — expect GREEN.**
```bash
cd packages/shared && npx vitest run src/constants/permissions.test.ts
cd packages/shared && npx tsc --noEmit
```

- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/constants/permissions.ts packages/shared/src/constants/permissions.test.ts
git commit -m "feat(billing): add agreements:read/write to the shared permission registry (W02)"
```

---

### Task 2: API seed rows, role presets, and the catalog label

**Files:**
- Modify: `apps/api/src/db/seed.ts`
- Modify: `apps/api/src/db/seed.test.ts`
- Modify: `apps/api/src/routes/permissionsCatalog.ts`
- Modify: `apps/api/src/routes/permissionsCatalog.test.ts`

**Interfaces:**
- Produces: two `DEFAULT_PERMISSIONS` entries (fresh-install seeding); `Partner Billing` gains `agreements:read` + `agreements:write`; `Partner Billing Viewer` gains `agreements:read`; `RESOURCE_LABELS.agreements = 'Agreements'`.
- `Org Admin` is **unchanged** (spec §4): templates are partner-scope in the UI today via `partnerScopeOnly`. `Partner Admin` needs nothing — it holds `*:*`, which `permissionMatching.ts:21-22` resolves against any resource.
- Consumed by: `GET /permissions/catalog` (the role editor UI), `seedRoles()`.

**Why the catalog label is not optional:** `permissionsCatalog.test.ts:66-71` asserts a truthy `resourceLabels[p.resource]` for **every** assignable permission. Task 1 already widened `ASSIGNABLE_PERMISSIONS`, so that test is *already* red at the start of this task — that is the red-first signal, and Step 1 below makes it explicit rather than incidental.

- [ ] **Step 1: Write the failing assertions.**

In `apps/api/src/routes/permissionsCatalog.test.ts`, inside the existing `GET /permissions/catalog` "returns the full assignable permission list with labels" test, next to the `expect(body.resourceLabels.workspace).toBe('Workspace');` spot-check (`:73`), add:

```ts
      // W02: the agreements resource must carry a human label, or the role
      // editor renders a raw `agreements` string in the resource column.
      expect(keys).toContain('agreements:read');
      expect(keys).toContain('agreements:write');
      expect(body.resourceLabels.agreements).toBe('Agreements');
```

In `apps/api/src/db/seed.test.ts`, append a new describe block (mirroring the existing `agent rollback RBAC` block's `byName` helper at `:125`):

```ts
describe('agreements RBAC (W02)', () => {
  const byName = (name: string) => SYSTEM_ROLES.find((role) => role.name === name);

  it('seeds both agreements permission rows', () => {
    const keys = DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`);
    expect(keys).toContain('agreements:read');
    expect(keys).toContain('agreements:write');
  });

  it('Partner Billing can read and write agreements', () => {
    expect(byName('Partner Billing')!.permissions).toEqual(
      expect.arrayContaining(['agreements:read', 'agreements:write']),
    );
  });

  it('Partner Billing Viewer can read agreements but not write them', () => {
    const perms = byName('Partner Billing Viewer')!.permissions;
    expect(perms).toContain('agreements:read');
    expect(perms).not.toContain('agreements:write');
  });

  // Spec §4: templates are partner-scope in the UI today (partnerScopeOnly),
  // so Org Admin's grant set is deliberately unchanged by this wave.
  it('leaves Org Admin without an agreements grant', () => {
    const perms = byName('Org Admin')!.permissions;
    expect(perms).not.toContain('agreements:read');
    expect(perms).not.toContain('agreements:write');
  });
});
```

- [ ] **Step 2: Run them — expect RED.**
```bash
cd apps/api && npx vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts
```
Expected failures: `expected [ … ] to contain 'agreements:read'` (seed), and in the catalog test both the new `resourceLabels.agreements` assertion **and** the pre-existing `:66-71` loop (`expected undefined to be truthy`) — the loop firing confirms Task 1 landed.

- [ ] **Step 3: Add the seed rows.** In `apps/api/src/db/seed.ts`, after the `documents` block (`:181-183`) and before `// Quotes / Proposals` (`:185`):

```ts
  // Agreement templates + signed agreements (agreements vocabulary & IA split, W02).
  { resource: 'agreements', action: 'read', description: 'View agreement templates and signed agreements' },
  { resource: 'agreements', action: 'write', description: 'Create, edit, publish and archive agreement templates; link signed agreements' },
```

These two description strings are **normative** (spec §4) and must be byte-identical to the ones in the migration (Task 3) — a fresh install seeds from here, an upgrade seeds from there, and a divergence means two databases disagree about what the permission says it does.

- [ ] **Step 4: Update the two role presets.** In the `Partner Billing` preset (`seed.ts:321-336`), change the contracts line `:334` block to add a line after it:

```ts
      'contracts:read', 'contracts:write', 'contracts:manage',
      'agreements:read', 'agreements:write'
```

In `Partner Billing Viewer` (`:337-348`), change `:346`:

```ts
      'contracts:read',
      'agreements:read'
```

Also update the two preset `description` strings so the role editor does not lie about what the role does:
- `Partner Billing` (`:324`): `'Full access to product catalog, quotes, invoices, contracts, and agreements'`
- `Partner Billing Viewer` (`:340`): `'Read-only access to product catalog, quotes, invoices, contracts, and agreements'`

- [ ] **Step 5: Add the catalog label.** In `apps/api/src/routes/permissionsCatalog.ts`, after `contracts: 'Contracts',` (`:32`) and `documents: 'Organization Documents',` (`:33`):

```ts
  agreements: 'Agreements',
```

- [ ] **Step 6: Run — expect GREEN.**
```bash
cd apps/api && npx vitest run src/db/seed.test.ts src/routes/permissionsCatalog.test.ts src/routes/roles.test.ts
```
`roles.test.ts` is included because `:1045-1060` `it.each`-expands over `ASSIGNABLE_PERMISSIONS`, so it silently gained two new cases from Task 1.

- [ ] **Step 7: Commit.**
```bash
git add apps/api/src/db/seed.ts apps/api/src/db/seed.test.ts apps/api/src/routes/permissionsCatalog.ts apps/api/src/routes/permissionsCatalog.test.ts
git commit -m "feat(billing): seed agreements permission rows, presets and catalog label (W02)"
```

---

### Task 3: Migration `2026-10-16-190000-agreements-permission.sql` + live-DB integration test

**Files:**
- Create: `apps/api/migrations/2026-10-16-190000-agreements-permission.sql`
- Create: `apps/api/src/__tests__/integration/agreementsPermissionMigration.integration.test.ts`
- Modify: `apps/api/src/index.ts` (one line, Step 5)

**Interfaces:**
- Produces: `permissions` rows `agreements:read`, `agreements:write`; `role_permissions` grants back-filled onto every role that already holds the equivalent `contracts:*` grant.
- Consumed by: `requirePermission` at runtime (Task 4), immediately after the guards flip.

**This is the load-bearing task of the wave.** Task 4 flips the guards with no transitional `contracts:* OR agreements:*` check (spec §4), so the back-fill is the entire no-regression story. Get it wrong and every MSP loses the template library on upgrade.

**Design decision — this migration sweeps BROADER than the PAM one it is modelled on, and the difference is deliberate.** `2026-10-15-150200-pam-dedicated-permissions.sql` matched on `r.name = 'Org Admin' AND r.scope = 'organization' AND r.is_system = TRUE`, because it was granting **new** authority nobody held before: `is_system = TRUE` was the anti-forgery filter stopping an attacker-created role merely *named* "Org Admin" from picking up PAM approval power. This migration is the opposite shape. It grants **no** new authority — it re-issues, under a new name, exactly the capability a role already holds. So it matches on the **existing grant**, never on the role's name, and covers system role templates, per-partner `is_system` clones **and custom (`is_system = FALSE`) roles alike.** Restricting it to `is_system` roles would silently strip the template library from every partner who built a custom "Billing Clerk" role — precisely the no-regression rule in spec §4. A custom role cannot be forged into extra privilege here, because the predicate *is* the privilege it already has.

**Design decision — action-for-action, no inference.** `contracts:read → agreements:read`, `contracts:write → agreements:write`. Nothing else. In particular:
- `contracts:manage` (activate/pause/resume/cancel/generate-invoices) does **not** confer `agreements:write`. Manage is a lifecycle verb on a billing contract; it says nothing about authoring legal text. Inferring write from it would grant authority a role never had, which is exactly what this migration must not do. The seeded `Partner Billing` preset holds `contracts:write` anyway, so no real role loses anything.
- `contracts:write` does **not** imply `agreements:read` by inference either — but in practice it is carried anyway, because the read back-fill's predicate is `contracts:read OR contracts:write`. That is not an inference: a holder of `contracts:write` could reach `GET /contract-templates` yesterday, since `templates.ts` gated reads on `contracts:read`… **verify this before relying on it.** `templates.ts:74` uses `readPerm` (`contracts:read`), so a write-only role could *not* list templates. Keeping `contracts:write → agreements:read` in the predicate is therefore a small, deliberate widening that makes `agreements:write` usable at all (you cannot sensibly author what you cannot list), and it is called out in the SQL comment. If the reviewer prefers strict action-for-action, drop `v_c_write_id` from the read predicate — the integration test in Step 3 asserts the chosen behaviour either way.

- [ ] **Step 1: Verify the filename still sorts last, then write the migration.**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/contact-templates
git ls-tree --name-only HEAD apps/api/migrations/ | sed 's#.*/##' \
  | grep -E '^[0-9]{4}-.*\.sql$' \
  | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);
             console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
```
Confirm the output is `2026-10-16-182600-ticket-comment-proposal-note-uq.sql` (or earlier). If a later file appeared, bump `190000` past it.

Create `apps/api/migrations/2026-10-16-190000-agreements-permission.sql`:

```sql
-- Dedicated agreements:read / agreements:write permissions for the agreement
-- template library and signed agreements, replacing the contracts:read /
-- contracts:write grants those surfaces used to ride on (agreements vocabulary
-- and IA split, spec §4). A billing contract and the MSA a customer signs are
-- different objects with different audiences: an MSP may want a technician who
-- can pull up a signed MSA without touching recurring billing, and a billing
-- clerk who runs contracts without authoring legal terms.
--
-- THE GUARDS FLIP IN THE SAME PR. routes/contracts/templates.ts and
-- documents.ts switch to AGREEMENTS_* with NO transitional
-- `contracts:* OR agreements:*` check, so the back-fill below is the ONLY
-- thing standing between an upgrade and a fleet-wide 403 on the template
-- library. It has to be exhaustive.
--
-- HOW THIS DIFFERS FROM 2026-10-15-150200-pam-dedicated-permissions.sql, the
-- file it is modelled on. That migration matched roles on
-- `r.name = 'Org Admin' AND r.scope = 'organization' AND r.is_system = TRUE`,
-- because it was GRANTING NEW AUTHORITY nobody held before (approve
-- elevations, author PAM rules): `is_system = TRUE` was the anti-forgery
-- filter stopping an attacker-created role merely NAMED "Org Admin" from
-- picking up PAM power.
--
-- This migration is the opposite shape and is deliberately BROADER. It grants
-- NO new authority: it re-issues, under a new name, exactly the capability a
-- role already holds. So it matches on the EXISTING GRANT, never on the role's
-- name, and it sweeps system role templates, per-partner is_system clones AND
-- CUSTOM (is_system = FALSE) roles alike. Scoping it to is_system roles would
-- silently strip the template library from every partner who built a custom
-- "Billing Clerk" role — exactly the no-regression rule in spec §4: nobody who
-- could reach the template library yesterday loses it today. A custom role
-- cannot be forged into extra privilege here, because the predicate IS the
-- privilege it already has.
--
-- Mapping is ACTION-FOR-ACTION. contracts:write -> agreements:write;
-- contracts:read OR contracts:write -> agreements:read. contracts:manage is
-- NOT a source for agreements:write: manage is a lifecycle verb on a billing
-- contract (activate/pause/resume/cancel/generate) and says nothing about
-- authoring legal text, so inferring write from it would grant authority the
-- role never had. contracts:write feeds the READ back-fill so that a role
-- granted agreements:write can actually list what it may edit.
--
-- WILDCARDS NEED NO BACK-FILL. Grant matching is per-axis
-- (services/permissionMatching.ts:14-23: `grant.resource === resource ||
-- grant.resource === '*'`), so the seeded Partner Admin's single '*:*' row
-- (db/seed.ts:263) already satisfies agreements:read and agreements:write at
-- runtime with no row of its own. A resource-wildcard row ('contracts','*')
-- does not exist in the registry or DEFAULT_PERMISSIONS, and routes/roles.ts:291
-- rejects any wildcard on a custom role — but the defensive third insert below
-- covers one anyway and reports loudly if it ever fires.
--
-- Idempotent: safe to re-run. permissions.id defaults to gen_random_uuid() at
-- the DB level (0001-baseline.sql), so no id is supplied on insert.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action) — only a
-- primary key on id. `ON CONFLICT DO NOTHING` would therefore have nothing to
-- conflict against and would silently insert a duplicate on every re-apply.
-- Use an explicit existence check, matching the PAM file.
--
-- NOTE: `role_permissions` DOES have PRIMARY KEY (role_id, permission_id)
-- (2026-06-20-role-permissions-unique.sql:44). The read back-fill therefore
-- needs SELECT DISTINCT: a role holding BOTH contracts:read and contracts:write
-- matches the predicate twice and would abort the migration with 23505.
--
-- Every write in this file runs under system scope: on a connection that does
-- not bypass RLS an INSERT with no scope elected aborts with 42501 (issue
-- #4518). One set_config at the top covers the whole file — is_local = true
-- scopes it to autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. The two permission rows
-- ============================================
-- Descriptions are normative (spec §4) and MUST stay byte-identical to
-- DEFAULT_PERMISSIONS in apps/api/src/db/seed.ts — a fresh install seeds from
-- there, an upgrade from here, and a divergence means two databases disagree
-- about what the permission claims to do.
DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'agreements' AND action = 'read'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('agreements', 'read', 'View agreement templates and signed agreements');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded agreements:read permission row';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'agreements' AND action = 'write'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('agreements', 'write', 'Create, edit, publish and archive agreement templates; link signed agreements');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded agreements:write permission row';
    END IF;
  END IF;
END $$;

-- ============================================
-- 2. No-regression back-fill
-- ============================================
DO $$
DECLARE
  n integer;
  v_read_id uuid;
  v_write_id uuid;
  v_contracts_read_id uuid;
  v_contracts_write_id uuid;
  v_contracts_any_id uuid;
BEGIN
  -- Scalar lookups (not JOINs) so this stays correct even if a duplicate
  -- permissions row were ever present — always resolves to exactly one id.
  SELECT id INTO v_read_id FROM permissions
  WHERE resource = 'agreements' AND action = 'read' ORDER BY id LIMIT 1;

  SELECT id INTO v_write_id FROM permissions
  WHERE resource = 'agreements' AND action = 'write' ORDER BY id LIMIT 1;

  SELECT id INTO v_contracts_read_id FROM permissions
  WHERE resource = 'contracts' AND action = 'read' ORDER BY id LIMIT 1;

  SELECT id INTO v_contracts_write_id FROM permissions
  WHERE resource = 'contracts' AND action = 'write' ORDER BY id LIMIT 1;

  -- Defensive: a resource-wildcard row. Expected to be NULL on every real
  -- database (see the header). If it is ever non-NULL the two inserts below
  -- pick it up and the row counts say so.
  SELECT id INTO v_contracts_any_id FROM permissions
  WHERE resource = 'contracts' AND action = '*' ORDER BY id LIMIT 1;

  IF v_contracts_any_id IS NOT NULL THEN
    RAISE WARNING 'unexpected contracts:* wildcard permission row present — including it in the agreements back-fill';
  END IF;

  -- 2a. contracts:write -> agreements:write.
  -- Matched on the GRANT, not the role name: system templates, per-partner
  -- is_system clones and custom roles all qualify.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_write_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_contracts_write_id, v_contracts_any_id)
    AND v_write_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_write_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 on a fresh install is expected, not
  -- evidence the INSERT silently no-op'd under RLS.
  RAISE WARNING 'granted agreements:write to % role(s) holding contracts:write', n;

  -- 2b. contracts:read OR contracts:write -> agreements:read.
  -- DISTINCT is load-bearing: role_permissions is PK (role_id, permission_id),
  -- and a role holding both source grants matches this predicate twice.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_read_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_contracts_read_id, v_contracts_write_id, v_contracts_any_id)
    AND v_read_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_read_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'granted agreements:read to % role(s) holding contracts:read or contracts:write', n;
END $$;
```

- [ ] **Step 2: Prove the RLS-scope guard baseline did not grow.**
```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```
Both must be green **without** adding this filename to the frozen baseline list in `migrationRlsScope.test.ts` — the baseline is capped at a cutoff filename and a new migration cannot be silenced by adding it (issue #4518). If `migrationRlsScope.test.ts` fails, the `SELECT set_config(...)` line is missing or is not the first statement; fix the SQL, never the baseline. `autoMigrate.test.ts` asserts every `readFileSync('../../../migrations/<file>.sql')` reference in the repo resolves — it will start covering the new integration test's path reference after Step 3.

- [ ] **Step 3: Write the live-DB integration test.** Create `apps/api/src/__tests__/integration/agreementsPermissionMigration.integration.test.ts`, copied from `pamDedicatedPermissionsMigration.integration.test.ts` and extended with a **custom-role fixture holding only `contracts:read`** — the case the PAM migration deliberately excluded and this one deliberately includes:

```ts
/**
 * Live-DB replay test for 2026-10-16-190000-agreements-permission.sql
 * (agreements vocabulary & IA split, W02). Exercises the migration file
 * directly against a real Postgres instance — not the seeded state a fresh
 * `autoMigrate` run leaves behind — covering the properties the PR promises:
 *
 *   1. agreements:read / agreements:write permission rows exist exactly once.
 *   2. Re-running the migration is a no-op (no duplicate rows or grants).
 *   3. The back-fill reaches EVERY role holding the equivalent contracts grant,
 *      matched on the GRANT and not the role name: the global system template,
 *      a per-partner is_system clone, AND a CUSTOM (is_system = FALSE) role.
 *      The custom-role case is the one the PAM migration deliberately excluded
 *      and this one deliberately includes — see the migration header.
 *   4. A role holding ONLY contracts:read receives agreements:read and NOT
 *      agreements:write (action-for-action; no inference).
 *   5. contracts:manage alone confers nothing.
 *   6. A role holding BOTH contracts:read and contracts:write does not trip the
 *      role_permissions (role_id, permission_id) primary key — the SELECT
 *      DISTINCT in the read back-fill.
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-16-190000-agreements-permission.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

// A dedicated superuser client (the role autoMigrate runs as) with onnotice
// wired so the migration's RAISE WARNING row counts can be asserted, mirroring
// pamDedicatedPermissionsMigration.integration.test.ts.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  onnotice: (n) => { notices.push(String(n.message)); },
});
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

async function replay(): Promise<string[]> {
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return [...notices];
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makePartner(name: string) {
  const [row] = await adminSql`
    insert into partners (name, slug, type, plan, status, currency_code)
    values (${name}, ${uniqueSlug('agr-mig')}, 'msp', 'free', 'active', 'USD')
    returning id
  `;
  return row!.id as string;
}

// setup.ts's per-test cleanupDatabase() TRUNCATEs `roles` (and, being the
// referencing table, `role_permissions`) between tests, so each test seeds the
// contracts permission rows and its own roles explicitly rather than relying on
// incidental seed state.
async function ensureContractPermission(action: string): Promise<string> {
  const existing = await adminSql`
    select id from permissions where resource = 'contracts' and action = ${action} order by id limit 1
  `;
  if (existing.length > 0) return existing[0]!.id as string;
  const [row] = await adminSql`
    insert into permissions (resource, action, description)
    values ('contracts', ${action}, ${`test fixture contracts:${action}`})
    returning id
  `;
  return row!.id as string;
}

async function grant(roleId: string, permissionId: string) {
  await adminSql`
    insert into role_permissions (role_id, permission_id)
    values (${roleId}, ${permissionId})
    on conflict do nothing
  `;
}

async function grantedKeys(roleId: string): Promise<string[]> {
  const rows = await adminSql`
    select p.resource || ':' || p.action as key
    from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = ${roleId}
  `;
  return rows.map((r) => r.key as string).sort();
}

describe.skipIf(!RUN)('migration: 2026-10-16-190000-agreements-permission', () => {
  it('permission rows exist exactly once for agreements:read and agreements:write', async () => {
    await replay();
    const read = await adminSql`select id from permissions where resource = 'agreements' and action = 'read'`;
    const write = await adminSql`select id from permissions where resource = 'agreements' and action = 'write'`;
    expect(read).toHaveLength(1);
    expect(write).toHaveLength(1);
  });

  it('re-running the migration is a no-op: no duplicate permission rows or grants', async () => {
    await replay(); // baseline

    const countPerms = () => adminSql`select count(*)::int as n from permissions where resource = 'agreements'`;
    const countGrants = () => adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where p.resource = 'agreements'
    `;

    const beforePerm = (await countPerms())[0]!.n;
    const beforeGrant = (await countGrants())[0]!.n;

    const msgs = await replay();

    expect((await countPerms())[0]!.n).toBe(beforePerm);
    expect((await countGrants())[0]!.n).toBe(beforeGrant);
    // A clean re-run seeds nothing new and grants nothing new. The back-fill
    // WARNINGs still fire (they always report, including 0) — assert they
    // report zero rather than asserting they are absent.
    expect(msgs.some((m) => m.startsWith('seeded agreements:'))).toBe(false);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^granted agreements:write to 0 role\(s\)/),
        expect.stringMatching(/^granted agreements:read to 0 role\(s\)/),
      ]),
    );
  });

  it('back-fills the global system template, a per-partner is_system clone, AND a custom role — matched on the grant, not the role name', async () => {
    await replay(); // ensure the permission rows exist

    const partnerId = await makePartner('Agreements Migration Backfill');
    const contractsRead = await ensureContractPermission('read');
    const contractsWrite = await ensureContractPermission('write');

    const [globalTemplate] = await adminSql`
      insert into roles (scope, name, is_system, force_mfa)
      values ('partner', 'Partner Billing', true, false) returning id
    `;
    const [clone] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Partner Billing', true, false) returning id
    `;
    // THE CASE THE PAM MIGRATION EXCLUDED AND THIS ONE INCLUDES: a custom
    // (is_system = FALSE) role built by the partner, holding ONLY
    // contracts:read. It must receive agreements:read — otherwise the partner
    // loses the template library on upgrade (spec §4 no-regression rule).
    const [custom] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Billing Clerk', false, false) returning id
    `;

    await grant(globalTemplate!.id, contractsRead);
    await grant(globalTemplate!.id, contractsWrite);
    await grant(clone!.id, contractsRead);
    await grant(clone!.id, contractsWrite);
    await grant(custom!.id, contractsRead);

    const msgs = await replay();

    for (const roleId of [globalTemplate!.id, clone!.id]) {
      expect(await grantedKeys(roleId)).toEqual(
        expect.arrayContaining(['agreements:read', 'agreements:write']),
      );
    }

    // Custom role: read only, action-for-action, no write inferred.
    const customKeys = await grantedKeys(custom!.id);
    expect(customKeys).toContain('agreements:read');
    expect(customKeys).not.toContain('agreements:write');

    expect(msgs.some((m) => /^granted agreements:write to [1-9]\d* role\(s\)/.test(m))).toBe(true);
    expect(msgs.some((m) => /^granted agreements:read to [1-9]\d* role\(s\)/.test(m))).toBe(true);
  });

  it('does not infer agreements:write from contracts:manage alone', async () => {
    await replay();

    const partnerId = await makePartner('Agreements Migration Manage Only');
    const contractsManage = await ensureContractPermission('manage');

    const [manageOnly] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Lifecycle Only', false, false) returning id
    `;
    await grant(manageOnly!.id, contractsManage);

    await replay();

    const keys = await grantedKeys(manageOnly!.id);
    expect(keys).not.toContain('agreements:read');
    expect(keys).not.toContain('agreements:write');
  });

  it('a role holding BOTH contracts:read and contracts:write does not trip the role_permissions primary key', async () => {
    // Regression guard for the SELECT DISTINCT in back-fill 2b: without it the
    // read insert emits the same (role_id, permission_id) twice and the whole
    // migration aborts with 23505 for every real Partner Billing role.
    await replay();

    const partnerId = await makePartner('Agreements Migration Both Grants');
    const contractsRead = await ensureContractPermission('read');
    const contractsWrite = await ensureContractPermission('write');

    const [both] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Full Billing', false, false) returning id
    `;
    await grant(both!.id, contractsRead);
    await grant(both!.id, contractsWrite);

    await expect(replay()).resolves.toBeDefined();

    const rows = await adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where rp.role_id = ${both!.id} and p.resource = 'agreements' and p.action = 'read'
    `;
    expect(rows[0]!.n).toBe(1);
  });
});
```

- [ ] **Step 4: Run the integration test under the per-worktree test stack.** The unit runner has no Postgres, so this must go through `vitest.integration.config.ts`, which loads `../../.env.test` — the file `pnpm test-stack up` writes.

```bash
# from the worktree root
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agreementsPermissionMigration.integration.test.ts
```
Expected first run: **RED** if the migration is wrong (the informative shapes are `23505 duplicate key value violates unique constraint "role_permissions_pkey"` = missing `DISTINCT`; `42501 new row violates row-level security policy` = missing/late `set_config`; `expected [...] to contain 'agreements:read'` on the custom role = the predicate matched on role name instead of grant). Iterate to **GREEN**, then:
```bash
# from the worktree root — nothing reaps a local stack for you
pnpm test-stack down
```
No change to `vitest.integration.config.ts` is needed: the shared `'src/__tests__/integration/**/*.test.ts'` glob already picks the file up, and `integration-suite-coverage.integration.test.ts` (which statically reads that config) is satisfied by the glob.

- [ ] **Step 5: Invalidate the permission cache on boot.** A cache **does** exist: `apps/api/src/services/permissions.ts` keeps an in-process `Map` (`permissionCache`, `:36`) with `CACHE_TTL = 5 * 60 * 1000` (`:37`), plus Redis version keys for cross-process invalidation (`:38-39`, read at `:45`, bumped at `:73`). `getUserPermissions` (`:91`) is what `requirePermission` calls (`middleware/auth.ts:874`).

The exposure this wave creates: during a rolling deploy, a replica that is already warm can serve a pre-migration `UserPermissions` for up to 5 minutes *after* the guards have flipped — a 403 on the template library for a user who does hold the back-filled grant. The exported `clearPermissionCache(userId?)` (`:265`) with no argument clears the local map **and** bumps the shared Redis global version, which every other replica re-reads on its next resolve — so one call invalidates the fleet immediately.

In `apps/api/src/index.ts`, immediately after the `await initializeDatabaseForStartup({ … });` block (`:1615-1618`) and before the `console.log('[config] Validated: …')` line (`:1619`):

```ts
  // Migrations may have changed role_permissions (W02 seeded agreements:* and
  // back-filled it onto every role holding the equivalent contracts grant), and
  // the permission resolver caches UserPermissions for CACHE_TTL = 5 minutes
  // (services/permissions.ts:36-37). A warm replica in a rolling deploy would
  // otherwise serve pre-migration grants — a 403 on a surface the operator can
  // see they have access to — until the TTL expired. Calling this with no
  // userId bumps the shared Redis version key, so every replica invalidates at
  // once rather than each aging out independently.
  await clearPermissionCache();
```
Add `clearPermissionCache` to the existing import from `./services/permissions` in `apps/api/src/index.ts` (verify whether that module is already imported there; if not, add `import { clearPermissionCache } from './services/permissions';`).

- [ ] **Step 6: Commit.**
```bash
git add apps/api/migrations/2026-10-16-190000-agreements-permission.sql \
        apps/api/src/__tests__/integration/agreementsPermissionMigration.integration.test.ts \
        apps/api/src/index.ts
git commit -m "feat(billing): agreements permission migration with no-regression back-fill (W02)"
```

---

### Task 4: Flip the API guards to `agreements:*`

**Files:**
- Modify: `apps/api/src/routes/contracts/templates.ts`
- Modify: `apps/api/src/routes/contracts/documents.ts`
- Create: `apps/api/src/routes/contracts/agreementsPermission.test.ts`

**Interfaces:**
- Produces: every route in both files now requires `agreements:read` / `agreements:write` instead of `contracts:read` / `contracts:write`. No transitional OR (spec §4 — the migration back-fill makes it unnecessary).
- Depends on: Task 1 (the registry keys) and Task 3 (the back-fill, without which this is a production outage).

**Why a new test file rather than editing the existing fixtures.** The wave brief asks to "find the grant fixture lines in `templates.test.ts` / `documents.test.ts` that grant `contracts:*` and make them grant `agreements:*`". **Those lines do not exist.** Both files mock `../../middleware/auth` with `requirePermission: () => async (_c, next) => next()` — an unconditional pass-through (`templates.test.ts:29-43`, `documents.test.ts:20-33`). The only mention of "contract perms" is a code comment. So those two suites cannot observe this change at all, in either direction, and editing them would be theatre. The negative test needs a permission-aware mock, which goes in its own file.

- [ ] **Step 1: Write the failing guard contract test.** Create `apps/api/src/routes/contracts/agreementsPermission.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Guard contract test for the agreements permission (W02, spec §4).
 *
 * templates.test.ts and documents.test.ts both mock requirePermission as an
 * unconditional pass-through, so neither can observe which permission the
 * routes actually ask for. This file mocks it as a real predicate over a
 * mutable grant set, which makes the ONE property that matters testable: the
 * agreement-template and signed-agreement routes gate on agreements:*, and a
 * caller holding contracts:* alone is refused.
 *
 * That negative is the whole point of the wave. If it ever goes green with
 * `contracts:read` in the grant set, the resources have quietly re-merged.
 */
const h = vi.hoisted(() => ({ grants: new Set<string>() }));

vi.mock('../../services/contractTemplateService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/contractTemplateService')>();
  return { ...original, listTemplates: vi.fn().mockResolvedValue([]), createTemplate: vi.fn() };
});

vi.mock('../../services/contractDocumentService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/contractDocumentService')>();
  return { ...original, listContractDocuments: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../services/sensitiveReadAudit', () => ({ auditSensitiveRead: vi.fn() }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'u1' },
      partnerId: 'p1',
      orgId: null,
      scope: 'partner',
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  // The real middleware's contract, reduced to the grant check: 403
  // 'Permission denied' when the caller lacks the exact resource:action the
  // route asked for (middleware/auth.ts:883-885).
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!h.grants.has(`${resource}:${action}`)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
    await next();
  },
}));

import { contractRoutes } from './index';

const TEMPLATES = '/contract-templates';
const DOCUMENTS = '/contract-documents';

describe('agreement surfaces gate on agreements:*, not contracts:* (W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.grants.clear();
  });

  it('GET /contract-templates allows a caller holding agreements:read', async () => {
    h.grants.add('agreements:read');
    const res = await contractRoutes.request(TEMPLATES, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  // THE REGRESSION GUARD. Before the guard flip this returns 200.
  it('GET /contract-templates 403s a caller holding contracts:read but not agreements:read', async () => {
    h.grants.add('contracts:read');
    h.grants.add('contracts:write');
    h.grants.add('contracts:manage');
    const res = await contractRoutes.request(TEMPLATES, { method: 'GET' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Permission denied' });
  });

  it('POST /contract-templates requires agreements:write, not agreements:read', async () => {
    h.grants.add('agreements:read');
    const res = await contractRoutes.request(TEMPLATES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerScope: 'partner', partnerId: 'p1', name: 'MSA' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /contract-documents allows agreements:read and 403s contracts:read', async () => {
    h.grants.add('agreements:read');
    expect((await contractRoutes.request(DOCUMENTS, { method: 'GET' })).status).toBe(200);

    h.grants.clear();
    h.grants.add('contracts:read');
    expect((await contractRoutes.request(DOCUMENTS, { method: 'GET' })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it — expect RED.**
```bash
cd apps/api && npx vitest run src/routes/contracts/agreementsPermission.test.ts
```
Expected failures: the `agreements:read` cases 403 (the routes still ask for `contracts:read`), and the negative case returns 200 (`expected 200 to be 403`) — that second one is the regression the wave exists to prevent.

- [ ] **Step 3: Flip the guards.** In `apps/api/src/routes/contracts/templates.ts`, replace `:35-36`:

```ts
// Agreement templates gate on agreements:* (W02, spec §4), NOT contracts:*.
// No transitional `contracts:* OR agreements:*` check: migration
// 2026-10-16-190000-agreements-permission.sql back-fills agreements:read/write
// onto every role that already held the equivalent contracts grant, so the
// straight swap is non-regressive on upgrade. A dual check would instead make
// the split meaningless — every contracts holder would keep reaching the
// library forever.
const readPerm = requirePermission(PERMISSIONS.AGREEMENTS_READ.resource, PERMISSIONS.AGREEMENTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.AGREEMENTS_WRITE.resource, PERMISSIONS.AGREEMENTS_WRITE.action);
```

In `apps/api/src/routes/contracts/documents.ts`, replace `:22-23` with the same two lines (shorter comment: `// Signed agreements gate on agreements:* (W02, spec §4) — see templates.ts.`).

No other line in either file changes: `readPerm` / `writePerm` are referenced by identifier at templates `:74,88,97,107,124,134,161,195,213,226` and documents `:51,62,91`.

- [ ] **Step 4: Run — expect GREEN.**
```bash
cd apps/api && npx vitest run src/routes/contracts/agreementsPermission.test.ts src/routes/contracts/templates.test.ts src/routes/contracts/documents.test.ts
```
`templates.test.ts` and `documents.test.ts` must stay green **unchanged** — their pass-through permission mocks are indifferent to which grant the route names, which is exactly why the new file was needed.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/contracts/templates.ts apps/api/src/routes/contracts/documents.ts apps/api/src/routes/contracts/agreementsPermission.test.ts
git commit -m "feat(billing): gate agreement templates and signed agreements on agreements:* (W02)"
```

---

### Task 5: Web permission gates

**Files:**
- Modify: `apps/web/src/components/organizations/record/orgRecordTabs.ts`
- Modify: `apps/web/src/components/organizations/record/orgRecordTabs.test.ts`
- Modify: `apps/web/src/components/layout/Sidebar.rbac.test.tsx`

**Interfaces:**
- Produces: `TAB_PERMISSION.billing` becomes a four-entry ANY-of array including `agreements:read`.

**Three scope decisions, each deliberate:**

1. **`Sidebar.tsx` is NOT touched.** The Contracts nav item at `:337` keeps `requiredPermission: { resource: 'contracts', action: 'read' }`. The separate **Agreements** nav item is W3 (spec §6), not this wave. Only the `PARTNER_BILLING` fixture in `Sidebar.rbac.test.tsx:43-49` changes, and only to stay a faithful mirror of the seeded preset after Task 2 — no assertion changes.

2. **`OrgBillingTab.tsx` is NOT touched.** Spec §4 mentions a `showAgreements` flag, but the Agreements section it would gate is W3 (spec §6 — "new `<details>` 'Agreements' section"). Adding a `const showAgreements = can('agreements','read')` that nothing reads would be dead code and an unused-variable lint failure. It lands in W3 with its section. `orgRecordTabs` *is* in scope because the tab's visibility rule genuinely changes now: once `agreements:read` exists as a real grant, a user holding it should be able to open the Contracts & Billing tab.

3. **`TemplatesTab.tsx` / `DocumentsTab.tsx` gain NO client-side gate.** Verified: neither component (nor `ContractsTabs.tsx`) contains `usePermissions`, `can(`, `AccessDenied` or any 403 branch — confirmed by reading their import blocks. They fetch on mount and render their `loadError` string if the request fails. So there is no existing gate to retarget from `contracts:read` to `agreements:read`, and adding a first-ever client-side gate to two components that W3 is about to move and rewrite is churn with a real cost: in W2 those tabs still sit inside `/contracts`, which is itself gated on `contracts:read` in the sidebar, and the API back-fill guarantees anyone who could open them yesterday still can. **Decision: no change in W2.** W3 adds the gate when the tabs move to `/agreements/*` and acquire their own route. Record this in the PR body so the reviewer sees it was decided and not missed.

- [ ] **Step 1: Write the failing test.** In `apps/web/src/components/organizations/record/orgRecordTabs.test.ts`, inside the existing `TAB_PERMISSION registry` describe (`:98-101`), add:

```ts
  // W02: agreements:read is a fourth way into Contracts & Billing. The tab is
  // ANY-of, so a user who can read signed agreements but holds no contracts,
  // invoices or quotes grant still has something to see there.
  it('lets agreements:read alone open Contracts & Billing', () => {
    expect(TAB_PERMISSION.billing).toEqual(
      expect.arrayContaining([{ resource: 'agreements', action: 'read' }]),
    );
  });

  // The service tab is NOT widened: deliverables are what a contract promises.
  it('leaves the Service tab on contracts:read only', () => {
    expect(TAB_PERMISSION.service).toEqual([{ resource: 'contracts', action: 'read' }]);
  });
```

- [ ] **Step 2: Run it — expect RED.**
```bash
cd apps/web && npx vitest run src/components/organizations/record/orgRecordTabs.test.ts
```
Expected failure: `expected [ {contracts:read}, {invoices:read}, {quotes:read} ] to deeply equal ... arrayContaining [ {agreements:read} ]`.

- [ ] **Step 3: Widen the billing tab.** In `apps/web/src/components/organizations/record/orgRecordTabs.ts`, change the `billing` entry (`:56-60`):

```ts
  billing: [
    { resource: 'contracts', action: 'read' },
    { resource: 'invoices', action: 'read' },
    { resource: 'quotes', action: 'read' },
    // W02: signed agreements are filed against the org and surface on this tab
    // in W3. ANY-of, so a user holding only agreements:read can reach them
    // without also being granted billing authority.
    { resource: 'agreements', action: 'read' },
  ],
```
This compiles only because Task 1 widened `PermissionResource` with `'agreements'`.

- [ ] **Step 4: Refresh the Sidebar RBAC fixture.** In `apps/web/src/components/layout/Sidebar.rbac.test.tsx`, append to `PARTNER_BILLING` (`:43-49`) so it keeps mirroring the seeded preset after Task 2:

```ts
  { resource: 'agreements', action: 'read' }, { resource: 'agreements', action: 'write' },
```
No assertion changes — the Contracts nav item still gates on `contracts:read` in W2, and this fixture exists to reproduce the real grant set, so letting it drift from the seed is the failure mode to avoid.

- [ ] **Step 5: Run — expect GREEN.**
```bash
cd apps/web && npx vitest run src/components/organizations/record/orgRecordTabs.test.ts src/components/layout/Sidebar.rbac.test.tsx src/components/organizations/record/OrgBillingTab.test.tsx
cd apps/web && npx vitest run src/lib/permissions.test.ts
```
`OrgBillingTab.test.tsx` is run to prove the untouched decision holds (it must stay green with no edit).

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/components/organizations/record/orgRecordTabs.ts apps/web/src/components/organizations/record/orgRecordTabs.test.ts apps/web/src/components/layout/Sidebar.rbac.test.tsx
git commit -m "feat(billing): let agreements:read open the org Contracts & Billing tab (W02)"
```

---

### Task 6: Docs — rewrite the Permissions section

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx`

**Interfaces:**
- Produces: a `## Permissions` section that describes `agreements:*` as distinct from `contracts:*`, and tells an upgrading operator that nothing was taken away.

There is **no API path note** in this wave — the paths did not change (quorum D4 reversal).

- [ ] **Step 1: Rewrite the paragraph.** Replace the single paragraph at `apps/docs/src/content/docs/features/contracts.mdx:217` (under the `## Permissions` heading at `:215`, above `## Related` at `:219`) with:

```mdx
Contract access is governed by role permissions: viewing requires contract read access, creating and editing requires contract write access, and lifecycle actions (activate, pause, resume, cancel) require contract management access. Service deliverables ride on the same contract permissions, and attaching evidence to a deliverable additionally needs the **Documents: write** permission (`documents:write`), because evidence is filed in the organization's document library.

The agreement template library and signed agreements have their **own** permissions, separate from contracts: **Agreements: read** (`agreements:read`) to view agreement templates and signed agreements, and **Agreements: write** (`agreements:write`) to create, edit, publish and archive templates and to link a signed agreement to a contract. There is no separate "manage" level — publishing and archiving are write actions.

Splitting them lets you grant one without the other: a technician who needs to pull up a customer's signed MSA does not need contract billing authority, and a billing clerk who runs recurring contracts does not need to author legal terms.

<Aside type="note" title="Upgrading">
  Nothing is taken away on upgrade. Any role that already held contract write access gains **Agreements: write** and **Agreements: read**; any role that held contract read access gains **Agreements: read** — including roles you created yourself. The built-in **Partner Billing** role gets both, **Partner Billing Viewer** gets read, and **Partner Admin** is unaffected (it holds everything). Review the split under **Settings → Users & Roles** if you want to tighten it.
</Aside>

Assign these through **Settings → Users & Roles**.
```

Verify `Aside` is already imported at the top of the file (it is used at `:181`); if the import is scoped differently, match the existing usage.

- [ ] **Step 2: Build the docs.**
```bash
cd apps/docs && pnpm exec astro check && pnpm build
```
(A docs-only change would route to CI's `docs-check` job, but this PR also touches code, so the full suite runs; check locally anyway.)

- [ ] **Step 3: Commit.**
```bash
git add apps/docs/src/content/docs/features/contracts.mdx
git commit -m "docs(billing): document the agreements permission split (W02)"
```

---

### Task 7: Full verification, commit and PR — **FINAL TASK, STOP AFTER THE PR IS OPEN**

**Files:** none modified (verification only).

- [ ] **Step 1: Typecheck all three packages.** Verified: `apps/api` and `apps/web` have **no** `typecheck` script (only `build`/`lint`/`test`); CI uses the two commands below (`.github/workflows/ci.yml:253,257`). `packages/shared` does have one.
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/contact-templates && pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd /Users/toddhebebrand/.herdr/worktrees/breeze/contact-templates/apps/web && pnpm exec astro check
cd /Users/toddhebebrand/.herdr/worktrees/breeze/contact-templates/packages/shared && pnpm typecheck
```

- [ ] **Step 2: Run every touched test file.**
```bash
cd packages/shared && npx vitest run src/constants/permissions.test.ts

cd apps/api && npx vitest run \
  src/db/seed.test.ts \
  src/routes/permissionsCatalog.test.ts \
  src/routes/roles.test.ts \
  src/routes/contracts/agreementsPermission.test.ts \
  src/routes/contracts/templates.test.ts \
  src/routes/contracts/documents.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/db/autoMigrate.test.ts

cd apps/web && npx vitest run \
  src/components/organizations/record/orgRecordTabs.test.ts \
  src/components/organizations/record/OrgBillingTab.test.tsx \
  src/components/layout/Sidebar.rbac.test.tsx \
  src/lib/permissions.test.ts
```
Check the reported file count on each run — vitest's path filter is a substring match, so a typo silently runs zero files and reports green.

- [ ] **Step 3: Re-run the migration integration test end to end.**
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agreementsPermissionMigration.integration.test.ts
# from the worktree root:
pnpm test-stack down
```

- [ ] **Step 4: Confirm what is deliberately NOT run.** `pnpm db:check-drift` is **not** required: the migration inserts rows into existing tables and changes no schema, so no `apps/api/src/db/schema/` file is touched and there is nothing for the drift check to compare. Say so in the PR body so a reviewer does not read its absence as an oversight.

- [ ] **Step 5: Re-verify the migration filename one last time** (origin/main may have moved since Task 3):
```bash
git fetch origin main
git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' \
  | grep -E '^[0-9]{4}-.*\.sql$' \
  | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);
             console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
bash scripts/check-migration-naming.sh --against-ref origin/main
```
If a later filename appeared, rename the migration **and** the `MIGRATION` constant in the integration test together (integration suites replay migrations by path; `autoMigrate.test.ts` catches a missed reference).

- [ ] **Step 6: Squash-review the diff, then push.**
```bash
git log --oneline origin/main..HEAD
git diff origin/main...HEAD --stat
git push -u origin feature/5822-agreements-ia/wave-5824
```

- [ ] **Step 7: Open the PR.**
```bash
gh pr create --title "feat(billing): agreements permission (W02)" --body "$(cat <<'EOF'
Closes #5824

Wave 2 of the agreements vocabulary and IA split (#5822). Gives the agreement
template library and signed agreements their own permission resource, so an MSP
can grant access to the MSA library without granting recurring-billing
authority, and vice versa.

Spec: `docs/superpowers/specs/billing/2026-09-14-agreements-vocabulary-and-ia-design.md` §4.
Plan: `docs/superpowers/plans/billing/2026-09-14-agreements-w02-permission.md`.

## What changed

- `packages/shared`: `AGREEMENTS_READ` (`agreements:read`) and `AGREEMENTS_WRITE`
  (`agreements:write`) join `PERMISSION_GRANTS`. No `manage` action — publishing
  and archiving are write actions on a template.
- API seed: both rows in `DEFAULT_PERMISSIONS`; `Partner Billing` gains
  read + write, `Partner Billing Viewer` gains read, `Org Admin` unchanged
  (templates are partner-scope in the UI today).
- `RESOURCE_LABELS.agreements = 'Agreements'` so the role editor renders a
  human label rather than the raw resource string.
- API guards: `routes/contracts/templates.ts` and `documents.ts` now require
  `agreements:read` / `agreements:write`. **No transitional
  `contracts:* OR agreements:*` check** — a dual check would make the split
  meaningless. The migration back-fill is what makes the straight swap safe.
- Web: `agreements:read` becomes a fourth ANY-of entry on the org record's
  Contracts & Billing tab.

## Migration

`apps/api/migrations/2026-10-16-190000-agreements-permission.sql`

Seeds both permission rows idempotently (explicit existence checks —
`permissions` has no unique constraint on `(resource, action)`, so
`ON CONFLICT DO NOTHING` would insert a duplicate on every re-apply), then
back-fills grants.

**Back-fill rule (spec §4 no-regression rule): nobody who could reach the
template library yesterday loses it today.**

| Role already holds | Receives |
|---|---|
| `contracts:write` | `agreements:write` **and** `agreements:read` |
| `contracts:read` | `agreements:read` |
| `contracts:manage` only | nothing (manage is a billing-lifecycle verb; inferring write from it would grant authority the role never had) |
| `*:*` | nothing — per-axis wildcard matching (`services/permissionMatching.ts:14-23`) already resolves it |

Roles are matched on **the grant they hold, not their name**, so the sweep
covers system role templates, per-partner `is_system` clones **and custom
(`is_system = FALSE`) roles**. This is deliberately broader than
`2026-10-15-150200-pam-dedicated-permissions.sql`, which it is modelled on:
that migration was granting *new* authority and used `is_system = TRUE` as an
anti-forgery filter, whereas this one re-issues authority a role already has,
so a custom role cannot be forged into extra privilege — the predicate *is*
the privilege. Scoping to `is_system` would have stripped the library from
every partner running a custom billing role.

Row counts are reported via `RAISE WARNING` (always, including zero, so a `0`
under RLS is not mistaken for evidence). System scope is elected on the first
line.

`apps/api/src/index.ts` calls `clearPermissionCache()` after
`initializeDatabaseForStartup`: the resolver caches `UserPermissions` for
5 minutes (`services/permissions.ts:36-37`), so without it a warm replica in a
rolling deploy could 403 a user who *does* hold the back-filled grant. The
no-arg call bumps the shared Redis version key, invalidating every replica at
once.

## Tests

- `packages/shared/src/constants/permissions.test.ts` — registry shape, distinct
  from contracts, exactly two actions.
- `apps/api/src/db/seed.test.ts` — both rows seeded, preset grants, Org Admin
  unchanged.
- `apps/api/src/routes/permissionsCatalog.test.ts` — the resource label (the
  catalog test already fails for any unlabelled resource).
- `apps/api/src/routes/contracts/agreementsPermission.test.ts` — **new.** The
  existing `templates.test.ts` / `documents.test.ts` mock `requirePermission` as
  an unconditional pass-through, so they cannot observe which grant the routes
  ask for; this file mocks it as a real predicate. Includes the regression
  guard: a caller holding `contracts:read` (+ write + manage) and **not**
  `agreements:read` gets 403 on `GET /contract-templates`.
- `apps/api/src/__tests__/integration/agreementsPermissionMigration.integration.test.ts`
  — **new**, live Postgres. Rows exist once; replay is a no-op; the back-fill
  reaches the global system template, a per-partner `is_system` clone **and a
  custom role holding only `contracts:read`**; `contracts:manage` alone confers
  nothing; a role holding both source grants does not trip the
  `role_permissions` primary key (the `SELECT DISTINCT` guard).
- `apps/api/src/db/migrationRlsScope.test.ts` — green with the new migration and
  **without** growing the frozen baseline.
- `apps/web` — `orgRecordTabs.test.ts`, `Sidebar.rbac.test.tsx`,
  `OrgBillingTab.test.tsx`.

## Deliberately out of scope

- **API paths are unchanged.** `/contracts/contract-templates` and
  `/contracts/contract-documents` stay as they are; the spec's §5 rename with
  aliases was dropped by advisor quorum. No `bodyLimit`, web API client, or e2e
  changes.
- **`pnpm db:check-drift` is not needed** — the migration inserts rows into
  existing tables and touches no Drizzle schema file.
- **No client-side gate added to `TemplatesTab` / `DocumentsTab`.** Neither
  component has any permission code today (verified — no `usePermissions`, no
  `can()`, no `AccessDenied`); they rely on the API. In W2 they still live under
  `/contracts`, which is sidebar-gated on `contracts:read`, and the back-fill
  guarantees nobody loses access. The gate lands in W3 when those tabs move to
  `/agreements/*` and get their own route.
- **`Sidebar.tsx` and `OrgBillingTab.tsx` unchanged.** The Agreements nav item
  and the org-record Agreements section are W3 (spec §6). Only the
  `PARTNER_BILLING` test fixture is refreshed to keep mirroring the seed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DJCyvnJ4AxP22ALPvEsFJa
EOF
)"
```

- [ ] **Step 8: STOP.** Do not merge, do not start W3. Report the PR URL.

---

## Self-review: spec §4 / §5 bullets → tasks

| Spec bullet | Task | Notes |
|---|---|---|
| §4 — `permissions.ts`: add `AGREEMENTS_READ` / `AGREEMENTS_WRITE` with the given descriptions | **T1** (keys) + **T2** (descriptions) | The registry carries no description field — verified at `permissions.ts:14`. The normative strings live in `DEFAULT_PERMISSIONS` and the migration, byte-identical. |
| §4 — no `manage` action | **T1** | Pinned by a test that asserts exactly two `AGREEMENTS_*` keys. |
| §4 — `seed.ts` `DEFAULT_PERMISSIONS`: add both rows | **T2** | |
| §4 — `Partner Billing` read+write; `Partner Billing Viewer` read; `Org Admin` unchanged | **T2** | All three asserted, including the negative for Org Admin. |
| §4 — `RESOURCE_LABELS.agreements = 'Agreements'` | **T2** | Already forced red by `permissionsCatalog.test.ts:66-71` once T1 lands. |
| §4 — migration modelled on the PAM file, sorted after the newest shipped | **T3** | `2026-10-16-190000-agreements-permission.sql`; newest shipped verified as `2026-10-16-182600-…`. |
| §4 — `set_config('breeze.scope','system',true)` first | **T3 Step 1** | Guarded by `migrationRlsScope.test.ts`; baseline must not grow (T3 Step 2). |
| §4 — idempotent inserts of the two permission rows | **T3 Step 1** | Explicit existence checks, not `ON CONFLICT` — `permissions` has no unique constraint on `(resource, action)`. |
| §4 — back-fill: `contracts:write` → `agreements:write` + `agreements:read`; `contracts:read` → `agreements:read` | **T3 Step 1** | Action-for-action. `contracts:manage` excluded by decision, with a test. |
| §4 — covers system templates, per-partner `is_system` clones **and** custom roles | **T3 Steps 1 + 3** | Matched on the grant, never the role name; called out in the SQL header as broader than the PAM file. Custom-role fixture is its own test case. |
| §4 — row counts via `RAISE WARNING` | **T3 Step 1** | `GET DIAGNOSTICS` on every insert; always reports, including 0. |
| §4 — integration test: rows once, idempotent replay, back-fill reaches a custom role with `contracts:read` | **T3 Step 3** | Plus two cases the spec did not name: `contracts:manage`-only confers nothing, and the `SELECT DISTINCT` primary-key guard. |
| §4 — guards: `templates.ts:35-36` and `documents.ts:22-23` → `AGREEMENTS_*`, no transitional OR | **T4** | Line numbers verified. |
| §4 — tests: `seed.test.ts`, shared `permissions.test.ts`, `permissionsCatalog.test.ts`, `orgRecordTabs.test.ts` | **T1, T2, T5** | All four covered. |
| §4 — test: `Sidebar.rbac.test.tsx` | **T5** | Fixture refreshed to mirror the seed; no assertion change, because `Sidebar.tsx` is untouched in W2 (the Agreements nav item is §6/W3). |
| §4 — test: `OrgBillingTab.test.tsx` | **T5 (decision: no change)** | Run unchanged as a control. `showAgreements` gates a section that does not exist until W3; adding it now is dead code. |
| §4 — web: `orgRecordTabs.ts` `TAB_PERMISSION.billing` adds `agreements:read` (ANY-of) | **T5** | |
| §4 — web: `Sidebar.tsx` item | **deferred to W3** | The spec's own §6 places the Agreements nav item in W3; the Contracts item keeps `contracts:read`. |
| §4 — web: `OrgBillingTab.tsx` gains `showAgreements` | **deferred to W3** | Ships with the section it gates (§6). |
| **§5 — API paths (`/agreement-templates`, `/signed-agreements`, aliases, `bodyLimit`, web `BASE` constants, e2e regexes)** | **no task** | **Dropped by advisor quorum (D4 reversal).** Paths stay `/contracts/contract-templates` and `/contracts/contract-documents`. Nothing in `index.ts`, `routes/contracts/index.ts`, `middleware/bodyLimit.ts`, `lib/api/contract*.ts`, `ContractDetail.documents.test.tsx` or `quote-contract-proposal.spec.ts` is touched. |
| Docs — `contracts.mdx` `## Permissions` rewritten for `agreements:*` | **T6** | Heading verified at `:215`. No API-path note (§5 dropped). |
| Permission cache invalidation | **T3 Step 5** | Cache confirmed to exist (`services/permissions.ts:36-39,73,265`, TTL 5 min). One `clearPermissionCache()` after `initializeDatabaseForStartup` (`index.ts:1615-1618`) invalidates the fleet via the shared Redis version key. |
| Wildcard grants | **T3 Step 1** | `*:*` needs no back-fill — per-axis matching at `permissionMatching.ts:14-23` resolves it at runtime. A `contracts:*` row does not exist (`seed.ts:263` is the only wildcard; `roles.ts:291` bars wildcards on custom roles), but the back-fill covers one defensively and warns loudly if it ever appears. |
