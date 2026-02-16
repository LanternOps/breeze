import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';

import { requireScope } from '../../middleware/auth';
import {
  listLatestSecurityPosture,
  getSecurityPostureTrend
} from '../../services/securityPosture';
import { dashboardQuerySchema, providerCatalog, postureComponentModel } from './schemas';
import {
  resolveScopedOrgIds,
  listStatusRows,
  listThreatRows,
  toStatusResponse,
  normalizeProvider,
  normalizeEncryption,
  computeSecurityScore,
  averageFactorScore,
  countFactorBelow,
  parseLocalAdminSummary,
  buildBe9Recommendations
} from './helpers';

export const dashboardRoutes = new Hono();

dashboardRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dashboardQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const scope = resolveScopedOrgIds(auth, query.orgId);
    if (scope.error) {
      return c.json({ error: scope.error.message }, scope.error.status);
    }

    const [statusRows, threats, posture, recommendationsResult, trendPoints] = await Promise.all([
      listStatusRows(auth, query.orgId),
      listThreatRows(auth, undefined, query.orgId),
      listLatestSecurityPosture({
        orgIds: scope.orgIds,
        limit: 2000
      }),
      buildBe9Recommendations(auth, query.orgId),
      getSecurityPostureTrend({
        orgIds: scope.orgIds,
        days: 30
      })
    ]);
    const statuses = statusRows.map(toStatusResponse);

    const providerCounts = new Map<string, number>();
    for (const status of statuses) {
      providerCounts.set(status.providerId, (providerCounts.get(status.providerId) ?? 0) + 1);
    }

    const providers = Array.from(providerCounts.entries()).map(([providerId, deviceCount]) => ({
      providerId,
      providerName: providerCatalog[normalizeProvider(providerId)].name,
      deviceCount,
      coverage: statuses.length === 0 ? 0 : Math.round((deviceCount / statuses.length) * 100)
    }));

    const lastScanAt = statuses
      .map((status) => status.lastScanAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

    const totalDevices = posture.length > 0 ? posture.length : statuses.length;
    const protectedDevices = posture.length > 0
      ? posture.filter((item) => item.deviceStatus === 'online' && item.riskLevel === 'low').length
      : statuses.filter((status) => status.status === 'protected').length;
    const atRiskDevices = posture.length > 0
      ? posture.filter((item) => item.riskLevel === 'medium' || item.riskLevel === 'high').length
      : statuses.filter((status) => status.status === 'at_risk').length;
    const unprotectedDevices = posture.length > 0
      ? posture.filter((item) => item.riskLevel === 'critical').length
      : statuses.filter((status) => status.status === 'unprotected').length;
    const offlineDevices = posture.length > 0
      ? posture.filter((item) => item.deviceStatus !== 'online').length
      : statuses.filter((status) => status.status === 'offline').length;
    const securityScore = posture.length > 0
      ? Math.round(posture.reduce((sum, item) => sum + item.overallScore, 0) / posture.length)
      : computeSecurityScore(statuses, threats);

    const passwordPolicyCompliance = averageFactorScore(posture, 'password_policy');

    const parsedAdmins = statusRows.map((row) => parseLocalAdminSummary(row.localAdminSummary));
    const defaultAccounts = parsedAdmins.reduce((sum, admin) => sum + admin.issueCounts.defaultAccounts, 0);
    const weakAccounts = parsedAdmins.reduce((sum, admin) => sum + admin.issueCounts.weakPasswords, 0);

    const encryptedStatuses = statuses.filter((status) => status.encryptionStatus !== 'unencrypted');
    const bitlockerEnabled = encryptedStatuses.filter((status) => status.os === 'windows').length;
    const filevaultEnabled = encryptedStatuses.filter((status) => status.os === 'macos').length;

    const chartTrend = trendPoints.map((point) => ({
      timestamp: String(point.timestamp),
      score: Number(point.overall ?? 0)
    }));

    return c.json({
      data: {
        totalDevices,
        protectedDevices,
        atRiskDevices,
        unprotectedDevices,
        offlineDevices,
        totalThreatsDetected: threats.length,
        activeThreats: threats.filter((threat) => threat.status === 'active').length,
        quarantinedThreats: threats.filter((threat) => threat.status === 'quarantined').length,
        removedThreats: threats.filter((threat) => threat.status === 'removed').length,
        lastScanAt,
        providers,
        securityScore,
        overallScore: securityScore,
        firewallEnabled: statuses.filter((status) => status.firewallEnabled).length,
        firewallDisabled: statuses.filter((status) => !status.firewallEnabled).length,
        encryption: {
          bitlockerEnabled,
          filevaultEnabled,
          total: statuses.length
        },
        passwordPolicyCompliance,
        adminAudit: {
          defaultAccounts,
          weakAccounts,
          deviceCount: statuses.length,
          devices: statusRows
            .map((row) => {
              const parsed = parseLocalAdminSummary(row.localAdminSummary);
              if (parsed.issueTypes.length === 0) return null;
              return {
                id: row.deviceId,
                name: row.deviceName,
                issue: parsed.issueTypes[0]
              };
            })
            .filter((row): row is { id: string; name: string; issue: 'default_account' | 'weak_password' | 'stale_account' } => row !== null)
            .slice(0, 10)
        },
        recommendations: (recommendationsResult.error ? [] : recommendationsResult.recommendations).map((rec) => ({
          id: rec.id,
          title: rec.title,
          description: rec.description,
          priority: rec.priority,
          category: rec.category
        })),
        trend: chartTrend
      }
    });
  }
);

dashboardRoutes.get(
  '/score-breakdown',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const scope = resolveScopedOrgIds(auth);
    if (scope.error) {
      return c.json({ error: scope.error.message }, scope.error.status);
    }

    const posture = await listLatestSecurityPosture({
      orgIds: scope.orgIds,
      limit: 2000
    });
    const total = posture.length;
    const stateOf = (score: number) => (score >= 90 ? 'good' : score >= 75 ? 'warning' : 'critical');

    const components = postureComponentModel.map((component) => {
      const score = averageFactorScore(posture, component.category);
      return {
        category: component.category,
        label: component.label,
        score,
        weight: component.weight,
        status: stateOf(score),
        affectedDevices: countFactorBelow(posture, component.category, 80),
        totalDevices: total
      };
    });

    const overallScore = total === 0
      ? 0
      : Math.round(posture.reduce((sum, item) => sum + item.overallScore, 0) / total);

    const grade =
      overallScore >= 90
        ? 'A'
        : overallScore >= 80
          ? 'B'
          : overallScore >= 70
            ? 'C'
            : overallScore >= 60
              ? 'D'
              : 'F';

    return c.json({
      data: {
        overallScore,
        grade,
        devicesAudited: total,
        components
      }
    });
  }
);
