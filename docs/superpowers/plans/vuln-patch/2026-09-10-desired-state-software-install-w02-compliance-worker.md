---
tracking_issue: LanternOps/breeze#5505
---

# Wave 02 — Compliance worker: missing-violation install remediation, per-pass cap, give-up counter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the software compliance worker act on `missing` violations — gate the new install verb on W01's shared arming helper, decide per device whether to queue an install (grace, cooldown, catalog-id presence, per-pass cap, consecutive-attempt give-up), record the decision in three new `software_compliance_status` columns, and enqueue a typed install-remediation job that W03's processor will consume.

**Architecture:** `software_compliance_status` gains `install_remediation_status` / `last_install_remediation_attempt` / `install_remediation_attempts` — a second, parallel status axis so every existing uninstall read and write stays byte-for-byte untouched (contract D1). `upsertSoftwareComplianceStatuses` generalises its existing two-branch "was `remediationStatus` provided" split into a shape-keyed grouping so a pass that says nothing about a column still never clobbers it. The worker stops re-deriving the arming gate inline and calls W01's `evaluateSoftwarePolicyArming(policy, verb)` for both verbs (D11); the grace clock stops hard-filtering `unauthorized` and takes the violation type it should measure (D10). A new pure `decideInstallRemediation()` holds all install-specific gating so the failure mode the spec calls out — an install loop that reinstalls forever every 15 minutes — is bounded by a per-policy per-pass cap and a consecutive-attempt counter that terminates at `gave_up`. Install jobs ride the existing `software-remediation` BullMQ queue under their own `type` discriminant and their own jobId namespace, so a device can be queued for uninstall AND install in the same pass without one deduping into the other.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS), BullMQ, Vitest (unit), zod (not touched by this wave).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-09-10-desired-state-software-install-design.md` (§2 missing-violation branch, §6 audit, Risks §1 install loops and §2 fleet-wide first run, Testing bullets 1-2 and the install half of bullet 6 — NOT §3 dispatch, §4 catalog resolution, §5 authorization, which are W01/W03/W05). Its **"Corrections after ground-truth verification"** section supersedes the body.

**Contract:** `contract-A-desired-state.md` (coordinator, authoritative). This wave owns D1, D5, D10, D11, the D9 *check*, and the install job payload. It does not re-decide anything there.

