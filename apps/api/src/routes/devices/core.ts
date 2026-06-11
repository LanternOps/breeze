import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, like, sql, desc, inArray, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createHash, randomBytes } from 'crypto';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceMetrics,
  deviceGroupMemberships,
  deviceGroups,
  sites,
  enrollmentKeys,
  organizations,
  partners,
} from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import {
  getPagination,
  getDeviceWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
  stripSensitiveDeviceFields,
} from './helpers';
import { listDevicesSchema, updateDeviceSchema } from './schemas';
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
import { resolveRemoteAccessForDevice } from '../../services/remoteAccessPolicy';
import {
  resolveRemoteAccessLaunch,
  type RemoteAccessLaunchResult,
  type RemoteAccessLaunchSkipReason,
} from '../../services/remoteAccessLauncher';
import { captureException } from '../../services/sentry';
import type { InheritableRemoteAccessSettings, PartnerSettings } from '@breeze/shared';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { sendCommandToAgent, isAgentConnected } from '../agentWs';
import { CommandTypes } from '../../services/commandQueue';
import { getGlobalEnrollmentSecret } from '../agents/enrollment';

/**
 * Tables where linked_device_id (not device_id) references devices.id.
 * These get SET NULL rather than deleted during cascade.
 */
export const DEVICE_LINKED_DEVICE_ID_TABLES = [
  'network_change_events',
  'discovered_assets',
] as const;

/**
 * Subset of {@link DEVICE_CASCADE_DELETE_TABLES} whose rows denormalize
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
 *   file_transfers, patch_job_results, patch_rollbacks,
 *   psa_ticket_mappings, software_compliance_status
 */
