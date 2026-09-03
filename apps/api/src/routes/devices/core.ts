import { Hono } from 'hono';
import { z } from 'zod';
import { optionalJsonValidator, zValidator } from '../../lib/validation';
import { and, eq, gte, like, sql, desc, inArray, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createHash, randomBytes } from 'crypto';
import { getRedis } from '../../services/redis';
import { invalidateOrgDeviceCount } from '../../services/agentOrgRateLimit';
import {
  devices,
  deviceHardware,
  deviceReliability,
  deviceNetwork,
  deviceMetrics,
  deviceGroupMemberships,
  deviceGroups,
  sites,
  enrollmentKeys,
  organizations,
  partners,
  users,
} from '../../db/schema';
import {
  authMiddleware,
  isInteractiveUserSession,
  requireMfa,
  requireScope,
  requirePermission,
  type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import {
  getPagination,
  getDeviceWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
  stripSensitiveDeviceFields,
} from './helpers';
import { listDevicesSchema, updateDeviceSchema, decommissionDeviceSchema } from './schemas';
import {
  DEVICES_LIST_DEFAULT_LIMIT,
  DEVICES_LIST_HARD_MAX,
  buildKeysetPredicate,
  buildOrderBy,
  cursorFromRow,
  decodeCursor,
  defaultSortDir,
  defaultSortKey,
  encodeCursor,
  type DevicesSortDir,
  type DevicesSortKey,
} from './cursor';
import { writeRouteAudit } from '../../services/auditEvents';
import { dissolveLinkGroupIfBelowMinimum } from '../../services/deviceLinkGroups';
import { deleteDeviceCascade } from '../../services/deviceDeletion';
import { resolveRemoteAccessForDevice } from '../../services/remoteAccessPolicy';
import {
  resolveRemoteAccessLaunch,
  checkRemoteAccessLaunchAvailability,
  type RemoteAccessLaunchResult,
  type RemoteAccessLaunchAvailability,
  type RemoteAccessLaunchSkipReason,
} from '../../services/remoteAccessLauncher';
import { captureException } from '../../services/sentry';
import type { InheritableRemoteAccessSettings, PartnerSettings } from '@breeze/shared';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { sendCommandToAgent, isAgentConnected, disconnectAgent } from '../agentWs';
import { terminateDeviceRemoteSessions, TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import { queueDeviceUninstall, releaseDeviceRemoveReason } from '../../services/deviceUninstallDrain';
import { CommandTypes } from '../../services/commandQueue';
import { getGlobalEnrollmentSecret } from '../agents/enrollment';
import { assertTtlWithinCap } from '../../services/enrollmentDefaults';
import {
  withExtensionDeviceCascade,
  withExtensionDeviceOrgDenormalized,
  withExtensionDeviceOrgMoveDelete,
} from '../../extensions/tenancyRegistry';
import { pgErrorCode, pgErrorNode } from '../../utils/pgErrors';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { requireCapability } from '../../services/partnerTrust';


/**
 * Tables where linked_device_id (not device_id) references devices.id.
 * These get SET NULL rather than deleted during cascade.
 */
export const DEVICE_LINKED_DEVICE_ID_TABLES = [
  'network_change_events',
  'discovered_assets',
] as const;

/**
 * Per-table columns that describe the LINK rather than the row, keyed by a
 * table in {@link DEVICE_LINKED_DEVICE_ID_TABLES}. Each must be cleared in the
 * SAME `UPDATE` that nulls `linked_device_id` (services/deviceDeletion.ts).
 *
 * #3952 — `discovered_assets.link_source` records HOW the asset came to be
 * linked ('manual' | 'auto'), and 2026-06-27-discovered-asset-link-source.sql
 * forbids the nonsensical "source without a link":
 *
 *   CHECK (link_source IS NULL OR linked_device_id IS NOT NULL)
 *
 * The cascade nulled `linked_device_id` alone, leaving `link_source = 'auto'`
 * behind, so permanently deleting any AUTO-linked device raised 23514 and
 * rolled the whole transaction back as a 500 — a self-hoster hit this on
 * 0.107.0.
 *
 * The constraint draws NO manual/auto distinction: a manually-linked asset
 * failed identically. 'auto' is simply what the bug report carried, and why no
 * manual-link report arrived is NOT established — do not read the reported
 * shape as the bug's boundary. (It is specifically not an API asymmetry:
 * #3261/#3295 removed the manual-only rule from the unlink route on
 * 2026-08-11, ten days before 0.107.0 was tagged, so by then that route
 * unlinked both.) The integration test covers both link sources for this
 * reason.
 *
 * Rows are DETACHED, never deleted: a discovered asset is a network-inventory
 * record about an endpoint that exists whether or not Breeze manages it, and
 * it carries operator-curated state (label, notes, tags, approval/dismissal,
 * type classification, first_seen_at) that must outlive the device row. The
 * table's membership in {@link DEVICE_LINKED_DEVICE_ID_TABLES} already encodes
 * that decision — this registry only completes the detach.
 *
 * NOT every linked table belongs here, which is why this is per-table and not
 * a flat column list: `network_change_events` has no `link_source`, and
 * appending the assignment there would trade 23514 for 42703
 * (undefined_column) — a 500 either way.
 *
 * `auto_link_suppressed_at` is deliberately ABSENT. It is a durable record of
 * a human's "stop re-linking this" (#3261), not a property of the link, and
 * the CHECK constraint does not cover it. Deleting a device says nothing about
 * that preference, so the cascade must leave it alone.
 *
 * cascadeDelete.test.ts derives the required entries from the CHECK
 * constraints in apps/api/migrations and fails CI when one is missing.
 */
export const DEVICE_LINK_DEPENDENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  discovered_assets: ['link_source'],
};

/**
 * Tables with a device_id FK to devices.id whose rows are tenant business
 * records — preserve history, detach the device (device_id SET NULL) instead
 * of cascade-deleting during permanent device deletion. Deviceless tickets
 * are first-class (tickets.device_id is nullable).
 */
// support_sessions (Quick Support) detaches rather than cascades: the session
// row is the audit trail for an ad-hoc support session and must outlive the
// ephemeral device the reaper purges 6h after the session ends. Its device_id
// FK is declared ON DELETE SET NULL to match.
// abuse_endpoint_fingerprints (recidivist-endpoint abuse detector) also
// detaches: it's an operator corpus that must survive device hard-delete so
// cross-partner endpoint correlation still works after the originating
// device is gone. Its device_id FK is declared ON DELETE SET NULL to match.
export const DEVICE_DETACH_DEVICE_ID_TABLES = [
  'abuse_endpoint_fingerprints', 'ai_agent_runs', 'support_sessions', 'tickets',
] as const;

/**
 * Subset of {@link getDeviceCascadeDeleteTables} ∪
 * {@link DEVICE_DETACH_DEVICE_ID_TABLES} whose rows denormalize
 * `org_id` for RLS performance. When a device moves between orgs, every
 * one of these tables must have its `org_id` rewritten inside the same
 * transaction that flips `devices.org_id`, otherwise pre-existing rows
 * stay visible to the OLD org under RLS and invisible to the NEW org.
 *
 * IMPORTANT: When you add a new device-scoped table with an `org_id`
 * column, add it here too. The test in moveOrg.coverage.test.ts will
 * fail CI if you forget.
 *
 * Tables intentionally excluded (no `org_id` column today):
 *   automation_policy_compliance, deployment_devices, deployment_results,
 *   device_commands (system-scoped per RLS policy), device_software,
 *   patch_job_results, patch_rollbacks,
 *   psa_ticket_mappings, software_compliance_status
 *
 * ai_agent_runs is deliberately ABSENT (wave 3b, owner decision 2026-08-23):
 * agent-run history stays with the source org on a cross-org move — moveOrg
 * detaches device_id instead. It is listed in INTENTIONALLY_NO_ORG_ID in
 * moveOrg.coverage.test.ts. Its org_id is trigger-immutable
 * (2026-09-06-a-agent-runs-org-immutable.sql).
 *
 * ai_unattended_exposure is deliberately ABSENT too (wave 5a, #3827): it has
 * an org_id column but is cascade-deleted, not moved. (a) Exposure history
 * stays with the org the unattended action ran in — the same
 * ai_agent_runs owner decision above — and re-stamping it would attribute
 * the old org's unattended-action count to the new org, corrupting the cap
 * the ledger exists to enforce. (b) The generic move-org loop UPDATEs
 * org_id alone, which would violate the (org_id, partner_id) →
 * organizations(id, partner_id) composite FK the moment the two orgs sit
 * under different partners — the same reason recorded in the
 * orgMergeRegistry entry for this table. It is listed in
 * INTENTIONALLY_NO_ORG_ID in moveOrg.coverage.test.ts.
 *
 * ai_agent_fix_watches is deliberately ABSENT too (wave 6 PR 2, #3828): it
 * has both org_id and device_id columns but is cascade-deleted, not moved —
 * identical reasoning to ai_unattended_exposure above, transplanted to
 * watch history: (a) a fix-held watch's org attribution stays with the run
 * it watches, which itself never follows a device move (ai_agent_runs is
 * ABSENT from this same list, above), so re-stamping the watch's org_id
 * while its run stays under the old org would split one remediation's
 * story across two orgs; (b) the same (org_id, partner_id) composite FK
 * fragility applies the moment the two orgs sit under different partners.
 * It is listed in INTENTIONALLY_NO_ORG_ID in moveOrg.coverage.test.ts.
 */
const CORE_DEVICE_ORG_DENORMALIZED_TABLES = [
  'agent_health_observations', 'agent_logs', 'ai_screenshots', 'ai_sessions', 'alerts', 'asset_checkouts',
  'audit_baseline_results', 'audit_policy_states',
  'automation_action_results', 'automation_run_device_results',
  'backup_chains', 'backup_jobs', 'backup_sla_events',
  'backup_snapshots', 'backup_verifications',
  'brain_device_context', 'browser_extensions', 'browser_policy_violations',
  'capacity_predictions',
  'cis_baseline_results', 'cis_remediation_actions',
  'deployment_invites',
  'device_agent_health_latest', 'device_boot_metrics', 'device_change_log', 'device_config_state',
  'device_connections', 'device_disks', 'device_event_logs',
  'device_filesystem_cleanup_runs', 'device_filesystem_scan_state',
  'device_filesystem_snapshots',
  'device_group_memberships', 'device_hardware', 'device_ip_history',
  'device_metrics', 'device_mtls_certificates', 'device_network', 'device_patches',
  'device_process_samples', 'device_recovery_keys', 'device_registry_state',
  'agent_rollback_events', 'agent_rollback_directives',
  'device_reliability', 'device_reliability_history', 'device_sessions', 'device_software_inventory_state',
  'device_vulnerabilities', 'device_warranty',
  'dns_event_aggregations', 'dns_security_events',
  'elevation_requests',
  'fleet_finding_devices',
  'group_membership_log',
  'huntress_agents', 'huntress_incidents', 'hyperv_vms', 'local_vaults',
  'metric_anomaly_candidates', 'metric_anomalies', 'metric_anomaly_incidents', 'metric_rollups',
  'onedrive_device_state',
  'peripheral_events', 'peripheral_policy_delivery_events', 'peripheral_policy_device_states',
  'playbook_executions', 'provision_credential_handles',
  'recovery_key_access_events',
  'recovery_readiness', 'recovery_tokens', 'remediation_suggestions', 'remote_sessions', 'restore_jobs',
  's1_actions', 's1_agents', 's1_threats',
  'script_executions',
  'security_posture_snapshots', 'security_scans', 'security_status',
  'security_threats',
  'sensitive_data_findings', 'sensitive_data_scans',
  'service_process_check_results',
  'software_inventory', 'software_inventory_observations', 'software_policy_audit', 'software_remediation_requests', 'sql_instances',
  'support_sessions',
  'tickets', 'time_series_metrics', 'tunnel_sessions',
] as const;

/**
 * Registered device/org tables whose org stamp is propagated by some OTHER
 * privileged mechanism, so move-org must NOT also issue its ordinary
 * app-role UPDATE against them (breeze_app lacks UPDATE on some of these,
 * and for the rest it would just be redundant with what already ran).
 *
 * Two different mechanisms populate this list:
 *  - `agent_health_observations` / `software_inventory_observations`: a
 *    composite FK on `devices(id, org_id)` declared `ON UPDATE CASCADE`, so
 *    PostgreSQL's own referential action restamps them the instant the
 *    `devices` row's org_id changes (line ~234's `.update(devices)` above)
 *    — immutable evidence can only be restamped this way, never by a
 *    direct app-role UPDATE.
 *  - `agent_rollback_events` (#4371 fixup): breeze_app has UPDATE revoked
 *    entirely (see ensureAppRole.ts's writer-path matrix), so restamping it
 *    the ordinary way here would 42501. It does NOT have its own `ON
 *    UPDATE CASCADE` FK (only `ON DELETE CASCADE` — ON UPDATE defaults to
 *    NO ACTION, so it must actually be re-tenanted, not just left alone).
 *    That happens via `breeze_cascade_device_org_id()` (migrations/
 *    2026-05-18-device-child-orgid-cascade.sql) instead: a SECURITY
 *    DEFINER trigger on `devices` (AFTER UPDATE OF org_id) that discovers
 *    every ordinary table with both a uuid `device_id` and `org_id` column
 *    and restamps it under the function owner's privileges, bypassing
 *    breeze_app's revoke the same way FK actions do. It fires as a row
 *    trigger on the SAME `.update(devices)` statement above, so by the
 *    time this loop runs, agent_rollback_events.org_id is already correct
 *    — verified against real Postgres:
 *    `SELECT * FROM breeze_device_child_orgid_tables()` includes it.
 *    (`pam_actuation_results` is deliberately EXCLUDED from that same
 *    discovery function — migrations/2026-09-17-pam-device-move-guard.sql
 *    — because a device with PAM history cannot move orgs at all; see
 *    devices_pam_history_move_guard / PamDeviceMoveBlockedError below.)
 */
export const DEVICE_ORG_FK_CASCADE_TABLES: readonly string[] = [
  'agent_health_observations',
  'software_inventory_observations',
  'agent_rollback_events',
];

export function getDeviceOrgDenormalizedTables(): readonly string[] {
  return withExtensionDeviceOrgDenormalized(CORE_DEVICE_ORG_DENORMALIZED_TABLES);
}

const CORE_DEVICE_ORG_MOVE_DELETE_TABLES: readonly string[] = [];

export function getDeviceOrgMoveDeleteTables(): readonly string[] {
  return withExtensionDeviceOrgMoveDelete(CORE_DEVICE_ORG_MOVE_DELETE_TABLES);
}

/** @deprecated Static core-only snapshot retained for call sites that predate extensions. */
export const DEVICE_ORG_DENORMALIZED_TABLES = CORE_DEVICE_ORG_DENORMALIZED_TABLES;

/**
 * Tables that denormalize `org_id` for RLS but have NO `device_id` column,
 * so the generic {@link getDeviceOrgDenormalizedTables} rewrite loop in
 * moveOrg.ts (which keys on `WHERE device_id = ...`) cannot reach them.
 * Each table here gets a dedicated, hand-written UPDATE inside the move-org
 * transaction — e.g. `ticket_alert_links` is rewritten via its alert_id
 * join to alerts.device_id.
 *
 * moveOrg.coverage.test.ts asserts this list is disjoint from the generic
 * lists (a table with a device_id column belongs there instead) and that
 * every entry exists with org_id but without device_id, so a future table
 * can't silently skip both paths. The dedicated statements themselves are
 * covered by behavior tests in moveOrg.test.ts.
 *
 * ORDER IS LOAD-BEARING, not cosmetic (#4657). `moveTicketOrg`
 * (services/ticketService.ts) re-stamps these same tables `WHERE ticket_id`,
 * and its rows overlap this path's — so both movers must take the locks in
 * one order or a concurrent ticket-move and device-move deadlock with 40P01.
 * That order is stated once, with its rationale, in
 * services/ticketOrgMoveLockOrder.ts; this list must match it, and
 * ticketOrgMoveLockOrder.test.ts fails if it drifts. moveOrg.test.ts pins the
 * hand-written UPDATEs in moveOrg.ts to this array's order in turn, so the
 * statements cannot drift from the list either.
 */
export const CUSTOM_ORG_REWRITE_TABLES = [
  'time_entries',
  'ticket_parts',
  'ticket_alert_links',
  'ticket_outbox',
  'ticket_attachments',
  'ticket_email_links',
] as const;

/**
 * Tables that are both device-id scoped AND denormalize site_id for query-perf.
 * EVERY write path that changes devices.site_id must rewrite each row's
 * site_id in the same transaction, or those rows strand under the OLD
 * site_id. Today that is two paths:
 *   - POST /devices/:id/move-org (moveOrg.ts — cross-org-cross-site move)
 *   - PATCH /devices/:id        (this file — same-org site change)
 * The moveOrg.coverage.test.ts drift-detector enforces that any future
 * schema PR adding site_id to a device-id-scoped table populates this list.
 */
export const DEVICE_SITE_DENORMALIZED_TABLES = [
  'elevation_requests',
] as const;

/**
 * All tables with a direct device_id FK to devices.id, ordered so children come
 * before parents (to avoid FK violations during cascade delete).
 *
 * Tables whose only FK to devices is via an intermediate table with ON DELETE CASCADE
 * (e.g. vault_snapshot_inventory → local_vaults) don't need to be listed here.
 *
 * IMPORTANT: When you add a new table with a device_id FK, add it here.
 * The test in cascadeDelete.test.ts will fail CI if you forget.
 */
const CORE_DEVICE_CASCADE_DELETE_TABLES = [
  // recovery_tokens & backup_chains FK to backup_snapshots (no cascade),
  // so delete them first, then restore_jobs → backup_snapshots → backup_jobs
  'recovery_tokens', 'backup_chains',
  'restore_jobs', 'backup_verifications', 'backup_snapshots', 'backup_jobs',
  // Application backup & DR
  'sql_instances', 'local_vaults', 'hyperv_vms',
  // Deployment invites (FK device_id → devices.id; no cascade)
  'deployment_invites',
  // Core device tables
  // Latest projection references the immutable observation, so it must be
  // deleted before the observation in the explicit device cascade.
  'device_agent_health_latest', 'device_software_inventory_state',
  'agent_health_observations', 'software_inventory_observations',
  'device_group_memberships', 'group_membership_log',
  'device_hardware', 'device_network', 'device_ip_history', 'device_disks',
  'device_metrics', 'device_software', 'device_registry_state', 'device_config_state',
  'device_commands', 'device_connections', 'device_boot_metrics',
  'device_sessions', 'device_change_log', 'device_warranty', 'device_vulnerabilities',
  // mTLS certificate history (Wave 5 Task 2, security remediation) — FK
  // device_id -> devices.id ON DELETE CASCADE (composite with org_id);
  // leaf table, no children.
  'device_mtls_certificates',
  // Patches
  'device_patches', 'patch_job_results', 'patch_rollbacks',
  // Deployments & software
  'deployment_devices', 'deployment_results', 'software_inventory',
  'software_compliance_status', 'software_policy_audit', 'software_remediation_requests',
  // Remote access
  'remote_sessions', 'tunnel_sessions',
  // Monitoring & logs
  'service_process_check_results', 'alerts', 'agent_logs', 'script_executions',
  'device_event_logs', 'automation_policy_compliance', 'backup_sla_events',
  // Per-device automation execution results (FK device_id → devices.id ON DELETE
  // CASCADE; leaf table, no children) — #2023
  'automation_action_results', 'automation_run_device_results',
  // Security
  'sensitive_data_scans', 'sensitive_data_findings',
  'dns_security_events', 'dns_event_aggregations',
  'security_status', 'security_threats', 'security_scans', 'security_posture_snapshots',
  'cis_baseline_results', 'cis_remediation_actions',
  'browser_extensions', 'browser_policy_violations',
  'audit_baseline_results', 'audit_policy_states',
  // Recovery-key escrow (#2021). Both FK device_id → devices.id ON DELETE
  // CASCADE; recovery_key_access_events.key_id → device_recovery_keys.id
  // ON DELETE CASCADE, so delete the access-event ledger before its parent keys.
  'recovery_key_access_events', 'device_recovery_keys',
  'pam_actuations', 'pam_actuation_results',
  'peripheral_policy_delivery_events', 'peripheral_policy_device_states', 'peripheral_events',
  'agent_rollback_events', 'agent_rollback_directives',
  's1_agents', 's1_threats', 's1_actions',
  'huntress_agents', 'huntress_incidents',
  // AI & context
  'ai_sessions', 'ai_screenshots', 'brain_device_context',
  // Unattended-exposure ledger (Wave 5 Part A, #3827) — live device_id
  // column (NOT NULL), no FK to devices, leaf table, no children. Same
  // situation as fleet_finding_devices below: the app-level DELETE is the
  // only thing that reclaims these rows.
  'ai_unattended_exposure',
  // Fix-held watch ledger (Wave 6 PR 2, #3828) — live device_id column
  // (NOT NULL), no FK to devices, leaf table, no children. Same situation
  // as ai_unattended_exposure directly above: the app-level DELETE is the
  // only thing that reclaims these rows. NOT in ai_agent_circuit_state's
  // company here — that table has no device_id column at all (org_id +
  // agent_id only), so it needs no entry in this device-cascade list.
  'ai_agent_fix_watches',
  // Analytics & reliability
  'device_reliability_history', 'device_reliability',
  'playbook_executions', 'time_series_metrics', 'capacity_predictions',
  'device_process_samples', 'remediation_suggestions',
  'metric_anomaly_candidates', 'metric_anomalies', 'metric_anomaly_incidents', 'metric_rollups',
  // Portal & integrations (tickets are detached, not deleted —
  // see DEVICE_DETACH_DEVICE_ID_TABLES)
  'psa_ticket_mappings', 'asset_checkouts',
  // Filesystem
  'device_filesystem_snapshots', 'device_filesystem_cleanup_runs', 'device_filesystem_scan_state',
  // Backup verification
  'recovery_readiness',
  // PAM elevation requests (elevation_audit cascades automatically via FK ON DELETE CASCADE)
  'elevation_requests',
  // Provisioning one-time credential handles (FK device_id → devices.id ON DELETE CASCADE;
  // listed for the explicit-cascade coverage contract — leaf table, no children)
  'provision_credential_handles',
  // OneDrive helper — persisted device state (PK = device_id; leaf table, no children)
  'onedrive_device_state',
  // Fleet hygiene finding membership — live device_id column (no FK; the
  // device-move trigger rewrites org_id in place), leaf table, no children.
  'fleet_finding_devices',
] as const;

export function getDeviceCascadeDeleteTables(): readonly string[] {
  return withExtensionDeviceCascade(CORE_DEVICE_CASCADE_DELETE_TABLES);
}

/** @deprecated Static core-only snapshot retained for call sites that predate extensions. */
export const DEVICE_CASCADE_DELETE_TABLES = CORE_DEVICE_CASCADE_DELETE_TABLES;

export const coreRoutes = new Hono();

coreRoutes.use('*', authMiddleware);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// #1108: caller-supplied onboarding-token limits. Count maps to maxUsage so one
// copied CLI command can enroll a whole batch; TTL cap mirrors the enrollment-
// keys route's 365-day ceiling.
const ENROLL_TOKEN_MAX_COUNT = 1000;
const ENROLL_TOKEN_MAX_TTL_MINUTES = 525_600; // 365 days

// `count` keeps its existing ad-hoc coercion + clamp behaviour below —
// existing clients rely on an out-of-range or non-numeric count being
// silently floored/clamped rather than rejected (devices.test.ts:353+).
// `ttlMinutes` is schema-validated and REJECTED when out of range: a
// silently reduced expiry is the exact failure mode #2775/#2777 were filed
// for, so it gets no such leniency.
//
// Every field is optional because a BODYLESS POST is a supported call shape
// here — first-run guided setup (web setup/EnrollDeviceStep.tsx) and script
// clients both POST with no body while `fetchWithAuth` still sends
// `Content-Type: application/json`. That is why the route uses
// `optionalJsonValidator`, not `zValidator('json', ...)`: the latter 400s
// ("Malformed JSON in request body") on an empty body with a JSON
// content-type, which the previous `c.req.json().catch(() => ({}))` did not.
const onboardingTokenSchema = z.object({
  count: z.unknown().optional(),
  ttlMinutes: z.number().int().min(1).max(ENROLL_TOKEN_MAX_TTL_MINUTES).optional(),
}).strict();

// POST /devices/onboarding-token - Generate a short-lived enrollment key.
// If AGENT_ENROLLMENT_SECRET is configured, enrollment also requires that
// shared secret; otherwise the short-lived key stands on its own.
coreRoutes.post(
  '/onboarding-token',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  requireCapability('installer_distribute'),
  optionalJsonValidator(onboardingTokenSchema),
  async (c) => {
    const auth = c.get('auth');
    const requestedOrgId = c.req.query('orgId');

    let orgId = auth.orgId ?? null;

    if (requestedOrgId) {
      if (!auth.canAccessOrg(requestedOrgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      orgId = requestedOrgId;
    }

    if (!orgId && auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
      const onlyOrgId = auth.accessibleOrgIds[0];
      if (onlyOrgId) {
        orgId = onlyOrgId;
      }
    }

    if (!orgId) {
      return c.json({ error: 'Organization ID required. Provide orgId query parameter.' }, 400);
    }

    // Optional caller-supplied multi-use / TTL controls (#1108). A copied CLI
    // command is frequently pasted onto several machines during a migration;
    // without these the historical hard-coded single-use token failed on every
    // machine after the first. A caller that sends no body still gets a
    // single-use token, but its TTL now follows the shared enrollment default
    // (ENROLLMENT_KEY_DEFAULT_TTL_MINUTES, 30 days) rather than the old 60
    // minutes — this route mints a real `enrollment_keys` row, and a token
    // staged through deployment tooling has to outlive the download day.
    const data = c.req.valid('json');
    const rawCount = Number((data as { count?: unknown }).count);
    const maxUsage = Number.isFinite(rawCount)
      ? Math.min(ENROLL_TOKEN_MAX_COUNT, Math.max(1, Math.trunc(rawCount)))
      : 1;
    // Explicit-ttl-vs-default is distinguished BEFORE the default is applied:
    // assertTtlWithinCap must see what the caller actually asked for (an
    // omitted ttlMinutes stays `undefined`, which the gate never rejects — an
    // unset value has no chooser to hold to a cap). No coercion or clamping is
    // needed here: the Zod schema already guarantees an integer in 1..525_600
    // and REJECTS anything outside it rather than silently reducing it.
    const explicitTtlMinutes = data.ttlMinutes;

    // Reject (never clamp) a caller-supplied TTL above the partner cap
    // (#2776 task 3.4). Runs after org resolution — orgId is required.
    const capError = await assertTtlWithinCap(orgId, explicitTtlMinutes);
    if (capError) return c.json({ error: capError }, 400);

    // Pick the first site in the org for the enrollment key
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.orgId, orgId))
      .limit(1);

    if (!site) {
      return c.json({ error: 'No site found for this organization. Create a site first.' }, 400);
    }

    const ttlMinutes = explicitTtlMinutes
      ?? envInt('ENROLLMENT_KEY_DEFAULT_TTL_MINUTES', 60 * 24 * 30);

    const key = `enroll_${randomBytes(24).toString('hex')}`;
    const keyHash = hashEnrollmentKey(key);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await db.insert(enrollmentKeys).values({
      orgId,
      siteId: site.id,
      name: `Onboarding token (${new Date().toISOString().slice(0, 10)})`,
      key: keyHash,
      maxUsage,
      expiresAt,
      createdBy: auth.user.id,
    });

    const configuredSecret = getGlobalEnrollmentSecret();
    const secretRequired = configuredSecret !== null;

    return c.json({
      token: key,
      maxUsage,
      expiresAt: expiresAt.toISOString(),
      enrollmentSecretMode: secretRequired ? 'global_env' : 'none',
      additionalSecretRequired: secretRequired,
      ...(secretRequired && { enrollmentSecret: configuredSecret }),
    });
  }
);

// GET /devices - List devices (paginated, filtered, sorted)
//
// Pagination modes (Discussion #742 PR 3):
//   - **Cursor (default)**: pass `?cursor=<opaque>` (omit on first page).
//     Server returns `{nextCursor, limit, total?}`. Scales to any fleet
//     size; constant cost per page; stable under concurrent UPDATEs that
//     don't touch the sort column. `total` is included only when the
//     first page is requested with `includeTotal=true` — the client
//     carries the count it receives across subsequent pages so we don't
//     re-COUNT(*) per cursor step.
//   - **Legacy offset**: pass `?page=N` (no cursor). Returns
//     `{page, limit, total}` exactly as before for existing callers.
//     Honored only when `page` is explicitly provided. New callers should
//     migrate to the cursor mode.
//
// Sort whitelist: `hostname` (default, ASC), `lastSeen` (DESC),
// `enrolled` (DESC). Each backed by a covering index. The keyset
// ORDER BY/LIMIT is owned by `cursor.ts` and is never delegated to the
// FilterConditionGroup engine — a filter-supplied ORDER BY would
// silently break the keyset's monotonicity guarantee.
coreRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    // -------- pagination mode + page-size --------
    const isCursorMode = query.page === undefined || query.cursor !== undefined;
    // Default sort branches by pagination mode (see `defaultSortKey`):
    // legacy `?page=N` callers keep the pre-cursor `last_seen_at DESC`
    // ordering; cursor mode defaults to `hostname ASC` because the
    // keyset's monotonicity is most stable on a NOT NULL string column.
    const sort: DevicesSortKey = query.sort ?? defaultSortKey(isCursorMode);
    const sortDir: DevicesSortDir = query.sortDir ?? defaultSortDir(sort);
    const limit = Math.min(
      DEVICES_LIST_HARD_MAX,
      Math.max(1, Number.parseInt(query.limit ?? String(DEVICES_LIST_DEFAULT_LIMIT), 10) || DEVICES_LIST_DEFAULT_LIMIT),
    );

    // Decode the incoming cursor up front so we can reject mismatches
    // before paying for the row query. A cursor whose sort/dir does not
    // match the query is a client bug, not a continuation — refuse it
    // instead of silently restarting the walk and confusing the caller.
    const cursor = isCursorMode ? decodeCursor(query.cursor ?? null) : null;
    if (query.cursor && !cursor) {
      return c.json({ error: 'Invalid or malformed cursor' }, 400);
    }
    if (cursor && (cursor.sort !== sort || cursor.sortDir !== sortDir)) {
      return c.json(
        { error: 'Cursor sort/sortDir does not match query — start a fresh walk' },
        400,
      );
    }

    // -------- row-filter predicates --------
    const conditions: SQL[] = [];

    // Quick Support devices live in the partner's hidden 'quick_support' org,
    // which deliberately stays inside accessibleOrgIds so RLS lets a tech reach
    // their own session. Nothing filters them out for us — exclude explicitly.
    conditions.push(eq(devices.isEphemeral, false));

    // Org access — uses pre-computed accessibleOrgIds from auth.
    const orgFilter = auth.orgCondition(devices.orgId);
    if (orgFilter) {
      conditions.push(orgFilter);
    }

    // Optional single-org filter (must be accessible).
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(devices.orgId, query.orgId));
    }

    // Multi-org filter — first-class. Each entry must be accessible; we
    // pre-check rather than rely on RLS to silently drop non-accessible
    // ids (RLS would drop them but the caller wouldn't know the filter
    // was effectively narrowed).
    if (query.orgIds && query.orgIds.length > 0) {
      for (const oid of query.orgIds) {
        if (!auth.canAccessOrg(oid)) {
          return c.json({ error: `Access to organization ${oid} denied` }, 403);
        }
      }
      conditions.push(inArray(devices.orgId, query.orgIds));
    }

    const permissions = c.get('permissions') as UserPermissions | undefined;
    const allowedSiteIds = permissions?.allowedSiteIds;
    const requestedSiteIds = [
      ...(query.siteId ? [query.siteId] : []),
      ...(query.siteIds ?? []),
    ];
    const uniqueRequestedSiteIds = [...new Set(requestedSiteIds)];

    if (allowedSiteIds) {
      const requestedOutsideAllowlist = uniqueRequestedSiteIds.find((siteId) => !allowedSiteIds.includes(siteId));
      if (requestedOutsideAllowlist) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }

      const effectiveSiteIds = uniqueRequestedSiteIds.length > 0
        ? uniqueRequestedSiteIds
        : allowedSiteIds;
      conditions.push(effectiveSiteIds.length > 0
        ? inArray(devices.siteId, effectiveSiteIds)
        : sql`false`);
    } else {
      if (query.siteId) {
        conditions.push(eq(devices.siteId, query.siteId));
      }
      if (query.siteIds && query.siteIds.length > 0) {
        conditions.push(inArray(devices.siteId, query.siteIds));
      }
    }

    // Group membership filter — EXISTS subquery against the join table
    // so we don't widen the SELECT row count if a device sits in
    // multiple groups in the filter set.
    if (query.groupIds && query.groupIds.length > 0) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM ${deviceGroupMemberships}
        WHERE ${deviceGroupMemberships.deviceId} = ${devices.id}
          AND ${deviceGroupMemberships.groupId} IN (${sql.join(
            query.groupIds.map((g) => sql`${g}::uuid`),
            sql`, `,
          )})
      )`);
    }

    if (query.status) {
      conditions.push(eq(devices.status, query.status));
    }
    if (query.osType) {
      conditions.push(eq(devices.osType, query.osType));
    }
    if (query.role) {
      conditions.push(eq(devices.deviceRole, query.role));
    }
    if (query.search) {
      conditions.push(like(devices.hostname, `%${query.search}%`));
    }

    // Exclude decommissioned by default unless explicitly requested.
    if (!query.status && query.includeDecommissioned !== 'true') {
      conditions.push(sql`${devices.status} != 'decommissioned'`);
    }

    // Keyset predicate (cursor mode only).
    if (cursor) {
      conditions.push(buildKeysetPredicate(cursor));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // -------- total (only if asked, only on first page) --------
    // Cursor mode: count only when caller opts in AND there's no
    // incoming cursor (the count is a once-per-walk thing the client
    // carries). Offset mode: always count (legacy contract).
    let total: number | undefined;
    const wantsTotal = isCursorMode
      ? query.includeTotal === 'true' && !cursor
      : true;
    if (wantsTotal) {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(devices)
        .where(whereCondition);
      total = Number(countResult[0]?.count ?? 0);
    }

    // -------- row query --------
    const orderBy = buildOrderBy(sort, sortDir);
    // Cursor mode peeks one extra row to detect "is there a next page" —
    // if N+1 rows come back, the (N+1)th becomes the nextCursor seed and
    // is trimmed from the response data. Offset mode uses the requested
    // limit verbatim.
    const fetchLimit = isCursorMode ? limit + 1 : limit;
    const offset = isCursorMode ? 0 : Math.max(0, ((Number.parseInt(query.page ?? '1', 10) || 1) - 1) * limit);

    const rows = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        agentId: devices.agentId,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        deviceRole: devices.deviceRole,
        deviceRoleSource: devices.deviceRoleSource,
        osVersion: devices.osVersion,
        osBuild: devices.osBuild,
        architecture: devices.architecture,
        agentVersion: devices.agentVersion,
        watchdogVersion: devices.watchdogVersion,
        agentServerUrl: devices.agentServerUrl,
        status: devices.status,
        watchdogStatus: devices.watchdogStatus,
        mainAgentSilentSince: devices.mainAgentSilentSince,
        lastSeenAt: devices.lastSeenAt,
        // WAN IP for the opt-in list column (#2503): the source address of the
        // agent's last authenticated request, stamped by agentAuth. That is
        // the device's public address as the control plane sees it — note that
        // device_network.public_ip looks like the obvious source but is never
        // written by any code path and is always NULL.
        lastSeenIp: devices.lastSeenIp,
        enrolledAt: devices.enrolledAt,
        tags: devices.tags,
        customFields: devices.customFields,
        desktopAccess: devices.desktopAccess,
        lastUser: devices.lastUser,
        uptimeSeconds: devices.uptimeSeconds,
        isHeadless: devices.isHeadless,
        pendingReboot: devices.pendingReboot,
        // Scheduled end-user restart (#3207 W5). Projected into the LIST as
        // well as the detail response because DeviceDetails is handed the
        // list-shaped row while its own detail fetch is still in flight — the
        // badge would otherwise pop in a beat late on every navigation.
        rebootScheduledAt: devices.rebootScheduledAt,
        rebootDeadline: devices.rebootDeadline,
        rebootSource: devices.rebootSource,
        rebootDeferralsUsed: devices.rebootDeferralsUsed,
        rebootMaxDeferrals: devices.rebootMaxDeferrals,
        // Collision enrollment (#2764): non-null when this row was created
        // because an agent presented a hostname that already existed in the
        // org. The list renders a "Possible duplicate" badge from it so the
        // review surface is discoverable from the fleet view, not only from
        // the device page a tech happens to open.
        possibleReplacementOfDeviceId: devices.possibleReplacementOfDeviceId,
        batteryStatus: devices.batteryStatus,
        activeVpns: devices.activeVpns,
        // Linked multi-boot profiles (#2138): null => unlinked. The web list
        // groups rows client-side by this id (inactive strips / group bar).
        linkGroupId: devices.linkGroupId,
        // vm_host member role (#2308): 'host' | 'guest' | null. Lets the web
        // list nest guest rows under their host without joining the group
        // table — a non-null role implies the group's kind is 'vm_host'.
        linkGroupRole: devices.linkGroupRole,
        createdAt: devices.createdAt,
        updatedAt: devices.updatedAt,
        // Hardware summary
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb,
        // Reliability headline score (#1720) — surfaced as a sortable list
        // column. device_reliability is org-scoped (RLS shape #1), so the
        // leftJoin stays tenant-safe; null when no score computed yet.
        reliabilityScore: deviceReliability.reliabilityScore,
        reliabilityTrend: deviceReliability.trendDirection,
        // RDS per-session helpers (plan 2 heartbeat ingest) — UI hint only,
        // see the truthy-guard comment in heartbeat.ts. Tasks 13/14 gate the
        // session picker on this being 'on-demand' at the list-row level.
        helperLifecycleMode: devices.helperLifecycleMode
      })
      .from(devices)
      .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
      .leftJoin(deviceReliability, eq(devices.id, deviceReliability.deviceId))
      .where(whereCondition)
      .orderBy(...orderBy)
      .limit(fetchLimit)
      .offset(offset);

    // Cursor-mode: split off the peek row to compute nextCursor.
    let nextCursor: string | null = null;
    let deviceList = rows;
    if (isCursorMode && rows.length > limit) {
      deviceList = rows.slice(0, limit);
      const lastReturned = deviceList[deviceList.length - 1];
      if (lastReturned) {
        nextCursor = encodeCursor(cursorFromRow(lastReturned, sort, sortDir));
      }
    }

    const deviceIds = deviceList.map(d => d.id);

    const latestMetricsByDevice = new Map<string, {
      cpuPercent: number;
      ramPercent: number;
      timestamp: Date;
    }>();

    // Best current LAN address per device for the opt-in list column (#2503);
    // populated by the batched lateral below. Absent => the column dashes.
    const lanIpByDevice = new Map<string, string>();

    if (deviceIds.length > 0) {
      // Per-device latest-row lookup via LATERAL + LIMIT 1 against the
      // (device_id, timestamp) primary key. Index-scan-backward returns
      // one row per device in O(log n) per device. Replaces a
      // GROUP BY MAX + self-join shape that scanned every metric row
      // per device to compute the max timestamp — quadratic in metric
      // history depth, observed at ~1 s on a 70-device fleet with
      // ~8.8k rows/device.
      //
      // Build a VALUES tuple list so each id is bound as its own $N::uuid
      // parameter. Drizzle's sql template spreads a JS array into N
      // positional params (not a single uuid[]), which breaks the
      // natural-looking `unnest(${ids}::uuid[])` form at runtime —
      // PostgresError: cannot cast type record to uuid[]. The VALUES
      // form sidesteps that.
      const idTuples = sql.join(
        deviceIds.map((id) => sql`(${id}::uuid)`),
        sql`, `
      );
      const metricsRows = await db.execute<{
        device_id: string;
        cpu_percent: number;
        ram_percent: number;
        timestamp: Date;
      }>(sql`
        SELECT d.device_id, m.cpu_percent, m.ram_percent, m.timestamp
        FROM (VALUES ${idTuples}) AS d(device_id)
        INNER JOIN LATERAL (
          SELECT cpu_percent, ram_percent, timestamp
          FROM ${deviceMetrics}
          WHERE device_id = d.device_id
          ORDER BY timestamp DESC
          LIMIT 1
        ) AS m ON true
      `);

      for (const row of metricsRows) {
        latestMetricsByDevice.set(row.device_id, {
          cpuPercent: row.cpu_percent,
          ramPercent: row.ram_percent,
          timestamp: row.timestamp,
        });
      }

      // LAN IP for the opt-in list column (#2503). One batched query for the
      // whole page rather than a correlated subquery per row, and NOT a
      // leftJoin on the main row query: device_network is 1:N per device (one
      // row per interface per address family), so joining it there would fan
      // the page out to one row per interface and silently break pagination.
      //
      // Ranking, best-first — the agent's is_primary flag alone is not enough
      // to pick a row, because collectors/inventory.go sets it from a fixed
      // interface-NAME allowlist (en0/eth0/ens33/enp0s3/wlan0/Wi-Fi/Ethernet).
      // Real fleets are full of "Ethernet 2", "eno1", "enp3s0" etc., which
      // that allowlist misses, so a primary-only filter would leave the column
      // blank for a large share of devices. The tiers below degrade instead:
      //   1. is_primary rows first (when the agent did identify one)
      //   2. IPv4 before IPv6 (techs type v4 addresses)
      //   3. routable addresses before APIPA/link-local/loopback — an
      //      unconfigured 169.254.x is worse than useless in a scan column
      //   4. interface_name for a deterministic, stable tiebreak
      const lanIpRows = await db.execute<{ device_id: string; ip_address: string }>(sql`
        SELECT d.device_id, n.ip_address
        FROM (VALUES ${idTuples}) AS d(device_id)
        INNER JOIN LATERAL (
          SELECT ip_address, interface_name
          FROM ${deviceNetwork}
          WHERE device_id = d.device_id
            AND ip_address IS NOT NULL
          ORDER BY
            is_primary DESC,
            (ip_type = 'ipv4') DESC,
            (
              ip_address LIKE '169.254.%'
              OR ip_address LIKE '127.%'
              -- ILIKE, not LIKE: the column is free text from an agent
              -- payload, and an uppercase FE80:: would otherwise be graded
              -- routable and outrank the device's real NIC.
              OR ip_address ILIKE 'fe80:%'
              OR ip_address = '::1'
            ) ASC,
            interface_name ASC
          LIMIT 1
        ) AS n ON true
      `);

      for (const row of lanIpRows) {
        lanIpByDevice.set(row.device_id, row.ip_address);
      }
    }

    // Transform to include hardware and latest metrics as nested objects
    const data = deviceList.map(d => {
      const latestMetrics = latestMetricsByDevice.get(d.id);

      return {
        id: d.id,
        orgId: d.orgId,
        siteId: d.siteId,
        agentId: d.agentId,
        hostname: d.hostname,
        displayName: d.displayName,
        osType: d.osType,
        deviceRole: d.deviceRole,
        deviceRoleSource: d.deviceRoleSource,
        osVersion: d.osVersion,
        osBuild: d.osBuild,
        architecture: d.architecture,
        agentVersion: d.agentVersion,
        watchdogVersion: d.watchdogVersion,
        agentServerUrl: d.agentServerUrl ?? null,
        status: d.status,
        watchdogStatus: d.watchdogStatus,
        mainAgentSilentSince: d.mainAgentSilentSince,
        pendingReboot: d.pendingReboot,
        // Scheduled end-user restart (#3207 W5). All five are null until an
        // agent that reports reboot status has actually scheduled one.
        rebootScheduledAt: d.rebootScheduledAt ?? null,
        rebootDeadline: d.rebootDeadline ?? null,
        rebootSource: d.rebootSource ?? null,
        rebootDeferralsUsed: d.rebootDeferralsUsed ?? null,
        rebootMaxDeferrals: d.rebootMaxDeferrals ?? null,
        lastSeenAt: d.lastSeenAt,
        // Opt-in WAN/LAN IP columns (#2503). Both null-able: wanIp is null
        // until the device has made one authenticated request, lanIp until an
        // inventory run has reported an interface with an address.
        wanIp: d.lastSeenIp ?? null,
        lanIp: lanIpByDevice.get(d.id) ?? null,
        enrolledAt: d.enrolledAt,
        tags: d.tags,
        customFields: d.customFields,
        desktopAccess: d.desktopAccess,
        lastUser: d.lastUser,
        uptimeSeconds: d.uptimeSeconds,
        isHeadless: d.isHeadless,
        // Selected above but historically the mapper is where list fields get
        // silently dropped (#800/#1273/#2138) — asserted by
        // core.list-response-shape.test.ts.
        possibleReplacementOfDeviceId: d.possibleReplacementOfDeviceId ?? null,
        batteryStatus: d.batteryStatus ?? null,
        activeVpns: d.activeVpns ?? null,
        linkGroupId: d.linkGroupId ?? null,
        linkGroupRole: d.linkGroupRole ?? null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        cpuPercent: latestMetrics?.cpuPercent ?? 0,
        ramPercent: latestMetrics?.ramPercent ?? 0,
        hardware: {
          cpuModel: d.cpuModel,
          cpuCores: d.cpuCores,
          ramTotalMb: d.ramTotalMb,
          diskTotalGb: d.diskTotalGb
        },
        // Reliability column (#1720): null when the device has no computed
        // score yet (no device_reliability row) — the list renders a dash.
        reliabilityScore: d.reliabilityScore ?? null,
        reliabilityTrend: d.reliabilityTrend ?? null,
        helperLifecycleMode: d.helperLifecycleMode ?? null,
        metrics: latestMetrics
          ? {
            cpuPercent: latestMetrics.cpuPercent,
            ramPercent: latestMetrics.ramPercent,
            timestamp: latestMetrics.timestamp
          }
          : null
      };
    });

    // Response shape diverges by pagination mode (see route-level comment).
    if (isCursorMode) {
      const pagination: { nextCursor: string | null; limit: number; total?: number } = {
        nextCursor,
        limit,
      };
      if (total !== undefined) pagination.total = total;
      return c.json({
        data,
        pagination,
        sort: { by: sort, dir: sortDir },
      });
    }

    // Legacy offset response (existing callers): unchanged shape.
    const legacyPage = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    return c.json({
      data,
      pagination: { page: legacyPage, limit, total: total ?? 0 },
    });
  }
);

// GET /devices/:id - Get device details
coreRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Get hardware info
    const [hardware] = await db
      .select()
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, deviceId))
      .limit(1);

    // Get network interfaces
    const networkInterfaces = await db
      .select()
      .from(deviceNetwork)
      .where(eq(deviceNetwork.deviceId, deviceId));

    // Get recent metrics (last 24 hours, sampled)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentMetricsRaw = await db
      .select()
      .from(deviceMetrics)
      .where(
        and(
          eq(deviceMetrics.deviceId, deviceId),
          gte(deviceMetrics.timestamp, oneDayAgo)
        )
      )
      .orderBy(desc(deviceMetrics.timestamp))
      .limit(288); // ~5 min intervals for 24 hours

    // Convert BigInt fields to numbers for JSON serialization
    const recentMetrics = recentMetricsRaw.map(m => ({
      ...m,
      diskReadBytes: m.diskReadBytes != null ? Number(m.diskReadBytes) : null,
      diskWriteBytes: m.diskWriteBytes != null ? Number(m.diskWriteBytes) : null,
      diskReadBps: m.diskReadBps != null ? Number(m.diskReadBps) : null,
      diskWriteBps: m.diskWriteBps != null ? Number(m.diskWriteBps) : null,
      diskReadOps: m.diskReadOps != null ? Number(m.diskReadOps) : null,
      diskWriteOps: m.diskWriteOps != null ? Number(m.diskWriteOps) : null,
      networkInBytes: m.networkInBytes != null ? Number(m.networkInBytes) : null,
      networkOutBytes: m.networkOutBytes != null ? Number(m.networkOutBytes) : null,
      bandwidthInBps: m.bandwidthInBps != null ? Number(m.bandwidthInBps) : null,
      bandwidthOutBps: m.bandwidthOutBps != null ? Number(m.bandwidthOutBps) : null
    }));

    // Get group memberships
    const memberships = await db
      .select({
        groupId: deviceGroupMemberships.groupId,
        addedAt: deviceGroupMemberships.addedAt,
        addedBy: deviceGroupMemberships.addedBy,
        groupName: deviceGroups.name,
        groupType: deviceGroups.type
      })
      .from(deviceGroupMemberships)
      .innerJoin(deviceGroups, eq(deviceGroupMemberships.groupId, deviceGroups.id))
      .where(eq(deviceGroupMemberships.deviceId, deviceId));

    // Get site info
    const [site] = await db
      .select({ timezone: sites.timezone, name: sites.name })
      .from(sites)
      .where(eq(sites.id, device.siteId))
      .limit(1);

    // Get org name (used by ChangeSiteModal copy)
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, device.orgId))
      .limit(1);

    // Resolve remote access policy (non-critical — don't fail the whole response)
    let remoteAccessPolicy = null;
    try {
      const remoteAccess = await resolveRemoteAccessForDevice(deviceId);
      remoteAccessPolicy = remoteAccess.policyId ? {
        webrtcDesktop: remoteAccess.settings.webrtcDesktop,
        vncRelay: remoteAccess.settings.vncRelay,
        remoteTools: remoteAccess.settings.remoteTools,
        enableProxy: remoteAccess.settings.enableProxy,
        policyName: remoteAccess.policyName,
        policyId: remoteAccess.policyId,
      } : null;
    } catch (err) {
      console.error(`[DeviceDetail] Failed to resolve remote access policy for ${deviceId}:`, err);
    }

    // Resolve whether a third-party remote-tool launcher (RustDesk,
    // ScreenConnect, TeamViewer, etc.) is configured and usable for this
    // device. This is an AVAILABILITY check only -- it never decrypts the
    // provider password or substitutes the template, so it does not build
    // (or discard) a credential-bearing URL. The actual launch URL is only
    // ever issued by POST /devices/:id/remote-access-launch on click, so the
    // password-bearing URL is never broadcast in detail-fetch responses and
    // never even materialized for a GET. See issue #3402.
    //
    // Skip-reason vocabulary lets the UI distinguish expected-empty
    // ('no_provider_configured'), configuration error ('config_error'),
    // and a potential security event ('scheme_not_allowed': partner
    // template was tampered to resolve to a disallowed scheme only after
    // substitution) -- though `scheme_not_allowed` can only ever be
    // observed by the issuance path (POST), since detecting it requires the
    // substitution this availability check deliberately skips.
    let hasRemoteAccessLauncher = false;
    let remoteAccessLaunchSkipReason: RemoteAccessLaunchSkipReason | 'config_error' | null = null;
    try {
      const availability = await checkRemoteAccessLauncherAvailabilityForDevice(
        device.orgId,
        device.customFields as Record<string, unknown> | null,
        auth,
      );
      if (availability.available) {
        hasRemoteAccessLauncher = true;
      } else {
        remoteAccessLaunchSkipReason = availability.skipReason;
      }
    } catch (err) {
      captureException(err, c);
      console.error(`[DeviceDetail] Failed to resolve remote-access launcher for ${deviceId}:`, err);
      remoteAccessLaunchSkipReason = 'config_error';
    }

    return c.json({
      ...stripSensitiveDeviceFields(device),
      hardware: hardware || null,
      networkInterfaces,
      recentMetrics,
      groups: memberships,
      siteName: site?.name || 'Unknown Site',
      siteTimezone: site?.timezone || 'UTC',
      orgName: org?.name ?? null,
      remoteAccessPolicy,
      hasRemoteAccessLauncher,
      remoteAccessLaunchSkipReason,
    });
  }
);

/**
 * Read the acting technician's preferred provider id, if any.
 *
 * Gated on `isInteractiveUserSession` on purpose. An MCP API key is built with
 * `user.id = apiKey.createdBy` (see AuthContext.principal), so keying this off
 * user identity alone would make a machine caller silently inherit whichever
 * remote tool the human who minted the key happens to prefer. A preference is a
 * property of a person at a keyboard; anything else gets the tenant default.
 */
async function readPreferredProviderId(auth: AuthContext): Promise<string | null> {
  if (!isInteractiveUserSession(auth)) return null;
  // Deliberately the ambient request context, not a system one. `users` carries
  // `breeze_user_isolation_select ... OR id = breeze_current_user_id()`, so a
  // technician reading their own row is already permitted under the caller's
  // own scope. Reading under the request context is the narrower privilege and
  // means this can never resolve a row outside the caller's tenant, even if
  // `auth.user.id` were ever influenced by something other than the verified
  // token.
  const [row] = await db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  const prefs = row?.preferences ?? null;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return null;
  const value = (prefs as { remoteAccessProviderId?: unknown }).remoteAccessProviderId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Loads the pieces every launcher call needs -- the tenant's configured
 * providers and the acting technician's preference -- without touching
 * credentials. Shared by both the availability check (GET) and the issuance
 * path (POST) so they evaluate the exact same provider selection; see the
 * skew case called out in issue #3402.
 *
 * The partners table has partner-axis RLS, and the request scope is the
 * user's (organization or partner), not the partner whose settings we need.
 * We wrap the lookup in a system-scope DB context so the policy engine
 * doesn't filter the row out. This mirrors how remoteAccessPolicy.ts uses
 * systemAuth for the same reason.
 */
async function loadRemoteAccessLauncherContext(
  orgId: string,
  auth?: AuthContext,
): Promise<{ providers: InheritableRemoteAccessSettings | undefined; preferredProviderId: string | null }> {
  const partnerSettings = await withSystemDbAccessContext(async () => {
    const [partnerRow] = await db
      .select({ settings: partners.settings })
      .from(partners)
      .innerJoin(organizations, eq(organizations.partnerId, partners.id))
      .where(eq(organizations.id, orgId))
      .limit(1);
    return (partnerRow?.settings ?? {}) as PartnerSettings;
  });
  const preferredProviderId = auth ? await readPreferredProviderId(auth) : null;
  return { providers: partnerSettings.remoteAccessProviders, preferredProviderId };
}

/**
 * Availability-only check: would a launch URL resolve for this device? Never
 * decrypts the provider password or substitutes the template. This is the
 * ONLY launcher entry point GET /devices/:id should call.
 */
async function checkRemoteAccessLauncherAvailabilityForDevice(
  orgId: string,
  customFields: Record<string, unknown> | null,
  auth?: AuthContext,
): Promise<RemoteAccessLaunchAvailability> {
  const { providers, preferredProviderId } = await loadRemoteAccessLauncherContext(orgId, auth);
  return checkRemoteAccessLaunchAvailability({ customFields }, providers, preferredProviderId);
}

/**
 * Issuance: resolves (and returns) the substituted, credential-bearing
 * launch URL. Only POST /devices/:id/remote-access-launch may call this.
 */
async function resolveRemoteAccessLauncherForDevice(
  orgId: string,
  customFields: Record<string, unknown> | null,
  auth?: AuthContext,
): Promise<RemoteAccessLaunchResult> {
  const { providers, preferredProviderId } = await loadRemoteAccessLauncherContext(orgId, auth);
  return resolveRemoteAccessLaunch({ customFields }, providers, preferredProviderId);
}

// POST /devices/:id/remote-access-launch - Issue a one-shot remote-access
// launch URL. The substituted URL (which may contain a preset password) is
// returned only in response to an explicit click and is never embedded in
// the device detail response. Each issuance is recorded in the audit log.
//
// REGISTRATION ORDER: this must be declared before PATCH/DELETE /:id
// handlers below so Hono's match-in-registration-order rule routes
// /:id/remote-access-launch correctly.
coreRoutes.post(
  '/:id/remote-access-launch',
  requireScope('organization', 'partner', 'system'),
  // Same gate as the WebRTC initiate flow (apps/api/src/routes/remote/index.ts:12).
  // This endpoint issues URLs containing substituted provider credentials, so it
  // needs to match (not loosen) the existing remote-desktop session gate.
  requirePermission(PERMISSIONS.REMOTE_ACCESS.resource, PERMISSIONS.REMOTE_ACCESS.action),
  requireMfa(),
  requireCapability('remote_control'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    let launcher: RemoteAccessLaunchResult;
    try {
      launcher = await resolveRemoteAccessLauncherForDevice(
        device.orgId,
        device.customFields as Record<string, unknown> | null,
        auth,
      );
    } catch (err) {
      captureException(err, c);
      console.error(`[RemoteAccessLaunch] Failed to resolve launcher for ${deviceId}:`, err);
      return c.json({ error: 'Failed to resolve remote-access launcher', code: 'config_error' }, 500);
    }

    if (launcher.skipReason === 'scheme_not_allowed') {
      // Loud failure: the partner template resolved to a disallowed scheme
      // only after substitution. Emit a dedicated audit event so this shows
      // up in the audit log and route to Sentry. Do NOT include the URL or
      // the password in any logged field.
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.remote_access_launch_url.scheme_rejected',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname,
        details: {
          deviceId,
          providerId: launcher.providerId,
        },
        result: 'denied',
      });
      captureException(
        new Error('Remote-access launcher resolved to disallowed scheme after substitution'),
        c,
      );
      return c.json(
        { error: 'Remote-access launcher rejected by scheme policy', code: 'scheme_not_allowed' },
        422,
      );
    }

    if (!launcher.launchUrl) {
      // Match GET /devices/:id 404 convention used elsewhere for missing
      // sub-resources; the UI uses `hasRemoteAccessLauncher` on the detail
      // response to know whether to surface the button at all, so this
      // path is only reachable from race conditions or out-of-date UI.
      return c.json(
        { error: 'No remote-access launcher available for this device', code: launcher.skipReason ?? 'unavailable' },
        404,
      );
    }

    // Success: record the issuance. NEVER write the launch URL or password
    // into the audit row. Only deviceId, providerId, and the scheme.
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.remote_access_launch_url.issued',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        deviceId,
        providerId: launcher.providerId,
        scheme: launcher.scheme,
      },
    });

    return c.json({
      launchUrl: launcher.launchUrl,
      scheme: launcher.scheme,
      providerId: launcher.providerId,
    });
  }
);

// Get management posture for a device
coreRoutes.get(
  '/:id/management-posture',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    return c.json({
      deviceId,
      hostname: device.hostname,
      posture: device.managementPosture ?? null,
      collected: device.managementPosture != null,
    });
  }
);

// PATCH /devices/:id - Update device
coreRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', updateDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // If moving to a different site, verify it's in the same org AND that a
    // site-restricted caller is allowed to place a device into the TARGET site.
    // The source device is already site-gated by getDeviceWithOrgAndSiteCheck
    // above; without this the caller could move a device into a site outside
    // their `allowedSiteIds` allowlist. Mirrors the gate in provision.ts.
    if (data.siteId && data.siteId !== device.siteId) {
      const [targetSite] = await db
        .select()
        .from(sites)
        .where(
          and(
            eq(sites.id, data.siteId),
            eq(sites.orgId, device.orgId)
          )
        )
        .limit(1);

      if (!targetSite) {
        return c.json({ error: 'Target site not found or belongs to a different organization' }, 400);
      }

      const perms = c.get('permissions') as UserPermissions | undefined;
      if (perms?.allowedSiteIds && !canAccessSite(perms, data.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.displayName !== undefined) updates.displayName = data.displayName;
    if (data.siteId !== undefined) updates.siteId = data.siteId;
    if (data.tags !== undefined) updates.tags = data.tags;
    if (data.deviceRole !== undefined) {
      updates.deviceRole = data.deviceRole;
      updates.deviceRoleSource = 'manual';
    }
    if (data.customFields !== undefined) {
      // Merge with existing custom fields rather than replacing
      const raw = device.customFields;
      const existing: Record<string, unknown> =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      updates.customFields = { ...existing, ...data.customFields };
    }

    // When the PATCH changes the device's site, the denormalized `site_id`
    // on every table in DEVICE_SITE_DENORMALIZED_TABLES must be rewritten in
    // the SAME transaction as the devices row flip — otherwise child rows
    // (e.g. elevation_requests) stay pinned under the OLD site_id and drift
    // out of site-visibility scoping. Mirrors moveOrg.ts. The proxied `db`
    // resolves to the request-context tx via AsyncLocalStorage, so this
    // opens a savepoint within the request transaction (established pattern).
    const siteChanged = data.siteId !== undefined && data.siteId !== device.siteId;

    let updated: typeof devices.$inferSelect | undefined;
    if (siteChanged) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(devices)
          .set(updates)
          .where(eq(devices.id, deviceId))
          .returning();
        updated = row;

        for (const table of DEVICE_SITE_DENORMALIZED_TABLES) {
          await tx.execute(
            sql`UPDATE ${sql.identifier(table)} SET site_id = ${data.siteId}::uuid WHERE device_id = ${deviceId}::uuid`,
          );
        }
      });
    } else {
      const [row] = await db
        .update(devices)
        .set(updates)
        .where(eq(devices.id, deviceId))
        .returning();
      updated = row;
    }

    if (siteChanged) {
      await schedulePeripheralPolicyDevice(deviceId, 'device_site_changed').catch((error) => {
        console.error(`[devices] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      });
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.update',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname,
      details: { changedFields: Object.keys(data) }
    });

    // SR-008: never return agent/helper/watchdog token hashes or mTLS cert
    // material to the client (these are credential verifiers / lifecycle
    // metadata that belong only inside the API).
    return c.json(updated ? stripSensitiveDeviceFields(updated) : updated);
  }
);