**Depends on:** **W01 (#5506)**, which must be merged first. W01 produces `PolicyRemediationVerb`, `readSoftwarePolicyAutoInstall`, the two-argument `evaluateSoftwarePolicyArming(policy, verb)`, the install audit-action constants, and `SoftwarePolicyViolation['rule'].catalogId`.

**Consumed by:** **W03 (#5508)**, which implements the processor for the job payload defined in Task 8 and replaces the parking branch installed there.

## Global Constraints

- **Migration slot:** `apps/api/migrations/2026-10-15-150400-software-compliance-install-remediation.sql`. Confirmed at plan time via `ls apps/api/migrations/*.sql | sort | tail -1` → `2026-10-15-150300-remote-session-revocation-lease.sql`, so `150400` sorts last. **Re-run that command at implementation time and rename upward if anything now sorts after it** — migration filenames run ahead of real time and today's date does NOT sort last. `2026-08-06` is a closed date block; never use it. Never edit a shipped migration.
- The migration is **DDL only** (three `ADD COLUMN IF NOT EXISTS`). It performs no `UPDATE`/`DELETE`/`INSERT`/`MERGE`, so it needs **no** `SELECT set_config('breeze.scope','system',true);`. Run `apps/api/src/db/migrationRlsScope.test.ts` anyway (Task 1 Step 5) to prove the guard stays green and that this file is not added to the 122-file frozen baseline.
- **No registration changes.** `software_compliance_status` has no `org_id`; verified zero occurrences in `apps/api/src/services/tenantCascade.ts` and `apps/api/src/services/tenantExportPolicyRegistry.ts`, and it is already registered in `CORE_DEVICE_CASCADE_DELETE_TABLES` at `apps/api/src/routes/devices/core.ts:511`. It is deliberately absent from `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (documented at `core.ts:208` as "no `org_id` column today"). Adding columns changes none of that.
- **New column shapes, verbatim from contract D1** (mirroring the existing `remediation_status` / `last_remediation_attempt` types at `softwarePolicies.ts:121-122`):
  ```
  install_remediation_status        varchar(20)  NULL DEFAULT 'none'
  last_install_remediation_attempt  timestamp    NULL
  install_remediation_attempts      integer      NOT NULL DEFAULT 0
  ```
- **Allowed `install_remediation_status` values — a TS union, no DB enum:**
  `'none' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'gave_up' | 'skipped'`
  where `'gave_up'` = consecutive attempts exhausted and `'skipped'` = rule has no `catalogId`, platform mismatch (W03), or the per-pass cap was hit.
- **`install_remediation_attempts` is the CONSECUTIVE attempt counter** for the install-loop guard: reset to 0 whenever that (policy, device) has no `missing` violation left; incremented on every queue.
- **New env knobs, resolved PER CALL, never captured at module load** (contract D5), in new file `apps/api/src/services/softwareInstallRemediationKnobs.ts`:

  | Knob | Default | Floor | Meaning |
  |---|---|---|---|
  | `SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS` | `50` | `1` | installs queued per policy per compliance pass |
  | `SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS` | `3` | `1` | consecutive attempts before giving up |

  Do **NOT** write `export const X = resolveX()` — that is the frozen-at-module-load bug `BACKUP_GC_GRACE_MS` shipped at `apps/api/src/jobs/backupRetention.ts:539`.
- **Audit action values are locked by contract D6:** `install_queued`, `install_succeeded`, `install_failed`, `install_gave_up`. W02 emits `install_queued` and `install_gave_up`. Import the constant object W01 exported from `softwarePolicyService.ts` — **never a string literal at an emit site**.
- **The existing upsert's non-clobber property is load-bearing and must be preserved.** `upsertSoftwareComplianceStatuses` splits on "was `remediationStatus` provided" precisely so a pass with nothing to say about that column does not write `excluded.remediation_status` (which for a fresh `values()` row would be the insert-time DEFAULT) over a live value. The install columns must inherit that behaviour, not always-write.
- **Explicitly OUT OF SCOPE for this wave** (contract wave-ownership map): deployment creation or dispatch of any kind, the `software_deployments` table and its `software_policy_id` column, `createSoftwareDeployment`, `dispatchSoftwareInstallToDevice`, catalog→install-method resolution and the platform-mismatch filter (all W03); any file under `apps/web` (W04); `aiGuardrails.ts`, `aiToolsCompliance.ts`, `aiToolsPolicyPrereqs.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiToolsSoftwarePolicyAudit.ts` (W05); the `autoInstall` schema field, the arming helper's own body, the authorization assertion, and the `catalogId` emission (all W01). The `'outdated'` violation type stays unwired (spec Non-goals).
- **TDD is mandatory and red-first.** Write the assertion, run it against unmodified code, watch it fail, then implement.
- **Scoped test runs are `cd apps/api && npx vitest run <path>`.** Never `pnpm --filter <pkg> test -- --run <path>` — the `--` makes vitest run the whole suite in watch mode. Vitest's path filter is a plain substring match, not a glob: list dotted sibling files explicitly and always check the reported file count.

---

## 0. Ground truth

Every claim below was verified by re-opening the file in this worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing`, branch `spec/hp-warranty-and-desired-state-install`) on 2026-09-10. The contract's "Verified starting facts" line numbers were **confirmed, not copied**. Deltas are flagged.

### Schema — `apps/api/src/db/schema/softwarePolicies.ts` (188 lines)

- `:25-32` `SoftwarePolicyRuleDefinition` — `{ name; vendor?; minVersion?; maxVersion?; catalogId?; reason? }`. **Confirmed**, and `catalogId?` is present today.
- `:48-63` `SoftwarePolicyViolation`. Its `rule` sub-object is verbatim:
  ```ts
    rule?: {
      name: string;
      minVersion?: string;
      maxVersion?: string;
      reason?: string;
    };
  ```
  **No `catalogId`** — confirmed. W01 adds it (contract D9).
- `:65-71` `SoftwarePolicyRemediationOptions` — `{ autoUninstall?; notifyUser?; gracePeriod?; cooldownMinutes?; maintenanceWindowOnly? }`. **Confirmed**; no `autoInstall` yet.
- `:114-129` `softwareComplianceStatus`. Columns verbatim:
  ```ts
    status: varchar('status', { length: 20 }).notNull().default('compliant'),
    lastChecked: timestamp('last_checked').notNull(),
    violations: jsonb('violations').$type<SoftwarePolicyViolation[]>(),
    remediationStatus: varchar('remediation_status', { length: 20 }).default('none'),
    lastRemediationAttempt: timestamp('last_remediation_attempt'),
    remediationErrors: jsonb('remediation_errors').$type<RemediationError[]>(),
  ```
  Unique index `software_compliance_device_policy_unique` on `(deviceId, policyId)` at `:128`. **Confirmed.** `integer` is already imported at `:10`, `timestamp` at `:6`, `varchar` at `:4` — Task 2 needs no new imports.
- `:142` `action: varchar('action', { length: 50 }).notNull()` on `softwarePolicyAudit` — bare varchar, no enum. **Confirmed.**

### Service — `apps/api/src/services/softwarePolicyService.ts` (575 lines)

- `:1` imports are `import { and, eq, inArray, sql } from 'drizzle-orm';` — `sql` is already there; Task 3 adds only `type SQL`.
- `:28` `export type SoftwarePolicyRemediationStatus = 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';` — **confirmed**, five values, no `gave_up`/`skipped`.
- `:30-37` `SoftwareComplianceUpsertInput` = `{ deviceId; policyId; status; violations; checkedAt?; remediationStatus? }`. **Confirmed.**
- `:99-111` `violationFingerprint` — **this is the D9 answer.** Verbatim:
  ```ts
  function violationFingerprint(violation: SoftwarePolicyViolation): string {
    const type = violation.type.toLowerCase();
    if (violation.type === 'unauthorized') {
      const name = normalizeComparable(violation.software?.name ?? '');
      const version = normalizeComparable(violation.software?.version ?? '');
      return `${type}:software:${name}:${version}`;
    }

    const ruleName = normalizeComparable(violation.rule?.name ?? '');
    const minVersion = normalizeComparable(violation.rule?.minVersion ?? '');
    const maxVersion = normalizeComparable(violation.rule?.maxVersion ?? '');
    return `${type}:rule:${ruleName}:${minVersion}:${maxVersion}`;
  }
  ```
  **It does NOT compare violation objects structurally.** It builds an explicit key from four named fields and ignores every other property. Adding `catalogId` to the emitted `rule` object therefore **cannot** change match behaviour — no fix is required in this wave, only a regression pin (Task 5). Two consequences worth recording: (a) two `missing` rules with the same name/minVersion/maxVersion but different `catalogId` collapse to one fingerprint and share the earliest `detectedAt`, which makes the grace clock *conservative* (fires sooner), never permissive; (b) `decideInstallRemediation` must therefore key nothing off the fingerprint.
- `:113-146` `withStableViolationTimestamps(nextViolations, previousViolations)` — builds `previousByKey` from `violationFingerprint`, then maps each next violation to the earliest previous `detectedAt` for the same key, **spreading the original object** (`{ ...violation, detectedAt }`). So a new `rule.catalogId` survives stabilisation untouched. Confirmed. Called only from `softwareComplianceWorker.ts:377` and its own test at `softwarePolicyService.test.ts:88`.
- `:159` `SoftwarePolicyUnarmedReason = 'audit_mode' | 'enforce_mode_off' | 'auto_uninstall_off'`; `:161-163` `SoftwarePolicyArmingState`; `:165-169` `SoftwarePolicyArmingInput` = `{ mode; enforceMode; remediationOptions }`; `:172-175` `readSoftwarePolicyAutoUninstall`; `:177-206` `evaluateSoftwarePolicyArming(policy)` — **one argument today**. All **confirmed**. The three refusal messages at `:184`, `:192-193`, `:201-202` all say "uninstall" explicitly.
- `:333-347` the `missing` emission — writes `rule: { name, minVersion, maxVersion }` only. **Confirmed; no `catalogId`, no `reason`.** (The audit-mode branch at `:364-369` does carry `reason`.)
- `:455-514` `upsertSoftwareComplianceStatuses` — the two-branch split is at `:468-469`:
  ```ts
    const withRemediationStatus = normalized.filter((input) => input.remediationStatus !== undefined);
    const withoutRemediationStatus = normalized.filter((input) => input.remediationStatus === undefined);
  ```
  followed by two near-identical `chunkArray` loops (`:471-490` without, `:492-513` with). **Confirmed.** Note the guard is `!== undefined`, not truthiness — Task 3 must preserve that, since `installRemediationAttempts: 0` is a meaningful value that a truthiness check would silently drop.
- `:516-531` `upsertSoftwareComplianceStatus` (singular) — a thin wrapper with its own inlined status union at `:521`. **It has zero non-test callers** (grep across `apps/api/src` for `upsertSoftwareComplianceStatus(` returns only its own definition and the plural it delegates to). This wave leaves it alone; it simply never carries install fields.
- `:533-574` `recordSoftwarePolicyAudit` — `action: string` at `:542`, owner-axis invariant at `:548-550` ("at least one", not XOR), failures swallowed to console + Sentry. **Confirmed.**

### Compliance worker — `apps/api/src/jobs/softwareComplianceWorker.ts` (668 lines)

- `:2` `import { and, eq, inArray } from 'drizzle-orm';` — **`sql` is NOT imported.** Task 9 must add it.
- `:4` `import { devices, softwareComplianceStatus, softwarePolicies } from '../db/schema';` — no type imports from schema yet.
- `:44` `const SCAN_INTERVAL_MS = 15 * 60 * 1000;` and `:45` `REMEDIATION_COOLDOWN_DEFAULT_MINUTES = 120`. **Confirmed.**
- `:67-73` `ExistingComplianceState` = `{ deviceId; status; violations; remediationStatus; lastRemediationAttempt }`. `:82-93` `parseRemediationStatus` accepts exactly the five `SoftwarePolicyRemediationStatus` values and returns `null` otherwise.
- `:95-134` `readComplianceStateByDevice` — chunked `db.select({...})` of five columns. This is where the three new columns must be read.
- `:136-162` `readRemediationOptions` — returns `{ autoUninstallEnabled, gracePeriodHours, cooldownMinutes }`; `autoUninstallEnabled` is derived at `:158` as `options.autoUninstall === true`. **This is the duplicate arming derivation D11 removes.** The function is module-private (not exported), so removing that one field breaks no external caller.
- `:164-182` `readEarliestUnauthorizedDetection(violations)` — exported. The hard filter is at `:171`:
  ```ts
      if (typed.type !== 'unauthorized' || typeof typed.detectedAt !== 'string') {
        continue;
      }
  ```
  **Confirmed.** A `missing` violation contributes nothing to grace today.
- `:184-212` `shouldQueueAutoRemediation` — exported; its declared return is `{ queue: boolean; reason?: string }`; it calls `readEarliestUnauthorizedDetection` at `:196`. Sole non-test call site is `:429`. **Confirmed.** The only reasons it ever returns are `'in_progress'` (`:193`), `'grace_period'` (`:200`), `'cooldown'` (`:207`).
- `:280-330` `processCheckPolicy` — policy reload `:286-293`, generation gate `:311-321`, `resolveDeviceIdsForSoftwarePolicy` `:324`, the ephemeral-device `orgByDevice` narrowing `:342-350`.
- `:361-369` the pass preamble: `normalizedRules`, `remediationOptions`, `existingByDevice`, `inventoryByDevice`, `violations`, `remediationTargets: Set<string>`, `complianceUpserts`, `now`.
- `:371-475` the per-device loop. `:377-380` `withStableViolationTimestamps(...)`; `:383-394` the uninstall `remediationStatus` derivation; `:396-403` the `complianceUpserts.push`; `:406-445` the `status === 'violation'` block.
- `:423-427` the remediation gate, verbatim — **this is the two-part blocker:**
  ```ts
        if (
          policy.enforceMode
          && policy.mode !== 'audit'
          && remediationOptions.autoUninstallEnabled
          && violationsWithStableTimestamps.some((violation) => violation.type === 'unauthorized')
        ) {
  ```
  The contract's `:423-444` range is **confirmed** (the block closes at `:444`). Note `enforceMode` is `boolean NOT NULL` in the schema (`softwarePolicies.ts:94`), so `policy.enforceMode &&` and `evaluateSoftwarePolicyArming`'s `policy.enforceMode !== true` are exactly equivalent — D11 is behaviour-preserving for uninstall.
- `:477-479` the upsert flush; `:481-516` the post-schedule block (`scheduleSoftwareRemediation` at `:484`, the chunked UPDATE at `:487-498`, `remediation_scheduled` audit at `:501-513`).
- `:526-548` `createSoftwareComplianceWorker`; `:550-568` `scheduleComplianceScan` with `repeat: { every: SCAN_INTERVAL_MS }` at `:563`. **Confirmed.**

### Remediation worker — `apps/api/src/jobs/softwareRemediationWorker.ts` (792 lines)

- `:56-72` `type RemediateDeviceJobData = { type: 'remediate-device'; policyId; deviceId; trigger?; requestedByUserId?; manualRequestId? }` — **not exported. Confirmed.**
- `:74` `type SoftwareRemediationJobData = RemediateDeviceJobData;` — a bare alias, not yet a union.
- `:148-155` `getSoftwareRemediationQueue(): Queue<SoftwareRemediationJobData>` — **exported.**
- `:168-195` `readInFlightUninstallKeys` — the uninstall dedup, `payload ->> 'policyId'` at `:181`.
- `:199` `processRemediateDevice(data: RemediateDeviceJobData)` — uninstall-specific end to end: manual-authorization consume `:308-316`, `evaluateSoftwarePolicyArming(policy)` at `:318` (one argument), the unarmed refusal + `remediationStatus: 'failed'` write `:343-380`, the `SOFTWARE_UNINSTALL` queue site `:522-532`, the terminal `remediationStatus`/`lastRemediationAttempt` write `:545-558`.
- `:601-620` `createSoftwareRemediationWorker` — the processor is a bare `return processRemediateDevice(job.data);` at `:606`, no `type` switch.
- `:712-792` `scheduleSoftwareRemediation(policyId, deviceIds, options)` — jobId namespaces at `:755-757`:
  ```ts
      const jobId = trigger === 'manual'
        ? `software-remediation-manual-${manualRequestId}`
        : `software-remediation-${policyId}-${deviceId}`;
  ```
  Dedup via `queue.getJob(jobId)` + `isReusableState(state)` at `:758-768`; `queue.add` opts at `:780-786`. Returns a **count**, and `softwareComplianceWorker.ts:486` then stamps `remediationStatus:'pending'` on **all** targets whenever that count is `> 0` — including devices that deduped and got no job. That is a pre-existing uninstall inaccuracy; this wave does not fix it (out of scope) but **must not replicate it** — Task 8's install scheduler returns the deviceIds actually enqueued.

### Registries, metrics, tests

- `apps/api/src/routes/devices/core.ts:511` — `'software_compliance_status', 'software_policy_audit', 'software_remediation_requests',` inside `CORE_DEVICE_CASCADE_DELETE_TABLES`. **Confirmed** (the contract's `:511` is right; the spec body's `:507` is stale).
- `grep -rn 'software_compliance_status' apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts` → **zero hits in both.** Confirmed.
- Every non-test reader of `softwareComplianceStatus` uses an explicit column projection, never a bare `select()` splat: `routes/softwarePolicies.ts:411-423,482-493,871,906-913`, `services/userRiskScoring.ts:600-609`, `services/aiToolsCompliance.ts:97-98`, `jobs/softwareRemediationWorker.ts`. Adding columns breaks none of them. **Corollary flagged for the coordinator: `routes/softwarePolicies.ts:482-487` is the compliance-list API projection and does NOT include the new columns, and no wave in the ownership map owns adding them** — W04 is "web UI only / must not touch any `apps/api` file". W02 leaves it alone per scope; see the closing note.
- `apps/api/src/routes/metrics.ts:918` — `recordSoftwareRemediationDecision(decision: string, count = 1)`. It lowercases and trims the label and accepts any string, so new decision labels need no registration.
- `apps/api/src/jobs/softwareComplianceWorker.test.ts` (291 lines) — mocks `bullmq`, `../services/redis`, `../db` (**only `db.select`**, plus `runOutsideDbContext`/`withDbAccessContext`/`withSystemDbAccessContext` passthroughs) and `../services/featureConfigResolver`. It imports `processCheckPolicy`, `readEarliestUnauthorizedDetection`, `scheduleSoftwareComplianceCheck`, `shouldQueueAutoRemediation`. Its `shouldQueueAutoRemediation` describe block is `:89-187` (8 cases) and its `readEarliestUnauthorizedDetection` block is `:189-223` (5 cases). Every one of those 13 cases must gain the new required argument in Task 4.
- `apps/api/src/services/softwarePolicyService.test.ts` — pure-function tests only; it declares **no `vi.mock` at all**. Task 3's upsert tests therefore need a new file with its own db mock rig rather than an edit here.
- `apps/api/src/db/migrationRlsScope.test.ts:1-60` — the guard reads every `^\d{4}-.*\.sql$` file and requires `SELECT set_config('breeze.scope','system',true);` before any DML. Pure-DDL files are unaffected.
- `apps/api/package.json` — `"test": "vitest"` (bare/watch). No `typecheck` script; use `pnpm --filter @breeze/api exec tsc --noEmit`.
- `apps/api/src/jobs/backupRetention.ts:539` — `export const BACKUP_GC_GRACE_MS = resolveBackupGcGraceMs();`. The defect D5 forbids repeating. Its floor is applied **only** under `NODE_ENV === 'production'` (`:517`); this wave's floors are unconditional (see Task 6 rationale).

## File structure

- **Create** `apps/api/migrations/2026-10-15-150400-software-compliance-install-remediation.sql` — three `ADD COLUMN IF NOT EXISTS`, DDL only.
- **Modify** `apps/api/src/db/schema/softwarePolicies.ts` — three columns on `softwareComplianceStatus`.
- **Modify** `apps/api/src/services/softwarePolicyService.ts` — `SoftwarePolicyInstallRemediationStatus`, the extended `SoftwareComplianceUpsertInput`, and the shape-keyed rewrite of `upsertSoftwareComplianceStatuses`.
- **Create** `apps/api/src/services/softwarePolicyService.complianceUpsert.test.ts` — the non-clobber contract, with a db mock rig the existing pure-function test file does not have.
- **Create** `apps/api/src/services/softwareInstallRemediationKnobs.ts` + `apps/api/src/services/softwareInstallRemediationKnobs.test.ts` — per-call env resolvers.
- **Modify** `apps/api/src/jobs/softwareComplianceWorker.ts` — verb-aware grace clock (D10), delegated arming (D11), `decideInstallRemediation`, the new columns in `ExistingComplianceState`/`readComplianceStateByDevice`, the install branch, the install scheduling block.
- **Modify** `apps/api/src/jobs/softwareComplianceWorker.test.ts` — thread the new required arguments through the 13 existing cases.
- **Create** `apps/api/src/jobs/softwareComplianceWorker.install.test.ts` — the install decision matrix, the D11 divergence guard, and the full-loop wiring test, each with its own mock rig.
- **Modify** `apps/api/src/jobs/softwareRemediationWorker.ts` — the exported install job payload type, `scheduleSoftwareInstallRemediation`, the discriminated `SoftwareRemediationJobData` union, and the processor parking branch W03 replaces.
- **Modify** `apps/api/src/jobs/softwareRemediationWorker.test.ts` — the jobId-namespace separation and the parking branch.
- **Create** `apps/api/src/services/softwarePolicyService.violationFingerprint.test.ts` — the D9 regression pin (Task 5).

---

### Task 1: Migration `150400` — the three install-remediation columns

**Files:**
- Create: `apps/api/migrations/2026-10-15-150400-software-compliance-install-remediation.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: the columns `software_compliance_status.install_remediation_status`, `.last_install_remediation_attempt`, `.install_remediation_attempts`.

- [ ] **Step 1: Confirm the slot still sorts last**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
ls apps/api/migrations/*.sql | sort | tail -1
```

Expected at plan time: `apps/api/migrations/2026-10-15-150300-remote-session-revocation-lease.sql`. If anything now sorts at or after `2026-10-15-150400`, pick the next free timestamp that sorts after the newest committed file and use that name **everywhere in this task**. Do not assume today's date sorts last.

- [ ] **Step 2: Observe the red — the columns are absent**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d software_compliance_status"
```

Expected: `install_remediation_status`, `last_install_remediation_attempt`, `install_remediation_attempts` are all absent. (This is the baseline; a migration has no unit-testable TypeScript surface.)

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-10-15-150400-software-compliance-install-remediation.sql
-- Feature #5505 W02 (#5507), contract D1: a SECOND remediation-status axis on
-- software_compliance_status, for the `missing`-violation install verb.
--
-- WHY THREE COLUMNS AND NOT A JSONB BLOB. remediation_status is a single
-- varchar today and two verbs sharing it would lie: a successful install
-- alongside a failed uninstall has no honest single value. Separate columns
-- leave every existing uninstall read/write and the uninstall cooldown logic
-- (softwareRemediationWorker.ts:545-558, softwareComplianceWorker.ts:486-498)
-- byte-for-byte untouched, which a jsonb reshape would not.
--
-- install_remediation_attempts is the CONSECUTIVE attempt counter behind the
-- install-loop guard (spec Risks §1): a policy whose rule never matches what
-- the installer actually registers in Add/Remove Programs would otherwise
-- re-detect `missing` and reinstall every 15 minutes forever. It resets to 0
-- when the (policy, device) has no `missing` violation left and increments on
-- every queue; at SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS the compliance
-- worker stops and writes install_remediation_status = 'gave_up'.
--
-- Types deliberately mirror the existing remediation_status /
-- last_remediation_attempt columns (schema/softwarePolicies.ts:121-122):
-- varchar(20) and a bare `timestamp`, NOT timestamptz. Allowed status values
-- are a TypeScript union, not a DB enum, matching how remediation_status is
-- already constrained: 'none' | 'pending' | 'in_progress' | 'completed' |
-- 'failed' | 'gave_up' | 'skipped'.
--
-- NO REGISTRATION CHANGES ARE NEEDED, verified: software_compliance_status has
-- no org_id column, appears zero times in services/tenantCascade.ts and zero
-- times in services/tenantExportPolicyRegistry.ts, and is already listed in
-- CORE_DEVICE_CASCADE_DELETE_TABLES (routes/devices/core.ts:511). It is
-- deliberately absent from CORE_DEVICE_ORG_DENORMALIZED_TABLES (documented as
-- such at routes/devices/core.ts:208).
--
-- DDL ONLY. No UPDATE/DELETE/INSERT/MERGE, so no
-- `SELECT set_config('breeze.scope','system',true);` is required (#4518 guard,
-- src/db/migrationRlsScope.test.ts). Idempotent: ADD COLUMN IF NOT EXISTS on
-- all three, so re-applying is a true no-op. No inner BEGIN/COMMIT — autoMigrate
-- already wraps each file in client.begin(...).
--
-- Note on existing rows: PostgreSQL 11+ materialises the DEFAULT for existing
-- rows via attmissingval without a table rewrite, so every pre-existing row
-- reads back 'none' / NULL / 0 immediately. That is the intended starting
-- state, identical to a freshly inserted row.

ALTER TABLE software_compliance_status
  ADD COLUMN IF NOT EXISTS install_remediation_status varchar(20) DEFAULT 'none';

ALTER TABLE software_compliance_status
  ADD COLUMN IF NOT EXISTS last_install_remediation_attempt timestamp;

ALTER TABLE software_compliance_status
  ADD COLUMN IF NOT EXISTS install_remediation_attempts integer NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Apply it and verify green**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d software_compliance_status"
```

Expected: all three columns present; `install_remediation_attempts` shows `not null default 0`; `install_remediation_status` shows `character varying(20)` with `default 'none'::character varying`.

Then prove idempotency and the default backfill:

```bash
pnpm db:migrate   # second run must report zero newly-applied migrations
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "SELECT install_remediation_status, install_remediation_attempts, count(*) FROM software_compliance_status GROUP BY 1,2;"
```

Expected: every existing row reads `none | 0`.

- [ ] **Step 5: Run the migration guards**

```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```

Expected: PASS. `migrationRlsScope` must pass **without** the new file being added to its frozen 122-file baseline — if it demands an entry, the migration has DML in it that should not be there. `autoMigrate.test.ts` proves the filename sorts correctly and that no path reference is broken.

- [ ] **Step 6: Run the drift check**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing && pnpm db:check-drift
```

Expected: PASS (one `breeze_migrations` row per file after a fresh apply).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-15-150400-software-compliance-install-remediation.sql
git commit -m "feat(software): install-remediation status columns on software_compliance_status (#5505 W02, D1)"
```

---

### Task 2: Drizzle schema — the three columns on `softwareComplianceStatus`

**Files:**
- Modify: `apps/api/src/db/schema/softwarePolicies.ts:114-129`

**Interfaces:**
- Consumes: Task 1's migration.
- Produces: `softwareComplianceStatus.installRemediationStatus`, `.lastInstallRemediationAttempt`, `.installRemediationAttempts` (Drizzle columns; every later task selects, sets and upserts through these).

- [ ] **Step 1: No automated red step — state the verification instead**

`pnpm db:check-drift` does **not** compare the Drizzle schema against a live database; it verifies migration-ledger parity only. A Drizzle column definition is proven correct by real inserts/queries through it, which happens in Task 3's test (compiled SQL) and at runtime. The red for this task is the TypeScript compiler: Task 3's code references `softwareComplianceStatus.installRemediationStatus` and will not compile until this task lands.

- [ ] **Step 2: Implement**

```ts
// apps/api/src/db/schema/softwarePolicies.ts — inside softwareComplianceStatus's
// column object, immediately after `remediationErrors` (currently :123)
  remediationErrors: jsonb('remediation_errors').$type<RemediationError[]>(),
  // Feature #5505 W02 (contract D1): the SECOND remediation axis, for the
  // `missing`-violation install verb. Deliberately separate columns rather than
  // widening remediationStatus — two verbs sharing one status field would lie
  // (a successful install alongside a failed uninstall has no honest single
  // value), and separate columns leave every uninstall read/write untouched.
  // Types mirror remediationStatus/lastRemediationAttempt above exactly.
  // Allowed values are the TS union SoftwarePolicyInstallRemediationStatus in
  // services/softwarePolicyService.ts — there is no DB enum, matching how
  // remediation_status is already constrained.
  installRemediationStatus: varchar('install_remediation_status', { length: 20 }).default('none'),
  lastInstallRemediationAttempt: timestamp('last_install_remediation_attempt'),
  // CONSECUTIVE attempts, not lifetime: reset to 0 the moment this
  // (policy, device) has no `missing` violation left, incremented on every
  // queue. This is the install-loop guard from spec Risks §1 — grace and
  // cooldown bound the RATE of a mismatched-rule reinstall loop but never stop
  // it; this counter is what terminates it, at 'gave_up'.
  installRemediationAttempts: integer('install_remediation_attempts').notNull().default(0),
}, (table) => ({
```

(`varchar`, `timestamp` and `integer` are already imported at `softwarePolicies.ts:4,6,10` — no import edit is needed.)

- [ ] **Step 3: Typecheck**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: PASS (no consumer yet).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/softwarePolicies.ts
git commit -m "feat(software): Drizzle columns for install remediation status (#5505 W02, D1)"
```

---

### Task 3: `upsertSoftwareComplianceStatuses` carries the install columns without clobbering

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.ts:1` (import `type SQL`), `:28-37` (types), `:455-514` (the upsert)
- Test: `apps/api/src/services/softwarePolicyService.complianceUpsert.test.ts` (create)

**Interfaces:**
- Consumes: `softwareComplianceStatus.installRemediationStatus` / `.installRemediationAttempts` (Task 2).
- Produces:
  - `export type SoftwarePolicyInstallRemediationStatus = 'none' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'gave_up' | 'skipped';`
  - `SoftwareComplianceUpsertInput` extended with `installRemediationStatus?: SoftwarePolicyInstallRemediationStatus` and `installRemediationAttempts?: number`.
  - The non-clobber guarantee, now generalised to every optional column: an input that omits a column produces a statement whose `set` clause does not mention it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/softwarePolicyService.complianceUpsert.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The existing softwarePolicyService.test.ts is pure-function only and declares
// no vi.mock at all, so the upsert's SQL shape needs its own rig here. We
// capture the exact objects handed to values()/onConflictDoUpdate() rather than
// asserting on compiled SQL: the property this guards is "which columns does
// the ON CONFLICT set clause name", and that is visible in the set object's
// own keys.
type CapturedInsert = {
  values: Record<string, unknown>[];
  setKeys: string[];
};

const { captured, insertMock } = vi.hoisted(() => {
  const captured: CapturedInsert[] = [];
  const insertMock = vi.fn(() => ({
    values: (rows: Record<string, unknown>[]) => ({
      onConflictDoUpdate: async (config: { set: Record<string, unknown> }) => {
        captured.push({ values: rows, setKeys: Object.keys(config.set) });
      },
    }),
  }));
  return { captured, insertMock };
});

vi.mock('../db', () => ({
  db: { insert: insertMock },
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { upsertSoftwareComplianceStatuses } from './softwarePolicyService';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';

function baseInput(deviceId: string) {
  return {
    deviceId,
    policyId: POLICY,
    status: 'violation' as const,
    violations: [],
    checkedAt: new Date('2026-09-10T00:00:00.000Z'),
  };
}

describe('upsertSoftwareComplianceStatuses — per-column non-clobber contract', () => {
  beforeEach(() => {
    captured.length = 0;
    vi.clearAllMocks();
  });

  it('omits every optional column from the set clause when the input carries none', async () => {
    await upsertSoftwareComplianceStatuses([baseInput(DEVICE_A)]);

    expect(captured).toHaveLength(1);
    expect(captured[0].setKeys.sort()).toEqual(['lastChecked', 'status', 'violations']);
    expect(captured[0].values[0]).not.toHaveProperty('remediationStatus');
    expect(captured[0].values[0]).not.toHaveProperty('installRemediationStatus');
    expect(captured[0].values[0]).not.toHaveProperty('installRemediationAttempts');
  });

  it('writes remediationStatus WITHOUT touching either install column (existing behaviour, unchanged)', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(DEVICE_A), remediationStatus: 'pending' },
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0].setKeys.sort()).toEqual(['lastChecked', 'remediationStatus', 'status', 'violations']);
  });

  it('writes installRemediationStatus WITHOUT touching remediationStatus', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(DEVICE_A), installRemediationStatus: 'skipped' },
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0].setKeys.sort()).toEqual([
      'installRemediationStatus', 'lastChecked', 'status', 'violations',
    ]);
    expect(captured[0].values[0].installRemediationStatus).toBe('skipped');
  });

  // The discriminating case: 0 is falsy. A `if (input.installRemediationAttempts)`
  // guard would silently drop the counter reset and leave a device stuck one
  // attempt short of 'gave_up' forever. The guard must be `!== undefined`.
  it('treats installRemediationAttempts: 0 as a value to write, not as absent', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(DEVICE_A), installRemediationAttempts: 0 },
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0].setKeys).toContain('installRemediationAttempts');
    expect(captured[0].values[0].installRemediationAttempts).toBe(0);
  });

  it('splits a mixed batch into one statement per column shape', async () => {
    await upsertSoftwareComplianceStatuses([
      baseInput(DEVICE_A),
      { ...baseInput(DEVICE_B), installRemediationStatus: 'gave_up', installRemediationAttempts: 3 },
    ]);

    expect(captured).toHaveLength(2);
    const shapes = captured.map((c) => c.setKeys.sort().join(',')).sort();
    expect(shapes).toEqual([
      'installRemediationAttempts,installRemediationStatus,lastChecked,status,violations',
      'lastChecked,status,violations',
    ]);
  });

  it('still skips inputs with a blank deviceId or policyId', async () => {
    await upsertSoftwareComplianceStatuses([
      { ...baseInput(''), installRemediationStatus: 'pending' },
    ]);

    expect(captured).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyService.complianceUpsert.test.ts
```

Expected: FAIL. The `installRemediationStatus` / `installRemediationAttempts` cases fail to typecheck against today's `SoftwareComplianceUpsertInput` (`:30-37`), and the mixed-batch case fails because today's split is on `remediationStatus` alone and would produce **one** statement.

- [ ] **Step 3: Extend the types**

```ts
// apps/api/src/services/softwarePolicyService.ts:1 — add the SQL type
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
```

```ts
// apps/api/src/services/softwarePolicyService.ts — replacing :28-37
export type SoftwarePolicyRemediationStatus = 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Feature #5505 (contract D1): the install verb's own status axis. It is a
 * SUPERSET of SoftwarePolicyRemediationStatus, adding two install-specific
 * terminal states:
 *  - 'gave_up'  — the consecutive-attempt counter hit
 *                 SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS. This is the
 *                 install-loop terminator (spec Risks §1); a policy whose rule
 *                 never matches what the installer registers would otherwise
 *                 reinstall every 15 minutes forever.
 *  - 'skipped'  — nothing was attempted and nothing is wrong with the device:
 *                 the rule carries no catalogId (so there is nothing to
 *                 install), the per-pass cap was reached, or (W03) the
 *                 catalog item has no install method for this device's OS.
 * Deliberately NOT a DB enum — remediation_status is a bare varchar(20) too.
 */
export type SoftwarePolicyInstallRemediationStatus =
  | 'none'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'gave_up'
  | 'skipped';

export type SoftwareComplianceUpsertInput = {
  deviceId: string;
  policyId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: SoftwarePolicyViolation[];
  checkedAt?: Date;
  /**
   * OPTIONAL ON PURPOSE, for all three of these. `undefined` means "this pass
   * has nothing to say about that column" and the generated statement must not
   * name it at all — see upsertSoftwareComplianceStatuses. Passing a value when
   * you mean "leave it alone" silently overwrites a live status.
   */
  remediationStatus?: SoftwarePolicyRemediationStatus;
  installRemediationStatus?: SoftwarePolicyInstallRemediationStatus;
  installRemediationAttempts?: number;
};
```

- [ ] **Step 4: Rewrite the upsert as a shape-keyed grouping**

```ts
// apps/api/src/services/softwarePolicyService.ts — replacing :455-514 entirely

/**
 * Optional columns of software_compliance_status, keyed by their
 * SoftwareComplianceUpsertInput field name. Values are FACTORIES, not shared
 * SQL objects, so each generated statement gets its own fragment.
 */
const COMPLIANCE_UPSERT_OPTIONAL_COLUMNS: Record<string, () => SQL> = {
  remediationStatus: () => sql`excluded.remediation_status`,
  installRemediationStatus: () => sql`excluded.install_remediation_status`,
  installRemediationAttempts: () => sql`excluded.install_remediation_attempts`,
};

type ComplianceUpsertOptionalKey = keyof SoftwareComplianceUpsertInput
  & ('remediationStatus' | 'installRemediationStatus' | 'installRemediationAttempts');

const COMPLIANCE_UPSERT_OPTIONAL_KEYS = Object.keys(
  COMPLIANCE_UPSERT_OPTIONAL_COLUMNS
) as ComplianceUpsertOptionalKey[];

export async function upsertSoftwareComplianceStatuses(
  inputs: SoftwareComplianceUpsertInput[]
): Promise<void> {
  if (inputs.length === 0) return;

  const normalized = inputs.filter((input) => (
    typeof input.deviceId === 'string'
    && input.deviceId.length > 0
    && typeof input.policyId === 'string'
    && input.policyId.length > 0
  ));
  if (normalized.length === 0) return;

  // Group by WHICH optional columns each input actually carries.
  //
  // A bulk onConflictDoUpdate shares ONE `set` clause across its whole chunk,
  // and `excluded.<col>` reads the value of the row this statement tried to
  // insert. So an input that says nothing about a column must not travel in the
  // same statement as one that does — otherwise the silent input's insert-time
  // DEFAULT ('none' / 0) is written over a live value. That is exactly why the
  // original implementation split on "was remediationStatus provided"; this
  // generalises the same split to every optional column and is byte-equivalent
  // for callers that pass only remediationStatus (they still produce the same
  // two groups, with the same set clauses, as before).
  //
  // The membership test is `!== undefined`, NOT truthiness:
  // installRemediationAttempts: 0 is the counter RESET and must be written.
  const byShape = new Map<string, SoftwareComplianceUpsertInput[]>();
  for (const input of normalized) {
    const presentKeys = COMPLIANCE_UPSERT_OPTIONAL_KEYS.filter((key) => input[key] !== undefined);
    const shapeKey = presentKeys.join('|');
    const bucket = byShape.get(shapeKey);
    if (bucket) bucket.push(input);
    else byShape.set(shapeKey, [input]);
  }

  for (const [shapeKey, group] of byShape) {
    const optionalKeys = shapeKey.length > 0
      ? (shapeKey.split('|') as ComplianceUpsertOptionalKey[])
      : [];

    for (const chunk of chunkArray(group)) {
      if (chunk.length === 0) continue;
      await db
        .insert(softwareComplianceStatus)
        .values(chunk.map((input) => {
          const row: Record<string, unknown> = {
            deviceId: input.deviceId,
            policyId: input.policyId,
            status: input.status,
            violations: input.violations,
            lastChecked: input.checkedAt ?? new Date(),
          };
          for (const key of optionalKeys) {
            row[key] = input[key];
          }
          return row as typeof softwareComplianceStatus.$inferInsert;
        }))
        .onConflictDoUpdate({
          target: [softwareComplianceStatus.deviceId, softwareComplianceStatus.policyId],
          set: {
            status: sql`excluded.status`,
            violations: sql`excluded.violations`,
            lastChecked: sql`excluded.last_checked`,
            ...Object.fromEntries(
              optionalKeys.map((key) => [key, COMPLIANCE_UPSERT_OPTIONAL_COLUMNS[key]()])
            ),
          },
        });
    }
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyService.complianceUpsert.test.ts src/services/softwarePolicyService.test.ts
```

Expected: PASS, 2 files. The existing `softwarePolicyService.test.ts` must stay green — this change is behaviour-preserving for every current caller.

- [ ] **Step 6: Typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/softwarePolicyService.ts apps/api/src/services/softwarePolicyService.complianceUpsert.test.ts
git commit -m "feat(software): shape-keyed compliance upsert carries install columns without clobbering (#5505 W02, D1)"
```

---

### Task 4: D10 — the grace clock becomes verb-aware

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts:164-212` (both helpers) and `:429-436` (the sole call site)
- Modify: `apps/api/src/jobs/softwareComplianceWorker.test.ts:89-223` (13 existing cases)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export type AutoRemediationDeferralReason = 'in_progress' | 'grace_period' | 'cooldown';`
  - `export function readEarliestViolationDetection(violations: unknown, violationType: SoftwarePolicyViolation['type']): Date | null;` — replaces `readEarliestUnauthorizedDetection`, which is deleted.
  - `shouldQueueAutoRemediation` gains a **required** `violationType` input field and a narrowed return type `{ queue: boolean; reason?: AutoRemediationDeferralReason }`.

Contract D10 says generalise rather than add a near-duplicate, and a **required** parameter (mirroring D2's discipline) is what makes the compiler enumerate every call site instead of letting one silently keep the old default.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/jobs/softwareComplianceWorker.test.ts`, and update the import block at `:36-41` first:

```ts
// apps/api/src/jobs/softwareComplianceWorker.test.ts — replacing the import block at :36-41
import {
  processCheckPolicy,
  readEarliestViolationDetection,
  scheduleSoftwareComplianceCheck,
  shouldQueueAutoRemediation,
} from './softwareComplianceWorker';
```

```ts
// apps/api/src/jobs/softwareComplianceWorker.test.ts — append at end of file
describe('readEarliestViolationDetection — verb awareness (contract D10)', () => {
  const MIXED = [
    { type: 'unauthorized', detectedAt: '2025-01-10T00:00:00Z' },
    { type: 'missing', detectedAt: '2025-01-02T00:00:00Z' },
    { type: 'unauthorized', detectedAt: '2025-01-05T00:00:00Z' },
    { type: 'missing', detectedAt: '2025-01-20T00:00:00Z' },
  ];

  it('measures only unauthorized violations when asked for unauthorized', () => {
    expect(readEarliestViolationDetection(MIXED, 'unauthorized')?.toISOString())
      .toBe('2025-01-05T00:00:00.000Z');
  });

  it('measures only missing violations when asked for missing', () => {
    expect(readEarliestViolationDetection(MIXED, 'missing')?.toISOString())
      .toBe('2025-01-02T00:00:00.000Z');
  });

  it('returns null when the requested type is absent', () => {
    expect(readEarliestViolationDetection(
      [{ type: 'unauthorized', detectedAt: '2025-01-10T00:00:00Z' }],
      'missing',
    )).toBeNull();
  });
});

describe('shouldQueueAutoRemediation — grace measured against the requested verb', () => {
  const NOW_D10 = new Date('2025-01-10T00:00:00Z');

  // A device with a fresh `missing` violation and a long-stale `unauthorized`
  // one. Before D10 the grace clock read the unauthorized timestamp for BOTH
  // verbs, so the install verb would queue immediately, ignoring its own grace.
  const MIXED_AGES = [
    { type: 'unauthorized', detectedAt: '2024-01-01T00:00:00Z' },
    { type: 'missing', detectedAt: '2025-01-09T23:00:00Z' },
  ];

  it('defers the install verb inside ITS grace window even though an unauthorized violation is ancient', () => {
    expect(shouldQueueAutoRemediation({
      violations: MIXED_AGES,
      violationType: 'missing',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW_D10,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    })).toEqual({ queue: false, reason: 'grace_period' });
  });

  it('still queues the uninstall verb against the same violation set', () => {
    expect(shouldQueueAutoRemediation({
      violations: MIXED_AGES,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW_D10,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    })).toEqual({ queue: true });
  });
});
```

Then thread `violationType: 'unauthorized'` into all 8 existing `shouldQueueAutoRemediation` cases at `:89-187` (add the field immediately after `violations:` in each object literal), and rewrite the 5 `readEarliestUnauthorizedDetection` cases at `:189-223` to call `readEarliestViolationDetection(x, 'unauthorized')` with the same expectations. The 5 rewritten cases are the **byte-identical-behaviour** proof the contract requires.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.test.ts
```

Expected: FAIL — `readEarliestViolationDetection` is not exported, and `violationType` is not a property of `shouldQueueAutoRemediation`'s input type.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — replacing :164-212

/**
 * Earliest detection timestamp among violations of ONE type (contract D10).
 *
 * This used to be readEarliestUnauthorizedDetection, which hard-filtered
 * `type !== 'unauthorized'`, so a `missing` violation contributed nothing to
 * grace. With two remediation verbs each having their own grace clock, the
 * type is a REQUIRED argument rather than a default: the compiler then has to
 * point at every call site instead of letting one silently keep uninstall
 * semantics. Behaviour for 'unauthorized' is unchanged, byte for byte.
 */
export function readEarliestViolationDetection(
  violations: unknown,
  violationType: SoftwarePolicyViolation['type']
): Date | null {
  if (!Array.isArray(violations)) return null;
  let earliest: Date | null = null;

  for (const violation of violations) {
    if (!violation || typeof violation !== 'object') continue;
    const typed = violation as { type?: unknown; detectedAt?: unknown };
    if (typed.type !== violationType || typeof typed.detectedAt !== 'string') {
      continue;
    }
    const detectedAt = new Date(typed.detectedAt);
    if (Number.isNaN(detectedAt.getTime())) continue;
    if (!earliest || detectedAt.getTime() < earliest.getTime()) {
      earliest = detectedAt;
    }
  }

  return earliest;
}

/** The only reasons this function ever defers. Narrowed from `string` so the
 *  install decision can widen it into its own union without a cast. */
export type AutoRemediationDeferralReason = 'in_progress' | 'grace_period' | 'cooldown';

export function shouldQueueAutoRemediation(input: {
  violations: unknown;
  /** Which violation type's clock the grace window is measured against (D10). */
  violationType: SoftwarePolicyViolation['type'];
  previousRemediationStatus: string | null;
  lastRemediationAttempt: Date | null;
  now: Date;
  gracePeriodHours: number;
  cooldownMinutes: number;
}): { queue: boolean; reason?: AutoRemediationDeferralReason } {
  if (input.previousRemediationStatus === 'pending' || input.previousRemediationStatus === 'in_progress') {
    return { queue: false, reason: 'in_progress' };
  }

  const earliestDetectedAt = readEarliestViolationDetection(input.violations, input.violationType);
  if (input.gracePeriodHours > 0 && earliestDetectedAt) {
    const graceMs = input.gracePeriodHours * 60 * 60 * 1000;
    if ((input.now.getTime() - earliestDetectedAt.getTime()) < graceMs) {
      return { queue: false, reason: 'grace_period' };
    }
  }

  if (input.lastRemediationAttempt) {
    const cooldownMs = input.cooldownMinutes * 60 * 1000;
    if ((input.now.getTime() - input.lastRemediationAttempt.getTime()) < cooldownMs) {
      return { queue: false, reason: 'cooldown' };
    }
  }

  return { queue: true };
}
```

Add the type import at `softwareComplianceWorker.ts:4`:

```ts
import {
  devices,
  softwareComplianceStatus,
  softwarePolicies,
  type SoftwarePolicyViolation,
} from '../db/schema';
```

And update the sole call site at `:429-436`:

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — inside the uninstall gate
          const remediationDecision = shouldQueueAutoRemediation({
            violations: violationsWithStableTimestamps,
            violationType: 'unauthorized',
            previousRemediationStatus: existing?.remediationStatus ?? null,
            lastRemediationAttempt: existing?.lastRemediationAttempt ?? null,
            now,
            gracePeriodHours: remediationOptions.gracePeriodHours,
            cooldownMinutes: remediationOptions.cooldownMinutes,
          });
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.test.ts
```

Expected: PASS. Confirm the reported file count is **1** and that all 13 pre-existing cases plus the 5 new ones ran.

- [ ] **Step 5: Prove nothing else referenced the old name**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -rn "readEarliestUnauthorizedDetection" apps packages ee 2>/dev/null | grep -v node_modules
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: the grep returns **nothing**, and tsc passes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareComplianceWorker.test.ts
git commit -m "refactor(software): verb-aware grace clock for remediation (#5505 W02, D10)"
```

---

### Task 5: D9 check — pin that `catalogId` on a violation's rule cannot change match behaviour

**Files:**
- Test: `apps/api/src/services/softwarePolicyService.violationFingerprint.test.ts` (create)

**Interfaces:**
- Consumes: `withStableViolationTimestamps` (existing, `softwarePolicyService.ts:113-146`) and W01's `SoftwarePolicyViolation['rule'].catalogId`.
- Produces: nothing at runtime. This is a regression pin.

**Finding (the contract asked W02 to open the code and state what it found, not to assume):** `violationFingerprint` (`softwarePolicyService.ts:99-111`) does **not** compare violation objects structurally. It builds an explicit string key from four named fields — `type` plus, for `missing`, `rule.name` / `rule.minVersion` / `rule.maxVersion` — and ignores every other property of the object. W01's new `rule.catalogId` is therefore invisible to matching, and `withStableViolationTimestamps` returns `{ ...violation, detectedAt }`, so the field survives stabilisation intact. **No fix is needed.** This task pins that, because the grace clock W02 just made verb-aware depends on `missing` violations keeping a stable `detectedAt` across the W01 change — if a future edit folds `catalogId` into the fingerprint, every rule edit would silently reset the install grace window and re-arm a loop the give-up counter is supposed to terminate.

- [ ] **Step 1: Write the test**

```ts
// apps/api/src/services/softwarePolicyService.violationFingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { withStableViolationTimestamps } from './softwarePolicyService';
import type { SoftwarePolicyViolation } from '../db/schema';

/**
 * Contract D9 guard (feature #5505). W01 adds `catalogId` to the `rule` object
 * of an emitted `missing` violation. violationFingerprint keys on
 * type + rule.name + rule.minVersion + rule.maxVersion and NOTHING else, so
 * that addition must not change which stored violation a fresh one matches.
 *
 * Why this matters beyond tidiness: the install grace clock
 * (readEarliestViolationDetection(v, 'missing')) reads detectedAt off the
 * STABILISED violation. If catalogId ever joined the fingerprint, editing a
 * policy rule's catalogId would reset every device's install grace window and
 * restart the attempt budget — re-arming exactly the reinstall loop the
 * give-up counter exists to terminate.
 */
describe('withStableViolationTimestamps — catalogId is not part of the match key (D9)', () => {
  const STORED: SoftwarePolicyViolation[] = [{
    type: 'missing',
    rule: { name: 'Google Chrome', minVersion: '120.0' },
    severity: 'high',
    detectedAt: '2026-09-01T00:00:00.000Z',
  }];

  it('carries the stored detectedAt onto a fresh violation that now also has catalogId', () => {
    const next: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '120.0', catalogId: 'catalog-abc' },
      severity: 'high',
      detectedAt: '2026-09-10T12:00:00.000Z',
    }];

    const stabilized = withStableViolationTimestamps(next, STORED);

    expect(stabilized[0].detectedAt).toBe('2026-09-01T00:00:00.000Z');
    // and the field itself must survive — W03 resolves the install target from it
    expect(stabilized[0].rule?.catalogId).toBe('catalog-abc');
  });

  it('is symmetric: a stored violation WITH catalogId still matches a fresh one without', () => {
    const stored: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '120.0', catalogId: 'catalog-abc' },
      severity: 'high',
      detectedAt: '2026-09-01T00:00:00.000Z',
    }];
    const next: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '120.0' },
      severity: 'high',
      detectedAt: '2026-09-10T12:00:00.000Z',
    }];

    expect(withStableViolationTimestamps(next, stored)[0].detectedAt)
      .toBe('2026-09-01T00:00:00.000Z');
  });

  it('still separates violations that differ in a field the fingerprint DOES read', () => {
    const next: SoftwarePolicyViolation[] = [{
      type: 'missing',
      rule: { name: 'Google Chrome', minVersion: '121.0', catalogId: 'catalog-abc' },
      severity: 'high',
      detectedAt: '2026-09-10T12:00:00.000Z',
    }];

    // minVersion changed, so this is a genuinely different requirement and must
    // start its own clock. Without this control the two cases above would pass
    // against a fingerprint that returned a constant.
    expect(withStableViolationTimestamps(next, STORED)[0].detectedAt)
      .toBe('2026-09-10T12:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyService.violationFingerprint.test.ts
```

Expected: PASS (all three) once W01 is merged. **If the first two fail, `catalogId` HAS entered the fingerprint** — stop and fix `violationFingerprint` to exclude it before continuing; that would be a real behaviour change W01 introduced.

Note on the red step: this task pins existing correct behaviour rather than driving new code, so there is no "watch it fail" moment for cases 1-2. Case 3 is the positive control that makes the pin non-vacuous — temporarily edit `violationFingerprint` to `return type;` and re-run: cases 1-2 still pass while case 3 goes red. Revert the edit before committing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/softwarePolicyService.violationFingerprint.test.ts
git commit -m "test(software): pin that violation catalogId stays out of the stable-timestamp match key (#5505 W02, D9)"
```

---

### Task 6: The install-remediation knobs, resolved per call

**Files:**
- Create: `apps/api/src/services/softwareInstallRemediationKnobs.ts`
- Test: `apps/api/src/services/softwareInstallRemediationKnobs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveInstallRemediationMaxPerPass(): number` and `resolveInstallRemediationMaxAttempts(): number` (contract D5 fixes both names).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/softwareInstallRemediationKnobs.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveInstallRemediationMaxAttempts,
  resolveInstallRemediationMaxPerPass,
} from './softwareInstallRemediationKnobs';

const KEYS = [
  'SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS',
  'SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS',
] as const;

describe('softwareInstallRemediationKnobs', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
    vi.restoreAllMocks();
  });

  it('returns the documented defaults when unset', () => {
    expect(resolveInstallRemediationMaxPerPass()).toBe(50);
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);
  });

  /**
   * THE POINT OF THIS FILE (contract D5). BACKUP_GC_GRACE_MS froze its knob at
   * module load (`export const X = resolveX()`, backupRetention.ts:539), so a
   * lab could set the env var and watch it do nothing. Two calls straddling an
   * env change must disagree; a module-load-cached implementation makes them
   * agree and this case goes red.
   */
  it('re-reads the environment on EVERY call, never caching at module load', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '7';
    expect(resolveInstallRemediationMaxPerPass()).toBe(7);

    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '9';
    expect(resolveInstallRemediationMaxPerPass()).toBe(9);

    delete process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS;
    expect(resolveInstallRemediationMaxPerPass()).toBe(50);
  });

  it('clamps to the floor of 1 in every environment, not just production', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '0';
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '-4';
    expect(resolveInstallRemediationMaxPerPass()).toBe(1);
    expect(resolveInstallRemediationMaxAttempts()).toBe(1);
  });

  it('falls back to the default for non-numeric, blank and fractional-below-floor input', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = 'three';
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);

    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '   ';
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);

    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = 'Infinity';
    expect(resolveInstallRemediationMaxAttempts()).toBe(3);
  });

  it('floors a fractional override rather than carrying a fraction into a counter comparison', () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '2.9';
    expect(resolveInstallRemediationMaxAttempts()).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwareInstallRemediationKnobs.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/softwareInstallRemediationKnobs.ts
/**
 * Env knobs for install remediation (feature #5505, contract D5).
 *
 * RESOLVED PER CALL, DELIBERATELY. Do NOT hoist any of these into
 * `export const X = resolveX()`: that is the defect BACKUP_GC_GRACE_MS shipped
 * (apps/api/src/jobs/backupRetention.ts:539), where the value froze at module
 * load and an operator setting the variable saw no effect at all. Both
 * resolvers below are cheap (one process.env read plus a Number cast) and run
 * at most twice per compliance pass, so there is nothing to optimise.
 *
 * FLOORS APPLY IN EVERY ENVIRONMENT, unlike BACKUP_GC_GRACE_MS's
 * production-only floor. A value below 1 is not a "risky but valid lab
 * setting" for either knob — it is a silent feature kill: 0 installs per pass
 * means the feature appears armed and never acts, and 0 attempts means every
 * device goes straight to 'gave_up'. Both would look like a product bug, not a
 * configuration choice, so they are clamped everywhere.
 */

const MAX_PER_PASS_ENV = 'SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS';
const MAX_PER_PASS_DEFAULT = 50;

const MAX_ATTEMPTS_ENV = 'SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS';
const MAX_ATTEMPTS_DEFAULT = 3;

const KNOB_FLOOR = 1;

function resolveCountKnob(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === '') return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[SoftwareInstallRemediation] Ignoring ${envKey}=${JSON.stringify(raw)} (not a finite number); using default ${defaultValue}`,
    );
    return defaultValue;
  }

  const floored = Math.floor(parsed);
  if (floored < KNOB_FLOOR) {
    console.warn(
      `[SoftwareInstallRemediation] ${envKey}=${parsed} is below the floor of ${KNOB_FLOOR}; using ${KNOB_FLOOR} instead`,
    );
    return KNOB_FLOOR;
  }

  if (floored !== defaultValue) {
    console.warn(`[SoftwareInstallRemediation] ${envKey} override active: ${floored} (default ${defaultValue})`);
  }
  return floored;
}

/**
 * Maximum install jobs queued for ONE policy in ONE compliance pass.
 *
 * Spec Risks §2: arming autoInstall on an existing broad policy could otherwise
 * queue thousands of installs in a single 15-minute pass. Devices over the cap
 * are recorded 'skipped' and picked up by the next pass — they are deferred,
 * never dropped, and never burn an attempt from the give-up budget.
 */
export function resolveInstallRemediationMaxPerPass(): number {
  return resolveCountKnob(MAX_PER_PASS_ENV, MAX_PER_PASS_DEFAULT);
}

/**
 * CONSECUTIVE install attempts for one (policy, device) before giving up.
 *
 * Spec Risks §1: a policy whose rule never matches what the installer registers
 * in Add/Remove Programs re-detects `missing` forever. Grace and cooldown bound
 * the rate of that loop but do not stop it; this counter does, by writing
 * install_remediation_status = 'gave_up'. The counter resets to 0 the moment
 * the device has no `missing` violation left for that policy.
 */
export function resolveInstallRemediationMaxAttempts(): number {
  return resolveCountKnob(MAX_ATTEMPTS_ENV, MAX_ATTEMPTS_DEFAULT);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/services/softwareInstallRemediationKnobs.test.ts
```

Expected: PASS, 6 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/softwareInstallRemediationKnobs.ts apps/api/src/services/softwareInstallRemediationKnobs.test.ts
git commit -m "feat(software): per-call install remediation env knobs (#5505 W02, D5)"
```

---

### Task 7: D11 — the worker delegates arming to the shared helper for both verbs

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts:136-162` (drop `autoUninstallEnabled`), `:361-369` (pass preamble), `:423-427` (the gate)
- Test: `apps/api/src/jobs/softwareComplianceWorker.install.test.ts` (create — the divergence guard lives here)

**Interfaces:**
- Consumes (from W01, exact names): `evaluateSoftwarePolicyArming(policy: SoftwarePolicyArmingInput, verb: PolicyRemediationVerb): SoftwarePolicyArmingState`, `type PolicyRemediationVerb = 'uninstall' | 'install'`.
- Produces: the worker's `uninstallArming` / `installArming` per-pass values; no new exports.

**Before starting, confirm W01's actual export names:**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n "PolicyRemediationVerb\|evaluateSoftwarePolicyArming\|readSoftwarePolicyAutoInstall\|install_queued\|install_gave_up" apps/api/src/services/softwarePolicyService.ts
```

`PolicyRemediationVerb`, `evaluateSoftwarePolicyArming(policy, verb)` and `readSoftwarePolicyAutoInstall` are locked by contract D2 and must match exactly. The **audit-action constant's export identifier** is not locked (D6 fixes only the four string VALUES and leaves W01 to name the object) — this plan writes `SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS` with fields `.queued`, `.succeeded`, `.failed`, `.gaveUp`. If W01 shipped a different identifier or field names, use W01's; the values `install_queued` / `install_gave_up` are non-negotiable.

- [ ] **Step 1: Write the failing divergence test**

```ts
// apps/api/src/jobs/softwareComplianceWorker.install.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  dbSelectMock,
  dbUpdateMock,
  resolveDeviceIdsMock,
  armingMock,
  upsertMock,
  inventoryMock,
  scheduleUninstallMock,
  scheduleInstallMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  resolveDeviceIdsMock: vi.fn(async () => ['device-1']),
  armingMock: vi.fn(() => ({ armed: true as const })),
  upsertMock: vi.fn(async () => undefined),
  inventoryMock: vi.fn(async () => new Map<string, unknown[]>([['device-1', []]])),
  scheduleUninstallMock: vi.fn(async () => 0),
  scheduleInstallMock: vi.fn(async () => [] as string[]),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = addMock; addBulk = vi.fn(); getRepeatableJobs = vi.fn(async () => []); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../db', () => ({
  db: { select: dbSelectMock, update: dbUpdateMock },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../services/featureConfigResolver', () => ({
  resolveDeviceIdsForSoftwarePolicy: resolveDeviceIdsMock,
}));
vi.mock('./softwareRemediationWorker', () => ({
  scheduleSoftwareRemediation: scheduleUninstallMock,
  scheduleSoftwareInstallRemediation: scheduleInstallMock,
}));
vi.mock('../services/softwarePolicyService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/softwarePolicyService')>();
  return {
    ...actual,
    evaluateSoftwarePolicyArming: armingMock,
    upsertSoftwareComplianceStatuses: upsertMock,
    getSoftwareInventoryByDeviceIds: inventoryMock,
    recordSoftwarePolicyAudit: vi.fn(async () => undefined),
  };
});

import { processCheckPolicy } from './softwareComplianceWorker';

const POLICY_ID = 'policy-1';

/**
 * A policy that is armed for BOTH verbs by every inline criterion the worker
 * used to check for itself: mode allowlist, enforceMode true, autoUninstall
 * true, autoInstall true.
 */
const FULLY_ARMED_POLICY = {
  id: POLICY_ID,
  orgId: 'org-1',
  partnerId: null,
  isActive: true,
  approvalGeneration: 1,
  mode: 'allowlist',
  enforceMode: true,
  remediationOptions: { autoUninstall: true, autoInstall: true },
  rules: { software: [{ name: 'Google Chrome', catalogId: 'catalog-abc' }] },
};

/** FIFO for db.select(): policy reload → devices(orgByDevice) → compliance state. */
function primeSelects(rows: unknown[][]) {
  for (const result of rows) {
    dbSelectMock.mockReturnValueOnce({
      from: () => ({
        where: Object.assign(
          () => ({ limit: () => Promise.resolve(result) }),
          { then: (r: (v: unknown) => void) => r(result) },
        ),
        limit: () => Promise.resolve(result),
      }),
    });
  }
}

function primeStandardPass() {
  primeSelects([
    [FULLY_ARMED_POLICY],                                   // policy reload
    [{ id: 'device-1', orgId: 'org-1' }],                   // orgByDevice
    [],                                                     // readComplianceStateByDevice
  ]);
  inventoryMock.mockResolvedValueOnce(new Map([['device-1', []]]));
}

describe('processCheckPolicy — arming comes from the shared helper only (contract D11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armingMock.mockReturnValue({ armed: true });
    scheduleUninstallMock.mockResolvedValue(0);
    scheduleInstallMock.mockResolvedValue([]);
  });

  it('asks evaluateSoftwarePolicyArming for BOTH verbs, once each', async () => {
    primeStandardPass();

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const verbs = armingMock.mock.calls.map((call) => call[1]);
    expect(verbs).toContain('uninstall');
    expect(verbs).toContain('install');
  });

  /**
   * THE DIVERGENCE GUARD. The policy row below satisfies every criterion the
   * worker's old inline gate checked (softwareComplianceWorker.ts:423-427), but
   * the shared helper says NOT ARMED. If the worker re-derives arming for
   * itself — today, or after some future edit re-inlines it — it queues anyway
   * and this fails. There is exactly one arming truth.
   */
  it('queues NOTHING when the shared helper says unarmed, even on a policy the old inline gate would have passed', async () => {
    armingMock.mockReturnValue({
      armed: false,
      reason: 'enforce_mode_off',
      message: 'test double: unarmed',
    });
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Some Unapproved App', version: '1.0', vendor: 'Acme', catalogId: null },
    ]]]));

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(result.violations).toBeGreaterThan(0);        // it DID detect
    expect(scheduleUninstallMock).not.toHaveBeenCalled(); // and refused to act
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.install.test.ts
```

Expected: FAIL on both cases — `armingMock` is never called (the worker derives inline), and `scheduleSoftwareInstallRemediation` is not yet an export of `./softwareRemediationWorker` (that arrives in Task 8; the mock factory declaring it is harmless).

- [ ] **Step 3: Drop the duplicate derivation from `readRemediationOptions`**

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — replacing :136-162
/**
 * Timing options only. `autoUninstall` used to be read here as
 * `autoUninstallEnabled`, which meant the worker carried its own copy of the
 * arming rule alongside evaluateSoftwarePolicyArming — the duplication that let
 * the two drift (contract D11). Arming now comes exclusively from that helper;
 * this function answers only "how long to wait", never "may we act".
 */
function readRemediationOptions(raw: unknown): {
  gracePeriodHours: number;
  cooldownMinutes: number;
} {
  if (!raw || typeof raw !== 'object') {
    return {
      gracePeriodHours: 0,
      cooldownMinutes: REMEDIATION_COOLDOWN_DEFAULT_MINUTES,
    };
  }

  const options = raw as Record<string, unknown>;
  const gracePeriodHours = typeof options.gracePeriod === 'number'
    ? Math.max(0, Math.min(24 * 90, Math.floor(options.gracePeriod)))
    : 0;
  const cooldownMinutes = typeof options.cooldownMinutes === 'number'
    ? Math.max(1, Math.min(24 * 90 * 60, Math.floor(options.cooldownMinutes)))
    : REMEDIATION_COOLDOWN_DEFAULT_MINUTES;

  return {
    gracePeriodHours,
    cooldownMinutes,
  };
}
```

- [ ] **Step 4: Evaluate arming once per pass and use it in the gate**

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — in the pass preamble, replacing :361-362
  const normalizedRules = normalizeSoftwarePolicyRules(policy.rules);
  const remediationOptions = readRemediationOptions(policy.remediationOptions);
  // Contract D11: ONE arming truth, shared with softwareRemediationWorker.ts and
  // the AI compliance tool. Evaluated once per pass — the policy row cannot
  // change mid-loop, and the generation gate at :311 already refused a job whose
  // policy was edited after enqueue.
  const uninstallArming = evaluateSoftwarePolicyArming(policy, 'uninstall');
  const installArming = evaluateSoftwarePolicyArming(policy, 'install');
```

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — replacing the gate at :423-427
        // Two INDEPENDENT gates over the same violation set (spec §2). A policy
        // may arm both, one, or neither, and a device may be queued for both
        // verbs in one pass — removing an unauthorised app and installing a
        // required one are not in conflict.
        if (
          uninstallArming.armed
          && violationsWithStableTimestamps.some((violation) => violation.type === 'unauthorized')
        ) {
```

Add the import at `softwareComplianceWorker.ts:11-20`:

```ts
import {
  evaluateSoftwarePolicyAgainstInventory,
  evaluateSoftwarePolicyArming,
  getSoftwareInventoryByDeviceIds,
  normalizeSoftwarePolicyRules,
  recordSoftwarePolicyAudit,
  upsertSoftwareComplianceStatuses,
  withStableViolationTimestamps,
  type SoftwarePolicyComplianceStatus,
  type SoftwarePolicyRemediationStatus,
} from '../services/softwarePolicyService';
```

**Equivalence note for the reviewer:** the removed inline gate was `policy.enforceMode && policy.mode !== 'audit' && remediationOptions.autoUninstallEnabled`. `enforceMode` is `boolean NOT NULL` (`softwarePolicies.ts:94`), so `policy.enforceMode &&` and the helper's `policy.enforceMode !== true` agree on every possible value; `mode !== 'audit'` and the helper's `mode === 'audit'` early-return agree; `options.autoUninstall === true` is character-for-character the helper's `readSoftwarePolicyAutoUninstall`. The replacement is behaviour-preserving for uninstall.

- [ ] **Step 5: Run the tests**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.install.test.ts src/jobs/softwareComplianceWorker.test.ts
```

Expected: the divergence case and the "asks for both verbs" case PASS; `softwareComplianceWorker.test.ts` stays green (2 files reported). The install-scheduling half is still absent — that is Task 8/9.

- [ ] **Step 6: Typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareComplianceWorker.install.test.ts
git commit -m "refactor(software): compliance worker delegates arming to the shared helper for both verbs (#5505 W02, D11)"
```

---

### Task 8: `decideInstallRemediation` — the pure install gate

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts` (new exported function, placed immediately after `shouldQueueAutoRemediation`)
- Test: `apps/api/src/jobs/softwareComplianceWorker.install.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `shouldQueueAutoRemediation` + `AutoRemediationDeferralReason` (Task 4), `SoftwarePolicyInstallRemediationStatus` (Task 3), `SoftwarePolicyViolation['rule'].catalogId` (W01).
- Produces:
  - `export type InstallRemediationSkipReason = AutoRemediationDeferralReason | 'no_missing_violations' | 'no_catalog_id' | 'attempts_exhausted' | 'pass_cap';`
  - `export type InstallRemediationDecision = { queue: true; catalogIds: string[]; attempt: number } | { queue: false; reason: InstallRemediationSkipReason };`
  - `export function decideInstallRemediation(input): InstallRemediationDecision;`
  - `export function installStatusForSkip(reason: InstallRemediationSkipReason): SoftwarePolicyInstallRemediationStatus | undefined;`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/jobs/softwareComplianceWorker.install.test.ts — append at end of file
import { decideInstallRemediation, installStatusForSkip } from './softwareComplianceWorker';
import type { SoftwarePolicyViolation } from '../db/schema';

const DECIDE_NOW = new Date('2026-09-10T12:00:00.000Z');

function missing(catalogId?: string, detectedAt = '2026-01-01T00:00:00.000Z'): SoftwarePolicyViolation {
  return {
    type: 'missing',
    rule: { name: 'Google Chrome', ...(catalogId ? { catalogId } : {}) },
    severity: 'high',
    detectedAt,
  };
}

function unauthorized(detectedAt = '2026-01-01T00:00:00.000Z'): SoftwarePolicyViolation {
  return {
    type: 'unauthorized',
    software: { name: 'Bad App', version: '1.0', vendor: 'Acme' },
    severity: 'medium',
    detectedAt,
  };
}

function decideWith(overrides: Partial<Parameters<typeof decideInstallRemediation>[0]> = {}) {
  return decideInstallRemediation({
    violations: [missing('catalog-abc')],
    previousInstallStatus: null,
    lastInstallAttempt: null,
    attempts: 0,
    now: DECIDE_NOW,
    gracePeriodHours: 0,
    cooldownMinutes: 120,
    maxAttempts: 3,
    capRemaining: 10,
    ...overrides,
  });
}

describe('decideInstallRemediation', () => {
  it('queues with the deduped catalog ids and a 1-based attempt number', () => {
    expect(decideWith({
      violations: [missing('catalog-abc'), missing('catalog-def'), missing('catalog-abc')],
    })).toEqual({ queue: true, catalogIds: ['catalog-abc', 'catalog-def'], attempt: 1 });
  });

  it('reports the next attempt number from the stored counter', () => {
    expect(decideWith({ attempts: 2, maxAttempts: 5 }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 3 });
  });

  it('ignores unauthorized violations entirely', () => {
    expect(decideWith({ violations: [unauthorized()] }))
      .toEqual({ queue: false, reason: 'no_missing_violations' });
  });

  it('refuses a missing violation whose rule carries no catalogId', () => {
    expect(decideWith({ violations: [missing()] }))
      .toEqual({ queue: false, reason: 'no_catalog_id' });
  });

  it('ignores blank and whitespace-only catalog ids', () => {
    expect(decideWith({ violations: [missing('   ')] }))
      .toEqual({ queue: false, reason: 'no_catalog_id' });
  });

  it('still queues when SOME missing rules have a catalogId and others do not', () => {
    expect(decideWith({ violations: [missing(), missing('catalog-abc')] }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 1 });
  });

  it('gives up once the consecutive counter reaches maxAttempts', () => {
    expect(decideWith({ attempts: 3, maxAttempts: 3 }))
      .toEqual({ queue: false, reason: 'attempts_exhausted' });
  });

  it('gives up on a counter that somehow exceeded maxAttempts', () => {
    expect(decideWith({ attempts: 99, maxAttempts: 3 }))
      .toEqual({ queue: false, reason: 'attempts_exhausted' });
  });

  // Ordering: attempts BEFORE timing, so an exhausted device reports the honest
  // terminal reason instead of hiding behind an incidental cooldown.
  it('reports attempts_exhausted rather than cooldown when both apply', () => {
    expect(decideWith({
      attempts: 3,
      maxAttempts: 3,
      lastInstallAttempt: new Date(DECIDE_NOW.getTime() - 60_000),
    })).toEqual({ queue: false, reason: 'attempts_exhausted' });
  });

  it('defers while an install is already pending', () => {
    expect(decideWith({ previousInstallStatus: 'pending' }))
      .toEqual({ queue: false, reason: 'in_progress' });
  });

  it('defers inside the grace window, measured on the MISSING clock', () => {
    expect(decideWith({
      violations: [missing('catalog-abc', '2026-09-10T11:00:00.000Z')],
      gracePeriodHours: 24,
    })).toEqual({ queue: false, reason: 'grace_period' });
  });

  it('defers inside the cooldown window', () => {
    expect(decideWith({
      lastInstallAttempt: new Date(DECIDE_NOW.getTime() - 60 * 1000),
      cooldownMinutes: 120,
    })).toEqual({ queue: false, reason: 'cooldown' });
  });

  // Ordering: cap LAST, so the pass budget is only consumed by devices that
  // would genuinely have queued. Checking it first would let devices already in
  // cooldown eat the cap and starve devices that are actually ready.
  it('applies the per-pass cap only after every other gate has passed', () => {
    expect(decideWith({ capRemaining: 0 }))
      .toEqual({ queue: false, reason: 'pass_cap' });

    expect(decideWith({ capRemaining: 0, previousInstallStatus: 'in_progress' }))
      .toEqual({ queue: false, reason: 'in_progress' });
  });

  it('treats a negative or non-finite stored counter as zero rather than throwing', () => {
    expect(decideWith({ attempts: -5 }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 1 });
    expect(decideWith({ attempts: Number.NaN }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 1 });
  });
});

describe('installStatusForSkip', () => {
  it('records a terminal give-up', () => {
    expect(installStatusForSkip('attempts_exhausted')).toBe('gave_up');
  });

  it('records the two "nothing attempted, nothing wrong with the device" cases as skipped', () => {
    expect(installStatusForSkip('no_catalog_id')).toBe('skipped');
    expect(installStatusForSkip('pass_cap')).toBe('skipped');
  });

  // Timing deferrals write NOTHING, mirroring the uninstall path: a device in
  // grace or cooldown has no new status to report, and overwriting a live
  // 'pending' with 'skipped' would tell a technician the install was abandoned.
  it('writes no status for a timing deferral or a device with nothing missing', () => {
    expect(installStatusForSkip('in_progress')).toBeUndefined();
    expect(installStatusForSkip('grace_period')).toBeUndefined();
    expect(installStatusForSkip('cooldown')).toBeUndefined();
    expect(installStatusForSkip('no_missing_violations')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.install.test.ts
```

Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — immediately after shouldQueueAutoRemediation

/** Why an install was not queued for a device on this pass. */
export type InstallRemediationSkipReason =
  | AutoRemediationDeferralReason
  | 'no_missing_violations'
  | 'no_catalog_id'
  | 'attempts_exhausted'
  | 'pass_cap';

export type InstallRemediationDecision =
  | { queue: true; catalogIds: string[]; attempt: number }
  | { queue: false; reason: InstallRemediationSkipReason };

/**
 * The whole install gate for one device, as a pure function (feature #5505 W02).
 *
 * GATE ORDER IS DELIBERATE and is the part most worth reading twice:
 *
 *  1. `missing` violations at all? A device whose only violations are
 *     `unauthorized` is not an install candidate — the uninstall verb owns it.
 *  2. Any of them carry a catalogId? A rule without one can be DETECTED as
 *     missing but cannot be installed: there is nothing to install. Spec §4
 *     requires the worker to skip it and say so rather than fail silently, so
 *     this maps to a visible 'skipped'. Checked before the timing gates because
 *     it is a policy-authoring defect the technician has to see now, not in two
 *     hours when the cooldown lapses.
 *  3. Consecutive attempts exhausted? Checked BEFORE grace/cooldown so an
 *     exhausted device reports the honest terminal reason ('gave_up') instead
 *     of disappearing behind an incidental cooldown. This is the terminator for
 *     spec Risks §1: a policy whose rule never matches what the installer
 *     registers in Add/Remove Programs would otherwise reinstall forever.
 *  4. Timing (in_progress / grace / cooldown), via the SAME
 *     shouldQueueAutoRemediation the uninstall verb uses, with the grace clock
 *     pointed at the `missing` violations (contract D10).
 *  5. Per-pass cap LAST. The cap must only be consumed by devices that would
 *     genuinely have queued; checking it earlier would let devices sitting in
 *     cooldown eat the budget and starve devices that are actually ready.
 *
 * Pure and total: no I/O, no clock read, no env read. Every input is supplied
 * by the caller so the whole matrix is testable without a database.
 */
export function decideInstallRemediation(input: {
  violations: SoftwarePolicyViolation[];
  previousInstallStatus: string | null;
  lastInstallAttempt: Date | null;
  attempts: number;
  now: Date;
  gracePeriodHours: number;
  cooldownMinutes: number;
  maxAttempts: number;
  capRemaining: number;
}): InstallRemediationDecision {
  const missingViolations = input.violations.filter(
    (violation) => !!violation && violation.type === 'missing'
  );
  if (missingViolations.length === 0) {
    return { queue: false, reason: 'no_missing_violations' };
  }

  const catalogIds: string[] = [];
  for (const violation of missingViolations) {
    const raw = violation.rule?.catalogId;
    if (typeof raw !== 'string') continue;
    const catalogId = raw.trim();
    if (catalogId.length === 0) continue;
    if (!catalogIds.includes(catalogId)) catalogIds.push(catalogId);
  }
  if (catalogIds.length === 0) {
    return { queue: false, reason: 'no_catalog_id' };
  }

  const attempts = Number.isFinite(input.attempts) ? Math.max(0, Math.floor(input.attempts)) : 0;
  if (attempts >= input.maxAttempts) {
    return { queue: false, reason: 'attempts_exhausted' };
  }

  const timing = shouldQueueAutoRemediation({
    violations: input.violations,
    violationType: 'missing',
    previousRemediationStatus: input.previousInstallStatus,
    lastRemediationAttempt: input.lastInstallAttempt,
    now: input.now,
    gracePeriodHours: input.gracePeriodHours,
    cooldownMinutes: input.cooldownMinutes,
  });
  if (!timing.queue && timing.reason) {
    return { queue: false, reason: timing.reason };
  }

  if (input.capRemaining <= 0) {
    return { queue: false, reason: 'pass_cap' };
  }

  return { queue: true, catalogIds, attempt: attempts + 1 };
}

/**
 * What (if anything) a skip should write to install_remediation_status.
 *
 * Timing deferrals write NOTHING, mirroring the uninstall path: a device inside
 * grace or cooldown has no new status to report, and overwriting a live
 * 'pending' with 'skipped' would tell a technician Breeze abandoned an install
 * that is in fact still in flight.
 */
export function installStatusForSkip(
  reason: InstallRemediationSkipReason
): SoftwarePolicyInstallRemediationStatus | undefined {
  if (reason === 'attempts_exhausted') return 'gave_up';
  if (reason === 'no_catalog_id' || reason === 'pass_cap') return 'skipped';
  return undefined;
}
```

Add `type SoftwarePolicyInstallRemediationStatus` to the `softwarePolicyService` import block edited in Task 7 Step 4.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.install.test.ts
```

Expected: PASS, 18 cases across the three describe blocks.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareComplianceWorker.install.test.ts
git commit -m "feat(software): pure install remediation gate with per-pass cap and give-up counter (#5505 W02)"
```

---

### Task 9: The install-remediation job payload and its producer

**Files:**
- Modify: `apps/api/src/jobs/softwareRemediationWorker.ts:56-74` (types), `:601-620` (processor), and append the producer after `scheduleSoftwareRemediation` (`:792`)
- Test: `apps/api/src/jobs/softwareRemediationWorker.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `getSoftwareRemediationQueue()` (`softwareRemediationWorker.ts:148`), `isReusableState` (`services/bullmqUtils`), `recordSoftwareRemediationDecision` (`routes/metrics`) — all already imported in that file.
- Produces, and **W03 consumes these exact names**:

```ts
export type InstallRemediateDeviceJobData = {
  type: 'install-remediate-device';
  policyId: string;
  deviceId: string;
  /** Catalog item ids to install, deduped, in rule order. NEVER empty. */
  catalogIds: string[];
  /** policy.approval_generation at enqueue time (site-ceiling gate contract §3). */
  generation: number;
  /** 1-based consecutive attempt this job represents. Observability only — the
   *  DB counter incremented by the compliance worker is authoritative. */
  attempt: number;
};

export type SoftwareRemediationJobData = RemediateDeviceJobData | InstallRemediateDeviceJobData;

export type InstallRemediationTarget = {
  deviceId: string;
  catalogIds: string[];
  attempt: number;
};

export async function scheduleSoftwareInstallRemediation(
  policyId: string,
  targets: InstallRemediationTarget[],
  generation: number
): Promise<string[]>; // the deviceIds actually enqueued, in input order
```

**Decision, stated as the contract requires: a SIBLING TYPE, not a widened `RemediateDeviceJobData`.** Three reasons, in order of weight:

1. **JobId collision.** The uninstall auto path keys on `software-remediation-${policyId}-${deviceId}` (`:757`). The spec explicitly requires that a device may be queued for both verbs in one pass. A widened type sharing that key would silently dedupe one verb into the other — the install job would be discarded as a duplicate of the uninstall job, or vice versa, with `isReusableState` reporting a clean `job_deduped`. The sibling gets `software-install-remediation-${policyId}-${deviceId}`.
2. **`processRemediateDevice` is uninstall-specific end to end** — it consumes a single-use manual-authorization row (`:308-316`), selects `unauthorized` violations, queues `SOFTWARE_UNINSTALL`, and writes the `remediation_status` column. Routing a second verb through it would put install traffic through the #3543/#3553 manual-override machinery, where a forged `trigger:'manual'` on an install job could consume an uninstall authorization. A separate `type` keeps that boundary intact by construction.
3. `SoftwareRemediationJobData` is already a type alias at `:74` waiting to become a discriminated union, and `SoftwareComplianceJobData` in the sibling worker (`softwareComplianceWorker.ts:233`) is already exactly that shape. This is the house pattern.

`RemediateDeviceJobData` itself stays **unexported and unchanged**.

**Why the type lives in `softwareRemediationWorker.ts` rather than a new file:** it is the producer half of the same BullMQ queue, and that file already owns the queue instance (`:148`), the union type (`:74`) and the jobId namespace. A separate module would have to import `getSoftwareRemediationQueue` while the worker imports the payload type back — a runtime import cycle for no benefit. The file grows ~75 lines; W03's processor goes in its own new file, which is where the bulk actually is.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/jobs/softwareRemediationWorker.test.ts — append at end of file
describe('scheduleSoftwareInstallRemediation (feature #5505 W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
  });

  it('enqueues one job per target with the full payload and returns the enqueued deviceIds', async () => {
    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [
        { deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 },
        { deviceId: 'device-2', catalogIds: ['catalog-abc', 'catalog-def'], attempt: 2 },
      ],
      7,
    );

    expect(enqueued).toEqual(['device-1', 'device-2']);
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock.mock.calls[1][0]).toBe('install-remediate-device');
    expect(addMock.mock.calls[1][1]).toEqual({
      type: 'install-remediate-device',
      policyId: 'policy-1',
      deviceId: 'device-2',
      catalogIds: ['catalog-abc', 'catalog-def'],
      generation: 7,
      attempt: 2,
    });
  });

  /**
   * The reason this is a sibling type and not a widened RemediateDeviceJobData:
   * a device may legitimately be queued for BOTH verbs in one compliance pass
   * (spec §2), and a shared jobId would make one silently dedupe into the other.
   */
  it('uses a jobId namespace disjoint from the uninstall path', async () => {
    await scheduleSoftwareInstallRemediation(
      'policy-1',
      [{ deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 }],
      1,
    );

    const installJobId = addMock.mock.calls[0][2].jobId as string;
    expect(installJobId).toBe('software-install-remediation-policy-1-device-1');
    expect(installJobId).not.toBe('software-remediation-policy-1-device-1');
  });

  it('dedupes against a reusable in-flight job instead of enqueuing a second', async () => {
    getJobMock.mockResolvedValue({ getState: async () => 'waiting', remove: vi.fn() });

    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [{ deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 }],
      1,
    );

    expect(enqueued).toEqual([]);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('refuses a target with no usable catalogIds rather than shipping an empty payload', async () => {
    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [
        { deviceId: 'device-1', catalogIds: [], attempt: 1 },
        { deviceId: 'device-2', catalogIds: ['  '], attempt: 1 },
        { deviceId: '', catalogIds: ['catalog-abc'], attempt: 1 },
      ],
      1,
    );

    expect(enqueued).toEqual([]);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('deduplicates repeated deviceIds and repeated catalogIds', async () => {
    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [
        { deviceId: 'device-1', catalogIds: ['catalog-abc', 'catalog-abc'], attempt: 1 },
        { deviceId: 'device-1', catalogIds: ['catalog-def'], attempt: 1 },
      ],
      1,
    );

    expect(enqueued).toEqual(['device-1']);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect((addMock.mock.calls[0][1] as { catalogIds: string[] }).catalogIds).toEqual(['catalog-abc']);
  });
});
```

Add `scheduleSoftwareInstallRemediation` to that file's import block. If the existing rig has no `getJobMock`/`addMock` on its BullMQ `Queue` double, add them there first (`Queue: class { add = addMock; getJob = getJobMock; }` inside the existing `vi.mock('bullmq', ...)` factory, both declared in the file's `vi.hoisted` block).

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/softwareRemediationWorker.test.ts
```

