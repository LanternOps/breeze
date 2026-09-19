import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ values: vi.fn(), execute: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    execute: state.execute,
    insert: () => ({ values: state.values }),
    select: () => ({ from: () => ({ where: async () => [{ actionIndex: 0, actionType: 'script' }] }) }),
  },
  getCurrentDbAccessContext: () => null,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
import { seedAutomationActionResults } from './automationActionResults';
beforeEach(() => {
  vi.clearAllMocks();
  state.execute.mockResolvedValue([{ id: 'd1', org_id: 'org1' }]);
  state.values.mockReturnValue({ onConflictDoNothing: async () => [] });
});
describe('automation trigger provenance', () => {
  it.each([undefined, { kind: 'alert' as const, refId: '11111111-1111-4111-8111-111111111111', key: 'alert:disk low' }])('stamps optional trigger and device org %j', async (trigger) => {
    await seedAutomationActionResults({ runId: 'r1', device: { id: 'd1', orgId: 'org1' }, actions: [{ actionIndex: 0, actionType: 'script' }], trigger });
    expect(state.values).toHaveBeenCalledWith([expect.objectContaining({ orgId: 'org1', triggerKind: trigger?.kind ?? null, triggerRefId: trigger?.refId ?? null, triggerKey: trigger?.key ?? null })]);
  });
  it('refuses a cross-org device without inserting', async () => {
    await expect(seedAutomationActionResults({ runId: 'r1', device: { id: 'd1', orgId: 'org2' }, actions: [{ actionIndex: 0, actionType: 'script' }], trigger: { kind: 'automation' } })).rejects.toThrow('organization mismatch');
    expect(state.values).not.toHaveBeenCalled();
  });
});
