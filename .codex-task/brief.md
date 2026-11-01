# wave-10729: Org-subject alerts W04 — device deletion keeps topology site alert history (#7269) (feature #10725, wave #10729)

Implementer: Codex (`codex exec`, workspace-write) in a fresh worktree from `origin/main` (W1 #10733 merged). **Rigor: high** (device deletion cascade, org-cascade contract). Red test first.

## Read first, in order
1. **Plan on `origin/main`:** `docs/superpowers/plans/2026-10-29-org-subject-alerts.md` — Global Constraints, Review Focus 5, **Wave 4 (Task 11)**, Wave order. Spec `docs/superpowers/specs/monitoring/2026-10-29-org-subject-alerts-design.md` (G10). Request #7269.
2. **W1 as merged** (`.codex-task/w1-pr-body.md`) and the #10835 follow-up body (`.codex-task/w1-followup-pr-body.md`, tightens the owner CHECK: `device` owners must have `topology_site_id IS NULL`; `topology_site` rows keep `topology_site_id`).
3. `CLAUDE.md` (Tenant Isolation: device cascade lists in `routes/devices/core.ts`, `deviceDeletion.ts` patterns), `docs/agents/tenancy-rls.md`, `docs/agents/testing.md`, `apps/api/src/services/deviceDeletion.ts` (`deleteOriginDeviceTopologyAlerts`), the device-cascade contract tests (`cascadeDelete.test.ts`, `deviceDeletion*.test.ts`, install-boundary classification if a table's device semantics change).

## Deliverables
One PR, base `main`, not stacked. Branch **`feature/10725-org-subject-alerts/wave-10729`**. PR body: `Closes #10729`, `Part of #10725`, `Refs #7269`. No migration, no schema change, **no web change** (the topology link in the alert UI belongs to W2 #10727, running in parallel).
- **T11:** replace the delete in `deleteOriginDeviceTopologyAlerts` with `UPDATE alerts SET device_id = NULL WHERE owner_kind = 'topology_site' AND device_id = $1`; exclude those rows from `deviceAlertIds` so their `alert_notifications`, `alert_correlations` and PSA ticket mappings survive; the caller's audit count becomes "detached". Keep device-owned alerts deleted. Real-DB test `preserves topology_site alerts when the origin device is deleted` (row, notifications, correlations remain; `device_id` NULL) + device-owned alerts still deleted; the org-cascade suite stays green; the install-boundary classification registry (`deviceInstallBoundary/classification.ts`) and `CORE_DEVICE_CASCADE_DELETE_TABLES` semantics must still be true for `alerts` (document the "detach, not delete" case where the registry describes it).
- Release notes: one line under `### Org-subject alerts (#10725)` (append; W2 may add its own line — keep both).

## Plan amendments (orchestrator, 2026-10-31, after the first Codex run stopped on a true ownership gap)

- **A1 — where the delete lives.** `deleteOriginDeviceTopologyAlerts` is imported into `services/deviceDeletion.ts` from `services/siteOwnedAlerts.ts`, which delegates to the shared `deleteTopologyAlertsWhere` also used by org erasure (`services/tenantCascade.ts`, with `ownerOrgNot`). Org erasure MUST keep deleting. Resolution: add a new device-only function `detachOriginDeviceTopologyAlerts(tx, deviceId, …)` (in `siteOwnedAlerts.ts` next to the existing helper, or in `deviceDeletion.ts`) that runs `UPDATE alerts SET device_id = NULL WHERE owner_kind = 'topology_site' AND device_id = $1` and returns the detached count; `deviceDeletion.ts` calls it instead of the delete; `deleteOriginDeviceTopologyAlerts` / `deleteTopologyAlertsWhere` and the `tenantCascade.ts` call stay byte-for-byte unchanged (add a one-line comment on the old helper saying device deletion no longer uses it).
- **A2 — ownership widened for the audit count only.** The result field `removedTopologyAlerts` travels through `services/deviceLifecycle.ts` (purge result) and `jobs/deviceBulkPurge.ts` (bulk-purge audit). You may rename/extend it to `detachedTopologyAlerts` in those two files and their tests so the audit says "detached"; no other change there.
- Premise re-stated: `deleteOriginDeviceTopologyAlerts` is DEFINED in `services/siteOwnedAlerts.ts` and CALLED from `services/deviceDeletion.ts:~281`; that is the expected state, not a stop condition.

## Orchestration amendments
- **File ownership:** `services/deviceDeletion.ts` (+ tests), the new detach function in `services/siteOwnedAlerts.ts` (additive only), `services/deviceLifecycle.ts` + `jobs/deviceBulkPurge.ts` (+ tests) for the audit-count rename, the device-cascade contract/registry files. Never change `deleteTopologyAlertsWhere` or `tenantCascade.ts`. W2 owns notification + web.
- **CI traps:** device cascade contracts (`cascadeDelete.test.ts`, `moveOrg.coverage.test.ts`, install-boundary contract), `parkedFanout.contract`, API typecheck as above; never `pnpm --filter <pkg> test -- --run <path>`. Codex cannot reach Docker: the real-DB test is written and proven by a guard-flip reading; CI runs it; say so.
- Codex sandbox cannot commit: cumulative patch `.codex-task/patches/T11.cumulative.patch` + `message.txt`; orchestrator commits. No push, no GitHub.

## Stop rules (verbatim)
- Open the PR, run `/pr-review-toolkit:review-pr`, post the review summary, STOP. Do not merge, do not close the issue. (Orchestrator performs these for a Codex run.)
- If the premise does not hold, ABORT and report — do not improvise. Premise: #10733 MERGED to `main`; `deleteOriginDeviceTopologyAlerts` is defined in `services/siteOwnedAlerts.ts`, called from `services/deviceDeletion.ts`, and still deletes; `alerts.device_id` is nullable with `owner_kind`; #10729 and #10725 OPEN; no `wave-10729*` PR.
- Do not start background CI pollers and never `pkill -f`; watching CI is the orchestrator's job.

## Result file
`.codex-task/RESULT.md`: patch, every test command with counts, typecheck exit, deviations, "Needs Todd" (none expected).
