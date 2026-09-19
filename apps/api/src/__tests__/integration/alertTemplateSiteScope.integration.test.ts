/** Real-PostgreSQL proof for legacy alert rule/template site authorization. */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext } from '../../db';
import { alertRules, alertTemplates, devices } from '../../db/schema';
import {
  canAccessAlertRuleTargets,
  canAccessTemplateDependents,
} from '../../routes/alertTemplates/siteScope';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

describe('legacy alert rule/template site authorization as breeze_app', () => {
  it('allows visible targets and denies hidden targets and shared templates with hidden dependents', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const foreignOrg = await createOrganization({ partnerId: partner.id });
    const allowedSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id });
    const [allowedDevice, hiddenDevice, foreignDevice] = await testDb.insert(devices).values([
      {
        orgId: org.id, siteId: allowedSite.id, agentId: `agent-${randomUUID()}`,
        hostname: 'allowed-alert-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
      },
      {
        orgId: org.id, siteId: hiddenSite.id, agentId: `agent-${randomUUID()}`,
        hostname: 'hidden-alert-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
      },
      {
        orgId: foreignOrg.id, siteId: foreignSite.id, agentId: `agent-${randomUUID()}`,
        hostname: 'foreign-alert-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
      },
    ]).returning();
    const [template] = await testDb.insert(alertTemplates).values({
      orgId: org.id, name: 'Shared site fixture', conditions: {}, severity: 'high',
      titleTemplate: 'Fixture', messageTemplate: 'Fixture', isBuiltIn: false,
    }).returning();
    await testDb.insert(alertRules).values([
      {
        orgId: org.id, templateId: template!.id, name: 'Visible rule',
        targetType: 'device', targetId: allowedDevice!.id,
      },
      {
        orgId: org.id, templateId: template!.id, name: 'Hidden rule',
        targetType: 'device', targetId: hiddenDevice!.id,
      },
    ]);

    const auth = { allowedSiteIds: [allowedSite.id] } as any;
    await withDbAccessContext({ scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] }, async () => {
      await expect(canAccessAlertRuleTargets(auth, org.id, 'device', [allowedDevice!.id], true)).resolves.toBe(true);
      await expect(canAccessAlertRuleTargets(auth, org.id, 'device', [hiddenDevice!.id], true)).resolves.toBe(false);
      await expect(canAccessAlertRuleTargets(auth, org.id, 'device', [foreignDevice!.id], true)).resolves.toBe(false);
      await expect(canAccessAlertRuleTargets(
        { allowedSiteIds: [foreignSite.id] }, org.id, 'site', [foreignSite.id], true,
      )).resolves.toBe(false);
      await expect(canAccessAlertRuleTargets(auth, org.id, 'org', [], true)).resolves.toBe(false);
      await expect(canAccessTemplateDependents(auth, template!.id, org.id)).resolves.toBe(false);
    });
  });
});
