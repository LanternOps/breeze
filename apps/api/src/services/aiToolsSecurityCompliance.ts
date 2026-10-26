/**
 * `get_security_compliance` (full-control W11, #6781): the AI read over the
 * security status and compliance routes — GET /security/{dashboard,
 * score-breakdown, trends, status[/:deviceId], firewall, encryption,
 * password-policy, admin-audit}.
 *
 * Tier 1, read-only, agent-reachable. A new tool rather than an extension of
 * `get_security_posture` (W11-D2): that tool is `alwaysLoad` and reads posture
 * snapshots, these views read `security_status`. Built from the routes' own
 * helpers (`listStatusRows`, which applies the org and site axes in SQL, the
 * summary parsers, the posture services); the exact-device axis is applied on
 * top. Deliberate differences from REST (W11-D5): no synthesised firewall
 * profiles or rule counts, no synthesised encryption volume, no TPM guess —
 * the model only ever sees what an agent reported. The org-wide aggregates
 * (dashboard, score breakdown, trends) are refused to a session bound to
 * specific devices.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceRecoveryKeys } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import { filterToDeviceScope, siteAllowlistOf } from './aiToolsSiteScope';
import { getSecurityPostureTrend, listLatestSecurityPosture } from './securityPosture';
import {
  averageFactorScore,
  buildBe9Recommendations,
  computeSecurityScore,
  countFactorBelow,
  deriveEncryptionMethod,
  listStatusRows,
  listThreatRows,
  normalizeEncryption,
  parseEncryptionVolumes,
  parseLocalAdminSummary,
  parsePasswordPolicySummary,
  resolveScopedOrgIds,
  toStatusResponse,
} from '../routes/security/helpers';
import { postureComponentModel } from '../routes/security/schemas';
import { SECURITY_COMPLIANCE_FILTERS, SECURITY_COMPLIANCE_VIEWS } from './aiToolSchemasSecurityPolicy';
import { bounded, deviceBoundDenied, jsonError, notFound, str, thrown } from './aiToolsSecurityPolicyShared';

type View = (typeof SECURITY_COMPLIANCE_VIEWS)[number];
const TOOL = 'get_security_compliance';
const PAGE = { defaultLimit: 25, maxLimit: 100 } as const;

const grade = (score: number) => (score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F');
const mean = (xs: number[]) => (xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

/** The status rows this caller may see: org + site axes in SQL (`listStatusRows`), exact-device axis here. */
async function visibleStatusRows(auth: AuthContext, orgId: string | undefined) {
  return filterToDeviceScope(auth, await listStatusRows(auth, orgId), (row) => row.deviceId);
}

function matchesSearch(name: string, search: string | undefined): boolean {
  return !search || name.toLowerCase().includes(search.toLowerCase());
}

