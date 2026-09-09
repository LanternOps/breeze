/** Real-PostgreSQL proof for the automation/script history site boundary. */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext } from '../../db';
import {
  automationRunDeviceResults,
  automationRuns,
  automations,
  devices,
  scriptExecutions,
  scripts,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { registerScriptTools } from '../../services/aiToolsScripts';
import { projectAutomationRunsToSites } from '../../services/automationReadProjection';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

function scriptHistory(): AiTool['handler'] {
  const tools = new Map<string, AiTool>();
  registerScriptTools(tools);
  return tools.get('get_script_execution_history')!.handler;
}

describe('automation history site projection as breeze_app', () => {
  it('keeps allowed output and removes sibling-site output, counts, and logs', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const foreignOrg = await createOrganization({ partnerId: partner.id });
    const allowedSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id });
    const testDb = getTestDb();
    const [allowedDevice, hiddenDevice, foreignDevice] = await testDb.insert(devices).values([
      {
        orgId: org.id, siteId: allowedSite.id, agentId: `agent-${randomUUID()}`,
        hostname: 'allowed-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
      },
      {
        orgId: org.id, siteId: hiddenSite.id, agentId: `agent-${randomUUID()}`,
        hostname: 'hidden-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
      },
      {
        orgId: foreignOrg.id, siteId: foreignSite.id, agentId: `agent-${randomUUID()}`,
        hostname: 'foreign-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
      },
    ]).returning();
    const [automation] = await testDb.insert(automations).values({
      orgId: org.id,
      name: 'Site projection fixture',
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [allowedDevice!.id, hiddenDevice!.id] },
      actions: [],
    }).returning();
    const [run] = await testDb.insert(automationRuns).values({
      automationId: automation!.id,
      triggeredBy: 'integration',
      status: 'failed',
      devicesTargeted: 2,
      devicesSucceeded: 1,
      devicesFailed: 1,
      logs: [
        { level: 'info', message: 'allowed-log', deviceId: allowedDevice!.id },
        { level: 'error', message: 'hidden-log', deviceId: hiddenDevice!.id },
      ],
    }).returning();
    await testDb.insert(automationRunDeviceResults).values([
      {
        runId: run!.id, deviceId: allowedDevice!.id, orgId: org.id, status: 'success', output: 'allowed-output',
        startedAt: new Date('2026-09-05T00:00:10Z'), completedAt: new Date('2026-09-05T00:00:20Z'),
      },
      {
        runId: run!.id, deviceId: hiddenDevice!.id, orgId: org.id, status: 'failed', output: 'hidden-output',
        startedAt: new Date('2026-09-05T00:00:11Z'), completedAt: new Date('2026-09-05T00:05:00Z'),
      },
    ]);
    const [script] = await testDb.insert(scripts).values({
      orgId: org.id, name: 'History fixture', osTypes: ['linux'], language: 'bash', content: 'exit 0',
    }).returning();
    const [foreignScript] = await testDb.insert(scripts).values({
      orgId: foreignOrg.id, name: 'Foreign history fixture', osTypes: ['linux'], language: 'bash', content: 'exit 0',
    }).returning();
    await testDb.insert(scriptExecutions).values([
      { scriptId: script!.id, deviceId: allowedDevice!.id, orgId: org.id, status: 'completed', stdout: 'allowed-stdout' },
      { scriptId: script!.id, deviceId: hiddenDevice!.id, orgId: org.id, status: 'completed', stdout: 'hidden-stdout' },
      { scriptId: foreignScript!.id, deviceId: foreignDevice!.id, orgId: foreignOrg.id, status: 'completed', stdout: 'foreign-stdout' },
    ]);

    const context = { scope: 'organization' as const, orgId: org.id, accessibleOrgIds: [org.id] };
    await withDbAccessContext(context, async () => {
      const projected = await projectAutomationRunsToSites([run!], [allowedSite.id]);
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({
        devicesTargeted: 1, devicesSucceeded: 1, devicesFailed: 0, status: 'completed',
        startedAt: new Date('2026-09-05T00:00:10Z'),
        completedAt: new Date('2026-09-05T00:00:20Z'),
      });
      expect(JSON.stringify(projected)).toContain('allowed-log');
      expect(JSON.stringify(projected)).not.toContain('hidden-log');

      const auth = {
        user: { id: randomUUID(), email: 'op@example.test', name: 'Op', isPlatformAdmin: false },
        token: {}, partnerId: null, orgId: org.id, scope: 'organization', accessibleOrgIds: [org.id],
        allowedSiteIds: [allowedSite.id],
        orgCondition: () => undefined,
        canAccessOrg: (id: string) => id === org.id,
        canAccessSite: (id: string | null | undefined) => id === allowedSite.id,
      } as unknown as AuthContext;
      const history = JSON.parse(await scriptHistory()({ scriptId: script!.id, limit: 10 }, auth));
      expect(history.count).toBe(1);
      expect(JSON.stringify(history)).toContain('allowed-stdout');
      expect(JSON.stringify(history)).not.toContain('hidden-stdout');
      expect(JSON.stringify(history)).not.toContain(hiddenDevice!.id);
      const foreignHistory = JSON.parse(await scriptHistory()({ scriptId: foreignScript!.id, limit: 10 }, auth));
      expect(foreignHistory).toEqual({ error: 'Script not found' });
      expect(JSON.stringify(foreignHistory)).not.toContain('foreign-stdout');
    });
  });
});
