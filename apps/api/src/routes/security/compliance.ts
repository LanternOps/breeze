import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../../db';
import { deviceRecoveryKeys } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { getSecurityPostureTrend } from '../../services/securityPosture';
import { siteAllowlistOf } from '../../services/aiToolsSiteScope';
import {
  trendsQuerySchema,
  firewallQuerySchema,
  encryptionQuerySchema,
  passwordPolicyQuerySchema,
  adminAuditQuerySchema
} from './schemas';
import {
  getPagination,
  paginate,
  resolveScopedOrgIds,
  listStatusRows,
  toStatusResponse,
  normalizeEncryption,
  parsePasswordPolicySummary,
  parseLocalAdminSummary,
  parseEncryptionVolumes,
  deriveEncryptionMethod
} from './helpers';
import { requireSecurityReadAccess } from './readAuthorization';

export const complianceRoutes = new Hono();

complianceRoutes.get(
  '/trends',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  zValidator('query', trendsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { period, orgId } = c.req.valid('query');
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;

    // ?orgId= is the header org switcher's selection (#9639); it can only
    // narrow within the caller's accessible orgs (403 otherwise).
    let orgIds: string[] | undefined;
    if (orgId) {
      const scope = resolveScopedOrgIds(auth, orgId);
      if (scope.error) {
        return c.json({ error: scope.error.message }, scope.error.status);
      }
      orgIds = scope.orgIds;
    } else {
      // Deliberately not resolveScopedOrgIds(auth): that 400s a caller with no
      // org context, where this route has always fallen back to RLS scoping.
      orgIds = auth.orgId
        ? [auth.orgId]
        : auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0
          ? auth.accessibleOrgIds
          : undefined;
    }

    const dataPoints = await getSecurityPostureTrend({
      orgIds,
      siteIds: siteAllowlistOf(auth),
      days
    });

    const previous = Number(dataPoints[0]?.overall ?? 0);
    const current = Number(dataPoints[dataPoints.length - 1]?.overall ?? 0);

    return c.json({
      data: {
        period,
        dataPoints,
        summary: {
          current,
          previous,
          change: current - previous,
          trend: current > previous ? 'improving' : current < previous ? 'declining' : 'stable'
        }
      }
    });
  }
);

complianceRoutes.get(
  '/firewall',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  zValidator('query', firewallQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth, query.orgId)).map(toStatusResponse);

    // `firewallEnabled: null` is unknown (#8252): the collector failed or never
    // reported, so no profile or rule data is synthesized for it.
    let devicesData = statuses.map((status) => ({
      deviceId: status.deviceId,
      deviceName: status.deviceName,
      os: status.os,
      firewallEnabled: status.firewallEnabled,
      profiles: status.firewallEnabled === null
        ? []
        : status.os === 'windows'
        ? [
            { name: 'Domain', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' },
            { name: 'Private', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' },
            { name: 'Public', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'block' }
          ]
        : [{ name: status.os === 'macos' ? 'Application Firewall' : 'iptables/nftables', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' }],
      rulesCount: status.firewallEnabled === null
        ? null
        : status.firewallEnabled ? (status.os === 'windows' ? 142 : 38) : 0
    }));

    if (query.status) {
      const enabled = query.status === 'enabled';
      devicesData = devicesData.filter((device) => device.firewallEnabled === enabled);
    }

    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }

    const enabledCount = statuses.filter((status) => status.firewallEnabled === true).length;
    const disabledCount = statuses.filter((status) => status.firewallEnabled === false).length;
    const unknownCount = statuses.length - enabledCount - disabledCount;

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total: statuses.length,
        enabled: enabledCount,
        disabled: disabledCount,
        unknown: unknownCount,
        coveragePercent: statuses.length ? Math.round((enabledCount / statuses.length) * 100) : 0
      }
    });
  }
);

