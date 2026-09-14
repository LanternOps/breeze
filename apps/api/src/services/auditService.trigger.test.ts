import { beforeEach, describe, expect, it, vi } from 'vitest';
const values = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({
  db: { insert: () => ({ values }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema', () => ({ auditLogs: {} }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
import { createAuditLog, createAuditLogAsync } from './auditService';
const base = { actorId: 'u1', action: 'script.execute', resourceType: 'device', result: 'success' as const };
beforeEach(() => { vi.clearAllMocks(); values.mockResolvedValue(undefined); });
describe('audit trigger envelope', () => {
  it.each([createAuditLog, createAuditLogAsync])('merges top-level provenance without changing caller details', async (write) => {
    const details = { deviceId: 'd1' };
    await write({ ...base, details, trigger: { kind: 'sweep_finding', refId: 'r1', key: 'sweep:service_down:Spooler' } });
    expect(values).toHaveBeenCalledWith({ ...base, actorType: 'user', details: { deviceId: 'd1', triggerKind: 'sweep_finding', triggerRefId: 'r1', triggerKey: 'sweep:service_down:Spooler' } });
    expect(details).toEqual({ deviceId: 'd1' });
  });
  it('preserves legacy details', async () => {
    await createAuditLog({ ...base, details: { deviceId: 'd1' } });
    expect(values).toHaveBeenCalledWith({ ...base, actorType: 'user', details: { deviceId: 'd1' } });
  });
});
