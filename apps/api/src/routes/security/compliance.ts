import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';

import { requireScope } from '../../middleware/auth';
import { getSecurityPostureTrend } from '../../services/securityPosture';
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
  listStatusRows,
  toStatusResponse,
  normalizeEncryption,
  parsePasswordPolicySummary,
  parseLocalAdminSummary
} from './helpers';

export const complianceRoutes = new Hono();

complianceRoutes.get(
  '/trends',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', trendsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { period } = c.req.valid('query');
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;

    const orgIds = auth.orgId
      ? [auth.orgId]
      : auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0
        ? auth.accessibleOrgIds
        : undefined;

    const dataPoints = await getSecurityPostureTrend({
      orgIds,
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
  zValidator('query', firewallQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);

    let devicesData = statuses.map((status) => ({
      deviceId: status.deviceId,
      deviceName: status.deviceName,
      os: status.os,
      firewallEnabled: status.firewallEnabled,
      profiles: status.os === 'windows'
        ? [
            { name: 'Domain', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' },
            { name: 'Private', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' },
            { name: 'Public', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'block' }
          ]
        : [{ name: status.os === 'macos' ? 'Application Firewall' : 'iptables/nftables', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' }],
      rulesCount: status.firewallEnabled ? (status.os === 'windows' ? 142 : 38) : 0
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

    const enabledCount = statuses.filter((status) => status.firewallEnabled).length;
    const disabledCount = statuses.length - enabledCount;

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total: statuses.length,
        enabled: enabledCount,
        disabled: disabledCount,
        coveragePercent: statuses.length ? Math.round((enabledCount / statuses.length) * 100) : 0
      }
    });
  }
);

complianceRoutes.get(
  '/encryption',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', encryptionQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);

    const methodByOs: Record<'windows' | 'macos' | 'linux', string> = {
      windows: 'bitlocker',
      macos: 'filevault',
      linux: 'luks'
    };

    let devicesData = statuses.map((status) => {
      const encStatus = normalizeEncryption(status.encryptionStatus);
      const method = encStatus === 'unencrypted' ? 'none' : methodByOs[status.os];

      return {
        deviceId: status.deviceId,
        deviceName: status.deviceName,
        os: status.os,
        encryptionMethod: method,
        encryptionStatus: encStatus,
        volumes: [
          {
            drive: status.os === 'windows' ? 'C:' : status.os === 'macos' ? 'Macintosh HD' : '/dev/sda1',
            encrypted: encStatus !== 'unencrypted',
            method: method === 'bitlocker' ? 'BitLocker' : method === 'filevault' ? 'FileVault' : method === 'luks' ? 'LUKS2' : 'None',
            size: status.os === 'linux' ? '1 TB' : '512 GB'
          }
        ],
        tpmPresent: status.os === 'windows',
        recoveryKeyEscrowed: encStatus !== 'unencrypted' && status.os !== 'linux'
      };
    });

    if (query.status) {
      devicesData = devicesData.filter((device) => device.encryptionStatus === query.status);
    }

    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }

    const fullyEncrypted = statuses.filter((status) => normalizeEncryption(status.encryptionStatus) === 'encrypted').length;
    const partial = statuses.filter((status) => normalizeEncryption(status.encryptionStatus) === 'partial').length;
    const unencrypted = statuses.filter((status) => normalizeEncryption(status.encryptionStatus) === 'unencrypted').length;

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total: statuses.length,
        fullyEncrypted,
        partial,
        unencrypted,
        methodCounts: {
          bitlocker: devicesData.filter((device) => device.encryptionMethod === 'bitlocker').length,
          filevault: devicesData.filter((device) => device.encryptionMethod === 'filevault').length,
          luks: devicesData.filter((device) => device.encryptionMethod === 'luks').length,
          none: devicesData.filter((device) => device.encryptionMethod === 'none').length
        }
      }
    });
  }
);

complianceRoutes.get(
  '/password-policy',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', passwordPolicyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const statusRows = await listStatusRows(auth);

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
  zValidator('query', adminAuditQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const statusRows = await listStatusRows(auth);

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
