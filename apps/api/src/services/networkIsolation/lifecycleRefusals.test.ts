import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../../jobs/deviceGroupJobs', () => ({ requestDeviceGroupReevaluationAfterCommit: vi.fn() }));
vi.mock('../commandCancelPropagation', () => ({ propagateCancelledDeviceCommands: vi.fn() }));
vi.mock('../deviceUninstallDrain', () => ({ queueDeviceUninstall: vi.fn() }));
vi.mock('../sentry', () => ({ captureMessage: vi.fn() }));
vi.mock('../fixMemory/store', () => ({ deleteDeviceFixOutcomes: vi.fn(async () => ({ deleted: 0, identitiesMarked: 0 })) }));
vi.mock('../hardwareHealth/retire', () => ({ resolveAlertsForRemovedComponents: vi.fn() }));
vi.mock('../siteOwnedAlerts', () => ({ detachOriginDeviceTopologyAlerts: vi.fn(async () => 0) }));
vi.mock('../../routes/devices/core', () => ({
  DEVICE_CASCADE_DELETE_PREDICATES: new Map(), DEVICE_DETACH_DEVICE_ID_TABLES: [],
  DEVICE_LINKED_DEVICE_ID_TABLES: [], DEVICE_LINK_DEPENDENT_COLUMNS: [], getDeviceCascadeDeleteTables: () => [],
}));

import { decommissionDeviceInTransaction } from '../deviceDecommission';
import { deleteDeviceCascade } from '../deviceDeletion';
import { queueDeviceUninstall } from '../deviceUninstallDrain';

const deviceId = '11111111-1111-4111-8111-111111111111';
const isolationId = '22222222-2222-4222-8222-222222222222';
const orgId = '33333333-3333-4333-8333-333333333333';
const dialect = new PgDialect();