Expected: FAIL — `scheduleSoftwareInstallRemediation` is not exported.

- [ ] **Step 3: Add the payload type and the union**

```ts
// apps/api/src/jobs/softwareRemediationWorker.ts — replacing :74
/**
 * Install remediation (feature #5505). A SIBLING type, deliberately not a
 * widened RemediateDeviceJobData:
 *
 *  - The uninstall auto path keys its BullMQ jobId on
 *    `software-remediation-${policyId}-${deviceId}`. A device may legitimately
 *    be queued for BOTH verbs in one compliance pass (spec §2) — removing an
 *    unauthorised app and installing a required one are not in conflict — so a
 *    shared key would silently dedupe one verb into the other.
 *  - processRemediateDevice is uninstall-specific end to end: it consumes a
 *    single-use manual-authorization row (#3553), selects `unauthorized`
 *    violations and writes the remediation_status column. Install traffic must
 *    not travel through that machinery, where a forged trigger:'manual' could
 *    consume an uninstall authorization.
 *
 * W02 (#5507) DEFINES this payload and produces it; W03 (#5508) consumes it and
 * replaces the parking branch in createSoftwareRemediationWorker below.
 */
export type InstallRemediateDeviceJobData = {
  type: 'install-remediate-device';
  policyId: string;
  deviceId: string;
  /**
   * Catalog item ids to install, deduped, in rule order. NEVER empty —
   * scheduleSoftwareInstallRemediation refuses a target that would produce an
   * empty list, because a deployment with no install target cannot satisfy
   * software_deployments_one_target_chk.
   */
  catalogIds: string[];
  /**
   * policy.approval_generation at enqueue time (site-ceiling gate contract §3).
   * W03 re-reads the policy and skips a job whose premise was edited away.
   */
  generation: number;
  /**
   * 1-based consecutive attempt this job represents, for the audit trail.
   * OBSERVABILITY ONLY: software_compliance_status.install_remediation_attempts,
   * incremented in SQL by the compliance worker, is authoritative.
   */
  attempt: number;
};

type SoftwareRemediationJobData = RemediateDeviceJobData | InstallRemediateDeviceJobData;
```

