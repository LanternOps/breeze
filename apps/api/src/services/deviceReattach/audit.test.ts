import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAuditLogAsyncMock = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
vi.mock('../auditService', () => ({
  createAuditLogAsync: (params: unknown) => createAuditLogAsyncMock(params),
}));
vi.mock('../auditEvents', () => ({ ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000' }));

import { writeReattachAudit } from './audit';

const base = {
  action: 'device.reinstall.reattached' as const,
  actorUserId: '00000000-0000-4000-8000-0000000000u1',
  targetOrgId: '00000000-0000-4000-8000-0000000000o1',
  sourceOrgId: '00000000-0000-4000-8000-0000000000o2',
  targetDeviceId: '00000000-0000-4000-8000-0000000000d1',
  details: { intentId: 'i-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  createAuditLogAsyncMock.mockImplementation(async () => undefined);
});

describe('writeReattachAudit (#8318, review finding 13)', () => {
  it('writes one durable row per org (target and source), through the retrying writer', async () => {
    await writeReattachAudit(base);
    expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(2);
    const rows = createAuditLogAsyncMock.mock.calls.map((call) => call[0] as Record<string, any>);
    expect(rows.map((r) => r.orgId).sort()).toEqual([base.targetOrgId, base.sourceOrgId].sort());
    expect(rows.find((r) => r.orgId === base.targetOrgId)!.details.auditOrgRole).toBe('target');
    expect(rows.every((r) => r.actorId === base.actorUserId && r.actorType === 'user')).toBe(true);
  });

  it('writes one row when both devices share an org', async () => {
    await writeReattachAudit({ ...base, sourceOrgId: base.targetOrgId });
    expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('an agent actor goes into the details with the anonymous actor id (actor_id is a uuid)', async () => {
    await writeReattachAudit({ ...base, actorUserId: null, actorAgentId: 'a'.repeat(64) });
    const row = createAuditLogAsyncMock.mock.calls[0]![0] as Record<string, any>;
    expect(row).toMatchObject({ actorType: 'agent', actorId: '00000000-0000-0000-0000-000000000000' });
    expect(row.details.actorAgentId).toBe('a'.repeat(64));
  });

  it('waits at most the bound for a slow write, then answers (the write carries on)', async () => {
    createAuditLogAsyncMock.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    await writeReattachAudit(base, { waitMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