// POST /devices/:id/agent-token/rotate - Rotate the agent bearer token for a device (returns new token once)
coreRoutes.post(
  '/:id/agent-token/rotate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status === 'decommissioned') {
      return c.json({ error: 'Device is decommissioned' }, 400);
    }

    const newToken = `brz_${randomBytes(32).toString('hex')}`;
    const tokenHash = createHash('sha256').update(newToken).digest('hex');

    const [updated] = await db
      .update(devices)
      .set({
        agentTokenHash: tokenHash,
        tokenIssuedAt: new Date(),
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        // Issue #2621 — this is the incident-response revocation path, so it must
        // also kill any staged (pending) rotation. A staged credential minted
        // before the revocation would otherwise keep authenticating for the rest
        // of its window, and could be promoted over this admin-issued token.
        pendingTokenHash: null,
        pendingWatchdogTokenHash: null,
        pendingHelperTokenHash: null,
        pendingTokenExpiresAt: null,
        updatedAt: new Date()
      })
      .where(eq(devices.id, deviceId))
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.agent_token.rotate',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname
    });

    return c.json({
      deviceId,
      agentId: updated?.agentId ?? device.agentId,
      authToken: newToken
    });
  }
);

// DELETE /devices/:id - Decommission device (soft delete)
coreRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  // Body is OPTIONAL — every existing caller (including bulk Remove) sends
  // none today and must keep working. `uninstallAgent` defaults to `false`
  // via the schema itself; see decommissionDeviceSchema's doc comment.
  optionalJsonValidator(decommissionDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { uninstallAgent } = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status === 'decommissioned') {
      return c.json({ error: 'Device is already decommissioned' }, 400);
    }

    // The status flip and the uninstall queue must commit or roll back
    // together (#3986 task 7) — a rolled-back Remove must never leave an
    // orphaned self_uninstall command behind. `queueDeviceUninstall` takes
    // the transaction handle directly and does its own row locking; it must
    // NOT be wrapped in runOutsideDbContext (device_commands has no RLS, so
    // it doesn't need a system context, and exiting the context here would
    // let the command commit independently of the decommission write).
    let updated: typeof devices.$inferSelect | undefined;
    let uninstallQueued = false;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(devices)
        .set({
          status: 'decommissioned',
          updatedAt: new Date()
        })
        .where(eq(devices.id, deviceId))
        .returning();
      updated = row;

      if (uninstallAgent) {
        const queueResult = await queueDeviceUninstall(tx, deviceId, auth.user.id);
        uninstallQueued = queueResult.queued || queueResult.mergedIntoExisting;
      }
    });

    // Resolve any "possible replacement of THIS device" linkage now that the
    // old device is decommissioned (#2764). The banner/badge on the newer
    // device asks a human "is this a replacement for <old device>?"; retiring
    // the old device IS that answer, so the question must stop being asked —
    // otherwise the prompt persists forever with no way to dismiss it.
    //
    // This writes OTHER devices' rows, not the enrollment path's own row, so
    // it does not violate the "never write existing device rows at enrollment
    // time" invariant — it is decommission-triggered, human-initiated, and
    // runs in the same request DB context (and therefore the same RLS scope)
    // as the decommission UPDATE above.
    await db
      .update(devices)
      .set({ possibleReplacementOfDeviceId: null, updatedAt: new Date() })
      .where(
        and(
          eq(devices.possibleReplacementOfDeviceId, deviceId),
          eq(devices.orgId, device.orgId)
        )
      );

    // Cut any live remote-control session to the device being decommissioned —
    // device `status` is only checked at session connect time, so an in-flight
    // desktop/terminal session would otherwise survive the offboarding. Never
    // throws; a TEARDOWN_FAILED (already Sentry-reported inside the service) is
    // recorded in the audit trail so there's a record live control may persist.
    const teardownResult = await terminateDeviceRemoteSessions(deviceId);

    // Same connect-time-only gap applies to the agent's own WS control
    // channel (#2230): a connected agent would keep its full command channel
    // after decommission. Force-close it; the handshake gate
    // (validateAgentToken) rejects the reconnect for decommissioned devices.
    // ('close-failed' means the channel may still be live — recorded in the
    // audit trail below. Quarantine flows don't force-close the socket; they
    // rely on the terminal-status write guard in agentWs.updateDeviceStatus.)
    const agentWsDisconnect = device.agentId
      ? disconnectAgent(device.agentId, 4041, 'Device decommissioned')
      : 'not-connected';

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.decommission',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname,
      details: {
        remoteSessionTeardown: teardownResult === TEARDOWN_FAILED ? 'failed' : 'ok',
        agentWsDisconnect,
        uninstallQueued,
      },
    });

    return c.json({
      success: true,
      device: updated ? stripSensitiveDeviceFields(updated) : updated,
      uninstallQueued,
    });
  }
);