async function aggregateView(view: 'dashboard' | 'score_breakdown' | 'trends', input: Record<string, unknown>, auth: AuthContext, orgId: string | undefined) {
  const denied = deviceBoundDenied(auth, 'This security summary');
  if (denied) return denied;
  const scope = resolveScopedOrgIds(auth, orgId);
  if (scope.error) return jsonError(scope.error.message, scope.error.status === 403 ? 'ACCESS_DENIED' : 'VALIDATION_ERROR');
  const siteIds = siteAllowlistOf(auth);

  if (view === 'trends') {
    const period = input.period === '7d' || input.period === '90d' ? input.period : '30d';
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const dataPoints = await getSecurityPostureTrend({ orgIds: scope.orgIds, siteIds, days });
    const previous = Number(dataPoints[0]?.overall ?? 0);
    const current = Number(dataPoints[dataPoints.length - 1]?.overall ?? 0);
    return bounded({
      view, period, dataPoints,
      summary: { current, previous, change: current - previous, trend: current > previous ? 'improving' : current < previous ? 'declining' : 'stable' },
    });
  }

  const posture = await listLatestSecurityPosture({ orgIds: scope.orgIds, siteIds, limit: 2000 });
  if (view === 'score_breakdown') {
    const total = posture.length;
    const overallScore = mean(posture.map((item) => item.overallScore));
    return bounded({
      view,
      overallScore,
      grade: grade(overallScore),
      devicesAudited: total,
      components: postureComponentModel.map((component) => {
        const score = averageFactorScore(posture, component.category);
        return {
          category: component.category, label: component.label, score, weight: component.weight,
          status: score >= 90 ? 'good' : score >= 75 ? 'warning' : 'critical',
          affectedDevices: countFactorBelow(posture, component.category, 80), totalDevices: total,
        };
      }),
    });
  }

  // dashboard: the counts of GET /security/dashboard, without the per-provider catalog names and the chart series.
  const [statusRows, threats, recs] = await Promise.all([
    listStatusRows(auth, orgId),
    listThreatRows(auth, undefined, orgId),
    buildBe9Recommendations(auth, orgId),
  ]);
  const statuses = statusRows.map(toStatusResponse);
  const triState = (pick: (s: (typeof statuses)[number]) => boolean | null) => {
    let on = 0; let off = 0; let unknown = 0;
    for (const s of statuses) { const v = pick(s); if (v === true) on += 1; else if (v === false) off += 1; else unknown += 1; }
    return { on, off, unknown };
  };
  const av = triState((s) => s.realTimeProtection);
  const fw = triState((s) => s.firewallEnabled);
  const encrypted = (os: string, state: 'encrypted' | 'partial') => statuses.filter((s) => s.os === os && s.encryptionStatus === state).length;
  const admins = statusRows.map((row) => parseLocalAdminSummary(row.localAdminSummary));
  const usePosture = posture.length > 0;
  return bounded({
    view,
    totalDevices: usePosture ? posture.length : statuses.length,
    protectedDevices: usePosture ? posture.filter((p) => p.deviceStatus === 'online' && p.riskLevel === 'low').length : statuses.filter((s) => s.status === 'protected').length,
    atRiskDevices: usePosture ? posture.filter((p) => p.riskLevel === 'medium' || p.riskLevel === 'high').length : statuses.filter((s) => s.status === 'at_risk').length,
    unprotectedDevices: usePosture ? posture.filter((p) => p.riskLevel === 'critical').length : statuses.filter((s) => s.status === 'unprotected').length,
    offlineDevices: usePosture ? posture.filter((p) => p.deviceStatus !== 'online').length : statuses.filter((s) => s.status === 'offline').length,
    securityScore: usePosture ? mean(posture.map((p) => p.overallScore)) : computeSecurityScore(statuses, threats),
    threats: {
      total: threats.length,
      active: threats.filter((t) => t.status === 'active').length,
      quarantined: threats.filter((t) => t.status === 'quarantined').length,
      removed: threats.filter((t) => t.status === 'removed').length,
    },
    antivirus: { protected: av.on, unprotected: av.off, unknown: av.unknown },
    firewall: { enabled: fw.on, disabled: fw.off, unknown: fw.unknown },
    encryption: {
      bitlockerEnabled: encrypted('windows', 'encrypted'), bitlockerPartial: encrypted('windows', 'partial'),
      filevaultEnabled: encrypted('macos', 'encrypted'), filevaultPartial: encrypted('macos', 'partial'),
      total: statuses.length,
    },
    passwordPolicyCompliance: averageFactorScore(posture, 'password_policy'),
    adminAudit: {
      defaultAccounts: admins.reduce((n, a) => n + a.issueCounts.defaultAccounts, 0),
      weakAccounts: admins.reduce((n, a) => n + a.issueCounts.weakPasswords, 0),
      devicesWithIssues: admins.filter((a) => a.issueTypes.length > 0).length,
    },
    recommendations: (recs.error ? [] : recs.recommendations).map((r) => ({ id: r.id, title: r.title, priority: r.priority, category: r.category })),
  });
}