export const DEVICE_ORG_DENORMALIZED_TABLES = [
  'agent_logs', 'ai_screenshots', 'ai_sessions', 'alerts', 'asset_checkouts',
  'audit_baseline_results', 'audit_policy_states',
  'backup_chains', 'backup_jobs', 'backup_sla_events',
  'backup_snapshots', 'backup_verifications',
  'brain_device_context', 'browser_extensions', 'browser_policy_violations',
  'capacity_predictions',
  'cis_baseline_results', 'cis_remediation_actions',
  'deployment_invites',
  'device_boot_metrics', 'device_change_log', 'device_config_state',
  'device_connections', 'device_disks', 'device_event_logs',
  'device_filesystem_cleanup_runs', 'device_filesystem_scan_state',
  'device_filesystem_snapshots',
  'device_group_memberships', 'device_hardware', 'device_ip_history',
  'device_metrics', 'device_network', 'device_patches', 'device_registry_state',
  'device_reliability', 'device_reliability_history', 'device_sessions',
  'device_warranty',
  'dns_event_aggregations', 'dns_security_events',
  'elevation_requests',
  'group_membership_log',
  'huntress_agents', 'huntress_incidents', 'hyperv_vms', 'local_vaults',
  'peripheral_events', 'playbook_executions',
  'recovery_readiness', 'recovery_tokens', 'remote_sessions', 'restore_jobs',
  's1_actions', 's1_agents', 's1_threats',
  'script_executions',
  'security_posture_snapshots', 'security_scans', 'security_status',
  'security_threats',
  'sensitive_data_findings', 'sensitive_data_scans',
  'service_process_check_results',
  'software_inventory', 'software_policy_audit', 'sql_instances',
  'tickets', 'time_series_metrics', 'tunnel_sessions',
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
export const DEVICE_CASCADE_DELETE_TABLES = [
  // recovery_tokens & backup_chains FK to backup_snapshots (no cascade),
  // so delete them first, then restore_jobs → backup_snapshots → backup_jobs
  'recovery_tokens', 'backup_chains',
  'restore_jobs', 'backup_verifications', 'backup_snapshots', 'backup_jobs',
  // Application backup & DR
  'sql_instances', 'local_vaults', 'hyperv_vms',
  // Deployment invites (FK device_id → devices.id; no cascade)
  'deployment_invites',
  // Core device tables
  'device_group_memberships', 'group_membership_log',
  'device_hardware', 'device_network', 'device_ip_history', 'device_disks',
  'device_metrics', 'device_software', 'device_registry_state', 'device_config_state',
  'device_commands', 'device_connections', 'device_boot_metrics',
  'device_sessions', 'device_change_log', 'device_warranty',
  // Patches
  'device_patches', 'patch_job_results', 'patch_rollbacks',
  // Deployments & software
  'deployment_devices', 'deployment_results', 'software_inventory',
  'software_compliance_status', 'software_policy_audit',
  // Remote access
  'remote_sessions', 'file_transfers', 'tunnel_sessions',
  // Monitoring & logs
  'service_process_check_results', 'alerts', 'agent_logs', 'script_executions',
  'device_event_logs', 'automation_policy_compliance', 'backup_sla_events',
  // Security
  'sensitive_data_scans', 'sensitive_data_findings',
  'dns_security_events', 'dns_event_aggregations',
  'security_status', 'security_threats', 'security_scans', 'security_posture_snapshots',
  'cis_baseline_results', 'cis_remediation_actions',
  'browser_extensions', 'browser_policy_violations',
  'audit_baseline_results', 'audit_policy_states',
  'peripheral_events',
  's1_agents', 's1_threats', 's1_actions',
  'huntress_agents', 'huntress_incidents',
  // AI & context
  'ai_sessions', 'ai_screenshots', 'brain_device_context',
  // Analytics & reliability
  'device_reliability_history', 'device_reliability',
  'playbook_executions', 'time_series_metrics', 'capacity_predictions',
  // Portal & integrations
  'psa_ticket_mappings', 'tickets', 'asset_checkouts',
  // Filesystem
  'device_filesystem_snapshots', 'device_filesystem_cleanup_runs', 'device_filesystem_scan_state',
  // Backup verification
  'recovery_readiness',
  // PAM elevation requests (elevation_audit cascades automatically via FK ON DELETE CASCADE)
  'elevation_requests',
  // Provisioning one-time credential handles (FK device_id → devices.id ON DELETE CASCADE;
  // listed for the explicit-cascade coverage contract — leaf table, no children)
  'provision_credential_handles',
] as const;

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

// POST /devices/onboarding-token - Generate a short-lived enrollment key.
// If AGENT_ENROLLMENT_SECRET is configured, enrollment also requires that
// shared secret; otherwise the short-lived key stands on its own.
coreRoutes.post(
  '/onboarding-token',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
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

    // Pick the first site in the org for the enrollment key
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.orgId, orgId))
      .limit(1);

    if (!site) {
      return c.json({ error: 'No site found for this organization. Create a site first.' }, 400);
    }

    // Optional caller-supplied multi-use / TTL controls (#1108). A copied CLI
    // command is frequently pasted onto several machines during a migration;
    // without these the historical hard-coded single-use token failed on every
    // machine after the first. Defaults preserve the old single-use, 60-min
    // behaviour for callers that send no body.
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const rawCount = Number((body as { count?: unknown }).count);
    const maxUsage = Number.isFinite(rawCount)
      ? Math.min(ENROLL_TOKEN_MAX_COUNT, Math.max(1, Math.trunc(rawCount)))
      : 1;
    const rawTtl = Number((body as { ttlMinutes?: unknown }).ttlMinutes);
    const defaultTtlMinutes = envInt('ENROLLMENT_KEY_DEFAULT_TTL_MINUTES', 60);
    const ttlMinutes = Number.isFinite(rawTtl)
      ? Math.min(ENROLL_TOKEN_MAX_TTL_MINUTES, Math.max(1, Math.trunc(rawTtl)))
      : defaultTtlMinutes;

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
        status: devices.status,
        watchdogStatus: devices.watchdogStatus,
        mainAgentSilentSince: devices.mainAgentSilentSince,
        lastSeenAt: devices.lastSeenAt,
        enrolledAt: devices.enrolledAt,
        tags: devices.tags,
        customFields: devices.customFields,
        desktopAccess: devices.desktopAccess,
        lastUser: devices.lastUser,
        uptimeSeconds: devices.uptimeSeconds,
        isHeadless: devices.isHeadless,
        createdAt: devices.createdAt,
        updatedAt: devices.updatedAt,
        // Hardware summary
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb
      })
      .from(devices)
      .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
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
        status: d.status,
        watchdogStatus: d.watchdogStatus,
        mainAgentSilentSince: d.mainAgentSilentSince,
        lastSeenAt: d.lastSeenAt,
        enrolledAt: d.enrolledAt,
        tags: d.tags,
        customFields: d.customFields,
        desktopAccess: d.desktopAccess,
        lastUser: d.lastUser,
        uptimeSeconds: d.uptimeSeconds,
        isHeadless: d.isHeadless,
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
    // device. We DO NOT return the substituted launch URL here. That is
    // issued by POST /devices/:id/remote-access-launch on click so the
    // password-bearing URL is never broadcast in detail-fetch responses.
    // The flags below only tell the UI whether to render the launcher
    // button and what to surface if the configuration is wrong.
    //
    // Skip-reason vocabulary lets the UI distinguish expected-empty
    // ('no_provider_configured'), configuration error ('config_error'),
    // and a potential security event ('scheme_not_allowed': partner
    // template was tampered to resolve to a disallowed scheme only after
    // substitution).
    let hasRemoteAccessLauncher = false;
    let remoteAccessLaunchSkipReason: RemoteAccessLaunchSkipReason | 'config_error' | null = null;
    try {
      const launcher = await resolveRemoteAccessLauncherForDevice(
        device.orgId,
        device.customFields as Record<string, unknown> | null,
      );
      if (launcher.launchUrl) {
        hasRemoteAccessLauncher = true;
      } else {
        remoteAccessLaunchSkipReason = launcher.skipReason;
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
 * Look up the partner's remote-access launcher config for a device and
 * return the structured result describing whether a launch URL is available.
 *
 * The partners table has partner-axis RLS, and the request scope is the
 * user's (organization or partner), not the partner whose settings we
 * need. We wrap the lookup in a system-scope DB context so the policy
 * engine doesn't filter the row out. This mirrors how remoteAccessPolicy.ts
 * uses systemAuth for the same reason.
 */
async function resolveRemoteAccessLauncherForDevice(
  orgId: string,
  customFields: Record<string, unknown> | null,
): Promise<RemoteAccessLaunchResult> {
  const partnerSettings = await withSystemDbAccessContext(async () => {
    const [partnerRow] = await db
      .select({ settings: partners.settings })
      .from(partners)
      .innerJoin(organizations, eq(organizations.partnerId, partners.id))
      .where(eq(organizations.id, orgId))
      .limit(1);
    return (partnerRow?.settings ?? {}) as PartnerSettings;
  });
  const providers: InheritableRemoteAccessSettings | undefined =
    partnerSettings.remoteAccessProviders;
  return resolveRemoteAccessLaunch({ customFields }, providers);
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
      return c.json({ error: 'Device is already decommissioned' }, 400);
    }

    const [updated] = await db
      .update(devices)
      .set({
        status: 'decommissioned',
        updatedAt: new Date()
      })
      .where(eq(devices.id, deviceId))
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.decommission',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname
    });

    return c.json({ success: true, device: updated ? stripSensitiveDeviceFields(updated) : updated });
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

    const [updated] = await db
      .update(devices)
      .set({
        status: 'offline',
        updatedAt: new Date()
      })
      .where(eq(devices.id, deviceId))
      .returning();

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.restore',
      resourceType: 'device',
      resourceId: updated?.id ?? deviceId,
      resourceName: updated?.hostname ?? updated?.displayName ?? device.hostname
    });

    return c.json({ success: true, device: updated ? stripSensitiveDeviceFields(updated) : updated });
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

    // Best-effort: send self_uninstall command if the agent is online.
    // We don't block deletion on this succeeding — fire and forget.
    let uninstallSent = false;
    if (device.agentId && isAgentConnected(device.agentId)) {
      try {
        uninstallSent = sendCommandToAgent(device.agentId, {
          id: `uninstall-${deviceId}`,
          type: CommandTypes.SELF_UNINSTALL,
          payload: { removeConfig: true },
        });
      } catch (err) {
        console.error(`[devices] best-effort self_uninstall failed for ${deviceId}:`, err);
      }
    }

    // Cascade: remove all FK-referencing records in a transaction.
    // Uses raw SQL to cover all child tables without importing each schema.
    // When adding new tables with device_id FK, add them here too.
    try {
      await db.transaction(async (tx) => {
        // Transitive dependencies: tables that reference device-scoped records
        // but don't have a direct device_id column.
        const deviceAlertIds = sql`(SELECT id FROM alerts WHERE device_id = ${deviceId})`;
        const deviceAiSessionIds = sql`(SELECT id FROM ai_sessions WHERE device_id = ${deviceId})`;

        await tx.execute(sql`DELETE FROM ai_tool_executions WHERE session_id IN ${deviceAiSessionIds}`);
        await tx.execute(sql`DELETE FROM ai_messages WHERE session_id IN ${deviceAiSessionIds}`);
        await tx.execute(sql`DELETE FROM ai_action_plans WHERE session_id IN ${deviceAiSessionIds}`);
        await tx.execute(sql`DELETE FROM alert_correlations WHERE parent_alert_id IN ${deviceAlertIds} OR child_alert_id IN ${deviceAlertIds}`);
        await tx.execute(sql`DELETE FROM alert_notifications WHERE alert_id IN ${deviceAlertIds}`);
        await tx.execute(sql`UPDATE log_correlations SET alert_id = NULL WHERE alert_id IN ${deviceAlertIds}`);
        await tx.execute(sql`UPDATE network_change_events SET alert_id = NULL WHERE alert_id IN ${deviceAlertIds}`);
        for (const linkedTable of DEVICE_LINKED_DEVICE_ID_TABLES) {
          await tx.execute(sql`UPDATE ${sql.identifier(linkedTable)} SET linked_device_id = NULL WHERE linked_device_id = ${deviceId}`);
        }

        const tables = DEVICE_CASCADE_DELETE_TABLES;
        for (const table of tables) {
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE device_id = ${deviceId}`);
        }
        await tx.delete(devices).where(eq(devices.id, deviceId));
      });
    } catch (err: unknown) {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === '23503') {
        const detail = (err as { detail?: string })?.detail ?? '';
        const constraintTable = (err as { table_name?: string })?.table_name;
        console.error(`[devices] FK violation during cascade delete of ${deviceId}: ${detail}`, err);
        return c.json({
          error: `Cannot delete: device still has related records${constraintTable ? ` in ${constraintTable}` : ''}. This table may need to be added to the cascade delete list.`,
        }, 409);
      }
      throw err;
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.permanent_delete',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.displayName ?? deviceId,
      details: { uninstallCommandSent: uninstallSent }
    });

    return c.json({
      success: true,
      agentUninstallSent: uninstallSent,
      ...(!uninstallSent && device.agentId && {
        warning: 'The agent could not be reached for remote uninstall. You may need to manually remove it from the endpoint.',
      }),
    });
  }
);
