---
tracking_issue: LanternOps/breeze#5505
---

# Wave 03 — Policy-owned deployments: origin column, target resolution, dispatch, dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `software_deployments` a nullable `software_policy_id` origin FK stamped at INSERT, and teach the software remediation worker to turn an enqueued install-remediation job into a real, policy-owned, platform-correct, tenancy-checked, deduped `software_deployments` row that dispatches through the existing install seam — closing the `missing`-violation loop that W01 and W02 open.

**Architecture:** Contract D7's `software_policy_id uuid NULL REFERENCES software_policies(id) ON DELETE SET NULL` is added by migration `2026-10-15-150401`, mirrored on the Drizzle table, and threaded through `CreateSoftwareDeploymentInput` so the origin is written by the same INSERT that creates the row (never patched afterwards). A new service module `services/softwarePolicyInstallRemediation.ts` owns the three decisions that must happen **before** a deployment exists — is the rule's `catalogId` reachable from the DEVICE's tenant, does the catalog item have an install target for the DEVICE's OS, and is there already unfinished policy-owned work for this (policy, device) — and then calls `createSoftwareDeployment` for the survivors. A new `processRemediateDeviceInstall` in `jobs/softwareRemediationWorker.ts` orchestrates that per job, re-checking arming for the `install` verb the same way the uninstall path re-checks it for `uninstall`. The uninstall path is not touched at all.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS, FORCE), BullMQ, Vitest (unit + `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-09-10-desired-state-software-install-design.md` §3 (install dispatch + the `deploymentId` coupling), §4 (resolving what to install), and the "Corrections after ground-truth verification" section, which supersedes the body. Cross-wave contract: `contract-A-desired-state.md` (coordinator scratchpad), decisions **D6, D7, D8**.

**Depends on:** **W01 (#5506)** — verb-aware `evaluateSoftwarePolicyArming(policy, verb)`, the D6 audit-action constants, and `catalogId` on `SoftwarePolicyViolation['rule']`. **W02 (#5507)** — the install-remediation job payload type, the `install_remediation_*` columns on `software_compliance_status`, and `services/softwareInstallRemediationKnobs.ts`. W03 **consumes** all of those and redefines none of them.

---

## Global Constraints

Copied verbatim from the cross-wave contract. W03 may not rename or re-shape anything here.

- **Migration slot (D8):** `apps/api/migrations/2026-10-15-150401-software-deployments-policy-origin.sql`. W02 owns `…-150400-…`; W03 sorts immediately after it. **Re-run `ls apps/api/migrations/*.sql | sort | tail -1` at implementation time and rename upward if anything now sorts after this slot** — migration filenames run ahead of real time and today's date does NOT sort last. `2026-08-06` is a closed date block; never use it.
- **Column (D7), exact DDL:**
  ```sql
  software_policy_id uuid NULL REFERENCES software_policies(id) ON DELETE SET NULL
  ```
  on `software_deployments`, plus `softwarePolicyId?: string` on `CreateSoftwareDeploymentInput` (`apps/api/src/services/softwareDeployment.ts:32-71`) so the row is stamped at insert rather than patched afterwards.
- **`ON DELETE SET NULL` is load-bearing**, not style: it is what makes deleting a policy — including the cascade's own `DELETE FROM software_policies` — incapable of aborting an org or partner erasure on a 23503.
- **This is NOT a composite `(x, org_id)` FK**, so CLAUDE.md's `DEFERRABLE INITIALLY IMMEDIATE` rule (org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent/child `org_id` in separate statements) **does not apply**. Do not add `DEFERRABLE` to it.
- **Registration obligations, all in the same PR:**
  - add `software_policy_id` to the `included` bucket of the `software_deployments` entry at `apps/api/src/services/tenantExportPolicyRegistry.ts:434`. This is the one registration rule that fires on a new **column**, not just a new table.
  - re-run `tenantCascade.integration.test.ts` — ordering here comes from the pre-clear steps at `tenantCascade.ts:840-852` (org) and `:1484-1502` (partner), **not** array position, so reason about those.
  - `rls-coverage.integration.test.ts` needs **no** change: `software_deployments` is shape 1 (direct `org_id`) and auto-discovered; a new column does not change its shape.
  - `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` need **no** change: `software_deployments` has no `device_id` column and is already reached by the org cascade.
- **Non-negotiable testing gates:**
  - `tenantCascade.integration.test.ts` and `tenant-export-policy.integration.test.ts` run **ONLY** in the **Integration Tests** CI job. A locally-green unit branch proves nothing about them. W03 MUST run both explicitly, with the integration config, before opening its PR (Task 8).
  - This migration performs **no DML** (no `UPDATE`/`DELETE`/`INSERT`/`MERGE`), so no `SELECT set_config('breeze.scope','system',true);` elevation is required. Run `apps/api/src/db/migrationRlsScope.test.ts` anyway to prove the guard agrees.
  - Red-first on every behavioural change: write the assertion, watch it fail against unmodified code, then implement.
  - Scoped test runs: `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` into argv, vitest stops flag parsing there, `--run` is swallowed, and the whole 1,470-file suite runs in watch mode. Vitest's path filter is a plain **substring** match, not a glob and not a directory prefix.
- **Out of scope for W03, do not touch:** the arming helper itself (`evaluateSoftwarePolicyArming`'s body, `readSoftwarePolicyAutoInstall`, the refusal messages) — W01; the compliance worker's gate logic, the per-pass cap, the attempt counter, the knobs file, `readEarliestUnauthorizedDetection` — W02; any file under `apps/web` — W04; `aiGuardrails.ts`, `aiTools*.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts` — W05. The uninstall path in `softwareRemediationWorker.ts` (`readInFlightUninstallKeys` `:168-195`, `processRemediateDevice` `:199-599`) stays byte-identical apart from the one job-type switch in Task 7.
- **HP / EDR stay out of it:** the secret-resolution branch at `softwareDeployment.ts:554-584` fires only when `catalogItem.integrationProvider === 'huntress' | 'sentinelone'`. W03 adds no special handling for it and no new branch that reads it.

### W01/W02-owned identifiers this wave imports

The contract lets W01 and W02 fix these exact export names. **Their semantics and field sets are contract-locked; the identifiers are not.** Task 4 Step 1 and Task 6 Step 1 open the landed files and record the real names; if one differs from the expected name below, change only the import.

| Expected name | Owner | Where it lands | What W03 does with it |
|---|---|---|---|
| `evaluateSoftwarePolicyArming(policy, verb)` | W01 | `apps/api/src/services/softwarePolicyService.ts:177` | called with the literal `'install'` |
| `SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS` — `{ queued: 'install_queued', succeeded: 'install_succeeded', failed: 'install_failed', gaveUp: 'install_gave_up' } as const`, plus the union type `SoftwarePolicyInstallAuditAction` (name and member keys confirmed against W01's landed plan, Task 3) | W01 | `apps/api/src/services/softwarePolicyService.ts` | imported; W03 emits `.queued` and `.failed`. **Never a string literal at an emit site.** |
| `SoftwarePolicyViolation['rule'].catalogId` | W01 | `apps/api/src/db/schema/softwarePolicies.ts:55-60` | read off each `missing` violation |
| `RemediateDeviceInstallJobData`, discriminant `type: 'remediate-device-install'`, fields `{ policyId: string; deviceId: string }` | W02 | `apps/api/src/jobs/softwareRemediationWorker.ts` | the job payload `processRemediateDeviceInstall` accepts |
| `softwareComplianceStatus.installRemediationStatus` (`varchar(20)`), `.lastInstallRemediationAttempt` (`timestamp`) | W02 | `apps/api/src/db/schema/softwarePolicies.ts` | W03 writes `'in_progress'`, `'pending'`, `'skipped'`, `'failed'` |

W03 does **not** write `installRemediationAttempts` — that counter and the `'gave_up'` transition are W02's, and double-incrementing it would halve the effective attempt budget.

---

## 0. Ground truth

Every citation below was re-opened in this worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing`) on 2026-09-10 and quoted from the file, not copied from the spec or the contract. **All contract line numbers for W03's files were confirmed correct.** Divergences from the spec BODY (already recorded in its corrections section) are marked.

**Migration slot.** `ls apps/api/migrations/*.sql | sort | tail -1` → `apps/api/migrations/2026-10-15-150300-remote-session-revocation-lease.sql` (730 migration files total). Nothing sorts after it, so `…-150400-…` (W02) and `…-150401-…` (W03) are free and correctly ordered. **Re-confirm before writing the file.**

**`software_deployments` — `apps/api/src/db/schema/software.ts:82-116`** (contract said `:82-116` — correct). Org-only, no `partner_id`. Verbatim, the parts this wave touches:
```ts
82:export const softwareDeployments = pgTable('software_deployments', {
83:  id: uuid('id').primaryKey().defaultRandom(),
84:  orgId: uuid('org_id').notNull().references(() => organizations.id),
...
109:  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
110:  createdAt: timestamp('created_at').defaultNow().notNull()
111:}, (table) => ({
112:  orgIdx: index('software_deployments_org_id_idx').on(table.orgId),
113:  versionIdx: index('software_deployments_version_id_idx').on(table.softwareVersionId),
114:  installMethodIdx: index('software_deployments_install_method_idx').on(table.installMethodId),
115:  scheduleIdx: index('software_deployments_schedule_idx').on(table.scheduleType, table.scheduledAt)
116:}));
```
`software.ts:1-21` imports from `./orgs`, `./devices`, `./users`, `./maintenance`, `./deployments` — **not** from `./softwarePolicies`. `softwarePolicies.ts:15-17` imports `./orgs`, `./users`, `./devices` — **not** `./software`. So adding `import { softwarePolicies } from './softwarePolicies'` to `software.ts` creates a one-way edge and **no import cycle**. Verified both directions.

**The CHECK + idempotency template — `apps/api/migrations/2026-08-16-b-software-deployments-install-method.sql`** (read in full). This is the exact precedent to copy: a header comment that names the export-policy obligation in the same PR, `ADD COLUMN IF NOT EXISTS`, a `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$;` guard around the constraint, `CREATE INDEX IF NOT EXISTS`. It contains **no DML and no `set_config`** — the same shape W03's migration takes.

**`CreateSoftwareDeploymentInput` — `apps/api/src/services/softwareDeployment.ts:32-71`** (contract `:32-71` — correct). `createdBy: string | null` at `:46` is a **required, non-optional** property. The last member is `targetIds?: string[] | null;` at `:70`, closing brace `:71`.

**`createSoftwareDeployment` — `softwareDeployment.ts:974-1133`** (contract said `:974-…` — correct). The XOR guard is verbatim at `:995-1002`:
```ts
995:  // Mirrors the DB CHECK (software_deployments_one_target_chk): a deployment
996:  // targets an uploaded/URL version OR a package-manager method, never both
997:  // and never neither.
998:  if ((softwareVersionId == null) === (installMethodId == null)) {
999:    throw new Error(
1000:      'createSoftwareDeployment requires exactly one of softwareVersionId / installMethodId',
1001:    );
1002:  }
```
The destructure is `:977-993`; the INSERT `.values({…})` is `:1065-1079` (last member `dependencyFingerprint,` at `:1078`); per-device `deployment_results` rows are inserted at `:1087-1095`; the immediate-dispatch branch is `:1103-1124` and fires only when `scheduleType === 'immediate' && deploymentType === 'install' && deviceIds.length > 0`. A non-immediate call returns `{ deploymentId, deployment, status: 'pending', dispatchedDeviceIds: [], deviceResults: [] }` at `:1126-1132`.

**Platform mismatch is downstream and install-method-only — `softwareDeployment.ts:413-429`** (contract `:413-429` — correct), inside `dispatchManagerInstalls` (`:374`, correct), using `NO_INSTALL_METHOD_FOR_OS` (`:297`, correct):
```ts
413:  let osMismatchCount = 0;
414:  for (const device of targetDevices) {
415:    if (device.osType !== installMethod.platform) {
416:      await db
417:        .update(deploymentResults)
418:        .set({
419:          status: 'failed',
420:          errorMessage: `${NO_INSTALL_METHOD_FOR_OS} (${device.osType})`,
```
**Note the asymmetry, and it matters for Task 4:** this check exists only on the install-**method** path. The `software_versions` path has **no** OS check anywhere at dispatch time (`supportedOs` is written by `routes/software.ts:1109,1237-1242` and read by nothing outside routes — verified by `grep -rn supportedOs src/`). So the version branch needs its own filter or nothing filters it at all.

**EDR branch — `softwareDeployment.ts:554-584`**, reached only via `catalogItem.integrationProvider`. Untouched by this wave.

**`dispatchSoftwareInstallToDevice` — `softwareDeployment.ts:126-165`** (contract `:126-165` — correct). It only UPDATEs a `deployment_results` row that must already exist (`:151-159`); the synthetic `sw-install-<deployment>-<device>-<attempt>` id is gone (see the comment at `:110-117`) and the row id travels as `res.command.id`. This is why W03 creates a real deployment instead of inventing a new dispatch seam.

**`software_install_methods` — `software.ts:261-272`.** No `org_id`; parent-FK-join tenancy via `software_catalog`. `platform varchar(10)` is `'windows' | 'macos'` (`:264`), `kind` is `'winget' | 'homebrew_cask' | 'homebrew_formula'` (`:265`), `enabled boolean NOT NULL DEFAULT true` (`:267`), unique on `(catalog_id, platform, kind)` (`:270`). **There is no `linux` install method**, by construction.

**`software_versions` — `software.ts:49-80`.** `supportedOs: jsonb('supported_os')` at `:61`; `isLatest boolean NOT NULL DEFAULT false` at `:72` with a unique partial index `software_versions_one_latest_per_catalog_idx` on `(catalog_id) WHERE is_latest = true` at `:77-79` — so "the latest version for a catalog item" is at most one row. `platformSchema = z.enum(['windows','macos','linux'])` (`routes/software.ts:465`) and `supportedOs: z.array(platformSchema)` (`:523`), so its values line up exactly with `devices.osType`.

**`software_catalog` — `software.ts:23-47`.** Dual-axis XOR ownership: `orgId` (`:29`) / `partnerId` (`:30`), CHECK `software_catalog_one_owner_chk`, `integrationProvider varchar(20)` (`:31`). The route-layer reachability precedent is `routes/software.ts:867-870`:
```ts
867:    const scopeBranches: SQL[] = [eq(softwareCatalog.orgId, orgId), isNotNull(softwareCatalog.integrationProvider)];
868:    if (auth.scope === 'partner' && auth.partnerId) {
869:      scopeBranches.push(and(isNull(softwareCatalog.orgId), eq(softwareCatalog.partnerId, auth.partnerId))!);
870:    }
```

**`deployment_results` — `software.ts:118-136`.** `deploymentId` (`:120`) and `deviceId` (`:121`) are both NOT NULL FKs; `status: deploymentStatusEnum('status').notNull().default('pending')` at `:122`. **`deployment_results` has no `org_id` and no `created_at`.** `deploymentStatusEnum` — `apps/api/src/db/schema/deployments.ts:15-26` — is `['draft','pending','running','paused','downloading','installing','completed','failed','cancelled','rollback']`.

**`devices.osType` — `apps/api/src/db/schema/devices.ts:6,62`:** `osTypeEnum = pgEnum('os_type', ['windows','macos','linux'])`, `osType: osTypeEnum('os_type').notNull()`.

**`software_policies` — `apps/api/src/db/schema/softwarePolicies.ts:83-112`.** `orgId` (`:85`) / `partnerId` (`:86`) XOR (CHECK `software_policies_one_owner_chk`), `name varchar(200) NOT NULL` (`:87`), `mode` (`:89`), `rules jsonb NOT NULL` (`:90`), `enforceMode boolean NOT NULL DEFAULT false` (`:95`), `remediationOptions jsonb` (`:96`).

**`SoftwarePolicyRuleDefinition` — `softwarePolicies.ts:25-32`** (contract `:25-32` — correct), `catalogId?: string` at **`:30`**. The spec BODY cites `:28`; the corrections section already fixes this to `:30`. Confirmed `:30`.

**`SoftwarePolicyViolation` — `softwarePolicies.ts:48-63`** (contract `:48-63` — correct). Its `rule` sub-object at `:55-60` is `{ name; minVersion?; maxVersion?; reason? }` — **no `catalogId`**, exactly as the contract's D9 says. W01 adds it.

**The `missing` emission — `softwarePolicyService.ts:333-347`** (contract `:333-347` — correct), verbatim, showing the D9 gap:
```ts
333:    for (const rule of softwareRules) {
334:      const found = inventory.some((installed) => matchesSoftwareRule(installed, rule));
335:      if (!found) {
336:        violations.push({
337:          type: 'missing',
338:          rule: {
339:            name: rule.name,
340:            minVersion: rule.minVersion,
341:            maxVersion: rule.maxVersion,
342:          },
343:          severity: 'high',
344:          detectedAt,
345:        });
346:      }
347:    }
```

**Arming helper — `softwarePolicyService.ts:159-206`** (contract `:159`, `:161-163`, `:165-169`, `:172-175`, `:177-206` — all correct). Today `evaluateSoftwarePolicyArming(policy: SoftwarePolicyArmingInput)` takes **one** argument; W01 adds the required second `verb`. Its three refusal messages at `:184`, `:191-193`, `:200-202` all say "uninstall" verbatim. `SoftwarePolicyRemediationStatus` at `:28` is `'none' | 'pending' | 'in_progress' | 'completed' | 'failed'`. `recordSoftwarePolicyAudit` at `:533-560` takes `{ orgId, partnerId?, policyId?, deviceId?, action: string, actor: 'user'|'system'|'ai', actorId?, details? }` and throws at `:548-550` unless at least one owner axis is set.

**Remediation worker — `apps/api/src/jobs/softwareRemediationWorker.ts` (792 lines, read in full).** All contract citations confirmed:
- imports `:1-11`; `const { db } = dbModule;` `:13`; `runWithSystemDbAccess` `:14-22`; `fireAudit` `:24-28`.
- `IN_FLIGHT_LOOKBACK_MINUTES = 24 * 60` at `:36`.
- `RemediateDeviceJobData` `:56-72` — **not exported**; `SoftwareRemediationJobData = RemediateDeviceJobData` (a one-member alias, not a union) at `:74`.
- uninstall dedup `readInFlightUninstallKeys` `:168-195`, pinned to `eq(deviceCommands.type, CommandTypes.SOFTWARE_UNINSTALL)` at `:178` and `(payload ->> 'policyId') = policyId` at `:181`. **Confirmed: this cannot cover installs and must not be extended.**
- `processRemediateDevice` `:199-599`. Policy SELECT `:205-218`; device SELECT with `.for('update')` `:243-248` (the #3553 retenanting lock) selecting only `{ orgId, isEphemeral }`; ephemeral early-return `:255-262`; `auditOrgId = policy.orgId ?? deviceRow?.orgId ?? null` at **`:264`** — the dual-owner audit rule; compliance SELECT `:266-273`; arming call `evaluateSoftwarePolicyArming(policy)` at **`:318`**; unarmed refusal + compliance write `:343-390`; cooldown `:414-448`; `in_progress` write `:450-457`; queue site `:522-532`; terminal status `:545-558`.
- worker processor `:601-620`, whose body is `return runWithSystemDbAccess(async () => { return processRemediateDevice(job.data); });` at `:605-607` — **this is the single line Task 7 changes.**
- `scheduleSoftwareRemediation` `:712-792`.

**Export policy — `apps/api/src/services/tenantExportPolicyRegistry.ts:434`** (contract `:434` — correct). Verbatim, with its two-line preceding comment at `:431-433`:
```ts
434:  "software_deployments": tablePolicy("org_id", {"included":["id","org_id","name","software_version_id","install_method_id","deployment_type","target_type","schedule_type","scheduled_at","dispatched_at","maintenance_window_id","created_by","created_at"],"reviewedIncluded":["dependency_fingerprint"],"excludedSensitive":[],"excludedOpen":["target_ids","options"]}),
```
`tablePolicy` is defined at `:17-39` and **throws** on a duplicate classification (`:23-27`), so a column may appear in exactly one bucket. `maintenance_window_id` and `created_by` are the in-file precedent for classifying an FK to another tenant-owned table as `included`.

**Cascade — `apps/api/src/services/tenantCascade.ts`.** Array positions confirmed: `'software_deployments'` at **`:597`**, `'software_policies'` at **`:600`** (contract correct; the spec body's `:436`/`:439` are stale and its corrections section already says so). `CORE_ORG_CASCADE_DELETE_ORDER` is declared at `:228`. The real ordering for `deployment_results` → `software_deployments` comes from explicit pre-clear entries — org at **`:840-852`**:
```ts
840:  {
841:    table: 'deployment_results',
842:    clearSql: (orgId) => sql`
843:      DELETE FROM deployment_results
844:      WHERE deployment_id IN (SELECT id FROM software_deployments WHERE org_id = ${orgId})
845:    `,
846:  },
847:  {
848:    table: 'software_deployments',
849:    clearSql: (orgId) => sql`
850:      DELETE FROM software_deployments WHERE org_id = ${orgId}
851:    `,
852:  },
```
whose comment at `:835` states "After these pre-clears the main loop's `software_deployments` DELETE is a no-op" — i.e. **the pre-clears run before the main ordered loop.** The partner twin is at **`:1484-1502`** (`deployment_results`) and `:1503-1517+` (`software_deployments`), keyed off partner-owned `software_versions` / `software_install_methods` rather than `org_id`, with the comment at `:1475-1482` explaining they are belt-and-braces because `software_deployments.org_id` is NOT NULL.

**Cascade conclusion (stated explicitly, as required).** The new FK is safe, for two independent reasons:
1. **Ordering already holds.** `software_deployments` (`:597`) precedes `software_policies` (`:600`) in the alphabetical array, so the referencing table is deleted before the referenced one; and the org pre-clear at `:840-852` empties `software_deployments` for the tenant *before* the main loop starts, so by the time the loop reaches `software_policies` there is no same-org deployment row left to reference it. `tenantCascade.integration.test.ts`'s "FK children before parents" property is satisfied without any array edit.
2. **Ordering is not even required**, because `ON DELETE SET NULL` cannot raise 23503. This matters for the case ordering does **not** cover: a **partner-wide** policy (`org_id NULL`, `partner_id` set) is referenced by policy-owned deployments in *every* child org. Erasing ONE org deletes only that org's deployments; the partner-wide policy survives, so nothing is orphaned. Erasing the PARTNER walks each child org first, then deletes the partner-wide policies — and any deployment row that somehow outlived its org would have its `software_policy_id` nulled rather than aborting the purge. A `NO ACTION` FK (the default, and what the two sibling FKs `software_version_id` / `install_method_id` use) would have made exactly that case a latent GDPR-erasure abort.
   PostgreSQL runs referential actions in internal RI triggers as the referencing table's owner and bypasses row security for them, so the SET NULL fires even though `software_deployments` is FORCE RLS. Task 8's integration test proves this against real Postgres rather than resting on the doc claim.
**No `CORE_ORG_CASCADE_DELETE_ORDER` edit, and no new pre-clear entry, is needed.** The one registration that *is* needed is the export-policy column (Task 3).

**Test conventions.**
- `apps/api/package.json:26` `"test": "vitest"` (bare — the `--` trap applies), `:31` `"test:integration": "vitest run --config vitest.integration.config.ts"`, `:35` `"test:rls"`, `:28` `"test:docker"` (up → integration → down).
- `vitest.integration.config.ts:11` `include:` already carries the standing `src/__tests__/integration/**` glob — a new file there needs **no** config edit.
- `apps/api/src/__tests__/integration/softwareInstallMethods.integration.test.ts` (read in full) is this wave's model: `import './setup'`, `getTestDb()` for superuser seeding, `withDbAccessContext(orgCtx(id), …)` for RLS-scoped assertions, the local `orgCtx` helper at `:120-125`, `pgErrorCode`/`expectPgCode` at `:127-142`, `seedCatalog` at `:144-153`, `seedMethod` at `:155-167`, device inserts at `:499-510` (`{ orgId, siteId, agentId, hostname, osType, osVersion, architecture, agentVersion }`), and `createOrganization`/`createPartner`/`createSite` from `./db-utils`. **Case 8 of that file already covers org and partner erasure of the whole software chain** — it is the natural home for W03's cascade fixture.
- `apps/api/src/jobs/softwareRemediationWorker.test.ts` (356 lines) — mock shape at `:20-60` (`vi.hoisted` + `vi.mock('../db', …)` exposing `select`/`update`/`insert`), the `chain(result)` helper at `:68-72` whose method list is `['from','innerJoin','where','limit','orderBy','returning','values','for']`, `primeDb` at `:106-122` which serves `db.select()` results in the worker's fixed call order, `policyAuditActions()` at `:124-126`. **Crucially it keeps the REAL `evaluateSoftwarePolicyArming` (`:41-49`)** — "the whole point of the suite is that the gate itself is correct, not that a stubbed gate was consulted." W03's new cases must preserve that.
- `apps/api/src/services/softwareDeployment.test.ts:47-80` — the `softwareDeployment.ts` mock shape: `selectMock`/`insertMock`/`updateMock`, `vi.mock('../db', …)` with `runOutsideDbContext`/`withSystemDbAccessContext` pass-throughs, and a **hand-written `vi.mock('../db/schema', …)`** that stubs each table as a plain object of string column markers. Any new table or column W03 reads in that module must be added to that stub or the test throws on an undefined property.
- **Known trap (memory `drizzle_condition_deep_search_matches_enum_values_vacuous`):** a deep-search over a mocked Drizzle condition matches a pgEnum's `enumValues` array, so an assertion like "the WHERE mentions `'completed'`" passes against *unfixed* code. Assert on the **bound `Param` values** of the built condition, or assert behaviour (rows returned / not returned), never on a substring of the serialized condition.

---

## File structure

- **Create** `apps/api/migrations/2026-10-15-150401-software-deployments-policy-origin.sql` — the `software_policy_id` column, its FK and its index. DDL only.
- **Modify** `apps/api/src/db/schema/software.ts` — `softwarePolicyId` column + index on `softwareDeployments`; new import of `softwarePolicies`.
- **Modify** `apps/api/src/services/softwareDeployment.ts` — `softwarePolicyId?: string` on `CreateSoftwareDeploymentInput`, destructured and written by the existing INSERT. **No other change to this file.**
- **Modify** `apps/api/src/services/tenantExportPolicyRegistry.ts:434` — classify the new column `included`.
- **Create** `apps/api/src/services/softwarePolicyInstallRemediation.ts` — target resolution (tenancy + platform), in-flight dedup, and the policy-owned deployment entry point. One responsibility: everything that must be decided *before* a deployment row exists, plus the thin stamped call that creates one.
- **Create** `apps/api/src/services/softwarePolicyInstallRemediation.test.ts` — unit coverage for the above.
- **Modify** `apps/api/src/jobs/softwareRemediationWorker.ts` — `processRemediateDeviceInstall` + the job-type switch in the BullMQ processor. The uninstall path is untouched.
- **Modify** `apps/api/src/jobs/softwareRemediationWorker.test.ts` — new `describe` block for the install processor.
- **Modify** `apps/api/src/services/softwareDeployment.test.ts` — one case proving the origin is stamped by the INSERT.
- **Modify** `apps/api/src/__tests__/integration/softwareInstallMethods.integration.test.ts` — the live-Postgres cases: policy-owned creation, no-second-deployment, cross-tenant `catalogId` refusal, and FK `SET NULL` survival through an org cascade.

---

### Task 1: Migration — `software_deployments.software_policy_id`

**Files:**
- Create: `apps/api/migrations/2026-10-15-150401-software-deployments-policy-origin.sql`

**Interfaces:**
- Consumes: nothing. This task has no TypeScript surface.
- Produces: the `software_policy_id` column, the FK `software_deployments_software_policy_id_fkey` (`ON DELETE SET NULL`), and the index `software_deployments_software_policy_idx`. Tasks 2, 3 and 8 depend on all three existing in a live database.

- [ ] **Step 1: Re-confirm the slot is still sort-last**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
ls apps/api/migrations/*.sql | sort | tail -3
```

Expected (as of 2026-09-10): the last entry is `2026-10-15-150300-remote-session-revocation-lease.sql`, plus W02's `2026-10-15-150400-software-compliance-install-remediation.sql` if W02 has already landed. If anything sorts **after** `2026-10-15-150401`, rename this file upward (bump the time component, never the `-a-`/`-b-` infix, and never into the closed `2026-08-06` block) and use the new name everywhere below.

- [ ] **Step 2: Write the red observation**

There is no TypeScript surface to assert against, so the red step is observing the column's absence in a live database.

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c "\d software_deployments" | grep -c software_policy_id
```

Expected: `0` (and `grep` exits non-zero). If the local stack is not up, bring the test database up instead and use it for every DB step in this task:

```bash
cd apps/api && pnpm test:docker:up
docker exec -i $(docker compose -f docker-compose.test.yml ps -q postgres) psql -U breeze_test -d breeze_test -c "\d software_deployments" | grep -c software_policy_id
```

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-10-15-150401-software-deployments-policy-origin.sql
--
-- Feature #5505 (desired-state software install) W03 / #5508, cross-wave
-- contract D7. Marks a software_deployments row as created BY a software
-- policy's autoInstall remediation rather than by an operator, so:
--   * the remediation worker can dedupe in-flight policy-owned work on the
--     DEPLOYMENT row (the uninstall dedup in softwareRemediationWorker.ts:168-195
--     pins device_commands.type = software_uninstall and cannot see installs);
--   * the deployment list can label the row as policy-owned (W04).
--
-- The column is stamped by the INSERT in createSoftwareDeployment
-- (softwareDeployment.ts:1063-1080), never patched onto an existing row.
--
-- WHY ON DELETE SET NULL — this is load-bearing, not style. software_policies
-- is in CORE_ORG_CASCADE_DELETE_ORDER (tenantCascade.ts:600) and a PARTNER-WIDE
-- policy (org_id NULL, partner_id set) is referenced by policy-owned deployments
-- in EVERY child org of that partner. With the NO ACTION default that the two
-- sibling FKs (software_version_id, install_method_id) use, deleting such a
-- policy — including the cascade's own DELETE FROM software_policies — would
-- abort an org or partner erasure with 23503 the moment one deployment row
-- outlived its policy. SET NULL degrades the label instead of aborting the
-- purge. Ordering is ALSO fine on its own (software_deployments sorts before
-- software_policies at tenantCascade.ts:597 vs :600, and the org pre-clear at
-- tenantCascade.ts:840-852 empties software_deployments before the main loop
-- runs), but SET NULL is what makes the cross-org partner-wide case safe.
--
-- NOT a composite (x, org_id) FK, so CLAUDE.md's "every composite FK that
-- references an org_id column MUST be DEFERRABLE INITIALLY IMMEDIATE" rule does
-- NOT apply: org merge runs SET CONSTRAINTS ALL DEFERRED and re-points org_id
-- on parent and child in separate statements, and never touches this column.
-- Do not add DEFERRABLE.
--
-- Export policy: software_policy_id is classified 'included' (a tenant row
-- identifier, no secret material — same treatment as the existing
-- maintenance_window_id and created_by FKs on this table) in
-- CORE_TENANT_EXPORT_POLICY in this same PR. software_deployments is an
-- org-cascade table, so every one of its columns must be classified, and
-- tenant-export-policy.integration.test.ts fails on an unclassified ADD COLUMN.
--
-- RLS: software_deployments is shape 1 (direct org_id) and its policies are
-- unchanged — a new column does not change the shape, so
-- rls-coverage.integration.test.ts needs no allowlist entry.
--
-- DDL ONLY: no UPDATE / DELETE / INSERT / MERGE, so no
-- `SELECT set_config('breeze.scope','system',true);` elevation is required
-- (migrationRlsScope.test.ts only flags files that write rows).
--
-- Idempotent: IF NOT EXISTS on the column and the index, and a duplicate_object
-- guard on the constraint (the same shape as
-- 2026-08-16-b-software-deployments-install-method.sql). Re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in its own transaction.

ALTER TABLE software_deployments
  ADD COLUMN IF NOT EXISTS software_policy_id uuid;

DO $$ BEGIN
  ALTER TABLE software_deployments
    ADD CONSTRAINT software_deployments_software_policy_id_fkey
    FOREIGN KEY (software_policy_id) REFERENCES software_policies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS software_deployments_software_policy_idx
  ON software_deployments (software_policy_id);
```

- [ ] **Step 4: Apply and verify green, including idempotency**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
pnpm db:migrate   # second run must report zero newly-applied migrations
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c "\d software_deployments" | grep software_policy_id
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c \
  "SELECT confdeltype FROM pg_constraint WHERE conname = 'software_deployments_software_policy_id_fkey';"
```

Expected: the column appears; `confdeltype` is `n` (SET NULL). `a` would mean NO ACTION and the migration is wrong.

- [ ] **Step 5: Prove the RLS-scope guard is satisfied**

```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts
```

Expected: PASS. This file writes no rows, so it must not need to appear in the guard's frozen baseline. **If it fails, do not add the file to the baseline** — that baseline is frozen at 122 pre-existing offenders and #4518 forbids new entries; fix the migration instead.

- [ ] **Step 6: Prove the migration ordering guard is satisfied**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
./scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
```

Expected: both PASS. The `--against-ref origin/main` form is what the pre-push hook runs, so a slot that looked free at commit time can still fail here if `origin/main` gained a later-sorting migration; rename if it does.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-15-150401-software-deployments-policy-origin.sql
git commit -m "feat(software): add software_deployments.software_policy_id origin FK (ON DELETE SET NULL) — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
```

---

### Task 2: Drizzle schema + `CreateSoftwareDeploymentInput.softwarePolicyId`

**Files:**
- Modify: `apps/api/src/db/schema/software.ts` (import block `:1-21`; `softwareDeployments` columns after `:109`; index block `:111-116`)
- Modify: `apps/api/src/services/softwareDeployment.ts` (`CreateSoftwareDeploymentInput` `:32-71`; destructure `:977-993`; INSERT `.values` `:1065-1079`)
- Test: `apps/api/src/services/softwareDeployment.test.ts`

**Interfaces:**
- Consumes: Task 1's live column.
- Produces:
  - `softwareDeployments.softwarePolicyId` — Drizzle column, `uuid`, nullable, `onDelete: 'set null'`.
  - `CreateSoftwareDeploymentInput.softwarePolicyId?: string` — optional; when omitted the INSERT writes `null`.
  Task 4 (`createPolicyOwnedInstallDeployment`) and Task 8's integration cases depend on both. W04 reads `softwareDeployments.softwarePolicyId` off deployment rows for its label.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/softwareDeployment.test.ts`. Note the mock at `:71-80` stubs `../db/schema` by hand — extend `softwareDeployments` there with `softwarePolicyId: 'sd.softwarePolicyId'` in the same edit, or the module throws on an undefined property.

```ts
describe('createSoftwareDeployment — policy origin (#5505 W03)', () => {
  it('stamps softwarePolicyId on the INSERT, and writes null when not supplied', async () => {
    // Two calls through the same fixture: one policy-owned, one operator-made.
    const insertedValues: Array<Record<string, unknown>> = [];

    const primeCreate = () => {
      // db.select() call order inside createSoftwareDeployment:
      //   1. install method (softwareDeployment.ts:1009-1012)
      //   2. catalog item  (:1031-1039)
      const selectResults = [
        [{ id: 'im-1', catalogId: 'cat-1', platform: 'windows', kind: 'winget', packageId: 'Vendor.App', enabled: true }],
        [{ id: 'cat-1', orgId: 'org-1', name: 'App', integrationProvider: null }],
      ];
      let call = 0;
      selectMock.mockImplementation(() => chain(selectResults[Math.min(call++, selectResults.length - 1)]));
      insertMock.mockImplementation(() => ({
        values: (v: Record<string, unknown> | Array<Record<string, unknown>>) => {
          if (!Array.isArray(v)) insertedValues.push(v);
          return chain(Array.isArray(v) ? [] : [{ id: 'dep-1', ...v }]);
        },
      }));
      updateMock.mockImplementation(() => ({ set: () => chain([]) }));
    };

    primeCreate();
    await createSoftwareDeployment({
      orgId: 'org-1',
      installMethodId: 'im-1',
      deploymentType: 'install',
      deviceIds: [],                 // no devices => no dispatch branch, INSERT only
      scheduleType: 'scheduled',
      createdBy: null,
      softwarePolicyId: 'pol-1',
    });

    primeCreate();
    await createSoftwareDeployment({
      orgId: 'org-1',
      installMethodId: 'im-1',
      deploymentType: 'install',
      deviceIds: [],
      scheduleType: 'scheduled',
      createdBy: null,
    });

    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[0]!.softwarePolicyId).toBe('pol-1');
    // Explicit null, not undefined: an undefined would let the column default,
    // which is the same value here but a different contract.
    expect(insertedValues[1]!.softwarePolicyId).toBeNull();
  });
});
```

If `chain` is not already a helper in this file, add the same shape the worker suite uses:

```ts
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'returning', 'values', 'for']) p[m] = () => p;
  return p;
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwareDeployment.test.ts -t "policy origin"
```

Expected: FAIL — TypeScript rejects `softwarePolicyId` as not assignable to `CreateSoftwareDeploymentInput`, and at runtime `insertedValues[0].softwarePolicyId` is `undefined`.

- [ ] **Step 3: Add the Drizzle column**

In `apps/api/src/db/schema/software.ts`, add to the import block (after the `./deployments` import at `:21`):

```ts
import { softwarePolicies } from './softwarePolicies';
```

`softwarePolicies.ts` does not import `./software`, so this edge introduces no cycle — verified.

Then insert between `dispatchedAt` (`:109`) and `createdAt` (`:110`):

```ts
  // #5505 W03 (contract D7): set when this deployment was created BY a software
  // policy's autoInstall remediation rather than by an operator. Stamped by the
  // INSERT in createSoftwareDeployment, never patched afterwards. ON DELETE SET
  // NULL (migration 2026-10-15-150401) is load-bearing: a partner-wide policy is
  // referenced by deployments in every child org, so a NO ACTION FK would abort
  // an org or partner erasure with 23503. The remediation worker dedupes
  // in-flight policy-owned work on this column.
  softwarePolicyId: uuid('software_policy_id').references(() => softwarePolicies.id, { onDelete: 'set null' }),
```

And add to the index block, after `installMethodIdx` (`:114`):

```ts
  softwarePolicyIdx: index('software_deployments_software_policy_idx').on(table.softwarePolicyId),
```

- [ ] **Step 4: Thread it through `CreateSoftwareDeploymentInput`**

In `apps/api/src/services/softwareDeployment.ts`, append to the interface (after `targetIds?: string[] | null;` at `:70`):

```ts
  /**
   * #5505 W03: the software policy whose autoInstall remediation produced this
   * deployment. Set ONLY by services/softwarePolicyInstallRemediation.ts —
   * HTTP callers never pass it, because an operator-created deployment is not
   * policy-owned. Stamped by this function's INSERT so the origin is durable
   * from the first moment the row exists (the remediation worker's dedup reads
   * it on the very next pass, 15 minutes later).
   */
  softwarePolicyId?: string;
```

Add `softwarePolicyId,` to the destructure at `:977-993` (after `targetIds,`), and add to the INSERT `.values({…})` at `:1065-1079`, after `dependencyFingerprint,`:

```ts
      softwarePolicyId: softwarePolicyId ?? null,
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd apps/api && npx vitest run src/services/softwareDeployment.test.ts
```

Expected: PASS, including every pre-existing case in the file (the new column must not disturb them).

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: no errors. There is no root `typecheck` script.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/software.ts apps/api/src/services/softwareDeployment.ts apps/api/src/services/softwareDeployment.test.ts
git commit -m "feat(software): stamp softwarePolicyId at deployment INSERT — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
```

---

### Task 3: Export-policy registration for the new column

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:431-434`

**Interfaces:**
- Consumes: Task 1's live column (the contract test reads `information_schema` for every column of every org-cascade table).
- Produces: nothing importable. It satisfies `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts`.

This is the registration CLAUDE.md records as having shipped or blocked CI five times with code review catching it 0/5 and contract tests 5/5. **It is a mechanical edit, not a judgement call.**

- [ ] **Step 1: Confirm the failing state is real, not assumed**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n 'software_policy_id' apps/api/src/services/tenantExportPolicyRegistry.ts
```

Expected: no output — the column is unclassified. That is the red state; the contract test that observes it needs a live DB and runs in Task 8.

- [ ] **Step 2: Classify the column `included`**

Replace line `:434` (keeping the `:431-433` comment above it untouched) with the same entry plus one new member in `included`, placed after `install_method_id` so the list keeps mirroring the column order:

```ts
  "software_deployments": tablePolicy("org_id", {"included":["id","org_id","name","software_version_id","install_method_id","software_policy_id","deployment_type","target_type","schedule_type","scheduled_at","dispatched_at","maintenance_window_id","created_by","created_at"],"reviewedIncluded":["dependency_fingerprint"],"excludedSensitive":[],"excludedOpen":["target_ids","options"]}),
```

Rationale for `included`, for the reviewer: `software_policy_id` is a plain uuid FK to another tenant-owned table — exactly the shape of `maintenance_window_id` and `created_by` already in this list. It matches nothing in `SUSPICIOUS_NAME_PARTS` (no password/hash/token/secret/credential/refresh substring), so it does not belong in `reviewedIncluded`. It is not credential, private-key or verifier material, so not `excludedSensitive`. It is `uuid`, not `json`/`jsonb`/`bytea`, so the `excludedOpen` open-container rule does not reach it.

- [ ] **Step 3: Prove the registry still builds and rejects nothing**

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicy.test.ts src/services/tenantExportPolicyRegistry.test.ts
```

Expected: PASS. (If neither file exists, this step is `pnpm --filter @breeze/api exec tsc --noEmit` only — `tablePolicy` throws at module load on a duplicate classification, so a typo surfaces the moment the module is imported by anything.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "chore(tenancy): classify software_deployments.software_policy_id as included — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
```

---

### Task 4: `softwarePolicyInstallRemediation.ts` — tenancy-checked, platform-aware target resolution

**Files:**
- Create: `apps/api/src/services/softwarePolicyInstallRemediation.ts`
- Test: `apps/api/src/services/softwarePolicyInstallRemediation.test.ts`

**Interfaces:**
- Consumes: `softwareCatalog`, `softwareInstallMethods`, `softwareVersions` from `../db/schema`; `db` from `../db`. Nothing from W01 or W02.
- Produces (Task 5 extends this file; Task 6 imports all of it):
  ```ts
  export type PolicyInstallSkipReason =
    | 'no_catalog_id'
    | 'catalog_item_not_reachable'
    | 'no_install_target_for_platform';

  export type PolicyInstallTarget =
    | { kind: 'install_method'; catalogId: string; installMethodId: string }
    | { kind: 'version'; catalogId: string; softwareVersionId: string };

  export type PolicyInstallTargetResolution =
    | { ok: true; target: PolicyInstallTarget }
    | { ok: false; reason: PolicyInstallSkipReason };

  export function resolvePolicyInstallTarget(input: {
    catalogId: string | null | undefined;
    deviceOrgId: string;
    deviceOsType: string;
  }): Promise<PolicyInstallTargetResolution>;
  ```

- [ ] **Step 1: Record the W01/W02 identifier names before writing anything**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n "export function evaluateSoftwarePolicyArming" -A 4 apps/api/src/services/softwarePolicyService.ts
grep -n "install_queued\|install_failed" apps/api/src/services/softwarePolicyService.ts
grep -n "catalogId" apps/api/src/db/schema/softwarePolicies.ts
```

Write the three real names down. Task 6 uses them. If W01 has not landed yet, stop and say so rather than inventing them — this wave cannot be finished ahead of W01.

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/services/softwarePolicyInstallRemediation.test.ts`:

```ts
/**
 * #5505 W03 — what must be decided BEFORE a policy-owned deployment row exists.
 *
 * The tenancy case is the sharp one. This module runs inside the remediation
 * worker's SYSTEM db context (softwareRemediationWorker.ts:14-22), where
 * breeze_has_org_access short-circuits true and RLS scopes nothing. A rule's
 * catalogId is operator-authored jsonb inside software_policies.rules, so
 * without an explicit ownership predicate a policy could name ANOTHER tenant's
 * catalog item and install that tenant's uploaded binary onto these machines.
 * The WHERE clause IS the entire guard here; there is no second line of defence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a) },
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import { resolvePolicyInstallTarget } from './softwarePolicyInstallRemediation';

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'returning', 'values', 'for']) p[m] = () => p;
  return p;
}

/** Serves db.select() in this module's fixed order: catalog -> method -> version. */
function primeSelects(...results: unknown[][]) {
  let call = 0;
  selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)] ?? []));
}

const CATALOG_ROW = { id: 'cat-1', orgId: 'org-1', partnerId: null, integrationProvider: null };

beforeEach(() => vi.clearAllMocks());

describe('resolvePolicyInstallTarget', () => {
  it('refuses a rule with no catalogId without touching the database', async () => {
    primeSelects([]);
    const result = await resolvePolicyInstallTarget({
      catalogId: undefined,
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({ ok: false, reason: 'no_catalog_id' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('refuses a catalogId the device tenant cannot reach', async () => {
    // The ownership predicate filters it out, so the catalog SELECT returns [].
    primeSelects([]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-from-another-tenant',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({ ok: false, reason: 'catalog_item_not_reachable' });
  });

  it('prefers an enabled install method matching the device OS', async () => {
    primeSelects([CATALOG_ROW], [{ id: 'im-win' }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({
      ok: true,
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-win' },
    });
  });

  it('falls back to the latest version when no install method matches the OS', async () => {
    primeSelects([CATALOG_ROW], [], [{ id: 'sv-1', supportedOs: ['windows'] }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({
      ok: true,
      target: { kind: 'version', catalogId: 'cat-1', softwareVersionId: 'sv-1' },
    });
  });

  it('treats a null/empty supportedOs as unrestricted', async () => {
    primeSelects([CATALOG_ROW], [], [{ id: 'sv-1', supportedOs: null }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'linux',
    });
    expect(result).toMatchObject({ ok: true, target: { kind: 'version', softwareVersionId: 'sv-1' } });
  });

  it('refuses when the only version declares a different OS — the cross-platform loop guard', async () => {
    // Without this the worker would create a guaranteed-failing deployment
    // every 15 minutes for every macOS device under a Windows-only policy.
    primeSelects([CATALOG_ROW], [], [{ id: 'sv-1', supportedOs: ['windows'] }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'macos',
    });
    expect(result).toEqual({ ok: false, reason: 'no_install_target_for_platform' });
  });

  it('refuses a linux device with no version row — there is no linux install method by construction', async () => {
    primeSelects([CATALOG_ROW], [], []);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'linux',
    });
    expect(result).toEqual({ ok: false, reason: 'no_install_target_for_platform' });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyInstallRemediation.test.ts
```

Expected: FAIL — `Failed to resolve import "./softwarePolicyInstallRemediation"`.

- [ ] **Step 4: Implement**

Create `apps/api/src/services/softwarePolicyInstallRemediation.ts`:

```ts
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  softwareCatalog,
  softwareInstallMethods,
  softwareVersions,
} from '../db/schema';

/**
 * #5505 W03 — everything that must be decided BEFORE a policy-owned
 * software_deployments row exists.
 *
 * The whole module runs inside the software remediation worker's SYSTEM db
 * context (softwareRemediationWorker.ts:14-22), where breeze_has_org_access
 * short-circuits true and RLS scopes nothing. Every predicate below is
 * therefore load-bearing on its own: a rule's catalogId is operator-authored
 * jsonb living in software_policies.rules, and nothing else checks it.
 */

/** Why a (policy, device, rule) triple produced no install deployment. */
export type PolicyInstallSkipReason =
  /** The rule can be DETECTED as missing but names nothing to install. */
  | 'no_catalog_id'
  /** The catalogId does not resolve to an item this device's tenant may use. */
  | 'catalog_item_not_reachable'
  /** Reachable item, but nothing installable on this device's OS. */
  | 'no_install_target_for_platform';

export type PolicyInstallTarget =
  | { kind: 'install_method'; catalogId: string; installMethodId: string }
  | { kind: 'version'; catalogId: string; softwareVersionId: string };

export type PolicyInstallTargetResolution =
  | { ok: true; target: PolicyInstallTarget }
  | { ok: false; reason: PolicyInstallSkipReason };

/**
 * software_install_methods.platform is 'windows' | 'macos' only
 * (db/schema/software.ts:264) — there is no linux install method by
 * construction, so a linux device can only ever be served by a version row.
 */
const INSTALL_METHOD_PLATFORM_BY_OS_TYPE: Readonly<Record<string, 'windows' | 'macos'>> = {
  windows: 'windows',
  macos: 'macos',
};

/**
 * `supported_os` is an optional array of the same three values as
 * devices.os_type (routes/software.ts:465,523). Null, non-array or empty means
 * the uploader declared no restriction, which stays permissive — this filter
 * may only ever narrow what an operator already allowed, never widen it.
 */
function versionSupportsOs(supportedOs: unknown, osType: string): boolean {
  if (!Array.isArray(supportedOs) || supportedOs.length === 0) return true;
  return supportedOs.some((value) => typeof value === 'string' && value === osType);
}

/**
 * Resolve a catalog item the DEVICE's tenant is actually entitled to install.
 *
 * Mirrors the route-layer widening at routes/software.ts:867-870, but keyed on
 * the DEVICE's org rather than on a request's auth: an org-owned item must
 * belong to this device's org, and a partner-owned item (built-in integration
 * package or partner-wide custom package) is reachable only when this device's
 * org belongs to that partner. Anything else — including another org's item
 * under the same partner — resolves to nothing.
 */
async function readReachableCatalogItem(
  catalogId: string,
  deviceOrgId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: softwareCatalog.id })
    .from(softwareCatalog)
    .where(
      and(
        eq(softwareCatalog.id, catalogId),
        or(
          eq(softwareCatalog.orgId, deviceOrgId),
          and(
            isNull(softwareCatalog.orgId),
            sql`EXISTS (
              SELECT 1 FROM organizations o
              WHERE o.id = ${deviceOrgId}
                AND o.partner_id = ${softwareCatalog.partnerId}
            )`,
          ),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a policy rule's catalogId to exactly one deployment target for this
 * device, or say precisely why it cannot.
 *
 * Package-manager install methods win over uploaded versions when both exist:
 * a manager deploy always resolves the current package at install time, so it
 * cannot go stale the way a pinned version row can.
 *
 * The platform filter is deliberately done HERE rather than relying on
 * softwareDeployment.ts:413-429, which (a) only covers the install-method path
 * and never the version path, and (b) fires downstream, after a deployment row
 * and a failed deployment_results row already exist — which a compliance pass
 * every 15 minutes would turn into an unbounded stream of guaranteed-failing
 * deployments for every cross-platform device under the policy.
 */
export async function resolvePolicyInstallTarget(input: {
  catalogId: string | null | undefined;
  deviceOrgId: string;
  deviceOsType: string;
}): Promise<PolicyInstallTargetResolution> {
  if (!input.catalogId) {
    return { ok: false, reason: 'no_catalog_id' };
  }

  const catalogItem = await readReachableCatalogItem(input.catalogId, input.deviceOrgId);
  if (!catalogItem) {
    return { ok: false, reason: 'catalog_item_not_reachable' };
  }

  const platform = INSTALL_METHOD_PLATFORM_BY_OS_TYPE[input.deviceOsType];
  if (platform) {
    const [method] = await db
      .select({ id: softwareInstallMethods.id })
      .from(softwareInstallMethods)
      .where(
        and(
          eq(softwareInstallMethods.catalogId, catalogItem.id),
          eq(softwareInstallMethods.platform, platform),
          eq(softwareInstallMethods.enabled, true),
        ),
      )
      .limit(1);
    if (method) {
      return {
        ok: true,
        target: { kind: 'install_method', catalogId: catalogItem.id, installMethodId: method.id },
      };
    }
  }

  // At most one row can match: software_versions_one_latest_per_catalog_idx is
  // a unique partial index on (catalog_id) WHERE is_latest = true.
  const [version] = await db
    .select({ id: softwareVersions.id, supportedOs: softwareVersions.supportedOs })
    .from(softwareVersions)
    .where(
      and(eq(softwareVersions.catalogId, catalogItem.id), eq(softwareVersions.isLatest, true)),
    )
    .limit(1);

  if (!version || !versionSupportsOs(version.supportedOs, input.deviceOsType)) {
    return { ok: false, reason: 'no_install_target_for_platform' };
  }

  return {
    ok: true,
    target: { kind: 'version', catalogId: catalogItem.id, softwareVersionId: version.id },
  };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyInstallRemediation.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/softwarePolicyInstallRemediation.ts apps/api/src/services/softwarePolicyInstallRemediation.test.ts
git commit -m "feat(software): tenancy-checked, platform-aware install target resolution for policy remediation — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
```

---

### Task 5: Deployment-row dedup + the policy-owned creation entry point

**Files:**
- Modify: `apps/api/src/services/softwarePolicyInstallRemediation.ts`
- Test: `apps/api/src/services/softwarePolicyInstallRemediation.test.ts`

**Interfaces:**
- Consumes: Task 2's `softwareDeployments.softwarePolicyId` and `CreateSoftwareDeploymentInput.softwarePolicyId`; `createSoftwareDeployment` (`softwareDeployment.ts:974`); `deploymentResults`, `softwareDeployments` from `../db/schema`; Task 4's `PolicyInstallTarget`.
- Produces (Task 6 imports both):
  ```ts
  export const POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES: number;   // 24 * 60

  export function hasUnfinishedPolicyOwnedInstall(
    policyId: string,
    deviceId: string,
  ): Promise<boolean>;

  export function createPolicyOwnedInstallDeployment(input: {
    policyId: string;
    policyName: string;
    /** The DEVICE's org — never the policy's, which is NULL for partner-wide. */
    orgId: string;
    deviceId: string;
    target: PolicyInstallTarget;
  }): Promise<{ deploymentId: string; status: 'pending' | 'failed'; message?: string }>;
  ```

**Design note for the reviewer — why the dedup lives on the deployment row and what "unfinished" means.** The existing uninstall dedup (`softwareRemediationWorker.ts:168-195`) reads `device_commands` filtered to `type = software_uninstall`, so it is structurally blind to installs; the spec directs the install path to dedupe on the deployment row instead, and this does. "Unfinished" is expressed as **NOT IN a closed list of terminal statuses** rather than IN a list of live ones, so a future `deployment_status` enum member counts as *unfinished* and suppresses a duplicate install — the failure the spec calls the most likely to reach a customer. The 24-hour lookback (mirroring `IN_FLIGHT_LOOKBACK_MINUTES` at `:36`) bounds the cost of that choice: a permanently wedged result row stops blocking the policy after a day instead of forever.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/softwarePolicyInstallRemediation.test.ts`. Add `createSoftwareDeploymentMock` to the existing `vi.hoisted` block and a `vi.mock('./softwareDeployment', …)` alongside the `../db` mock at the top of the file:

```ts
const { createSoftwareDeploymentMock } = vi.hoisted(() => ({
  createSoftwareDeploymentMock: vi.fn(async (..._args: any[]) => ({
    deploymentId: 'dep-1',
    deployment: {},
    status: 'pending' as const,
    dispatchedDeviceIds: ['dev-1'],
    deviceResults: [],
  })),
}));
vi.mock('./softwareDeployment', () => ({ createSoftwareDeployment: createSoftwareDeploymentMock }));
```

and the cases:

```ts
import {
  createPolicyOwnedInstallDeployment,
  hasUnfinishedPolicyOwnedInstall,
} from './softwarePolicyInstallRemediation';

describe('hasUnfinishedPolicyOwnedInstall', () => {
  it('is true when a non-terminal policy-owned result row exists', async () => {
    primeSelects([{ id: 'dr-1' }]);
    await expect(hasUnfinishedPolicyOwnedInstall('pol-1', 'dev-1')).resolves.toBe(true);
  });

  it('is false when the join returns nothing', async () => {
    primeSelects([]);
    await expect(hasUnfinishedPolicyOwnedInstall('pol-1', 'dev-1')).resolves.toBe(false);
  });

  it('excludes exactly completed/failed/cancelled and nothing else', async () => {
    // Asserted on the CONSTANT, not on a serialized drizzle condition: a deep
    // search over a mocked condition also matches deploymentStatusEnum's own
    // enumValues array, which makes such an assertion pass against unfixed code
    // (memory: drizzle_condition_deep_search_matches_enum_values_vacuous).
    const { FINISHED_POLICY_INSTALL_RESULT_STATUSES } = await import(
      './softwarePolicyInstallRemediation'
    );
    expect([...FINISHED_POLICY_INSTALL_RESULT_STATUSES].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
    ]);
  });
});

describe('createPolicyOwnedInstallDeployment', () => {
  it('creates an immediate install stamped with the policy, under the DEVICE org, with a null actor', async () => {
    await createPolicyOwnedInstallDeployment({
      policyId: 'pol-1',
      policyName: 'Standard workstation build',
      orgId: 'device-org-1',
      deviceId: 'dev-1',
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
    });

    expect(createSoftwareDeploymentMock).toHaveBeenCalledTimes(1);
    const input = createSoftwareDeploymentMock.mock.calls[0]![0];
    expect(input).toMatchObject({
      orgId: 'device-org-1',
      installMethodId: 'im-1',
      versionMode: 'latest',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
      softwarePolicyId: 'pol-1',
      targetType: 'devices',
      targetIds: ['dev-1'],
    });
    // XOR: exactly one target field reaches createSoftwareDeployment, or its
    // guard at softwareDeployment.ts:998-1002 throws.
    expect(input.softwareVersionId).toBeUndefined();
    expect(String(input.name)).toContain('Standard workstation build');
  });

  it('passes a version target as softwareVersionId and never sets installMethodId', async () => {
    await createPolicyOwnedInstallDeployment({
      policyId: 'pol-1',
      policyName: 'P',
      orgId: 'device-org-1',
      deviceId: 'dev-1',
      target: { kind: 'version', catalogId: 'cat-1', softwareVersionId: 'sv-1' },
    });
    const input = createSoftwareDeploymentMock.mock.calls.at(-1)![0];
    expect(input.softwareVersionId).toBe('sv-1');
    expect(input.installMethodId).toBeUndefined();
    expect(input.versionMode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyInstallRemediation.test.ts
```

Expected: FAIL — `hasUnfinishedPolicyOwnedInstall`, `createPolicyOwnedInstallDeployment` and `FINISHED_POLICY_INSTALL_RESULT_STATUSES` are not exported.

- [ ] **Step 3: Implement**

Replace the import block at the top of `apps/api/src/services/softwarePolicyInstallRemediation.ts` with this (three added drizzle operators, two added tables, one new module import — `PolicyInstallTarget` is declared in this same file and needs no import):

```ts
import { and, eq, gte, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  deploymentResults,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwareVersions,
} from '../db/schema';
import { createSoftwareDeployment } from './softwareDeployment';
```

Append:

```ts
/**
 * Mirrors IN_FLIGHT_LOOKBACK_MINUTES (softwareRemediationWorker.ts:36) so both
 * verbs forget stuck work on the same horizon. Its job here is to bound the
 * cost of the deliberately conservative "unfinished" definition below: without
 * it, one permanently wedged deployment_results row would suppress every future
 * policy install for that (policy, device) pair forever.
 */
export const POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES = 24 * 60;

/**
 * The CLOSED set of deployment_status values that mean "this device is done
 * with that deployment". Deliberately a terminal list rather than a live list:
 * a deployment_status enum member added later then counts as UNFINISHED and
 * suppresses a duplicate install, which is the safe direction — the spec's
 * top-ranked customer-facing risk is an install loop, not a delayed install.
 * (deployment_status = draft|pending|running|paused|downloading|installing|
 *  completed|failed|cancelled|rollback — db/schema/deployments.ts:15-26.
 *  'rollback' is deliberately NOT terminal.)
 */
export const FINISHED_POLICY_INSTALL_RESULT_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const;

/**
 * The install-side dedup, and the reason W03 adds a column instead of reusing
 * readInFlightUninstallKeys (softwareRemediationWorker.ts:168-195): that query
 * pins device_commands.type to SOFTWARE_UNINSTALL, so it is structurally blind
 * to installs. This asks the deployment row instead — is there already
 * unfinished policy-owned work for this exact (policy, device)?
 */
export async function hasUnfinishedPolicyOwnedInstall(
  policyId: string,
  deviceId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES * 60 * 1000);
  const [row] = await db
    .select({ id: deploymentResults.id })
    .from(deploymentResults)
    .innerJoin(softwareDeployments, eq(softwareDeployments.id, deploymentResults.deploymentId))
    .where(
      and(
        eq(softwareDeployments.softwarePolicyId, policyId),
        eq(deploymentResults.deviceId, deviceId),
        notInArray(deploymentResults.status, [...FINISHED_POLICY_INSTALL_RESULT_STATUSES]),
        gte(softwareDeployments.createdAt, cutoff),
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * Create ONE policy-owned deployment for ONE device and dispatch it through the
 * existing seam.
 *
 * `orgId` is the DEVICE's org, never the policy's: a partner-wide policy has
 * org_id NULL, and every worker-created child row takes the device's org (the
 * partner-wide playbook's rule, and the same rule the audit rows follow at
 * softwareRemediationWorker.ts:264).
 *
 * `createdBy: null` is required and deliberate — createSoftwareDeployment
 * declares it non-optional (softwareDeployment.ts:46) and there is no operator
 * behind an automatic remediation. `scheduleType: 'immediate'` +
 * `deploymentType: 'install'` is what makes createSoftwareDeployment take its
 * dispatch branch (:1103) rather than leaving the row sitting for the scheduler.
 *
 * Exactly one of installMethodId / softwareVersionId is set, mirroring
 * software_deployments_one_target_chk; passing both or neither throws at
 * softwareDeployment.ts:998-1002.
 *
 * Nothing here touches the EDR secret-resolution branch
 * (softwareDeployment.ts:554-584): that fires only when the resolved catalog
 * item's integrationProvider is 'huntress' or 'sentinelone', and this path adds
 * no special handling for it either way.
 */
export async function createPolicyOwnedInstallDeployment(input: {
  policyId: string;
  policyName: string;
  orgId: string;
  deviceId: string;
  target: PolicyInstallTarget;
}): Promise<{ deploymentId: string; status: 'pending' | 'failed'; message?: string }> {
  const targetFields =
    input.target.kind === 'install_method'
      ? { installMethodId: input.target.installMethodId, versionMode: 'latest' as const }
      : { softwareVersionId: input.target.softwareVersionId };

  const result = await createSoftwareDeployment({
    orgId: input.orgId,
    ...targetFields,
    deploymentType: 'install',
    deviceIds: [input.deviceId],
    scheduleType: 'immediate',
    createdBy: null,
    // software_deployments.name is varchar(255) and software_policies.name is
    // varchar(200), so the prefixed form always fits.
    name: `Policy: ${input.policyName}`,
    targetType: 'devices',
    targetIds: [input.deviceId],
    softwarePolicyId: input.policyId,
  });

  return {
    deploymentId: result.deploymentId,
    status: result.status,
    ...(result.message ? { message: result.message } : {}),
  };
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyInstallRemediation.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/softwarePolicyInstallRemediation.ts apps/api/src/services/softwarePolicyInstallRemediation.test.ts
git commit -m "feat(software): deployment-row dedup + policy-owned deployment creation — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
```

---

### Task 6: `processRemediateDeviceInstall` in the remediation worker

**Files:**
- Modify: `apps/api/src/jobs/softwareRemediationWorker.ts` (new function after `processRemediateDevice` ends at `:599`; new imports)
- Test: `apps/api/src/jobs/softwareRemediationWorker.test.ts`

**Interfaces:**
- Consumes:
  - **W01:** `evaluateSoftwarePolicyArming(policy, 'install')`, the D6 audit-action constants (`install_queued`, `install_failed` members), `SoftwarePolicyViolation['rule'].catalogId`.
  - **W02:** `RemediateDeviceInstallJobData` (`type: 'remediate-device-install'`, `{ policyId, deviceId }`), `softwareComplianceStatus.installRemediationStatus`, `.lastInstallRemediationAttempt`.
  - **W03 Tasks 4-5:** `resolvePolicyInstallTarget`, `hasUnfinishedPolicyOwnedInstall`, `createPolicyOwnedInstallDeployment`, `PolicyInstallSkipReason`.
  - existing in-file: `db`, `fireAudit`, `recordSoftwareRemediationDecision`, `devices`, `softwareComplianceStatus`, `softwarePolicies`.
- Produces: `processRemediateDeviceInstall(data): Promise<{ policyId; deviceId; deploymentsCreated: number; skipped: number; errors: number }>` — exported for tests and used by Task 7's switch.

**Decision the contract left open, recorded here.** The dedup gate is evaluated **once, at the top of the job**. If it is clean, this pass creates **one deployment per distinct resolvable missing rule** — not one deployment total. Rationale: a `software_deployments` row carries exactly one target (the XOR CHECK), so N missing apps require N rows no matter when they are created; creating them together lets a device converge in one 15-minute cycle instead of N, while the top-of-job gate still guarantees the *next* pass queues nothing until this batch finishes. The per-device blast radius is bounded by the policy's own rule count, and the per-policy fleet blast radius is bounded by W02's per-pass cap.

- [ ] **Step 1: Confirm the W01/W02 names have landed**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n "remediate-device-install" apps/api/src/jobs/softwareRemediationWorker.ts
grep -n "installRemediationStatus\|lastInstallRemediationAttempt" apps/api/src/db/schema/softwarePolicies.ts
grep -n "install_queued" apps/api/src/services/softwarePolicyService.ts
grep -n "verb" apps/api/src/services/softwarePolicyService.ts | head -5
```

All four must return hits. Substitute the real identifiers into every snippet below; do not invent them and do not fall back to string literals for the audit actions.

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/src/jobs/softwareRemediationWorker.test.ts`. Extend the existing `vi.mock('../services/softwarePolicyService', …)` at `:41-49` to also re-export W01's audit-action constants (keep `evaluateSoftwarePolicyArming` REAL), and add a mock for the new service module:

```ts
const { resolveTargetMock, hasUnfinishedMock, createPolicyDeploymentMock } = vi.hoisted(() => ({
  resolveTargetMock: vi.fn(),
  hasUnfinishedMock: vi.fn(async () => false),
  createPolicyDeploymentMock: vi.fn(async () => ({ deploymentId: 'dep-1', status: 'pending' as const })),
}));
vi.mock('../services/softwarePolicyInstallRemediation', () => ({
  resolvePolicyInstallTarget: resolveTargetMock,
  hasUnfinishedPolicyOwnedInstall: hasUnfinishedMock,
  createPolicyOwnedInstallDeployment: createPolicyDeploymentMock,
}));
```

then the cases:

```ts
import { processRemediateDeviceInstall } from './softwareRemediationWorker';

const INSTALL_ARMED = { enforceMode: true, remediationOptions: { autoUninstall: false, autoInstall: true } };

const MISSING_COMPLIANCE = {
  id: 'cs-1',
  policyId: POLICY_ID,
  deviceId: DEVICE_ID,
  lastRemediationAttempt: null,
  violations: [{ type: 'missing', rule: { name: 'Chrome', catalogId: 'cat-1' }, severity: 'high' }],
  remediationStatus: 'none',
};

/** db.select() order for the install processor: policy -> device -> compliance. */
function primeInstallDb(policy: unknown, compliance: unknown = MISSING_COMPLIANCE) {
  const results = [[policy], [{ orgId: ORG_ID, osType: 'windows', isEphemeral: false }], [compliance]];
  let call = 0;
  selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)]));
  setSpy = vi.fn(() => chain([]));
  updateMock.mockImplementation(() => ({ set: setSpy }));
}

describe('processRemediateDeviceInstall — #5505 W03', () => {
  beforeEach(() => {
    hasUnfinishedMock.mockResolvedValue(false);
    resolveTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
    });
    createPolicyDeploymentMock.mockResolvedValue({ deploymentId: 'dep-1', status: 'pending' });
  });

  it('creates a policy-owned deployment for an armed policy and a missing violation', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.deploymentsCreated).toBe(1);
    expect(createPolicyDeploymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ policyId: POLICY_ID, deviceId: DEVICE_ID, orgId: ORG_ID }),
    );
    expect(policyAuditActions()).toContain('install_queued');
  });

  it('refuses a policy that is armed for uninstall but NOT for install', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: true } }));

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(policyAuditActions()).toContain('remediation_skipped_unarmed');
    // The refusal must land on the INSTALL column, never on the uninstall one —
    // a shared column would make a refused install look like a refused uninstall.
    const written = setSpy.mock.calls[0]![0];
    expect(written.installRemediationStatus).toBe('failed');
    expect(written.remediationStatus).toBeUndefined();
  });

  it('records skipped, not failed, for a rule with no catalogId', async () => {
    resolveTargetMock.mockResolvedValue({ ok: false, reason: 'no_catalog_id' });
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [{ type: 'missing', rule: { name: 'Chrome' }, severity: 'high' }],
    });

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.deploymentsCreated).toBe(0);
    expect(result.skipped).toBe(1);
    const written = setSpy.mock.calls.at(-1)![0];
    expect(written.installRemediationStatus).toBe('skipped');
    // "Never fail silently": the reason has to be greppable in the audit trail.
    const audit = recordPolicyAuditMock.mock.calls.at(-1)![0] as any;
    expect(JSON.stringify(audit.details)).toContain('no_catalog_id');
  });

  it('skips a platform mismatch instead of creating a guaranteed-failing deployment', async () => {
    resolveTargetMock.mockResolvedValue({ ok: false, reason: 'no_install_target_for_platform' });
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('skipped');
  });

  it('does not queue a second deployment while one is unfinished', async () => {
    hasUnfinishedMock.mockResolvedValue(true);
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).toHaveBeenCalledWith('command_deduped');
  });

  it('never installs onto an ephemeral Quick Support device', async () => {
    const results = [
      [policyRow({ mode: 'allowlist', ...INSTALL_ARMED })],
      [{ orgId: ORG_ID, osType: 'windows', isEphemeral: true }],
    ];
    let call = 0;
    selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)]));

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
  });

  it('deduplicates two rules that name the same catalogId into one deployment', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [
        { type: 'missing', rule: { name: 'Chrome', catalogId: 'cat-1' }, severity: 'high' },
        { type: 'missing', rule: { name: 'Chrome (alias)', catalogId: 'cat-1' }, severity: 'high' },
      ],
    });

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.deploymentsCreated).toBe(1);
    expect(createPolicyDeploymentMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unauthorized violations entirely — the install verb never uninstalls', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [{ type: 'unauthorized', software: { name: 'Unwanted App', version: '1.0' } }],
    });

    const result = await processRemediateDeviceInstall({
      type: 'remediate-device-install',
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
    });

    expect(result.deploymentsCreated).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/softwareRemediationWorker.test.ts -t "processRemediateDeviceInstall"
