/**
 * #8053 W1a-1 — the heartbeat's materialization-off skip returns exactly what
 * the real negotiation returns with materialization off, against real
 * PostgreSQL, including the ephemeral / suspended refusal.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withDbTransaction, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { withResolvedTopologyFlags, resolveTopologyFlags } from '../../services/topology/flags';
import { topologyHeartbeat, topologyHeartbeatWithoutMaterialization } from '../../services/topology/heartbeat';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const OFF = resolveTopologyFlags({});

async function seedDevice(over: Partial<{ isEphemeral: boolean; agentTokenSuspendedAt: Date | null; agentTokenHash: string | null }>) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const unique = randomUUID().slice(0, 8);
    const [row] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `topo-off-${unique}`, hostname: `topo-off-${unique}`,
      osType: 'linux', osVersion: '22.04', architecture: 'amd64', agentVersion: '0.0.0-test', status: 'online',
      agentTokenHash: 'b'.repeat(64), ...over,
    }).returning();
    return row!;
  });
}

async function negotiated(device: typeof devices.$inferSelect, input: Record<string, unknown>) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    withResolvedTopologyFlags({ orgId: device.orgId, flags: OFF }, () =>
      withDbTransaction(() => topologyHeartbeat(device, input))));
}

describe('topology heartbeat with materialization off (#8053 W1a-1) — real PostgreSQL', () => {
  for (const [name, input] of [
    ['no report', {}],
    ['an unsupported report version', { networkContextV1: { version: 99, sequence: '5' } }],
    ['an invalid report', { networkContextV1: { version: 1, sequence: '6', junk: true } }],
  ] as const) {
    runDb(`a live device: same config and receipt for ${name}`, async () => {
      const device = await seedDevice({});
      const [fresh] = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(devices).where(eq(devices.id, device.id)));
      expect(topologyHeartbeatWithoutMaterialization(fresh!, input)).toEqual(await negotiated(fresh!, input));
    });
  }

  for (const [name, over] of [
    ['an ephemeral (Quick Support) device', { isEphemeral: true }],
    ['a token-suspended device', { agentTokenSuspendedAt: new Date() }],
    ['a tokenless device', { agentTokenHash: null }],
  ] as const) {
    runDb(`${name}: both paths refuse with producer_unavailable`, async () => {
      const device = await seedDevice(over);
      await expect(negotiated(device, {})).rejects.toThrow('producer_unavailable');
      expect(() => topologyHeartbeatWithoutMaterialization(device, {})).toThrow('producer_unavailable');
    });
  }
});
