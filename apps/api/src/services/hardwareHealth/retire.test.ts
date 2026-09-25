import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ select: vi.fn(), resolve: vi.fn(), stage: vi.fn(), predicate: undefined as unknown }));
vi.mock('../../db', () => ({ db: { select: m.select }, withDbTransaction: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('../alertService', () => ({ RESOLVABLE_ALERT_STATUSES: ['active','acknowledged','suppressed'], resolveAlert: m.resolve }));
vi.mock('./retirementOutbox', () => ({ stageRetiredSubjectResolution: m.stage }));
import { resolveAlertsForRemovedComponents } from './retire';
beforeEach(() => { vi.clearAllMocks(); m.stage.mockResolvedValue(undefined); });
it('defers selected open subjects and stages only CAS winners', async () => {
  m.select.mockReturnValue({ from: () => ({ where: (p: unknown) => { m.predicate = p; return [{ id: 'a' }, { id: 'b' }]; } }) });
  m.resolve.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await resolveAlertsForRemovedComponents('device', ['disk:3','disk:5'])).toBe(1);
  expect(m.resolve).toHaveBeenCalledWith('a', 'component no longer reported', undefined, true);
  expect(m.stage).toHaveBeenCalledExactlyOnceWith('a');
  const query = new PgDialect().sqlToQuery(m.predicate as never);
  expect(query.sql).toContain(' and ');
  expect(query.params).toEqual(expect.arrayContaining(['device','disk:3','disk:5','active','acknowledged','suppressed']));
  expect(query.params).not.toContain('resolved');
});
it('empty retirement does no work', async () => {
  expect(await resolveAlertsForRemovedComponents('device', [])).toBe(0);
  expect(m.select).not.toHaveBeenCalled(); expect(m.stage).not.toHaveBeenCalled();
});
it('staging failure rejects the caller transaction', async () => {
  m.select.mockReturnValue({ from: () => ({ where: () => [{ id: 'a' }] }) });
  m.resolve.mockResolvedValue(true); m.stage.mockRejectedValueOnce(new Error('outbox unavailable'));
  await expect(resolveAlertsForRemovedComponents('device', ['disk:3'])).rejects.toThrow('outbox unavailable');
});