- [ ] **Step 4: Add the producer**

```ts
// apps/api/src/jobs/softwareRemediationWorker.ts — append after scheduleSoftwareRemediation (:792)

export type InstallRemediationTarget = {
  deviceId: string;
  catalogIds: string[];
  attempt: number;
};

/**
 * Enqueue install remediation for a batch of devices under one policy.
 *
 * Returns THE DEVICE IDS ACTUALLY ENQUEUED, not a count. The uninstall sibling
 * returns a count, and its caller (softwareComplianceWorker.ts:486) then stamps
 * remediationStatus:'pending' on every target whenever that count is > 0 —
 * including devices that deduped and got no job. That inaccuracy predates this
 * feature and is out of scope to fix here, but it must not be replicated: an
 * install row wrongly left at 'pending' blocks its own next pass (pending reads
 * as in_progress) and would strand the device.
 */
export async function scheduleSoftwareInstallRemediation(
  policyId: string,
  targets: InstallRemediationTarget[],
  generation: number
): Promise<string[]> {
  const queue = getSoftwareRemediationQueue();
  const enqueued: string[] = [];
  const seenDeviceIds = new Set<string>();

  for (const target of targets) {
    if (typeof target.deviceId !== 'string' || target.deviceId.length === 0) continue;
    if (seenDeviceIds.has(target.deviceId)) continue;
    seenDeviceIds.add(target.deviceId);

    const catalogIds: string[] = [];
    for (const raw of target.catalogIds ?? []) {
      if (typeof raw !== 'string') continue;
      const catalogId = raw.trim();
      if (catalogId.length === 0) continue;
      if (!catalogIds.includes(catalogId)) catalogIds.push(catalogId);
    }
    // A target with nothing to install is a caller bug, not a queueable job:
    // W03 would try to create a deployment with neither software_version_id nor
    // install_method_id and abort on software_deployments_one_target_chk.
    // Refuse it here rather than shipping an empty payload into Redis.
    if (catalogIds.length === 0) {
      console.warn('[SoftwareRemediationWorker] Install target has no usable catalogIds, skipping', {
        policyId,
        deviceId: target.deviceId,
      });
      recordSoftwareRemediationDecision('install_no_catalog_id');
      continue;
    }

    // Its OWN jobId namespace — see InstallRemediateDeviceJobData's docstring.
    const jobId = `software-install-remediation-${policyId}-${target.deviceId}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (isReusableState(state)) {
        recordSoftwareRemediationDecision('install_job_deduped');
        continue;
      }
      await existing.remove().catch((err) => {
        console.warn('[SoftwareRemediationWorker] Failed to remove stale install job (non-fatal):', { jobId, error: err });
      });
    }

    await queue.add(
      'install-remediate-device',
      {
        type: 'install-remediate-device' as const,
        policyId,
        deviceId: target.deviceId,
        catalogIds,
        generation,
        attempt: target.attempt,
      },
      {
        jobId,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      }
    );
    enqueued.push(target.deviceId);
  }

  return enqueued;
}
```

- [ ] **Step 5: Park the new job type in the processor until W03 lands**

```ts
// apps/api/src/jobs/softwareRemediationWorker.ts — replacing the processor body at :604-608
    async (job: Job<SoftwareRemediationJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'install-remediate-device') {
          // W03 (#5508) installs the real install processor here.
          //
          // Until it lands this job is PARKED, never routed to
          // processRemediateDevice: that function is uninstall-specific end to
          // end (manual-authorization consumption, unauthorized-violation
          // selection, remediation_status writes) and would misread install job
          // data. Parking is the safe intermediate state, not a leak: the
          // compliance row stays at 'pending', which
          // shouldQueueAutoRemediation reads as in_progress, so the device is
          // queued exactly ONCE and no reinstall loop can form. W03 replaces
          // this branch and clears those rows on its first pass.
          console.warn(
            '[SoftwareRemediationWorker] install-remediate-device received but no processor is installed yet (feature #5505 W03) — parking',
            { policyId: job.data.policyId, deviceId: job.data.deviceId, catalogIds: job.data.catalogIds }
          );
          recordSoftwareRemediationDecision('install_processor_unavailable');
          return {
            policyId: job.data.policyId,
            deviceId: job.data.deviceId,
            commandsQueued: 0,
            errors: 0,
          };
        }
        return processRemediateDevice(job.data);
      });
    },
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/jobs/softwareRemediationWorker.test.ts
```

Expected: PASS — the 5 new cases plus every pre-existing case in the file. Confirm the reported file count is **1** and that the pre-existing count did not drop.

- [ ] **Step 7: Typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/jobs/softwareRemediationWorker.ts apps/api/src/jobs/softwareRemediationWorker.test.ts
git commit -m "feat(software): install-remediation job payload and producer (#5505 W02)"
```

