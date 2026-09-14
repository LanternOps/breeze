import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  deploymentResults,
  devices,
  softwareCatalog,
  softwareDeployments,
  softwareVersions,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { softwareDeploymentSiteScopePredicate } from '../../routes/software';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('software deployment parent site scope', () => {
  runDb('shows only parents whose complete result set remains inside the site ceiling', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const allowedSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });
    const testDb = getTestDb();

    const [allowedDevice, hiddenDevice] = await testDb.insert(devices).values([
      {
        orgId: org.id,
        siteId: allowedSite.id,
        agentId: `site-scope-allowed-${Date.now()}`,
        hostname: 'site-scope-allowed',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: 'test',
        status: 'online',
        enrolledAt: new Date(),
      },
      {
        orgId: org.id,
        siteId: hiddenSite.id,
        agentId: `site-scope-hidden-${Date.now()}`,
        hostname: 'site-scope-hidden',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: 'test',
        status: 'online',
        enrolledAt: new Date(),
      },
    ]).returning({ id: devices.id });

    const [catalog] = await testDb.insert(softwareCatalog).values({ orgId: org.id, name: 'scope fixture' }).returning();
    const [version] = await testDb.insert(softwareVersions).values({
      catalogId: catalog!.id,
      version: '1.0.0',
      downloadUrl: 'https://example.invalid/package.exe',
    }).returning();
    const makeDeployment = (name: string) => testDb.insert(softwareDeployments).values({
      orgId: org.id,
      name,
      softwareVersionId: version!.id,
      deploymentType: 'install',
      targetType: 'devices',
      scheduleType: 'immediate',
    }).returning({ id: softwareDeployments.id });
    const [allowedOnly] = await makeDeployment('allowed-only');
    const [hiddenOnly] = await makeDeployment('hidden-only');
    const [mixed] = await makeDeployment('mixed');
    const [empty] = await makeDeployment('empty');
    await testDb.insert(deploymentResults).values([
      { deploymentId: allowedOnly!.id, deviceId: allowedDevice!.id },
      { deploymentId: hiddenOnly!.id, deviceId: hiddenDevice!.id },
      { deploymentId: mixed!.id, deviceId: allowedDevice!.id },
      { deploymentId: mixed!.id, deviceId: hiddenDevice!.id },
    ]);

    const visible = await withSystemDbAccessContext(() => db
      .select({ id: softwareDeployments.id })
      .from(softwareDeployments)
      .where(and(
        eq(softwareDeployments.orgId, org.id),
        softwareDeploymentSiteScopePredicate(
          softwareDeployments.id,
          { allowedSiteIds: [allowedSite.id] } as never,
        ),
      )));
    expect(visible.map((row) => row.id)).toEqual([allowedOnly!.id]);

    const emptyCeiling = await withSystemDbAccessContext(() => db
      .select({ id: softwareDeployments.id })
      .from(softwareDeployments)
      .where(and(
        eq(softwareDeployments.orgId, org.id),
        softwareDeploymentSiteScopePredicate(
          softwareDeployments.id,
          { allowedSiteIds: [] } as never,
        ),
      )));
    expect(emptyCeiling).toEqual([]);

    const unrestricted = await withSystemDbAccessContext(() => db
      .select({ id: softwareDeployments.id })
      .from(softwareDeployments)
      .where(and(
        eq(softwareDeployments.orgId, org.id),
        softwareDeploymentSiteScopePredicate(softwareDeployments.id, undefined),
      )));
    expect(new Set(unrestricted.map((row) => row.id))).toEqual(
      new Set([allowedOnly!.id, hiddenOnly!.id, mixed!.id, empty!.id]),
    );
  });
});
