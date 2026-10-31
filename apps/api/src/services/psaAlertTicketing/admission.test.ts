import { describe, expect, it, vi } from 'vitest';
import { makeAdmission } from './admission';
import { makeReconcile } from '../../jobs/psaTicketingReconciler';
import { connectwiseAlertTicketingStoredSchema } from '@breeze/shared';

const config = connectwiseAlertTicketingStoredSchema.parse({ enabled: true, boardId: 1, openStatusId: 2, closedStatusId: 3 });
const now = new Date('2026-10-31T12:00:00Z');
function fixture() {
  const row = { id: 'alert', orgId: 'org', deviceId: null, status: 'active', severity: 'low', ruleId: 'rule', monitorId: 'monitor', triggeredAt: now };
  const target = { connectionId: 'connection', config, rev: 1, enabledAt: new Date(now.getTime() - 3600000) };
  const seen = new Set<string>();
  const deps = {
    load: vi.fn(async () => ({ alert: row, target })),
    insert: vi.fn(async () => { if (seen.size) return null; seen.add(row.id); return 'mapping'; }),
    wake: vi.fn(async (_id: string) => {}),
  };
  return { row, target, deps, admit: makeAdmission(deps) };
}
describe('PSA admission from committed alert', () => {
  it('admits once across duplicate trigger delivery and wakes even an existing row', async () => {
    const f = fixture();
    expect(await f.admit('alert', 'auto')).toBe('admitted');
    expect(await f.admit('alert', 'auto')).toBe('exists');
    expect(f.deps.insert).toHaveBeenCalledTimes(2);
    expect(f.deps.wake).toHaveBeenCalledTimes(2);
  });
  it.each(['severity', 'rule', 'monitor'])('applies the %s filter', async (filter) => {
    const f = fixture();
    f.target.config = { ...config, ...(filter === 'severity' ? { minSeverity: 'high' as const } : filter === 'rule' ? { ruleIds: ['different'] } : { monitorIds: ['different'] }) };
    expect(await f.admit('alert', 'auto')).toBe('filtered');
    expect(f.deps.insert).not.toHaveBeenCalled();
    expect(await f.admit('alert', 'manual', { bypassFilters: true })).toBe('admitted');
  });
  it.each(['not_bound', 'disabled', 'not_external'])('%s admits nothing', async () => {
    const f = fixture(); f.deps.load.mockResolvedValue(null as never);
    expect(await f.admit('alert', 'auto')).toBe('inactive');
    expect(f.deps.insert).not.toHaveBeenCalled();
  });
  it('does not admit a resolved committed row even with manual bypass', async () => {
    const f = fixture(); f.row.status = 'resolved';
    expect(await f.admit('alert', 'manual', { bypassFilters: true })).toBe('filtered');
    expect(f.deps.insert).not.toHaveBeenCalled();
  });
});
describe('reconciler is independent of event dispatch', () => {
  it('catches dropped events above max(enabledAt, lookback) and wakes due/skipped rows', async () => {
    const f = fixture();
    const candidates = vi.fn(async () => ['recent']);
    const wakeDue = vi.fn(async () => ['due', 'no-company-now-linked']);
    const admit = vi.fn(async () => 'admitted' as const);
    const wake = vi.fn(async (_id: string) => {});
    process.env.EVENT_DISPATCH_MODE = 'off';
    await makeReconcile({ targets: async () => [f.target], candidates, wakeDue, admit, wake })(now);
    expect(candidates).toHaveBeenCalledWith('connection', f.target.enabledAt);
    expect(admit).toHaveBeenCalledWith('recent', 'auto');
    expect(wake.mock.calls.map((c) => c[0])).toEqual(['due', 'no-company-now-linked']);
    f.target.enabledAt = new Date(now.getTime() - 48 * 3600000);
    await makeReconcile({ targets: async () => [f.target], candidates, wakeDue, admit, wake })(now);
    expect(candidates).toHaveBeenLastCalledWith('connection', new Date(now.getTime() - 24 * 3600000));
    delete process.env.EVENT_DISPATCH_MODE;
  });
});