complianceRoutes.get(
  '/encryption',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  zValidator('query', encryptionQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const rows = await listStatusRows(auth, query.orgId);

    // Real escrow status: devices with at least one active escrowed key.
    // Constrained to the org-scoped device set already resolved by
    // listStatusRows so the enrichment never touches a device outside the
    // caller's accessible orgs (and avoids an unbounded cross-tenant scan).
    const deviceIds = rows.map((row) => row.deviceId);
    const escrowRows = deviceIds.length
      ? await db
          .selectDistinct({ deviceId: deviceRecoveryKeys.deviceId })
          .from(deviceRecoveryKeys)
          .where(
            and(
              eq(deviceRecoveryKeys.status, 'active'),
              inArray(deviceRecoveryKeys.deviceId, deviceIds)
            )
          )
      : [];
    const escrowedDeviceIds = new Set(escrowRows.map((r) => r.deviceId));

    const FALLBACK_VOLUME_METHOD_LABELS: Record<string, string> = {
      bitlocker: 'BitLocker',
      filevault: 'FileVault',
      luks: 'LUKS',
      none: 'None',
      unknown: 'Unknown'
    };

    let devicesData = rows.map((row) => {
      const status = toStatusResponse(row);
      const encStatus = status.encryptionStatus;
      // What the agent reported, never inferred from the OS (#9607).
      const method = deriveEncryptionMethod(row.encryptionDetails, encStatus);
      // No per-volume detail reported: synthesize one row for the system
      // volume. Its method mirrors the device-level method, which is itself
      // only what the agent reported.
      const fallbackVolume = {
        drive: status.os === 'windows' ? 'C:' : status.os === 'macos' ? 'Macintosh HD' : '/dev/sda1',
        encrypted: encStatus !== 'unencrypted',
        method: FALLBACK_VOLUME_METHOD_LABELS[method] ?? method,
        status: null as string | null,
        percentEncrypted: null as number | null
      };

      return {
        deviceId: status.deviceId,
        deviceName: status.deviceName,
        os: status.os,
        encryptionMethod: method,
        encryptionStatus: encStatus,
        volumes: parseEncryptionVolumes(row.encryptionDetails) ?? [fallbackVolume],
        // The agent does not collect TPM state; null renders as "not
        // reported" rather than a value guessed from the OS (#9607).
        tpmPresent: null as boolean | null,
        recoveryKeyEscrowed: escrowedDeviceIds.has(status.deviceId)
      };
    });

    if (query.status) {
      devicesData = devicesData.filter((device) => device.encryptionStatus === query.status);
    }

    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }

    if (query.escrow) {
      const wantEscrowed = query.escrow === 'escrowed';
      devicesData = devicesData.filter((device) => device.recoveryKeyEscrowed === wantEscrowed);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }

    // Every tile (state, escrow and method) counts the same filtered set so
    // they never disagree under a filter (#9609).
    const fullyEncrypted = devicesData.filter((device) => normalizeEncryption(device.encryptionStatus) === 'encrypted').length;
    const partial = devicesData.filter((device) => normalizeEncryption(device.encryptionStatus) === 'partial').length;
    const unencrypted = devicesData.filter((device) => normalizeEncryption(device.encryptionStatus) === 'unencrypted').length;

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total: devicesData.length,
        fullyEncrypted,
        partial,
        unencrypted,
        recoveryKeysEscrowed: devicesData.filter((device) => device.recoveryKeyEscrowed).length,
        methodCounts: {
          bitlocker: devicesData.filter((device) => device.encryptionMethod === 'bitlocker').length,
          filevault: devicesData.filter((device) => device.encryptionMethod === 'filevault').length,
          luks: devicesData.filter((device) => device.encryptionMethod === 'luks').length,
          none: devicesData.filter((device) => device.encryptionMethod === 'none').length,
          unknown: devicesData.filter((device) => device.encryptionMethod === 'unknown').length
        }
      }
    });
  }
);

complianceRoutes.get(
  '/password-policy',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  zValidator('query', passwordPolicyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const statusRows = await listStatusRows(auth, query.orgId);

    let devicesData = statusRows.map((row) => {
      const policy = parsePasswordPolicySummary(row.passwordPolicySummary);
      const adminSummary = parseLocalAdminSummary(row.localAdminSummary);

      return {
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        os: row.os,
        compliant: policy.compliant,
        checks: policy.checks,
        localAccounts: adminSummary.localAccounts,
        adminAccounts: adminSummary.totalAdmins
      };
    });

    if (query.compliance) {
      const compliant = query.compliance === 'compliant';
      devicesData = devicesData.filter((device) => device.compliant === compliant);
    }

    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }

    const compliantCount = devicesData.filter((device) => device.compliant).length;
    const total = devicesData.length;

    const failureCounts: Record<string, number> = {};
    for (const device of devicesData) {
      for (const check of device.checks) {
        if (!check.pass) {
          failureCounts[check.rule] = (failureCounts[check.rule] ?? 0) + 1;
        }
      }
    }

    const commonFailures = Object.entries(failureCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({ rule, count }));

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total,
        compliant: compliantCount,
        nonCompliant: total - compliantCount,
        compliancePercent: total ? Math.round((compliantCount / total) * 100) : 0,
        commonFailures
      }
    });
  }
);

complianceRoutes.get(
  '/admin-audit',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  zValidator('query', adminAuditQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const statusRows = await listStatusRows(auth, query.orgId);

    let rows = statusRows.map((row) => {
      const parsed = parseLocalAdminSummary(row.localAdminSummary);
      return {
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        os: row.os,
        adminAccounts: parsed.accounts,
        totalAdmins: parsed.totalAdmins,
        hasIssues: parsed.issueTypes.length > 0,
        issueTypes: parsed.issueTypes,
        issueCounts: parsed.issueCounts
      };
    });

    if (query.issue) {
      const issue = query.issue;
      if (issue === 'no_issues') {
        rows = rows.filter((row) => !row.hasIssues);
      } else {
        rows = rows.filter((row) => row.issueTypes.includes(issue));
      }
    }

    if (query.os) {
      rows = rows.filter((row) => row.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      rows = rows.filter((row) => {
        return row.deviceName.toLowerCase().includes(term) || row.adminAccounts.some((account) => account.username.toLowerCase().includes(term));
      });
    }

    const devicesWithIssues = rows.filter((row) => row.hasIssues).length;
    const totalAdmins = rows.reduce((sum, row) => sum + row.totalAdmins, 0);
    const defaultAccounts = rows.reduce((sum, row) => sum + row.issueCounts.defaultAccounts, 0);
    const weakPasswords = rows.reduce((sum, row) => sum + row.issueCounts.weakPasswords, 0);
    const staleAccounts = rows.reduce((sum, row) => sum + row.issueCounts.staleAccounts, 0);

    return c.json({
      ...paginate(
        rows.map((row) => ({
          deviceId: row.deviceId,
          deviceName: row.deviceName,
          os: row.os,
          adminAccounts: row.adminAccounts,
          totalAdmins: row.totalAdmins,
          hasIssues: row.hasIssues,
          issueTypes: row.issueTypes
        })),
        page,
        limit
      ),
      summary: {
        totalDevices: rows.length,
        devicesWithIssues,
        totalAdmins,
        defaultAccounts,
        weakPasswords,
        staleAccounts
      }
    });
  }
);