---

### Task 10: Wire the install branch into `processCheckPolicy`

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts:2` (import `sql`), `:67-93` (state type + parser), `:95-134` (read the new columns), `:280-285` (return type), `:361-369` (preamble), `:371-445` (the loop), `:481-524` (the scheduling block)
- Test: `apps/api/src/jobs/softwareComplianceWorker.install.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `decideInstallRemediation` / `installStatusForSkip` (Task 8), `scheduleSoftwareInstallRemediation` (Task 9), `resolveInstallRemediationMaxPerPass` / `resolveInstallRemediationMaxAttempts` (Task 6), the extended `SoftwareComplianceUpsertInput` (Task 3), W01's `evaluateSoftwarePolicyArming(policy, 'install')` and its install audit-action constants.
- Produces: `processCheckPolicy` returns an additional `installRemediationQueued: number`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/jobs/softwareComplianceWorker.install.test.ts — append at end of file
describe('processCheckPolicy — install remediation wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armingMock.mockReturnValue({ armed: true });
    scheduleUninstallMock.mockResolvedValue(0);
    scheduleInstallMock.mockResolvedValue([]);
    delete process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS;
    delete process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS;
  });

  function primePass(devices: string[], existingRows: Record<string, unknown>[]) {
    resolveDeviceIdsMock.mockResolvedValueOnce(devices);
    primeSelects([
      [FULLY_ARMED_POLICY],
      devices.map((id) => ({ id, orgId: 'org-1' })),
      existingRows,
    ]);
    // Inventory is EMPTY for every device, so the allowlist rule
    // { name: 'Google Chrome', catalogId: 'catalog-abc' } produces exactly one
    // `missing` violation per device.
    inventoryMock.mockResolvedValueOnce(new Map(devices.map((id) => [id, []])));
  }

  it('queues an install for a device whose allowlist rule is missing', async () => {
    primePass(['device-1'], []);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(result.installRemediationQueued).toBe(1);
    expect(scheduleInstallMock).toHaveBeenCalledWith(
      POLICY_ID,
      [{ deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 }],
      1,
    );
    // and it must stamp only the devices that actually got a job
    expect(dbUpdateMock).toHaveBeenCalled();
  });

  it('does not queue an install when only the install verb is unarmed', async () => {
    armingMock.mockImplementation((_policy: unknown, verb: string) => (
      verb === 'install'
        ? { armed: false, reason: 'auto_install_off', message: 'unarmed' }
        : { armed: true }
    ));
    primePass(['device-1'], []);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(result.installRemediationQueued).toBe(0);
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  it('caps installs per pass and records the overflow devices as skipped', async () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '2';
    primePass(['device-1', 'device-2', 'device-3'], []);
    scheduleInstallMock.mockResolvedValueOnce(['device-1', 'device-2']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleInstallMock.mock.calls[0][1]).toHaveLength(2);
    const upserted = upsertMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    const third = upserted.find((row) => row.deviceId === 'device-3');
    expect(third?.installRemediationStatus).toBe('skipped');
  });

  it('gives up on a device whose consecutive attempts are exhausted', async () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '3';
    primePass(['device-1'], [{
      deviceId: 'device-1',
      status: 'violation',
      violations: [],
      remediationStatus: null,
      lastRemediationAttempt: null,
      installRemediationStatus: 'failed',
      lastInstallRemediationAttempt: null,
      installRemediationAttempts: 3,
    }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleInstallMock).not.toHaveBeenCalled();
    const upserted = upsertMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(upserted[0].installRemediationStatus).toBe('gave_up');
  });

  it('resets the consecutive counter once the device has no missing violation left', async () => {
    resolveDeviceIdsMock.mockResolvedValueOnce(['device-1']);
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [{
        deviceId: 'device-1',
        status: 'violation',
        violations: [],
        remediationStatus: null,
        lastRemediationAttempt: null,
        installRemediationStatus: 'pending',
        lastInstallRemediationAttempt: null,
        installRemediationAttempts: 2,
      }],
    ]);
    // Chrome is now installed, so the allowlist rule matches and nothing is missing.
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Google Chrome', version: '121.0', vendor: 'Google', catalogId: 'catalog-abc' },
    ]]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const upserted = upsertMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(upserted[0].installRemediationAttempts).toBe(0);
    expect(upserted[0].installRemediationStatus).toBe('completed');
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  it('says nothing about the install columns for a device with no missing violation and no install history', async () => {
    resolveDeviceIdsMock.mockResolvedValueOnce(['device-1']);
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Google Chrome', version: '121.0', vendor: 'Google', catalogId: 'catalog-abc' },
    ]]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const upserted = upsertMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(upserted[0].installRemediationStatus).toBeUndefined();
    expect(upserted[0].installRemediationAttempts).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.install.test.ts