```

Expected: FAIL — `processRemediateDeviceInstall` is not exported from `./softwareRemediationWorker`.

- [ ] **Step 4: Implement**

Extend the imports at the top of `apps/api/src/jobs/softwareRemediationWorker.ts`:

```ts
import {
  evaluateSoftwarePolicyArming,
  recordSoftwarePolicyAudit,
  SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS,   // W01's D6 constants — use the landed name
} from '../services/softwarePolicyService';
import {
  createPolicyOwnedInstallDeployment,
  hasUnfinishedPolicyOwnedInstall,
  resolvePolicyInstallTarget,
  type PolicyInstallSkipReason,
  type PolicyInstallTarget,
} from '../services/softwarePolicyInstallRemediation';
```

Then append after `processRemediateDevice` ends at `:599`:

```ts
/**
 * #5505 W03 — turn one enqueued install-remediation job into policy-owned
 * software_deployments rows.
 *
 * Deliberately a SEPARATE function from processRemediateDevice rather than a
 * branch inside it: the uninstall path carries the #3553 manual-authorization
 * machinery (single-use token consume, ownership TOCTOU lock, manual override
 * of the arming gate) and none of it applies to install remediation, which has
 * no manual route in this feature. Every install job is therefore `auto` and
 * unconditionally gated — there is no override to reach.
 *
 * The arming re-check here is the same defence-in-depth as #3543 for uninstall
 * (incident #3381, 259 devices mass-uninstalled by a stale job): this worker is
 * the last hop before real software lands on a customer machine, so a policy
 * disarmed AFTER its job was enqueued, or a replayed/hand-enqueued job, must
 * not install anything.
 *
 * Exported for tests.
 */
