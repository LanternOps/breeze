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
  // Review fix (PR #5780) — a bare `{ kind: 'automation' }` trigger (no
  // `refId`/`key`) must write both as explicit `null`, not omit them: a
  // reader distinguishing "no provenance recorded" (key absent) from "this
  // trigger legitimately carries none" (key present, null) needs the
  // column to always exist once `trigger` was passed at all.
  it('writes triggerRefId/triggerKey as explicit null for a bare trigger', async () => {
    await createAuditLog({ ...base, details: {}, trigger: { kind: 'automation' } });
    expect(values).toHaveBeenCalledWith({
      ...base,
      actorType: 'user',
      details: { triggerKind: 'automation', triggerRefId: null, triggerKey: null },
    });
    const written = values.mock.calls[0]![0] as { details: Record<string, unknown> };
    expect(written.details).toHaveProperty('triggerRefId', null);
    expect(written.details).toHaveProperty('triggerKey', null);
  });
});