```

Expected: FAIL — `installRemediationQueued` is not on the result, and `scheduleSoftwareInstallRemediation` is never called.

- [ ] **Step 3: Read the new columns into the pass state**

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts:2 — sql is needed for the atomic counter increment
import { and, eq, inArray, sql } from 'drizzle-orm';
```

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — replacing :67-93
type ExistingComplianceState = {
  deviceId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: unknown;
  remediationStatus: SoftwarePolicyRemediationStatus | null;
  lastRemediationAttempt: Date | null;
  // Feature #5505 W02: the install verb's parallel axis.
  installRemediationStatus: SoftwarePolicyInstallRemediationStatus | null;
  lastInstallRemediationAttempt: Date | null;
  installRemediationAttempts: number;
};

function parseComplianceStatus(value: unknown): SoftwarePolicyComplianceStatus {
  if (value === 'compliant' || value === 'violation' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}

function parseRemediationStatus(value: unknown): SoftwarePolicyRemediationStatus | null {
  if (
    value === 'none'
    || value === 'pending'
    || value === 'in_progress'
    || value === 'completed'
    || value === 'failed'
  ) {
    return value;
  }
  return null;
}

/** Superset of parseRemediationStatus: the install axis adds two terminal states. */
function parseInstallRemediationStatus(value: unknown): SoftwarePolicyInstallRemediationStatus | null {
  if (value === 'gave_up' || value === 'skipped') return value;
  return parseRemediationStatus(value);
}

/** A NULL or garbage counter reads as 0 — never NaN into a `>=` comparison. */
function parseAttemptCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
```

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — replacing the select + mapping inside
// readComplianceStateByDevice (:108-130)
    const rows = await db
      .select({
        deviceId: softwareComplianceStatus.deviceId,
        status: softwareComplianceStatus.status,
        violations: softwareComplianceStatus.violations,
        remediationStatus: softwareComplianceStatus.remediationStatus,
        lastRemediationAttempt: softwareComplianceStatus.lastRemediationAttempt,
        installRemediationStatus: softwareComplianceStatus.installRemediationStatus,
        lastInstallRemediationAttempt: softwareComplianceStatus.lastInstallRemediationAttempt,
        installRemediationAttempts: softwareComplianceStatus.installRemediationAttempts,
      })
      .from(softwareComplianceStatus)
      .where(and(
        eq(softwareComplianceStatus.policyId, policyId),
        inArray(softwareComplianceStatus.deviceId, chunk),
      ));

    for (const row of rows) {
      byDevice.set(row.deviceId, {
        deviceId: row.deviceId,
        status: parseComplianceStatus(row.status),
        violations: row.violations,
        remediationStatus: parseRemediationStatus(row.remediationStatus),
        lastRemediationAttempt: row.lastRemediationAttempt,
        installRemediationStatus: parseInstallRemediationStatus(row.installRemediationStatus),
        lastInstallRemediationAttempt: row.lastInstallRemediationAttempt,
        installRemediationAttempts: parseAttemptCount(row.installRemediationAttempts),
      });
    }
```

- [ ] **Step 4: Extend the pass preamble and the return type**

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — replacing the signature at :280-285
export async function processCheckPolicy(data: CheckPolicyJobData): Promise<{
  policyId: string;
  devicesEvaluated: number;
  violations: number;
  remediationQueued: number;
  installRemediationQueued: number;
}> {
```

Every early return in that function (`:299-304`, `:315-320`, `:353-358`) gains `installRemediationQueued: 0`.

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — extending the preamble at :366-369
  let violations = 0;
  const remediationTargets = new Set<string>();
  // Feature #5505 W02. Knobs are read ONCE PER PASS — per call, never module
  // load (contract D5); the cap is per policy per pass by definition.
  const installMaxPerPass = resolveInstallRemediationMaxPerPass();
  const installMaxAttempts = resolveInstallRemediationMaxAttempts();
  const installTargets: InstallRemediationTarget[] = [];
  const complianceUpserts: Parameters<typeof upsertSoftwareComplianceStatuses>[0] = [];
  const now = new Date();
```

New imports:

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts:22 — replacing the single-name import
import {
  scheduleSoftwareRemediation,
  scheduleSoftwareInstallRemediation,
  type InstallRemediationTarget,
} from './softwareRemediationWorker';
import {
  resolveInstallRemediationMaxAttempts,
  resolveInstallRemediationMaxPerPass,
} from '../services/softwareInstallRemediationKnobs';
```

and add `SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS` to the `softwarePolicyService` import block (confirm W01's exact identifier first — Task 7 Step 0).

- [ ] **Step 5: Add the install decision to the per-device loop**

Insert this between the uninstall `remediationStatus` derivation (which ends at `:394`) and the `complianceUpserts.push` (`:396`). The decision must run **before** the push so its status can ride the same upsert.

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — after the remediationStatus derivation,
// before complianceUpserts.push
      // ---- Feature #5505 W02: the install verb -------------------------------
      // Keyed on "does this device have a `missing` violation", NOT on the
      // overall compliance status: a device can be in `violation` purely
      // because of unauthorized software while having nothing missing, and the
      // two verbs must not read each other's condition.
      const hasMissingViolation = violationsWithStableTimestamps.some((v) => v.type === 'missing');

      let installRemediationStatus: SoftwarePolicyInstallRemediationStatus | undefined;
      let installRemediationAttempts: number | undefined;
      if (!hasMissingViolation) {
        // Desired state reached. Mirrors the uninstall transition above: a
        // working status settles to 'completed', and the CONSECUTIVE counter
        // resets so a future recurrence starts with a full attempt budget.
        // 'gave_up' also settles to 'completed' — the software is present now,
        // however it got there, and leaving a permanent tombstone on a healthy
        // device would be a lie.
        if (
          existing?.installRemediationStatus
          && existing.installRemediationStatus !== 'none'
          && existing.installRemediationStatus !== 'completed'
        ) {
          installRemediationStatus = 'completed';
        }
        if ((existing?.installRemediationAttempts ?? 0) > 0) {
          installRemediationAttempts = 0;
        }
      } else if (existing?.installRemediationStatus === 'completed') {
        // It came back. Clear the stale success so the next decision is not read
        // against a status describing a previous cycle.
        installRemediationStatus = 'none';
      }

      if (hasMissingViolation && installArming.armed) {
        const installDecision = decideInstallRemediation({
          violations: violationsWithStableTimestamps,
          previousInstallStatus: existing?.installRemediationStatus ?? null,
          lastInstallAttempt: existing?.lastInstallRemediationAttempt ?? null,
          attempts: existing?.installRemediationAttempts ?? 0,
          now,
          gracePeriodHours: remediationOptions.gracePeriodHours,
          cooldownMinutes: remediationOptions.cooldownMinutes,
          maxAttempts: installMaxAttempts,
          // Cap is measured against what THIS pass has already committed to.
          capRemaining: installMaxPerPass - installTargets.length,
        });

        if (installDecision.queue) {
          installTargets.push({
            deviceId,
            catalogIds: installDecision.catalogIds,
            attempt: installDecision.attempt,
          });
          recordSoftwareRemediationDecision('install_queued');
        } else {
          recordSoftwareRemediationDecision(`install_${installDecision.reason}`);
          const skipStatus = installStatusForSkip(installDecision.reason);
          if (skipStatus) {
            installRemediationStatus = skipStatus;
          }
          // Audit the give-up ONCE, on the transition. Firing it every pass
          // would put one row per device per 15 minutes into
          // software_policy_audit for as long as the policy stays armed.
          if (skipStatus === 'gave_up' && existing?.installRemediationStatus !== 'gave_up') {
            fireAudit({
              orgId: policy.orgId ?? orgByDevice.get(deviceId) ?? null,
              partnerId: policy.partnerId,
              policyId: policy.id,
              deviceId,
              action: SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS.gaveUp,
              actor: 'system',
              details: {
                policyName: policy.name,
                attempts: existing?.installRemediationAttempts ?? 0,
                maxAttempts: installMaxAttempts,
              },
            });
          }
        }
      }
      // ---- end install verb -------------------------------------------------

      complianceUpserts.push({
        deviceId,
        policyId: policy.id,
        status,
        violations: violationsWithStableTimestamps,
        checkedAt: now,
        remediationStatus,
        installRemediationStatus,
        installRemediationAttempts,
      });
```

- [ ] **Step 6: Add the install scheduling block after the upsert flush**

Insert immediately after the existing uninstall scheduling block closes (`:516`), before the function's `return` at `:518`.

```ts
// apps/api/src/jobs/softwareComplianceWorker.ts — after the uninstall scheduling block
  let installRemediationQueued = 0;
  if (installTargets.length > 0) {
    // Placed AFTER the upsertSoftwareComplianceStatuses flush above, so every
    // row this block is about to UPDATE is guaranteed to exist.
    const enqueuedDeviceIds = await scheduleSoftwareInstallRemediation(
      policy.id,
      installTargets,
      policy.approvalGeneration,
    );
    installRemediationQueued = enqueuedDeviceIds.length;

    if (enqueuedDeviceIds.length > 0) {
      const attemptedAt = new Date();
      for (const chunk of chunkArray(enqueuedDeviceIds)) {
        await db
          .update(softwareComplianceStatus)
          .set({
            installRemediationStatus: 'pending',
            lastInstallRemediationAttempt: attemptedAt,
            // Incremented in SQL, not from the value read at the top of the
            // pass: this is the authoritative counter, and doing the arithmetic
            // in the statement keeps it correct even if a concurrent pass or the
            // W03 processor touched the row in between.
            installRemediationAttempts: sql`${softwareComplianceStatus.installRemediationAttempts} + 1`,
          })
          .where(and(
            eq(softwareComplianceStatus.policyId, policy.id),
            inArray(softwareComplianceStatus.deviceId, chunk),
          ));
      }
    }

    fireAudit({
      orgId: policy.orgId,
      partnerId: policy.partnerId,
      policyId: policy.id,
      action: SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS.queued,
      actor: 'system',
      details: {
        targetCount: installTargets.length,
        queuedCount: installRemediationQueued,
        deferredCount: Math.max(0, installTargets.length - installRemediationQueued),
        maxPerPass: installMaxPerPass,
        maxAttempts: installMaxAttempts,
      },
    });

    recordSoftwareRemediationDecision('install_scheduled', installRemediationQueued);
  }

  return {
    policyId: policy.id,
    devicesEvaluated: deviceIds.length,
    violations,
    remediationQueued,
    installRemediationQueued,
  };
```

- [ ] **Step 7: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.install.test.ts src/jobs/softwareComplianceWorker.test.ts
```

Expected: PASS, 2 files, every case green.

- [ ] **Step 8: Typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareComplianceWorker.install.test.ts
git commit -m "feat(software): compliance worker queues install remediation for missing violations (#5505 W02)"
```

---

### Task 11: Wave verification

**Files:** none modified.

**Interfaces:**
- Consumes: everything above.
- Produces: the evidence this wave is safe to open as a PR.

- [ ] **Step 1: Sweep for leftover references to the removed names**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -rn "readEarliestUnauthorizedDetection\|autoUninstallEnabled" apps packages ee 2>/dev/null | grep -v node_modules
```

Expected: **no output.** Both were deleted in Tasks 4 and 7; a survivor means a call site still carries the duplicated arming logic D11 exists to remove.

- [ ] **Step 2: Confirm no out-of-scope file was touched**

```bash
git diff --name-only main...HEAD
```

Expected: exactly the files listed in this plan's File structure section. **Any of these appearing is a scope violation, stop and revert it:** `apps/api/src/services/softwareDeployment.ts`, `apps/api/src/db/schema/software.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, anything under `apps/web/`, and any `ai*` file.

- [ ] **Step 3: Run the full affected test set explicitly**

```bash
cd apps/api && npx vitest run \
  src/jobs/softwareComplianceWorker.test.ts \
  src/jobs/softwareComplianceWorker.install.test.ts \
  src/jobs/softwareRemediationWorker.test.ts \
  src/services/softwarePolicyService.test.ts \
  src/services/softwarePolicyService.complianceUpsert.test.ts \
  src/services/softwarePolicyService.violationFingerprint.test.ts \
  src/services/softwareInstallRemediationKnobs.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/db/autoMigrate.test.ts
```

Expected: PASS, **9 files reported.** Every path is listed explicitly rather than by prefix, because vitest's filter is a plain substring match and a trailing-slash or bare-prefix filter silently skips dotted sibling files.

- [ ] **Step 4: Run the broader compliance/policy surface**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.test.ts src/services/userRiskScoring.test.ts
```

Expected: PASS. These read `software_compliance_status` with explicit column projections and must be unaffected by the three new columns; if either fails, a projection somewhere is broader than the ground-truth pass found.

- [ ] **Step 5: Typecheck and lint the whole API package**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
pnpm --filter @breeze/api exec tsc --noEmit
pnpm lint
```

Expected: PASS both.

- [ ] **Step 6: Prove the migration applies to a database that already has it**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```

Expected: zero newly-applied migrations on the second run, and drift check green.

- [ ] **Step 7: Record what this wave deliberately did NOT do, in the PR body**

The PR description must state all of these so a reviewer does not read them as omissions:

- **No deployment is created and nothing is dispatched.** Install jobs are enqueued and parked by `createSoftwareRemediationWorker` until W03 (#5508) lands. A parked job leaves the compliance row at `'pending'`, which `shouldQueueAutoRemediation` reads as `in_progress`, so each device is queued exactly once and no loop can form.
- **No platform-mismatch filter.** Spec §4 wants a cross-platform policy filtered before it generates guaranteed-failing deployments. That needs catalog→install-method resolution against `device.osType`, which is W03's resolution step; duplicating it in the compliance worker would create two places to keep in sync. W03 writes `install_remediation_status = 'skipped'` for that case, which is why `'skipped'` is in the union already.
- **No registration changes**, and none are needed: `software_compliance_status` has no `org_id`, is absent from `tenantCascade.ts` and `tenantExportPolicyRegistry.ts` (zero hits in both), and is already in `CORE_DEVICE_CASCADE_DELETE_TABLES` at `routes/devices/core.ts:511`.
- **The uninstall path is untouched**, including its pre-existing inaccuracy at `softwareComplianceWorker.ts:486` where all targets are stamped `'pending'` whenever the queued count is `> 0`. The install path deliberately does not replicate it (Task 9).
- **`install_remediation_status` is not yet exposed by the API.** `routes/softwarePolicies.ts:482-487` projects `remediationStatus` only, and no wave in the contract's ownership map owns widening it — W04 is "web UI only, must not touch any `apps/api` file". Flag this to the coordinator.

---

## Self-review

**1. Spec coverage.** Every requirement this wave owns maps to a task:

| Requirement | Task |
|---|---|
| Contract D1 — three columns, migration, upsert plumbing, non-clobber preserved | 1, 2, 3 |
| Contract D5 — per-call knobs file | 6 |
| Contract D10 — verb-aware grace clock | 4 |
| Contract D11 — worker delegates arming, divergence test | 7 |
| Contract D9 — the required check on stable-timestamp matching | 5 |
| Spec §2 — missing-violation branch, two independent gates, both verbs in one pass | 7, 8, 10 |
| Spec Risks §1 — consecutive-attempt give-up counter | 6, 8, 10 |
| Spec Risks §2 — per-pass cap | 6, 8, 10 |
| Spec §4 — rule without `catalogId` is skipped and says so | 8, 10 |
| Spec §6 — install-specific audit actions, never the uninstall ones | 10 |
| Spec Testing 1-2 — verb-aware arming, branch selection, `catalogId` skip, `shouldQueueAutoRemediation` on install | 7, 8, 10 |
| Spec Testing 6 — arming install does not arm uninstall and vice versa | 10 |
| Install job payload W03 consumes, stated verbatim | 9 |

Deliberate non-coverage, each argued in Task 11 Step 7: platform filter (W03), deployment creation (W03), integration suites for `tenantCascade` / `tenant-export-policy` (W03 — this wave adds no `org_id` column and no FK, so neither contract is engaged), `'outdated'` violations (spec Non-goals).

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries complete, runnable code. The one forward reference — W01's audit-action constant identifier — is handled with an explicit `grep` verification step (Task 7, before Step 1) plus a stated fallback rule, because contract D6 locks the four string values but leaves the export name to W01.

**3. Type consistency.** Checked end to end: `SoftwarePolicyInstallRemediationStatus` (Task 3) is the return type of `installStatusForSkip` (Task 8) and the type of `ExistingComplianceState.installRemediationStatus` (Task 10) and of `SoftwareComplianceUpsertInput.installRemediationStatus` (Task 3). `AutoRemediationDeferralReason` (Task 4) is a member of `InstallRemediationSkipReason` (Task 8), which is why `decideInstallRemediation` returns `timing.reason` with no cast. `InstallRemediationTarget` (Task 9) is exactly what `installTargets.push` builds (Task 10) and what `scheduleSoftwareInstallRemediation` accepts (Task 9). `readEarliestViolationDetection` is the single name used in Task 4's implementation, its tests, and `shouldQueueAutoRemediation`'s body — the old `readEarliestUnauthorizedDetection` appears nowhere after Task 4 and is grepped for in Task 11.