export async function processRemediateDeviceInstall(
  data: RemediateDeviceInstallJobData,
): Promise<{
  policyId: string;
  deviceId: string;
  deploymentsCreated: number;
  skipped: number;
  errors: number;
}> {
  const nothing = {
    policyId: data.policyId,
    deviceId: data.deviceId,
    deploymentsCreated: 0,
    skipped: 0,
    errors: 0,
  };

  const [policy] = await db
    .select({
      id: softwarePolicies.id,
      orgId: softwarePolicies.orgId,
      partnerId: softwarePolicies.partnerId,
      name: softwarePolicies.name,
      isActive: softwarePolicies.isActive,
      mode: softwarePolicies.mode,
      enforceMode: softwarePolicies.enforceMode,
      remediationOptions: softwarePolicies.remediationOptions,
    })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.id, data.policyId))
    .limit(1);

  if (!policy || !policy.isActive) {
    console.warn('[SoftwareRemediationWorker] Policy not found or inactive, skipping install remediation', {
      policyId: data.policyId,
      deviceId: data.deviceId,
    });
    return nothing;
  }

  // FOR UPDATE mirrors the uninstall path (:243-248): it pins this device row
  // for the worker's system transaction so a concurrent org move cannot land
  // between reading the device's org and creating a deployment under it.
  const [deviceRow] = await db
    .select({ orgId: devices.orgId, osType: devices.osType, isEphemeral: devices.isEphemeral })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1)
    .for('update');

  // Quick Support exclusion: an ephemeral device is a stranger's personal
  // machine borrowed for one ~20-minute session. Installing software on it
  // would be strictly worse than the uninstall this same guard already blocks.
  if (!deviceRow || deviceRow.isEphemeral) {
    return nothing;
  }

  // Dual-owner audit (#2126): a per-device event under a partner-wide policy
  // (policy.orgId NULL) must carry the DEVICE's org so the org admin sees it.
  const auditOrgId = policy.orgId ?? deviceRow.orgId ?? null;

  const [compliance] = await db
    .select()
    .from(softwareComplianceStatus)
    .where(and(
      eq(softwareComplianceStatus.policyId, data.policyId),
      eq(softwareComplianceStatus.deviceId, data.deviceId),
    ))
    .limit(1);

  if (!compliance) {
    console.warn('[SoftwareRemediationWorker] Compliance record not found for install remediation', {
      policyId: data.policyId,
      deviceId: data.deviceId,
    });
    return nothing;
  }

  const arming = evaluateSoftwarePolicyArming(policy, 'install');
  if (!arming.armed) {
    console.warn('[SoftwareRemediationWorker] Policy is not armed for install, skipping remediation', {
      policyId: policy.id,
      deviceId: data.deviceId,
      reason: arming.reason,
    });
    fireAudit({
      orgId: auditOrgId,
      partnerId: policy.partnerId,
      policyId: policy.id,
      deviceId: data.deviceId,
      action: 'remediation_skipped_unarmed',
      actor: 'system',
      details: {
        policyName: policy.name,
        verb: 'install',
        reason: arming.reason,
        mode: policy.mode,
        enforceMode: policy.enforceMode,
      },
    });
    recordSoftwareRemediationDecision('policy_not_armed');
    // The INSTALL column only. Writing remediationStatus here would make a
    // refused install indistinguishable from a refused uninstall — the exact
    // ambiguity D1's separate columns exist to prevent.
    await db
      .update(softwareComplianceStatus)
      .set({ installRemediationStatus: 'failed' })
      .where(eq(softwareComplianceStatus.id, compliance.id))
      .catch((err: unknown) => {
        console.error('[SoftwareRemediationWorker] Failed to record refused install status:', err);
        captureException(err);
      });
    return nothing;
  }

  const now = new Date();

  // Dedup gate, evaluated ONCE per job: unfinished policy-owned work for this
  // (policy, device) means queue nothing at all this pass. Checked before the
  // in_progress write so a deduped pass does not churn the status column.
  if (await hasUnfinishedPolicyOwnedInstall(policy.id, data.deviceId)) {
    recordSoftwareRemediationDecision('command_deduped');
    await db
      .update(softwareComplianceStatus)
      .set({ installRemediationStatus: 'pending', lastInstallRemediationAttempt: now })
      .where(eq(softwareComplianceStatus.id, compliance.id));
    return nothing;
  }

  await db
    .update(softwareComplianceStatus)
    .set({ installRemediationStatus: 'in_progress', lastInstallRemediationAttempt: now })
    .where(eq(softwareComplianceStatus.id, compliance.id));

  try {
    // Only 'missing' violations, deduplicated by catalogId: two rules may name
    // the same catalog item, and installing it twice is never right.
    const rawViolations = Array.isArray(compliance.violations) ? compliance.violations : [];
    const missingRules: Array<{ ruleName: string; catalogId: string | undefined }> = [];
    const seenCatalogIds = new Set<string>();
    let rulesWithoutCatalogId = 0;
    for (const violation of rawViolations) {
      if (!violation || typeof violation !== 'object') continue;
      const typed = violation as {
        type?: string;
        rule?: { name?: string; catalogId?: string };
      };
      if (typed.type !== 'missing') continue;
      const catalogId = typeof typed.rule?.catalogId === 'string' ? typed.rule.catalogId : undefined;
      if (!catalogId) {
        // Detectable but not installable. Counted, never dropped silently.
        rulesWithoutCatalogId += 1;
        missingRules.push({ ruleName: typed.rule?.name ?? '(unnamed rule)', catalogId: undefined });
        continue;
      }
      if (seenCatalogIds.has(catalogId)) continue;
      seenCatalogIds.add(catalogId);
      missingRules.push({ ruleName: typed.rule?.name ?? '(unnamed rule)', catalogId });
    }
    void rulesWithoutCatalogId;

    if (missingRules.length === 0) {
      await db
        .update(softwareComplianceStatus)
        .set({ installRemediationStatus: 'completed', lastInstallRemediationAttempt: now })
        .where(eq(softwareComplianceStatus.id, compliance.id));
      recordSoftwareRemediationDecision('no_violations');
      return nothing;
    }

    const skips: Array<{ rule: string; reason: PolicyInstallSkipReason }> = [];
    const targets: Array<{ rule: string; target: PolicyInstallTarget }> = [];
    for (const rule of missingRules) {
      const resolution = await resolvePolicyInstallTarget({
        catalogId: rule.catalogId,
        deviceOrgId: deviceRow.orgId,
        deviceOsType: deviceRow.osType,
      });
      if (resolution.ok) {
        targets.push({ rule: rule.ruleName, target: resolution.target });
      } else {
        skips.push({ rule: rule.ruleName, reason: resolution.reason });
      }
    }

    const errors: Array<{ rule: string; message: string }> = [];
    const deploymentIds: string[] = [];
    for (const entry of targets) {
      try {
        const created = await createPolicyOwnedInstallDeployment({
          policyId: policy.id,
          policyName: policy.name,
          // The DEVICE's org, never the policy's — a partner-wide policy has none.
          orgId: deviceRow.orgId,
          deviceId: data.deviceId,
          target: entry.target,
        });
        deploymentIds.push(created.deploymentId);
        recordSoftwareRemediationDecision('command_queued');
      } catch (error) {
        errors.push({
          rule: entry.rule,
          message: error instanceof Error ? error.message : 'Failed to create install deployment',
        });
        recordSoftwareRemediationDecision('command_failed');
      }
    }

    const installRemediationStatus = (() => {
      if (deploymentIds.length > 0) return 'pending';
      if (errors.length > 0) return 'failed';
      return 'skipped';
    })();

    await db
      .update(softwareComplianceStatus)
      .set({ installRemediationStatus, lastInstallRemediationAttempt: now })
      .where(eq(softwareComplianceStatus.id, compliance.id));

    fireAudit({
      orgId: auditOrgId,
      partnerId: policy.partnerId,
      policyId: policy.id,
      deviceId: data.deviceId,
      action: errors.length > 0 && deploymentIds.length === 0
        ? SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS.failed
        : SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS.queued,
      actor: 'system',
      details: {
        policyName: policy.name,
        missingViolations: missingRules.length,
        deploymentsCreated: deploymentIds.length,
        deploymentIds,
        // "Skip it and say so": there is no install-errors jsonb column
        // (D1 ships only status/timestamp/attempts), so the audit row is the
        // only durable place a technician can read WHY a rule was skipped.
        skipped: skips,
        errors,
      },
    });

    return {
      policyId: data.policyId,
      deviceId: data.deviceId,
      deploymentsCreated: deploymentIds.length,
      skipped: skips.length,
      errors: errors.length,
    };
  } catch (error) {
    console.error(
      `[SoftwareRemediationWorker] Unhandled install-remediation error for device ${data.deviceId}, policy ${data.policyId}:`,
      error,
    );
    await db
      .update(softwareComplianceStatus)
      .set({ installRemediationStatus: 'failed' })
      .where(eq(softwareComplianceStatus.id, compliance.id))
      .catch((resetErr: unknown) => {
        console.error('[SoftwareRemediationWorker] Failed to reset installRemediationStatus to failed:', resetErr);
      });
    throw error;
  }
}
```

Remove the `void rulesWithoutCatalogId;` line and the local counter if the linter flags it — the `no_catalog_id` reason already reaches the audit through `skips`; the counter exists only if a reviewer wants it in `details`. Prefer deleting both.

- [ ] **Step 5: Run and watch it pass**

```bash
cd apps/api && npx vitest run src/jobs/softwareRemediationWorker.test.ts
```

Expected: PASS, including every pre-existing `#3543`/`#3553` uninstall case unchanged. If any uninstall case broke, the install path leaked into it — revert and isolate.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
pnpm lint
git add apps/api/src/jobs/softwareRemediationWorker.ts apps/api/src/jobs/softwareRemediationWorker.test.ts
git commit -m "feat(software): policy-owned install remediation in the remediation worker — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
```

---

### Task 7: Route the install job type through the BullMQ processor

**Files:**
- Modify: `apps/api/src/jobs/softwareRemediationWorker.ts:74` (the `SoftwareRemediationJobData` alias) and `:601-620` (`createSoftwareRemediationWorker`)
- Test: `apps/api/src/jobs/softwareRemediationWorker.test.ts`

**Interfaces:**
- Consumes: W02's `RemediateDeviceInstallJobData`; Task 6's `processRemediateDeviceInstall`.
- Produces: nothing importable. It is the wiring that makes an enqueued install job actually run.

- [ ] **Step 1: Write the failing test**

```ts
import { createSoftwareRemediationWorker } from './softwareRemediationWorker';

