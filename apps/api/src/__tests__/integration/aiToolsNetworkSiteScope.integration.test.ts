import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext } from '../../db';
import {
  deviceIpHistory,
  devices,
  networkBaselines,
  networkChangeEvents,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { registerNetworkTools } from '../../services/aiToolsNetwork';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

function handlers(): Map<string, AiTool> {
  const tools = new Map<string, AiTool>();
  registerNetworkTools(tools);
  return tools;
}

function authFor(orgId: string, allowedSiteIds: string[]): AuthContext {
  return {
    principal: { kind: 'api_key', apiKeyId: randomUUID() },
    user: { id: randomUUID(), email: 'operator@example.test', name: 'Operator', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (column) => eq(column, orgId),
    canAccessOrg: (candidate) => candidate === orgId,
    allowedSiteIds,
    canAccessSite: (siteId) => !!siteId && allowedSiteIds.includes(siteId),
  };
}

async function invoke(tool: AiTool, input: Record<string, unknown>, auth: AuthContext) {
  return withDbAccessContext(
    { scope: 'organization', orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds },
    () => tool.handler(input, auth),
  );
}

describe('network AI/MCP site scope against real PostgreSQL as breeze_app', () => {
  it('returns and mutates only the allowed site while RLS also excludes a foreign org', async () => {
    const seed = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const foreignOrg = await createOrganization({ partnerId: partner.id });
    const allowedSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id });

    const [allowedDevice, hiddenDevice, foreignDevice] = await seed.insert(devices).values([
      { orgId: org.id, siteId: allowedSite.id, agentId: `agent-${randomUUID()}`, hostname: 'allowed-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online' },
      { orgId: org.id, siteId: hiddenSite.id, agentId: `agent-${randomUUID()}`, hostname: 'hidden-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online' },
      { orgId: foreignOrg.id, siteId: foreignSite.id, agentId: `agent-${randomUUID()}`, hostname: 'foreign-host', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online' },
    ]).returning();

    const [allowedBaseline, hiddenBaseline, foreignBaseline] = await seed.insert(networkBaselines).values([
      { orgId: org.id, siteId: allowedSite.id, subnet: '192.0.2.0/24' },
      { orgId: org.id, siteId: hiddenSite.id, subnet: '198.51.100.0/24' },
      { orgId: foreignOrg.id, siteId: foreignSite.id, subnet: '203.0.113.0/24' },
    ]).returning();

    const [allowedEvent, hiddenEvent] = await seed.insert(networkChangeEvents).values([
      { orgId: org.id, siteId: allowedSite.id, baselineId: allowedBaseline!.id, eventType: 'new_device', ipAddress: '192.0.2.10', hostname: 'allowed-event' },
      { orgId: org.id, siteId: hiddenSite.id, baselineId: hiddenBaseline!.id, eventType: 'new_device', ipAddress: '192.0.2.20', hostname: 'hidden-event' },
      { orgId: foreignOrg.id, siteId: foreignSite.id, baselineId: foreignBaseline!.id, eventType: 'new_device', ipAddress: '192.0.2.30', hostname: 'foreign-event' },
    ]).returning();

    const firstSeen = new Date('2026-01-01T00:00:00.000Z');
    const lastSeen = new Date('2026-12-31T00:00:00.000Z');
    await seed.insert(deviceIpHistory).values([
      { deviceId: allowedDevice!.id, orgId: org.id, interfaceName: 'eth0', ipAddress: '192.0.2.99', firstSeen, lastSeen },
      { deviceId: hiddenDevice!.id, orgId: org.id, interfaceName: 'eth0', ipAddress: '192.0.2.99', firstSeen, lastSeen },
      { deviceId: foreignDevice!.id, orgId: foreignOrg.id, interfaceName: 'eth0', ipAddress: '192.0.2.99', firstSeen, lastSeen },
    ]);

    const auth = authFor(org.id, [allowedSite.id]);
    const tools = handlers();

    const changes = JSON.parse(await invoke(tools.get('get_network_changes')!, {}, auth));
    expect(changes.events.map((row: { hostname: string }) => row.hostname)).toEqual(['allowed-event']);

    const reverse = JSON.parse(await invoke(tools.get('get_ip_history')!, {
      ip_address: '192.0.2.99', at_time: '2026-06-01T00:00:00.000Z',
    }, auth));
    expect(reverse.results.map((row: { device: { hostname: string } }) => row.device.hostname)).toEqual(['allowed-host']);

    const ack = JSON.parse(await invoke(tools.get('acknowledge_network_device')!, {
      event_id: hiddenEvent!.id,
    }, auth));
    expect(ack.error).toMatch(/not found|access denied/i);

    const update = JSON.parse(await invoke(tools.get('configure_network_baseline')!, {
      baseline_id: hiddenBaseline!.id, scan_interval_hours: 1,
    }, auth));
    expect(update.error).toMatch(/not found|access denied/i);

    const create = JSON.parse(await invoke(tools.get('configure_network_baseline')!, {
      org_id: org.id, site_id: hiddenSite.id, subnet: '198.18.0.0/24',
    }, auth));
    expect(create.error).toMatch(/not found|access denied/i);

    const [persistedHiddenEvent] = await seed.select().from(networkChangeEvents)
      .where(eq(networkChangeEvents.id, hiddenEvent!.id)).limit(1);
    const [persistedHiddenBaseline] = await seed.select().from(networkBaselines)
      .where(eq(networkBaselines.id, hiddenBaseline!.id)).limit(1);
    expect(persistedHiddenEvent?.acknowledged).toBe(false);
    expect((persistedHiddenBaseline?.scanSchedule as { intervalHours?: number } | null)?.intervalHours).not.toBe(1);
    expect(allowedEvent).toBeDefined();
  });
});
