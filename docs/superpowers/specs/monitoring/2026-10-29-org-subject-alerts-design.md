# Alerts that are not about a device (org-subject alerts): design

**Status:** DRAFT, awaiting approval
**Date:** 2026-10-29
**Motivation:**
- SaaS backup workloads (Dropsuite/Cove M365, feature #10598) can fail with no device to attach an alert to.
- Issue #7269: site-owned topology alerts are destroyed when their origin device is deleted.

**Advisor quorum:** an independent Codex xhigh read-only review recommended the same option (a), extending alerts with an explicit owner.

## Problem

Every alert must have a device: `alerts.device_id` is `NOT NULL` (`apps/api/src/db/schema/alerts.ts:131`), and the FK is NO ACTION. Two real conditions don't fit that:

1. **SaaS backup.** A customer's "Microsoft 365 mail backup failing" is an org-level fact. Today `backupProviders/alerts.ts` skips SaaS rows (`:252`, `:306`). It publishes events only, so MSPs get nothing in the alert list, channels, escalation or PSA feed.
2. **Topology alerts.** These are owned by a site (`topology_site_id`) but still need a provenance device. Deleting that device deletes the site's alert history (#7269, `services/deviceDeletion.ts:275-300`).

## Goal

An alert can be owned by something other than a device. Device-less alerts get the normal alert list and detail view, notification channels, escalation, webhooks, the Partner API feed and Breeze tickets. No device-centric consumer silently widens, merges or leaks because a device is missing.

## Non-goals (v1)

- No alert *rules* for org-level subjects. Org-level alerts are **sourced only**, created by integrations through `createSourcedAlert`.
- Device-less alerts are not correlated and get no AI verdict. Both are skipped explicitly, with a recorded reason.
- No new delivery mechanism; existing channels are reused.

## Design

### Data model (one migration, idempotent)

```sql
ALTER TABLE alerts ALTER COLUMN device_id DROP NOT NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_kind varchar(30) NOT NULL DEFAULT 'device';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_ref  varchar(128);
-- backfill: topology-owned alerts
UPDATE alerts SET owner_kind = 'topology_site' WHERE topology_site_id IS NOT NULL AND owner_kind = 'device';
ALTER TABLE alerts ADD CONSTRAINT alerts_owner_chk CHECK (
     (owner_kind = 'device'          AND device_id IS NOT NULL)
  OR (owner_kind = 'topology_site'   AND topology_site_id IS NOT NULL)            -- device_id = provenance, nullable
  OR (owner_kind = 'backup_workload' AND device_id IS NULL AND owner_ref IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_owner_uidx
  ON alerts (org_id, owner_kind, owner_ref)
  WHERE owner_kind NOT IN ('device', 'topology_site') AND status IN (<open statuses>);
```

- **Names.** `owner_kind` is varchar with a CHECK constraint, not a pg enum, so a later kind only needs a migration that widens the CHECK. The existing `subject_key` column means a *component within a device*; that is why the new column is called `owner_*`, to avoid a name clash.
- **`owner_ref` for `backup_workload`** is `backup_provider_devices.id`. It is not a FK: resolution on row deletion goes through the existing `alertsResolve.ts` paths.
- **Each org-level owner has at most one open alert.** When a condition changes (for example stale → failed), the alert is updated in place instead of a second one opening.
- **The migration writes rows** (the backfill), so it elects `breeze.scope = system` first.
- **Tenancy** stays shape 1, with org RLS on `org_id` (`0001-baseline.sql:15358…`). New columns are classified in `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:214`). Org merge stays a plain repoint, and the cascade order is unchanged.

### Consumer contract: the rules every consumer must follow