// POST /devices/:id/restore - Restore a decommissioned device
coreRoutes.post(
  '/:id/restore',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status !== 'decommissioned') {
      return c.json({ error: 'Only decommissioned devices can be restored' }, 400);
    }

    // Release-THEN-flip, atomically, inside ONE `db.transaction` (#3986
    // task 8 fix round 1; mirrors `queueDeviceUninstall`'s composition in
    // DELETE /devices/:id). THE SAFETY PROPERTY IS THE TRANSACTION, not the
    // statement order: under READ COMMITTED (the default here, and what
    // `db.transaction` gives you — a real BEGIN/COMMIT on one connection),
    // no other session can observe either write until both commit together.
    // So no concurrent heartbeat can ever see "status flipped, uninstall
    // still pending" — that combined state never exists as a committed fact
    // regardless of which statement runs first inside the transaction.
    //
    // The race this guards against: `isDeviceUninstallDraining` requires
    // `devices.status = 'decommissioned'`; once status is anything else the
    // device is an ordinary agent again, and a heartbeat landing in that
    // window would claim a still-`pending` self_uninstall as an ordinary
    // command — no type allowlist gates that path — and uninstall the
    // machine the user just restored. The transaction is what prevents any
    // session from ever observing that window.
    //
    // Release-before-flip is kept anyway as DELIBERATE SECONDARY DEFENSE:
    // if a future refactor splits these two writes back into separate
    // transactions (exactly how this bug was introduced), this order still
    // leaves the safe failure mode — a failure after the release leaves the
    // device `decommissioned` with the uninstall already cancelled, so a
    // retry is harmless — instead of the device-wiping one that flip-first
    // would leave behind.
    //
    // `releaseDeviceRemoveReason` strips only the `device_remove` reason —
    // a row a tenant-offboarding drain also owns stays alive for that owner
    // — and cancels the underlying command only while it is still `pending`.
    //
    // A row already `sent` CANNOT be recalled here regardless of ordering:
    // `claimPendingCommandsForDevice` (commandDispatch.ts) commits `pending
    // → sent` before the HTTP response reaches the agent, and the agent's
    // self-uninstall handler hands teardown to a detached helper and acks
    // immediately (handlers_uninstall.go). Once a row is `sent` there is no
    // safe claimed-state transition today — the real fix is an agent-side
    // pre-teardown fence (a `begin` endpoint that CASes `sent → executing`,
    // serialized against restore), which needs a Go agent change out of
    // scope for this plan. Tracked as a follow-up:
    // https://github.com/LanternOps/breeze/issues/3995. Restore deliberately
    // still SUCCEEDS in that case — it is a user-facing recovery action and
    // must not be wedged by a race that lasts seconds — but reports
    // `uninstallAlreadyDispatched: true` so the caller can tell the user
    // plainly the machine may already be gone and will need a reinstall.
    let updated: typeof devices.$inferSelect | undefined;
    let uninstallAlreadyDispatched = false;
    await db.transaction(async (tx) => {
      const releaseResult = await releaseDeviceRemoveReason(tx, deviceId, 'device_restored');
      uninstallAlreadyDispatched = releaseResult.alreadyDispatched > 0;

      const [row] = await tx
        .update(devices)
        .set({
          status: 'offline',
          updatedAt: new Date()
        })
        .where(eq(devices.id, deviceId))
        .returning();
      updated = row;
    });

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.restore',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname,
      details: { uninstallAlreadyDispatched },
    });

    return c.json({
      success: true,
      device: updated ? stripSensitiveDeviceFields(updated) : updated,
      uninstallAlreadyDispatched,
    });
  }
);

