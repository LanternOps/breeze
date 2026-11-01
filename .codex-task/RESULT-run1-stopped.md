# W04 / T11 result — stopped on brief premise mismatch

No implementation changes were made. No commits, pushes, or GitHub actions were performed.

## Blocking evidence

The brief's stop rule requires `deleteOriginDeviceTopologyAlerts` to exist in `services/deviceDeletion.ts` and instructs this run to abort if its premise does not hold. That file contains an import and call, but the implementation is in a different module:

- `apps/api/src/services/deviceDeletion.ts:13` imports the helper from `./siteOwnedAlerts`; line 281 calls it.
- `apps/api/src/services/siteOwnedAlerts.ts:53` defines the helper. It delegates to `deleteTopologyAlertsWhere`, which deletes alerts and their children.
- `apps/api/src/services/tenantCascade.ts:2399` also calls this helper during org erasure, with `ownerOrgNot`. Changing the shared helper would therefore change org-erasure behavior as well as device deletion.

The binding file-ownership amendment permits `services/deviceDeletion.ts` (+ tests) and device-cascade contract/registry files. It does not include `siteOwnedAlerts.ts` or `tenantCascade.ts`. Replacing the imported helper with a new device-only implementation would be an adaptation of the stated premise; this run was explicitly instructed to stop rather than improvise.

There is also a propagation gap in the stated ownership: the `removedTopologyAlerts` result is transported through `services/deviceLifecycle.ts` (the purge result) and `jobs/deviceBulkPurge.ts` (the bulk-purge audit). Both are outside the named ownership. Updating only the single-device route's audit in `routes/devices/core.ts` would leave bulk-purge audits describing detached alerts as removed.

Other local premises checked: HEAD is `f8a19be8d3` (the W1 #10733 merge), the branch is `feature/10725-org-subject-alerts/wave-10729`, and the alerts schema has nullable `deviceId` and `ownerKind`. Live issue/PR states were not queried because the user explicitly prohibited touching GitHub. The supplied #10835 follow-up body describes a CHECK tightening that is not present at this HEAD; this was not itself treated as a stop premise.

## Task artifacts

- T11: stopped before implementation or red-test edits.
- `.codex-task/patches/T11.cumulative.patch`: not generated; no completed green task to snapshot.
- `.codex-task/patches/T11.message.txt`: not generated; no implementation to commit.
- `.codex-task/T11-red.log` / `T11-green.log`: not generated; no tests run.

## Validation

- Test commands: none; 0 tests run.
- Required contract sweep: not run because the premise stop occurred before implementation.
- API typecheck: not run; exit code unavailable.
- Real-DB integration suites: not run; no Docker or DB services started. No new integration test or guard-flip proof was produced.
- `git diff --stat`: empty before writing this task-local report.

## Deviations and open questions

Stopped as required by the brief, rather than changing the shared deletion helper or widening ownership. No infrastructure was started or left running.

Needs Todd/orchestrator: clarify that T11 may replace the imported call with device-only detachment, and include the lifecycle/bulk-purge audit propagation files and tests in the permitted ownership (or provide a revised brief covering the shared helper and org-erasure semantics). No user question was issued during this run.
