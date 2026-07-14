import './setup';

import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceVulnerabilities, vulnerabilities } from '../../db/schema';
import { generateSecurityCompliancePostureReport } from '../../services/securityComplianceReport';
import { loadOpenVulnerabilityCounts } from '../../services/securityComplianceReportVulnerabilities';
import { setupTestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('security compliance report vulnerability isolation', () => {
  runDb('counts its own open catalog findings and excludes another organization', async () => {
    const envA = await setupTestEnvironment({ scope: 'organization' });
    const envB = await setupTestEnvironment({ scope: 'organization' });

    const seeded = await withSystemDbAccessContext(async () => {
      const [deviceA, deviceB] = await db
        .insert(devices)
        .values([
          {
            orgId: envA.organization.id,
            siteId: envA.site.id,
            agentId: `posture-a-${Date.now()}`,
            hostname: 'posture-a',
            osType: 'windows',
            osVersion: '11',
            architecture: 'x86_64',
            agentVersion: 'test',
            status: 'offline',
          },
          {
            orgId: envB.organization.id,
            siteId: envB.site.id,
            agentId: `posture-b-${Date.now()}`,
            hostname: 'posture-b',
            osType: 'windows',
            osVersion: '11',
            architecture: 'x86_64',
            agentVersion: 'test',
            status: 'offline',
          },
        ])
        .returning({ id: devices.id, orgId: devices.orgId });

      const [catalogA, catalogB, patchedCatalog, mitigatedCatalog, acceptedCatalog] = await db
        .insert(vulnerabilities)
        .values([
          { cveId: 'CVE-2026-71001', source: 'nvd', description: 'org A open finding', severity: 'HIGH', rawPayload: {} },
          { cveId: 'CVE-2026-71002', source: 'msrc', description: 'org B open finding', severity: 'Critical', rawPayload: {} },
          { cveId: 'CVE-2026-71003', source: 'nvd', description: 'org A patched finding', severity: 'CRITICAL', rawPayload: {} },
          { cveId: 'CVE-2026-71004', source: 'nvd', description: 'org A mitigated finding', severity: 'CRITICAL', rawPayload: {} },
          { cveId: 'CVE-2026-71005', source: 'nvd', description: 'org A accepted finding', severity: 'CRITICAL', rawPayload: {} },
        ])
        .returning({ id: vulnerabilities.id });

      await db.insert(deviceVulnerabilities).values([
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: catalogA!.id,
          status: 'open',
          detectedAt: new Date(),
        },
        {
          orgId: envB.organization.id,
          deviceId: deviceB!.id,
          vulnerabilityId: catalogB!.id,
          status: 'open',
          detectedAt: new Date(),
        },
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: patchedCatalog!.id,
          status: 'patched',
          detectedAt: new Date(),
        },
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: mitigatedCatalog!.id,
          status: 'mitigated',
          detectedAt: new Date(),
        },
        {
          orgId: envA.organization.id,
          deviceId: deviceA!.id,
          vulnerabilityId: acceptedCatalog!.id,
          status: 'accepted',
          detectedAt: new Date(),
        },
      ]);

      return { deviceA: deviceA!.id, deviceB: deviceB!.id };
    });

    const { result, vulnerabilityCounts } = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: envA.organization.id,
        accessibleOrgIds: [envA.organization.id],
        userId: envA.user.id,
      },
      async () => {
        const result = await generateSecurityCompliancePostureReport(envA.organization.id, {
          includeCis: false,
        });
        const vulnerabilityCounts = await loadOpenVulnerabilityCounts([
          seeded.deviceA,
          seeded.deviceB,
        ]);
        return { result, vulnerabilityCounts };
      },
    );

    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostname: 'posture-a',
          openVulnHigh: 1,
          openVulnCritical: 0,
        }),
      ]),
    );
    expect(result.rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ hostname: 'posture-b' })]),
    );
    expect(vulnerabilityCounts.get(seeded.deviceA)).toEqual({ high: 1, critical: 0 });
    expect(vulnerabilityCounts.has(seeded.deviceB)).toBe(false);
  });
});