describe('createSoftwareRemediationWorker — job-type routing (#5505 W03)', () => {
  it('routes remediate-device-install to the install processor and leaves uninstall alone', async () => {
    // The bullmq mock at the top of this file replaces Worker with a class that
    // ignores its processor, so capture the processor argument directly.
    const captured: Array<(job: any) => Promise<unknown>> = [];
    const bullmq = await import('bullmq');
    const OriginalWorker = bullmq.Worker as any;
    (bullmq as any).Worker = class {
      constructor(_name: string, processor: (job: any) => Promise<unknown>) {
        captured.push(processor);
      }
      on = vi.fn();
      close = vi.fn();
    };

    createSoftwareRemediationWorker();
    (bullmq as any).Worker = OriginalWorker;

    const processor = captured[0]!;
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));
    const installResult: any = await processor({
      data: { type: 'remediate-device-install', policyId: POLICY_ID, deviceId: DEVICE_ID },
    });
    expect(installResult).toHaveProperty('deploymentsCreated');

    primeDb(policyRow({ enforceMode: false }));
    const uninstallResult: any = await processor({
      data: { type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID },
    });
    expect(uninstallResult).toHaveProperty('commandsQueued');
    expect(uninstallResult).not.toHaveProperty('deploymentsCreated');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/softwareRemediationWorker.test.ts -t "job-type routing"
```

Expected: FAIL — the processor returns a `commandsQueued` shape for the install job, because everything currently falls through to `processRemediateDevice`.

- [ ] **Step 3: Implement**

At `:74`, widen the alias — **only if W02 has not already done so**; check first, and if the union already contains the install member, leave the line untouched:

```ts
type SoftwareRemediationJobData = RemediateDeviceJobData | RemediateDeviceInstallJobData;
```

Then replace the processor body at `:605-607`:

```ts
      return runWithSystemDbAccess(async () => {
        // #5505 W03: the two verbs are separate processors. Discriminating on
        // job.data.type keeps the uninstall path (and its #3553 manual-
        // authorization machinery) byte-identical.
        if (job.data.type === 'remediate-device-install') {
          return processRemediateDeviceInstall(job.data);
        }
        return processRemediateDevice(job.data);
      });
```

- [ ] **Step 4: Run and watch it pass**

```bash
cd apps/api && npx vitest run src/jobs/softwareRemediationWorker.test.ts
```

Expected: PASS, whole file.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/jobs/softwareRemediationWorker.ts apps/api/src/jobs/softwareRemediationWorker.test.ts
git commit -m "feat(software): route remediate-device-install jobs to the install processor — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
```

---

### Task 8: Live-Postgres contract coverage and the two blocking integration suites

**Files:**
- Modify: `apps/api/src/__tests__/integration/softwareInstallMethods.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7, plus `cascadeDeleteOrg` / `cascadeDeletePartner` (already imported by this file) and `createOrganization` / `createPartner` / `createSite` from `./db-utils`.
- Produces: nothing importable. This is the wave's proof.

**Why this file and not a new one.** `softwareInstallMethods.integration.test.ts` already owns the live-Postgres contract for the whole catalog → version → install-method → deployment → deployment_result chain, including case 8 ("ORG ERASURE of the whole software chain") and the `software_deployments_one_target_chk` case. The new FK belongs beside them, and `vitest.integration.config.ts:11`'s standing `src/__tests__/integration/**` glob means no config edit either way.

- [ ] **Step 1: Bring up the integration database**

```bash
cd apps/api && pnpm test:docker:up
```

`src/__tests__/integration/setup.ts` defaults `DATABASE_URL`/`DATABASE_URL_APP` to `postgresql://breeze_test:breeze_test@localhost:5433/breeze_test`, which `docker-compose.test.yml` provisions — no override needed. `assertTestDatabaseUrlSafe` refuses any URL on port 5432 or with a non-`breeze_test*` database name, so do not point this at the dev DB.

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/src/__tests__/integration/softwareInstallMethods.integration.test.ts`, reusing its existing `orgCtx`, `expectPgCode`, `seedCatalog`, `seedMethod` helpers:

```ts
describe('software_deployments.software_policy_id — policy origin (#5505 W03)', () => {
  async function seedDevice(orgId: string, siteId: string, osType: 'windows' | 'macos' = 'windows') {
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `w03-agent-${crypto.randomUUID()}`,
        hostname: 'w03-host',
        osType,
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
      })
      .returning();
    if (!device) throw new Error('failed to seed device');
    return device;
  }

  async function seedPolicy(owner: { orgId?: string; partnerId?: string }, catalogId: string) {
    const [policy] = await getTestDb()
      .insert(softwarePolicies)
      .values({
        orgId: owner.orgId ?? null,
        partnerId: owner.partnerId ?? null,
        name: 'Standard workstation build',
        mode: 'allowlist',
        rules: { software: [{ name: 'Chrome', catalogId }] },
        enforceMode: true,
        remediationOptions: { autoInstall: true },
      })
      .returning();
    if (!policy) throw new Error('failed to seed policy');
    return policy;
  }

  it('the FK is ON DELETE SET NULL: deleting the policy nulls the column and keeps the deployment', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    // A PARTNER-WIDE policy: this is the case array ordering does not cover,
    // because such a policy is referenced from every child org.
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);

    const [deployment] = await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId: org.id,
        name: 'Policy: Standard workstation build',
        installMethodId: method.id,
        deploymentType: 'install',
        targetType: 'devices',
        scheduleType: 'immediate',
        softwarePolicyId: policy.id,
      })
      .returning();
    expect(deployment!.softwarePolicyId).toBe(policy.id);

    await getTestDb().delete(softwarePolicies).where(eq(softwarePolicies.id, policy.id));

    const [after] = await getTestDb()
      .select()
      .from(softwareDeployments)
      .where(eq(softwareDeployments.id, deployment!.id));
    // Survived, with the label degraded rather than the delete aborting.
    expect(after).toBeDefined();
    expect(after!.softwarePolicyId).toBeNull();
  });

  it('org erasure still completes with a policy-owned deployment present', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);
    const device = await seedDevice(org.id, site.id);

    const [deployment] = await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId: org.id,
        name: 'Policy: Standard workstation build',
        installMethodId: method.id,
        deploymentType: 'install',
        targetType: 'devices',
        scheduleType: 'immediate',
        softwarePolicyId: policy.id,
      })
      .returning();
    await getTestDb()
      .insert(deploymentResults)
      .values({ deploymentId: deployment!.id, deviceId: device.id, status: 'pending' });

    // Must not raise 23503. This is the contract that has caught this class of
    // mistake 5/5 times while code review caught it 0/5.
    await expect(
      cascadeDeleteOrg(org.id, { performedBy: PERFORMED_BY, performedByEmail: PERFORMED_EMAIL }),
    ).resolves.toBeDefined();

    const remaining = await getTestDb()
      .select()
      .from(softwareDeployments)
      .where(eq(softwareDeployments.id, deployment!.id));
    expect(remaining).toHaveLength(0);
  });

  it('a policy rule naming ANOTHER org\'s catalog item resolves to nothing', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const catalogB = await seedCatalog(orgB.id, 'B Chrome');
    await seedMethod(catalogB.id, 'windows', 'winget', 'Google.Chrome');

    // The worker runs in a SYSTEM context where RLS scopes nothing, so this is
    // the only thing standing between a forged catalogId and org B's package
    // landing on org A's machines.
    const resolution = await resolvePolicyInstallTarget({
      catalogId: catalogB.id,
      deviceOrgId: orgA.id,
      deviceOsType: 'windows',
    });
    expect(resolution).toEqual({ ok: false, reason: 'catalog_item_not_reachable' });
  });

  it('a partner-owned catalog item IS reachable from a child org of that partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb()
      .insert(softwareCatalog)
      .values({ orgId: null, partnerId: partner.id, name: 'Partner-wide App' })
      .returning();
    await seedMethod(catalog!.id, 'windows', 'winget', 'Partner.App');

    const resolution = await resolvePolicyInstallTarget({
      catalogId: catalog!.id,
      deviceOrgId: org.id,
      deviceOsType: 'windows',
    });
    expect(resolution).toMatchObject({ ok: true, target: { kind: 'install_method' } });
  });

  it('does not create a second policy-owned deployment while one is unfinished', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);
    const device = await seedDevice(org.id, site.id);

    const [first] = await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId: org.id,
        name: 'Policy: Standard workstation build',
        installMethodId: method.id,
        deploymentType: 'install',
        targetType: 'devices',
        scheduleType: 'immediate',
        softwarePolicyId: policy.id,
      })
      .returning();
    await getTestDb()
      .insert(deploymentResults)
      .values({ deploymentId: first!.id, deviceId: device.id, status: 'installing' });

    await expect(hasUnfinishedPolicyOwnedInstall(policy.id, device.id)).resolves.toBe(true);

    // Once the result reaches a terminal status the gate reopens.
    await getTestDb()
      .update(deploymentResults)
      .set({ status: 'completed' })
      .where(eq(deploymentResults.deploymentId, first!.id));
    await expect(hasUnfinishedPolicyOwnedInstall(policy.id, device.id)).resolves.toBe(false);
  });
});
```

Add `softwarePolicies` to the `../../db/schema` import list and
`import { hasUnfinishedPolicyOwnedInstall, resolvePolicyInstallTarget } from '../../services/softwarePolicyInstallRemediation';`
at the top of the file.

- [ ] **Step 3: Run and watch them fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/softwareInstallMethods.integration.test.ts
```

Expected before Tasks 1-5 are applied: FAIL on `column "software_policy_id" does not exist`. If Tasks 1-5 are already committed this run is green — that is fine; the red was observed at Task 1 Step 2 and Task 4 Step 3.

- [ ] **Step 4: Run the two blocking contract suites — the gate this whole task exists for**

```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

Expected: all three PASS. `tenant-export-policy` is the one that fails on an unclassified `ADD COLUMN` — if Task 3 was skipped, it fails here and nowhere else, and it will fail in **Integration Tests** on the PR. `tenantCascade` asserts alphabetisation with `organizations` last, every `org_id` table present, no non-existent table, each table exactly once, and FK children before parents.

**Do not use `pnpm test:integration -- <path>`** — the `--` makes vitest run the whole integration suite. The `npx vitest run --config … <path>` form above is the one that scopes.

- [ ] **Step 5: Run the full affected unit set**

```bash
cd apps/api && npx vitest run \
  src/services/softwarePolicyInstallRemediation.test.ts \
  src/services/softwareDeployment.test.ts \
  src/jobs/softwareRemediationWorker.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/db/autoMigrate.test.ts \
  src/config/composeBindMounts.test.ts
```

Expected: all PASS. Note the paths are listed explicitly rather than as a prefix — vitest's filter is a plain substring match and a trailing slash silently skips sibling `foo.test.ts` files.

- [ ] **Step 6: Verify schema/migration parity and lint**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
pnpm lint
pnpm --filter @breeze/api exec tsc --noEmit
```

`db:check-drift` verifies migration-ledger parity only — it cannot fail on a Drizzle-schema change alone, so a green result here is not evidence the column matches; Step 3's live inserts through the Drizzle table objects are.

- [ ] **Step 7: Merge `main` before trusting any of this**

CI tests the merge commit, not your branch head. A stale base is how a locally-green branch reddens `main`.

```bash
git fetch origin && git merge origin/main
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts
```

Re-run Step 4's suites after the merge; if `origin/main` added an org-cascade table or column in the meantime, the export-policy suite will say so.

- [ ] **Step 8: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/softwareInstallMethods.integration.test.ts
git commit -m "test(software): live-Postgres coverage for policy-owned deployments and the SET NULL origin FK — #5505 W03

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz"
git push -u origin HEAD
gh pr create --title "feat(software): policy-owned install deployments (#5505 W03)" --body "$(cat <<'EOF'
Closes #5508

W03 of feature #5505 (desired-state software install). Adds the deployment origin column and turns an enqueued install-remediation job into a real, policy-owned, tenancy-checked, platform-correct, deduped `software_deployments` row.

## What changed
- Migration `2026-10-15-150401`: `software_deployments.software_policy_id uuid NULL REFERENCES software_policies(id) ON DELETE SET NULL` + index. DDL only, no DML, no `breeze.scope` elevation needed.
- `CreateSoftwareDeploymentInput.softwarePolicyId?` — stamped by the existing INSERT, never patched afterwards.
- New `services/softwarePolicyInstallRemediation.ts`: tenancy-checked catalog resolution, platform filtering ahead of dispatch, deployment-row dedup, and the policy-owned creation entry point.
- New `processRemediateDeviceInstall` in the remediation worker + job-type routing. The uninstall path is untouched.

## Registrations (contract D7)
- `software_policy_id` added to the `included` bucket of `software_deployments` in `CORE_TENANT_EXPORT_POLICY` — the one registration rule that fires on a new COLUMN.
- **Cascade: no change needed, and here is why.** `software_deployments` (`tenantCascade.ts:597`) already precedes `software_policies` (`:600`), and the org pre-clear at `:840-852` empties `software_deployments` before the main loop starts, so child-before-parent already holds. Independently, `ON DELETE SET NULL` means the FK cannot raise 23503 at all — which is what covers the case ordering does not: a partner-wide policy referenced by deployments in every child org. Proven live in `softwareInstallMethods.integration.test.ts`.
- Not a composite `(x, org_id)` FK, so `DEFERRABLE INITIALLY IMMEDIATE` does not apply.
- `rls-coverage`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`: no change (shape 1, no `device_id`).

## Tests run
- `tenant-export-policy.integration.test.ts`, `tenantCascade.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` — run explicitly against a live DB, since they only run in the **Integration Tests** job.
- `softwareInstallMethods.integration.test.ts` extended: SET NULL survival, org erasure with a policy-owned deployment, cross-tenant `catalogId` refusal, partner-owned reachability, dedup open/close.
- Unit: `softwarePolicyInstallRemediation.test.ts` (new), `softwareDeployment.test.ts`, `softwareRemediationWorker.test.ts`, `migrationRlsScope.test.ts`, `autoMigrate.test.ts`.

## Notable decisions
- Dedup is checked **once per job**; a clean pass then creates one deployment per distinct resolvable missing rule, so a device converges in one 15-minute cycle while the next pass still queues nothing.
- "Unfinished" is a closed terminal list (`completed`/`failed`/`cancelled`), so a future `deployment_status` member counts as unfinished and suppresses a duplicate install. A 24h lookback (mirroring `IN_FLIGHT_LOOKBACK_MINUTES`) bounds that.
- Cross-tenant `catalogId` guard: the worker runs in a system DB context where RLS scopes nothing, and a rule's `catalogId` is operator-authored jsonb — the ownership predicate in `readReachableCatalogItem` is the only thing stopping another tenant's package from installing. Not in the contract; added deliberately.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

- [ ] **Step 9: Tear the local stacks down**

```bash
cd apps/api && pnpm test:docker:down
docker compose ls -a
```

---

## Self-review

**1. Spec coverage.** Walked the spec's §3, §4 and the corrections section against the wave-ownership map.

| Spec / contract item | Task |
|---|---|
| §3 D7 `software_policy_id` column + `ON DELETE SET NULL` | 1 |
| §3 D7 `softwarePolicyId` on `CreateSoftwareDeploymentInput`, stamped at INSERT | 2 |
| §3 D7 export-policy registration | 3 |
| §3 D7 cascade verification (org + partner pre-clears, not array position) | 0 (conclusion), 8 (proof) |
| §3 D7 "not a composite `(x, org_id)` FK, so no DEFERRABLE" | Global Constraints + Task 1 header comment |
| §3 "policy remediation creates a real, policy-owned deployment" | 5, 6 |
| §3 "dedup on the deployment row, not `device_commands`" | 5 (design note), 6 |
| §4 resolve `catalogId` → install method XOR version | 4 |
| §4 rule without `catalogId` → skip and say so (`'skipped'`) | 4 (`no_catalog_id`), 6 (status + audit) |
| §4 platform filter BEFORE creating a deployment | 4, 6 |
| §5/D6 audit actions from W01's constants, no literals | 6 |
| "Keep HP/EDR out of it" | Global Constraints + Task 5 comment; no new `integrationProvider` branch anywhere |
| D8 migration slot + re-check | 1 Steps 1, 6 |
| Both contract suites run before the PR | 8 Steps 4, 7 |
| Non-goals (`'outdated'`, replacing deployments, uninstall behaviour) | untouched — no task references any of them |

Out-of-scope items confirmed absent from every task: the arming helper's body, `readSoftwarePolicyAutoInstall`, the compliance worker, the per-pass cap, the attempt counter, the knobs file, any `apps/web` file, any AI file.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Every code step carries runnable code. The one genuine unknown — W01/W02's exact export names — is handled by a named verification step (Task 4 Step 1, Task 6 Step 1) with the exact `grep` commands and an explicit instruction to stop rather than invent, not by a placeholder.

**3. Type consistency.** Cross-checked every identifier used in a later task against its definition in an earlier one:
- `PolicyInstallTarget` (Task 4) is consumed by `createPolicyOwnedInstallDeployment` (Task 5) and by `processRemediateDeviceInstall` (Task 6) with the same two-variant shape and the same field names (`kind`, `catalogId`, `installMethodId` / `softwareVersionId`).
- `PolicyInstallSkipReason`'s three members are the same three strings in Task 4's implementation, Task 4's tests, Task 6's implementation, Task 6's tests and Task 8's integration case (`catalog_item_not_reachable`, not `catalog_item_not_visible` — the earlier draft's name was normalised).
- `resolvePolicyInstallTarget`'s parameter object is `{ catalogId, deviceOrgId, deviceOsType }` at every call site (Tasks 4, 6, 8).
- `createPolicyOwnedInstallDeployment`'s input is `{ policyId, policyName, orgId, deviceId, target }` in Task 5's signature, Task 5's test and Task 6's call.
- `hasUnfinishedPolicyOwnedInstall(policyId, deviceId)` — positional, two strings, in Tasks 5, 6 and 8.
- `softwarePolicyId` (camel, Drizzle/TS) vs `software_policy_id` (snake, SQL/export registry) are used consistently in their respective layers.
- `installRemediationStatus` values written by Task 6 (`'in_progress'`, `'pending'`, `'skipped'`, `'failed'`, `'completed'`) are all members of D1's declared union.

**4. Gap found and fixed inline.** The contract does not say what happens when a rule's `catalogId` names a catalog item belonging to a different tenant. Because the remediation worker runs under `withSystemDbAccessContext` (`softwareRemediationWorker.ts:14-22`), RLS scopes nothing there, and `rules` is operator-authored jsonb — so with no explicit predicate this path would install another tenant's uploaded binary. Task 4's `readReachableCatalogItem` is the fail-closed guard, and Task 8 proves it against real Postgres in both directions (another org refused, own partner allowed).
