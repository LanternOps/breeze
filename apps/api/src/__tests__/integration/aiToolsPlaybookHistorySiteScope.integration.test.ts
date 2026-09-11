import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, playbookDefinitions, playbookExecutions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { registerPlaybookTools } from '../../services/aiToolsPlaybooks';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL_APP);

function historyHandler(): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerPlaybookTools(registry);
  return registry.get('get_playbook_history')!.handler;
}

function authFor(orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: randomUUID(), email: 'operator@example.test', name: 'Operator', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: () => undefined,
    canAccessOrg: (candidate) => candidate === orgId,
    allowedSiteIds,
    canAccessSite: (siteId) => allowedSiteIds === undefined
      || (!!siteId && allowedSiteIds.includes(siteId)),
  } as AuthContext;
}

function dbContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId] };
}

async function seedDevice(orgId: string, siteId: string, hostname: string) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `agent-${randomUUID()}`,
    hostname,
    osType: 'linux',
    osVersion: '1.0',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'online',
  }).returning({ id: devices.id });
  return device!;
}

async function seedPlaybook(orgId: string, name: string) {
  const [playbook] = await getTestDb().insert(playbookDefinitions).values({
    orgId,
    name,
    description: 'Synthetic playbook',
    category: 'security',
    steps: [],
    requiredPermissions: [],
  }).returning({ id: playbookDefinitions.id });
  return playbook!;
}

async function seedExecution(
  orgId: string,
  deviceId: string,
  playbookId: string,
  marker: string,
  createdAt: Date,
) {
  await getTestDb().insert(playbookExecutions).values({
    orgId,
    deviceId,
    playbookId,
    status: 'failed',
    currentStepIndex: 1,
    steps: [{
      stepIndex: 0,
      stepName: marker,
      status: 'failed',
      toolInput: { marker },
      toolOutput: `${marker}-output`,
      error: `${marker}-error`,
    }],
    errorMessage: `${marker}-execution-error`,
    triggeredBy: 'ai',
    createdAt,
  });
}

describe.skipIf(!SHOULD_RUN)('playbook history AI site scope', () => {
  it('filters current device visibility before LIMIT and follows a later site move', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const visibleSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const visible = await seedDevice(org.id, visibleSite.id, 'visible-host');
    const hidden = await seedDevice(org.id, hiddenSite.id, 'hidden-host');
    const crossOrg = await seedDevice(otherOrg.id, otherSite.id, 'cross-org-host');
    const playbook = await seedPlaybook(org.id, 'Visible org playbook');
    const otherPlaybook = await seedPlaybook(otherOrg.id, 'Other org playbook');
    const now = Date.now();
    await seedExecution(org.id, hidden.id, playbook.id, 'hidden', new Date(now - 1_000));
    await seedExecution(org.id, visible.id, playbook.id, 'visible', new Date(now - 2_000));
    await seedExecution(otherOrg.id, crossOrg.id, otherPlaybook.id, 'cross-org', new Date(now));

    const selected = authFor(org.id, [visibleSite.id]);
    const context = dbContext(org.id);
    const result = JSON.parse(await withDbAccessContext(context, () =>
      historyHandler()({ limit: 1 }, selected)));
    expect(result.count).toBe(1);
    expect(result.executions).toEqual([expect.objectContaining({
      deviceHostname: 'visible-host',
      errorMessage: 'visible-execution-error',
      steps: [expect.objectContaining({ stepName: 'visible' })],
    })]);

    const explicitHidden = JSON.parse(await withDbAccessContext(context, () =>
      historyHandler()({ deviceId: hidden.id, limit: 10 }, selected)));
    expect(explicitHidden).toEqual({ executions: [], count: 0 });

    // Visibility follows the current device site in the same SQL statement.
    await getTestDb().update(devices).set({ siteId: hiddenSite.id }).where(eq(devices.id, visible.id));
    const moved = JSON.parse(await withDbAccessContext(context, () =>
      historyHandler()({ limit: 10 }, selected)));
    expect(moved).toEqual({ executions: [], count: 0 });

    // Undefined preserves same-org all-sites history while FORCE RLS excludes
    // the newer execution belonging to the other organization.
    const unrestricted = JSON.parse(await withDbAccessContext(context, () =>
      historyHandler()({ limit: 10 }, authFor(org.id))));
    expect(unrestricted.count).toBe(2);
    expect(unrestricted.executions.map((entry: { deviceHostname: string }) => entry.deviceHostname).sort())
      .toEqual(['hidden-host', 'visible-host']);
  });
});
