## Summary

W4 of org-subject alerts (#7269): deleting a device no longer deletes the topology-site alerts it originated. They stay as site history with `device_id = NULL`, and their notifications, correlations and PSA ticket mappings survive.

- New device-only `detachOriginDeviceTopologyAlerts` (`services/siteOwnedAlerts.ts`, additive) runs `UPDATE alerts SET device_id = NULL WHERE owner_kind = 'topology_site' AND device_id = $1` and returns the count; `services/deviceDeletion.ts` calls it instead of the delete. The shared `deleteTopologyAlertsWhere` and the org-erasure call in `tenantCascade.ts` are unchanged (org erasure still deletes everything).
- The device-alert child subquery selects device-owned alerts only, so the detached rows' `alert_notifications` / `alert_correlations` are not swept; PSA mappings naming a surviving topology alert have their device pointer detached before the device-based mapping deletes.
- The purge result and the permanent-delete / bulk-purge audits report `detachedTopologyAlerts` (plan amendment A2 on #10729: `deviceLifecycle.ts` and `jobs/deviceBulkPurge.ts` carry only the count rename).
- The alerts cascade registry entry documents the detach-before-delete ordering.

Plan amendment A1 (recorded on #10729): the plan placed the delete in `deviceDeletion.ts`; it is defined in `siteOwnedAlerts.ts` and shared with org erasure, so W4 adds a new function rather than changing the shared helper.

No migration, no schema change, no web change (the topology link in the alert UI is W2 #10727).

Closes #10729
Part of #10725
Refs #7269

## Merge Danger

**Door:** none. Behaviour change only on device deletion: topology-site alerts are detached, not deleted. Org erasure and site deletion are unchanged.

**Blast radius:** device deletion / permanent delete / bulk purge paths and their audit counts.

## Testing

Red first (exit 1 before the production edit). Local: 6 files / 124 tests green on the deletion, lifecycle, bulk-purge and site-owned-alert suites; device-cascade, tenancy and install-boundary parity contracts green; API typecheck exit 0. Real-DB test `preserves topology_site alerts when the origin device is deleted` (row, notifications, correlations remain; `device_id` NULL; device-owned alerts still deleted) runs under the Integration Tests CI job, with the org-cascade suite.

Implemented by Codex (gpt-6.1-sol) under the orchestrator brief.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
