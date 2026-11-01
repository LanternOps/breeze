## Summary

Follow-up to #10733 (W1 of #10725), which merged while the land-gate hardening pass was still running. All six review items from the #10733 land-gate review land here:

- **Resolve continuity.** Web, mobile and service resolve paths log `alert_has_no_device` with alertId/orgId/ownerKind and skip only the device-keyed cooldown; the `alert.resolved` event, ML feedback and audit proceed identically for device and non-device alerts (previously a throw after the UPDATE left partial state, and in mobile it was swallowed by the cooldown try/catch).
- **G1 observability.** Automation and flow skips for device-less alert events carry alertId/eventId/orgId/owner and increment `alert_device_consumer_skipped_total{consumer="automation"|"flow"}`.
- **Sourced-alert outcomes.** `createSourcedAlert` logs the dedupe path at info with org/owner and tags owner context on every failure path.
- **Ownership shape.** New migration `2027-01-18-130000-alerts-owner-kind-device-topology-chk.sql` re-creates `alerts_owner_chk` so `owner_kind = 'device'` requires `topology_site_id IS NULL` (the shipped CHECK admitted a topology row classified as device, which would then be keyed and throttled by its origin device). Idempotent, writes no rows; every existing topology row was already classified `topology_site` by the shipped backfill. Drizzle CHECK and the schema test track the new file; the insert contract test checks literal owner values against the row shape.
- **Compliance reconcile** reports alert id and scope and continues past a malformed row instead of aborting the page.
- **`alertOwnerKey`** names the alert in its invariant error.

Part of #10725
Refs #10726 #10733

## Merge Danger

**Door:** one additive migration that only re-creates a CHECK (validated against existing rows at apply time; all current rows satisfy it). No data rewrite.

**Blast radius:** alert resolve handlers (web/mobile/service), automation + flow admission logging, compliance reconcile loop.

## Testing

Red first in each family (logs in the implementer task folder). Local: 54 files / 735 tests green across alerts routes, mobile resolve, alertService, automationWorker, eventTrigger, complianceAlertReconcile, alertOwner, sentry, queueSchemas, schema owner-kind test, insert-owner contract, migrationRlsScope; `check-migration-naming` OK; API typecheck exit 0 on the pre-rebase tree. Integration (`alertsOwner.integration.test.ts`, incl. the new "rejects a topology row labeled as a device owner") runs in CI.

Implemented by Codex (gpt-6.1-sol) from the land-gate review findings; replayed onto main by the orchestrator with the CHECK change moved into a new migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
