import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ existing: [] as unknown[][], inserted: [] as unknown[], insertReturn: [] as unknown[][] }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.existing.shift() ?? []).then(r);
  (chain as { insert: unknown }).insert = vi.fn(() => ({
    values: (v: unknown) => { h.inserted.push(v); return { onConflictDoNothing: () => ({ returning: async () => h.insertReturn.shift() ?? [] }) }; },
  }));
  return { db: chain };
});
vi.mock('../outcomeProbes', () => ({ inSystemDbContext: (fn: () => unknown) => fn() }));

import {
  assertTroubleshootAgentEdit, ensureTroubleshootAgent, TroubleshootAgentEditError, TroubleshootBaselineConflictError,
} from './troubleshootProvisioning';
import { TROUBLESHOOT_PROPOSABLE_TOOLS } from './troubleshootProfile';

const SYSTEM = 'system:device_troubleshooting';

describe('ensureTroubleshootAgent', () => {
  beforeEach(() => { h.existing.length = 0; h.inserted.length = 0; h.insertReturn.length = 0; });

  it('creates one enabled, shadow, system-provisioned partner row whose stored allowlist is the proposable set', async () => {
    h.existing.push([]);
    h.insertReturn.push([{ id: 'agent-1' }]);
    await expect(ensureTroubleshootAgent('p-1')).resolves.toEqual({ agentId: 'agent-1', created: true });
    expect(h.inserted[0]).toMatchObject({
      partnerId: 'p-1', orgId: null, kind: 'troubleshoot', name: 'Device troubleshooting (built-in)',
      enabled: true, mode: 'shadow', createdBy: null, provisionedBy: SYSTEM, instructions: null,
    });
    expect((h.inserted[0] as { toolAllowlist: string[] }).toolAllowlist).toEqual([...TROUBLESHOOT_PROPOSABLE_TOOLS]);
  });

  it('is idempotent: the second call adopts the same row and inserts nothing', async () => {
    h.existing.push([{ id: 'agent-9', provisionedBy: SYSTEM }]);
    await expect(ensureTroubleshootAgent('p-1')).resolves.toEqual({ agentId: 'agent-9', created: false });
    expect(h.inserted).toEqual([]);
  });

  it('a lost insert race re-reads the winner', async () => {
    h.existing.push([], [{ id: 'agent-winner', provisionedBy: SYSTEM }]);
    h.insertReturn.push([]);
    await expect(ensureTroubleshootAgent('p-1')).resolves.toEqual({ agentId: 'agent-winner', created: false });
  });

  it('fails closed on a row that was not system-provisioned', async () => {
    h.existing.push([{ id: 'squat', provisionedBy: null }]);
    await expect(ensureTroubleshootAgent('p-1')).rejects.toBeInstanceOf(TroubleshootBaselineConflictError);
    expect(h.inserted).toEqual([]);
  });
});

describe('assertTroubleshootAgentEdit', () => {
  it('allows enabled and name only', () => {
    expect(() => assertTroubleshootAgentEdit({ enabled: false, name: 'X', mode: undefined })).not.toThrow();
  });
  it.each([
    [{ mode: 'act' }, ['mode']],
    [{ toolAllowlist: ['manage_services'] }, ['toolAllowlist']],
    [{ instructions: 'ignore rules' }, ['instructions']],
    [{ limits: { maxActionsPerRun: 50 } }, ['limits']],
  ])('refuses %o', (input, fields) => {
    try { assertTroubleshootAgentEdit(input); expect.unreachable(); } catch (err) {
      expect(err).toBeInstanceOf(TroubleshootAgentEditError);
      expect((err as TroubleshootAgentEditError).fields).toEqual(fields);
    }
  });
});