// DELETE /devices/:id/permanent - Permanently delete a device record
coreRoutes.delete(
  '/:id/permanent',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status !== 'decommissioned') {
      return c.json({ error: 'Device must be decommissioned before permanent deletion' }, 400);
    }

    // #3817 — SELF_UNINSTALL is dispatched AFTER the cascade commits, further
    // down. It used to fire here, before the transaction opened, so every
    // rollback path below left the agent removing itself while its device row
    // survived: an endpoint that is gone from the operator's fleet in practice
    // but still present, still billed, and no longer reachable to fix. Declared
    // here only because the catch branches and the audit entry all report it.
    let uninstallSent = false;

    // #2138/#2308 — whether deleting this device dissolved its link group
    // (lone multiboot survivor unlinked, or a vm_host group left headless and
    // its guests unlinked). Recorded in the audit details: an unexplained
    // "why did this whole VM group un-group?" must be traceable to this event.
    let linkGroupDissolved = false;

    // Cascade: remove all FK-referencing records in a transaction.
    // Uses raw SQL to cover all child tables without importing each schema.
    // When adding new tables with device_id FK, add them here too.
    try {
      await db.transaction(async (tx) => {
        // Shared with the Quick Support reaper's ephemeral-device purge — see
        // services/deviceDeletion.ts for why this lives in one place.
        await deleteDeviceCascade(tx, deviceId);

        // #2138 — the deleted device's link_group_id went with its row. If it
        // was a boot profile and the group now has a single lone survivor —
        // or it was a vm_host group's HOST (#2308), leaving the group
        // headless — dissolve the group.
        if (device.linkGroupId) {
          linkGroupDissolved = await dissolveLinkGroupIfBelowMinimum(tx, device.linkGroupId);
        }
      });
    } catch (err: unknown) {
      // MUST unwrap. Drizzle wraps the postgres-js PostgresError in a
      // DrizzleQueryError whose own `.code` is undefined — the SQLSTATE lives on
      // `.cause`. Verified against live Postgres with real two-connection lock
      // contention: a genuine lock timeout arrives here as
      // `{ code: undefined, cause: { code: '55P03' } }`, so the top-level read
      // this replaced returned undefined and BOTH branches below were dead —
      // the 55P03 one silently, and the pre-existing 23503 one too. `pgErrors`
      // documents exactly this hazard and exists for it.
      const pgCode = pgErrorCode(err);
      if (pgCode === '23503') {
        // Read the diagnostics off the SAME node the code came from. Unwrapping
        // only the code and then reading `detail`/`table_name` off the outer
        // Drizzle error yields blanks on every wrapped statement, i.e. "related
        // records in undefined" — this branch had never run before the unwrap
        // above, so that was never observed.
        const node = pgErrorNode(err);
        const detail = typeof node?.detail === 'string' ? node.detail : '';
        const constraintTable = typeof node?.table_name === 'string' ? node.table_name : undefined;
        console.error(`[devices] FK violation during cascade delete of ${deviceId}: ${detail} (uninstallSent=${uninstallSent})`, err);
        // This catch also covers dissolveLinkGroupIfBelowMinimum, so the
        // violation is not necessarily a missing cascade-list table — say
        // "may" rather than asserting a cause we have not established.
        //
        // uninstallSent is necessarily false here (#3817): the dispatch sits
        // below this try/catch, so reaching it at all means the cascade
        // committed. Kept in the body for response-shape stability — no
        // current consumer reads it (the web caller surfaces only
        // `err.message`), so this is about not silently dropping a documented
        // field, not about a distinction someone is making today.
        return c.json({
          error: `Cannot delete: device still has related records${constraintTable ? ` in ${constraintTable}` : ''}. A related table may be missing from the cascade delete list.`,
          uninstallSent,
        }, 409);
      }
      // 55P03 lock_not_available — the cascade bounds its wait for the devices
      // row (services/deviceDeletion.ts) so a delete racing a long-running site
      // move or moveOrg fails fast instead of pinning a pooled connection.
      // Without this branch that bound would surface as a generic 500, which
      // reads as a bug rather than the transient, retryable conflict it is.
      //
      // This was one of the three rollback paths (with 23503 above and the
      // generic rethrow below) that could leave an agent uninstalling itself
      // while its device row survived, because the dispatch ran before the
      // transaction. Since #3817 none of them can. What is specific to THIS
      // branch: the lock is the cascade's first statement, so a bounded lock
      // failure rolls back having mutated nothing at all. A retry is therefore
      // an ordinary retry, and saying more would describe damage that did not
      // occur.
      if (pgCode === '55P03') {
        console.warn(`[devices] lock timeout acquiring devices row for ${deviceId}; another writer holds it (uninstallSent=${uninstallSent})`, err);
        return c.json({
          error: 'Device is busy: another operation is currently modifying it. Try again in a moment.',
          uninstallSent,
        }, 409);
      }
      // Anything else is a server-side cascade defect, and it STAYS a 500 —
      // #3952 was exactly this (a 23514 check violation), and mapping such a
      // failure to a 409 would advertise "retry me" for something that fails
      // identically forever. But the status code is not the reason to lose the
      // context: the global onError logs a bare `Error:` with no deviceId and,
      // in production, returns a sanitized body, so without this line there is
      // no server-side record of WHICH device failed to delete. `uninstallSent`
      // stays in the message even though #3817 pins it to false on this path —
      // it is the standing assertion that the irreversible command did not
      // escape a failed delete, and an assertion is worth something only if it
      // is actually recorded. Rethrow unchanged so the response contract and
      // Sentry reporting stay owned by onError.
      console.error(`[devices] unhandled ${pgCode ?? 'non-postgres'} error during cascade delete of ${deviceId} (uninstallSent=${uninstallSent})`, err);
      throw err;
    }

    // Best-effort: send self_uninstall command if the agent is online.
    // We don't block on this succeeding — fire and forget.
    //
    // #3817 — deliberately AFTER the cascade commits. SELF_UNINSTALL is
    // irreversible, so dispatching it speculatively (as this route used to)
    // meant any rollback above stranded a self-removing agent against a
    // surviving device row. The cost of this ordering is the inverse race —
    // the agent disconnecting between the commit and this send — which leaves
    // `uninstallSent` false and puts the `warning` below in the 200 body, i.e.
    // a manual uninstall. That is recoverable; the other direction is not.
    // (The web caller currently discards that warning — #4368.)
    //
    // The delete is ALREADY COMMITTED here, so nothing in this block may throw
    // out of the handler: a 500 now would lose the audit entry and the
    // device-count invalidation below while the row is permanently gone, and
    // would tell the caller nothing happened when everything did. The guard is
    // therefore INSIDE the try — `isAgentConnected` is not a bare Map read, it
    // asserts the process role first (agentWs.ts) and throws in the worker
    // role. Same reasoning as the getRedis() call further down.
    try {
      if (device.agentId && isAgentConnected(device.agentId)) {
        uninstallSent = sendCommandToAgent(device.agentId, {
          id: `uninstall-${deviceId}`,
          type: CommandTypes.SELF_UNINSTALL,
          payload: { removeConfig: true },
        });
      }
    } catch (err) {
      // Durable, not just console: this is a post-commit failure on an
      // irreversible operation, and a console line on a droplet is not a record
      // anyone will find later.
      //
      // `err` goes in RAW. captureException takes `unknown` deliberately — it
      // runs connectTimeoutClassifier and pgErrorCode over the value to derive
      // its tags, so pre-wrapping a non-Error in `new Error(String(err))` would
      // throw those away (and String() on a hostile object can itself throw,
      // out of the very catch that exists to keep this block from escaping).
      console.error(`[devices] best-effort self_uninstall failed for ${deviceId}:`, err);
      captureException(err, c);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.permanent_delete',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.displayName ?? deviceId,
      details: {
        uninstallCommandSent: uninstallSent,
        // #2138/#2308 — deleting a linked device can dissolve its link group
        // (and unlink every remaining member). Without this flag the audit
        // trail would show only "device deleted" while sibling devices
        // silently lost their grouping.
        ...(device.linkGroupId
          ? { linkGroupId: device.linkGroupId, linkGroupDissolved }
          : {}),
      }
    });

    // #2728 — the per-org agent rate limit is sized from a cached enrolled
    // device count. Drop the cache so the org's ceiling reflects the removal.
    // Deliberately AFTER writeRouteAudit, and fully guarded: the delete has
    // already committed, so nothing here may turn a completed destructive
    // operation into a 500. getRedis() itself can throw on a misconfigured
    // Redis, so the synchronous call is inside the try as well.
    try {
      void invalidateOrgDeviceCount(getRedis(), device.orgId);
    } catch (err) {
      console.error('[devices] device-count cache invalidation failed after delete', err);
    }

    return c.json({
      success: true,
      agentUninstallSent: uninstallSent,
      ...(!uninstallSent && device.agentId && {
        warning: 'The agent could not be reached for remote uninstall. You may need to manually remove it from the endpoint.',
      }),
    });
  }
);