async function deviceView(view: Exclude<View, 'dashboard' | 'score_breakdown' | 'trends'>, input: Record<string, unknown>, auth: AuthContext, orgId: string | undefined) {
  const page = readPageArgs(TOOL, input, PAGE);
  if (!page.ok) return jsonError(page.error, page.code);
  const filter = str(input.filter);
  const os = str(input.os);
  const search = str(input.search);

  if (view === 'status' && str(input.deviceId)) {
    const access = await verifyDeviceAccess(String(input.deviceId), auth);
    if ('error' in access) return notFound('Device');
    const row = (await listStatusRows(auth, access.device.orgId)).find((r) => r.deviceId === access.device.id);
    return row ? bounded({ view, device: toStatusResponse(row) }) : notFound('Device security status');
  }

  const rows = await visibleStatusRows(auth, orgId);
  const finish = (items: unknown[], summary: Record<string, unknown>) =>
    bounded({ view, summary, ...pageEnvelope({ key: 'devices', items: items.slice(page.offset, page.offset + page.limit), limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: items.length }) });

  if (view === 'status') {
    const statuses = rows.map(toStatusResponse).filter((s) => (!filter || s.status === filter) && (!os || s.os === os) && matchesSearch(s.deviceName, search));
    const count = (state: string) => statuses.filter((s) => s.status === state).length;
    return finish(statuses, { total: statuses.length, protected: count('protected'), atRisk: count('at_risk'), unprotected: count('unprotected'), offline: count('offline') });
  }

  if (view === 'firewall') {
    // Only what the agent reported: no synthesised profiles or rule counts (W11-D5).
    const all = rows.map(toStatusResponse);
    const items = all
      .filter((s) => (!filter || s.firewallEnabled === (filter === 'enabled')) && (!os || s.os === os) && matchesSearch(s.deviceName, search))
      .map((s) => ({ deviceId: s.deviceId, deviceName: s.deviceName, os: s.os, firewallEnabled: s.firewallEnabled }));
    const enabled = all.filter((s) => s.firewallEnabled === true).length;
    const disabled = all.filter((s) => s.firewallEnabled === false).length;
    return finish(items, { total: all.length, enabled, disabled, unknown: all.length - enabled - disabled, coveragePercent: all.length ? Math.round((enabled / all.length) * 100) : 0 });
  }

  if (view === 'encryption') {
    const deviceIds = rows.map((row) => row.deviceId);
    const escrowed = new Set(
      deviceIds.length
        ? (await db.selectDistinct({ deviceId: deviceRecoveryKeys.deviceId }).from(deviceRecoveryKeys)
          .where(and(eq(deviceRecoveryKeys.status, 'active'), inArray(deviceRecoveryKeys.deviceId, deviceIds)))).map((r) => r.deviceId)
        : [],
    );
    const items = rows.map((row) => {
      const s = toStatusResponse(row);
      return {
        deviceId: s.deviceId, deviceName: s.deviceName, os: s.os,
        encryptionMethod: deriveEncryptionMethod(row.encryptionDetails, s.encryptionStatus),
        encryptionStatus: s.encryptionStatus,
        volumes: parseEncryptionVolumes(row.encryptionDetails) ?? [],
        recoveryKeyEscrowed: escrowed.has(s.deviceId),
      };
    }).filter((d) => (!filter || d.encryptionStatus === filter) && (!os || d.os === os) && matchesSearch(d.deviceName, search));
    const state = (want: string) => items.filter((d) => normalizeEncryption(d.encryptionStatus) === want).length;
    return finish(items, {
      total: items.length, fullyEncrypted: state('encrypted'), partial: state('partial'), unencrypted: state('unencrypted'),
      recoveryKeysEscrowed: items.filter((d) => d.recoveryKeyEscrowed).length,
    });
  }

  if (view === 'password_policy') {
    const items = rows.map((row) => {
      const policy = parsePasswordPolicySummary(row.passwordPolicySummary);
      const admin = parseLocalAdminSummary(row.localAdminSummary);
      return {
        deviceId: row.deviceId, deviceName: row.deviceName, os: row.os, compliant: policy.compliant,
        checks: policy.checks.map((c) => ({ rule: c.rule, pass: c.pass })),
        localAccounts: admin.localAccounts, adminAccounts: admin.totalAdmins,
      };
    }).filter((d) => (!filter || d.compliant === (filter === 'compliant')) && (!os || d.os === os) && matchesSearch(d.deviceName, search));
    const failures: Record<string, number> = {};
    for (const d of items) for (const c of d.checks) if (!c.pass) failures[c.rule] = (failures[c.rule] ?? 0) + 1;
    const compliant = items.filter((d) => d.compliant).length;
    return finish(items, {
      total: items.length, compliant, nonCompliant: items.length - compliant,
      compliancePercent: items.length ? Math.round((compliant / items.length) * 100) : 0,
      commonFailures: Object.entries(failures).sort((a, b) => b[1] - a[1]).map(([rule, count]) => ({ rule, count })),
    });
  }

  // admin_audit: local admin account names are device-reported text (fenced by RAW_TEXT_FIELDS_BY_TOOL).
  const items = rows.map((row) => {
    const parsed = parseLocalAdminSummary(row.localAdminSummary);
    return {
      deviceId: row.deviceId, deviceName: row.deviceName, os: row.os,
      adminAccounts: parsed.accounts.map((a) => ({ username: a.username, isBuiltIn: a.isBuiltIn, enabled: a.enabled, issues: a.issues })),
      totalAdmins: parsed.totalAdmins, issueTypes: parsed.issueTypes, issueCounts: parsed.issueCounts,
    };
  }).filter((d) => (!filter || (filter === 'no_issues' ? d.issueTypes.length === 0 : (d.issueTypes as string[]).includes(filter)))
    && (!os || d.os === os)
    && (!search || matchesSearch(d.deviceName, search) || d.adminAccounts.some((a) => matchesSearch(a.username, search))));
  return finish(items.map(({ issueCounts: _c, ...rest }) => rest), {
    totalDevices: items.length,
    devicesWithIssues: items.filter((d) => d.issueTypes.length > 0).length,
    totalAdmins: items.reduce((n, d) => n + d.totalAdmins, 0),
    defaultAccounts: items.reduce((n, d) => n + d.issueCounts.defaultAccounts, 0),
    weakPasswords: items.reduce((n, d) => n + d.issueCounts.weakPasswords, 0),
    staleAccounts: items.reduce((n, d) => n + d.issueCounts.staleAccounts, 0),
  });
}

