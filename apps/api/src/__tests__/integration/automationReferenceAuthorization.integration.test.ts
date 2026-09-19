/**
 * Real-Postgres boundary coverage for live automation reference authorization.
 *
 * Breaks caught here:
 * - configuration-policy automation decomposition persists foreign references;
 * - standalone run admission trusts a previously-active binding after the
 *   referenced resource moves to another tenant;
 * - a denied admission still creates an automation run.
 */
import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  automationResourceBindings,
  automationRuns,
  automations,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  notificationChannels,
  scripts,
  scriptExecutions,
  softwareCatalog,
  softwareDeployments,
  softwareVersions,
} from '../../db/schema';
import { addFeatureLink } from '../../services/configurationPolicy';
import { createAutomationRunRecord, executeAutomationRun } from '../../services/automationRuntime';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
  const tdb = getTestDb();
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });

  const [policyA] = await tdb.insert(configurationPolicies).values({
    orgId: orgA.id,
    partnerId: null,
    name: 'Authorized policy owner',
  }).returning();
  const [foreignScript] = await tdb.insert(scripts).values({
    orgId: orgB.id,
    partnerId: partnerB.id,
    name: 'Foreign script',
    osTypes: ['windows'],
    language: 'powershell',
    content: 'Get-Date',
  }).returning();
  const [foreignCatalog] = await tdb.insert(softwareCatalog).values({
    orgId: orgB.id,
    partnerId: null,
    name: 'Foreign catalog',
  }).returning();
  await tdb.insert(softwareVersions).values({
    catalogId: foreignCatalog!.id,
    version: '1.0.0',
    supportedOs: ['windows'],
    isLatest: true,
  });
  const [foreignChannel] = await tdb.insert(notificationChannels).values({
    orgId: orgB.id,
    partnerId: null,
    name: 'Foreign channel',
    type: 'webhook',
    config: { url: 'https://example.invalid/foreign' },
  }).returning();

  return {
    partnerA,
    partnerB,
    orgA,
    orgB,
    policyA: policyA!,
    foreignScript: foreignScript!,
    foreignCatalog: foreignCatalog!,
    foreignChannel: foreignChannel!,
  };
}

describe.runIf(RUN)('automation reference authorization boundaries', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it.each([
    ['script', (f: Fixture) => ({ type: 'run_script', scriptId: f.foreignScript.id })],
    ['catalog/version', (f: Fixture) => ({ type: 'deploy_software', catalogId: f.foreignCatalog.id })],
    ['notification channel', (f: Fixture) => ({ type: 'send_notification', notificationChannelId: f.foreignChannel.id })],
  ])('stores zero configuration-policy links for a valid foreign %s id', async (_kind, actionFor) => {
    const before = await getTestDb()
      .select({ id: configPolicyFeatureLinks.id })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.configPolicyId, fixture.policyA.id));
    expect(before).toHaveLength(0);

    await expect(withSystemDbAccessContext(() => addFeatureLink(
      fixture.policyA.id,
      'automation',
      null,
      {
        items: [{
          name: 'Foreign reference',
          triggerType: 'manual',
          actions: [actionFor(fixture)],
        }],
      },
    ))).rejects.toMatchObject({ code: 'unknown_or_unauthorized_reference' });

    const links = await getTestDb()
      .select({ id: configPolicyFeatureLinks.id })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.configPolicyId, fixture.policyA.id));
    expect(links).toHaveLength(0);
  });

  it.each(['manual:test-user', 'scheduler', 'event:device.offline', 'webhook'])(
    'creates zero runs for %s when an active standalone script binding becomes foreign before admission',
    async (triggeredBy) => {
    const tdb = getTestDb();
    const [ownedScript] = await tdb.insert(scripts).values({
      orgId: fixture.orgA.id,
      partnerId: fixture.partnerA.id,
      name: 'Moves after binding',
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Get-Date',
    }).returning();
    const [automation] = await tdb.insert(automations).values({
      orgId: fixture.orgA.id,
      partnerId: null,
      name: 'Moved reference admission',
      trigger: { type: 'manual' },
      actions: [{ type: 'run_script', scriptId: ownedScript!.id }],
      onFailure: 'stop',
    }).returning();
    await tdb.insert(automationResourceBindings).values({
      automationId: automation!.id,
      orgId: fixture.orgA.id,
      partnerId: null,
      resourceKind: 'script',
      resourceId: ownedScript!.id,
      expectedResourceOrgId: fixture.orgA.id,
      expectedResourcePartnerId: fixture.partnerA.id,
      expectedResourceIsSystem: false,
      state: 'active',
    });

    await tdb.update(scripts).set({
      orgId: fixture.orgB.id,
      partnerId: fixture.partnerB.id,
    }).where(eq(scripts.id, ownedScript!.id));

    await expect(withSystemDbAccessContext(() => createAutomationRunRecord({
      automation: automation!,
      triggeredBy,
    }))).rejects.toMatchObject({ code: 'unknown_or_unauthorized_reference' });

    const runs = await tdb
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automation!.id));
    expect(runs).toHaveLength(0);
    },
  );

  it('blocks a forged queued retry after ownership moves with zero downstream mutations', async () => {
    const tdb = getTestDb();
    const [ownedScript] = await tdb.insert(scripts).values({
      orgId: fixture.orgA.id,
      partnerId: fixture.partnerA.id,
      name: 'Queued script moves',
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Get-Date',
    }).returning();
    const [automation] = await tdb.insert(automations).values({
      orgId: fixture.orgA.id,
      partnerId: null,
      name: 'Forged queued retry',
      trigger: { type: 'manual' },
      actions: [{ type: 'run_script', scriptId: ownedScript!.id }],
      onFailure: 'stop',
    }).returning();
    await tdb.insert(automationResourceBindings).values({
      automationId: automation!.id,
      orgId: fixture.orgA.id,
      partnerId: null,
      resourceKind: 'script',
      resourceId: ownedScript!.id,
      expectedResourceOrgId: fixture.orgA.id,
      expectedResourcePartnerId: fixture.partnerA.id,
      expectedResourceIsSystem: false,
      state: 'active',
    });
    const [run] = await tdb.insert(automationRuns).values({
      automationId: automation!.id,
      triggeredBy: 'manual:forged-retry',
      status: 'running',
    }).returning();

    await tdb.update(scripts).set({
      orgId: fixture.orgB.id,
      partnerId: fixture.partnerB.id,
    }).where(eq(scripts.id, ownedScript!.id));

    await expect(withSystemDbAccessContext(() => executeAutomationRun(run!.id, [])))
      .rejects.toMatchObject({ code: 'unknown_or_unauthorized_reference' });

    const [executionRows, deploymentRows, commandRows] = await Promise.all([
      tdb.select({ id: scriptExecutions.id }).from(scriptExecutions),
      tdb.select({ id: softwareDeployments.id }).from(softwareDeployments),
      tdb.select({ id: deviceCommands.id }).from(deviceCommands),
    ]);
    expect(executionRows).toHaveLength(0);
    expect(deploymentRows).toHaveLength(0);
    expect(commandRows).toHaveLength(0);
  });
});
