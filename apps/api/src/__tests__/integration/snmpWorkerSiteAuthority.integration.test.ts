/**
 * Real-PostgreSQL proof that asset-bound SNMP polls select an executor from the
 * asset's current site. Agent connectivity and dispatch are synthetic; no
 * command leaves this process and no SNMP credential reaches a real endpoint.
 */
import './setup';

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { relayMock, decryptMock } = vi.hoisted(() => ({
  relayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn(async () => ({ status: 'sent' as const, via: 'local' as const })),
  },
  decryptMock: vi.fn((value: string | null) => value),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));

vi.mock('../../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: relayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: relayMock.dispatchCommandToAgent,
}));

vi.mock('../../services/snmpSecrets', () => ({ decryptSnmpSecret: decryptMock }));
vi.mock('../../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));
vi.mock('../../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { devices, discoveredAssets, snmpDevices, snmpTemplates } from '../../db/schema';
import { __testables, shutdownSnmpWorker } from '../../jobs/snmpWorker';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const { processPollDevice } = __testables;

let fixture: Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
  const adminDb = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const originalSite = await createSite({ orgId: org.id });
  const currentSite = await createSite({ orgId: org.id });
  const noAgentSite = await createSite({ orgId: org.id });

  const originalAgentId = `snmp-original-${randomUUID()}`;
  const currentAgentId = `snmp-current-${randomUUID()}`;
  await adminDb.insert(devices).values([
    {
      orgId: org.id,
      siteId: originalSite.id,
      agentId: originalAgentId,
      hostname: 'original-site-agent',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online',
      isEphemeral: false,
    },
    {
      orgId: org.id,
      siteId: currentSite.id,
      agentId: currentAgentId,
      hostname: 'current-site-agent',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online',
      isEphemeral: false,
    },
  ]);

  const [asset] = await adminDb.insert(discoveredAssets).values({
    orgId: org.id,
    siteId: currentSite.id,
    ipAddress: '192.0.2.114',
    hostname: 'current-site-switch',
    approvalStatus: 'approved',
  }).returning();
  const [template] = await adminDb.insert(snmpTemplates).values({
    orgId: org.id,
    name: 'Synthetic uptime',
    oids: [{ oid: '1.3.6.1.2.1.1.3.0' }],
  }).returning();
  const [snmp] = await adminDb.insert(snmpDevices).values({
    orgId: org.id,
    assetId: asset.id,
    name: 'Synthetic switch',
    ipAddress: '192.0.2.114',
    snmpVersion: 'v2c',
    community: 'synthetic-encrypted-community',
    templateId: template.id,
    isActive: true,
  }).returning();

  return { adminDb, org, asset, snmp, originalSite, currentSite, noAgentSite, originalAgentId, currentAgentId };
}

beforeEach(async () => {
  vi.clearAllMocks();
  relayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
  relayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  fixture = await seedFixture();
});

afterEach(async () => {
  await shutdownSnmpWorker();
});

describe('SNMP worker current-site executor authority as breeze_app', () => {
  it('follows a moved asset to its current site and fails closed when that site has no agent', async () => {
    const dispatched = await processPollDevice({
      type: 'poll-device',
      deviceId: fixture.snmp.id,
      orgId: fixture.org.id,
    });
    expect(dispatched).toEqual({ dispatched: true, agentId: fixture.currentAgentId });
    expect(relayMock.dispatchCommandToAgent).toHaveBeenCalledWith(
      fixture.currentAgentId,
      expect.objectContaining({ type: 'snmp_poll' }),
      { priority: 'probe' },
    );
    expect(relayMock.dispatchCommandToAgent).not.toHaveBeenCalledWith(
      fixture.originalAgentId,
      expect.anything(),
      expect.anything(),
    );

    relayMock.dispatchCommandToAgent.mockClear();
    decryptMock.mockClear();
    await fixture.adminDb.update(discoveredAssets)
      .set({ siteId: fixture.noAgentSite.id })
      .where(eq(discoveredAssets.id, fixture.asset.id));

    const denied = await processPollDevice({
      type: 'poll-device',
      deviceId: fixture.snmp.id,
      orgId: fixture.org.id,
    });
    expect(denied).toEqual({ dispatched: false, agentId: null });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(relayMock.dispatchCommandToAgent).not.toHaveBeenCalled();

    const [attempted] = await fixture.adminDb.select({ lastPollAttemptedAt: snmpDevices.lastPollAttemptedAt })
      .from(snmpDevices)
      .where(eq(snmpDevices.id, fixture.snmp.id));
    expect(attempted?.lastPollAttemptedAt).toBeInstanceOf(Date);
  });
});