export function registerSecurityComplianceTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'security',
    searchHint: 'security status and compliance: AV, firewall, BitLocker/FileVault encryption, password policy, local admins, score trend',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_security_compliance',
      description:
        'Security status and compliance views (read-only). view: dashboard, score_breakdown, trends, status (fleet, or one deviceId), firewall, encryption, password_policy, admin_audit. For per-device posture scores use get_security_posture.',
      input_schema: {
        type: 'object' as const,
        properties: {
          view: { type: 'string', enum: [...SECURITY_COMPLIANCE_VIEWS], description: 'Which view to read' },
          orgId: { type: 'string', description: 'Only this organization UUID (must be accessible)' },
          deviceId: { type: 'string', description: 'status view: one device UUID' },
          period: { type: 'string', enum: ['7d', '30d', '90d'], description: 'trends view: window (default 30d)' },
          filter: {
            type: 'string',
            enum: [...new Set(Object.values(SECURITY_COMPLIANCE_FILTERS).flat())],
            description: 'status: protected|at_risk|unprotected|offline; firewall: enabled|disabled; encryption: encrypted|partial|unencrypted; password_policy: compliant|non_compliant; admin_audit: default_account|weak_password|stale_account|no_issues',
          },
          os: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Device-list views: only this OS' },
          search: { type: 'string', description: 'Device-list views: device name contains (admin_audit also matches account names)' },
          ...pageParamSchema(PAGE.defaultLimit, PAGE.maxLimit),
        },
        required: ['view'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const view = input.view as View;
      if (!SECURITY_COMPLIANCE_VIEWS.includes(view)) return jsonError(`Unknown view: ${String(view)}`, 'VALIDATION_ERROR');
      const filter = str(input.filter);
      if (filter) {
        const allowed = (SECURITY_COMPLIANCE_FILTERS as Record<string, readonly string[]>)[view];
        if (!allowed?.includes(filter)) return jsonError(`filter '${filter}' does not apply to the ${view} view`, 'VALIDATION_ERROR');
      }
      if (str(input.deviceId) && view !== 'status') return jsonError('deviceId applies to the status view only', 'VALIDATION_ERROR');
      const orgId = str(input.orgId);
      if (orgId && !auth.canAccessOrg(orgId)) return notFound('Organization');
      try {
        return view === 'dashboard' || view === 'score_breakdown' || view === 'trends'
          ? await aggregateView(view, input, auth, orgId)
          : await deviceView(view, input, auth, orgId);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