| # | Consumer | Today, with `device_id` NULL | Rule |
|---|---|---|---|
| G1 | **Automation targeting** (`automationWorker.ts:901-937` → `automationRuntime.ts:1219`) | A missing device falls back to **all org devices**, or all partner devices for partner-wide automations | Device-targeting actions on a device-less alert **skip**, with reason `alert_has_no_device`. They never resolve to org or fleet scope. Org-level actions (notify, ticket, webhook) still run. **This is the first guard to land.** |
| G2 | Open-alert dedupe (`alertService.ts:265,300`, index `alerts_open_rule_device_subject_uidx`) | NULLs are distinct, so duplicate open alerts get through | Dedupe on `(org_id, owner_kind, owner_ref)` for non-device owners (the new unique index plus `ON CONFLICT`) |
| G3 | Cooldown and flapping (`alertCooldown.ts:65,87,337,369`, correlation flapping `:214`) | Every device-less alert shares one `null` key | Build keys from an **owner key** helper: `device:<id>` / `topology:<site>:<sourceKey>` / `backup_workload:<ref>` |
| G4 | Notification throttle (`notificationDispatcher.ts:654`) | One `device:null` bucket, so notifications are lost | Use the owner key from G3 |
| G5 | Site scope (`routes/alerts/helpers.ts:66-69,210-219`, `tickets/siteScope.ts:50`, `mobile.ts:421`, `aiToolsAlerts.ts:102-117`, `aiToolsFleet.ts:614`) | Device-less alerts are visible to every site-restricted caller (fail-open) | Fail closed. `topology_site` alerts are visible when `topology_site_id` is in the caller's sites. Org-level owners (`backup_workload`) are visible only to callers **without** a site restriction. |
| G6 | Delivery routing (`resolveDelivery.ts:63`) | Rules filtered by site fail closed | Keep that behaviour. Org-level alerts match only rules with no site filter (documented) |
| G7 | Correlation (`alertCorrelation.ts:434` inner join), RCA text (`alertCorrelationRca.ts`) | Dropped silently, or "alert on null" in the text | Explicitly excluded from correlation v1, and RCA never renders a null device |
| G8 | AI verdict (`alertVerdictSubscriber.ts:201`) | Skipped silently | Explicit skip, with reason `alert_has_no_device` recorded |
| G9 | Templates and payloads (`notificationDispatcher.ts:738-742`, event publishers) | Empty device fields | Add `ownerKind`, `ownerLabel` and `subjectName` to template fields. `{{device}}` falls back to `subjectName`. Payloads keep `deviceId: null` and add `owner` |
| G10 | Device deletion (`deviceDeletion.ts:275-300`) | Deletes every alert on the device, including topology history | `topology_site` alerts get `device_id = NULL` and are preserved. Device-owned alerts are deleted as today. **Fixes #7269.** |
| G11 | Device org move (`devices/core.ts:331`, `moveDeviceOrgInTransaction.ts`) | The trigger restamps by `device_id` | Unchanged for device owners. Device-less alerts stay in their org |
| G12 | Web UI (`AlertDetailPage.tsx:45,420,481,551`, `AlertDeviceInfo.tsx:31`, `AlertList.tsx`, `AlertsPage.tsx`, `CorrelatedAlertGroups.tsx`, `AlertsFeed.tsx`, `OrgOverviewTab.tsx`) | `/devices/null` links, and device actions offered | Rendering is owner-aware: a subject chip ("Microsoft 365 mail backup · Contoso"), a link to the owner's page (backup health or topology site), and no device actions (DelegateToOperator, device filter) for non-device owners. Mobile is already null-safe; verify only. |

Already safe and not changed: the Partner API alert feed, webhook enrichment, Breeze tickets, reports and search. They use left joins and nullable DTOs.

**Also in W1 scope:**
- **Flows.** `flows/eventTrigger.ts` starts flows on `alert.triggered`. It was not audited in depth, so W1 audits it under the G1 rule.
- **Insert paths.** Nine paths insert alerts directly instead of going through `createAlert`/`createSourcedAlert`:
  - `alertCreation.ts:121`
  - `topology/monitoringAlerts.ts:57`
  - `metricAnomalyPromotion.ts:255`
  - `dnsThreatAlerts.ts:129`
  - `offlineAlertEffects.ts:183`
  - `subjectAlertOutbox.ts:227`
  - `logSearch.ts:1157`
  - `aiAgents/fixWatch.ts:924`
  - `aiAgents/actVerify.ts:460`

  All of these pass a device. W1 adds a contract test that every alert insert sets `owner_kind` explicitly, so a future device-less writer can't bypass the guards.

### First producer: SaaS backup workloads

`services/backupProviders/alerts.ts`: SaaS rows that are mapped to an org and raise a condition (same two-poll hysteresis) call `createSourcedAlert` with these values:
- `ownerKind: 'backup_workload'`
- `ownerRef: row.id`
- `deviceId: null`
- severity: from the condition table
- title: `"<Workload label> backup <condition> — <customer/org name>"`

The existing resolve paths close the alert when the condition clears or the row disappears. The existing `backup.provider_device_*` events continue unchanged.

## Waves

1. **W1 Foundation and guards.** Migration, schema and types, the owner-key helper, and guards G1–G8 and G10–G11. No producer creates device-less alerts yet. Add a **contract test that pushes a device-less fixture alert through every consumer in the table**. Rigor: full, because this touches tenancy, automation targeting and migrations.
2. **W2 Surfaces.** G9 templates and payloads, and G12 web UI. Verify mobile.
3. **W3 SaaS backup producer.** `backup_workload` alerts from backup-provider sync, docs and release notes.
4. **W4 Topology preservation (#7269).** Backfill check, the G10 behaviour change, and the topology UI linking to the site.

W1 must merge before any producer ships. W2 and W4 can run in parallel after W1. W3 needs W1 and W2.

## Testing

- **Unit:** each guard G1–G8 has a red test with a device-less alert. G1 includes a partner-wide automation that must not target any device.
- **Real-DB integration:**
  - The CHECK constraint rejects invalid owner combinations.
  - The open-owner unique index blocks a second open `backup_workload` alert.
  - RLS on `alerts` is unchanged.
  - Device deletion preserves `topology_site` alerts (#7269).
  - Org cascade, merge and export suites pass with the new columns.
- **E2E (W2):** the alert list and detail pages render a device-less alert with no `/devices/null` link.

## Open decisions

1. **Visibility for site-restricted users.** Should site-restricted technicians see org-level alerts at all? The recommendation is **no** (fail closed, G5). A later setting could grant it.
2. **Org-level alerts and alert rules.** Should device-less alerts count toward rule-based alert policies, such as maintenance windows? The recommendation is no in v1: maintenance windows are device- or site-scoped. Org-level alerts ignore them, and this is documented.
3. **Raising alerts for existing Cove M365 rows in W3.** The recommendation is yes. They follow the same rule, and the release notes say so.
