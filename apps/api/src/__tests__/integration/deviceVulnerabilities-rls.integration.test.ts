/**
 * Real-driver cross-tenant forge test for device_vulnerabilities.
 *
 * device_vulnerabilities is a direct org-axis table (org_id + policies using
 * breeze_has_org_access). The global vulnerability catalog row is seeded under
 * system context because the catalog is forced-RLS and system-scoped.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceVulnerabilities, sites, vulnerabilities } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });

    const [siteA] = await db
      .insert(sites)
      .values({ orgId: orgA.id, name: `Vuln RLS Site ${unique}` })
      .returning({ id: sites.id });
    if (!siteA) throw new Error('failed to seed site A');

    const [deviceA] = await db
      .insert(devices)
      .values({
        orgId: orgA.id,
        siteId: siteA.id,
        agentId: `vuln-rls-agent-${unique}`,
        hostname: `vuln-rls-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    if (!deviceA) throw new Error('failed to seed device A');

    const [vulnerability] = await db
      .insert(vulnerabilities)
      .values({
        cveId: `CVE-2099-${unique.replace(/[^0-9a-z]/gi, '').slice(0, 12)}`,
        source: 'nvd',
        description: 'RLS forge test vulnerability',
        severity: 'high',
        cvssVersion: '3.1',
        cvssScore: '8.0',
        knownExploited: false,
        patchAvailable: true,
        rawPayload: { test: true, unique },
      })
      .returning({ id: vulnerabilities.id });
    if (!vulnerability) throw new Error('failed to seed vulnerability');

    return { orgA, orgB, deviceA, vulnerability };
  });
}

describe('device_vulnerabilities RLS (breeze_app)', () => {
  runDb('allows same-org insert and rejects forged cross-org insert', async () => {
    const { orgA, orgB, deviceA, vulnerability } = await seed();

    const vulnerabilityProbe = await withSystemDbAccessContext(() =>
      db
        .select({ id: vulnerabilities.id })
        .from(vulnerabilities)
        .where(eq(vulnerabilities.id, vulnerability.id))
    );
    expect(vulnerabilityProbe).toHaveLength(1);

    const [inserted] = await withDbAccessContext(orgCtx(orgA.id), () =>
      db
        .insert(deviceVulnerabilities)
        .values({
          orgId: orgA.id,
          deviceId: deviceA.id,
          vulnerabilityId: vulnerability.id,
          status: 'open',
          riskScore: '8.00',
          detectedAt: new Date(),
        })
        .returning({ id: deviceVulnerabilities.id })
    );
    expect(inserted?.id).toBeDefined();

    const insertedProbe = await withSystemDbAccessContext(() =>
      db
        .select({ id: deviceVulnerabilities.id })
        .from(deviceVulnerabilities)
        .where(eq(deviceVulnerabilities.id, inserted!.id))
    );
    expect(insertedProbe).toHaveLength(1);

    // Drizzle wraps the PostgresError, so the RLS message lives on `.cause`
    // (the repo convention — see audit-logs-rls / alert-templates-partner-wide).
    let caught: unknown;
    try {
      await withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(deviceVulnerabilities).values({
          orgId: orgA.id,
          deviceId: deviceA.id,
          vulnerabilityId: vulnerability.id,
          status: 'open',
          riskScore: '8.00',
          detectedAt: new Date(),
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'cross-org insert must be rejected by RLS').toBeDefined();
    const cause = (caught as { cause?: { message?: string; code?: string } } | undefined)?.cause;
    expect(cause?.code).toBe('42501'); // insufficient_privilege / RLS WITH CHECK
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "device_vulnerabilities"/
    );
  });
});
