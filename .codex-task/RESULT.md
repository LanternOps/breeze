# W04 / T11 result

T11 is complete, green in all executed tests, typechecked, and snapshotted.
No commits, pushes, GitHub reads/writes, Docker stacks, or background CI pollers.

## Behavior and scope

- A new device-only `detachOriginDeviceTopologyAlerts` clears topology alerts'
  provenance device and reports its count, without deleting alert children.
- The device-alert child subquery explicitly selects device owners only.
- PSA mappings naming a surviving topology alert have their device pointer
  detached before both device-based mapping delete paths. Other device mappings
  and device-owned alerts remain deleted.
- `detachedTopologyAlerts` propagates through lifecycle, permanent-delete route,
  and bulk-purge audits. The lifecycle/bulk files have only the A2 count rename.
- The alerts cascade registry entry stays present and documents the preceding
  detach; install-boundary classification stays history and explains the case.
- Release notes append the requested Org-subject alerts line.
- No migration, schema, web, notification-dispatch, or org-erasure changes.
  Mechanically compared both existing delete helper bodies and tenantCascade.ts
  to HEAD: byte-for-byte unchanged (apart from the permitted comment outside the
  old helper body and additive helper/import in siteOwnedAlerts.ts).

## Task artifacts

- Patch: `.codex-task/patches/T11.cumulative.patch`.
- Message: `.codex-task/patches/T11.message.txt`.
- Red: `.codex-task/T11-red.log`.
- Green: `.codex-task/T11-green.log`.
- Contract sweep: `.codex-task/T11-contract-sweep.log`.
- Extra contracts: `.codex-task/T11-install-parity.log`, `.codex-task/T11-row-count.log`.
- Typecheck: `.codex-task/T11-typecheck.log` (compiler diagnostics; empty on success).
- Real-DB guard-flip reading: `.codex-task/T11-guard-flip-reading.md`.

## Every test command and result

All commands were invoked from the worktree root; Vitest paths are exact paths
relative to apps/api. No forbidden pnpm test passthrough or substring-only
selection was used.

1. Red first, before production edits (exit 1):

   ```sh
   pnpm --filter @breeze/api exec vitest run src/services/siteOwnedAlerts.test.ts src/services/deviceDeletion.test.ts src/services/deviceLifecycle.test.ts src/jobs/deviceBulkPurge.test.ts src/routes/devices/cascadeDelete.test.ts
   ```

   5 files; **11 failed, 110 passed (121 total)**. Failures cover the absent
   detach helper, missing PSA detach, old result field, and old audit fields.

2. Implementation run, then corrected mocks/assertions and reran (same command
   twice):

   ```sh
   pnpm --filter @breeze/api exec vitest run src/services/siteOwnedAlerts.test.ts src/services/deviceDeletion.test.ts src/services/deviceDeletion.hardwareHealth.test.ts src/services/deviceLifecycle.test.ts src/jobs/deviceBulkPurge.test.ts src/routes/devices/cascadeDelete.test.ts
   ```

   First attempt exit 1: 2 files failed / 4 passed; **5 failed, 119 passed
   (124 total)**, in `T11-green-attempt1.log`. Three helper cases and one cascade
   case compared the full Drizzle compiled object without its `typings` metadata;
   changed to partial object matching while preserving exact SQL/parameter
   assertions. The lock-timeout fixture returned one row for every statement;
   made the new detach response accurately return zero rows there.

   Final green exit 0: **6 files, 124 passed** (`T11-green.log`).

3. Required available device-cascade / tenancy contract sweep (exit 0):

   ```sh
   pnpm --filter @breeze/api exec vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/deviceInstallBoundary/deviceInstallBoundary.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/tenantCascade.test.ts src/services/tenantCascade.partner.test.ts src/services/orgMerge.test.ts src/services/orgMergeRegistry.extensions.test.ts src/services/tenantExportPolicy.test.ts src/__tests__/alertInsertOwnerKind.contract.test.ts
   ```

   **10 files, 302 passed** (`T11-contract-sweep.log`).

4. Additional install-boundary parity contract (exit 0):

   ```sh
   pnpm --filter @breeze/api exec vitest run src/services/deviceInstallBoundary/orgMoveParity.test.ts
   ```

   **1 file, 7 passed** (`T11-install-parity.log`).

5. Shared row-count reader contract used by the new helper (exit 0):

   ```sh
   pnpm --filter @breeze/api exec vitest run src/db/rowCount.test.ts
   ```

   **1 file, 17 passed** (`T11-row-count.log`).

## Typecheck and other verification

```sh
NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"
```

Compiler stdout/stderr captured in `T11-typecheck.log` without piping to tail.
Exit: **0**, checked from the command's `exit=0` output. No web files changed; web tsc and astro check do not apply.
`git diff --check`: exit 0. Final patch reverse-apply check: exit 0; includes all 13 implementation/test/doc files, including the untracked helper test, and no task-local artifacts.

## Real-DB suites: written/read, not run

Per the binding no-Docker rule, no real-DB integration suite was executed and
no DB success is claimed. The modified integration file contains **3 cases**:
two preservation cases (same org and moved origin) and the retained GDPR-erasure
case. It asserts topology owner/site/org retention, null provenance, surviving
notifications/correlations/PSA mapping, device-owned alert/mapping deletion, and
the detached audit count. The old erasure case still expects deletion and its
foreign-alert deletion count.

The source-level guard-flip reading explains the assertion that fails for each
removed/wrong owner guard, missing PSA detachment, restored old delete call, or
accidental change to org erasure. Live `tenantCascade.integration.test.ts` and
`installBoundaryContract.integration.test.ts` likewise remain for CI. Unit
counterparts and the unchanged helper's destructive behavior passed locally.

## Review, deviations, open questions

- One independent read-only final review found no actionable findings after
  checking scope, both PSA delete paths, fixture validity, org erasure, audit
  propagation, and registry documentation.
- A1 resolves the previous run's helper-location stop: no stop on that premise.
- PSA pointer detachment is necessary to deliver the explicitly required mapping
  preservation; alert-only detachment would still delete mappings twice.
- The single-device route's count rename in core.ts is necessary to make its
  audit accurate, alongside the explicitly permitted A2 propagation changes.
- Required plan execution subskills (`superpowers:executing-plans` /
  `superpowers:subagent-driven-development`) are not installed in the available
  skill locations; followed the supplied task's red/green/snapshot procedure
  directly with repository breeze-testing conventions.
- Live issue/PR states were not queried because the user prohibits touching
  GitHub; relied on supplied orchestration context. Local branch, HEAD
  f8a19be8d3081cde91319f7fab91b45b4a736042, nullable deviceId/ownerKind, and the
  still-destructive shared helper were verified. The supplied W1 follow-up
  describes a stricter CHECK that is not at this HEAD; this patch requires no
  CHECK change and fixtures explicitly set ownerKind for that follow-up.
- Open implementation questions: none. Needs Todd: none. The orchestrator owns
  commit, PR, external review posting, and CI. No infrastructure left running.
