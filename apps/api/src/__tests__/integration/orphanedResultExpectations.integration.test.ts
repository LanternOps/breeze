/**
 * Real-Redis coverage for #4135: the dispatch records that authorize orphaned
 * command results (SNMP polls, monitor checks, probes) are shared by every API
 * replica, so a result that reaches a replica other than the one that sent the
 * command is still honored, and only once.
 *
 * Two logical replicas run in this one process. Replica A is the module graph
 * this file imports statically: the real agentWs send path plus the store. A
 * fresh module graph (vi.resetModules) stands in for replica B: its own store
 * state and its own Redis client, pointed at the same Redis. The mocked unit
 * suite (services/orphanedResultExpectations.test.ts) cannot prove the real
 * SET PX / GETDEL / PTTL behaviour; this one does.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/orphanedResultExpectations.integration.test.ts
 */
import './setup';

import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeRedis, getRedis } from '../../services/redis';
import {
  ORPHANED_RESULT_EXPECTATION_TTL_MS,
  consumeOrphanedResultExpectation,
  orphanedResultExpectationKey,
  peekOrphanedResultExpectation,
  recordOrphanedResultExpectation,
} from '../../services/orphanedResultExpectations';
import { __installAgentSocketForTest, sendCommandToAgent } from '../../routes/agentWs';

type StoreModule = typeof import('../../services/orphanedResultExpectations');
type RedisModule = typeof import('../../services/redis');

// Namespaced per run so a shard sharing this Redis cannot collide (#3066).
const RUN = randomUUID().slice(0, 8);
const agentId = (label: string) => `agent-ore-${RUN}-${label}`;

let replicaB: StoreModule;
let replicaBRedis: RedisModule;

beforeAll(async () => {
  vi.resetModules();
  replicaB = await import('../../services/orphanedResultExpectations');
  replicaBRedis = await import('../../services/redis');
  // Two separate clients: one per replica.
  expect(replicaBRedis.getRedis()).not.toBe(getRedis());
});

afterAll(async () => {
  await replicaBRedis.closeRedis();
  await closeRedis();
});

describe('orphaned result expectations across replicas — real Redis (#4135)', () => {
  it('a record made on one replica is consumed on another, once, with the expectation TTL', async () => {
    const snmpAgent = agentId('snmp');
    const probeAgent = agentId('probe');
    const snmpCommand = `snmp-${randomUUID()}`;
    const probeCommand = `probe-${randomUUID()}`;
    const expiresAt = Date.now() + ORPHANED_RESULT_EXPECTATION_TTL_MS;

    // Two logical registrations on replica A.
    await recordOrphanedResultExpectation(snmpCommand, {
      agentId: snmpAgent, kind: 'snmp', targetId: 'snmp-device-1', expiresAt,
    });
    await recordOrphanedResultExpectation(probeCommand, {
      agentId: probeAgent, kind: 'probe', targetId: 'asset-1', ipAddress: '192.0.2.10', siteId: 'site-1', expiresAt,
    });

    const redis = getRedis()!;
    const pttl = await redis.pttl(orphanedResultExpectationKey(snmpAgent, snmpCommand));
    expect(pttl).toBeGreaterThan(ORPHANED_RESULT_EXPECTATION_TTL_MS - 60_000);
    expect(pttl).toBeLessThanOrEqual(ORPHANED_RESULT_EXPECTATION_TTL_MS);

    // Replica B: another agent cannot take the record, and a peek leaves it.
    await expect(replicaB.consumeOrphanedResultExpectation(probeAgent, snmpCommand)).resolves.toBeNull();
    await expect(replicaB.peekOrphanedResultExpectation(snmpAgent, snmpCommand))
      .resolves.toMatchObject({ kind: 'snmp', targetId: 'snmp-device-1' });

    await expect(replicaB.consumeOrphanedResultExpectation(snmpAgent, snmpCommand))
      .resolves.toMatchObject({ agentId: snmpAgent, kind: 'snmp', targetId: 'snmp-device-1' });
    await expect(replicaB.consumeOrphanedResultExpectation(probeAgent, probeCommand))
      .resolves.toMatchObject({ agentId: probeAgent, kind: 'probe', ipAddress: '192.0.2.10', siteId: 'site-1' });

    // Single use on every replica.
    await expect(replicaB.consumeOrphanedResultExpectation(snmpAgent, snmpCommand)).resolves.toBeNull();
    await expect(consumeOrphanedResultExpectation(snmpAgent, snmpCommand)).resolves.toBeNull();
    await expect(peekOrphanedResultExpectation(probeAgent, probeCommand)).resolves.toBeNull();
  });

  it('two replicas consuming the same record at once: exactly one gets it', async () => {
    const id = agentId('race');
    const commandIds = Array.from({ length: 20 }, () => `snmp-${randomUUID()}`);
    const expiresAt = Date.now() + ORPHANED_RESULT_EXPECTATION_TTL_MS;
    await Promise.all(commandIds.map((commandId) =>
      recordOrphanedResultExpectation(commandId, { agentId: id, kind: 'snmp', targetId: 'snmp-device-2', expiresAt })));

    for (const commandId of commandIds) {
      const outcomes = await Promise.all([
        consumeOrphanedResultExpectation(id, commandId),
        replicaB.consumeOrphanedResultExpectation(id, commandId),
      ]);
      expect(outcomes.filter((outcome) => outcome !== null), commandId).toHaveLength(1);
    }
  });

  it('the agent socket send path records into Redis for the other replica to honor', async () => {
    const id = agentId('send');
    const frames: string[] = [];
    __installAgentSocketForTest(id, { send: (data: string) => frames.push(data) });
    const commandId = randomUUID();

    expect(sendCommandToAgent(id, {
      id: commandId, type: 'network_ping', payload: { monitorId: 'monitor-1', target: '192.0.2.20' },
    })).toBe(true);
    expect(frames).toHaveLength(1);

    const key = orphanedResultExpectationKey(id, commandId);
    await vi.waitFor(async () => expect(await getRedis()!.exists(key)).toBe(1), { timeout: 5_000 });

    await expect(replicaB.consumeOrphanedResultExpectation(id, commandId))
      .resolves.toMatchObject({ agentId: id, kind: 'monitor', targetId: 'monitor-1' });
    expect(await getRedis()!.exists(key)).toBe(0);
  });
});