function transaction(isolations: unknown[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const chain = () => {
    const rows = Promise.resolve([]);
    return {
      set: () => ({ where: () => ({ returning: () => rows, then: rows.then.bind(rows) }) }),
      from: () => ({ where: () => rows }),
    };
  };
  const tx = {
    execute: vi.fn(async (query: SQL) => {
      const compiled = dialect.sqlToQuery(query);
      queries.push(compiled);
      if (compiled.sql.includes('FROM device_network_isolations')) return isolations;
      if (compiled.sql.includes('pg_settings')) return [{ prior_ms: '7000' }];
      if (compiled.sql.includes('FOR UPDATE')) return Object.assign([{ id: deviceId }], { count: 1 });
      return [];
    }),
    update: vi.fn(chain),
    select: vi.fn(chain),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  };
  return { tx, queries };
}

describe('network isolation lifecycle refusals', () => {
  beforeEach(() => vi.clearAllMocks());
  it('refuses decommission before changing status, cancelling work, or queuing uninstall', async () => {
    const { tx } = transaction([{ isolationId, deviceId }]);
    await expect(decommissionDeviceInTransaction(tx as never, {
      deviceId, queueUninstall: true, actorUserId: null,
    })).rejects.toMatchObject({ code: 'isolation_unresolved', message: 'Release network isolation first' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(queueDeviceUninstall).not.toHaveBeenCalled();
  });

  it.each([{ deviceId }, { deviceIds: [deviceId] }, { orgId }])('queries unresolved episodes within %j', async scope => {
    const { findUnresolvedIsolations } = await import('./lifecycle');
    const { tx, queries } = transaction([{ isolationId, deviceId }]);
    expect(await findUnresolvedIsolations(tx, scope)).toEqual([{ isolationId, deviceId }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/not in/i);
    expect(queries[0]!.params).toEqual(expect.arrayContaining(['released', 'expired', 'failed', 'uninstalled']));
    expect(queries[0]!.params).not.toContain('released_locally');
    expect(queries[0]!.params).not.toContain('self_released');
    expect(queries[0]!.params).not.toContain('release_requested');
    expect(queries[0]!.params).toContain('orgId' in scope ? orgId : deviceId);
  });

  it('returns a typed refusal containing the offending episode and device', async () => {
    const { assertNoUnresolvedIsolation, NetworkIsolationUnresolvedError } = await import('./lifecycle');
    const { tx } = transaction([{ isolationId, deviceId }]);
    const result = assertNoUnresolvedIsolation(tx, { deviceId }, 'decommission');
    await expect(result).rejects.toBeInstanceOf(NetworkIsolationUnresolvedError);
    await expect(result).rejects.toMatchObject({
      code: 'isolation_unresolved', message: 'Release network isolation first',
      isolations: [{ isolationId, deviceId }], action: 'decommission',
    });
  });

  it('allows operations once no unresolved episode remains', async () => {
    const { assertNoUnresolvedIsolation } = await import('./lifecycle');
    const { tx } = transaction([]);
    await expect(assertNoUnresolvedIsolation(tx, { deviceId }, 'decommission')).resolves.toBeUndefined();
  });

  it('credential suspension refuses unresolved isolation for future operator reasons and proceeds after resolution', async () => {
    const { isolationBlocksTokenSuspension, AGENT_TOKEN_SUSPEND_REASON } = await import('../agentTokenSuspension');
    const { assertNoUnresolvedIsolation } = await import('./lifecycle');
    expect(isolationBlocksTokenSuspension('operator_requested' as typeof AGENT_TOKEN_SUSPEND_REASON.crossTenantProbe)).toBe(true);
    const unresolved = transaction([{ isolationId, deviceId }]);
    await expect(assertNoUnresolvedIsolation(unresolved.tx, { deviceId }, 'suspend_agent_token'))
      .rejects.toMatchObject({ code: 'isolation_unresolved', action: 'suspend_agent_token' });
    const resolved = transaction([]);
    await expect(assertNoUnresolvedIsolation(resolved.tx, { deviceId }, 'suspend_agent_token')).resolves.toBeUndefined();
    expect(isolationBlocksTokenSuspension(AGENT_TOKEN_SUSPEND_REASON.crossTenantProbe)).toBe(false);
    expect(isolationBlocksTokenSuspension(AGENT_TOKEN_SUSPEND_REASON.tenantSuspended)).toBe(false);
  });

  it('does not turn an empty device batch into an unscoped query', async () => {
    const { findUnresolvedIsolations, assertNoUnresolvedIsolation } = await import('./lifecycle');
    const { tx } = transaction([{ isolationId, deviceId }]);
    expect(await findUnresolvedIsolations(tx, { deviceIds: [] })).toEqual([]);
    await assertNoUnresolvedIsolation(tx, { deviceIds: [] }, 'suspend');
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it.each(['requested', 'dispatched', 'applying', 'applied', 'verified', 'release_requested', 'released_locally', 'self_released'])(
    'refuses decommission and permanent deletion for unresolved %s', async state => {
      for (const operation of ['decommission', 'delete']) {
        const { tx } = transaction([{ isolationId, deviceId, state }]);
        const result = operation === 'delete'
          ? deleteDeviceCascade(tx, deviceId)
          : decommissionDeviceInTransaction(tx as never, { deviceId, queueUninstall: false, actorUserId: null });
        await expect(result).rejects.toMatchObject({ code: 'isolation_unresolved' });
        expect(tx.update).not.toHaveBeenCalled();
        expect(tx.delete).not.toHaveBeenCalled();
      }
    },
  );

  it('allows decommission and deletion after release or acknowledgement removes the unresolved row', async () => {
    const decommission = transaction([]);
    await expect(decommissionDeviceInTransaction(decommission.tx as never, {
      deviceId, queueUninstall: false, actorUserId: null,
    })).resolves.toMatchObject({ uninstallQueued: false });
    expect(decommission.tx.update).toHaveBeenCalled();
    const deletion = transaction([]);
    await expect(deleteDeviceCascade(deletion.tx, deviceId)).resolves.toEqual({ detachedTopologyAlerts: 0 });
    expect(deletion.tx.delete).toHaveBeenCalled();
  });

  it('locks the device before reading episodes so a concurrent start cannot pass the guard', async () => {
    const { assertNoUnresolvedIsolation } = await import('./lifecycle');
    const { tx, queries } = transaction([]);
    await assertNoUnresolvedIsolation(tx, { deviceId }, 'decommission');
    expect(queries[0]!.sql).toMatch(/FROM devices.*FOR NO KEY UPDATE/);
    expect(queries[1]!.sql).toContain('FROM device_network_isolations');
  });

  it('fails closed when the episode lookup fails', async () => {
    const { tx } = transaction([]);
    tx.execute.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(decommissionDeviceInTransaction(tx as never, {
      deviceId, queueUninstall: false, actorUserId: null,
    })).rejects.toThrow('database unavailable');
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('never treats a malformed query response as no isolation', async () => {
    const { findUnresolvedIsolations } = await import('./lifecycle');
    const tx = { execute: vi.fn(async () => ({ unexpected: true })) };
    await expect(findUnresolvedIsolations(tx, { deviceId })).rejects.toThrow('Invalid network isolation query result');
  });

  it('can read under an existing lock or database move guard without reversing lock order', async () => {
    const { assertNoUnresolvedIsolation } = await import('./lifecycle');
    const { tx, queries } = transaction([{ isolationId, deviceId }]);
    await expect(assertNoUnresolvedIsolation(tx, { deviceId }, 'move', { lockDevices: false }))
      .rejects.toMatchObject({ code: 'isolation_unresolved' });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('FROM device_network_isolations');
  });
});

function incidentDeletionIsGuarded(source: string): boolean {
  return !/\.delete\s*\(/.test(source) || /\bassertNoUnresolvedIsolation\b/.test(source);
}

describe('incident deletion isolation contract', () => {
  it('requires an isolation assertion if an incident delete route is introduced', () => {
    const source = readFileSync(new URL('../../routes/incidents.ts', import.meta.url), 'utf8');
    expect(incidentDeletionIsGuarded(source)).toBe(true);
  });

  it('distinguishes an unguarded delete, a guarded delete, and no delete', () => {
    expect(incidentDeletionIsGuarded("routes.delete('/:id', handler)")).toBe(false);
    expect(incidentDeletionIsGuarded("routes.delete('/:id', async () => assertNoUnresolvedIsolation(tx, scope, 'delete'))")).toBe(true);
    expect(incidentDeletionIsGuarded("routes.get('/:id', handler)")).toBe(true);
  });
});
